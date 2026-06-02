import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeScenarioCode, executeScenario, runPlaywrightBody } from '../../src/agent/execute';
import type { AgentTestContext, GeneratedScenario } from '../../src/shared/types';

void describe('runPlaywrightBody', () => {
  void it('executes snippets with the provided runtime scope', async () => {
    const visited: string[] = [];
    const result = await runPlaywrightBody(
      [
        'await page.goto(url);',
        'await expect(page.title).toBe(title);',
        'return page.visited;',
      ].join('\n'),
      {
        url: 'https://example.com',
        title: 'Example',
        page: {
          title: 'Example',
          visited,
          goto(url: string): void {
            visited.push(url);
          },
        },
        expect(value: unknown) {
          return {
            toBe(expected: unknown) {
              assert.equal(value, expected);
            },
          };
        },
      },
    );

    assert.deepEqual(result, ['https://example.com']);
  });

  void it('does not expose values that are absent from the runtime scope', async () => {
    await assert.rejects(runPlaywrightBody('return missingValue;', {}), /missingValue is not defined/);
  });

  void it('exposes registered scope values as named locals', async () => {
    const result = await runPlaywrightBody('return todoPage.title;', { todoPage: { title: 'My Todos' } });

    assert.equal(result, 'My Todos');
  });
});

void describe('composeScenarioCode', () => {
  void it('joins action and assertion code, trimming and dropping empties', () => {
    assert.equal(
      composeScenarioCode({ blockId: 'block-1', actionCode: '  await a();  ', assertionCode: 'await expect(x).toBe(1);' }),
      'await a();\nawait expect(x).toBe(1);',
    );
    assert.equal(composeScenarioCode({ blockId: 'block-1', actionCode: 'await a();' }), 'await a();');
  });
});

/**
 * A minimal fake page + fixture bundle sufficient for `createPlaywrightRunScope`
 * and `executeScenario`. The real `@playwright/test` `expect` runs against the
 * plain values the fake page exposes.
 */
function fakeContext(): { context: AgentTestContext; visited: string[] } {
  const visited: string[] = [];
  const page = {
    visited,
    url: () => visited.at(-1) ?? 'https://start.example',
    title: () => Promise.resolve('Fake Title'),
    goto: (url: string) => {
      visited.push(url);

      return Promise.resolve();
    },
  };
  const playwright = {
    devices: {},
    chromium: {},
    firefox: {},
    webkit: {},
    selectors: {},
    errors: {},
    request: undefined,
  };

  return {
    visited,
    context: {
      fixtures: { page, playwright } as unknown as AgentTestContext['fixtures'],
      page: page as unknown as AgentTestContext['page'],
      testInfo: {} as AgentTestContext['testInfo'],
      blocks: [],
      nextBlockIndex: 0,
    },
  };
}

void describe('executeScenario', () => {
  void it('returns a passing record with observation, url and title', async () => {
    const { context } = fakeContext();
    const generated: GeneratedScenario = {
      blockId: 'block-1',
      actionCode: 'await page.goto("https://example.com");',
      assertionCode: 'expect(page.visited).toContain("https://example.com"); return page.visited.length;',
    };

    const record = await executeScenario(context, generated);

    assert.equal(record.ok, true);
    assert.equal(record.blockId, 'block-1');
    assert.equal(record.observation, 1);
    assert.equal(record.url, 'https://example.com');
    assert.equal(record.title, 'Fake Title');
    assert.equal(record.error, undefined);
    assert.ok(record.code.includes('page.goto'));
  });

  void it('returns a failing record with the assertion error and no LLM involvement', async () => {
    const { context } = fakeContext();
    const generated: GeneratedScenario = {
      blockId: 'block-2',
      actionCode: 'await page.goto("https://example.com");',
      assertionCode: 'expect(page.visited).toContain("https://nope.example");',
    };

    const record = await executeScenario(context, generated);

    assert.equal(record.ok, false);
    assert.equal(record.blockId, 'block-2');
    assert.ok(record.error?.message, 'a failing scenario must carry an error message');
    assert.equal(record.url, 'https://example.com');
  });
});
