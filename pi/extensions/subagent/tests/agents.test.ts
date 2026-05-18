/**
 * Tests for agent .md discovery and frontmatter parsing.
 */

import {strict as assert} from 'node:assert';
import {mkdir, writeFile} from 'node:fs/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const TMP = tmpdir();

import {discoverAgents} from '../main/agents.js';

async function withTempPiAgentDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-agents-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await mkdir(join(dir, 'agents'), {recursive: true});
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    await rm(dir, {recursive: true, force: true});
  }
}

test('discoverAgents loads a user agent with required frontmatter', async () => {
  await withTempPiAgentDir(async (dir) => {
    await writeFile(
      join(dir, 'agents', 'scout.md'),
      [
        '---',
        'description: Read-only recon',
        'tools: read, grep, find, ls, bash',
        '---',
        '',
        'You are a scout.',
        '',
      ].join('\n'),
    );
    const result = discoverAgents(TMP);
    const scout = result.agents.find((a) => a.name === 'scout');
    assert.ok(scout);
    assert.equal(scout!.description, 'Read-only recon');
    assert.deepEqual(scout!.tools, ['read', 'grep', 'find', 'ls', 'bash']);
    assert.equal(scout!.placement, 'split-right');
    assert.equal(scout!.worktree, false);
    assert.equal(scout!.closeOnSuccess, true);
    assert.equal(scout!.source, 'user');
  });
});

test('discoverAgents respects placement / worktree / close_on_success overrides', async () => {
  await withTempPiAgentDir(async (dir) => {
    await writeFile(
      join(dir, 'agents', 'worker.md'),
      [
        '---',
        'description: Worker',
        'tools: read, write, edit, bash, grep, find, ls',
        'placement: window-detached',
        'worktree: true',
        'close_on_success: false',
        '---',
        'Body.',
      ].join('\n'),
    );
    const result = discoverAgents(TMP);
    const worker = result.agents.find((a) => a.name === 'worker');
    assert.ok(worker);
    assert.equal(worker!.placement, 'window-detached');
    assert.equal(worker!.worktree, true);
    assert.equal(worker!.closeOnSuccess, false);
  });
});

test('discoverAgents skips files missing required fields', async () => {
  await withTempPiAgentDir(async (dir) => {
    await writeFile(
      join(dir, 'agents', 'nofields.md'),
      ['---', 'description: but no tools', '---', 'Body.'].join('\n'),
    );
    const result = discoverAgents(TMP);
    assert.equal(result.agents.find((a) => a.name === 'nofields'), undefined);
  });
});

test('discoverAgents reads disallowed_tools', async () => {
  await withTempPiAgentDir(async (dir) => {
    await writeFile(
      join(dir, 'agents', 'limited.md'),
      [
        '---',
        'description: Limited tools',
        'tools: read, grep, bash',
        'disallowed_tools: bash, edit',
        '---',
        'Body.',
      ].join('\n'),
    );
    const result = discoverAgents(TMP);
    const limited = result.agents.find((a) => a.name === 'limited');
    assert.ok(limited);
    assert.deepEqual(limited!.disallowedTools, ['bash', 'edit']);
  });
});
