/**
 * Append-only JSONL audit log for the subagent bus.
 *
 * Both sides tee every envelope they send and every envelope they receive into
 * `bus.jsonl` inside the task's state dir. This file is never read by the
 * protocol; it exists purely for human introspection (`tail -F bus.jsonl`)
 * and post-mortem.
 *
 * Writes are line-buffered through `fs.appendFile`, which on POSIX guarantees
 * atomicity for writes below `PIPE_BUF` (>=4 KiB on macOS/Linux). Larger
 * envelopes are still written as a single appendFile call; the kernel may
 * interleave at block boundaries but the JSON parser will reject torn lines,
 * which is acceptable for an audit log that is never machine-consumed.
 */

import {appendFile} from 'node:fs/promises';

import type {Envelope} from './envelope.js';

export class AuditLog {
  private readonly path: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Append an envelope to the log. Returns a promise that resolves once the
   * write hits the disk buffer. Writes are serialized so the JSONL file stays
   * line-aligned even under concurrent calls.
   */
  append(env: Envelope, direction: 'send' | 'recv'): Promise<void> {
    const line = JSON.stringify({direction, ...env}) + '\n';
    this.chain = this.chain.then(
      () => appendFile(this.path, line, {encoding: 'utf-8', mode: 0o600}),
      () => appendFile(this.path, line, {encoding: 'utf-8', mode: 0o600}),
    );
    return this.chain;
  }

  /**
   * Flush pending writes. Useful before process exit so the audit log doesn't
   * miss the final `done` envelope.
   */
  flush(): Promise<void> {
    return this.chain.catch(() => {
      // Swallow: any individual write failure was already surfaced from
      // append() itself; we don't want to propagate during shutdown.
    });
  }
}
