import { createRequire } from 'node:module';
import path from 'node:path';
import type * as PlaywrightTest from '@playwright/test';

type PlaywrightTestModule = typeof PlaywrightTest;

let playwrightTestModule: PlaywrightTestModule | undefined;

/**
 * Load the consumer project's `@playwright/test` module once.
 *
 * Langwright treats Playwright as a peer dependency, so resolving from the
 * current project keeps versions and fixture types aligned with the test run.
 */
export function getPlaywrightTestModule(): PlaywrightTestModule {
  playwrightTestModule ??= loadPlaywrightTestModule();
  return playwrightTestModule;
}

function loadPlaywrightTestModule(): PlaywrightTestModule {
  const requireFromProject = createRequire(path.join(process.cwd(), 'package.json'));
  return requireFromProject('@playwright/test') as PlaywrightTestModule;
}
