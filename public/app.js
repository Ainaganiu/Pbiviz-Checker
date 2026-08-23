const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const progress = document.getElementById('progress');
const errorNotice = document.getElementById('error-notice');
const results = document.getElementById('results');
const categoriesEl = document.getElementById('categories');
const checkAnother = document.getElementById('check-another');

const STATUS_GLYPH = { pass: '✓', fail: '✕', skipped: '–' };
const STATUS_WORD = { pass: 'Pass', fail: 'Fail', skipped: 'Not checked' };
const BAND_COLOR = { ready: '#0f7a34', minor: '#b8860b', several: '#d2691e', blocked: '#c22626' };

// --- small DOM helpers ----------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setBusy(busy) {
  progress.hidden = !busy;
  dropzone.setAttribute('aria-disabled', String(busy));
}

function showError(message) {
  errorNotice.textContent = message;
  errorNotice.hidden = false;
}

function clearError() {
  errorNotice.hidden = true;
  errorNotice.textContent = '';
}

// --- rendering ------------------------------------------------------------

function renderScore(result) {
  const dial = document.getElementById('dial');
  dial.style.setProperty('--pct', result.score);
  dial.style.setProperty('--dial-color', BAND_COLOR[result.band.level] ?? BAND_COLOR.ready);
  dial.setAttribute('aria-label', `Compliance score ${result.score} out of 100 — ${result.band.label}`);
  document.getElementById('score-value').textContent = String(result.score);
  document.getElementById('score-band').textContent = `${result.band.emoji} ${result.band.label}`;

  const { passed, failed, skipped } = result.counts;
  const name = result.visual.displayName ? `${result.visual.displayName} · ` : '';
  document.getElementById('score-meta').textContent =
    `${name}${passed} passed, ${failed} failed, ${skipped} not checked across ${result.counts.total} rules.`;

  const chips = document.getElementById('score-chips');
  chips.replaceChildren();
  const severity = result.counts.bySeverity;
  for (const level of ['critical', 'high', 'medium', 'low']) {
    if (severity[level] > 0) {
      chips.append(el('span', `chip ${level === 'critical' ? 'chip-dark' : ''}`, `${severity[level]} ${level}`));
    }
  }
  if (result.visual.apiVersion) chips.append(el('span', 'chip chip-quiet', `API ${result.visual.apiVersion}`));
  if (result.detected.minified) chips.append(el('span', 'chip chip-quiet', 'minified bundle'));
  if (failed === 0) chips.append(el('span', 'chip', 'no failures'));
}

function renderConfidence(result) {
  const node = document.getElementById('confidence');
  node.className = `confidence level-${result.confidence.level}`;
  node.replaceChildren(el('strong', null, `${result.confidence.label}. `), document.createTextNode(result.confidence.reason));
}

function renderSummary(result) {
  const card = document.getElementById('summary-card');
  const text = document.getElementById('summary-text');
  const fixes = document.getElementById('summary-fixes');
  const attribution = document.getElementById('summary-attribution');

  fixes.replaceChildren();

  if (result.summary?.summary) {
    text.textContent = result.summary.summary;
    for (const fix of result.summary.fixes ?? []) fixes.append(el('li', null, fix));
    attribution.textContent = `Written by ${result.summary.provider} (${result.summary.model}) from the checklist result only — your file and code were not sent.`;
    card.hidden = false;
    return;
  }

  // No provider configured or every provider failed: fall back to the rule-based fixes.
  if (result.topFixes.length === 0) {
    card.hidden = true;
    return;
  }
  text.textContent = 'The plain-English summary is unavailable right now, so here are the highest-severity fixes straight from the checklist, most severe first.';
  for (const fix of result.topFixes) fixes.append(el('li', null, `${fix.id} — ${fix.reason}`));
  attribution.textContent = 'Generated from the rules directly; no language model was involved.';
  card.hidden = false;
}

function renderFinding(finding) {
  const row = el('div', `finding ${finding.status}`);
  const pill = el('span', `status-pill ${finding.status}`, STATUS_GLYPH[finding.status]);
  pill.title = STATUS_WORD[finding.status];
  row.append(pill);

  const body = el('div');
  const head = el('div', 'finding-head');
  head.append(el('span', 'finding-title', finding.title));
  head.append(el('span', 'rule-id', finding.id));
  head.append(el('span', `severity ${finding.severity}`, finding.severity));
  body.append(head);
  body.append(el('p', 'finding-reason', finding.reason));

  const links = el('div', 'finding-links');
  const doc = el('a', null, 'Microsoft Learn reference →');
  doc.href = finding.doc;
  doc.target = '_blank';
  doc.rel = 'noopener noreferrer';
  links.append(doc);
  if (finding.bestEffort) {
    const badge = el('span', 'best-effort', '🔍 Best-effort detection — static analysis only');
    badge.title = 'A pass here means nothing suspicious was found, not that nothing exists.';
    links.append(badge);
  }
  body.append(links);

  const details = finding.detectedHosts ?? finding.declaredDomains ?? finding.telemetryHosts;
  if (Array.isArray(details) && details.length > 0) {
    const ul = el('ul', 'detail-list');
    for (const item of details.slice(0, 8)) ul.append(el('li', null, item));
    body.append(ul);
  }
  if (Array.isArray(finding.vulnerable)) {
    const ul = el('ul', 'detail-list');
    for (const v of finding.vulnerable.slice(0, 8)) ul.append(el('li', null, `${v.name}@${v.version} — ${v.advisories.join(', ')}`));
    body.append(ul);
  }

  row.append(body);
  return row;
}

function renderCategories(result) {
  categoriesEl.replaceChildren();
  for (const category of result.categories) {
    const details = el('details', 'category');
    // Anything failing opens by default; clean categories stay collapsed.
    details.open = category.status === 'fail';

    const summary = el('summary', category.status);
    summary.append(el('span', 'caret', '▶'));
    const pill = el('span', `status-pill ${category.status}`, STATUS_GLYPH[category.status]);
    pill.title = STATUS_WORD[category.status];
    summary.append(pill);
    summary.append(el('span', null, category.label));
    summary.append(el('span', 'category-count',
      category.failed > 0
        ? `${category.failed} failing of ${category.findings.length}`
        : `${category.passed} of ${category.findings.length} passing`));
    details.append(summary);

    for (const finding of category.findings) details.append(renderFinding(finding));
    categoriesEl.append(details);
  }
}

function render(result) {
  renderScore(result);
  renderConfidence(result);
  renderSummary(result);
  renderCategories(result);
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- upload ---------------------------------------------------------------

async function check(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pbiviz')) {
    showError('That does not look like a .pbiviz file. Pick the package produced by `pbiviz package`.');
    return;
  }

  clearError();
  results.hidden = true;
  setBusy(true);

  const body = new FormData();
  body.append('file', file);

  try {
    const response = await fetch('/api/analyze', { method: 'POST', body });
    const payload = await response.json();
    if (!response.ok) {
      showError(payload.error ?? 'That file could not be analyzed.');
      return;
    }
    render(payload);
  } catch {
    showError('The check could not be completed — the connection dropped before a result came back. Nothing was stored.');
  } finally {
    setBusy(false);
    fileInput.value = '';
  }
}

browseBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  fileInput.click();
});
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => check(fileInput.files?.[0]));

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
  });
}
dropzone.addEventListener('drop', (event) => check(event.dataTransfer?.files?.[0]));

checkAnother.addEventListener('click', () => {
  results.hidden = true;
  clearError();
  dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
  fileInput.click();
});
