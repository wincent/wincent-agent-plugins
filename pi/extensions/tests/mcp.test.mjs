import {strict as assert} from 'node:assert';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {piPackageImports} from './pi-package.mjs';

const hooks = registerHooks(piPackageImports([
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  'typebox',
  'typebox/value',
]));
let makeIsWriteTool;
let defineMcpProxyTool;
try {
  ({makeIsWriteTool, defineMcpProxyTool} = await import('../lib/mcp.ts'));
} finally {
  hooks.deregister();
}

const isWriteTool = makeIsWriteTool(new Set(['post', 'delete', 'update', 'mute', 'run', 'set']));

test('unknown and unannotated tools require confirmation, including read-looking names', () => {
  for (const name of ['frobnicate', 'slack_search_messages', 'getMonitor', 'listLogs']) {
    for (const annotations of [undefined, {}, {readOnlyHint: false}, {destructiveHint: false}, {idempotentHint: true}]) {
      assert.equal(isWriteTool({name, annotations}), true, `${name}: ${JSON.stringify(annotations)}`);
    }
  }
});

test('explicitly read-only tools bypass confirmation unless there is conflicting mutation evidence', () => {
  for (const name of ['slack_search_messages', 'getMonitor', 'HTTPGetLogs', 'listPosts', 'getUpdatedMonitor', 'getRuntime', 'lookupDataset']) {
    assert.equal(isWriteTool({name, annotations: {readOnlyHint: true}}), false, name);
    assert.equal(isWriteTool({name, annotations: {readOnlyHint: true, destructiveHint: false}}), false, name);
    assert.equal(isWriteTool({name, annotations: {readOnlyHint: true, destructiveHint: true}}), true, name);
  }
});

test('mutation tokens override read-only hints across separators, camelCase, PascalCase and acronyms', () => {
  for (const name of [
    'chat.postMessage',
    'ChatPostMessage',
    'slackPostMessage',
    'slack_post_message',
    'slack-post-message',
    'CHAT.POST.MESSAGE',
    'HTTPPostMessage',
    'postHTTPMessage',
    'v2PostMessage',
    'slack/postMessage',
    'slack:postMessage',
    'deleteMonitor',
    'datadogUpdateMonitor',
    'datadogMuteMonitor',
    'runWorkflow',
    'setStatus',
    'getAndDeleteMonitor',
  ]) {
    for (const annotations of [undefined, {readOnlyHint: true}, {readOnlyHint: false}, {readOnlyHint: true, destructiveHint: false}]) {
      assert.equal(isWriteTool({name, annotations}), true, `${name}: ${JSON.stringify(annotations)}`);
    }
  }
});

test('without mutation verbs, explicit read-only annotation is still required', () => {
  const classify = makeIsWriteTool(new Set());
  assert.equal(classify({name: 'unknown'}), true);
  assert.equal(classify({name: 'unknown', annotations: {readOnlyHint: true}}), false);
  assert.equal(classify({name: 'unknown', annotations: {readOnlyHint: true, destructiveHint: true}}), true);
});

test('catalog, description and execution agree on classification and gate each mutation', async () => {
  const tools = [
    {name: 'chat.postMessage', annotations: {readOnlyHint: true}},
    {name: 'datadogMuteMonitor', annotations: {readOnlyHint: true}},
    {name: 'unknown_operation'},
    {name: 'searchMessages', annotations: {readOnlyHint: true}},
  ];
  const calls = [];
  const confirmations = [];
  let approved = false;
  const ctx = {ui: {confirm: async (...args) => {
    confirmations.push(args);
    return approved;
  }}};
  const proxy = defineMcpProxyTool({
    name: 'test_mcp',
    label: 'Test MCP',
    description: 'Test MCP tool',
    client: {
      listTools: async () => tools,
      callTool: async (name, args) => {
        calls.push({name, args});
        return 'ok';
      },
      reset() {},
    },
    isWriteTool,
    writeGate: {title: 'Confirm write'},
  });
  const execute = (params) => proxy.execute('test', params, undefined, undefined, ctx);
  const catalog = await execute({action: 'list_tools'});
  assert.deepEqual(JSON.parse(catalog.content[0].text).map(({mutating}) => mutating), [true, true, true, false]);
  for (const {name} of tools) {
    const description = await execute({action: 'describe_tool', tool_name: name});
    assert.equal(JSON.parse(description.content[0].text).mutating, name !== 'searchMessages');
  }
  assert.equal(confirmations.length, 0);

  for (const {name} of tools.slice(0, 3)) {
    const params = {action: 'call_tool', tool_name: name, tool_args: {id: 'example'}};
    approved = false;
    const before = calls.length;
    await assert.rejects(execute(params), /Blocked by user/);
    assert.equal(calls.length, before);
    approved = true;
    const result = await execute(params);
    assert.equal(result.details.mutating, true);
    assert.deepEqual(calls.at(-1), {name, args: {id: 'example'}});
    approved = false;
    await assert.rejects(execute(params), /Blocked by user/);
    assert.equal(calls.length, before + 1);
  }
  assert.equal(confirmations.length, 9);
  assert.match(confirmations[0][1], /chat\.postMessage/);
  assert.match(confirmations[0][1], /example/);

  const result = await execute({action: 'call_tool', tool_name: 'searchMessages'});
  assert.equal(result.details.mutating, false);
  assert.equal(confirmations.length, 9);
  assert.equal(calls.length, 4);
});
