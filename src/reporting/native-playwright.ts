import ts from 'typescript';
import type { TestStatus } from '@playwright/test';
import type {
  AgentInstructionBlockKind,
  AgentTestContext,
  AgentTraceEvent,
  NativePlaywrightArtifact,
  NativePlaywrightSpan,
  PlaywrightRunInput,
} from '../shared/types.js';

interface CandidateTrace {
  index: number;
  event: AgentTraceEvent;
  input: PlaywrightRunInput;
}

interface SanitizedBody {
  code: string;
  diagnostics: string[];
  invalidStatementCount: number;
}

interface CandidateSelection {
  candidates: CandidateTrace[];
  diagnostics: string[];
  partial: boolean;
}

const WRAPPER_NAME = '__langwrightNativeBody';

/**
 * Build the native Playwright replacement artifact from observed agent tool
 * calls.
 *
 * The artifact is intentionally conservative: only successful `playwright_run`
 * calls that are marked as action/assertion/final, or the best legacy fallback,
 * are copied. Unsupported or tool-only statements are reported as diagnostics
 * instead of being emitted.
 */
export function buildNativePlaywrightArtifact(
  context: AgentTestContext,
  trace: AgentTraceEvent[],
  sourceStatus: TestStatus,
): NativePlaywrightArtifact {
  const selection = selectNativeCandidates(trace);
  const diagnostics: string[] = [...selection.diagnostics];
  const spans: NativePlaywrightSpan[] = [];
  let invalidStatementCount = 0;

  if (sourceStatus !== 'passed') {
    diagnostics.push(
      `Generated native Playwright code may be incomplete because the source Langwright test ended with status "${sourceStatus}".`,
    );
  }

  for (const candidate of selection.candidates) {
    const sanitized = sanitizePlaywrightBody(
      candidate.input.body,
      `trace ${candidate.index + 1}`,
    );
    diagnostics.push(...sanitized.diagnostics);
    invalidStatementCount += sanitized.invalidStatementCount;

    if (!sanitized.code.trim()) {
      continue;
    }

    spans.push({
      blockId: spanBlockId(candidate.input.blockIds, context),
      kind: spanKind(candidate.input.blockIds, context),
      code: sanitized.code,
      sourceTraceIndex: candidate.index,
    });
  }

  const body = spans.map((span) => span.code.trim()).filter(Boolean).join('\n\n');
  const isPartial = sourceStatus !== 'passed' || selection.partial || invalidStatementCount > 0;

  return {
    status: body ? (isPartial ? 'partial' : 'complete') : 'invalid',
    body: body ? `${body}\n` : '',
    spans,
    diagnostics,
  };
}

/**
 * Select trace events that should contribute to generated native Playwright.
 *
 * Newer agents should annotate every tool call with `purpose`, `blockIds`, or
 * `contributesToNativeCode`. For older traces with no annotations, Langwright
 * can only safely use the last successful call as a best-effort candidate.
 */
function selectNativeCandidates(trace: AgentTraceEvent[]): CandidateSelection {
  const diagnostics: string[] = [];
  const successful = trace
    .map((event, index) => ({ event, index, input: readPlaywrightRunInput(event.input) }))
    .filter((candidate): candidate is CandidateTrace => {
      return candidate.input !== undefined && isSuccessfulTrace(candidate.event);
    });
  const annotated = successful.filter(
    ({ input }) =>
      input.purpose !== undefined ||
      input.blockIds !== undefined ||
      input.contributesToNativeCode !== undefined,
  );
  const selected = (annotated.length > 0 ? annotated : successful.slice(-1)).filter(({ input }) => {
    return input.contributesToNativeCode !== false && input.purpose !== 'probe';
  });
  let partial = false;

  if (successful.length === 0) {
    diagnostics.push('No successful playwright_run trace was available for native Playwright generation.');
  } else if (annotated.length === 0 && successful.length === 1) {
    diagnostics.push(
      'No playwright_run native-code metadata was available; used the only successful trace as the native Playwright candidate.',
    );
  } else if (annotated.length === 0 && successful.length > 1) {
    diagnostics.push(
      'No playwright_run native-code metadata was available; used only the last successful trace as the best candidate.',
    );
    partial = true;
  } else if (annotated.length > 0 && annotated.length < successful.length) {
    diagnostics.push(
      'Some successful playwright_run traces did not include native-code metadata and were excluded from native Playwright generation.',
    );
    partial = true;
  }

  if (annotated.length > 0 && selected.length === 0) {
    diagnostics.push('All annotated playwright_run traces were marked as probes or excluded from native Playwright generation.');
    partial = true;
  }

  return { candidates: selected, diagnostics, partial };
}

/**
 * Normalize an arbitrary trace input into the `playwright_run` schema.
 */
function readPlaywrightRunInput(input: unknown): PlaywrightRunInput | undefined {
  if (!isRecord(input) || typeof input.body !== 'string') {
    return undefined;
  }

  return {
    body: input.body,
    purpose: input.purpose === 'probe' ||
      input.purpose === 'action' ||
      input.purpose === 'assertion' ||
      input.purpose === 'final'
      ? input.purpose
      : undefined,
    blockIds: Array.isArray(input.blockIds)
      ? input.blockIds.filter((blockId): blockId is string => typeof blockId === 'string')
      : undefined,
    contributesToNativeCode:
      typeof input.contributesToNativeCode === 'boolean' ? input.contributesToNativeCode : undefined,
  };
}

/**
 * A trace is successful when the tool did not throw and its JSON observation
 * does not explicitly report `ok: false`.
 */
function isSuccessfulTrace(event: AgentTraceEvent): boolean {
  if (event.error) {
    return false;
  }

  return !isRecord(event.output) || event.output.ok !== false;
}

/**
 * Parse, filter, and print a `playwright_run` body into native-test-safe code.
 */
function sanitizePlaywrightBody(
  body: string,
  label: string,
): SanitizedBody {
  const sourceText = `async function ${WRAPPER_NAME}() {\n${body}\n}\n`;
  const sourceFile = ts.createSourceFile('langwright-native-body.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];
  const diagnostics: string[] = parseDiagnostics.map((diagnostic: ts.Diagnostic) => {
    return `${label}: Rejected unparsable Playwright code: ${flattenDiagnostic(diagnostic.messageText)}`;
  });
  const wrapper = sourceFile.statements.find(ts.isFunctionDeclaration);
  const emittedStatements: string[] = [];
  let invalidStatementCount = diagnostics.length;

  if (!wrapper?.body) {
    diagnostics.push(`${label}: Rejected Playwright code because no executable body was found.`);

    return { code: '', diagnostics, invalidStatementCount: invalidStatementCount + 1 };
  }

  for (const statement of wrapper.body.statements) {
    const result = sanitizeStatement(statement, sourceFile, label);

    diagnostics.push(...result.diagnostics);
    invalidStatementCount += result.invalid ? 1 : 0;

    if (result.code) {
      emittedStatements.push(result.code);
    }
  }

  return {
    code: emittedStatements.join('\n'),
    diagnostics,
    invalidStatementCount,
  };
}

/**
 * Decide whether one top-level statement can be copied into native Playwright.
 */
function sanitizeStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  label: string,
): { code?: string; diagnostics: string[]; invalid: boolean } {
  const statementText = statement.getText(sourceFile);

  if (ts.isEmptyStatement(statement)) {
    return { diagnostics: [], invalid: false };
  }

  if (ts.isReturnStatement(statement)) {
    return {
      diagnostics: [`${label}: Dropped return statement; native Playwright replacement code should not return tool observations.`],
      invalid: false,
    };
  }

  if (isDiagnosticStatement(statement)) {
    return {
      diagnostics: [`${label}: Dropped diagnostic-only statement: ${summarizeStatement(statementText)}`],
      invalid: false,
    };
  }

  if (!isAllowedNativeStatement(statement)) {
    return {
      diagnostics: [`${label}: Rejected unsupported statement for native Playwright output: ${summarizeStatement(statementText)}`],
      invalid: true,
    };
  }

  const forbiddenReason = forbiddenNativeReason(statement);

  if (forbiddenReason) {
    return {
      diagnostics: [`${label}: Rejected statement with ${forbiddenReason}: ${summarizeStatement(statementText)}`],
      invalid: true,
    };
  }

  return {
    code: statement.getText(sourceFile),
    diagnostics: [],
    invalid: false,
  };
}

/**
 * Statement forms that are useful in generated tests and simple enough to
 * validate without executing them again.
 */
function isAllowedNativeStatement(statement: ts.Statement): boolean {
  return (
    ts.isExpressionStatement(statement) ||
    ts.isVariableStatement(statement) ||
    ts.isIfStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isBlock(statement)
  );
}

/**
 * Detect statements that are useful while the agent is probing the page but
 * should not appear in the final native test.
 */
function isDiagnosticStatement(statement: ts.Statement): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.every((declaration) => {
      return ts.isIdentifier(declaration.name) && declaration.name.text === 'notes';
    });
  }

  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return false;
  }

  const callee = statement.expression.expression;

  return isPropertyCallOn(callee, 'notes') || isPropertyCallOn(callee, 'console');
}

function isPropertyCallOn(callee: ts.Expression, objectName: string): boolean {
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === objectName;
}

/**
 * Return a human-readable rejection reason for constructs that are valid
 * JavaScript but unsafe or meaningless in a copied Playwright test body.
 */
function forbiddenNativeReason(node: ts.Node): string | undefined {
  let reason: string | undefined;

  const visit = (current: ts.Node) => {
    if (reason) {
      return;
    }

    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) {
      reason = 'module syntax';

      return;
    }

    if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'Function') {
      reason = 'dynamic function construction';

      return;
    }

    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      const callName = current.expression.text;

      if (callName === 'eval' || callName === 'Function' || callName === 'playwright_run') {
        reason = `tool-only or dynamic call "${callName}"`;

        return;
      }
    }

    if (ts.isIdentifier(current)) {
      reason = forbiddenIdentifierReason(current);

      if (reason) {
        return;
      }
    }

    ts.forEachChild(current, visit);
  };

  visit(node);

  return reason;
}

/**
 * Reject identifiers that only exist inside Langwright's tool runtime.
 */
function forbiddenIdentifierReason(identifier: ts.Identifier): string | undefined {
  const name = identifier.text;

  if (name === 'registeredFixtures') {
    return 'tool-only or ambient identifier "registeredFixtures"';
  }

  if (
    name === 'fixtures' ||
    name === 'testInfo' ||
    name === 'globalThis' ||
    name === 'window' ||
    name === 'document' ||
    name === 'process' ||
    name === 'require'
  ) {
    return `tool-only or ambient identifier "${name}"`;
  }

  if (name === 'notes') {
    return `diagnostic identifier "${name}"`;
  }

  if (name === 'test' && isCalleeOrPropertyRoot(identifier)) {
    return 'nested Playwright test API usage';
  }

  return undefined;
}

function isCalleeOrPropertyRoot(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;

  return (
    (ts.isCallExpression(parent) && parent.expression === identifier) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === identifier)
  );
}

function spanBlockId(blockIds: string[] | undefined, context: AgentTestContext): string {
  const validBlockIds = validInstructionBlockIds(blockIds, context);

  if (validBlockIds.length === 1) {
    return validBlockIds[0];
  }

  return validBlockIds.length > 1 ? 'mixed' : 'all-instructions';
}

function spanKind(blockIds: string[] | undefined, context: AgentTestContext): AgentInstructionBlockKind | 'mixed' {
  const validBlockIds = validInstructionBlockIds(blockIds, context);

  if (validBlockIds.length !== 1) {
    return 'mixed';
  }

  const block = context.blocks.find((candidate) => candidate.id === validBlockIds[0]);

  return block?.kind === 'steps' || block?.kind === 'expectation' ? block.kind : 'mixed';
}

function validInstructionBlockIds(blockIds: string[] | undefined, context: AgentTestContext): string[] {
  const knownInstructionIds = new Set(
    context.blocks
      .filter((block) => block.kind === 'steps' || block.kind === 'expectation')
      .map((block) => block.id),
  );

  return (blockIds ?? []).filter((blockId) => knownInstructionIds.has(blockId));
}

function summarizeStatement(statement: string): string {
  const compact = statement.replace(/\s+/g, ' ').trim();

  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

function flattenDiagnostic(message: string | ts.DiagnosticMessageChain): string {
  if (typeof message === 'string') {
    return message;
  }

  return ts.flattenDiagnosticMessageText(message, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
