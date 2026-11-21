import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface PiRuntime {
  executable: string;
  args: string[];
}

export const PI_ENTRYPOINT_ENV = 'PI_SUBAGENT_PI_ENTRYPOINT';

interface SelectedPiRuntime {
  mode: 'cli' | 'sdk';
  runtime: PiRuntime;
}

export async function subagentPiRuntime(
  {mode, runtime}: SelectedPiRuntime = resolvePiRuntime(),
  argv?: string[],
  cwd = process.cwd(),
): Promise<PiRuntime> {
  const entry = realpathSync(
    fileURLToPath(new URL('../index.ts', import.meta.url)),
  );
  if (mode === 'sdk') {
    // Host arguments are not Pi arguments, even when some spellings overlap.
    return {...runtime, args: [...runtime.args, '--extension', entry]};
  }

  // Carry explicit CLI resources, not discovered project code. Use Pi's parser
  // so prompts, option values, aliases, and the -- terminator keep CLI semantics.
  const {parseArgs} = await import('@earendil-works/pi-coding-agent');
  const parsed = parseArgs(argv ?? process.argv.slice(2));
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
  const extensions = new Set([
    ...(parsed.extensions ?? []).map((source) => {
      const resolved = extensionSource(source, cwd);
      try {
        if (realpathSync(resolved) === dirname(entry)) {
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

/** Reuse a running CLI first; only SDK hosts need a launcher-provided bin. */
export function resolvePiRuntime(
  executable = process.execPath,
  entrypoint = process.argv[1],
  env = process.env,
): SelectedPiRuntime {
  try {
    return {mode: 'cli', runtime: validatePiRuntime(executable, entrypoint)};
  } catch (cliError) {
    const configured = env[PI_ENTRYPOINT_ENV];
    let reason = `the controller is not a validated Pi CLI (${
      (cliError as Error).message
    })`;
    if (configured !== undefined) {
      try {
        return {
          mode: 'sdk',
          runtime: validatePiRuntime(executable, configured),
        };
      } catch (error) {
        reason = `${PI_ENTRYPOINT_ENV} is invalid (${
          (error as Error).message
        })`;
      }
    }
    throw new Error(
      `Cannot dispatch subagent: ${reason}. Set ${PI_ENTRYPOINT_ENV} in the SDK host or launcher to the absolute path of the installed @earendil-works/pi-coding-agent JavaScript pi bin. No PATH or launcher fallback is used.`,
    );
  }
}

/** Trust the selected installation, not a shim that merely forwards to it. */
export function validatePiRuntime(
  executable: string,
  entrypoint: string | undefined,
): PiRuntime {
  if (!entrypoint || !isAbsolute(entrypoint) || !isAbsolute(executable)) {
    throw new Error('expected absolute runtime and CLI paths');
  }

  const interpreter = realpathSync(executable);
  const cli = realpathSync(entrypoint);
  if (!statSync(interpreter).isFile() || !statSync(cli).isFile()) {
    throw new Error('expected runtime and CLI files');
  }

  let directory = dirname(cli);
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
        if (
          typeof bin !== 'string' || realpathSync(join(directory, bin)) !== cli
        ) {
          throw new Error('entrypoint is not the declared Pi bin');
        }
        return {executable: interpreter, args: [cli]};
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error('entrypoint has no Pi package manifest');
}
