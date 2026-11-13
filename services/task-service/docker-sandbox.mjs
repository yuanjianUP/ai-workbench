import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const label = 'io.ai-workbench.execution';
const roleLabel = 'io.ai-workbench.role';
const moduleDir = fileURLToPath(new URL('.', import.meta.url));

function dockerEnvironment(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}
async function docker(args, extra = {}) {
  const { stdout } = await exec('docker', args, { env: dockerEnvironment(extra), timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  return stdout.trim();
}
function safePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[,\r\n]/.test(path)) throw new Error('Docker 路径无效');
  return path;
}
async function requireLocalDocker() {
  const context = await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!(process.platform === 'win32' ? context.startsWith('npipe://') : context.startsWith('unix://'))) throw new Error('仅支持本机 Docker');
}

// Prototype only. The caller must persist an execution intent before invoking this function.
// Never retry an uncertain launch with the same intent without reconciling Docker state.
export async function startDockerSandbox({ executionId, checkout, promptFile, imageId, nodeBinary, codexBinary, model, apiKey, uid }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(executionId || '') || !/^sha256:[a-f0-9]{64}$/.test(imageId || '') || !/^[a-zA-Z0-9._/-]{1,128}$/.test(model || '') || typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(uid || '')) throw new Error('隔离执行配置无效');
  checkout = await realpath(safePath(checkout));
  promptFile = await realpath(safePath(promptFile));
  nodeBinary = await realpath(safePath(nodeBinary));
  codexBinary = await realpath(safePath(codexBinary));
  for (const path of [checkout, promptFile, nodeBinary, codexBinary, moduleDir]) safePath(path);
  const gitDir = join(checkout, '.git');
  const gitStat = await lstat(gitDir);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error('任务 Git 元数据无效');

  await requireLocalDocker();
  const security = JSON.parse(await docker(['info', '--format', '{{json .SecurityOptions}}']));
  if (!Array.isArray(security) || !security.includes('name=seccomp,profile=builtin')) throw new Error('Docker 默认 seccomp 不可确认');

  const suffix = executionId.replaceAll('-', '');
  const network = `aiwb-${suffix}`;
  const proxyName = `${network}-proxy`;
  const workerName = `${network}-worker`;
  const token = randomBytes(32).toString('hex');
  let networkId; let proxyId; let workerId;
  try {
    networkId = await docker(['network', 'create', '--internal', '--ipv6=false', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--label', `${label}=${executionId}`, network]);
    proxyId = await docker(['create', '--name', proxyName, '--label', `${label}=${executionId}`, '--label', `${roleLabel}=proxy`, '--pull', 'never', '--network', network,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', '64', '--memory', '512m',
      '--mount', `type=bind,source=${nodeBinary},target=/usr/local/bin/node,readonly`,
      '--mount', `type=bind,source=${join(moduleDir, 'api-proxy.mjs')},target=/opt/api-proxy.mjs,readonly`,
      '--mount', `type=bind,source=${join(moduleDir, 'api-proxy-runner.mjs')},target=/opt/api-proxy-runner.mjs,readonly`,
      '--env', 'AIWB_PROXY_API_KEY', '--env', 'AIWB_PROXY_ACCESS_TOKEN', '--entrypoint', '/usr/local/bin/node', imageId, '/opt/api-proxy-runner.mjs'],
    { AIWB_PROXY_API_KEY: apiKey, AIWB_PROXY_ACCESS_TOKEN: token });
    await docker(['network', 'connect', 'bridge', proxyId]);
    await docker(['start', proxyId]);
    const proxy = JSON.parse(await docker(['inspect', proxyId]))[0];
    const isolatedNetwork = JSON.parse(await docker(['network', 'inspect', networkId]))[0];
    const proxyMounts = new Set(['/usr/local/bin/node', '/opt/api-proxy.mjs', '/opt/api-proxy-runner.mjs']);
    const proxyNetworks = Object.keys(proxy.NetworkSettings.Networks || {}).sort();
    if (isolatedNetwork.Internal !== true || isolatedNetwork.EnableIPv6 !== false || isolatedNetwork.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated' || isolatedNetwork.Labels?.[label] !== executionId || proxy.Config.Labels?.[label] !== executionId || proxy.State.Running !== true || proxy.Config.User !== '65534:65534' || proxy.HostConfig.Privileged || !proxy.HostConfig.ReadonlyRootfs || !proxy.HostConfig.CapDrop?.includes('ALL') || !proxy.HostConfig.SecurityOpt?.includes('no-new-privileges') || proxy.Image !== imageId || proxyNetworks.join(',') !== [network, 'bridge'].sort().join(',') || proxy.Mounts?.length !== proxyMounts.size || proxy.Mounts.some(item => !proxyMounts.has(item.Destination) || item.RW !== false)) throw new Error('代理隔离配置不可确认');
    let ready = false;
    for (let attempt = 0; attempt < 10 && !ready; attempt++) {
      try {
        await docker(['exec', proxyId, '/usr/local/bin/node', '-e', "const s=require('node:net').connect(3128,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(1000,()=>process.exit(1))"]);
        ready = true;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw new Error('代理未就绪');
    const proxyAddress = proxy.NetworkSettings.Networks?.[network]?.IPAddress;
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(proxyAddress || '')) throw new Error('代理地址不可确认');
    workerId = await docker(['create', '--name', workerName, '--label', `${label}=${executionId}`, '--label', `${roleLabel}=worker`, '--pull', 'never', '--network', network, '--dns', '127.0.0.1',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', uid, '--pids-limit', '128', '--memory', '2g', '--cpus', '2',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--mount', `type=bind,source=${checkout},target=/workspace`,
      '--mount', `type=bind,source=${gitDir},target=/workspace/.git,readonly`, '--mount', `type=bind,source=${promptFile},target=/run/aiwb-task,readonly`,
      '--mount', `type=bind,source=${codexBinary},target=/usr/local/bin/codex,readonly`, '--env', 'CODEX_API_KEY', '--env', 'HOME=/tmp', '--env', 'CODEX_HOME=/tmp/codex',
      '--entrypoint', '/bin/sh', imageId, '-c', 'mkdir -p /tmp/codex && exec /usr/local/bin/codex "$@" < /run/aiwb-task', '_',
      'exec', '--ignore-user-config', '--skip-git-repo-check', '-C', '/workspace', '-m', model, '-s', 'workspace-write',
      '-c', 'model_provider="aiwb"', '-c', 'model_providers.aiwb.name="aiwb"', '-c', `model_providers.aiwb.base_url="http://${proxyAddress}:3128/v1"`,
      '-c', 'model_providers.aiwb.env_key="CODEX_API_KEY"', '-'], { CODEX_API_KEY: token });
    const worker = JSON.parse(await docker(['inspect', workerId]))[0];
    const host = worker.HostConfig;
    const mounts = worker.Mounts || [];
    const expectedMounts = new Map([['/workspace', true], ['/workspace/.git', false], ['/run/aiwb-task', false], ['/usr/local/bin/codex', false]]);
    if (worker.Config.Labels?.[label] !== executionId || worker.Image !== imageId || host.Privileged || !host.ReadonlyRootfs || !host.CapDrop?.includes('ALL') || !host.SecurityOpt?.includes('no-new-privileges') || host.NetworkMode !== network || host.Dns?.length !== 1 || host.Dns[0] !== '127.0.0.1' || host.PidsLimit !== 128 || host.Memory !== 2147483648 || host.NanoCpus !== 2000000000 || worker.Config.User !== uid || mounts.length !== expectedMounts.size || mounts.some(item => !expectedMounts.has(item.Destination) || expectedMounts.get(item.Destination) !== item.RW)) throw new Error('容器隔离配置不可确认');
    await docker(['start', workerId]);
    return { executionId, networkId, proxyId, workerId, state: 'unknown' };
  } catch (error) {
    // Only resources whose exact IDs were returned by Docker are cleaned here.
    // An ambiguous create may have succeeded without returning an ID; the caller must reconcile it.
    for (const id of [workerId, proxyId]) if (id) await docker(['rm', '-f', id]).catch(() => {});
    if (networkId) await docker(['network', 'rm', networkId]).catch(() => {});
    const message = (error instanceof Error ? error.message : '未知错误').replaceAll(apiKey, '[已隐藏]').replaceAll(token, '[已隐藏]');
    throw new Error(`隔离执行未能确认，禁止盲目重试：${message}`);
  }
}

async function findOwnedContainers(executionId) {
  const filter = `${label}=${executionId}`;
  const ids = (await docker(['ps', '-a', '--filter', `label=${filter}`, '--format', '{{.ID}}'])).split('\n').filter(Boolean);
  const result = [];
  for (const id of ids) {
    const info = JSON.parse(await docker(['inspect', id]))[0];
    if (info.Config.Labels?.[label] !== executionId || !['worker', 'proxy'].includes(info.Config.Labels?.[roleLabel])) throw new Error('容器归属不可确认');
    result.push({ id: info.Id, role: info.Config.Labels[roleLabel], running: info.State.Running === true });
  }
  return result;
}

// A Docker state or missing container cannot establish that a task succeeded.
export async function inspectDockerSandbox(executionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(executionId || '')) throw new Error('执行标识无效');
  await requireLocalDocker();
  const containers = await findOwnedContainers(executionId);
  if (containers.filter(item => item.role === 'worker').length > 1 || containers.filter(item => item.role === 'proxy').length > 1) throw new Error('容器状态不可确认');
  return { state: 'unknown', containers };
}

// Use explicit cleanup only after the caller has decided how to handle the saved execution.
// Empty results do not prove that an earlier ambiguous launch never happened.
export async function cleanupDockerSandbox(executionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(executionId || '')) throw new Error('执行标识无效');
  await requireLocalDocker();
  const filter = `${label}=${executionId}`;
  const containers = await findOwnedContainers(executionId);
  const networks = (await docker(['network', 'ls', '--filter', `label=${filter}`, '--format', '{{.ID}}'])).split('\n').filter(Boolean);
  for (const container of containers) await docker(['rm', '-f', container.id]);
  for (const id of networks) {
    const info = JSON.parse(await docker(['network', 'inspect', id]))[0];
    if (info.Labels?.[label] !== executionId) throw new Error('网络归属不可确认');
    await docker(['network', 'rm', id]);
  }
  return { containersRemoved: containers.length, networksRemoved: networks.length };
}
