#!/usr/bin/env node
/**
 * Test runner for the subagent extension.
 *
 * Invokes `node --test --import jiti/register` against every tests/*.test.ts
 * and tests/*.test.mjs file. jiti is borrowed from the discovered Pi installation
 * (it's Pi's runtime extension loader). Runtime-backed unit tests explicitly
 * alias platform imports to that installation instead of the type-only stubs.
 *
 * Usage:
 *   node pi/extensions/subagent/tests/run.mjs
 *
 * Exits non-zero if any test fails.
 */

import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {piPackageImports} from '../../tests/pi-package.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function locateJitiRegister() {
  const hooks = registerHooks(piPackageImports(['jiti/register']));
  try {
    return fileURLToPath(import.meta.resolve('jiti/register'));
  } finally {
    hooks.deregister();
  }
}

const jitiRegister = locateJitiRegister();
const testFiles = readdirSync(__dirname)
  .filter((f) => /\.test\.(?:ts|mjs)$/.test(f))
  .map((f) => resolve(__dirname, f));

if (testFiles.length === 0) {
  console.log('no test files found');
  process.exit(0);
}

const args = ['--test', '--import', jitiRegister, ...testFiles];
const result = spawnSync('node', args, {stdio: 'inherit'});
process.exit(result.status ?? 1);
