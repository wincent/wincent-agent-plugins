import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import {AuditLog} from './bus/audit-log.js';
import {Bus} from './bus/bus.js';
import type {DoneStatus} from './bus/envelope.js';
import {connectToPeer} from './bus/transport-uds.js';
import {reapStaleEntries} from './main/state.js';
import {installStatus} from './main/status.js';
import {CONNECT_TIMEOUT_MS, registerMainTools} from './main/tools.js';
import {installSubRouting} from './sub/routing.js';
import {registerSubTools} from './sub/tools.js';

export default function subagentExtension(pi: ExtensionAPI): void {
  const taskId = process.env.PI_SUBAGENT_TASK_ID;
  const busDir = process.env.PI_SUBAGENT_BUS_DIR;
  if (!taskId && !busDir) {
    pi.on('session_start', () => {
      reapStaleEntries();
    });
    registerMainTools({pi});
    installStatus(pi);
    return;
  }
  if (!taskId || !busDir) {
    throw new Error(
      'subagent extension: PI_SUBAGENT_TASK_ID and PI_SUBAGENT_BUS_DIR must both be set, or neither',
    );
  }
  installSubMode(pi, busDir);
}

function installSubMode(pi: ExtensionAPI, busDir: string): void {
  let bus: Bus | undefined;
  let storedCtx: ExtensionContext | undefined;
  let doneSent = false;
  let cancelReason: string | undefined;
  let finalText: string | undefined;
  let outcome: DoneStatus = 'failed';
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  registerSubTools(pi, {
    getBus: () => {
      if (!bus || bus.isClosed || cancelReason) {
        throw new Error('subagent bus is unavailable or task was cancelled');
      }
      return bus;
    },
  });

  const abort = (reason: string) => {
    if (doneSent || cancelReason) {
      return;
    }
    cancelReason = reason;
    outcome = 'aborted';
    process.exitCode = 1;
    storedCtx?.abort();
    // Print mode has no shutdownHandler. Bound orphan lifetime if a tool
    // ignores cancellation after the controlling process has disappeared.
    shutdownTimer = setTimeout(() => process.exit(1), 5_000);
    shutdownTimer.unref();
  };

  pi.on('session_start', async (_event, ctx) => {
    storedCtx = ctx;
    try {
      const transport = await connectToPeer(`${busDir}/main.sock`, {
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
      bus = new Bus(transport, new AuditLog(`${busDir}/bus.jsonl`), 'sub');
      bus.onPeerClose(() => abort('controlling agent disconnected'));
      unsubscribe = installSubRouting(pi, {
        bus,
        getCtx: () => storedCtx,
        onCancel: abort,
      });
    } catch (error) {
      process.stderr.write(
        `[subagent sub] startup failed: ${(error as Error).message}\n`,
      );
      // Pi reports session_start exceptions but still submits the initial prompt.
      // Without the owner connection there is no safe task to execute.
      process.exit(1);
    }
  });

  pi.on('input', async () => {
    if (cancelReason) {
      await sendDone('aborted', cancelReason);
      return {action: 'handled'};
    }
  });
  pi.on('tool_call', () => {
    if (cancelReason) {
      return {block: true, reason: cancelReason};
    }
  });
  pi.on('agent_end', (event) => {
    finalText = lastAssistantText(event.messages);
  });
  pi.on('agent_before_settle', (event) => {
    outcome = event.outcome === 'completed'
      ? 'ok'
      : event.outcome === 'aborted'
      ? 'aborted'
      : 'failed';
  });
  pi.on('agent_settled', async () => {
    await sendDone(cancelReason ? 'aborted' : outcome, cancelReason);
  });
  pi.on('session_shutdown', async (event) => {
    clearTimeout(shutdownTimer);
    unsubscribe?.();
    await sendDone(
      cancelReason ? 'aborted' : 'failed',
      cancelReason ?? `session ended before task settled (${event.reason})`,
    );
    await bus?.close();
  });

  async function sendDone(status: DoneStatus, error?: string): Promise<void> {
    if (doneSent) {
      return;
    }
    doneSent = true;
    if (status !== 'ok') {
      process.exitCode = 1;
    }
    if (!bus) {
      return;
    }
    try {
      if (!bus.isClosed) {
        bus.emit('done', {
          status,
          ...(error ? {error} : {}),
          ...(finalText ? {finalText} : {}),
        });
      }
    } finally {
      await bus.close();
    }
  }
}

function lastAssistantText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {role?: string; content?: unknown};
    if (message?.role !== 'assistant') {
      continue;
    }
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part: {type?: string; text?: unknown}) =>
          part.type === 'text' && typeof part.text === 'string'
        )
        .map((part: {text: string}) => part.text)
        .join('\n');
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}
