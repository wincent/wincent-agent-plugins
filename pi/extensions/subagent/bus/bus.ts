/**
 * High-level Bus API.
 *
 * Wraps a Transport with:
 *   - Audit-log tee on every send/recv.
 *   - Protocol-version check on receive (warns and drops mismatches).
 *   - Multi-subscriber dispatch (extension-scoped + tool-scoped coexist).
 *   - Request/reply matching via `inReplyTo` for the `ask`/`answer` pair.
 *
 * The transport is what comes out of `listenForPeer` (main side) or
 * `connectToPeer` (sub side); the audit log is constructed alongside the
 * transport using the same task's `bus.jsonl` path.
 */

import type {AuditLog} from './audit-log.js';
import {
  type Envelope,
  type MessageType,
  type PayloadMap,
  type Role,
  checkVersion,
  makeEnvelope,
} from './envelope.js';
import type {Transport} from './transport-uds.js';

export type EnvelopeHandler = (env: Envelope) => void;
export type CloseHandler = (err?: Error) => void;

interface PendingRequest {
  resolve: (env: Envelope) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

export class Bus {
  private readonly transport: Transport;
  private readonly auditLog: AuditLog;
  private readonly role: Role;
  private readonly handlers = new Set<EnvelopeHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly versionWarn: (line: string) => void;
  private readonly parseWarn: (line: string, err: Error) => void;
  private closed = false;

  constructor(
    transport: Transport,
    auditLog: AuditLog,
    role: Role,
    options?: {
      onVersionMismatch?: (line: string) => void;
      onParseError?: (line: string, err: Error) => void;
    },
  ) {
    this.transport = transport;
    this.auditLog = auditLog;
    this.role = role;
    this.versionWarn = options?.onVersionMismatch
      ?? ((line) => {
        process.stderr.write(`[subagent bus] version mismatch: ${line}\n`);
      });
    this.parseWarn = options?.onParseError
      ?? ((line, err) => {
        process.stderr.write(
          `[subagent bus] parse error (${err.message}) for line: ${line}\n`,
        );
      });

    transport.onEnvelope((env) => this.onIncoming(env));
    transport.onClose((err) => this.onClose(err));
    transport.onParseError((line, err) => this.parseWarn(line, err));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Send a fully-built envelope. The envelope is teed to the audit log
   * (best effort, never blocking the send) and then handed to the transport.
   */
  send(env: Envelope): void {
    if (this.closed) {
      throw new Error('cannot send on a closed bus');
    }
    void this.auditLog.append(env, 'send');
    this.transport.send(env);
  }

  /**
   * Convenience: build and send an envelope. Returns the id of the sent
   * envelope so callers can correlate replies.
   */
  emit<T extends MessageType>(
    type: T,
    payload: PayloadMap[T],
    options?: {inReplyTo?: string},
  ): string {
    const env = makeEnvelope(type, this.role, payload, options) as Envelope;
    this.send(env);
    return env.id;
  }

  /**
   * Send a message and wait for a reply matching its id. Rejects on timeout
   * or bus close.
   */
  request<T extends MessageType>(
    type: T,
    payload: PayloadMap[T],
    options?: {timeoutMs?: number},
  ): Promise<Envelope> {
    const env = makeEnvelope(type, this.role, payload) as Envelope;

    return new Promise<Envelope>((resolve, reject) => {
      const timeoutHandle = options?.timeoutMs
        ? setTimeout(() => {
          this.pending.delete(env.id);
          reject(
            new Error(
              `request ${env.id} timed out after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs)
        : null;

      this.pending.set(env.id, {resolve, reject, timeoutHandle});

      try {
        this.send(env);
      } catch (err) {
        this.pending.delete(env.id);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        reject(err as Error);
      }
    });
  }

  /**
   * Subscribe to all incoming envelopes. The returned function unsubscribes.
   */
  subscribe(handler: EnvelopeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Called when the peer disconnects, the transport errors, or we close
   * locally.
   */
  onPeerClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * Close the bus. Sends are no longer permitted. Pending requests reject.
   * Audit log is flushed.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const req of this.pending.values()) {
      if (req.timeoutHandle) {
        clearTimeout(req.timeoutHandle);
      }
      req.reject(new Error('bus closed before reply arrived'));
    }
    this.pending.clear();

    await this.transport.close();
    await this.auditLog.flush();
  }

  private onIncoming(env: Envelope): void {
    const versionError = checkVersion(env);
    if (versionError) {
      this.versionWarn(versionError);
      return;
    }
    void this.auditLog.append(env, 'recv');

    if (env.inReplyTo) {
      const pending = this.pending.get(env.inReplyTo);
      if (pending) {
        this.pending.delete(env.inReplyTo);
        if (pending.timeoutHandle) {
          clearTimeout(pending.timeoutHandle);
        }
        pending.resolve(env);
      }
    }

    for (const handler of this.handlers) {
      try {
        handler(env);
      } catch (err) {
        process.stderr.write(
          `[subagent bus] handler threw: ${(err as Error).message}\n`,
        );
      }
    }
  }

  private onClose(err?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const req of this.pending.values()) {
      if (req.timeoutHandle) {
        clearTimeout(req.timeoutHandle);
      }
      req.reject(err ?? new Error('bus closed'));
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      handler(err);
    }
    void this.auditLog.flush();
  }
}
