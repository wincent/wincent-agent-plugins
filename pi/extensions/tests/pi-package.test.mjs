import {strict as assert} from 'node:assert';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {locatePiPackage, piPackageImports} from './pi-package.mjs';

function resolveImports(specifiers, piDir) {
  const hooks = registerHooks(piPackageImports(specifiers, piDir));
  try {
    return new Map(specifiers.map((specifier) => [specifier, import.meta.resolve(specifier)]));
  } finally {
    hooks.deregister();
  }
}

const packageName = '@earendil-works/pi-coding-agent';

function packageAt(dir, name, subpath = '.') {
  mkdirSync(join(dir, 'dist'), {recursive: true});
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    type: 'module',
    exports: {[subpath]: {import: './dist/index.js'}},
    main: './dist/incorrect-require-entry.js',
  }));
  writeFileSync(join(dir, 'dist/index.js'), 'throw new Error("Resolution must not execute packages");\n');
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-package-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const home = join(root, 'home with spaces');
  const modules = join(home, 'n/pi/node_modules');
  const pkg = join(modules, packageName);
  packageAt(pkg, packageName);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // A launcher on PATH must never be inspected or executed.
  writeFileSync(join(bin, 'pi'), '#!/bin/sh\nexit 99\n', {mode: 0o755});
  const env = {HOME: home, PATH: bin};
  return {root, home, modules, pkg, env};
}

test('locates the managed package regardless of a wrapper or missing Pi on PATH', (t) => {
  const {pkg, env} = fixture(t);
  assert.equal(locatePiPackage(env), pkg);
  assert.equal(locatePiPackage({...env, PATH: ''}), pkg);
  assert.equal(locatePiPackage({...env, PI_REAL_BIN: ''}), pkg);
});

test('PI_REAL_BIN takes precedence and follows chained relative symlinks without executing Pi', (t) => {
  const {root, env, pkg: managed} = fixture(t);
  const pkg = join(root, 'explicit runtime/node_modules', packageName);
  packageAt(pkg, packageName);
  const bundle = join(pkg, 'dist/bundle');
  mkdirSync(bundle);
  const cli = join(bundle, 'cli.js');
  writeFileSync(cli, 'throw new Error("Do not run Pi to discover its package");\n');
  const shim = join(root, 'explicit runtime/node_modules/.bin');
  mkdirSync(shim);
  symlinkSync(relative(shim, cli), join(shim, 'pi'));
  const entry = join(root, 'real-pi');
  symlinkSync(relative(root, join(shim, 'pi')), entry);
  const selected = {...env, PI_REAL_BIN: entry};
  assert.equal(locatePiPackage(selected), pkg);
  rmSync(managed, {recursive: true});
  assert.equal(locatePiPackage(selected), pkg);
  const ai = join(root, 'explicit runtime/node_modules/@earendil-works/pi-ai');
  packageAt(ai, '@earendil-works/pi-ai');
  assert.equal(resolveImports(['@earendil-works/pi-ai'], locatePiPackage(selected)).get('@earendil-works/pi-ai'), pathToFileURL(join(ai, 'dist/index.js')).href);
});

test('invalid PI_REAL_BIN never falls back to the available managed runtime', (t) => {
  const {root, env} = fixture(t);
  assert.throws(
    () => locatePiPackage({...env, PI_REAL_BIN: join(root, 'missing')}),
    /Cannot resolve PI_REAL_BIN/,
  );
  assert.throws(
    () => locatePiPackage({...env, PI_REAL_BIN: join(env.PATH, 'pi')}),
    /Cannot find.*for PI_REAL_BIN.*real executable, not a wrapper/,
  );
});

test('PI_REAL_BIN rejects unrelated and malformed package manifests', (t) => {
  const {root, env} = fixture(t);
  const pkg = join(root, 'not-pi');
  packageAt(pkg, 'not-pi');
  const selected = {...env, PI_REAL_BIN: join(pkg, 'dist/index.js')};
  assert.throws(() => locatePiPackage(selected), /Cannot find.*for PI_REAL_BIN/);
  writeFileSync(join(pkg, 'package.json'), '{');
  assert.throws(() => locatePiPackage(selected), /Cannot find.*for PI_REAL_BIN/);
});

test('missing managed Pi never falls back to a global installation', (t) => {
  const {root, pkg, env} = fixture(t);
  rmSync(pkg, {recursive: true});
  const global = join(root, 'global/node_modules', packageName);
  packageAt(global, packageName);
  assert.throws(
    () => locatePiPackage({...env, NODE_PATH: join(root, 'global/node_modules')}),
    /Cannot locate managed.*Tests require ~\/n\/pi; PATH\/global Pi installations are not used/,
  );
});

test('a different or malformed managed manifest cannot identify Pi', (t) => {
  const {pkg, env} = fixture(t);
  for (const manifest of [JSON.stringify({name: 'not-pi'}), '{']) {
    writeFileSync(join(pkg, 'package.json'), manifest);
    assert.throws(() => locatePiPackage(env), /Cannot locate managed @earendil-works\/pi-coding-agent/);
  }
});

for (const layout of ['nested', 'hoisted']) {
  test(`resolves platform imports from Pi with ${layout} dependencies`, (t) => {
    const {pkg, modules, env} = fixture(t);
    const specifiers = [packageName, '@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui', 'typebox'];
    const expected = [[packageName, pathToFileURL(join(pkg, 'dist/index.js')).href]];
    for (const specifier of specifiers.slice(1)) {
      const dir = join(layout === 'nested' ? join(pkg, 'node_modules') : modules, specifier);
      packageAt(dir, specifier);
      expected.push([specifier, pathToFileURL(join(dir, 'dist/index.js')).href]);
    }
    const jiti = join(layout === 'nested' ? join(pkg, 'node_modules') : modules, 'jiti');
    packageAt(jiti, 'jiti', './register');
    specifiers.push('jiti/register');
    expected.push(['jiti/register', pathToFileURL(join(jiti, 'dist/index.js')).href]);
    assert.deepEqual([...resolveImports(specifiers, locatePiPackage(env))], expected);
  });
}

test('nested dependency wins over a hoisted copy', (t) => {
  const {pkg, modules} = fixture(t);
  const name = '@earendil-works/pi-ai';
  const nested = join(pkg, 'node_modules', name);
  packageAt(nested, name);
  packageAt(join(modules, name), name);
  assert.equal(resolveImports([name], pkg).get(name), pathToFileURL(join(nested, 'dist/index.js')).href);
});
