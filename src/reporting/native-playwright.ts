import type { TestStatus } from '@playwright/test';
import type { NativePlaywrightArtifact, NativePlaywrightSpan, ScenarioRecord } from '../shared/types.js';

/**
 * Build the native Playwright replacement artifact from the executed scenarios.
 *
 * In the staged pipeline the Generator authored clean Playwright code and the
 * Execute stage ran it directly, so the executed code is authoritative — no
 * reconstruction from a tool trace and no AST sanitizing is required. Only code
 * from scenarios that executed green contributes; each scenario yields an action
 * span and (when present) an assertion span.
 */
export function buildNativePlaywrightArtifact(
  records: ScenarioRecord[],
  sourceStatus: TestStatus,
): NativePlaywrightArtifact {
  const diagnostics: string[] = [];
  const spans: NativePlaywrightSpan[] = [];
  let hadFailedScenario = false;

  if (sourceStatus !== 'passed') {
    diagnostics.push(
      `Generated native Playwright code may be incomplete because the source Langwright test ended with status "${sourceStatus}".`,
    );
  }

  records.forEach((record, index) => {
    if (!record.execution.ok) {
      hadFailedScenario = true;
      diagnostics.push(`Excluded scenario ${record.block.id} because its generated code failed to execute.`);

      return;
    }

    const action = stripNonNative(record.generated.actionCode);

    if (action) {
      spans.push({ blockId: record.block.id, kind: 'steps', code: action, sourceBlockIndex: index });
    }

    const assertion = stripNonNative(record.generated.assertionCode ?? '');

    if (assertion) {
      spans.push({ blockId: record.block.id, kind: 'expectation', code: assertion, sourceBlockIndex: index });
    }
  });

  if (records.length === 0) {
    diagnostics.push('No scenarios were executed, so no native Playwright code could be generated.');
  }

  const body = spans
    .map((span) => span.code.trim())
    .filter(Boolean)
    .join('\n\n');
  const isPartial = sourceStatus !== 'passed' || hadFailedScenario;

  return {
    status: body ? (isPartial ? 'partial' : 'complete') : 'invalid',
    body: body ? `${body}\n` : '',
    spans,
    diagnostics,
  };
}

/**
 * Trim the few statement forms that are useful while running but should not
 * appear in a standalone test: a `return` of the body's observation, and
 * `console`/`notes` diagnostic lines. The Generator is prompted to avoid these;
 * this is a light backstop, not the old full AST validation.
 */
function stripNonNative(code: string): string {
  return code
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();

      return !/^return\b/.test(trimmed) && !/^console\s*\./.test(trimmed) && !/^notes\b/.test(trimmed);
    })
    .join('\n')
    .trim();
}
