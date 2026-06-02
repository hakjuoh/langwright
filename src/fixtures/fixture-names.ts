import type { LangwrightFixtureOptions } from '../shared/types.js';

/**
 * Built-in Playwright Test fixtures exposed to the agent as live page handles.
 *
 * These are the object fixtures the agent operates on directly inside
 * `playwright_run`.
 */
export const CORE_FIXTURE_NAMES = ['page', 'context', 'browser', 'playwright', 'request'] as const;

/**
 * Built-in Playwright option fixtures surfaced to the agent both by name and
 * under `options`.
 *
 * This is the single source of truth for the option values the Langwright
 * runtime fixture depends on; the runtime fixture's destructuring signature is
 * generated from it so the list never has to be maintained twice.
 */
export const OPTION_FIXTURE_NAMES = [
  'browserName',
  'defaultBrowserType',
  'headless',
  'channel',
  'launchOptions',
  'connectOptions',
  'screenshot',
  'trace',
  'video',
  'acceptDownloads',
  'bypassCSP',
  'colorScheme',
  'clientCertificates',
  'deviceScaleFactor',
  'extraHTTPHeaders',
  'geolocation',
  'hasTouch',
  'httpCredentials',
  'ignoreHTTPSErrors',
  'isMobile',
  'javaScriptEnabled',
  'locale',
  'offline',
  'permissions',
  'proxy',
  'storageState',
  'timezoneId',
  'userAgent',
  'viewport',
  'baseURL',
  'contextOptions',
  'actionTimeout',
  'navigationTimeout',
  'serviceWorkers',
  'testIdAttribute',
] as const satisfies readonly (keyof LangwrightFixtureOptions)[];

/**
 * Non-fixture helper bindings that are always present in the `playwright_run`
 * scope (assigned in {@link createPlaywrightRunScope}).
 */
export const SCOPE_HELPER_NAMES = [
  'options',
  'expect',
  'test',
  'testInfo',
  'devices',
  'chromium',
  'firefox',
  'webkit',
  'selectors',
  'errors',
  'apiRequest',
  'fixtures',
] as const;

/**
 * Names a user fixture or `register(...)` entry must not shadow, because they
 * are owned by Playwright's built-in fixtures or Langwright's scope helpers.
 */
export const RESERVED_SCOPE_NAMES: ReadonlySet<string> = new Set<string>([
  ...CORE_FIXTURE_NAMES,
  ...OPTION_FIXTURE_NAMES,
  ...SCOPE_HELPER_NAMES,
]);

/**
 * JavaScript reserved words that cannot be used as a binding identifier. A
 * scope name is turned into a `new Function` parameter (see `runPlaywrightBody`,
 * which runs in strict mode), so any of these would make the whole scope fail to
 * construct and must be rejected/dropped.
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set<string>([
  // ES keywords.
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  // Reserved in strict mode (and `new Function` bodies are strict).
  'let', 'static', 'yield', 'implements', 'interface', 'package', 'private',
  'protected', 'public', 'eval', 'arguments',
  // Reserved in async/module contexts.
  'await',
]);

/** A valid JavaScript identifier, including non-ASCII names (e.g. `café`). */
export const IDENTIFIER_PATTERN = /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u;

/**
 * Whether a name is safe to expose as an agent-scope binding: a valid JS
 * identifier that is not `__proto__`, a reserved scope name, or a reserved word.
 * Only such names can be a `new Function` parameter without shadowing a built-in
 * or failing to construct.
 */
export function isSafeScopeBindingName(name: string): boolean {
  return (
    name !== '__proto__' &&
    IDENTIFIER_PATTERN.test(name) &&
    !RESERVED_SCOPE_NAMES.has(name) &&
    !RESERVED_WORDS.has(name)
  );
}

/**
 * Keep only the entries whose names are safe agent-scope bindings. Used for both
 * the runtime scope and the prompt advertisement so the agent is never told
 * about a name that is not actually injected.
 */
export function filterScopeFixtures(fixtures: Record<string, unknown> | undefined): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};

  if (fixtures) {
    for (const [name, value] of Object.entries(fixtures)) {
      if (isSafeScopeBindingName(name)) {
        filtered[name] = value;
      }
    }
  }

  return filtered;
}
