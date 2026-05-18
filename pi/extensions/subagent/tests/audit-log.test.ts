/**
 * Tests for the audit log writer.
 *
 * Verifies that:
 * - Writes are line-terminated JSON.
 * - Concurrent appends don't interleave bytes within a single envelope.
 */

import {strict as assert} from 'node:assert';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {AuditLog} from '../bus/audit-log.js';
import {makeEnvelope} from '../bus/envelope.js';

test('AuditLog appends line-terminated JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-audit-'));
  try {
    const log = new AuditLog(join(dir, 'bus.jsonl'));
    const env = makeEnvelope('progress', 'sub', {text: 'hello'});
    await log.append(env, 'send');
    await log.flush();
    const content = await readFile(join(dir, 'bus.jsonl'), 'utf-8');
    const lines = content.split('\n');
    assert.equal(lines.length, 2); // one entry + trailing empty
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.direction, 'send');
    assert.equal(parsed.type, 'progress');
    assert.equal(parsed.payload.text, 'hello');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('AuditLog serializes concurrent writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-audit-concurrent-'));
  try {
    const log = new AuditLog(join(dir, 'bus.jsonl'));
    const count = 50;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      writes.push(
        log.append(makeEnvelope('progress', 'sub', {text: `${i}`}), 'send'),
      );
    }
    await Promise.all(writes);
    const content = await readFile(join(dir, 'bus.jsonl'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, count);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.payload.text, 'string');
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
