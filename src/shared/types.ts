import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestInfo,
  TestStatus,
} from '@playwright/test';

/**
 * Playwright option fixtures that are copied into the Langwright execution
 * scope. These are exposed both as top-level variables and under `options`
 * when the agent runs `playwright_run`.
 */
export type LangwrightFixtureOptions = PlaywrightTestOptions & PlaywrightWorkerOptions;

/**
 * Natural-language instruction categories accepted by the Langwright DSL.
 * `steps` describe browser actions; `expectation` blocks describe assertions
 * that must pass at their exact position in the instruction stream.
 */
export type AgentInstructionBlockKind = 'steps' | 'expectation';

/**
 * A natural-language instruction block recorded from `steps` or `expect`.
 */
export interface AgentInstructionBlock {
  /** Stable block ID used in prompts, traces, and generated code spans. */
  id: string;
  /** Whether the block is an action step or an expectation. */
  kind: AgentInstructionBlockKind;
  /** Rendered natural-language text from the tagged template. */
  text: string;
}

/**
 * Ordered work item collected while a Langwright test body is evaluated.
 */
export type AgentBlock = AgentInstructionBlock;

/**
 * Per-test runtime state shared between the DSL, LangChain tools, executor,
 * and artifact builders.
 */
export interface AgentTestContext {
  /** Complete Playwright fixture bundle exposed to tests and tools. */
  fixtures: LangwrightFixtures;
  /** Active Playwright page convenience reference. */
  page: PlaywrightTestArgs['page'];
  /** Playwright Test metadata for the running test. */
  testInfo: TestInfo;
  /** Ordered DSL blocks collected before the agent executes. */
  blocks: AgentBlock[];
  /** Monotonic counter used to allocate `block-N` identifiers. */
  nextBlockIndex: number;
  /** Raw `playwright_run` tool calls captured during agent execution. */
  trace: AgentTraceEvent[];
  /** Best-effort source location of the user-authored Langwright test. */
  sourceLocation?: AgentSourceLocation;
  /**
   * User-defined fixtures and `register(...)` objects captured for this test,
   * injected into the `playwright_run` scope under their own names. Refreshed
   * (non-draining) before each incremental turn so registrations made between
   * awaited DSL calls reach the agent, and snapshotted when the test finalizes.
   */
  userFixtures?: Record<string, unknown>;
  /**
   * Worker-scoped fixture names this test is allowed to expose, derived from the
   * test body signature. Used to gate which worker captures reach the agent when
   * refreshing {@link userFixtures} for each turn.
   */
  exposedWorkerNames?: ReadonlySet<string>;
  /**
   * The active multi-turn agent session, present during the per-test runtime so
   * each awaited DSL call can run one turn through it. Absent for one-shot paths
   * such as scope hooks that drive the agent through {@link AgentExecutor.run}.
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

/**
 * Normalized result produced by an agent executor.
 *
 * This intentionally mirrors the parts of Playwright TestResult that are useful
 * as attachments, while keeping agent-specific fields such as instructions,
 * trajectory events, model metrics, and generated native Playwright output.
 */
export interface AgentExecutionResult {
  /** Final Playwright-compatible status selected from the agent outcome. */
  status: TestStatus;
  /** Wall-clock execution time for the agent run in milliseconds. */
  duration: number;
  /** Normalized errors reported by the agent or produced while invoking it. */
  errors: AgentResultError[];
  /** Agent-owned standard output lines from the final JSON response. */
  stdout: string[];
  /** Agent-owned standard error lines from the final JSON response. */
  stderr: string[];
  /** Attachment metadata that Langwright will expose through Playwright. */
  attachments: AgentResultAttachment[];
  /** Trace-derived tool execution steps, not Playwright's internal step tree. */
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
  /** Parsed final JSON payload returned by the agent when available. */
  final?: AgentFinalResult;
  /** Playwright test title copied from `testInfo`. */
  title: string;
  /** Flattened `steps` instructions that were sent to the agent. */
  actions: string[];
  /** Flattened `expect` instructions that were sent to the agent. */
  expectations: string[];
  /** Ordered DSL instruction blocks, used to reconstruct per-turn trajectories. */
  instructions?: AgentInstructionBlock[];
  /** Structured view of every observed `playwright_run` call. */
  trajectory: AgentTrajectoryEvent[];
  /** Generated native Playwright code assembled from successful tool calls. */
  nativePlaywright?: NativePlaywrightArtifact;
  /** Structured diagnosis and repair proposal for non-passing runs. */
  failureAnalysis?: FailureAnalysis;
}

/**
 * Outcome of running one instruction block as a single agent turn.
 */
export interface TurnResult {
  /** Whether the agent completed this instruction successfully. */
  status: 'ok' | 'failed';
  /** Failure detail when `status` is `failed`. */
  error?: AgentResultError;
  /** Optional short per-turn note aggregated into the run's stdout. */
  summary?: string;
  /** Optional agent-authored diagnosis attached to a failed turn. */
  failureAnalysis?: FailureAnalysis;
}

/**
 * A persistent multi-turn agent session for one test.
 *
 * Each awaited DSL call runs one instruction through {@link runInstruction}
 * against the live browser (state persists between turns); {@link finalize}
 * synthesizes the single execution result from the accumulated trace, turns,
 * and metrics.
 */
export interface AgentSession {
  /** Execute one instruction block as a turn and report its outcome. */
  runInstruction(block: AgentInstructionBlock): Promise<TurnResult>;
  /** Assemble the aggregate execution result for the whole test. */
  finalize(options?: { status?: TestStatus; error?: AgentResultError }): AgentExecutionResult;
}

/**
 * Pluggable execution backend for Langwright.
 *
 * Custom executors can replace the default LangChain executor while preserving
 * the same result attachment and failure behavior in the Playwright runner.
 */
export interface AgentExecutor {
  /**
   * Start a multi-turn session for the per-test incremental runtime, where each
   * awaited DSL call drives one turn.
   */
  startSession(context: AgentTestContext): AgentSession;
  /**
   * Run all already-collected blocks in one pass and return the result. Used by
   * one-shot paths such as scope hooks.
   */
  run(context: AgentTestContext): Promise<AgentExecutionResult>;
}

/**
 * Minimal contract Langwright delegates a test run to: any object exposing an
 * `invoke(input, options?)` method (a LangChain agent, a custom adapter, etc.).
 */
export interface AgentDelegate {
  invoke(input: unknown, options?: unknown): Promise<unknown> | unknown;
}

/**
 * Runtime configuration loaded from `langwright.config.*`.
 */
export interface LangwrightConfig {
  /** Invokable agent the default executor delegates each test run to. */
  agent?: AgentDelegate;
  /** Human-readable agent name written to trajectory artifacts. */
  agentName?: string;
  /** Human-readable agent version written to trajectory artifacts. */
  agentVersion?: string;
  /** Custom executor. When present, this takes precedence over `agent`. */
  executor?: AgentExecutor;
  /** Stable run identifier used for trajectory grouping. */
  sessionId?: string;
  /** Custom formatter for the trajectory attachment. */
  trajectoryFormatter?: AgentTrajectoryFormatter;
}

/**
 * Raw tool-call event captured whenever the agent invokes `playwright_run`.
 */
export interface AgentTraceEvent {
  /** Tool name, currently `playwright_run`. */
  tool: string;
  /** Raw tool input supplied by the agent. */
  input: unknown;
  /** Tool output observation, when execution completed. */
  output?: unknown;
  /** Error message when the tool failed. */
  error?: string;
  /** ISO timestamp for when the tool call started. */
  startedAt: string;
  /** ISO timestamp for when the tool call finished. */
  finishedAt?: string;
  /** Tool-call duration in milliseconds. */
  durationMs?: number;
}

/**
 * Structured trajectory event derived from a raw trace event for reporting and
 * downstream analysis.
 */
export interface AgentTrajectoryEvent {
  /** Stable ID used by evidence locators, for example `playwright-1`. */
  id: string;
  /** Trajectory event family. */
  type: 'playwright';
  /** Human-readable event description. */
  description: string;
  /** Playwright code body executed by the tool call. */
  code: string;
  /** Agent-declared purpose for the tool call. */
  purpose?: PlaywrightRunPurpose;
  /** Instruction block IDs this call implements. */
  blockIds?: string[];
  /** Whether this call should be considered for native-code generation. */
  contributesToNativeCode?: boolean;
  /** Simplified tool observation. */
  observation?: unknown;
  /** Error message when the tool call failed. */
  error?: string;
  /** ISO timestamp for when the tool call started. */
  startedAt: string;
  /** ISO timestamp for when the tool call finished. */
  finishedAt?: string;
  /** Tool-call duration in milliseconds. */
  durationMs?: number;
}

/**
 * Agent-supplied reason for a `playwright_run` call.
 *
 * `probe` calls are exploratory and should not be copied into generated native
 * Playwright. `final` is the preferred marker for a clean replacement body.
 */
export type PlaywrightRunPurpose = 'probe' | 'action' | 'assertion' | 'final';

/**
 * Input schema accepted by the LangChain `playwright_run` tool.
 */
export interface PlaywrightRunInput {
  /** Playwright Test code to run inside the current test async function. */
  body: string;
  /** Why the agent is running this body. */
  purpose?: PlaywrightRunPurpose;
  /** Ordered Langwright instruction block IDs implemented by this code. */
  blockIds?: string[];
  /** Explicit include/exclude switch for native Playwright generation. */
  contributesToNativeCode?: boolean;
}

/**
 * Generated native Playwright replacement assembled from successful tool calls.
 */
export interface NativePlaywrightArtifact {
  /**
   * `complete` means all selected code was accepted from a passing source run.
   * `partial` means some selected code or source status was incomplete.
   * `invalid` means no safe native Playwright body could be emitted.
   */
  status: 'complete' | 'partial' | 'invalid';
  /** Concatenated native Playwright body, ending with a newline when present. */
  body: string;
  /** Accepted code spans grouped by source instruction metadata. */
  spans: NativePlaywrightSpan[];
  /** Human-readable reasons for partial or invalid output. */
  diagnostics: string[];
}

/**
 * A contiguous generated code span and the instruction block it came from.
 */
export interface NativePlaywrightSpan {
  /** Source instruction block ID, `mixed`, or `all-instructions`. */
  blockId: string;
  /** Source instruction kind when it can be narrowed to one block. */
  kind: AgentInstructionBlockKind | 'mixed';
  /** Sanitized Playwright code for this span. */
  code: string;
  /** Zero-based index of the source trace event. */
  sourceTraceIndex?: number;
}

/**
 * Provider-agnostic LLM usage metrics extracted from LangChain responses.
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
 * Final JSON payload the agent is expected to return after executing a test.
 */
export interface AgentFinalResult {
  /** Agent-declared final status. */
  status?: TestStatus;
  /** Agent-declared errors. Empty or omitted for passing runs. */
  errors?: AgentResultError[];
  /** Agent-declared standard output lines. */
  stdout?: string[];
  /** Agent-declared standard error lines. */
  stderr?: string[];
  /** Optional concise execution summary. */
  summary?: string;
  /** Optional agent-authored diagnosis for non-passing runs. */
  failureAnalysis?: FailureAnalysis;
  /** Raw non-JSON or fallback-parsed response text. */
  raw?: string;
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
 * Lightweight Playwright Test step representation derived from tool traces.
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
  /** Step error when the underlying trace failed. */
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
