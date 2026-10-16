import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SuiteContext, TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {type SpawnArgs, spawnSubagent} from '../../main/spawn.js';

// Fake runtimes must not create directories in the user's durable storage.
export function isolateAgentDir(t: TestContext | SuiteContext): void {
  if (!('after' in t)) {
    throw new Error('isolateAgentDir must run in a per-test hook');
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "sa agent's "));
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    rmSync(dir, {recursive: true, force: true});
  });
}

export function spawnFakeChild(args: SpawnArgs) {
  return spawnSubagent(args, {
    executable: process.execPath,
    args: [fileURLToPath(new URL('./fake-child.mjs', import.meta.url))],
  });
}
