import {strict as assert} from 'node:assert';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// Resolve runtime imports from installed Pi, not the local type-only stubs.
// Keep registration inside the test so imports happen after the hook is active.
test('subagent communication tools', async (t) => {
  const helper = new URL('../../tests/pi-package.mjs', import.meta.url).href;
  const {piPackageImports} = await import(helper);
  const packages = ['typebox', '@earendil-works/pi-ai/compat'];
  const hooks = registerHooks(piPackageImports(['jiti', ...packages]));
  try {
    const {createJiti} = await import(import.meta.resolve('jiti'));
    const jiti = createJiti(import.meta.url, {
      alias: Object.fromEntries(packages.map((name) => [
        name, fileURLToPath(import.meta.resolve(name)),
      ])),
    });
    const {registerSubTools} = await jiti.import('../sub/tools.ts');
    const {handleAsk, LLM_ASK_BUDGET} = await jiti.import('../main/ask.ts');
    const tools = new Map();
    const sent = [];
    let failSend = false;
    const bus = {
      emit(type, payload) {
        if (failSend) {
          throw new Error('test send failure');
        }
        sent.push({type, payload});
      },
    };
    registerSubTools({
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    }, {getBus: () => bus});
    const execute = (name, params) =>
      tools.get(name).execute(
        'test-call',
        params,
        undefined,
        undefined,
        {},
      );

    await t.test('only successful final reports request termination', async () => {
      for (const final of [undefined, true, false]) {
        sent.length = 0;
        const result = await execute('report', {
          summary: 'test report',
          ...(final === undefined ? {} : {final}),
        });
        assert.equal(result.terminate, final ?? true);
        assert.deepEqual(result.content, [{type: 'text', text: 'report sent'}]);
        assert.deepEqual(sent, [{
          type: 'report',
          payload: {summary: 'test report', final: final ?? true},
        }]);
      }
      const progress = await execute('progress', {text: 'still working'});
      assert.equal(progress.terminate, undefined);
      failSend = true;
      try {
        await assert.rejects(execute('report', {summary: 'undelivered'}), /test send failure/);
      } finally {
        failSend = false;
      }
    });

    await t.test('deny and fallback answers omit the question but preserve the reason', async () => {
      const question = 'Unique question already present in the tool call?';
      for (const {policy, count, prefix, source} of [
        {policy: 'deny', count: 0, prefix: '(ask_policy=deny)', source: 'policy'},
        {policy: 'human', count: 0, prefix: '(ask_policy=deny)', source: 'policy'},
        {policy: 'llm', count: 0, prefix: '(ask_policy=llm; model unavailable)', source: 'llm-fallback'},
        {policy: 'llm', count: LLM_ASK_BUDGET, prefix: `(ask_policy=llm; ${LLM_ASK_BUDGET}-answer budget reached; human declined)`, source: 'policy-escalated'},
      ]) {
        sent.length = 0;
        const events = [];
        const task = {
          taskId: 'test-task', agentName: 'scout', bus,
          llmAnswersSinceEscalation: count, llmAnswersTotal: count,
        };
        await handleAsk({
          pi: {events: {emit(name, payload) {
            events.push({name, payload});
          }}},
          ctx: undefined,
          task, askId: 'test-ask', question, defaultAnswer: undefined, policy,
        });
        const expected = `${prefix} No answer available; please make a reasonable assumption and note it in your report.`;
        assert.deepEqual(sent, [{type: 'answer', payload: {text: expected}}]);
        assert.ok(!expected.includes(question));
        assert.equal(events[0].name, 'subagent:asked');
        assert.equal(events[0].payload.question, question);
        assert.equal(events[1].name, 'subagent:answered');
        assert.equal(events[1].payload.source, source);
      }
    });

    await t.test('human answers and configured defaults are unchanged', async () => {
      for (const hasUI of [true, false]) {
        sent.length = 0;
        await handleAsk({
          pi: {events: {emit() {}}},
          ctx: {hasUI, ui: {input: async () => 'human answer'}},
          task: {taskId: 'test-task', agentName: 'scout', bus},
          askId: 'test-ask', question: 'Which value?',
          defaultAnswer: 'configured default', policy: 'human',
        });
        assert.deepEqual(sent, [{
          type: 'answer', payload: {text: hasUI ? 'human answer' : 'configured default'},
        }]);
      }
    });
  } finally {
    hooks.deregister();
  }
});
