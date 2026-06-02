import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNativePlaywrightArtifact } from '../../src/reporting/native-playwright.js';
import type { AgentTestContext, AgentTraceEvent } from '../../src/shared/types.js';

function context(): AgentTestContext {
  return {
    fixtures: {} as AgentTestContext['fixtures'],
    page: {} as AgentTestContext['page'],
    testInfo: {} as AgentTestContext['testInfo'],
    blocks: [
      { id: 'block-1', kind: 'steps', text: 'Use the page object.' },
      { id: 'block-2', kind: 'expectation', text: 'Verify the table of contents.' },
    ],
    nextBlockIndex: 2,
    trace: [],
  };
}

function trace(input: Record<string, unknown>, ok = true): AgentTraceEvent {
  return {
    tool: 'playwright_run',
    input,
    output: { ok },
    error: ok ? undefined : 'failed',
    startedAt: '2026-05-29T00:00:00.000Z',
    finishedAt: '2026-05-29T00:00:00.001Z',
    durationMs: 1,
  };
}

void describe('buildNativePlaywrightArtifact', () => {
  void it('emits complete native code from an annotated final trace', () => {
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [
        trace({
          purpose: 'final',
          blockIds: ['block-1', 'block-2'],
          body: [
            'await page.goto("https://playwright.dev");',
            "await expect(page.locator('article')).toContainText('Install');",
          ].join('\n'),
        }),
      ],
      'passed',
    );

    assert.equal(artifact.status, 'complete');
    assert.equal(artifact.spans.length, 1);
    assert.equal(artifact.spans[0].blockId, 'mixed');
    assert.match(artifact.body, /await page\.goto\("https:\/\/playwright\.dev"\);/);
    assert.deepEqual(artifact.diagnostics, []);
  });

  void it('marks multiple unannotated successful traces as partial and uses only the last successful trace', () => {
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [
        trace({ body: 'await page.goto("https://example.com");' }),
        trace({ body: 'await expect(page).toHaveURL(/example/);' }),
      ],
      'passed',
    );

    assert.equal(artifact.status, 'partial');
    assert.doesNotMatch(artifact.body, /page\.goto/);
    assert.match(artifact.body, /toHaveURL/);
    assert.match(artifact.diagnostics.join('\n'), /used only the last successful trace/);
  });

  void it('marks mixed annotated and unannotated traces as partial', () => {
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [
        trace({ body: 'await page.goto("https://example.com");' }),
        trace({
          purpose: 'assertion',
          blockIds: ['block-2'],
          body: 'await expect(page).toHaveTitle(/Example/);',
        }),
      ],
      'passed',
    );

    assert.equal(artifact.status, 'partial');
    assert.equal(artifact.spans[0].blockId, 'block-2');
    assert.match(artifact.diagnostics.join('\n'), /did not include native-code metadata/);
  });

  void it('drops probe and explicitly excluded traces', () => {
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [
        trace({ purpose: 'probe', body: 'await page.title();' }),
        trace({ contributesToNativeCode: false, body: 'await page.screenshot();' }),
      ],
      'passed',
    );

    assert.equal(artifact.status, 'invalid');
    assert.equal(artifact.body, '');
    assert.match(artifact.diagnostics.join('\n'), /marked as probes or excluded/);
  });

  void it('still rejects the legacy registeredFixtures namespace as a hallucinated token', () => {
    // The public fixture API surfaces fixtures and registered objects as bare
    // identifiers (see the next test), so a literal `registeredFixtures` object
    // is never a real injected local; it is rejected to catch model
    // hallucinations of the old namespace.
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [
        trace({
          purpose: 'final',
          body: [
            "await registeredFixtures['playwrightDevPage'].goto();",
            'await registeredFixtures.helper.finish();',
            "await page.fill('input', 'registeredFixtures.playwrightDevPage');",
          ].join('\n'),
        }),
      ],
      'passed',
    );

    assert.equal(artifact.status, 'partial');
    assert.match(artifact.body, /await page\.fill\('input', 'registeredFixtures\.playwrightDevPage'\);/);
    assert.match(artifact.diagnostics.join('\n'), /tool-only or ambient identifier "registeredFixtures"/);
  });

  void it('emits native code that calls registered fixtures and page objects by their own name', () => {
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [
        trace({
          purpose: 'final',
          blockIds: ['block-1'],
          body: [
            'await playwrightDevPage.goto();',
            'await playwrightDevPage.getStarted();',
            'await expect(todoPage.items).toHaveCount(2);',
          ].join('\n'),
        }),
      ],
      'passed',
    );

    assert.equal(artifact.status, 'complete');
    assert.match(artifact.body, /await playwrightDevPage\.goto\(\);/);
    assert.match(artifact.body, /await playwrightDevPage\.getStarted\(\);/);
    assert.match(artifact.body, /await expect\(todoPage\.items\)\.toHaveCount\(2\);/);
    assert.deepEqual(artifact.diagnostics, []);
  });

  void it('drops diagnostic statements and return observations', () => {
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [
        trace({
          purpose: 'final',
          body: [
            'const notes = [];',
            "notes.push('debug');",
            "console.log('debug');",
            'await page.goto("https://playwright.dev");',
            'return notes;',
          ].join('\n'),
        }),
      ],
      'passed',
    );

    assert.equal(artifact.status, 'complete');
    assert.equal(artifact.body.trim(), 'await page.goto("https://playwright.dev");');
    assert.match(artifact.diagnostics.join('\n'), /Dropped diagnostic-only statement/);
    assert.match(artifact.diagnostics.join('\n'), /Dropped return statement/);
  });

  void it('rejects tool-only and dynamic execution constructs', () => {
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [
        trace({
          purpose: 'final',
          body: [
            'await page.goto("https://example.com");',
            "eval('page.reload()');",
            'fixtures.page = page;',
            'await test.step("nested", async () => {});',
          ].join('\n'),
        }),
      ],
      'passed',
    );

    assert.equal(artifact.status, 'partial');
    assert.equal(artifact.body.trim(), 'await page.goto("https://example.com");');
    assert.match(artifact.diagnostics.join('\n'), /tool-only or dynamic call "eval"/);
    assert.match(artifact.diagnostics.join('\n'), /tool-only or ambient identifier "fixtures"/);
    assert.match(artifact.diagnostics.join('\n'), /nested Playwright test API usage/);
  });

  void it('marks output from a failed Langwright source result as partial', () => {
    const artifact = buildNativePlaywrightArtifact(
      context(),
      [trace({ purpose: 'final', body: 'await page.goto("https://example.com");' })],
      'failed',
    );

    assert.equal(artifact.status, 'partial');
    assert.match(artifact.diagnostics.join('\n'), /source Langwright test ended with status "failed"/);
  });
});
