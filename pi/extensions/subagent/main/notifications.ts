import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';

import {describeResult} from './description.js';
import type {ActiveTask} from './registry.js';
import type {SubagentDetails} from './result.js';

/** Session-local delivery state; saved reports remain the source of truth. */
export function installCompletionNotifications(pi: ExtensionAPI) {
  const pending = new Map<string, string>();
  const handled = new Set<string>();
  let closed = false;
  let outcome: 'completed' | 'aborted' | 'error' = 'completed';

  const reset = () => {
    pending.clear();
    handled.clear();
  };
  pi.on('session_start', () => {
    reset();
    closed = false;
    outcome = 'completed';
  });
  pi.on('session_shutdown', () => {
    closed = true;
    reset();
  });

  const message = () => ({
    customType: 'subagent-completion',
    content: [...pending.values()].join('\n\n'),
    // Let the agent synthesize the outcome, rather than showing a synthetic
    // user message followed by an acknowledgment of that same message.
    display: false,
    details: {taskIds: [...pending.keys()]},
  });
  const delivered = () => {
    for (const id of pending.keys()) {
      handled.add(id);
    }
    pending.clear();
  };
  const flushIdle = () => {
    // This guard also applies to completions arriving after an aborted/error
    // run has settled. They must not revive it through the idle enqueue path.
    if (closed || pending.size === 0 || outcome !== 'completed') {
      return;
    }
    const notice = message();
    try {
      pi.sendMessage(notice, {triggerTurn: true, deliverAs: 'followUp'});
      delivered();
    } catch (error) {
      // Keep the pending notice available for the next boundary on a
      // synchronous delivery failure. Pi reports asynchronous failures itself.
      process.stderr.write(
        `[subagent main] completion delivery failed: ${
          (error as Error).message
        }\n`,
      );
    }
  };
  const flushBoundary = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
    outcome = event.outcome;
    if (closed || pending.size === 0 || event.outcome !== 'completed') {
      return;
    }
    const notice = message();
    delivered();
    return {
      // Boundary entries replace the accumulated drafts; preserve preceding
      // extensions' messages, context edits, and compactions.
      entries: [...event.entries, {type: 'custom_message' as const, ...notice}],
      continue: true,
    };
  };
  pi.on('turn_end', flushBoundary);
  pi.on('agent_before_settle', flushBoundary);
  // Covers completion during asynchronous pre-settlement handlers, after our
  // boundary hook has already run. Pi defers triggered messages until settled.
  // Do not revive an aborted/error run: those notices wait for the next input.
  pi.on('agent_settled', flushIdle);

  return {
    enqueue(task: ActiveTask, result: string, ctx: ExtensionContext) {
      if (
        closed || task.ownerClosed || task.mode !== 'background' ||
        handled.has(task.taskId) || pending.has(task.taskId)
      ) {
        return;
      }
      pending.set(
        task.taskId,
        `[subagent ${task.agentName}:${task.taskId}] ${result}`,
      );
      if (ctx.isIdle()) {
        flushIdle();
      }
    },
    retrieved(details: SubagentDetails) {
      // An interim report, a history listing, or a legacy reconstruction is
      // not equivalent to observing the authoritative saved final result.
      if (!details.resultPath || !describeResult(details).finalized) {
        return;
      }
      pending.delete(details.taskId);
      handled.add(details.taskId);
    },
  };
}

export type CompletionNotifications = ReturnType<
  typeof installCompletionNotifications
>;
