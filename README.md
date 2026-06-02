# Langwright

Langwright is a LangChain-powered Playwright testing library that makes end-to-end tests feel more LLM-native. It
preserves the familiar Playwright workflow while allowing browser interactions and assertions to be written in natural
language.

<table>
  <tr>
    <th>Playwright</th>
    <th>Langwright</th>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <pre><code class="language-ts">import { test, expect } from '@playwright/test';

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
});</code></pre>
    </td>
    <td width="50%" valign="top">
      <pre><code class="language-ts">import { test, steps, expect } from '@hakjuoh/langwright/test';

test('has title', async () => {
&nbsp;&nbsp;steps&#96;
&nbsp;&nbsp;&nbsp;&nbsp;Go to https://playwright.dev/.
&nbsp;&nbsp;&#96;;

&nbsp;&nbsp;expect&#96;
&nbsp;&nbsp;&nbsp;&nbsp;The page title should contain Playwright.
&nbsp;&nbsp;&#96;;
});

test('get started link', async () => {
&nbsp;&nbsp;steps&#96;
&nbsp;&nbsp;&nbsp;&nbsp;Go to https://playwright.dev/.
&nbsp;&nbsp;&nbsp;&nbsp;Click the Get started link.
&nbsp;&nbsp;&#96;;

&nbsp;&nbsp;expect&#96;
&nbsp;&nbsp;&nbsp;&nbsp;The Installation heading should be visible.
&nbsp;&nbsp;&#96;;
});</code></pre>
    </td>
  </tr>
</table>
