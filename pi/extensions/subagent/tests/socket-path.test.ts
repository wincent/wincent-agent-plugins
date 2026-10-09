import {strict as assert} from 'node:assert';
import {existsSync} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';

import {AuditLog} from '../bus/audit-log.js';
import {Bus} from '../bus/bus.js';
import {allocateTaskSocket, validateSocketPath} from '../bus/socket-path.js';
import {connectToPeer, listenForPeer} from '../bus/transport-uds.js';
import {launchSubagent} from '../main/launch.js';
import {terminateProcess, waitForExit} from '../main/spawn.js';
import {spawnFakeChild} from './fixtures/runtime.js';

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ss-'));
  const keys = ['PI_SUBAGENT_SOCKET_ROOT', 'PI_SUBAGENT_SOCKET_PATH'];
  const values = keys.map((key) => process.env[key]);
  process.env.PI_SUBAGENT_SOCKET_ROOT = root;
  try {
    await fn(root);
  } finally {
    keys.forEach((key, i) => {
      if (values[i] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = values[i];
      }
    });
    await rm(root, {recursive: true, force: true});
  }
}

function launchArgs(dir: string, task = 'normal') {
  return {
    taskId: 'test_socket',
    taskDir: dir,
    task,
    cwd: dir,
    parentId: 'parent',
    toolsWhitelist: [],
    systemPromptPath: join(dir, 'system.md'),
  };
}

test('path validation counts UTF-8 bytes and reserves the terminating NUL', () => {
  validateSocketPath('/' + 'a'.repeat(102), 'darwin');
  assert.throws(
    () => validateSocketPath('/' + 'a'.repeat(103), 'darwin'),
    /104 bytes.*103 bytes/,
  );
  validateSocketPath('/' + 'a'.repeat(106), 'linux');
  assert.throws(
    () => validateSocketPath('/' + 'a'.repeat(107), 'linux'),
    /108 bytes.*107 bytes/,
  );
  assert.throws(
    () => validateSocketPath('/' + 'é'.repeat(52), 'darwin'),
    /105 bytes/,
  );
  assert.throws(() => validateSocketPath('relative'), /absolute/);
  assert.throws(() => validateSocketPath('/nul\0path'), /NUL/);
});

test('concurrent allocations are private, unique, and clean up only their own directory', async () => {
  await withRoot(async (root) => {
    const sockets = await Promise.all(
      Array.from({length: 12}, () => allocateTaskSocket()),
    );
    assert.equal(new Set(sockets.map(({path}) => path)).size, 12);
    for (const socket of sockets) {
      assert.equal(dirname(dirname(socket.path)), root);
      assert.equal((await lstat(dirname(socket.path))).mode & 0o777, 0o700);
    }
    await sockets[0].cleanup();
    await sockets[0].cleanup();
    assert.equal((await readdir(root)).length, 11);
    assert.ok(existsSync(dirname(sockets[1].path)));
    await Promise.all(sockets.slice(1).map((socket) => socket.cleanup()));
    assert.deepEqual(await readdir(root), []);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
  });
});

test('unset root uses a private temporary directory without depending on artifact paths', async () => {
  await withRoot(async () => {
    delete process.env.PI_SUBAGENT_SOCKET_ROOT;
    const socket = await allocateTaskSocket();
    try {
      assert.equal(dirname(dirname(socket.path)), tmpdir());
      validateSocketPath(socket.path);
    } finally {
      await socket.cleanup();
    }
    assert.ok(!existsSync(dirname(socket.path)));
  });
});

test('invalid configured roots fail without fallback or creating directories', async () => {
  await withRoot(async (root) => {
    const file = join(root, 'file');
    await writeFile(file, 'keep');
    const link = join(root, 'link');
    await symlink(root, link);
    const publicDir = join(root, 'public');
    await mkdir(publicDir, {mode: 0o755});
    await chmod(publicDir, 0o755);
    const before = await readdir(root);
    for (
      const bad of [
        '',
        'relative',
        join(root, 'missing'),
        file,
        link,
        link + '/',
        publicDir,
        '/' + 'é'.repeat(100),
      ]
    ) {
      process.env.PI_SUBAGENT_SOCKET_ROOT = bad;
      await assert.rejects(
        allocateTaskSocket(),
        /PI_SUBAGENT_SOCKET_ROOT; no fallback/,
      );
      assert.deepEqual(await readdir(root), before);
    }
  });
});

test('cleanup refuses unexpected contents or a replaced allocation', async () => {
  await withRoot(async (root) => {
    const socket = await allocateTaskSocket();
    const directory = dirname(socket.path);
    await writeFile(join(directory, 'keep'), 'unrelated');
    await assert.rejects(socket.cleanup(), /Could not clean up/);
    assert.ok(existsSync(join(directory, 'keep')));
    const moved = join(root, 'original');
    await rename(directory, moved);
    await mkdir(directory);
    await assert.rejects(socket.cleanup(), /replaced socket directory/);
    assert.ok(existsSync(directory));
    assert.ok(existsSync(join(moved, 'keep')));
  });
});

test(
  'long artifact paths and concurrent launches propagate the exact allocated socket path',
  {timeout: 10_000},
  async () => {
    await withRoot(async (root) => {
      process.env.PI_SUBAGENT_SOCKET_PATH = '/stale-parent-path';
      const artifacts = join(root, 'artifacts-' + 'x'.repeat(110));
      await mkdir(artifacts);
      const runs = await Promise.all([0, 1, 2].map(async (index) => {
        const dir = join(artifacts, String(index));
        await mkdir(dir);
        const launched = await launchSubagent(launchArgs(dir), {
          connectTimeoutMs: 3000,
          killGraceMs: 100,
        }, spawnFakeChild);
        return {dir, launched};
      }));
      try {
        assert.equal(
          new Set(runs.map(({launched}) => launched.socketPath)).size,
          3,
        );
        for (const {dir, launched} of runs) {
          assert.deepEqual(
            JSON.parse(await readFile(join(dir, 'socket-env.json'), 'utf8')),
            {
              busDir: dir,
              socketPath: launched.socketPath,
            },
          );
          assert.equal((await waitForExit(launched.process, 3000))?.code, 0);
          await launched.transport.close();
          await launched.transport.close();
          assert.ok(!existsSync(dirname(launched.socketPath)));
          assert.ok(existsSync(join(dir, 'stdout.log')));
          assert.ok(existsSync(join(dir, 'run.sh')));
        }
        assert.deepEqual(await readdir(root), ['artifacts-' + 'x'.repeat(110)]);
      } finally {
        for (const {launched} of runs) {
          await terminateProcess(launched.process, 0, 100);
          await launched.transport.close();
        }
      }
    });
  },
);

for (const mode of ['exit-early', 'no-connect', 'aborted', 'spawn-failure']) {
  test(`launch failure removes only its socket allocation: ${mode}`, {
    timeout: 10_000,
  }, async () => {
    await withRoot(async (root) => {
      const sibling = await allocateTaskSocket();
      const dir = join(root, 'artifacts');
      await mkdir(dir);
      const controller = new AbortController();
      const args = launchArgs(dir, mode === 'aborted' ? 'no-connect' : mode);
      if (mode === 'spawn-failure') {
        args.cwd = join(root, 'missing');
      }
      const pending = launchSubagent(args, {
        connectTimeoutMs: 150,
        killGraceMs: 100,
        signal: controller.signal,
      }, spawnFakeChild);
      const timer = mode === 'aborted'
        ? setTimeout(() => controller.abort(), 30)
        : undefined;
      try {
        await assert.rejects(pending);
        assert.deepEqual(
          (await readdir(root)).sort(),
          ['artifacts', dirname(sibling.path).split('/').at(-1)!].sort(),
        );
        assert.ok(existsSync(dir));
      } finally {
        clearTimeout(timer);
        await sibling.cleanup();
      }
    });
  });
}

test('configured allocation failure never starts a child', async () => {
  await withRoot(async (root) => {
    process.env.PI_SUBAGENT_SOCKET_ROOT = join(root, 'missing');
    await assert.rejects(
      launchSubagent(launchArgs(root), {
        connectTimeoutMs: 100,
        killGraceMs: 100,
      }, () => {
        assert.fail('allocation failure must prevent child launch');
      }),
      /no fallback/,
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test('socket cleanup failures preserve unexpected files and still flush audit logs', async () => {
  await withRoot(async (root) => {
    const artifacts = join(root, 'artifacts');
    await mkdir(artifacts);
    const launched = await launchSubagent(launchArgs(artifacts), {
      connectTimeoutMs: 3000,
      killGraceMs: 100,
    }, spawnFakeChild);
    const audit = new AuditLog(join(artifacts, 'bus.jsonl'));
    const flush = audit.flush.bind(audit);
    let flushCalls = 0;
    audit.flush = async () => {
      flushCalls++;
      await flush();
    };
    const bus = new Bus(launched.transport, audit, 'main');
    try {
      await writeFile(join(dirname(launched.socketPath), 'keep'), 'unrelated');
      assert.equal((await waitForExit(launched.process, 3000))?.code, 0);
      const beforeClose = flushCalls;
      await assert.rejects(
        bus.close(),
        /Could not clean up subagent socket directory/,
      );
      assert.equal(flushCalls, beforeClose + 1);
      assert.match(
        await readFile(join(artifacts, 'bus.jsonl'), 'utf8'),
        /finished/,
      );
      assert.ok(existsSync(join(dirname(launched.socketPath), 'keep')));
      assert.ok(existsSync(root));
    } finally {
      await terminateProcess(launched.process, 0, 100);
      await bus.close().catch(() => {});
    }
  });
});

test('bind collisions never unlink another listener socket', async () => {
  await withRoot(async () => {
    const socket = await allocateTaskSocket();
    const listening = listenForPeer(socket.path, {timeoutMs: 1000});
    void listening.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    try {
      await assert.rejects(
        listenForPeer(socket.path, {timeoutMs: 1000}),
        /EADDRINUSE/,
      );
      assert.ok(existsSync(socket.path));
      const client = await connectToPeer(socket.path, {timeoutMs: 1000});
      const server = await listening;
      await client.close();
      await server.close();
    } finally {
      await listening.then((transport) => transport.close(), () => {});
      await socket.cleanup();
    }
  });
});

test('listener bind failure and timeout settle before allocation cleanup', async () => {
  await withRoot(async () => {
    const socket = await allocateTaskSocket();
    const controller = new AbortController();
    const listening = listenForPeer(socket.path, {
      timeoutMs: 1000,
      signal: controller.signal,
    });
    void listening.catch(() => {});
    const client = await connectToPeer(socket.path, {timeoutMs: 1000});
    const server = await listening;
    await client.close();
    await server.close();
    await socket.cleanup();

    const missing = await allocateTaskSocket();
    await missing.cleanup();
    assert.ok(!existsSync(dirname(missing.path)));
    // Darwin reports EACCES for a missing bind parent; Linux reports ENOENT.
    await assert.rejects(
      listenForPeer(missing.path, {timeoutMs: 1000}),
      /listen (ENOENT|EACCES)/,
    );
    const timedOut = await allocateTaskSocket();
    await assert.rejects(
      listenForPeer(timedOut.path, {timeoutMs: 20}),
      /timed out/,
    );
    await timedOut.cleanup();
  });
});
