import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, join} from 'node:path';

export interface PiRuntime {
  executable: string;
  args: string[];
}

/** Reuse the running CLI, never a PATH shim or a sandbox bootstrap wrapper. */
export function runningPiRuntime(
  executable = process.execPath,
  entrypoint = process.argv[1],
): PiRuntime {
  try {
    if (!entrypoint || !isAbsolute(entrypoint) || !isAbsolute(executable)) {
      throw new Error('expected absolute runtime and CLI paths');
    }
    const cli = realpathSync(entrypoint);
    let directory = dirname(cli);
    while (true) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (pkg.name === '@earendil-works/pi-coding-agent') {
          const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
          if (
            typeof bin !== 'string' ||
            realpathSync(join(directory, bin)) !== cli
          ) {
            throw new Error(
              'controller entrypoint is not the installed Pi CLI',
            );
          }
          return {executable: realpathSync(executable), args: [cli]};
        }
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
    throw new Error('controller entrypoint has no Pi package manifest');
  } catch (error) {
    throw new Error(
      `Cannot identify the controlling Pi runtime: ${
        (error as Error).message
      }. Subagents require an installed Node/Bun Pi CLI; no PATH or launcher fallback is used.`,
    );
  }
}
