import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {registerHooks} from 'node:module';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './dialog.js') specifier = './dialog.ts';
    return nextResolve(specifier, context);
  },
});
let makeIsWriteTool;
try {
  ({makeIsWriteTool} = await import('../lib/mcp.ts'));
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
