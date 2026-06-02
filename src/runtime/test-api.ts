import type {
  Fixtures,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestDetails,
  TestInfo,
  TestType,
} from '@playwright/test';
import { appendScenarioBlock } from './context.js';
import { runScenarioBlock } from './dsl.js';
import { recordFixtureNow, runLangwrightRuntime, runScopeHook } from './agent-run.js';
import { wrapFixtureExtension } from '../fixtures/fixture-capture.js';
import { CORE_FIXTURE_NAMES, OPTION_FIXTURE_NAMES } from '../fixtures/fixture-names.js';
import { getPlaywrightTestModule } from '../shared/playwright-module.js';
import type { AgentHook, AgentHookInstruction, ScopeHookWorkerFixtures } from './hook-types.js';

const { test: playwrightTest } = getPlaywrightTestModule();

type PlaywrightTestApi = typeof playwrightTest;
type AgentHookRegistration = {
  (instruction: AgentHookInstruction): void;
  (title: string, instruction: AgentHookInstruction): void;
};

/** Test body receiving the (possibly extended) Playwright fixture bundle. */
type AgentTestBodyFor<TestArgs extends {}, WorkerArgs extends {}> = (
  fixtures: TestArgs & WorkerArgs,
  testInfo: TestInfo,
) => Promise<void> | void;

/** Playwright-shaped `test(...)` registration overloads over the fixture args. */
type AgentTestCallFor<TestArgs extends {}, WorkerArgs extends {}> = {
  (title: string, body: AgentTestBodyFor<TestArgs, WorkerArgs>): void;
  (title: string, details: TestDetails, body: AgentTestBodyFor<TestArgs, WorkerArgs>): void;
};

/**
 * Langwright's Playwright-compatible test API, generic over the fixture args.
 *
 * Test registration, describe scopes, modifiers (`only`/`skip`/`fixme`/`fail`/
 * `slow`), and `step`/`use`/`info` are the unmodified `@playwright/test`
 * members, so they keep Playwright's exact behavior and report tests at the
 * user's spec location. Only the four hooks are replaced with natural-language
 * registrars, and `extend` re-applies this wrapper to the extended test — so a
 * test produced by `test.extend(...)` keeps both its extended body fixtures and
 * the natural-language hook typing.
 */
type AgentTestApiFor<TestArgs extends {}, WorkerArgs extends {}> = AgentTestCallFor<TestArgs, WorkerArgs> &
  Omit<TestType<TestArgs, WorkerArgs>, 'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll' | 'extend'> & {
    beforeAll: AgentHookRegistration;
    beforeEach: AgentHookRegistration;
    afterEach: AgentHookRegistration;
    afterAll: AgentHookRegistration;
    extend<T extends {}, W extends {} = {}>(
      fixtures: Fixtures<T, W, TestArgs, WorkerArgs>,
    ): AgentTestApiFor<TestArgs & T, WorkerArgs & W>;
  };

type AgentTestApi = AgentTestApiFor<
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

type AgentHookKind = 'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll';
type EachHookKind = 'beforeEach' | 'afterEach';
type ScopeHookKind = 'beforeAll' | 'afterAll';
type NativeHookRegistrar = (...args: unknown[]) => void;

function normalizeHook(
  kind: AgentHookKind,
  titleOrInstruction: string,
  maybeInstruction: string | undefined,
): AgentHook {
  // Validate the instruction eagerly in both the `(instruction)` and
  // `(title, instruction)` forms so an empty hook fails at registration instead
  // of silently registering a no-op.
  return maybeInstruction === undefined
    ? { instruction: requireHookInstruction(kind, titleOrInstruction) }
    : { title: titleOrInstruction, instruction: requireHookInstruction(kind, maybeInstruction) };
}

function requireHookInstruction(kind: AgentHookKind, instruction: string | undefined): string {
  if (!instruction) {
    throw new Error(`test.${kind}(title, instruction) requires a hook instruction string.`);
  }

  return instruction;
}

/**
 * Create a `beforeEach`/`afterEach` registrar that records a natural-language
 * instruction as an ordered `steps` block.
 *
 * The instruction is registered as a real Playwright hook so Playwright owns its
 * describe scoping and ordering. The hook runs inside the runtime fixture's
 * active context (hooks execute within the fixture's `use()` window), so the
 * block joins the same per-test prompt, page, and native-code path as the body.
 */
function createEachHook(nativeRegistrar: NativeHookRegistrar, kind: EachHookKind): AgentHookRegistration {
  return (titleOrInstruction: string, maybeInstruction?: string) => {
    const hook = normalizeHook(kind, titleOrInstruction, maybeInstruction);
    const runner = async (): Promise<void> => {
      const block = appendScenarioBlock(hook.instruction);
      await runScenarioBlock(block);
    };

    if (hook.title) {
      nativeRegistrar(hook.title, runner);
    } else {
      nativeRegistrar(runner);
    }
  };
}

/**
 * Create a `beforeAll`/`afterAll` registrar that runs the instruction once per
 * scope through a real Playwright worker-level hook.
 */
function createScopeHook(nativeRegistrar: NativeHookRegistrar, kind: ScopeHookKind): AgentHookRegistration {
  return (titleOrInstruction: string, maybeInstruction?: string) => {
    const hook = normalizeHook(kind, titleOrInstruction, maybeInstruction);
    const runner = async (
      { browser, browserName, playwright }: ScopeHookWorkerFixtures,
      testInfo: TestInfo,
    ): Promise<void> => {
      await runScopeHook(hook, { browser, browserName, playwright }, testInfo);
    };

    if (hook.title) {
      nativeRegistrar(hook.title, runner);
    } else {
      nativeRegistrar(runner);
    }
  };
}

/**
 * Dependency names the runtime fixture must request so Playwright resolves every
 * built-in fixture and effective (post-`test.use()`) option value.
 */
const RUNTIME_DEPENDENCY_NAMES: readonly string[] = [...CORE_FIXTURE_NAMES, ...OPTION_FIXTURE_NAMES];

/**
 * The auto fixture that establishes the Langwright runtime around every test.
 *
 * Playwright derives a fixture's dependencies by parsing the function source
 * (`fn.toString()`) for its destructured first argument, so the fixture is
 * generated from {@link RUNTIME_DEPENDENCY_NAMES}. This keeps the ~40 dependency
 * names in a single source of truth instead of a hand-maintained destructure
 * that would also have to be repeated to rebuild the `options` object. Because
 * the user still calls the real `@playwright/test` `test()`, the Playwright
 * report points at the spec file.
 */
// eslint-disable-next-line no-new-func -- Generates the runtime fixture's destructuring signature from the canonical fixture-name list so Playwright resolves every built-in fixture and option.
const langwrightRuntimeFixture = new Function(
  'runLangwrightRuntime',
  `return async function ({ ${RUNTIME_DEPENDENCY_NAMES.join(', ')} }, use) {\n` +
    `  return runLangwrightRuntime({ ${RUNTIME_DEPENDENCY_NAMES.join(', ')} }, use);\n` +
    '};',
)(runLangwrightRuntime) as (deps: Record<string, unknown>, use: () => Promise<void>) => Promise<void>;

const runtimeExtension = {
  _langwrightRuntime: [langwrightRuntimeFixture, { auto: true }],
};
const runtimeTest = playwrightTest.extend<{ _langwrightRuntime: void }>(
  runtimeExtension as unknown as Parameters<typeof playwrightTest.extend>[0],
);

/**
 * Re-apply Langwright's natural-language hooks and recursive `extend` to a
 * Playwright test that already carries the runtime auto fixture.
 *
 * `test()` itself and every modifier/describe member are left untouched so they
 * stay Playwright-native (correct spec locations, full drop-in behavior). Only
 * the four hooks accept natural-language instructions, and `extend` wraps the
 * extended test the same way.
 */
function withLangwrightHooks(nativeTest: PlaywrightTestApi): AgentTestApi {
  // Snapshot the native hook registrars before the Object.assign below overwrites
  // these same keys; the natural-language registrars delegate to these originals.
  const nativeBeforeAll = nativeTest.beforeAll.bind(nativeTest) as NativeHookRegistrar;
  const nativeAfterAll = nativeTest.afterAll.bind(nativeTest) as NativeHookRegistrar;
  const nativeBeforeEach = nativeTest.beforeEach.bind(nativeTest) as NativeHookRegistrar;
  const nativeAfterEach = nativeTest.afterEach.bind(nativeTest) as NativeHookRegistrar;
  const nativeExtend = nativeTest.extend.bind(nativeTest);

  return Object.assign(nativeTest, {
    beforeAll: createScopeHook(nativeBeforeAll, 'beforeAll'),
    afterAll: createScopeHook(nativeAfterAll, 'afterAll'),
    beforeEach: createEachHook(nativeBeforeEach, 'beforeEach'),
    afterEach: createEachHook(nativeAfterEach, 'afterEach'),
    extend: ((extension: Parameters<typeof nativeExtend>[0]) =>
      withLangwrightHooks(
        nativeExtend(
          wrapFixtureExtension(extension, recordFixtureNow) as Parameters<typeof nativeExtend>[0],
        ),
      )) as unknown as AgentTestApi['extend'],
  });
}

/**
 * Langwright's Playwright-compatible test API. See {@link AgentTestApi}.
 */
export const test = withLangwrightHooks(runtimeTest);
