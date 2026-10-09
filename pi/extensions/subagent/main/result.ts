import type {AgentToolResult} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

import type {ReportPayload, Verification} from '../bus/envelope.js';
import {type ResultDescription, describeResult} from './description.js';
import {
  type MetaJson,
  type TaskStatus,
  auditLogPath,
  isTaskPending,
  readMeta,
  stateRoot,
  taskDir,
} from './state.js';

export interface SubagentDetails {
  taskId: string;
  agent: string;
  task: string;
  mode: 'sync' | 'background' | 'unknown';
  pid: number | null;
  taskDir: string;
  cwd?: string;
  execution?: {
    status: 'ok' | 'failed' | 'aborted' | 'crashed';
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    processExited?: boolean | null;
    processGroupExited?: boolean | null;
  };
  worktree: {
    enabled: boolean;
    baseCommit?: string;
    repoRoot?: string;
    retentionVerified?: boolean;
    verification?: Verification[];
    hasCommittedChanges?: boolean | null;
    hadUncommittedChanges?: boolean | null;
    cleanup?: {
      directoryRemoved: boolean | null;
      registrationRemoved: boolean | null;
    };
    warnings?: string[];
    error?: string;
    branch?: string;
    commits?: {sha: string; subject: string}[];
    preservedPath?: string;
  };
  status: TaskStatus;
  progress: string[];
  finalReport?: ReportPayload;
  error?: string;
  resultPath?: string;
  retrievalNote?: string;
}

interface SavedResult {
  v: 1;
  completedAt: string;
  details: SubagentDetails;
  result?: ResultDescription;
}

export const MAX_RESULT_CHARS = 32_000;

export function resultPath(taskId: string): string {
  return join(taskDir(taskId), 'result.json');
}

export function saveResult(details: SubagentDetails): void {
  const path = resultPath(details.taskId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const saved: SavedResult = {
      v: 1,
      completedAt: new Date().toISOString(),
      details: {...details, resultPath: path},
      result: describeResult(details),
    };
    writeFileSync(temporary, JSON.stringify(saved, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, path);
    details.resultPath = path;
  } finally {
    try {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    } catch {
      // Preserve the primary write/rename failure.
    }
  }
}

function readSavedResult(taskId: string): SavedResult | undefined {
  try {
    const saved = JSON.parse(
      readFileSync(resultPath(taskId), 'utf8'),
    ) as SavedResult;
    const details = saved?.details;
    if (
      saved?.v !== 1 || typeof saved.completedAt !== 'string' || !details ||
      details.taskId !== taskId
      || typeof details.agent !== 'string' || typeof details.task !== 'string'
      || !['ok', 'failed', 'aborted', 'crashed', 'spawn_failed'].includes(
        details.status,
      )
      || !['sync', 'background', 'unknown'].includes(details.mode)
      || !details.worktree || !Array.isArray(details.progress)
      || (details.finalReport !== undefined &&
        typeof details.finalReport?.summary !== 'string')
    ) {
      return undefined;
    }
    return {
      ...saved,
      details: {
        ...details,
        taskDir: taskDir(taskId),
        resultPath: resultPath(taskId),
      },
    };
  } catch {
    return undefined;
  }
}

export function resultText(details: SubagentDetails): string {
  const identity = {
    taskId: details.taskId || null,
    agent: details.agent,
    status: details.status,
    mode: details.mode,
    pid: details.pid,
    taskDir: details.taskDir || undefined,
    cwd: details.cwd,
    resultPath: details.resultPath,
    ...(details.taskDir ?
      {
        stdoutPath: join(details.taskDir, 'stdout.log'),
        stderrPath: join(details.taskDir, 'stderr.log'),
        auditLogPath: join(details.taskDir, 'bus.jsonl'),
      } :
      {}),
  };
  const body = {
    ...describeResult(details),
    execution: details.execution,
    error: details.error,
    retrievalNote: details.retrievalNote,
    finalReport: details.finalReport,
    worktree: details.worktree,
  };
  const full = JSON.stringify({...identity, ...body}, null, 2);
  if (full.length <= MAX_RESULT_CHARS) {
    return full;
  }
  const header = JSON.stringify({...identity, truncated: true}, null, 2);
  const source = details.resultPath ??
    (details.taskDir ? join(details.taskDir, 'bus.jsonl') : undefined);
  const notice = source
    ? `Result truncated. Read ${source} for the full saved result or report envelopes.`
    : 'Result truncated; no task artifact is available.';
  return `${header}\n\n${notice}\n\nResult preview:\n${
    JSON.stringify(body, null, 2).slice(0, MAX_RESULT_CHARS)
  }`;
}

export function completionText(details: SubagentDetails): string {
  const result = describeResult(details);
  const headline = result.resultDescription.length > 480
    ? `${result.resultDescription.slice(0, 480)}...`
    : result.resultDescription;
  if (!details.resultPath) {
    // Without a saved snapshot, do not discard authoritative finalization details.
    return `${headline}\n\n${resultText(details)}`;
  }
  return `${headline}\n${
    JSON.stringify({
      taskId: details.taskId,
      status: details.status,
      taskOutcome: result.taskOutcome,
      finalized: result.finalized,
      resultPath: details.resultPath,
      retainedBranch: details.worktree.retentionVerified
        ? details.worktree.branch
        : undefined,
      preservedPath: details.worktree.preservedPath,
    })
  }\nFull report: subagent_status({task_id: ${
    JSON.stringify(details.taskId)
  }}). If the finalized result was already retrieved, no further action is needed.`;
}

export function taskResult(
  details: SubagentDetails,
): AgentToolResult<SubagentDetails> {
  return {content: [{type: 'text', text: resultText(details)}], details};
}

function detailsFromMeta(meta: MetaJson): SubagentDetails {
  return {
    taskId: meta.taskId,
    agent: meta.agent,
    task: meta.task,
    mode: meta.mode ?? 'unknown',
    pid: meta.subPid,
    taskDir: taskDir(meta.taskId),
    cwd: meta.cwd,
    status: meta.status,
    worktree: {
      enabled: !!meta.worktreePath,
      ...(meta.worktreePath && existsSync(meta.worktreePath)
        ? {preservedPath: meta.worktreePath}
        : {}),
    },
    progress: [],
  };
}

/** Older tasks only have metadata and an audit log, not result.json. */
export async function readTaskResult(
  taskId: string,
): Promise<SubagentDetails | undefined> {
  const saved = readSavedResult(taskId);
  if (saved) {
    return saved.details;
  }
  const meta = readMeta(taskId);
  if (!meta) {
    return undefined;
  }
  const details = detailsFromMeta(meta);
  let lastReport: ReportPayload | undefined;
  let finalReport: ReportPayload | undefined;
  let finalText: string | undefined;
  const input = createReadStream(auditLogPath(taskId), {encoding: 'utf8'});
  const lines = createInterface({input, crlfDelay: Infinity});
  try {
    for await (const line of lines) {
      let env;
      try {
        env = JSON.parse(line);
      } catch {
        continue;
      }
      if (env?.v !== 1 || env.from !== 'sub') {
        continue;
      }
      if (env.type === 'report' && typeof env.payload?.summary === 'string') {
        lastReport = env.payload;
        if (env.payload.final !== false) {
          finalReport = env.payload;
        }
      } else if (env.type === 'done') {
        if (typeof env.payload?.finalText === 'string') {
          finalText = env.payload.finalText;
        }
        if (typeof env.payload?.error === 'string') {
          details.error = env.payload.error;
        }
      }
    }
    details.retrievalNote = finalReport || lastReport || finalText
      ? 'No valid saved result snapshot; recovered the report from the legacy audit log. Worktree metadata may predate finalization.'
      : 'No valid saved result snapshot or report was found in the audit log.';
  } catch {
    details.retrievalNote =
      'No saved result snapshot; the audit log is missing or unreadable.';
  } finally {
    lines.close();
    input.destroy();
  }
  details.finalReport = finalReport ?? lastReport ??
    (finalText ? {summary: finalText} : undefined);
  return details;
}

export function recentCompletedTasks(
  limit: number,
  excluded: ReadonlySet<string> = new Set(),
): SubagentDetails[] {
  if (limit <= 0) {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(stateRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const candidates: {taskId: string; time: number; meta: MetaJson | null}[] =
    [];
  for (const taskId of names) {
    if (excluded.has(taskId)) {
      continue;
    }
    try {
      const meta = readMeta(taskId);
      const path = resultPath(taskId);
      if (existsSync(path)) {
        candidates.push({taskId, time: statSync(path).mtimeMs, meta});
      } else if (
        meta && !isTaskPending(meta.status)
      ) {
        candidates.push({
          taskId,
          time: Date.parse(meta.endedAt ?? meta.startedAt) || 0,
          meta,
        });
      }
    } catch {
      // Ignore non-task entries and tasks concurrently pruned from disk.
    }
  }
  candidates.sort((a, b) =>
    b.time - a.time || a.taskId.localeCompare(b.taskId)
  );
  const results: SubagentDetails[] = [];
  for (const candidate of candidates) {
    if (results.length >= limit) {
      break;
    }
    const saved = readSavedResult(candidate.taskId);
    if (saved) {
      results.push(saved.details);
    } else if (
      candidate.meta && !isTaskPending(candidate.meta.status)
    ) {
      results.push(detailsFromMeta(candidate.meta));
    }
  }
  return results;
}
