import { filterScopeFixtures } from '../fixtures/fixture-names.js';
import type { AgentTestContext } from '../shared/types.js';

/**
 * Inputs needed to build the lexical scope for an agent-authored snippet.
 */
export interface PlaywrightRunScopeOptions {
  context: AgentTestContext;
  expect: unknown;
  test: unknown;
  apiRequest: unknown;
}

/**
 * Create the object whose keys become local variables in `playwright_run`.
 *
 * User fixtures and `register(...)` objects are spread in under their own names
 * so the agent (and any generated native Playwright code) can reference them
 * directly. Names that would shadow a built-in fixture, option, or scope helper
 * are dropped so the core handles the agent relies on always win.
 */
export function createPlaywrightRunScope({
  context,
  expect,
  test,
  apiRequest,
}: PlaywrightRunScopeOptions): Record<string, unknown> {
  const { fixtures } = context;

  return {
    ...fixtures,
    ...filterScopeFixtures(context.userFixtures),
    expect,
    test,
    testInfo: context.testInfo,
    devices: fixtures.playwright.devices,
    chromium: fixtures.playwright.chromium,
    firefox: fixtures.playwright.firefox,
    webkit: fixtures.playwright.webkit,
    selectors: fixtures.playwright.selectors,
    errors: fixtures.playwright.errors,
    apiRequest,
    fixtures,
  };
}
