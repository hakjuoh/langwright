import { test } from '@hakjuoh/langwright/test';

/**
 * Compile-only checks (never executed) that lock in the public typing of
 * `test.extend(...)`: extended tests keep the natural-language hook registrars
 * and infer the extended body fixtures. This file is named `.type-check.ts` so
 * the unit runner (which only runs `*.test.js`) never executes it, while
 * `tsc --noEmit` still validates it.
 */
class TodoPage {
  addToDo(_item: string): void {}
}

export function __extendTypingChecks(): void {
  const extended = test.extend<{ todoPage: TodoPage }>({
    todoPage: async ({ page: _page }, use) => {
      await use(new TodoPage());
    },
  });

  // Natural-language hooks remain string registrars on the extended test.
  extended.beforeEach('Open the app and sign in.');
  extended.beforeAll('Provision shared state.');

  // The extended body fixture is inferred (todoPage has addToDo).
  extended('adds an item', ({ todoPage }) => {
    todoPage.addToDo('ship it');
  });

  // @ts-expect-error natural-language hooks take an instruction string, not a function.
  extended.beforeEach((_args, _info) => {});

  // Recursive extend keeps the natural-language hook typing too.
  const nested = extended.extend<{ extra: number }>({
    extra: async ({}, use) => {
      await use(1);
    },
  });
  nested.beforeAll('Warm the cache.');
}
