import {strict as assert} from 'node:assert';
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {test} from 'node:test';
import {locatePiPackage} from './pi-package.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-package-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const pkg = join(root, 'custom install', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const dist = join(pkg, 'dist');
  mkdirSync(dist, {recursive: true});
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({name: '@earendil-works/pi-coding-agent'}));
  const cli = join(dist, 'cli.js');
  writeFileSync(cli, '#!/bin/sh\nexit 99\n');
  chmodSync(cli, 0o755);
  return {root, bin, pkg, cli};
}

test('discovers Pi through chained relative executable symlinks without npm or running Pi', (t) => {
  const {root, bin, pkg, cli} = fixture(t);
  const shim = join(root, 'custom install', 'node_modules', '.bin');
  mkdirSync(shim);
  symlinkSync(relative(shim, cli), join(shim, 'pi'));
  symlinkSync(relative(bin, join(shim, 'pi')), join(bin, 'pi'));
  assert.equal(locatePiPackage({PATH: bin}), pkg);
});

test('missing Pi reports an actionable error', (t) => {
  const {bin} = fixture(t);
  assert.throws(() => locatePiPackage({PATH: bin}), /Cannot locate `pi` on PATH.*Install Pi/);
});

test('an unrelated executable reports an actionable error', (t) => {
  const {bin} = fixture(t);
  writeFileSync(join(bin, 'pi'), '#!/bin/sh\nexit 99\n', {mode: 0o755});
  assert.throws(() => locatePiPackage({PATH: bin}), /Cannot find @earendil-works\/pi-coding-agent.*executable on PATH/);
});

test('a different or malformed package manifest cannot identify Pi', (t) => {
  const {bin, pkg, cli} = fixture(t);
  symlinkSync(cli, join(bin, 'pi'));
  for (const manifest of [JSON.stringify({name: 'not-pi'}), '{']) {
    writeFileSync(join(pkg, 'package.json'), manifest);
    assert.throws(() => locatePiPackage({PATH: bin}), /Cannot find @earendil-works\/pi-coding-agent/);
  }
});
