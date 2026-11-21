import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import {createServer} from 'node:http';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {locatePiPackage} from '../../tests/pi-package.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const extension = realpathSync(fileURLToPath(new URL('../index.ts', import.meta.url)));
const piSources = realpathSync(resolve(fixtures, '../../../../'));
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";

async function smoke(t, sandboxed) {
  const pkgDir = locatePiPackage();
  const {bin} = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const pi = realpathSync(join(pkgDir, typeof bin === 'string' ? bin : bin.pi));
  const node = realpathSync(process.execPath);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-sdk-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const cwd = join(root, 'workspace');
  const agent = join(root, 'agent');
  const sockets = join(root, 's');
  // The default nono profile grants system access under /private/var on
  // macOS, so keep its protected state and the denied fixture outside TMPDIR.
  const home = sandboxed
    ? realpathSync(mkdtempSync(join(homedir(), '.sa-sdk-home-')))
    : join(root, 'home');
  if (sandboxed) {
    t.after(() => rmSync(home, {recursive: true, force: true}));
  } else {
    mkdirSync(home, {mode: 0o700});
  }
  const work = join(root, 'tmp');
  for (const dir of [cwd, agent, sockets, work]) mkdirSync(dir, {mode: 0o700});
  const cli = join(root, 'pi-link');
  symlinkSync(pi, cli);
  const projectExtensions = join(cwd, "nested/child's directory", '.pi', 'extensions');
  mkdirSync(projectExtensions, {recursive: true});
  writeFileSync(join(projectExtensions, 'untrusted.ts'), 'throw new Error("untrusted project extension loaded");');
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({
    extensions: [
      extension, join(fixtures, 'test-provider.ts'),
      ...(sandboxed ? [join(fixtures, 'sdk-sandbox-probe.mjs')] : []),
      '-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search',
    ],
    defaultProvider: 'subagent-test',
    defaultModel: 'exact-test-model',
    defaultProjectTrust: 'never',
    enableInstallTelemetry: false,
    enableAnalytics: false,
    retry: {enabled: false},
  }));
  // No host config, API keys, inherited task identifiers, or live provider calls.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: work,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1',
    PI_SUBAGENT_PI_ENTRYPOINT: cli,
    PI_SUBAGENT_SOCKET_ROOT: sockets,
    SUBAGENT_TEST_PI_DIR: pkgDir,
  };

  let program = node;
  const args = [
    join(fixtures, 'sdk-controller.mjs'), '--approve', '--no-extensions',
    '--extension', './sdk-host-only.ts', '--model', 'not-a-cli-model',
  ];
  const hits = [];
  if (sandboxed) {
    // The sandbox should deny an otherwise-readable fixture not granted below.
    const denied = join(home, 'secret');
    writeFileSync(denied, 'only a synthetic secret');
    assert.equal(readFileSync(denied, 'utf8'), 'only a synthetic secret');
    const upstream = createServer((req, res) => {
      hits.push(req.url);
      res.end('test upstream');
    });
    t.after(() => new Promise((done) => upstream.close(done)));
    await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
    env.SUBAGENT_TEST_PROBE_URL = `http://127.0.0.1:${upstream.address().port}`;
    env.SUBAGENT_TEST_DENIED_FILE = denied;
    program = 'nono';
    args.unshift('run', '--profile', 'default', '--silent', '--no-audit', '--no-rollback',
      '--allow', root, '--allow-unix-socket-subtree-bind', sockets,
      '--read', piSources, '--read', dirname(dirname(pkgDir)), '--read-file', node,
      '--allow-domain', '127.0.0.1', '--', '/usr/bin/env',
      `XDG_STATE_HOME=${env.XDG_STATE_HOME}`, `XDG_CACHE_HOME=${env.XDG_CACHE_HOME}`,
      `XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`, node);
    env.XDG_STATE_HOME = join(home, 'state');
    env.XDG_CACHE_HOME = join(home, 'cache');
    env.XDG_CONFIG_HOME = join(home, 'config');
  }
  const {stdout, stderr} = await promisify(execFile)(program, args, {cwd, env, timeout: 25_000});
  assert.doesNotMatch(stderr, /Extension error|Failed to load extension|untrusted project extension/);
  const {completed, active} = JSON.parse(stdout.trim());
  const saved = JSON.parse(readFileSync(join(active.taskDir, 'result.json'), 'utf8')).details;
  assert.equal(saved.status, 'aborted');
  assert.equal(saved.execution.processGroupExited, true);
  assert.throws(() => process.kill(-active.subPid, 0), {code: 'ESRCH'});
  assert.deepEqual(readdirSync(sockets), []);
  for (const taskDir of [completed.taskDir, active.taskDir]) {
    const wrapper = readFileSync(join(taskDir, 'run.sh'), 'utf8');
    assert.ok(wrapper.includes(`\nexec ${quote(node)} ${quote(pi)} '--extension' ${quote(extension)} -p `));
    assert.doesNotMatch(wrapper, /--approve|--no-extensions|sdk-host-only|not-a-cli-model/);
    assert.doesNotMatch(readFileSync(join(taskDir, 'stderr.log'), 'utf8'), /untrusted project extension/);
  }
  assert.ok(existsSync(completed.resultPath));
  if (sandboxed) {
    const probe = (dir) => JSON.parse(readFileSync(join(dir, 'sandbox-probe.json'), 'utf8'));
    const controller = probe(cwd);
    assert.deepEqual(probe(completed.taskDir), controller);
    assert.match(controller.readError, /^(EACCES|EPERM)$/);
    assert.deepEqual(controller.response, {status: 200, body: 'test upstream'});
    assert.deepEqual(hits, ['/controller', '/child']);
  }
}

test('Node SDK controller gets a real Pi report and reaps an active child on shutdown', {
  timeout: 30_000,
}, (t) => smoke(t, false));

test('Node SDK child inherits nono filesystem denial and the same test proxy', {
  timeout: 30_000,
  skip: process.env.NONO_SDK_INTEGRATION !== '1' && 'set NONO_SDK_INTEGRATION=1 to test nono',
}, (t) => smoke(t, true));
