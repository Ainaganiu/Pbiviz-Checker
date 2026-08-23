import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

import { analyze, ExtractionError } from '../src/analyze/index.js';
import { scanCode } from '../src/analyze/codeScan.js';
import { readPrivileges } from '../src/analyze/checks.js';
import { scoreFindings } from '../src/analyze/score.js';

// A 20x20 PNG, base64 — just enough header for the IHDR read.
const ICON_20 = 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';

function buildPbiviz({ capabilities = {}, code = '', apiVersion = '5.11.0', visual = {}, stringResources, icon = ICON_20 } = {}) {
  const resource = {
    apiVersion,
    visual: {
      name: 'testVisual',
      displayName: 'Test Visual',
      guid: 'testVisual1A2B3C',
      visualClassName: 'Visual',
      version: '1.0.0',
      description: 'A visual used in tests.',
      supportUrl: 'https://example.invalid/support',
      ...visual,
    },
    author: { name: 'Tester', email: 'tester@example.invalid' },
    capabilities,
    stringResources: stringResources ?? { en: { name: 'Test Visual' } },
    content: { js: code, css: '', iconBase64: icon },
  };
  return Buffer.from(zipSync({
    'package.json': strToU8(JSON.stringify({ version: '1.0.0', resources: [{ file: 'resources/visual.pbiviz.json' }] })),
    'resources/visual.pbiviz.json': strToU8(JSON.stringify(resource)),
  }));
}

function findingById(result, id) {
  for (const category of result.categories) {
    const match = category.findings.find((f) => f.id === id);
    if (match) return match;
  }
  throw new Error(`finding ${id} not produced`);
}

test('rejects something that is not a zip', async () => {
  await assert.rejects(() => analyze(Buffer.from('not a zip at all')), ExtractionError);
});

test('rejects a zip that is not a Power BI visual', async () => {
  const zip = Buffer.from(zipSync({ 'readme.txt': strToU8('hello') }));
  await assert.rejects(() => analyze(zip), ExtractionError);
});

test('a clean visual scores well and reports high-level metadata', async () => {
  const code = `
    class Visual {
      constructor(options) {
        this.el = options.element;
        this.el.setAttribute('tabindex', '0');
        this.el.setAttribute('aria-label', 'Test visual');
        this.el.addEventListener('keydown', () => {});
      }
      update(options) {
        const hc = options.host.colorPalette.isHighContrast;
        if (hc) { this.paint(options.host.colorPalette.foreground); }
      }
    }
  `;
  const result = await analyze(buildPbiviz({ code }));

  assert.equal(result.visual.apiVersion, '5.11.0');
  assert.equal(result.visual.displayName, 'Test Visual');
  assert.equal(findingById(result, 'NET-001').status, 'pass');
  assert.equal(findingById(result, 'A11Y-001').status, 'pass');
  assert.equal(findingById(result, 'A11Y-003').status, 'pass');
  assert.equal(findingById(result, 'BLK-001').status, 'pass');
  assert.equal(findingById(result, 'PKG-002').status, 'pass');
  assert.ok(result.score >= 90, `expected a high score, got ${result.score}`);
  assert.equal(result.band.level, 'ready');
});

test('an undeclared external call fails NET-001 and names the domain', async () => {
  const code = `fetch("https://api.weatherapi.com/v1/current.json?key=x").then(r => r.json());`;
  const result = await analyze(buildPbiviz({ code }));
  const net = findingById(result, 'NET-001');

  assert.equal(net.status, 'fail');
  assert.match(net.reason, /api\.weatherapi\.com/);
  assert.equal(net.severity, 'critical');
  assert.deepEqual(result.detected.hosts, ['api.weatherapi.com']);
});

test('a declared external call passes and echoes the declared domains', async () => {
  const code = `fetch("https://api.weatherapi.com/v1/current.json");`;
  const capabilities = { privileges: [{ name: 'WebAccess', essential: true, parameters: ['https://api.weatherapi.com'] }] };
  const net = findingById(await analyze(buildPbiviz({ code, capabilities })), 'NET-001');

  assert.equal(net.status, 'pass');
  assert.deepEqual(net.declaredDomains, ['https://api.weatherapi.com']);
});

test('an unresolvable destination says so rather than passing quietly', async () => {
  const code = `const u = base + path; fetch(u);`;
  const net = findingById(await analyze(buildPbiviz({ code })), 'NET-001');

  assert.equal(net.status, 'fail');
  assert.equal(net.unresolvedDestination, true);
  assert.match(net.reason, /couldn't|could not be determined/i);
});

test('wildcard domain patterns are flagged, specific subdomains are not', async () => {
  const broad = { privileges: [{ name: 'WebAccess', parameters: ['https://*.com'] }] };
  const narrow = { privileges: [{ name: 'WebAccess', parameters: ['https://*.contoso.com'] }] };

  assert.equal(findingById(await analyze(buildPbiviz({ capabilities: broad })), 'NET-002').status, 'fail');
  assert.equal(findingById(await analyze(buildPbiviz({ capabilities: narrow })), 'NET-002').status, 'pass');
});

test('telemetry endpoints are called out separately from data calls', async () => {
  const code = `navigator.sendBeacon("https://api.mixpanel.com/track", payload);`;
  const result = await analyze(buildPbiviz({ code }));

  assert.equal(findingById(result, 'NET-003').status, 'fail');
  assert.deepEqual(result.detected.telemetryHosts, ['api.mixpanel.com']);
});

test('undeclared localStorage fails, declared localStorage passes', async () => {
  const code = `localStorage.setItem("k", "v");`;
  assert.equal(findingById(await analyze(buildPbiviz({ code })), 'STO-001').status, 'fail');

  const declared = { privileges: [{ name: 'LocalStorage' }] };
  assert.equal(findingById(await analyze(buildPbiviz({ code, capabilities: declared })), 'STO-001').status, 'pass');
});

test('eval and iframes are certification blockers', async () => {
  const code = `eval("1+1"); const f = document.createElement("iframe");`;
  const result = await analyze(buildPbiviz({ code }));

  assert.equal(findingById(result, 'BLK-001').status, 'fail');
  assert.equal(findingById(result, 'BLK-003').status, 'fail');
  assert.ok(result.score < 70, `expected blockers to sink the score, got ${result.score}`);
});

test('an old API version fails the certification floor', async () => {
  const result = await analyze(buildPbiviz({ apiVersion: '2.6.0' }));
  assert.equal(findingById(result, 'MAN-003').status, 'fail');
});

test('a missing guid fails the required-fields check', async () => {
  const result = await analyze(buildPbiviz({ visual: { guid: '' } }));
  const man = findingById(result, 'MAN-004');
  assert.equal(man.status, 'fail');
  assert.match(man.reason, /guid/);
});

test('dependency checks are skipped, not failed, when no npm manifest is bundled', async () => {
  const dep = findingById(await analyze(buildPbiviz({})), 'DEP-001');
  assert.equal(dep.status, 'skipped');
});

test('a bundled source map is reported', async () => {
  const zip = Buffer.from(zipSync({
    'pbiviz.json': strToU8(JSON.stringify({ apiVersion: '5.11.0', visual: { name: 'v', guid: 'g', displayName: 'V', visualClassName: 'Visual', version: '1.0.0' } })),
    'visual.js': strToU8('const a = 1;'),
    'visual.js.map': strToU8('{"version":3}'),
  }));
  const result = await analyze(zip);
  assert.equal(findingById(result, 'PKG-001').status, 'fail');
  assert.equal(result.visual.layout, 'loose');
});

test('minified code drops the score confidence to low', async () => {
  const code = `var a=1;${'b'.repeat(4000)}`;
  const result = await analyze(buildPbiviz({ code }));
  assert.equal(result.confidence.level, 'low');
  assert.match(result.confidence.reason, /minified/);
});

test('scanner ignores w3.org namespaces that appear in every SVG bundle', () => {
  const scan = scanCode('const NS = "http://www.w3.org/2000/svg";');
  assert.deepEqual(scan.network.hosts, []);
});

test('privileges are read case-insensitively', () => {
  const privileges = readPrivileges({ privileges: [{ name: 'webAccess', parameters: ['https://a.example'] }] });
  assert.ok(privileges.webAccess);
  assert.deepEqual(privileges.webAccess.parameters, ['https://a.example']);
});

test('score floors at zero and orders fixes by severity weight', () => {
  const byCategory = {
    network: [
      { id: 'NET-001', title: 'a', severity: 'critical', doc: '#', status: 'fail', reason: 'r', bestEffort: true },
      { id: 'NET-002', title: 'b', severity: 'high', doc: '#', status: 'fail', reason: 'r' },
    ],
    blockers: [
      { id: 'BLK-001', title: 'c', severity: 'critical', doc: '#', status: 'fail', reason: 'r', bestEffort: true },
      { id: 'BLK-002', title: 'd', severity: 'critical', doc: '#', status: 'fail', reason: 'r', bestEffort: true },
      { id: 'BLK-003', title: 'e', severity: 'high', doc: '#', status: 'fail', reason: 'r' },
      { id: 'BLK-004', title: 'f', severity: 'medium', doc: '#', status: 'fail', reason: 'r' },
    ],
  };
  const scored = scoreFindings(byCategory, { empty: false, minification: { minified: false } });

  assert.equal(scored.score, 0);
  assert.equal(scored.counts.bySeverity.critical, 3);
  assert.deepEqual(scored.topFixes.map((f) => f.severity), ['critical', 'critical', 'critical']);
});
