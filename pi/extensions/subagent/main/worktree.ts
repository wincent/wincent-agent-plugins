/**
 * Git worktree management for case-2 isolation.
 *
 * Lifecycle:
 *   1. `prepareWorktree` runs `git worktree add` against a sibling directory
 *      of the main repo. Fails loudly if the working dir is not a git repo
 *      or has no HEAD.
 *   2. The subagent runs inside the worktree as its cwd.
 *   3. `finalizeWorktree` runs after the subagent exits. If the worktree
 *      has changes: stage everything, commit with a descriptive message,
 *      create a branch in the main repo, prune the worktree. If no changes:
 *      prune the worktree. On error: leave the worktree intact so the user
 *      can inspect.
 *
 * The subagent itself doesn't know about worktrees; it just gets a cwd.
 */

import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreePlan {
  /** Absolute path where the worktree was created. */
  path: string;
  /** Branch name (eventually) created in the main repo. */
  branch: string;
  /** Path to the main repo (the parent of the worktree). */
  repoRoot: string;
}

export interface WorktreeOutcome {
  hasChanges: boolean;
  branch?: string;
  /** When the worktree was kept due to an error, this is the path. */
  preservedPath?: string;
  commits: {sha: string; subject: string}[];
}

interface RunOptions {
  cwd: string;
  timeoutMs?: number;
}

async function run(
  cmd: string,
  args: string[],
  options: RunOptions,
): Promise<{stdout: string; stderr: string}> {
  const {stdout, stderr} = await execFileAsync(cmd, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {stdout: stdout.toString(), stderr: stderr.toString()};
}

async function repoRootOf(cwd: string): Promise<string> {
  const {stdout} = await run('git', ['rev-parse', '--show-toplevel'], {cwd});
  return stdout.trim();
}

/**
 * Plan and create a worktree for a subagent.
 *
 * @param sourceCwd  The directory the main is operating in.
 * @param taskId     The unique task id (used in branch name and worktree dir).
 * @param agentName  The agent's name (used in branch name).
 */
export async function prepareWorktree(
  sourceCwd: string,
  taskId: string,
  agentName: string,
): Promise<WorktreePlan> {
  // Verify we're in a git repo with HEAD.
  let repoRoot: string;
  try {
    repoRoot = await repoRootOf(sourceCwd);
  } catch (err) {
    throw new Error(
      `worktree creation requires a git repo: ${(err as Error).message}`,
    );
  }
  try {
    await run('git', ['rev-parse', 'HEAD'], {cwd: repoRoot});
  } catch {
    throw new Error('worktree creation requires at least one commit (no HEAD)');
  }

  const repoName = basename(repoRoot);
  const worktreesParent = resolve(
    dirname(repoRoot),
    `${repoName}-subagent-worktrees`,
  );
  await mkdir(worktreesParent, {recursive: true, mode: 0o755});

  const worktreePath = join(worktreesParent, taskId);
  const branch = `subagent/${agentName}/${shortId(taskId)}`;

  try {
    await run(
      'git',
      ['worktree', 'add', '--detach', worktreePath, 'HEAD'],
      {cwd: repoRoot},
    );
  } catch (err) {
    throw new Error(
      `git worktree add failed: ${(err as Error).message}`,
    );
  }

  return {path: worktreePath, branch, repoRoot};
}

/**
 * Finalize a worktree after the subagent exits.
 *
 * On success:
 *   - If the worktree has uncommitted changes: stage, commit, branch, prune.
 *   - If the worktree is clean: prune.
 *
 * On failure during commit: leave the worktree intact, surface the path.
 */
export async function finalizeWorktree(
  plan: WorktreePlan,
  options: {
    agentName: string;
    taskSummary: string;
  },
): Promise<WorktreeOutcome> {
  if (!existsSync(plan.path)) {
    return {hasChanges: false, commits: []};
  }

  let statusOutput: string;
  try {
    const {stdout} = await run(
      'git',
      ['status', '--porcelain'],
      {cwd: plan.path},
    );
    statusOutput = stdout.trim();
  } catch (err) {
    return {
      hasChanges: false,
      preservedPath: plan.path,
      commits: [],
    };
  }

  if (statusOutput.length === 0) {
    // No changes; prune.
    try {
      await run(
        'git',
        ['worktree', 'remove', '--force', plan.path],
        {cwd: plan.repoRoot},
      );
    } catch {
      // Swallow: prune is best-effort.
    }
    return {hasChanges: false, commits: []};
  }

  // Changes exist. Stage, commit, branch, then remove the worktree.
  const message = `subagent(${options.agentName}): ${
    options.taskSummary.slice(0, 200)
  }`;
  try {
    await run('git', ['add', '-A'], {cwd: plan.path});
    await run('git', ['commit', '-m', message], {cwd: plan.path});
  } catch (err) {
    return {
      hasChanges: true,
      preservedPath: plan.path,
      commits: [],
    };
  }

  let branchName = plan.branch;
  try {
    await run('git', ['branch', branchName], {cwd: plan.path});
  } catch {
    branchName = `${plan.branch}-${Date.now().toString(36)}`;
    try {
      await run('git', ['branch', branchName], {cwd: plan.path});
    } catch {
      return {
        hasChanges: true,
        preservedPath: plan.path,
        commits: [],
      };
    }
  }

  let commits: {sha: string; subject: string}[] = [];
  try {
    const {stdout} = await run(
      'git',
      ['log', '-n', '50', '--pretty=format:%H %s', `${branchName}`, '^HEAD'],
      {cwd: plan.repoRoot},
    );
    commits = stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const space = line.indexOf(' ');
        return {sha: line.slice(0, space), subject: line.slice(space + 1)};
      });
  } catch {
    // Best effort: we still know the branch exists.
  }

  try {
    await run(
      'git',
      ['worktree', 'remove', '--force', plan.path],
      {cwd: plan.repoRoot},
    );
  } catch {
    // Branch is the artefact; worktree pruning is best-effort.
  }

  return {hasChanges: true, branch: branchName, commits};
}

/**
 * On crash, leave the worktree path on disk for forensics and return what we
 * can. No commit attempt because we don't know the agent's intent.
 */
export function preserveWorktreeOnCrash(plan: WorktreePlan): WorktreeOutcome {
  return {
    hasChanges: existsSync(plan.path),
    preservedPath: plan.path,
    commits: [],
  };
}

function shortId(taskId: string): string {
  // Strip the `msg_` prefix if our ids ever change shape, take a short slice.
  const stripped = taskId.replace(/^msg_/, '').replace(/[^a-z0-9]/g, '');
  return stripped.slice(0, 12) || taskId.slice(0, 12);
}
