/**
 * Integration test for the bus protocol.
 *
 * Stands up a main-side Bus + audit log on a tmp socket, then opens a
 * sub-side Bus on the same socket (in the same process) and exercises
 * the request/reply, progress streaming, and graceful shutdown flow.
 *
 * Does NOT involve a real pi subprocess or tmux. The full end-to-end
 * exercise (real `pi -p` spawned in a tmux pane) is checked manually.
 */

import {strict as assert} from 'node:assert';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {AuditLog} from '../bus/audit-log.js';
import {Bus} from '../bus/bus.js';
import type {Envelope} from '../bus/envelope.js';
import {connectToPeer, listenForPeer} from '../bus/transport-uds.js';

test('integration: progress -> report -> done flow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-integration-'));
  const socketPath = join(dir, 'main.sock');
  try {
    // Main side starts listening.
    const serverPromise = listenForPeer(socketPath, {timeoutMs: 3000});

    // Slight delay so listen wins the race, like the real spawn flow.
    await new Promise((r) => setTimeout(r, 20));

    // Sub side connects.
    const subTransport = await connectToPeer(socketPath, {timeoutMs: 3000});
    const subBus = new Bus(
      subTransport,
      new AuditLog(join(dir, 'bus-sub.jsonl')),
      'sub',
    );

    // Main side accepts the connection.
    const mainTransport = await serverPromise;
    const mainBus = new Bus(
      mainTransport,
      new AuditLog(join(dir, 'bus-main.jsonl')),
      'main',
    );

    const received: Envelope[] = [];
    mainBus.subscribe((env) => {
      received.push(env);
    });

    const doneSeen = new Promise<void>((resolve) => {
      mainBus.subscribe((env) => {
        if (env.type === 'done') {
          resolve();
        }
      });
    });

    // Sub side: simulate a worker.
    subBus.emit('progress', {text: 'starting'});
    subBus.emit('progress', {text: 'doing work'});
    subBus.emit('report', {
      summary: 'found 3 issues',
      findings: [
        {severity: 'warning', message: 'unused import', file: 'a.ts', line: 1},
        {severity: 'error', message: 'null deref', file: 'b.ts', line: 42},
        {severity: 'info', message: 'todo comment', file: 'c.ts', line: 10},
      ],
    });
    subBus.emit('done', {status: 'ok', finalText: 'all clear'});

    await doneSeen;

    const types = received.map((e) => e.type);
    assert.deepEqual(types, ['progress', 'progress', 'report', 'done']);

    const reportEnv = received.find((e) => e.type === 'report');
    assert.ok(reportEnv);
    if (reportEnv?.type === 'report') {
      assert.equal(reportEnv.payload.summary, 'found 3 issues');
      assert.equal(reportEnv.payload.findings?.length, 3);
    }

    await subBus.close();
    await mainBus.close();

    // Audit logs should record both directions for both sides.
    const mainLog = await readFile(join(dir, 'bus-main.jsonl'), 'utf-8');
    const subLog = await readFile(join(dir, 'bus-sub.jsonl'), 'utf-8');
    assert.ok(mainLog.split('\n').filter((l) => l.length > 0).length >= 4);
    assert.ok(subLog.split('\n').filter((l) => l.length > 0).length >= 4);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('integration: ask/answer round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-integration-ask-'));
  const socketPath = join(dir, 'main.sock');
  try {
    const serverPromise = listenForPeer(socketPath, {timeoutMs: 3000});
    await new Promise((r) => setTimeout(r, 20));
    const subTransport = await connectToPeer(socketPath, {timeoutMs: 3000});
    const subBus = new Bus(
      subTransport,
      new AuditLog(join(dir, 'bus-sub.jsonl')),
      'sub',
    );
    const mainTransport = await serverPromise;
    const mainBus = new Bus(
      mainTransport,
      new AuditLog(join(dir, 'bus-main.jsonl')),
      'main',
    );

    // Main side answers any ask with a fixed value.
    mainBus.subscribe((env) => {
      if (env.type === 'ask') {
        mainBus.emit('answer', {text: '42'}, {inReplyTo: env.id});
      }
    });

    const reply = await subBus.request(
      'ask',
      {question: 'meaning of life?'},
      {timeoutMs: 1000},
    );
    assert.equal(reply.type, 'answer');
    if (reply.type === 'answer') {
      assert.equal(reply.payload.text, '42');
    }

    await subBus.close();
    await mainBus.close();
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('integration: peer close without done is observed by the other side', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-integration-close-'));
  const socketPath = join(dir, 'main.sock');
  try {
    const serverPromise = listenForPeer(socketPath, {timeoutMs: 3000});
    await new Promise((r) => setTimeout(r, 20));
    const subTransport = await connectToPeer(socketPath, {timeoutMs: 3000});
    const subBus = new Bus(
      subTransport,
      new AuditLog(join(dir, 'bus-sub.jsonl')),
      'sub',
    );
    const mainTransport = await serverPromise;
    const mainBus = new Bus(
      mainTransport,
      new AuditLog(join(dir, 'bus-main.jsonl')),
      'main',
    );

    const closeObserved = new Promise<void>((resolve) => {
      mainBus.onPeerClose(() => resolve());
    });

    // Sub side: closes without emitting `done`.
    await subBus.close();

    await closeObserved;

    await mainBus.close();
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
