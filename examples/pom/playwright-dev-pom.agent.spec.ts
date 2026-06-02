import { type Locator, type Page } from '@playwright/test';
import { test, scenario, register } from '@hakjuoh/langwright/test';

class PlaywrightDevPage {
  readonly page: Page;
  readonly getStartedLink: Locator;
  readonly gettingStartedHeader: Locator;
  readonly tocList: Locator;

  constructor(page: Page) {
    this.page = page;
    this.getStartedLink = page.locator('a', { hasText: 'Get started' });
    this.gettingStartedHeader = page.locator('h1', { hasText: 'Installation' });
    this.tocList = page.locator('article div.markdown ul > li > a');
  }

  async goto(): Promise<void> {
    await this.page.goto('https://playwright.dev');
  }

  async getStarted(): Promise<void> {
    await this.getStartedLink.first().click();
  }
}

test('getting started should contain table of contents', async ({ page }) => {
  const playwrightDevPage = new PlaywrightDevPage(page);
  register({ playwrightDevPage });

  await scenario(
    `
      Using the playwrightDevPage page object, open the Playwright site and go to
      the Get started page:
      - call playwrightDevPage.goto()
      - call playwrightDevPage.getStarted()
      - confirm playwrightDevPage.gettingStartedHeader is visible
      Then inspect the current Playwright Get started page table of contents.
    `,
    `
      The table of contents should contain all of these items:
      - How to install Playwright
      - What's installed
      - How to run the example test
      - How to open the HTML test report
      - Write tests using web-first assertions, fixtures and locators
      - Run single or multiple tests; headed mode
      - Generate tests with Codegen
      - View a trace of your tests
    `,
  );
});

test.fail('intentional failure reports table of contents diagnosis', async ({ page }) => {
  const playwrightDevPage = new PlaywrightDevPage(page);
  register({ playwrightDevPage });

  await scenario(
    `
      Using the playwrightDevPage page object, open the site and go to Get started:
      - call playwrightDevPage.goto()
      - call playwrightDevPage.getStarted()
      Then inspect the current Playwright Get started page table of contents.
    `,
    `
      The table of contents should contain an item named
      Intentional Missing Heading For Failure Analysis.
    `,
  );
});
