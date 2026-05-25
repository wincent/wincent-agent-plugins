/**
 * Envelope schema and validators for the subagent bus.
 *
 * Every message on the wire (and tee'd into bus.jsonl) is one of these.
 * Schema is versioned via `v`. Receivers warn-and-drop unknown `v` values.
 */

export const PROTOCOL_VERSION = 1 as const;

export type Role = 'main' | 'sub';

export type Severity = 'info' | 'warning' | 'error';

export type ProgressKind = 'info' | 'tool' | 'thinking';

/** A single finding produced by a read-only helper (linter, reviewer, ...). */
export interface Finding {
  file?: string;
  line?: number;
  column?: number;
  severity: Severity;
  message: string;
  rule?: string;
}

/** Minimal commit reference returned by case-2 workers. */
export interface CommitInfo {
  sha: string;
  subject: string;
}

export interface ProgressPayload {
  text: string;
  kind?: ProgressKind;
}

export interface ReportPayload {
  summary: string;
  findings?: Finding[];
  branch?: string;
  commits?: CommitInfo[];
  data?: unknown;
  /** false marks an interim report; default true (final). */
  final?: boolean;
}

export interface AskPayload {
  question: string;
  options?: string[];
  default?: string;
  timeoutMs?: number;
}

export type DoneStatus = 'ok' | 'failed' | 'aborted';

export interface DonePayload {
  status: DoneStatus;
  finalText?: string;
  exitCode?: number;
  error?: string;
}

export interface SteerPayload {
  text: string;
}

export interface AnswerPayload {
  text: string;
}

export interface CancelPayload {
  reason: string;
  graceMs?: number;
}

export interface PayloadMap {
  progress: ProgressPayload;
  report: ReportPayload;
  ask: AskPayload;
  done: DonePayload;
  steer: SteerPayload;
  answer: AnswerPayload;
  cancel: CancelPayload;
}

export type MessageType = keyof PayloadMap;

interface BaseEnvelope<TType extends MessageType> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ts: string;
  from: Role;
  type: TType;
  inReplyTo?: string;
  payload: PayloadMap[TType];
}

export type ProgressEnvelope = BaseEnvelope<'progress'>;
export type ReportEnvelope = BaseEnvelope<'report'>;
export type AskEnvelope = BaseEnvelope<'ask'>;
export type DoneEnvelope = BaseEnvelope<'done'>;
export type SteerEnvelope = BaseEnvelope<'steer'>;
export type AnswerEnvelope = BaseEnvelope<'answer'>;
export type CancelEnvelope = BaseEnvelope<'cancel'>;

export type Envelope = {
  [T in MessageType]: BaseEnvelope<T>;
}[MessageType];

const VALID_TYPES: ReadonlySet<MessageType> = new Set([
  'progress',
  'report',
  'ask',
  'done',
  'steer',
  'answer',
  'cancel',
]);

/**
 * Generate a small lexicographically-sortable id. We don't pull in a ULID
 * dependency: a timestamp prefix plus crypto random bytes is enough for the
 * volumes we'll ever see on a single-machine bus.
 */
export function newEnvelopeId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = Array.from(
    {length: 8},
    () => Math.floor(Math.random() * 36).toString(36),
  ).join('');
  return `msg_${ts}_${rand}`;
}

/**
 * Build an envelope of the requested type. The `id` and `ts` fields are
 * populated automatically when not supplied.
 */
export function makeEnvelope<T extends MessageType>(
  type: T,
  from: Role,
  payload: PayloadMap[T],
  options?: {id?: string; inReplyTo?: string; ts?: string},
): BaseEnvelope<T> {
  const env: BaseEnvelope<T> = {
    v: PROTOCOL_VERSION,
    id: options?.id ?? newEnvelopeId(),
    ts: options?.ts ?? new Date().toISOString(),
    from,
    type,
    payload,
  };
  if (options?.inReplyTo) {
    env.inReplyTo = options.inReplyTo;
  }
  return env;
}

/**
 * Structural validation of a freshly-parsed JSON object. Does not enforce
 * payload-level correctness beyond the basic shape; payload-specific checks
 * live in the handlers that consume each message type.
 *
 * Returns `null` if the value is not a recognizable envelope.
 */
export function parseEnvelope(value: unknown): Envelope | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.v !== 'number') {
    return null;
  }
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    return null;
  }
  if (typeof obj.ts !== 'string') {
    return null;
  }
  if (obj.from !== 'main' && obj.from !== 'sub') {
    return null;
  }
  if (
    typeof obj.type !== 'string' || !VALID_TYPES.has(obj.type as MessageType)
  ) {
    return null;
  }
  if (typeof obj.payload !== 'object' || obj.payload === null) {
    return null;
  }
  if (
    obj.inReplyTo !== undefined
    && typeof obj.inReplyTo !== 'string'
  ) {
    return null;
  }
  return obj as unknown as Envelope;
}

/**
 * Check whether the envelope's protocol version is one we understand.
 * Returns a description of the mismatch when incompatible, otherwise null.
 */
export function checkVersion(env: Envelope): string | null {
  if (env.v === PROTOCOL_VERSION) {
    return null;
  }
  return `protocol version mismatch: got v=${env.v}, expected v=${PROTOCOL_VERSION}`;
}
