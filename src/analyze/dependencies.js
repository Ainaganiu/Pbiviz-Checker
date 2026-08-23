// Dependency checks. Vulnerabilities come from OSV.dev's free batch API — no key,
// no account. Only package names and version strings are sent; never file content.

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_TIMEOUT_MS = Number(process.env.OSV_TIMEOUT_MS ?? 6000);
const MAX_PACKAGES = 200;

const LOOSE_RANGE = /^(\^|~|>=|>|<|<=|\*|x|latest|\d+\.x|\d+\.\d+\.x)/i;
const COPYLEFT_SPDX = /\b(A?GPL-[0-9.]+|LGPL-[0-9.]+|MPL-[0-9.]+|EUPL|CDDL|SSPL)/i;

/** Strip range operators down to something OSV will accept as a concrete version. */
function concreteVersion(range) {
  if (typeof range !== 'string') return null;
  const match = range.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

export function collectDependencies(npmManifest) {
  if (!npmManifest) return [];
  const groups = [
    ['dependencies', npmManifest.dependencies],
    ['devDependencies', npmManifest.devDependencies],
  ];
  const out = [];
  for (const [group, deps] of groups) {
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string') continue;
      out.push({ name, range, group, version: concreteVersion(range) });
    }
  }
  return out.slice(0, MAX_PACKAGES);
}

export function findLooseRanges(dependencies) {
  return dependencies.filter((dep) => LOOSE_RANGE.test(dep.range.trim()));
}

export function licenseIsCopyleft(license) {
  return typeof license === 'string' && COPYLEFT_SPDX.test(license);
}

/**
 * @returns {Promise<{ status: 'ok'|'unavailable'|'skipped', vulnerable: Array, error?: string }>}
 */
export async function queryOsv(dependencies) {
  const queryable = dependencies.filter((dep) => dep.version);
  if (queryable.length === 0) {
    return { status: 'skipped', vulnerable: [], checked: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OSV_TIMEOUT_MS);
  try {
    const response = await fetch(OSV_BATCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        queries: queryable.map((dep) => ({
          package: { name: dep.name, ecosystem: 'npm' },
          version: dep.version,
        })),
      }),
    });
    if (!response.ok) {
      return { status: 'unavailable', vulnerable: [], checked: 0, error: `OSV responded ${response.status}` };
    }
    const body = await response.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    const vulnerable = [];
    results.forEach((entry, index) => {
      const vulns = entry?.vulns ?? [];
      if (vulns.length === 0) return;
      const dep = queryable[index];
      vulnerable.push({
        name: dep.name,
        version: dep.version,
        range: dep.range,
        group: dep.group,
        advisories: vulns.slice(0, 5).map((v) => v.id).filter(Boolean),
      });
    });
    return { status: 'ok', vulnerable, checked: queryable.length };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'the vulnerability database timed out' : 'the vulnerability database could not be reached';
    return { status: 'unavailable', vulnerable: [], checked: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
