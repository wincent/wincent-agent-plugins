/**
 * Pure ask-dispatch logic, separated from the rest of `ask.ts` so it can
 * be unit-tested without pulling in `@earendil-works/pi-ai` (whose
 * runtime module is provided by pi itself at load time, not by this
 * extension's stub-only `node_modules`).
 *
 * Keep this file dependency-free: no platform imports, no I/O, no
 * model calls. Just the decision a caller makes given the configured
 * policy and how many autonomous LLM answers the task has already
 * consumed.
 */

import type {AskPolicy} from './agents.js';

/**
 * How many successful `'llm'`-policy answers a single subagent gets
 * before the next ask is escalated to a human prompt. Tuned by feel:
 * frequent enough that a drifting subagent is caught early, infrequent
 * enough that the user is not constantly interrupted.
 */
export const LLM_ASK_BUDGET = 10;

/**
 * Which branch of the answer machinery should run.
 *
 *   - 'llm'             : do a one-shot model call
 *   - 'deny'            : reply with the canned deny message
 *   - 'human'           : prompt the user via ctx.ui.input (normal)
 *   - 'human-escalated' : prompt the user via ctx.ui.input because the
 *                         per-task LLM budget has been reached; the
 *                         counter will be reset after this attempt
 */
export type AskAction = 'llm' | 'deny' | 'human' | 'human-escalated';

export function decideAskAction(
  policy: AskPolicy,
  llmAnswersSinceEscalation: number,
  budget: number = LLM_ASK_BUDGET,
): AskAction {
  if (policy === 'deny') {
    return 'deny';
  }
  if (policy === 'human') {
    return 'human';
  }
  // policy === 'llm'
  if (llmAnswersSinceEscalation >= budget) {
    return 'human-escalated';
  }
  return 'llm';
}
