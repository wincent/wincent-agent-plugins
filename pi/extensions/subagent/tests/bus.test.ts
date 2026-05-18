/**
 * Tests for the high-level Bus API: multi-subscriber, request/reply,
 * version-mismatch handling, audit-log tee.
 */

import {strict as assert} from 'node:assert';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {AuditLog} from '../bus/audit-log.js';
import {Bus} from '../bus/bus.js';
import type {Envelope} from '../bus/envelope.js';
import {makeEnvelope} from '../bus/envelope.js';
import {connectToPeer, listenForPeer} from '../bus/transport-uds.js';

async function makeBusPair(): Promise<{
  main: Bus;
  sub: Bus;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-bus-'));
  const socketPath = join(dir, 'main.sock');
  const serverPromise = listenForPeer(socketPath, {timeoutMs: 2000});
  await new Promise((r) => setTimeout(r, 20));
  const clientPromise = connectToPeer(socketPath, {timeoutMs: 2000});
  const [serverT, clientT] = await Promise.all([serverPromise, clientPromise]);

  const main = new Bus(
    serverT,
    new AuditLog(join(dir, 'bus-main.jsonl')),
    'main',
  );
  const sub = new Bus(clientT, new AuditLog(join(dir, 'bus-sub.jsonl')), 'sub');

  return {
    main,
    sub,
    dir,
    cleanup: async () => {
      await sub.close();
      await main.close();
      await rm(dir, {recursive: true, force: true});
    },
  };
}

test('Bus: emit and subscribe round-trip', async () => {
  const {main, sub, cleanup} = await makeBusPair();
  try {
    const received: Envelope[] = [];
    const done = new Promise<void>((resolve) => {
      main.subscribe((env) => {
        received.push(env);
        resolve();
      });
    });
    sub.emit('progress', {text: 'hi'});
    await done;
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'progress');
  } finally {
    await cleanup();
  }
});

test('Bus: multi-subscriber dispatch', async () => {
  const {main, sub, cleanup} = await makeBusPair();
  try {
    const a: Envelope[] = [];
    const b: Envelope[] = [];
    main.subscribe((env) => a.push(env));
    main.subscribe((env) => b.push(env));
    sub.emit('progress', {text: 'one'});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  } finally {
    await cleanup();
  }
});

test('Bus: request/reply via inReplyTo', async () => {
  const {main, sub, cleanup} = await makeBusPair();
  try {
    sub.subscribe((env) => {
      if (env.type === 'ask') {
        sub.emit('answer', {text: `re: ${env.payload.question}`}, {
          inReplyTo: env.id,
        });
      }
    });
    const reply = await main.request('ask', {question: 'what?'}, {
      timeoutMs: 1000,
    });
    assert.equal(reply.type, 'answer');
    if (reply.type === 'answer') {
      assert.equal(reply.payload.text, 're: what?');
    }
  } finally {
    await cleanup();
  }
});

test('Bus: request times out when no reply comes', async () => {
  const {main, cleanup} = await makeBusPair();
  try {
    await assert.rejects(
      main.request('ask', {question: 'hello?'}, {timeoutMs: 100}),
      /timed out/,
    );
  } finally {
    await cleanup();
  }
});

test('Bus: audit log captures both directions', async () => {
  const {main, sub, dir, cleanup} = await makeBusPair();
  try {
    const done = new Promise<void>((resolve) => {
      main.subscribe(() => resolve());
    });
    sub.emit('progress', {text: 'audited'});
    await done;
    await sub.close();
    await main.close();
    const mainLog = await readFile(join(dir, 'bus-main.jsonl'), 'utf-8');
    const subLog = await readFile(join(dir, 'bus-sub.jsonl'), 'utf-8');
    assert.ok(mainLog.includes('"direction":"recv"'));
    assert.ok(subLog.includes('"direction":"send"'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('Bus: unknown version is warned and dropped', async () => {
  const {main, sub, cleanup} = await makeBusPair();
  try {
    const warnings: string[] = [];
    // Replace the warn handler by constructing a fresh Bus on the same
    // transport: easier to instead capture stderr writes. Simplest: use
    // the constructor option directly by re-creating main.
    // The pair we already have is fine; just send an envelope with
    // tampered v on the wire.
    const received: Envelope[] = [];
    main.subscribe((env) => received.push(env));

    // Bypass the typed emit to send a v=99 envelope.
    (sub as unknown as {transport: {send: (env: object) => void}}).transport
      .send({
        v: 99,
        id: 'msg_bad',
        ts: new Date().toISOString(),
        from: 'sub',
        type: 'progress',
        payload: {text: 'should be dropped'},
      } as never);

    // Also send a well-formed envelope so we can observe that bad ones don't
    // appear before good ones.
    await new Promise((r) => setTimeout(r, 50));
    sub.emit('progress', {text: 'good'});
    await new Promise((r) => setTimeout(r, 100));

    // Bad envelope must not have reached the subscriber.
    const types = received.map((e) => e.type);
    assert.equal(received.length, 1);
    assert.deepEqual(types, ['progress']);
    if (received[0].type === 'progress') {
      assert.equal(received[0].payload.text, 'good');
    }
    // No assertion on warnings text; we'd need a custom Bus instance to
    // observe it, and the default writes to stderr.
    void warnings;
  } finally {
    await cleanup();
  }
});
