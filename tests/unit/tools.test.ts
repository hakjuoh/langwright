import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPlaywrightBody } from '../../src/agent/tools.js';

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
    await assert.rejects(
      runPlaywrightBody('return missingValue;', {}),
      /missingValue is not defined/,
    );
  });

  void it('exposes registered scope values as named locals', async () => {
    const result = await runPlaywrightBody('return todoPage.title;', {
      todoPage: { title: 'My Todos' },
    });

    assert.equal(result, 'My Todos');
  });
});
