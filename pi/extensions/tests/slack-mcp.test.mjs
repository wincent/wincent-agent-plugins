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
    if (specifier === './lib/mcp.js' && context.parentURL === new URL('../slack-mcp.ts', import.meta.url).href) {
      specifier = './lib/mcp.ts';
    }
    return packages.resolve(specifier, context, nextResolve);
  },
});
let extension;
try {
  ({default: extension} = await import('../slack-mcp.ts'));
} finally {
  hooks.deregister();
}

function setup({name = 'mcp__slack__slack_send_message', annotations, known = true, hasUI = true, confirm = async () => false} = {}) {
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
  for (const name of ['slack', 'mcp__other__postMessage', 'mcp__slack_other__slack_send_message']) {
    const gate = setup({name});
    assert.equal(await gate.call(), undefined);
    assert.equal(gate.dialogs.length, 0);
  }
});

test('explicitly read-only Slack tools need no UI', async () => {
  const gate = setup({name: 'mcp__slack__slack_search_messages', annotations: {readOnlyHint: true}, hasUI: false});
  assert.equal(await gate.call(), undefined);
  assert.equal(gate.dialogs.length, 0);
});

test('missing metadata and conflicting hints fail closed', async () => {
  for (const options of [
    {name: 'mcp__slack__slack_search_messages'},
    {name: 'mcp__slack__slack_search_messages', annotations: {readOnlyHint: true}, known: false},
    {annotations: {readOnlyHint: true}},
    {name: 'mcp__slack__slack_search_messages', annotations: {readOnlyHint: true, destructiveHint: true}},
  ]) {
    const gate = setup({...options, hasUI: false});
    assert.equal((await gate.call()).block, true);
    assert.equal(gate.dialogs.length, 0);
  }
});

test('mutation verbs override misleading read-only hints', async () => {
  for (const verb of ['draft', 'invite', 'join', 'leave', 'revoke', 'unarchive', 'upload', 'complete', 'send', 'schedule', 'create', 'edit']) {
    const gate = setup({name: `mcp__slack__${verb}_resource`, annotations: {readOnlyHint: true}, hasUI: false});
    assert.equal((await gate.call()).block, true, verb);
  }
});

test('approval is per call, including nested codemode calls', async () => {
  const gate = setup({confirm: async () => true});
  assert.equal(await gate.call(), undefined);
  assert.equal(await gate.call({parentToolCallId: 'codemode-1'}), undefined);
  assert.equal(gate.dialogs.length, 2);
  assert.match(gate.dialogs[0][1], /mcp__slack__slack_send_message/);
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
