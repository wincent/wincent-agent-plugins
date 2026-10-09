import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export function installStatus(pi: ExtensionAPI): void {
  const tasks = new Map<string, {agent: string; text: string}>();
  let cleanup: (() => void)[] = [];
  let ctx: ExtensionContext | undefined;
  const render = () => {
    if (!ctx?.hasUI) {
      return;
    }
    ctx.ui.setStatus(
      'subagent',
      tasks.size ? `Subagents: ${tasks.size} active` : undefined,
    );
    const lines = [...tasks.values()].slice(0, 6).map(({agent, text}) =>
      `${agent}: ${text}`
    );
    if (tasks.size > 6) {
      lines.push(`... and ${tasks.size - 6} more`);
    }
    ctx.ui.setWidget('subagent', lines.length ? lines : undefined);
  };
  pi.on('session_start', (_event, context) => {
    for (const unsubscribe of cleanup) {
      unsubscribe();
    }
    ctx = context;
    tasks.clear();
    cleanup = [
      'spawned',
      'progress',
      'report',
      'finalizing',
      'asked',
      'answered',
      'done',
      'failed',
    ].map((kind) =>
      pi.events.on(`subagent:${kind}`, (data) => {
        const event = data as {
          taskId: string;
          agent?: string;
          text?: string;
          summary?: string;
        };
        if (kind === 'spawned') {
          tasks.set(event.taskId, {
            agent: event.agent ?? 'subagent',
            text: 'running',
          });
        } else if (kind === 'done' || kind === 'failed') {
          tasks.delete(event.taskId);
        } else {
          const task = tasks.get(event.taskId);
          if (task) {
            task.text = (event.text ?? event.summary ??
              (kind === 'asked'
                ? 'waiting for an answer'
                : kind === 'finalizing'
                ? 'finalizing outputs and cleanup'
                : 'running'))
              .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 160);
          }
        }
        render();
      })
    );
    render();
  });
  pi.on('session_shutdown', () => {
    for (const unsubscribe of cleanup) {
      unsubscribe();
    }
    cleanup = [];
    tasks.clear();
    render();
    ctx = undefined;
  });
}
