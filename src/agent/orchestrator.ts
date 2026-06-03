import { readFileSync } from 'node:fs';
import type { TestStatus } from '@playwright/test';
import { buildFailureAnalysis } from '../reporting/failure-analysis.js';
import { buildNativePlaywrightArtifact } from '../reporting/native-playwright.js';
import { capturePageSnapshot } from './snapshot.js';
import { executeScenario } from './execute.js';
import { describeRegisteredObjects } from './registered-objects.js';
import { finalizeMetrics } from './metrics.js';
import type {
  AgentExecutionResult,
  AgentExecutor,
  AgentFinalResult,
  AgentMetrics,
  AgentResultAttachment,
  AgentResultError,
  AgentResultStep,
  AgentSession,
  AgentTestContext,
  AgentTrajectoryEvent,
  FailureAnalysis,
  Generator,
  Healer,
  MetricSample,
  NativePlaywrightArtifact,
  ScenarioBlock,
  ScenarioOutcome,
  ScenarioRecord,
} from '../shared/types.js';

/**
 * Default executor: runs each scenario through the Generate -> Execute -> Heal
 * pipeline and normalizes the accumulated records into attachments.
 */
export class LangwrightExecutor implements AgentExecutor {
  constructor(
    private readonly generator: Generator,
    private readonly healer?: Healer,
  ) {}

  startSession(context: AgentTestContext): AgentSession {
    return new LangwrightSession(this.generator, this.healer, context);
  }

  /**
   * Run every already-collected scenario in one pass. Used by one-shot paths
   * such as scope hooks, which pre-seed a single scenario.
   */
  async run(context: AgentTestContext): Promise<AgentExecutionResult> {
    const session = this.startSession(context);

    for (const block of context.blocks) {
      const outcome = await session.runScenario(block);

      if (outcome.status === 'failed') {
        break;
      }
    }

    return session.finalize();
  }
}

/**
 * One test's pipeline session. Each `runScenario` snapshots the page, generates
 * Playwright code, executes it directly, and on failure heals (diagnoses) it.
 * `finalize` synthesizes the aggregate result from the accumulated records.
 */
class LangwrightSession implements AgentSession {
  private readonly startedAt = new Date();
  private readonly startedMs = Date.now();
  private readonly records: ScenarioRecord[] = [];
  private readonly samples: MetricSample[] = [];
  private generateCount = 0;
  private healCount = 0;

  constructor(
    private readonly generator: Generator,
    private readonly healer: Healer | undefined,
    private readonly context: AgentTestContext,
  ) {}

  async runScenario(block: ScenarioBlock): Promise<ScenarioOutcome> {
    // Stage 1 — Generate (LLM, page-aware).
    const snapshot = await capturePageSnapshot(this.context.page);
    const { generated, metrics: generateMetrics } = await this.generator.generate({
      block,
      registeredObjects: describeRegisteredObjects(this.context),
      snapshot,
      testTitle: this.context.testInfo.title,
    });
    this.generateCount += 1;
    this.samples.push(...generateMetrics);

    // Stage 2 — Execute (no LLM).
    const execution = await executeScenario(this.context, generated);
    const record: ScenarioRecord = { block, generated, execution };
    this.records.push(record);

    if (execution.ok) {
      return { status: 'ok' };
    }

    // Stage 3 — Heal (LLM) is OPTIONAL: it runs only on failure, and only when a
    // Healer is configured. Without one, the failure is still reported with a
    // deterministic diagnosis (see buildFailureAnalysis).
    if (this.healer) {
      const failureSnapshot = await capturePageSnapshot(this.context.page);
      const { diagnosis, metrics: healMetrics } = await this.healer.heal({
        block,
        generated,
        execution,
        snapshot: failureSnapshot,
        testTitle: this.context.testInfo.title,
        sourceContext: buildSourceContext(this.context),
      });
      this.healCount += 1;
      this.samples.push(...healMetrics);
      record.diagnosis = diagnosis;
    }

    return { status: 'failed', error: execution.error };
  }

  finalize(options?: { status?: TestStatus; error?: AgentResultError }): AgentExecutionResult {
    const metrics = finalizeMetrics(this.samples);
    // Count actual Generator/Healer invocations rather than usage samples, which
    // can be absent when a provider omits usage metadata.
    metrics.extra.llm_call_count = this.generateCount + this.healCount;
    metrics.extra.generator_call_count = this.generateCount;
    metrics.extra.healer_call_count = this.healCount;

    return buildExecutionResult(this.context, this.records, {
      startedAt: this.startedAt,
      duration: Date.now() - this.startedMs,
      metrics,
      options,
    });
  }
}

/** Aggregate metadata accumulated while a session ran, handed to the reporter. */
interface ExecutionResultMeta {
  startedAt: Date;
  duration: number;
  metrics: AgentMetrics;
  options?: { status?: TestStatus; error?: AgentResultError };
}

/** Status, failed scenario, and errors derived from the scenario records. */
interface ResolvedOutcome {
  failedIndex: number;
  failedRecord: ScenarioRecord | undefined;
  status: TestStatus;
  errors: AgentResultError[];
}

/**
 * Stage 4 — Report. Assemble the normalized execution result from the scenario
 * records: trajectory, native Playwright code, failure analysis, and metrics.
 */
function buildExecutionResult(
  context: AgentTestContext,
  records: ScenarioRecord[],
  meta: ExecutionResultMeta,
): AgentExecutionResult {
  const outcome = resolveOutcome(records, meta.options);
  const { status, errors } = outcome;
  const stdout = collectStdout(records);
  const trajectory = buildTrajectory(records);
  const nativePlaywright = buildNativePlaywrightArtifact(records, status);
  const failureAnalysis = buildResultFailureAnalysis(context, meta, outcome, nativePlaywright);

  return {
    status,
    duration: meta.duration,
    errors,
    error: errors.at(0),
    stdout,
    stderr: [],
    attachments: buildResultAttachments(failureAnalysis !== undefined),
    steps: buildResultSteps(records),
    annotations: context.testInfo.annotations.map((annotation) => ({
      type: annotation.type,
      description: annotation.description,
    })),
    retry: context.testInfo.retry,
    startTime: meta.startedAt.toISOString(),
    workerIndex: context.testInfo.workerIndex,
    parallelIndex: context.testInfo.parallelIndex,
    metrics: meta.metrics,
    final: buildFinalResult(status, errors, stdout),
    title: context.testInfo.title,
    actions: records.flatMap((record) => splitInstructions(record.block.steps)),
    expectations: records.flatMap((record) => (record.block.expect ? splitInstructions(record.block.expect) : [])),
    instructions: records.map((record) => record.block),
    trajectory,
    nativePlaywright,
    failureAnalysis,
  };
}

/**
 * Derive run status and errors. A failed scenario's own error is what Playwright
 * originally threw and the body rethrows, so prefer it over the duplicate body
 * error finalize is handed.
 */
function resolveOutcome(records: ScenarioRecord[], options: ExecutionResultMeta['options']): ResolvedOutcome {
  const failedIndex = records.findIndex((record) => !record.execution.ok);
  const failedRecord = failedIndex >= 0 ? records[failedIndex] : undefined;
  const scenarioErrors = failedRecord?.execution.error ? [failedRecord.execution.error] : [];
  const status = deriveStatus(scenarioErrors, options);
  const errors = deriveErrors(scenarioErrors, options);

  return { failedIndex, failedRecord, status, errors };
}

/**
 * A run is `failed` when any scenario errored, or when finalize was handed an
 * explicit failure (error or status). Otherwise honor the caller's requested
 * status, defaulting to `passed`. Extracted so the ternary cluster stays below
 * the cyclomatic-complexity limit and reads as a single decision.
 */
function deriveStatus(scenarioErrors: AgentResultError[], options: ExecutionResultMeta['options']): TestStatus {
  if (scenarioErrors.length > 0 || options?.error !== undefined || options?.status === 'failed') {
    return 'failed';
  }

  return options?.status ?? 'passed';
}

/**
 * Prefer the scenario's own error (the original Playwright throw) over the
 * duplicate body error finalize receives; fall back to the option error, then
 * to no errors. Extracted to keep {@link resolveOutcome} under the complexity
 * limit while preserving the exact precedence.
 */
function deriveErrors(scenarioErrors: AgentResultError[], options: ExecutionResultMeta['options']): AgentResultError[] {
  if (scenarioErrors.length > 0) {
    return scenarioErrors;
  }

  return options?.error ? [options.error] : [];
}

/** Per-scenario observation lines, dropping scenarios that produced none. */
function collectStdout(records: ScenarioRecord[]): string[] {
  return records
    .map((record) => scenarioSummary(record))
    .filter((summary): summary is string => typeof summary === 'string' && summary.length > 0);
}

/** Build the failure diagnosis for a non-passing run; passing runs have none. */
function buildResultFailureAnalysis(
  context: AgentTestContext,
  meta: ExecutionResultMeta,
  outcome: ResolvedOutcome,
  nativePlaywright: NativePlaywrightArtifact,
): FailureAnalysis | undefined {
  if (outcome.status === 'passed') {
    return undefined;
  }

  return buildFailureAnalysis(context, {
    startedAt: meta.startedAt,
    errors: outcome.errors,
    failedRecord: outcome.failedRecord,
    failedStepId: outcome.failedIndex >= 0 ? `playwright-${outcome.failedIndex + 1}` : undefined,
    nativePlaywright,
  });
}

/** The fixed attachment manifest, plus failure analysis when the run failed. */
function buildResultAttachments(hasFailureAnalysis: boolean): AgentResultAttachment[] {
  return [
    { name: 'langwright-result.json', contentType: 'application/json' },
    { name: 'langwright-trajectory.json', contentType: 'application/json' },
    { name: 'langwright-native-playwright.ts', contentType: 'text/plain' },
    { name: 'langwright-native-playwright.json', contentType: 'application/json' },
    ...(hasFailureAnalysis ? [{ name: 'langwright-failure-analysis.json', contentType: 'application/json' }] : []),
  ];
}

/** The Playwright-facing summary view of the run. */
function buildFinalResult(status: TestStatus, errors: AgentResultError[], stdout: string[]): AgentFinalResult {
  return {
    status,
    errors: errors.length > 0 ? errors : undefined,
    stdout: stdout.length > 0 ? stdout : undefined,
    summary: stdout.length > 0 ? stdout.join('\n') : undefined,
  };
}

/**
 * Build the structured trajectory: one event per executed scenario, attributed
 * to its block by `blockIds` (single-element) for ATIF reconstruction.
 */
function buildTrajectory(records: ScenarioRecord[]): AgentTrajectoryEvent[] {
  return records.map((record, index) => ({
    id: `playwright-${index + 1}`,
    type: 'playwright',
    description: record.block.expect
      ? `Scenario ${record.block.id} (actions and assertion)`
      : `Scenario ${record.block.id}`,
    code: record.execution.code,
    blockIds: [record.block.id],
    observation: record.execution.observation,
    error: record.execution.error?.message,
    startedAt: record.execution.startedAt,
    finishedAt: record.execution.finishedAt,
    durationMs: record.execution.durationMs,
  }));
}

function buildResultSteps(records: ScenarioRecord[]): AgentResultStep[] {
  return records.map((record) => ({
    title: `scenario ${record.block.id}`,
    category: 'agent',
    startTime: record.execution.startedAt,
    duration: record.execution.durationMs,
    error: record.execution.ok ? undefined : record.execution.error,
  }));
}

function scenarioSummary(record: ScenarioRecord): string | undefined {
  if (typeof record.execution.observation === 'string' && record.execution.observation.length > 0) {
    return `${record.block.id}: ${record.execution.observation}`;
  }

  return undefined;
}

/**
 * Build a slice of the user's test source for the Healer to reason about,
 * mirroring the failed scenario's registration site.
 */
function buildSourceContext(context: AgentTestContext): string | undefined {
  const file = context.sourceLocation?.file ?? context.testInfo.file;
  const line = context.sourceLocation?.line ?? context.testInfo.line;

  if (!file || !line) {
    return undefined;
  }

  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const startLine = Math.max(1, line - 30);
    const endLine = Math.min(lines.length, line + 60);
    const sourceLines = lines.slice(startLine - 1, endLine).map((source, index) => `${startLine + index}: ${source}`);

    return [`File: ${file}`, `Registered test line: ${line}`, '```ts', ...sourceLines, '```'].join('\n');
  } catch {
    return `File: ${file}\nRegistered test line: ${line}`;
  }
}

function splitInstructions(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+\.\s*/, ''));
}
