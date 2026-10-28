import {strict as assert} from 'node:assert';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {AuditLog} from '../bus/audit-log.js';
import {Bus} from '../bus/bus.js';
import type {Envelope} from '../bus/envelope.js';
import {launchSubagent} from '../main/launch.js';
import {readTaskResult, resultText} from '../main/result.js';
import {spawnSubagent, terminateProcess, waitForExit} from '../main/spawn.js';
import {stdinTasks} from './fixtures/tasks.js';

// Match locatePiPackage(): prefer the explicit real executable, never PATH.
const entry = realpathSync(
  process.env.PI_REAL_BIN || join(homedir(), 'n/pi/node_modules/.bin/pi'),
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

function setup(explicitOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), 'sa-'));
  const keys = [
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'PI_OFFLINE',
    'PI_SUBAGENT_SOCKET_ROOT',
    'PI_SUBAGENT_TASK_ID',
    'PI_SUBAGENT_BUS_DIR',
    'PI_SUBAGENT_SOCKET_PATH',
    'PI_SUBAGENT_PARENT_ID',
    'XDG_STATE_HOME',
    'TMUX',
  ];
  const previous = keys.map((key) => process.env[key]);
  for (
    const key of [
      'PI_SUBAGENT_TASK_ID',
      'PI_SUBAGENT_BUS_DIR',
      'PI_SUBAGENT_SOCKET_PATH',
      'PI_SUBAGENT_PARENT_ID',
    ]
  ) {
    delete process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  process.env.XDG_STATE_HOME = dir;
  process.env.PI_OFFLINE = '1';
  delete process.env.TMUX;
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR, 'settings.json'),
    JSON.stringify({
      extensions: [
        ...(explicitOnly ? [] : [extension, provider]),
        '-builtin:mcp',
        '-builtin:llama.cpp',
        '-builtin:codemode',
        '-builtin:tool-search',
      ],
      defaultProjectTrust: 'never',
      defaultProvider: 'wrong-default',
      defaultModel: 'wrong-default',
      defaultThinkingLevel: 'off',
      enableInstallTelemetry: false,
      enableAnalytics: false,
      retry: {enabled: false},
    }),
  );
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

function sessionEntries(taskId: string) {
  const dir = join(
    process.env.PI_CODING_AGENT_DIR!,
    'subagent-sessions',
    taskId,
  );
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1, 'Each child retains one session transcript');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const file = join(dir, files[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  return readFileSync(file, 'utf8').trim().split('\n').map((line) =>
    JSON.parse(line)
  );
}

for (
  const {scenario, task} of [
    ...[
      'ask',
      'final-report',
      'interim-report',
      'mixed-report',
      'continuation',
      'failure',
      'cancel',
      'disconnect',
    ].map((scenario) => ({scenario, task: scenario})),
    ...stdinTasks,
  ]
) {
  test(`real headless Pi: ${scenario}`, {timeout: 30_000}, async () => {
    const {dir, cleanup} = setup();
    let launched: Awaited<ReturnType<typeof launchSubagent>> | undefined;
    let bus: Bus | undefined;
    try {
      launched = await launchSubagent(
        {
          taskId: 'test_headless',
          taskDir: dir,
          parentId: 'test_parent',
          cwd: dir,
          task,
          model,
          thinkingLevel: 'high',
          toolsWhitelist: [],
          systemPromptPath: join(dir, 'system.md'),
        },
        {connectTimeoutMs: 15_000, killGraceMs: 500},
        (args) =>
          spawnSubagent(args, {executable: process.execPath, args: cliArgs}),
      );
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
        socketPath: launched.socketPath,
        busDir: dir,
      });
      const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8');
      const initial = JSON.parse(requests.split('\n')[0]).messages.find(
        (message: {role: string}) => message.role === 'user',
      );
      assert.deepEqual(initial.content, [{type: 'text', text: task.trim()}]);
      assert.equal(readFileSync(join(dir, 'task.txt'), 'utf8'), task);
      assert.ok(!existsSync(join(dir, 'sessions')));
      const savedUser = sessionEntries('test_headless').find((entry) =>
        entry.type === 'message' && entry.message.role === 'user'
      );
      assert.deepEqual(savedUser.message.content, initial.content);
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
      if (
        scenario === 'ask' || scenario === 'continuation' ||
        scenario.endsWith('-report') || scenario.startsWith('stdin-')
      ) {
        assert.equal(exit.code, 0, stderr);
        assert.ok(received.some((env) => env.type === 'progress'));
        const reports = received.filter((env) => env.type === 'report');
        assert.equal(reports.length, scenario === 'interim-report' ? 2 : 1);
        assert.equal(reports.at(-1)!.payload.final, true);
        assert.equal(reports.at(-1)!.payload.summary, 'headless report');
        assert.match(requests, /chosen test value/);
        const followsReport = scenario === 'continuation' ||
          scenario === 'interim-report' || scenario === 'mixed-report';
        assert.equal(
          requests.trim().split('\n').length,
          followsReport ? 4 : 3,
          'a final report skips the automatic follow-up, not interim work, mixed batches, or explicit continuation',
        );
        if (scenario === 'continuation') {
          assert.match(done[0].payload.finalText!, /continued final answer/);
        } else if (scenario === 'mixed-report') {
          assert.match(requests, /same-batch progress/);
          assert.equal(done[0].payload.finalText, 'headless final answer');
        } else {
          assert.equal(done[0].payload.finalText, undefined);
        }
        if (scenario === 'interim-report') {
          assert.equal(reports[0].payload.final, false);
          assert.equal(reports[0].payload.summary, 'interim report');
          assert.match(requests, /report sent/);
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

for (
  const scenario of ['empty-task', 'whitespace-task', 'unicode-whitespace-task']
) {
  test(`real controller rejects ${scenario} before creating task or worktree`, {
    timeout: 30_000,
  }, async () => {
    const {dir, cleanup} = setup();
    try {
      await runController(dir, scenario);
      const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8');
      const results = toolTexts(requests, 'subagent');
      assert.equal(results.length, 1);
      assert.match(results[0], /task must not be empty or whitespace-only/);
      const lastRequest = JSON.parse(requests.trim().split('\n').at(-1)!);
      const result = lastRequest.messages.find((
        message: {role: string; toolName?: string},
      ) => message.role === 'toolResult' && message.toolName === 'subagent');
      assert.equal(result.isError, true);
      const root = join(dir, 'pi', 'subagent');
      assert.deepEqual(existsSync(root) ? readdirSync(root) : [], []);
      assert.ok(!existsSync(join(dir, '.agent-worktrees')));
    } finally {
      cleanup();
    }
  });
}

test(
  'child bootstrap rejects missing or invalid socket paths before model requests',
  {timeout: 30_000},
  () => {
    const {dir, cleanup} = setup();
    try {
      for (
        const socketPath of [undefined, '', 'relative', '/' + 'x'.repeat(120)]
      ) {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PI_SUBAGENT_TASK_ID: 'test_invalid_socket',
          PI_SUBAGENT_BUS_DIR: dir,
        };
        if (socketPath === undefined) {
          delete env.PI_SUBAGENT_SOCKET_PATH;
        } else {
          env.PI_SUBAGENT_SOCKET_PATH = socketPath;
        }
        const run = spawnSync(process.execPath, [
          ...cliArgs,
          '--no-session',
          '--provider',
          model.provider,
          '--model',
          model.id,
          '-p',
          'ask',
        ], {cwd: dir, env, encoding: 'utf8', timeout: 5000});
        assert.equal(run.status, 1, run.stderr);
        assert.match(
          run.stderr,
          /PI_SUBAGENT_SOCKET_PATH|Subagent socket path/,
        );
        assert.ok(
          !existsSync(join(dir, 'requests.jsonl')),
          'Invalid bootstrap must not submit the prompt',
        );
      }
    } finally {
      cleanup();
    }
  },
);

test(
  'real controller collects opt-in state and the child imports it before execution',
  {timeout: 30_000},
  async () => {
    const {dir, cleanup} = setup();
    try {
      await runController(dir, 'ask');
      const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8');
      const result = JSON.parse(toolTexts(requests, 'subagent')[0]);
      assert.equal(result.status, 'ok');
      assert.deepEqual(
        JSON.parse(
          readFileSync(join(result.taskDir, 'extension-state.json'), 'utf8'),
        ),
        {language: 'de', enabled: true},
      );
      for (
        const name of [
          'run.sh',
          'meta.json',
          'result.json',
          'bus.jsonl',
          'system-prompt.md',
          'task.txt',
        ]
      ) {
        assert.doesNotMatch(
          readFileSync(join(result.taskDir, name), 'utf8'),
          /test-preference/,
        );
      }
      assert.doesNotMatch(requests, /test-preference/);
    } finally {
      cleanup();
    }
  },
);

test(
  'child sessions retain tool history and usage outside normal resume discovery',
  {
    timeout: 30_000,
  },
  async () => {
    const {dir, cleanup} = setup();
    const inheritedSessionDir = join(dir, 'unwanted-sessions');
    process.env.PI_CODING_AGENT_SESSION_DIR = inheritedSessionDir;
    try {
      await runController(dir, 'session-storage');
      const result = JSON.parse(
        toolTexts(
          readFileSync(join(dir, 'requests.jsonl'), 'utf8'),
          'subagent',
        )[0],
      );
      assert.equal(result.status, 'ok');
      assert.equal(result.execution.processGroupExited, true);
      const entries = sessionEntries(result.taskId);
      assert.ok(!existsSync(join(result.taskDir, 'sessions')));
      assert.equal(entries[0].type, 'session');
      assert.equal(entries[0].cwd, realpathSync(dir));
      const messages = entries.filter((entry) => entry.type === 'message').map(
        (entry) => entry.message,
      );
      const assistants = messages.filter((message) =>
        message.role === 'assistant'
      );
      assert.equal(assistants.length, 3);
      assert.equal(
        assistants.reduce(
          (total, message) => total + message.usage.cost.total,
          0,
        ),
        0.75,
        'Synthetic child usage survives persistence without another model turn',
      );
      assert.deepEqual(
        assistants.flatMap((message) =>
          message.content.filter((part: {type: string}) =>
            part.type === 'toolCall'
          )
            .map((part: {name: string}) => part.name)
        ),
        ['progress', 'ask', 'report'],
      );
      assert.deepEqual(
        messages.filter((message) => message.role === 'toolResult')
          .map((message) => message.toolName),
        ['progress', 'ask', 'report'],
      );
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, 'resume-sessions.json'), 'utf8')),
        {
          current: [],
          all: [],
        },
      );
      assert.ok(
        !existsSync(inheritedSessionDir),
        'Explicit child directory overrides inherited session storage',
      );
      assert.ok(existsSync(result.resultPath));
      rmSync(result.taskDir, {recursive: true});
      assert.deepEqual(
        sessionEntries(result.taskId),
        entries,
        'Task cleanup leaves durable transcripts intact',
      );
    } finally {
      cleanup();
    }
  },
);

test('real controller keeps long state paths separate from socket allocation', {
  timeout: 30_000,
}, async () => {
  const {dir, cleanup} = setup();
  const socketRoot = join(dir, 'sockets');
  mkdirSync(socketRoot, {mode: 0o700});
  process.env.PI_SUBAGENT_SOCKET_ROOT = socketRoot;
  process.env.XDG_STATE_HOME = join(dir, 'long-state-' + 'x'.repeat(120));
  try {
    await runController(dir, 'ask');
    const result = JSON.parse(
      toolTexts(
        readFileSync(join(dir, 'requests.jsonl'), 'utf8'),
        'subagent',
      )[0],
    );
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.ok(result.taskDir.startsWith(process.env.XDG_STATE_HOME));
    const observed = JSON.parse(
      readFileSync(join(result.taskDir, 'observed.json'), 'utf8'),
    );
    assert.equal(observed.busDir, result.taskDir);
    assert.deepEqual(
      JSON.parse(readFileSync(join(result.taskDir, 'runtime.json'), 'utf8')),
      JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')),
    );
    assert.ok(observed.socketPath.startsWith(socketRoot + '/'));
    assert.ok(existsSync(result.resultPath));
    assert.ok(existsSync(join(result.taskDir, 'bus.jsonl')));
    assert.deepEqual(readdirSync(socketRoot), []);
  } finally {
    cleanup();
  }
});

for (
  const scenario of [
    'worker-clean',
    'worker-mismatch',
    'worker-partial',
    'worker-background',
  ]
) {
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
      const ignore = join(dir, 'gitignore');
      writeFileSync(ignore, '.agent-worktrees/\n');
      git(['config', 'core.excludesFile', ignore]);
      writeFileSync(join(repo, 'README.md'), 'initial\n');
      git(['add', 'README.md']);
      git(['commit', '-qm', 'initial']);
      await runController(repo, scenario);
      const requests = readFileSync(join(repo, 'requests.jsonl'), 'utf8');
      const result = scenario === 'worker-background'
        ? JSON.parse(
          readFileSync(
            join(
              dir,
              'pi',
              'subagent',
              readdirSync(join(dir, 'pi', 'subagent'))[0],
              'result.json',
            ),
            'utf8',
          ),
        ).details
        : JSON.parse(toolTexts(requests, 'subagent')[0]);
      assert.equal(result.worktree.commits.length, 1);
      assert.equal(result.worktree.hasCommittedChanges, true);
      assert.equal(
        result.worktree.hadUncommittedChanges,
        scenario === 'worker-partial',
      );
      assert.ok(!('hasChanges' in result.worktree));
      assert.equal(result.execution.processExited, true);
      assert.equal(result.execution.processGroupExited, true);
      const removed = scenario === 'worker-clean' ||
        scenario === 'worker-background';
      assert.deepEqual(result.worktree.cleanup, {
        directoryRemoved: removed,
        registrationRemoved: removed,
      });
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
      if (scenario !== 'worker-mismatch') {
        assert.equal(result.status, 'ok');
        assert.equal(result.finalReport.commits[0].sha, head);
        if (scenario === 'worker-partial') {
          assert.equal(result.taskOutcome, 'partial');
          assert.match(result.resultDescription, /partial delivery/);
          assert.ok(existsSync(result.worktree.preservedPath));
          assert.match(
            execFileSync('git', ['-C', result.cwd, 'status', '--porcelain'], {
              encoding: 'utf8',
            }),
            /\?\? unfinished.txt/,
          );
        } else {
          assert.ok(!existsSync(result.cwd));
        }
      } else {
        assert.equal(result.status, 'failed');
        assert.match(result.error, /reported commits disagree/);
        assert.equal(
          result.taskOutcome,
          'completed',
          'the claim is separate from harness failure',
        );
        assert.match(
          result.resultDescription,
          /Harness finalization ended with status failed/,
        );
        assert.notEqual(
          result.finalReport.commits[0].sha,
          head,
          'preserve the original report for comparison',
        );
        assert.ok(existsSync(result.worktree.preservedPath));
      }
      const saved = JSON.parse(readFileSync(result.resultPath, 'utf8'));
      assert.equal(saved.details.status, result.status);
      assert.deepEqual(saved.details.worktree, result.worktree);
      assert.ok(
        saved.result.artifacts.retained.some((
          artifact: {kind: string; location: string},
        ) =>
          artifact.kind === 'branch' &&
          artifact.location === result.worktree.branch
        ),
      );
      assert.equal(
        saved.result.verification.reported[0].check,
        'Read foo.txt contents',
      );
      assert.ok(
        saved.result.verification.harness.some((
          check: {check: string; result: string},
        ) =>
          check.check === 'Retained branch points to finalized HEAD' &&
          check.result === 'passed'
        ),
      );
      assert.deepEqual(
        JSON.parse(
          readFileSync(
            join(result.taskDir, 'finalizing-observed.json'),
            'utf8',
          ),
        ),
        {status: 'finalizing', hasSavedResult: false},
      );
      if (scenario === 'worker-background') {
        assert.doesNotMatch(requests, /report received \(not finalized\)/);
        assert.equal(completionNotices(requests).length, 1);
        assert.match(requests, /Agent reports task completion/);
        assert.doesNotMatch(
          requests,
          /Retained branch points to finalized HEAD/,
          'completion should not repeat the full verification report',
        );
        assert.match(requests, /Full report: subagent_status/);
        const retrieved = JSON.parse(
          resultText((await readTaskResult(result.taskId))!),
        );
        assert.equal(retrieved.worktree.cleanup.registrationRemoved, true);
        assert.deepEqual(retrieved.finalReport, result.finalReport);
        assert.doesNotMatch(requests, /done \(ok\)/);
      }
    } finally {
      cleanup();
    }
  });
}

test(
  'worker refusal has a declined outcome even when execution and lifecycle succeed',
  {timeout: 30_000},
  async () => {
    const {dir, cleanup} = setup();
    try {
      await runController(dir, 'worker-declined');
      const result = JSON.parse(
        toolTexts(
          readFileSync(join(dir, 'requests.jsonl'), 'utf8'),
          'subagent',
        )[0],
      );
      assert.equal(result.status, 'ok');
      assert.equal(result.execution.status, 'ok');
      assert.equal(result.taskOutcome, 'declined');
      assert.match(result.resultDescription, /declined the task/);
      assert.deepEqual(result.blockers, [
        'Mandatory commit workflow conflicts with untracked-only request',
      ]);
      assert.deepEqual(result.artifacts.reported, []);
      assert.equal(result.verification.reported[0].result, 'not_run');
    } finally {
      cleanup();
    }
  },
);

for (const explicitOnly of [false, true]) {
  test(
    `controller extensions and nested cwd (explicit only: ${explicitOnly})`,
    {timeout: 30_000},
    async () => {
      const {dir, cleanup} = setup(explicitOnly);
      try {
        const nested = join(dir, "nested/child's directory");
        mkdirSync(join(nested, '.pi', 'extensions'), {recursive: true});
        writeFileSync(
          join(nested, '.pi', 'extensions', 'untrusted.ts'),
          'throw new Error("untrusted project extension loaded");',
        );
        const controllerCwd = realpathSync(dir);
        await runController(dir, 'nested-cwd', [
          entry,
          '--offline',
          '--no-approve',
          ...(explicitOnly ? ['--no-extensions'] : []),
          '-e',
          relative(controllerCwd, extension),
          '--extension',
          relative(controllerCwd, provider),
          // Deliberately overlap relative and absolute paths; do not load twice.
          '--extension',
          provider,
        ]);
        const result = JSON.parse(
          toolTexts(
            readFileSync(join(dir, 'requests.jsonl'), 'utf8'),
            'subagent',
          )[0],
        );
        assert.equal(result.status, 'ok', JSON.stringify(result));
        assert.equal(
          result.cwd,
          join(realpathSync(dir), "nested/child's directory"),
        );
        assert.equal(result.finalReport.summary, 'headless report');
        const session = sessionEntries(result.taskId).find((entry) =>
          entry.type === 'session'
        );
        assert.equal(session.cwd, result.cwd);
        const stderr = readFileSync(join(result.taskDir, 'stderr.log'), 'utf8');
        assert.doesNotMatch(
          stderr,
          /Extension error|Failed to load extension|conflict|untrusted project/,
        );
        const wrapper = readFileSync(join(result.taskDir, 'run.sh'), 'utf8');
        assert.match(wrapper, /--no-approve/);
        assert.doesNotMatch(wrapper, /'--approve'/);
      } finally {
        cleanup();
      }
    },
  );
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

function completionNotices(requests: string): string[] {
  // Count messages in the final context, not repeated copies across requests.
  const last = JSON.parse(requests.trim().split('\n').at(-1)!);
  return last.messages.flatMap((message: {
    role: string;
    content: string | {type: string; text?: string}[];
  }) => {
    if (message.role !== 'user') {
      return [];
    }
    const texts = typeof message.content === 'string'
      ? [message.content]
      : message.content.flatMap((part) =>
        part.type === 'text' ? [part.text ?? ''] : []
      );
    return texts.filter((text) => text.startsWith('[subagent '));
  });
}

async function runController(
  dir: string,
  scenario: string,
  runtimeArgs = cliArgs,
): Promise<void> {
  const child = spawn(process.execPath, [
    ...runtimeArgs,
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
    'background-default',
    'background-default-retrieved',
    'background-default-listed',
    'background-default-shutdown',
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
      assert.doesNotMatch(requests, /report received \(not finalized\)/);
      if (
        scenario === 'ask' || scenario === 'history' ||
        scenario === 'result-failure'
      ) {
        // Inspect only the tool's content sent to the provider, never UI details.
        const visible = JSON.parse(toolTexts(requests, 'subagent')[0]);
        assert.equal(visible.status, 'ok');
        assert.equal(
          visible.mode,
          'sync',
          'explicit false waits for completion',
        );
        assert.equal(visible.finalized, true);
        assert.equal(visible.execution.processExited, true);
        assert.equal(visible.execution.processGroupExited, true);
        const childRequests = readFileSync(
          join(visible.taskDir, 'requests.jsonl'),
          'utf8',
        );
        assert.equal(childRequests.trim().split('\n').length, 3);
        assert.deepEqual(toolTexts(childRequests, 'ask'), [
          '(ask_policy=deny) No answer available; please make a reasonable assumption and note it in your report.',
        ]);
        assert.equal(
          JSON.parse(readFileSync(join(visible.taskDir, 'meta.json'), 'utf8'))
            .mode,
          'sync',
        );
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
      } else if (
        scenario === 'background' || scenario === 'background-default-shutdown'
      ) {
        assert.equal(
          requests.trim().split('\n').length,
          2,
          'shutdown must not start another model turn',
        );
        assert.match(requests, /Started scout in background/);
        assert.match(requests, /shutdown cancels this task/);
        const root = join(dir, 'pi', 'subagent');
        const tasks = readdirSync(root);
        assert.equal(tasks.length, 1);
        const meta = JSON.parse(
          readFileSync(join(root, tasks[0], 'meta.json'), 'utf8'),
        );
        assert.equal(meta.status, 'aborted');
        assert.equal(meta.mode, 'background');
        const saved = JSON.parse(
          readFileSync(join(root, tasks[0], 'result.json'), 'utf8'),
        );
        assert.equal(saved.details.mode, 'background');
        assert.equal(saved.details.status, 'aborted');
        assert.throws(() => process.kill(meta.subPid, 0), /ESRCH/);
      } else if (scenario.startsWith('background-default')) {
        const handle = toolTexts(requests, 'subagent')[0];
        assert.match(handle, /Started scout in background/);
        assert.match(handle, /completion will arrive automatically/);
        assert.equal(
          completionNotices(requests).length,
          scenario === 'background-default-retrieved' ? 0 : 1,
          'only a finalized per-task retrieval suppresses the pending notification',
        );
        if (scenario === 'background-default-retrieved') {
          const status = JSON.parse(toolTexts(requests, 'subagent_status')[0]);
          assert.equal(status.finalized, true);
          assert.equal(status.finalReport.data.commits.length, 5);
          assert.equal(
            requests.trim().split('\n').length,
            3,
            'retrieval must not leave an extra acknowledgment turn',
          );
        } else {
          assert.match(requests, /Full report: subagent_status/);
        }
        const taskId = handle.match(/task_id=(task_[^,]+)/)![1];
        const retrieved = JSON.parse(
          resultText((await readTaskResult(taskId))!),
        );
        assert.equal(retrieved.mode, 'background');
        assert.equal(retrieved.status, 'ok');
        assert.equal(retrieved.finalized, true);
        assert.equal(retrieved.execution.processExited, true);
        assert.equal(retrieved.finalReport.summary, 'headless report');
        assert.equal(retrieved.finalReport.data.commits.length, 5);
        assert.equal(
          JSON.parse(readFileSync(join(retrieved.taskDir, 'meta.json'), 'utf8'))
            .mode,
          'background',
        );
        assert.match(
          readFileSync(
            join(retrieved.taskDir, 'reports-observed.jsonl'),
            'utf8',
          ),
          /headless report/,
          'provisional reports still reach lifecycle/UI subscribers',
        );
        if (scenario !== 'background-default-retrieved') {
          assert.doesNotMatch(
            requests,
            /commit summary 4/,
            'default background completion should be a digest',
          );
        }
      } else {
        assert.match(requests, /metadata update failed/);
        assert.doesNotMatch(
          requests,
          /commit summary 4/,
          'background completion should be a digest',
        );
        assert.match(requests, /Full report: subagent_status/);
        const taskId = readdirSync(join(dir, 'pi', 'subagent'))[0];
        const retrieved = JSON.parse(
          resultText((await readTaskResult(taskId))!),
        );
        assert.equal(retrieved.status, 'failed');
        assert.equal(
          retrieved.finalReport.data.commits[4].summary,
          'commit summary 4',
          'full data must remain retrievable',
        );
      }
      assert.doesNotMatch(requests, /"status":"failed"/);
    } finally {
      cleanup();
    }
  });
}
