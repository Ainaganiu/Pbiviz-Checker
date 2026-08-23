// Static pattern scanning over the bundled visual code.
//
// This is deliberately conservative: everything here is *best-effort*. A clean
// result means nothing suspicious was found, never that nothing exists — the UI
// says so, and the confidence flag drops when the bundle is minified.

/** Hosts that appear in bundles as XML namespaces or license headers, not as network calls. */
const NON_NETWORK_HOSTS = new Set([
  'www.w3.org', 'w3.org', 'schemas.microsoft.com', 'json-schema.org',
  'purl.org', 'ns.adobe.com', 'sourceforge.net', 'creativecommons.org',
  'www.gnu.org', 'gnu.org', 'opensource.org', 'unlicense.org', 'localhost',
  'example.com', 'www.example.com', 'tools.ietf.org', 'developer.mozilla.org',
]);

/** Hosts that indicate the visual is phoning home with telemetry rather than fetching data. */
const TELEMETRY_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'analytics.google.com',
  'api.mixpanel.com', 'mixpanel.com', 'api.segment.io', 'cdn.segment.com',
  'sentry.io', 'ingest.sentry.io', 'api.amplitude.com', 'amplitude.com',
  'static.hotjar.com', 'hotjar.com', 'fullstory.com', 'bugsnag.com',
  'posthog.com', 'app.posthog.com', 'datadoghq.com', 'newrelic.com',
  'matomo.cloud', 'clarity.ms', 'doubleclick.net', 'connect.facebook.net',
  'track.customer.io', 'heap.io', 'logrocket.com',
];

const NETWORK_APIS = [
  { id: 'fetch', re: /\bfetch\s*\(/g, label: 'fetch()' },
  { id: 'xhr', re: /\bnew\s+XMLHttpRequest\b/g, label: 'XMLHttpRequest' },
  { id: 'axios', re: /\baxios\s*[.(]/g, label: 'axios' },
  { id: 'jquery-ajax', re: /\$\s*\.\s*(ajax|get|post|getJSON)\s*\(/g, label: 'jQuery ajax' },
  { id: 'websocket', re: /\bnew\s+WebSocket\b/g, label: 'WebSocket' },
  { id: 'beacon', re: /\bnavigator\s*\.\s*sendBeacon\s*\(/g, label: 'navigator.sendBeacon' },
  { id: 'eventsource', re: /\bnew\s+EventSource\b/g, label: 'EventSource' },
  { id: 'd3-fetch', re: /\bd3\s*\.\s*(json|csv|tsv|text|xml)\s*\(/g, label: 'd3 fetch helper' },
  { id: 'importscripts', re: /\bimportScripts\s*\(/g, label: 'importScripts' },
];

const STORAGE_APIS = [
  { id: 'localStorage', re: /\blocalStorage\b/g, label: 'localStorage' },
  { id: 'sessionStorage', re: /\bsessionStorage\b/g, label: 'sessionStorage' },
  { id: 'indexedDB', re: /\bindexedDB\b/g, label: 'indexedDB' },
  { id: 'cookie', re: /\bdocument\s*\.\s*cookie\b/g, label: 'document.cookie' },
];

/** The host-provided storage service — the *supported* way to persist state. */
const HOST_STORAGE = /\b(storageService|storageV2Service|ILocalVisualStorageService|IVisualLocalStorageV2Service)\b/;

const EXPORT_PATTERNS = [
  { id: 'downloadService', re: /\bdownloadService\b|\bexportVisualsContent\s*\(/g, label: 'host download service' },
  { id: 'objectUrl', re: /\bURL\s*\.\s*createObjectURL\s*\(/g, label: 'URL.createObjectURL' },
  { id: 'msSaveBlob', re: /\bmsSaveBlob\b|\bmsSaveOrOpenBlob\b/g, label: 'msSaveBlob' },
  { id: 'downloadAttr', re: /\bsetAttribute\s*\(\s*['"]download['"]/g, label: 'anchor download attribute' },
];

const KEYBOARD_PATTERNS = [
  { id: 'tabindex', re: /\btabindex\b/gi, label: 'tabindex' },
  { id: 'keydown', re: /\b(keydown|onkeydown)\b/g, label: 'keydown handler' },
  { id: 'keyup', re: /\b(keyup|keypress)\b/g, label: 'keyup / keypress handler' },
  { id: 'focus', re: /\.focus\s*\(\s*\)|\bfocusin\b/g, label: 'focus management' },
];

const ARIA_PATTERNS = [
  { id: 'aria-label', re: /\baria-label\b/g, label: 'aria-label' },
  { id: 'role', re: /['"]role['"]|\brole\s*=/g, label: 'role attribute' },
  { id: 'aria-any', re: /\baria-[a-z]+\b/g, label: 'aria-* attribute' },
  { id: 'svg-title', re: /append\s*\(\s*['"]title['"]\s*\)|<title[\s>]/g, label: 'SVG title element' },
];

const HIGH_CONTRAST_PATTERNS = [
  { id: 'isHighContrast', re: /\bisHighContrast\b/g, label: 'colorPalette.isHighContrast' },
  { id: 'hc-colors', re: /\bcolorPalette\s*\.\s*(foreground|background|foregroundSelected|hyperlink)\b/g, label: 'high-contrast palette colors' },
  { id: 'colorutils', re: /powerbi-visuals-utils-colorutils|\bColorUtils\b/g, label: 'colorutils' },
  { id: 'forced-colors', re: /forced-colors|-ms-high-contrast/g, label: 'forced-colors media query' },
];

const BLOCKER_PATTERNS = {
  eval: [
    { id: 'eval', re: /(?<![.\w$])eval\s*\(/g, label: 'eval()' },
    { id: 'new-function', re: /\bnew\s+Function\s*\(/g, label: 'new Function()' },
    { id: 'timeout-string', re: /\bset(Timeout|Interval)\s*\(\s*['"]/g, label: 'setTimeout with a string body' },
  ],
  scriptInjection: [
    { id: 'create-script', re: /createElement\s*\(\s*['"]script['"]\s*\)/g, label: 'document.createElement("script")' },
    { id: 'document-write', re: /\bdocument\s*\.\s*write(ln)?\s*\(/g, label: 'document.write()' },
    { id: 'script-tag', re: /<script[\s>]/g, label: 'inline script markup' },
    { id: 'dynamic-import', re: /\bimport\s*\(\s*[a-zA-Z_$]/g, label: 'dynamic import() with a computed specifier' },
  ],
  iframe: [
    { id: 'iframe-el', re: /createElement\s*\(\s*['"]iframe['"]\s*\)|<iframe[\s>]/g, label: 'iframe' },
    { id: 'srcdoc', re: /\bsrcdoc\b/g, label: 'iframe srcdoc' },
  ],
  csp: [
    { id: 'innerhtml', re: /\.innerHTML\s*=/g, label: 'innerHTML assignment' },
    { id: 'outerhtml', re: /\.outerHTML\s*=/g, label: 'outerHTML assignment' },
    { id: 'insert-adjacent', re: /insertAdjacentHTML\s*\(/g, label: 'insertAdjacentHTML' },
    { id: 'unsafe-inline', re: /unsafe-inline|unsafe-eval/g, label: 'unsafe-inline / unsafe-eval CSP directive' },
  ],
};

const COPYLEFT_MARKERS = [
  { re: /GNU\s+(Affero\s+)?General\s+Public\s+License/i, label: 'GPL / AGPL license header' },
  { re: /\bAGPL-3\.0\b|\bGPL-[23]\.0\b|\bLGPL-[23]/i, label: 'GPL-family SPDX identifier' },
  { re: /Mozilla\s+Public\s+License/i, label: 'MPL license header' },
];

function countMatches(source, patterns) {
  const hits = [];
  for (const { id, re, label } of patterns) {
    re.lastIndex = 0;
    const matches = source.match(re);
    if (matches && matches.length > 0) hits.push({ id, label, count: matches.length });
  }
  return hits;
}

function detectMinified(code) {
  if (!code) return { minified: false, maxLineLength: 0, lineCount: 0, avgLineLength: 0 };
  const lines = code.split('\n');
  let maxLineLength = 0;
  for (const line of lines) if (line.length > maxLineLength) maxLineLength = line.length;
  const avgLineLength = code.length / lines.length;
  // Either a single monstrous line, or consistently long lines across a large file.
  const minified = maxLineLength > 3000 || (code.length > 50_000 && avgLineLength > 300);
  return { minified, maxLineLength, lineCount: lines.length, avgLineLength: Math.round(avgLineLength) };
}

const URL_RE = /https?:\/\/[a-zA-Z0-9.\-_]+(?::\d+)?[^\s'"()\\]*/g;

function extractHosts(code) {
  const urls = code.match(URL_RE) ?? [];
  const hosts = new Map();
  for (const url of urls) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (NON_NETWORK_HOSTS.has(host) || !host.includes('.')) continue;
    const entry = hosts.get(host) ?? { host, count: 0, sample: url.slice(0, 140) };
    entry.count += 1;
    hosts.set(host, entry);
  }
  return [...hosts.values()].sort((a, b) => b.count - a.count);
}

function isTelemetryHost(host) {
  return TELEMETRY_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

export function scanCode(code = '', css = '') {
  const source = code ?? '';
  const combined = `${source}\n${css ?? ''}`;
  const minification = detectMinified(source);
  const hosts = extractHosts(source);

  const tryCount = (source.match(/\btry\s*\{/g) ?? []).length;
  const catchCount = (source.match(/\bcatch\s*[({]/g) ?? []).length;

  return {
    empty: source.trim().length === 0,
    length: source.length,
    minification,
    network: {
      apis: countMatches(source, NETWORK_APIS),
      hosts,
      telemetryHosts: hosts.filter((h) => isTelemetryHost(h.host)),
    },
    storage: {
      browserApis: countMatches(source, STORAGE_APIS),
      usesHostStorageService: HOST_STORAGE.test(source),
      exportApis: countMatches(source, EXPORT_PATTERNS),
    },
    accessibility: {
      keyboard: countMatches(source, KEYBOARD_PATTERNS),
      aria: countMatches(combined, ARIA_PATTERNS),
      highContrast: countMatches(combined, HIGH_CONTRAST_PATTERNS),
    },
    blockers: {
      eval: countMatches(source, BLOCKER_PATTERNS.eval),
      scriptInjection: countMatches(source, BLOCKER_PATTERNS.scriptInjection),
      iframe: countMatches(combined, BLOCKER_PATTERNS.iframe),
      csp: countMatches(combined, BLOCKER_PATTERNS.csp),
    },
    licenses: COPYLEFT_MARKERS.filter(({ re }) => re.test(source)).map(({ label }) => label),
    errorHandling: { tryCount, catchCount },
    hasInlineSourceMap: /\/\/[#@]\s*sourceMappingURL=/.test(source) || /"sourcesContent"\s*:/.test(source),
  };
}

export const _internals = { detectMinified, extractHosts, isTelemetryHost, TELEMETRY_HOSTS };
