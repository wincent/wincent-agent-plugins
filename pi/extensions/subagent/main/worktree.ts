/** Git worktree lifecycle for isolated subagents. */
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {promisify} from 'node:util';

import type {CommitInfo} from '../bus/envelope.js';

const execFileAsync = promisify(execFile);

export interface WorktreePlan {
  path: string;
  branch: string;
  repoRoot: string;
  /** Immutable dispatch baseline, independent of later parent HEAD changes. */
  baseCommit: string;
}

export interface WorktreeOutcome {
  hasChanges: boolean;
  branch?: string;
  preservedPath?: string;
  commits: CommitInfo[];
  warnings?: string[];
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const {stdout} = await execFileAsync('git', args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.toString().trim();
}

export async function prepareWorktree(
  sourceCwd: string,
  taskId: string,
  agentName: string,
): Promise<WorktreePlan> {
  let repoRoot: string;
  try {
    repoRoot = await git(sourceCwd, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    throw new Error(
      `worktree creation requires a git repo: ${(error as Error).message}`,
    );
  }
  let baseCommit: string;
  try {
    baseCommit = await git(repoRoot, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
  } catch {
    throw new Error('worktree creation requires at least one commit (no HEAD)');
  }
  const worktreesParent = resolve(
    dirname(repoRoot),
    `${basename(repoRoot)}-subagent-worktrees`,
  );
  await mkdir(worktreesParent, {recursive: true, mode: 0o755});
  const path = join(worktreesParent, taskId);
  const branch = `subagent/${agentName}/${
    taskId.replace(/[^a-zA-Z0-9_-]/g, '')
  }`;
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', path, baseCommit]);
  } catch (error) {
    throw new Error(`git worktree add failed: ${(error as Error).message}`);
  }
  return {path, branch, repoRoot, baseCommit};
}

async function commitsSinceBase(
  plan: WorktreePlan,
  head: string,
): Promise<CommitInfo[]> {
  const log = await git(plan.path, [
    'log',
    '--reverse',
    '--format=%H%x00%s',
    `${plan.baseCommit}..${head}`,
  ]);
  return log ?
    log.split('\n').map((line) => {
      const separator = line.indexOf('\0');
      return {
        sha: line.slice(0, separator),
        subject: line.slice(separator + 1),
      };
    }) :
    [];
}

function reportsAgree(reported: CommitInfo[], actual: CommitInfo[]): boolean {
  const resolved = reported.map(({sha}) => {
    if (!/^[a-f0-9]{7,64}$/i.test(sha)) {
      return undefined;
    }
    const matches = actual.filter((commit) =>
      commit.sha.startsWith(sha.toLowerCase())
    );
    return matches.length === 1 ? matches[0].sha : undefined;
  });
  return !resolved.includes(undefined) &&
    new Set(resolved).size === actual.length
    && resolved.length === actual.length;
}

/** Never remove a worktree until its committed output has a retained ref. */
export async function finalizeWorktree(
  plan: WorktreePlan,
  options: {
    agentName: string;
    taskSummary: string;
    reportedCommits?: CommitInfo[];
    allowCommit?: boolean;
  },
): Promise<WorktreeOutcome> {
  const result: WorktreeOutcome = {hasChanges: false, commits: []};
  try {
    if (!existsSync(plan.path)) {
      throw new Error(
        'worktree is missing; cannot verify or retain its output',
      );
    }
    let head = await git(plan.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const dirty = (await git(plan.path, ['status', '--porcelain'])).length > 0;
    result.hasChanges = dirty || head !== plan.baseCommit;
    result.commits = await commitsSinceBase(plan, head);
    try {
      await git(plan.path, [
        'merge-base',
        '--is-ancestor',
        plan.baseCommit,
        head,
      ]);
    } catch {
      result.error =
        'worktree HEAD no longer descends from its dispatch baseline';
    }
    // Compare before a harness-created commit can extend the child's output.
    if (
      options.reportedCommits !== undefined &&
      !reportsAgree(options.reportedCommits, result.commits)
    ) {
      result.error = [
        result.error,
        'reported commits disagree with commits detected since the dispatch baseline',
      ].filter(Boolean).join('; ');
    }
    if (dirty && !result.error && options.allowCommit !== false) {
      await git(plan.path, ['add', '-A']);
      await git(plan.path, [
        'commit',
        '-m',
        `subagent(${options.agentName}): ${options.taskSummary.slice(0, 200)}`,
      ]);
      head = await git(plan.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
      result.commits = await commitsSinceBase(plan, head);
    } else if (dirty && options.allowCommit === false) {
      result.warnings = [
        'Task was not reported completed; uncommitted changes were left untouched.',
      ];
    }
    if (head !== plan.baseCommit) {
      let branch = plan.branch;
      try {
        await git(plan.repoRoot, ['branch', branch, head]);
      } catch {
        branch = `${plan.branch}-${randomUUID().slice(0, 8)}`;
        await git(plan.repoRoot, ['branch', branch, head]);
      }
      result.branch = branch;
      const retained = await git(plan.repoRoot, [
        'rev-parse',
        '--verify',
        `refs/heads/${branch}`,
      ]);
      if (retained !== head) {
        throw new Error(
          'retained branch does not point to the finalized worktree HEAD',
        );
      }
    }
    if (result.error || (dirty && options.allowCommit === false)) {
      result.preservedPath = plan.path;
      return result;
    }
    // Without --force, concurrent uncommitted changes or a lock prevent removal.
    await git(plan.repoRoot, ['worktree', 'remove', plan.path]);
  } catch (error) {
    result.error = [result.error, (error as Error).message].filter(Boolean)
      .join('; ');
    if (existsSync(plan.path)) {
      result.preservedPath = plan.path;
    }
  }
  return result;
}

export function preserveWorktreeOnCrash(plan: WorktreePlan): WorktreeOutcome {
  return {
    hasChanges: existsSync(plan.path),
    preservedPath: plan.path,
    commits: [],
  };
}
