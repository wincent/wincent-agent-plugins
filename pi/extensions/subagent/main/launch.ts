import {join} from 'node:path';

import {type Transport, listenForPeer} from '../bus/transport-uds.js';
import {
  type SpawnArgs,
  type SpawnedProcess,
  spawnSubagent,
  terminateProcess,
} from './spawn.js';

export async function launchSubagent(
  args: SpawnArgs,
  options: {
    signal?: AbortSignal;
    connectTimeoutMs: number;
    killGraceMs: number;
  },
): Promise<{process: SpawnedProcess; transport: Transport}> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, {once: true});
  const connection = listenForPeer(join(args.taskDir, 'main.sock'), {
    timeoutMs: options.connectTimeoutMs,
    signal: controller.signal,
  });
  // Binding may fail while spawn is still pending; attach a rejection handler now.
  void connection.catch(() => {});
  let child: SpawnedProcess | undefined;
  try {
    child = await spawnSubagent(args);
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
    return {process: child, transport};
  } catch (error) {
    controller.abort();
    await connection.then((transport) => transport.close(), () => {});
    if (child) {
      await terminateProcess(child, 0, options.killGraceMs);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
