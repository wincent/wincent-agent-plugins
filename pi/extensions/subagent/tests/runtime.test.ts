import {strict as assert} from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {
  PI_ENTRYPOINT_ENV,
  resolvePiRuntime,
  validatePiRuntime,
} from '../main/runtime.js';

function fixture(t: {after: (fn: () => void) => void}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const root = join(dir, "Pi package's directory");
  mkdirSync(join(root, 'dist'), {recursive: true});
  const cli = join(root, 'dist', 'cli.js');
  writeFileSync(cli, '');
  const host = join(dir, 'sdk-host.mjs');
  writeFileSync(host, '');
  const manifest = join(root, 'package.json');
  const pkg = {
    name: '@earendil-works/pi-coding-agent',
    bin: {pi: 'dist/cli.js'},
  };
  writeFileSync(manifest, JSON.stringify(pkg));
  const runtime = {
    executable: realpathSync(process.execPath),
    args: [realpathSync(cli)],
  };
  return {dir, root, cli, host, manifest, pkg, runtime};
}

test('runtime validation canonicalizes both the interpreter and installed CLI', (t) => {
  const {dir, cli, runtime} = fixture(t);
  const link = join(dir, 'pi');
  const interpreter = join(dir, 'node');
  symlinkSync(cli, link);
  symlinkSync(process.execPath, interpreter);
  assert.deepEqual(validatePiRuntime(interpreter, link), runtime);
});

test('runtime validation accepts the string bin manifest form', (t) => {
  const {manifest, pkg, cli, runtime} = fixture(t);
  writeFileSync(manifest, JSON.stringify({...pkg, bin: 'dist/cli.js'}));
  assert.deepEqual(validatePiRuntime(process.execPath, cli), runtime);
});

test('runtime validation rejects relative paths and missing interpreter files', (t) => {
  const {dir, cli} = fixture(t);
  assert.throws(
    () => validatePiRuntime(process.execPath, 'pi'),
    /absolute runtime and CLI paths/,
  );
  assert.throws(
    () => validatePiRuntime('node', cli),
    /absolute runtime and CLI paths/,
  );
  assert.throws(
    () => validatePiRuntime(join(dir, 'missing-node'), cli),
    {code: 'ENOENT'},
  );
});

test('SDK hosts opt into an absolute installed entrypoint or a symlink to it', (t) => {
  const {dir, cli, host, runtime} = fixture(t);
  const link = join(dir, 'pi');
  symlinkSync(cli, link);
  for (const entrypoint of [cli, link]) {
    assert.deepEqual(
      resolvePiRuntime(process.execPath, host, {
        [PI_ENTRYPOINT_ENV]: entrypoint,
      }),
      {mode: 'sdk', runtime},
    );
  }
});

test('valid running Pi takes precedence without consulting explicit configuration', (t) => {
  const {cli, runtime} = fixture(t);
  assert.deepEqual(
    resolvePiRuntime(process.execPath, cli, {
      get [PI_ENTRYPOINT_ENV](): string {
        throw new Error('must not read the setting');
      },
    }),
    {mode: 'cli', runtime},
  );
});

test('SDK hosts with no usable setting get an actionable dispatch error', (t) => {
  const {dir, root, cli, host, manifest, pkg} = fixture(t);
  const resolve = (entrypoint?: string) =>
    resolvePiRuntime(process.execPath, host, {[PI_ENTRYPOINT_ENV]: entrypoint});
  const action =
    /Cannot dispatch subagent: .*Set PI_SUBAGENT_PI_ENTRYPOINT in the SDK host or launcher.*No PATH or launcher fallback/;
  assert.throws(() => resolve(), action);
  const invalid = (value: string, reason: RegExp) => {
    assert.throws(() => resolve(value), (error: Error) => {
      assert.match(error.message, action);
      assert.match(error.message, /PI_SUBAGENT_PI_ENTRYPOINT is invalid/);
      assert.match(error.message, reason);
      return true;
    });
  };
  invalid('', /absolute runtime and CLI paths/);
  invalid('dist/cli.js', /absolute runtime and CLI paths/);
  invalid(join(dir, 'missing'), /ENOENT/);
  const wrapper = join(dir, 'wrapper');
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${cli}" "$@"\n`, {mode: 0o700});
  invalid(wrapper, /no Pi package manifest/);
  const otherScript = join(root, 'sdk-host.js');
  writeFileSync(otherScript, '');
  invalid(otherScript, /not the declared Pi bin/);
  writeFileSync(
    manifest,
    JSON.stringify({...pkg, bin: {other: 'dist/cli.js'}}),
  );
  invalid(cli, /not the declared Pi bin/);
  writeFileSync(manifest, JSON.stringify({...pkg, name: 'not-pi'}));
  invalid(cli, /no Pi package manifest/);
  writeFileSync(manifest, 'invalid JSON');
  invalid(cli, /JSON/);
});
