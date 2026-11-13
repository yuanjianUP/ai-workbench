import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('反馈规则必须确认才能修改，且重启后保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-cli-rule-'));
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, TASK_DB: join(dir, 'tasks.db') }, encoding: 'utf8'
  });
  try {
    const task = JSON.parse(run('create', '规则测试').stdout);
    assert.notEqual(run('feedback-rule', task.id, 'comment', 'allow').status, 0);
    assert.deepEqual(JSON.parse(run('feedback-rules').stdout), []);
    assert.equal(run('feedback-rule', task.id, 'comment', 'allow', '--confirm').status, 0);
    assert.equal(JSON.parse(run('feedback-rules').stdout)[0].decision, 'allow');
    assert.notEqual(run('feedback-rule', task.id, 'invalid', 'allow', '--confirm').status, 0);
    assert.equal(JSON.parse(run('feedback-rules').stdout)[0].decision, 'allow');
    assert.equal(run('feedback-rule', task.id, 'comment', 'deny', '--confirm').status, 0);
    assert.equal(JSON.parse(run('feedback-rules').stdout)[0].decision, 'deny');
    assert.notEqual(run('automation-rule', 'github', '99', '42', 'allow').status, 0);
    assert.deepEqual(JSON.parse(run('automation-rules').stdout), []);
    const automation = run('automation-rule', 'github', '99', '42', 'allow', '--confirm');
    assert.equal(automation.status, 0);
    assert.equal(JSON.parse(automation.stdout).executionAvailable, false);
    assert.equal(JSON.parse(run('automation-rules').stdout)[0].decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
