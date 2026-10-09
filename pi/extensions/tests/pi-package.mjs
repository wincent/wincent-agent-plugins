import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';

const packageName = '@earendil-works/pi-coding-agent';

function isPiPackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === packageName;
  } catch {
    return false;
  }
}

export function locatePiPackage(env = process.env) {
  let entry;
  try {
    const executable = execFileSync('/bin/sh', ['-c', 'command -v pi'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    entry = realpathSync(executable);
  } catch {
    throw new Error('Cannot locate `pi` on PATH. Install Pi and ensure its executable is on PATH.');
  }

  for (let dir = dirname(entry);; dir = dirname(dir)) {
    if (isPiPackage(dir)) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new Error(`Cannot find ${packageName} for ${entry}. Ensure the pi executable on PATH belongs to an installed Pi package.`);
}
