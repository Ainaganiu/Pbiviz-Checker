# PBIVIZ Compliance Checker

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-30%20passing-2ea44f?logo=github)](test/)
[![Deploy](https://img.shields.io/badge/deploy-Render-46E3B7?logo=render&logoColor=111111)](render.yaml)

Upload a Power BI custom visual and get a fast, explainable AppSource readiness report.

PBIVIZ Compliance Checker evaluates Microsoft's AppSource certification checklist across security,
accessibility, packaging, dependencies, and manifest integrity. It returns pass/fail results, a
weighted score, confidence level, and plain-English recommendations.

## At a glance

- **27 rules** across seven certification categories
- **In-memory processing** with no uploaded files written to disk
- **Explainable results** with rule IDs and Microsoft Learn links
- **Optional AI summary** using OpenRouter and Hugging Face, with no source code sent
- **Render-ready deployment** with optional Turso-backed daily counters

**Nothing is stored.** The upload is streamed into memory, unzipped, analyzed and discarded
inside a single request. It never touches disk and is never logged. The only data that persists
is two integers per day: files checked, and recommendations shown.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # 30 tests, fully offline
```

No configuration is required. Every environment variable in `.env.example` is optional —
without an LLM key the app returns the full checklist and score and simply skips the prose summary.
`npm start` loads a `.env` file if one is present (via Node's `--env-file-if-exists`); on Render the
platform supplies the variables instead.

## How a check works

A `.pbiviz` is a zip. On upload the analyzer:

1. Unzips it in memory (`src/analyze/extract.js`), normalising both the packaged layout
   (`resources/*.pbiviz.json` with the code embedded as a string) and the loose dev layout
   (`pbiviz.json` + `capabilities.json` + `visual.js`).
2. Reads the manifest — API version, guid, class name, version, support URL.
3. Reads `capabilities.json` → the `privileges` array (`WebAccess`, `LocalStorage`, `ExportContent`).
4. Pattern-scans the bundled script (`src/analyze/codeScan.js`) for outbound calls, storage,
   export, accessibility hooks and certification blockers.
5. **Diffs declared privileges against detected code patterns** — the hidden-vs-declared gap
   is the check that actually matters to reviewers and to end users.
6. Runs the rules and computes a weighted score (`src/analyze/checks.js`, `score.js`).
7. Returns the result and drops the buffer.

## The checklist

27 rules across seven categories. Every rule has an ID and a Microsoft Learn deep-link,
declared in one place: `src/analyze/rules.js`.

| Category | Rules |
|---|---|
| Manifest integrity | `MAN-001`…`MAN-006` — manifest parses, API version valid and above the certification floor, required fields, semver, description/support URL |
| External network calls | `NET-001` declared-vs-detected, `NET-002` wildcard domain breadth, `NET-003` telemetry endpoints |
| Data export / local storage | `STO-001` localStorage, `STO-002` ExportContent, `STO-003` unsupported storage APIs |
| Accessibility | `A11Y-001` keyboard, `A11Y-002` ARIA/roles, `A11Y-003` high contrast |
| Certification blockers | `BLK-001` eval, `BLK-002` script injection, `BLK-003` iframes, `BLK-004` CSP-unsafe DOM sinks |
| Dependencies | `DEP-001` OSV.dev vulnerabilities, `DEP-002` version pinning, `DEP-003` license |
| Packaging & hygiene | `PKG-001` source maps, `PKG-002` icon, `PKG-003` localization, `PKG-004` bundle size, `PKG-005` error handling |

### Honesty rules baked in

- **Named destinations.** If a called domain can be resolved statically, the result names it.
  If it can't, the row says so plainly rather than passing quietly: *"This visual makes external
  calls, but the destination couldn't be determined from static analysis."*
- **Best-effort badges.** Every pattern-based row carries an inline badge — a pass means nothing
  suspicious was *found*, not that nothing exists.
- **Skipped ≠ passed.** A check that couldn't run (no npm manifest bundled, OSV unreachable) is
  reported as skipped and deducts nothing.
- **False positives avoided.** `http://www.w3.org/2000/svg` appears in every D3 bundle ever
  shipped; namespace and license-header hosts are excluded from the network check.

## Scoring

Start at 100, subtract per failing rule, floor at 0.

| Severity | Weight | Examples |
|---|---|---|
| Critical | −25 | eval, undeclared external call, undeclared export, undeclared telemetry |
| High | −15 | undeclared localStorage, missing manifest fields, vulnerable dependency, wildcard domains |
| Medium | −8 | no high-contrast support, no keyboard hooks, bundled source map |
| Low | −3 | missing ARIA, loose version ranges, oversized bundle |

🟢 90–100 AppSource-ready · 🟡 70–89 Minor fixes · 🟠 40–69 Several issues · 🔴 0–39 Not ready

A **confidence level** rides alongside the score: *high* when only structured JSON was read,
*medium* on readable source, *low* when the bundle is minified — detected automatically from
line length, not assumed.

## The summary

After the score is computed, only the derived JSON (score, rule IDs, reasons) is sent to a
language model. The file and the code are never sent. Providers are tried in order and are
fully configurable:

1. **OpenRouter** free tier (`OPENROUTER_MODEL`)
2. **Hugging Face** Inference Providers (`HF_MODEL`) — an independent rail, not just a second
   model on the same provider
3. Both unavailable → the checklist and score still render, with the top three fixes taken
   straight from the severity ordering

Both variables take a **comma-separated list of models, tried in order**, because a single slug is
fragile in practice: free models get promoted to paid (`404 "This model is unavailable for free"`)
and the ones that stay free return `429` under load. Every failed attempt is logged with its
provider, model and HTTP reason, so a dead slug is never mistaken for a missing key.

Use **instruction-tuned models only**. Reasoning models emit their chain-of-thought as the answer
("We need to respond with exactly two parts…"), which is worse than no prose at all — the parser
detects that shape, rejects it, and falls through to the next model.

## What gets tracked

```
uploads_total
recommendations_shown_total
```

Bucketed by UTC day so `/dashboard` can answer "how many yesterday". No timestamps tied to
file content, no IP-to-file mapping, no visual metadata, no results.

Storage is libSQL (SQLite) and picks its backend from the environment:

| `TURSO_DATABASE_URL` | Backend | Survives a restart? |
|---|---|---|
| set | hosted Turso database | yes |
| unset | local `counters.db` file | no — the dashboard says so on the page |

Counter writes are fire-and-forget and swallow their own errors, so a cold, rate-limited or
unreachable store never fails a check. `/api/health` reports the store's state, and `/api/stats`
returns 503 (which the dashboard handles) rather than taking the site down.

## Deploying to Render

`render.yaml` is a ready blueprint and runs on the **free** plan — no disk required.

Free Render instances have no persistent disk and sleep when idle, so the counters have to live
off-box to mean anything. Create a free Turso database:

```bash
turso db create pbiviz-checker
turso db show pbiviz-checker --url      # -> TURSO_DATABASE_URL
turso db tokens create pbiviz-checker   # -> TURSO_AUTH_TOKEN
```

Then:

1. Push this repo to GitHub and create a Render **Blueprint** from it.
2. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
3. Set `PUBLIC_URL` to the live Render URL (sent to OpenRouter as the referer header).
4. Optionally set `OPENROUTER_API_KEY` and/or `HF_API_KEY` for the prose summary.

Skip step 2 entirely if you don't mind the numbers resetting — the app falls back to a local
file, everything else works identically, and the dashboard states plainly that the counters
reset on restart rather than implying they are a running total.

Swapping in a different store (Upstash, Neon, Postgres) means rewriting one file:
`src/stats/counters.js` exports `recordCheck` and `readStats`, and nothing else in the app
touches persistence.

## Layout

```
server.js                  Express app, in-memory multer, CSP headers
src/analyze/rules.js       rule IDs, severities, Microsoft Learn links
src/analyze/extract.js     in-memory unzip + layout normalisation
src/analyze/codeScan.js    static pattern scanning
src/analyze/checks.js      the rules themselves
src/analyze/score.js       weighted score, bands, confidence
src/analyze/dependencies.js OSV.dev vulnerability lookup
src/llm/summarize.js       OpenRouter -> Hugging Face -> null
src/stats/counters.js      the two counters, and nothing else (libSQL: Turso or local file)
public/                    landing page, dashboard, no build step
```
