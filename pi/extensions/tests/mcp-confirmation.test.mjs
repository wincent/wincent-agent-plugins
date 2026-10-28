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
    if (specifier === './lib/mcp.js') {
      // Separate library instances, like Pi's uncached extension imports.
      const caller = new URL(context.parentURL).pathname.split('/').at(-1);
      specifier = new URL(`../lib/mcp.ts?caller=${caller}`, import.meta.url).href;
    }
    return packages.resolve(specifier, context, nextResolve);
  },
});
let slack, datadog, workspace, queueMcpConfirmation;
try {
  ({default: slack} = await import('../slack-mcp.ts'));
  ({default: datadog} = await import('../datadog-mcp.ts'));
  ({default: workspace} = await import('../google-workspace-mcp.ts'));
  ({queueMcpConfirmation} = await import('../lib/mcp.ts?caller=direct'));
} finally {
  hooks.deregister();
}

function gate(extension, name, ui) {
  let handler;
  extension({
    on(event, callback) {
      assert.equal(event, 'tool_call');
      handler = callback;
    },
    getAllTools: () => [{name, annotations: {readOnlyHint: false}}],
  });
  return (input = {}) => handler({toolName: name, input}, {hasUI: true, ui});
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('independent module instances serialize mixed-server and direct confirmations', async () => {
  const dialogs = [];
  const ui = {confirm: (title) => new Promise((resolve, reject) => dialogs.push({title, resolve, reject}))};
  const slackCall = gate(slack, 'mcp__slack__slack_send_message', ui);
  const datadogCall = gate(datadog, 'mcp__datadog__create_dashboard', ui);
  const workspaceCall = gate(workspace, 'mcp__google_workspace__create_document', ui);
  const first = slackCall();
  const second = datadogCall();
  const third = workspaceCall();
  const fourth = queueMcpConfirmation(ui, () => ui.confirm('Direct confirmation'));
  await tick();
  assert.deepEqual(dialogs.map(({title}) => title), ['Slack write operation']);
  dialogs[0].resolve(false);
  assert.equal((await first).block, true);
  await tick();
  assert.deepEqual(dialogs.map(({title}) => title), ['Slack write operation', 'Datadog write operation']);
  dialogs[1].reject(new Error('UI unavailable'));
  assert.equal((await second).block, true);
  await tick();
  assert.equal(dialogs[2].title, 'Google Workspace write operation');
  dialogs[2].resolve(true);
  assert.equal(await third, undefined);
  await tick();
  assert.equal(dialogs[3].title, 'Direct confirmation');
  dialogs[3].resolve(false);
  assert.equal(await fourth, false);
  const fifth = workspaceCall();
  await tick();
  assert.equal(dialogs.length, 5);
  dialogs[4].resolve(false);
  assert.equal((await fifth).block, true);
});

test('a pending dialog does not block a different UI', async () => {
  const first = Promise.withResolvers();
  const pending = queueMcpConfirmation({}, () => first.promise);
  assert.equal(await queueMcpConfirmation({}, async () => true), true);
  first.resolve(false);
  assert.equal(await pending, false);
});

test('synchronous failures release the queue and only true approves', async () => {
  const ui = {};
  assert.equal(await queueMcpConfirmation(ui, () => { throw new Error('Unavailable'); }), false);
  assert.equal(await queueMcpConfirmation(ui, async () => 'yes'), false);
  assert.equal(await queueMcpConfirmation(ui, async () => true), true);
});

test('unserializable arguments fail closed without showing or wedging a dialog', async () => {
  let dialogs = 0;
  const ui = {confirm: async () => { dialogs++; return true; }};
  const call = gate(slack, 'mcp__slack__slack_send_message', ui);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal((await call(cyclic)).block, true);
  assert.equal(dialogs, 0);
  assert.equal(await call(), undefined);
  assert.equal(dialogs, 1);
});
