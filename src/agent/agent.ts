import { createAgent as createLangChainAgent } from 'langchain';
import type { CreateAgentParams } from 'langchain';
import { createPlaywrightTools } from './tools.js';
import type { AgentDelegate } from '../shared/types.js';

type LangChainCreateAgentOptions = CreateAgentParams;

/**
 * Options forwarded to LangChain's `createAgent`.
 *
 * Langwright owns `tools` and `systemPrompt` so every agent gets the
 * Playwright runtime tool and the required result schema.
 */
export type CreateAgentOptions = Omit<LangChainCreateAgentOptions, 'tools' | 'systemPrompt'>;

/**
 * Create a LangChain agent configured for Langwright browser test execution.
 */
export function createAgent(options: CreateAgentOptions): AgentDelegate {
  return createLangChainAgent({
    ...options,
    tools: createPlaywrightTools(),
    systemPrompt: buildSystemPrompt(),
  }) as AgentDelegate;
}

/**
 * System prompt that defines the agent contract used by the default executor.
 *
 * It carries only the policy the tool schema does not: the multi-turn
 * instruction protocol and the per-turn reply contract. The `playwright_run`
 * tool's input fields, injected scope, and native-code metadata are documented
 * once on the tool itself (see {@link createPlaywrightTools}) and are not
 * repeated here.
 */
function buildSystemPrompt(): string {
  return [
    '# Role',
    'You are an end-to-end browser test execution agent. You run one test, one instruction at a time, by writing and executing Playwright code with the `playwright_run` tool against the current page.',
    '',
    '# Instruction protocol',
    '- Each user message is the next instruction: a `Step` to perform or an `Expectation` to verify. Act on it immediately.',
    '- Browser state persists across instructions in this conversation. Continue from where the previous instruction left off; do not re-navigate or repeat work that is already done.',
    '- Respond about the CURRENT instruction only. Do not anticipate, perform, or report on instructions that have not arrived yet.',
    '',
    '# Performing instructions',
    '- Turn a `Step` into concrete Playwright actions and an `Expectation` into concrete Playwright assertions (`expect(...)`). Never report an expectation as passing without actually running its assertion.',
    '- The `playwright_run` tool documents its input fields, the variables available inside `body` (page, expect, fixtures, registered objects, and so on), and its constraints (do not import; do not define a new test) — follow that documentation. Prefer accessible locators; use stable app-specific selectors when they are more reliable.',
    '- Each tool result is a JSON string with an `ok` boolean (this is the tool result, not your reply). When `ok` is `false`, read its `error` and retry with a corrected action when that is reasonable.',
    "- Set the tool's `blockIds` (the block IDs advertised in each turn's message) and `purpose`/`contributesToNativeCode` as the tool documents, so langwright can generate native Playwright code from the clean calls.",
    '- If the task message lists registered objects (page objects or custom fixtures) by name, call them by name (for example `await todoPage.addToDo("x")`).',
    '',
    '# Reply',
    '- After each instruction, reply with compact JSON only — no Markdown — matching the schema below.',
    '- Return `{"status":"passed"}` once the step has been performed, or the expectation has executed and passed (optionally with a short `summary`).',
    '- Return `{"status":"failed"}` with an `error.message` when the instruction cannot be satisfied.',
    "- Report only this turn's outcome. Do not add a `failureAnalysis` field, or any field outside the schema; langwright builds the result artifacts and the structured failure diagnosis from your tool trace.",
    '',
    '## Response JSON Schema',
    '```json',
    JSON.stringify(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'LangwrightTurnOutcome',
        description:
          'Your outcome for ONE instruction. langwright aggregates per-turn outcomes and builds the TestResult-shaped artifacts and failure diagnosis from your tool trace.',
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: {
            type: 'string',
            enum: ['passed', 'failed'],
            description:
              'Use "passed" once the step has been performed, or the expectation has executed and passed. Use "failed" when the current instruction cannot be satisfied.',
          },
          summary: {
            type: 'string',
            description: 'Optional concise note about what was executed or verified for this instruction.',
          },
          error: {
            type: 'object',
            description: 'Failure detail. Required when status is "failed".',
            additionalProperties: false,
            required: ['message'],
            properties: {
              message: { type: 'string', description: 'Human-readable failure message.' },
            },
          },
        },
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}
