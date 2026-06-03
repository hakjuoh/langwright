# Langwright

Langwright is a LangChain-powered Playwright testing library that makes end-to-end tests feel more LLM-native. It
preserves the familiar Playwright workflow while allowing browser interactions and assertions to be written in natural
language.

**Playwright**

```ts
import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  await expect(page).toHaveTitle(/Playwright/);
});

test('get started link', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  await page.getByRole('link', { name: 'Get started' }).click();
  await expect(
    page.getByRole('heading', { name: 'Installation' }),
  ).toBeVisible();
});
```

**Langwright**

```ts
import { test, scenario } from '@hakjuoh/langwright/test';

test('has title', async () => {
  await scenario(
    `Go to https://playwright.dev/.`,
    `The page title should contain Playwright.`,
  );
});

test('get started link', async () => {
  await scenario(
    `Go to https://playwright.dev/. Click the Get started link.`,
    `The Installation heading should be visible.`,
  );
});
```

Each `scenario(steps, expect?)` runs a four-stage pipeline — **generate → execute → heal → report**. A *Generator*
agent converts the natural-language scenario into Playwright code (inspecting the live page for robust locators),
Playwright executes that code directly (no LLM in the loop), and on failure a *Healer* agent diagnoses the cause and
proposes a fix. This mirrors [Playwright's test agents](https://playwright.dev/docs/test-agents): the test plan is
authored inline as natural language, so Langwright fuses the Generator and Healer roles into a single run.
