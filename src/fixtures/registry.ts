import { getAgentTestContext } from '../runtime/context.js';
import { IDENTIFIER_PATTERN, RESERVED_SCOPE_NAMES, RESERVED_WORDS } from './fixture-names.js';
import { recordFixture } from './fixture-store.js';
import { getPlaywrightTestModule } from '../shared/playwright-module.js';

/** Accepted argument shapes for {@link register}. */
export type RegisterArgs = [registrations: Record<string, unknown>] | [name: string, value: unknown];

/**
 * Validate and normalize `register(...)` arguments into name/value pairs.
 *
 * Kept pure (no Playwright access) so the parsing and the reserved-name guard
 * can be unit-tested directly.
 */
export function normalizeRegistration(args: RegisterArgs): Array<[string, unknown]> {
  let entries: Array<[string, unknown]>;

  if (args.length >= 2 && typeof args[0] === 'string') {
    entries = [[args[0], args[1]]];
  } else if (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    !Array.isArray(args[0])
  ) {
    entries = Object.entries(args[0]);
  } else {
    throw new Error('register(...) expects register({ name: value, ... }) or register("name", value).');
  }

  for (const [name] of entries) {
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
