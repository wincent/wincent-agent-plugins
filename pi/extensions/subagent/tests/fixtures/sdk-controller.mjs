import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {piPackageImports} from '../../../tests/pi-package.mjs';

registerHooks(piPackageImports(['@earendil-works/pi-coding-agent'], process.env.SUBAGENT_TEST_PI_DIR));
const {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
} = await import('@earendil-works/pi-coding-agent');

const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
async function run(scenario, verify) {
  const runtime = await createAgentSessionRuntime(async (options) => {
    const services = await createAgentSessionServices(options);
    return {
      ...await createAgentSessionFromServices({
        ...options, services, tools: ['subagent'], thinkingLevel: 'high',
      }),
      services,
      diagnostics: services.diagnostics,
    };
  }, {cwd, agentDir, sessionManager: SessionManager.inMemory(cwd)});
  const {session} = runtime;
  try {
    await session.bindExtensions({onError: (error) => console.error(error)});
    await session.prompt(scenario);
    assert.equal(session.getLastAssistantText(), 'headless final answer');
    const message = session.messages.find((m) => m.role === 'toolResult' && m.toolName === 'subagent');
    assert.ok(message, 'SDK session did not receive a subagent tool result');
    return await verify(message);
  } finally {
    // Unlike session.dispose(), runtime.dispose() awaits session_shutdown.
    await runtime.dispose();
  }
}

const completed = await run('nested-cwd', (message) => {
  const result = JSON.parse(message.content.find((part) => part.type === 'text').text);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.finalReport.summary, 'headless report');
  assert.equal(result.execution.processGroupExited, true);
  assert.equal(result.cwd, join(cwd, "nested/child's directory"));
  return result;
});

delete process.env.SUBAGENT_TEST_PROBE_URL;
const entrypoint = process.env.PI_SUBAGENT_PI_ENTRYPOINT;
delete process.env.PI_SUBAGENT_PI_ENTRYPOINT;
await run('ask', (message) => {
  const result = JSON.parse(message.content.find((part) => part.type === 'text').text);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Set PI_SUBAGENT_PI_ENTRYPOINT in the SDK host or launcher/);
});
process.env.PI_SUBAGENT_PI_ENTRYPOINT = entrypoint;

const active = await run('background-default-shutdown', async (message) => {
  const text = message.content.find((part) => part.type === 'text').text;
  const taskId = text.match(/task_id=(task_[^,]+)/)?.[1];
  assert.ok(taskId, text);
  const taskDir = join(process.env.XDG_STATE_HOME, 'pi', 'subagent', taskId);
  const {subPid} = JSON.parse(readFileSync(join(taskDir, 'meta.json'), 'utf8'));
  // Wait for the live child to enter its intentionally blocked provider call.
  for (let i = 0; i < 200 && !existsSync(join(taskDir, 'requests.jsonl')); i++) {
    await delay(25);
  }
  assert.ok(existsSync(join(taskDir, 'requests.jsonl')), readFileSync(join(taskDir, 'stderr.log'), 'utf8'));
  process.kill(subPid, 0);
  return {taskDir, subPid};
});
console.log(JSON.stringify({completed, active}));
