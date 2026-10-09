import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {installStatus} from '../main/status.js';

test('status widget follows lifecycle events and unsubscribes on shutdown', () => {
  const hooks = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => void
  >();
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const widgets: (string[] | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      hooks.set(name, handler);
    },
    events: {
      on(name: string, handler: (data: unknown) => void) {
        const set = handlers.get(name) ?? new Set();
        handlers.set(name, set);
        set.add(handler);
        return () => set.delete(handler);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: {
      setWidget(_key: string, lines: string[] | undefined) {
        widgets.push(lines);
      },
      setStatus(_key: string, status: string | undefined) {
        statuses.push(status);
      },
    },
  } as unknown as ExtensionContext;
  const emit = (kind: string, data: unknown) => {
    for (const handler of handlers.get(`subagent:${kind}`) ?? []) {
      handler(data);
    }
  };
  installStatus(pi);
  hooks.get('session_start')!({}, ctx);
  emit('spawned', {taskId: 'one', agent: 'scout'});
  emit('progress', {taskId: 'one', text: 'reading\nfiles'});
  assert.equal(statuses.at(-1), 'Subagents: 1 active');
  assert.deepEqual(widgets.at(-1), ['scout: reading files']);
  emit('finalizing', {taskId: 'one'});
  assert.deepEqual(widgets.at(-1), ['scout: finalizing outputs and cleanup']);
  emit('done', {taskId: 'one'});
  assert.equal(widgets.at(-1), undefined);
  hooks.get('session_shutdown')!({}, ctx);
  assert.ok([...handlers.values()].every((set) => set.size === 0));
  const before = widgets.length;
  hooks.get('session_start')!({}, {...ctx, hasUI: false});
  emit('spawned', {taskId: 'two', agent: 'tester'});
  assert.equal(widgets.length, before);
  hooks.get('session_shutdown')!({}, ctx);
});
