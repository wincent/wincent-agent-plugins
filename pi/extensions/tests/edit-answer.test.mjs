// Run: node --experimental-transform-types --test pi/extensions/tests/edit-answer.test.mjs
import {strict as assert} from 'node:assert';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {piPackageImports} from './pi-package.mjs';

const packages = piPackageImports(['@earendil-works/pi-coding-agent']);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/dialog.js')) specifier = specifier.replace(/\.js$/, '.ts');
    return packages.resolve(specifier, context, nextResolve);
  },
});
const {queueDialog} = await import('../lib/dialog.ts');
let extension;
try {
  ({default: extension} = await import('../edit-answer.ts'));
} finally {
  hooks.deregister();
}

function env(t, name, value) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

function harness(options = {}) {
  let handler;
  extension({registerCommand(name, command) {
    assert.equal(name, 'edit-answer');
    handler = command.handler;
  }});
  const events = [];
  const notifications = [];
  let draft = 'existing draft';
  const ctx = {
    mode: 'tui', hasUI: true, cwd: process.cwd(),
    waitForIdle: async () => events.push('idle'),
    sessionManager: {getBranch: () => ['older answer', 'latest answer'].map((text, index) => ({
      type: 'message', id: String(index), timestamp: new Date().toISOString(),
      message: {role: 'assistant', content: [{type: 'text', text}]},
    }))},
    ui: {
      notify: (message, level) => notifications.push({message, level}),
      setEditorText(text) { events.push('set'); draft = text; },
      async select(_title, labels) { events.push('select'); return options.cancel ? undefined : labels[1]; },
      custom(factory) {
        events.push('custom');
        return new Promise((resolve, reject) => {
          Promise.resolve(factory({
            stop: () => events.push('stop'),
            start: () => events.push('start'),
            requestRender: (force) => { assert.equal(force, true); events.push('render'); },
          }, {}, {}, (result) => { events.push('done'); resolve(result); })).catch(reject);
        });
      },
    },
  };
  return {ctx, events, notifications, run: (args = '') => handler(args, ctx), get draft() { return draft; }};
}

function mockSpawn(t, callback) {
  const mocked = t.mock.method(childProcess, 'spawn', callback);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

for (const args of ['', 'pick', '--pick']) {
  test(`edits ${args || 'latest'} with terminal handoff and cleanup`, async (t) => {
    env(t, 'EDITOR', 'emacs -nw');
    const h = harness();
    let file;
    mockSpawn(t, (_shell, argv, options) => {
      h.events.push('spawn');
      assert.equal(h.events.at(-2), 'stop');
      assert.equal(options.stdio, 'inherit');
      assert.equal(options.cwd, h.ctx.cwd);
      assert.equal(argv.at(-3), 'emacs -nw "$1"');
      assert.equal(argv.at(-2), 'pi-edit-answer');
      file = argv.at(-1);
      assert.equal(readFileSync(file, 'utf8'), `${args ? 'older' : 'latest'} answer\n`);
      writeFileSync(file, 'edited answer\n');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    });
    await h.run(args);
    assert.equal(h.draft, 'edited answer\n');
    assert.deepEqual(h.events.slice(-6), ['stop', 'spawn', 'start', 'render', 'done', 'set']);
    assert.deepEqual(h.notifications, []);
    assert.equal(existsSync(dirname(file)), false);
  });
}

for (const failure of ['nonzero', 'signal', 'error', 'throw', 'read']) {
  test(`restores terminal and preserves draft on ${failure} failure`, async (t) => {
    env(t, 'EDITOR', 'fake-editor');
    const h = harness();
    let file;
    mockSpawn(t, (_shell, argv) => {
      file = argv.at(-1);
      if (failure === 'throw') throw new Error('spawn threw');
      const child = new EventEmitter();
      setImmediate(() => {
        if (failure === 'read') rmSync(file);
        else writeFileSync(file, 'must not replace draft');
        if (failure === 'error') child.emit('error', new Error('ENOENT'));
        child.emit('close', failure === 'nonzero' ? 7 : failure === 'signal' ? null : 0, failure === 'signal' ? 'SIGTERM' : null);
      });
      return child;
    });
    await h.run();
    assert.equal(h.draft, 'existing draft');
    assert.ok(h.events.indexOf('start') > h.events.indexOf('stop'));
    assert.equal(h.events.filter((event) => event === 'start').length, 1);
    assert.ok(h.events.includes('render'));
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].level, 'error');
    assert.match(h.notifications[0].message, /status 7|signal|ENOENT|spawn threw/);
    assert.equal(existsSync(dirname(file)), false);
  });
}

test('empty edits are accepted and an unset EDITOR defaults to vim', async (t) => {
  env(t, 'EDITOR', undefined);
  const h = harness();
  mockSpawn(t, (_shell, argv) => {
    assert.equal(argv.at(-3), 'vim "$1"');
    writeFileSync(argv.at(-1), '');
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  await h.run();
  assert.equal(h.draft, '');
});

test('non-TUI modes never wait, select, or spawn (including RPC with UI)', async (t) => {
  mockSpawn(t, () => assert.fail('must not spawn'));
  for (const mode of ['rpc', 'json', 'print']) {
    for (const args of ['', 'pick']) {
      const h = harness();
      h.ctx.mode = mode;
      h.ctx.hasUI = mode === 'rpc';
      await h.run(args);
      assert.deepEqual(h.events, []);
      assert.equal(h.draft, 'existing draft');
      assert.equal(h.notifications.length, mode === 'rpc' ? 1 : 0);
    }
  }
});

test('editor and picker share the dialog queue with other extensions', async (t) => {
  env(t, 'EDITOR', 'fake-editor');
  let child;
  mockSpawn(t, () => child = new EventEmitter());
  for (const args of ['', 'pick']) {
    const h = harness();
    const hold = Promise.withResolvers();
    const first = queueDialog(h.ctx.ui, () => hold.promise);
    child = undefined;
    const editing = h.run(args);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.events, ['idle']);
    hold.resolve();
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(child);
    let nextOpened = false;
    const next = queueDialog(h.ctx.ui, async () => { nextOpened = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nextOpened, false);
    child.emit('close', 0);
    await Promise.all([editing, next]);
    assert.equal(nextOpened, true);
  }
});

test('a queued custom modal cannot restore the pre-edit draft', async (t) => {
  env(t, 'EDITOR', 'fake-editor');
  const h = harness();
  let child;
  mockSpawn(t, (_shell, argv) => {
    writeFileSync(argv.at(-1), 'edited answer');
    return child = new EventEmitter();
  });
  const editing = h.run();
  await new Promise(resolve => setImmediate(resolve));
  const closed = Promise.withResolvers();
  let savedDraft;
  const modal = queueDialog(h.ctx.ui, async () => {
    // Pi's showExtensionCustom snapshots the draft on entry and restores it
    // on close, which must happen after edit-answer publishes its result.
    savedDraft = h.draft;
    await closed.promise;
    h.ctx.ui.setEditorText(savedDraft);
  });
  child.emit('close', 0);
  await editing;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(savedDraft, 'edited answer');
  closed.resolve();
  await modal;
  assert.equal(h.draft, 'edited answer');
});

test('picker cancellation does not open an editor', async (t) => {
  mockSpawn(t, () => assert.fail('must not spawn'));
  const h = harness({cancel: true});
  await h.run('pick');
  assert.deepEqual(h.events, ['idle', 'select']);
});

test('real non-interactive editor preserves command quoting and treats hostile temp paths as data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'edit-answer-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  // If interpolated as shell source, these substitutions would create a marker.
  const marker = `edit-answer-injection-${process.pid}`;
  const temp = join(root, `space ' \" ; $(touch ${marker}) \`touch ${marker}\` $HOME`);
  mkdirSync(temp);
  env(t, 'TMPDIR', temp);
  const script = join(root, 'fake editor.mjs');
  writeFileSync(script, `import {readFileSync, writeFileSync} from 'node:fs';
const file = process.argv.at(-1);
writeFileSync(file, JSON.stringify({args: process.argv.slice(2, -1), seed: readFileSync(file, 'utf8'), file}));\n`);
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  env(t, 'EDITOR', `${quote(process.execPath)} ${quote(script)} -nw "two words" 'single quoted' escaped\\ space '' '$HOME' trailing\\ `);
  const h = harness();
  await h.run();
  assert.deepEqual(h.notifications, []);
  const result = JSON.parse(h.draft);
  assert.deepEqual(result.args, ['-nw', 'two words', 'single quoted', 'escaped space', '', '$HOME', 'trailing ']);
  assert.equal(result.seed, 'latest answer\n');
  assert.ok(result.file.startsWith(temp));
  assert.equal(existsSync(join(process.cwd(), marker)), false);
  assert.equal(existsSync(dirname(result.file)), false);
});
