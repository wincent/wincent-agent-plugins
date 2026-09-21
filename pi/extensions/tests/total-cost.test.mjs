/**
 * Run with: node --test pi/extensions/tests/total-cost.test.mjs
 * Uses only temporary sessions and stubs Pi's UI imports, not its accounting.
 */
import {strict as assert} from 'node:assert';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

// This repository has type stubs, not runtime Pi dependencies. The command's
// non-interactive path must not instantiate any of these UI components.
const uiStub =
  'class UnusedUI { constructor() { throw new Error("Unexpected UI"); } }';
const imports = new Map([[
  '@earendil-works/pi-coding-agent',
  `${uiStub} export { UnusedUI as DynamicBorder };`,
], [
  '@earendil-works/pi-tui',
  `${uiStub} export { UnusedUI as Container, UnusedUI as Text, UnusedUI as matchesKey };`,
]]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = imports.get(specifier);
    return source === undefined
      ? nextResolve(specifier, context)
      : {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true,
      };
  },
});
let extension;
try {
  ({default: extension} = await import('../total-cost.ts'));
} finally {
  hooks.deregister();
}

function usage(model, cost, timestamp, kind = 'cache_warm') {
  return {type: 'usage', kind, model, timestamp, usage: {cost: {total: cost}}};
}

function assistant(model, cost, timestamp) {
  return {
    type: 'message',
    timestamp,
    message: {role: 'assistant', model, usage: {cost: {total: cost}}},
  };
}

async function report(t, files, args = '') {
  const dir = await mkdtemp(join(tmpdir(), 'total-cost-test-'));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const project = join(dir, 'sessions', 'project');
    await mkdir(project, {recursive: true});
    for (const [index, entries] of files.entries()) {
      await writeFile(
        join(project, `${index}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join('\n') +
          '\n{broken\n',
      );
    }
    let handler;
    extension({
      registerCommand(name, command) {
        assert.equal(name, 'total-cost');
        handler = command.handler;
      },
    });
    const output = [];
    t.mock.method(console, 'log', (line) => output.push(line));
    t.mock.method(console, 'error', (line) => assert.fail(line));
    await handler(args, {hasUI: false});
    return output.join('\n');
  } finally {
    if (previousDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousDir;
    }
    await rm(dir, {recursive: true, force: true});
  }
}

function rows(output) {
  return output.split('\n')
    .filter((line) => /^(?:Total\s+\$|\d{4}-\d{2}\s)/.test(line))
    .map((line) => line.trim().split(/\s+/));
}

const mixedFiles = [[
  assistant('gpt', 3, '2026-09-21T00:00:00Z'),
  usage('gpt', 1, '2026-09-21T00:00:00Z'),
], [
  usage('claude', 0.5, '2026-08-31T00:00:00Z'),
  usage('claude', 0.25, '2026-08-31T00:00:00Z', 'future_operation'),
]];

test('counts usage by month/model/session without inflating message counts', async (t) => {
  assert.deepEqual(rows(await report(t, mixedFiles)), [
    ['2026-09', '$4.00', '$4.00', '-', '1', '1'],
    ['2026-08', '$0.75', '-', '$0.75', '0', '1'],
    ['Total', '$4.75', '$4.00', '$0.75', '1', '2'],
  ]);
});

test('model filters retain usage-only months and omit unmatched months', async (t) => {
  assert.deepEqual(rows(await report(t, mixedFiles, 'CLAUDE')), [[
    '2026-08',
    '$0.75',
    '$0.75',
    '0',
    '1',
  ], ['Total', '$0.75', '$0.75', '0', '1']]);
});

test('no-model-breakdown keeps usage costs and message counts', async (t) => {
  assert.deepEqual(rows(await report(t, mixedFiles, 'no-model-breakdown')), [
    ['2026-09', '$4.00', '1', '1'],
    ['2026-08', '$0.75', '0', '1'],
    ['Total', '$4.75', '1', '2'],
  ]);
});

test('usage-only sessions use UTC timestamps and unknown-model fallback', async (t) => {
  const output = await report(t, [[
    usage(undefined, 2, '2026-09-01T00:30:00+02:00'),
  ]], 'unknown');
  assert.deepEqual(rows(output), [['2026-08', '$2.00', '$2.00', '0', '1'], [
    'Total',
    '$2.00',
    '$2.00',
    '0',
    '1',
  ]]);
});

test('ignores malformed and unrelated records, retaining old assistant costs', async (t) => {
  const oldMessage = assistant('gpt', 2, undefined);
  oldMessage.message.timestamp = Date.UTC(2026, 8, 21);
  assert.deepEqual(
    rows(
      await report(t, [[
        oldMessage,
        null,
        {type: 'usage'},
        {type: 'message'},
        {
          type: 'message',
          message: {role: 'system', usage: {cost: {total: 100}}},
        },
        usage('gpt', -1, '2026-09-21'),
        usage('gpt', '3', '2026-09-21'),
        usage('gpt', 0, '2026-09-21'),
        usage('gpt', 10, 'invalid'),
      ]]),
    ),
    [['2026-09', '$2.00', '$2.00', '1', '1'], [
      'Total',
      '$2.00',
      '$2.00',
      '1',
      '1',
    ]],
  );
});

test('unmatched filters still report no matching models', async (t) => {
  const output = await report(t, mixedFiles, 'missing');
  assert.match(output, /No models matching missing found/);
  assert.deepEqual(rows(output), []);
});
