/**
 * Which Pi process is a subagent.
 *
 * The controller's wrapper exports the task variables and then `exec`s Pi, so
 * every descendant of the child (its tool processes and any program they start
 * that embeds Pi) inherits them too. The wrapper therefore also records its own
 * PID, which `exec` hands to Pi unchanged. Only the process whose PID matches is
 * the subagent; the check is stateless, so it needs no shared module instance,
 * survives reloads and session resets, and does not depend on load order.
 */

export const SUBAGENT_PID_ENV = 'PI_SUBAGENT_PID';

const IDENTITY_KEYS = [
  'PI_SUBAGENT_TASK_ID',
  'PI_SUBAGENT_BUS_DIR',
  'PI_SUBAGENT_SOCKET_PATH',
] as const;

export interface SubagentIdentity {
  taskId: string;
  busDir: string;
  socketPath: string;
}

export type SubagentEnvironment =
  /** No subagent variables: an ordinary Pi process. */
  | {kind: 'none'}
  /** Variables inherited from an ancestor subagent; not this process's task. */
  | {kind: 'inherited'; ownerPid?: string}
  /** The spawned child, but its bootstrap variables are incomplete. */
  | {kind: 'invalid'; missing: string[]}
  /** The spawned child. */
  | {kind: 'child'; identity: SubagentIdentity};

export function subagentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): SubagentEnvironment {
  const owner = env[SUBAGENT_PID_ENV];
  if (owner !== String(pid)) {
    return owner === undefined && IDENTITY_KEYS.every((key) => !(key in env))
      ? {kind: 'none'}
      : {kind: 'inherited', ...(owner === undefined ? {} : {ownerPid: owner})};
  }
  const missing = IDENTITY_KEYS.filter((key) => !env[key]);
  if (missing.length) {
    return {kind: 'invalid', missing};
  }
  return {
    kind: 'child',
    identity: {
      taskId: env.PI_SUBAGENT_TASK_ID!,
      busDir: env.PI_SUBAGENT_BUS_DIR!,
      socketPath: env.PI_SUBAGENT_SOCKET_PATH!,
    },
  };
}

/** True only in the process the subagent controller spawned. */
export function isSubagentProcess(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): boolean {
  return subagentEnvironment(env, pid).kind === 'child';
}
