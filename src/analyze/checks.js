import { ruleMeta } from './rules.js';
import { collectDependencies, findLooseRanges, licenseIsCopyleft, queryOsv } from './dependencies.js';

// The lowest API version AppSource currently accepts for certification.
// Kept here as a single constant so it can be bumped when Microsoft moves the floor.
export const MIN_CERTIFIED_API_VERSION = process.env.MIN_CERTIFIED_API_VERSION ?? '5.3.0';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const BUNDLE_SIZE_LIMIT = Number(process.env.BUNDLE_SIZE_LIMIT_BYTES ?? 2 * 1024 * 1024);

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function finding(id, status, reason, extra = {}) {
  const meta = ruleMeta(id);
  return {
    id,
    title: meta.title,
    severity: meta.severity,
    doc: meta.doc,
    bestEffort: Boolean(meta.bestEffort),
    status, // 'pass' | 'fail' | 'skipped'
    reason,
    ...extra,
  };
}

const pass = (id, reason, extra) => finding(id, 'pass', reason, extra);
const fail = (id, reason, extra) => finding(id, 'fail', reason, extra);
const skip = (id, reason, extra) => finding(id, 'skipped', reason, extra);

const list = (items, max = 4) => {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
};

// --- privileges -----------------------------------------------------------

export function readPrivileges(capabilities) {
  const raw = Array.isArray(capabilities?.privileges) ? capabilities.privileges : [];
  const byName = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry.name !== 'string') continue;
    byName.set(entry.name.toLowerCase(), {
      name: entry.name,
      essential: entry.essential !== false,
      parameters: Array.isArray(entry.parameters) ? entry.parameters.filter((p) => typeof p === 'string') : [],
    });
  }
  return {
    declared: raw.length > 0,
    webAccess: byName.get('webaccess') ?? null,
    localStorage: byName.get('localstorage') ?? null,
    exportContent: byName.get('exportcontent') ?? null,
    all: [...byName.values()],
  };
}

// Two-label public suffixes, so `*.co.uk` is recognised as swallowing a whole TLD
// rather than looking like a legitimate `*.contoso.com`.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.nz', 'com.br', 'com.cn', 'co.in', 'co.za', 'com.mx',
]);

/** A wildcard is only acceptable when it stands in for a subdomain of a real domain. */
function overlyBroadPatterns(parameters) {
  return parameters.filter((pattern) => {
    const host = pattern.trim().replace(/^\*?:?\/*/, '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    if (host === '' || host === '*' || host === '*.*') return true;
    if (!host.startsWith('*.')) return false;
    const rest = host.slice(2);
    // `*.com` swallows every .com; `*.co.uk` swallows every UK domain.
    return !rest.includes('.') || MULTI_LABEL_SUFFIXES.has(rest);
  });
}

// --- category checks ------------------------------------------------------

function checkManifest(pkg) {
  const out = [];
  const manifest = pkg.manifest;
  const visual = manifest?.visual ?? null;

  if (!manifest) {
    out.push(fail('MAN-001', 'No pbiviz manifest was found in the package.'));
    return out;
  }
  out.push(pass('MAN-001', `Manifest read from the ${pkg.layout === 'packaged' ? 'packaged resources file' : 'pbiviz.json'}.`));

  const apiVersion = manifest.apiVersion;
  if (!apiVersion || !SEMVER.test(String(apiVersion))) {
    out.push(fail('MAN-002', apiVersion ? `apiVersion "${apiVersion}" is not a valid version string.` : 'No apiVersion is declared.'));
    out.push(skip('MAN-003', 'Cannot compare an API version that is missing or malformed.'));
  } else {
    out.push(pass('MAN-002', `Declares API version ${apiVersion}.`));
    if (compareVersions(apiVersion, MIN_CERTIFIED_API_VERSION) < 0) {
      out.push(fail('MAN-003', `API ${apiVersion} is below the ${MIN_CERTIFIED_API_VERSION} floor AppSource certification requires.`));
    } else {
      out.push(pass('MAN-003', `API ${apiVersion} meets the ${MIN_CERTIFIED_API_VERSION} certification floor.`));
    }
  }

  const required = [
    ['guid', visual?.guid],
    ['visualClassName', visual?.visualClassName],
    ['displayName', visual?.displayName],
    ['name', visual?.name],
    ['version', visual?.version],
  ];
  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    out.push(fail('MAN-004', `Missing required manifest field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`));
  } else {
    out.push(pass('MAN-004', 'guid, name, visualClassName, displayName and version are all present.'));
  }

  const version = visual?.version;
  if (!version) {
    out.push(skip('MAN-005', 'No version field to validate.'));
  } else if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(String(version))) {
    out.push(fail('MAN-005', `Version "${version}" is not a valid version number.`));
  } else {
    out.push(pass('MAN-005', `Version ${version} is well formed.`));
  }

  const softMissing = [];
  if (!visual?.description) softMissing.push('description');
  if (!visual?.supportUrl) softMissing.push('supportUrl');
  if (!manifest.author?.name && !manifest.author?.email) softMissing.push('author');
  if (softMissing.length > 0) {
    out.push(fail('MAN-006', `AppSource submission expects ${softMissing.join(', ')} in the manifest.`));
  } else {
    out.push(pass('MAN-006', 'Description, support URL and author details are declared.'));
  }

  return out;
}

function checkNetwork(pkg, scan, privileges) {
  const out = [];
  const apis = scan.network.apis;
  const hosts = scan.network.hosts.filter((h) => !scan.network.telemetryHosts.some((t) => t.host === h.host));
  const declared = privileges.webAccess;
  const declaredParams = declared?.parameters ?? [];

  const callsDetected = apis.length > 0 || hosts.length > 0;

  if (!callsDetected) {
    out.push(pass('NET-001', declared
      ? 'No outbound calls were found in the bundled code, though WebAccess is declared — consider removing the unused privilege.'
      : 'No outbound network calls were found in the bundled code.'));
  } else if (declared) {
    const where = hosts.length > 0
      ? `Calls out to ${list(hosts.map((h) => h.host))}.`
      : 'Outbound call APIs are present but the destination could not be resolved statically.';
    out.push(pass('NET-001', `WebAccess is declared, so this is disclosed. ${where}`, {
      detectedApis: apis.map((a) => a.label),
      detectedHosts: hosts.map((h) => h.host),
      declaredDomains: declaredParams,
    }));
  } else if (hosts.length > 0) {
    out.push(fail('NET-001', `This visual calls out to ${list(hosts.map((h) => h.host))} but declares no WebAccess privilege.`, {
      detectedApis: apis.map((a) => a.label),
      detectedHosts: hosts.map((h) => h.host),
    }));
  } else {
    out.push(fail('NET-001', 'This visual makes external calls, but the destination could not be determined from static analysis. If you are the developer, declare the WebAccess privilege and disclose this endpoint to your users.', {
      detectedApis: apis.map((a) => a.label),
      unresolvedDestination: true,
    }));
  }

  if (!declared) {
    out.push(skip('NET-002', 'No WebAccess privilege is declared, so there are no domain patterns to review.'));
  } else if (declaredParams.length === 0) {
    out.push(fail('NET-002', 'WebAccess is declared without any domain parameters — AppSource requires the specific endpoints to be listed.'));
  } else {
    const broad = overlyBroadPatterns(declaredParams);
    if (broad.length > 0) {
      out.push(fail('NET-002', `Declared domain pattern${broad.length > 1 ? 's are' : ' is'} too broad: ${list(broad)}. Reviewers reject wildcards that cover a whole TLD.`, { declaredDomains: declaredParams }));
    } else {
      out.push(pass('NET-002', `Declares ${declaredParams.length} specific domain pattern${declaredParams.length > 1 ? 's' : ''}: ${list(declaredParams)}.`, { declaredDomains: declaredParams }));
    }
  }

  const telemetry = scan.network.telemetryHosts;
  if (telemetry.length === 0) {
    out.push(pass('NET-003', 'No known analytics or telemetry endpoints were found.'));
  } else {
    const named = list(telemetry.map((t) => t.host));
    const covered = declared && declaredParams.some((p) => telemetry.some((t) => p.includes(t.host.replace(/^www\./, ''))));
    if (covered) {
      out.push(pass('NET-003', `Contacts telemetry endpoints (${named}), and these are covered by the declared WebAccess domains.`, { telemetryHosts: telemetry.map((t) => t.host) }));
    } else {
      out.push(fail('NET-003', `This visual phones home to ${named} without declaring it. Telemetry endpoints must be disclosed to users.`, { telemetryHosts: telemetry.map((t) => t.host) }));
    }
  }

  return out;
}

function checkStorage(scan, privileges) {
  const out = [];
  const browser = scan.storage.browserApis;
  const usesLocal = browser.some((b) => b.id === 'localStorage' || b.id === 'sessionStorage');
  const unsupported = browser.filter((b) => b.id === 'indexedDB' || b.id === 'cookie');
  const exportApis = scan.storage.exportApis;

  if (!usesLocal && !scan.storage.usesHostStorageService) {
    out.push(pass('STO-001', privileges.localStorage
      ? 'LocalStorage is declared but no storage usage was found — consider removing the unused privilege.'
      : 'No browser or host storage usage was found.'));
  } else if (privileges.localStorage) {
    out.push(pass('STO-001', scan.storage.usesHostStorageService
      ? 'Uses the host storage service and declares the LocalStorage privilege.'
      : `Uses ${list(browser.filter((b) => b.id === 'localStorage' || b.id === 'sessionStorage').map((b) => b.label))} with the LocalStorage privilege declared.`));
  } else {
    out.push(fail('STO-001', `Uses ${list(browser.map((b) => b.label))} without declaring the LocalStorage privilege. Persisting state also requires the host storage service rather than the raw browser API.`));
  }

  if (exportApis.length === 0) {
    out.push(pass('STO-002', privileges.exportContent
      ? 'ExportContent is declared but no export code was found — consider removing the unused privilege.'
      : 'No content export or file download code was found.'));
  } else if (privileges.exportContent) {
    out.push(pass('STO-002', `Exports content via ${list(exportApis.map((e) => e.label))}, and ExportContent is declared.`));
  } else {
    out.push(fail('STO-002', `Exports data via ${list(exportApis.map((e) => e.label))} without declaring the ExportContent privilege.`));
  }

  if (unsupported.length === 0) {
    out.push(pass('STO-003', 'No unsupported browser storage APIs are used.'));
  } else {
    out.push(fail('STO-003', `Uses ${list(unsupported.map((u) => u.label))}, which is not available to visuals in the Power BI sandbox.`));
  }

  return out;
}

function checkAccessibility(scan) {
  const out = [];
  const { keyboard, aria, highContrast } = scan.accessibility;

  if (keyboard.length === 0) {
    out.push(fail('A11Y-001', 'No tabindex, key handlers or focus management were found — the visual is likely unreachable by keyboard.'));
  } else {
    out.push(pass('A11Y-001', `Keyboard support signals found: ${list(keyboard.map((k) => k.label))}.`));
  }

  if (aria.length === 0) {
    out.push(fail('A11Y-002', 'No aria-* attributes, role attributes or SVG title elements were found, so rendered content has no text alternative.'));
  } else {
    out.push(pass('A11Y-002', `Accessible naming signals found: ${list(aria.map((a) => a.label))}.`));
  }

  if (highContrast.length === 0) {
    out.push(fail('A11Y-003', 'No high contrast handling was found. Read colorPalette.isHighContrast and repaint using the host foreground/background colors.'));
  } else {
    out.push(pass('A11Y-003', `High contrast support found: ${list(highContrast.map((h) => h.label))}.`));
  }

  return out;
}

function checkBlockers(scan) {
  const out = [];
  const { eval: evalHits, scriptInjection, iframe, csp } = scan.blockers;

  if (evalHits.length === 0) {
    out.push(pass('BLK-001', 'No eval() or dynamic function construction was found.'));
  } else {
    out.push(fail('BLK-001', `Found ${list(evalHits.map((e) => `${e.label} x${e.count}`))}. This is an automatic certification blocker — it often comes from a webpack "eval" devtool setting, so check your production build config.`));
  }

  if (scriptInjection.length === 0) {
    out.push(pass('BLK-002', 'No dynamic script injection was found.'));
  } else {
    out.push(fail('BLK-002', `Found ${list(scriptInjection.map((s) => s.label))}. Visuals may not load or inject external script at runtime.`));
  }

  if (iframe.length === 0) {
    out.push(pass('BLK-003', 'No iframe usage was found.'));
  } else {
    out.push(fail('BLK-003', `Found ${list(iframe.map((i) => i.label))}. Iframes are flagged during certification review and are usually rejected.`));
  }

  const unsafeCsp = csp.filter((c) => c.id === 'unsafe-inline');
  const htmlSinks = csp.filter((c) => c.id !== 'unsafe-inline');
  if (csp.length === 0) {
    out.push(pass('BLK-004', 'No CSP-unsafe DOM patterns were found.'));
  } else if (unsafeCsp.length > 0) {
    out.push(fail('BLK-004', `Found an ${list(unsafeCsp.map((c) => c.label))} directive, which the Power BI sandbox will not permit.`));
  } else {
    out.push(fail('BLK-004', `Found ${list(htmlSinks.map((c) => `${c.label} x${c.count}`))}. These raw HTML sinks are a review flag — build nodes with the DOM API or sanitise input first.`));
  }

  return out;
}

async function checkDependencies(pkg, scan) {
  const out = [];
  const dependencies = collectDependencies(pkg.npmManifest);

  if (!pkg.npmManifest) {
    out.push(skip('DEP-001', 'No npm package.json is bundled in a packaged .pbiviz, so dependencies could not be resolved. Run this check in CI against your source repo.'));
    out.push(skip('DEP-002', 'No npm package.json is bundled, so version ranges could not be reviewed.'));
  } else {
    const osv = await queryOsv(dependencies);
    if (osv.status === 'unavailable') {
      out.push(skip('DEP-001', `Dependencies were not checked because ${osv.error}.`, { dependencyCount: dependencies.length }));
    } else if (osv.status === 'skipped') {
      out.push(skip('DEP-001', 'No dependency resolved to a concrete version, so nothing could be queried against the vulnerability database.'));
    } else if (osv.vulnerable.length === 0) {
      out.push(pass('DEP-001', `Checked ${osv.checked} dependenc${osv.checked === 1 ? 'y' : 'ies'} against OSV.dev — no known vulnerabilities.`));
    } else {
      out.push(fail('DEP-001', `${osv.vulnerable.length} dependenc${osv.vulnerable.length === 1 ? 'y has' : 'ies have'} known vulnerabilities: ${list(osv.vulnerable.map((v) => `${v.name}@${v.version}`))}.`, {
        vulnerable: osv.vulnerable,
      }));
    }

    const loose = findLooseRanges(dependencies);
    if (loose.length === 0) {
      out.push(pass('DEP-002', `All ${dependencies.length} dependencies are pinned to exact versions.`));
    } else {
      out.push(fail('DEP-002', `${loose.length} of ${dependencies.length} dependencies use a loose range (${list(loose.map((d) => `${d.name}@${d.range}`))}), so a rebuild can silently pull a different version.`));
    }
  }

  const declared = pkg.declaredLicense;
  const copyleftHeaders = scan.licenses;
  if (!declared && copyleftHeaders.length === 0) {
    out.push(fail('DEP-003', 'No license field is declared in the package metadata.'));
  } else if (licenseIsCopyleft(declared)) {
    out.push(fail('DEP-003', `The declared license "${declared}" is copyleft, which creates redistribution obligations for a commercial AppSource listing.`));
  } else if (copyleftHeaders.length > 0) {
    out.push(fail('DEP-003', `Declared license is "${declared ?? 'none'}", but the bundle contains ${list(copyleftHeaders)} — a bundled dependency may be copyleft.`));
  } else {
    out.push(pass('DEP-003', `Declares the "${declared}" license and no copyleft headers were found in the bundle.`));
  }

  return out;
}

function checkPackaging(pkg, scan) {
  const out = [];

  const maps = pkg.sourceMapFiles;
  if (maps.length === 0 && !scan.hasInlineSourceMap) {
    out.push(pass('PKG-001', 'No source maps are bundled.'));
  } else if (maps.length > 0) {
    out.push(fail('PKG-001', `Bundles ${maps.length} source map file${maps.length > 1 ? 's' : ''} (${list(maps)}), which publishes your original source and comments.`));
  } else {
    out.push(fail('PKG-001', 'The bundle contains an inline source map, which publishes your original source and comments.'));
  }

  if (!pkg.icon) {
    out.push(fail('PKG-002', 'No icon was found. AppSource requires a 20x20 PNG at assets/icon.png.'));
  } else if (pkg.icon.width && (pkg.icon.width !== 20 || pkg.icon.height !== 20)) {
    out.push(fail('PKG-002', `The icon is ${pkg.icon.width}x${pkg.icon.height}; AppSource requires exactly 20x20.`));
  } else {
    out.push(pass('PKG-002', 'A 20x20 PNG icon is present.'));
  }

  const hasStrings = Boolean(pkg.stringResources && Object.keys(pkg.stringResources).length > 0) || pkg.hasStringResourceFolder;
  if (hasStrings) {
    const locales = pkg.stringResources ? Object.keys(pkg.stringResources) : [];
    out.push(pass('PKG-003', locales.length > 0
      ? `Ships string resources for ${list(locales)}.`
      : 'Ships a string resources folder.'));
  } else {
    out.push(fail('PKG-003', 'No stringResources were found — user-facing text appears to be hardcoded rather than declared per locale.'));
  }

  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (pkg.packagedSize <= BUNDLE_SIZE_LIMIT) {
    out.push(pass('PKG-004', `Package is ${mb(pkg.packagedSize)}, within the ${mb(BUNDLE_SIZE_LIMIT)} guideline.`));
  } else {
    out.push(fail('PKG-004', `Package is ${mb(pkg.packagedSize)}, over the ${mb(BUNDLE_SIZE_LIMIT)} guideline — check for unexpected bundled dependencies.`));
  }

  const risky = scan.network.apis.length > 0 || scan.storage.exportApis.length > 0;
  const { tryCount, catchCount } = scan.errorHandling;
  if (!risky) {
    out.push(pass('PKG-005', 'No external calls or export code that would need dedicated error handling.'));
  } else if (catchCount === 0) {
    out.push(fail('PKG-005', 'This visual makes external calls but contains no catch blocks — an unhandled rejection will crash the visual on the canvas.'));
  } else {
    out.push(pass('PKG-005', `Found ${tryCount} try / ${catchCount} catch blocks around risky operations.`));
  }

  return out;
}

export async function runChecks(pkg, scan) {
  const privileges = readPrivileges(pkg.capabilities);
  const byCategory = {
    manifest: checkManifest(pkg),
    network: checkNetwork(pkg, scan, privileges),
    storage: checkStorage(scan, privileges),
    accessibility: checkAccessibility(scan),
    blockers: checkBlockers(scan),
    dependencies: await checkDependencies(pkg, scan),
    packaging: checkPackaging(pkg, scan),
  };
  return { byCategory, privileges };
}
