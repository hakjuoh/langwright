import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestInfo,
  TestStatus,
} from '@playwright/test';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Playwright option fixtures that are copied into the Langwright execution
 * scope. These are exposed both as top-level variables and under `options`
 * when the generated Playwright code runs.
 */
export type LangwrightFixtureOptions = PlaywrightTestOptions & PlaywrightWorkerOptions;

/**
 * The two halves a `scenario(...)` call can carry. `steps` become Playwright
 * actions; `expectation` become `expect(...)` assertions. Used to label native
 * Playwright code spans and ATIF turns.
 */
export type AgentInstructionBlockKind = 'steps' | 'expectation';

/**
 * One awaited `scenario(steps, expect?)` call: the unit of generation and
 * execution. The steps are converted into action code and the optional
 * expectation into assertion code by the Generator, then run together.
 */
export interface ScenarioBlock {
  /** Stable block ID used in prompts, trajectory events, and generated spans. */
  id: string;
  /** Rendered natural-language action text (required). */
  steps: string;
  /** Rendered natural-language expectation text, when the call supplied one. */
  expect?: string;
}

/**
 * Ordered work item collected while a Langwright test body is evaluated.
 */
export type AgentBlock = ScenarioBlock;

/**
 * Best-effort accessibility/state snapshot of the live page, passed to the
 * Generator (to author robust locators) and the Healer (to diagnose failures).
 */
export interface PageSnapshot {
  /** AI-optimized ARIA snapshot of the page body, when it could be captured. */
  ariaSnapshot?: string;
  /** Current page URL. */
  url?: string;
  /** Current page title. */
  title?: string;
}

/**
 * Per-test runtime state shared between the DSL, the stage modules, and the
 * artifact builders.
 */
export interface AgentTestContext {
  /** Complete Playwright fixture bundle exposed to tests and generated code. */
  fixtures: LangwrightFixtures;
  /** Active Playwright page convenience reference. */
  page: PlaywrightTestArgs['page'];
  /** Playwright Test metadata for the running test. */
  testInfo: TestInfo;
  /** Ordered scenario blocks collected as the body runs. */
  blocks: AgentBlock[];
  /** Monotonic counter used to allocate `block-N` identifiers. */
  nextBlockIndex: number;
  /** Best-effort source location of the user-authored Langwright test. */
  sourceLocation?: AgentSourceLocation;
  /**
   * User-defined fixtures and `register(...)` objects captured for this test,
   * injected into the generated-code scope under their own names. Refreshed
   * (non-draining) before each scenario so registrations made between awaited
   * DSL calls reach the Generator, and snapshotted when the test finalizes.
   */
  userFixtures?: Record<string, unknown>;
  /**
   * Worker-scoped fixture names this test is allowed to expose, derived from the
   * test body signature. Gates which worker captures reach the generated-code
   * scope when refreshing {@link userFixtures} per scenario.
   */
  exposedWorkerNames?: ReadonlySet<string>;
  /**
   * The active session, present during the per-test runtime so each awaited DSL
   * call can run one scenario through it. Absent for one-shot paths such as
   * scope hooks that drive the session through {@link AgentExecutor.run}.
   */
  session?: AgentSession;
}

/**
 * Best-effort source location captured when a user registers `test(...)`.
 */
export interface AgentSourceLocation {
  /** Absolute or project-resolved test file path. */
  file: string;
  /** One-based line number. */
  line: number;
  /** Optional one-based column number. */
  column?: number;
}

/**
 * The complete set of Playwright Test fixtures available to Langwright tests.
 */
export type LangwrightFixtures = PlaywrightTestArgs &
  PlaywrightWorkerArgs &
  LangwrightFixtureOptions & {
    options: LangwrightFixtureOptions;
  };

/* -------------------------------------------------------------------------- */
/* Stage 1: Generate                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Provider-agnostic LLM usage sample collected from one structured-output call.
 */
export interface MetricSample {
  /** Token usage record extracted from the raw model response. */
  usage: Record<string, unknown>;
  /** Response metadata (model name, provider) extracted from the raw response. */
  metadata: Record<string, unknown>;
}

/**
 * Everything the Generator needs to convert one scenario into Playwright code.
 */
export interface GeneratorInput {
  /** The scenario being converted. */
  block: ScenarioBlock;
  /** One-line descriptions of objects available by name in the run scope. */
  registeredObjects: string[];
  /** Live page snapshot used to author robust locators. */
  snapshot: PageSnapshot;
  /** Test title, for orientation. */
  testTitle: string;
}

/**
 * Playwright code generated for one scenario. `actionCode` performs the steps;
 * `assertionCode` holds `expect(...)` assertions for the optional expectation.
 */
export interface GeneratedScenario {
  /** Source scenario block ID. */
  blockId: string;
  /** Playwright action code implementing the scenario's steps. */
  actionCode: string;
  /** `expect(...)` assertion code implementing the scenario's expectation. */
  assertionCode?: string;
  /** Optional model rationale; never executed or copied into native output. */
  notes?: string;
}

/**
 * The Generator stage: a single structured-output LLM call per scenario.
 */
export interface Generator {
  generate(input: GeneratorInput): Promise<{ generated: GeneratedScenario; metrics: MetricSample[] }>;
}

/* -------------------------------------------------------------------------- */
/* Stage 2: Execute                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic result of running one scenario's generated code via Playwright.
 * Produced without any LLM involvement.
 */
export interface ExecutionRecord {
  /** Source scenario block ID. */
  blockId: string;
  /** Whether the generated code ran without throwing. */
  ok: boolean;
  /** The exact code that was executed (action code, then assertion code). */
  code: string;
  /** Serialized return value of the executed body, when any. */
  observation?: unknown;
  /** Failure detail when `ok` is `false`. */
  error?: AgentResultError;
  /** Page URL observed after execution. */
  url?: string;
  /** Page title observed after execution. */
  title?: string;
  /** ISO timestamp for when execution started. */
  startedAt: string;
  /** ISO timestamp for when execution finished. */
  finishedAt: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Stage 3: Heal                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything the Healer needs to diagnose one failed scenario.
 */
export interface HealerInput {
  /** The scenario that failed. */
  block: ScenarioBlock;
  /** The code the Generator produced for it. */
  generated: GeneratedScenario;
  /** The failed execution record (carries the error). */
  execution: ExecutionRecord;
  /** Page snapshot captured at the point of failure. */
  snapshot: PageSnapshot;
  /** Test title, for orientation. */
  testTitle: string;
  /** Optional source slice (file:line + surrounding lines) for diagnosis. */
  sourceContext?: string;
}

/**
 * One diagnosed cause produced by the Healer model. The deterministic Report
 * stage wraps these into full {@link FailureFinding}s (ids, evidence, provenance).
 */
export interface HealerFinding {
  /** Short display title. */
  title: string;
  /** What kind of failure occurred. */
  category: FailureFinding['category'];
  /** Likely owner of the repair. */
  owner: FailureFinding['owner'];
  /** Numeric confidence in [0, 1]. */
  confidence: number;
  /** Concise explanation of the cause. */
  explanation: string;
  /** Optional fix proposal. */
  suggestedFix?: SuggestedFix;
}

/**
 * The Healer model's diagnosis for one failed scenario. Langwright assembles
 * the full {@link FailureAnalysis} (runId, timestamp, fingerprint, evidence,
 * approval policy) deterministically around this content.
 */
export interface HealerDiagnosis {
  /** Human-readable summary of the failure. */
  summary: string;
  /** One or more diagnosed causes. */
  findings: HealerFinding[];
}

/**
 * The Healer stage: a single structured-output LLM call on failure.
 */
export interface Healer {
  heal(input: HealerInput): Promise<{ diagnosis: HealerDiagnosis; metrics: MetricSample[] }>;
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The full record of one scenario across the pipeline.
 */
export interface ScenarioRecord {
  /** The scenario block. */
  block: ScenarioBlock;
  /** Code produced by the Generator. */
  generated: GeneratedScenario;
  /** Result of executing that code. */
  execution: ExecutionRecord;
  /** Healer diagnosis, present iff execution failed and Heal ran. */
  diagnosis?: HealerDiagnosis;
}

/**
 * DSL-facing outcome of running one scenario. A failed outcome throws at the
 * awaited `scenario(...)` call, like a Playwright assertion.
 */
export interface ScenarioOutcome {
  /** Whether the scenario passed. */
  status: 'ok' | 'failed';
  /** Failure detail when `status` is `failed`. */
  error?: AgentResultError;
}

/**
 * A persistent session for one test. Each awaited DSL call runs one scenario
 * through {@link runScenario} (Generate -> Execute -> Heal-on-failure) against
 * the live browser; {@link finalize} synthesizes the single execution result
 * from the accumulated scenario records and metrics.
 */
export interface AgentSession {
  /** Run one scenario through the pipeline and report its outcome. */
  runScenario(block: ScenarioBlock): Promise<ScenarioOutcome>;
  /** Assemble the aggregate execution result for the whole test. */
  finalize(options?: { status?: TestStatus; error?: AgentResultError }): AgentExecutionResult;
}

/**
 * Pluggable execution backend for Langwright.
 *
 * Custom executors can replace the default pipeline while preserving the same
 * result attachment and failure behavior in the Playwright runner.
 */
export interface AgentExecutor {
  /**
   * Start a session for the per-test incremental runtime, where each awaited
   * DSL call drives one scenario.
   */
  startSession(context: AgentTestContext): AgentSession;
  /**
   * Run all already-collected scenarios in one pass. Used by one-shot paths
   * such as scope hooks.
   */
  run(context: AgentTestContext): Promise<AgentExecutionResult>;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Per-role override for the Generator or Healer. When omitted, the role is
 * derived from the base {@link LangwrightConfig.model}.
 */
export interface AgentRoleConfig {
  /** Chat model for this role; defaults to the base config model. */
  model?: BaseChatModel;
  /** System-prompt override for this role. */
  systemPrompt?: string;
}

/**
 * Runtime configuration loaded from `langwright.config.*`.
 *
 * Langwright derives a Generator and a Healer from `model`; either role can be
 * overridden (so they can use different models) via `generator`/`healer`.
 */
export interface LangwrightConfig {
  /** Base chat model used for both the Generator and the Healer. */
  model?: BaseChatModel;
  /** Generator override: a role config or a fully built Generator. */
  generator?: AgentRoleConfig | Generator;
  /**
   * Healer override. Healing is OPTIONAL — it only runs when a scenario fails
   * (a passing scenario has nothing to fix). Provide a role config or a built
   * Healer, or set `false` to disable healing entirely. When omitted, a Healer
   * is derived from the base `model` if one is available; with no model and no
   * explicit Healer, failures are reported with a deterministic diagnosis and
   * no LLM heal step.
   */
  healer?: AgentRoleConfig | Healer | false;
  /** Custom executor. When present, this takes precedence over `model`. */
  executor?: AgentExecutor;
  /** Human-readable agent name written to trajectory artifacts. */
  agentName?: string;
  /** Human-readable agent version written to trajectory artifacts. */
  agentVersion?: string;
  /** Custom formatter for the trajectory attachment. */
  trajectoryFormatter?: AgentTrajectoryFormatter;
  /**
   * Stable run identifier used for trajectory grouping. This is the static
   * form: supply it when you already know the run ID — e.g. a CI build ID or
   * git SHA computed when the config module is loaded. For an ID that must be
   * derived from the test, use {@link sessionIdResolver} instead; it takes
   * precedence when both are set. When neither is set, Langwright auto-resolves
   * a run-stable ID (the `LANGWRIGHT_SESSION_ID` env var, else a generated one
   * shared across parallel workers).
   */
  sessionId?: string;
  /**
   * Resolver invoked once per agent run to derive the session ID from the run's
   * {@link TestInfo}. Takes precedence over {@link sessionId}. Because it is the
   * trajectory grouping key, it MUST return a value that is stable across the
   * whole run — do not derive it from per-test fields such as the title or
   * repeat index, or trajectories from one run will no longer group together.
   */
  sessionIdResolver?: (testInfo: TestInfo) => string;
}

/* -------------------------------------------------------------------------- */
/* Stage 4: Report                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Normalized result produced by the executor.
 *
 * This intentionally mirrors the parts of Playwright TestResult that are useful
 * as attachments, while keeping Langwright-specific fields such as scenarios,
 * trajectory events, model metrics, and generated native Playwright output.
 */
export interface AgentExecutionResult {
  /** Final Playwright-compatible status selected from the run outcome. */
  status: TestStatus;
  /** Wall-clock execution time for the run in milliseconds. */
  duration: number;
  /** Normalized errors reported by the pipeline. */
  errors: AgentResultError[];
  /** Per-scenario summary lines aggregated into the run's stdout. */
  stdout: string[];
  /** Reserved standard error lines. */
  stderr: string[];
  /** Attachment metadata that Langwright will expose through Playwright. */
  attachments: AgentResultAttachment[];
  /** Scenario-derived execution steps, not Playwright's internal step tree. */
  steps: AgentResultStep[];
  /** Playwright annotations copied from `testInfo`. */
  annotations: AgentResultAnnotation[];
  /** Retry index copied from `testInfo`. */
  retry: number;
  /** ISO timestamp for when the executor started running. */
  startTime: string;
  /** Worker index copied from `testInfo`. */
  workerIndex: number;
  /** Parallel index copied from `testInfo`. */
  parallelIndex: number;
  /** Provider-agnostic token, cost, and model metadata. */
  metrics: AgentMetrics;
  /** First error in `errors`, matching Playwright's common result shape. */
  error?: AgentResultError;
  /** Deterministic final payload (status, stdout, summary). */
  final?: AgentFinalResult;
  /** Playwright test title copied from `testInfo`. */
  title: string;
  /** Flattened action (`steps`) instructions across all scenarios. */
  actions: string[];
  /** Flattened expectation instructions across all scenarios. */
  expectations: string[];
  /** Ordered scenario blocks, used to reconstruct per-scenario trajectories. */
  instructions?: ScenarioBlock[];
  /** Structured view of every executed scenario. */
  trajectory: AgentTrajectoryEvent[];
  /** Generated native Playwright code assembled from the executed scenarios. */
  nativePlaywright?: NativePlaywrightArtifact;
  /** Structured diagnosis and repair proposal for non-passing runs. */
  failureAnalysis?: FailureAnalysis;
}

/**
 * Structured trajectory event derived from one executed scenario, for reporting
 * and downstream analysis.
 */
export interface AgentTrajectoryEvent {
  /** Stable ID used by evidence locators, for example `playwright-1`. */
  id: string;
  /** Trajectory event family. */
  type: 'playwright';
  /** Human-readable event description. */
  description: string;
  /** Playwright code executed for the scenario. */
  code: string;
  /** Scenario block IDs this event implements (always single-element here). */
  blockIds?: string[];
  /** Simplified execution observation. */
  observation?: unknown;
  /** Error message when the scenario failed. */
  error?: string;
  /** ISO timestamp for when execution started. */
  startedAt: string;
  /** ISO timestamp for when execution finished. */
  finishedAt?: string;
  /** Execution duration in milliseconds. */
  durationMs?: number;
}

/**
 * Generated native Playwright replacement assembled from executed scenarios.
 */
export interface NativePlaywrightArtifact {
  /**
   * `complete` means every scenario executed green and contributed code.
   * `partial` means the run ended non-passing or a scenario failed.
   * `invalid` means no native Playwright body could be emitted.
   */
  status: 'complete' | 'partial' | 'invalid';
  /** Concatenated native Playwright body, ending with a newline when present. */
  body: string;
  /** Accepted code spans grouped by source scenario metadata. */
  spans: NativePlaywrightSpan[];
  /** Human-readable reasons for partial or invalid output. */
  diagnostics: string[];
}

/**
 * A contiguous generated code span and the scenario block it came from.
 */
export interface NativePlaywrightSpan {
  /** Source scenario block ID. */
  blockId: string;
  /** Whether the span is the scenario's action code or assertion code. */
  kind: AgentInstructionBlockKind | 'mixed';
  /** Playwright code for this span. */
  code: string;
  /** Zero-based index of the source scenario record. */
  sourceBlockIndex?: number;
}

/**
 * Provider-agnostic LLM usage metrics aggregated across Generator and Healer
 * calls.
 */
export interface AgentMetrics {
  /** Prompt/input token count when reported by the provider. */
  prompt_tokens: number | null;
  /** Completion/output token count when reported by the provider. */
  completion_tokens: number | null;
  /** Cached input token count when reported by the provider. */
  cached_tokens: number | null;
  /** Total token count, either provider-reported or prompt plus completion. */
  total_tokens: number | null;
  /** Estimated cost in USD when reported by the provider layer. */
  cost_usd: number | null;
  /**
   * Provider-specific metadata. Langwright commonly writes `model`,
   * `provider`, and `llm_call_count` when those values can be extracted.
   */
  extra: Record<string, unknown>;
}

/**
 * Deterministic final payload summarizing the run.
 */
export interface AgentFinalResult {
  /** Final status. */
  status?: TestStatus;
  /** Errors. Empty or omitted for passing runs. */
  errors?: AgentResultError[];
  /** Per-scenario summary lines. */
  stdout?: string[];
  /** Reserved standard error lines. */
  stderr?: string[];
  /** Optional concise execution summary. */
  summary?: string;
}

/**
 * Reference to a stored execution artifact. Evidence locators point at
 * artifacts instead of embedding screenshots, videos, traces, or large logs.
 */
export interface AttachmentRef {
  /** Storage class for the referenced artifact. */
  storage: 'local' | 'blob';
  /** URI or attachment pseudo-URI, for example `attachment://trace.zip`. */
  uri: string;
  /** Optional content hash when the artifact is addressable outside the report. */
  sha256?: string;
}

/**
 * A source-code range. Multiple ranges are allowed within one locator when the
 * same file has related setup and assertion spans.
 */
export interface SourceRange {
  /** One-based starting line. */
  startLine: number;
  /** One-based inclusive ending line. Defaults to `startLine`. */
  endLine?: number;
  /** Optional one-based starting column. */
  startColumn?: number;
  /** Optional one-based inclusive ending column. */
  endColumn?: number;
}

/**
 * Typed pointer to the concrete artifact region that supports a finding.
 */
export type EvidenceLocator =
  | {
      kind: 'source_range';
      file: string;
      role: 'app' | 'test' | 'fixture' | 'config';
      ranges: SourceRange[];
      symbol?: string;
    }
  | {
      kind: 'dom_node';
      snapshot: AttachmentRef;
      selector?: string;
      role?: string;
      text?: string;
      htmlExcerpt?: string;
    }
  | {
      kind: 'screenshot_region';
      image: AttachmentRef;
      bbox: { x: number; y: number; width: number; height: number };
    }
  | {
      kind: 'video_segment';
      video: AttachmentRef;
      startMs: number;
      endMs: number;
    }
  | {
      kind: 'trace_event';
      trace: AttachmentRef;
      eventId: string;
      timestampMs?: number;
      action?: string;
    }
  | {
      kind: 'log_span';
      log: AttachmentRef;
      startLine?: number;
      endLine?: number;
      pattern?: string;
    }
  | {
      kind: 'network_request';
      trace: AttachmentRef;
      requestId: string;
      url?: string;
      status?: number;
    }
  | {
      kind: 'external_html_fragment';
      url: string;
      selector?: string;
      textFragment?: string;
      htmlExcerpt?: string;
    }
  | {
      kind: 'agent_step';
      trajectory: AttachmentRef;
      stepId: string;
    };

/**
 * One bounded evidence pointer. `detail` is a short explanation, not a raw dump.
 */
export interface FailureEvidence {
  /** Stable ID used by UIs and memory stores to cite this evidence item. */
  id: string;
  /** Who produced this evidence pointer. */
  provenance: 'agent' | 'fallback' | 'langwright';
  /** True when Langwright had to synthesize missing locator fields. */
  synthetic?: boolean;
  /** Artifact-specific locator. */
  locator: EvidenceLocator;
  /** Short human-readable reason this evidence matters. */
  detail: string;
  /** Strength of this evidence for the finding. */
  relevance: 'primary' | 'supporting' | 'context';
}

/**
 * Machine-readable proposed edit. This remains optional because a read-only
 * diagnosis can identify the cause before a patch plan is safe to produce.
 */
export interface ProposedEdit {
  /** Repository-relative or absolute file path. */
  file: string;
  /** Edit operation. */
  kind: 'replace_range' | 'insert' | 'delete';
  /** Source range for the edit. Required for replace/delete, optional for insert. */
  range?: SourceRange;
  /** Replacement or inserted text. */
  newText?: string;
}

/**
 * Repair proposal presented for approval before any patching agent edits files.
 */
export interface SuggestedFix {
  /** Why this fix addresses the finding. */
  rationale: string;
  /** Optional structured edits for preview/application. */
  edits?: ProposedEdit[];
  /** Optional unified diff when a concrete patch is available. */
  unifiedDiff?: string;
  /** Estimated blast radius. */
  risk: 'low' | 'medium' | 'high';
}

/**
 * One diagnosed failure cause.
 */
export interface FailureFinding {
  /** Stable ID used for selection, dedupe, and fix-plan references. */
  id: string;
  /** Who produced this finding. */
  provenance: 'agent' | 'fallback' | 'langwright';
  /** Short display title. */
  title: string;
  /** What kind of failure occurred. */
  category: 'defect' | 'flake' | 'spec_gap';
  /** Likely owner of the repair. */
  owner: 'app' | 'test' | 'agent' | 'infra' | 'unknown';
  /** Numeric confidence in [0, 1]. */
  confidence: number;
  /** Concise code/artifact-level explanation. */
  explanation: string;
  /** Bounded evidence pointers. */
  evidence: FailureEvidence[];
  /** Optional fix proposal for this finding. */
  suggestedFix?: SuggestedFix;
}

/**
 * Read-only failure diagnosis and optional repair plan for a non-passing test.
 */
export interface FailureAnalysis {
  /** Stable run identifier used to correlate artifacts. */
  runId: string;
  /** ISO timestamp for when the analysis was produced. */
  timestamp: string;
  /** Stable-ish hash for deduping recurring failures. */
  fingerprint: string;
  /** Human-readable summary. */
  summary: string;
  /** Bounded list of likely failure causes. */
  findings: FailureFinding[];
  /** Non-fatal normalization or truncation notes. */
  diagnostics?: string[];
  /** Optional plan the user can approve before edits are applied. */
  fixPlan?: {
    findingIds: string[];
    rationale: string;
    suggestedFix: SuggestedFix;
    verification: string[];
  };
  /** Gate policy for any future patching stage. */
  approvalPolicy: 'always' | 'auto_if_test_only' | 'auto_if_known_pattern';
}

/**
 * Playwright-compatible error shape used in result attachments.
 */
export interface AgentResultError {
  /** Human-readable error message. */
  message: string;
  /** Optional stack trace or source diagnostic. */
  stack?: string;
  /** Optional serialized thrown value. */
  value?: string;
}

/**
 * Attachment metadata exposed through `langwright-result.json`.
 */
export interface AgentResultAttachment {
  /** Attachment filename shown in Playwright reports. */
  name: string;
  /** Attachment MIME type. */
  contentType: string;
}

/**
 * Lightweight Playwright Test step representation derived from scenarios.
 */
export interface AgentResultStep {
  /** Human-readable step title. */
  title: string;
  /** Step category, currently `agent`. */
  category: string;
  /** ISO timestamp for when the step started. */
  startTime: string;
  /** Step duration in milliseconds. */
  duration: number;
  /** Step error when the underlying scenario failed. */
  error?: AgentResultError;
}

/**
 * Test annotations copied from Playwright `testInfo`.
 */
export interface AgentResultAnnotation {
  /** Annotation type copied from Playwright. */
  type: string;
  /** Optional annotation description copied from Playwright. */
  description?: string;
}

/**
 * Formatter hook for writing an additional trajectory attachment.
 */
export interface AgentTrajectoryFormatter {
  /** Attachment filename for the formatted trajectory. */
  name: string;
  /** Attachment MIME type for the formatted trajectory. */
  contentType: string;
  /** Serialize a normalized execution result. */
  format(result: AgentExecutionResult): string;
}
