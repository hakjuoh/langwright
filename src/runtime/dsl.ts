import { appendScenarioBlock, getAgentTestContext } from './context.js';
import { peekFixtureStore } from '../fixtures/fixture-store.js';
import type { AgentResultError, ScenarioBlock } from '../shared/types.js';

/**
 * Langwright's single DSL primitive: a scenario.
 *
 * `steps` are the natural-language browser actions; the optional `expect` is the
 * natural-language expectation. Both are converted together into one Playwright
 * code block (actions, then `expect(...)` assertions) by the Generator, executed
 * directly by Playwright, and — on failure — diagnosed by the Healer. The call
 * throws on failure so the test fails at the awaited `scenario(...)`, exactly
 * like a native Playwright assertion.
 *
 * @example
 * await scenario(
 *   `Go to https://playwright.dev/ and click Get started.`,
 *   `The Installation heading should be visible.`,
 * );
 */
export async function scenario(steps: string, expect?: string): Promise<void> {
  const block = appendScenarioBlock(steps, expect);
  await runScenarioBlock(block);
}

/**
 * Run one scenario block through the active session, refreshing the
 * registered-object scope first so objects registered between awaited DSL calls
 * are reachable. Throws on a failed scenario (fail-fast).
 */
export async function runScenarioBlock(block: ScenarioBlock): Promise<void> {
  const context = getAgentTestContext();
  const session = context.session;

  if (!session) {
    throw new Error('langwright DSL can only be used inside test(...) from @hakjuoh/langwright/test.');
  }

  context.userFixtures = peekFixtureStore(context.testInfo.testId, context.exposedWorkerNames);

  const outcome = await session.runScenario(block);

  if (outcome.status === 'failed') {
    throw toError(outcome.error);
  }
}

function toError(error: AgentResultError | undefined): Error {
  const failure = new Error(error?.message ?? 'langwright scenario failed.');

  if (error?.stack) {
    failure.stack = error.stack;
  }

  return failure;
}
