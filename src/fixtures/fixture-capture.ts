import { IDENTIFIER_PATTERN, RESERVED_SCOPE_NAMES } from './fixture-names.js';
import type { FixtureScope } from './fixture-store.js';

/** Callback that records a captured fixture value, resolving the test id itself. */
export type RecordFixtureFn = (name: string, value: unknown, scope: FixtureScope) => void;

/**
 * Parse the destructured first-argument fixture names from a fixture function,
 * mirroring how Playwright resolves dependencies (it parses `fn.toString()`), so
 * a capturing wrapper can re-declare the identical dependency set.
 *
 * Returns the names for a `{ ... }` first argument (`[]` when empty), or null
 * when the signature is not a plain object-destructuring of identifiers (rest,
 * defaults, a non-destructured argument, or no argument); the fixture is then
 * left unwrapped rather than risk altering its dependency resolution.
 */
export function parseFixtureParameterNames(fn: Function): string[] | null {
  const parsed = firstParameterFixtureNames(fn);

  return parsed.kind === 'names' ? parsed.names : null;
}

/**
 * Parse the fixture names a TEST BODY declares (its destructured first argument),
 * used to gate which worker-scoped fixtures are exposed to that test.
 *
 * Returns `[]` when the body declares no fixtures (e.g. `async () => {}` or
 * `async ({}) => {}`), the names when it destructures them, or null when the
 * signature is indeterminate (non-destructured argument, rest, defaults) so the
 * caller can fall back safely.
 */
export function parseTestBodyFixtureNames(fn: Function): string[] | null {
  const parsed = firstParameterFixtureNames(fn);

  if (parsed.kind === 'none') {
    return [];
  }

  return parsed.kind === 'names' ? parsed.names : null;
}

type FirstParameterFixtureNames =
  | { kind: 'none' }
  | { kind: 'names'; names: string[] }
  | { kind: 'indeterminate' };

/**
 * Recover a function's first-parameter fixture names the way Playwright does:
 * take the text up to the first `)`, split it into top-level parameters with
 * {@link splitByComma}, and require the first parameter to be a `{ ... }`
 * destructuring of plain identifiers (taking the source key before any `:`).
 *
 * `none` = no parameters; `names` = a parseable destructure; `indeterminate` =
 * a non-destructured/rest/default/garbled signature the caller should not trust.
 */
function firstParameterFixtureNames(fn: Function): FirstParameterFixtureNames {
  const afterParen = afterFirstParen(fn);

  if (afterParen === null) {
    return { kind: 'indeterminate' };
  }

  const closeParen = afterParen.indexOf(')');
  const params = (closeParen === -1 ? afterParen : afterParen.slice(0, closeParen)).trim();

  if (!params) {
    return { kind: 'none' };
  }

  const firstParam = splitByComma(params)[0];

  if (firstParam === undefined) {
    return { kind: 'none' };
  }

  if (firstParam[0] !== '{' || firstParam[firstParam.length - 1] !== '}') {
    return { kind: 'indeterminate' };
  }

  const inner = firstParam.slice(1, -1).trim();

  if (!inner) {
    return { kind: 'names', names: [] };
  }

  const names: string[] = [];

  for (const segment of splitByComma(inner)) {
    // The source key is the text before the first colon (alias/nested rename),
    // matching Playwright's own name extraction.
    const colon = segment.indexOf(':');
    const name = (colon === -1 ? segment : segment.slice(0, colon)).trim();

    if (!IDENTIFIER_PATTERN.test(name)) {
      return { kind: 'indeterminate' };
    }

    names.push(name);
  }

  return { kind: 'names', names };
}

/**
 * Return the comment-stripped source text immediately after a function's first
 * `(`, or null. Comments are removed up front (mirroring Playwright's
 * `filterOutComments`) so a comment inside the parameter list cannot corrupt
 * parsing.
 */
function afterFirstParen(fn: Function): string | null {
  const source = stripComments(fn.toString());
  const parenIndex = source.indexOf('(');

  if (parenIndex === -1) {
    return null;
  }

  return source.slice(parenIndex + 1).trimStart();
}

/**
 * Split a destructuring body on top-level commas, mirroring Playwright's own
 * `splitByComma`: only `{}` and `[]` are treated as nesting (parentheses are
 * not), and empty tokens (from a trailing comma) are dropped.
 */
function splitByComma(text: string): string[] {
  const segments: string[] = [];
  const stack: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
    } else if (char === stack[stack.length - 1]) {
      stack.pop();
    } else if (stack.length === 0 && char === ',') {
      const token = text.slice(start, i).trim();

      if (token) {
        segments.push(token);
      }

      start = i + 1;
    }
  }

  const last = text.slice(start).trim();

  if (last) {
    segments.push(last);
  }

  return segments;
}

/**
 * Remove block and line comments so a comment inside a parameter list does not
 * corrupt parsing.
 *
 * This is string-unaware (like a regex, not a full tokenizer), so it diverges
 * from Playwright only for the pathological case of a `/*` or `//` marker inside
 * a string-literal default within a fixture/body destructure. That case is
 * invalid-ish usage and cannot cause a leak (the worker gate fails closed and
 * the wrapper only re-emits identifier names), so exact parity is not pursued.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Wrap a fixture function so the resolved value is captured for agent injection
 * the moment the fixture calls `use(value)`. The wrapper re-declares the
 * original's destructured dependencies so Playwright resolves the identical
 * fixture graph. Returns null when the signature cannot be parsed.
 */
export function wrapFixtureFunction(
  name: string,
  fn: Function,
  scope: FixtureScope,
  record: RecordFixtureFn,
): Function | null {
  const names = parseFixtureParameterNames(fn);

  if (names === null) {
    return null;
  }

  // Reserve Langwright's internal `__lw` identifier prefix. A dependency named
  // with it could shadow the wrapper's own bindings or duplicate its positional
  // parameters (`__lwUse`/`__lwInfo`), so such a fixture is left unwrapped.
  if (names.some((dep) => dep.startsWith('__lw'))) {
    return null;
  }

  const destructure = `{ ${names.join(', ')} }`;

  try {
    // The factory parameters are `__lw`-prefixed so a user dependency (e.g. one
    // named `record`) destructured in the inner signature cannot shadow them.
    // eslint-disable-next-line no-new-func -- Re-emits the fixture's destructuring signature so Playwright's source-parsed dependency resolution is preserved while the resolved value is captured at use().
    const factory = new Function(
      '__lwOriginalFn',
      '__lwRecord',
      '__lwName',
      '__lwScope',
      `return function (${destructure}, __lwUse, __lwInfo) {\n` +
        '  const __lwWrappedUse = (__lwValue) => {\n' +
        '    __lwRecord(__lwName, __lwValue, __lwScope);\n' +
        '    return __lwUse(__lwValue);\n' +
        '  };\n' +
        `  return __lwOriginalFn(${destructure}, __lwWrappedUse, __lwInfo);\n` +
        '};',
    );
    const wrapper: Function = factory(fn, record, name, scope);

    return wrapper;
  } catch {
    // A pathological signature that slipped past parsing would make the
    // generated source invalid; leave the fixture unwrapped rather than abort
    // the whole spec file's registration.
    return null;
  }
}

/**
 * Decide how a single `test.extend(...)` fixture entry is wrapped for capture.
 *
 * Reserved names (built-in overrides, options) and non-function values (literal
 * option defaults) pass through unchanged; function fixtures and `[fn, options]`
 * tuples are wrapped, routing the captured value to the test or worker store by
 * the declared scope.
 */
function wrapFixtureEntry(name: string, value: unknown, record: RecordFixtureFn): unknown {
  if (RESERVED_SCOPE_NAMES.has(name)) {
    return value;
  }

  if (typeof value === 'function') {
    return wrapFixtureFunction(name, value, 'test', record) ?? value;
  }

  if (Array.isArray(value) && typeof value[0] === 'function') {
    const [fn, options] = value as [Function, { scope?: FixtureScope } | undefined];
    const scope: FixtureScope = options?.scope === 'worker' ? 'worker' : 'test';
    const wrappedFn = wrapFixtureFunction(name, fn, scope, record);

    return wrappedFn ? [wrappedFn, options] : value;
  }

  return value;
}

/**
 * Wrap every function-valued fixture in a `test.extend(...)` argument with the
 * capture proxy so user fixtures become available to the agent under their own
 * names.
 */
export function wrapFixtureExtension(extension: unknown, record: RecordFixtureFn): unknown {
  if (!extension || typeof extension !== 'object') {
    return extension;
  }

  const wrapped: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(extension as Record<string, unknown>)) {
    wrapped[name] = wrapFixtureEntry(name, value, record);
  }

  return wrapped;
}
