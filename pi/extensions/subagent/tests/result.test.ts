import {strict as assert} from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {describeResult} from '../main/description.js';
import {
  MAX_RESULT_CHARS,
  type SubagentDetails,
  readTaskResult,
  recentCompletedTasks,
  resultPath,
  resultText,
  saveResult,
  taskResult,
} from '../main/result.js';
import {
  auditLogPath,
  ensureTaskDir,
  metaPath,
  taskDir,
  writeMeta,
} from '../main/state.js';

async function withState(fn: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'sa-results-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
    rmSync(root, {recursive: true, force: true});
  }
}

function details(taskId = 'task_test'): SubagentDetails {
  return {
    taskId,
    agent: 'scout',
    task: 'Summarize five commits',
    mode: 'sync',
    pid: null,
    taskDir: ensureTaskDir(taskId),
    status: 'ok',
    progress: [],
    worktree: {enabled: false},
    finalReport: {
      summary: 'Five commits',
      findings: [{severity: 'info', message: 'A detailed finding'}],
      branch: 'example-branch',
      commits: [{sha: 'example-sha', subject: 'Example subject'}],
      data: {
        commits: Array.from(
          {length: 5},
          (_value, i) => ({sha: `sha-${i}`, summary: `Details of commit ${i}`}),
        ),
      },
    },
  };
}

function legacyMeta(
  taskId: string,
  status: 'ok' | 'crashed' | 'running' | 'finalizing' = 'ok',
): void {
  ensureTaskDir(taskId);
  writeMeta({
    v: 1,
    taskId,
    parentId: 'old-session',
    agent: 'scout',
    task: 'old task',
    status,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: status === 'running' || status === 'finalizing'
      ? null
      : '2026-01-01T00:01:00Z',
    mainPid: process.pid,
    subPid: null,
    cwd: tmpdir(),
    worktreePath: null,
  });
}

test('model-visible content contains status, full task ID, paths, and every report field', async () => {
  await withState(async () => {
    const result = details();
    const tool = taskResult(result);
    assert.equal(tool.content[0].type, 'text');
    if (tool.content[0].type !== 'text') {
      return;
    }
    const visible = JSON.parse(tool.content[0].text);
    assert.equal(visible.taskId, result.taskId);
    assert.equal(visible.status, 'ok');
    assert.equal(visible.taskDir, result.taskDir);
    assert.equal(visible.stdoutPath, join(result.taskDir, 'stdout.log'));
    assert.deepEqual(visible.finalReport, result.finalReport);
    assert.deepEqual(visible.worktree, result.worktree);
    assert.equal(tool.details, result);
  });
});

test('saved results round-trip privately without in-memory task registration', async () => {
  await withState(async () => {
    const result = details();
    saveResult(result);
    assert.equal(statSync(resultPath(result.taskId)).mode & 0o777, 0o600);
    assert.deepEqual(await readTaskResult(result.taskId), result);
    assert.equal(
      JSON.parse(resultText(result)).resultPath,
      resultPath(result.taskId),
    );
    assert.deepEqual(readdirSync(result.taskDir), ['result.json']);
  });
});

test('large reports have an explicit preview and a complete artifact', async () => {
  await withState(async () => {
    const result = details();
    result.finalReport!.data = {
      large: 'x'.repeat(MAX_RESULT_CHARS * 2),
      end: 'retained-in-artifact',
    };
    saveResult(result);
    const visible = resultText(result);
    assert.match(visible, /"truncated": true/);
    assert.ok(visible.includes(resultPath(result.taskId)));
    assert.ok(visible.length < MAX_RESULT_CHARS + 4_000);
    assert.deepEqual(
      (await readTaskResult(result.taskId))!.finalReport!.data,
      result.finalReport!.data,
    );
    assert.equal(
      JSON.parse(readFileSync(resultPath(result.taskId), 'utf8')).details
        .finalReport.data.end,
      'retained-in-artifact',
    );
  });
});

test('recent completed tasks are bounded, newest first, and exclude active IDs', async () => {
  await withState(async () => {
    for (const [index, taskId] of ['task_a', 'task_b', 'task_c'].entries()) {
      saveResult(details(taskId));
      utimesSync(resultPath(taskId), 100 + index, 100 + index);
    }
    legacyMeta('task_running', 'running');
    legacyMeta('task_finalizing', 'finalizing');
    assert.deepEqual(recentCompletedTasks(2).map((task) => task.taskId), [
      'task_c',
      'task_b',
    ]);
    assert.deepEqual(
      recentCompletedTasks(2, new Set(['task_c'])).map((task) => task.taskId),
      ['task_b', 'task_a'],
    );
    assert.deepEqual(recentCompletedTasks(0), []);
  });
});

test('a saved failure remains discoverable when the final metadata update failed', async () => {
  await withState(async () => {
    legacyMeta('task_failed', 'running');
    const result = details('task_failed');
    result.status = 'failed';
    result.error = 'metadata update failed';
    saveResult(result);
    assert.equal(recentCompletedTasks(10)[0].status, 'failed');
    assert.equal((await readTaskResult(result.taskId))?.error, result.error);
  });
});

test('legacy audit recovery preserves nested data and prefers the final report over later progress reports', async () => {
  await withState(async () => {
    legacyMeta('task_legacy');
    const report = details('task_source').finalReport;
    writeFileSync(
      auditLogPath('task_legacy'),
      [
        JSON.stringify({v: 1, from: 'sub', type: 'report', payload: report}),
        JSON.stringify({
          v: 1,
          from: 'sub',
          type: 'report',
          payload: {summary: 'later partial', final: false},
        }),
        '{incomplete audit line',
      ].join('\n'),
    );
    const result = await readTaskResult('task_legacy');
    assert.deepEqual(result?.finalReport, report);
    assert.equal(result?.mode, 'unknown');
    assert.match(result!.retrievalNote!, /legacy audit log/);
    assert.equal(recentCompletedTasks(10)[0].taskId, 'task_legacy');
  });
});

test('missing or corrupt results and audit logs have a useful metadata fallback', async () => {
  await withState(async () => {
    legacyMeta('task_missing', 'crashed');
    writeFileSync(resultPath('task_missing'), '{bad json');
    const result = await readTaskResult('task_missing');
    assert.equal(result?.status, 'crashed');
    assert.equal(result?.finalReport, undefined);
    assert.match(result!.retrievalNote!, /missing or unreadable/);
    assert.equal(await readTaskResult('task_unknown'), undefined);
    legacyMeta('task_empty');
    writeFileSync(auditLogPath('task_empty'), '');
    assert.match(
      (await readTaskResult('task_empty'))!.retrievalNote!,
      /No valid saved result snapshot or report was found/,
    );
  });
});

test('history rejects traversal and mismatched metadata identities', async () => {
  await withState(async () => {
    for (
      const taskId of ['../outside', '/tmp/outside', '.', '..', 'nested/id']
    ) {
      assert.throws(() => taskDir(taskId), /Invalid subagent task ID/);
      assert.equal(await readTaskResult(taskId), undefined);
    }
    legacyMeta('task_bad');
    const meta = JSON.parse(readFileSync(metaPath('task_bad'), 'utf8'));
    writeFileSync(
      metaPath('task_bad'),
      JSON.stringify({...meta, taskId: '../outside'}),
    );
    assert.equal(await readTaskResult('task_bad'), undefined);
    assert.deepEqual(recentCompletedTasks(10), []);
  });
});

test('task outcomes are explicit claims, not inferred from exit or summary text', async () => {
  await withState(async () => {
    const result = details();
    result.execution = {status: 'ok', exitCode: 0};
    result.finalReport!.summary = 'Task completed successfully';
    assert.equal(describeResult(result).taskOutcome, 'unknown');
    for (
      const outcome of [
        'completed',
        'partial',
        'blocked',
        'declined',
        'failed',
      ] as const
    ) {
      result.finalReport!.outcome = outcome;
      assert.equal(describeResult(result).taskOutcome, outcome);
      assert.equal(result.status, 'ok');
    }
    result.finalReport!.outcome = 'completed';
    result.finalReport!.verification = [{
      check: 'Run test suite',
      result: 'failed',
      details: 'Reported all failures',
    }];
    assert.equal(
      describeResult(result).taskOutcome,
      'completed',
      'completing a testing task does not mean its tests passed',
    );
    result.finalReport!.final = false;
    assert.equal(
      describeResult(result).taskOutcome,
      'unknown',
      'interim reports cannot establish a final outcome',
    );
  });
});

test('descriptions separate reported delivery and verification from harness observations', async () => {
  await withState(async () => {
    const result = details();
    result.finalReport = {
      outcome: 'partial',
      summary: 'Implemented parsing; integration remains blocked.',
      remaining: ['Integrate the parser'],
      blockers: ['Missing service access'],
      artifacts: [{kind: 'file', location: 'parser.ts'}],
      verification: [{check: 'Parser unit tests', result: 'passed'}, {
        check: 'Integration tests',
        result: 'not_run',
      }],
    };
    result.worktree = {
      enabled: true,
      branch: 'retained',
      commits: [{sha: 'abc', subject: 'parser'}],
      retentionVerified: true,
      verification: [{check: 'Branch retention', result: 'passed'}],
    };
    const description = describeResult(result);
    assert.match(description.resultDescription, /partial delivery/);
    assert.deepEqual(description.remaining, ['Integrate the parser']);
    assert.deepEqual(description.blockers, ['Missing service access']);
    assert.equal(description.artifacts.reported[0].location, 'parser.ts');
    assert.equal(description.artifacts.retained[0].location, 'retained');
    assert.equal(description.verification.reported.length, 2);
    assert.deepEqual(description.verification.harness, [{
      check: 'Branch retention',
      result: 'passed',
    }]);
    result.worktree.retentionVerified = false;
    assert.deepEqual(
      describeResult(result).artifacts.retained,
      [],
      'an unverified branch is not a retained artifact claim',
    );
    result.execution = {status: 'ok', exitCode: 0};
    result.status = 'failed';
    result.error = 'retention failed';
    assert.match(
      describeResult(result).resultDescription,
      /Harness finalization ended with status failed: retention failed/,
    );
    saveResult(result);
    assert.deepEqual(
      JSON.parse(readFileSync(result.resultPath!, 'utf8')).result,
      describeResult(result),
    );
  });
});

test('a final agent report is not a finalized harness result', async () => {
  await withState(async () => {
    const result = details();
    result.status = 'finalizing';
    result.finalReport!.outcome = 'completed';
    const visible = JSON.parse(resultText(result));
    assert.equal(visible.finalized, false);
    assert.equal(visible.status, 'finalizing');
    assert.match(visible.resultDescription, /results are not finalized/);
  });
});

test('failed result writes leave no partial result file or temporary file', async () => {
  await withState(async () => {
    const result = details();
    mkdirSync(resultPath(result.taskId));
    assert.throws(() => saveResult(result));
    assert.equal(result.resultPath, undefined);
    assert.deepEqual(readdirSync(result.taskDir), ['result.json']);
  });
});
