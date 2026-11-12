import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {registerHooks} from 'node:module';
import {test} from 'node:test';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './subagent-identity.js') specifier = './subagent-identity.ts';
    return nextResolve(specifier, context);
  },
});
let collectSubagentState, provideSubagentState, SUBAGENT_STATE_ENV, takeSubagentState;
try {
  ({collectSubagentState, provideSubagentState, SUBAGENT_STATE_ENV, takeSubagentState} = await import('../lib/subagent-state.ts'));
} finally {
  hooks.deregister();
}

const child = (pid = process.pid) => ({
  PI_SUBAGENT_TASK_ID: 'test-child',
  PI_SUBAGENT_BUS_DIR: '/test-bus',
  PI_SUBAGENT_SOCKET_PATH: '/test-bus/socket',
  PI_SUBAGENT_PID: String(pid),
});

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
  Object.assign(env, child());
  assert.equal(takeSubagentState('toString', env), undefined);
  assert.equal(takeSubagentState('approval', env), true);
  assert.equal(takeSubagentState('approval', env), undefined);
  assert.equal(takeSubagentState('preference', env), 'de');
  assert.equal(env[SUBAGENT_STATE_ENV], undefined);
});

test('absent and malformed snapshots import no state', () => {
  for (const value of [undefined, '', '{', 'null', 'true', '42', '"text"', '[true]']) {
    const env = {...child(), [SUBAGENT_STATE_ENV]: value};
    assert.equal(takeSubagentState('approval', env), undefined);
    assert.equal(env[SUBAGENT_STATE_ENV], undefined);
  }
});

test('descendants that inherit a subagent environment neither import nor consume its state', () => {
  const snapshot = JSON.stringify({approval: true});
  for (const env of [
    {...child(process.pid + 1), [SUBAGENT_STATE_ENV]: snapshot},
    {PI_SUBAGENT_TASK_ID: 'test-child', [SUBAGENT_STATE_ENV]: snapshot},
    {...child(), PI_SUBAGENT_SOCKET_PATH: undefined, [SUBAGENT_STATE_ENV]: snapshot},
  ]) {
    assert.equal(takeSubagentState('approval', env), undefined);
    assert.equal(env[SUBAGENT_STATE_ENV], snapshot);
  }
  const env = {...child(4242), [SUBAGENT_STATE_ENV]: snapshot};
  assert.equal(takeSubagentState('approval', env, 4242), true, 'The owning PID is the subagent');
});
