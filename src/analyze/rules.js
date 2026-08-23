// Central rule catalogue. Every finding the analyzer can emit is declared here so
// severities, copy and Microsoft Learn deep-links live in exactly one place.

export const SEVERITY_WEIGHTS = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
};

// One reference for every rule: the Power BI custom visuals documentation hub.
// Deep links into individual checklist pages get reorganised and 404; the hub
// is stable, so rows link there and carry the rule ID for the specific item.
const VISUALS_DOCS = 'https://learn.microsoft.com/en-us/power-bi/developer/visuals/';

// id -> { title, severity, doc, bestEffort }
// `bestEffort` marks rules that rely on pattern-scanning source rather than
// reading structured JSON — the UI renders the "best-effort detection" badge for these.
export const RULES = {
  // --- Manifest integrity -------------------------------------------------
  'MAN-001': { title: 'Manifest present and parseable', severity: 'high', doc: VISUALS_DOCS },
  'MAN-002': { title: 'API version declared and valid', severity: 'high', doc: VISUALS_DOCS },
  'MAN-003': { title: 'API version is currently supported', severity: 'high', doc: VISUALS_DOCS },
  'MAN-004': { title: 'Required manifest fields present', severity: 'high', doc: VISUALS_DOCS },
  'MAN-005': { title: 'Visual version is valid semver', severity: 'low', doc: VISUALS_DOCS },
  'MAN-006': { title: 'Support URL and description declared', severity: 'low', doc: VISUALS_DOCS },

  // --- External network calls --------------------------------------------
  'NET-001': { title: 'External network calls are declared', severity: 'critical', doc: VISUALS_DOCS, bestEffort: true },
  'NET-002': { title: 'Declared domains are specific, not wildcards', severity: 'high', doc: VISUALS_DOCS },
  'NET-003': { title: 'No undeclared telemetry / analytics endpoints', severity: 'critical', doc: VISUALS_DOCS, bestEffort: true },

  // --- Data export / local storage ---------------------------------------
  'STO-001': { title: 'Local storage usage is declared', severity: 'high', doc: VISUALS_DOCS, bestEffort: true },
  'STO-002': { title: 'Content export is declared', severity: 'critical', doc: VISUALS_DOCS, bestEffort: true },
  'STO-003': { title: 'No unsupported browser storage APIs', severity: 'high', doc: VISUALS_DOCS, bestEffort: true },

  // --- Accessibility ------------------------------------------------------
  'A11Y-001': { title: 'Keyboard navigation hooks present', severity: 'medium', doc: VISUALS_DOCS, bestEffort: true },
  'A11Y-002': { title: 'ARIA labels / roles present', severity: 'low', doc: VISUALS_DOCS, bestEffort: true },
  'A11Y-003': { title: 'High contrast mode support', severity: 'medium', doc: VISUALS_DOCS, bestEffort: true },

  // --- Certification blockers --------------------------------------------
  'BLK-001': { title: 'No eval() or dynamic code construction', severity: 'critical', doc: VISUALS_DOCS, bestEffort: true },
  'BLK-002': { title: 'No dynamic script injection', severity: 'critical', doc: VISUALS_DOCS, bestEffort: true },
  'BLK-003': { title: 'No iframe usage', severity: 'high', doc: VISUALS_DOCS, bestEffort: true },
  'BLK-004': { title: 'No CSP-unsafe DOM patterns', severity: 'medium', doc: VISUALS_DOCS, bestEffort: true },

  // --- Dependencies -------------------------------------------------------
  'DEP-001': { title: 'No known-vulnerable dependencies', severity: 'high', doc: VISUALS_DOCS },
  'DEP-002': { title: 'Dependency versions are pinned', severity: 'low', doc: VISUALS_DOCS },
  'DEP-003': { title: 'License declared and redistribution-safe', severity: 'low', doc: VISUALS_DOCS },

  // --- Packaging / hygiene -----------------------------------------------
  'PKG-001': { title: 'No source maps bundled', severity: 'medium', doc: VISUALS_DOCS },
  'PKG-002': { title: 'Icon and assets complete', severity: 'medium', doc: VISUALS_DOCS },
  'PKG-003': { title: 'Localization resources declared', severity: 'low', doc: VISUALS_DOCS },
  'PKG-004': { title: 'Bundle size within recommended limit', severity: 'low', doc: VISUALS_DOCS },
  'PKG-005': { title: 'Error handling around risky operations', severity: 'low', doc: VISUALS_DOCS, bestEffort: true },
};

// Ordered category definitions — drives both the analyzer and the results table.
export const CATEGORIES = [
  { id: 'manifest', label: 'Manifest integrity', rules: ['MAN-001', 'MAN-002', 'MAN-003', 'MAN-004', 'MAN-005', 'MAN-006'] },
  { id: 'network', label: 'External network calls', rules: ['NET-001', 'NET-002', 'NET-003'] },
  { id: 'storage', label: 'Data export / local storage', rules: ['STO-001', 'STO-002', 'STO-003'] },
  { id: 'accessibility', label: 'Accessibility', rules: ['A11Y-001', 'A11Y-002', 'A11Y-003'] },
  { id: 'blockers', label: 'Certification blockers', rules: ['BLK-001', 'BLK-002', 'BLK-003', 'BLK-004'] },
  { id: 'dependencies', label: 'Dependencies', rules: ['DEP-001', 'DEP-002', 'DEP-003'] },
  { id: 'packaging', label: 'Packaging & hygiene', rules: ['PKG-001', 'PKG-002', 'PKG-003', 'PKG-004', 'PKG-005'] },
];

export function ruleMeta(id) {
  const rule = RULES[id];
  if (!rule) throw new Error(`Unknown rule id: ${id}`);
  return rule;
}
