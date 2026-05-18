/**
 * Routing of incoming bus envelopes on the subagent side.
 *
 * - `steer`: inject the text as a synthetic user message into the running
 *   session (via `pi.sendUserMessage`).
 * - `cancel`: abort the session and let the normal teardown path send
 *   `done(aborted)`.
 * - `answer`: handled implicitly by the Bus's request/reply matcher (we
 *   register a no-op subscriber here purely for visibility in the audit log).
 *
 * The subagent is invoked headlessly with `pi -p '<task>'`, so the main
 * agent's prompt is already a "user message" that has triggered processing.
 * Steers arrive mid-stream and route through `deliverAs: 'steer'`; if
 * somehow the agent is idle when one arrives we fall back to a plain
 * `sendUserMessage` which will trigger a new turn.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import type {Bus} from '../bus/bus.js';
import type {Envelope} from '../bus/envelope.js';

export interface SubRoutingOptions {
  bus: Bus;
  getCtx: () => ExtensionContext | undefined;
}

export function installSubRouting(
  pi: ExtensionAPI,
  options: SubRoutingOptions,
): () => void {
  const {bus, getCtx} = options;

  const unsubscribe = bus.subscribe((env: Envelope) => {
    if (env.from !== 'main') {
      return;
    }
    switch (env.type) {
      case 'steer':
        deliverSteer(pi, getCtx(), env.payload.text);
        break;
      case 'cancel':
        deliverCancel(getCtx(), env.payload.reason);
        break;
      case 'answer':
        // Bus.request already resolved the pending promise; nothing to do.
        break;
      default:
        // Other types (progress, report, ask, done) are sub->main only.
        break;
    }
  });

  return unsubscribe;
}

function deliverSteer(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  text: string,
): void {
  const message = `[main steer] ${text}`;
  if (!ctx) {
    // Not yet bound to a session: drop with a warning. The main side will
    // see no behavior change and can decide to resend.
    process.stderr.write(
      '[subagent sub] received steer before context was available; dropping\n',
    );
    return;
  }
  try {
    if (ctx.isIdle()) {
      pi.sendUserMessage(message);
    } else {
      pi.sendUserMessage(message, {deliverAs: 'steer'});
    }
  } catch (err) {
    process.stderr.write(
      `[subagent sub] sendUserMessage threw: ${(err as Error).message}\n`,
    );
  }
}

function deliverCancel(
  ctx: ExtensionContext | undefined,
  reason: string,
): void {
  if (!ctx) {
    // No context bound yet; we can still abort the process.
    process.stderr.write(
      `[subagent sub] cancel received before context (${reason}); exiting\n`,
    );
    process.exit(1);
  }
  try {
    ctx.abort();
  } catch (err) {
    process.stderr.write(
      `[subagent sub] ctx.abort() threw: ${(err as Error).message}\n`,
    );
  }
}
