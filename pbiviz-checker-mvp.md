# PBIVIZ Compliance Checker — MVP Spec

## One-line pitch
Drag in a `.pbiviz`, get an instant pass/fail against Microsoft's AppSource certification checklist (security + accessibility), a weighted score, and a plain-English summary. Nothing is stored — the file is analyzed in memory and discarded.

## Core promise (privacy)
- File never touches disk on the server. Stream into memory → parse → analyze → discard.
- Only two numbers persist: total uploads count, total "recommendations shown" count.
- No visual code, no visual name, no user file content is logged anywhere — this is the app's main trust claim, so it should be stated on the landing page, not just in a privacy policy.

## How a pbiviz gets checked (approach, not implementation)
A `.pbiviz` is a zip. On upload:
1. Unzip in memory.
2. Read `pbiviz.json` — capabilities, permissions, API version.
3. Read `capabilities.json` — check `privileges` array (this is where `WebAccess`, `LocalStorage`, `ExportContent` etc. get declared).
4. Scan the bundled `visual.js` for outbound call patterns and other risk signals (see detection features below).
5. Diff declared privileges vs. detected code patterns — the "hidden vs declared" gap that actually matters to reviewers and end users.
6. Run the checklist rules and compute a weighted score.
7. Return a result to the frontend. Delete the unzipped buffer.

## Checklist categories (pass/fail, each with a rule ID so users can look up the Microsoft doc)

| Category | Checks | Result |
|---|---|---|
| **Manifest integrity** | `pbiviz.json` has valid `apiVersion`, matches a supported current API version; required fields present (guid, visualClassName, displayName, version semver) | Pass/Fail |
| **External network calls** | Detects any outbound call in code. **If declared in capabilities.json privileges** → Pass, and app **states the API/domain** it found. **If code calls out but nothing declared** → Fail. **If no calls detected** → Pass | Pass/Fail |
| **Data export / local storage** | Checks for `localStorage`, `sessionStorage`, `ExportContent` privilege usage vs. declared privileges | Pass/Fail |
| **Accessibility — keyboard** | Checks for `tabindex`, keydown handlers on interactive elements | Pass/Fail |
| **Accessibility — ARIA/contrast hooks** | Checks for `aria-label`/`role` attributes; flags if visual renders text/SVG with no alt-text path | Pass/Fail |
| **High contrast mode support** | Checks for `powerbi-visuals-utils-colorutils` / high-contrast API usage per current MS guidance | Pass/Fail |
| **Certification blockers** | No `eval()`, no dynamic `<script>` injection, no CSP-unsafe patterns, iframe usage flagged | Pass/Fail |
| **Dependencies** | package.json checked against a free vulnerability DB for known-vulnerable/abandoned packages | Pass/Fail with list |

Each row renders as: ✅/❌ + one-line reason + link to the relevant Microsoft Learn checklist item.

## "Hidden API" honesty rule
- If the tool can identify the actual domain being called (e.g. `api.weatherapi.com`), show it.
- If it's dynamic/obfuscated/minified beyond what static analysis can resolve, don't guess — say plainly: **"This visual makes external calls, but the destination couldn't be determined from static analysis. If you're the developer, disclose this endpoint to your users."** That's more trustworthy than a false negative.

## UI caveat — "Best-Effort Detection" badge
Static regex/pattern scanning cannot reliably parse minified or obfuscated `visual.js`. Rather than let a ✅ read as a guarantee, every row in **External Network Calls** and **Certification Blockers** carries a small inline badge:

> 🔍 **Best-effort detection** — static analysis only. A pass here means nothing suspicious was *found*, not that nothing exists.

---

## Scoring system (beyond raw pass/fail)

A single pass/fail per row is useful but flattens severity — an undisclosed API call is not the same risk as a missing `aria-label`. Add a weighted score on top of the checklist.

### Severity weights
| Severity | Examples | Weight |
|---|---|---|
| **Critical** | `eval()`/dynamic script injection, undeclared external network call, undeclared data export | -25 pts each |
| **High** | Undeclared local storage, missing manifest required fields, known-vulnerable dependency | -15 pts each |
| **Medium** | No high-contrast support, no keyboard nav hooks | -8 pts each |
| **Low** | Missing ARIA labels (presence-only, not a functional break), outdated but non-vulnerable dependency | -3 pts each |

Start at 100, subtract per finding, floor at 0. Display as:
- **90–100** → 🟢 "AppSource-ready"
- **70–89** → 🟡 "Minor fixes needed"
- **40–69** → 🟠 "Several issues to resolve"
- **0–39** → 🔴 "Not ready — critical issues found"

### Confidence flag alongside score
Because some checks are best-effort, attach a **confidence level** to the score itself, not just individual rows:
- **High confidence** — manifest and capabilities checks (these read structured JSON, not guesswork)
- **Medium confidence** — pattern-based checks on unminified/readable code
- **Low confidence** — pattern-based checks on minified/obfuscated code (score still shown, but flagged: "This visual's code is minified — score may miss issues that static scanning can't see.")

This keeps the score honest rather than implying a false sense of completeness.

---

## Additional detection features worth adding (beyond the original checklist)

These extend accuracy and catch things reviewers or real users would flag, without needing the file to be stored:

1. **Minification/obfuscation detector** — flags when `visual.js` is minified (long single-line files, short variable names) so the confidence flag above can trigger automatically rather than relying on a fixed assumption.
2. **Permission scope check** — beyond "is WebAccess declared," checks whether the declared domains in `capabilities.json` use overly broad wildcard patterns (e.g. `*` or `*.com`) vs. specific domains — a common AppSource rejection reason.
3. **Telemetry/analytics call detection** — separate category from generic "external calls" specifically flagging known analytics/tracking endpoints (Google Analytics, Mixpanel, Sentry, etc.) so users can see if their visual is phoning home for telemetry, not just data.
4. **Source map exposure check** — flags if a `.js.map` file is bundled in the package, which can expose original unminified source and internal comments publicly.
5. **Icon and asset completeness** — checks that required icon sizes and `assets` folder structure match AppSource submission requirements (a common non-security rejection reason worth bundling in since it's a one-line check).
6. **Localization/i18n check** — flags whether the visual has a `stringResources` or locale folder structure, since AppSource increasingly expects at least English-only explicit declaration rather than hardcoded strings.
7. **Bundle size flag** — flags visuals over a size threshold (e.g. 2MB), which is both a performance smell and sometimes indicates unexpected bundled dependencies.
8. **License field check** — checks `package.json` for a declared license, and cross-checks bundled dependency licenses for anything copyleft (GPL) that could create redistribution issues for a commercial visual.
9. **Error handling / try-catch coverage (heuristic)** — flags visuals with API/data-binding code that has zero try-catch blocks around external calls or data parsing, since unhandled exceptions are a common cause of visual crashes in the Power BI canvas.
10. **Version pinning check** — flags dependencies using loose version ranges (`^` or `*`) in `package.json`, which can cause a visual to silently pull in a different (possibly vulnerable) package version on rebuild.

Each of these can slot into the existing severity-weight table above (most are Medium or Low; undeclared telemetry calls would be Critical alongside undeclared external calls).

---

## Summary generation (free LLM)
- After the rule-based checklist and score are computed, send only the **structured JSON result** (never the file, never raw code) to a free model for a 3–4 sentence plain-English summary + top 3 fix recommendations, ordered by severity weight.
- Model provider options, cheapest first:
  - **OpenRouter free tier models** (e.g. a free Llama or Gemma variant available at `:free` suffix on OpenRouter).
  - **Hugging Face Inference API / Inference Providers (free tier)** — worth including as a second provider option, not just a fallback model on the same provider. Reasoning:
    - Free-tier rate limits and available models are governed separately from OpenRouter, so if OpenRouter's free tier changes terms or rate-limits harder, Hugging Face is a genuinely independent fallback rather than just a different model on the same rail.
    - Good candidate models for this exact task (structured JSON → short summary + ranked fixes) are small instruction-tuned models — e.g. a Llama-3-8B-Instruct or Mistral-7B-Instruct class model hosted via HF Inference Providers — since the task is summarization/ranking on already-structured input, not open-ended reasoning, so a small model is enough.
    - HF also makes it easy to self-host later (e.g. via a lightweight local endpoint) if the free hosted tier ever becomes unreliable — useful long-term given the "no file storage, low infra cost" MVP philosophy.
  - Keep the provider *and* model name in config, not hardcoded, with the flow being: try primary (OpenRouter free model) → fall back to secondary (Hugging Face free model) → if both fail, still show the checklist and score, just without the prose summary.
- This is the only place an LLM touches user data, and even then only the derived JSON, never the file itself — worth stating that explicitly in-product.

## What gets tracked (and only this)
```
uploads_total: counter
recommendations_shown_total: counter
```
Bucketed by day so daily figures (e.g. "uploads yesterday") are answerable. No timestamps tied to file content, no IP-to-file mapping, no visual metadata retention.

## Dashboard page
A second, unauthenticated page shows only the two tracked counters:
- Uploads yesterday / today / 30-day total
- Recommendations shown yesterday / today / 30-day total
- A simple daily bar chart of uploads over the last 30 days

No file names, IPs, or check results shown here — purely the aggregate activity signal, consistent with the "we only track counts" promise.

## MVP scope cut (ship fast)
**In v1:** manifest checks, external API detection, localStorage/export check, ARIA presence check, weighted score + confidence flag, LLM summary, dashboard page.
**Defer to v2:** minification detector feeding the confidence flag automatically, telemetry-specific detection, source map exposure check, dependency license scan, bundle size flag, high-contrast API depth-check.

## Landing page copy angle
Given your audience (devs going for AppSource certification, like your own Donut Chart Builder), the pitch that'll land: *"Check your pbiviz against the certification checklist before Microsoft's reviewers do — your file never leaves your session."*
