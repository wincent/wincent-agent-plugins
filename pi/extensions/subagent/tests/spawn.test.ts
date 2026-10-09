import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {AuditLog} from '../bus/audit-log.js';
import {Bus} from '../bus/bus.js';
import {launchSubagent} from '../main/launch.js';
import {cancelTask, observeTask} from '../main/lifecycle.js';
import {type ActiveTask, trackBus} from '../main/registry.js';
import {
  type SpawnArgs,
  type SpawnedProcess,
  renderWrapper,
  spawnSubagent,
  terminateProcess,
} from '../main/spawn.js';

function argsFor(dir: string, task = 'Inspect the code'): SpawnArgs {
  return {
    taskId: 'task_test',
    taskDir: dir,
    socketPath: join(dir, 's'),
    task,
    parentId: 'pi-main-test',
    cwd: dir,
    toolsWhitelist: ['read', 'bash'],
    systemPromptPath: join(dir, 'system-prompt.md'),
  };
}

function capturePiArgs(
  overrides: Partial<SpawnArgs> = {},
  launcher?: string,
): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'sa-'));
  const previous = process.env.PI_SUBAGENT_LAUNCHER;
  try {
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
    const args = {...argsFor(dir), ...overrides};
    writeFileSync(join(dir, 'task.txt'), args.task);
    const wrapperPath = join(dir, 'run.sh');
    writeFileSync(wrapperPath, renderWrapper(args));
    return execFileSync('bash', [wrapperPath], {
      encoding: 'utf-8',
      env: {...process.env, PATH: `${dir}:${process.env.PATH}`},
    }).split('\0').slice(0, -1);
  } finally {
    restoreEnv('PI_SUBAGENT_LAUNCHER', previous);
    rmSync(dir, {recursive: true, force: true});
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test('wrapper passes the exact model and thinking level in headless mode', () => {
  const args = capturePiArgs({
    model: {provider: 'openai-codex', id: 'gpt-6-astra'},
    thinkingLevel: 'high',
  });
  assert.deepEqual(
    args.slice(args.indexOf('--provider'), args.indexOf('--provider') + 6),
    [
      '--provider',
      'openai-codex',
      '--model',
      'gpt-6-astra',
      '--thinking',
      'high',
    ],
  );
  assert.equal(args[0], '-p');
  assert.equal(args.at(-1), 'Inspect the code');
  assert.equal(
    args[args.indexOf('--tools') + 1],
    'read,bash,report,progress,ask',
  );
  assert.ok(args.includes('--no-session'));
});

test('wrapper preserves shell metacharacters and option-like prompts', () => {
  const model = {
    provider: "custom provider's $(echo unsafe)",
    id: "org/model's name:tag; `echo unsafe` $HOME",
  };
  const args = capturePiArgs({model, task: '--model unwanted; $(echo unsafe)'});
  assert.equal(args[args.indexOf('--provider') + 1], model.provider);
  assert.equal(args[args.indexOf('--model') + 1], model.id);
  assert.deepEqual(args.slice(-2), ['--', '--model unwanted; $(echo unsafe)']);
});

test('wrapper leaves model selection to Pi if no model is provided', () => {
  const args = capturePiArgs();
  assert.ok(!args.includes('--provider'));
  assert.ok(!args.includes('--model'));
});

test('wrapper execs the launcher named by PI_SUBAGENT_LAUNCHER', () => {
  assert.equal(capturePiArgs({}, 'pi-naked').at(-1), 'Inspect the code');
});

test('wrapper applies the denylist without excluding runtime bus tools', () => {
  const args = capturePiArgs({disallowedTools: ['bash']});
  assert.equal(args[args.indexOf('--exclude-tools') + 1], 'bash');
  assert.throws(
    () => capturePiArgs({disallowedTools: ['report']}),
    /must not exclude/,
  );
});

async function withChild(
  mode: string,
  fn: (dir: string, task: ActiveTask) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-'));
  const previous = process.env.PI_SUBAGENT_LAUNCHER;
  const previousTmux = process.env.TMUX;
  process.env.PI_SUBAGENT_LAUNCHER = `${process.execPath} '${
    fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url))
  }'`;
  delete process.env.TMUX;
  let child: SpawnedProcess | undefined;
  let bus: Bus | undefined;
  try {
    const launched = await launchSubagent(argsFor(dir, mode), {
      connectTimeoutMs: 3_000,
      killGraceMs: 100,
    });
    child = launched.process;
    bus = new Bus(
      launched.transport,
      new AuditLog(join(dir, 'bus.jsonl')),
      'main',
    );
    const task: ActiveTask = {
      taskId: 'task_test',
      agentName: 'scout',
      task: mode,
      process: child,
      bus,
      mode: 'sync',
      worktreePath: null,
      startedAt: Date.now(),
      cleanup: [],
      status: 'running',
      askPolicy: 'deny',
      llmAnswersSinceEscalation: 0,
      llmAnswersTotal: 0,
    };
    await fn(dir, task);
  } finally {
    if (child) {
      await terminateProcess(child, 0, 100);
    }
    await bus?.close();
    restoreEnv('PI_SUBAGENT_LAUNCHER', previous);
    restoreEnv('TMUX', previousTmux);
    rmSync(dir, {recursive: true, force: true});
  }
}

test(
  'direct child captures private logs and completion waits for process exit',
  {timeout: 5_000},
  async () => {
    await withChild('normal', async (dir, task) => {
      const started = Date.now();
      trackBus(task);
      const doneStatuses: string[] = [];
      task.bus.subscribe((env) => {
        if (env.type === 'done') {
          doneStatuses.push(task.status);
        }
      });
      const outcome = await observeTask(task, {
        exitGraceMs: 500,
        killGraceMs: 100,
      });
      assert.equal(outcome.status, 'ok');
      assert.deepEqual(doneStatuses, ['finalizing']);
      assert.equal(
        task.status,
        'finalizing',
        'process settlement cannot publish terminal task success',
      );
      assert.equal(outcome.exit?.code, 0);
      assert.equal(outcome.processExited, true);
      assert.equal(outcome.processGroupExited, true);
      assert.ok(Date.now() - started >= 100);
      assert.match(readFileSync(task.process.stdoutPath, 'utf8'), /task_test/);
      assert.match(
        readFileSync(task.process.stderrPath, 'utf8'),
        /fake diagnostic/,
      );
      for (const name of ['stdout.log', 'stderr.log', 'task.txt']) {
        assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
      }
      task.process.signal('SIGKILL'); // no-op after observing exit
      await task.bus.close();
      const {socketPath} = JSON.parse(
        readFileSync(join(dir, 'socket-env.json'), 'utf8'),
      );
      assert.ok(!existsSync(dirname(socketPath)));
    });
  },
);

test('an observed leader exit is separate from unverified group cleanup', {
  timeout: 5_000,
}, async () => {
  await withChild('normal', async (_dir, task) => {
    await task.process.exited;
    const original = task.process.isGroupAlive;
    task.process.isGroupAlive = () => true;
    try {
      const outcome = await observeTask(task, {
        exitGraceMs: 20,
        killGraceMs: 20,
      });
      assert.equal(outcome.status, 'crashed');
      assert.equal(outcome.processExited, true);
      assert.equal(outcome.processGroupExited, false);
      assert.equal(
        outcome.exit,
        undefined,
        'a leader exit alone must not permit worktree finalization',
      );
    } finally {
      task.process.isGroupAlive = original;
    }
  });
});

test(
  'direct child ask/answer round-trip needs no child UI',
  {timeout: 5_000},
  async () => {
    await withChild('ask', async (_dir, task) => {
      const outcome = observeTask(task, {exitGraceMs: 500, killGraceMs: 100});
      let summary: string | undefined;
      task.bus.subscribe((env) => {
        if (env.type === 'ask') {
          task.bus.emit('answer', {text: 'chosen'}, {inReplyTo: env.id});
        } else if (env.type === 'report') {
          summary = env.payload.summary;
        }
      });
      assert.equal((await outcome).status, 'ok');
      assert.equal(summary, 'chosen');
    });
  },
);

for (
  const [mode, expected] of [['crash', 'crashed'], ['bad-exit', 'failed'], [
    'hang-done',
    'failed',
  ]] as const
) {
  test(`direct child ${mode} reconciles bus and process outcome`, {
    timeout: 5_000,
  }, async () => {
    await withChild(mode, async (_dir, task) => {
      const outcome = await observeTask(task, {
        exitGraceMs: 300,
        killGraceMs: 100,
      });
      assert.equal(outcome.status, expected);
      assert.ok(outcome.error);
    });
  });
}

for (const mode of ['cancel', 'stubborn', 'descendant']) {
  test(
    `cancellation: ${mode}`,
    {timeout: 5_000},
    async () => {
      await withChild(mode, async (dir, task) => {
        const outcome = observeTask(task, {exitGraceMs: 500, killGraceMs: 100});
        await new Promise<void>((resolve) =>
          task.bus.subscribe((env) => {
            if (env.type === 'progress') {
              resolve();
            }
          })
        );
        const cancellation = cancelTask(task, {
          reason: 'test',
          graceMs: 20,
          killGraceMs: 100,
        });
        assert.equal(
          cancelTask(task, {reason: 'duplicate', graceMs: 0}),
          cancellation,
        );
        await cancellation;
        const result = await outcome;
        assert.equal(result.status, 'aborted');
        assert.equal(
          result.exit?.signal,
          mode === 'stubborn' ? 'SIGKILL' : null,
        );
        assert.equal(task.process.isGroupAlive(), false);
        if (mode === 'descendant') {
          const pid = Number(readFileSync(join(dir, 'descendant-pid'), 'utf8'));
          assert.throws(() => process.kill(pid, 0), /ESRCH/);
        }
      });
    },
  );
}

for (const mode of ['exit-early', 'no-connect', 'aborted']) {
  test(`launch failure ${mode} cleans up listener and process`, {
    timeout: 5_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-'));
    const previous = process.env.PI_SUBAGENT_LAUNCHER;
    const launcher = join(dir, 'launcher.sh');
    writeFileSync(
      launcher,
      `#!/bin/sh\necho $$ > '${
        join(dir, 'pid')
      }'\nexec '${process.execPath}' '${
        fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url))
      }' "$@"\n`,
      {mode: 0o700},
    );
    process.env.PI_SUBAGENT_LAUNCHER = launcher;
    try {
      const controller = new AbortController();
      const timer = mode === 'aborted'
        ? setTimeout(() => controller.abort(), 1_500)
        : undefined;
      await assert.rejects(
        launchSubagent(argsFor(dir, mode === 'aborted' ? 'no-connect' : mode), {
          connectTimeoutMs: 2_000,
          killGraceMs: 100,
          signal: controller.signal,
        }),
      );
      clearTimeout(timer);
      const {socketPath} = JSON.parse(
        readFileSync(join(dir, 'socket-env.json'), 'utf8'),
      );
      assert.ok(!existsSync(dirname(socketPath)));
      assert.ok(
        existsSync(join(dir, 'pid')),
        readFileSync(join(dir, 'stderr.log'), 'utf8'),
      );
      const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally {
      restoreEnv('PI_SUBAGENT_LAUNCHER', previous);
      rmSync(dir, {recursive: true, force: true});
    }
  });
}

test('configured launcher failure does not fall back to pi', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-'));
  const previous = process.env.PI_SUBAGENT_LAUNCHER;
  process.env.PI_SUBAGENT_LAUNCHER = join(dir, 'missing-launcher');
  try {
    const child = await spawnSubagent(argsFor(dir));
    assert.equal((await child.exited).code, 127);
    assert.match(readFileSync(child.stderrPath, 'utf8'), /missing-launcher/);
  } finally {
    restoreEnv('PI_SUBAGENT_LAUNCHER', previous);
    rmSync(dir, {recursive: true, force: true});
  }
});
