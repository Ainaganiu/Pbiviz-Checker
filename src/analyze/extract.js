import { unzipSync, strFromU8 } from 'fflate';

// A .pbiviz is a zip. Two shapes exist in the wild and we normalise both:
//
//  a) packaged (what `pbiviz package` produces)
//       package.json                    <- visual package manifest
//       resources/<name>.pbiviz.json    <- { visual, capabilities, content: { js, css, iconBase64 } }
//       assets/icon.png
//
//  b) loose / dev layout, occasionally zipped by hand
//       pbiviz.json, capabilities.json, visual.js, package.json (npm)
//
// Everything below works on the normalised shape so the checks never care which was uploaded.

const MAX_ENTRIES = 5000;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isNpmManifest(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Boolean(obj.dependencies || obj.devDependencies || obj.peerDependencies);
}

/** PNG dimensions straight out of the IHDR chunk — no image library needed. */
function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export class ExtractionError extends Error {}

export function extract(buffer) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new ExtractionError('That file could not be read as a zip archive. A .pbiviz is a zip — make sure the upload is not renamed or corrupted.');
  }

  const paths = Object.keys(entries);
  if (paths.length === 0) throw new ExtractionError('The archive is empty.');
  if (paths.length > MAX_ENTRIES) throw new ExtractionError('The archive contains an unexpected number of files.');

  const files = paths.map((path) => ({
    path,
    normalised: path.split('\\').join('/').toLowerCase(),
    bytes: entries[path],
    size: entries[path].length,
  }));

  const byName = (name) => files.find((f) => f.normalised === name || f.normalised.endsWith(`/${name}`));
  const text = (file) => (file ? strFromU8(file.bytes) : null);

  const result = {
    files: files.map((f) => ({ path: f.path, size: f.size })),
    totalUnpackedSize: files.reduce((sum, f) => sum + f.size, 0),
    packagedSize: buffer.length,
    layout: 'unknown',
    manifest: null,       // pbiviz.json-shaped: { visual, apiVersion, author, ... }
    capabilities: null,
    code: '',
    css: '',
    npmManifest: null,
    stringResources: null,
    icon: null,           // { source, width, height } | null
    sourceMapFiles: [],
    warnings: [],
  };

  // --- packaged layout: resources/*.pbiviz.json holds everything ----------
  const resourceFile = files.find((f) => f.normalised.endsWith('.pbiviz.json'));
  if (resourceFile) {
    const parsed = parseJson(text(resourceFile));
    if (parsed) {
      result.layout = 'packaged';
      result.manifest = {
        visual: parsed.visual ?? null,
        apiVersion: parsed.apiVersion ?? null,
        author: parsed.author ?? null,
        assets: parsed.assets ?? null,
        externalJS: parsed.externalJS ?? null,
        style: parsed.style ?? null,
      };
      result.capabilities = parsed.capabilities ?? null;
      result.code = typeof parsed.content?.js === 'string' ? parsed.content.js : '';
      result.css = typeof parsed.content?.css === 'string' ? parsed.content.css : '';
      result.stringResources = parsed.stringResources ?? null;
      if (parsed.content?.iconBase64) {
        try {
          const bytes = new Uint8Array(Buffer.from(parsed.content.iconBase64, 'base64'));
          result.icon = { source: 'iconBase64', ...(pngSize(bytes) ?? { width: null, height: null }) };
        } catch {
          result.warnings.push('The embedded icon could not be decoded.');
        }
      }
    }
  }

  // --- loose layout, and fallbacks for anything the packaged form omitted --
  if (!result.manifest) {
    const pbivizJson = byName('pbiviz.json');
    const parsed = parseJson(text(pbivizJson));
    if (parsed) {
      result.layout = 'loose';
      result.manifest = parsed;
      result.capabilities = result.capabilities ?? parsed.capabilities ?? null;
      result.stringResources = result.stringResources ?? parsed.stringResources ?? null;
    }
  }

  if (!result.capabilities) {
    result.capabilities = parseJson(text(byName('capabilities.json')));
  }

  if (!result.code) {
    // Prefer an explicit visual.js, otherwise take the largest bundled script.
    const explicit = byName('visual.js');
    const scripts = files.filter((f) => f.normalised.endsWith('.js') && !f.normalised.endsWith('.min.js.map'));
    const chosen = explicit ?? scripts.sort((a, b) => b.size - a.size)[0];
    if (chosen) result.code = text(chosen) ?? '';
  }

  if (!result.css) {
    const cssFile = files.find((f) => f.normalised.endsWith('.css'));
    if (cssFile) result.css = text(cssFile) ?? '';
  }

  // The top-level package.json in a packaged .pbiviz is the *visual* manifest,
  // not an npm one. Only treat it as npm metadata when it actually declares deps.
  for (const file of files.filter((f) => f.normalised.endsWith('package.json'))) {
    const parsed = parseJson(text(file));
    if (isNpmManifest(parsed)) {
      result.npmManifest = parsed;
      break;
    }
    if (parsed && !result.manifest) {
      // Hand-zipped visuals sometimes only ship the package manifest.
      result.manifest = parsed.visual ? { visual: parsed.visual, apiVersion: parsed.apiVersion ?? null, author: parsed.author ?? null } : result.manifest;
    }
    if (parsed && parsed.license && !result.npmManifest) {
      result.declaredLicense = parsed.license;
    }
  }
  if (result.npmManifest?.license) result.declaredLicense = result.npmManifest.license;

  if (!result.icon) {
    const iconFile = files.find((f) => /(^|\/)assets\/.*\.png$/.test(f.normalised) || f.normalised.endsWith('/icon.png') || f.normalised === 'icon.png');
    if (iconFile) result.icon = { source: iconFile.path, ...(pngSize(iconFile.bytes) ?? { width: null, height: null }) };
  }

  result.sourceMapFiles = files.filter((f) => f.normalised.endsWith('.map')).map((f) => f.path);
  result.hasStringResourceFolder = files.some((f) => /(^|\/)(stringresources|resources\/[a-z]{2}(-[a-z]{2})?)\//i.test(f.normalised));

  if (!result.manifest && !result.capabilities && !result.code) {
    throw new ExtractionError('This zip does not look like a Power BI visual — no manifest, capabilities or bundled script was found.');
  }

  return result;
}
