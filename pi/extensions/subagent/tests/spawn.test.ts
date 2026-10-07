import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {type SpawnArgs, renderWrapper} from '../main/spawn.js';

/** Run the real wrapper against a fake pi executable, without tmux or an LLM. */
function capturePiArgs(
  model?: SpawnArgs['model'],
  launcher?: string,
): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-spawn-'));
  const previous = process.env.PI_SUBAGENT_LAUNCHER;
  try {
    // Write only the binary the wrapper is expected to exec, so a test fails
    // loudly if the launcher is ignored rather than silently falling back.
    writeFileSync(
      join(dir, launcher ?? 'pi'),
      '#!/bin/sh\nprintf \'%s\\0\' "$@"\n',
      {mode: 0o700},
    );
    if (launcher) {
      process.env.PI_SUBAGENT_LAUNCHER = launcher;
    } else {
      delete process.env.PI_SUBAGENT_LAUNCHER;
    }
    writeFileSync(join(dir, 'task.txt'), 'Inspect the code');
    const args: SpawnArgs = {
      taskId: 'task_test',
      taskDir: dir,
      task: 'Inspect the code',
      parentId: 'pi-main-test',
      cwd: dir,
      agentName: 'scout',
      model,
      toolsWhitelist: ['read', 'bash'],
      systemPromptPath: join(dir, 'system-prompt.md'),
      placement: 'split-right',
    };
    const wrapperPath = join(dir, 'run.sh');
    writeFileSync(wrapperPath, renderWrapper(args));
    const stdout = execFileSync('bash', [wrapperPath], {
      encoding: 'utf-8',
      env: {...process.env, PATH: `${dir}:${process.env.PATH}`},
    });
    return stdout.split('\0').slice(0, -1);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_SUBAGENT_LAUNCHER;
    } else {
      process.env.PI_SUBAGENT_LAUNCHER = previous;
    }
    rmSync(dir, {recursive: true, force: true});
  }
}

test('wrapper passes the main provider and exact model ID to pi', () => {
  const args = capturePiArgs({provider: 'openai-codex', id: 'gpt-6-astra'});
  const providerIndex = args.indexOf('--provider');
  assert.notEqual(providerIndex, -1);
  assert.deepEqual(args.slice(providerIndex, providerIndex + 4), [
    '--provider',
    'openai-codex',
    '--model',
    'gpt-6-astra',
  ]);
  assert.equal(args[0], 'Inspect the code');
  assert.equal(
    args[args.indexOf('--tools') + 1],
    'read,bash,report,progress,ask',
  );
  assert.ok(args.includes('--no-session'));
});

test('wrapper preserves shell metacharacters and slashes in provider and model', () => {
  const model = {
    provider: "custom provider's $(echo unsafe)",
    id: "org/model's name:tag; `echo unsafe` $HOME",
  };
  const args = capturePiArgs(model);
  assert.equal(args[args.indexOf('--provider') + 1], model.provider);
  assert.equal(args[args.indexOf('--model') + 1], model.id);
});

test('wrapper leaves model selection to pi when the main context has no model', () => {
  const args = capturePiArgs();
  assert.ok(!args.includes('--provider'));
  assert.ok(!args.includes('--model'));
});

test('wrapper execs the launcher named by PI_SUBAGENT_LAUNCHER', () => {
  const args = capturePiArgs(undefined, 'pi-naked');
  assert.equal(args[0], 'Inspect the code');
});
