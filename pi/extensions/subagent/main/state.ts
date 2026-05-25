/**
 * State-directory layout and reaper for the subagent bus.
 *
 * Per-task layout:
 *
 *   ${XDG_STATE_HOME:-~/.local/state}/pi/subagent/<task_id>/
 *     meta.json           # status metadata
 *     main.sock           # UDS bind point (removed on close)
 *     bus.jsonl           # append-only audit log
 *     system-prompt.md    # rendered system prompt for the subagent
 *     worktree            # symlink to the actual worktree, when used
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

export type TaskStatus =
  | 'spawning'
  | 'running'
  | 'ok'
  | 'aborted'
  | 'failed'
  | 'crashed'
  | 'spawn_failed';

export interface MetaJson {
  v: 1;
  taskId: string;
  parentId: string;
  agent: string;
  task: string;
  startedAt: string;
  endedAt: string | null;
  status: TaskStatus;
  mainPid: number;
  subPid: number | null;
  paneId: string | null;
  windowId: string | null;
  cwd: string;
  worktreePath: string | null;
  placement: string;
}

export function stateRoot(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, 'pi', 'subagent');
  }
  return join(homedir(), '.local', 'state', 'pi', 'subagent');
}

export function taskDir(taskId: string): string {
  return join(stateRoot(), taskId);
}

export function socketPath(taskId: string): string {
  return join(taskDir(taskId), 'main.sock');
}

export function auditLogPath(taskId: string): string {
  return join(taskDir(taskId), 'bus.jsonl');
}

export function metaPath(taskId: string): string {
  return join(taskDir(taskId), 'meta.json');
}

export function systemPromptPath(taskId: string): string {
  return join(taskDir(taskId), 'system-prompt.md');
}

export function ensureTaskDir(taskId: string): string {
  const dir = taskDir(taskId);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  return dir;
}

export function writeMeta(meta: MetaJson): void {
  writeFileSync(
    metaPath(meta.taskId),
    JSON.stringify(meta, null, 2),
    {encoding: 'utf-8', mode: 0o600},
  );
}

export function readMeta(taskId: string): MetaJson | null {
  try {
    const data = readFileSync(metaPath(taskId), 'utf-8');
    return JSON.parse(data) as MetaJson;
  } catch {
    return null;
  }
}

export function updateMeta(
  taskId: string,
  patch: Partial<MetaJson>,
): MetaJson | null {
  const existing = readMeta(taskId);
  if (!existing) {
    return null;
  }
  const updated = {...existing, ...patch};
  writeMeta(updated);
  return updated;
}

function processAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the state root and mark any task whose recorded PIDs are no longer
 * alive as `crashed`. Returns the count of entries reaped.
 */
export function reapStaleEntries(): number {
  const root = stateRoot();
  if (!existsSync(root)) {
    return 0;
  }
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const taskId of entries) {
    const dir = join(root, taskId);
    let s;
    try {
      s = statSync(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) {
      continue;
    }
    const meta = readMeta(taskId);
    if (!meta) {
      continue;
    }
    if (meta.status !== 'running' && meta.status !== 'spawning') {
      continue;
    }
    if (processAlive(meta.mainPid) || processAlive(meta.subPid)) {
      continue;
    }
    updateMeta(taskId, {
      status: 'crashed',
      endedAt: new Date().toISOString(),
    });
    count++;
  }
  return count;
}

/**
 * Aggressive prune: remove the entire dir for completed/crashed entries
 * older than `maxAgeMs`. Not called automatically in v1; provided for tools.
 */
export async function pruneOldEntries(maxAgeMs: number): Promise<number> {
  const root = stateRoot();
  if (!existsSync(root)) {
    return 0;
  }
  const now = Date.now();
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const taskId of entries) {
    const meta = readMeta(taskId);
    if (!meta) {
      continue;
    }
    if (meta.status === 'running' || meta.status === 'spawning') {
      continue;
    }
    if (!meta.endedAt) {
      continue;
    }
    const ended = Date.parse(meta.endedAt);
    if (Number.isNaN(ended)) {
      continue;
    }
    if (now - ended < maxAgeMs) {
      continue;
    }
    try {
      await rm(join(root, taskId), {recursive: true, force: true});
      count++;
    } catch {
      // best effort
    }
  }
  return count;
}
