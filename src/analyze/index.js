import { extract, ExtractionError } from './extract.js';
import { scanCode } from './codeScan.js';
import { runChecks } from './checks.js';
import { scoreFindings } from './score.js';

export { ExtractionError };

/**
 * Analyse a .pbiviz that lives entirely in memory.
 *
 * Nothing here writes to disk, and nothing derived from the file — name, guid,
 * code, hostnames — is logged. The returned object is the only thing that leaves
 * this function, and it is what the caller may show the user.
 */
export async function analyze(buffer) {
  const startedAt = Date.now();
  const pkg = extract(buffer);
  const scan = scanCode(pkg.code, pkg.css);
  const { byCategory, privileges } = await runChecks(pkg, scan);
  const scored = scoreFindings(byCategory, scan);

  return {
    ...scored,
    visual: {
      // Shown back to the user in their own browser; never persisted or logged.
      displayName: pkg.manifest?.visual?.displayName ?? null,
      version: pkg.manifest?.visual?.version ?? null,
      apiVersion: pkg.manifest?.apiVersion ?? null,
      layout: pkg.layout,
      packagedSize: pkg.packagedSize,
      fileCount: pkg.files.length,
    },
    detected: {
      minified: scan.minification.minified,
      codeLength: scan.length,
      hosts: scan.network.hosts.map((h) => h.host),
      telemetryHosts: scan.network.telemetryHosts.map((h) => h.host),
      networkApis: scan.network.apis.map((a) => a.label),
      declaredPrivileges: privileges.all.map((p) => ({ name: p.name, parameters: p.parameters })),
    },
    warnings: pkg.warnings,
    analysisMs: Date.now() - startedAt,
  };
}
