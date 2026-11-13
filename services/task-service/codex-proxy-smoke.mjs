// Run inside a network-disabled test container with a local Codex binary.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { createApiProxy } from './api-proxy.mjs';

const token = 'a'.repeat(64);
mkdirSync('/tmp/aiwb-codex-home/.codex', { recursive: true });
mkdirSync('/tmp/aiwb-codex-work', { recursive: true });
let observed = false;
const proxy = createApiProxy({ apiKey: 'synthetic-upstream-key', accessToken: token, request: async (url, options) => {
  observed = url === 'https://api.openai.com/v1/responses' && options.headers.authorization === 'Bearer synthetic-upstream-key';
  return new Response('{"error":{"message":"synthetic test"}}', { status: 401, headers: { 'content-type': 'application/json' } });
} });
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
const args = [
  'exec', '--ignore-user-config', '--skip-git-repo-check', '-C', '/tmp/aiwb-codex-work', '-m', 'test-model',
  '-c', 'model_provider="test"', '-c', 'model_providers.test.name="test"', '-c', `model_providers.test.base_url="http://127.0.0.1:${proxy.address().port}/v1"`,
  '-c', 'model_providers.test.env_key="CODEX_API_KEY"', '-c', 'model_providers.test.request_max_retries=0', '测试'
];
const child = spawn('/usr/local/bin/codex', args, {
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/aiwb-codex-home', CODEX_HOME: '/tmp/aiwb-codex-home/.codex', CODEX_API_KEY: token },
  stdio: ['ignore', 'ignore', 'pipe']
});
let stderr = '';
child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
try {
  await once(child, 'exit');
  if (!observed) throw new Error(`Codex 未到达模拟代理: ${stderr.slice(0, 1000)}`);
  console.log('隔离容器中的 Codex 已使用占位令牌到达模拟凭据代理');
} finally {
  clearTimeout(timer);
  proxy.closeAllConnections(); proxy.close();
  await once(proxy, 'close');
}
