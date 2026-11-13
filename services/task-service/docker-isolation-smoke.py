"""使用本地镜像和假凭据检查容器隔离；不会连接真实 API。"""
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NODE = shutil.which('node')
CODEX = os.environ.get('TASK_CODEX_BINARY')
if not NODE or not CODEX or not pathlib.Path(CODEX).is_file():
    raise SystemExit('请安装 Node，并设置 TASK_CODEX_BINARY 指向本机 Linux Codex 二进制')

NETWORK = 'aiwb-isolate-' + uuid.uuid4().hex[:10]
PROXY = NETWORK + '-proxy'

PROXY_SCRIPT = '''
import { createApiProxy } from '/work/services/task-service/api-proxy.mjs';
const proxy = createApiProxy({
  apiKey: process.env.AIWB_FAKE_KEY,
  accessToken: 'a'.repeat(64),
  request: async (url, options) => {
    if (options.headers.authorization === 'Bearer synthetic-secret') console.log('PROXY_REQUESTED');
    return new Response('{"error":{"message":"synthetic"}}', { status: 401 });
  }
});
proxy.listen(3128, '0.0.0.0', () => console.log('READY'));
'''

CLIENT_SCRIPT = '''
const { spawn } = require('node:child_process');
const { mkdirSync, existsSync } = require('node:fs');
const dns = require('node:dns');
const net = require('node:net');
(async () => {
  if (process.env.AIWB_FAKE_KEY || existsSync('/var/run/docker.sock')) throw Error('宿主凭据或 Docker socket 可见');
  let dnsBlocked = false;
  try { await dns.promises.lookup('api.openai.com'); } catch { dnsBlocked = true; }
  if (!dnsBlocked) throw Error('外部 DNS 可访问');
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); reject(Error('可直接访问外网')); });
    socket.on('error', resolve);
    socket.on('timeout', () => { socket.destroy(); resolve(); });
  });
  mkdirSync('/tmp/home/.codex', { recursive: true });
  mkdirSync('/tmp/work', { recursive: true });
  const args = [
    'exec', '--ignore-user-config', '--skip-git-repo-check', '-C', '/tmp/work', '-m', 'test-model',
    '-c', 'model_provider="test"', '-c', 'model_providers.test.name="test"',
    '-c', `model_providers.test.base_url="http://${process.env.AIWB_PROXY_IP}:3128/v1"`,
    '-c', 'model_providers.test.env_key="CODEX_API_KEY"',
    '-c', 'model_providers.test.request_max_retries=0', '测试'
  ];
  const child = spawn('/usr/local/bin/codex', args, {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/home', CODEX_HOME: '/tmp/home/.codex', CODEX_API_KEY: 'a'.repeat(64) },
    stdio: 'ignore'
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  clearTimeout(timer);
  console.log('WORKER_BOUNDARY_OK');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
'''


def run(args, *, check=True, timeout=30):
    return subprocess.run(args, text=True, capture_output=True, check=check, timeout=timeout)


with tempfile.TemporaryDirectory(prefix='aiwb-boundary-') as directory:
    temp = pathlib.Path(directory)
    (temp / 'proxy.mjs').write_text(PROXY_SCRIPT)
    (temp / 'client.cjs').write_text(CLIENT_SCRIPT)
    try:
        run(['docker', 'network', 'create', '--internal', '--ipv6=false', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', NETWORK])
        run([
            'docker', 'run', '-d', '--rm', '--name', PROXY, '--pull', 'never', '--network', NETWORK,
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
            '--mount', f'type=bind,source={ROOT},target=/work,readonly',
            '--mount', f'type=bind,source={NODE},target=/usr/local/bin/node,readonly',
            '--mount', f'type=bind,source={temp}/proxy.mjs,target=/tmp/proxy.mjs,readonly',
            '-e', 'AIWB_FAKE_KEY=synthetic-secret', '--entrypoint', '/usr/local/bin/node',
            'python:3.11-slim-bookworm', '/tmp/proxy.mjs'
        ])
        template = f'{{{{(index .NetworkSettings.Networks "{NETWORK}").IPAddress}}}}'
        address = run(['docker', 'inspect', '--format', template, PROXY]).stdout.strip()
        for _ in range(100):
            if 'READY' in run(['docker', 'logs', PROXY]).stdout:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('测试代理未就绪')
        result = run([
            'docker', 'run', '--rm', '--pull', 'never', '--network', NETWORK, '--dns', '127.0.0.1',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
            '--tmpfs', '/tmp:rw,nosuid,size=64m',
            '--mount', f'type=bind,source={NODE},target=/usr/local/bin/node,readonly',
            '--mount', f'type=bind,source={CODEX},target=/usr/local/bin/codex,readonly',
            '--mount', f'type=bind,source={temp}/client.cjs,target=/tmp/client.cjs,readonly',
            '-e', 'AIWB_PROXY_IP=' + address, '--entrypoint', '/usr/local/bin/node',
            'python:3.11-slim-bookworm', '/tmp/client.cjs'
        ], timeout=50)
        assert 'WORKER_BOUNDARY_OK' in result.stdout
        assert 'PROXY_REQUESTED' in run(['docker', 'logs', PROXY]).stdout
        print('隔离容器经代理请求，代理凭据不可见，直接外网与外部 DNS 被拒绝')
    finally:
        run(['docker', 'rm', '-f', PROXY], check=False, timeout=15)
        run(['docker', 'network', 'rm', NETWORK], check=False, timeout=15)
