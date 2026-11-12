import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import activate, { callService } from './worker.mjs';

test('worker 经受保护的本机 socket 创建和读取任务，拒绝无效令牌和断连', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-worker-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\ai-workbench-${randomUUID()}` : join(dir, 'service.sock');
  const token = 'a'.repeat(64);
  const server = spawn(process.execPath, [fileURLToPath(new URL('../../services/task-service/server.ts', import.meta.url))], {
    env: { ...process.env, TASK_DB: join(dir, 'db'), TASK_SOCKET: socket, TASK_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const handlers = {};
  let protection = 'os-keyring';
  let launches = 0;
  let launchFails = false;
  let readFails = false;
  activate({ panels: { handle(name, handler) { handlers[name] = handler; } }, host: { async call(method) {
    if (method === 'secrets.protection') return { status: protection };
    if (method === 'settings.get') return { settings: { socketPath: socket } };
    if (method === 'secrets.get') return { value: token };
    if (method === 'workspace.list') return { workspaces: [{ id: 'workspace-1' }], truncated: false };
    if (method === 'agent.launch') { launches++; if (launchFails) throw new Error('连接中断'); return { terminalId: 'terminal-1' }; }
    if (method === 'terminal.read') { if (readFails) throw new Error('终端断开'); return { lines: ['日志'], truncated: false }; }
    throw new Error('unexpected host call');
  } } });
  try {
    await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error('服务启动失败'); })]);
    assert.deepEqual(await handlers['tasks.list'](), []);
    const task = await handlers['tasks.create']({ text: '测试任务' });
    assert.equal(task.text, '测试任务');
    assert.equal((await handlers['tasks.list']()).length, 1);
    const manual = { mode: 'manual', taskId: task.id, workspace: 'workspace-1', agent: 'codex' };
    await assert.rejects(handlers['executions.start']({ ...manual, mode: 'automatic' }), /自动执行不可用/);
    await assert.rejects(handlers['executions.start']({ ...manual, mode: undefined }), /自动执行不可用/);
    assert.equal(launches, 0);
    assert.deepEqual(await handlers['executions.start'](manual), { terminalId: 'terminal-1', state: 'unknown' });
    const executions = await handlers['executions.list']();
    assert.equal(executions[0].orcaId, 'terminal-1');
    assert.equal(executions[0].state, 'unknown');
    assert.deepEqual((await handlers['executions.read']({ id: executions[0].id })).lines, ['日志']);
    readFails = true;
    await assert.rejects(handlers['executions.read']({ id: executions[0].id }), /终端断开/);
    assert.equal((await handlers['executions.list']())[0].state, 'unknown');
    await assert.rejects(handlers['executions.start'](manual), /必须先核对/);
    assert.equal(launches, 1);
    const ambiguous = await handlers['tasks.create']({ text: '启动结果不确定' });
    launchFails = true;
    await assert.rejects(handlers['executions.start']({ ...manual, taskId: ambiguous.id }), /启动结果未知/);
    await assert.rejects(handlers['executions.start']({ ...manual, taskId: ambiguous.id }), /必须先核对/);
    assert.equal(launches, 2);
    const unknown = (await handlers['executions.list']()).find(item => item.taskId === ambiguous.id);
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.orcaId, null);
    await assert.rejects(callService(socket, 'b'.repeat(64), 'GET', '/tasks'), /未授权/);
    await assert.rejects(callService(socket, 'b'.repeat(64), 'GET', '/executions'), /未授权/);
    protection = 'unavailable';
    await assert.rejects(handlers['tasks.list'](), /密钥保护不可用/);
    server.kill('SIGTERM'); await once(server, 'exit');
    await assert.rejects(callService(socket, token, 'GET', '/tasks'));
  } finally {
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
    rmSync(dir, { recursive: true, force: true });
  }
});
