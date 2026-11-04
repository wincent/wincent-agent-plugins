import {strict as assert} from 'node:assert';
import fs from 'node:fs';
import {test} from 'node:test';
import extension from '../program-status.ts';

function harness(t, options = {}) {
  for (const [key, value] of Object.entries({
    PI_PROGRAM_STATUS: undefined,
    TMUX: '/tmp/tmux-123/default,1,0',
    PI_SUBAGENT_TASK_ID: undefined,
    ...options.env,
  })) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', {value: options.tty ?? true, configurable: true});
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
    else delete process.stdout.isTTY;
  });
  const writes = [];
  const notifications = [];
  const events = new Map();
  t.mock.method(fs, 'writeSync', (fd, text) => {
    assert.equal(fd, process.stdout.fd);
    if (options.writeFails) throw new Error('terminal closed');
    writes.push(text);
    return text.length;
  });
  const ctx = {
    mode: options.mode ?? 'tui',
    isIdle: () => options.idle ?? true,
    ui: {notify: (...args) => notifications.push(args)},
  };
  extension({on: (name, handler) => events.set(name, handler)});
  const emit = (type, data = {}) => events.get(type)?.({type, ...data}, ctx);
  t.after(() => emit('session_shutdown'));
  return {
    writes, notifications, ctx, emit,
    start: () => emit('session_start'),
    settle(outcome = 'completed', aborted = false) {
      emit('agent_before_settle', {outcome});
      emit('agent_settled', {aborted});
    },
    records() {
      return writes.map((sequence) => {
        if (sequence.startsWith('\x1bPtmux;')) {
          sequence = sequence.slice(7, -2).replaceAll('\x1b\x1b', '\x1b');
        }
        assert.ok(sequence.startsWith('\x1b]7501;'));
        assert.ok(sequence.endsWith('\x1b\\'));
        return Object.fromEntries(sequence.slice(7, -2).split(':').map((pair) => pair.split('=')));
      });
    },
    states() { return this.records().map((record) => record.state); },
  };
}

test('starts only at session_start and uses a private record with no transcript text', (t) => {
  const h = harness(t);
  assert.deepEqual(h.writes, []);
  h.start();
  const [record] = h.records();
  assert.match(record.id, /^pi\/[a-f0-9]{32}$/);
  assert.deepEqual(record, {state: 'idle', id: record.id, app: 'pi'});
  assert.equal(h.writes[0], `\x1bPtmux;\x1b\x1b]7501;state=idle:id=${record.id}:app=pi\x1b\x1b\\\x1b\\`);
  h.emit('before_agent_start', {prompt: 'private prompt'});
  h.emit('agent_start');
  h.emit('message_end', {message: {role: 'assistant', content: 'private reply'}});
  h.settle();
  assert.deepEqual(h.states(), ['idle', 'working', 'done']);
  assert.ok(h.records().every(({id}) => id === record.id));
  assert.ok(!h.writes.join('').includes('private'));
});

test('wraps reports and scoped cleanup for one tmux layer, doubling every payload ESC', (t) => {
  const h = harness(t);
  h.start();
  h.emit('agent_start');
  h.settle();
  h.emit('session_shutdown');
  const records = h.records();
  assert.deepEqual(h.states(), ['idle', 'working', 'done', 'clear']);
  for (const [index, record] of records.entries()) {
    assert.equal(h.writes[index], `\x1bPtmux;\x1b\x1b]7501;state=${record.state}:id=${record.id}:app=pi\x1b\x1b\\\x1b\\`);
  }
});

test('waits for settlement, including recovery and continuation, before reporting an outcome', (t) => {
  const h = harness(t);
  h.start();
  h.emit('agent_start');
  h.emit('message_end', {message: {role: 'assistant', stopReason: 'error'}});
  h.emit('tool_result', {isError: true});
  h.emit('agent_end');
  h.emit('agent_before_settle', {outcome: 'error'});
  assert.deepEqual(h.states(), ['idle', 'working']);
  h.emit('agent_start');
  h.settle();
  assert.deepEqual(h.states(), ['idle', 'working', 'done']);
  h.emit('agent_start');
  h.settle('error');
  assert.equal(h.states().at(-1), 'error');
  h.emit('agent_start');
  h.settle('error', true);
  assert.equal(h.states().at(-1), 'idle');
  h.emit('agent_start');
  h.settle('aborted');
  assert.equal(h.states().at(-1), 'idle');
});

test('blocking dialogs override work and restore it only after all dialogs close', (t) => {
  const h = harness(t);
  h.start();
  h.emit('agent_start');
  h.emit('ui_prompt_start', {kind: 'confirm', title: 'private approval'});
  assert.equal(h.records().at(-1).kind, 'permission');
  h.emit('ui_prompt_start', {kind: 'input', title: 'private question'});
  assert.equal(h.records().at(-1).kind, 'question');
  h.emit('ui_prompt_end', {kind: 'confirm', title: 'private approval'});
  assert.equal(h.states().at(-1), 'blocked');
  h.emit('ui_prompt_end', {kind: 'input', title: 'private question'});
  assert.equal(h.states().at(-1), 'working');
  h.emit('ui_prompt_start', {kind: 'custom'});
  assert.equal(h.records().at(-1).kind, undefined);
  h.settle();
  assert.equal(h.states().at(-1), 'blocked');
  h.emit('ui_prompt_end', {kind: 'custom'});
  assert.equal(h.states().at(-1), 'done');
  assert.ok(!h.writes.join('').includes('private'));
});

test('idle dialogs return to idle and unmatched end events do not dismiss another prompt', (t) => {
  const h = harness(t);
  h.start();
  h.emit('ui_prompt_start', {kind: 'select', title: 'choice'});
  h.emit('ui_prompt_end', {kind: 'input', title: 'other'});
  assert.equal(h.states().at(-1), 'blocked');
  h.emit('ui_prompt_end', {kind: 'select', title: 'choice'});
  assert.deepEqual(h.states(), ['idle', 'blocked', 'idle']);
});

test('tracks manual compaction success, failure, and cancellation without an agent run', (t) => {
  const h = harness(t);
  h.start();
  h.emit('session_before_compact', {reason: 'manual'});
  h.emit('session_compact', {reason: 'manual'});
  h.emit('session_before_compact', {reason: 'manual'});
  h.emit('session_compact_failed', {reason: 'manual', aborted: false});
  h.emit('session_before_compact', {reason: 'manual'});
  h.emit('session_compact_failed', {reason: 'manual', aborted: true});
  assert.deepEqual(h.states(), ['idle', 'working', 'done', 'working', 'error', 'working', 'idle']);
});

test('automatic compaction does not prematurely finish an active run', (t) => {
  const h = harness(t);
  h.start();
  h.emit('agent_start');
  h.emit('session_before_compact', {reason: 'overflow'});
  h.emit('session_compact', {reason: 'overflow'});
  h.emit('session_before_compact', {reason: 'threshold'});
  h.emit('session_compact_failed', {reason: 'threshold', aborted: false});
  assert.deepEqual(h.states(), ['idle', 'working']);
  h.settle('error');
  assert.equal(h.states().at(-1), 'error');
});

for (const mode of ['rpc', 'json', 'print']) {
  test(`does not report or notify in ${mode} mode, even with a TTY`, (t) => {
    const h = harness(t, {mode, env: {PI_PROGRAM_STATUS: '1'}});
    h.start();
    h.emit('agent_start');
    h.emit('ui_prompt_start', {kind: 'input'});
    h.emit('session_before_compact');
    h.settle();
    h.emit('session_shutdown');
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.notifications, []);
  });
}

for (const options of [{tty: false}, {env: {PI_SUBAGENT_TASK_ID: 'child-123'}}]) {
  test(`does not report from ${options.tty === false ? 'redirected output' : 'a marked subagent, even in TUI mode'}`, (t) => {
    const h = harness(t, options);
    h.start();
    h.emit('agent_start');
    h.emit('ui_prompt_start', {kind: 'input'});
    h.settle();
    h.emit('session_shutdown');
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.notifications, []);
  });
}

for (const value of [undefined, '0', '1']) {
  test(`activates automatically in tmux without changing PI_PROGRAM_STATUS=${value}`, (t) => {
    const h = harness(t, {env: {PI_PROGRAM_STATUS: value}});
    h.start();
    h.emit('agent_start');
    h.settle();
    h.emit('session_shutdown');
    assert.deepEqual(h.states(), ['idle', 'working', 'done', 'clear']);
    assert.deepEqual(h.notifications, []);
    assert.equal(process.env.PI_PROGRAM_STATUS, value);
  });
}

for (const tmux of [undefined, '']) {
  test(`stays silent outside tmux (TMUX=${JSON.stringify(tmux)})`, (t) => {
    const h = harness(t, {env: {TMUX: tmux}});
    const listeners = process.listenerCount('exit');
    h.start();
    h.emit('agent_start');
    h.emit('ui_prompt_start', {kind: 'input'});
    h.emit('session_before_compact');
    h.settle();
    h.emit('session_shutdown');
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.notifications, []);
    assert.equal(process.listenerCount('exit'), listeners);
  });
}

test('shutdown is idempotent, removes the exit hook, and reload gets a fresh ID', (t) => {
  const h = harness(t);
  const listeners = process.listenerCount('exit');
  h.start();
  const first = h.records()[0].id;
  assert.equal(process.listenerCount('exit'), listeners + 1);
  h.emit('agent_start');
  h.emit('ui_prompt_start', {kind: 'input'});
  h.emit('session_shutdown');
  const count = h.writes.length;
  h.emit('session_shutdown');
  h.emit('agent_start');
  assert.equal(h.writes.length, count);
  assert.equal(process.listenerCount('exit'), listeners);
  assert.deepEqual(h.records().at(-1), {state: 'clear', id: first, app: 'pi'});
  h.start();
  assert.equal(h.states().at(-1), 'idle');
  assert.notEqual(h.records().at(-1).id, first);
  h.start(); // Defensive repeated startup clears only the preceding instance.
  assert.deepEqual(h.states().slice(-2), ['clear', 'idle']);
  assert.equal(process.listenerCount('exit'), listeners + 1);
});

test('simultaneous reporters keep independent IDs and never clear each other', (t) => {
  const h = harness(t);
  const events = new Map();
  extension({on: (type, handler) => events.set(type, handler)});
  const emit = (type, data = {}) => events.get(type)?.({type, ...data}, h.ctx);
  t.after(() => emit('session_shutdown'));
  h.start();
  const first = h.records().at(-1).id;
  emit('session_start');
  const second = h.records().at(-1).id;
  assert.notEqual(first, second);
  h.emit('agent_start');
  emit('ui_prompt_start', {kind: 'confirm'});
  h.emit('session_shutdown');
  const live = new Map();
  for (const record of h.records()) {
    if (record.state === 'clear') live.delete(record.id);
    else live.set(record.id, record.state);
  }
  assert.deepEqual([...live], [[second, 'blocked']]);
});

test('exit fallback clears only this reporter and does not retain a listener', (t) => {
  const h = harness(t);
  const existing = new Set(process.listeners('exit'));
  h.start();
  const cleanup = process.listeners('exit').find((listener) => !existing.has(listener));
  assert.ok(cleanup);
  cleanup(); // Do not dispatch other extensions' exit handlers in this test.
  assert.deepEqual(h.states(), ['idle', 'clear']);
  assert.equal(h.records()[0].id, h.records()[1].id);
  assert.ok(!process.listeners('exit').includes(cleanup));
});

test('starts working when loaded into a busy session', (t) => {
  const h = harness(t, {idle: false});
  h.start();
  assert.deepEqual(h.states(), ['working']);
  h.settle();
  assert.deepEqual(h.states(), ['working', 'done']);
});

test('terminal write failures never interrupt the agent', (t) => {
  const h = harness(t, {writeFails: true});
  assert.doesNotThrow(() => {
    h.start();
    h.emit('agent_start');
    h.settle();
    h.emit('session_shutdown');
  });
});
