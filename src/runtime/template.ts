/**
 * Render a template-tagged instruction block into compact prompt text.
 *
 * Indentation is stripped so tests can format natural-language instructions
 * like normal TypeScript without leaking whitespace noise into the agent prompt.
 */
export function renderTemplate(strings: TemplateStringsArray, values: unknown[]): string {
  let rendered = '';

  strings.forEach((part, index) => {
    rendered += part;

    if (index < values.length) {
      rendered += String(values[index]);
    }
  });

  return rendered
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}
