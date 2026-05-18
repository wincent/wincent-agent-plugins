/**
 * Tests for the envelope schema, version stamping, and parseEnvelope.
 *
 * Run with `node --test`. Imports use `.js` extensions so they resolve at
 * runtime under Node's experimental TypeScript support (or via jiti).
 */

import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {
  PROTOCOL_VERSION,
  checkVersion,
  makeEnvelope,
  newEnvelopeId,
  parseEnvelope,
} from '../bus/envelope.js';

test('newEnvelopeId produces unique-looking ids', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    ids.add(newEnvelopeId());
  }
  assert.equal(ids.size, 1000);
});

test('makeEnvelope stamps v=1 and the requested fields', () => {
  const env = makeEnvelope('progress', 'sub', {text: 'hello', kind: 'info'});
  assert.equal(env.v, PROTOCOL_VERSION);
  assert.equal(env.from, 'sub');
  assert.equal(env.type, 'progress');
  assert.equal(env.payload.text, 'hello');
  assert.equal(env.payload.kind, 'info');
  assert.ok(env.id.length > 0);
  assert.ok(env.ts.includes('T'));
});

test('makeEnvelope includes inReplyTo when supplied', () => {
  const env = makeEnvelope(
    'answer',
    'main',
    {text: 'yes'},
    {inReplyTo: 'msg_abc'},
  );
  assert.equal(env.inReplyTo, 'msg_abc');
});

test('parseEnvelope accepts a well-formed envelope', () => {
  const env = makeEnvelope('report', 'sub', {summary: 'done'});
  const roundtrip = parseEnvelope(JSON.parse(JSON.stringify(env)));
  assert.ok(roundtrip);
  assert.equal(roundtrip!.type, 'report');
});

test('parseEnvelope rejects malformed inputs', () => {
  assert.equal(parseEnvelope(null), null);
  assert.equal(parseEnvelope('string'), null);
  assert.equal(parseEnvelope({}), null);
  assert.equal(
    parseEnvelope({
      v: 1,
      id: 'x',
      ts: 't',
      from: 'sub',
      type: 'unknown',
      payload: {},
    }),
    null,
  );
  assert.equal(
    parseEnvelope({
      v: 1,
      id: '',
      ts: 't',
      from: 'sub',
      type: 'progress',
      payload: {},
    }),
    null,
  );
  assert.equal(
    parseEnvelope({
      v: 1,
      id: 'x',
      ts: 't',
      from: 'nobody',
      type: 'progress',
      payload: {},
    }),
    null,
  );
});

test('parseEnvelope accepts known higher v for checkVersion to reject', () => {
  const env = parseEnvelope({
    v: 99,
    id: 'x',
    ts: 't',
    from: 'sub',
    type: 'progress',
    payload: {text: 'x'},
  });
  assert.ok(env);
  const mismatch = checkVersion(env!);
  assert.ok(mismatch?.includes('mismatch'));
});

test('checkVersion accepts the current PROTOCOL_VERSION', () => {
  const env = makeEnvelope('progress', 'sub', {text: 'x'});
  assert.equal(checkVersion(env), null);
});
