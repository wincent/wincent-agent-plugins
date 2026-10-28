import {
  type AssistantMessage,
  type ToolCall,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {execFileSync} from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
  provideSubagentState,
  takeSubagentState,
} from '../../../lib/subagent-state.js';

/** Deterministic, in-memory provider. No requests, credentials, or paid tokens. */
export default function (pi: ExtensionAPI): void {
  let scenario = 'ask';
  let turn = 0;
  let continued = false;
  let backgroundFinished = false;
  const isChild = !!process.env.PI_SUBAGENT_TASK_ID;
  let inheritedState: unknown;
  provideSubagentState(
    pi,
    'test-preference',
    () => ({language: 'de', enabled: true}),
  );
  pi.on('session_start', () => {
    inheritedState = takeSubagentState('test-preference');
  });
  pi.on('input', (event) => {
    if (turn === 0) {
      scenario = event.text;
    }
  });
  pi.on('before_agent_start', (_event, ctx) => {
    writeFileSync(
      join(
        isChild ? process.env.PI_SUBAGENT_BUS_DIR! : ctx.cwd,
        'runtime.json',
      ),
      JSON.stringify({
        executable: realpathSync(process.execPath),
        entrypoint: realpathSync(process.argv[1]),
        socketRoot: process.env.PI_SUBAGENT_SOCKET_ROOT ?? null,
      }),
      {mode: 0o600},
    );
    if (isChild) {
      writeFileSync(
        join(process.env.PI_SUBAGENT_BUS_DIR!, 'extension-state.json'),
        JSON.stringify(inheritedState ?? null),
      );
      writeFileSync(
        join(process.env.PI_SUBAGENT_BUS_DIR!, 'observed.json'),
        JSON.stringify({
          provider: ctx.model?.provider,
          model: ctx.model?.id,
          thinking: pi.getThinkingLevel(),
          hasUI: ctx.hasUI,
          socketPath: process.env.PI_SUBAGENT_SOCKET_PATH,
          busDir: process.env.PI_SUBAGENT_BUS_DIR,
        }),
      );
    }
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (!isChild && scenario === 'session-storage') {
      writeFileSync(
        join(ctx.cwd, 'resume-sessions.json'),
        JSON.stringify({
          current: (await SessionManager.list(ctx.cwd)).map((s) => s.path),
          all: (await SessionManager.listAll()).map((s) => s.path),
        }),
      );
    }
  });
  pi.on('agent_before_settle', (event) => {
    if (
      scenario === 'continuation' && !continued && event.outcome === 'completed'
    ) {
      continued = true;
      return {
        continue: true,
        entries: [{
          type: 'custom_message',
          customType: 'test-continuation',
          content: 'Continue with the final answer.',
          display: false,
        }],
      };
    }
  });
  pi.events.on('subagent:spawned', (data) => {
    if (scenario === 'result-failure') {
      const {taskId} = data as {taskId: string};
      mkdirSync(
        join(
          process.env.XDG_STATE_HOME!,
          'pi',
          'subagent',
          taskId,
          'result.json',
        ),
      );
    }
    if (scenario === 'metadata-failure') {
      const {taskId} = data as {taskId: string};
      chmodSync(
        join(
          process.env.XDG_STATE_HOME!,
          'pi',
          'subagent',
          taskId,
          'meta.json',
        ),
        0o400,
      );
    }
  });
  pi.events.on('subagent:report', (data) => {
    const {taskId} = data as {taskId: string};
    appendFileSync(
      join(
        process.env.XDG_STATE_HOME!,
        'pi',
        'subagent',
        taskId,
        'reports-observed.jsonl',
      ),
      JSON.stringify(data) + '\n',
    );
  });
  pi.events.on('subagent:finalizing', (data) => {
    const {taskId} = data as {taskId: string};
    const dir = join(process.env.XDG_STATE_HOME!, 'pi', 'subagent', taskId);
    writeFileSync(
      join(dir, 'finalizing-observed.json'),
      JSON.stringify({
        status: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).status,
        hasSavedResult: existsSync(join(dir, 'result.json')),
      }),
    );
  });
  pi.events.on('subagent:done', () => {
    backgroundFinished = true;
  });
  pi.registerProvider('subagent-test', {
    api: 'subagent-test-api',
    apiKey: 'not-a-real-key',
    baseUrl: 'http://invalid.test',
    models: [{
      id: 'exact-test-model',
      name: 'Subagent test',
      reasoning: true,
      input: ['text'],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 100_000,
      maxTokens: 1_000,
    }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      // Synthetic accounting data only; this provider never makes a request.
      const input = isChild && scenario === 'session-storage' ? 1 : 0;
      const cost = input ? 0.25 : 0;
      const output: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'pending',
        usage: {
          input,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: input,
          cost: {
            input: cost,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: cost,
          },
        },
      };
      const respond = () => {
        const current = turn++;
        const dir = process.env.PI_SUBAGENT_BUS_DIR ?? process.cwd();
        appendFileSync(
          join(dir, 'requests.jsonl'),
          JSON.stringify({turn: current, messages: context.messages}) + '\n',
        );
        if (scenario === 'wait') {
          const abort = () => {
            output.stopReason = 'aborted';
            output.errorMessage = 'test request aborted';
            stream.push({type: 'error', reason: 'aborted', error: output});
            stream.end();
          };
          if (options?.signal?.aborted) {
            abort();
          } else {
            options?.signal?.addEventListener('abort', abort, {once: true});
          }
          return;
        }
        if (scenario === 'failure') {
          output.stopReason = 'error';
          output.errorMessage = 'intentional non-retryable test failure';
          stream.push({type: 'error', reason: 'error', error: output});
          stream.end();
          return;
        }
        let call: {name: string; arguments: ToolCall['arguments']} | undefined;
        if (!isChild && scenario.startsWith('retrieve:') && current === 0) {
          call = {
            name: 'subagent_status',
            arguments: {task_id: scenario.slice('retrieve:'.length)},
          };
        } else if (
          !isChild && current === 1 &&
          (scenario === 'background-default-retrieved' ||
            scenario === 'background-default-listed')
        ) {
          const result = context.messages.find((message) =>
            message.role === 'toolResult' && message.toolName === 'subagent'
          );
          const text = result?.role === 'toolResult'
            ? result.content.find((part) => part.type === 'text')
            : undefined;
          const taskId = text?.type === 'text'
            ? text.text.match(/task_id=(task_[^,]+)/)![1]
            : 'missing';
          call = {
            name: 'subagent_status',
            arguments: scenario === 'background-default-retrieved'
              ? {task_id: taskId}
              : {},
          };
        } else if (!isChild && scenario === 'history' && current === 1) {
          call = {name: 'subagent_status', arguments: {}};
        } else if (!isChild && scenario === 'history' && current === 2) {
          const result = context.messages.find((message) =>
            message.role === 'toolResult' && message.toolName === 'subagent'
          );
          const text = result?.role === 'toolResult'
            ? result.content.find((part) => part.type === 'text')
            : undefined;
          const taskId = text?.type === 'text'
            ? JSON.parse(text.text).taskId
            : 'missing';
          call = {name: 'subagent_status', arguments: {task_id: taskId}};
        } else if (!isChild && current === 0) {
          const blankTasks: Record<string, string> = {
            'empty-task': '',
            'whitespace-task': ' \t\r\n',
            'unicode-whitespace-task': '\u2003\u00a0\ufeff',
          };
          call = {
            name: 'subagent',
            arguments: {
              agent: scenario.startsWith('worker-') ? 'worker' : 'scout',
              ...(scenario === 'worker-declined' ? {worktree: false} : {}),
              ...(scenario in blankTasks ? {worktree: true} : {}),
              ...(scenario === 'nested-cwd'
                ? {cwd: "nested/child's directory"}
                : {}),
              task: scenario in blankTasks
                ? blankTasks[scenario]
                : scenario === 'background' ||
                    scenario === 'background-default-shutdown'
                ? 'wait'
                : scenario === 'metadata-failure'
                ? 'ask'
                : scenario,
              ask_policy: 'deny',
              ...(scenario.startsWith('background-default') ? {} : {
                background: scenario === 'background' ||
                  scenario === 'metadata-failure' ||
                  scenario === 'worker-background',
              }),
            },
          };
        } else if (isChild && current === 0) {
          call = {name: 'progress', arguments: {text: 'headless progress'}};
        } else if (
          isChild && scenario.startsWith('worker-') &&
          scenario !== 'worker-declined' && current === 1
        ) {
          call = {
            name: 'bash',
            arguments: {
              command:
                "printf 'example\\n' > foo.txt && git add -- foo.txt && git commit -m 'test worker output'" +
                (scenario === 'worker-partial'
                  ? " && printf 'unfinished\\n' > unfinished.txt"
                  : ''),
            },
          };
        } else if (
          isChild && scenario.startsWith('worker-') &&
          scenario !== 'worker-declined' && current === 2
        ) {
          const sha = execFileSync('git', [
            'rev-parse',
            scenario === 'worker-mismatch' ? 'HEAD^' : 'HEAD',
          ], {encoding: 'utf8'}).trim();
          call = {
            name: 'report',
            arguments: {
              summary: 'Created and committed foo.txt',
              outcome: scenario === 'worker-partial' ? 'partial' : 'completed',
              remaining: scenario === 'worker-partial'
                ? ['Finish the second file']
                : [],
              artifacts: [{
                kind: 'file',
                location: 'foo.txt',
                description: 'Example output',
              }],
              verification: [{
                check: 'Read foo.txt contents',
                result: readFileSync('foo.txt', 'utf8') === 'example\n'
                  ? 'passed'
                  : 'failed',
                details: 'example followed by a newline',
              }],
              commits: [{sha, subject: 'test worker output'}],
            },
          };
        } else if (isChild && current === 1) {
          call = {
            name: 'ask',
            arguments: {question: 'Which value?', timeoutMs: 10_000},
          };
        } else if (isChild && scenario === 'worker-declined' && current === 2) {
          call = {
            name: 'report',
            arguments: {
              outcome: 'declined',
              summary:
                'No file was created because this role requires a commit.',
              blockers: [
                'Mandatory commit workflow conflicts with untracked-only request',
              ],
              remaining: ['Create the untracked scratch file'],
              artifacts: [],
              verification: [{
                check: 'Scratch file contents',
                result: 'not_run',
                details: 'No file was created',
              }],
            },
          };
        } else if (
          isChild &&
          (current === 2 || (scenario === 'interim-report' && current === 3))
        ) {
          call = {
            name: 'report',
            arguments: {
              ...(scenario === 'final-report' ? {final: true} : {}),
              ...(scenario === 'interim-report' ? {final: current === 3} : {}),
              summary: scenario === 'interim-report' && current === 2
                ? 'interim report'
                : 'headless report',
              findings: [{
                severity: 'info',
                message: 'detailed finding',
                file: 'example.ts',
                line: 3,
              }],
              branch: 'subagent/test',
              commits: [{sha: 'worker-sha', subject: 'worker subject'}],
              data: {
                theme: 'detailed theme',
                commits: Array.from(
                  {length: 5},
                  (_value, i) => ({
                    sha: `sha-${i}`,
                    subject: `subject-${i}`,
                    summary: `commit summary ${i}`,
                  }),
                ),
              },
            },
          };
        }
        stream.push({type: 'start', partial: output});
        if (call) {
          const calls = [call];
          if (isChild && scenario === 'mixed-report' && current === 2) {
            calls.push({
              name: 'progress',
              arguments: {text: 'same-batch progress'},
            });
          }
          for (const [index, call] of calls.entries()) {
            const toolCall: ToolCall = {
              type: 'toolCall',
              id: `call_${current}_${index}`,
              name: call.name,
              arguments: {},
            };
            output.content.push(toolCall);
            stream.push({
              type: 'toolcall_start',
              contentIndex: index,
              partial: output,
            });
            toolCall.arguments = call.arguments;
            stream.push({
              type: 'toolcall_end',
              contentIndex: index,
              toolCall,
              partial: output,
            });
          }
          output.stopReason = 'toolUse';
          stream.push({type: 'done', reason: 'toolUse', message: output});
        } else {
          output.content.push({type: 'text', text: ''});
          stream.push({type: 'text_start', contentIndex: 0, partial: output});
          const text = continued
            ? 'continued final answer'
            : 'headless final answer';
          output.content[0] = {type: 'text', text};
          stream.push({
            type: 'text_delta',
            contentIndex: 0,
            delta: text,
            partial: output,
          });
          stream.push({
            type: 'text_end',
            contentIndex: 0,
            content: text,
            partial: output,
          });
          output.stopReason = 'stop';
          stream.push({type: 'done', reason: 'stop', message: output});
        }
        stream.end();
      };
      if (
        !isChild && turn === 1 &&
        (scenario === 'worker-background' ||
          (scenario.startsWith('background-default') &&
            scenario !== 'background-default-shutdown'))
      ) {
        // These scenarios deliberately keep the one-shot controller alive
        // until completion. The shutdown scenarios do not.
        const wait = () =>
          backgroundFinished ? respond() : setTimeout(wait, 10);
        wait();
      } else if (!isChild && scenario === 'metadata-failure' && turn === 1) {
        setTimeout(respond, 300);
      } else {
        queueMicrotask(respond);
      }
      return stream;
    },
  });
}
