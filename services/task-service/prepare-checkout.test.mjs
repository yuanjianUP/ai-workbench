import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCheckout } from './prepare-checkout.mjs';

test('任务快照不包含旧历史或源仓库地址，不执行宿主 Git 钩子', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-checkout-test-'));
  const source = join(root, 'source'); const jobs = join(root, 'jobs');
  const marker = join(root, 'hook-ran'); const hooks = join(root, 'hooks');
  mkdirSync(source); mkdirSync(jobs); mkdirSync(hooks);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const oldConfig = process.env.GIT_CONFIG_GLOBAL;
  try {
    git('init', '-b', 'main', source);
    writeFileSync(join(source, 'old.txt'), '旧历史');
    git('-C', source, 'add', '.');
    git('-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'old');
    const oldCommit = git('-C', source, 'rev-parse', 'HEAD');
    rmSync(join(source, 'old.txt'));
    writeFileSync(join(source, 'current.txt'), '当前内容');
    git('-C', source, 'add', '-A');
    git('-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'current');
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const globalConfig = join(root, 'global-config');
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    const result = await prepareCheckout({ repository: source, branch: 'main', taskRoot: jobs });
    assert.equal(result.commit, git('-C', source, 'rev-parse', 'HEAD'));
    assert.equal(git('-C', result.checkout, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(git('-C', result.checkout, 'remote'), '');
    assert.equal(existsSync(join(result.checkout, 'current.txt')), true);
    assert.equal(existsSync(join(result.checkout, 'old.txt')), false);
    assert.notEqual(spawnSync('git', ['-C', result.checkout, 'cat-file', '-e', oldCommit]).status, 0);
    assert.equal(existsSync(marker), false);
    const before = readdirSync(jobs).length;
    await assert.rejects(prepareCheckout({ repository: source, branch: 'missing', taskRoot: jobs }));
    assert.equal(readdirSync(jobs).length, before);
    await assert.rejects(prepareCheckout({ repository: source, branch: '../bad', taskRoot: jobs }), /无效/);
    await assert.rejects(prepareCheckout({ repository: source, branch: 'main', taskRoot: source }), /分离/);
  } finally {
    if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
