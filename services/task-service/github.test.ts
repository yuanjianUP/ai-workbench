import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from './store.ts';
import { receiveGithub } from './github.ts';

test('GitHub 签名、授权与重启去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-intake-'));
  try {
    const path = join(dir, 'tasks.db');
    const raw = JSON.stringify({ action: 'opened', sender: { id: 42 }, repository: { id: 99, name: 'repo', owner: { login: 'owner' } }, issue: { id: 123, number: 7, title: '标题', body: '内容' } });
    const headers = { event: 'issues', delivery: 'delivery-1', signature: 'sha256=' + createHmac('sha256', 'secret').update(raw).digest('hex') };
    const config = { secret: 'secret', senders: ['42'], repositories: ['99'] };
    let store = new TaskStore(path);
    assert.equal(receiveGithub(store, raw, { ...headers, signature: 'wrong' }, config).outcome, 'invalid');
    assert.equal(receiveGithub(store, raw, headers, { ...config, senders: [] }).outcome, 'unauthorized');
    assert.equal(receiveGithub(store, raw, headers, { ...config, repositories: [] }).outcome, 'invalid');
    assert.equal(receiveGithub(store, raw, headers, config).outcome, 'accepted');
    store.close(); store = new TaskStore(path);
    assert.equal(receiveGithub(store, raw, headers, config).outcome, 'duplicate');
    assert.equal(receiveGithub(store, raw, { ...headers, delivery: 'different-delivery' }, config).outcome, 'duplicate');
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.sourceContext(store.list()[0].id as string), { source: 'github', context: { owner: 'owner', repo: 'repo', number: 7, repositoryId: '99' } });
    assert.equal(store.list()[0].status, 'pending');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
