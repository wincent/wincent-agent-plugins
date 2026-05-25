/**
 * In-process registry of active subagents on the main side.
 *
 * Tracks one entry per spawned subagent: bus, pane id, agent name, status,
 * background-mode flag. Used by:
 *   - The synchronous `subagent` tool to manage its own task while it waits.
 *   - The `subagent_steer` / `subagent_cancel` / `subagent_status` tools to
 *     find an existing task.
 *   - The background routing path so envelopes from a still-running
 *     subagent can be injected into the main agent's session as user
 *     messages.
 */

import type {Bus} from '../bus/bus.js';
import type {Envelope, ReportEnvelope} from '../bus/envelope.js';
import type {AskPolicy} from './agents.js';

export type TaskMode = 'sync' | 'background';

export interface ActiveTask {
  taskId: string;
  agentName: string;
  task: string;
  paneId: string | null;
  windowId: string | null;
  pid: number | null;
  bus: Bus;
  mode: TaskMode;
  worktreePath: string | null;
  startedAt: number;
  /** Subscribers that should be cleaned up on task end. */
  cleanup: (() => void)[];
  /** Final report (most recent `final: true` report received). */
  finalReport?: ReportEnvelope['payload'];
  /** Most recent any-report received. */
  lastReport?: ReportEnvelope['payload'];
  /** Last status from the subagent. */
  status: 'running' | 'ok' | 'failed' | 'aborted' | 'crashed';
  /**
   * Resolved ask policy for this task: per-call override beats agent
   * frontmatter beats the global default of `'human'`. Read by routing
   * for background-mode asks; sync mode passes it through as a closure.
   */
  askPolicy: AskPolicy;
  /**
   * Number of successful `'llm'`-policy answers given since the last
   * budget escalation (or since the task started). Compared against
   * the budget in `ask.ts` to decide when to escalate to a human.
   * Reset to 0 every time an escalation is attempted, regardless of
   * whether the human typed an answer.
   */
  llmAnswersSinceEscalation: number;
  /**
   * Total successful `'llm'`-policy answers given over the lifetime of
   * the task. Diagnostic; never reset. Surfaced in the `subagent:done`
   * lifecycle event.
   */
  llmAnswersTotal: number;
}

const tasks = new Map<string, ActiveTask>();

export function register(task: ActiveTask): void {
  tasks.set(task.taskId, task);
}

export function lookup(taskId: string): ActiveTask | undefined {
  return tasks.get(taskId);
}

export function remove(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task) {
    return;
  }
  for (const fn of task.cleanup) {
    try {
      fn();
    } catch {
      // ignored
    }
  }
  tasks.delete(taskId);
}

export function listActive(): ActiveTask[] {
  return Array.from(tasks.values());
}

/**
 * Convenience: subscribe to a task's bus and update local state from
 * incoming envelopes. Returns the unsubscribe function (already added to
 * task.cleanup).
 */
export function trackBus(
  task: ActiveTask,
  onUpdate?: (env: Envelope) => void,
): () => void {
  const unsub = task.bus.subscribe((env) => {
    if (env.type === 'report') {
      task.lastReport = env.payload;
      if (env.payload.final !== false) {
        task.finalReport = env.payload;
      }
    } else if (env.type === 'done') {
      task.status = env.payload.status === 'ok'
        ? 'ok'
        : env.payload.status === 'aborted'
        ? 'aborted'
        : 'failed';
    }
    onUpdate?.(env);
  });
  task.cleanup.push(unsub);
  return unsub;
}
