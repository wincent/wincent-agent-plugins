import {fileURLToPath} from 'node:url';
import {type SpawnArgs, spawnSubagent} from '../../main/spawn.js';

export function spawnFakeChild(args: SpawnArgs) {
  return spawnSubagent(args, {
    executable: process.execPath,
    args: [fileURLToPath(new URL('./fake-child.mjs', import.meta.url))],
  });
}
