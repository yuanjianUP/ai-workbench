import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHmac, createCipheriv, createHash, randomBytes } from 'node:crypto';

test('缺少管理令牌时服务拒绝启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-server-config-'));
  try {
    const env = { ...process.env, TASK_DB: join(dir, 'tasks.db'), TASK_SOCKET: join(dir, 'service.sock') };
    delete env.TASK_API_TOKEN;
    const child = spawn(process.execPath, [new URL('./server.ts', import.meta.url).pathname], { env, stdio: 'ignore' });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('服务重启后保留任务并重复初始化数据库', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-server-'));
  const socket = join(dir, 'service.sock');
  const token = 'a'.repeat(64);
  const start = async () => {
    const child = spawn(process.execPath, [new URL('./server.ts', import.meta.url).pathname], {
      env: { ...process.env, TASK_DB: join(dir, 'tasks.db'), TASK_SOCKET: socket, TASK_API_TOKEN: token, GITHUB_WEBHOOK_SECRET: 'test-secret', GITHUB_ALLOWED_SENDERS: '42', GITHUB_ALLOWED_REPOSITORIES: '99', FEISHU_ENCRYPT_KEY: 'key', FEISHU_VERIFICATION_TOKEN: 'token', FEISHU_APP_ID: 'app', FEISHU_ALLOWED_TENANTS: 'tenant', FEISHU_ALLOWED_SENDERS: 'sender', FEISHU_ALLOWED_CHATS: 'chat' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('服务启动失败'); })]);
    return child;
  };
  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: any }> => new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method, path, headers: headers ?? { authorization: `Bearer ${token}` } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  let child: Awaited<ReturnType<typeof start>> | undefined;
  try {
    child = await start();
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    assert.equal((await call('GET', '/tasks', undefined, {})).status, 401);
    assert.equal((await call('POST', '/tasks', { text: '拒绝' }, { authorization: `Bearer ${'b'.repeat(64)}` })).status, 401);
    assert.equal((await call('GET', '/tasks', undefined)).data.length, 0);
    assert.equal((await call('POST', '/tasks', { text: '  ' })).status, 400);
    const created = await call('POST', '/tasks', { text: '服务任务' });
    assert.equal(created.status, 201);
    const execution = await call('POST', '/executions', { taskId: created.data.id, workspace: 'workspace-1', agent: 'codex' });
    assert.equal(execution.status, 201);
    assert.equal((await call('POST', `/executions/${execution.data.id}/attach`, { orcaId: 'terminal-1' })).status, 200);
    child.kill('SIGTERM'); await once(child, 'exit'); child = undefined;
    child = await start();
    assert.equal((await call('GET', '/tasks')).data.length, 1);
    assert.equal((await call('GET', `/tasks/${created.data.id}`)).data.text, '服务任务');
    const restored = (await call('GET', '/executions')).data;
    assert.equal(restored.length, 1);
    assert.equal(restored[0].orcaId, 'terminal-1');
    assert.equal(restored[0].state, 'unknown');
    assert.notEqual((await call('POST', '/executions', { taskId: created.data.id, workspace: 'workspace-1', agent: 'codex' })).status, 201);
    assert.equal((await call('GET', '/executions')).data.length, 1);
    const payload = { action: 'opened', sender: { id: 42 }, repository: { id: 99 }, issue: { id: 123, title: 'GitHub 任务' } };
    const signature = 'sha256=' + createHmac('sha256', 'test-secret').update(JSON.stringify(payload)).digest('hex');
    const headers = { 'x-hub-signature-256': signature, 'x-github-delivery': 'event-1', 'x-github-event': 'issues' };
    assert.equal((await call('POST', '/webhooks/github', payload, headers)).data.outcome, 'accepted');
    assert.equal((await call('POST', '/webhooks/github', payload, headers)).data.outcome, 'duplicate');
    const splitPayload = { ...payload, issue: { id: 124, title: '分块中文' } };
    const splitBytes = Buffer.from(JSON.stringify(splitPayload));
    const splitAt = splitBytes.indexOf(Buffer.from('分')) + 1;
    const splitHeaders = { ...headers, 'x-github-delivery': 'event-2', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'test-secret').update(splitBytes).digest('hex') };
    const splitResult = await new Promise<{ status: number; data: any }>((resolve, reject) => {
      const req = request({ socketPath: socket, method: 'POST', path: '/webhooks/github', headers: splitHeaders }, res => {
        let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(splitBytes.subarray(0, splitAt));
      setTimeout(() => req.end(splitBytes.subarray(splitAt)), 25);
    });
    assert.equal(splitResult.status, 200);
    assert.equal(splitResult.data.outcome, 'accepted');
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update('key').digest(), iv);
    const event = { header: { token: 'token', app_id: 'app', tenant_key: 'tenant', event_id: 'evt', event_type: 'im.message.receive_v1' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'sender' } }, message: { chat_id: 'chat', message_type: 'text', content: JSON.stringify({ text: '飞书任务' }) } } };
    const envelope = { encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(event)), cipher.final()]).toString('base64') };
    const feishuHeaders = { 'x-lark-request-timestamp': '123', 'x-lark-request-nonce': 'nonce', 'x-lark-signature': createHash('sha256').update('123noncekey' + JSON.stringify(envelope)).digest('hex') };
    assert.equal((await call('POST', '/webhooks/feishu', envelope, feishuHeaders)).data.outcome, 'accepted');
    assert.equal((await call('POST', '/webhooks/feishu', envelope, feishuHeaders)).data.outcome, 'duplicate');
  } finally {
    if (child) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(dir, { recursive: true, force: true });
  }
});
