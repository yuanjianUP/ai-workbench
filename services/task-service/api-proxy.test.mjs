import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApiProxy } from './api-proxy.mjs';

test('凭据代理只允许授权的 Responses 请求并替换密钥', async () => {
  const token = 'a'.repeat(64);
  const observed = [];
  const server = createApiProxy({ apiKey: 'private-test-key', accessToken: token, request: async (url, options) => {
    observed.push({ url, options });
    return new Response('data: test\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const call = (path, authorization, body = '{}') => new Promise((resolve, reject) => {
    const req = request({ port, host: '127.0.0.1', path, method: 'POST', headers: { authorization } }, res => {
      let output = ''; res.on('data', chunk => output += chunk); res.on('end', () => resolve({ status: res.statusCode, output }));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    assert.equal((await call('/v1/responses', `Bearer ${'b'.repeat(64)}`)).status, 401);
    assert.equal((await call('/v1/models', `Bearer ${token}`)).status, 404);
    assert.equal(observed.length, 0);
    const result = await call('/v1/responses', `Bearer ${token}`, '{"model":"test"}');
    assert.equal(result.status, 200);
    assert.equal(result.output, 'data: test\n\n');
    assert.equal(observed[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(observed[0].options.headers.authorization, 'Bearer private-test-key');
    assert.equal(observed[0].options.redirect, 'error');
    assert.equal(Buffer.from(observed[0].options.body).toString(), '{"model":"test"}');
  } finally { server.close(); await once(server, 'close'); }
});

test('上游异常不向调用方泄漏代理密钥', async () => {
  const server = createApiProxy({ apiKey: 'private-test-key', accessToken: 'a'.repeat(64), request: async () => { throw new Error('private-test-key'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(64)}` }, body: '{}' });
    assert.equal(res.status, 502);
    assert.doesNotMatch(await res.text(), /private-test-key/);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});
