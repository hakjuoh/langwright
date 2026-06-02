import type { LangwrightFixtures } from '../shared/types.js';

/** Natural-language instruction body recorded by a Langwright hook. */
export type AgentHookInstruction = string;

/** A normalized hook: a required instruction with an optional title. */
export interface AgentHook {
  title?: string;
  instruction: AgentHookInstruction;
}

/**
 * The worker-scoped Playwright fixtures a `beforeAll`/`afterAll` scope hook
 * needs to spin up its own short-lived browser context.
 */
export type ScopeHookWorkerFixtures = Pick<LangwrightFixtures, 'browser' | 'browserName' | 'playwright'>;
