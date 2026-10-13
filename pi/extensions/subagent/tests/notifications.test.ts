import type {
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from '@earendil-works/pi-coding-agent';
import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {installCompletionNotifications} from '../main/notifications.js';
import type {ActiveTask} from '../main/registry.js';
import type {SubagentDetails} from '../main/result.js';

function setup() {
  const hooks = new Map<string, (event: unknown) => unknown>();
  const sent: {content: string; display: boolean}[] = [];
  let idle = false;
  const pi = {
    on(name: string, handler: (event: unknown) => unknown) {
      hooks.set(name, handler);
    },
    sendMessage(
      message: {content: string; display: boolean},
      options: unknown,
    ) {
      assert.deepEqual(options, {triggerTurn: true, deliverAs: 'followUp'});
      sent.push(message);
    },
  } as unknown as ExtensionAPI;
  const notifications = installCompletionNotifications(pi);
  const ctx = {isIdle: () => idle} as ExtensionContext;
  return {
    notifications,
    sent,
    enqueue(id = 'one', overrides: Partial<ActiveTask> = {}) {
      notifications.enqueue(
        {
          taskId: id,
          agentName: 'scout',
          mode: 'background',
          ...overrides,
        } as ActiveTask,
        `Finished ${id}`,
        ctx,
      );
    },
    idle() {
      idle = true;
    },
    fire(
      name: string,
      outcome = 'completed',
      entries: SessionBoundaryDraft[] = [],
    ) {
      return hooks.get(name)!({outcome, entries}) as BoundaryResult | undefined;
    },
  };
}

function saved(taskId = 'one'): SubagentDetails {
  return {
    taskId,
    agent: 'scout',
    task: 'test',
    mode: 'background',
    pid: null,
    taskDir: '/test/task',
    resultPath: '/test/task/result.json',
    status: 'ok',
    progress: [],
    worktree: {enabled: false},
  };
}

test('idle completion triggers one hidden custom message, not repeated acknowledgments', () => {
  const s = setup();
  s.idle();
  s.enqueue();
  s.enqueue();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].content, /Finished one/);
  assert.equal(s.sent[0].display, false);
  assert.equal(s.fire('turn_end'), undefined);
});

test('busy completions are batched at a turn boundary exactly once', () => {
  const s = setup();
  s.enqueue();
  s.enqueue();
  s.enqueue('two');
  assert.deepEqual(s.sent, []);
  const result = s.fire('turn_end')!;
  assert.equal(result.continue, true);
  assert.deepEqual(result.entries, [{
    type: 'custom_message',
    customType: 'subagent-completion',
    content:
      '[subagent scout:one] Finished one\n\n[subagent scout:two] Finished two',
    display: false,
    details: {taskIds: ['one', 'two']},
  }]);
  s.enqueue();
  assert.equal(s.fire('agent_before_settle'), undefined);
  s.fire('agent_settled');
  assert.deepEqual(s.sent, []);
});

test('both boundaries preserve preceding extensions entries without mutating them', () => {
  for (const boundary of ['turn_end', 'agent_before_settle']) {
    const s = setup();
    const entries: SessionBoundaryDraft[] = [{
      type: 'custom_message',
      customType: 'other-extension',
      content: 'Keep this message',
      display: true,
    }, {
      type: 'custom',
      customType: 'other-extension-state',
      data: {keep: true},
    }];
    const before = structuredClone(entries);
    s.enqueue();
    const result = s.fire(boundary, 'completed', entries)!;
    assert.equal(result.continue, true);
    assert.equal(result.entries!.length, 3);
    assert.deepEqual(result.entries!.slice(0, 2), before);
    assert.deepEqual(entries, before);
    assert.match(JSON.stringify(result.entries![2]), /Finished one/);
  }
});

test('retrieving a finalized saved result suppresses only that pending completion', () => {
  const s = setup();
  s.enqueue();
  s.enqueue('two');
  s.notifications.retrieved(saved());
  const result = s.fire('turn_end')!;
  assert.match(JSON.stringify(result), /Finished two/);
  assert.doesNotMatch(JSON.stringify(result), /Finished one/);
  s.enqueue();
  assert.equal(s.fire('turn_end'), undefined);
});

test('a result retrieved before notification enqueue also suppresses delivery', () => {
  const s = setup();
  s.notifications.retrieved(saved());
  s.idle();
  s.enqueue();
  assert.deepEqual(s.sent, []);
});

test('interim and recovered results do not suppress authoritative completion', () => {
  for (
    const details of [{...saved(), status: 'running' as const}, {
      ...saved(),
      status: 'finalizing' as const,
    }, {...saved(), resultPath: undefined}]
  ) {
    const s = setup();
    s.enqueue();
    s.notifications.retrieved(details);
    assert.equal(s.fire('turn_end')!.entries!.length, 1);
  }
});

test('late completion is delivered at pre-settlement or just after settlement', () => {
  const s = setup();
  s.fire('turn_end');
  s.enqueue();
  assert.equal(s.fire('agent_before_settle')!.entries!.length, 1);
  s.enqueue('two');
  s.fire('agent_settled');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].content, /Finished two/);
});

test('notifications do not restart aborted or failed runs', () => {
  for (const outcome of ['aborted', 'error']) {
    const s = setup();
    s.enqueue();
    assert.equal(s.fire('turn_end', outcome), undefined);
    assert.equal(s.fire('agent_before_settle', outcome), undefined);
    s.fire('agent_settled');
    assert.deepEqual(s.sent, []);
    // A later user turn can consume the pending notification.
    assert.equal(s.fire('turn_end')!.entries!.length, 1);
  }
});

test('new completions after aborted/error settlement stay paused until a successful turn', () => {
  for (const outcome of ['aborted', 'error']) {
    for (const alreadyPending of [false, true]) {
      const s = setup();
      if (alreadyPending) {
        s.enqueue('one');
      }
      s.fire('turn_end', outcome);
      s.fire('agent_before_settle', outcome);
      s.fire('agent_settled');
      s.idle();
      s.enqueue('two');
      assert.equal(s.sent.length, 0, 'idle enqueue must not restart the model');
      // A subsequent successful turn consumes all held notices in one batch.
      const result = s.fire('turn_end')!;
      assert.equal(result.entries!.length, 1);
      assert.match(JSON.stringify(result.entries), /Finished two/);
      if (alreadyPending) {
        assert.match(JSON.stringify(result.entries), /Finished one/);
      }
      s.fire('agent_before_settle');
      s.fire('agent_settled');
      assert.equal(
        s.sent.length,
        0,
        'held notices should be delivered only once',
      );
      s.enqueue('three');
      assert.equal(s.sent.length, 1, 'successful turn restores idle delivery');
      assert.match(s.sent[0].content, /Finished three/);
    }
  }
});

test('sync tasks, closed owners and shutdown do not notify; session reset clears state', () => {
  const s = setup();
  s.enqueue('sync', {mode: 'sync'});
  s.enqueue('closed', {ownerClosed: true});
  assert.equal(s.fire('turn_end'), undefined);
  s.enqueue();
  s.fire('session_shutdown');
  s.enqueue('two');
  assert.equal(s.fire('turn_end'), undefined);
  s.fire('agent_settled');
  assert.deepEqual(s.sent, []);
  s.fire('session_start');
  s.enqueue();
  assert.equal(s.fire('turn_end')!.entries!.length, 1);
});
