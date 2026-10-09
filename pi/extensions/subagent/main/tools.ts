import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {existsSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {type Static, Type} from 'typebox';

import {AuditLog} from '../bus/audit-log.js';
import {Bus} from '../bus/bus.js';
import {newEnvelopeId} from '../bus/envelope.js';
import {type AgentConfig, discoverAgents} from './agents.js';
import {handleAsk} from './ask.js';
import {emitLifecycle} from './events.js';
import {launchSubagent} from './launch.js';
import {
  CANCEL_GRACE_MS,
  SIGKILL_GRACE_MS,
  cancelTask,
  observeTask,
} from './lifecycle.js';
import {
  type ActiveTask,
  listActive,
  lookup,
  register,
  remove,
  trackBus,
} from './registry.js';
import {
  type SubagentDetails,
  readTaskResult,
  recentCompletedTasks,
  resultText,
  saveResult,
  taskResult,
} from './result.js';
import {installMainRoutingFor, routeTaskCompletion} from './routing.js';
import {
  auditLogPath,
  ensureTaskDir,
  readMeta,
  systemPromptPath,
  taskDir,
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
export const MAX_TURNS = 15;
export const GRACE_TURNS = 5;

const SubagentParams = Type.Object({
  agent: Type.String({description: 'Name of an agent (matches an .md file)'}),
  task: Type.String({description: 'The task to delegate, in natural language'}),
  worktree: Type.Optional(
    Type.Boolean({description: 'Override the agent.md worktree default'}),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory; defaults to main agent's cwd",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        'Return after connecting; deliver the final result later. Default false.',
    }),
  ),
  ask_policy: Type.Optional(
    Type.Union([
      Type.Literal('human'),
      Type.Literal('deny'),
      Type.Literal('llm'),
    ], {
      description:
        'How to answer subagent questions: human prompts the controlling UI (default); deny asks the child to make a reasonable assumption; llm consults the controlling model at extra token cost. Per-call policy overrides agent frontmatter.',
    }),
  ),
});

const StatusParams = Type.Object({
  task_id: Type.Optional(
    Type.String({
      description:
        'Retrieve an active or completed task, including its full report.',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 50,
      description:
        'Number of recent completed tasks to list (default 10). Use 0 for active tasks only. Ignored with task_id.',
    }),
  ),
});

export function registerMainTools({pi}: {pi: ExtensionAPI}): void {
  let session = new AbortController();
  const pending = new Set<Promise<unknown>>();
  pi.on('session_start', () => {
    session = new AbortController();
  });
  pi.on('session_shutdown', async () => {
    session.abort();
    const active = listActive();
    for (const task of active) {
      task.ownerClosed = true;
    }
    await Promise.allSettled(active.map((task) =>
      cancelTask(task, {
        reason: 'controlling session ended',
        graceMs: CANCEL_GRACE_MS,
      })
    ));
    await Promise.allSettled([
      ...pending,
      ...active.map((task) => task.completion),
    ]);
  });

  pi.registerTool<typeof SubagentParams, SubagentDetails>({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate a task to a specialized subagent in its own headless Pi process.',
      'The system prompt, tool whitelist, and worktree default come from an agent .md file.',
      'Use synchronously (default) or background: true for a later result.',
      "Subagents inherit the controlling agent's active provider, model, and thinking level.",
      'Progress appears in the controlling UI; logs remain in the task directory.',
    ].join(' '),
    parameters: SubagentParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const combined = signal
        ? AbortSignal.any([signal, session.signal])
        : session.signal;
      const run = runSubagentTool(pi, params, combined, onUpdate, ctx);
      pending.add(run);
      try {
        return await run;
      } finally {
        pending.delete(run);
      }
    },
  });

  pi.registerTool({
    name: 'subagent_steer',
    label: 'Steer subagent',
    description: 'Send a steering message to a running subagent.',
    parameters: Type.Object({task_id: Type.String(), text: Type.String()}),
    async execute(_id, params) {
      const task = lookup(params.task_id);
      if (!task || task.bus.isClosed) {
        return textResult(
          `No connected subagent with task_id=${params.task_id}.`,
        );
      }
      task.bus.emit('steer', {text: params.text});
      emitLifecycle(pi, 'subagent:steered', {
        taskId: task.taskId,
        text: params.text,
      });
      return textResult(`Steered ${task.agentName} (${task.taskId}).`);
    },
  });

  pi.registerTool({
    name: 'subagent_cancel',
    label: 'Cancel subagent',
    description:
      'Cancel a running subagent via the bus, then SIGTERM/SIGKILL if needed.',
    parameters: Type.Object({
      task_id: Type.String(),
      reason: Type.Optional(Type.String()),
      grace_ms: Type.Optional(Type.Integer({minimum: 0})),
    }),
    async execute(_id, params) {
      const task = lookup(params.task_id);
      if (!task) {
        return textResult(`No active subagent with task_id=${params.task_id}.`);
      }
      await cancelTask(task, {
        reason: params.reason ?? 'controlling agent requested cancel',
        graceMs: params.grace_ms ?? CANCEL_GRACE_MS,
      });
      await task.completion;
      return textResult(`Cancelled ${task.agentName} (${task.taskId}).`);
    },
  });

  pi.registerTool<typeof StatusParams, unknown>({
    name: 'subagent_status',
    label: 'Subagent status',
    description:
      'List active tasks and recent completed tasks from local history, including IDs and log paths. With task_id, retrieve the full result of an active or completed task, including finalReport.data. Completed results survive session restart.',
    parameters: StatusParams,
    async execute(_id, params) {
      if (params.task_id !== undefined) {
        taskDir(params.task_id);
        const active = lookup(params.task_id);
        const details = active
          ? activeDetails(active)
          : await readTaskResult(params.task_id);
        return details
          ? taskResult(details)
          : textResult(
            `No active or saved subagent with task_id=${params.task_id}.`,
          );
      }
      const active = listActive();
      const completed = recentCompletedTasks(
        params.limit ?? 10,
        new Set(active.map((task) => task.taskId)),
      );
      const summary = (details: SubagentDetails) => ({
        taskId: details.taskId,
        agent: details.agent,
        status: details.status,
        mode: details.mode,
        task: details.task.slice(0, 200),
        summary: details.finalReport?.summary.slice(0, 500),
        taskDir: details.taskDir,
        cwd: details.cwd,
        resultPath: details.resultPath,
        stdoutPath: join(details.taskDir, 'stdout.log'),
        stderrPath: join(details.taskDir, 'stderr.log'),
      });
      const details = {
        active: active.map((task) => summary(activeDetails(task))),
        recentCompleted: completed.map(summary),
      };
      return {
        content: [{type: 'text', text: JSON.stringify(details, null, 2)}],
        details,
      };
    },
  });
}

async function runSubagentTool(
  pi: ExtensionAPI,
  params: Static<typeof SubagentParams>,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails>> {
  // Snapshot before asynchronous worktree/launcher setup or a parent model switch.
  const model = ctx.model
    ? {provider: ctx.model.provider, id: ctx.model.id}
    : undefined;
  const thinkingLevel = pi.getThinkingLevel();
  const details: SubagentDetails = {
    taskId: '',
    agent: params.agent,
    task: params.task,
    mode: params.background ? 'background' : 'sync',
    pid: null,
    taskDir: '',
    cwd: params.cwd ?? ctx.cwd,
    worktree: {enabled: false},
    status: 'spawning',
    progress: [],
  };
  let worktreePlan: WorktreePlan | null = null;
  let task: ActiveTask | undefined;
  try {
    signal.throwIfAborted();
    const discovery = discoverAgents(ctx.cwd);
    const agent = discovery.agents.find((candidate) =>
      candidate.name === params.agent
    );
    if (!agent) {
      throw new Error(
        `Unknown agent "${params.agent}". Available: ${
          discovery.agents.map((a) => a.name).join(', ') || '(none)'
        }.`,
      );
    }
    const taskId = `task_${newEnvelopeId().replace(/^msg_/, '')}`;
    const dir = ensureTaskDir(taskId);
    details.taskId = taskId;
    details.taskDir = dir;
    details.worktree.enabled = params.worktree ?? agent.worktree;
    writeFileSync(systemPromptPath(taskId), buildSystemPromptFile(agent), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    let cwd = params.cwd ?? ctx.cwd;
    if (details.worktree.enabled) {
      worktreePlan = await prepareWorktree(cwd, taskId, agent.name);
      cwd = worktreePlan.path;
      try {
        symlinkSync(cwd, join(dir, 'worktree'));
      } catch {
        // The symlink is only an inspection convenience.
      }
    }
    details.cwd = cwd;
    signal.throwIfAborted();
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
      cwd,
      worktreePath: worktreePlan?.path ?? null,
      mode: params.background ? 'background' : 'sync',
      model,
      thinkingLevel,
    });
    const launched = await launchSubagent({
      taskId,
      taskDir: dir,
      task: params.task,
      parentId,
      cwd,
      model,
      thinkingLevel,
      toolsWhitelist: agent.tools,
      disallowedTools: agent.disallowedTools,
      systemPromptPath: systemPromptPath(taskId),
    }, {
      signal,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      killGraceMs: SIGKILL_GRACE_MS,
    });
    const bus = new Bus(
      launched.transport,
      new AuditLog(auditLogPath(taskId)),
      'main',
    );
    task = {
      taskId,
      agentName: agent.name,
      task: params.task,
      process: launched.process,
      bus,
      mode: params.background ? 'background' : 'sync',
      worktreePath: worktreePlan?.path ?? null,
      startedAt: Date.now(),
      cleanup: [],
      status: 'running',
      askPolicy: params.ask_policy ?? agent.askPolicy ?? 'human',
      llmAnswersSinceEscalation: 0,
      llmAnswersTotal: 0,
    };
    details.pid = launched.process.pid;
    details.status = 'running';
    register(task);
    trackBus(task);
    installMainRoutingFor(task, {pi, getCtx: () => ctx});
    const active = task;
    const unsubscribe = bus.subscribe((env) => {
      if (env.from !== 'sub') {
        return;
      }
      if (env.type === 'report') {
        details.finalReport = {
          ...(active.finalReport ?? active.lastReport ?? env.payload),
        };
      }
      if (active.mode !== 'sync') {
        return;
      }
      if (env.type === 'ask') {
        void handleAsk({
          pi,
          ctx,
          task: active,
          askId: env.id,
          question: env.payload.question,
          defaultAnswer: env.payload.default,
          policy: active.askPolicy,
        });
      }
      if (env.type === 'progress' || env.type === 'report') {
        const text = env.type === 'progress'
          ? env.payload.text
          : `report: ${env.payload.summary}`;
        details.progress.push(text);
        onUpdate?.({
          content: [{type: 'text', text}],
          details: {...details, progress: [...details.progress]},
        });
      }
    });
    active.cleanup.push(unsubscribe);
    const outcome = observeTask(active);
    const onAbort = () => {
      void cancelTask(active, {
        reason: 'aborted by controlling agent',
        graceMs: CANCEL_GRACE_MS,
      }).catch((error) => {
        details.error = (error as Error).message;
      });
    };
    signal.addEventListener('abort', onAbort, {once: true});
    active.cleanup.push(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) {
      onAbort();
    }
    updateMeta(taskId, {status: 'running', subPid: launched.process.pid});
    emitLifecycle(pi, 'subagent:spawned', {
      taskId,
      agent: agent.name,
      task: params.task,
      worktree: details.worktree.enabled,
    });
    emitLifecycle(pi, 'subagent:connected', {taskId});
    const completion = (async (): Promise<AgentToolResult<SubagentDetails>> => {
      const result = await outcome;
      details.status = result.status;
      details.error = result.error;
      if (!details.finalReport && result.finalText) {
        details.finalReport = {summary: result.finalText};
      }
      try {
        if (worktreePlan) {
          // Never mutate/prune a worktree until process exit is confirmed, or
          // auto-commit partial changes from an aborted/failed worker.
          const finalized = result.status === 'ok' && result.exit
            ? await finalizeWorktree(worktreePlan, {
              agentName: agent.name,
              taskSummary: params.task,
            })
            : preserveWorktreeOnCrash(worktreePlan);
          details.worktree = {enabled: true, ...finalized};
          if (finalized.branch && details.finalReport) {
            details.finalReport.branch = finalized.branch;
            details.finalReport.commits = finalized.commits;
          }
        }
      } catch (error) {
        details.status = 'failed';
        details.error = `worktree finalization failed: ${
          (error as Error).message
        }`;
        if (worktreePlan) {
          details.worktree = {
            enabled: true,
            ...preserveWorktreeOnCrash(worktreePlan),
          };
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        try {
          await bus.close();
        } catch (error) {
          details.status = 'failed';
          details.error = `bus cleanup failed: ${(error as Error).message}`;
        } finally {
          remove(taskId);
        }
      }
      try {
        updateMeta(taskId, {
          status: details.status,
          endedAt: new Date().toISOString(),
          exitCode: result.exit?.code,
          exitSignal: result.exit?.signal,
        });
      } catch (error) {
        details.status = 'failed';
        details.error = `metadata update failed: ${(error as Error).message}`;
      }
      persistResult(details);
      active.status = details.status;
      emitLifecycle(pi, 'subagent:done', {
        taskId,
        status: details.status,
        durationMs: Date.now() - active.startedAt,
        worktree: details.worktree,
        llmAnswersTotal: active.llmAnswersTotal,
      });
      if (active.mode === 'background' && !active.ownerClosed) {
        routeTaskCompletion(pi, ctx, active, resultText(details));
      }
      return taskResult(details);
    })();
    active.completion = completion;
    if (params.background) {
      // Observe unexpected finalizer failures immediately, not just at shutdown.
      void completion.catch((error) => {
        active.status = 'failed';
        details.status = 'failed';
        details.error = `Finalization failed: ${(error as Error).message}`;
        if (worktreePlan && existsSync(worktreePlan.path)) {
          details.worktree.preservedPath = worktreePlan.path;
        }
        persistResult(details);
        emitLifecycle(pi, 'subagent:failed', {
          taskId,
          error: (error as Error).message,
        });
        process.stderr.write(
          `[subagent main] finalization failed for ${taskId}: ${
            (error as Error).message
          }\n`,
        );
        remove(taskId);
        if (!active.ownerClosed) {
          routeTaskCompletion(
            pi,
            ctx,
            active,
            resultText(details),
          );
        }
      });
      // The turn's signal must not own a task after returning its background handle.
      signal.removeEventListener('abort', onAbort);
      return {
        content: [{
          type: 'text',
          text:
            `Started ${agent.name} in background; task_id=${taskId}, pid=${details.pid}. Logs: ${dir}`,
        }],
        details: {...details},
      };
    }
    return await completion;
  } catch (error) {
    details.status = signal.aborted ? 'aborted' : 'failed';
    details.error = (error as Error).message;
    if (task) {
      await cancelTask(task, {reason: details.error, graceMs: 0}).catch(
        () => {},
      );
      try {
        await task.bus.close();
      } finally {
        remove(task.taskId);
      }
    }
    if (worktreePlan) {
      details.worktree = {
        enabled: true,
        ...preserveWorktreeOnCrash(worktreePlan),
      };
    }
    if (details.taskId) {
      try {
        updateMeta(details.taskId, {
          status: 'spawn_failed',
          endedAt: new Date().toISOString(),
        });
      } catch (metadataError) {
        details.error += `; metadata update failed: ${
          (metadataError as Error).message
        }`;
      }
      emitLifecycle(pi, 'subagent:failed', {
        taskId: details.taskId,
        error: details.error,
      });
    }
    persistResult(details);
    return taskResult(details);
  }
}

function persistResult(details: SubagentDetails): void {
  if (!details.taskId) {
    return;
  }
  try {
    saveResult(details);
  } catch (error) {
    details.retrievalNote = `Could not save result.json: ${
      (error as Error).message
    }. The report is still included here; inspect bus.jsonl if needed.`;
  }
}

function activeDetails(task: ActiveTask): SubagentDetails {
  return {
    taskId: task.taskId,
    agent: task.agentName,
    task: task.task,
    mode: task.mode,
    pid: task.process.pid,
    taskDir: taskDir(task.taskId),
    cwd: readMeta(task.taskId)?.cwd,
    status: task.status,
    progress: [],
    worktree: {enabled: !!task.worktreePath},
    finalReport: task.finalReport ?? task.lastReport,
  };
}

function textResult(text: string): AgentToolResult<undefined> {
  return {content: [{type: 'text', text}], details: undefined};
}

function buildSystemPromptFile(agent: AgentConfig): string {
  return [
    `# Subagent system prompt (${agent.name})`,
    '',
    'You are a headless subagent. Use report for results, progress for short updates, and ask when you genuinely need clarification from the controlling agent or user.',
    '',
    `## Soft turn limit: ${MAX_TURNS} (grace: ${GRACE_TURNS})`,
    '',
    'Wrap up at the soft limit with a report of partial work. Stop after the grace period.',
    '',
    `## Agent personality: ${agent.name}`,
    '',
    agent.systemPrompt,
    '',
  ].join('\n');
}
