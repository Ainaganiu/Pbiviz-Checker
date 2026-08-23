import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyze, ExtractionError } from './src/analyze/index.js';
import { summarize, configuredProviders } from './src/llm/summarize.js';
import { recordCheck, readStats, storeHealth, storeMode } from './src/stats/counters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024);

// memoryStorage is the whole privacy promise: the upload is a Buffer that lives
// for the length of one request and is never handed to the filesystem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader(
    'content-security-policy',
    // 'unsafe-inline' for styles only: the score dial and dashboard bars are sized
    // with inline custom properties. No inline script is permitted.
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  next();
});

app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }));

app.post('/api/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file was uploaded. Choose a .pbiviz file and try again.' });
  }

  let buffer = req.file.buffer;
  try {
    const result = await analyze(buffer);
    const summary = await summarize(result);

    // Fire-and-forget by design: the write swallows its own errors, so a store
    // that is cold, rate-limited or unreachable never fails a check.
    void recordCheck(summary?.fixes?.length ?? result.topFixes.length);

    return res.json({ ...result, summary });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return res.status(400).json({ error: error.message });
    }
    // Deliberately opaque: nothing derived from the user's file is logged or returned.
    console.error('analysis failed:', error.name);
    return res.status(500).json({ error: 'Something went wrong analyzing that package. Nothing was stored.' });
  } finally {
    // Drop the reference so the buffer is collectable immediately after the response.
    buffer = null;
    if (req.file) req.file.buffer = null;
  }
});

app.get('/api/stats', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  try {
    res.json(await readStats(days));
  } catch {
    res.status(503).json({ error: 'The activity counters are unavailable right now. Checking files is unaffected.' });
  }
});

app.get('/api/health', async (req, res) => {
  // Always 200: the checker works with or without a counter store.
  res.json({ ok: true, summaryProviders: configuredProviders(), counters: await storeHealth() });
});

// multer's own errors (file too large, wrong field) arrive here.
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? `That file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`
      : 'That upload could not be read.';
    return res.status(400).json({ error: message });
  }
  return next(error);
});

app.listen(PORT, () => {
  const providers = configuredProviders();
  console.log(`pbiviz-checker listening on http://localhost:${PORT}`);
  console.log(providers.length > 0
    ? `summary providers: ${providers.join(' -> ')}`
    : 'summary providers: none configured (checklist and score still work)');
  console.log(storeMode === 'turso'
    ? 'counters: hosted Turso database'
    : 'counters: local file (set TURSO_DATABASE_URL to persist across restarts)');
});
