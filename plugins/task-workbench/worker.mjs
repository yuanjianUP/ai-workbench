import { request } from 'node:http';
import { isAbsolute } from 'node:path';

export function callService(socketPath, token, method, path, body) {
  const validSocket = typeof socketPath === 'string' && (process.platform === 'win32'
    ? /^\\\\\.\\pipe\\ai-workbench-[a-zA-Z0-9_-]+$/.test(socketPath)
    : isAbsolute(socketPath));
  if (!validSocket) throw new Error('请配置本机 Unix socket 或 Windows ai-workbench 命名管道');
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('请先配置任务服务令牌');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, timeout: 5000 }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { req.destroy(new Error('服务响应过大')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(result.error || '任务服务拒绝请求'));
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('任务服务连接超时')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export default function activate(orca) {
  async function call(method, path, body) {
    const protection = await orca.host.call('secrets.protection');
    if (protection.status !== 'os-keyring') throw new Error('系统密钥保护不可用，无法连接任务服务');
    const { settings } = await orca.host.call('settings.get');
    const { value } = await orca.host.call('secrets.get', { key: 'task-api-token' });
    return callService(settings.socketPath, value, method, path, body);
  }
  orca.panels.handle('tasks.list', () => call('GET', '/tasks'));
  orca.panels.handle('tasks.create', input => {
    if (!input || typeof input.text !== 'string' || !input.text.trim()) throw new Error('任务内容不能为空');
    return call('POST', '/tasks', { text: input.text });
  });
  orca.panels.handle('workspaces.list', () => orca.host.call('workspace.list'));
  orca.panels.handle('executions.list', () => call('GET', '/executions'));
  orca.panels.handle('executions.start', async input => {
    if (input?.mode !== 'manual') throw new Error('自动执行不可用：尚未验证任务工作区和权限隔离');
    if (typeof input.taskId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.taskId) || typeof input.workspace !== 'string' || typeof input.agent !== 'string' || !input.agent.trim()) throw new Error('执行信息无效');
    const { workspaces, truncated } = await orca.host.call('workspace.list');
    if (truncated || !workspaces.some(workspace => workspace.id === input.workspace)) throw new Error('工作区不可确认，请刷新后重试');
    const task = await call('GET', `/tasks/${input.taskId}`);
    const intent = await call('POST', '/executions', { taskId: input.taskId, workspace: input.workspace, agent: input.agent.trim() });
    let launched;
    try { launched = await orca.host.call('agent.launch', { workspaceId: input.workspace, agent: input.agent.trim(), prompt: task.text }); }
    catch { throw new Error('启动结果未知；请在 Orca 中核对后再处理执行记录'); }
    if (!launched || typeof launched.terminalId !== 'string' || !launched.terminalId) throw new Error('启动结果未知；请在 Orca 中核对执行记录');
    try { await call('POST', `/executions/${intent.id}/attach`, { orcaId: launched.terminalId }); }
    catch { throw new Error(`终端 ${launched.terminalId} 已返回，但执行记录未能确认；请在 Orca 中核对`); }
    return { terminalId: launched.terminalId, state: 'unknown' };
  });
  orca.panels.handle('executions.read', async input => {
    const executions = await call('GET', '/executions');
    const execution = executions.find(item => item.id === input?.id);
    if (!execution?.orcaId) throw new Error('终端标识未知');
    return orca.host.call('terminal.read', { terminalId: execution.orcaId, maxLines: 500 });
  });
  orca.panels.handle('workspaces.review', async input => {
    const executions = await call('GET', '/executions');
    const execution = executions.find(item => item.id === input?.id);
    if (!execution) throw new Error('执行记录不存在');
    await orca.host.call('workspace.open', { workspaceId: execution.workspace });
    return orca.host.call('commands.run', { action: 'sidebar.sourceControl.toggle' });
  });
}
