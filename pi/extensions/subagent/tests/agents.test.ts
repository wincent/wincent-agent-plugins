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

test('discoverAgents leaves askPolicy undefined when not set in frontmatter', async () => {
  await withTempPiAgentDir(async (dir) => {
    await writeFile(
      join(dir, 'agents', 'plain.md'),
      ['---', 'description: Plain agent', 'tools: read', '---', 'Body.'].join(
        '\n',
      ),
    );
    const result = discoverAgents(TMP);
    const plain = result.agents.find((a) => a.name === 'plain');
    assert.ok(plain);
    assert.equal(plain!.askPolicy, undefined);
  });
});

test('discoverAgents parses each valid ask_policy value', async () => {
  await withTempPiAgentDir(async (dir) => {
    for (const value of ['human', 'deny', 'llm'] as const) {
      await writeFile(
        join(dir, 'agents', `${value}.md`),
        [
          '---',
          `description: Agent with ${value} policy`,
          'tools: read',
          `ask_policy: ${value}`,
          '---',
          'Body.',
        ].join('\n'),
      );
    }
    const result = discoverAgents(TMP);
    const human = result.agents.find((a) => a.name === 'human');
    const deny = result.agents.find((a) => a.name === 'deny');
    const llm = result.agents.find((a) => a.name === 'llm');
    assert.ok(human);
    assert.ok(deny);
    assert.ok(llm);
    assert.equal(human!.askPolicy, 'human');
    assert.equal(deny!.askPolicy, 'deny');
    assert.equal(llm!.askPolicy, 'llm');
  });
});

test('discoverAgents normalises mixed-case ask_policy values', async () => {
  await withTempPiAgentDir(async (dir) => {
    await writeFile(
      join(dir, 'agents', 'shouty.md'),
      [
        '---',
        'description: Shouty agent',
        'tools: read',
        'ask_policy: DENY',
        '---',
        'Body.',
      ].join('\n'),
    );
    const result = discoverAgents(TMP);
    const shouty = result.agents.find((a) => a.name === 'shouty');
    assert.ok(shouty);
    assert.equal(shouty!.askPolicy, 'deny');
  });
});

test('discoverAgents drops invalid ask_policy values', async () => {
  await withTempPiAgentDir(async (dir) => {
    await writeFile(
      join(dir, 'agents', 'weird.md'),
      [
        '---',
        'description: Weird agent',
        'tools: read',
        'ask_policy: telepathy',
        '---',
        'Body.',
      ].join('\n'),
    );
    const result = discoverAgents(TMP);
    const weird = result.agents.find((a) => a.name === 'weird');
    assert.ok(weird);
    assert.equal(weird!.askPolicy, undefined);
  });
});
