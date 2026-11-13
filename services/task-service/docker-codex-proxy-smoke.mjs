// Explicit offline integration test; the proxy uses a synthetic upstream and key.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { prepareCheckout } from './prepare-checkout.mjs';

if (typeof process.getuid !== 'function' || !process.getuid() || !process.env.TASK_CODEX_BINARY) throw new Error('请使用非 root Linux 用户并设置 TASK_CODEX_BINARY');
const exec = promisify(execFile);
const call = async (...args) => (await exec(args[0], args.slice(1), { timeout: 60000, env: args[0] === 'git' ? { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } : process.env })).stdout.trim();
const root = await mkdtemp(join(tmpdir(), 'aiwb-codex-runner-'));
const executionId = randomUUID();
let sandbox; let cleanup;
try {
  const modules = join(root, 'modules'); const source = join(root, 'source'); const jobs = join(root, 'jobs');
  await mkdir(modules); await mkdir(source); await mkdir(jobs);
  await copyFile(new URL('./docker-sandbox.mjs', import.meta.url), join(modules, 'docker-sandbox.mjs'));
  await copyFile(new URL('./api-proxy.mjs', import.meta.url), join(modules, 'api-proxy.mjs'));
  await writeFile(join(modules, 'api-proxy-runner.mjs'), `import {createApiProxy} from './api-proxy.mjs';
const proxy=createApiProxy({apiKey:process.env.AIWB_PROXY_API_KEY,accessToken:process.env.AIWB_PROXY_ACCESS_TOKEN,request:async (url,options)=>{
  if (url==='https://api.openai.com/v1/responses' && options.headers.authorization==='Bearer synthetic-secret') console.log('MOCK_API_OK');
  return new Response('{"error":{"message":"synthetic"}}',{status:401,headers:{'content-type':'application/json'}});
}});
proxy.listen(3128,'0.0.0.0');
`);
  const runtime = await import(pathToFileURL(join(modules, 'docker-sandbox.mjs')).href);
  cleanup = runtime.cleanupDockerSandbox;
  await call('git', 'init', '-q', '-b', 'main', source);
  await writeFile(join(source, 'file.txt'), 'test');
  await call('git', '-C', source, 'add', 'file.txt');
  await call('git', '-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'initial');
  const checkout = await prepareCheckout({ repository: source, branch: 'main', taskRoot: jobs });
  const prompt = join(checkout.job, 'prompt.txt'); await writeFile(prompt, '只回复测试，不运行工具', { mode: 0o600 });
  const imageId = await call('docker', 'image', 'inspect', '--format', '{{.Id}}', 'python:3.11-slim-bookworm');
  sandbox = await runtime.startDockerSandbox({ executionId, checkout: checkout.checkout, promptFile: prompt,
    imageId, nodeBinary: process.execPath, codexBinary: process.env.TASK_CODEX_BINARY, model: 'test-model', apiKey: 'synthetic-secret', uid: `${process.getuid()}:${process.getgid()}` });
  await call('docker', 'wait', sandbox.workerId);
  assert.match(await call('docker', 'logs', sandbox.proxyId), /MOCK_API_OK/);
  assert.doesNotMatch(await call('docker', 'logs', sandbox.workerId), /synthetic-secret/);
  console.log('真实 Codex 已通过 Docker 生命周期原型访问模拟代理；未访问真实 API');
} finally {
  if (cleanup) await cleanup(executionId);
  await rm(root, { recursive: true, force: true });
}
