#!/usr/bin/env node
/** Opt-in wrapper smoke test. Uses a deterministic provider, not paid model calls. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const launcher = process.argv[2];
if (!launcher || !isAbsolute(launcher)) {
  throw new Error('Usage: node sandbox-smoke.mjs /absolute/path/to/bin/pi');
}
const dir = mkdtempSync(join(tmpdir(), 'pi-smoke-'));
const agentDir = join(dir, 'agent');
mkdirSync(agentDir, {mode: 0o700});
const extension = fileURLToPath(new URL('../index.ts', import.meta.url));
const provider = fileURLToPath(new URL('./fixtures/test-provider.ts', import.meta.url));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
  extensions: [extension, provider, '-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'],
  defaultProvider: 'subagent-test',
  defaultModel: 'exact-test-model',
  defaultThinkingLevel: 'high',
  defaultProjectTrust: 'never',
  enableInstallTelemetry: false,
  enableAnalytics: false,
  retry: {enabled: false},
}), {mode: 0o600});
const env = {...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1'};
for (const key of ['PI_SUBAGENT_TASK_ID', 'PI_SUBAGENT_BUS_DIR', 'PI_SUBAGENT_SOCKET_PATH', 'PI_SUBAGENT_SOCKET_ROOT']) {
  delete env[key];
}
const stdout = openSync(join(dir, 'stdout.log'), 'wx', 0o600);
const stderr = openSync(join(dir, 'stderr.log'), 'wx', 0o600);
console.log(`Smoke artifacts retained at ${dir}`);
let run;
try {
  run = spawnSync(launcher, ['--offline', '--no-session', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '-p', 'ask'], {
    cwd: dir, env, stdio: ['ignore', stdout, stderr], timeout: 60_000,
  });
} finally {
  closeSync(stdout);
  closeSync(stderr);
}
assert.equal(run.error, undefined, `Launcher failed; inspect ${dir}`);
assert.equal(run.status, 0, `Launcher exited ${run.status}; inspect ${dir}`);
const messages = readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').flatMap((line) => JSON.parse(line).messages);
const response = messages.find((message) => message.role === 'toolResult' && message.toolName === 'subagent');
assert.ok(response, 'Controller did not return a subagent result');
const result = JSON.parse(response.content.find((part) => part.type === 'text').text);
writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
console.log(JSON.stringify({status: result.status, taskId: result.taskId, taskDir: result.taskDir, error: result.error}, null, 2));
assert.equal(result.status, 'ok', `Subagent failed; inspect ${result.taskDir}`);
assert.equal(result.finalReport.summary, 'headless report');
assert.equal(result.execution.processGroupExited, true);
const observed = JSON.parse(readFileSync(join(result.taskDir, 'observed.json'), 'utf8'));
assert.equal(observed.busDir, result.taskDir);
assert.ok(!existsSync(dirname(observed.socketPath)), 'Task socket directory was not removed');
assert.ok(existsSync(result.resultPath), 'Retained result is missing');
const runtime = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
assert.deepEqual(JSON.parse(readFileSync(join(result.taskDir, 'runtime.json'), 'utf8')), runtime, 'Child did not inherit the controller runtime and socket root');
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
assert.ok(readFileSync(join(result.taskDir, 'run.sh'), 'utf8').includes(`exec ${quote(runtime.executable)} ${quote(runtime.entrypoint)} `), 'Child did not invoke the controlling Pi runtime directly');
if (runtime.socketRoot) {
  assert.equal(dirname(dirname(observed.socketPath)), runtime.socketRoot);
}
console.log(`PASS: wrapper controller and direct child exchanged progress, clarification, report, and completion. Socket: ${observed.socketPath}`);
