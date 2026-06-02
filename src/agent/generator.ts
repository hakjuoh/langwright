import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { extractMetricSamples } from './metrics.js';
import type { GeneratedScenario, Generator, GeneratorInput, PageSnapshot } from '../shared/types.js';

/**
 * Structured output the Generator must return. No tool-calling: a single
 * `withStructuredOutput` call yields the Playwright code directly.
 */
// Optional fields are declared `.nullable()`, not `.optional()`: OpenAI/Azure
// strict structured output (`response_format` json_schema) requires every
// property to appear in `required`, so optionality is expressed as a nullable
// value the model sets to `null` when absent.
const generatedScenarioSchema = z.object({
  actionCode: z
    .string()
    .describe('Playwright Test code that performs the scenario steps. May be empty only if there are no actions.'),
  assertionCode: z
    .string()
    .nullable()
    .describe('Playwright `expect(...)` assertions implementing the expectation; null when the scenario has none.'),
  notes: z.string().nullable().describe('Optional brief rationale (or null). Never executed or copied into the test.'),
});

type GeneratedScenarioFields = z.infer<typeof generatedScenarioSchema>;

/**
 * System prompt for the Generator (Playwright's "Generator" role): convert one
 * natural-language scenario into Playwright Test code. It never executes code —
 * Langwright runs the returned code directly.
 */
export const GENERATOR_SYSTEM_PROMPT = [
  '# Role',
  'You are the code Generator for an end-to-end browser test framework. You convert ONE natural-language test scenario into Playwright Test code. You do NOT execute anything; Langwright runs your code directly against the live page.',
  '',
  '# Output',
  '- Return `actionCode`: Playwright code performing the scenario steps (navigation, clicks, typing, page-object calls).',
  '- Return `assertionCode`: Playwright `expect(...)` assertions for the expectation. Omit it when the scenario has no expectation.',
  '- The two run together as one async body, action code first. Use `await` on every Playwright call.',
  '',
  '# Available variables (do NOT import anything; do NOT call test(...))',
  '- `page`, `context`, `browser`, `browserName`, `request`, and `playwright` Playwright Test fixtures.',
  '- Built-in option values such as `baseURL`, `viewport`, `storageState`, `headless`, `trace`, `testIdAttribute`, also under `options`.',
  '- `expect`, `test`, and `testInfo` from Playwright Test.',
  '- `devices`, `chromium`, `firefox`, `webkit`, `selectors`, `errors`, and `apiRequest` for common @playwright/test imports.',
  '- `fixtures` as the complete injected fixture object, and any registered objects listed in the user message by name.',
  '',
  '# Locators',
  '- Use the provided page snapshot to choose robust, accessible locators. Prefer `getByRole`, `getByLabel`, `getByText`; fall back to stable app-specific selectors.',
  '- When the user message lists registered objects (page objects or fixtures) by name, call them by name (for example `await todoPage.addToDo("x")`).',
  '- Do not return tool observations and do not use `console`. Keep the code to actions and assertions only.',
  '',
  '# Assertions',
  '- Turn each distinct expected outcome into its own `await expect(...)` assertion. When the expectation lists multiple required items (for example a bulleted list of entries), assert each item with its own locator and assertion rather than expecting a single element to contain them all.',
  '- Match each item against the specific element that should contain it (for example `getByRole("link", { name: item })`), not against a broad container that holds many items.',
].join('\n');

/**
 * Create the Generator stage from a chat model.
 */
export function createGenerator(model: BaseChatModel, opts: { systemPrompt?: string } = {}): Generator {
  const runnable = model.withStructuredOutput(generatedScenarioSchema, { includeRaw: true });
  const systemPrompt = opts.systemPrompt ?? GENERATOR_SYSTEM_PROMPT;

  return {
    async generate(input) {
      const response = (await runnable.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(buildGeneratorPrompt(input)),
      ])) as { parsed: GeneratedScenarioFields | null; raw: unknown };
      // `includeRaw` returns `parsed: null` when the model output fails schema
      // parsing. Extract metrics regardless, then surface the failure as a
      // scenario that fails at execution so the deterministic Execute -> Heal ->
      // Report path still runs instead of throwing out of the pipeline.
      const metrics = extractMetricSamples(response.raw);

      if (!response.parsed) {
        return {
          generated: {
            blockId: input.block.id,
            actionCode:
              'throw new Error("langwright Generator: the model returned no parseable Playwright code for this scenario.");',
          },
          metrics,
        };
      }

      return { generated: normalizeGenerated(response.parsed, input.block.id), metrics };
    },
  };
}

/**
 * Build the per-scenario user prompt: orientation, registered objects, the live
 * page snapshot, and the steps/expectation to convert.
 */
export function buildGeneratorPrompt(input: GeneratorInput): string {
  const lines: string[] = [`Test: ${input.testTitle}`, ''];

  if (input.registeredObjects.length > 0) {
    lines.push(
      'Registered objects available by name (call them directly):',
      ...input.registeredObjects.map((object) => `- ${object}`),
      '',
    );
  }

  lines.push(...formatSnapshot(input.snapshot), '');
  lines.push(`Scenario ${input.block.id}.`, '', 'Steps to perform:', input.block.steps);

  if (input.block.expect) {
    lines.push('', 'Expectation to verify (generate expect(...) assertions):', input.block.expect);
  }

  return lines.join('\n');
}

function formatSnapshot(snapshot: PageSnapshot): string[] {
  const lines = ['Current page state:'];
  lines.push(`- url: ${snapshot.url ?? '(unknown)'}`);
  lines.push(`- title: ${snapshot.title ?? '(unknown)'}`);

  if (snapshot.ariaSnapshot) {
    lines.push('- accessibility snapshot (use for locators):', '```yaml', snapshot.ariaSnapshot, '```');
  } else {
    lines.push('- accessibility snapshot: (unavailable)');
  }

  return lines;
}

function normalizeGenerated(parsed: GeneratedScenarioFields, blockId: string): GeneratedScenario {
  const assertionCode =
    typeof parsed.assertionCode === 'string' && parsed.assertionCode.trim().length > 0
      ? parsed.assertionCode
      : undefined;

  return {
    blockId,
    actionCode: typeof parsed.actionCode === 'string' ? parsed.actionCode : '',
    assertionCode,
    notes: typeof parsed.notes === 'string' && parsed.notes.trim().length > 0 ? parsed.notes : undefined,
  };
}
