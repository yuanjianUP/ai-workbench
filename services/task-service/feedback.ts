import { TaskStore } from './store.ts';
import { createHash } from 'node:crypto';

type Input = { operationKey: string; taskId: string; kind: 'comment' | 'reply' | 'pull_request'; text: string; head?: string; base?: string };
type Credentials = { githubToken?: string; feishuToken?: string };

// Destinations come only from verified, authorized source events, never from caller-supplied URLs.
export async function deliverFeedback(store: TaskStore, input: Input, credentials: Credentials, request: typeof fetch = fetch) {
  if (!input || typeof input.operationKey !== 'string' || !input.operationKey.trim() || typeof input.taskId !== 'string' || typeof input.text !== 'string' || !input.text.trim()) throw new Error('反馈内容无效');
  const source = store.sourceContext(input.taskId);
  if (!source) throw new Error('缺少经验证的来源信息，无法发送反馈');
  let url: string;
  let token: string;
  let body: object;
  if (source.source === 'github' && (input.kind === 'comment' || input.kind === 'pull_request')) {
    const { owner, repo, number } = source.context;
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(owner) || typeof repo !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..' || !Number.isSafeInteger(number) || number <= 0) throw new Error('GitHub 来源信息无效');
    if (!credentials.githubToken) throw new Error('未配置 GitHub 反馈令牌');
    token = credentials.githubToken;
    const prefix = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    if (input.kind === 'comment') {
      url = `${prefix}/issues/${number}/comments`;
      body = { body: input.text };
    } else {
      if (typeof input.head !== 'string' || !input.head.trim() || typeof input.base !== 'string' || !input.base.trim()) throw new Error('创建 PR 需要 head 和 base');
      url = `${prefix}/pulls`;
      body = { title: input.text, head: input.head, base: input.base };
    }
  } else if (source.source === 'feishu' && input.kind === 'reply') {
    const { messageId } = source.context;
    if (typeof messageId !== 'string' || !/^om_[a-zA-Z0-9]+$/.test(messageId)) throw new Error('飞书来源信息无效');
    if (!credentials.feishuToken) throw new Error('未配置飞书反馈令牌');
    token = credentials.feishuToken;
    url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
    body = { msg_type: 'text', content: JSON.stringify({ text: input.text }) };
  } else throw new Error('该来源不支持此反馈操作');

  const payloadDigest = createHash('sha256').update(JSON.stringify({ url, body })).digest('hex');
  return store.sendFeedback(input.operationKey, input.taskId, input.kind, async () => {
    const response = await request(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(source.source === 'github' ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ai-workbench' } : {}) },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('反馈结果无法确认');
    if (source.source === 'feishu' && (await response.json() as { code?: number }).code !== 0) throw new Error('反馈结果无法确认');
  }, payloadDigest);
}
