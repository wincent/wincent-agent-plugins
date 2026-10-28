import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface PiRuntime {
  executable: string;
  args: string[];
}

/**
 * Carry explicit CLI resources, not the controller's discovered project code.
 * ExtensionAPI has no loaded-extension inventory. Use Pi's public parser so
 * prompts, option values, aliases, and the -- terminator keep CLI semantics.
 */
export async function subagentPiRuntime(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  runtime = runningPiRuntime(),
): Promise<PiRuntime> {
  const {parseArgs} = await import('@earendil-works/pi-coding-agent');
  const parsed = parseArgs(argv);
  const args = [...runtime.args];
  for (
    const [enabled, flag] of [
      [parsed.noExtensions, '--no-extensions'],
      [parsed.noMcp, '--no-mcp'],
      [parsed.noSkills, '--no-skills'],
      [parsed.noPromptTemplates, '--no-prompt-templates'],
      [parsed.noThemes, '--no-themes'],
      [parsed.noContextFiles, '--no-context-files'],
      [parsed.offline, '--offline'],
      [parsed.projectTrustOverride === false, '--no-approve'],
    ] as const
  ) {
    if (enabled) {
      args.push(flag);
    }
  }
  // Never propagate --approve: the child may run in another project.
  // Pi deduplicates canonical extension files across explicit sources and
  // discovery. Its bare directory sources are not equivalent to index.ts, so
  // normalize this extension's directory before ensuring the required entry.
  const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
  const extensions = new Set([
    ...(parsed.extensions ?? []).map((source) => {
      const resolved = extensionSource(source, cwd);
      try {
        if (realpathSync(resolved) === realpathSync(dirname(entry))) {
          return entry;
        }
      } catch {
        // Package sources and missing paths remain Pi's responsibility.
      }
      return resolved;
    }),
    entry,
  ]);
  for (const extension of extensions) {
    args.push('--extension', extension);
  }
  return {...runtime, args};
}

function extensionSource(source: string, cwd: string): string {
  // Keep package sources for Pi's own resolver; never resolve them as files.
  if (/^(npm:|git:|github:|https?:|ssh:|builtin:)/.test(source.trim())) {
    return source;
  }
  const path = source.startsWith('file://')
    ? fileURLToPath(source)
    : source === '~'
    ? homedir()
    : source.startsWith('~/')
    ? join(homedir(), source.slice(2))
    : source;
  return resolve(cwd, path);
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
