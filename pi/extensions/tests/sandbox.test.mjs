import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import extension from '../sandbox.ts';

function setup(t) {
  for (const key of ['SB_SANDBOX', 'NONO_CAP_FILE']) {
    const original = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    });
  }
  const handlers = new Map();
  const statuses = new Map([['ocr-approval', 'OCR ✔']]);
  extension({on: (event, handler) => handlers.set(event, handler)});
  const ctx = {
    mode: 'tui',
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      theme: {
        fg: (color, text) => {
          assert.equal(color, 'dim');
          return `dim(${text})`;
        },
      },
    },
  };
  return {start: () => handlers.get('session_start')({}, ctx), ctx, statuses};
}

test('shows a dimmed VM indicator, taking precedence over NONO_CAP_FILE', (t) => {
  const {start, statuses} = setup(t);
  process.env.SB_SANDBOX = '1';
  for (const value of [undefined, '/nonexistent/nono-capabilities.json']) {
    if (value !== undefined) {
      process.env.NONO_CAP_FILE = value;
    }
    start();
    assert.equal(statuses.get('sandbox'), 'dim(VM ✔)');
    assert.equal(statuses.get('ocr-approval'), 'OCR ✔');
  }
});

test('falls back to the sandbox indicator when SB_SANDBOX is empty', (t) => {
  const {start, statuses} = setup(t);
  process.env.SB_SANDBOX = '';
  process.env.NONO_CAP_FILE = '/nonexistent/nono-capabilities.json';
  start();
  assert.equal(statuses.get('sandbox'), 'dim(Sandbox ✔)');
});

test('shows a dimmed sandbox indicator based only on a non-empty environment variable', (t) => {
  const {start, statuses} = setup(t);
  process.env.NONO_CAP_FILE = '/nonexistent/nono-capabilities.json';
  start();
  assert.equal(statuses.get('sandbox'), 'dim(Sandbox ✔)');
  assert.equal(statuses.get('ocr-approval'), 'OCR ✔');
});

test('clears the sandbox indicator when the variable is empty or unset', (t) => {
  const {start, statuses} = setup(t);
  for (const value of ['', undefined]) {
    process.env.NONO_CAP_FILE = '/nonexistent/nono-capabilities.json';
    start();
    assert.equal(statuses.get('sandbox'), 'dim(Sandbox ✔)');
    if (value === undefined) {
      delete process.env.NONO_CAP_FILE;
    } else {
      process.env.NONO_CAP_FILE = value;
    }
    start();
    assert.equal(statuses.get('sandbox'), undefined);
    assert.equal(statuses.get('ocr-approval'), 'OCR ✔');
  }
});

test('does not access the UI outside TUI mode', (t) => {
  const {start, ctx} = setup(t);
  process.env.SB_SANDBOX = '1';
  process.env.NONO_CAP_FILE = '/nonexistent/nono-capabilities.json';
  delete ctx.ui;
  for (const mode of ['rpc', 'json', 'print']) {
    ctx.mode = mode;
    assert.doesNotThrow(start);
  }
});
