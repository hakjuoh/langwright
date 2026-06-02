import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { buildHealerPrompt, createHealer } from '../../src/agent/healer';
import type { HealerInput } from '../../src/shared/types';

function stubModel(parsed: unknown, raw?: unknown): { model: BaseChatModel; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const model = {
    withStructuredOutput() {
      return {
        invoke: (messages: unknown[]) => {
          calls.push(messages);

          return Promise.resolve({
            parsed,
            raw: raw ?? { id: 'heal-1', usage_metadata: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } },
          });
        },
      };
    },
  };

  return { model: model as unknown as BaseChatModel, calls };
}

const baseInput: HealerInput = {
  block: { id: 'block-1', steps: 'open settings', expect: 'the Settings heading is visible' },
  generated: {
    blockId: 'block-1',
    actionCode: 'await page.getByRole("button", { name: "Settings" }).click();',
    assertionCode: 'await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();',
  },
  execution: {
    blockId: 'block-1',
    ok: false,
    code: 'await page.getByRole("button", { name: "Settings" }).click();\nawait expect(...).toBeVisible();',
    error: { message: 'locator not found: heading "Settings"' },
    url: 'https://app.example/dashboard',
    startedAt: '2026-06-01T00:00:00.000Z',
    finishedAt: '2026-06-01T00:00:01.000Z',
    durationMs: 1000,
  },
  snapshot: { url: 'https://app.example/dashboard', title: 'Dashboard', ariaSnapshot: '- heading "Preferences"' },
  testTitle: 'settings smoke',
  sourceContext: 'File: spec.ts\nRegistered test line: 10',
};

void describe('createHealer', () => {
  void it('returns a diagnosis with clamped confidence and a metric sample', async () => {
    const { model } = stubModel({
      summary: 'The heading locator did not match; the page shows "Preferences".',
      findings: [
        {
          title: 'Heading text mismatch',
          category: 'defect',
          owner: 'agent',
          confidence: 1.4,
          explanation: 'The generated assertion expects "Settings" but the page renders "Preferences".',
          suggestedFix: { rationale: 'Assert on "Preferences" or correct the expectation.', risk: 'low' },
        },
      ],
    });

    const { diagnosis, metrics } = await createHealer(model).heal(baseInput);

    assert.equal(diagnosis.findings[0].confidence, 1, 'confidence is clamped into [0,1]');
    assert.equal(diagnosis.findings[0].owner, 'agent');
    assert.ok(diagnosis.findings[0].suggestedFix?.rationale.includes('Preferences'));
    assert.ok(diagnosis.summary.length > 0);
    assert.equal(metrics.length, 1);
  });

  void it('falls back to a summary-only diagnosis when the model output is unparseable (parsed: null)', async () => {
    const { model } = stubModel(null);

    const { diagnosis, metrics } = await createHealer(model).heal(baseInput);

    assert.match(diagnosis.summary, /locator not found/);
    assert.equal(diagnosis.findings.length, 0);
    assert.equal(metrics.length, 1);
  });

  void it('falls back to the error message when the summary is blank and tolerates no findings', async () => {
    const { model } = stubModel({ summary: '   ', findings: [] });

    const { diagnosis } = await createHealer(model).heal(baseInput);

    assert.match(diagnosis.summary, /locator not found/);
    assert.equal(diagnosis.findings.length, 0);
  });
});

void describe('buildHealerPrompt', () => {
  void it('includes the failed code, error, and page snapshot', () => {
    const prompt = buildHealerPrompt(baseInput);

    assert.match(prompt, /getByRole\("button", \{ name: "Settings" \}\)/);
    assert.match(prompt, /locator not found: heading "Settings"/);
    assert.match(prompt, /heading "Preferences"/);
    assert.match(prompt, /Registered test line: 10/);
  });
});
