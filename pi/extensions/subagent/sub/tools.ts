/**
 * Tools registered in subagent mode: report, ask, progress.
 *
 * These are the only way the subagent communicates back to the main agent.
 * They are always available in sub mode regardless of the agent's tool
 * whitelist (the whitelist applies to user tools like read/bash/grep, not to
 * runtime bus tools).
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';

import type {Bus} from '../bus/bus.js';
import type {
  AnswerEnvelope,
  CommitInfo,
  Finding,
  Severity,
} from '../bus/envelope.js';

const SeveritySchema = Type.Union([
  Type.Literal('info'),
  Type.Literal('warning'),
  Type.Literal('error'),
]);

const FindingSchema = Type.Object({
  file: Type.Optional(
    Type.String({description: 'Absolute or repo-relative path'}),
  ),
  line: Type.Optional(Type.Integer({minimum: 1})),
  column: Type.Optional(Type.Integer({minimum: 1})),
  severity: SeveritySchema,
  message: Type.String(),
  rule: Type.Optional(Type.String()),
});

const CommitInfoSchema = Type.Object({
  sha: Type.String(),
  subject: Type.String(),
});

const ProgressParams = Type.Object({
  text: Type.String({
    description: 'Short status update to display in the main agent UI',
  }),
  kind: Type.Optional(
    Type.Union([
      Type.Literal('info'),
      Type.Literal('tool'),
      Type.Literal('thinking'),
    ]),
  ),
});

const ReportParams = Type.Object({
  summary: Type.String({
    description: 'One or two sentence summary of what was done',
  }),
  findings: Type.Optional(Type.Array(FindingSchema)),
  branch: Type.Optional(
    Type.String({description: 'Branch name (case-2 workers)'}),
  ),
  commits: Type.Optional(Type.Array(CommitInfoSchema)),
  data: Type.Optional(Type.Unknown()),
  final: Type.Optional(
    Type.Boolean({
      description: 'Whether this is the final report. Defaults to true.',
    }),
  ),
});

const AskParams = Type.Object({
  question: Type.String({
    description: 'Question to ask the main agent or user',
  }),
  options: Type.Optional(Type.Array(Type.String())),
  default: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      description: 'Reply timeout (default 5 minutes)',
    }),
  ),
});

const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;

export interface SubToolsOptions {
  bus: Bus;
}

export function registerSubTools(
  pi: ExtensionAPI,
  options: SubToolsOptions,
): void {
  const {bus} = options;

  pi.registerTool({
    name: 'progress',
    label: 'Progress',
    description:
      'Send a short status update back to the main agent. Fire-and-forget; '
      + 'use this to keep the main agent informed while you work. Prefer `report` '
      + 'when you have structured findings or final results.',
    parameters: ProgressParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      bus.emit('progress', {text: params.text, kind: params.kind});
      return {
        content: [{type: 'text', text: 'progress sent'}],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: 'report',
    label: 'Report',
    description:
      'Send a structured report back to the main agent. Use this for findings, '
      + 'commit summaries, or your final answer. Set `final: false` to send an '
      + 'incremental report and continue working; `final: true` (the default) '
      + 'indicates this is your last report.',
    parameters: ReportParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const findings = params.findings as Finding[] | undefined;
      const commits = params.commits as CommitInfo[] | undefined;
      bus.emit('report', {
        summary: params.summary,
        ...(findings ? {findings} : {}),
        ...(params.branch ? {branch: params.branch} : {}),
        ...(commits ? {commits} : {}),
        ...(params.data !== undefined ? {data: params.data} : {}),
        final: params.final ?? true,
      });
      return {
        content: [{type: 'text', text: 'report sent'}],
        details: {summary: params.summary},
      };
    },
  });

  pi.registerTool({
    name: 'ask',
    label: 'Ask',
    description:
      'Ask the main agent (or the human watching) a clarifying question and wait '
      + 'for the answer. Use sparingly: prefer to make a reasonable assumption and '
      + 'note it in your report. The call blocks until an answer arrives or the '
      + 'timeout elapses.',
    parameters: AskParams,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const timeoutMs = params.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
      const askPromise = bus.request('ask', {
        question: params.question,
        ...(params.options ? {options: params.options} : {}),
        ...(params.default !== undefined ? {default: params.default} : {}),
        timeoutMs,
      }, {timeoutMs});

      const env = await waitOrAbort(askPromise, signal);
      if (env.type !== 'answer') {
        throw new Error(
          `expected answer envelope in reply to ask, got ${env.type}`,
        );
      }
      const answerEnv = env as AnswerEnvelope;
      return {
        content: [{type: 'text', text: answerEnv.payload.text}],
        details: {question: params.question, answer: answerEnv.payload.text},
      };
    },
  });
}

async function waitOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw new Error('ask aborted');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('ask aborted'));
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Re-export for tests.
 */
export type {Severity};
export type _UnusedContext = ExtensionContext;
