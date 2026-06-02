import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistration } from '../../src/fixtures/registry.js';

void describe('normalizeRegistration', () => {
  void it('accepts the object form', () => {
    const pom = { goto() {} };
    assert.deepEqual(normalizeRegistration([{ playwrightDevPage: pom }]), [['playwrightDevPage', pom]]);
  });

  void it('accepts the name/value form', () => {
    const value = { addToDo() {} };
    assert.deepEqual(normalizeRegistration(['todoPage', value]), [['todoPage', value]]);
  });

  void it('accepts multiple entries in the object form', () => {
    const entries = normalizeRegistration([{ a: 1, b: 2 }]);
    assert.deepEqual(entries, [['a', 1], ['b', 2]]);
  });

  void it('rejects reserved names that would shadow built-ins or helpers', () => {
    for (const reserved of ['page', 'context', 'expect', 'viewport', 'fixtures', 'options']) {
      assert.throws(() => normalizeRegistration([{ [reserved]: {} }]), /reserved name/);
    }
  });

  void it('rejects names that are not valid identifiers', () => {
    assert.throws(() => normalizeRegistration([{ 'has space': {} }]), /valid JavaScript identifier/);
    assert.throws(() => normalizeRegistration([{ '1abc': {} }]), /valid JavaScript identifier/);
  });

  void it('rejects __proto__ which would corrupt the merged scope object', () => {
    assert.throws(() => normalizeRegistration(['__proto__', { polluted: true }]), /__proto__/);
  });

  void it('rejects JavaScript reserved words that cannot be a scope parameter', () => {
    for (const reserved of ['class', 'let', 'yield', 'default', 'function', 'await']) {
      assert.throws(() => normalizeRegistration([{ [reserved]: {} }]), /reserved word/);
    }
  });

  void it('rejects malformed argument shapes', () => {
    assert.throws(() => normalizeRegistration([] as unknown as [Record<string, unknown>]), /expects/);
    assert.throws(() => normalizeRegistration(['only-a-string'] as unknown as [string, unknown]), /expects/);
  });
});
