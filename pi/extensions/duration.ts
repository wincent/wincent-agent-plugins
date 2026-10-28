import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {truncateToWidth, visibleWidth} from '@earendil-works/pi-tui';
import {performance} from 'node:perf_hooks';

const ENTRY_TYPE = 'duration';

interface Duration {
  durationMs: number;
  aborted: boolean;
}

function formatDuration(durationMs: number): string {
  const tenths = Math.round(durationMs / 100);
  if (tenths < 600) {
    return `${(tenths / 10).toFixed(1)}s`;
  }
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}m ${
    String(seconds % 60).padStart(2, '0')
  }s`;
}

export default function (pi: ExtensionAPI) {
  let submittedAt: number | undefined;
  let startedAt: number | undefined;

  const reset = () => {
    submittedAt = undefined;
    startedAt = undefined;
  };
  pi.on('session_start', reset);
  pi.on('session_shutdown', reset);
  pi.on('session_tree', reset);

  pi.on('input', (_event, ctx) => {
    // Capture submission before prompt preparation and pre-run compaction.
    // Steering/follow-ups belong to the current run, not a new stopwatch.
    if (ctx.isIdle()) {
      submittedAt = performance.now();
    }
  });

  pi.on('before_agent_start', (event) => {
    // An intercepted/rejected input must not start a stopwatch on its own.
    // Custom-message runs have no input event and use this boundary instead.
    startedAt = event.messageType === 'user'
      ? submittedAt ?? performance.now()
      : performance.now();
    submittedAt = undefined;
  });

  pi.on('agent_start', () => {
    // Also cover continuations of a resumed session. Retry/compaction loops
    // can emit agent_start again, so never reset an already running timer.
    startedAt ??= performance.now();
  });

  pi.on('agent_settled', (event) => {
    if (startedAt === undefined) {
      return;
    }
    const durationMs = Math.max(0, performance.now() - startedAt);
    reset();
    // Custom entries survive reopening/branching without entering LLM context.
    pi.appendEntry<Duration>(ENTRY_TYPE, {
      durationMs,
      aborted: event.aborted,
    });
  });

  pi.registerEntryRenderer<Duration>(
    ENTRY_TYPE,
    (entry, _options, theme) => {
      const data = entry.data;
      if (
        !data || typeof data.durationMs !== 'number' ||
        !Number.isFinite(data.durationMs) || data.durationMs < 0 ||
        typeof data.aborted !== 'boolean'
      ) {
        return;
      }
      const label = formatDuration(data.durationMs) +
        (data.aborted ? ' · aborted' : '');
      return {
        render(width) {
          if (width <= 0) {
            return [];
          }
          const text = truncateToWidth(label, width, '…');
          return [
            ' '.repeat(Math.max(0, width - visibleWidth(text))) +
            theme.fg('dim', text),
          ];
        },
        invalidate() {},
      };
    },
  );
}
