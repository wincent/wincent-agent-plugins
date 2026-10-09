/**
 * Tests for worktree lifecycle: create, finalize (commit + branch), prune.
 *
 * These spin up a real git repo in a tmp dir. Skipped when git is not on PATH.
 */

import {strict as assert} from 'node:assert';
import {execFile} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {test} from 'node:test';
import {promisify} from 'node:util';
import type {WorktreePlan} from '../main/worktree.js';

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
  const ignore = join(parent, 'gitignore');
  await writeFile(ignore, '.agent-worktrees/\n');
  await execFileAsync('git', [
    '-C',
    repo,
    'config',
    'core.excludesFile',
    ignore,
  ]);
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await execFileAsync('git', ['-C', repo, 'add', '-A']);
  await execFileAsync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
  return {repo, cleanup: () => rm(parent, {recursive: true, force: true})};
}

test('prepareWorktree creates an ignored directory inside the source worktree', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('git not available');
    return;
  }
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_x', 'worker');
    assert.equal(
      plan.path,
      join(realpathSync(repo), '.agent-worktrees', 'task_x'),
    );
    const {stdout: status} = await execFileAsync('git', [
      '-C',
      repo,
      'status',
      '--porcelain',
    ]);
    assert.equal(status, '');
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

test('placement follows a linked worktree root, including when called from a subdirectory', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const parent = await prepareWorktree(repo, 'task_parent', 'worker');
    const cwd = join(parent.path, 'subdirectory');
    await mkdir(cwd);
    const child = await prepareWorktree(cwd, 'task_child', 'worker');
    assert.equal(child.repoRoot, parent.path);
    assert.equal(
      child.path,
      join(parent.path, '.agent-worktrees', 'task_child'),
    );
    const head = await commitFile(child.path, 'output.txt');
    const result = await finalizeWorktree(child, {
      agentName: 'worker',
      taskSummary: 'file',
    });
    assert.equal(result.error, undefined);
    await assertRetained(child, result.branch, head);
    assert.ok(!existsSync(child.path));
    const {stdout: status} = await execFileAsync('git', [
      '-C',
      parent.path,
      'status',
      '--porcelain',
    ]);
    assert.equal(status, '');
    const parentResult = await finalizeWorktree(parent, {
      agentName: 'worker',
      taskSummary: 'noop',
    });
    assert.equal(parentResult.error, undefined);
    assert.ok(!existsSync(parent.path));
    await assertRetained(parent, result.branch, head);
  } finally {
    await cleanup();
  }
});

test('cleanup matches canonical registrations even through symlinks and unusual paths', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const target = join(repo, 'tree storage\nwith newline');
    await mkdir(target);
    await symlink(target, join(repo, '.agent-worktrees'), 'dir');
    const plan = await prepareWorktree(repo, 'task_alias', 'worker');
    assert.equal(plan.path, join(realpathSync(target), 'task_alias'));
    const preserved = await preserveWorktreeOnCrash(plan);
    assert.deepEqual(preserved.cleanup, {
      directoryRemoved: false,
      registrationRemoved: false,
    });
    const finalized = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'noop',
    });
    assert.equal(finalized.error, undefined);
    assert.deepEqual(finalized.cleanup, {
      directoryRemoved: true,
      registrationRemoved: true,
    });
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
    assert.equal(outcome.hasCommittedChanges, false);
    assert.equal(outcome.hadUncommittedChanges, false);
    assert.deepEqual(outcome.cleanup, {
      directoryRemoved: true,
      registrationRemoved: true,
    });
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
    assert.equal(outcome.hasCommittedChanges, true);
    assert.equal(outcome.hadUncommittedChanges, true);
    assert.deepEqual(outcome.cleanup, {
      directoryRemoved: true,
      registrationRemoved: true,
    });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.commits.length, 1);
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

async function commitFile(
  cwd: string,
  name: string,
  contents = 'example\n',
): Promise<string> {
  await writeFile(join(cwd, name), contents);
  await execFileAsync('git', ['-C', cwd, 'add', '--', name]);
  await execFileAsync('git', ['-C', cwd, 'commit', '-q', '-m', `add ${name}`]);
  const {stdout} = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function assertRetained(
  plan: WorktreePlan,
  branch: string | undefined,
  head: string,
): Promise<void> {
  assert.ok(branch);
  const {stdout} = await execFileAsync('git', [
    '-C',
    plan.repoRoot,
    'rev-parse',
    `refs/heads/${branch}`,
  ]);
  assert.equal(stdout.trim(), head);
}

test('worker commits survive a clean checkout and a subsequent parent HEAD change', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_committed', 'worker');
    const first = await commitFile(plan.path, 'first.txt');
    const second = await commitFile(plan.path, 'second.txt');
    // Moving the parent to the worker tip would make the old ^HEAD range empty.
    await execFileAsync('git', ['-C', repo, 'merge', '--ff-only', second]);
    const outcome = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'two files',
      reportedCommits: [{sha: first, subject: 'add first.txt'}, {
        sha: second,
        subject: 'add second.txt',
      }],
    });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.hasCommittedChanges, true);
    assert.equal(outcome.hadUncommittedChanges, false);
    assert.deepEqual(outcome.cleanup, {
      directoryRemoved: true,
      registrationRemoved: true,
    });
    assert.ok(!('hasChanges' in outcome));
    assert.deepEqual(outcome.commits.map(({sha}) => sha), [first, second]);
    await assertRetained(plan, outcome.branch, second);
    assert.ok(!existsSync(plan.path));
  } finally {
    await cleanup();
  }
});

test('mismatched reported commits fail explicitly without losing actual commits or the worktree', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_mismatch', 'worker');
    const head = await commitFile(plan.path, 'actual.txt');
    const outcome = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'file',
      reportedCommits: [{sha: plan.baseCommit, subject: 'incorrect claim'}],
    });
    assert.match(outcome.error!, /reported commits disagree/);
    assert.deepEqual(outcome.commits.map(({sha}) => sha), [head]);
    await assertRetained(plan, outcome.branch, head);
    assert.equal(outcome.preservedPath, plan.path);
    assert.ok(existsSync(plan.path));
  } finally {
    await cleanup();
  }
});

test('existing branch names are not overwritten', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_collision', 'worker');
    await execFileAsync('git', [
      '-C',
      repo,
      'branch',
      plan.branch,
      plan.baseCommit,
    ]);
    const head = await commitFile(plan.path, 'new.txt');
    const outcome = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'file',
    });
    assert.equal(outcome.error, undefined);
    assert.notEqual(outcome.branch, plan.branch);
    await assertRetained(plan, plan.branch, plan.baseCommit);
    await assertRetained(plan, outcome.branch, head);
  } finally {
    await cleanup();
  }
});

test('cleanup failure is explicit and retains both branch and worktree', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_locked', 'worker');
    const head = await commitFile(plan.path, 'new.txt');
    await execFileAsync('git', ['-C', repo, 'worktree', 'lock', plan.path]);
    const outcome = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'file',
    });
    assert.match(outcome.error!, /locked/);
    assert.deepEqual(outcome.cleanup, {
      directoryRemoved: false,
      registrationRemoved: false,
    });
    assert.equal(outcome.preservedPath, plan.path);
    await assertRetained(plan, outcome.branch, head);
    assert.ok(existsSync(plan.path));
  } finally {
    await cleanup();
  }
});

test('disabling auto-commit preserves uncommitted work while retaining existing commits', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_partial', 'worker');
    const head = await commitFile(plan.path, 'done.txt');
    await writeFile(join(plan.path, 'unfinished.txt'), 'partial\n');
    const outcome = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'partial',
      allowCommit: false,
    });
    assert.equal(outcome.error, undefined);
    assert.ok(outcome.warnings?.length);
    assert.equal(outcome.hasCommittedChanges, true);
    assert.equal(outcome.hadUncommittedChanges, true);
    assert.deepEqual(outcome.cleanup, {
      directoryRemoved: false,
      registrationRemoved: false,
    });
    assert.equal(outcome.preservedPath, plan.path);
    await assertRetained(plan, outcome.branch, head);
    const {stdout} = await execFileAsync('git', [
      '-C',
      plan.path,
      'status',
      '--porcelain',
    ]);
    assert.match(stdout, /\?\? unfinished.txt/);
  } finally {
    await cleanup();
  }
});

test('missing worktree cannot silently finalize successfully', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(repo, 'task_missing', 'worker');
    await execFileAsync('git', ['-C', repo, 'worktree', 'remove', plan.path]);
    const outcome = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'file',
    });
    assert.match(outcome.error!, /worktree is missing/);
  } finally {
    await cleanup();
  }
});

test('directory disappearance does not imply Git registration removal', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(
      repo,
      'task_missing_directory',
      'worker',
    );
    await rm(plan.path, {recursive: true});
    const outcome = await finalizeWorktree(plan, {
      agentName: 'worker',
      taskSummary: 'file',
    });
    assert.match(outcome.error!, /worktree is missing/);
    assert.deepEqual(outcome.cleanup, {
      directoryRemoved: true,
      registrationRemoved: false,
    });
    assert.equal(outcome.hasCommittedChanges, null);
    assert.equal(outcome.hadUncommittedChanges, null);
  } finally {
    await cleanup();
  }
});

test('an unavailable Git query leaves registration cleanup unknown', async () => {
  const {repo, cleanup} = await makeTempRepo();
  try {
    const plan = await prepareWorktree(
      repo,
      'task_unknown_registration',
      'worker',
    );
    const outcome = await preserveWorktreeOnCrash({
      ...plan,
      repoRoot: join(repo, 'not-a-directory'),
    });
    assert.deepEqual(outcome.cleanup, {
      directoryRemoved: false,
      registrationRemoved: null,
    });
    assert.ok(existsSync(plan.path));
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
    const outcome = await preserveWorktreeOnCrash(plan);
    assert.equal(outcome.hasCommittedChanges, null);
    assert.equal(outcome.hadUncommittedChanges, null);
    assert.deepEqual(outcome.cleanup, {
      directoryRemoved: false,
      registrationRemoved: false,
    });
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
