import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFixtureParameterNames,
  parseTestBodyFixtureNames,
  wrapFixtureExtension,
  wrapFixtureFunction,
} from '../../src/fixtures/fixture-capture.js';
import type { FixtureScope } from '../../src/fixtures/fixture-store.js';

type Capture = [string, unknown, FixtureScope];

function recorder(): { captures: Capture[]; record: (n: string, v: unknown, s: FixtureScope) => void } {
  const captures: Capture[] = [];

  return { captures, record: (n, v, s) => captures.push([n, v, s]) };
}

// Named (non-async) fixture-shaped functions so their compiled source can be
// parsed without inline-arrow contextual typing getting in the way.
function depPageContext({ page, context }: { page: unknown; context: unknown }, use: (v: unknown) => void): void {
  use(page ?? context);
}

function depAliased({ context: ctx, page }: { context: unknown; page: unknown }, use: (v: unknown) => void): void {
  use(ctx ?? page);
}

function depEmpty({}: Record<string, never>, use: (v: unknown) => void): void {
  use(undefined);
}

function depRest({ page, ...rest }: Record<string, unknown>, use: (v: unknown) => void): void {
  use(rest ?? page);
}

function depDefault({ page = 1 }: { page?: number }, use: (v: unknown) => void): void {
  use(page);
}

function depNonDestructured(deps: unknown, use: (v: unknown) => void): void {
  use(deps);
}

void describe('parseFixtureParameterNames', () => {
  void it('reads destructured dependency names', () => {
    assert.deepEqual(parseFixtureParameterNames(depPageContext), ['page', 'context']);
  });

  void it('uses the key name for aliased destructuring', () => {
    assert.deepEqual(parseFixtureParameterNames(depAliased), ['context', 'page']);
  });

  void it('returns an empty list for an empty destructure', () => {
    assert.deepEqual(parseFixtureParameterNames(depEmpty), []);
  });

  void it('returns null for unsupported signatures (rest, defaults, non-destructured)', () => {
    assert.equal(parseFixtureParameterNames(depRest), null);
    assert.equal(parseFixtureParameterNames(depDefault), null);
    assert.equal(parseFixtureParameterNames(depNonDestructured), null);
  });

  void it('tolerates a trailing comma in the destructure (Prettier style)', () => {
    // eslint-disable-next-line no-new-func -- builds a function whose source literally keeps a trailing comma.
    const fn = new Function('return (function ({ page, context, }, use) { return use; });')() as () => unknown;

    assert.deepEqual(parseFixtureParameterNames(fn), ['page', 'context']);
  });

  void it('reads outer names from a nested destructure', () => {
    // eslint-disable-next-line no-new-func -- source must literally contain a nested destructure.
    const fn = new Function('return (function ({ account: { id, name }, page }, use) {});')() as () => unknown;

    assert.deepEqual(parseFixtureParameterNames(fn), ['account', 'page']);
  });

  void it('ignores comments in the parameter list', () => {
    // eslint-disable-next-line no-new-func -- source must literally contain a comment.
    const fn = new Function('return (function ({ account /* worker */, page }, use) {});')() as () => unknown;

    assert.deepEqual(parseFixtureParameterNames(fn), ['account', 'page']);
  });

  void it('does not lose a sibling name when a nested default contains bracket characters', () => {
    // Parentheses inside a string default must not be treated as nesting
    // (Playwright tracks only {} and [] in splitByComma).
    // eslint-disable-next-line no-new-func -- source must literally contain the string default.
    const fn = new Function('return (function ({ account: { x = "(" }, workerB }, use) {});')() as () => unknown;

    assert.deepEqual(parseFixtureParameterNames(fn), ['account', 'workerB']);
  });

  void it('does not lose a sibling name when an array default string contains a brace', () => {
    // A `}` inside a string in an array default must not terminate the
    // destructure early (the first parameter is recovered via splitByComma).
    // eslint-disable-next-line no-new-func -- source must literally contain the string default.
    const fn = new Function('return (function ({ account: [x = "}"], workerB }, use) {});')() as () => unknown;

    assert.deepEqual(parseFixtureParameterNames(fn), ['account', 'workerB']);
  });

  void it('accepts non-ASCII identifier names', () => {
    // eslint-disable-next-line no-new-func -- source must literally contain a Unicode identifier.
    const fn = new Function('return (function ({ café, page }, use) {});')() as () => unknown;

    assert.deepEqual(parseFixtureParameterNames(fn), ['café', 'page']);
  });
});

function bodyNoFixtures(): void {}

function bodyWithFixtures({ todoPage, page }: { todoPage: unknown; page: unknown }): void {
  void todoPage;
  void page;
}

function bodyNonDestructured(args: unknown): void {
  void args;
}

void describe('parseTestBodyFixtureNames', () => {
  void it('returns an empty list when the body declares no fixtures', () => {
    assert.deepEqual(parseTestBodyFixtureNames(bodyNoFixtures), []);
  });

  void it('returns the declared fixture names', () => {
    assert.deepEqual(parseTestBodyFixtureNames(bodyWithFixtures), ['todoPage', 'page']);
  });

  void it('returns null when the first argument is not a destructure (indeterminate)', () => {
    assert.equal(parseTestBodyFixtureNames(bodyNonDestructured), null);
  });

  void it('gates a nested-destructure body to its outer fixture names', () => {
    // eslint-disable-next-line no-new-func -- source must literally contain a nested destructure.
    const body = new Function('return (function ({ account: { id }, page }, testInfo) {});')() as () => unknown;

    assert.deepEqual(parseTestBodyFixtureNames(body), ['account', 'page']);
  });
});

function originalTestFixture({ page }: { page: string }, use: (v: unknown) => void): void {
  use({ pom: true, from: page });
}

function originalWorkerFixture({ browser }: { browser: string }, use: (v: unknown) => void): void {
  use({ account: browser });
}

function reservedPageOverride({ page }: { page: unknown }, use: (v: unknown) => void): void {
  use(page);
}

void describe('wrapFixtureFunction', () => {
  void it('captures the resolved value at use() and preserves the dependency signature', () => {
    const { captures, record } = recorder();
    const wrapped = wrapFixtureFunction('todoPage', originalTestFixture, 'test', record);

    if (wrapped === null) {
      assert.fail('expected a wrapped fixture function');
    }

    // Playwright must resolve the identical dependency set from the wrapper.
    assert.deepEqual(parseFixtureParameterNames(wrapped), ['page']);

    let used: unknown;
    wrapped({ page: 'P' }, (v: unknown) => {
      used = v;
    }, {});

    assert.deepEqual(used, { pom: true, from: 'P' });
    assert.deepEqual(captures, [['todoPage', { pom: true, from: 'P' }, 'test']]);
  });

  void it('returns null when the signature cannot be parsed', () => {
    const { record } = recorder();
    assert.equal(wrapFixtureFunction('x', depNonDestructured, 'test', record), null);
  });

  void it('does not let a dependency named like an internal binding break capture', () => {
    const { captures, record } = recorder();
    // eslint-disable-next-line no-new-func -- dependency literally named `record` to prove it cannot shadow the wrapper's closure.
    const fn = new Function(
      'return (function ({ record, page }, use) { return use({ got: record, page }); });',
    )() as Function;

    const wrapped = wrapFixtureFunction('audit', fn, 'test', record);

    if (wrapped === null) {
      assert.fail('expected a wrapped fixture function');
    }

    let used: unknown;
    wrapped({ record: 'USER', page: 'P' }, (v: unknown) => {
      used = v;
    }, {});

    assert.deepEqual(used, { got: 'USER', page: 'P' });
    assert.deepEqual(captures, [['audit', { got: 'USER', page: 'P' }, 'test']]);
  });

  void it('skips wrapping (no crash) when a dependency uses the reserved __lw prefix', () => {
    const { record } = recorder();
    // eslint-disable-next-line no-new-func -- dependency named with Langwright's reserved internal prefix.
    const fn = new Function('return (function ({ __lwUse, page }, use) { return use(page); });')() as Function;

    assert.equal(wrapFixtureFunction('x', fn, 'test', record), null);
  });
});

void describe('wrapFixtureExtension', () => {
  void it('passes reserved names through unchanged', () => {
    const { record } = recorder();
    const wrapped = wrapFixtureExtension({ page: reservedPageOverride }, record) as Record<string, unknown>;

    assert.equal(wrapped.page, reservedPageOverride);
  });

  void it('passes literal option defaults through unchanged', () => {
    const { record } = recorder();
    const option: [string, { option: boolean }] = ['Buy milk', { option: true }];
    const wrapped = wrapFixtureExtension({ defaultItem: option }, record) as Record<string, unknown>;

    assert.equal(wrapped.defaultItem, option);
  });

  void it('wraps a worker-scoped tuple fixture, preserving options and recording with worker scope', () => {
    const { captures, record } = recorder();
    const wrapped = wrapFixtureExtension(
      { account: [originalWorkerFixture, { scope: 'worker' }] },
      record,
    ) as Record<string, unknown>;
    const entry = wrapped.account as [Function, { scope: string }];

    assert.deepEqual(entry[1], { scope: 'worker' });
    assert.deepEqual(parseFixtureParameterNames(entry[0]), ['browser']);

    entry[0]({ browser: 'B' }, (v: unknown) => v, {});
    assert.deepEqual(captures, [['account', { account: 'B' }, 'worker']]);
  });

  void it('returns non-object extensions unchanged', () => {
    const { record } = recorder();
    assert.equal(wrapFixtureExtension(undefined, record), undefined);
  });
});
