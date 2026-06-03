import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TestInfo } from '@playwright/test';
import { resolveSessionId } from '../../src/reporting/session-id';

/**
 * Minimal `TestInfo` stub. Only `project.name`/`project.outputDir` are read by
 * the resolution paths exercised here; the env-var fast path in
 * `resolveRunSessionId` short-circuits before any other field is touched.
 */
function stubTestInfo(name = 'proj'): TestInfo {
  return { project: { name, outputDir: '/tmp/langwright-session-id-test' } } as unknown as TestInfo;
}

function withEnvSessionId<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.LANGWRIGHT_SESSION_ID;

  if (value === undefined) {
    delete process.env.LANGWRIGHT_SESSION_ID;
  } else {
    process.env.LANGWRIGHT_SESSION_ID = value;
  }

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.LANGWRIGHT_SESSION_ID;
    } else {
      process.env.LANGWRIGHT_SESSION_ID = previous;
    }
  }
}

void describe('resolveSessionId', () => {
  void it('prefers sessionIdResolver over a static sessionId and forwards testInfo', () => {
    const id = resolveSessionId(
      { sessionId: 'static-id', sessionIdResolver: (info) => `run-${info.project.name}` },
      stubTestInfo('checkout'),
    );

    assert.equal(id, 'run-checkout');
  });

  void it('uses the static sessionId when no resolver is configured', () => {
    const id = resolveSessionId({ sessionId: 'static-id' }, stubTestInfo());

    assert.equal(id, 'static-id');
  });

  void it('passes an explicit empty-string sessionId through unchanged (mirrors prior ?? behavior)', () => {
    const id = resolveSessionId({ sessionId: '' }, stubTestInfo());

    assert.equal(id, '');
  });

  void it('falls back to the run-stable default when neither field is set', () => {
    const id = withEnvSessionId('env-run-id', () => resolveSessionId({}, stubTestInfo()));

    assert.equal(id, 'env-run-id');
  });
});
