/**
 * Tools registered in main mode: subagent, subagent_steer, subagent_cancel,
 * subagent_status.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {existsSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Type} from 'typebox';

import {AuditLog} from '../bus/audit-log.js';
import {Bus} from '../bus/bus.js';
import {newEnvelopeId} from '../bus/envelope.js';
import {listenForPeer} from '../bus/transport-uds.js';
import type {AgentConfig, Placement} from './agents.js';
import {discoverAgents} from './agents.js';
import {emitLifecycle} from './events.js';
import {
  type ActiveTask,
  listActive,
  lookup,
  register,
  remove,
  trackBus,
} from './registry.js';
import {installMainRoutingFor} from './routing.js';
import {
  type SpawnedPane,
  ensureInTmux,
  killPane,
  sendKeysCtrlC,
  spawnSubagentPane,
} from './spawn.js';
import {
  auditLogPath,
  ensureTaskDir,
  socketPath,
  systemPromptPath,
  updateMeta,
  writeMeta,
} from './state.js';
import {
  type WorktreePlan,
  finalizeWorktree,
  prepareWorktree,
  preserveWorktreeOnCrash,
} from './worktree.js';

export const CONNECT_TIMEOUT_MS = 10_000;
export const CANCEL_GRACE_MS = 5_000;
export const SIGKILL_GRACE_MS = 5_000;
export const MAX_TURNS = 15;
export const GRACE_TURNS = 5;

const PlacementSchema = Type.Union([
  Type.Literal('split-right'),
  Type.Literal('split-down'),
  Type.Literal('window'),
  Type.Literal('window-detached'),
]);

const SubagentParams = Type.Object({
  agent: Type.String({description: 'Name of an agent (matches an .md file)'}),
  task: Type.String({description: 'The task to delegate, in natural language'}),
  placement: Type.Optional(PlacementSchema),
  worktree: Type.Optional(
    Type.Boolean({
      description: 'Override the agent.md default for case-2 isolation',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory; defaults to main agent's cwd",
    }),
  ),
  close_on_success: Type.Optional(Type.Boolean()),
  background: Type.Optional(
    Type.Boolean({
      description:
        'Return immediately; route results as user messages. Default false.',
    }),
  ),
  ask_policy: Type.Optional(
    Type.Union(
      [Type.Literal('human'), Type.Literal('deny')],
      {description: 'How to handle ask envelopes; default "human".'},
    ),
  ),
});

const SteerParams = Type.Object({
  task_id: Type.String(),
  text: Type.String(),
});

const CancelParams = Type.Object({
  task_id: Type.String(),
  reason: Type.Optional(Type.String()),
  grace_ms: Type.Optional(Type.Integer({minimum: 0})),
});

const StatusParams = Type.Object({
  task_id: Type.Optional(Type.String()),
});

export interface MainToolsOptions {
  pi: ExtensionAPI;
}

interface SubagentDetails {
  taskId: string;
  agent: string;
  task: string;
  mode: 'sync' | 'background';
  paneId: string | null;
  windowId: string | null;
  worktree: {
    enabled: boolean;
    branch?: string;
    commits?: {sha: string; subject: string}[];
    preservedPath?: string;
  };
  status: 'spawning' | 'running' | 'ok' | 'failed' | 'aborted' | 'crashed';
  progress: string[];
  finalReport?: {
    summary: string;
    findings?: unknown;
    branch?: string;
    commits?: {sha: string; subject: string}[];
    data?: unknown;
  };
  error?: string;
}

export function registerMainTools(options: MainToolsOptions): void {
  const {pi} = options;

  pi.registerTool<typeof SubagentParams, SubagentDetails>({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate a task to a specialized subagent that runs in its own pi process',
      "inside a tmux pane. The subagent's system prompt, tool whitelist, and",
      'default placement/worktree behaviour come from an .md file under',
      '~/.pi/agent/agents/ or <repo>/.pi/agents/. Use synchronously (default)',
      'or with background: true to fire-and-forget. Reports from the subagent',
      'arrive structured.',
    ].join(' '),
    parameters: SubagentParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return runSubagentTool(pi, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool<typeof SteerParams>({
    name: 'subagent_steer',
    label: 'Steer subagent',
    description:
      "Send a steering message to a running subagent. Injected as a user message into the subagent's session.",
    parameters: SteerParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = lookup(params.task_id);
      if (!task) {
        return {
          content: [{
            type: 'text',
            text: `No active subagent with task_id=${params.task_id}.`,
          }],
          details: {},
        };
      }
      task.bus.emit('steer', {text: params.text});
      emitLifecycle(pi, 'subagent:steered', {
        taskId: task.taskId,
        text: params.text,
      });
      return {
        content: [{
          type: 'text',
          text: `Steered ${task.agentName} (${task.taskId}).`,
        }],
        details: {},
      };
    },
  });

  pi.registerTool<typeof CancelParams>({
    name: 'subagent_cancel',
    label: 'Cancel subagent',
    description:
      'Cancel a running subagent. Sends a cancel envelope, escalates to SIGTERM/SIGKILL after grace.',
    parameters: CancelParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = lookup(params.task_id);
      if (!task) {
        return {
          content: [{
            type: 'text',
            text: `No active subagent with task_id=${params.task_id}.`,
          }],
          details: {},
        };
      }
      await cancelTask(task, {
        reason: params.reason ?? 'master requested cancel',
        graceMs: params.grace_ms ?? CANCEL_GRACE_MS,
      });
      return {
        content: [{
          type: 'text',
          text: `Cancelled ${task.agentName} (${task.taskId}).`,
        }],
        details: {},
      };
    },
  });

  pi.registerTool<typeof StatusParams>({
    name: 'subagent_status',
    label: 'Subagent status',
    description:
      'List active subagents (or details for a single task_id). Useful in background mode.',
    parameters: StatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const tasks = params.task_id
        ? [lookup(params.task_id)].filter((t): t is ActiveTask =>
          t !== undefined
        )
        : listActive();
      if (tasks.length === 0) {
        return {
          content: [{type: 'text', text: 'No active subagents.'}],
          details: {},
        };
      }
      const lines = tasks.map((t) =>
        `${t.taskId} ${t.agentName} mode=${t.mode} status=${t.status} task=${
          t.task.slice(0, 60)
        }`
      );
      return {
        content: [{type: 'text', text: lines.join('\n')}],
        details: {
          tasks: tasks.map((t) => ({
            taskId: t.taskId,
            agent: t.agentName,
            status: t.status,
            mode: t.mode,
          })),
        },
      };
    },
  });
}

async function runSubagentTool(
  pi: ExtensionAPI,
  params: {
    agent: string;
    task: string;
    placement?: Placement;
    worktree?: boolean;
    cwd?: string;
    close_on_success?: boolean;
    background?: boolean;
    ask_policy?: 'human' | 'deny';
  },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails>> {
  try {
    await ensureInTmux();
  } catch (err) {
    return errorResult(params, `${(err as Error).message}`);
  }

  const discovery = discoverAgents(ctx.cwd);
  const agent = discovery.agents.find((a) => a.name === params.agent);
  if (!agent) {
    const available = discovery.agents.map((a) => a.name).join(', ') ||
      '(none)';
    return errorResult(
      params,
      `Unknown agent "${params.agent}". Available: ${available}.`,
    );
  }

  const placement: Placement = params.placement ?? agent.placement;
  const closeOnSuccess = params.close_on_success ?? agent.closeOnSuccess;
  const useWorktree = params.worktree ?? agent.worktree;
  const askPolicy = params.ask_policy ?? 'human';
  const background = params.background ?? false;
  const taskId = `task_${newEnvelopeId().replace(/^msg_/, '')}`;
  const requestedCwd = params.cwd ?? ctx.cwd;

  // Prepare task dir + audit log + system prompt file
  const dir = ensureTaskDir(taskId);
  writeFileSync(systemPromptPath(taskId), buildSystemPromptFile(agent), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  let worktreePlan: WorktreePlan | null = null;
  let effectiveCwd = requestedCwd;
  if (useWorktree) {
    try {
      worktreePlan = await prepareWorktree(requestedCwd, taskId, agent.name);
      effectiveCwd = worktreePlan.path;
      try {
        symlinkSync(worktreePlan.path, join(dir, 'worktree'));
      } catch {
        // ignored: best effort
      }
    } catch (err) {
      return errorResult(
        params,
        `worktree setup failed: ${(err as Error).message}`,
      );
    }
  }

  const parentId = `pi-main-${process.pid}`;
  writeMeta({
    v: 1,
    taskId,
    parentId,
    agent: agent.name,
    task: params.task,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'spawning',
    mainPid: process.pid,
    subPid: null,
    paneId: null,
    windowId: null,
    cwd: effectiveCwd,
    worktreePath: worktreePlan?.path ?? null,
    placement,
  });

  // Bind UDS server BEFORE spawning the subagent.
  const listenPromise = listenForPeer(socketPath(taskId), {
    timeoutMs: CONNECT_TIMEOUT_MS,
    signal,
  });

  let spawn: SpawnedPane;
  try {
    spawn = await spawnSubagentPane({
      taskId,
      taskDir: dir,
      task: params.task,
      parentId,
      cwd: effectiveCwd,
      agentName: agent.name,
      toolsWhitelist: agent.tools,
      disallowedTools: agent.disallowedTools,
      systemPromptPath: systemPromptPath(taskId),
      placement,
    });
  } catch (err) {
    updateMeta(taskId, {
      status: 'spawn_failed',
      endedAt: new Date().toISOString(),
    });
    return errorResult(
      params,
      `failed to spawn tmux pane: ${(err as Error).message}`,
    );
  }

  updateMeta(taskId, {
    paneId: spawn.paneId,
    windowId: spawn.windowId,
    subPid: spawn.pid,
  });

  let transport;
  try {
    transport = await listenPromise;
  } catch (err) {
    updateMeta(taskId, {
      status: 'spawn_failed',
      endedAt: new Date().toISOString(),
    });
    return errorResult(
      params,
      `subagent did not connect within ${CONNECT_TIMEOUT_MS}ms: ${
        (err as Error).message
      }`,
    );
  }

  const auditLog = new AuditLog(auditLogPath(taskId));
  const bus = new Bus(transport, auditLog, 'main');
  emitLifecycle(pi, 'subagent:connected', {taskId});
  updateMeta(taskId, {status: 'running'});

  const task: ActiveTask = {
    taskId,
    agentName: agent.name,
    task: params.task,
    paneId: spawn.paneId,
    windowId: spawn.windowId,
    pid: spawn.pid,
    bus,
    mode: background ? 'background' : 'sync',
    worktreePath: worktreePlan?.path ?? null,
    startedAt: Date.now(),
    cleanup: [],
    status: 'running',
  };
  register(task);

  emitLifecycle(pi, 'subagent:spawned', {
    taskId,
    agent: agent.name,
    task: params.task,
    placement,
    worktree: useWorktree,
  });

  // Track the bus into the registry (always).
  trackBus(task);

  // Install the extension-scoped routing for background mode and for late
  // envelopes that arrive after a sync tool has resolved.
  installMainRoutingFor(task, {pi, getCtx: () => ctx});

  // If background, return immediately.
  if (background) {
    handleBackgroundFinalization(
      pi,
      task,
      worktreePlan,
      agent,
      closeOnSuccess,
      params.task,
    );
    return {
      content: [{
        type: 'text',
        text:
          `Started ${agent.name} in background; task_id=${taskId}, pane=${spawn.paneId}.`,
      }],
      details: buildDetails(task, agent, params.task, useWorktree),
    };
  }

  // Sync: wait for `done` (or socket close) and produce a final report.
  return runSyncWait(
    pi,
    ctx,
    signal,
    onUpdate,
    task,
    agent,
    worktreePlan,
    closeOnSuccess,
    askPolicy,
    params.task,
    useWorktree,
  );
}

function runSyncWait(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  task: ActiveTask,
  agent: AgentConfig,
  worktreePlan: WorktreePlan | null,
  closeOnSuccess: boolean,
  askPolicy: 'human' | 'deny',
  userTask: string,
  useWorktree: boolean,
): Promise<AgentToolResult<SubagentDetails>> {
  return new Promise<AgentToolResult<SubagentDetails>>((resolve) => {
    let settled = false;
    const progressMessages: string[] = [];
    const details: SubagentDetails = buildDetails(
      task,
      agent,
      userTask,
      useWorktree,
    );

    const pushUpdate = () => {
      if (onUpdate) {
        onUpdate({
          content: [{
            type: 'text',
            text: progressMessages[progressMessages.length - 1] ?? 'running...',
          }],
          details: {...details, progress: [...progressMessages]},
        });
      }
    };

    const unsub = task.bus.subscribe((env) => {
      if (env.from !== 'sub') {
        return;
      }
      switch (env.type) {
        case 'progress':
          progressMessages.push(env.payload.text);
          pushUpdate();
          break;
        case 'report':
          details.finalReport = {
            summary: env.payload.summary,
            findings: env.payload.findings,
            branch: env.payload.branch,
            commits: env.payload.commits,
            data: env.payload.data,
          };
          progressMessages.push(`report: ${env.payload.summary}`);
          pushUpdate();
          break;
        case 'ask':
          void handleAsk(
            pi,
            ctx,
            task,
            env.id,
            env.payload.question,
            env.payload.default,
            askPolicy,
          );
          progressMessages.push(`asked: ${env.payload.question}`);
          pushUpdate();
          break;
        case 'done':
          details.status = env.payload.status === 'ok'
            ? 'ok'
            : env.payload.status === 'aborted'
            ? 'aborted'
            : 'failed';
          if (env.payload.error) {
            details.error = env.payload.error;
          }
          if (env.payload.finalText && !details.finalReport) {
            details.finalReport = {summary: env.payload.finalText};
          }
          void finishSync();
          break;
        default:
          break;
      }
    });

    const unsubClose = task.bus.onPeerClose(() => {
      if (settled) {
        return;
      }
      // Peer closed without `done`: synthesise a crash report.
      if (
        !details.finalReport && details.status === 'spawning' ||
        details.status === 'running'
      ) {
        details.status = 'crashed';
        details.error = details.error ??
          'subagent process exited without sending done';
      }
      void finishSync();
    });

    const onAbort = () => {
      if (settled) {
        return;
      }
      void cancelTask(task, {
        reason: 'aborted by main',
        graceMs: CANCEL_GRACE_MS,
      })
        .finally(() => {
          details.status = 'aborted';
          void finishSync();
        });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, {once: true});
      }
    }

    const finishSync = async () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        unsub();
      } catch {
        // ignored
      }
      try {
        unsubClose();
      } catch {
        // ignored
      }
      try {
        signal?.removeEventListener('abort', onAbort);
      } catch {
        // ignored
      }

      let worktreeOutcome: SubagentDetails['worktree'] = {enabled: useWorktree};
      if (worktreePlan) {
        if (details.status === 'crashed' || details.status === 'failed') {
          const preserved = preserveWorktreeOnCrash(worktreePlan);
          worktreeOutcome = {
            enabled: true,
            branch: preserved.branch,
            commits: preserved.commits,
            preservedPath: preserved.preservedPath,
          };
        } else {
          const finalized = await finalizeWorktree(worktreePlan, {
            agentName: agent.name,
            taskSummary: userTask,
          });
          worktreeOutcome = {
            enabled: true,
            branch: finalized.branch,
            commits: finalized.commits,
            preservedPath: finalized.preservedPath,
          };
        }
      }
      details.worktree = worktreeOutcome;

      // If the report has a branch (from the subagent), prefer that; the
      // worktree finalizer's branch is a more authoritative ground truth.
      if (worktreeOutcome.branch && details.finalReport) {
        details.finalReport.branch = worktreeOutcome.branch;
        details.finalReport.commits = worktreeOutcome.commits;
      }

      emitLifecycle(pi, 'subagent:done', {
        taskId: task.taskId,
        status: details.status,
        durationMs: Date.now() - task.startedAt,
      });
      updateMeta(task.taskId, {
        status: details.status,
        endedAt: new Date().toISOString(),
      });

      await task.bus.close();

      if (closeOnSuccess && details.status === 'ok' && task.paneId) {
        await killPane(task.paneId);
      }

      remove(task.taskId);

      const text = details.finalReport?.summary
        ?? details.error
        ?? `Subagent ${task.agentName} finished with status=${details.status}.`;
      resolve({
        content: [{type: 'text', text}],
        details,
      });
    };

    pushUpdate();
  });
}

function handleBackgroundFinalization(
  pi: ExtensionAPI,
  task: ActiveTask,
  worktreePlan: WorktreePlan | null,
  agent: AgentConfig,
  closeOnSuccess: boolean,
  userTask: string,
): void {
  const onDoneOrClose = async () => {
    let worktreeOutcome: SubagentDetails['worktree'] = {
      enabled: !!worktreePlan,
    };
    if (worktreePlan) {
      if (task.status === 'crashed' || task.status === 'failed') {
        const preserved = preserveWorktreeOnCrash(worktreePlan);
        worktreeOutcome = {
          enabled: true,
          branch: preserved.branch,
          commits: preserved.commits,
          preservedPath: preserved.preservedPath,
        };
      } else {
        const finalized = await finalizeWorktree(worktreePlan, {
          agentName: agent.name,
          taskSummary: userTask,
        });
        worktreeOutcome = {
          enabled: true,
          branch: finalized.branch,
          commits: finalized.commits,
          preservedPath: finalized.preservedPath,
        };
      }
    }

    emitLifecycle(pi, 'subagent:done', {
      taskId: task.taskId,
      status: task.status,
      durationMs: Date.now() - task.startedAt,
      worktree: worktreeOutcome,
    });
    updateMeta(task.taskId, {
      status: task.status,
      endedAt: new Date().toISOString(),
    });

    await task.bus.close();
    if (closeOnSuccess && task.status === 'ok' && task.paneId) {
      await killPane(task.paneId);
    }
    remove(task.taskId);
  };

  let resolved = false;
  const settle = () => {
    if (resolved) {
      return;
    }
    resolved = true;
    void onDoneOrClose();
  };

  const subDone = task.bus.subscribe((env) => {
    if (env.from === 'sub' && env.type === 'done') {
      settle();
    }
  });
  task.cleanup.push(subDone);

  task.bus.onPeerClose(() => settle());
}

async function handleAsk(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  task: ActiveTask,
  askId: string,
  question: string,
  defaultAnswer: string | undefined,
  policy: 'human' | 'deny',
): Promise<void> {
  emitLifecycle(pi, 'subagent:asked', {taskId: task.taskId, question});

  let answerText: string;
  if (policy === 'deny') {
    answerText =
      `(ask_policy=deny) No answer available; please make a reasonable assumption and note it in your report. Question was: ${question}`;
  } else {
    try {
      const fromUi = await ctx.ui.input(
        `Subagent ${task.agentName} asks:`,
        question,
      );
      answerText = fromUi ?? defaultAnswer ?? '(no answer)';
    } catch (err) {
      answerText = defaultAnswer ?? `(no answer: ${(err as Error).message})`;
    }
  }
  task.bus.emit('answer', {text: answerText}, {inReplyTo: askId});
  emitLifecycle(pi, 'subagent:answered', {
    taskId: task.taskId,
    text: answerText,
    source: policy === 'deny' ? 'policy' : 'human',
  });
}

async function cancelTask(
  task: ActiveTask,
  options: {reason: string; graceMs: number},
): Promise<void> {
  try {
    task.bus.emit('cancel', {reason: options.reason, graceMs: options.graceMs});
  } catch {
    // Bus may already be closed; fall through to signal escalation.
  }

  await new Promise((resolve) => setTimeout(resolve, options.graceMs));

  if (task.pid !== null) {
    try {
      process.kill(task.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, SIGKILL_GRACE_MS));
  if (task.pid !== null) {
    try {
      process.kill(task.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (task.paneId) {
    await killPane(task.paneId);
  }
}

function buildSystemPromptFile(agent: AgentConfig): string {
  return [
    `# Subagent system prompt (${agent.name})`,
    '',
    'You are running as a subagent spawned by a main pi agent. Communicate',
    'results back via the `report` tool (final results) and `progress` tool',
    '(short status updates). Use `ask` only when you genuinely cannot proceed',
    'without information; the main agent or user will reply via `answer`.',
    '',
    `## Soft turn limit: ${MAX_TURNS} (grace: ${GRACE_TURNS})`,
    '',
    `If you hit the soft limit, wrap up immediately: send a \`report\` summarizing`,
    'partial work. Hard abort after the grace period.',
    '',
    `## Agent personality: ${agent.name}`,
    '',
    agent.systemPrompt,
    '',
  ].join('\n');
}

function buildDetails(
  task: ActiveTask,
  agent: AgentConfig,
  userTask: string,
  useWorktree: boolean,
): SubagentDetails {
  return {
    taskId: task.taskId,
    agent: agent.name,
    task: userTask,
    mode: task.mode,
    paneId: task.paneId,
    windowId: task.windowId,
    worktree: {enabled: useWorktree},
    status: 'running',
    progress: [],
  };
}

function errorResult(
  params: {agent: string; task: string},
  message: string,
): AgentToolResult<SubagentDetails> {
  return {
    content: [{type: 'text', text: `error: ${message}`}],
    details: {
      taskId: '',
      agent: params.agent,
      task: params.task,
      mode: 'sync',
      paneId: null,
      windowId: null,
      worktree: {enabled: false},
      status: 'failed',
      progress: [],
      error: message,
    },
  };
}
