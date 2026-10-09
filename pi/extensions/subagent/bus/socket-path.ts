import {chmod, lstat, mkdtemp, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';

export function validateSocketPath(
  path: string,
  platform = process.platform,
): void {
  const limit = platform === 'linux' ? 107 : 103;
  const bytes = Buffer.byteLength(path, 'utf8');
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error(
      'Subagent socket path must be absolute and contain no NUL bytes',
    );
  }
  if (bytes > limit) {
    throw new Error(
      `Subagent socket path is ${bytes} bytes; the ${platform} limit is ${limit} bytes: ${path}. Set PI_SUBAGENT_SOCKET_ROOT to a shorter permitted absolute directory. Task artifacts remain in PI_SUBAGENT_BUS_DIR.`,
    );
  }
}

export interface TaskSocket {
  path: string;
  cleanup(): Promise<void>;
}

export async function allocateTaskSocket(): Promise<TaskSocket> {
  const configured = process.env.PI_SUBAGENT_SOCKET_ROOT;
  const root = configured ?? tmpdir();
  let directory: string | undefined;
  try {
    validateSocketPath(join(root, 'p-XXXXXX', 's'));
    if (!isAbsolute(root) || root.includes('\0')) {
      throw new Error('socket root must be an absolute directory');
    }
    if (configured !== undefined) {
      // Match join() below and avoid following a final symlink via a trailing slash.
      const info = await lstat(join(root, '.'));
      if (
        !info.isDirectory() || info.isSymbolicLink() ||
        info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0
      ) {
        throw new Error(
          'socket root must be an owned private directory (0700), not a symlink',
        );
      }
    }
    directory = await mkdtemp(join(root, 'p-'));
    await chmod(directory, 0o700);
    const identity = await lstat(directory);
    const ownedDirectory = directory;
    const path = join(directory, 's');
    validateSocketPath(path);
    return {
      path,
      async cleanup() {
        try {
          const current = await lstat(ownedDirectory);
          if (
            !current.isDirectory() || current.dev !== identity.dev ||
            current.ino !== identity.ino
          ) {
            throw new Error('refusing to remove a replaced socket directory');
          }
          // Never recurse: unexpected contents belong to neither this allocation nor its cleanup.
          await rmdir(ownedDirectory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(
              `Could not clean up subagent socket directory ${ownedDirectory}: ${
                (error as Error).message
              }`,
            );
          }
        }
      },
    };
  } catch (error) {
    let cleanupError = '';
    if (directory) {
      try {
        await rmdir(directory);
      } catch (failure) {
        cleanupError = `; socket directory cleanup failed: ${
          (failure as Error).message
        }`;
      }
    }
    throw new Error(
      `Could not allocate subagent socket beneath ${JSON.stringify(root)}${
        configured !== undefined
          ? ' (PI_SUBAGENT_SOCKET_ROOT; no fallback)'
          : ' (temporary directory)'
      }: ${(error as Error).message}${cleanupError}`,
    );
  }
}
