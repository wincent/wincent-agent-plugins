import {
  REPORT_OUTCOMES,
  type ReportArtifact,
  type ReportPayload,
  type ReportedOutcome,
  type Verification,
} from '../bus/envelope.js';
import type {SubagentDetails} from './result.js';
import {isTaskPending} from './state.js';

export function reportedOutcome(
  report: ReportPayload | undefined,
): ReportedOutcome {
  return report?.final !== false &&
      REPORT_OUTCOMES.includes(report?.outcome as ReportedOutcome)
    ? report!.outcome!
    : 'unknown';
}

export interface ResultDescription {
  taskOutcome: ReportedOutcome;
  resultDescription: string;
  finalized: boolean;
  remaining: string[];
  blockers: string[];
  artifacts: {reported: ReportArtifact[]; retained: ReportArtifact[]};
  verification: {reported: Verification[]; harness: Verification[]};
}

function verificationEntries(
  entries: Verification[] | undefined,
): Verification[] {
  return Array.isArray(entries)
    ? entries.filter((entry) =>
      typeof entry?.check === 'string' &&
      ['passed', 'failed', 'not_run'].includes(entry.result)
    )
    : [];
}

export function describeResult(details: SubagentDetails): ResultDescription {
  const report = details.finalReport;
  const taskOutcome = reportedOutcome(report);
  const finalized = !isTaskPending(details.status);
  const claims: Record<ReportedOutcome, string> = {
    completed: 'Agent reports task completion',
    partial: 'Agent finished with partial delivery',
    blocked: 'Agent finished but was blocked',
    declined: 'Agent finished but declined the task',
    failed: 'Agent finished and reported task failure',
    unknown: 'Task outcome was not reported',
  };
  const remaining = Array.isArray(report?.remaining)
    ? report.remaining.filter((value) => typeof value === 'string')
    : [];
  const blockers = Array.isArray(report?.blockers)
    ? report.blockers.filter((value) => typeof value === 'string')
    : [];
  let resultDescription = finalized
    ? `${claims[taskOutcome]}.${report?.summary ? ` ${report.summary}` : ''}`
    : `Task is ${details.status}; results are not finalized.${
      report?.summary ? ` Latest report: ${report.summary}` : ''
    }`;
  if (finalized && details.status !== 'ok') {
    const phase = details.execution?.status === 'ok'
      ? 'Harness finalization'
      : 'Task lifecycle';
    resultDescription = `${phase} ended with status ${details.status}${
      details.error ? `: ${details.error}.` : '.'
    } ${resultDescription}`;
  }
  if (blockers.length) {
    resultDescription += ` Blockers: ${blockers.join('; ')}.`;
  }
  if (remaining.length) {
    resultDescription += ` Remaining: ${remaining.join('; ')}.`;
  }
  const retained: ReportArtifact[] = [];
  if (details.worktree.retentionVerified && details.worktree.branch) {
    retained.push({
      kind: 'branch',
      location: details.worktree.branch,
      description: `Retained in ${
        details.worktree.repoRoot ?? 'the source repository'
      }`,
    });
    for (
      const commit of Array.isArray(details.worktree.commits)
        ? details.worktree.commits
        : []
    ) {
      if (
        typeof commit?.sha === 'string' && typeof commit.subject === 'string'
      ) {
        retained.push({
          kind: 'commit',
          location: commit.sha,
          description: commit.subject,
        });
      }
    }
  }
  if (details.worktree.preservedPath) {
    retained.push({
      kind: 'directory',
      location: details.worktree.preservedPath,
      description: 'Worktree preserved for inspection',
    });
  }
  const harness: Verification[] = details.execution ?
    [{
      check: 'Child process exit observed',
      result: details.execution.processExited === true
        ? 'passed'
        : details.execution.processExited === false
        ? 'failed'
        : 'not_run',
      details: `status=${details.execution.status}, exitCode=${
        details.execution.exitCode ?? 'unknown'
      }, signal=${details.execution.signal ?? 'none'}`,
    }, {
      check: 'Owned process group exited',
      result: details.execution.processGroupExited === true
        ? 'passed'
        : details.execution.processGroupExited === false
        ? 'failed'
        : 'not_run',
    }] :
    [];
  harness.push(...verificationEntries(details.worktree.verification));
  return {
    taskOutcome,
    resultDescription,
    finalized,
    remaining,
    blockers,
    artifacts: {
      reported: Array.isArray(report?.artifacts) ? report.artifacts : [],
      retained,
    },
    verification: {
      reported: verificationEntries(report?.verification),
      harness,
    },
  };
}
