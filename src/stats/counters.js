import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// The entire persistence layer of this app: two integers per day.
//
// No timestamps tied to a file, no IP, no visual metadata, no check results.
// Day buckets exist only so the dashboard can answer "how many yesterday".
//
// Backed by libSQL, which is SQLite either way:
//   - TURSO_DATABASE_URL set  -> hosted Turso, survives Render's free-tier restarts
//   - unset                   -> a local file, so `npm start` needs no account
//
// Counter writes must never break a check. Every write swallows its own errors;
// only readStats (the dashboard) surfaces a failure, and the page handles it.

const remoteUrl = process.env.TURSO_DATABASE_URL;

function buildClient() {
  if (remoteUrl) {
    return {
      client: createClient({ url: remoteUrl, authToken: process.env.TURSO_AUTH_TOKEN }),
      mode: 'turso',
    };
  }
  const dir = resolve(process.env.DATA_DIR ?? './data');
  mkdirSync(dir, { recursive: true });
  return {
    client: createClient({ url: `file:${resolve(dir, 'counters.db')}` }),
    mode: 'local-file',
  };
}

const { client, mode } = buildClient();

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS daily_counters (
    day TEXT PRIMARY KEY,
    uploads_total INTEGER NOT NULL DEFAULT 0,
    recommendations_shown_total INTEGER NOT NULL DEFAULT 0
  );
`;

// Run the migration once, lazily, and remember the outcome. A cold Turso database
// or a network blip shouldn't take the whole process down at boot.
let ready = null;
function ensureSchema() {
  ready ??= client.execute(SCHEMA).then(
    () => true,
    (error) => {
      ready = null; // let the next call retry rather than failing forever
      throw error;
    },
  );
  return ready;
}

/** UTC day key, so buckets don't shift with the server's timezone. */
function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function shiftDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return dayKey(d);
}

async function bump(uploads, recommendations) {
  await ensureSchema();
  await client.execute({
    sql: `
      INSERT INTO daily_counters (day, uploads_total, recommendations_shown_total)
      VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        uploads_total = uploads_total + excluded.uploads_total,
        recommendations_shown_total = recommendations_shown_total + excluded.recommendations_shown_total
    `,
    args: [dayKey(), uploads, recommendations],
  });
}

/** Never throws: a counter that can't be written must not fail a user's check. */
async function bumpQuietly(uploads, recommendations) {
  try {
    await bump(uploads, recommendations);
    return true;
  } catch (error) {
    // Deliberately terse — nothing about the user's file is involved here.
    console.warn(`counter write skipped: ${error.code ?? error.name}`);
    return false;
  }
}

/**
 * One check is one write. The two counters always move together, so bumping them
 * separately would mean two round-trips racing on the same row for no benefit.
 */
export function recordCheck(recommendationsShown = 0) {
  return bumpQuietly(1, Math.max(0, recommendationsShown));
}

export async function readStats(days = 30) {
  await ensureSchema();
  const since = shiftDays(-(days - 1));
  const { rows } = await client.execute({
    sql: `
      SELECT day, uploads_total, recommendations_shown_total
      FROM daily_counters
      WHERE day >= ?
      ORDER BY day ASC
    `,
    args: [since],
  });
  const byDay = new Map(rows.map((r) => [r.day, r]));

  // Fill gaps so the chart has one bar per day rather than a ragged series.
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = shiftDays(-i);
    const row = byDay.get(day);
    series.push({
      day,
      uploads: Number(row?.uploads_total ?? 0),
      recommendations: Number(row?.recommendations_shown_total ?? 0),
    });
  }

  const today = series.at(-1);
  const yesterday = series.at(-2) ?? { uploads: 0, recommendations: 0 };
  const totals = series.reduce(
    (acc, d) => ({ uploads: acc.uploads + d.uploads, recommendations: acc.recommendations + d.recommendations }),
    { uploads: 0, recommendations: 0 },
  );

  return {
    windowDays: days,
    persistent: mode === 'turso',
    today: { uploads: today.uploads, recommendations: today.recommendations },
    yesterday: { uploads: yesterday.uploads, recommendations: yesterday.recommendations },
    window: totals,
    series,
  };
}

export const storeMode = mode;

/** Used by /api/health so a misconfigured store is visible without opening the dashboard. */
export async function storeHealth() {
  try {
    await ensureSchema();
    return { mode, ok: true };
  } catch (error) {
    return { mode, ok: false, error: error.code ?? error.name };
  }
}

/** Releases the database handle. Only tests need this; the server runs until killed. */
export function closeStore() {
  client.close();
}
