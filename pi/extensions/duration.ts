import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {CustomEditor} from '@earendil-works/pi-coding-agent';
import type {TUI} from '@earendil-works/pi-tui';
import {truncateToWidth, visibleWidth} from '@earendil-works/pi-tui';
import {performance} from 'node:perf_hooks';
import {stripVTControlCharacters} from 'node:util';

const ENTRY_TYPE = 'duration';
const PENDING_ENTRY_TYPE = 'duration-pending';

interface Duration {
  durationMs: number;
  aborted: boolean;
}

function isDuration(data: unknown): data is Duration {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const duration = data as Duration;
  return typeof duration.durationMs === 'number' &&
    Number.isFinite(duration.durationMs) && duration.durationMs >= 0 &&
    typeof duration.aborted === 'boolean';
}

function formatDuration(durationMs: number, live = false): string {
  if (live && durationMs >= 10_000 && durationMs < 60_000) {
    return `${Math.floor(durationMs / 1000)}s`;
  }
  const tenths = live
    ? Math.floor(durationMs / 100)
    : Math.round(durationMs / 100);
  if (tenths < 600) {
    return `${(tenths / 10).toFixed(1)}s`;
  }
  const seconds = live
    ? Math.floor(durationMs / 1000)
    : Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}m ${
    String(seconds % 60).padStart(2, '0')
  }s`;
}

function durationLabel(duration: Duration): string {
  return formatDuration(duration.durationMs) +
    (duration.aborted ? ' · aborted' : '');
}

export default function (pi: ExtensionAPI) {
  let submittedAt: number | undefined;
  let startedAt: number | undefined;
  let pending: Duration | undefined;
  let label: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeTui: TUI | undefined;
  let ui: ExtensionContext['ui'] | undefined;
  let editorFactory: ReturnType<ExtensionContext['ui']['getEditorComponent']>;

  const ownsEditor = () =>
    editorFactory !== undefined && ui?.getEditorComponent() === editorFactory;

  const stopTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const resetTiming = () => {
    stopTimer();
    submittedAt = undefined;
    startedAt = undefined;
  };

  const refreshTimer = () => {
    stopTimer();
    if (startedAt === undefined || !ownsEditor()) {
      return;
    }
    const elapsed = Math.max(0, performance.now() - startedAt);
    // Cache the label so unrelated TUI repaints don't advance the stopwatch.
    label = formatDuration(elapsed, true);
    activeTui?.requestRender();
    const interval = elapsed < 10_000 ? 100 : 1000;
    timer = setTimeout(refreshTimer, interval - (elapsed % interval));
    timer.unref();
  };

  const promotePending = () => {
    if (pending) {
      const duration = pending;
      pending = undefined;
      // The pending entry is already durable, but has no renderer (and hence
      // no transcript spacer). Append its visible copy before the next prompt.
      pi.appendEntry<Duration>(ENTRY_TYPE, duration);
    }
    label = undefined;
  };

  const restorePending = (ctx: ExtensionContext) => {
    resetTiming();
    pending = undefined;
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== 'custom') {
        continue;
      }
      if (entry.customType === ENTRY_TYPE) {
        break; // Already promoted, or a legacy transcript-only duration.
      }
      if (entry.customType === PENDING_ENTRY_TYPE && isDuration(entry.data)) {
        pending = entry.data;
        break;
      }
    }
    label = pending ? durationLabel(pending) : undefined;
    activeTui?.requestRender();
  };

  pi.on('session_start', (event, ctx) => {
    restorePending(ctx);
    if (ctx.mode !== 'tui') {
      return;
    }
    ui = ctx.ui;
    // Do not replace another extension's editor. Without our editor, retain
    // the original transcript-only behavior instead of hiding durations.
    if (ui.getEditorComponent() && !ownsEditor()) {
      return;
    }
    editorFactory = (tui, theme, keybindings) => {
      activeTui = tui;
      class DurationEditor extends CustomEditor {
        protected renderTopBorder(width: number, hiddenLineCount: number) {
          const original = super.renderTopBorder(width, hiddenLineCount);
          const badgeWidth = label ? visibleWidth(label) + 3 : 0;
          if (!label || width < badgeWidth + 8) {
            return original;
          }
          const compact = super.renderTopBorder(
            width - badgeWidth,
            hiddenLineCount,
          );
          // Let Pi lay out its own indicators, but don't crowd out content
          // it could show at full width (including a long scroll counter).
          const content = (line: string) =>
            stripVTControlCharacters(line).replace(/[─\s]/g, '');
          if (content(compact) !== content(original)) {
            return original;
          }
          return compact + this.borderColor(' ') +
            ctx.ui.theme.fg('dim', label) +
            this.borderColor(' ─');
        }
      }
      const editor = new DurationEditor(tui, theme, keybindings, {
        embedWorkingStatus: true,
      });
      // Pi populates editor history on initial load, but not on /reload.
      // A replacement editor needs to rebuild it from the active branch.
      if (event.reason === 'reload') {
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type === 'message' && entry.message.role === 'user') {
            const content = entry.message.content;
            const text = typeof content === 'string'
              ? content
              : content.filter((part) => part.type === 'text')
                .map((part) => part.text).join('\n');
            editor.addToHistory(text);
          }
        }
      }
      return editor;
    };
    ui.setEditorComponent(editorFactory);
  });

  pi.on('session_tree', (_event, ctx) => restorePending(ctx));

  pi.on('session_shutdown', () => {
    resetTiming();
    pending = undefined;
    label = undefined;
    if (ownsEditor()) {
      ui?.setEditorComponent(undefined);
    }
    editorFactory = undefined;
    activeTui = undefined;
    ui = undefined;
  });

  pi.on('input', (_event, ctx) => {
    // Capture submission before prompt preparation and pre-run compaction.
    // Steering/follow-ups belong to the current run, not a new stopwatch.
    if (ctx.isIdle()) {
      submittedAt = performance.now();
    }
  });

  pi.on('before_agent_start', (event) => {
    promotePending();
    // An intercepted/rejected input must not start a stopwatch on its own.
    // Custom-message runs have no input event and use this boundary instead.
    startedAt = event.messageType === 'user'
      ? submittedAt ?? performance.now()
      : performance.now();
    submittedAt = undefined;
    refreshTimer();
  });

  pi.on('agent_start', () => {
    // Also cover continuations of a resumed session. Retry/compaction loops
    // can emit agent_start again, so never reset an already running timer.
    if (startedAt === undefined) {
      promotePending();
      startedAt = performance.now();
      refreshTimer();
    }
  });

  pi.on('agent_settled', (event) => {
    if (startedAt === undefined) {
      return;
    }
    const duration: Duration = {
      durationMs: Math.max(0, performance.now() - startedAt),
      aborted: event.aborted,
    };
    resetTiming();
    // Save immediately, even though the visible transcript entry is deferred.
    // Both entry types stay out of model context, including after reopening.
    if (ownsEditor()) {
      pending = duration;
      label = durationLabel(duration);
      pi.appendEntry<Duration>(PENDING_ENTRY_TYPE, duration);
      activeTui?.requestRender();
    } else {
      pi.appendEntry<Duration>(ENTRY_TYPE, duration);
    }
  });

  pi.registerEntryRenderer<Duration>(
    ENTRY_TYPE,
    (entry, _options, theme) => {
      if (!isDuration(entry.data)) {
        return;
      }
      const text = durationLabel(entry.data);
      return {
        render(width) {
          if (width <= 0) {
            return [];
          }
          const truncated = truncateToWidth(text, width, '…');
          return [
            ' '.repeat(Math.max(0, width - visibleWidth(truncated))) +
            theme.fg('dim', truncated),
          ];
        },
        invalidate() {},
      };
    },
  );
}
