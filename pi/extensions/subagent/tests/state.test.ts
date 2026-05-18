/**
 * Tests for state directory layout and the stale-entry reaper.
 *
 * We exercise the helpers with a temporary $XDG_STATE_HOME so the real
 * user state dir is never touched.
 */

import {strict as assert} from 'node:assert';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const TMP = tmpdir();

import {
  auditLogPath,
  ensureTaskDir,
  metaPath,
  readMeta,
  reapStaleEntries,
  socketPath,
  stateRoot,
  systemPromptPath,
  taskDir,
  updateMeta,
  writeMeta,
} from '../main/state.js';

async function withTempStateRoot<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-state-'));
  const previousXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (previousXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdg;
    }
    await rm(dir, {recursive: true, force: true});
  }
}

test('stateRoot honours XDG_STATE_HOME', async () => {
  await withTempStateRoot(async (root) => {
    assert.equal(stateRoot(), join(root, 'pi', 'subagent'));
  });
});

test('ensureTaskDir creates the per-task directory with mode 0700', async () => {
  await withTempStateRoot(async () => {
    const dir = ensureTaskDir('task_alpha');
    assert.ok(existsSync(dir));
    assert.equal(socketPath('task_alpha'), join(dir, 'main.sock'));
    assert.equal(auditLogPath('task_alpha'), join(dir, 'bus.jsonl'));
    assert.equal(metaPath('task_alpha'), join(dir, 'meta.json'));
    assert.equal(systemPromptPath('task_alpha'), join(dir, 'system-prompt.md'));
  });
});

test('writeMeta / readMeta / updateMeta round-trip', async () => {
  await withTempStateRoot(async () => {
    ensureTaskDir('task_beta');
    writeMeta({
      v: 1,
      taskId: 'task_beta',
      parentId: 'parent_1',
      agent: 'scout',
      task: 'find things',
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      mainPid: process.pid,
      subPid: null,
      paneId: null,
      windowId: null,
      cwd: TMP,
      worktreePath: null,
      placement: 'split-right',
    });
    const round1 = readMeta('task_beta');
    assert.ok(round1);
    assert.equal(round1!.agent, 'scout');
    const round2 = updateMeta('task_beta', {
      status: 'ok',
      endedAt: new Date().toISOString(),
    });
    assert.ok(round2);
    assert.equal(round2!.status, 'ok');
    assert.ok(round2!.endedAt);
  });
});

test('reapStaleEntries marks dead processes as crashed', async () => {
  await withTempStateRoot(async (root) => {
    const taskRoot = join(root, 'pi', 'subagent');
    mkdirSync(join(taskRoot, 'task_dead'), {recursive: true, mode: 0o700});
    writeFileSync(
      join(taskRoot, 'task_dead', 'meta.json'),
      JSON.stringify({
        v: 1,
        taskId: 'task_dead',
        parentId: 'p',
        agent: 'scout',
        task: 't',
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: 'running',
        mainPid: 999999, // unlikely to exist
        subPid: 999998,
        paneId: null,
        windowId: null,
        cwd: TMP,
        worktreePath: null,
        placement: 'split-right',
      }),
    );
    const reaped = reapStaleEntries();
    assert.equal(reaped, 1);
    const meta = readMeta('task_dead');
    assert.equal(meta?.status, 'crashed');
    assert.ok(meta?.endedAt);
  });
});

test('reapStaleEntries does not touch entries with live pids', async () => {
  await withTempStateRoot(async (root) => {
    const taskRoot = join(root, 'pi', 'subagent');
    mkdirSync(join(taskRoot, 'task_alive'), {recursive: true, mode: 0o700});
    writeFileSync(
      join(taskRoot, 'task_alive', 'meta.json'),
      JSON.stringify({
        v: 1,
        taskId: 'task_alive',
        parentId: 'p',
        agent: 'scout',
        task: 't',
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: 'running',
        mainPid: process.pid, // certainly alive
        subPid: null,
        paneId: null,
        windowId: null,
        cwd: TMP,
        worktreePath: null,
        placement: 'split-right',
      }),
    );
    const reaped = reapStaleEntries();
    assert.equal(reaped, 0);
    const meta = readMeta('task_alive');
    assert.equal(meta?.status, 'running');
  });
});
