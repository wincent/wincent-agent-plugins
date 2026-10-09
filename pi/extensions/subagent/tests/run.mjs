#!/usr/bin/env node
/**
 * Test runner for the subagent extension.
 *
 * Invokes `node --test --import jiti/register` against every tests/*.test.ts
 * file. jiti is borrowed from the discovered Pi installation (it's Pi's runtime
 * extension loader), so the same module-resolution rules apply at test time
 * as at runtime.
 *
 * Usage:
 *   node pi/extensions/subagent/tests/run.mjs
 *
 * Exits non-zero if any test fails.
 */

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {locatePiPackage} from '../../tests/pi-package.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function locateJitiRegister() {
  const piPkgRoot = locatePiPackage();
  const candidate = join(piPkgRoot, 'node_modules', 'jiti', 'lib', 'jiti-register.mjs');
  if (!existsSync(candidate)) {
    throw new Error(`jiti not found at expected path: ${candidate}`);
  }
  return candidate;
}

const jitiRegister = locateJitiRegister();
const testFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => resolve(__dirname, f));

if (testFiles.length === 0) {
  console.log('no test files found');
  process.exit(0);
}

const args = ['--test', '--import', jitiRegister, ...testFiles];
const result = spawnSync('node', args, {stdio: 'inherit'});
process.exit(result.status ?? 1);
