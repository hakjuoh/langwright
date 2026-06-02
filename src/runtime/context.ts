import { normalizeInstructionText } from './template.js';
import type { AgentTestContext, ScenarioBlock } from '../shared/types.js';

/**
 * The active Langwright test context.
 *
 * AsyncLocalStorage is intentionally avoided: Playwright schedules a test body
 * outside the async-continuation chain of the fixture `use()` that sets it up,
 * so an ALS store established around `use()` does not reach the body. Playwright
 * runs at most one test at a time per worker process, so a module-level variable
 * scoped by `withAgentTestContext` covers the whole test (body, hooks, and the
 * scenario runs) without depending on async-context propagation.
 */
let currentContext: AgentTestContext | undefined;

/**
 * Run a callback with the given context active.
 *
 * The context stays active for the full duration of `callback` — including the
 * test body Playwright runs while a wrapping fixture's `use()` is pending — and
 * is restored afterward, so nested scopes (for example a scope hook) are safe.
 */
export async function withAgentTestContext<T>(
  context: AgentTestContext,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = currentContext;
  currentContext = context;

  try {
    return await callback();
  } finally {
    currentContext = previous;
  }
}

/**
 * Return the active test context or fail with an actionable DSL usage error.
 */
export function getAgentTestContext(): AgentTestContext {
  if (!currentContext) {
    throw new Error('langwright DSL can only be used inside test(...) from @hakjuoh/langwright/test.');
  }

  return currentContext;
}

/**
 * Append a scenario block to the current test and return it so the caller can
 * run it through the session. Both halves are indentation-normalized; an empty
 * expectation collapses to `undefined` (an action-only scenario).
 */
export function appendScenarioBlock(steps: string, expect?: string): ScenarioBlock {
  const context = getAgentTestContext();
  const normalizedExpect = expect === undefined ? undefined : normalizeInstructionText(expect);
  const block: ScenarioBlock = {
    id: nextBlockId(context),
    steps: normalizeInstructionText(steps),
    expect: normalizedExpect && normalizedExpect.length > 0 ? normalizedExpect : undefined,
  };
  context.blocks.push(block);

  return block;
}

function nextBlockId(context: AgentTestContext): string {
  context.nextBlockIndex += 1;

  return `block-${context.nextBlockIndex}`;
}
