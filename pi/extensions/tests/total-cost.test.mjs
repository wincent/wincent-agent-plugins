/**
 * Requires Pi on PATH (no provider requests).
 * Run: node --experimental-transform-types --test pi/extensions/tests/total-cost.test.mjs
 * Uses temporary sessions and Pi's real rendering and width helpers.
 */
import {strict as assert} from 'node:assert';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {pathToFileURL} from 'node:url';

import {locatePiPackage} from './pi-package.mjs';

const piDir = locatePiPackage();
const imports = new Map([
  ['@earendil-works/pi-coding-agent', piDir],
  ['@earendil-works/pi-tui', join(piDir, 'node_modules/@earendil-works/pi-tui')],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const dir = imports.get(specifier);
    return dir === undefined
      ? nextResolve(specifier, context)
      : {
        url: pathToFileURL(join(dir, 'dist/index.js')).href,
        shortCircuit: true,
      };
  },
});
let extension;
let visibleWidth;
let stripTerminalSequences;
try {
  ({default: extension} = await import('../total-cost.ts'));
  ({visibleWidth, stripTerminalSequences} = await import('@earendil-works/pi-tui'));
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

function toolResult(cost, timestamp, extra = {}) {
  return {
    type: 'message',
    timestamp,
    message: {
      role: 'toolResult',
      toolName: 'codemode',
      toolCallId: 'parent',
      usage: {cost: {total: cost}},
      ...extra,
    },
  };
}

async function report(t, files, args = '', context = {hasUI: false}) {
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
    await handler(args, context);
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

test('counts aggregated tool usage once in a separate bucket', async (t) => {
  const output = await report(t, [[
    assistant('gpt', 3, '2026-09-21'),
    usage('gpt', 1, '2026-09-21'),
    toolResult(2, '2026-09-21', {
      nestedCalls: [
        {toolCallId: 'parent/1', usage: {cost: {total: 0.75}}},
        {toolCallId: 'parent/2', usage: {cost: {total: 1.25}}},
      ],
      details: {usage: {cost: {total: 2}}},
    }),
  ]]);
  assert.match(output, /Month\s+Cost\s+gpt\s+tools\s+Messages\s+Sessions/);
  assert.deepEqual(rows(output), [
    ['2026-09', '$6.00', '$4.00', '$2.00', '1', '1'],
    ['Total', '$6.00', '$4.00', '$2.00', '1', '1'],
  ]);
});

test('tool-only sessions count even failed calls without adding messages', async (t) => {
  const output = await report(t, [[
    toolResult(2, undefined, {
      timestamp: Date.UTC(2026, 8, 1),
      isError: true,
    }),
  ], [
    toolResult(1, '2026-09-01T00:30:00+02:00'),
    toolResult(undefined, '2026-09-01'),
    toolResult(-1, '2026-09-01'),
    toolResult('2', '2026-09-01'),
    toolResult(0, '2026-09-01'),
    toolResult(10, 'invalid'),
  ]], 'no-model-breakdown');
  assert.deepEqual(rows(output), [
    ['2026-09', '$2.00', '0', '1'],
    ['2026-08', '$1.00', '0', '1'],
    ['Total', '$3.00', '0', '2'],
  ]);
});

test('model filters do not attribute pooled tool usage to a model', async (t) => {
  const files = [[
    assistant('gpt', 3, '2026-09-21'),
    toolResult(2, '2026-09-21', {model: 'gpt'}),
  ]];
  assert.deepEqual(rows(await report(t, files, 'gpt')), [
    ['2026-09', '$3.00', '$3.00', '1', '1'],
    ['Total', '$3.00', '$3.00', '1', '1'],
  ]);
  assert.deepEqual(rows(await report(t, files, 'TOOLS')), [
    ['2026-09', '$2.00', '$2.00', '0', '1'],
    ['Total', '$2.00', '$2.00', '0', '1'],
  ]);
});

test('unmatched filters still report no matching models', async (t) => {
  const output = await report(t, mixedFiles, 'missing');
  assert.match(output, /No models matching missing found/);
  assert.deepEqual(rows(output), []);
});

const wideFiles = [[
  assistant('alpha-model-long-name', 3, '2026-09-21'),
  assistant('beta-model-long-name', 2, '2026-09-21'),
  assistant('gamma-model-long-name', 1, '2026-09-21'),
]];

async function inspectUI(t, files, args, inspect) {
  let renders = 0;
  let closes = 0;
  let color = 32;
  await report(t, files, args, {
    hasUI: true,
    ui: {
      notify() {},
      async custom(factory) {
        const component = factory(
          {requestRender: () => renders++},
          {
            fg: (_name, text) => `\x1b[${color}m${text}\x1b[39m`,
            bold: (text) => `\x1b[1m${text}\x1b[22m`,
          },
          {},
          () => closes++,
        );
        await inspect({
          component,
          render(width) {
            const lines = component.render(width);
            for (const line of lines) {
              assert.ok(visibleWidth(line) <= width, `Line exceeds ${width}: ${line}`);
            }
            return lines.map(stripTerminalSequences);
          },
          get renders() { return renders; },
          get closes() { return closes; },
          changeTheme() { color = 35; component.invalidate(); },
        });
      },
    },
  });
}

const keys = {left: '\x1b[D', right: '\x1b[C', home: '\x1b[H', end: '\x1b[F'};
const tableRows = (lines) => lines.filter((line) => /^\s*(Month\s|2026-\d\d\s|Total\s+\$)/.test(line));

test('scrolls by column with Month/Cost frozen, including headers and totals', async (t) => {
  await inspectUI(t, wideFiles, '', (ui) => {
    const initial = ui.render(46);
    const firstRows = tableRows(initial);
    assert.equal(firstRows.length, 3);
    assert.match(firstRows[0], /alpha-model-long-name/);
    assert.match(initial.join('\n'), /Left\/Right: scroll/);
    const frozenWidth = firstRows[0].indexOf('alpha');
    const frozen = firstRows.map((line) => line.slice(0, frozenWidth));

    ui.component.handleInput(keys.right);
    assert.equal(ui.renders, 1);
    const nextRows = tableRows(ui.render(46));
    assert.deepEqual(nextRows.map((line) => line.slice(0, frozenWidth)), frozen);
    assert.match(nextRows[0], /beta-model-long-name/);
    assert.match(nextRows[1].slice(frozenWidth), /\$2\.00/);
    assert.match(nextRows[2].slice(frozenWidth), /\$2\.00/);

    ui.component.handleInput(keys.left);
    assert.deepEqual(ui.render(46), initial);
    ui.component.handleInput(keys.end);
    const endRows = tableRows(ui.render(46));
    assert.deepEqual(endRows.map((line) => line.slice(0, frozenWidth)), frozen);
    assert.match(endRows[0], /Messages\s+Sessions/);
    assert.match(endRows[1], /3\s+1\s*$/);
    const renders = ui.renders;
    ui.component.handleInput(keys.right);
    assert.equal(ui.renders, renders);
    ui.component.handleInput(keys.home);
    assert.deepEqual(ui.render(46), initial);
    ui.component.handleInput(keys.left);
    ui.component.handleInput('x');
    ui.component.handleInput('\r');
    assert.equal(ui.closes, 1);
  });
});

test('clamps scrolling on resize and hides navigation when the table fits', async (t) => {
  await inspectUI(t, wideFiles, '', (ui) => {
    ui.render(46);
    ui.component.handleInput(keys.end);
    const wide = ui.render(160);
    assert.doesNotMatch(wide.join('\n'), /Left\/Right: scroll/);
    assert.match(tableRows(wide)[0], /alpha-model-long-name.*gamma-model-long-name.*Sessions/);
    const renders = ui.renders;
    ui.component.handleInput(keys.right);
    assert.equal(ui.renders, renders);
    assert.match(tableRows(ui.render(46))[0], /alpha-model-long-name/);
    for (const width of [0, 1, 2, 10, 17, 18, 20]) {
      ui.render(width);
      ui.component.handleInput(keys.right);
    }
    assert.match(ui.render(10).join('\n'), /Widen/);
  });
});

test('pages within oversized columns without skipping their contents', async (t) => {
  const name = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  await inspectUI(t, [[assistant(name, 1, '2026-09-21')]], '', (ui) => {
    const initial = tableRows(ui.render(34))[0];
    const start = initial.indexOf('ABC');
    let seen = initial.slice(start).trimEnd();
    for (let step = 0; step < 3; step++) {
      ui.component.handleInput(keys.right);
      seen += tableRows(ui.render(34))[0].slice(start).trimEnd();
    }
    assert.ok(seen.startsWith(name), seen);
    ui.component.handleInput(keys.home);
    assert.equal(tableRows(ui.render(34))[0], initial);
  });
});

test('preserves ANSI styling, handles wide characters, and refreshes the theme', async (t) => {
  await inspectUI(t, [[
    assistant('模型模型模型模型模型模型模型模型模型模型', 3, '2026-09-21'),
    assistant('emoji-🚀-e\u0301-model', 1, '2026-09-21'),
  ]], '', (ui) => {
    for (const width of [19, 20, 21, 33, 48, 100]) {
      ui.render(width);
      ui.component.handleInput(keys.right);
      ui.render(width);
      ui.component.handleInput(keys.end);
      ui.render(width);
      ui.component.handleInput(keys.home);
    }
    assert.ok(ui.component.render(48).some((line) => line.includes('\x1b[32m')));
    ui.changeTheme();
    const updated = ui.component.render(48).join('\n');
    assert.ok(updated.includes('\x1b[35m'));
    assert.ok(!updated.includes('\x1b[32m'));
  });
});

test('keeps filters, totals-only output, empty results, and Escape working', async (t) => {
  await inspectUI(t, wideFiles, 'beta no-model-breakdown', (ui) => {
    const lines = ui.render(100);
    assert.match(lines.join('\n'), /Filtered to models matching: beta/);
    assert.match(tableRows(lines)[1], /2026-09\s+\$2.00\s+1\s+1/);
    assert.doesNotMatch(tableRows(lines)[0], /model/);
    assert.doesNotMatch(lines.join('\n'), /Left\/Right/);
    ui.component.handleInput('\x1b');
    assert.equal(ui.closes, 1);
  });
  await inspectUI(t, wideFiles, 'missing', (ui) => {
    const lines = ui.render(100);
    assert.match(lines.join('\n'), /No models matching missing found/);
    assert.equal(tableRows(lines).length, 0);
    assert.doesNotMatch(lines.join('\n'), /Left\/Right/);
  });
});
