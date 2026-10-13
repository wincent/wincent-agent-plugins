import {strict as assert} from 'node:assert';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
