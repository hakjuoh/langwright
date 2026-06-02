import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaywrightRunScope } from '../../src/agent/runtime-scope.js';
import type { AgentTestContext } from '../../src/shared/types.js';

function buildContext(userFixtures: Record<string, unknown>): AgentTestContext {
  const playwright = { devices: {}, chromium: {}, firefox: {}, webkit: {}, selectors: {}, errors: {} };

  return {
    fixtures: { page: 'PAGE', playwright } as unknown as AgentTestContext['fixtures'],
    page: 'PAGE' as unknown as AgentTestContext['page'],
    testInfo: {} as AgentTestContext['testInfo'],
    blocks: [],
    nextBlockIndex: 0,
    trace: [],
    userFixtures,
  };
}

void describe('createPlaywrightRunScope', () => {
  void it('exposes user fixtures by name', () => {
    const todoPage = { addToDo(): void {} };
    const scope = createPlaywrightRunScope({
      context: buildContext({ todoPage }),
      expect: 'E',
      test: 'T',
      apiRequest: 'A',
    });

    assert.equal(scope.todoPage, todoPage);
  });

  void it('does not let user fixtures shadow built-in fixtures, options, or helpers', () => {
    const scope = createPlaywrightRunScope({
      context: buildContext({ page: 'EVIL', viewport: 'EVIL', expect: 'EVIL' }),
      expect: 'E',
      test: 'T',
      apiRequest: 'A',
    });

    assert.equal(scope.page, 'PAGE'); // built-in fixture preserved
    assert.equal(scope.expect, 'E'); // helper preserved
    assert.equal(scope.viewport, undefined); // reserved option not injected from user fixtures
  });

  void it('drops user fixtures named with a JavaScript reserved word', () => {
    const scope = createPlaywrightRunScope({
      context: buildContext({ class: 'X', todoPage: { ok: true } }),
      expect: 'E',
      test: 'T',
      apiRequest: 'A',
    });

    // A reserved-word name would break the new Function scope, so it is dropped.
    assert.equal('class' in scope, false);
    assert.deepEqual(scope.todoPage, { ok: true });
  });
});
