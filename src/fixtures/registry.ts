import { getAgentTestContext } from '../runtime/context.js';
import { IDENTIFIER_PATTERN, RESERVED_SCOPE_NAMES, RESERVED_WORDS } from './fixture-names.js';
import { recordFixture } from './fixture-store.js';
import { getPlaywrightTestModule } from '../shared/playwright-module.js';

/** Accepted argument shapes for {@link register}. */
export type RegisterArgs = [registrations: Record<string, unknown>] | [name: string, value: unknown];

/**
 * Parse the overloaded `register(...)` arguments into raw name/value pairs.
 *
 * Split out from {@link normalizeRegistration} so the overload-shape branching
 * (positional vs. object form) is isolated from per-name validation, keeping
 * each piece single-purpose and below the complexity ceiling. Performs no name
 * validation — that is the caller's responsibility.
 */
function parseRegistrationEntries(args: RegisterArgs): Array<[string, unknown]> {
  if (args.length >= 2 && typeof args[0] === 'string') {
    return [[args[0], args[1]]];
  }

  if (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    !Array.isArray(args[0])
  ) {
    return Object.entries(args[0]);
  }

  throw new Error('register(...) expects register({ name: value, ... }) or register("name", value).');
}

/**
 * Throw if a registration name is unusable by the agent runtime.
 *
 * Extracted from {@link normalizeRegistration} so the five guard checks live in
 * one cohesive, single-purpose helper outside the loop. The check order and
 * error messages are preserved exactly to keep behavior identical.
 */
function assertValidRegistrationName(name: string): void {
  if (!name) {
    throw new Error('register(...) names must be non-empty strings.');
  }

  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `register(...) name "${name}" must be a valid JavaScript identifier so the agent can reference it by name.`,
    );
  }

  if (name === '__proto__') {
    throw new Error('register(...) cannot use the name "__proto__".');
  }

  if (RESERVED_WORDS.has(name)) {
    throw new Error(
      `register(...) cannot use the JavaScript reserved word "${name}" as a name; the agent could not reference it.`,
    );
  }

  if (RESERVED_SCOPE_NAMES.has(name)) {
    throw new Error(
      `register(...) cannot use the reserved name "${name}"; it would shadow a built-in Playwright fixture, option, or Langwright scope helper.`,
    );
  }
}

/**
 * Validate and normalize `register(...)` arguments into name/value pairs.
 *
 * Kept pure (no Playwright access) so the parsing and the reserved-name guard
 * can be unit-tested directly.
 */
export function normalizeRegistration(args: RegisterArgs): Array<[string, unknown]> {
  const entries = parseRegistrationEntries(args);

  for (const [name] of entries) {
    assertValidRegistrationName(name);
  }

  return entries;
}

/**
 * Expose ad-hoc objects (for example a page object constructed inside the test
 * body) to the agent runtime under their given names.
 *
 * Use this for values that are not Playwright fixtures; fixtures defined via
 * `test.extend(...)` are captured automatically. Must be called inside a
 * Langwright `test(...)`.
 */
export function register(registrations: Record<string, unknown>): void;
export function register(name: string, value: unknown): void;
export function register(...args: RegisterArgs): void {
  // Surface a clear DSL error when used outside test(...).
  getAgentTestContext();

  const entries = normalizeRegistration(args);
  const testId = getPlaywrightTestModule().test.info().testId;

  for (const [name, value] of entries) {
    recordFixture(testId, name, value, 'test');
  }
}
