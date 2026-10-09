import type {DonePayload} from '../bus/envelope.js';
import type {ActiveTask} from './registry.js';
import {type ProcessExit, terminateProcess, waitForExit} from './spawn.js';

export const CANCEL_GRACE_MS = 5_000;
export const SIGKILL_GRACE_MS = 5_000;

export interface TaskOutcome {
  status: 'ok' | 'failed' | 'aborted' | 'crashed';
  error?: string;
  finalText?: string;
  exit?: ProcessExit;
}

export function cancelTask(
  task: ActiveTask,
  options: {reason: string; graceMs: number; killGraceMs?: number},
): Promise<void> {
  if (!task.cancellation) {
    task.cancelReason = options.reason;
    task.cancellation = (async () => {
      try {
        task.bus.emit('cancel', {
          reason: options.reason,
          graceMs: options.graceMs,
        });
      } catch {
        // A dead bus still requires process cleanup.
      }
      await terminateProcess(
        task.process,
        options.graceMs,
        options.killGraceMs ?? SIGKILL_GRACE_MS,
      );
    })();
  }
  return task.cancellation;
}

/** Completion requires process exit, not merely a report or a closed socket. */
export function observeTask(
  task: ActiveTask,
  options: {exitGraceMs?: number; killGraceMs?: number} = {},
): Promise<TaskOutcome> {
  const exitGraceMs = options.exitGraceMs ?? CANCEL_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? SIGKILL_GRACE_MS;
  return new Promise((resolve) => {
    let done: DonePayload | undefined;
    let finishing = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = async () => {
      if (finishing) {
        return;
      }
      finishing = true;
      clearTimeout(exitTimer);
      let exit: ProcessExit | undefined;
      let error: string | undefined;
      try {
        exit = await waitForExit(task.process, exitGraceMs);
        if (!exit) {
          exit = await terminateProcess(task.process, 0, killGraceMs);
          error = 'subagent did not exit after closing its task';
        }
      } catch (err) {
        error = (err as Error).message;
      }
      unsub();
      unsubClose();
      let status: TaskOutcome['status'];
      if (task.cancelReason) {
        status = 'aborted';
        error = error ?? task.cancelReason;
      } else if (!done) {
        status = 'crashed';
        error = error ?? 'subagent process exited without sending done';
      } else if (done.status === 'aborted' && exit) {
        status = 'aborted';
        error = error ?? done.error;
      } else if (error || exit?.error || exit?.code !== 0) {
        status = 'failed';
        error = error ?? exit?.error ??
          `subagent exited with code=${exit?.code}, signal=${exit?.signal}`;
      } else {
        status = done.status;
        error = done.error;
      }
      task.status = status;
      resolve({status, error, finalText: done?.finalText, exit});
    };
    const unsub = task.bus.subscribe((env) => {
      if (env.from === 'sub' && env.type === 'done') {
        done = env.payload;
        void finish();
      }
    });
    const unsubClose = task.bus.onPeerClose(() => void finish());
    // Exit can precede delivery of the last socket data. Allow that data to drain,
    // but don't wait indefinitely if a descendant has kept the socket open.
    void task.process.exited.then(() => {
      if (!finishing) {
        exitTimer = setTimeout(
          () => void finish(),
          Math.min(exitGraceMs, 1_000),
        );
      }
    });
    if (task.bus.isClosed) {
      void finish();
    }
  });
}
