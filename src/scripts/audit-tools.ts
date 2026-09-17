#!/usr/bin/env node
/**
 * Tool contract audit CLI.
 *
 * Thin wrapper: the rules themselves live in `src/audit/contract.ts` so they can
 * be exercised against synthetic tool descriptors. This script only fetches the
 * real catalogue from a running server and formats the findings.
 *
 * Runs against `tools/list` over stdio, so it validates what the model will
 * actually receive rather than what the source claims to register.
 *
 *   npm run audit:tools              # errors + warnings
 *   npm run audit:tools -- --strict  # warnings become failures too
 */

import { auditTools, type Finding } from '../audit/contract.js';
import { openStdioSession, resolveServerEntry } from './lib/stdio-session.js';

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const session = await openStdioSession({
    entry: resolveServerEntry(import.meta.url),
    env: { LOG_LEVEL: 'error' },
  });

  try {
    const tools = session.snapshot.tools;
    const names = tools.map((tool) => tool.name);

    const findings: Finding[] = auditTools(tools);
    // A corrupt stdio channel invalidates everything else, so it is reported here too.
    for (const anomaly of session.anomalies) {
      findings.push({ level: 'error', tool: '(transport)', rule: 'stdio', message: anomaly });
    }

    const errors = findings.filter((finding) => finding.level === 'error');
    const warnings = findings.filter((finding) => finding.level === 'warn');

    process.stderr.write(`Audited ${tools.length} tools: ${names.join(', ')}\n\n`);

    // Group by tool so the output reads as a review, not a log dump.
    const byTool = new Map<string, Finding[]>();
    for (const finding of [...errors, ...warnings]) {
      const bucket = byTool.get(finding.tool) ?? [];
      bucket.push(finding);
      byTool.set(finding.tool, bucket);
    }
    for (const [tool, bucket] of byTool) {
      process.stderr.write(`${tool}\n`);
      for (const finding of bucket) {
        process.stderr.write(`  ${finding.level === 'error' ? 'ERROR' : 'WARN '} [${finding.rule}] ${finding.message}\n`);
      }
      process.stderr.write('\n');
    }

    process.stderr.write(`${errors.length} error(s), ${warnings.length} warning(s)\n`);

    if (errors.length > 0 || (strict && warnings.length > 0)) {
      process.exitCode = 1;
      return;
    }
    process.stderr.write('TOOL CONTRACT AUDIT PASSED\n');
  } finally {
    await session.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
