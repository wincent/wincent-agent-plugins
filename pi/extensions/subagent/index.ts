/**
 * Subagent extension.
 *
 * One extension, two modes. Role is decided at load time from the
 * PI_SUBAGENT_TASK_ID / PI_SUBAGENT_BUS_DIR environment variables.
 *
 *   - main mode: registers the `subagent`, `subagent_steer`,
 *     `subagent_cancel`, and `subagent_status` tools. Spawns subagent pi
 *     processes in tmux panes and routes their bus envelopes.
 *
 *   - sub mode: registers the `report`, `ask`, and `progress` tools.
 *     Connects to the main side's UDS at PI_SUBAGENT_BUS_DIR/main.sock
 *     and hooks lifecycle events to ensure a final `done` envelope is
 *     always sent.
 *
 * See pi/extensions/subagent/PLAN.md for the full design (link is to the
 * repo's PLAN.md at the root).
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import {AuditLog} from './bus/audit-log.js';
import {Bus} from './bus/bus.js';
import {connectToPeer} from './bus/transport-uds.js';
import {reapStaleEntries} from './main/state.js';
import {CONNECT_TIMEOUT_MS, registerMainTools} from './main/tools.js';
import {installSubRouting} from './sub/routing.js';
import {registerSubTools} from './sub/tools.js';

interface SubModeEnv {
  taskId: string;
  busDir: string;
  parentId: string;
}

function detectSubMode(): SubModeEnv | null {
  const taskId = process.env.PI_SUBAGENT_TASK_ID;
  const busDir = process.env.PI_SUBAGENT_BUS_DIR;
  const parentId = process.env.PI_SUBAGENT_PARENT_ID;
  if (!taskId && !busDir) {
    return null;
  }
  if (!taskId || !busDir) {
    throw new Error(
      'subagent extension: corrupt environment — both PI_SUBAGENT_TASK_ID and PI_SUBAGENT_BUS_DIR must be set, or neither',
    );
  }
  return {taskId, busDir, parentId: parentId ?? ''};
}

export default async function subagentExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const sub = detectSubMode();
  if (sub) {
    await installSubMode(pi, sub);
  } else {
    await installMainMode(pi);
  }
}

async function installMainMode(pi: ExtensionAPI): Promise<void> {
  // Reap stale state from previous crashes before doing anything else.
  try {
    reapStaleEntries();
  } catch (err) {
    process.stderr.write(
      `[subagent main] reapStaleEntries failed: ${(err as Error).message}\n`,
    );
  }
  registerMainTools({pi});
}

async function installSubMode(
  pi: ExtensionAPI,
  env: SubModeEnv,
): Promise<void> {
  const socketPath = `${env.busDir}/main.sock`;
  const auditLogPath = `${env.busDir}/bus.jsonl`;

  let bus: Bus | null = null;
  let storedCtx: ExtensionContext | undefined;
  let doneSent = false;

  const connectAndBind = async () => {
    if (bus) {
      return;
    }
    const transport = await connectToPeer(socketPath, {
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    const auditLog = new AuditLog(auditLogPath);
    bus = new Bus(transport, auditLog, 'sub');
    bus.onPeerClose(() => {
      // The main side closed. Mark done if we haven't already; the process
      // will exit naturally once the agent loop is done.
      void sendDoneIfMissing('aborted', 'main side closed bus');
    });
    registerSubTools(pi, {bus});
    installSubRouting(pi, {bus, getCtx: () => storedCtx});
  };

  // Subagent's pi starts up and the extension is loaded before the first
  // user prompt. Connect synchronously here.
  try {
    await connectAndBind();
  } catch (err) {
    process.stderr.write(
      `[subagent sub] failed to connect to main: ${(err as Error).message}\n`,
    );
    // We can't usefully continue; exit. The main will time out and report.
    process.exit(1);
  }

  // Capture the context the first time it's available so steer/cancel can
  // act on it later.
  pi.on('session_start', async (_event, ctx) => {
    storedCtx = ctx;
  });

  pi.on('agent_end', async (event, ctx) => {
    storedCtx = ctx;
    const finalText = lastAssistantText(event);
    await sendDoneIfMissing('ok', undefined, finalText);
  });

  pi.on('session_shutdown', async (event, _ctx) => {
    // Last chance to send done. If we already sent ok, this is a no-op.
    const reason = event.reason === 'quit'
      ? 'ok'
      : 'aborted';
    await sendDoneIfMissing(
      reason as 'ok' | 'aborted',
      `session_shutdown:${event.reason}`,
    );
  });

  async function sendDoneIfMissing(
    status: 'ok' | 'failed' | 'aborted',
    error?: string,
    finalText?: string,
  ): Promise<void> {
    if (doneSent || !bus || bus.isClosed) {
      return;
    }
    doneSent = true;
    try {
      bus.emit('done', {
        status,
        ...(error ? {error} : {}),
        ...(finalText ? {finalText} : {}),
      });
    } catch (err) {
      process.stderr.write(
        `[subagent sub] failed to send done: ${(err as Error).message}\n`,
      );
    }
    // Give the audit log a moment to flush before the process exits.
    try {
      await bus.close();
    } catch {
      // ignored
    }
  }
}

function lastAssistantText(event: {messages: unknown[]}): string | undefined {
  const messages = event.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {role?: string; content?: unknown};
    if (msg?.role !== 'assistant') {
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const part = msg.content[j] as {type?: string; text?: string};
        if (part?.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
      }
    } else if (typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return undefined;
}
