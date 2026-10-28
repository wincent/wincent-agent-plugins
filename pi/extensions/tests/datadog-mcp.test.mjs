import {strict as assert} from 'node:assert';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {piPackageImports} from './pi-package.mjs';

const packages = piPackageImports([
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  'typebox',
  'typebox/value',
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/dialog.js')) specifier = specifier.replace(/\.js$/, '.ts');
    if (specifier === './lib/mcp.js' && context.parentURL === new URL('../datadog-mcp.ts', import.meta.url).href) {
      specifier = './lib/mcp.ts';
    }
    return packages.resolve(specifier, context, nextResolve);
  },
});
let extension;
try {
  ({default: extension} = await import('../datadog-mcp.ts'));
} finally {
  hooks.deregister();
}

function setup({name = 'mcp__datadog__create_dashboard', annotations, known = true, hasUI = true, confirm = async () => false} = {}) {
  let handler;
  const dialogs = [];
  extension({
    on(event, callback) {
      assert.equal(event, 'tool_call');
      handler = callback;
    },
    getAllTools: () => known ? [{name, annotations}] : [],
  });
  const ctx = {hasUI, ui: {confirm: async (...args) => {
    dialogs.push(args);
    return confirm(...args);
  }}};
  return {
    dialogs,
    call: (extra = {}) => handler({toolName: name, input: {title: 'test'}, ...extra}, ctx),
  };
}

test('other servers and legacy tools are not intercepted', async () => {
  for (const name of ['datadog', 'mcp__slack__postMessage', 'mcp__datadog_other__create_dashboard']) {
    const gate = setup({name});
    assert.equal(await gate.call(), undefined);
    assert.equal(gate.dialogs.length, 0);
  }
});

test('explicitly read-only Datadog tools need no UI', async () => {
  const gate = setup({name: 'mcp__datadog__get_monitors', annotations: {readOnlyHint: true}, hasUI: false});
  assert.equal(await gate.call(), undefined);
  assert.equal(gate.dialogs.length, 0);
});

test('missing metadata and conflicting hints fail closed', async () => {
  for (const options of [
    {name: 'mcp__datadog__get_monitors'},
    {name: 'mcp__datadog__get_monitors', annotations: {readOnlyHint: true}, known: false},
    {annotations: {readOnlyHint: true}},
    {name: 'mcp__datadog__get_monitors', annotations: {readOnlyHint: true, destructiveHint: true}},
  ]) {
    const gate = setup({...options, hasUI: false});
    assert.equal((await gate.call()).block, true);
    assert.equal(gate.dialogs.length, 0);
  }
});

test('mutation verbs in the live catalog override misleading read-only hints', async () => {
  for (const verb of ['assign', 'detach', 'manage', 'mitigate', 'override', 'publish', 'recover', 'reorder', 'retry', 'swap', 'unblock', 'unpublish', 'upsert']) {
    const gate = setup({name: `mcp__datadog__${verb}_resource`, annotations: {readOnlyHint: true}, hasUI: false});
    assert.equal((await gate.call()).block, true, verb);
  }
});

test('approval is per call, including nested codemode calls', async () => {
  const gate = setup({confirm: async () => true});
  assert.equal(await gate.call(), undefined);
  assert.equal(await gate.call({parentToolCallId: 'codemode-1'}), undefined);
  assert.equal(gate.dialogs.length, 2);
  assert.match(gate.dialogs[0][1], /mcp__datadog__create_dashboard/);
  assert.match(gate.dialogs[0][1], /"title": "test"/);
});

test('denial and unavailable confirmation both block', async () => {
  for (const confirm of [async () => false, async () => { throw new Error('UI unavailable'); }]) {
    const gate = setup({confirm});
    assert.equal((await gate.call()).block, true);
    assert.equal((await gate.call()).block, true);
    assert.equal(gate.dialogs.length, 2);
  }
});

test('parallel calls queue distinct dialogs without reusing approval', async () => {
  const first = Promise.withResolvers();
  let count = 0;
  const gate = setup({confirm: () => ++count === 1 ? first.promise : false});
  const one = gate.call();
  const two = gate.call();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 1);
  first.resolve(true);
  assert.equal(await one, undefined);
  assert.equal((await two).block, true);
  assert.equal(count, 2);
});
