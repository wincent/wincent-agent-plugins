import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {
  collectSubagentState,
  provideSubagentState,
  SUBAGENT_STATE_ENV,
  takeSubagentState,
} from '../lib/subagent-state.ts';

test('only explicit providers contribute state, captured independently at dispatch', () => {
  const pi = {events: new EventEmitter()};
  assert.equal(collectSubagentState(pi), '{}');
  let approved = false;
  provideSubagentState(pi, 'approval', () => approved);
  provideSubagentState(pi, 'preference', () => ({language: 'de', pages: [0, 1]}));
  const before = collectSubagentState(pi);
  approved = true;
  const after = collectSubagentState(pi);
  assert.deepEqual(JSON.parse(before), {approval: false, preference: {language: 'de', pages: [0, 1]}});
  assert.deepEqual(JSON.parse(after), {approval: true, preference: {language: 'de', pages: [0, 1]}});
  approved = false;
  assert.equal(JSON.parse(after).approval, true);
  assert.equal(JSON.parse(collectSubagentState(pi)).approval, false);
});

test('imports require child context and consume only their own namespace once', () => {
  const env = {[SUBAGENT_STATE_ENV]: JSON.stringify({approval: true, preference: 'de'})};
  assert.equal(takeSubagentState('approval', env), undefined);
  env.PI_SUBAGENT_TASK_ID = 'test-child';
  assert.equal(takeSubagentState('toString', env), undefined);
  assert.equal(takeSubagentState('approval', env), true);
  assert.equal(takeSubagentState('approval', env), undefined);
  assert.equal(takeSubagentState('preference', env), 'de');
  assert.equal(env[SUBAGENT_STATE_ENV], undefined);
});

test('absent and malformed snapshots import no state', () => {
  for (const value of [undefined, '', '{', 'null', 'true', '42', '"text"', '[true]']) {
    const env = {PI_SUBAGENT_TASK_ID: 'test-child', [SUBAGENT_STATE_ENV]: value};
    assert.equal(takeSubagentState('approval', env), undefined);
    assert.equal(env[SUBAGENT_STATE_ENV], undefined);
  }
});
