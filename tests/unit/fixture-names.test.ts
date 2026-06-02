import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterScopeFixtures, isSafeScopeBindingName } from '../../src/fixtures/fixture-names.js';

void describe('isSafeScopeBindingName', () => {
  void it('accepts plain and non-ASCII identifiers', () => {
    assert.equal(isSafeScopeBindingName('todoPage'), true);
    assert.equal(isSafeScopeBindingName('café'), true);
    assert.equal(isSafeScopeBindingName('_helper$2'), true);
  });

  void it('rejects non-identifier names that would break the new Function scope', () => {
    assert.equal(isSafeScopeBindingName('foo-bar'), false);
    assert.equal(isSafeScopeBindingName('has space'), false);
    assert.equal(isSafeScopeBindingName('1abc'), false);
  });

  void it('rejects reserved words, reserved scope names, and __proto__', () => {
    assert.equal(isSafeScopeBindingName('class'), false);
    assert.equal(isSafeScopeBindingName('let'), false);
    assert.equal(isSafeScopeBindingName('page'), false);
    assert.equal(isSafeScopeBindingName('expect'), false);
    assert.equal(isSafeScopeBindingName('__proto__'), false);
  });
});

void describe('filterScopeFixtures', () => {
  void it('keeps only safe names and is deterministic for prompt/scope parity', () => {
    const input = { todoPage: 1, 'foo-bar': 2, class: 3, page: 4, café: 5 };

    assert.deepEqual(filterScopeFixtures(input), { todoPage: 1, café: 5 });
  });

  void it('returns an empty object for undefined', () => {
    assert.deepEqual(filterScopeFixtures(undefined), {});
  });
});

void describe('scope binding names are valid strict-mode parameters', () => {
  // Ties the hand-maintained reserved-word list to real JS semantics: every
  // name the predicate accepts must be usable as a `new Function` parameter
  // (as runPlaywrightBody does), and the words it rejects must genuinely fail.
  void it('accepts names that are valid strict new Function parameters', () => {
    for (const name of ['todoPage', 'café', '_x$2']) {
      assert.equal(isSafeScopeBindingName(name), true);
      assert.doesNotThrow(() => {
        // eslint-disable-next-line no-new-func -- proves an accepted name works as a strict scope parameter.
        new Function(name, '"use strict"; return;');
      });
    }
  });

  void it('rejects words that genuinely fail as strict new Function parameters', () => {
    const breaking = [
      'class', 'let', 'yield', 'default', 'function', 'return', 'const', 'eval',
      'arguments', 'static', 'public', 'implements', 'package', 'interface',
      'private', 'protected',
    ];

    for (const word of breaking) {
      assert.equal(isSafeScopeBindingName(word), false);
      assert.throws(() => {
        // eslint-disable-next-line no-new-func -- proves a rejected word is genuinely invalid as a strict scope parameter.
        new Function(word, '"use strict"; return;');
      });
    }
  });
});
