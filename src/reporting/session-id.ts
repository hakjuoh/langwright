import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';
import type { LangwrightConfig } from '../shared/types.js';

const sessionIdsByFile = new Map<string, string>();

/**
 * Normalize the two session-ID config inputs and the auto default into one
 * resolved value.
 *
 * Precedence: an explicit `sessionIdResolver` (called with the run's
 * `testInfo`) wins, then a static `sessionId`, then {@link resolveRunSessionId}
 * — which already has the `(testInfo) => string` shape the resolver normalizes
 * to. The `!= null` check on `sessionId` mirrors the previous `??` behavior, so
 * an explicit empty string is still passed through unchanged.
 *
 * Called once per agent run, so the resolver MUST return a run-stable value; it
 * is the trajectory grouping key.
 */
export function resolveSessionId(
  config: Pick<LangwrightConfig, 'sessionId' | 'sessionIdResolver'>,
  testInfo: TestInfo,
): string {
  if (config.sessionIdResolver) {
    return config.sessionIdResolver(testInfo);
  }

  if (config.sessionId != null) {
    return config.sessionId;
  }

  return resolveRunSessionId(testInfo);
}

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

  return createRunSessionId(testInfo, sessionFile);
}

/**
 * Generate a fresh session ID and persist it with an exclusive create.
 *
 * Extracted from `resolveRunSessionId` so the cache-hit fast paths and this
 * filesystem-mutating slow path each stay a single, focused unit. Behavior is
 * unchanged: we generate, ensure the dir exists, then attempt the `wx` write
 * that loses gracefully to a parallel worker via the EEXIST race handler.
 */
function createRunSessionId(testInfo: TestInfo, sessionFile: string): string {
  const generated = `langwright-run-${randomUUID()}`;

  mkdirSync(join(testInfo.project.outputDir, '.langwright'), { recursive: true });

  try {
    writeFileSync(sessionFile, `${generated}\n`, { flag: 'wx' });
    sessionIdsByFile.set(sessionFile, generated);

    return generated;
  } catch (error) {
    return resolveSessionIdAfterRace(error, sessionFile);
  }
}

/**
 * Resolve the session ID after losing (or failing) the exclusive create.
 *
 * Extracted from the `catch` clause so the race-recovery logic is isolated and
 * its own statement/complexity budget. Re-throws non-EEXIST errors and the
 * original error when no winning value can be read, preserving prior behavior.
 */
function resolveSessionIdAfterRace(error: unknown, sessionFile: string): string {
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
