import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const contains = (parent, child) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };

// Inputs must come from an administrator's trusted configuration, not an external event.
// This prepares files only; it does not authorize or start an agent.
export async function prepareCheckout({ repository, branch, taskRoot }) {
  if (typeof repository !== 'string' || !isAbsolute(repository) || typeof taskRoot !== 'string' || !isAbsolute(taskRoot) || typeof branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(branch)) throw new Error('任务目录配置无效');
  const source = await realpath(repository);
  const root = await realpath(taskRoot);
  if (contains(source, root) || contains(root, source)) throw new Error('任务目录必须与源仓库分离');
  const job = await mkdtemp(join(root, 'task-'));
  const home = join(job, 'home');
  const templates = join(job, 'empty-templates');
  const checkout = join(job, 'checkout');
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
  const git = (...args) => exec('git', args, { env, timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true });
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(templates, { mode: 0o700 });
    await git('check-ref-format', '--branch', branch);
    await git('-c', `init.templateDir=${templates}`, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', 'clone', '--depth', '1', '--no-tags', '--single-branch', '--branch', branch, '--', pathToFileURL(source).href, checkout);
    await git('-C', checkout, 'remote', 'remove', 'origin');
    const { stdout } = await git('-C', checkout, 'rev-parse', 'HEAD');
    const commit = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('任务版本不可确认');
    return { job, checkout, commit };
  } catch (error) {
    await rm(job, { recursive: true, force: true });
    throw error;
  }
}
