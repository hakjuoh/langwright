import { randomUUID } from 'node:crypto';
import type {
  AgentExecutionResult,
  AgentTrajectoryEvent,
  AgentTrajectoryFormatter,
  ScenarioBlock,
} from '../shared/types.js';
import { DEFAULT_AGENT_NAME, LANGWRIGHT_PACKAGE_NAME, LANGWRIGHT_VERSION } from '../config/defaults.js';

const ATIF_SCHEMA_VERSION = 'ATIF-v1.7';
const DEFAULT_AGENT_VERSION = LANGWRIGHT_VERSION;
// Used when formatting ATIF outside the normal Playwright runner path, where
// `test.ts` would otherwise provide a project-level run session ID. The
// LANGWRIGHT_SESSION_ID env var can make this fallback deterministic across
// processes; otherwise it is created once and shared by all formatters here.
const FALLBACK_SESSION_ID = process.env.LANGWRIGHT_SESSION_ID ?? `langwright-run-${randomUUID()}`;

/**
 * Metadata used when formatting a Langwright run as an ATIF trajectory.
 */
export interface AtifFormatterOptions {
  /** Agent name written into the trajectory metadata. */
  agentName?: string;
  /** Agent version written into the trajectory metadata. */
  agentVersion?: string;
  /** Session ID used to group trajectories from the same run. */
  sessionId?: string;
}

/**
 * Top-level Agent Trajectory Interchange Format document emitted by Langwright.
 */
export interface AtifTrajectory {
  /** ATIF schema version emitted by this formatter. */
  schema_version: string;
  /** Run-level grouping identifier. */
  session_id?: string;
  /** Stable identifier for this test trajectory. */
  trajectory_id?: string;
  /** Agent identity and tool schema metadata. */
  agent: AtifAgent;
  /** Formatter notes about what is and is not captured. */
  notes?: string;
  /** Aggregate metrics for the trajectory. */
  final_metrics: AtifFinalMetrics;
  /** Langwright-specific metadata. */
  extra: Record<string, unknown>;
  /** Ordered user and agent turns. */
  steps: AtifStep[];
}

/**
 * One user, system, or agent turn in the exported trajectory.
 */
export interface AtifStep {
  /** One-based step index. */
  step_id: number;
  /** ISO timestamp for the step. */
  timestamp: string;
  /** Actor that produced this step. */
  source: 'system' | 'user' | 'agent';
  /** Model name when the step was produced by an LLM. */
  model_name?: string;
  /** Human-readable step content. */
  message: string;
  /** Tool calls issued during this step. */
  tool_calls?: AtifToolCall[];
  /** Tool observations returned during this step. */
  observation?: AtifObservation;
  /** Token and cost metrics for this step. */
  metrics?: AtifMetrics;
  /** Additional formatter-specific metadata. */
  extra?: Record<string, unknown>;
  /** Number of LLM calls represented by this step. */
  llm_call_count?: number;
  /** Whether the step is copied context rather than newly produced content. */
  is_copied_context?: boolean;
}

/**
 * Tool invocation captured inside an ATIF agent step.
 */
export interface AtifToolCall {
  /** Stable ID for linking observations back to this call. */
  tool_call_id: string;
  /** Function tool name. */
  function_name: string;
  /** JSON-like tool arguments. */
  arguments: Record<string, unknown>;
  /** Additional call metadata such as timing. */
  extra?: Record<string, unknown>;
}

/**
 * Tool observations attached to an ATIF agent step.
 */
export interface AtifObservation {
  /** Observation records returned by tool calls. */
  results: AtifObservationResult[];
}

export interface AtifObservationResult {
  /** Tool call ID that produced this observation. */
  source_call_id?: string;
  /** Short human-readable observation summary. */
  content?: string;
  /** Raw observation payload and extra metadata. */
  extra?: Record<string, unknown>;
}

/**
 * Normalized error value for ATIF metadata.
 */
export interface AtifError {
  /** Human-readable error message. */
  message: string;
  /** Optional stack trace or source diagnostic. */
  stack?: string;
  /** Optional serialized thrown value. */
  value?: string;
}

/**
 * Agent identity and tool schema metadata for the trajectory.
 */
export interface AtifAgent {
  /** Agent display name. */
  name: string;
  /** Agent display version. */
  version: string;
  /** Underlying model name when known. */
  model_name?: string;
  /** Tool definitions available to the agent. */
  tool_definitions?: AtifToolDefinition[];
  /** Additional agent metadata. */
  extra?: Record<string, unknown>;
}

/**
 * Function-tool definition recorded in the trajectory.
 */
export interface AtifToolDefinition {
  /** ATIF tool definition type. */
  type: 'function';
  /** Function schema details. */
  function: {
    /** Function name. */
    name: string;
    /** Human-readable function description. */
    description: string;
    /** JSON Schema-like parameter definition. */
    parameters: Record<string, unknown>;
  };
}

/**
 * Aggregate token and cost metrics for the entire trajectory.
 */
export interface AtifFinalMetrics {
  /** Total prompt tokens across extracted model calls. */
  total_prompt_tokens?: number;
  /** Total completion tokens across extracted model calls. */
  total_completion_tokens?: number;
  /** Total cached tokens across extracted model calls. */
  total_cached_tokens?: number;
  /** Total estimated cost in USD when provided by the model layer. */
  total_cost_usd?: number;
  /** Number of ATIF steps in the trajectory. */
  total_steps: number;
  /** Additional aggregate metrics such as total tokens and provider metadata. */
  extra: Record<string, unknown>;
}

/**
 * Token and cost metrics for an individual ATIF step.
 */
export interface AtifMetrics {
  /** Prompt tokens for this step. */
  prompt_tokens?: number;
  /** Completion tokens for this step. */
  completion_tokens?: number;
  /** Cached tokens for this step. */
  cached_tokens?: number;
  /** Estimated cost in USD for this step. */
  cost_usd?: number;
  /** Additional step metrics. */
  extra: Record<string, unknown>;
}

/**
 * Create the default trajectory formatter used for Playwright attachments.
 */
export function createAtifTrajectoryFormatter(options: AtifFormatterOptions = {}): AgentTrajectoryFormatter {
  return {
    name: 'langwright-trajectory.json',
    contentType: 'application/json',
    format(result) {
      return JSON.stringify(toAtifTrajectory(result, options), null, 2);
    },
  };
}

/**
 * Convert a normalized Langwright execution result into ATIF.
 */
export function toAtifTrajectory(
  result: AgentExecutionResult,
  options: AtifFormatterOptions = {},
): AtifTrajectory {
  const sessionId = stableSessionId(options.sessionId);
  const trajectoryId = stableTrajectoryId(result, sessionId);
  const agentName = options.agentName ?? DEFAULT_AGENT_NAME;
  const agentVersion = options.agentVersion ?? DEFAULT_AGENT_VERSION;
  const modelName = typeof result.metrics.extra.model === 'string' ? result.metrics.extra.model : undefined;
  const steps = buildTurnSteps(result, modelName);

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: sessionId,
    trajectory_id: trajectoryId,
    agent: {
      name: agentName,
      version: agentVersion,
      model_name: modelName,
      tool_definitions: [playwrightExecuteToolDefinition()],
      extra: {
        provider: result.metrics.extra.provider,
        runner: LANGWRIGHT_PACKAGE_NAME,
        runner_version: LANGWRIGHT_VERSION,
      },
    },
    notes: 'Generated by Langwright: each scenario is converted to Playwright code by the Generator and executed directly. Hidden model reasoning is intentionally not recorded.',
    final_metrics: {
      total_prompt_tokens: numberOrUndefined(result.metrics.prompt_tokens),
      total_completion_tokens: numberOrUndefined(result.metrics.completion_tokens),
      total_cached_tokens: numberOrUndefined(result.metrics.cached_tokens),
      total_cost_usd: numberOrUndefined(result.metrics.cost_usd),
      total_steps: steps.length,
      extra: {
        total_tokens: result.metrics.total_tokens,
        ...result.metrics.extra,
      },
    },
    extra: {
      test_title: result.title,
      status: result.status,
      errors: result.errors.map(toAtifError),
    },
    steps,
  };
}

interface TurnEvent {
  event: AgentTrajectoryEvent;
  eventIndex: number;
}

/**
 * Build one user + agent step pair per instruction block, reconstructing each
 * turn from the trajectory events that cite the block's ID. Each event is
 * attributed to the earliest (source-order) block among its `blockIds`; events
 * with no known block are collected into a trailing "uncategorized" agent step.
 * Per-step metrics are intentionally omitted because usage is only tracked in
 * aggregate; see {@link AtifTrajectory.final_metrics}.
 */
function buildTurnSteps(result: AgentExecutionResult, modelName: string | undefined): AtifStep[] {
  const blocks = result.instructions ?? [];
  const trajectory = result.trajectory;
  const blockIndexById = new Map(blocks.map((block, index) => [block.id, index]));
  const owners = trajectory.map((event) => {
    const indexes = (event.blockIds ?? [])
      .map((id) => blockIndexById.get(id))
      .filter((index): index is number => index !== undefined);

    return indexes.length > 0 ? Math.min(...indexes) : -1;
  });
  const eventsFor = (blockIndex: number): TurnEvent[] =>
    trajectory.flatMap((event, eventIndex) => (owners[eventIndex] === blockIndex ? [{ event, eventIndex }] : []));

  const steps: AtifStep[] = [];
  let stepId = 1;

  for (const [blockIndex, block] of blocks.entries()) {
    steps.push(buildUserStep(stepId++, block, result.startTime));
    steps.push(buildAgentStep(stepId++, block, eventsFor(blockIndex), modelName, result.startTime));
  }

  const leftover = eventsFor(-1);

  if (leftover.length > 0 || blocks.length === 0) {
    steps.push(buildAgentStep(stepId++, undefined, leftover, modelName, result.startTime));
  }

  return steps;
}

function buildUserStep(stepId: number, block: ScenarioBlock, fallbackTimestamp: string): AtifStep {
  const message = [`Scenario ${block.id}:`, `Steps: ${block.steps}`, block.expect ? `Expectation: ${block.expect}` : undefined]
    .filter(Boolean)
    .join('\n');

  return {
    step_id: stepId,
    timestamp: fallbackTimestamp,
    source: 'user',
    message,
    extra: {
      block_id: block.id,
      has_expectation: Boolean(block.expect),
    },
  };
}

function buildAgentStep(
  stepId: number,
  block: ScenarioBlock | undefined,
  events: TurnEvent[],
  modelName: string | undefined,
  fallbackTimestamp: string,
): AtifStep {
  return {
    step_id: stepId,
    timestamp: events[0]?.event.startedAt ?? fallbackTimestamp,
    source: 'agent',
    model_name: modelName,
    message: agentStepMessage(block, events.length),
    tool_calls: events.map(({ event, eventIndex }) => ({
      tool_call_id: toolCallId(eventIndex),
      function_name: 'playwright_execute',
      arguments: {
        code: event.code,
        blockIds: event.blockIds,
      },
      extra: {
        description: event.description,
        started_at: event.startedAt,
        finished_at: event.finishedAt,
        duration_ms: event.durationMs,
      },
    })),
    observation: {
      results: events.map(({ event, eventIndex }) => ({
        source_call_id: toolCallId(eventIndex),
        content: summarizeObservation(event.observation),
        extra: {
          raw: event.observation,
          error: event.error,
        },
      })),
    },
    extra: {
      block_id: block?.id,
    },
  };
}

function agentStepMessage(block: ScenarioBlock | undefined, callCount: number): string {
  if (!block) {
    return callCount > 0
      ? `Executed ${callCount} unattributed Playwright call(s).`
      : 'No Playwright calls were recorded.';
  }

  return `Executed ${callCount} Playwright call(s) for ${block.id}.`;
}

function summarizeObservation(observation: unknown): string | undefined {
  if (observation === undefined) {
    return undefined;
  }

  if (typeof observation === 'string') {
    return observation;
  }

  if (isRecord(observation)) {
    const url = typeof observation.url === 'string' ? observation.url : undefined;
    const title = typeof observation.title === 'string' ? observation.title : undefined;

    if (url || title) {
      return [url ? `url=${url}` : undefined, title ? `title=${title}` : undefined].filter(Boolean).join(' ');
    }
  }

  return 'Structured observation is stored in extra.raw.';
}

function toAtifError(error: { message: string; stack?: string; value?: string }): AtifError {
  return {
    message: error.message,
    stack: error.stack,
    value: error.value,
  };
}

function numberOrUndefined(value: number | null): number | undefined {
  return value ?? undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toolCallId(index: number): string {
  return `call-playwright-execute-${index + 1}`;
}

function playwrightExecuteToolDefinition(): AtifToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'playwright_execute',
      description: 'Execute the Playwright Test code generated for a scenario against the current test page.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Generated Playwright Test code executed for the scenario.',
          },
          blockIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Scenario block IDs implemented by this code.',
          },
        },
        required: ['code'],
      },
    },
  };
}

function stableSessionId(configuredSessionId: string | undefined): string {
  return configuredSessionId ?? FALLBACK_SESSION_ID;
}

function stableTrajectoryId(result: AgentExecutionResult, sessionId: string): string {
  // Stable when executor-provided `startTime` is valid; Date.now() is only a
  // defensive fallback for hand-built results passed directly to the formatter.
  return `${sessionId}-${slugify(result.title)}-${Date.parse(result.startTime) || Date.now()}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
