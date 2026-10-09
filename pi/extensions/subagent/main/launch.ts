import {type TaskSocket, allocateTaskSocket} from '../bus/socket-path.js';
import {type Transport, listenForPeer} from '../bus/transport-uds.js';
import {
  type SpawnArgs,
  type SpawnedProcess,
  spawnSubagent,
  terminateProcess,
} from './spawn.js';

export async function launchSubagent(
  args: Omit<SpawnArgs, 'socketPath'>,
  options: {
    signal?: AbortSignal;
    connectTimeoutMs: number;
    killGraceMs: number;
  },
  startProcess: typeof spawnSubagent = spawnSubagent,
): Promise<
  {process: SpawnedProcess; transport: Transport; socketPath: string}
> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, {once: true});
  let socket: TaskSocket | undefined;
  let connection: Promise<Transport> | undefined;
  let child: SpawnedProcess | undefined;
  try {
    socket = await allocateTaskSocket();
    options.signal?.throwIfAborted();
    connection = listenForPeer(socket.path, {
      timeoutMs: options.connectTimeoutMs,
      signal: controller.signal,
    });
    // Binding may fail while spawn is still pending; observe rejection immediately.
    void connection.catch(() => {});
    child = await startProcess({...args, socketPath: socket.path});
    const transport = await Promise.race([
      connection,
      child.exited.then((exit) => {
        throw new Error(
          `subagent exited before connecting (code=${exit.code}, signal=${exit.signal})${
            exit.error ? `: ${exit.error}` : ''
          }; see ${child!.stderrPath}`,
        );
      }),
    ]);
    options.signal?.throwIfAborted();
    const allocation = socket;
    let closing: Promise<void> | undefined;
    return {
      process: child,
      socketPath: socket.path,
      transport: {
        ...transport,
        close() {
          return closing ??= cleanupAll([
            () => transport.close(),
            () => allocation.cleanup(),
          ]);
        },
      },
    };
  } catch (error) {
    controller.abort();
    try {
      await cleanupAll([async () => {
        await connection?.then((transport) => transport.close(), () => {});
      }, async () => {
        if (child) {
          await terminateProcess(child, 0, options.killGraceMs);
        }
      }, async () => {
        await socket?.cleanup();
      }]);
    } catch (failure) {
      throw new Error(
        `${(error as Error).message}; launch cleanup failed: ${
          (failure as Error).message
        }`,
      );
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function cleanupAll(steps: (() => Promise<void>)[]): Promise<void> {
  const errors: string[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
}
