import { filterScopeFixtures } from '../fixtures/fixture-names.js';
import type { AgentTestContext } from '../shared/types.js';

/**
 * Describe the user fixtures and `register(...)` objects available by name in
 * the generated-code scope, so the Generator knows it can call them (for example
 * `await todoPage.addToDo("x")`).
 *
 * Advertises exactly what {@link createPlaywrightRunScope} injects, so the
 * Generator is never told about a name filtered out of the runtime scope.
 */
export function describeRegisteredObjects(context: AgentTestContext): string[] {
  return Object.entries(filterScopeFixtures(context.userFixtures)).map(([name, value]) =>
    describeScopeValue(name, value),
  );
}

/**
 * Build a one-line description of a registered value: a primitive summary, the
 * keys of a plain object, or the constructor name and methods of a class
 * instance.
 *
 * Always returns a single safe line: introspection is wrapped so an exotic value
 * cannot fail prompt assembly, and every interpolated token is sanitized so
 * attacker-shaped member names cannot corrupt the prompt's line structure.
 */
function describeScopeValue(name: string, value: unknown): string {
  try {
    return describeScopeValueUnsafe(name, value);
  } catch {
    return name;
  }
}

function describeScopeValueUnsafe(name: string, value: unknown): string {
  if (value === null || value === undefined) {
    return `${name}: ${String(value)}`;
  }

  const valueType = typeof value;

  // Primitives (and symbol/bigint) get a serialized-value summary; objects and
  // functions get a structural (methods/keys) summary instead.
  if (valueType !== 'object' && valueType !== 'function') {
    return describePrimitiveScopeValue(name, valueType, value);
  }

  return describeObjectScopeValue(name, value);
}

/**
 * Summarize a non-object, non-function value as `name: type = serialized`.
 *
 * Extracted from {@link describeScopeValueUnsafe} so the serialization branch —
 * with its JSON.stringify fallback to String() for unserializable primitives
 * (e.g. bigint) — is a single-purpose unit that stays within the complexity and
 * statement limits.
 */
function describePrimitiveScopeValue(name: string, valueType: string, value: unknown): string {
  let serialized: string;

  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }

  return `${name}: ${valueType} = ${sanitizeToken(serialized)}`;
}

/**
 * Summarize an object or function by its constructor label plus, preferring
 * methods over keys, its callable or own member names.
 *
 * Extracted from {@link describeScopeValueUnsafe} so the constructor/method/key
 * introspection branch — the bulk of the original branching — is isolated and
 * each path (methods present, keys present, bare label) stays single-purpose and
 * within the complexity and statement limits.
 */
function describeObjectScopeValue(name: string, value: unknown): string {
  const constructorName =
    isRecord(value) && typeof value.constructor === 'function' ? value.constructor.name : undefined;
  const label =
    constructorName && constructorName !== 'Object' ? `${name} (${sanitizeToken(constructorName)})` : name;

  const methods = collectMethodNames(value as object);

  if (methods.length > 0) {
    return `${label} — methods: ${formatMemberList(methods)}`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);

    if (keys.length > 0) {
      return `${label} — keys: ${formatMemberList(keys)}`;
    }
  }

  return label;
}

/**
 * Render a member-name list capped at 12 entries, sanitizing each token and
 * appending an ellipsis when the list was truncated.
 *
 * Shared by the methods and keys branches of {@link describeObjectScopeValue} so
 * the identical "slice 12, sanitize, join, maybe-ellipsis" shaping lives in one
 * place rather than being duplicated per branch.
 */
function formatMemberList(members: string[]): string {
  const shown = members.slice(0, 12).map(sanitizeToken).join(', ');

  return `${shown}${members.length > 12 ? ', …' : ''}`;
}

/**
 * Collapse whitespace (including newlines) and truncate a single token so an
 * interpolated member name cannot break the prompt's one-line list structure.
 */
function sanitizeToken(token: string, maxLength = 40): string {
  return truncate(token.replace(/\s+/g, ' ').trim(), maxLength);
}

/**
 * Collect the callable member names of a value (own enumerable methods plus one
 * level of prototype methods), guarding against getters that throw.
 */
function collectMethodNames(value: object): string[] {
  const names = new Set<string>();
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (safeIsFunction(record, key)) {
      names.add(key);
    }
  }

  const prototype = Object.getPrototypeOf(value) as object | null;

  if (prototype && prototype !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key !== 'constructor' && safeIsFunction(record, key)) {
        names.add(key);
      }
    }
  }

  return [...names];
}

function safeIsFunction(record: Record<string, unknown>, key: string): boolean {
  try {
    return typeof record[key] === 'function';
  } catch {
    return false;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
