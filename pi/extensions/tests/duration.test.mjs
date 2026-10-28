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

function harness(t, session, options = {}) {
  let now = 0;
  let idle = true;
  let editor;
  let factory = options.existingFactory;
  const events = new Map();
  const renderers = new Map();
  const entries = [];
  let branch = entries;
  const timers = new Map();
  const scheduled = [];
  const repaints = [];
  const tui = {terminal: {rows: 24}, requestRender: () => repaints.push(now)};
  const theme = {fg: (_color, text) => text};
  const ctx = {
    mode: options.mode ?? 'print',
    isIdle: () => idle,
    sessionManager: {getBranch: () => session?.getBranch() ?? branch},
    ui: {
      theme,
      getEditorComponent: () => factory,
      setEditorComponent(value) {
        const draft = editor?.getText?.() ?? '';
        factory = value;
        editor = factory?.(tui, {borderColor: (text) => text, selectList: {}}, {
          matches: (data, action) => action === 'app.interrupt' && data === '\x1b',
        });
        editor?.setText?.(draft);
      },
    },
  };
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const handle = {unrefCalled: false, unref() { this.unrefCalled = true; }};
    timers.set(handle, {callback, due: now + delay});
    scheduled.push({delay, handle});
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => timers.delete(handle));
  extension({
    on(name, handler) { events.set(name, handler); },
    appendEntry(customType, data) {
      entries.push({type: 'custom', customType, data});
      session?.appendCustomEntry(customType, data);
    },
    registerEntryRenderer(name, renderer) { renderers.set(name, renderer); },
  });
  events.get('session_start')({type: 'session_start', reason: 'startup'}, ctx);
  return {
    ctx, entries, timers, scheduled, repaints,
    get editor() { return editor; },
    setBranch(value) { branch = value; },
    at(time) { now = time; },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > target) break;
        timers.delete(next[0]);
        now = next[1].due;
        next[1].callback();
      }
      now = target;
    },
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
      return renderers.get(entry.customType)?.(entry, {expanded: false}, theme);
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

test('live border refreshes every 100 ms until 10 seconds, then once per second', (t) => {
  const h = harness(t, undefined, {mode: 'tui'});
  assert.equal(h.editor.render(60)[0], '─'.repeat(60));
  h.input();
  assert.equal(h.timers.size, 0);
  h.start();
  assert.match(h.editor.render(60)[0], / 0\.0s ─$/);
  assert.equal(h.scheduled.at(-1).delay, 100);
  h.advance(9900);
  assert.match(h.editor.render(60)[0], / 9\.9s ─$/);
  assert.ok(h.scheduled.every(({delay}) => delay === 100));
  h.advance(100);
  assert.match(h.editor.render(60)[0], / 10s ─$/);
  assert.equal(h.scheduled.at(-1).delay, 1000);
  const repaints = h.repaints.length;
  h.advance(999);
  // Other UI redraws (e.g. typing or a spinner) must not advance the label.
  assert.equal(h.repaints.length, repaints);
  assert.match(h.editor.render(60)[0], / 10s ─$/);
  h.advance(1);
  assert.match(h.editor.render(60)[0], / 11s ─$/);
  h.advance(49000);
  assert.match(h.editor.render(60)[0], / 1m 00s ─$/);
  assert.equal(h.timers.size, 1);
  assert.ok(h.scheduled.every(({handle}) => handle.unrefCalled));
  assert.deepEqual(h.entries, []); // Intermediate ticks never reach the session.
  h.settle();
  assert.equal(h.timers.size, 0);
});

test('freezes the precise final duration and promotes it only when another run starts', (t) => {
  const h = harness(t, undefined, {mode: 'tui'});
  h.input();
  h.at(2300); // Preparation time is included; ticks align to elapsed time.
  h.start();
  assert.match(h.editor.render(60)[0], / 2\.3s ─$/);
  h.at(12345);
  h.settle();
  assert.equal(h.timers.size, 0);
  assert.match(h.editor.render(60)[0], / 12\.3s ─$/);
  assert.deepEqual(h.entries, [{type: 'custom', customType: 'duration-pending', data: {durationMs: 12345, aborted: false}}]);
  assert.equal(h.render(h.entries[0]), undefined); // No component or spacer.
  h.advance(100000);
  assert.match(h.editor.render(60)[0], / 12\.3s ─$/);
  h.input(); // Input interception, slash commands, and draft edits don't promote.
  assert.equal(h.entries.length, 1);
  h.start();
  assert.deepEqual(h.entries[1], {type: 'custom', customType: 'duration', data: {durationMs: 12345, aborted: false}});
  assert.equal(h.render(h.entries[1]).render(60)[0].trim(), '12.3s');
  assert.match(h.editor.render(60)[0], / 0\.0s ─$/);
  h.emit('agent_start'); // Retries don't duplicate history or schedule timers.
  h.emit('agent_end');
  assert.equal(h.timers.size, 1);
  assert.equal(h.entries.length, 2);
  h.advance(1000);
  h.settle();
  assert.equal(h.entries.length, 3);
  assert.equal(h.entries[2].customType, 'duration-pending');
  assert.equal(h.entries[2].data.durationMs, 1000);
  h.settle();
  assert.equal(h.entries.length, 3);
});

test('aborted runs freeze with an aborted marker, then promote normally', (t) => {
  const h = harness(t, undefined, {mode: 'tui'});
  h.input();
  h.start();
  h.advance(8200);
  h.settle(true);
  assert.equal(h.timers.size, 0);
  assert.match(h.editor.render(60)[0], / 8\.2s · aborted ─$/);
  h.start('custom');
  assert.equal(h.render(h.entries[1]).render(60)[0].trim(), '8.2s · aborted');
  h.settle();
});

test('editor decoration preserves draft, submit, interrupt, cursor, and status/scroll indicators', (t) => {
  const h = harness(t, undefined, {mode: 'tui'});
  h.start();
  h.advance(1200);
  const editor = h.editor;
  editor.focused = true;
  editor.handleInput('hello');
  assert.equal(editor.getText(), 'hello');
  let submitted;
  editor.onSubmit = (text) => submitted = text;
  editor.handleInput('\r');
  assert.equal(submitted, 'hello');
  let interrupted = false;
  editor.onEscape = () => interrupted = true;
  editor.handleInput('\x1b');
  assert.equal(interrupted, true);
  editor.setText(Array.from({length: 30}, (_, i) => `line ${i} 🌈`).join('\n'));
  const draft = editor.getText();
  editor.setWorkingStatusIndicator({
    renderInBorder: (width) => 'Working'.slice(0, width),
    renderSpinnerInBorder: () => '*',
  });
  const lines = editor.render(120);
  assert.match(lines[0], /Working/);
  assert.match(lines[0], /↑ \d+ more/);
  assert.match(lines[0], / 1\.2s ─$/);
  // Render the real editor, including its cursor and wide input characters.
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  for (const width of [0, 1, 5, 10, 15, 30, 60]) {
    assert.equal(visibleWidth(editor.renderTopBorder(width, 25)), width);
  }
  assert.ok(!editor.renderTopBorder(10, 25).includes('1.2s'));
  assert.equal(editor.getText(), draft);
  h.ctx.ui.theme = {fg: (token, text) => { assert.equal(token, 'dim'); return `\x1b[90m${text}\x1b[0m`; }};
  editor.invalidate();
  assert.ok(editor.render(120)[0].includes('\x1b[90m1.2s\x1b[0m'));
  h.settle();
});

test('reopening restores the frozen pending duration and promotes it exactly once', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-duration-border-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const session = SessionManager.create(dir, dir);
  session.appendMessage({role: 'user', content: 'hello', timestamp: Date.now()});
  session.appendMessage({
    role: 'assistant', content: [{type: 'text', text: 'hello back'}],
    api: 'openai-responses', provider: 'openai', model: 'test',
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    stopReason: 'stop', timestamp: Date.now(),
  });
  const h = harness(t, session, {mode: 'tui'});
  h.start();
  h.at(123000);
  h.settle();
  h.emit('session_shutdown');
  const reopened = SessionManager.open(session.getSessionFile());
  const pendingId = reopened.getLeafId();
  const fresh = harness(t, reopened, {mode: 'tui'});
  assert.match(fresh.editor.render(60)[0], / 2m 03s ─$/);
  assert.equal(fresh.timers.size, 0);
  assert.deepEqual(fresh.entries, []); // Reloading does not mutate history.
  fresh.emit('session_start', {reason: 'reload'});
  assert.match(fresh.editor.render(60)[0], / 2m 03s ─$/);
  fresh.start();
  assert.equal(fresh.entries.length, 1);
  assert.equal(fresh.entries[0].customType, 'duration');
  const promotedId = reopened.getLeafId();
  assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ['user', 'assistant']);
  fresh.emit('session_shutdown');
  fresh.emit('session_start', {reason: 'reload'});
  assert.equal(fresh.editor.render(60)[0], '─'.repeat(60));
  assert.equal(fresh.timers.size, 0);
  // Navigating to the pending entry restores its frozen value; navigating
  // forward to its visible copy clears it, without appending duplicates.
  reopened.branch(pendingId);
  fresh.emit('session_tree');
  assert.match(fresh.editor.render(60)[0], / 2m 03s ─$/);
  reopened.branch(promotedId);
  fresh.emit('session_tree');
  assert.equal(fresh.editor.render(60)[0], '─'.repeat(60));
  assert.equal(fresh.entries.length, 1);
});

for (const event of ['session_start', 'session_shutdown', 'session_tree']) {
  test(`${event} cancels live refreshes and discards unfinished timing`, (t) => {
    const h = harness(t, undefined, {mode: 'tui'});
    h.start();
    h.advance(200);
    assert.equal(h.timers.size, 1);
    h.emit(event);
    assert.equal(h.timers.size, 0);
    const repaints = h.repaints.length;
    h.advance(10000);
    assert.equal(h.repaints.length, repaints);
    h.settle();
    assert.deepEqual(h.entries, []);
  });
}

test('legacy transcript durations and malformed pending data do not appear in the editor', (t) => {
  const h = harness(t, undefined, {mode: 'tui'});
  h.setBranch([{type: 'custom', customType: 'duration', data: {durationMs: 3000, aborted: false}}]);
  h.emit('session_tree');
  assert.equal(h.editor.render(60)[0], '─'.repeat(60));
  assert.ok(h.render(h.ctx.sessionManager.getBranch()[0]));
  h.setBranch([{type: 'custom', customType: 'duration-pending', data: {durationMs: 'oops', aborted: false}}]);
  h.emit('session_tree');
  assert.equal(h.editor.render(60)[0], '─'.repeat(60));
});

test('reload restores prompt-history navigation in the replacement editor', (t) => {
  const h = harness(t, undefined, {mode: 'tui'});
  h.setBranch([
    {type: 'message', message: {role: 'user', content: 'first prompt'}},
    {type: 'message', message: {role: 'assistant', content: [{type: 'text', text: 'answer'}]}},
    {type: 'message', message: {role: 'user', content: [{type: 'text', text: 'second prompt'}, {type: 'image', data: 'ignored'}]}},
  ]);
  h.editor.addToHistory('first prompt'); // As Pi does on initial load/submission.
  h.editor.addToHistory('second prompt');
  h.editor.handleInput('\x1b[A');
  assert.equal(h.editor.getText(), 'second prompt');
  h.editor.setText('');
  // Match Pi's /reload ordering: reset UI, shut down the old runtime, then
  // create a fresh editor. Transcript rebuilding doesn't populate history.
  h.ctx.ui.setEditorComponent(undefined);
  h.emit('session_shutdown');
  h.emit('session_start', {reason: 'reload'});
  h.editor.handleInput('\x1b[A');
  assert.equal(h.editor.getText(), 'second prompt');
  h.editor.handleInput('\x1b[A');
  assert.equal(h.editor.getText(), 'first prompt');
  h.editor.handleInput('\x1b[B');
  assert.equal(h.editor.getText(), 'second prompt');
});

test('long badges yield to scroll and working indicators on narrow borders', (t) => {
  const h = harness(t, undefined, {mode: 'tui'});
  h.start();
  h.advance(8200);
  h.settle(true);
  let border = h.editor.renderTopBorder(28, 25);
  assert.match(border, /↑ 25 more/);
  assert.ok(!border.includes('aborted'));
  h.editor.setWorkingStatusIndicator({
    renderInBorder: (width) => 'Working'.slice(0, width),
    renderSpinnerInBorder: () => '*',
  });
  border = h.editor.renderTopBorder(30, 25);
  assert.match(border, /↑ 25 more/);
  assert.ok(!border.includes('aborted'));
  const wide = h.editor.renderTopBorder(100, 25);
  assert.match(wide, /Working/);
  assert.match(wide, /↑ 25 more/);
  assert.match(wide, /8\.2s · aborted/);
  assert.equal(visibleWidth(border), 30);
  assert.equal(visibleWidth(wide), 100);
});

test('non-TUI modes and another extension editor retain transcript-only behavior', (t) => {
  for (const mode of ['print', 'json', 'rpc', 'tui']) {
    const existingFactory = () => ({getText: () => ''});
    const h = harness(t, undefined, {mode, existingFactory});
    h.start();
    h.at(1200);
    h.settle();
    assert.equal(h.scheduled.length, 0);
    assert.equal(h.ctx.ui.getEditorComponent(), existingFactory);
    assert.equal(h.entries[0].customType, 'duration');
    assert.ok(h.render(h.entries[0]));
    h.emit('session_shutdown');
    assert.equal(h.ctx.ui.getEditorComponent(), existingFactory);
  }
});

test('a later editor replacement stops refreshes and is not undone on shutdown', (t) => {
  const h = harness(t, undefined, {mode: 'tui'});
  h.start();
  const other = () => ({getText: () => ''});
  h.ctx.ui.setEditorComponent(other);
  h.advance(100);
  assert.equal(h.timers.size, 0);
  h.settle();
  assert.equal(h.entries[0].customType, 'duration');
  h.emit('session_shutdown');
  assert.equal(h.ctx.ui.getEditorComponent(), other);
});
