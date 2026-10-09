import {strict as assert} from 'node:assert';
import {execFileSync, spawn} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {AuditLog} from '../bus/audit-log.js';
import {Bus} from '../bus/bus.js';
import type {Envelope} from '../bus/envelope.js';
import {launchSubagent} from '../main/launch.js';
import {terminateProcess, waitForExit} from '../main/spawn.js';

const entry = realpathSync(
  execFileSync('/bin/bash', ['-c', 'command -v pi'], {encoding: 'utf8'})
    .trim(),
);
const extension = fileURLToPath(new URL('../index.ts', import.meta.url));
const provider = fileURLToPath(
  new URL('./fixtures/test-provider.ts', import.meta.url),
);
const cliArgs = [
  entry,
  '--offline',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--no-themes',
  '--no-approve',
  '-e',
  extension,
  '-e',
  provider,
];
const model = {provider: 'subagent-test', id: 'exact-test-model'};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sa-'));
  const keys = [
    'PI_CODING_AGENT_DIR',
    'PI_SUBAGENT_LAUNCHER',
    'XDG_STATE_HOME',
    'TMUX',
  ];
  const previous = keys.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  process.env.XDG_STATE_HOME = dir;
  delete process.env.TMUX;
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'wrong-default',
      defaultModel: 'wrong-default',
      defaultThinkingLevel: 'off',
      enableInstallTelemetry: false,
      enableAnalytics: false,
      retry: {enabled: false},
    }),
  );
  process.env.PI_SUBAGENT_LAUNCHER = [process.execPath, ...cliArgs].map((arg) =>
    `'${arg.replace(/'/g, "'\\''")}'`
  ).join(' ');
  writeFileSync(join(dir, 'system.md'), 'You are a deterministic test agent.');
  return {
    dir,
    cleanup() {
      keys.forEach((key, i) => {
        if (previous[i] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[i];
        }
      });
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

for (
  const scenario of ['ask', 'continuation', 'failure', 'cancel', 'disconnect']
) {
  test(`real headless Pi: ${scenario}`, {timeout: 30_000}, async () => {
    const {dir, cleanup} = setup();
    let launched: Awaited<ReturnType<typeof launchSubagent>> | undefined;
    let bus: Bus | undefined;
    try {
      launched = await launchSubagent({
        taskId: 'test_headless',
        taskDir: dir,
        parentId: 'test_parent',
        cwd: dir,
        task: scenario,
        model,
        thinkingLevel: 'high',
        toolsWhitelist: [],
        systemPromptPath: join(dir, 'system.md'),
      }, {connectTimeoutMs: 15_000, killGraceMs: 500});
      bus = new Bus(
        launched.transport,
        new AuditLog(join(dir, 'main.jsonl')),
        'main',
      );
      const received: Envelope[] = [];
      bus.subscribe((env) => {
        received.push(env);
        if (env.type === 'ask') {
          if (scenario === 'cancel') {
            bus!.emit('cancel', {reason: 'test cancellation'});
          } else if (scenario === 'disconnect') {
            void bus!.close();
          } else {
            bus!.emit('answer', {text: 'chosen test value'}, {
              inReplyTo: env.id,
            });
          }
        }
      });
      const exit = await waitForExit(launched.process, 20_000);
      assert.ok(exit, 'headless child did not exit');
      // The final process event may precede delivery of the final UDS bytes.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const stderr = readFileSync(launched.process.stderrPath, 'utf8');
      assert.doesNotMatch(stderr, /Extension error|Failed to load extension/);
      const observed = JSON.parse(
        readFileSync(join(dir, 'observed.json'), 'utf8'),
      );
      assert.deepEqual(observed, {
        provider: model.provider,
        model: model.id,
        thinking: 'high',
        hasUI: false,
      });
      const done = received.filter((env) => env.type === 'done');
      if (scenario === 'disconnect') {
        assert.ok(!received.some((env) => env.type === 'report'));
      } else {
        assert.equal(done.length, 1, stderr);
        assert.equal(
          done[0].payload.status,
          scenario === 'failure'
            ? 'failed'
            : scenario === 'cancel'
            ? 'aborted'
            : 'ok',
          stderr,
        );
      }
      if (scenario === 'ask' || scenario === 'continuation') {
        assert.equal(exit.code, 0, stderr);
        assert.ok(received.some((env) => env.type === 'progress'));
        assert.ok(received.some((env) => env.type === 'report'));
        assert.match(
          readFileSync(join(dir, 'requests.jsonl'), 'utf8'),
          /chosen test value/,
        );
        if (scenario === 'continuation') {
          assert.match(done[0].payload.finalText!, /continued final answer/);
        }
      }
    } finally {
      if (launched) {
        await terminateProcess(launched.process, 0, 500);
      }
      await bus?.close();
      cleanup();
    }
  });
}

for (const scenario of ['ask', 'background', 'metadata-failure']) {
  test(`real controlling Pi: ${scenario}`, {timeout: 30_000}, async () => {
    const {dir, cleanup} = setup();
    try {
      const child = spawn(process.execPath, [
        ...cliArgs,
        '-p',
        '--no-session',
        '--provider',
        model.provider,
        '--model',
        model.id,
        '--thinking',
        'high',
        '--tools',
        'subagent',
        scenario,
      ], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => stdout += data);
      child.stderr.on('data', (data) => stderr += data);
      const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
      const code = await new Promise((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      clearTimeout(timer);
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stderr, /Extension error|Failed to load extension/);
      assert.match(stdout, /headless final answer/);
      const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8');
      if (scenario === 'ask') {
        assert.match(requests, /headless report/);
        assert.match(requests, /"status":"ok"/);
      } else if (scenario === 'background') {
        assert.equal(
          requests.trim().split('\n').length,
          2,
          'shutdown must not start another model turn',
        );
        assert.match(requests, /Started scout in background/);
        const root = join(dir, 'pi', 'subagent');
        const tasks = readdirSync(root);
        assert.equal(tasks.length, 1);
        const meta = JSON.parse(
          readFileSync(join(root, tasks[0], 'meta.json'), 'utf8'),
        );
        assert.equal(meta.status, 'aborted');
        assert.throws(() => process.kill(meta.subPid, 0), /ESRCH/);
      } else {
        assert.match(requests, /metadata update failed/);
      }
      assert.doesNotMatch(requests, /"status":"failed"/);
    } finally {
      cleanup();
    }
  });
}
