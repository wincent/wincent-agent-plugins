/**
 * Tests for the pure dispatch decision in `ask-decision.ts`.
 *
 * The rest of `handleAsk` (in `ask.ts`) is intentionally not unit-
 * tested here: it pulls in `@earendil-works/pi-ai`, whose runtime
 * module is provided by pi itself at load time rather than by this
 * extension's stub-only `node_modules`, so importing it from a node
 * --test process fails. End-to-end coverage of the LLM path comes
 * from manual runs; coverage of the bus protocol comes from
 * `integration.test.ts`.
 */

import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {LLM_ASK_BUDGET, decideAskAction} from '../main/ask-decision.js';

test('decideAskAction returns "deny" for the deny policy regardless of count', () => {
  assert.equal(decideAskAction('deny', 0), 'deny');
  assert.equal(decideAskAction('deny', 5), 'deny');
  assert.equal(decideAskAction('deny', 1000), 'deny');
});

test('decideAskAction returns "human" for the human policy regardless of count', () => {
  assert.equal(decideAskAction('human', 0), 'human');
  assert.equal(decideAskAction('human', LLM_ASK_BUDGET), 'human');
  assert.equal(decideAskAction('human', LLM_ASK_BUDGET + 100), 'human');
});

test('decideAskAction returns "llm" while under budget', () => {
  assert.equal(decideAskAction('llm', 0), 'llm');
  assert.equal(decideAskAction('llm', 1), 'llm');
  assert.equal(decideAskAction('llm', LLM_ASK_BUDGET - 1), 'llm');
});

test('decideAskAction escalates exactly at the budget boundary', () => {
  assert.equal(decideAskAction('llm', LLM_ASK_BUDGET), 'human-escalated');
  assert.equal(decideAskAction('llm', LLM_ASK_BUDGET + 1), 'human-escalated');
  assert.equal(decideAskAction('llm', LLM_ASK_BUDGET * 100), 'human-escalated');
});

test('decideAskAction honours a caller-supplied budget override', () => {
  // Smaller-than-default budget triggers earlier.
  assert.equal(decideAskAction('llm', 2, 3), 'llm');
  assert.equal(decideAskAction('llm', 3, 3), 'human-escalated');

  // Larger-than-default budget delays the escalation.
  assert.equal(decideAskAction('llm', LLM_ASK_BUDGET, 100), 'llm');
  assert.equal(decideAskAction('llm', 99, 100), 'llm');
  assert.equal(decideAskAction('llm', 100, 100), 'human-escalated');

  // Budget of zero escalates immediately (degenerate but well-defined).
  assert.equal(decideAskAction('llm', 0, 0), 'human-escalated');
});

test('LLM_ASK_BUDGET is the documented default', () => {
  // If you change this, please update the skill and the README as well.
  assert.equal(LLM_ASK_BUDGET, 10);
});
