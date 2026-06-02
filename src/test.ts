/**
 * Public entry point for `@hakjuoh/langwright/test`.
 *
 * This module is intentionally a thin barrel: it only re-exports the public
 * surface. All runtime wiring lives under `src/runtime`, `src/reporting`, and
 * `src/fixtures` and is not part of the package API.
 */

/** Langwright's Playwright-compatible test API. */
export { test } from './runtime/test-api.js';

/**
 * `steps` records browser actions and `expect` records assertions, both as
 * natural-language instructions for the agent.
 */
export { steps, expect } from './runtime/dsl.js';

/**
 * Expose ad-hoc objects (for example a page object constructed in the test
 * body) to the agent runtime under their own names. Fixtures defined through
 * `test.extend(...)` are captured automatically and do not need `register`.
 */
export { register } from './fixtures/registry.js';
