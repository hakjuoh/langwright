import type { LangwrightConfig } from './shared/types.js';
import { DEFAULT_AGENT_NAME, LANGWRIGHT_VERSION } from './config/defaults.js';

export { createGenerator } from './agent/generator.js';
export { createHealer } from './agent/healer.js';

/**
 * Helper for authoring `langwright.config.*` with TypeScript support.
 *
 * Langwright fills stable agent metadata unless the config explicitly overrides
 * it, keeping trajectory artifacts identifiable without requiring boilerplate
 * in every project config.
 */
export function defineConfig(config: LangwrightConfig): LangwrightConfig {
  return {
    ...config,
    agentName: config.agentName ?? DEFAULT_AGENT_NAME,
    agentVersion: config.agentVersion ?? LANGWRIGHT_VERSION,
  };
}
