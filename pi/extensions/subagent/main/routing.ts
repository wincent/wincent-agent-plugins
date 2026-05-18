/**
 * Routing of incoming bus envelopes on the main side, for any task that
 * is NOT currently being awaited by a synchronous tool call.
 *
 * The synchronous `subagent` tool installs its own subscriber for the
 * duration of the call and routes through `onUpdate`. Once the tool
 * returns (or for `background: true` tasks), this extension-scoped
 * subscriber takes over and routes envelopes into the main agent's
 * session as synthetic user messages.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import type {Envelope} from '../bus/envelope.js';
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
      // Lifecycle events fire regardless.
      emitLifecycleFromEnvelope(pi, task, env);
      return;
    }
    emitLifecycleFromEnvelope(pi, task, env);
    routeEnvelopeAsUserMessage(pi, getCtx(), task, env);
  });
  task.cleanup.push(unsub);
  return unsub;
}

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
    case 'ask':
      emitLifecycle(pi, 'subagent:asked', {
        taskId: task.taskId,
        question: env.payload.question,
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
    case 'ask':
      text = `${prefix} asks: ${env.payload.question}`;
      break;
    case 'done':
      text = `${prefix} done (${env.payload.status}). ${
        env.payload.finalText ?? ''
      }`.trim();
      break;
    default:
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
