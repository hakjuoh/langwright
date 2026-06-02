import type { Page } from '@playwright/test';
import { getPlaywrightTestModule } from '../shared/playwright-module.js';
import { createPlaywrightRunScope } from './runtime-scope.js';
import type { AgentResultError, AgentTestContext, ExecutionRecord, GeneratedScenario } from '../shared/types.js';

/**
 * Stage 2 (Execute): run one scenario's generated Playwright code directly
 * against the live page. No LLM is involved — this is deterministic Playwright,
 * and it is the sole producer of a scenario's execution record.
 */
export async function executeScenario(
  context: AgentTestContext,
  generated: GeneratedScenario,
): Promise<ExecutionRecord> {
  const { fixtures, page } = context;
  const playwrightTest = getPlaywrightTestModule();
  const { expect, test } = playwrightTest;
  const apiRequest = fixtures.playwright.request ?? playwrightTest.request;
  const code = composeScenarioCode(generated);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  try {
    const result = await runPlaywrightBody(
      code,
      createPlaywrightRunScope({ context, expect, test, apiRequest }),
    );

    return {
      blockId: generated.blockId,
      ok: true,
      code,
      observation: serializeResult(result),
      url: safeUrl(page),
      title: await page.title().catch(() => undefined),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
    };
  } catch (error) {
    return {
      blockId: generated.blockId,
      ok: false,
      code,
      error: toExecutionError(error),
      url: safeUrl(page),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
    };
  }
}

/**
 * Concatenate a scenario's action code and (optional) assertion code into the
 * single body that is executed and later emitted as native Playwright.
 */
export function composeScenarioCode(generated: GeneratedScenario): string {
  return [generated.actionCode, generated.assertionCode]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

/**
 * Execute a Playwright snippet inside a controlled lexical scope.
 *
 * Each key in `scope` becomes an argument to a generated async function. This
 * allows direct variable access (`page`, `expect`, Playwright fixtures, and so
 * on) without exposing undeclared names or requiring imports in the snippet.
 */
export async function runPlaywrightBody(
  body: string,
  scope: Record<string, unknown>,
): Promise<unknown> {
  const parameterNames = Object.keys(scope);
  // eslint-disable-next-line no-new-func -- Langwright intentionally executes generated Playwright snippets inside a constrained runtime scope.
  const execute = new Function(
    ...parameterNames,
    `"use strict"; return (async () => {\n${body}\n})();`,
  ) as (...args: unknown[]) => Promise<unknown>;

  return execute(...parameterNames.map((parameterName) => scope[parameterName]));
}

function serializeResult(result: unknown): unknown {
  if (result === undefined) {
    return null;
  }

  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
    return result;
  }

  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return String(result);
  }
}

function toExecutionError(error: unknown): AgentResultError {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }

  return { message: String(error) };
}

function safeUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}
