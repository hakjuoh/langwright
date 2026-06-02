import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { extractMetricSamples } from './metrics.js';
import type { Healer, HealerDiagnosis, HealerFinding, HealerInput, PageSnapshot } from '../shared/types.js';

/**
 * Structured output the Healer must return: a summary plus one or more diagnosed
 * causes. Langwright wraps these into a full FailureAnalysis (ids, evidence,
 * runId, fingerprint, approval policy) deterministically.
 */
// Optional fields use `.nullable()` (not `.optional()`) for OpenAI/Azure strict
// structured output, which requires every property to be listed in `required`.
const suggestedFixSchema = z.object({
  rationale: z.string().describe('Why this fix addresses the cause.'),
  risk: z.enum(['low', 'medium', 'high']).describe('Estimated blast radius of the fix.'),
  unifiedDiff: z.string().nullable().describe('Unified diff when a concrete patch is clear, otherwise null.'),
});

const healerFindingSchema = z.object({
  title: z.string().describe('Short display title for the cause.'),
  category: z.enum(['defect', 'flake', 'spec_gap']).describe('defect=app/test bug; flake=timing/env; spec_gap=unclear requirement.'),
  owner: z.enum(['app', 'test', 'agent', 'infra', 'unknown']).describe('Who most likely owns the repair.'),
  confidence: z.number().describe('Confidence in [0,1].'),
  explanation: z.string().describe('Concise, code/UI-level explanation of the cause.'),
  suggestedFix: suggestedFixSchema.nullable().describe('A proposed fix, or null when none is clear.'),
});

const healerDiagnosisSchema = z.object({
  summary: z.string().describe('One-paragraph summary of why the scenario failed.'),
  findings: z.array(healerFindingSchema).describe('One or more diagnosed causes, most likely first.'),
});

type HealerDiagnosisFields = z.infer<typeof healerDiagnosisSchema>;

/**
 * System prompt for the Healer (Playwright's "Healer" role): diagnose why the
 * generated Playwright code failed and propose a fix. Read-only — it suggests,
 * it does not patch.
 */
export const HEALER_SYSTEM_PROMPT = [
  '# Role',
  'You are the Healer for an end-to-end browser test framework. A scenario was converted to Playwright code, executed, and failed. Diagnose the most likely cause(s) and propose a fix. You do not edit files; you produce a read-only diagnosis.',
  '',
  '# How to diagnose',
  '- Compare the failing code and error against the page snapshot at the moment of failure.',
  '- Decide a `category`: `defect` (app or test logic is wrong), `flake` (timing/environment sensitive), or `spec_gap` (the requirement is ambiguous or unmet by design).',
  '- Decide an `owner`: `app`, `test`, `agent` (bad generated code), `infra`, or `unknown`.',
  '- Propose a `suggestedFix` (locator update, wait adjustment, data fix, or an app/test change) with a clear rationale and a risk level.',
  '- Be specific and grounded in the evidence; do not invent elements that are absent from the snapshot.',
].join('\n');

/**
 * Create the Healer stage from a chat model.
 */
export function createHealer(model: BaseChatModel, opts: { systemPrompt?: string } = {}): Healer {
  const runnable = model.withStructuredOutput(healerDiagnosisSchema, { includeRaw: true });
  const systemPrompt = opts.systemPrompt ?? HEALER_SYSTEM_PROMPT;

  return {
    async heal(input) {
      const response = (await runnable.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(buildHealerPrompt(input)),
      ])) as { parsed: HealerDiagnosisFields | null; raw: unknown };
      // `includeRaw` returns `parsed: null` on a schema-parse failure. Fall back
      // to a summary-only diagnosis so the Report stage still emits a (then
      // deterministic) finding rather than dereferencing null or masking the
      // original execution error.
      const metrics = extractMetricSamples(response.raw);
      const diagnosis: HealerDiagnosis = response.parsed
        ? normalizeDiagnosis(response.parsed, input)
        : { summary: input.execution.error?.message ?? 'The scenario failed.', findings: [] };

      return { diagnosis, metrics };
    },
  };
}

/**
 * Build the per-failure user prompt: the scenario, the generated code, the
 * error, the page snapshot at failure, and the test source context.
 */
export function buildHealerPrompt(input: HealerInput): string {
  const lines: string[] = [
    `Test: ${input.testTitle}`,
    '',
    `Scenario ${input.block.id} steps:`,
    input.block.steps,
  ];

  if (input.block.expect) {
    lines.push('', 'Expectation:', input.block.expect);
  }

  lines.push(
    '',
    'Generated Playwright code that failed:',
    '```ts',
    input.execution.code,
    '```',
    '',
    'Failure error:',
    input.execution.error?.message ?? '(no error message captured)',
    '',
    ...formatSnapshot(input.snapshot),
  );

  if (input.sourceContext) {
    lines.push('', 'Test source context:', input.sourceContext);
  }

  return lines.join('\n');
}

function formatSnapshot(snapshot: PageSnapshot): string[] {
  const lines = ['Page state at failure:', `- url: ${snapshot.url ?? '(unknown)'}`, `- title: ${snapshot.title ?? '(unknown)'}`];

  if (snapshot.ariaSnapshot) {
    lines.push('- accessibility snapshot:', '```yaml', snapshot.ariaSnapshot, '```');
  }

  return lines;
}

/**
 * Coerce and bound the model's diagnosis. Confidence is clamped; an empty
 * findings list is tolerated (the Report stage then falls back to a
 * deterministic finding while keeping this summary).
 */
function normalizeDiagnosis(parsed: HealerDiagnosisFields, input: HealerInput): HealerDiagnosis {
  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
      ? parsed.summary
      : (input.execution.error?.message ?? 'The scenario failed.');
  const findings: HealerFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings.map((finding) => ({
        title: finding.title,
        category: finding.category,
        owner: finding.owner,
        confidence: clampConfidence(finding.confidence),
        explanation: finding.explanation,
        suggestedFix: finding.suggestedFix
          ? {
              rationale: finding.suggestedFix.rationale,
              risk: finding.suggestedFix.risk,
              unifiedDiff: finding.suggestedFix.unifiedDiff ?? undefined,
            }
          : undefined,
      }))
    : [];

  return { summary, findings };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}
