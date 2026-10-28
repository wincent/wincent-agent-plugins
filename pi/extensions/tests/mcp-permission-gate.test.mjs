import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {registerHooks} from 'node:module';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './dialog.js') specifier = './dialog.ts';
    return nextResolve(specifier, context);
  },
});
let registerMcpPermissionGate;
try {
  ({registerMcpPermissionGate} = await import('../lib/mcp.ts'));
} finally {
  hooks.deregister();
}

const call = {
  toolName: 'mcp__example__operation',
  input: {value: 1},
};
const metadata = {name: call.toolName, annotations: {readOnlyHint: true}};
const blocked = {
  block: true,
  reason: `Example tool ${call.toolName} requires per-call user confirmation.`,
};

function setup(tools = [], isWriteTool = () => true) {
  let handler;
  registerMcpPermissionGate({
    on(name, callback) {
      assert.equal(name, 'tool_call');
      assert.equal(handler, undefined);
      handler = callback;
    },
    getAllTools: typeof tools === 'function' ? tools : () => tools,
  }, {
    server: 'example',
    label: 'Example',
    isWriteTool,
  });
  assert.equal(typeof handler, 'function');
  return handler;
}

test('only the exact native namespace consults the catalog or policy', async () => {
  const unexpected = () => assert.fail('unrelated call consulted the gate');
  const handler = setup(unexpected, unexpected);
  for (const toolName of [
    'example',
    'mcp__example_operation',
    'mcp__example_other__operation',
    'mcp__other__operation',
  ]) {
    assert.equal(await handler({...call, toolName}, {hasUI: false}), undefined);
  }
});

test('the policy receives the original full native metadata without rewriting it', async () => {
  const tool = Object.freeze({...metadata, description: 'Read operation'});
  let classified = 0;
  const handler = setup([tool], (actual) => {
    assert.equal(actual, tool);
    classified++;
    return false;
  });
  assert.equal(await handler(call, {hasUI: false}), undefined);
  assert.equal(classified, 1);
});

test('missing exact metadata requires confirmation even with a permissive policy', async () => {
  for (const tools of [[], [{name: 'mcp__example__other'}]]) {
    let classified = 0;
    const handler = setup(tools, () => {
      classified++;
      return false;
    });
    assert.deepEqual(await handler(call, {hasUI: false}), blocked);
    assert.equal(classified, 0);
  }
});

test('each call consults current metadata rather than caching a read exemption', async () => {
  let tools = [metadata];
  let lookups = 0;
  const handler = setup(() => {
    lookups++;
    return tools;
  }, (tool) => tool.annotations?.readOnlyHint !== true);
  assert.equal(await handler(call, {hasUI: false}), undefined);
  tools = [{...metadata, annotations: {readOnlyHint: false}}];
  assert.deepEqual(await handler(call, {hasUI: false}), blocked);
  tools = [];
  assert.deepEqual(await handler(call, {hasUI: false}), blocked);
  tools = [metadata];
  assert.equal(await handler(call, {hasUI: false}), undefined);
  assert.equal(lookups, 4);
});

test('every confirmation shows the original call and only strict true approves', async () => {
  const handler = setup([metadata]);
  let answer;
  let prompts = 0;
  const ctx = {
    hasUI: true,
    ui: {
      async confirm(title, message) {
        assert.equal(title, 'Example write operation');
        assert.equal(message, `Allow ${call.toolName}?\n\n${JSON.stringify(call.input, null, 2)}`);
        prompts++;
        return answer;
      },
    },
  };
  const answers = [true, false, 'yes', 1, undefined, null, true, false];
  for (answer of answers) {
    assert.deepEqual(await handler(call, ctx), answer === true ? undefined : blocked);
  }
  assert.equal(prompts, answers.length);
});

test('an unavailable UI fails closed even if the context claims UI support', async () => {
  const handler = setup([metadata]);
  for (const ui of [undefined, null, {}]) {
    assert.deepEqual(await handler(call, {hasUI: true, ui}), blocked);
  }
});

test('catalog and policy errors propagate instead of granting permission', async () => {
  const failure = new Error('unavailable');
  const fail = () => {
    throw failure;
  };
  for (const handler of [setup(fail), setup([metadata], fail)]) {
    await assert.rejects(handler(call, {hasUI: false}), (error) => error === failure);
  }
});
