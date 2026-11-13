// Explicit smoke test: uses only local Docker images, temporary files and synthetic credentials.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { prepareCheckout } from './prepare-checkout.mjs';
import { cleanupDockerSandbox, inspectDockerSandbox, startDockerSandbox } from './docker-sandbox.mjs';

if (typeof process.getuid !== 'function' || !process.getuid()) throw new Error('请使用非 root Linux 用户运行测试');
const exec = promisify(execFile);
const call = async (...args) => (await exec(args[0], args.slice(1), { timeout: 40000, env: args[0] === 'git' ? { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } : process.env })).stdout.trim();
const root = await mkdtemp(join(tmpdir(), 'aiwb-docker-runner-'));
const executionId = randomUUID();
let sandbox;
try {
  const source = join(root, 'source'); const jobs = join(root, 'jobs');
  await mkdir(source); await mkdir(jobs);
  await call('git', 'init', '-q', '-b', 'main', source);
  await writeFile(join(source, 'file.txt'), 'before');
  await call('git', '-C', source, 'add', 'file.txt');
  await call('git', '-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'initial');
  const checkout = await prepareCheckout({ repository: source, branch: 'main', taskRoot: jobs });
  const prompt = join(checkout.job, 'prompt.txt');
  await writeFile(prompt, 'synthetic task', { mode: 0o600 });
  const fakeAgent = join(root, 'fake-agent');
  await writeFile(fakeAgent, `#!/usr/local/bin/python3
import os, pathlib, sys
assert 'AIWB_PROXY_API_KEY' not in os.environ
assert os.environ.get('CODEX_API_KEY') != 'synthetic-secret'
assert not pathlib.Path('/var/run/docker.sock').exists()
assert sys.stdin.read() == 'synthetic task'
try:
    pathlib.Path('/workspace/.git/config').write_text('tampered')
    raise RuntimeError('git metadata writable')
except OSError:
    pass
pathlib.Path('/workspace/file.txt').write_text('after')
print('SANDBOX_SMOKE_OK')
`, { mode: 0o755 });
  const config = await readFile(join(checkout.checkout, '.git', 'config'), 'utf8');
  const imageId = await call('docker', 'image', 'inspect', '--format', '{{.Id}}', 'python:3.11-slim-bookworm');
  sandbox = await startDockerSandbox({ executionId, checkout: checkout.checkout, promptFile: prompt,
    imageId, nodeBinary: process.execPath, codexBinary: fakeAgent, model: 'test-model', apiKey: 'synthetic-secret', uid: `${process.getuid()}:${process.getgid()}` });
  assert.equal(await call('docker', 'wait', sandbox.workerId), '0');
  assert.match(await call('docker', 'logs', sandbox.workerId), /SANDBOX_SMOKE_OK/);
  assert.equal(await readFile(join(checkout.checkout, 'file.txt'), 'utf8'), 'after');
  assert.equal(await readFile(join(checkout.checkout, '.git', 'config'), 'utf8'), config);
  const state = await inspectDockerSandbox(executionId);
  assert.equal(state.state, 'unknown');
  assert.equal(state.containers.find(container => container.role === 'worker').running, false);
  assert.equal(state.containers.find(container => container.role === 'proxy').running, true);
  console.log('Docker 生命周期原型验证通过：任务目录可写、Git 元数据只读、代理密钥不可见');
} finally {
  const cleaned = await cleanupDockerSandbox(executionId);
  if (sandbox) assert.deepEqual(cleaned, { containersRemoved: 2, networksRemoved: 1 });
  assert.deepEqual(await cleanupDockerSandbox(executionId), { containersRemoved: 0, networksRemoved: 0 });
  await rm(root, { recursive: true, force: true });
}
