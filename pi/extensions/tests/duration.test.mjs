// Run: node --experimental-transform-types --test pi/extensions/tests/duration.test.mjs
import {strict as assert} from 'node:assert';
import {mkdtempSync, rmSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {test} from 'node:test';
import {piPackageImports} from './pi-package.mjs';

const hooks = registerHooks(piPackageImports([
  '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui',
]));
let extension, SessionManager, visibleWidth;
try {
  ({default: extension} = await import('../duration.ts'));
  ({SessionManager} = await import('@earendil-works/pi-coding-agent'));
  ({visibleWidth} = await import('@earendil-works/pi-tui'));
} finally {
  hooks.deregister();
}

function harness(t, session) {
  let now = 0;
  let idle = true;
  const events = new Map();
  const renderers = new Map();
  const entries = [];
  t.mock.method(performance, 'now', () => now);
  extension({
    on(name, handler) { events.set(name, handler); },
    appendEntry(customType, data) {
      entries.push({type: 'custom', customType, data});
      session?.appendCustomEntry(customType, data);
    },
    registerEntryRenderer(name, renderer) { renderers.set(name, renderer); },
  });
  const ctx = {isIdle: () => idle}; // No UI needed, including in headless modes.
  return {
    entries,
    at(time) { now = time; },
    emit(type, data = {}) { return events.get(type)?.({type, ...data}, ctx); },
    input() { return events.get('input')({type: 'input', source: 'interactive'}, ctx); },
    start(messageType = 'user') {
      idle = false;
      events.get('before_agent_start')({type: 'before_agent_start', messageType}, ctx);
      events.get('agent_start')({type: 'agent_start'}, ctx);
    },
    settle(aborted = false) {
      idle = true;
      events.get('agent_settled')({type: 'agent_settled', aborted}, ctx);
    },
    render(entry, theme = {fg: (_color, text) => text}) {
      return renderers.get(entry.customType)(entry, {expanded: false}, theme);
    },
  };
}

test('times submission through settlement, including preparation and excluding idle time', (t) => {
  const h = harness(t);
  h.input(); // Zero is a valid monotonic start time.
  h.at(2000); // Pre-run compaction and prompt preparation.
  h.start();
  h.at(12345);
  h.settle();
  assert.deepEqual(h.entries, [{type: 'custom', customType: 'duration', data: {durationMs: 12345, aborted: false}}]);
  h.at(1000000); // User pauses before submitting another prompt.
  h.input();
  h.start();
  h.at(1002000);
  h.settle();
  assert.equal(h.entries[1].data.durationMs, 2000);
  h.settle(); // No duplicate entry.
  assert.equal(h.entries.length, 2);
});

test('tool iterations, retries, compaction, approvals, and queued input share one timer', (t) => {
  const h = harness(t);
  h.input();
  h.start();
  for (let i = 1; i <= 3; i++) {
    h.at(i * 1000);
    h.emit('turn_start');
    h.emit('turn_end');
    h.emit('agent_end');
    h.emit('session_compact');
    h.emit('ui_prompt_start');
    h.input(); // Steering/follow-ups during the active run cannot reset it.
    h.emit('ui_prompt_end');
    h.emit('agent_start');
    assert.equal(h.entries.length, 0);
  }
  h.at(9000);
  h.settle();
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.durationMs, 9000);
});

test('interrupted and failed runs record elapsed time without claiming success', (t) => {
  const h = harness(t);
  h.input();
  h.start();
  h.at(8200);
  h.settle(true);
  assert.deepEqual(h.entries[0].data, {durationMs: 8200, aborted: true});
  assert.equal(h.render(h.entries[0]).render(30)[0].trim(), '8.2s · aborted');
  h.at(10000);
  h.input();
  h.start();
  h.emit('agent_end', {messages: [{role: 'assistant', stopReason: 'error'}]});
  h.at(11000);
  h.settle();
  assert.equal(h.render(h.entries[1]).render(30)[0].trim(), '1.0s');
});

test('ignored or rejected inputs do not produce entries or leak into the next prompt', (t) => {
  const h = harness(t);
  h.input();
  h.at(100000);
  h.settle();
  assert.deepEqual(h.entries, []);
  h.input();
  h.start();
  h.at(101000);
  h.settle();
  assert.equal(h.entries[0].data.durationMs, 1000);
});

test('custom-message runs and resumed continuations work without an input event', (t) => {
  const h = harness(t);
  h.input(); // An intercepted input must not time a later custom-message run.
  h.at(10000);
  h.start('custom');
  h.at(11000);
  h.settle();
  assert.equal(h.entries[0].data.durationMs, 1000);
  h.at(20000);
  h.emit('agent_start');
  h.at(22000);
  h.settle();
  assert.equal(h.entries[1].data.durationMs, 2000);
});

for (const event of ['session_start', 'session_shutdown', 'session_tree']) {
  test(`${event} clears timers instead of carrying them to another session/branch`, (t) => {
    const h = harness(t);
    h.input();
    h.start();
    h.emit(event);
    h.at(100000);
    h.settle();
    assert.deepEqual(h.entries, []);
    h.input();
    h.emit(event); // Also clear pending submission timestamps.
    h.at(200000);
    h.start();
    h.at(201000);
    h.settle();
    assert.equal(h.entries[0].data.durationMs, 1000);
  });
}

test('formats and right-aligns durations while respecting terminal width and theme changes', (t) => {
  const h = harness(t);
  const cases = [[0, '0.0s'], [12345, '12.3s'], [59949, '59.9s'], [59950, '1m 00s'], [123000, '2m 03s'], [3599999, '60m 00s']];
  for (const [durationMs, label] of cases) {
    let color = '\x1b[90m';
    const component = h.render({customType: 'duration', data: {durationMs, aborted: false}}, {
      fg(token, text) { assert.equal(token, 'dim'); return `${color}${text}\x1b[0m`; },
    });
    const [line] = component.render(40);
    assert.equal(line, `${' '.repeat(40 - label.length)}\x1b[90m${label}\x1b[0m`);
    for (const width of [0, 1, 2, 3, 5, 10, 80]) {
      const lines = component.render(width);
      assert.equal(lines.length, width === 0 ? 0 : 1);
      assert.ok(lines.every((value) => visibleWidth(value) === width));
    }
    color = '\x1b[37m';
    component.invalidate();
    assert.ok(component.render(40)[0].includes(color));
  }
});

test('malformed saved entries are hidden rather than breaking rendering', (t) => {
  const h = harness(t);
  for (const data of [undefined, null, {}, {durationMs: -1, aborted: false}, {durationMs: NaN, aborted: false}, {durationMs: Infinity, aborted: false}, {durationMs: '12', aborted: false}, {durationMs: 12}]) {
    assert.equal(h.render({customType: 'duration', data}), undefined);
  }
});

test('duration entries survive disk reopening and follow branches without entering model context', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-duration-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const session = SessionManager.create(dir, dir);
  session.appendMessage({role: 'user', content: 'hello', timestamp: Date.now()});
  const answerId = session.appendMessage({
    role: 'assistant', content: [{type: 'text', text: 'hello back'}],
    api: 'openai-responses', provider: 'openai', model: 'test',
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    stopReason: 'stop', timestamp: Date.now(),
  });
  const h = harness(t, session);
  h.input();
  h.start();
  h.at(123000);
  h.settle();
  const reopened = SessionManager.open(session.getSessionFile());
  const entry = reopened.getBranch().at(-1);
  assert.equal(entry.customType, 'duration');
  // A fresh extension instance renders entirely from saved data.
  const fresh = harness(t);
  assert.equal(fresh.render(entry).render(20)[0], '2m 03s'.padStart(20));
  assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ['user', 'assistant']);
  reopened.branch(answerId);
  assert.ok(reopened.getBranch().every((entry) => entry.customType !== 'duration'));
});
