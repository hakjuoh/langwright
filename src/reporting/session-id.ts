import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';

const sessionIdsByFile = new Map<string, string>();

/**
 * Resolve a stable session ID for all tests in a Playwright project output dir.
 *
 * Parallel workers race through an exclusive file create; the loser reads the
 * winning value so trajectory IDs remain grouped within the same run.
 */
export function resolveRunSessionId(testInfo: TestInfo): string {
  const configured = process.env.LANGWRIGHT_SESSION_ID;

  if (configured) {
    return configured;
  }

  const sessionFile = join(testInfo.project.outputDir, '.langwright', 'session-id');
  const cached = sessionIdsByFile.get(sessionFile);

  if (cached) {
    return cached;
  }

  const existing = readSessionFile(sessionFile);

  if (existing) {
    sessionIdsByFile.set(sessionFile, existing);

    return existing;
  }

  const generated = `langwright-run-${randomUUID()}`;

  mkdirSync(join(testInfo.project.outputDir, '.langwright'), { recursive: true });

  try {
    writeFileSync(sessionFile, `${generated}\n`, { flag: 'wx' });
    sessionIdsByFile.set(sessionFile, generated);

    return generated;
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }

    const winner = readSessionFileWithRetry(sessionFile);

    if (winner) {
      sessionIdsByFile.set(sessionFile, winner);

      return winner;
    }

    throw error;
  }
}

function readSessionFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim();

    return value || undefined;
  } catch {
    return undefined;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function readSessionFileWithRetry(path: string): string | undefined {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = readSessionFile(path);

    if (value) {
      return value;
    }

    sleepSync(10);
  }

  return undefined;
}

function sleepSync(durationMs: number): void {
  // `resolveRunSessionId` is synchronous because it runs while constructing
  // attachments; this retry sleep is only used after losing the EEXIST race.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}
