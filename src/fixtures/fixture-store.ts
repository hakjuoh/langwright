/**
 * Per-test capture store for user fixtures and `register(...)` objects.
 *
 * Playwright resolves fixtures lazily and offers no API to fetch a fixture value
 * on demand, so Langwright captures the resolved value at the moment a fixture's
 * `use()` is called (see the wrapping in `src/test.ts`) or when the user calls
 * `register(...)`. The capture is written here, keyed by `testId`, and later
 * drained by the runtime fixture before the agent runs.
 *
 * Each Playwright worker is its own process running one test at a time, so a
 * module-level map is parallel-safe. Worker-scoped fixtures are kept in a
 * separate, longer-lived map because they are instantiated once per worker and
 * shared across the tests that depend on them.
 */
const testStores = new Map<string, Map<string, unknown>>();
const workerStore = new Map<string, unknown>();

/** Scope of a captured fixture, mirroring Playwright's fixture scopes. */
export type FixtureScope = 'test' | 'worker';

/**
 * Record a captured fixture/object value for later injection into the agent
 * scope. `testId` is ignored for worker-scoped values, which outlive any single
 * test.
 */
export function recordFixture(testId: string, name: string, value: unknown, scope: FixtureScope): void {
  if (scope === 'worker') {
    workerStore.set(name, value);

    return;
  }

  let store = testStores.get(testId);

  if (!store) {
    store = new Map<string, unknown>();
    testStores.set(testId, store);
  }

  store.set(name, value);
}

/**
 * Return the captured names for a test (worker captures merged in first, then
 * test captures so a test-scoped name wins on collision) and clear the
 * test-scoped entries. `undefined` values are dropped so void fixtures do not
 * surface as agent-scope locals.
 *
 * `exposedWorkerNames` gates which worker-scoped captures are surfaced: only
 * names the test actually declared are exposed, so a worker fixture does not
 * leak into unrelated tests sharing the worker. When it is `null`/`undefined`
 * (the test's declared names could not be determined), all worker captures are
 * exposed as a safe fallback.
 */
export function consumeFixtureStore(
  testId: string,
  exposedWorkerNames?: ReadonlySet<string> | null,
): Record<string, unknown> {
  const merged = peekFixtureStore(testId, exposedWorkerNames);

  testStores.delete(testId);

  return merged;
}

/**
 * Like {@link consumeFixtureStore} but non-draining: returns the captures
 * available so far without clearing the test-scoped entries. Used before each
 * incremental turn so objects registered between awaited DSL calls reach the
 * agent, with the final drain deferred to {@link consumeFixtureStore}.
 */
export function peekFixtureStore(
  testId: string,
  exposedWorkerNames?: ReadonlySet<string> | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const [name, value] of workerStore) {
    if (exposedWorkerNames && !exposedWorkerNames.has(name)) {
      continue;
    }

    assignCapture(merged, name, value);
  }

  const store = testStores.get(testId);

  if (store) {
    for (const [name, value] of store) {
      assignCapture(merged, name, value);
    }
  }

  return merged;
}

/**
 * Assign a captured value as an own property, skipping `undefined` (void
 * fixtures) and `__proto__` (which would mutate the result's prototype instead
 * of becoming a readable own property).
 */
function assignCapture(target: Record<string, unknown>, name: string, value: unknown): void {
  if (value === undefined || name === '__proto__') {
    return;
  }

  target[name] = value;
}

/**
 * Clear worker-scoped captures. Primarily a test seam; in production the worker
 * store is naturally discarded when the worker process exits.
 */
export function clearWorkerFixtures(): void {
  workerStore.clear();
}
