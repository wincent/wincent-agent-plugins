/**
 * Routing of incoming bus envelopes on the main side, for any task that
 * is NOT currently being awaited by a synchronous tool call.
 *
 * The synchronous `subagent` tool installs its own subscriber for the
 * duration of the call and routes through `onUpdate`. Once the tool
 * returns (or for `background: true` tasks), this extension-scoped
 * subscriber takes over and routes envelopes into the main agent's
 * session as synthetic user messages.
 *
 * `ask` envelopes are a special case: they need a reply on the bus, not
 * a one-way user-message injection. Both sync and background paths
 * delegate to `handleAsk`, which honours the task's resolved
 * `askPolicy`. Sync mode wires this directly inside the tool's
 * subscriber; background mode wires it here so the policy still
 * applies after the original tool call has returned.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import type {Envelope} from '../bus/envelope.js';
import {handleAsk} from './ask.js';
import {emitLifecycle} from './events.js';
import type {ActiveTask} from './registry.js';

export interface MainRoutingOptions {
  pi: ExtensionAPI;
  getCtx: () => ExtensionContext | undefined;
  /**
   * If true (default), envelopes from background-mode tasks are injected
   * as user messages into the main session. Sync-mode tasks suppress this
   * via their own per-call subscriber.
   */
  injectForBackground?: boolean;
}

export function installMainRoutingFor(
  task: ActiveTask,
  options: MainRoutingOptions,
): () => void {
  const {pi, getCtx} = options;
  const inject = options.injectForBackground ?? true;
  const unsub = task.bus.subscribe((env) => {
    if (env.from !== 'sub') {
      return;
    }
    if (!inject || task.mode !== 'background') {
      // Sync tasks: the in-flight tool call handles surfacing.
      // Lifecycle events fire regardless. `ask` is handled inline by
      // runSyncWait, not here, to avoid double-replying on the bus.
      if (env.type !== 'ask') {
        emitLifecycleFromEnvelope(pi, task, env);
      }
      return;
    }
    // Background mode.
    if (env.type === 'ask') {
      void handleAsk({
        pi,
        ctx: getCtx(),
        task,
        askId: env.id,
        question: env.payload.question,
        defaultAnswer: env.payload.default,
        policy: task.askPolicy,
      });
      return;
    }
    emitLifecycleFromEnvelope(pi, task, env);
    routeEnvelopeAsUserMessage(pi, getCtx(), task, env);
  });
  task.cleanup.push(unsub);
  return unsub;
}

/**
 * Note: `ask` envelopes are intentionally not handled here. The
 * `subagent:asked` and `subagent:answered` lifecycle events are emitted
 * by `handleAsk()` (which is the single place that produces a reply on
 * the bus). Calling this function for an `ask` envelope is a no-op.
 */
function emitLifecycleFromEnvelope(
  pi: ExtensionAPI,
  task: ActiveTask,
  env: Envelope,
): void {
  switch (env.type) {
    case 'progress':
      emitLifecycle(pi, 'subagent:progress', {
        taskId: task.taskId,
        text: env.payload.text,
        kind: env.payload.kind,
      });
      break;
    case 'report':
      emitLifecycle(pi, 'subagent:report', {
        taskId: task.taskId,
        summary: env.payload.summary,
        branch: env.payload.branch,
        commits: env.payload.commits,
      });
      break;
    case 'done':
      emitLifecycle(pi, 'subagent:done', {
        taskId: task.taskId,
        status: env.payload.status,
        durationMs: Date.now() - task.startedAt,
      });
      break;
    default:
      break;
  }
}

function routeEnvelopeAsUserMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  task: ActiveTask,
  env: Envelope,
): void {
  const prefix = `[subagent ${task.agentName}:${shortId(task.taskId)}]`;
  let text: string | null = null;
  switch (env.type) {
    case 'progress':
      // Skip individual progress for background to avoid spam; reports are
      // the meaningful boundary.
      return;
    case 'report':
      text = `${prefix} report: ${
        describeReport(env.payload.summary, env.payload.branch)
      }`;
      break;
    case 'done':
      text = `${prefix} done (${env.payload.status}). ${
        env.payload.finalText ?? ''
      }`.trim();
      break;
    default:
      // `ask` is handled by handleAsk(); everything else is uninteresting.
      return;
  }
  if (!text) {
    return;
  }
  try {
    if (!ctx || ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, {deliverAs: 'followUp'});
    }
  } catch (err) {
    process.stderr.write(
      `[subagent main] sendUserMessage failed: ${(err as Error).message}\n`,
    );
  }
}

function describeReport(summary: string, branch?: string): string {
  const parts: string[] = [summary];
  if (branch) {
    parts.push(`(branch: ${branch})`);
  }
  return parts.join(' ');
}

function shortId(taskId: string): string {
  return taskId.replace(/^msg_/, '').slice(0, 8);
}
