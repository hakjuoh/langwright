import { readFileSync } from 'node:fs';
import type { TestStatus } from '@playwright/test';
import { buildFailureAnalysis } from '../reporting/failure-analysis.js';
import { filterScopeFixtures } from '../fixtures/fixture-names.js';
import { buildNativePlaywrightArtifact } from '../reporting/native-playwright.js';
import type {
  LangwrightConfig,
  AgentExecutor,
  AgentExecutionResult,
  AgentFinalResult,
  AgentInstructionBlock,
  AgentMetrics,
  AgentResultError,
  AgentResultStep,
  AgentSession,
  AgentTestContext,
  AgentTraceEvent,
  AgentTrajectoryEvent,
  AttachmentRef,
  FailureAnalysis,
  FailureEvidence,
  FailureFinding,
  AgentDelegate,
  TurnResult,
} from '../shared/types.js';

const resultAttachmentRef: AttachmentRef = {
  storage: 'local',
  uri: 'attachment://langwright-result.json',
};

const trajectoryAttachmentRef: AttachmentRef = {
  storage: 'local',
  uri: 'attachment://langwright-trajectory.json',
};

/**
 * Resolve the executor that should run the collected Langwright instructions.
 *
 * A fully custom executor takes precedence over the default LangChain executor.
 */
export function createAgentExecutor(config: LangwrightConfig): AgentExecutor {
  if (config.executor) {
    return config.executor;
  }

  if (config.agent) {
    return new LangChainAgentExecutor(config.agent);
  }

  throw new Error(
    'langwright requires an agent in langwright.config.ts. Create one with createAgent(...) from @hakjuoh/langwright/config and pass it as { agent }.',
  );
}

/**
 * Default executor that drives a LangChain-compatible agent through a multi-turn
 * session — one turn per awaited DSL instruction — and normalizes the
 * accumulated trace and metrics into attachments.
 */
export class LangChainAgentExecutor implements AgentExecutor {
  constructor(private readonly agent: AgentDelegate) {}

  /**
   * Start a multi-turn session for the per-test incremental runtime.
   */
  startSession(context: AgentTestContext): AgentSession {
    return new LangChainAgentSession(this.agent, context);
  }

  /**
   * Run every already-collected block in one pass. Used by one-shot paths such
   * as scope hooks, which pre-seed a single instruction block.
   */
  async run(context: AgentTestContext): Promise<AgentExecutionResult> {
    const session = this.startSession(context);

    for (const block of context.blocks) {
      const turn = await session.runInstruction(block);

      if (turn.status === 'failed') {
        break;
      }
    }

    return session.finalize();
  }
}

/**
 * One test's persistent agent conversation. Each `runInstruction` appends the
 * instruction to the running message history, invokes the agent against the
 * live page (state persists between turns), accumulates provider metrics, and
 * reports a per-turn outcome. `finalize` synthesizes the aggregate result from
 * the accumulated trace, turns, and metrics.
 */
class LangChainAgentSession implements AgentSession {
  private readonly startedAt = new Date();
  private readonly startedMs = Date.now();
  private readonly messages: unknown[] = [];
  private readonly samples: MetricSample[] = [];
  private readonly seenMetricKeys = new Set<string>();
  private readonly perTurn: TurnResult[] = [];
  private turnCount = 0;

  constructor(
    private readonly agent: AgentDelegate,
    private readonly context: AgentTestContext,
  ) {}

  async runInstruction(block: AgentInstructionBlock): Promise<TurnResult> {
    const prompt = buildTurnPrompt(this.context, block, this.turnCount === 0);
    this.turnCount += 1;
    this.messages.push({ role: 'user', content: prompt });

    let response: unknown;

    try {
      response = await this.agent.invoke({ messages: this.messages });
    } catch (error) {
      const turn: TurnResult = { status: 'failed', error: toAgentResultError(error) };
      this.perTurn.push(turn);

      return turn;
    }

    collectMetricSamples(response, this.samples, this.seenMetricKeys);
    this.updateHistory(response);

    const turn = parseTurnResult(stringifyAgentResponse(response));
    this.perTurn.push(turn);

    return turn;
  }

  finalize(options?: { status?: TestStatus; error?: AgentResultError }): AgentExecutionResult {
    const failedTurnErrors = this.perTurn
      .filter((turn) => turn.status === 'failed')
      .flatMap((turn) => (turn.error ? [turn.error] : []));
    const status: TestStatus =
      failedTurnErrors.length > 0 || options?.error !== undefined || options?.status === 'failed'
        ? 'failed'
        : (options?.status ?? 'passed');
    // With fail-fast there is at most one failure source: a failed turn's error
    // is the original that the body rethrows, so prefer it over the duplicate
    // body error the runtime passes in; fall back to the body error otherwise.
    const errors = failedTurnErrors.length > 0 ? failedTurnErrors : options?.error ? [options.error] : [];
    const stdout = this.perTurn
      .map((turn) => turn.summary)
      .filter((summary): summary is string => typeof summary === 'string' && summary.length > 0);
    const agentFailureAnalysis = [...this.perTurn].reverse().find((turn) => turn.failureAnalysis)?.failureAnalysis;
    const final: AgentFinalResult = {
      status,
      errors: errors.length > 0 ? errors : undefined,
      stdout: stdout.length > 0 ? stdout : undefined,
      summary: stdout.length > 0 ? stdout.join('\n') : undefined,
      failureAnalysis: agentFailureAnalysis,
    };

    return buildExecutionResult(this.context, {
      status,
      startedAt: this.startedAt,
      duration: Date.now() - this.startedMs,
      final,
      errors,
      stdout,
      metrics: finalizeMetrics(this.samples),
    });
  }

  /**
   * Carry the conversation forward. LangChain agents return the full updated
   * message list, so adopt it verbatim; fall back to appending the textual
   * reply for delegates that return a bare string or object.
   */
  private updateHistory(response: unknown): void {
    if (isRecord(response) && Array.isArray(response.messages) && response.messages.length > 0) {
      this.messages.length = 0;
      this.messages.push(...response.messages);

      return;
    }

    this.messages.push({ role: 'assistant', content: stringifyAgentResponse(response) });
  }
}

/**
 * Merge runner-owned metadata, agent-owned final status, trace-derived steps,
 * and generated native Playwright output into one attachment-friendly result.
 */
function buildExecutionResult(
  context: AgentTestContext,
  options: {
    status: TestStatus;
    startedAt: Date;
    duration: number;
    final?: AgentFinalResult;
    errors?: AgentResultError[];
    stdout?: string[];
    stderr?: string[];
    metrics?: AgentMetrics;
  },
): AgentExecutionResult {
  const errors = options.errors ?? [];
  const nativePlaywright = buildNativePlaywrightArtifact(context, context.trace, options.status);
  const failureAnalysis =
    options.status === 'passed'
      ? undefined
      : buildFailureAnalysis(context, {
          startedAt: options.startedAt,
          errors,
          final: options.final,
          nativePlaywright,
        });

  return {
    status: options.status,
    duration: options.duration,
    errors,
    error: errors.at(0),
    stdout: options.stdout ?? [],
    stderr: options.stderr ?? [],
    attachments: [
      {
        name: 'langwright-result.json',
        contentType: 'application/json',
      },
      {
        name: 'langwright-trajectory.json',
        contentType: 'application/json',
      },
      {
        name: 'langwright-native-playwright.ts',
        contentType: 'text/plain',
      },
      {
        name: 'langwright-native-playwright.json',
        contentType: 'application/json',
      },
      ...(failureAnalysis
        ? [
            {
              name: 'langwright-failure-analysis.json',
              contentType: 'application/json',
            },
          ]
        : []),
    ],
    steps: buildResultSteps(context.trace),
    annotations: context.testInfo.annotations.map((annotation) => ({
      type: annotation.type,
      description: annotation.description,
    })),
    retry: context.testInfo.retry,
    startTime: options.startedAt.toISOString(),
    workerIndex: context.testInfo.workerIndex,
    parallelIndex: context.testInfo.parallelIndex,
    metrics: options.metrics ?? emptyMetrics(),
    final: options.final,
    title: context.testInfo.title,
    actions: getInstructions(context, 'steps'),
    expectations: getInstructions(context, 'expectation'),
    instructions: [...context.blocks],
    trajectory: buildTrajectory(context.trace),
    nativePlaywright,
    failureAnalysis,
  };
}

/**
 * Create the null-filled metrics object used when no provider usage data exists.
 */
function emptyMetrics(): AgentMetrics {
  return {
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    total_tokens: null,
    cost_usd: null,
    extra: {},
  };
}

/**
 * Reduce the token, model, provider, and cost usage samples gathered across one
 * or more agent invocations into a single aggregate metrics object.
 */
function finalizeMetrics(samples: MetricSample[]): AgentMetrics {
  const metrics = emptyMetrics();

  for (const sample of samples) {
    const promptTokens = readNumber(sample.usage, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens']);
    const completionTokens = readNumber(sample.usage, [
      'completion_tokens',
      'completionTokens',
      'output_tokens',
      'outputTokens',
    ]);
    const totalTokens = readNumber(sample.usage, ['total_tokens', 'totalTokens']);
    const cachedTokens =
      readNumber(sample.usage, ['cached_tokens', 'cachedTokens', 'cache_read', 'cacheRead']) ??
      readNumber(sample.usage, ['input_token_details.cache_read', 'inputTokenDetails.cacheRead']);
    const costUsd = readNumber(sample.usage, ['cost_usd', 'costUsd']);
    const modelName = readString(sample.metadata, ['model_name', 'modelName', 'model']);
    const modelProvider = readString(sample.metadata, ['model_provider', 'modelProvider', 'provider']);

    metrics.prompt_tokens = sumNullable(metrics.prompt_tokens, promptTokens);
    metrics.completion_tokens = sumNullable(metrics.completion_tokens, completionTokens);
    metrics.total_tokens = sumNullable(metrics.total_tokens, totalTokens);
    metrics.cached_tokens = sumNullable(metrics.cached_tokens, cachedTokens);
    metrics.cost_usd = sumNullable(metrics.cost_usd, costUsd);

    if (modelName) {
      metrics.extra.model = modelName;
    }

    if (modelProvider) {
      metrics.extra.provider = modelProvider;
    }
  }

  metrics.extra.llm_call_count = samples.length;

  if (metrics.total_tokens === null) {
    metrics.total_tokens = sumNullable(metrics.prompt_tokens, metrics.completion_tokens);
  }

  return metrics;
}

interface MetricSample {
  usage: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * Walk nested LangChain message containers and collect unique usage records.
 */
function collectMetricSamples(value: unknown, samples: MetricSample[], seenMetricKeys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMetricSamples(item, samples, seenMetricKeys);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const responseMetadata = firstRecord(value.response_metadata, value.responseMetadata);
  const usage =
    firstRecord(value.usage_metadata, value.usageMetadata) ??
    (responseMetadata ? firstRecord(responseMetadata.tokenUsage, responseMetadata.token_usage) : undefined);
  const metadata = responseMetadata ?? {};

  if (usage) {
    const key = metricIdentity(value, metadata);

    if (!key || !seenMetricKeys.has(key)) {
      samples.push({ usage, metadata });

      if (key) {
        seenMetricKeys.add(key);
      }
    }
  }

  if (Array.isArray(value.messages)) {
    collectMetricSamples(value.messages, samples, seenMetricKeys);
  }

  if (isRecord(value.kwargs)) {
    collectMetricSamples(value.kwargs, samples, seenMetricKeys);
  }
}

/**
 * Best-effort identity used to avoid double-counting the same model response
 * when LangChain repeats it in both top-level and nested message structures.
 */
function metricIdentity(message: Record<string, unknown>, metadata: Record<string, unknown>): string | undefined {
  const id = readString(message, ['id']) ?? readString(message, ['kwargs.id']) ?? readString(metadata, ['id']);

  if (id) {
    return `id:${id}`;
  }

  const model = readString(metadata, ['model_name', 'modelName', 'model']) ?? 'unknown-model';
  const promptTokens = readNumber(message, ['usage_metadata.input_tokens', 'usageMetadata.inputTokens']);
  const completionTokens = readNumber(message, ['usage_metadata.output_tokens', 'usageMetadata.outputTokens']);
  const totalTokens = readNumber(message, ['usage_metadata.total_tokens', 'usageMetadata.totalTokens']);

  if (promptTokens !== null || completionTokens !== null || totalTokens !== null) {
    return `usage:${model}:${promptTokens ?? ''}:${completionTokens ?? ''}:${totalTokens ?? ''}`;
  }

  return undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord);
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = readPath(record, key);

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readPath(record, key);

    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!isRecord(current)) {
      return undefined;
    }

    return current[part];
  }, record);
}

function sumNullable(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }

  return (current ?? 0) + next;
}

/**
 * Build the per-turn prompt for one instruction block.
 *
 * The first turn carries the orientation (test title, instruction metadata,
 * registered objects, and source context); later turns send only the new
 * instruction because the accumulated message history retains the rest. The
 * registered-objects list is re-advertised whenever any exist so objects
 * registered between awaited DSL calls are reachable by name.
 */
function buildTurnPrompt(context: AgentTestContext, block: AgentInstructionBlock, isFirstTurn: boolean): string {
  const lines: string[] = [];

  if (isFirstTurn) {
    lines.push(
      'You are executing an end-to-end browser test through Playwright tools.',
      'Instructions arrive one at a time. Perform each instruction now against the current browser page using playwright_run; state from earlier instructions persists, so do not redo completed work.',
      'For an expectation instruction, run the assertion and report success only once it passes.',
      'After each instruction, reply with compact per-turn JSON that satisfies the response schema in the system prompt. Do not finalize the whole test; more instructions may follow.',
      '',
      `Test: ${context.testInfo.title}`,
      '',
      'Instruction metadata:',
      '- Each instruction has a stable block ID such as `block-1`; pass relevant IDs as `blockIds` in playwright_run calls.',
      '- Trajectory evidence can cite Playwright tool calls with `agent_step` step IDs such as `playwright-1`, `playwright-2`, in execution order.',
      '- Mark exploratory tool calls with `purpose: "probe"` or `contributesToNativeCode: false` so they are excluded from native Playwright code generation.',
      ...formatRegisteredObjects(context),
      '',
      'Test source context for failure diagnosis:',
      ...formatTestSourceContext(context),
    );
  } else {
    const registered = formatRegisteredObjects(context);

    if (registered.length > 0) {
      lines.push(...registered);
    }
  }

  const kindLabel = block.kind === 'expectation' ? 'Expectation' : 'Step';

  lines.push(
    '',
    `${kindLabel} ${block.id}:`,
    ...splitInstructions(block.text).map((instruction) => `- ${instruction}`),
    '',
    // A reporting-oriented directive rather than an imperative "perform these
    // instructions now": the latter, next to instruction-shaped page content
    // (e.g. a scraped table-of-contents expectation), matches Azure OpenAI's
    // indirect-prompt-injection (jailbreak) shield and gets the prompt filtered.
    'When you have carried out the instruction above on the current page, reply with the per-turn status JSON.',
  );

  return lines.join('\n');
}

/**
 * Advertise the user fixtures and `register(...)` objects captured for this
 * test so the agent knows it can reference them by name inside `playwright_run`,
 * alongside a light description of each value's shape.
 */
function formatRegisteredObjects(context: AgentTestContext): string[] {
  // Advertise exactly what createPlaywrightRunScope injects, so the agent is
  // never told about a name that was filtered out of the runtime scope.
  const entries = Object.entries(filterScopeFixtures(context.userFixtures));

  if (entries.length === 0) {
    return [];
  }

  return [
    '',
    'Registered objects available by name inside playwright_run (in addition to the built-in fixtures listed in the system prompt):',
    ...entries.map(([name, value]) => `- ${describeScopeValue(name, value)}`),
  ];
}

/**
 * Build a one-line description of a registered value: a primitive summary, the
 * keys of a plain object, or the constructor name and methods of a class
 * instance.
 *
 * Always returns a single safe line: introspection is wrapped so an exotic value
 * (a Proxy with throwing traps, a throwing `constructor` getter) cannot fail
 * prompt assembly, and every interpolated token is sanitized so attacker-shaped
 * member names cannot corrupt the prompt's line structure.
 */
function describeScopeValue(name: string, value: unknown): string {
  try {
    return describeScopeValueUnsafe(name, value);
  } catch {
    return name;
  }
}

function describeScopeValueUnsafe(name: string, value: unknown): string {
  if (value === null || value === undefined) {
    return `${name}: ${String(value)}`;
  }

  const valueType = typeof value;

  if (valueType !== 'object' && valueType !== 'function') {
    let serialized: string;

    try {
      serialized = JSON.stringify(value) ?? String(value);
    } catch {
      serialized = String(value);
    }

    return `${name}: ${valueType} = ${sanitizeToken(serialized)}`;
  }

  const constructorName =
    isRecord(value) && typeof value.constructor === 'function' ? value.constructor.name : undefined;
  const methods = collectMethodNames(value);
  const label =
    constructorName && constructorName !== 'Object' ? `${name} (${sanitizeToken(constructorName)})` : name;

  if (methods.length > 0) {
    const shown = methods.slice(0, 12).map(sanitizeToken).join(', ');

    return `${label} — methods: ${shown}${methods.length > 12 ? ', …' : ''}`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);

    if (keys.length > 0) {
      const shown = keys.slice(0, 12).map(sanitizeToken).join(', ');

      return `${label} — keys: ${shown}${keys.length > 12 ? ', …' : ''}`;
    }
  }

  return label;
}

/**
 * Collapse whitespace (including newlines) and truncate a single token so an
 * interpolated member name cannot break the prompt's one-line list structure.
 */
function sanitizeToken(token: string, maxLength = 40): string {
  return truncateSummary(token.replace(/\s+/g, ' ').trim(), maxLength);
}

/**
 * Collect the callable member names of a value (own enumerable methods plus one
 * level of prototype methods), guarding against getters that throw.
 */
function collectMethodNames(value: object): string[] {
  const names = new Set<string>();
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (safeIsFunction(record, key)) {
      names.add(key);
    }
  }

  const prototype = Object.getPrototypeOf(value) as object | null;

  if (prototype && prototype !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key !== 'constructor' && safeIsFunction(record, key)) {
        names.add(key);
      }
    }
  }

  return [...names];
}

function safeIsFunction(record: Record<string, unknown>, key: string): boolean {
  try {
    return typeof record[key] === 'function';
  } catch {
    return false;
  }
}

function truncateSummary(value: string, maxLength = 80): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatTestSourceContext(context: AgentTestContext): string[] {
  const file = context.sourceLocation?.file ?? context.testInfo.file;
  const line = context.sourceLocation?.line ?? context.testInfo.line;

  if (!file || !line) {
    return ['- unavailable'];
  }

  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const startLine = Math.max(1, line - 40);
    const endLine = Math.min(lines.length, line + 80);
    const sourceLines = lines
      .slice(startLine - 1, endLine)
      .map((sourceLine, index) => `${startLine + index}: ${sourceLine}`);

    return [
      `File: ${file}`,
      `Registered test line: ${line}`,
      '```ts',
      ...sourceLines,
      '```',
    ];
  } catch (error) {
    return [`- unavailable: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/**
 * Convert raw tool traces into Playwright-style step entries.
 */
function buildResultSteps(trace: AgentTraceEvent[]): AgentResultStep[] {
  return trace.map((event, index) => ({
    title: `agent playwright execution ${index + 1}`,
    category: 'agent',
    startTime: event.startedAt,
    duration: event.durationMs ?? 0,
    error: event.error ? { message: event.error } : undefined,
  }));
}

/**
 * Convert raw tool traces into the structured trajectory used by ATIF and
 * langwright-result attachments.
 */
function buildTrajectory(trace: AgentTraceEvent[]): AgentTrajectoryEvent[] {
  return trace.map((event, index) => ({
    id: `playwright-${index + 1}`,
    type: 'playwright',
    description: `Playwright execution ${index + 1}`,
    code: extractPlaywrightBody(event.input),
    ...extractPlaywrightRunMetadata(event.input),
    observation: simplifyObservation(event.output),
    error: event.error,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    durationMs: event.durationMs,
  }));
}

/**
 * Preserve native-code metadata from a `playwright_run` call when present.
 */
function extractPlaywrightRunMetadata(input: unknown): Pick<
  AgentTrajectoryEvent,
  'purpose' | 'blockIds' | 'contributesToNativeCode'
> {
  if (!isRecord(input)) {
    return {};
  }

  return {
    purpose:
      input.purpose === 'probe' ||
      input.purpose === 'action' ||
      input.purpose === 'assertion' ||
      input.purpose === 'final'
        ? input.purpose
        : undefined,
    blockIds: Array.isArray(input.blockIds)
      ? input.blockIds.filter((blockId): blockId is string => typeof blockId === 'string')
      : undefined,
    contributesToNativeCode:
      typeof input.contributesToNativeCode === 'boolean' ? input.contributesToNativeCode : undefined,
  };
}

function extractPlaywrightBody(input: unknown): string {
  if (isRecord(input) && typeof input.body === 'string') {
    return input.body;
  }

  if (isRecord(input) && typeof input.code === 'string') {
    return input.code;
  }

  return '';
}

function simplifyObservation(output: unknown): unknown {
  if (!isRecord(output)) {
    return output;
  }

  return Object.fromEntries(
    Object.entries(output).filter(([key, value]) => key !== 'ok' && value !== undefined),
  );
}

/**
 * Parse one per-turn agent reply into a {@link TurnResult}.
 *
 * The preferred contract is compact JSON (`{ status: 'ok' | 'failed', ... }`),
 * but the lenient text fallback preserves a useful outcome when the reply is not
 * valid JSON. A failed turn may carry an agent-authored `failureAnalysis`.
 */
function parseTurnResult(responseText: string): TurnResult {
  try {
    const parsed: unknown = JSON.parse(responseText);

    if (isRecord(parsed)) {
      const summary = typeof parsed.summary === 'string' ? parsed.summary : undefined;

      if (parsed.status === 'ok' || parsed.status === 'passed') {
        return { status: 'ok', summary };
      }

      const errors = normalizeErrors(parsed.errors);
      const error =
        errors?.[0] ??
        (isRecord(parsed.error)
          ? {
              message:
                typeof parsed.error.message === 'string' ? parsed.error.message : JSON.stringify(parsed.error),
            }
          : typeof parsed.error === 'string'
            ? { message: parsed.error }
            : { message: `Agent reported turn status: ${String(parsed.status)}` });

      return {
        status: 'failed',
        error,
        summary,
        failureAnalysis: normalizeFailureAnalysis(parsed.failureAnalysis),
      };
    }
  } catch {
    // Fall through to a lenient text check when the reply is not valid JSON.
  }

  if (/"status"\s*:\s*"(ok|passed)"/i.test(responseText)) {
    return { status: 'ok' };
  }

  return {
    status: 'failed',
    error: { message: `Agent did not report a passing turn:\n${responseText}` },
  };
}

function normalizeErrors(errors: unknown): AgentResultError[] | undefined {
  if (!Array.isArray(errors)) {
    return undefined;
  }

  return errors.map((error) => {
    if (isRecord(error)) {
      return {
        message: typeof error.message === 'string' ? error.message : JSON.stringify(error),
        stack: typeof error.stack === 'string' ? error.stack : undefined,
        value: typeof error.value === 'string' ? error.value : undefined,
      };
    }

    return { message: String(error) };
  });
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((item) => (typeof item === 'string' ? item : String(item)));
}

function normalizeFailureAnalysis(value: unknown): FailureAnalysis | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const runId = typeof value.runId === 'string' ? value.runId : undefined;
  const timestamp = typeof value.timestamp === 'string' ? value.timestamp : undefined;
  const fingerprint = typeof value.fingerprint === 'string' ? value.fingerprint : undefined;
  const summary = typeof value.summary === 'string' ? value.summary : undefined;
  const findings = normalizeFailureFindings(value.findings);
  const approvalPolicy = normalizeApprovalPolicy(value.approvalPolicy);

  if (!runId || !timestamp || !fingerprint || !summary || findings.length === 0 || !approvalPolicy) {
    return undefined;
  }

  return {
    runId,
    timestamp,
    fingerprint,
    summary,
    findings,
    diagnostics: normalizeStringArray(value.diagnostics),
    fixPlan: normalizeFixPlan(value.fixPlan),
    approvalPolicy,
  };
}

function normalizeFailureFindings(value: unknown): FailureFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): FailureFinding[] => {
    if (!isRecord(item)) {
      return [];
    }

    const id = typeof item.id === 'string' ? item.id : undefined;
    const title = typeof item.title === 'string' ? item.title : undefined;
    const category = normalizeFindingCategory(item.category);
    const owner = normalizeFindingOwner(item.owner);
    const confidence = typeof item.confidence === 'number' ? item.confidence : undefined;
    const explanation = typeof item.explanation === 'string' ? item.explanation : undefined;
    const evidence = normalizeFailureEvidence(item.evidence);
    const provenance = normalizeProvenance(item.provenance) ?? 'agent';

    if (!id || !title || !category || !owner || confidence === undefined || !explanation || evidence.length === 0) {
      return [];
    }

    return [
      {
        id,
        provenance,
        title,
        category,
        owner,
        confidence,
        explanation,
        evidence,
        suggestedFix: normalizeSuggestedFix(item.suggestedFix),
      },
    ];
  });
}

function normalizeFailureEvidence(value: unknown): FailureEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): FailureEvidence[] => {
    if (!isRecord(item)) {
      return [];
    }

    const id = typeof item.id === 'string' ? item.id : undefined;
    const detail = typeof item.detail === 'string' ? item.detail : undefined;
    const relevance = normalizeEvidenceRelevance(item.relevance);

    const locatorResult = normalizeEvidenceLocator(item.locator);

    if (!id || !locatorResult || !detail || !relevance) {
      return [];
    }

    return [
      {
        id,
        provenance: normalizeProvenance(item.provenance) ?? 'agent',
        synthetic: typeof item.synthetic === 'boolean' ? item.synthetic : locatorResult.synthetic,
        locator: locatorResult.locator,
        detail,
        relevance,
      },
    ];
  });
}

function normalizeEvidenceLocator(
  value: unknown,
): { locator: FailureEvidence['locator']; synthetic?: boolean } | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return undefined;
  }

  switch (value.kind) {
    case 'source_range': {
      const ranges = normalizeSourceRanges(value.ranges);
      const legacyLine = typeof value.line === 'number' ? value.line : undefined;
      const file = typeof value.file === 'string' ? value.file : undefined;

      if (!file) {
        return undefined;
      }

      const normalizedRanges = ranges.length > 0 ? ranges : legacyLine ? [{ startLine: legacyLine, endLine: legacyLine }] : [];

      if (normalizedRanges.length === 0) {
        return undefined;
      }

      return {
        locator: {
          kind: 'source_range',
          file,
          role: normalizeSourceRole(value.role) ?? 'test',
          ranges: normalizedRanges,
          symbol: typeof value.symbol === 'string' ? value.symbol : undefined,
        },
      };
    }
    case 'dom_node': {
      const selector = typeof value.selector === 'string' ? value.selector : undefined;
      const role = typeof value.role === 'string' ? value.role : undefined;
      const text = typeof value.text === 'string' ? value.text : undefined;
      const htmlExcerpt = typeof value.htmlExcerpt === 'string' ? value.htmlExcerpt : undefined;

      if (!selector && !role && !text && !htmlExcerpt) {
        return undefined;
      }

      return {
        locator: {
          kind: 'dom_node',
          snapshot: normalizeAttachmentRef(value.snapshot) ?? resultAttachmentRef,
          selector,
          role,
          text,
          htmlExcerpt,
        },
        synthetic: !normalizeAttachmentRef(value.snapshot),
      };
    }
    case 'screenshot_region':
      if (!isRecord(value.bbox)) {
        return undefined;
      }

      return {
        locator: {
          kind: 'screenshot_region',
          image: normalizeAttachmentRef(value.image) ?? resultAttachmentRef,
          bbox: {
            x: readFiniteNumber(value.bbox.x) ?? 0,
            y: readFiniteNumber(value.bbox.y) ?? 0,
            width: readFiniteNumber(value.bbox.width) ?? readFiniteNumber(value.bbox.w) ?? 0,
            height: readFiniteNumber(value.bbox.height) ?? readFiniteNumber(value.bbox.h) ?? 0,
          },
        },
        synthetic: !normalizeAttachmentRef(value.image),
      };
    case 'video_segment':
      return {
        locator: {
          kind: 'video_segment',
          video: normalizeAttachmentRef(value.video) ?? resultAttachmentRef,
          startMs: readFiniteNumber(value.startMs) ?? 0,
          endMs: readFiniteNumber(value.endMs) ?? 0,
        },
        synthetic: !normalizeAttachmentRef(value.video),
      };
    case 'trace_event':
      if (typeof value.eventId !== 'string') {
        return undefined;
      }

      return {
        locator: {
          kind: 'trace_event',
          trace: normalizeAttachmentRef(value.trace) ?? trajectoryAttachmentRef,
          eventId: value.eventId,
          timestampMs: readFiniteNumber(value.timestampMs) ?? undefined,
          action: typeof value.action === 'string' ? value.action : undefined,
        },
        synthetic: !normalizeAttachmentRef(value.trace),
      };
    case 'log_span':
      return {
        locator: {
          kind: 'log_span',
          log: normalizeAttachmentRef(value.log) ?? resultAttachmentRef,
          startLine: readFiniteNumber(value.startLine) ?? undefined,
          endLine: readFiniteNumber(value.endLine) ?? undefined,
          pattern: typeof value.pattern === 'string' ? value.pattern : undefined,
        },
        synthetic: !normalizeAttachmentRef(value.log),
      };
    case 'network_request':
      if (typeof value.requestId !== 'string') {
        return undefined;
      }

      return {
        locator: {
          kind: 'network_request',
          trace: normalizeAttachmentRef(value.trace) ?? trajectoryAttachmentRef,
          requestId: value.requestId,
          url: typeof value.url === 'string' ? value.url : undefined,
          status: readFiniteNumber(value.status) ?? undefined,
        },
        synthetic: !normalizeAttachmentRef(value.trace),
      };
    case 'external_html_fragment':
      if (typeof value.url !== 'string') {
        return undefined;
      }

      return {
        locator: {
          kind: 'external_html_fragment',
          url: value.url,
          selector: typeof value.selector === 'string' ? value.selector : undefined,
          textFragment: typeof value.textFragment === 'string' ? value.textFragment : undefined,
          htmlExcerpt: typeof value.htmlExcerpt === 'string' ? value.htmlExcerpt : undefined,
        },
      };
    case 'agent_step':
      if (typeof value.stepId !== 'string') {
        return undefined;
      }

      return {
        locator: {
          kind: 'agent_step',
          trajectory: normalizeAttachmentRef(value.trajectory) ?? trajectoryAttachmentRef,
          stepId: value.stepId,
        },
        synthetic: !normalizeAttachmentRef(value.trajectory),
      };
    default:
      return undefined;
  }
}

function normalizeSourceRanges(value: unknown): Array<{ startLine: number; endLine?: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): Array<{ startLine: number; endLine?: number }> => {
    if (!isRecord(item)) {
      return [];
    }

    const startLine = readFiniteNumber(item.startLine);

    if (!startLine) {
      return [];
    }

    return [
      {
        startLine,
        endLine: readFiniteNumber(item.endLine) ?? startLine,
      },
    ];
  });
}

function normalizeAttachmentRef(value: unknown): AttachmentRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const storage = value.storage === 'local' || value.storage === 'blob' ? value.storage : undefined;
  const uri = typeof value.uri === 'string' ? value.uri : undefined;

  if (!storage || !uri) {
    return undefined;
  }

  return {
    storage,
    uri,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : undefined,
  };
}

function normalizeSourceRole(value: unknown): 'app' | 'test' | 'fixture' | 'config' | undefined {
  return value === 'app' || value === 'test' || value === 'fixture' || value === 'config'
    ? value
    : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeFixPlan(value: unknown): FailureAnalysis['fixPlan'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const findingIds = Array.isArray(value.findingIds)
    ? value.findingIds.filter((item): item is string => typeof item === 'string')
    : [];
  const rationale = typeof value.rationale === 'string' ? value.rationale : undefined;
  const suggestedFix = normalizeSuggestedFix(value.suggestedFix);
  const verification = Array.isArray(value.verification)
    ? value.verification.filter((item): item is string => typeof item === 'string')
    : [];

  if (findingIds.length === 0 || !rationale || !suggestedFix || verification.length === 0) {
    return undefined;
  }

  return {
    findingIds,
    rationale,
    suggestedFix,
    verification,
  };
}

function normalizeSuggestedFix(value: unknown): FailureFinding['suggestedFix'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rationale = typeof value.rationale === 'string' ? value.rationale : undefined;
  const risk = value.risk === 'low' || value.risk === 'medium' || value.risk === 'high' ? value.risk : undefined;
  const unifiedDiff = typeof value.unifiedDiff === 'string' ? value.unifiedDiff : undefined;

  if (!rationale || !risk) {
    return undefined;
  }

  return {
    rationale,
    unifiedDiff,
    risk,
  };
}

function normalizeFindingCategory(value: unknown): FailureFinding['category'] | undefined {
  return value === 'defect' || value === 'flake' || value === 'spec_gap' ? value : undefined;
}

function normalizeFindingOwner(value: unknown): FailureFinding['owner'] | undefined {
  return value === 'app' ||
    value === 'test' ||
    value === 'agent' ||
    value === 'infra' ||
    value === 'unknown'
    ? value
    : undefined;
}

function normalizeEvidenceRelevance(value: unknown): FailureEvidence['relevance'] | undefined {
  return value === 'primary' || value === 'supporting' || value === 'context' ? value : undefined;
}

function normalizeProvenance(value: unknown): FailureEvidence['provenance'] | undefined {
  return value === 'agent' || value === 'fallback' || value === 'langwright' ? value : undefined;
}

function normalizeApprovalPolicy(value: unknown): FailureAnalysis['approvalPolicy'] | undefined {
  return value === 'always' || value === 'auto_if_test_only' || value === 'auto_if_known_pattern'
    ? value
    : undefined;
}

function toAgentResultError(error: unknown): AgentResultError {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function getInstructions(context: AgentTestContext, kind: 'steps' | 'expectation'): string[] {
  return context.blocks
    .filter((block): block is Extract<AgentTestContext['blocks'][number], { kind: typeof kind }> => block.kind === kind)
    .flatMap((block) => splitInstructions(block.text));
}

function splitInstructions(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+\.\s*/, ''));
}

function stringifyAgentResponse(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (isRecord(response)) {
    const messages = response.messages;

    if (Array.isArray(messages) && messages.length > 0) {
      const lastMessage = messages.at(-1);

      if (isRecord(lastMessage) && typeof lastMessage.content === 'string') {
        return lastMessage.content;
      }
    }
  }

  return JSON.stringify(response, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
