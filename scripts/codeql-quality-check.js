#!/usr/bin/env node

const fs = require('node:fs');

const sarifPath = process.argv[2];

if (!sarifPath) {
  console.error('Usage: node scripts/codeql-quality-check.js <results.sarif>');
  process.exit(2);
}

// Gate source findings only. Build output and reporter/test artifacts are
// generated from source or third-party tooling and are reviewed through their
// source inputs instead.
const generatedPathPattern = /^(dist|node_modules|playwright-report|test-results)\//;
const sarif = JSON.parse(fs.readFileSync(sarifPath, 'utf8'));
const sourceFindings = [];
let totalFindings = 0;

for (const run of sarif.runs ?? []) {
  const rules = new Map((run.tool?.driver?.rules ?? []).map((rule) => [rule.id, rule]));

  for (const result of run.results ?? []) {
    totalFindings += 1;

    const location = result.locations?.[0]?.physicalLocation;
    const file = location?.artifactLocation?.uri ?? '';

    if (generatedPathPattern.test(file)) {
      continue;
    }

    const rule = rules.get(result.ruleId);
    const severity =
      rule?.properties?.['security-severity'] ??
      rule?.properties?.severity ??
      rule?.defaultConfiguration?.level ??
      result.level ??
      'none';

    sourceFindings.push({
      ruleId: result.ruleId,
      severity,
      message: result.message?.text ?? '',
      file,
      line: location?.region?.startLine,
    });
  }
}

console.log(
  JSON.stringify(
    {
      totalFindings,
      ignoredGeneratedFindings: totalFindings - sourceFindings.length,
      sourceFindings: sourceFindings.length,
    },
    null,
    2,
  ),
);

for (const finding of sourceFindings) {
  console.error(
    `${finding.ruleId} [${finding.severity}] ${finding.message} (${finding.file}:${finding.line ?? '?'})`,
  );
}

if (sourceFindings.length > 0) {
  process.exit(1);
}
