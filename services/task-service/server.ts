import { createServer } from 'node:http';
import { chmodSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { TaskStore } from './store.ts';
import { receiveGithub } from './github.ts';
import { receiveFeishu } from './feishu.ts';

const dbPath = process.env.TASK_DB;
const socketPath = process.env.TASK_SOCKET;
const apiToken = process.env.TASK_API_TOKEN;
if (!dbPath || !socketPath || !apiToken || !/^[a-f0-9]{64}$/.test(apiToken)) throw new Error('请设置 TASK_DB、TASK_SOCKET 和 64 位小写十六进制 TASK_API_TOKEN');
if (process.platform === 'win32' && !/^\\\\\.\\pipe\\ai-workbench-[a-zA-Z0-9_-]+$/.test(socketPath)) throw new Error('Windows TASK_SOCKET 必须是 ai-workbench 命名管道');
const tokenBytes = Buffer.from(apiToken, 'hex');
process.umask(0o077);
const store = new TaskStore(dbPath);
const server = createServer(async (req, res) => {
  const respond = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  try {
    if (req.url === '/tasks' || req.url?.startsWith('/tasks/') || req.url === '/executions' || req.url?.startsWith('/executions/')) {
      const authorization = req.headers.authorization ?? '';
      const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
      if (!match || !timingSafeEqual(tokenBytes, Buffer.from(match[1], 'hex'))) return respond(401, { error: '未授权' });
    }
    if (req.method === 'GET' && req.url === '/tasks') return respond(200, store.list());
    if (req.method === 'GET' && req.url === '/executions') return respond(200, store.executions());
    if (req.method === 'GET' && req.url?.startsWith('/tasks/')) {
      const task = store.get(req.url.slice('/tasks/'.length));
      return task ? respond(200, task) : respond(404, { error: '任务不存在' });
    }
    if (req.method === 'POST' && (req.url === '/tasks' || req.url === '/executions' || /^\/executions\/[0-9a-f-]+\/attach$/.test(req.url ?? '') || req.url === '/webhooks/github' || req.url === '/webhooks/feishu')) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) return respond(413, { error: '请求过大' });
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks);
      const body = rawBody.toString('utf8');
      if (req.url === '/webhooks/github') {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        const senders = (process.env.GITHUB_ALLOWED_SENDERS ?? '').split(',').filter(Boolean);
        const repositories = (process.env.GITHUB_ALLOWED_REPOSITORIES ?? '').split(',').filter(Boolean);
        if (!secret || !senders.length || !repositories.length) return respond(503, { error: 'GitHub 接入未配置' });
        try {
          const result = receiveGithub(store, rawBody, { signature: req.headers['x-hub-signature-256'], delivery: req.headers['x-github-delivery'], event: req.headers['x-github-event'] }, { secret, senders, repositories });
          return respond(result.outcome === 'invalid' || result.outcome === 'unauthorized' ? 403 : 200, result);
        } catch { return respond(400, { error: '事件格式错误或不支持' }); }
      }
      if (req.url === '/webhooks/feishu') {
        const encryptKey = process.env.FEISHU_ENCRYPT_KEY ?? '';
        const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN ?? '';
        const appId = process.env.FEISHU_APP_ID ?? '';
        const tenants = (process.env.FEISHU_ALLOWED_TENANTS ?? '').split(',').filter(Boolean);
        const senders = (process.env.FEISHU_ALLOWED_SENDERS ?? '').split(',').filter(Boolean);
        const chats = (process.env.FEISHU_ALLOWED_CHATS ?? '').split(',').filter(Boolean);
        if (!encryptKey || !verificationToken || !appId || !tenants.length || !senders.length || !chats.length) return respond(503, { error: '飞书接入未配置' });
        try {
          const result = receiveFeishu(store, rawBody, { timestamp: req.headers['x-lark-request-timestamp'], nonce: req.headers['x-lark-request-nonce'], signature: req.headers['x-lark-signature'] }, { encryptKey, verificationToken, appId, tenants, senders, chats });
          return respond('outcome' in result && (result.outcome === 'invalid' || result.outcome === 'unauthorized') ? 403 : 200, result);
        } catch { return respond(400, { error: '事件校验失败或不支持' }); }
      }
      let data: unknown;
      try { data = JSON.parse(body); } catch { return respond(400, { error: 'JSON 格式错误' }); }
      if (req.url === '/executions') {
        if (!data || typeof data !== 'object' || !('taskId' in data) || typeof data.taskId !== 'string' || !('workspace' in data) || typeof data.workspace !== 'string' || !('agent' in data) || typeof data.agent !== 'string') return respond(400, { error: '执行信息无效' });
        try { return respond(201, { id: store.beginExecution(data.taskId, data.workspace, data.agent) }); }
        catch (error) { return respond(409, { error: error instanceof Error ? error.message : '无法创建执行记录' }); }
      }
      const attachment = /^\/executions\/([0-9a-f-]+)\/attach$/.exec(req.url ?? '');
      if (attachment) {
        if (!data || typeof data !== 'object' || !('orcaId' in data) || typeof data.orcaId !== 'string') return respond(400, { error: 'Orca 标识无效' });
        try { store.attachExecution(attachment[1], data.orcaId); return respond(200, { attached: true }); }
        catch (error) { return respond(409, { error: error instanceof Error ? error.message : '无法更新执行记录' }); }
      }
      if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string' || !data.text.trim()) return respond(400, { error: '任务内容不能为空' });
      return respond(201, store.create(data.text));
    }
    respond(404, { error: '接口不存在' });
  } catch {
    respond(500, { error: '服务处理失败' });
  }
});
server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
server.listen(socketPath, () => {
  if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
  console.log(`任务服务已启动: ${socketPath}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { store.close(); }));
