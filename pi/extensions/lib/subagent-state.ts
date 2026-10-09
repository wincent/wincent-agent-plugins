import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export const SUBAGENT_STATE_ENV = 'PI_SUBAGENT_EXTENSION_STATE';
const COLLECT_EVENT = 'subagent:collect-state';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {[key: string]: JsonValue};

export function provideSubagentState(
  pi: Pick<ExtensionAPI, 'events'>,
  namespace: string,
  snapshot: () => JsonValue,
): void {
  // Collection is synchronous: exporters must not await or return promises.
  pi.events.on(COLLECT_EVENT, (data) => {
    (data as Record<string, JsonValue>)[namespace] = snapshot();
  });
}

export function collectSubagentState(pi: Pick<ExtensionAPI, 'events'>): string {
  const state: Record<string, JsonValue> = Object.create(null);
  pi.events.emit(COLLECT_EVENT, state);
  return JSON.stringify(state);
}

export function takeSubagentState(
  namespace: string,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (!env.PI_SUBAGENT_TASK_ID) {
    return undefined;
  }
  try {
    const state = JSON.parse(env[SUBAGENT_STATE_ENV] ?? '{}');
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      delete env[SUBAGENT_STATE_ENV];
      return undefined;
    }
    const value = Object.hasOwn(state, namespace)
      ? state[namespace]
      : undefined;
    // Consume each namespace once so reload/session reset cannot restore it.
    delete state[namespace];
    if (Object.keys(state).length) {
      env[SUBAGENT_STATE_ENV] = JSON.stringify(state);
    } else {
      delete env[SUBAGENT_STATE_ENV];
    }
    return value;
  } catch {
    delete env[SUBAGENT_STATE_ENV];
    return undefined;
  }
}
