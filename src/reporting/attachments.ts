import type { TestInfo } from '@playwright/test';
import { createAtifTrajectoryFormatter } from './atif.js';
import { resolveRunSessionId } from './session-id.js';
import type {
  AgentExecutionResult,
  AgentTrajectoryEvent,
  FailureAnalysis,
  NativePlaywrightArtifact,
} from '../shared/types.js';

/**
 * Filenames of the artifacts Langwright attaches to a test result. Kept in one
 * place so each `testInfo.attach(...)` call and the summary that references it
 * (`detailsAttachment`/`bodyAttachment`) cannot drift apart.
 */
const ATTACHMENT_NAMES = {
  result: 'langwright-result.json',
  nativeBody: 'langwright-native-playwright.ts',
  nativeJson: 'langwright-native-playwright.json',
  failureAnalysis: 'langwright-failure-analysis.json',
} as const;

/**
 * Attach all Langwright-produced artifacts to the Playwright test result.
 */
export async function attachAgentResult(
  testInfo: TestInfo,
  result: AgentExecutionResult,
  trajectoryFormatter = createAtifTrajectoryFormatter({ sessionId: resolveRunSessionId(testInfo) }),
): Promise<void> {
  await testInfo.attach(ATTACHMENT_NAMES.result, {
    body: JSON.stringify(toAgentResultAttachment(result, trajectoryFormatter), null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach(trajectoryFormatter.name, {
    body: trajectoryFormatter.format(result),
    contentType: trajectoryFormatter.contentType,
  });

  if (result.nativePlaywright) {
    await testInfo.attach(ATTACHMENT_NAMES.nativeBody, {
      body: result.nativePlaywright.body || '// No native Playwright code could be generated.\n',
      contentType: 'text/plain',
    });
    await testInfo.attach(ATTACHMENT_NAMES.nativeJson, {
      body: JSON.stringify(result.nativePlaywright, null, 2),
      contentType: 'application/json',
    });
  }

  if (result.failureAnalysis) {
    await testInfo.attach(ATTACHMENT_NAMES.failureAnalysis, {
      body: JSON.stringify(result.failureAnalysis, null, 2),
      contentType: 'application/json',
    });
  }
}

/**
 * Build the JSON payload stored in `langwright-result.json`.
 */
function toAgentResultAttachment(
  result: AgentExecutionResult,
  trajectoryFormatter: ReturnType<typeof createAtifTrajectoryFormatter>,
) {
  return {
    status: result.status,
    duration: result.duration,
    errors: result.errors,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
    attachments: [
      {
        name: ATTACHMENT_NAMES.result,
        contentType: 'application/json',
      },
      {
        name: trajectoryFormatter.name,
        contentType: trajectoryFormatter.contentType,
      },
      ...result.attachments.filter(
        (attachment) =>
          attachment.name !== ATTACHMENT_NAMES.result &&
          attachment.name !== trajectoryFormatter.name,
      ),
    ],
    steps: result.steps,
    annotations: result.annotations,
    retry: result.retry,
    startTime: result.startTime,
    workerIndex: result.workerIndex,
    parallelIndex: result.parallelIndex,
    metrics: result.metrics,
    final: result.final,
    title: result.title,
    actions: result.actions,
    expectations: result.expectations,
    trajectorySummary: summarizeTrajectory(result.trajectory, trajectoryFormatter.name),
    nativePlaywright: summarizeNativePlaywright(result.nativePlaywright),
    failureAnalysis: summarizeFailureAnalysis(result.failureAnalysis),
  };
}

function summarizeTrajectory(trajectory: AgentTrajectoryEvent[], detailsAttachment: string) {
  const failedSteps = trajectory.filter((event) => event.error).length;
  const lastEvent = trajectory.at(-1);

  return {
    totalSteps: trajectory.length,
    failedSteps,
    lastStep: lastEvent
      ? {
          id: lastEvent.id,
          blockIds: lastEvent.blockIds,
          durationMs: lastEvent.durationMs,
          status: lastEvent.error ? 'failed' : 'passed',
        }
      : undefined,
    detailsAttachment,
  };
}

function summarizeNativePlaywright(nativePlaywright: NativePlaywrightArtifact | undefined) {
  if (!nativePlaywright) {
    return undefined;
  }

  return {
    status: nativePlaywright.status,
    reason: truncateSummary(nativePlaywright.diagnostics.at(0)),
    hasBody: nativePlaywright.body.trim().length > 0,
    bodyLength: nativePlaywright.body.length,
    spanCount: nativePlaywright.spans.length,
    detailsAttachment: ATTACHMENT_NAMES.nativeJson,
    bodyAttachment: ATTACHMENT_NAMES.nativeBody,
  };
}

function summarizeFailureAnalysis(analysis: FailureAnalysis | undefined) {
  if (!analysis) {
    return undefined;
  }

  const primaryFinding = analysis.findings.at(0);

  return {
    summary: analysis.summary,
    cause: primaryFinding?.explanation,
    finding: primaryFinding
      ? {
          title: primaryFinding.title,
          category: primaryFinding.category,
          owner: primaryFinding.owner,
          confidence: primaryFinding.confidence,
        }
      : undefined,
    suggestedFix:
      analysis.fixPlan?.suggestedFix.rationale ??
      primaryFinding?.suggestedFix?.rationale,
    approvalPolicy: analysis.approvalPolicy,
    detailsAttachment: ATTACHMENT_NAMES.failureAnalysis,
  };
}

function truncateSummary(value: string | undefined, maxLength = 300): string | undefined {
  if (!value || value.length <= maxLength) {
    return value;
  }

  // Reserve one character for the ellipsis so the result never exceeds maxLength.
  return `${value.slice(0, maxLength - 1)}…`;
}
