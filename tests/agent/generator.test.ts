import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { buildGeneratorPrompt, createGenerator } from '../../src/agent/generator';
import type { GeneratorInput } from '../../src/shared/types';

/**
 * A fake chat model whose `withStructuredOutput(...).invoke()` returns a canned
 * parsed object plus a raw response carrying usage metadata, and records the
 * messages it was sent so prompt assembly can be asserted.
 */
function stubModel(parsed: unknown, raw?: unknown): { model: BaseChatModel; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const model = {
    withStructuredOutput() {
      return {
        invoke: (messages: unknown[]) => {
          calls.push(messages);

          return Promise.resolve({
            parsed,
            raw: raw ?? { id: 'gen-1', usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
          });
        },
      };
    },
  };

  return { model: model as unknown as BaseChatModel, calls };
}

const baseInput: GeneratorInput = {
  block: { id: 'block-1', steps: 'Go to the dashboard and open Settings', expect: 'The Settings heading is visible' },
  registeredObjects: ['todoPage (TodoPage) — methods: addToDo, toggle'],
  snapshot: { url: 'https://app.example/dashboard', title: 'Dashboard', ariaSnapshot: '- button "Settings" [ref=e1]' },
  testTitle: 'settings smoke',
};

function promptOf(calls: unknown[][]): string {
  const human = (calls[0] as Array<{ content: unknown }>)[1];

  return String(human.content);
}

void describe('createGenerator', () => {
  void it('returns generated code and a metric sample', async () => {
    const { model } = stubModel({
      actionCode: 'await page.getByRole("button", { name: "Settings" }).click();',
      assertionCode: 'await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();',
      notes: 'clicked settings',
    });

    const { generated, metrics } = await createGenerator(model).generate(baseInput);

    assert.equal(generated.blockId, 'block-1');
    assert.match(generated.actionCode, /Settings/);
    assert.ok(generated.assertionCode?.includes('toBeVisible'));
    assert.equal(generated.notes, 'clicked settings');
    assert.equal(metrics.length, 1);
  });

  void it('returns a failing scenario when the model output is unparseable (parsed: null)', async () => {
    const { model } = stubModel(null);

    const { generated, metrics } = await createGenerator(model).generate(baseInput);

    assert.equal(generated.blockId, 'block-1');
    assert.match(generated.actionCode, /no parseable Playwright code/);
    assert.equal(metrics.length, 1, 'usage metrics are still extracted from the raw response');
  });

  void it('drops blank assertion/notes to undefined', async () => {
    const { model } = stubModel({ actionCode: 'await page.goto("/");', assertionCode: '   ', notes: '' });

    const { generated } = await createGenerator(model).generate(baseInput);

    assert.equal(generated.assertionCode, undefined);
    assert.equal(generated.notes, undefined);
  });

  void it('sends snapshot, registered objects, steps and expectation in the prompt', async () => {
    const { model, calls } = stubModel({ actionCode: 'await page.goto("/");' });

    await createGenerator(model).generate(baseInput);
    const prompt = promptOf(calls);

    assert.match(prompt, /button "Settings" \[ref=e1\]/);
    assert.match(prompt, /todoPage \(TodoPage\)/);
    assert.match(prompt, /open Settings/);
    assert.match(prompt, /Settings heading is visible/);
  });
});

void describe('buildGeneratorPrompt', () => {
  void it('omits the expectation section for an action-only scenario', () => {
    const prompt = buildGeneratorPrompt({ ...baseInput, block: { id: 'block-2', steps: 'Click logout' } });

    assert.doesNotMatch(prompt, /Expectation to verify/);
    assert.match(prompt, /Click logout/);
  });

  void it('notes when the accessibility snapshot is unavailable', () => {
    const prompt = buildGeneratorPrompt({ ...baseInput, snapshot: { url: 'https://x', title: 'X' } });

    assert.match(prompt, /accessibility snapshot: \(unavailable\)/);
  });
});
