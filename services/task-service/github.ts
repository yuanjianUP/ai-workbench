import { createHmac, timingSafeEqual } from 'node:crypto';
import { TaskStore } from './store.ts';

export function receiveGithub(store: TaskStore, raw: string | Buffer, headers: { signature?: string; delivery?: string; event?: string }, config: { secret: string; senders: string[]; repositories: string[] }) {
  const expected = Buffer.from('sha256=' + createHmac('sha256', config.secret).update(raw).digest('hex'));
  const supplied = Buffer.from(headers.signature ?? '');
  const verified = !!config.secret && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!headers.delivery || !/^[a-zA-Z0-9-]{1,128}$/.test(headers.delivery)) throw new Error('缺少有效投递 ID');
  let payload: any;
  try { payload = JSON.parse(raw.toString()); } catch { throw new Error('JSON 格式错误'); }
  const sender = String(payload?.sender?.id ?? '');
  const repository = String(payload?.repository?.id ?? '');
  const issueId = payload?.issue?.id;
  const text = headers.event === 'issues' && payload?.action === 'opened' && Number.isSafeInteger(issueId) && issueId > 0 && typeof payload?.issue?.title === 'string'
    ? `${payload.issue.title}\n${typeof payload.issue.body === 'string' ? payload.issue.body : ''}`.trim() : '';
  if (!sender || !repository || !text) throw new Error('不支持或无效的 GitHub 事件');
  // The delivery header is not covered by the body signature. The issue ID is.
  const owner = payload?.repository?.owner?.login;
  const name = payload?.repository?.name;
  const number = payload?.issue?.number;
  const context = typeof owner === 'string' && /^[a-zA-Z0-9-]{1,39}$/.test(owner) && typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(name) && name !== '.' && name !== '..' && Number.isSafeInteger(number) && number > 0
    ? { owner, repo: name, number, repositoryId: repository } : undefined;
  return store.ingestEvent({ source: 'github', id: `issues-opened:${repository}:${issueId}`, sender, text, context }, verified && config.repositories.includes(repository), config.senders);
}
