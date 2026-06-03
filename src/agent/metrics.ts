import type { AgentMetrics, MetricSample } from '../shared/types.js';

/**
 * Provider-agnostic LLM usage metrics, shared by the Generator and Healer.
 *
 * Both stages use LangChain `withStructuredOutput({ includeRaw: true })`, whose
 * `raw` field is the `AIMessage` carrying `usage_metadata`. {@link extractMetricSamples}
 * walks that raw response; {@link finalizeMetrics} sums samples from every call
 * (Generator + Healer) into one aggregate.
 */

/**
 * Create the null-filled metrics object used when no provider usage data exists.
 */
export function emptyMetrics(): AgentMetrics {
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
 * Collect the usage samples from one raw structured-output response (the `raw`
 * of `{ parsed, raw }`). A fresh dedupe set is used per call.
 */
export function extractMetricSamples(raw: unknown): MetricSample[] {
  const samples: MetricSample[] = [];
  collectMetricSamples(raw, samples, new Set<string>());

  return samples;
}

/**
 * Reduce token, model, provider, and cost usage samples gathered across one or
 * more LLM calls into a single aggregate metrics object.
 */
export function finalizeMetrics(samples: MetricSample[]): AgentMetrics {
  const metrics = emptyMetrics();

  for (const sample of samples) {
    accumulateSample(metrics, sample);
  }

  metrics.extra.llm_call_count = samples.length;

  if (metrics.total_tokens === null) {
    metrics.total_tokens = sumNullable(metrics.prompt_tokens, metrics.completion_tokens);
  }

  return metrics;
}

/**
 * Fold one sample's token, cost, model, and provider usage into the running
 * aggregate. Extracted from {@link finalizeMetrics} so the per-sample field
 * mapping lives in one single-purpose place and keeps the reducer's statement
 * count within the structural limits.
 */
function accumulateSample(metrics: AgentMetrics, sample: MetricSample): void {
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

/**
 * Walk nested LangChain message containers and collect unique usage records.
 */
export function collectMetricSamples(value: unknown, samples: MetricSample[], seenMetricKeys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMetricSamples(item, samples, seenMetricKeys);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  recordUsageSample(value, samples, seenMetricKeys);

  if (Array.isArray(value.messages)) {
    collectMetricSamples(value.messages, samples, seenMetricKeys);
  }

  if (isRecord(value.kwargs)) {
    collectMetricSamples(value.kwargs, samples, seenMetricKeys);
  }
}

/**
 * Pull the usage record off a single message container and, if it has not been
 * seen before, push a sample. Split out of {@link collectMetricSamples} so the
 * recursive walk stays simple while the dedupe/usage-resolution logic — the
 * source of most of the branching — lives on its own and stays under the
 * cyclomatic-complexity limit.
 */
function recordUsageSample(
  value: Record<string, unknown>,
  samples: MetricSample[],
  seenMetricKeys: Set<string>,
): void {
  const responseMetadata = firstRecord(value.response_metadata, value.responseMetadata);
  const usage =
    firstRecord(value.usage_metadata, value.usageMetadata) ??
    (responseMetadata ? firstRecord(responseMetadata.tokenUsage, responseMetadata.token_usage) : undefined);
  const metadata = responseMetadata ?? {};

  if (!usage) {
    return;
  }

  const key = metricIdentity(value, metadata);

  if (!key || !seenMetricKeys.has(key)) {
    samples.push({ usage, metadata });

    if (key) {
      seenMetricKeys.add(key);
    }
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

  return usageIdentity(message, metadata);
}

/**
 * Build the fallback dedupe key from a message's token counts when it carries no
 * stable id. Extracted from {@link metricIdentity} because the multi-key reads
 * plus the "any token present" test push the combined function past the
 * cyclomatic-complexity limit; isolating the token branch keeps both halves
 * single-purpose and compliant.
 */
function usageIdentity(message: Record<string, unknown>, metadata: Record<string, unknown>): string | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
