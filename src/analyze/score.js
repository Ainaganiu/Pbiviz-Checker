import { SEVERITY_WEIGHTS, CATEGORIES } from './rules.js';

const BANDS = [
  { min: 90, level: 'ready', emoji: '🟢', label: 'AppSource-ready' },
  { min: 70, level: 'minor', emoji: '🟡', label: 'Minor fixes needed' },
  { min: 40, level: 'several', emoji: '🟠', label: 'Several issues to resolve' },
  { min: 0, level: 'blocked', emoji: '🔴', label: 'Not ready — critical issues found' },
];

/**
 * Confidence describes how much the *score* can be trusted, not any single row.
 *  high   — every failing check read structured JSON (manifest / capabilities)
 *  medium — pattern checks ran against readable source
 *  low    — pattern checks ran against minified or obfuscated code
 */
export function computeConfidence(findings, scan) {
  if (scan.empty) {
    return {
      level: 'low',
      label: 'Low confidence',
      reason: 'No bundled script could be read from this package, so every pattern-based check was inconclusive.',
    };
  }
  if (scan.minification.minified) {
    return {
      level: 'low',
      label: 'Low confidence',
      reason: "This visual's code is minified — the score may miss issues that static scanning can't see.",
    };
  }
  const anyBestEffort = findings.some((f) => f.bestEffort && f.status !== 'skipped');
  if (!anyBestEffort) {
    return {
      level: 'high',
      label: 'High confidence',
      reason: 'Every check that ran read structured JSON rather than scanning code.',
    };
  }
  return {
    level: 'medium',
    label: 'Medium confidence',
    reason: 'Pattern-based checks ran against readable, unminified code.',
  };
}

export function scoreFindings(byCategory, scan) {
  const categories = CATEGORIES.map((category) => {
    const findings = byCategory[category.id] ?? [];
    const failed = findings.filter((f) => f.status === 'fail');
    return {
      id: category.id,
      label: category.label,
      status: failed.length > 0 ? 'fail' : findings.every((f) => f.status === 'skipped') ? 'skipped' : 'pass',
      passed: findings.filter((f) => f.status === 'pass').length,
      failed: failed.length,
      skipped: findings.filter((f) => f.status === 'skipped').length,
      findings,
    };
  });

  const allFindings = categories.flatMap((c) => c.findings);
  const failures = allFindings.filter((f) => f.status === 'fail');

  let deductions = 0;
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const failure of failures) {
    deductions += SEVERITY_WEIGHTS[failure.severity] ?? 0;
    bySeverity[failure.severity] += 1;
  }

  const score = Math.max(0, 100 - deductions);
  const band = BANDS.find((b) => score >= b.min);

  // Fixes are ordered by severity weight, then by the order rules are declared.
  const topFixes = [...failures]
    .sort((a, b) => (SEVERITY_WEIGHTS[b.severity] ?? 0) - (SEVERITY_WEIGHTS[a.severity] ?? 0))
    .slice(0, 3)
    .map((f) => ({ id: f.id, title: f.title, severity: f.severity, reason: f.reason, doc: f.doc }));

  return {
    score,
    band,
    deductions,
    counts: {
      total: allFindings.length,
      passed: allFindings.filter((f) => f.status === 'pass').length,
      failed: failures.length,
      skipped: allFindings.filter((f) => f.status === 'skipped').length,
      bySeverity,
    },
    categories,
    topFixes,
    confidence: computeConfidence(allFindings, scan),
  };
}
