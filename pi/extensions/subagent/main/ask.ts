/**
 * `ask` envelope handling on the main side.
 *
 * The subagent's `ask` tool sends an `ask` envelope; this module is the
 * single place that turns that into an `answer` envelope on the bus,
 * regardless of whether the requesting task is in sync or background
 * mode. Three policies are supported:
 *
 *   - "human": prompt the watching user via `ctx.ui.input`. The original
 *     behaviour, and the right choice for short-lived helpers running
 *     in a visible split-right pane.
 *
 *   - "deny": short-circuit with a canned reply telling the subagent to
 *     make a reasonable assumption and document it. The right choice
 *     for fire-and-forget background work where a popup would be
 *     intrusive (e.g. sweep workers in detached windows).
 *
 *   - "llm": ask the main agent's own model out-of-band via a one-shot
 *     `complete()` call, then reply on the bus. The model is whatever
 *     `ctx.model` currently is, so the answer comes from the same
 *     model the main agent is using. The main conversation transcript
 *     is NOT touched.
 *
 * For the `llm` policy there is a per-task budget (`LLM_ASK_BUDGET`).
 * After that many successful LLM-answered questions, the next ask
 * escalates to a `human` prompt regardless of policy, giving the user
 * a chance to sanity-check that the subagent has not drifted. The
 * counter resets on every escalation attempt (so an Esc-happy user
 * does not get prompted on every subsequent ask) and the subagent
 * gets another budget of LLM answers before the next check-in.
 *
 * `handleAsk` is invoked as fire-and-forget (`void handleAsk(...)`).
 * Errors are swallowed and turned into a defaulted answer so the
 * subagent always unblocks.
 */

import {type UserMessage, complete} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import type {AskPolicy} from './agents.js';
import {
  type AskAction,
  LLM_ASK_BUDGET,
  decideAskAction,
} from './ask-decision.js';
import {emitLifecycle} from './events.js';
import type {ActiveTask} from './registry.js';

// Re-exported here so callers and tests have a single import surface.
export {LLM_ASK_BUDGET, decideAskAction};
export type {AskAction};

/**
 * Source label recorded in the `subagent:answered` lifecycle event.
 *
 *   - 'human'            : ctx.ui.input returned (or defaulted) under
 *                          the normal `'human'` policy
 *   - 'policy'           : canned `ask_policy=deny` reply, or the
 *                          no-ctx fallback for `'human'` policy
 *   - 'llm'              : a one-shot model call answered it
 *   - 'llm-fallback'     : `'llm'` policy but the call could not be
 *                          made (no model, no API key, or failure);
 *                          deny-style reply used instead
 *   - 'human-escalated'  : budget triggered an escalation; the human
 *                          typed a real answer
 *   - 'policy-escalated' : budget triggered an escalation; the human
 *                          dismissed it (Esc / empty / no UI), so the
 *                          deny-style reply was used
 */
export type AnswerSource =
  | 'human'
  | 'policy'
  | 'llm'
  | 'llm-fallback'
  | 'human-escalated'
  | 'policy-escalated';

const LLM_SYSTEM_PROMPT = [
  'You are the main agent supervising a subagent. The subagent has paused',
  'mid-task to ask you a clarifying question. Reply with a short, concrete',
  'answer the subagent can act on, in one or two sentences. If you do not',
  'know, say so plainly and suggest the assumption the subagent should make.',
  'Do not ask follow-up questions; the subagent cannot have a conversation',
  'with you. Do not include preamble like "Sure" or "Of course"; reply with',
  'the answer text only.',
].join(' ');

const DENY_PREFIX = '(ask_policy=deny)';
const LLM_FALLBACK_PREFIX = '(ask_policy=llm; model unavailable)';
const ESCALATED_FALLBACK_PREFIX =
  `(ask_policy=llm; ${LLM_ASK_BUDGET}-answer budget reached; human declined)`;

function buildDenyAnswer(question: string, prefix = DENY_PREFIX): string {
  return (
    `${prefix} No answer available; please make a reasonable assumption `
    + `and note it in your report. Question was: ${question}`
  );
}

interface AskContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext | undefined;
  task: ActiveTask;
  askId: string;
  question: string;
  defaultAnswer: string | undefined;
  policy: AskPolicy;
}

export async function handleAsk(args: AskContext): Promise<void> {
  const {pi, ctx, task, askId, question, defaultAnswer, policy} = args;
  emitLifecycle(pi, 'subagent:asked', {taskId: task.taskId, question});

  const action = decideAskAction(policy, task.llmAnswersSinceEscalation);
  const {text, source} = await executeAction({
    action,
    ctx,
    question,
    defaultAnswer,
    agentName: task.agentName,
  });

  // Update counters based on what actually happened.
  if (source === 'llm') {
    task.llmAnswersSinceEscalation += 1;
    task.llmAnswersTotal += 1;
  } else if (action === 'human-escalated') {
    // Reset on every escalation attempt, so an Esc-happy user is not
    // prompted again on the very next ask.
    task.llmAnswersSinceEscalation = 0;
  }

  try {
    task.bus.emit('answer', {text}, {inReplyTo: askId});
  } catch (err) {
    process.stderr.write(
      `[subagent main] failed to send answer for ${task.taskId}: `
        + `${(err as Error).message}\n`,
    );
  }

  emitLifecycle(pi, 'subagent:answered', {
    taskId: task.taskId,
    text,
    source,
    llmAnswersTotal: task.llmAnswersTotal,
  });
}

async function executeAction(args: {
  action: AskAction;
  ctx: ExtensionContext | undefined;
  question: string;
  defaultAnswer: string | undefined;
  agentName: string;
}): Promise<{text: string; source: AnswerSource}> {
  const {action, ctx, question, defaultAnswer, agentName} = args;

  switch (action) {
    case 'deny':
      return {text: buildDenyAnswer(question), source: 'policy'};

    case 'llm': {
      const llm = await tryAnswerWithLlm(ctx, question);
      if (llm !== null) {
        return {text: llm, source: 'llm'};
      }
      return {
        text: buildDenyAnswer(question, LLM_FALLBACK_PREFIX),
        source: 'llm-fallback',
      };
    }

    case 'human': {
      const result = await askHuman({
        ctx,
        title: `Subagent ${agentName} asks: ${question}`,
        placeholder: HUMAN_INPUT_HINT,
      });
      if (result.kind === 'answered') {
        return {text: result.text, source: 'human'};
      }
      if (result.kind === 'dismissed') {
        return {
          text: defaultAnswer ?? '(no answer)',
          source: 'human',
        };
      }
      // result.kind === 'unavailable'
      return {
        text: defaultAnswer ?? buildDenyAnswer(question),
        source: 'policy',
      };
    }

    case 'human-escalated': {
      const result = await askHuman({
        ctx,
        title:
          `Subagent ${agentName} (${LLM_ASK_BUDGET} LLM answers used; Esc to let it proceed): `
          + question,
        placeholder: HUMAN_INPUT_HINT,
      });
      if (result.kind === 'answered') {
        return {text: result.text, source: 'human-escalated'};
      }
      // Dismissed or unavailable: fall back to a deny-style reply so the
      // subagent unblocks, but tag the source distinctly so the audit
      // log shows the escalation happened.
      return {
        text: defaultAnswer
          ?? buildDenyAnswer(question, ESCALATED_FALLBACK_PREFIX),
        source: 'policy-escalated',
      };
    }
  }
}

/**
 * The placeholder shown inside the empty input field. Important context
 * (the subagent's question, budget status, etc.) goes in the title
 * instead, because the title stays visible while the placeholder is
 * cleared the moment the user starts typing.
 */
const HUMAN_INPUT_HINT = '(type your answer, or press Esc to dismiss)';

type HumanAskResult =
  | {kind: 'answered'; text: string}
  | {kind: 'dismissed'} // user pressed Esc / submitted empty
  | {kind: 'unavailable'}; // no ctx, no UI, or input() threw

async function askHuman(args: {
  ctx: ExtensionContext | undefined;
  title: string;
  placeholder: string;
}): Promise<HumanAskResult> {
  const {ctx, title, placeholder} = args;
  if (!ctx || !ctx.hasUI) {
    return {kind: 'unavailable'};
  }
  let fromUi: string | undefined;
  try {
    fromUi = await ctx.ui.input(title, placeholder);
  } catch (err) {
    process.stderr.write(
      `[subagent main] ctx.ui.input failed: ${(err as Error).message}\n`,
    );
    return {kind: 'unavailable'};
  }
  if (fromUi === undefined || fromUi === null || fromUi === '') {
    return {kind: 'dismissed'};
  }
  return {kind: 'answered', text: fromUi};
}

/**
 * Returns the answer text on success, or `null` if the call could not be
 * made (no model, no API key, or the request failed/aborted).
 */
async function tryAnswerWithLlm(
  ctx: ExtensionContext | undefined,
  question: string,
): Promise<string | null> {
  if (!ctx?.model) {
    return null;
  }
  let auth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  } catch (err) {
    process.stderr.write(
      `[subagent main] ask_policy=llm: getApiKeyAndHeaders failed: `
        + `${(err as Error).message}\n`,
    );
    return null;
  }
  if (!auth.ok || !auth.apiKey) {
    return null;
  }

  const userMessage: UserMessage = {
    role: 'user',
    content: [{type: 'text', text: question}],
    timestamp: Date.now(),
  };

  try {
    const response = await complete(
      ctx.model,
      {systemPrompt: LLM_SYSTEM_PROMPT, messages: [userMessage]},
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: ctx.signal,
      },
    );
    if (response.stopReason === 'aborted' || response.stopReason === 'error') {
      return null;
    }
    const text = response.content
      .filter((c): c is {type: 'text'; text: string} => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    process.stderr.write(
      `[subagent main] ask_policy=llm: complete() failed: `
        + `${(err as Error).message}\n`,
    );
    return null;
  }
}
