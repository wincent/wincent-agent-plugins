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
    if (specifier === './lib/mcp.js' && context.parentURL === new URL('../google-workspace-mcp.ts', import.meta.url).href) {
      specifier = './lib/mcp.ts';
    }
    return packages.resolve(specifier, context, nextResolve);
  },
});
let extension;
try {
  ({default: extension} = await import('../google-workspace-mcp.ts'));
} finally {
  hooks.deregister();
}

function setup({name = 'mcp__google_workspace__create_document', annotations, known = true, hasUI = true, confirm = async () => false} = {}) {
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
  for (const name of ['google_workspace', 'mcp__other__postMessage', 'mcp__google_workspace_other__create_document']) {
    const gate = setup({name});
    assert.equal(await gate.call(), undefined);
    assert.equal(gate.dialogs.length, 0);
  }
});

test('all known Workspace reads work without annotations or UI', async () => {
  for (const name of [
    'get_comment', 'get_doc_as_markdown', 'get_file_content', 'get_file_metadata',
    'get_presentation', 'get_slide', 'get_slide_thumbnail', 'get_spreadsheet_metadata',
    'list_file_comments', 'list_folder_contents', 'list_sheet_comments', 'list_tabs',
    'ping', 'read_document', 'read_sheet', 'search_files',
  ]) {
    for (const annotations of [undefined, {readOnlyHint: true}, {destructiveHint: false}]) {
      const gate = setup({name: 'mcp__google_workspace__' + name, annotations, hasUI: false});
      assert.equal(await gate.call(), undefined, name);
      assert.equal(gate.dialogs.length, 0);
    }
  }
});

test('unknown tools and explicit conflicting hints fail closed', async () => {
  for (const options of [
    {name: 'mcp__google_workspace__search_files', known: false},
    {name: 'mcp__google_workspace__search_files', annotations: {readOnlyHint: false}},
    {name: 'mcp__google_workspace__search_files', annotations: {readOnlyHint: true, destructiveHint: true}},
    {name: 'mcp__google_workspace__new_read_tool', annotations: {readOnlyHint: true}},
    {name: 'mcp__google_workspace__search_files_extra', annotations: {readOnlyHint: true}},
    {name: 'mcp__google_workspace__search_files_hash', annotations: {readOnlyHint: true}},
    {name: 'mcp__google_workspace__SEARCH_FILES', annotations: {readOnlyHint: true}},
    {name: 'mcp__google_workspace__new_tool'},
  ]) {
    const gate = setup({...options, hasUI: false});
    assert.equal((await gate.call()).block, true);
    assert.equal(gate.dialogs.length, 0);
  }
});

test('server-side write exemptions cannot bypass the local allowlist', async () => {
  for (const name of ['create_document', 'create_spreadsheet', 'format_cells', 'rename_file', 'duplicate_slide', 'delete_file']) {
    const gate = setup({name: 'mcp__google_workspace__' + name, annotations: {readOnlyHint: true}, hasUI: false});
    assert.equal((await gate.call()).block, true, name);
  }
});

test('approval is per call, including nested codemode calls', async () => {
  const gate = setup({confirm: async () => true});
  assert.equal(await gate.call(), undefined);
  assert.equal(await gate.call({parentToolCallId: 'codemode-1'}), undefined);
  assert.equal(gate.dialogs.length, 2);
  assert.match(gate.dialogs[0][1], /mcp__google_workspace__create_document/);
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
