/**
 * Requires globally installed Pi 0.87.1 or newer (no provider requests).
 * Run: node --experimental-transform-types --test pi/extensions/tests/context-breakdown.test.mjs
 */
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

const piDir = process.env.PI_TEST_PACKAGE_DIR ?? join(
  execFileSync('npm', ['root', '-g'], {encoding: 'utf8'}).trim(),
  '@earendil-works/pi-coding-agent',
);
const packages = new Set([
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui',
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!packages.has(specifier)) {
      return nextResolve(specifier, context);
    }
    const dir = specifier === '@earendil-works/pi-coding-agent'
      ? piDir
      : join(piDir, 'node_modules', specifier);
    return {
      url: pathToFileURL(join(dir, 'dist/index.js')).href,
      shortCircuit: true,
    };
  },
});
let extension;
let buildContextEntries;
let buildSessionProjection;
let getCurrentSystemPrompt;
let renderSystemMessageUpdate;
try {
  ({default: extension} = await import('../context-breakdown.ts'));
  ({buildContextEntries, buildSessionProjection} = await import(
    '@earendil-works/pi-coding-agent'
  ));
  ({getCurrentSystemPrompt, renderSystemMessageUpdate} = await import(
    '@earendil-works/pi-ai'
  ));
} finally {
  hooks.deregister();
}

function system(content, extra = {}) {
  return {role: 'system', content, timestamp: 0, ...extra};
}

function tool(name, description = 'Tool description') {
  return {name, description, parameters: {type: 'object', properties: {}}};
}

function assistant(input = 100) {
  return {
    role: 'assistant',
    provider: 'test',
    model: 'example',
    api: 'openai-responses',
    stopReason: 'stop',
    content: [{type: 'text', text: 'answer'}],
    timestamp: 1,
    usage: {
      input,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + 2,
    },
  };
}

function entries(messages) {
  return messages.map((message, index) => ({
    type: 'message',
    id: `entry${index}`,
    parentId: index ? `entry${index - 1}` : null,
    timestamp: '2026-09-21T00:00:00Z',
    message,
  }));
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'context-breakdown-test-'));
  const agent = join(dir, 'agent');
  const cwd = join(dir, 'project');
  await mkdir(agent);
  await mkdir(join(cwd, '.pi'), {recursive: true});
  const globalText = JSON.stringify(options.global ?? {});
  const projectText = JSON.stringify(options.project ?? {});
  await writeFile(join(agent, 'settings.json'), globalText);
  await writeFile(join(cwd, '.pi/settings.json'), projectText);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    await rm(dir, {recursive: true, force: true});
  });
  const model = {
    provider: 'test',
    id: 'example',
    api: 'openai-responses',
    name: 'Example',
    contextWindow: 100000,
    compat: {supportsMidConvoSystemMessages: true},
    ...options.model,
  };
  const messages = options.messages ?? [system('Initial prompt')];
  const branch = options.branch ?? entries(messages);
  const buildOptions = options.buildOptions ??
    {selectedTools: [], contextFiles: [], skills: []};
  let prompt = options.prompt ?? getCurrentSystemPrompt(messages);
  const allTools = (options.tools ?? []).map((item) => ({
    ...item,
    sourceInfo: {
      source: 'builtin',
      path: item.name,
      scope: 'user',
      origin: 'top-level',
    },
  }));
  const events = new Map();
  let handler;
  extension({
    on(name, callback) {
      events.set(name, callback);
    },
    registerCommand(name, command) {
      assert.equal(name, 'context');
      handler = command.handler;
    },
    getAllTools: () => allTools,
    getActiveTools: () => options.active ?? allTools.map((item) => item.name),
  });
  const ctx = {
    cwd,
    model,
    hasUI: false,
    mode: 'print',
    isProjectTrusted: () => options.trusted ?? true,
    getSystemPrompt: () => prompt,
    getSystemPromptOptions: () => buildOptions,
    getContextUsage: () => ({
      tokens: options.tokens ?? null,
      contextWindow: 100000,
    }),
    sessionManager: {
      buildContextEntries: () => buildContextEntries(branch),
      buildSessionProjection: () => buildSessionProjection(branch),
      getBranch: () => branch,
    },
  };
  let output = [];
  let errors = [];
  t.mock.method(console, 'log', (line) => output.push(line));
  t.mock.method(console, 'error', (line) => errors.push(line));
  return {
    ctx,
    async observe(message, forcedPrompt, effectivePrompt) {
      const sharedOptions = {...buildOptions};
      await events.get('before_agent_start')({
        systemPromptOptions: sharedOptions,
      }, ctx);
      // Simulate a later handler returning systemPrompt, even if identical to
      // the replayed prompt. The observer must retain the shared reference.
      if (forcedPrompt !== undefined) {
        sharedOptions.forceSystemPrompt = forcedPrompt;
      }
      prompt = effectivePrompt ?? forcedPrompt ?? prompt;
      await events.get('message_end')({message}, ctx);
      await events.get('agent_end')({}, ctx);
      // Idle ctx.getSystemPrompt() reverts to base options after settlement.
      prompt = options.prompt ?? getCurrentSystemPrompt(messages);
    },
    async run() {
      output = [];
      errors = [];
      await handler('all', ctx);
      return {text: output.join('\n'), error: errors.join('\n')};
    },
    async assertReadOnly() {
      assert.deepEqual(await readdir(agent), ['settings.json']);
      assert.deepEqual(await readdir(join(cwd, '.pi')), ['settings.json']);
      assert.equal(
        await readFile(join(agent, 'settings.json'), 'utf8'),
        globalText,
      );
      assert.equal(
        await readFile(join(cwd, '.pi/settings.json'), 'utf8'),
        projectText,
      );
    },
  };
}

test('global model override beats project fallback and merges nested fields', async (t) => {
  const f = await fixture(t, {
    global: {
      compaction: {modelOverrides: {'test/example': {reserveTokens: 30000}}},
    },
    project: {
      compaction: {
        reserveTokens: 40000,
        modelOverrides: {'test/example': {keepRecentTokens: 1000}},
      },
    },
  });
  const {text, error} = await f.run();
  assert.equal(error, '');
  assert.match(text, /Compaction reserve: 30k tokens/);
  await f.assertReadOnly();
});

test('untrusted project settings cannot override the global model budget', async (t) => {
  const f = await fixture(t, {
    trusted: false,
    global: {
      compaction: {modelOverrides: {'test/example': {reserveTokens: 30000}}},
    },
    project: {
      compaction: {modelOverrides: {'test/example': {reserveTokens: 40000}}},
    },
  });
  assert.match((await f.run()).text, /Compaction reserve: 30k tokens/);
});

test('zero model reserve is honored', async (t) => {
  const f = await fixture(t, {
    global: {
      compaction: {
        reserveTokens: 30000,
        modelOverrides: {'test/example': {reserveTokens: 0}},
      },
    },
  });
  assert.doesNotMatch((await f.run()).text, /Compaction reserve/);
});

test('disabled compaction has no reserve', async (t) => {
  const f = await fixture(t, {global: {compaction: {enabled: false}}});
  assert.doesNotMatch((await f.run()).text, /Compaction reserve/);
});

test('invalid ordinary budgets still fail when a valid model override exists', async (t) => {
  const f = await fixture(t, {
    global: {
      compaction: {
        reserveTokens: -1,
        modelOverrides: {'test/example': {reserveTokens: 30000}},
      },
    },
  });
  const {text, error} = await f.run();
  assert.equal(text, '');
  assert.match(error, /Invalid compaction.reserveTokens/);
});

test('native prompt patches are counted without repeating initial prompt or schemas', async (t) => {
  const read = tool('read');
  const patch = system('', {
    sections: {instructions: 'Updated instructions', removed: null},
    toolsAdded: [tool('write')],
  });
  const f = await fixture(t, {
    messages: [system('Initial prompt', {toolsAdded: [read]}), {
      role: 'user',
      content: 'Hi',
    }, patch],
    tools: [read, tool('write')],
  });
  const {text, error} = await f.run();
  assert.equal(error, '');
  assert.match(text, /System prompt: 4 tokens/);
  assert.ok(
    text.includes(
      `System prompt updates: ${
        Math.ceil(renderSystemMessageUpdate(patch).length / 4)
      } tokens`,
    ),
  );
  assert.match(text, /Tool definitions.*2 tools/);
  assert.match(text, /Historical forced prompts are not persisted/);
});

test('non-native model collapses patches and replaces same-name schemas', async (t) => {
  const replacement = tool('read', 'Replacement');
  const messages = [
    system('', {sections: {preamble: 'Old'}, toolsAdded: [tool('read')]}),
    {role: 'user', content: 'Hi'},
    system('', {
      sections: {preamble: 'New'},
      toolsRemoved: [{name: 'read'}],
      toolsAdded: [replacement],
    }),
  ];
  const f = await fixture(t, {
    messages,
    tools: [replacement],
    model: {compat: {}},
  });
  const {text} = await f.run();
  assert.match(text, /System prompt: 1 tokens/);
  assert.doesNotMatch(text, /System prompt updates:/);
  assert.match(text, /Tool definitions.*1 tool/);
});

test('observed forced prompt collapses history even when equal to replayed prompt', async (t) => {
  const reply = assistant();
  const messages = [
    system('Initial'),
    {role: 'user', content: 'Hi'},
    system('Later'),
    reply,
  ];
  const f = await fixture(t, {messages});
  await f.observe(reply, getCurrentSystemPrompt(messages));
  const {text} = await f.run();
  assert.match(text, /Observed forced prompt/);
  assert.doesNotMatch(text, /System prompt updates:/);
  assert.doesNotMatch(text, /Historical forced prompts are not persisted/);
});

test('forced prompts do not charge omitted files and skills', async (t) => {
  const reply = assistant();
  const f = await fixture(t, {
    messages: [system('Initial'), reply],
    buildOptions: {
      selectedTools: ['read'],
      contextFiles: [{path: '/private/AGENTS.md', content: 'PRIVATE_CONTEXT'}],
      skills: [{
        name: 'private',
        description: 'PRIVATE_SKILL',
        filePath: '/private/SKILL.md',
      }],
    },
  });
  await f.observe(reply, 'Only these instructions');
  const {text} = await f.run();
  assert.match(text, /Context files: 0 tokens/);
  assert.match(text, /Skills: 0 tokens/);
  assert.doesNotMatch(text, /\/private\//);
});

test('native Anthropic retains removed tool declarations exactly once', async (t) => {
  const read = tool('read');
  const write = tool('write');
  const f = await fixture(t, {
    model: {
      api: 'anthropic-messages',
      compat: {
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolChanges: true,
      },
    },
    messages: [
      system('Initial', {toolsAdded: [read]}),
      system('', {toolsAdded: [write]}),
      system('', {toolsRemoved: [{name: 'read'}]}),
    ],
    tools: [write],
  });
  const {text} = await f.run();
  assert.match(text, /Tool definitions \(2 tools/);
  assert.match(text, /Transcript/);
});

test('usage records do not become context messages', async (t) => {
  const branch = entries([system('Initial')]);
  branch.push({
    type: 'usage',
    kind: 'cache_warm',
    usage: {cost: {total: 99}},
    id: 'warm',
    parentId: 'entry0',
  });
  const f = await fixture(t, {branch});
  const {text} = await f.run();
  assert.doesNotMatch(text, /cache_warm|Conversation \(/);
});

test('compaction checkpoint is counted once and old usage cannot calibrate', async (t) => {
  const old = assistant(50000);
  const retained = entries([old])[0];
  const checkpoint = {
    type: 'compaction',
    id: 'compact',
    parentId: retained.id,
    timestamp: '2026-09-21T00:00:00Z',
    summary: 'Summary',
    tokensBefore: 50000,
    firstKeptEntryId: retained.id,
    systemMessage: system('Checkpoint'),
  };
  const f = await fixture(t, {
    branch: [retained, checkpoint],
    prompt: 'Checkpoint',
  });
  await f.observe(old, undefined, 'Old prompt');
  const {text} = await f.run();
  assert.match(text, /System prompt: 3 tokens/);
  assert.match(text, /No comparable observed turns/);
  assert.match(text, /no provider count yet; total estimated/);
});

test('unobserved and changed-prompt turns are not fitted together', async (t) => {
  const first = assistant(1000);
  const second = assistant(2000);
  const f = await fixture(t, {
    messages: [system('Initial'), first, system('Updated'), second],
    tokens: 2002,
  });
  await f.observe(first, 'First forced prompt');
  await f.observe(second, 'A different forced prompt');
  const {text} = await f.run();
  assert.equal((text.match(/Observed forced prompt/g) ?? []).length, 1);
  // One comparable observation uses a pooled rate, not a two-epoch slope.
  const rates = [...text.matchAll(
    /(\d+\.\d{2}) chars\/token|conversation and (\d+\.\d{2})/g,
  )];
  assert.equal(rates.length, 2);
  assert.equal(rates[0][1], rates[1][2]);
});

test('empty sessions estimate prompt and tools without comparing against zero', async (t) => {
  const options = {
    messages: [],
    branch: [],
    tokens: 0,
    prompt: 'Configured system prompt',
    tools: [tool('read')],
  };
  const f = await fixture(t, options);
  const initial = await f.run();
  assert.equal(initial.error, '');
  assert.match(initial.text, /no provider count yet; total estimated/);
  assert.match(initial.text, /~[\d.]+k?\/100k tokens/);
  assert.doesNotMatch(initial.text, /Attribution estimate exceeds/);

  // A usable response changes the baseline from a heuristic to a measurement.
  options.branch.push(...entries([assistant()]));
  options.tokens = 102;
  const measured = await f.run();
  assert.equal(measured.error, '');
  assert.doesNotMatch(measured.text, /no provider count yet; total estimated/);
  assert.doesNotMatch(measured.text, /~[\d.]+k?\/100k tokens/);
});

test('positive pre-response conversation heuristics are not provider measurements', async (t) => {
  const f = await fixture(t, {
    messages: [system('Configured system prompt'), {
      role: 'user',
      content: 'Hi',
    }],
    tokens: 1,
  });
  const {text, error} = await f.run();
  assert.equal(error, '');
  assert.match(text, /no provider count yet; total estimated/);
  assert.doesNotMatch(text, /Attribution estimate exceeds/);
});

for (const reason of ['error', 'aborted', 'zero usage']) {
  test(`${reason} responses do not establish a provider baseline`, async (t) => {
    const reply = assistant();
    if (reason === 'zero usage') {
      reply.usage.input = reply.usage.output = reply.usage.totalTokens = 0;
    } else {
      reply.stopReason = reason;
    }
    const f = await fixture(t, {
      messages: [system('Configured system prompt'), reply],
      tokens: 2,
    });
    const {text, error} = await f.run();
    assert.equal(error, '');
    assert.match(text, /no provider count yet; total estimated/);
    assert.doesNotMatch(text, /Attribution estimate exceeds/);
  });
}

function contextEdit(branch, targetId, replacement) {
  return {
    type: 'context_edit',
    id: `edit${branch.length}`,
    parentId: branch.at(-1)?.id ?? null,
    timestamp: '2026-09-23T00:00:00Z',
    targetId,
    replacement: replacement === null ? null : {content: replacement},
  };
}

for (const message of [
  {role: 'user', content: 'OMITTED_USER'},
  {...assistant(), content: [{type: 'text', text: 'OMITTED_ASSISTANT'}]},
  {
    role: 'toolResult',
    toolName: 'read',
    toolCallId: 'call',
    content: [{type: 'text', text: 'OMITTED_RESULT'}],
  },
]) {
  test(`context edits omit ${message.role} content without changing history`, async (t) => {
    const branch = entries([system('Initial'), message]);
    branch.push(contextEdit(branch, 'entry1', null));
    const original = structuredClone(branch);
    const f = await fixture(t, {branch});
    const {text, error} = await f.run();
    assert.equal(error, '');
    assert.doesNotMatch(text, /OMITTED_|Conversation \(/);
    assert.deepEqual(branch, original);
    await f.assertReadOnly();
  });
}

for (const message of [
  {role: 'user', content: 'ORIGINAL_USER'},
  {...assistant(), content: [{type: 'text', text: 'ORIGINAL_ASSISTANT'}]},
  {
    role: 'toolResult',
    toolName: 'read',
    toolCallId: 'call',
    content: [{type: 'text', text: 'ORIGINAL_RESULT'}],
  },
]) {
  test(`latest context edit replaces ${message.role} content and navigation restores it`, async (t) => {
    const branch = entries([system('Initial'), message]);
    const original = structuredClone(branch);
    branch.push(contextEdit(branch, 'entry1', null));
    branch.push(contextEdit(branch, 'entry1', 'REPLACEMENT'));
    const f = await fixture(t, {branch});
    const {text, error} = await f.run();
    assert.equal(error, '');
    assert.match(text, /Conversation \(1 message \/ 3 tokens/);
    if (message.role !== 'toolResult') {
      assert.match(text, /REPLACEMENT/);
    }
    assert.doesNotMatch(text, /ORIGINAL_/);
    assert.deepEqual(branch.slice(0, 2), original);

    branch.splice(2);
    const restored = await f.run();
    assert.equal(restored.error, '');
    const content = typeof message.content === 'string'
      ? message.content
      : message.content[0].text;
    assert.ok(restored.text.includes(
      `Conversation (1 message / ${Math.ceil(content.length / 4)} tokens`,
    ));
    if (message.role !== 'toolResult') {
      assert.match(restored.text, /ORIGINAL_/);
    }
    assert.doesNotMatch(restored.text, /REPLACEMENT/);
  });
}

test('context edits invalidate old usage and calibration until a fresh response', async (t) => {
  const old = assistant(1000);
  const messages = [system('Initial'), {role: 'user', content: 'Original'}, old];
  const branch = entries(messages);
  const options = {messages, branch, tokens: 1002};
  const f = await fixture(t, options);
  await f.observe(old);
  assert.doesNotMatch((await f.run()).text, /No comparable observed turns/);

  branch.push(contextEdit(branch, 'entry1', 'Edited prompt'));
  // Pi can return a positive heuristic after an edit, not a provider count.
  options.tokens = 20;
  const edited = await f.run();
  assert.equal(edited.error, '');
  assert.match(edited.text, /Edited prompt/);
  assert.doesNotMatch(edited.text, /Original/);
  assert.match(edited.text, /No comparable observed turns/);
  assert.match(edited.text, /no provider count yet; total estimated/);

  const fresh = assistant(2000);
  branch.push({
    ...entries([fresh])[0],
    id: 'fresh',
    parentId: branch.at(-1).id,
  });
  options.tokens = 2002;
  await f.observe(fresh);
  const updated = await f.run();
  assert.equal(updated.error, '');
  assert.doesNotMatch(updated.text, /no provider count yet/);
  assert.doesNotMatch(updated.text, /No comparable observed turns/);
  // Only the post-edit observation can calibrate the edited prefix.
  const rates = [...updated.text.matchAll(
    /(\d+\.\d{2}) chars\/token|conversation and (\d+\.\d{2})/g,
  )];
  assert.equal(rates.length, 2);
  assert.equal(rates[0][1], rates[1][2]);

  branch.push({
    type: 'custom',
    id: 'metadata',
    parentId: 'fresh',
    customType: 'test',
    data: {},
  });
  assert.doesNotMatch((await f.run()).text, /No comparable observed turns/);

  // A later compaction still invalidates otherwise fresh post-edit usage.
  branch.push({
    type: 'compaction',
    id: 'compact',
    parentId: 'metadata',
    timestamp: '2026-09-23T00:00:00Z',
    summary: 'Summary',
    firstKeptEntryId: 'fresh',
    tokensBefore: 2002,
    systemMessage: system('Checkpoint'),
  });
  const compacted = await f.run();
  assert.equal(compacted.error, '');
  assert.match(compacted.text, /No comparable observed turns/);
  assert.match(compacted.text, /no provider count yet; total estimated/);
});

test('retained older compactions do not contribute duplicate checkpoints or summaries', async (t) => {
  const branch = entries([system('Initial'), {role: 'user', content: 'Retained'}]);
  branch.push({
    type: 'compaction',
    id: 'older',
    parentId: 'entry1',
    timestamp: '2026-09-23T00:00:00Z',
    summary: 'OLD_SUMMARY',
    tokensBefore: 100,
    firstKeptEntryId: 'entry1',
    systemMessage: system('Old checkpoint'),
  });
  branch.push({
    type: 'compaction',
    id: 'newer',
    parentId: 'older',
    timestamp: '2026-09-23T00:00:00Z',
    summary: 'New summary',
    tokensBefore: 200,
    firstKeptEntryId: 'older',
    systemMessage: system('Checkpoint'),
  });
  const f = await fixture(t, {branch, prompt: 'Checkpoint'});
  const {text, error} = await f.run();
  assert.equal(error, '');
  assert.match(text, /System prompt: 3 tokens/);
  assert.match(text, /Conversation \(1 message/);
  assert.match(text, /Compaction summaries: 3 tokens/);
  assert.doesNotMatch(text, /System prompt updates:/);
});

test('retain-none compaction projects only its checkpoint and summary', async (t) => {
  const branch = entries([system('Old prompt'), assistant(50000)]);
  branch.push({
    type: 'compaction',
    id: 'compact',
    parentId: 'entry1',
    timestamp: '2026-09-23T00:00:00Z',
    summary: 'Summary',
    tokensBefore: 50000,
    firstKeptEntryId: 'compact',
    systemMessage: system('Checkpoint'),
  });
  const f = await fixture(t, {branch, prompt: 'Checkpoint'});
  const {text, error} = await f.run();
  assert.equal(error, '');
  assert.match(text, /Conversation \(1 message/);
  assert.doesNotMatch(text, /Assistant text:/);
  assert.match(text, /no provider count yet; total estimated/);
});

test('real measured discrepancies still produce the warning', async (t) => {
  const f = await fixture(t, {
    messages: [system('Long prompt '.repeat(100)), assistant(1)],
    tokens: 3,
  });
  const {text, error} = await f.run();
  assert.equal(error, '');
  assert.doesNotMatch(text, /no provider count yet; total estimated/);
  assert.match(
    text,
    /Attribution estimate exceeds Pi's context estimate \(3 tokens\)/,
  );
});
