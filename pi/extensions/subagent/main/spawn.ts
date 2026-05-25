/**
 * Spawn a subagent in a tmux pane.
 *
 * The wrapper script lives in the task dir, sets the env vars, and execs
 * `pi -p '<task>' --append-system-prompt ...`. We don't pass the task via
 * `-p` directly to tmux because of quoting: the wrapper script reads the
 * task text from a file in the task dir so we never have to escape.
 *
 * Returns the pane id, window id, and the pi subprocess pid (read after
 * spawn via `tmux display-message`).
 */

import {execFile} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';

import type {Placement} from './agents.js';

const execFileAsync = promisify(execFile);

export interface SpawnArgs {
  taskId: string;
  taskDir: string;
  task: string;
  parentId: string;
  cwd: string;
  agentName: string;
  toolsWhitelist: string[];
  disallowedTools?: string[];
  systemPromptPath: string;
  placement: Placement;
}

export interface SpawnedPane {
  paneId: string;
  windowId: string;
  pid: number;
}

const WRAPPER_FILENAME = 'run.sh';
const TASK_FILENAME = 'task.txt';

/**
 * Tool names registered on the sub side by this extension. They must always
 * be in the allowlist passed to pi via --tools so the model can call them.
 * Kept in sync with sub/tools.ts.
 */
const BUS_TOOL_NAMES = ['report', 'progress', 'ask'] as const;

export async function ensureInTmux(): Promise<void> {
  if (!process.env.TMUX) {
    throw new Error(
      'subagent requires running inside tmux. $TMUX is not set.',
    );
  }
  // Cheap sanity check: this fails if tmux isn't reachable.
  await execFileAsync('tmux', ['display-message', '-p', '#{session_id}'], {
    timeout: 5_000,
  });
}

export async function spawnSubagentPane(args: SpawnArgs): Promise<SpawnedPane> {
  const taskFilePath = join(args.taskDir, TASK_FILENAME);
  writeFileSync(taskFilePath, args.task, {encoding: 'utf-8', mode: 0o600});

  const wrapperPath = join(args.taskDir, WRAPPER_FILENAME);
  writeFileSync(wrapperPath, renderWrapper(args), {
    encoding: 'utf-8',
    mode: 0o700,
  });

  const tmuxArgs = buildTmuxArgs(args, wrapperPath);
  const {stdout} = await execFileAsync('tmux', tmuxArgs, {timeout: 15_000});
  const [paneId, windowIdRaw, pidStr] = stdout.trim().split(/\s+/);
  if (!paneId || !pidStr) {
    throw new Error(
      `unexpected output from tmux split/new-window: ${JSON.stringify(stdout)}`,
    );
  }
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`tmux returned non-numeric pid: ${pidStr}`);
  }
  const windowId = windowIdRaw && windowIdRaw.startsWith('@')
    ? windowIdRaw
    : await lookupWindowId(paneId);

  await trySetTitles(
    paneId,
    windowId,
    args.agentName,
    args.taskId,
    args.placement,
  );

  return {paneId, windowId, pid};
}

async function lookupWindowId(paneId: string): Promise<string> {
  const {stdout} = await execFileAsync(
    'tmux',
    ['display-message', '-p', '-t', paneId, '#{window_id}'],
    {timeout: 5_000},
  );
  return stdout.trim();
}

async function trySetTitles(
  paneId: string,
  windowId: string,
  agentName: string,
  taskId: string,
  placement: Placement,
): Promise<void> {
  const shortTask = taskId.replace(/^msg_/, '').slice(0, 8);
  // Best-effort: these requires tmux 3.2+ and the right options; ignore errors.
  try {
    await execFileAsync(
      'tmux',
      ['select-pane', '-t', paneId, '-T', `subagent:${agentName}`],
      {timeout: 5_000},
    );
  } catch {
    // ignored
  }
  if (placement !== 'window' && placement !== 'window-detached') {
    return;
  }
  try {
    await execFileAsync(
      'tmux',
      ['rename-window', '-t', windowId, `pi:${agentName}:${shortTask}`],
      {timeout: 5_000},
    );
  } catch {
    // ignored
  }
}

function buildTmuxArgs(args: SpawnArgs, wrapperPath: string): string[] {
  const printFormat = '#{pane_id} #{window_id} #{pane_pid}';
  switch (args.placement) {
    case 'split-down':
      return [
        'split-window',
        '-v',
        '-d',
        '-P',
        '-F',
        printFormat,
        '-c',
        args.cwd,
        'bash',
        wrapperPath,
      ];
    case 'window':
      return [
        'new-window',
        '-P',
        '-F',
        printFormat,
        '-c',
        args.cwd,
        'bash',
        wrapperPath,
      ];
    case 'window-detached':
      return [
        'new-window',
        '-d',
        '-P',
        '-F',
        printFormat,
        '-c',
        args.cwd,
        'bash',
        wrapperPath,
      ];
    case 'split-right':
    default:
      return [
        'split-window',
        '-h',
        '-d',
        '-P',
        '-F',
        printFormat,
        '-c',
        args.cwd,
        'bash',
        wrapperPath,
      ];
  }
}

function renderWrapper(args: SpawnArgs): string {
  // The wrapper sets env vars, then execs pi reading the task text from a
  // file. We escape values via single-quote-bash-quoting (`'` -> `'\''`).
  const exports: string[] = [
    `export PI_SUBAGENT_TASK_ID=${shellQuote(args.taskId)}`,
    `export PI_SUBAGENT_BUS_DIR=${shellQuote(args.taskDir)}`,
    `export PI_SUBAGENT_PARENT_ID=${shellQuote(args.parentId)}`,
  ];

  const piArgs: string[] = [
    '"$(cat ' + shellQuote(join(args.taskDir, TASK_FILENAME)) + ')"',
    '--append-system-prompt',
    shellQuote(args.systemPromptPath),
    '--no-session',
  ];
  // Pi's --tools is an allowlist that covers built-in, extension, AND
  // custom tools. The bus tools registered by this extension on the sub
  // side (report, progress, ask) must always be available, so we splice
  // them into the whitelist regardless of the agent's declared `tools`.
  if (args.toolsWhitelist.length > 0) {
    const merged = Array.from(
      new Set([...args.toolsWhitelist, ...BUS_TOOL_NAMES]),
    );
    piArgs.push('--tools', shellQuote(merged.join(',')));
  }

  // The subagent runs in interactive mode (no `-p`) so its full TUI is
  // visible in the pane. The positional task argument is auto-submitted by
  // pi on startup; once the agent finishes that single prompt, pi waits for
  // further user input. The main side either kills the pane on done
  // (close_on_success) or leaves it alive for inspection / interaction.
  return [
    '#!/usr/bin/env bash',
    'set -e',
    ...exports,
    `cd ${shellQuote(args.cwd)}`,
    'exec pi ' + piArgs.join(' '),
    '',
  ].join('\n');
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export async function sendKeysCtrlC(paneId: string): Promise<void> {
  await execFileAsync('tmux', ['send-keys', '-t', paneId, 'C-c'], {
    timeout: 5_000,
  });
}

export async function killPane(paneId: string): Promise<void> {
  try {
    await execFileAsync('tmux', ['kill-pane', '-t', paneId], {timeout: 5_000});
  } catch {
    // Pane may already be gone; ignore.
  }
}
