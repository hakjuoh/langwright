/**
 * Normalize a natural-language instruction string into compact prompt text.
 *
 * Indentation is stripped so tests can format natural-language instructions
 * like normal TypeScript without leaking whitespace noise into the prompt.
 * Applied to both halves of every `scenario(steps, expect?)` call.
 */
export function normalizeInstructionText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}
