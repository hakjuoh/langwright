import { createGenerator } from './generator.js';
import { createHealer } from './healer.js';
import { LangwrightExecutor } from './orchestrator.js';
import type {
  AgentExecutor,
  AgentRoleConfig,
  Generator,
  Healer,
  LangwrightConfig,
} from '../shared/types.js';

/**
 * Resolve the executor that should run a test's scenarios.
 *
 * A fully custom executor takes precedence. Otherwise the default pipeline
 * executor is built from a required Generator and an OPTIONAL Healer derived
 * from the config: each uses the base `model` unless a role overrides it (so
 * they can differ). Healing is skipped entirely when disabled or unavailable.
 */
export function createAgentExecutor(config: LangwrightConfig): AgentExecutor {
  if (config.executor) {
    return config.executor;
  }

  return new LangwrightExecutor(resolveGenerator(config), resolveHealer(config));
}

/**
 * Resolve the optional Healer. Returns `undefined` when healing is disabled
 * (`healer: false`) or no model is available — failures are then reported with a
 * deterministic diagnosis and no LLM heal step.
 */
function resolveHealer(config: LangwrightConfig): Healer | undefined {
  const healer = config.healer;

  if (healer === false) {
    return undefined;
  }

  if (isHealer(healer)) {
    return healer;
  }

  const model = healer?.model ?? config.model;

  if (!model) {
    return undefined;
  }

  return createHealer(model, { systemPrompt: healer?.systemPrompt });
}

function resolveGenerator(config: LangwrightConfig): Generator {
  if (isGenerator(config.generator)) {
    return config.generator;
  }

  const role = config.generator;
  const model = role?.model ?? config.model;

  if (!model) {
    throw missingModelError();
  }

  return createGenerator(model, { systemPrompt: role?.systemPrompt });
}

function isGenerator(value: AgentRoleConfig | Generator | undefined): value is Generator {
  return typeof (value as Generator | undefined)?.generate === 'function';
}

function isHealer(value: AgentRoleConfig | Healer | false | undefined): value is Healer {
  return typeof (value as Healer | undefined)?.heal === 'function';
}

function missingModelError(): Error {
  return new Error(
    'langwright requires a chat model in langwright.config.ts. Pass a LangChain chat model as { model } to defineConfig from @hakjuoh/langwright/config (optionally override per role with { generator } / { healer }).',
  );
}
