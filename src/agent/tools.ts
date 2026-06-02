import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAgentTestContext } from '../runtime/context.js';
import { getPlaywrightTestModule } from '../shared/playwright-module.js';
import { createPlaywrightRunScope } from './runtime-scope.js';

/**
 * Build the LangChain tools that let the agent operate on the active
 * Playwright test page.
 *
 * The tool records every execution into the current `AgentTestContext`, which
 * later drives Playwright attachments, ATIF trajectory output, and generated
 * native Playwright code.
 */
export function createPlaywrightTools() {
  return [
    tool(
      async (input) => {
        const { body, purpose, blockIds, contributesToNativeCode } = input;
        const context = getAgentTestContext();
        const { fixtures, page } = context;
        const playwrightTest = getPlaywrightTestModule();
        const { expect, test } = playwrightTest;
        const apiRequest = fixtures.playwright.request ?? playwrightTest.request;
        const startedAt = Date.now();
        const traceEvent = {
          tool: 'playwright_run',
          input: {
            body,
            purpose,
            blockIds,
            contributesToNativeCode,
          },
          startedAt: new Date(startedAt).toISOString(),
        };

        try {
          const result = await runPlaywrightBody(
            body,
            createPlaywrightRunScope({
              context,
              expect,
              test,
              apiRequest,
            }),
          );
          const output = {
            ok: true,
            result: serializeResult(result),
            url: page.url(),
            title: await page.title().catch(() => ''),
          };

          context.trace.push({
            ...traceEvent,
            output,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
          });

          return JSON.stringify(output);
        } catch (error) {
          const output = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            url: page.url(),
          };

          context.trace.push({
            ...traceEvent,
            output,
            error: output.error,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
          });

          return JSON.stringify(output);
        }
      },
      {
        name: 'playwright_run',
        description: [
          'Run Playwright Test code against the current test page.',
          'Use this tool to perform browser actions and assertions for the current test.',
          'The body runs inside an async function with these variables already available:',
          '`page`, `context`, `browser`, `browserName`, `request`, and `playwright` as Playwright Test built-in fixtures.',
          'Built-in Playwright option values such as `baseURL`, `viewport`, `storageState`, `headless`, `trace`, and `testIdAttribute` are available by name and under `options`.',
          '`expect`, `test`, and `testInfo` from Playwright Test.',
          '`devices`, `chromium`, `firefox`, `webkit`, `selectors`, `errors`, and `apiRequest` for common @playwright/test imports.',
          '`fixtures` as the complete injected fixture object.',
          'Do not import anything. Use await directly.',
          'Do not define a new test with test(...). The body runs inside the current test.',
          'Use `request` for the per-test APIRequestContext fixture; use `apiRequest.newContext(...)` only when a separate API request context is required.',
          'When the code contributes to a later native Playwright artifact, set `purpose` to `action`, `assertion`, or `final` and set `blockIds` to the ordered instruction block IDs it implements.',
          'When the code is exploratory, diagnostic, or a retry that should not be copied into native Playwright output, set `purpose` to `probe` or `contributesToNativeCode` to false.',
          'Return useful observations when needed.',
          'Example: await page.goto("https://example.com");',
          'Example: await page.getByLabel("Username").fill("john.doe@example.com");',
          'Example: await expect(page).toHaveURL(/index\\.html/);',
        ].join('\n'),
        schema: z.object({
          body: z.string().describe('Playwright Test code to run inside the current test async function.'),
          purpose: z
            .enum(['probe', 'action', 'assertion', 'final'])
            .optional()
            .describe('Why this tool call is being made. Use probe for exploratory code that should not be copied.'),
          blockIds: z
            .array(z.string())
            .optional()
            .describe('Ordered Langwright instruction block IDs implemented by this code.'),
          contributesToNativeCode: z
            .boolean()
            .optional()
            .describe('Whether this body should be considered for generated native Playwright output.'),
        }),
      },
    ),
  ];
}

/**
 * Execute an agent-authored Playwright snippet inside a controlled lexical
 * scope.
 *
 * Each key in `scope` becomes an argument to a generated async function. This
 * allows direct variable access (`page`, `expect`, Playwright fixtures, and so on)
 * without exposing undeclared names or requiring imports in the snippet.
 */
export async function runPlaywrightBody(
  body: string,
  scope: Record<string, unknown>,
): Promise<unknown> {
  const parameterNames = Object.keys(scope);
  // eslint-disable-next-line no-new-func -- Langwright intentionally executes agent-produced Playwright snippets inside a constrained runtime scope.
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
