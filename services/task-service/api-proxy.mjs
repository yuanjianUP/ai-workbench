import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Prototype for the isolated executor. It is not wired into automatic execution.
export function createApiProxy({ apiKey, accessToken, request = fetch }) {
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) || typeof accessToken !== 'string' || !/^[a-f0-9]{64}$/.test(accessToken)) throw new Error('代理凭据无效');
  const expected = Buffer.from(accessToken, 'hex');
  let active = 0;
  return createServer(async (req, res) => {
    const reject = (status, message) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: message })); };
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
    if (!supplied || !timingSafeEqual(expected, Buffer.from(supplied[1], 'hex'))) return reject(401, '未授权');
    if (req.method !== 'POST' || req.url !== '/v1/responses') return reject(404, '接口不可用');
    if (active >= 4) return reject(429, '请求过多');
    active++;
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) return reject(413, '请求过大');
        chunks.push(chunk);
      }
      const upstream = await request('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
        body: Buffer.concat(chunks)
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      if (!upstream.body) return res.end();
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      if (res.headersSent) res.destroy();
      else reject(502, '上游请求失败');
    } finally { active--; }
  });
}
