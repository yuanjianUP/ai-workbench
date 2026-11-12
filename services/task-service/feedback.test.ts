import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TaskStore } from './store.ts';
import { deliverFeedback } from './feedback.ts';

test('来源反馈默认拒绝，授权后发送并对不确定结果去重', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-feedback-adapter-'));
  const path = join(dir, 'tasks.db');
  let store = new TaskStore(path);
  try {
    const github = store.ingestEvent({ source: 'github', id: 'gh', sender: 'u', text: '任务', context: { owner: 'org', repo: 'repo', number: 3 } }, true, ['u']).taskId as string;
    const feishu = store.ingestEvent({ source: 'feishu', id: 'fs', sender: 'u', text: '任务', context: { messageId: 'om_123' } }, true, ['u']).taskId as string;
    const requests: { url: string; body: any }[] = [];
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      if (requests.length === 1) throw new Error('timeout');
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as typeof fetch;
    const credentials = { githubToken: 'test', feishuToken: 'test' };
    const comment = { operationKey: 'one', taskId: github, kind: 'comment' as const, text: '完成' };
    assert.deepEqual(await deliverFeedback(store, comment, credentials, request), { attempted: false, status: 'denied' });
    assert.equal(requests.length, 0);
    store.setFeedbackRule(github, 'comment', 'allow');
    assert.equal((await deliverFeedback(store, comment, credentials, request)).status, 'unknown');
    assert.equal(requests[0].url, 'https://api.github.com/repos/org/repo/issues/3/comments');
    store.close(); store = new TaskStore(path);
    assert.deepEqual(await deliverFeedback(store, comment, credentials, request), { attempted: false, status: 'unknown' });
    await assert.rejects(deliverFeedback(store, { ...comment, text: '不同内容' }, credentials, request), /标识冲突/);
    assert.equal(requests.length, 1);
    store.setFeedbackRule(github, 'pull_request', 'allow');
    const pr = { operationKey: 'two', taskId: github, kind: 'pull_request' as const, text: '标题', head: 'feature', base: 'main' };
    assert.equal((await deliverFeedback(store, pr, credentials, request)).status, 'sent');
    assert.equal(requests[1].url, 'https://api.github.com/repos/org/repo/pulls');
    assert.deepEqual(requests[1].body, { title: '标题', head: 'feature', base: 'main' });
    store.setFeedbackRule(feishu, 'reply', 'allow');
    assert.equal((await deliverFeedback(store, { operationKey: 'three', taskId: feishu, kind: 'reply', text: '回复' }, credentials, request)).status, 'sent');
    assert.equal(requests[2].url, 'https://open.feishu.cn/open-apis/im/v1/messages/om_123/reply');
    await assert.rejects(deliverFeedback(store, { ...comment, taskId: feishu }, credentials, request), /不支持/);
    assert.equal(requests.length, 3);
    assert.deepEqual(store.feedbackAudit().map(row => row.status), ['unknown', 'sent', 'sent']);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('反馈命令要求显式确认，未授权规则不会发送请求', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-feedback-cli-'));
  const path = join(dir, 'tasks.db');
  const store = new TaskStore(path);
  try {
    const taskId = store.ingestEvent({ source: 'github', id: 'gh', sender: 'u', text: '任务', context: { owner: 'org', repo: 'repo', number: 3 } }, true, ['u']).taskId;
    const input = join(dir, 'feedback.json');
    writeFileSync(input, JSON.stringify({ operationKey: 'cli', taskId, kind: 'comment', text: '评论' }));
    const env = { ...process.env, TASK_DB: path, GITHUB_FEEDBACK_TOKEN: 'test' };
    const cli = fileURLToPath(new URL('./feedback-cli.ts', import.meta.url));
    assert.notEqual(spawnSync(process.execPath, [cli, input], { env }).status, 0);
    const result = spawnSync(process.execPath, [cli, input, '--confirm'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { attempted: false, status: 'denied' });
    assert.equal(store.feedbackAudit().length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('评论、回复和 PR 的超时或平台错误均保留未知，重启后不重发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-feedback-uncertain-'));
  const path = join(dir, 'tasks.db');
  let store = new TaskStore(path);
  try {
    const github = store.ingestEvent({ source: 'github', id: 'gh', sender: 'u', text: '任务', context: { owner: 'org', repo: 'repo', number: 3 } }, true, ['u']).taskId as string;
    const feishu = store.ingestEvent({ source: 'feishu', id: 'fs', sender: 'u', text: '任务', context: { messageId: 'om_123' } }, true, ['u']).taskId as string;
    store.setFeedbackRule(github, 'comment', 'allow');
    store.setFeedbackRule(github, 'pull_request', 'allow');
    store.setFeedbackRule(feishu, 'reply', 'allow');
    const operations = [
      { operationKey: 'comment', taskId: github, kind: 'comment' as const, text: '评论' },
      { operationKey: 'pr', taskId: github, kind: 'pull_request' as const, text: 'PR', head: 'feature', base: 'main' },
      { operationKey: 'reply', taskId: feishu, kind: 'reply' as const, text: '回复' }
    ];
    let calls = 0;
    const request = (async () => {
      calls++;
      if (calls === 1) throw new Error('timeout');
      if (calls === 2) return new Response('', { status: 502 });
      return new Response(JSON.stringify({ code: 123 }), { status: 200 });
    }) as typeof fetch;
    const credentials = { githubToken: 'test', feishuToken: 'test' };
    for (const operation of operations) assert.equal((await deliverFeedback(store, operation, credentials, request)).status, 'unknown');
    store.close(); store = new TaskStore(path);
    for (const operation of operations) assert.deepEqual(await deliverFeedback(store, operation, credentials, request), { attempted: false, status: 'unknown' });
    assert.equal(calls, 3);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
