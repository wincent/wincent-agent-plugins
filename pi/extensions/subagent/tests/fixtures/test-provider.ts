import {
  type AssistantMessage,
  type ToolCall,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {appendFileSync, chmodSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** Deterministic, in-memory provider. No requests, credentials, or paid tokens. */
export default function (pi: ExtensionAPI): void {
  let scenario = 'ask';
  let turn = 0;
  let continued = false;
  const isChild = !!process.env.PI_SUBAGENT_TASK_ID;
  pi.on('input', (event) => {
    if (turn === 0) {
      scenario = event.text;
    }
  });
  pi.on('before_agent_start', (_event, ctx) => {
    if (isChild) {
      writeFileSync(
        join(process.env.PI_SUBAGENT_BUS_DIR!, 'observed.json'),
        JSON.stringify({
          provider: ctx.model?.provider,
          model: ctx.model?.id,
          thinking: pi.getThinkingLevel(),
          hasUI: ctx.hasUI,
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
      const output: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'pending',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
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
        if (!isChild && current === 0) {
          call = {
            name: 'subagent',
            arguments: {
              agent: 'scout',
              task: scenario === 'background'
                ? 'wait'
                : scenario === 'metadata-failure'
                ? 'ask'
                : scenario,
              ask_policy: 'deny',
              background: scenario === 'background' ||
                scenario === 'metadata-failure',
            },
          };
        } else if (isChild && current === 0) {
          call = {name: 'progress', arguments: {text: 'headless progress'}};
        } else if (isChild && current === 1) {
          call = {
            name: 'ask',
            arguments: {question: 'Which value?', timeoutMs: 10_000},
          };
        } else if (isChild && current === 2) {
          call = {name: 'report', arguments: {summary: 'headless report'}};
        }
        stream.push({type: 'start', partial: output});
        if (call) {
          const toolCall: ToolCall = {
            type: 'toolCall',
            id: `call_${current}`,
            name: call.name,
            arguments: {},
          };
          output.content.push(toolCall);
          stream.push({
            type: 'toolcall_start',
            contentIndex: 0,
            partial: output,
          });
          toolCall.arguments = call.arguments;
          stream.push({
            type: 'toolcall_end',
            contentIndex: 0,
            toolCall,
            partial: output,
          });
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
      if (!isChild && scenario === 'metadata-failure' && turn === 1) {
        setTimeout(respond, 300);
      } else {
        queueMicrotask(respond);
      }
      return stream;
    },
  });
}
