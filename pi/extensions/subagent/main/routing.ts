/**
 * Route bus envelopes to lifecycle/UI events and answer background asks.
 * Reports are provisional even when the child marks them final. Only the
 * controller's finalized completion is delivered to the main model, via
 * notifications.ts. Sync tools stream their own progress through onUpdate.
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
}

export function installMainRoutingFor(
  task: ActiveTask,
  options: MainRoutingOptions,
): () => void {
  const {pi, getCtx} = options;
  const unsub = task.bus.subscribe((env) => {
    if (env.from !== 'sub' || task.ownerClosed) {
      return;
    }
    if (env.type === 'ask') {
      // Sync mode answers in its per-call subscriber, never twice.
      if (task.mode === 'background') {
        void handleAsk({
          pi,
          ctx: getCtx(),
          task,
          askId: env.id,
          question: env.payload.question,
          defaultAnswer: env.payload.default,
          policy: task.askPolicy,
        });
      }
      return;
    }
    emitLifecycleFromEnvelope(pi, task, env);
  });
  task.cleanup.push(unsub);
  return unsub;
}

/** Ask lifecycle events are emitted by handleAsk, alongside the bus reply. */
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
    default:
      break;
  }
}
