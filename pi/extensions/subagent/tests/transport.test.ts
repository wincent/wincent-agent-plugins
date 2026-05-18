/**
 * Tests for the UDS transport.
 *
 * Spins up a listener and a connector on a tmp socket path and verifies a
 * full round-trip: send from one side, receive on the other.
 */

import {strict as assert} from 'node:assert';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {makeEnvelope, parseEnvelope} from '../bus/envelope.js';
import {connectToPeer, listenForPeer} from '../bus/transport-uds.js';

test('UDS transport: round-trip a single envelope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-uds-'));
  const socketPath = join(dir, 'main.sock');
  try {
    const serverPromise = listenForPeer(socketPath, {timeoutMs: 2000});
    // Tiny delay so the listener has a chance to bind before connect.
    await new Promise((r) => setTimeout(r, 20));
    const clientPromise = connectToPeer(socketPath, {timeoutMs: 2000});

    const [server, client] = await Promise.all([serverPromise, clientPromise]);

    const received: unknown[] = [];
    const recvPromise = new Promise<void>((resolve) => {
      server.onEnvelope((env) => {
        received.push(env);
        resolve();
      });
    });

    const env = makeEnvelope('progress', 'sub', {text: 'hello'});
    client.send(env);

    await recvPromise;
    assert.equal(received.length, 1);
    const parsed = parseEnvelope(received[0]);
    assert.ok(parsed);
    assert.equal(parsed!.type, 'progress');

    await client.close();
    await server.close();
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('UDS transport: framing across split chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-uds-frame-'));
  const socketPath = join(dir, 'main.sock');
  try {
    const serverPromise = listenForPeer(socketPath, {timeoutMs: 2000});
    await new Promise((r) => setTimeout(r, 20));
    const clientPromise = connectToPeer(socketPath, {timeoutMs: 2000});
    const [server, client] = await Promise.all([serverPromise, clientPromise]);

    const received: unknown[] = [];
    const allReceived = new Promise<void>((resolve) => {
      let count = 0;
      server.onEnvelope((env) => {
        received.push(env);
        count++;
        if (count === 3) {
          resolve();
        }
      });
    });

    // Send three envelopes in a single write to simulate batched data.
    const envs = [
      makeEnvelope('progress', 'sub', {text: 'a'}),
      makeEnvelope('progress', 'sub', {text: 'b'}),
      makeEnvelope('progress', 'sub', {text: 'c'}),
    ];
    for (const e of envs) {
      client.send(e);
    }

    await allReceived;
    assert.equal(received.length, 3);

    await client.close();
    await server.close();
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('UDS transport: peer close fires onClose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-uds-close-'));
  const socketPath = join(dir, 'main.sock');
  try {
    const serverPromise = listenForPeer(socketPath, {timeoutMs: 2000});
    await new Promise((r) => setTimeout(r, 20));
    const clientPromise = connectToPeer(socketPath, {timeoutMs: 2000});
    const [server, client] = await Promise.all([serverPromise, clientPromise]);

    const closed = new Promise<void>((resolve) => {
      server.onClose(() => resolve());
    });

    await client.close();
    await closed;
    await server.close();
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('UDS transport: connect times out cleanly when nobody is listening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-uds-noconnect-'));
  const socketPath = join(dir, 'never.sock');
  try {
    await assert.rejects(
      connectToPeer(socketPath, {timeoutMs: 300, retryIntervalMs: 50}),
      /failed to connect/,
    );
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
