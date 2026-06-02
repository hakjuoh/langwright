import { appendAgentBlock, getAgentTestContext } from './context.js';
import { renderTemplate } from './template.js';
import { peekFixtureStore } from '../fixtures/fixture-store.js';
import { getPlaywrightTestModule } from '../shared/playwright-module.js';
import type { AgentInstructionBlock, AgentResultError } from '../shared/types.js';

/** Playwright's assertion `expect`, used for the value-form overload. */
const playwrightExpect = getPlaywrightTestModule().expect;

/**
 * Langwright's `expect`: a natural-language expectation recorder when called as
 * a tagged template (`expect\`...\``), and Playwright's real assertion `expect`
 * when called with a value (`expect(locator).toBeVisible()`). Because awaited
 * instructions execute sequentially, a value-form assertion runs against the
 * page state the agent has already produced.
 */
type LangwrightExpect = typeof playwrightExpect & {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<void>;
};

/**
 * Record browser actions as a natural-language instruction and run it as one
 * agent turn against the live page.
 */
export async function steps(strings: TemplateStringsArray, ...values: unknown[]): Promise<void> {
  const block = appendAgentBlock('steps', renderTemplate(strings, values));
  await runBlockTurn(block);
}

function expectImpl(first: unknown, ...rest: unknown[]): unknown {
  if (isTemplateStringsArray(first)) {
    const block = appendAgentBlock('expectation', renderTemplate(first, rest));

    return runBlockTurn(block);
  }

  return (playwrightExpect as unknown as (...args: unknown[]) => unknown)(first, ...rest);
}

/**
 * Build the polymorphic `expect` by carrying every own property of Playwright's
 * `expect` (including non-enumerable statics such as `soft`, `poll`,
 * `configure`, and `extend`) onto the tagged-template-aware implementation.
 */
function buildExpect(): LangwrightExpect {
  const fn = expectImpl as unknown as LangwrightExpect;

  for (const key of Object.getOwnPropertyNames(playwrightExpect)) {
    if (key === 'length' || key === 'name' || key === 'prototype') {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(playwrightExpect, key);

    if (descriptor) {
      Object.defineProperty(fn, key, descriptor);
    }
  }

  return fn;
}

/**
 * Record assertions as natural-language expectations, or delegate to
 * Playwright's assertion library when called with a value. See
 * {@link LangwrightExpect}.
 */
export const expect: LangwrightExpect = buildExpect();

/**
 * Run one instruction block through the active session, refreshing the
 * registered-object scope first so objects registered between awaited DSL calls
 * are reachable. Throws on a failed turn so the test fails at the awaited DSL
 * call (fail-fast, like a native Playwright assertion).
 */
export async function runBlockTurn(block: AgentInstructionBlock): Promise<void> {
  const context = getAgentTestContext();
  const session = context.session;

  if (!session) {
    throw new Error('langwright DSL can only be used inside test(...) from @hakjuoh/langwright/test.');
  }

  context.userFixtures = peekFixtureStore(context.testInfo.testId, context.exposedWorkerNames);

  const turn = await session.runInstruction(block);

  if (turn.status === 'failed') {
    throw toError(turn.error);
  }
}

function toError(error: AgentResultError | undefined): Error {
  const failure = new Error(error?.message ?? 'langwright expectation failed.');

  if (error?.stack) {
    failure.stack = error.stack;
  }

  return failure;
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && 'raw' in value;
}
