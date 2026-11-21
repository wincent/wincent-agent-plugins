import {strict as assert} from 'node:assert';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {piPackageImports} from '../../tests/pi-package.mjs';

test('child runtime inherits explicit extensions using the public Pi parser', async (t) => {
  const packages = ['@earendil-works/pi-coding-agent'];
  const hooks = registerHooks(piPackageImports(['jiti', ...packages]));
  try {
    const {createJiti} = await import(import.meta.resolve('jiti'));
    const jiti = createJiti(import.meta.url, {
      alias: Object.fromEntries(packages.map((name) => [
        name, fileURLToPath(import.meta.resolve(name)),
      ])),
    });
    const {subagentPiRuntime} = await jiti.import('../main/runtime.ts');
    const runtime = {executable: '/runtime/node', args: ['/runtime/pi.js']};
    const entry = realpathSync(fileURLToPath(new URL('../index.ts', import.meta.url)));
    const cwd = "/controller's project";
    const cliRuntime = (argv) => subagentPiRuntime({mode: 'cli', runtime}, argv, cwd);
    const {parseArgs, DefaultResourceLoader, SettingsManager} = await import(
      '@earendil-works/pi-coding-agent'
    );

    await t.test('relative, absolute, home, file URL, and package sources', async () => {
      const sources = [
        './provider.ts', '../other.ts', '/absolute/provider.ts',
        '~/provider.ts', 'builtin:codemode', 'npm:@test/provider',
        'git:github.com/test/provider', 'https://github.com/test/provider',
        pathToFileURL('/file url/provider.ts').href,
      ];
      const result = await cliRuntime(
        sources.flatMap((source, index) => [index % 2 ? '--extension' : '-e', source]),
      );
      assert.equal(result.executable, runtime.executable);
      assert.deepEqual(parseArgs(result.args.slice(1)).extensions, [
        resolve(cwd, './provider.ts'), resolve(cwd, '../other.ts'),
        '/absolute/provider.ts', join(homedir(), 'provider.ts'),
        ...sources.slice(4, 8), '/file url/provider.ts', entry,
      ]);
      assert.deepEqual(runtime.args, ['/runtime/pi.js']);
    });

    await t.test('only recognized selections propagate, never prompt text or approval', async () => {
      const result = await cliRuntime([
        '-ne', '-ns', '-np', '--no-themes', '-nc', '--no-mcp', '--offline',
        '--approve', '--system-prompt', '-e',
        '--extensions', 'not-a-session-alias.ts',
        '-e', './provider.ts', '--extension', './provider.ts',
        '--extension', entry, '--', '-e', './untrusted.ts',
      ]);
      const parsed = parseArgs(result.args.slice(1));
      assert.deepEqual(parsed.extensions, [resolve(cwd, 'provider.ts'), entry]);
      assert.equal(parsed.projectTrustOverride, undefined);
      for (const name of [
        'noExtensions', 'noSkills', 'noPromptTemplates', 'noThemes',
        'noContextFiles', 'noMcp', 'offline',
      ]) assert.equal(parsed[name], true, name);
      assert.deepEqual(parsed.messages, []);
      assert.equal(parsed.systemPrompt, undefined);
      const denied = await cliRuntime(['-na']);
      assert.equal(parseArgs(denied.args.slice(1)).projectTrustOverride, false);
    });

    await t.test('required handlers load even with no explicit extensions', async () => {
      const result = await cliRuntime(['--no-extensions']);
      assert.deepEqual(parseArgs(result.args.slice(1)).extensions, [entry]);
    });

    await t.test('required extension directory and entry point do not load twice', async () => {
      const result = await cliRuntime(['-e', resolve(entry, '..'), '-e', entry]);
      assert.deepEqual(parseArgs(result.args.slice(1)).extensions, [entry]);
    });

    await t.test('Pi deduplicates explicit files, symlinks and discovered selections', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sa-extension-'));
      try {
        const extension = join(dir, 'example');
        mkdirSync(extension);
        const file = join(extension, 'index.ts');
        writeFileSync(file, 'export default function (pi) { pi.registerFlag("unique-test-flag", {type: "boolean"}); }');
        const alias = join(dir, 'alias.ts');
        symlinkSync(file, alias);
        for (const source of [alias, extension, dir]) {
          const loader = new DefaultResourceLoader({
            cwd: dir,
            agentDir: dir,
            settingsManager: SettingsManager.inMemory({
              extensions: [source], defaultProjectTrust: 'never',
            }),
            additionalExtensionPaths: [file, alias],
          });
          await loader.reload();
          assert.equal(loader.getExtensions().extensions.length, 1, JSON.stringify(loader.getExtensions().extensions.map((extension) => ({path: extension.path, resolvedPath: extension.resolvedPath}))));
          assert.deepEqual(loader.getExtensions().errors, []);
        }
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });
  } finally {
    hooks.deregister();
  }
});
