import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {spawn} from 'node:child_process';
import {closeSync, openSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {type PiRuntime, runningPiRuntime} from './runtime.js';

export interface SpawnArgs {
  taskId: string;
  taskDir: string;
  socketPath: string;
  task: string;
  parentId: string;
  cwd: string;
  model?: {provider: string; id: string};
  thinkingLevel?: ReturnType<ExtensionAPI['getThinkingLevel']>;
  toolsWhitelist: string[];
  disallowedTools?: string[];
  systemPromptPath: string;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface SpawnedProcess {
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  exited: Promise<ProcessExit>;
  isGroupAlive(): boolean;
  signal(signal: NodeJS.Signals): void;
}

const BUS_TOOL_NAMES = ['report', 'progress', 'ask'] as const;

export async function spawnSubagent(
  args: SpawnArgs,
  runtime: PiRuntime = runningPiRuntime(),
): Promise<SpawnedProcess> {
  writeFileSync(join(args.taskDir, 'task.txt'), args.task, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  const wrapperPath = join(args.taskDir, 'run.sh');
  writeFileSync(wrapperPath, renderWrapper(args, runtime), {
    encoding: 'utf-8',
    mode: 0o700,
  });
  const stdoutPath = join(args.taskDir, 'stdout.log');
  const stderrPath = join(args.taskDir, 'stderr.log');
  const fds: number[] = [];
  try {
    fds.push(openSync(stdoutPath, 'a', 0o600));
    fds.push(openSync(stderrPath, 'a', 0o600));
    // A separate process group lets cancellation include launcher/tool children.
    const child = spawn('bash', [wrapperPath], {
      cwd: args.cwd,
      detached: true,
      stdio: ['ignore', fds[0], fds[1]],
    });
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once('error', (error) => {
        resolve({code: null, signal: null, error: error.message});
      });
      child.once('exit', (code, signal) => {
        resolve({code, signal});
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    // POSIX retains the group ID while descendants still belong to it, even
    // after the leader exits. Latch disappearance so later calls cannot signal
    // a reused ID. This owns one process group, not descendants that detach.
    let groupGone = false;
    const isGroupAlive = () => {
      if (groupGone) {
        return false;
      }
      try {
        process.kill(-child.pid!, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          groupGone = true;
          return false;
        }
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          // Includes transient unreaped members on macOS. Permission failure
          // is not evidence that the group is gone.
          return true;
        }
        throw error;
      }
    };
    void exited.then(() => {
      try {
        isGroupAlive();
      } catch {
        // Surface permission errors through the caller's cleanup path.
      }
    });
    return {
      pid: child.pid!,
      stdoutPath,
      stderrPath,
      exited,
      isGroupAlive,
      signal(signal) {
        if (!isGroupAlive()) {
          return;
        }
        try {
          process.kill(-child.pid!, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
          groupGone = true;
        }
      },
    };
  } finally {
    for (const fd of fds) {
      closeSync(fd);
    }
  }
}

export function waitForExit(
  child: SpawnedProcess,
  timeoutMs: number,
): Promise<ProcessExit | undefined> {
  return new Promise((resolve, reject) => {
    let exit: ProcessExit | undefined;
    const finish = (result?: ProcessExit, error?: unknown) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const check = () => {
      try {
        if (exit && !child.isGroupAlive()) {
          finish(exit);
        }
      } catch (error) {
        finish(undefined, error);
      }
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    const poll = setInterval(check, 20);
    void child.exited.then((result) => {
      exit = result;
      check();
    });
  });
}

export async function terminateProcess(
  child: SpawnedProcess,
  graceMs: number,
  killGraceMs: number,
): Promise<ProcessExit> {
  let exit = await waitForExit(child, graceMs);
  if (exit) {
    return exit;
  }
  child.signal('SIGTERM');
  exit = await waitForExit(child, killGraceMs);
  if (exit) {
    return exit;
  }
  child.signal('SIGKILL');
  exit = await waitForExit(child, killGraceMs);
  if (!exit) {
    throw new Error(`subagent process ${child.pid} did not exit after SIGKILL`);
  }
  return exit;
}

export function renderWrapper(
  args: SpawnArgs,
  runtime: PiRuntime = runningPiRuntime(),
): string {
  const exports = [
    `export PI_SUBAGENT_TASK_ID=${shellQuote(args.taskId)}`,
    `export PI_SUBAGENT_BUS_DIR=${shellQuote(args.taskDir)}`,
    `export PI_SUBAGENT_SOCKET_PATH=${shellQuote(args.socketPath)}`,
    `export PI_SUBAGENT_PARENT_ID=${shellQuote(args.parentId)}`,
  ];
  const command = [runtime.executable, ...runtime.args].map(shellQuote).join(
    ' ',
  );
  const piArgs = [
    '-p',
    '--append-system-prompt',
    shellQuote(args.systemPromptPath),
    '--no-session',
  ];
  if (args.model) {
    piArgs.push(
      '--provider',
      shellQuote(args.model.provider),
      '--model',
      shellQuote(args.model.id),
    );
  }
  if (args.thinkingLevel !== undefined) {
    piArgs.push('--thinking', shellQuote(args.thinkingLevel));
  }
  const denied = new Set(args.disallowedTools ?? []);
  if (BUS_TOOL_NAMES.some((name) => denied.has(name))) {
    throw new Error(
      'disallowed_tools must not exclude report, progress, or ask',
    );
  }
  const tools = Array.from(
    new Set([...args.toolsWhitelist, ...BUS_TOOL_NAMES]),
  );
  piArgs.push('--tools', shellQuote(tools.join(',')));
  if (denied.size > 0) {
    piArgs.push('--exclude-tools', shellQuote([...denied].join(',')));
  }
  piArgs.push(
    '--',
    '"$(cat ' + shellQuote(join(args.taskDir, 'task.txt')) + ')"',
  );
  return [
    '#!/usr/bin/env bash',
    'set -e',
    ...exports,
    `cd ${shellQuote(args.cwd)}`,
    `exec ${command} ` + piArgs.join(' '),
    '',
  ].join('\n');
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
