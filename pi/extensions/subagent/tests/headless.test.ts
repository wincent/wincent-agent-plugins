import {strict as assert} from 'node:assert';
import {execFileSync, spawn} from 'node:child_process';
import {
  existsSync,
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

for (const scenario of ['worker-clean', 'worker-mismatch']) {
  test(`real controlling Pi: ${scenario}`, {timeout: 30_000}, async () => {
    const {dir, cleanup} = setup();
    const repo = join(dir, 'repo');
    const git = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
    try {
      mkdirSync(repo);
      git(['init', '--initial-branch=main', '-q']);
      git(['config', 'user.name', 'test']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'commit.gpgsign', 'false']);
      git(['config', 'core.hooksPath', '/dev/null']);
      writeFileSync(join(repo, 'README.md'), 'initial\n');
      git(['add', 'README.md']);
      git(['commit', '-qm', 'initial']);
      await runController(repo, scenario);
      const result = JSON.parse(
        toolTexts(
          readFileSync(join(repo, 'requests.jsonl'), 'utf8'),
          'subagent',
        )[0],
      );
      assert.equal(result.worktree.commits.length, 1);
      const head = result.worktree.commits[0].sha;
      assert.equal(
        git(['rev-parse', `refs/heads/${result.worktree.branch}`]),
        head,
      );
      assert.equal(
        execFileSync('git', ['-C', repo, 'show', `${head}:foo.txt`], {
          encoding: 'utf8',
        }),
        'example\n',
      );
      if (scenario === 'worker-clean') {
        assert.equal(result.status, 'ok');
        assert.equal(result.finalReport.commits[0].sha, head);
        assert.ok(!existsSync(result.cwd));
      } else {
        assert.equal(result.status, 'failed');
        assert.match(result.error, /reported commits disagree/);
        assert.notEqual(
          result.finalReport.commits[0].sha,
          head,
          'preserve the original report for comparison',
        );
        assert.ok(existsSync(result.worktree.preservedPath));
      }
      const saved = JSON.parse(readFileSync(result.resultPath, 'utf8')).details;
      assert.equal(saved.status, result.status);
      assert.deepEqual(saved.worktree, result.worktree);
    } finally {
      cleanup();
    }
  });
}

function toolTexts(requests: string, toolName: string): string[] {
  const texts: string[] = [];
  for (const line of requests.trim().split('\n')) {
    for (const message of JSON.parse(line).messages) {
      if (message.role === 'toolResult' && message.toolName === toolName) {
        for (const part of message.content) {
          if (part.type === 'text') {
            texts.push(part.text);
          }
        }
      }
    }
  }
  return texts;
}

async function runController(dir: string, scenario: string): Promise<void> {
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
    'subagent,subagent_status',
    scenario,
  ], {cwd: dir, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => stdout += data);
  child.stderr.on('data', (data) => stderr += data);
  const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /Extension error|Failed to load extension/);
    assert.match(stdout, /headless final answer/);
  } finally {
    clearTimeout(timer);
  }
}

for (
  const scenario of [
    'ask',
    'background',
    'metadata-failure',
    'history',
    'result-failure',
  ]
) {
  test(`real controlling Pi: ${scenario}`, {timeout: 30_000}, async () => {
    const {dir, cleanup} = setup();
    try {
      await runController(dir, scenario);
      const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8');
      if (
        scenario === 'ask' || scenario === 'history' ||
        scenario === 'result-failure'
      ) {
        // Inspect only the tool's content sent to the provider, never UI details.
        const visible = JSON.parse(toolTexts(requests, 'subagent')[0]);
        assert.equal(visible.status, 'ok');
        assert.match(visible.taskId, /^task_/);
        assert.equal(visible.finalReport.summary, 'headless report');
        assert.equal(visible.finalReport.data.commits.length, 5);
        assert.deepEqual(visible.finalReport.data.commits[4], {
          sha: 'sha-4',
          subject: 'subject-4',
          summary: 'commit summary 4',
        });
        assert.equal(
          visible.finalReport.findings[0].message,
          'detailed finding',
        );
        assert.equal(visible.finalReport.branch, 'subagent/test');
        assert.equal(visible.finalReport.commits[0].sha, 'worker-sha');
        if (scenario === 'result-failure') {
          assert.equal(visible.resultPath, undefined);
          assert.match(visible.retrievalNote, /Could not save result.json/);
        } else {
          assert.equal(
            JSON.parse(readFileSync(visible.resultPath, 'utf8')).details.taskId,
            visible.taskId,
          );
        }
        if (scenario === 'history') {
          const statuses = toolTexts(requests, 'subagent_status').map((text) =>
            JSON.parse(text)
          );
          assert.ok(
            statuses.some((status) =>
              status.active?.length === 0 &&
              status.recentCompleted?.[0]?.taskId === visible.taskId
            ),
          );
          assert.ok(
            statuses.some((status) =>
              status.taskId === visible.taskId &&
              status.finalReport?.data.commits.length === 5
            ),
          );
          await runController(dir, `retrieve:${visible.taskId}`);
          const afterRestart = toolTexts(
            readFileSync(join(dir, 'requests.jsonl'), 'utf8'),
            'subagent_status',
          );
          assert.deepEqual(
            JSON.parse(afterRestart.at(-1)!).finalReport,
            visible.finalReport,
          );
        }
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
        assert.match(
          requests,
          /commit summary 4/,
          'background completion must expose report data too',
        );
      }
      assert.doesNotMatch(requests, /"status":"failed"/);
    } finally {
      cleanup();
    }
  });
}
