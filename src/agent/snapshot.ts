import type { Page } from '@playwright/test';
import type { PageSnapshot } from '../shared/types.js';

/**
 * Upper bound on the ARIA snapshot text fed into a prompt, so a large page
 * cannot blow the model's context budget. Tunable single knob for snapshot
 * fidelity vs. cost.
 */
export const MAX_ARIA_SNAPSHOT_CHARS = 12000;

/**
 * Capture a best-effort, read-only snapshot of the live page for the Generator
 * (to author robust locators) and the Healer (to diagnose a failure).
 *
 * Every field is optional and isolated behind its own guard: snapshotting must
 * never throw into the pipeline, because it is an observability aid, not a step.
 */
export async function capturePageSnapshot(page: Page): Promise<PageSnapshot> {
  const [ariaSnapshot, title] = await Promise.all([
    captureAriaSnapshot(page),
    page.title().catch(() => undefined),
  ]);

  return { ariaSnapshot, url: safeUrl(page), title };
}

/**
 * Capture the AI-optimized ARIA snapshot of the page body. The `ai` mode adds
 * element references (`[ref=eN]`) and role/name structure ideal for authoring
 * `getByRole`/`getByText` locators. Truncated to {@link MAX_ARIA_SNAPSHOT_CHARS}.
 */
async function captureAriaSnapshot(page: Page): Promise<string | undefined> {
  try {
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });

    return truncate(snapshot, MAX_ARIA_SNAPSHOT_CHARS);
  } catch {
    return undefined;
  }
}

function safeUrl(page: Page): string | undefined {
  try {
    const url = page.url();

    return url && url !== 'about:blank' ? url : url || undefined;
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
