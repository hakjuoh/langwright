import { createHash } from 'node:crypto';
import type {
  AgentResultError,
  AgentTestContext,
  AttachmentRef,
  FailureAnalysis,
  FailureEvidence,
  FailureFinding,
  HealerDiagnosis,
  NativePlaywrightArtifact,
  ScenarioRecord,
} from '../shared/types.js';

export const FAILURE_ANALYSIS_LIMITS = {
  maxFindings: 3,
  maxEvidencePerFinding: 5,
  maxEvidenceDetailChars: 500,
  maxExplanationChars: 1500,
} as const;

interface BuildFailureAnalysisOptions {
  startedAt: Date;
  errors: AgentResultError[];
  /** The first failed scenario, when one exists. */
  failedRecord?: ScenarioRecord;
  /** Trajectory step id of the failed scenario, for evidence locators. */
  failedStepId?: string;
  nativePlaywright?: NativePlaywrightArtifact;
}

const resultAttachment: AttachmentRef = {
  storage: 'local',
  uri: 'attachment://langwright-result.json',
};

const trajectoryAttachment: AttachmentRef = {
  storage: 'local',
  uri: 'attachment://langwright-trajectory.json',
};

/**
 * Assemble the read-only failure diagnosis for a non-passing test.
 *
 * When the Healer produced a diagnosis, its findings are wrapped with
 * deterministic ids, evidence, run id, fingerprint, and approval policy.
 * Otherwise a conservative fallback finding is inferred from the failed
 * scenario's error.
 */
export function buildFailureAnalysis(
  context: AgentTestContext,
  options: BuildFailureAnalysisOptions,
): FailureAnalysis {
  const diagnosis = options.failedRecord?.diagnosis;
  const evidence = buildEvidence(context, options);
  const primaryError = options.failedRecord?.execution.error ?? options.errors.at(0);

  if (diagnosis && diagnosis.findings.length > 0) {
    return enrichFailureAnalysis(
      context,
      boundFailureAnalysis(assembleHealedAnalysis(context, options, diagnosis, evidence)),
    );
  }

  const summary = truncate(
    diagnosis?.summary ?? primaryError?.message ?? 'The Langwright agent reported a failed test run.',
    FAILURE_ANALYSIS_LIMITS.maxEvidenceDetailChars,
  );
  const finding = buildFallbackFinding(summary, evidence, Boolean(options.failedRecord), options.nativePlaywright);

  return {
    runId: buildRunId(context),
    timestamp: options.startedAt.toISOString(),
    fingerprint: fingerprintFailure(context, evidence),
    summary,
    findings: [finding],
    fixPlan: {
      findingIds: [finding.id],
      rationale:
        'Review the failing expectation against the observed browser state, then either correct the product behavior or update the test requirement if the expectation is wrong.',
      suggestedFix: {
        rationale: inferSuggestedFix(summary),
        risk: 'medium',
      },
      verification: [
        'Rerun the failing Langwright spec only.',
        'Inspect langwright-result.json and langwright-trajectory.json if the failure repeats.',
        'After a code or test change, rerun the closest related regression tests.',
      ],
    },
    approvalPolicy: 'always',
  };
}

/**
 * Wrap the Healer's findings into a full FailureAnalysis with deterministic
 * ids, shared evidence, run id, fingerprint, and approval policy.
 */
function assembleHealedAnalysis(
  context: AgentTestContext,
  options: BuildFailureAnalysisOptions,
  diagnosis: HealerDiagnosis,
  evidence: FailureEvidence[],
): FailureAnalysis {
  const findings: FailureFinding[] = diagnosis.findings.map((finding, index) => ({
    id: `finding-${index + 1}`,
    provenance: 'agent',
    title: finding.title,
    category: finding.category,
    owner: finding.owner,
    confidence: finding.confidence,
    explanation: finding.explanation,
    evidence,
    suggestedFix: finding.suggestedFix,
  }));
  const summary = truncate(diagnosis.summary, FAILURE_ANALYSIS_LIMITS.maxExplanationChars);
  const primaryFix = findings.find((finding) => finding.suggestedFix)?.suggestedFix;

  return {
    runId: buildRunId(context),
    timestamp: options.startedAt.toISOString(),
    fingerprint: fingerprintFailure(context, evidence),
    summary,
    findings,
    fixPlan: {
      findingIds: findings.map((finding) => finding.id),
      rationale: primaryFix?.rationale ?? summary,
      suggestedFix: primaryFix ?? { rationale: inferSuggestedFix(summary), risk: 'medium' },
      verification: [
        'Apply the suggested fix, then rerun the failing Langwright spec only.',
        'Inspect langwright-result.json and langwright-trajectory.json if the failure repeats.',
        'After a code or test change, rerun the closest related regression tests.',
      ],
    },
    approvalPolicy: 'always',
  };
}

function buildFallbackFinding(
  summary: string,
  evidence: FailureEvidence[],
  hasFailedScenario: boolean,
  nativePlaywright: NativePlaywrightArtifact | undefined,
): FailureFinding {
  const owner = inferOwner(summary, hasFailedScenario);
  const category = inferCategory(summary);
  const nativeDiagnostics = nativePlaywright?.diagnostics.join('\n');
  const explanation = truncate(
    [
      'The test failed after Langwright generated and executed the requested browser actions and assertions.',
      'The primary failure evidence points to a mismatch between the requested expectation and the observed page state.',
      nativeDiagnostics ? `Native Playwright generation also reported: ${nativeDiagnostics}` : undefined,
    ]
      .filter(Boolean)
      .join(' '),
    FAILURE_ANALYSIS_LIMITS.maxExplanationChars,
  );

  return {
    id: 'finding-1',
    provenance: 'fallback',
    title: titleForCategory(category, owner),
    category,
    owner,
    confidence: evidence.some((item) => item.relevance === 'primary') ? 0.72 : 0.5,
    explanation,
    evidence,
    suggestedFix: {
      rationale: inferSuggestedFix(summary),
      risk: 'medium',
    },
  };
}

function inferSuggestedFix(summary: string): string {
  const quotedValues = [...summary.matchAll(/"([^"]+)"/g)].map((match) => match[1]).filter(Boolean);

  if (quotedValues.length >= 2 && /expect|expected|assert/i.test(summary)) {
    const [expected, actual] = quotedValues;

    return [
      `Confirm whether "${expected}" is the intended expected value.`,
      `If the observed value "${actual}" is correct, update the test expectation to "${actual}".`,
      `If "${expected}" is correct, change the app, fixture setup, or preceding test steps so the page reaches that state before the assertion.`,
    ].join(' ');
  }

  if (/not present|not found|no matching|missing/i.test(summary)) {
    return 'Confirm whether the missing element or text is part of the intended behavior. If not, update the test expectation to an existing UI state; if it is required, change the app or fixture setup so the element is present before the assertion.';
  }

  return 'Review the failing expectation against the observed browser state, then either correct the product behavior or update the test requirement if the expectation is wrong.';
}

function buildEvidence(context: AgentTestContext, options: BuildFailureAnalysisOptions): FailureEvidence[] {
  const evidence: FailureEvidence[] = [];
  const testSourceEvidence = buildTestSourceEvidence(context);

  if (testSourceEvidence) {
    evidence.push(testSourceEvidence);
  }

  const failedError = options.failedRecord?.execution.error;

  if (options.failedStepId && failedError) {
    evidence.push({
      id: `evidence-${evidence.length + 1}`,
      provenance: 'fallback',
      locator: {
        kind: 'agent_step',
        trajectory: trajectoryAttachment,
        stepId: options.failedStepId,
      },
      detail: truncate(failedError.message, FAILURE_ANALYSIS_LIMITS.maxEvidenceDetailChars),
      relevance: 'primary',
    });
  }

  const primaryError = failedError ?? options.errors.at(0);

  if (primaryError) {
    evidence.push({
      id: `evidence-${evidence.length + 1}`,
      provenance: 'fallback',
      locator: {
        kind: 'log_span',
        log: resultAttachment,
        pattern: firstLine(primaryError.message),
      },
      detail: truncate(primaryError.message, FAILURE_ANALYSIS_LIMITS.maxEvidenceDetailChars),
      relevance: options.failedStepId && failedError ? 'supporting' : 'primary',
    });
  }

  return evidence.slice(0, FAILURE_ANALYSIS_LIMITS.maxEvidencePerFinding);
}

function buildTestSourceEvidence(context: AgentTestContext): FailureEvidence | undefined {
  const file = context.sourceLocation?.file ?? context.testInfo.file;
  const line = context.sourceLocation?.line ?? context.testInfo.line;

  if (!file || !line) {
    return undefined;
  }

  return {
    id: 'evidence-1',
    provenance: 'langwright',
    locator: {
      kind: 'source_range',
      file,
      role: 'test',
      ranges: [{ startLine: Math.max(1, line), endLine: Math.max(1, line) }],
    },
    detail: `The failing Langwright test is registered at ${file}:${line}.`,
    relevance: 'context',
  };
}

function inferCategory(message: string): FailureFinding['category'] {
  const normalized = message.toLowerCase();

  if (/\btimeout\b|timed out|flaky|intermittent/.test(normalized)) {
    return 'flake';
  }

  if (/ambiguous|unclear|cannot determine|insufficient/.test(normalized)) {
    return 'spec_gap';
  }

  return 'defect';
}

function inferOwner(message: string, hasFailedScenario: boolean): FailureFinding['owner'] {
  const normalized = message.toLowerCase();

  if (/api key|credential|browser closed|worker|fixture|config/.test(normalized)) {
    return 'infra';
  }

  if (/invalid json|did not report|agent/.test(normalized)) {
    return 'agent';
  }

  if (/expect|locator|tohave|visible|text|title/.test(normalized)) {
    return 'unknown';
  }

  if (!hasFailedScenario) {
    return 'agent';
  }

  return 'unknown';
}

function titleForCategory(category: FailureFinding['category'], owner: FailureFinding['owner']): string {
  if (category === 'flake') {
    return 'Likely timing or environment-sensitive failure';
  }

  if (category === 'spec_gap') {
    return 'Requirement or expected behavior needs clarification';
  }

  if (owner === 'agent') {
    return 'Generated code failed to complete the requested test contract';
  }

  return 'Observed page state did not satisfy the test expectation';
}

function fingerprintFailure(context: AgentTestContext, evidence: FailureEvidence[]): string {
  const hash = createHash('sha256');
  hash.update(context.testInfo.title);
  hash.update('\n');
  hash.update(context.blocks.map((block) => `${block.id}:${block.steps}:${block.expect ?? ''}`).join('\n'));
  hash.update('\n');
  hash.update(evidence.map((item) => `${item.locator.kind}:${locatorFingerprint(item.locator)}`).join('\n'));

  return hash.digest('hex').slice(0, 16);
}

function buildRunId(context: AgentTestContext): string {
  return [
    context.testInfo.project.name,
    context.sourceLocation?.file ?? context.testInfo.file,
    context.sourceLocation?.line ?? context.testInfo.line,
    `retry-${context.testInfo.retry}`,
  ]
    .filter(Boolean)
    .join(':');
}

function boundFailureAnalysis(analysis: FailureAnalysis): FailureAnalysis {
  const sortedFindings = [...analysis.findings].sort((left, right) => right.confidence - left.confidence);
  const droppedFindings = Math.max(0, sortedFindings.length - FAILURE_ANALYSIS_LIMITS.maxFindings);
  const findings = sortedFindings.slice(0, FAILURE_ANALYSIS_LIMITS.maxFindings).map((finding) => ({
    ...finding,
    provenance: finding.provenance ?? 'agent',
    confidence: clampConfidence(finding.confidence),
    explanation: truncate(finding.explanation, FAILURE_ANALYSIS_LIMITS.maxExplanationChars),
    evidence: finding.evidence.slice(0, FAILURE_ANALYSIS_LIMITS.maxEvidencePerFinding).map((evidence) => ({
      ...evidence,
      provenance: evidence.provenance ?? 'agent',
      detail: truncate(evidence.detail, FAILURE_ANALYSIS_LIMITS.maxEvidenceDetailChars),
    })),
  }));

  return {
    ...analysis,
    summary: truncate(analysis.summary, FAILURE_ANALYSIS_LIMITS.maxExplanationChars),
    diagnostics: [
      ...(analysis.diagnostics ?? []),
      ...(droppedFindings > 0 ? [`Dropped ${droppedFindings} low-confidence finding(s) due to analysis bounds.`] : []),
    ],
    findings,
    // Keep fixPlan.findingIds consistent with the retained findings so it never
    // references a finding that bounding dropped.
    fixPlan: reconcileFixPlan(analysis.fixPlan, findings),
  };
}

/**
 * Drop fix-plan references to findings that were bounded away; if none of the
 * referenced findings survived, point at all retained findings instead.
 */
function reconcileFixPlan(
  fixPlan: FailureAnalysis['fixPlan'],
  findings: FailureFinding[],
): FailureAnalysis['fixPlan'] {
  if (!fixPlan) {
    return undefined;
  }

  const retainedIds = new Set(findings.map((finding) => finding.id));
  const referenced = fixPlan.findingIds.filter((id) => retainedIds.has(id));

  return {
    ...fixPlan,
    findingIds: referenced.length > 0 ? referenced : findings.map((finding) => finding.id),
  };
}

function enrichFailureAnalysis(context: AgentTestContext, analysis: FailureAnalysis): FailureAnalysis {
  const sourceEvidence = buildTestSourceEvidence(context);

  if (!sourceEvidence) {
    return analysis;
  }

  return {
    ...analysis,
    findings: analysis.findings.map((finding) => {
      if (finding.evidence.some((evidence) => evidence.locator.kind === 'source_range')) {
        return finding;
      }

      return {
        ...finding,
        evidence: [...finding.evidence, { ...sourceEvidence, id: `${finding.id}-source` }].slice(
          0,
          FAILURE_ANALYSIS_LIMITS.maxEvidencePerFinding,
        ),
      };
    }),
  };
}

function locatorFingerprint(locator: FailureEvidence['locator']): string {
  switch (locator.kind) {
    case 'source_range':
      return `${locator.file}:${locator.ranges.map((range) => `${range.startLine}-${range.endLine ?? range.startLine}`).join(',')}`;
    case 'agent_step':
      return locator.stepId;
    case 'dom_node':
      return locator.selector ?? locator.role ?? locator.text ?? locator.htmlExcerpt ?? 'dom';
    case 'trace_event':
      return locator.eventId;
    case 'log_span':
      return `${locator.startLine ?? ''}-${locator.endLine ?? ''}:${locator.pattern ?? ''}`;
    case 'network_request':
      return `${locator.requestId}:${locator.status ?? ''}`;
    case 'external_html_fragment':
      return `${locator.url}:${locator.selector ?? locator.textFragment ?? ''}`;
    case 'screenshot_region':
      return `${locator.image.uri}:${locator.bbox.x},${locator.bbox.y},${locator.bbox.width},${locator.bbox.height}`;
    case 'video_segment':
      return `${locator.video.uri}:${locator.startMs}-${locator.endMs}`;
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function firstLine(value: string): string {
  return value.split('\n').find((line) => line.trim())?.trim() ?? value;
}
