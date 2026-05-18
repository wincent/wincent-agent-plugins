/**
 * Unix domain socket transport for the subagent bus.
 *
 * The main side creates a `net.Server` and listens on `<busDir>/main.sock`.
 * The subagent side connects to that path. Either end can send envelopes at
 * any time. Each envelope is one line of JSON terminated by `\n`.
 *
 * On either side, `close()` ends the socket and (for the main) removes the
 * socket file. A peer-side close surfaces as the `close` listener firing on
 * the local end with no further data.
 */

import {unlink} from 'node:fs/promises';
import {
  type Server,
  type Socket,
  createConnection,
  createServer,
} from 'node:net';

import type {Envelope} from './envelope.js';
import {parseEnvelope} from './envelope.js';

export type EnvelopeHandler = (env: Envelope) => void;
export type CloseHandler = (err?: Error) => void;
export type ParseErrorHandler = (rawLine: string, error: Error) => void;

export interface Transport {
  send(env: Envelope): void;
  onEnvelope(handler: EnvelopeHandler): () => void;
  onClose(handler: CloseHandler): () => void;
  onParseError(handler: ParseErrorHandler): () => void;
  close(): Promise<void>;
}

function attachSocket(
  socket: Socket,
  state: {
    handlers: Set<EnvelopeHandler>;
    closeHandlers: Set<CloseHandler>;
    parseErrorHandlers: Set<ParseErrorHandler>;
  },
): {flushBuffer: () => void} {
  let buffer = '';

  const flushBuffer = () => {
    if (buffer.length === 0) {
      return;
    }
    const trailing = buffer;
    buffer = '';
    if (trailing.trim().length === 0) {
      return;
    }
    parseAndDispatch(trailing);
  };

  const parseAndDispatch = (line: string) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      for (const handler of state.parseErrorHandlers) {
        handler(line, err as Error);
      }
      return;
    }
    const env = parseEnvelope(value);
    if (!env) {
      const err = new Error('not a valid envelope');
      for (const handler of state.parseErrorHandlers) {
        handler(line, err);
      }
      return;
    }
    for (const handler of state.handlers) {
      handler(env);
    }
  };

  socket.setEncoding('utf-8');

  socket.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString();
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        parseAndDispatch(line);
      }
      newlineIdx = buffer.indexOf('\n');
    }
  });

  return {flushBuffer};
}

/**
 * Listen on a UDS path and accept exactly one connection (the subagent).
 *
 * Resolves to a Transport when the connection is established. Rejects if
 * the connect timeout elapses or the server fails to bind.
 */
export function listenForPeer(
  socketPath: string,
  options: {timeoutMs: number; signal?: AbortSignal},
): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    const handlers = new Set<EnvelopeHandler>();
    const closeHandlers = new Set<CloseHandler>();
    const parseErrorHandlers = new Set<ParseErrorHandler>();

    let resolved = false;
    let server: Server | null = null;
    let socket: Socket | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let flushBuffer: () => void = () => {};

    const cleanupSocketFile = async () => {
      try {
        await unlink(socketPath);
      } catch {
        // The socket file may already be gone; that's fine.
      }
    };

    const finishWithError = (err: Error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (socket) {
        socket.destroy();
      }
      if (server) {
        server.close();
      }
      void cleanupSocketFile();
      reject(err);
    };

    timeoutHandle = setTimeout(() => {
      finishWithError(
        new Error(
          `timed out after ${options.timeoutMs}ms waiting for subagent to connect`,
        ),
      );
    }, options.timeoutMs);

    if (options.signal) {
      const onAbort = () => {
        finishWithError(new Error('aborted while waiting for subagent'));
      };
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, {once: true});
    }

    server = createServer((conn) => {
      socket = conn;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      const attached = attachSocket(conn, {
        handlers,
        closeHandlers,
        parseErrorHandlers,
      });
      flushBuffer = attached.flushBuffer;

      conn.on('error', (err) => {
        for (const handler of closeHandlers) {
          handler(err);
        }
      });

      const onTerminated = () => {
        flushBuffer();
        for (const handler of closeHandlers) {
          handler();
        }
      };
      conn.on('end', onTerminated);
      conn.on('close', onTerminated);

      if (server) {
        // Only accept one peer; reject any further connection attempts.
        server.close();
      }

      resolved = true;
      resolve(buildTransport({
        write: (line) => {
          if (conn.destroyed) {
            return;
          }
          conn.write(line);
        },
        handlers,
        closeHandlers,
        parseErrorHandlers,
        close: async () => {
          conn.end();
          conn.destroy();
          await cleanupSocketFile();
        },
      }));
    });

    server.on('error', (err) => {
      finishWithError(err);
    });

    server.listen(socketPath);
  });
}

/**
 * Connect to a peer listening on a UDS path. Retries the connect briefly to
 * accommodate the race between the main calling `listen()` and the subagent
 * spawning. Resolves with a Transport on success, rejects on persistent
 * failure.
 */
export function connectToPeer(
  socketPath: string,
  options: {
    timeoutMs: number;
    retryIntervalMs?: number;
    signal?: AbortSignal;
  },
): Promise<Transport> {
  const retryIntervalMs = options.retryIntervalMs ?? 100;
  const deadline = Date.now() + options.timeoutMs;

  return new Promise<Transport>((resolve, reject) => {
    const handlers = new Set<EnvelopeHandler>();
    const closeHandlers = new Set<CloseHandler>();
    const parseErrorHandlers = new Set<ParseErrorHandler>();

    let resolved = false;
    let aborted = false;

    if (options.signal?.aborted) {
      reject(new Error('aborted before connect'));
      return;
    }

    const onAbort = () => {
      aborted = true;
      if (!resolved) {
        resolved = true;
        reject(new Error('aborted while connecting'));
      }
    };
    options.signal?.addEventListener('abort', onAbort, {once: true});

    const tryConnect = () => {
      if (aborted || resolved) {
        return;
      }
      const conn = createConnection({path: socketPath});

      let connected = false;

      conn.on('connect', () => {
        connected = true;
        resolved = true;
        const attached = attachSocket(conn, {
          handlers,
          closeHandlers,
          parseErrorHandlers,
        });
        const flushBuffer = attached.flushBuffer;

        const onTerminated = () => {
          flushBuffer();
          for (const handler of closeHandlers) {
            handler();
          }
        };
        conn.on('error', (err) => {
          for (const handler of closeHandlers) {
            handler(err);
          }
        });
        conn.on('end', onTerminated);
        conn.on('close', onTerminated);

        resolve(buildTransport({
          write: (line) => {
            if (conn.destroyed) {
              return;
            }
            conn.write(line);
          },
          handlers,
          closeHandlers,
          parseErrorHandlers,
          close: async () => {
            conn.end();
            conn.destroy();
          },
        }));
      });

      conn.on('error', (err) => {
        if (connected) {
          return;
        }
        if (Date.now() >= deadline) {
          if (!resolved) {
            resolved = true;
            reject(
              new Error(
                `failed to connect to ${socketPath} within ${options.timeoutMs}ms: ${
                  (err as Error).message
                }`,
              ),
            );
          }
          return;
        }
        conn.destroy();
        setTimeout(tryConnect, retryIntervalMs);
      });
    };

    tryConnect();
  });
}

function buildTransport(args: {
  write: (line: string) => void;
  handlers: Set<EnvelopeHandler>;
  closeHandlers: Set<CloseHandler>;
  parseErrorHandlers: Set<ParseErrorHandler>;
  close: () => Promise<void>;
}): Transport {
  return {
    send(env: Envelope): void {
      const line = JSON.stringify(env) + '\n';
      args.write(line);
    },
    onEnvelope(handler: EnvelopeHandler): () => void {
      args.handlers.add(handler);
      return () => args.handlers.delete(handler);
    },
    onClose(handler: CloseHandler): () => void {
      args.closeHandlers.add(handler);
      return () => args.closeHandlers.delete(handler);
    },
    onParseError(handler: ParseErrorHandler): () => void {
      args.parseErrorHandlers.add(handler);
      return () => args.parseErrorHandlers.delete(handler);
    },
    close(): Promise<void> {
      return args.close();
    },
  };
}
