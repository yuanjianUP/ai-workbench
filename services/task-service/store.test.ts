import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from './store.ts';
import { DatabaseSync } from 'node:sqlite';

test('验证非空任务、持久化和重复初始化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-store-'));
  try {
    const path = join(dir, 'tasks.db');
    let store = new TaskStore(path);
    assert.throws(() => store.create('  '), /不能为空/);
    const task = store.create('  测试任务  ');
    assert.equal(task.text, '测试任务');
    assert.equal(task.source, 'manual');
    assert.ok(!Number.isNaN(Date.parse(task.createdAt)));
    store.close();
    store = new TaskStore(path);
    assert.deepEqual({ ...store.get(task.id) }, task);
    assert.equal(store.list().length, 1);
    assert.equal(store.get('missing'), undefined);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧版反馈表迁移保留记录并可重复运行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-feedback-migration-'));
  const path = join(dir, 'tasks.db');
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE feedback (operation_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO feedback VALUES ('old', 'task', 'comment', 'unknown', '2026-01-01')");
    db.close();
    let store = new TaskStore(path);
    assert.equal(store.feedbackAudit()[0].status, 'unknown');
    store.close(); store = new TaskStore(path);
    assert.equal(store.feedbackAudit().length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('来源事件校验、授权、审计和重启去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-events-'));
  try {
    const path = join(dir, 'tasks.db');
    let store = new TaskStore(path);
    for (const source of ['github', 'feishu'] as const) {
      const event = { source, id: 'event-1', sender: 'user-1', text: '外部任务' };
      assert.equal(store.ingestEvent(event, false, ['user-1']).outcome, 'invalid');
      assert.equal(store.ingestEvent(event, true, []).outcome, 'unauthorized');
      assert.equal(store.ingestEvent(event, true, ['user-1']).outcome, 'accepted');
    }
    store.close();
    store = new TaskStore(path);
    for (const source of ['github', 'feishu'] as const) {
      assert.equal(store.ingestEvent({ source, id: 'event-1', sender: 'user-1', text: '外部任务' }, true, ['user-1']).outcome, 'duplicate');
    }
    assert.equal(store.list().length, 2);
    assert.ok(store.list().every(task => task.status === 'pending'));
    assert.deepEqual(store.eventAudit().map(row => row.outcome), ['invalid', 'unauthorized', 'accepted', 'invalid', 'unauthorized', 'accepted', 'duplicate', 'duplicate']);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('反馈超时或重启后不会重复发送，成功结果可审计', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-feedback-'));
  try {
    const path = join(dir, 'tasks.db');
    let store = new TaskStore(path);
    const task = store.create('反馈测试');
    let calls = 0;
    assert.deepEqual(await store.sendFeedback('comment-1', task.id, 'comment', async () => { calls++; }), { attempted: false, status: 'denied' });
    store.setFeedbackRule(task.id, 'comment', 'deny');
    assert.deepEqual(await store.sendFeedback('comment-1', task.id, 'comment', async () => { calls++; }), { attempted: false, status: 'denied' });
    store.setFeedbackRule(task.id, 'comment', 'allow');
    assert.deepEqual(await store.sendFeedback('comment-1', task.id, 'comment', async () => { calls++; throw new Error('timeout'); }), { attempted: true, status: 'unknown' });
    store.close(); store = new TaskStore(path);
    assert.equal(store.feedbackRules()[0].decision, 'allow');
    assert.deepEqual(await store.sendFeedback('comment-1', task.id, 'comment', async () => { calls++; }), { attempted: false, status: 'unknown' });
    store.setFeedbackRule(task.id, 'reply', 'allow');
    await assert.rejects(store.sendFeedback('comment-1', task.id, 'reply', async () => { calls++; }), /冲突/);
    assert.deepEqual(await store.sendFeedback('reply-1', task.id, 'reply', async () => { calls++; }), { attempted: true, status: 'sent' });
    assert.equal(calls, 2);
    assert.deepEqual(store.feedbackAudit().map(row => row.status), ['unknown', 'sent']);
    assert.deepEqual(store.feedbackAuthorizationAudit().map(row => row.decision), ['deny', 'deny', 'allow', 'allow', 'allow', 'allow']);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('执行意图先持久化，重启后仍为未知且不重新启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-execution-'));
  try {
    const path = join(dir, 'tasks.db');
    let store = new TaskStore(path);
    const task = store.create('执行测试');
    const id = store.beginExecution(task.id, '/worktree', 'codex');
    const second = new TaskStore(path);
    assert.throws(() => second.beginExecution(task.id, '/another', 'codex'), /必须先核对/);
    second.close();
    store.attachExecution(id, 'orca-123');
    assert.throws(() => store.attachExecution(id, 'orca-456'));
    store.close(); store = new TaskStore(path);
    const records = store.executions();
    assert.equal(records.length, 1);
    assert.equal(records[0].orcaId, 'orca-123');
    assert.equal(records[0].state, 'unknown');
    assert.throws(() => store.beginExecution(task.id, '/worktree', 'codex'), /必须先核对/);
    assert.equal(store.executions().length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('人工核对未知执行后保留审计记录，才允许再次创建执行意图', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-execution-review-'));
  try {
    const path = join(dir, 'tasks.db');
    let store = new TaskStore(path);
    const task = store.create('人工核对');
    const id = store.beginExecution(task.id, '/worktree', 'codex');
    assert.throws(() => store.reviewExecution(id, '  '), /不能为空/);
    assert.throws(() => store.beginExecution(task.id, '/worktree', 'codex'), /必须先核对/);
    store.reviewExecution(id, '已在 Orca 中确认进程退出');
    assert.throws(() => store.reviewExecution(id, '重复核对'), /已核对/);
    store.close();
    store = new TaskStore(path);
    assert.equal(store.executions()[0].state, 'manually_checked');
    assert.equal(store.executionReviews()[0].note, '已在 Orca 中确认进程退出');
    assert.ok(store.beginExecution(task.id, '/worktree', 'codex'));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('原型导入先预览，确认后原子写入并对同一文件去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-import-'));
  try {
    const path = join(dir, 'tasks.db');
    let store = new TaskStore(path);
    const input = JSON.stringify([{ text: '原型任务', createdAt: '2026-01-01T00:00:00.000Z' }]);
    assert.deepEqual(store.importPrototype(input, false), { count: 1, alreadyImported: false, imported: false });
    assert.equal(store.list().length, 0);
    assert.throws(() => store.importPrototype('[{"text":""}]', true), /格式/);
    assert.equal(store.importPrototype(input, true).imported, true);
    store.close();
    store = new TaskStore(path);
    assert.deepEqual(store.importPrototype(input, true), { count: 1, alreadyImported: true, imported: false });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].createdAt, '2026-01-01T00:00:00.000Z');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
