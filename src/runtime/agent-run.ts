import type { PlaywrightTestArgs, TestInfo } from '@playwright/test';
import { createAtifTrajectoryFormatter } from '../reporting/atif.js';
import { attachAgentResult } from '../reporting/attachments.js';
import { resolveRunSessionId } from '../reporting/session-id.js';
import { loadLangwrightConfig } from '../config/config-loader.js';
import { withAgentTestContext } from './context.js';
import { createAgentExecutor } from '../agent/executor.js';
import { parseTestBodyFixtureNames } from '../fixtures/fixture-capture.js';
import { OPTION_FIXTURE_NAMES } from '../fixtures/fixture-names.js';
import { consumeFixtureStore, recordFixture } from '../fixtures/fixture-store.js';
import type { FixtureScope } from '../fixtures/fixture-store.js';
import { getPlaywrightTestModule } from '../shared/playwright-module.js';
import type {
  AgentResultError,
  AgentSourceLocation,
  AgentTestContext,
  LangwrightFixtureOptions,
  LangwrightFixtures,
} from '../shared/types.js';
import type { AgentHook, ScopeHookWorkerFixtures } from './hook-types.js';

const { test: playwrightTest } = getPlaywrightTestModule();

/**
 * Shape the core object fixtures plus resolved options into the bundle injected
 * into the agent runtime. The five core keys mirror the canonical core fixture
 * names (`page`, `context`, `browser`, `playwright`, `request`); options appear
 * both spread inline and under `options`, matching what the tools layer reads.
 */
function assembleFixtureBundle(
  core: Record<string, unknown>,
  options: LangwrightFixtureOptions,
): LangwrightFixtures {
  return { ...core, ...options, options } as unknown as LangwrightFixtures;
}

/**
 * Assemble the Langwright execution context from the Playwright fixtures
 * injected into the runtime fixture or a scope hook.
 *
 * Any pre-seeded `blocks` must already be numbered `block-1..block-N`, because
 * `nextBlockIndex` continues the sequence from `blocks.length`.
 */
function buildAgentTestContext(
  fixtures: LangwrightFixtures,
  page: PlaywrightTestArgs['page'],
  testInfo: TestInfo,
  blocks: AgentTestContext['blocks'] = [],
): AgentTestContext {
  return {
    fixtures,
    page,
    testInfo,
    blocks,
    nextBlockIndex: blocks.length,
    sourceLocation: sourceLocationFromTestInfo(testInfo),
  };
}

/**
 * Derive the user's spec location from Playwright's `testInfo`.
 *
 * Because Langwright tests are registered through the real `@playwright/test`
 * `test()` (the DSL runtime is injected via an auto fixture rather than by
 * wrapping `test`), `testInfo` already points at the user's spec file.
 */
function sourceLocationFromTestInfo(testInfo: TestInfo): AgentSourceLocation | undefined {
  if (!testInfo.file) {
    return undefined;
  }

  return {
    file: testInfo.file,
    line: testInfo.line ?? 0,
    column: testInfo.column ?? 0,
  };
}

/**
 * Load the executor, run one agent invoke for the collected blocks, attach the
 * artifacts, and surface a non-passing run as a Playwright failure.
 *
 * Shared by the per-test runtime fixture and the once-per-scope
 * `beforeAll`/`afterAll` hooks so both produce identical attachments and
 * failure behavior.
 */
async function runAgentForContext(context: AgentTestContext): Promise<void> {
  const config = await loadLangwrightConfig();
  const executor = createAgentExecutor(config);
  const result = await executor.run(context);
  const trajectoryFormatter =
    config.trajectoryFormatter ??
    createAtifTrajectoryFormatter({
      agentName: config.agentName,
      agentVersion: config.agentVersion,
      sessionId: config.sessionId ?? resolveRunSessionId(context.testInfo),
    });

  await attachAgentResult(context.testInfo, result, trajectoryFormatter);

  if (result.status !== 'passed') {
    throw new Error(result.error?.message ?? `Agent reported test status: ${result.status}`);
  }
}

/**
 * Execute a once-per-scope `beforeAll`/`afterAll` instruction through the agent.
 *
 * Playwright isolates a fresh page per test, so a scope hook runs the agent
 * against its own short-lived browser context. Browser state created here is not
 * carried into per-test pages; the hook is intended for setup the agent can
 * perform once, such as API calls, storage state, or account preparation.
 */
export async function runScopeHook(
  hook: AgentHook,
  worker: ScopeHookWorkerFixtures,
  testInfo: TestInfo,
): Promise<void> {
  const instruction = hook.instruction.trim();

  if (!instruction) {
    return;
  }

  const browserContext = await worker.browser.newContext();
  const page = await browserContext.newPage();

  try {
    const fixtures = assembleFixtureBundle(
      {
        page,
        context: browserContext,
        browser: worker.browser,
        playwright: worker.playwright,
        request: browserContext.request,
      },
      { browserName: worker.browserName } as LangwrightFixtureOptions,
    );

    const context = buildAgentTestContext(fixtures, page, testInfo, [
      { id: 'block-1', steps: instruction },
    ]);
    context.userFixtures = consumeFixtureStore(testInfo.testId, exposedWorkerFixtureNames(testInfo));

    await withAgentTestContext(context, () => runAgentForContext(context));
  } finally {
    await browserContext.close();
  }
}

/**
 * Pull the built-in Playwright option values out of the resolved fixture bundle.
 */
function collectFixtureOptions(deps: Record<string, unknown>): LangwrightFixtureOptions {
  const options: Record<string, unknown> = {};

  for (const name of OPTION_FIXTURE_NAMES) {
    options[name] = deps[name];
  }

  return options as unknown as LangwrightFixtureOptions;
}

/**
 * The Langwright runtime body: open a multi-turn agent session, run the test
 * body (where each awaited DSL call drives one turn against the live page), then
 * finalize and attach the aggregate result.
 *
 * Invoked by the generated auto fixture in `test-api.ts`, which supplies every
 * built-in fixture and option as `deps`.
 */
export async function runLangwrightRuntime(
  deps: Record<string, unknown>,
  use: () => Promise<void>,
): Promise<void> {
  const fixtures = assembleFixtureBundle(
    {
      page: deps.page,
      context: deps.context,
      browser: deps.browser,
      playwright: deps.playwright,
      request: deps.request,
    },
    collectFixtureOptions(deps),
  );
  const context = buildAgentTestContext(fixtures, fixtures.page, playwrightTest.info());

  await withAgentTestContext(context, async () => {
    const config = await loadLangwrightConfig();
    const executor = createAgentExecutor(config);
    const startInfo = playwrightTest.info();
    context.exposedWorkerNames = exposedWorkerFixtureNames(startInfo);
    const session = executor.startSession(context);
    context.session = session;
    const trajectoryFormatter =
      config.trajectoryFormatter ??
      createAtifTrajectoryFormatter({
        agentName: config.agentName,
        agentVersion: config.agentVersion,
        sessionId: config.sessionId ?? resolveRunSessionId(startInfo),
      });

    // The body and any beforeEach/afterEach hooks run during `use()`; each
    // awaited DSL call executes one turn through `session`. A failed turn (or a
    // value-form `expect`) throws inside the body — Playwright records that on
    // `testInfo` and fails the test, but the fixture's `use()` still RESOLVES
    // (teardown always runs), so the outcome is read from `testInfo.errors`
    // rather than caught here. A genuine `use()`/fixture rejection (rare) is
    // captured separately and rethrown so it is not swallowed.
    let useError: unknown;

    try {
      await use();
    } catch (error) {
      useError = error;
    } finally {
      const info = playwrightTest.info();
      // Drain the per-test fixture store for the final snapshot; turns already
      // peeked it non-destructively during the body.
      context.userFixtures = consumeFixtureStore(info.testId, context.exposedWorkerNames);
      const failure = info.errors[0] ?? useError;
      const result = session.finalize(
        failure === undefined ? { status: 'passed' } : { status: 'failed', error: toResultError(failure) },
      );

      try {
        await attachAgentResult(info, result, trajectoryFormatter);
      } catch {
        // An attachment failure must not mask a fixture-level rejection.
      }
    }

    if (useError !== undefined) {
      throw useError;
    }
  });
}

/**
 * Normalize a thrown value or a Playwright `TestInfoError` into a result error.
 */
function toResultError(error: unknown): AgentResultError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }

  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: unknown; stack?: unknown; value?: unknown };
    const message =
      typeof record.message === 'string'
        ? record.message
        : typeof record.value === 'string'
          ? record.value
          : JSON.stringify(error);

    return {
      message,
      stack: typeof record.stack === 'string' ? record.stack : undefined,
      value: typeof record.value === 'string' ? record.value : undefined,
    };
  }

  return { message: String(error) };
}

const NO_WORKER_FIXTURES: ReadonlySet<string> = new Set<string>();

/**
 * Determine which worker-scoped fixtures this test may see, by parsing the test
 * body's declared fixture names. A worker fixture is exposed only if the body
 * declared it, preventing a worker fixture from leaking into unrelated tests
 * sharing the worker.
 *
 * `fn` is the user's test body (`TestInfo.fn`). The gate fails closed: if the
 * body's declared names cannot be determined (the function is missing or its
 * signature is indeterminate), no worker fixtures are exposed rather than
 * leaking all of them.
 */
function exposedWorkerFixtureNames(testInfo: TestInfo): ReadonlySet<string> {
  const fn = (testInfo as { fn?: unknown }).fn;

  if (typeof fn !== 'function') {
    return NO_WORKER_FIXTURES;
  }

  const names = parseTestBodyFixtureNames(fn);

  return names === null ? NO_WORKER_FIXTURES : new Set(names);
}

/**
 * Record a captured fixture value into the per-test store, resolving the active
 * test id at call time.
 */
export function recordFixtureNow(name: string, value: unknown, scope: FixtureScope): void {
  let testId: string;

  try {
    testId = scope === 'worker' ? '' : playwrightTest.info().testId;
  } catch {
    // No active test for this capture; skip rather than crash the user fixture.
    return;
  }

  recordFixture(testId, name, value, scope);
}
