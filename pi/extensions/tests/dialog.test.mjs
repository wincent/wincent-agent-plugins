import {strict as assert} from 'node:assert';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {piPackageImports} from './pi-package.mjs';

const packages = piPackageImports(['@earendil-works/pi-ai/compat', 'typebox']);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/dialog.js')) {
      // Each feature gets a separate helper module, like Pi's extension caches.
      specifier = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
        + '?caller=' + encodeURIComponent(context.parentURL);
    } else if (context.parentURL?.startsWith(new URL('../', import.meta.url).href) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      specifier = specifier.replace(/\.js$/, '.ts');
    }
    return packages.resolve(specifier, context, nextResolve);
  },
});
let registerMcpPermissionGate, ocr, handleAsk, queueDialog, cancelTask, installMainRoutingFor;
try {
  ({registerMcpPermissionGate} = await import('../lib/mcp.ts'));
  ({default: ocr} = await import('../ocr/index.ts'));
  ({handleAsk} = await import('../subagent/main/ask.ts'));
  ({queueDialog} = await import('../lib/dialog.ts?caller=test'));
  ({cancelTask} = await import('../subagent/main/lifecycle.ts'));
  ({installMainRoutingFor} = await import('../subagent/main/routing.ts'));
} finally {
  hooks.deregister();
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const dialogs = [], answers = [], subscribers = new Set(), closed = new Set();
  const ui = {
    confirm: (title, message, options) => open(title, options),
    input: (title, placeholder, options) => open(title, options),
    notify() {}, setStatus() {}, theme: {fg: (_color, text) => text},
  };
  function open(title, options) {
    const deferred = Promise.withResolvers();
    dialogs.push({title, options, ...deferred});
    return deferred.promise;
  }
  const ctx = {hasUI: true, ui};
  let gate, approval;
  registerMcpPermissionGate({on: (_event, handler) => gate = handler, getAllTools: () => []}, {
    server: 'test', label: 'Test', isWriteTool: () => true,
  });
  ocr({on() {}, events: {on() {}}, registerTool() {}, registerCommand(name, command) {
    if (name === 'ocr-approval') approval = command;
  }});
  const task = {
    taskId: 'task', agentName: 'helper', mode: 'background', cleanup: [],
    llmAnswersSinceEscalation: 0, llmAnswersTotal: 0,
    bus: {
      emit: (...args) => answers.push(args),
      subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
      onPeerClose(fn) { closed.add(fn); return () => closed.delete(fn); },
    },
  };
  const pi = {events: {emit() {}}};
  return {
    ctx, task, dialogs, answers, subscribers, closed, pi,
    mcp: () => gate({toolName: 'mcp__test__write', input: {}}, ctx),
    ocr: mode => approval.handler(mode ?? 'session', ctx),
    ask: (extra = {}) => handleAsk({pi, ctx, task, askId: 'ask', question: 'Why?', policy: 'human', ...extra}),
  };
}

test('MCP, OCR, human asks and separate module caches share one UI queue', async () => {
  const f = fixture();
  const calls = [f.mcp(), f.ocr(), f.ask(), queueDialog(f.ctx.ui, () => f.ctx.ui.confirm('direct'))];
  for (const [index, title, answer] of [
    [0, /Test write/, false], [1, /Allow OCR/, true],
    [2, /Subagent helper asks/, 'because'], [3, /direct/, false],
  ]) {
    await tick();
    assert.equal(f.dialogs.length, index + 1);
    assert.match(f.dialogs[index].title, title);
    f.dialogs[index].resolve(answer);
    await calls[index];
  }
  assert.equal(f.answers[0][1].text, 'because');
});

test('MCP captures the original signal and aborted queued calls return without prompting', async () => {
  const f = fixture(), hold = Promise.withResolvers();
  const first = queueDialog(f.ctx.ui, () => hold.promise);
  const controller = new AbortController();
  let signal = controller.signal, reads = 0;
  Object.defineProperty(f.ctx, 'signal', {get() { reads++; return signal; }});
  const pending = f.mcp();
  signal = new AbortController().signal;
  controller.abort();
  assert.equal((await pending).block, true);
  assert.equal(reads, 1);
  hold.resolve();
  await first;
  await tick();
  assert.equal(f.dialogs.length, 0);
  assert.equal((await (async () => {
    const next = f.mcp(); await tick(); f.dialogs[0].resolve(true); return next;
  })()), undefined);
});

test('MCP forwards cancellation and rejects late approval without releasing an occupied slot', async () => {
  const f = fixture(), controller = new AbortController();
  f.ctx.signal = controller.signal;
  const call = f.mcp();
  await tick();
  assert.equal(f.dialogs[0].options.signal, controller.signal);
  controller.abort();
  assert.equal((await call).block, true);
  const next = queueDialog(f.ctx.ui, async () => 'next');
  let advanced = false;
  void next.then(() => advanced = true);
  await tick();
  assert.equal(advanced, false);
  f.dialogs[0].resolve(true);
  assert.equal(await next, 'next');
});

test('MCP fails closed if the UI aborts just before returning true; pre-aborted calls never open', async () => {
  const f = fixture(), controller = new AbortController();
  f.ctx.signal = controller.signal;
  f.ctx.ui.confirm = async () => { controller.abort(); return true; };
  assert.equal((await f.mcp()).block, true);
  f.ctx.ui.confirm = () => assert.fail('pre-aborted prompt');
  assert.equal((await f.mcp()).block, true);
});

test('queued OCR cancellation or revocation cannot grant session approval or open a stale dialog', async () => {
  for (const action of ['abort', 'revoke']) {
    const f = fixture(), hold = Promise.withResolvers(), controller = new AbortController();
    f.ctx.signal = controller.signal;
    const first = queueDialog(f.ctx.ui, () => hold.promise);
    const pending = f.ocr();
    if (action === 'abort') controller.abort();
    else await f.ocr('revoke');
    hold.resolve();
    await Promise.all([first, pending]);
    assert.equal(f.dialogs.length, 0);
  }
});

test('ask deadlines expire in the queue and dismiss active dialogs without sending stale answers', async () => {
  for (const queued of [true, false]) {
    const f = fixture(), hold = Promise.withResolvers();
    const first = queued ? queueDialog(f.ctx.ui, () => hold.promise) : Promise.resolve();
    f.ctx.ui.input = (_title, _hint, {signal}) => new Promise(resolve => {
      f.dialogs.push({signal});
      signal.addEventListener('abort', () => resolve('late answer'), {once: true});
    });
    await f.ask({deadline: Date.now() + 20});
    assert.equal(f.dialogs.length, queued ? 0 : 1);
    assert.equal(f.answers.length, 0);
    assert.equal(f.task.cleanup.length, 0);
    assert.equal(f.subscribers.size, 0);
    assert.equal(f.closed.size, 0);
    hold.resolve();
    await first;
    await tick();
    assert.equal(f.dialogs.length, queued ? 0 : 1);
    assert.equal(await queueDialog(f.ctx.ui, async () => 'next'), 'next');
  }
});

test('task cancellation, done, peer-close and owner cleanup dismiss asks', async () => {
  for (const reason of ['cancel', 'done', 'close', 'cleanup']) {
    const f = fixture();
    f.ctx.ui.input = (_title, _hint, {signal}) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(undefined), {once: true});
    });
    const pending = f.ask();
    await tick();
    if (reason === 'cancel') {
      // A finished fake process needs no real process operations.
      f.task.process = {exited: Promise.resolve({code: 0}), isGroupAlive: () => false};
      await cancelTask(f.task, {reason: 'test', graceMs: 0});
    } else if (reason === 'done') {
      for (const fn of f.subscribers) fn({from: 'sub', type: 'done'});
    } else if (reason === 'close') {
      for (const fn of f.closed) fn();
    } else {
      for (const fn of [...f.task.cleanup]) fn();
    }
    await pending;
    assert.equal(f.answers.filter(([type]) => type === 'answer').length, 0);
    assert.equal(await queueDialog(f.ctx.ui, async () => true), true);
  }
});

test('sync asks capture turn cancellation while background asks outlive the current turn', async () => {
  for (const mode of ['sync', 'background']) {
    const f = fixture(), controller = new AbortController();
    f.task.mode = mode;
    f.ctx.signal = controller.signal;
    const pending = f.ask();
    await tick();
    f.ctx.signal = new AbortController().signal;
    controller.abort();
    if (mode === 'sync') {
      await pending;
      assert.equal(f.dialogs[0].options.signal.aborted, true);
      f.dialogs[0].resolve('too late');
      assert.equal(f.answers.length, 0);
    } else {
      assert.equal(f.dialogs[0].options.signal.aborted, false);
      f.dialogs[0].resolve('still wanted');
      await pending;
      assert.equal(f.answers[0][1].text, 'still wanted');
    }
  }
});

test('background routing accounts for ask time already spent in transit', async () => {
  const f = fixture();
  installMainRoutingFor(f.task, {pi: f.pi, getCtx: () => f.ctx});
  for (const fn of [...f.subscribers]) fn({from: 'sub', type: 'ask', id: 'old', ts: new Date(Date.now() - 2000).toISOString(), payload: {question: 'expired', timeoutMs: 1000}});
  await tick();
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.answers.length, 0);
});
