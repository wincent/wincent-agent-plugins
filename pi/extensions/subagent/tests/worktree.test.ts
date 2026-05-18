/**
 * Tests for worktree lifecycle: create, finalize (commit + branch), prune.
 *
 * These spin up a real git repo in a tmp dir. Skipped when git is not on PATH.
 */

import {strict as assert} from 'node:assert';
import {execFile} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';

import {
  finalizeWorktree,
  prepareWorktree,
  preserveWorktreeOnCrash,
} from '../main/worktree.js';

const execFileAsync = promisify(execFile);

async function gitIsAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], {timeout: 3000});
    return true;
  } catch {
    return false;
  }
}

async function makeTempRepo(): Promise<
  {repo: string; cleanup: () => Promise<void>}
> {
  const parent = await mkdtemp(join(tmpdir(), 'subagent-wt-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, {recursive: true});
  await execFileAsync('git', ['init', '--initial-branch=main', '-q', repo]);
  // Repo-local config that overrides any host-level git config which may
  // require GPG signing or push hooks the test environment can't satisfy.
  await execFileAsync('git', [
    '-C',
    repo,
    'config',
    'user.email',
    'test@example.com',
  ]);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'test']);
  await execFileAsync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false']);
  await execFileAsync('git', ['-C', repo, 'config', 'tag.gpgsign', 'false']);
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await execFileAsync('git', ['-C', repo, 'add', '-A']);
  await execFileAsync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
  return {repo, cleanup: () => rm(parent, {recursive: true, force: true})};
}

test('prepareWorktree creates a sibling worktree directory', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('git not available');
    return;
  }
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_x', 'worker');
    assert.ok(plan.path.includes('repo-subagent-worktrees'));
    assert.ok(existsSync(plan.path));
    assert.ok(existsSync(join(plan.path, 'README.md')));
    // On macOS, `git rev-parse --show-toplevel` returns the resolved real
    // path while `repo` is a symlinked `/var/folders/...`. Compare resolved
    // forms to avoid false negatives.
    assert.equal(realpathSync(plan.repoRoot), realpathSync(repo));
    assert.match(plan.branch, /^subagent\/worker\//);
    // Cleanup the worktree before we cleanup the parent dir.
    await execFileAsync('git', [
      '-C',
      repo,
      'worktree',
      'remove',
      '--force',
      plan.path,
    ]);
  } finally {
    await cleanup();
  }
});

test('finalizeWorktree prunes a clean worktree', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('git not available');
    return;
  }
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_clean', 'scout');
    const outcome = await finalizeWorktree(plan, {
      agentName: 'scout',
      taskSummary: 'noop',
    });
    assert.equal(outcome.hasChanges, false);
    assert.equal(outcome.branch, undefined);
    assert.ok(!existsSync(plan.path));
  } finally {
    await cleanup();
  }
});

test('finalizeWorktree commits and creates a branch when changes exist', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('git not available');
    return;
  }
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_change', 'worker');
    await writeFile(join(plan.path, 'NEW.md'), 'new content\n');
    const outcome = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'add new file',
    });
    assert.equal(outcome.hasChanges, true);
    assert.ok(outcome.branch);
    assert.match(outcome.branch!, /^subagent\/worker\//);
    // Worktree should be pruned now.
    assert.ok(!existsSync(plan.path));
    // Branch should exist in the main repo.
    const {stdout} = await execFileAsync('git', [
      '-C',
      repo,
      'branch',
      '--list',
      outcome.branch!,
    ]);
    assert.ok(stdout.trim().length > 0);
  } finally {
    await cleanup();
  }
});

test('preserveWorktreeOnCrash leaves the worktree alone', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('git not available');
    return;
  }
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_crash', 'worker');
    await writeFile(join(plan.path, 'partial.md'), 'partial\n');
    const outcome = preserveWorktreeOnCrash(plan);
    assert.equal(outcome.hasChanges, true);
    assert.equal(outcome.preservedPath, plan.path);
    // The worktree should still exist on disk.
    assert.ok(existsSync(plan.path));
    // Clean up so we don't leave artefacts.
    await execFileAsync('git', [
      '-C',
      repo,
      'worktree',
      'remove',
      '--force',
      plan.path,
    ]);
  } finally {
    await cleanup();
  }
});
