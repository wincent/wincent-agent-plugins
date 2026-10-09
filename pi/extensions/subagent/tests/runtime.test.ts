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

import {runningPiRuntime} from '../main/runtime.js';

function fixture(t: {after: (fn: () => void) => void}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const root = join(dir, "Pi package's directory");
  mkdirSync(join(root, 'dist'), {recursive: true});
  const cli = join(root, 'dist', 'cli.js');
  writeFileSync(cli, '');
  const manifest = join(root, 'package.json');
  const pkg = {
    name: '@earendil-works/pi-coding-agent',
    bin: {pi: 'dist/cli.js'},
  };
  writeFileSync(manifest, JSON.stringify(pkg));
  return {dir, root, cli, manifest, pkg};
}

test('runtime selection reuses the controlling interpreter and canonical installed CLI', (t) => {
  const {dir, cli} = fixture(t);
  const link = join(dir, 'pi');
  symlinkSync(cli, link);
  assert.deepEqual(runningPiRuntime(process.execPath, link), {
    executable: realpathSync(process.execPath),
    args: [realpathSync(cli)],
  });
});

test('runtime selection accepts the string bin manifest form', (t) => {
  const {manifest, pkg, cli} = fixture(t);
  writeFileSync(manifest, JSON.stringify({...pkg, bin: 'dist/cli.js'}));
  assert.equal(
    runningPiRuntime(process.execPath, cli).args[0],
    realpathSync(cli),
  );
});

test('runtime selection rejects SDK hosts and other entrypoints inside the Pi package', (t) => {
  const {root} = fixture(t);
  const host = join(root, 'host.js');
  writeFileSync(host, '');
  assert.throws(
    () => runningPiRuntime(process.execPath, host),
    /not the installed Pi CLI.*no PATH or launcher fallback/,
  );
});

test('runtime selection rejects unrelated packages, invalid manifests, and missing CLI files', (t) => {
  const {manifest, cli, pkg} = fixture(t);
  writeFileSync(manifest, JSON.stringify({...pkg, name: 'not-pi'}));
  assert.throws(
    () => runningPiRuntime(process.execPath, cli),
    /no Pi package manifest/,
  );
  writeFileSync(manifest, 'invalid JSON');
  assert.throws(
    () => runningPiRuntime(process.execPath, cli),
    /Cannot identify the controlling Pi runtime/,
  );
  rmSync(cli);
  assert.throws(
    () => runningPiRuntime(process.execPath, cli),
    /ENOENT.*no PATH or launcher fallback/,
  );
});

test('runtime selection rejects relative paths and missing interpreter files', (t) => {
  const {dir, cli} = fixture(t);
  assert.throws(
    () => runningPiRuntime(process.execPath, 'pi'),
    /absolute runtime and CLI paths/,
  );
  assert.throws(
    () => runningPiRuntime('node', cli),
    /absolute runtime and CLI paths/,
  );
  assert.throws(
    () => runningPiRuntime(join(dir, 'missing-node'), cli),
    /ENOENT.*no PATH or launcher fallback/,
  );
});
