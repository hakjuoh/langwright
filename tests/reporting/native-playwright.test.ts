import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNativePlaywrightArtifact } from '../../src/reporting/native-playwright';
import type { GeneratedScenario, ScenarioBlock, ScenarioRecord } from '../../src/shared/types';

function record(
  id: string,
  generated: Omit<GeneratedScenario, 'blockId'>,
  ok = true,
  expect?: string,
): ScenarioRecord {
  const block: ScenarioBlock = { id, steps: 'do something', expect };
  const code = [generated.actionCode, generated.assertionCode].filter(Boolean).join('\n');

  return {
    block,
    generated: { blockId: id, ...generated },
    execution: {
      blockId: id,
      ok,
      code,
      error: ok ? undefined : { message: 'boom' },
      startedAt: '2026-05-29T00:00:00.000Z',
      finishedAt: '2026-05-29T00:00:00.001Z',
      durationMs: 1,
    },
  };
}

function emitsCompleteNativeCodeFromPassingScenarios(): void {
  const artifact = buildNativePlaywrightArtifact(
    [
      record('block-1', { actionCode: 'await page.goto("https://playwright.dev");' }),
      record(
        'block-2',
        {
          actionCode: 'await page.getByRole("link", { name: "Get started" }).click();',
          assertionCode: 'await expect(page.getByRole("heading", { name: "Installation" })).toBeVisible();',
        },
        true,
        'installation heading visible',
      ),
    ],
    'passed',
  );

  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.spans.length, 3, 'block-1 action + block-2 action + block-2 assertion');
  assert.match(artifact.body, /await page\.goto\("https:\/\/playwright\.dev"\);/);
  assert.match(artifact.body, /toBeVisible/);
  assert.deepEqual(artifact.diagnostics, []);
}

function labelsActionAndAssertionSpansByKind(): void {
  const artifact = buildNativePlaywrightArtifact(
    [record('block-1', { actionCode: 'await a();', assertionCode: 'await expect(x).toBe(1);' }, true, 'x is 1')],
    'passed',
  );

  assert.deepEqual(
    artifact.spans.map((span) => [span.blockId, span.kind]),
    [
      ['block-1', 'steps'],
      ['block-1', 'expectation'],
    ],
  );
}

function excludesFailedScenarioAndMarksPartial(): void {
  const artifact = buildNativePlaywrightArtifact(
    [
      record('block-1', { actionCode: 'await page.goto("https://example.com");' }),
      record('block-2', { actionCode: 'await broken();' }, false),
    ],
    'failed',
  );

  assert.equal(artifact.status, 'partial');
  assert.match(artifact.body, /page\.goto/);
  assert.doesNotMatch(artifact.body, /broken/);
  assert.match(artifact.diagnostics.join('\n'), /Excluded scenario block-2/);
  assert.match(artifact.diagnostics.join('\n'), /ended with status "failed"/);
}

function returnsInvalidWhenNoGreenScenarioProducedCode(): void {
  const artifact = buildNativePlaywrightArtifact([record('block-1', { actionCode: 'await broken();' }, false)], 'failed');

  assert.equal(artifact.status, 'invalid');
  assert.equal(artifact.body, '');
}

function stripsDiagnosticLinesFromGeneratedCode(): void {
  const artifact = buildNativePlaywrightArtifact(
    [
      record('block-1', {
        actionCode: ['const notes = [];', 'notes.push("debug");', 'console.log("debug");', 'await page.goto("https://playwright.dev");', 'return notes;'].join('\n'),
      }),
    ],
    'passed',
  );

  assert.equal(artifact.status, 'complete');
  assert.match(artifact.body, /await page\.goto\("https:\/\/playwright\.dev"\);/);
  assert.doesNotMatch(artifact.body, /console\.log/);
  assert.doesNotMatch(artifact.body, /return notes/);
  assert.doesNotMatch(artifact.body, /notes\.push/);
}

void describe('buildNativePlaywrightArtifact', () => {
  void it('emits complete native code 1:1 from passing scenarios', emitsCompleteNativeCodeFromPassingScenarios);
  void it('labels action and assertion spans by kind', labelsActionAndAssertionSpansByKind);
  void it('excludes a failed scenario and marks the artifact partial', excludesFailedScenarioAndMarksPartial);
  void it('returns invalid when no green scenario produced code', returnsInvalidWhenNoGreenScenarioProducedCode);
  void it('strips return/console/notes diagnostic lines from generated code', stripsDiagnosticLinesFromGeneratedCode);
});
