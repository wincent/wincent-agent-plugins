import type {
  ExtensionAPI,
  UIPromptStartEvent,
} from '@earendil-works/pi-coding-agent';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';

type RestingState = 'idle' | 'done' | 'error';
type State = RestingState | 'working' | 'blocked' | 'clear';

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let id = '';
  let lastReport = '';
  let running = false;
  let compacting = false;
  let resting: RestingState = 'idle';
  let outcome: RestingState = 'done';
  let prompts: UIPromptStartEvent[] = [];

  const write = (state: State, kind?: 'permission' | 'question') => {
    if (!enabled) {
      return;
    }
    const report = `\x1b]7501;state=${state}:id=${id}:app=pi` +
      (kind ? `:kind=${kind}` : '') + '\x1b\\';
    if (report === lastReport) {
      return;
    }
    const sequence = `\x1bPtmux;${report.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
    try {
      // Also flush cleanup when called from the process exit handler.
      fs.writeSync(process.stdout.fd, sequence);
      lastReport = report;
    } catch {
      // A missing terminal must not interrupt the agent.
    }
  };

  const report = () => {
    const prompt = prompts.at(-1);
    if (prompt) {
      write(
        'blocked',
        prompt.kind === 'confirm'
          ? 'permission'
          : prompt.kind === 'custom'
          ? undefined
          : 'question',
      );
    } else {
      write(running || compacting ? 'working' : resting);
    }
  };

  const cleanup = () => {
    write('clear'); // Never clear another program's records.
    enabled = false;
    process.removeListener('exit', cleanup);
  };

  pi.on('session_start', (_event, ctx) => {
    cleanup();
    if (
      ctx.mode !== 'tui' || !process.stdout.isTTY ||
      !process.env.TMUX || process.env.PI_SUBAGENT_TASK_ID
    ) {
      return;
    }
    enabled = true;
    id = `pi/${randomBytes(16).toString('hex')}`;
    lastReport = '';
    running = !ctx.isIdle();
    compacting = false;
    resting = 'idle';
    outcome = 'done';
    prompts = [];
    process.on('exit', cleanup);
    report();
  });

  pi.on('session_shutdown', cleanup);

  const start = () => {
    running = true;
    outcome = 'done';
    report();
  };
  pi.on('before_agent_start', start);
  pi.on('agent_start', start);

  // This boundary includes retries and recovery; agent_end is not final.
  pi.on('agent_before_settle', (event) => {
    outcome = event.outcome === 'completed'
      ? 'done'
      : event.outcome === 'aborted'
      ? 'idle'
      : 'error';
  });
  pi.on('agent_settled', (event) => {
    if (running) {
      running = false;
      resting = event.aborted ? 'idle' : outcome;
      report();
    }
  });

  pi.on('session_before_compact', () => {
    compacting = true;
    report();
  });
  pi.on('session_compact', (event) => {
    compacting = false;
    if (!running && event.reason === 'manual') {
      resting = 'done';
    }
    report();
  });
  pi.on('session_compact_failed', (event) => {
    compacting = false;
    if (!running) {
      resting = event.aborted ? 'idle' : 'error';
    }
    report();
  });

  pi.on('ui_prompt_start', (event) => {
    prompts.push(event);
    report();
  });
  pi.on('ui_prompt_end', (event) => {
    const index = prompts.findLastIndex((prompt) =>
      prompt.kind === event.kind && prompt.title === event.title
    );
    if (index !== -1) {
      prompts.splice(index, 1);
    }
    report();
  });
}
