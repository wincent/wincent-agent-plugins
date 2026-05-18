/**
 * Lifecycle events emitted by the main extension on `pi.events`.
 *
 * Names use the `subagent:*` (singular) namespace to coexist with
 * `subagents:*` (plural) used by `@tintinweb/pi-subagents`.
 */

import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export type LifecycleEvent =
  | 'subagent:spawned'
  | 'subagent:connected'
  | 'subagent:progress'
  | 'subagent:report'
  | 'subagent:asked'
  | 'subagent:answered'
  | 'subagent:steered'
  | 'subagent:done'
  | 'subagent:failed';

export function emitLifecycle(
  pi: ExtensionAPI,
  event: LifecycleEvent,
  payload: Record<string, unknown>,
): void {
  try {
    pi.events.emit(event, payload);
  } catch (err) {
    process.stderr.write(
      `[subagent main] failed to emit ${event}: ${(err as Error).message}\n`,
    );
  }
}
