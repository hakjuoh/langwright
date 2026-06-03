import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearWorkerFixtures, consumeFixtureStore, recordFixture } from '../../src/fixtures/fixture-store';

function recordsAndDrainsTestScopedCaptures(): void {
  clearWorkerFixtures();
  recordFixture('test-1', 'todoPage', { id: 1 }, 'test');
  recordFixture('test-1', 'helper', { ready: true }, 'test');

  const drained = consumeFixtureStore('test-1');

  assert.deepEqual(drained, { todoPage: { id: 1 }, helper: { ready: true } });
}

function clearsTestScopedCapturesAfterConsumed(): void {
  clearWorkerFixtures();
  recordFixture('test-2', 'todoPage', { id: 2 }, 'test');

  assert.deepEqual(consumeFixtureStore('test-2'), { todoPage: { id: 2 } });
  assert.deepEqual(consumeFixtureStore('test-2'), {});
}

function isolatesCapturesAcrossTestIds(): void {
  clearWorkerFixtures();
  recordFixture('test-a', 'pom', 'A', 'test');
  recordFixture('test-b', 'pom', 'B', 'test');

  assert.deepEqual(consumeFixtureStore('test-a'), { pom: 'A' });
  assert.deepEqual(consumeFixtureStore('test-b'), { pom: 'B' });
}

function keepsWorkerCapturesAndTestWinsOnCollision(): void {
  clearWorkerFixtures();
  recordFixture('', 'account', { worker: true }, 'worker');
  recordFixture('test-3', 'pom', 'P', 'test');
  recordFixture('test-3', 'account', { worker: false }, 'test');

  const drained = consumeFixtureStore('test-3');

  assert.deepEqual(drained, { account: { worker: false }, pom: 'P' });
  // Worker capture survives the test-store drain.
  assert.deepEqual(consumeFixtureStore('test-4'), { account: { worker: true } });
}

function dropsUndefinedCaptures(): void {
  clearWorkerFixtures();
  recordFixture('test-5', 'present', 1, 'test');
  recordFixture('test-5', 'absent', undefined, 'test');

  assert.deepEqual(consumeFixtureStore('test-5'), { present: 1 });
}

function exposesWorkerCaptureOnlyToDeclaringTests(): void {
  clearWorkerFixtures();
  recordFixture('', 'account', { w: true }, 'worker');

  // Declared by the test → exposed.
  assert.deepEqual(consumeFixtureStore('w1', new Set(['account'])), { account: { w: true } });
  // Not declared → hidden (no leak).
  assert.deepEqual(consumeFixtureStore('w2', new Set(['other'])), {});
  // Declares no fixtures (e.g. a pure natural-language test) → hidden.
  assert.deepEqual(consumeFixtureStore('w3', new Set()), {});
  // Unknown declared set (null/undefined) → fallback exposes all worker captures.
  assert.deepEqual(consumeFixtureStore('w4', undefined), { account: { w: true } });
  assert.deepEqual(consumeFixtureStore('w5'), { account: { w: true } });
}

function neverGatesTestCapturesByWorkerNameSet(): void {
  clearWorkerFixtures();
  recordFixture('w6', 'pom', 'P', 'test');

  assert.deepEqual(consumeFixtureStore('w6', new Set()), { pom: 'P' });
}

function ignoresProtoCaptureInsteadOfPolluting(): void {
  clearWorkerFixtures();
  recordFixture('test-6', '__proto__', { polluted: true }, 'test');
  recordFixture('test-6', 'ok', 1, 'test');

  const drained = consumeFixtureStore('test-6');

  assert.deepEqual(drained, { ok: 1 });
  assert.equal(Object.getPrototypeOf(drained), Object.prototype);
}

void describe('fixture-store', () => {
  void it('records and drains test-scoped captures for one test id', recordsAndDrainsTestScopedCaptures);
  void it('clears test-scoped captures after they are consumed', clearsTestScopedCapturesAfterConsumed);
  void it('isolates captures across test ids', isolatesCapturesAcrossTestIds);
  void it('keeps worker-scoped captures available to every test and a test capture wins on collision', keepsWorkerCapturesAndTestWinsOnCollision);
  void it('drops undefined captures so void fixtures do not surface', dropsUndefinedCaptures);
  void it('exposes a worker capture only to tests that declared it', exposesWorkerCaptureOnlyToDeclaringTests);
  void it('never gates test-scoped captures by the worker-name set', neverGatesTestCapturesByWorkerNameSet);
  void it('ignores a __proto__ capture instead of polluting the result prototype', ignoresProtoCaptureInsteadOfPolluting);
});
