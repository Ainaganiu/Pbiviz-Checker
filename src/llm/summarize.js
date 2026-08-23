// Plain-English summary of an already-computed result.
//
// The only thing sent to a provider is the derived JSON below — never the file,
// never the bundled code, never a hostname list beyond what the checks already
// surfaced to the user. If every provider fails we return null and the caller
// still renders the checklist and score.

// Free tiers move: models get promoted to paid, and the ones that stay free
// return 429 under load. So each provider takes a *list* of models, tried in
// order, before falling through to the next provider. Set either variable to a
// comma-separated list to change the order without touching this file.
// Instruction-tuned models only. Reasoning models are deliberately excluded:
// they emit their chain-of-thought as the answer, which is worse than no prose.
const DEFAULT_OPENROUTER_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'google/gemma-4-26b-a4b-it:free',
];
// Hugging Face slugs are case-sensitive and differ from OpenRouter's; these three
// are confirmed present on the Inference Providers router.
const DEFAULT_HF_MODELS = [
  'Qwen/Qwen2.5-72B-Instruct',
  'google/gemma-3-27b-it',
  'meta-llama/Llama-3.1-8B-Instruct',
];

function modelList(value, fallback) {
  const parsed = (value ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

const PROVIDERS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    enabled: () => Boolean(process.env.OPENROUTER_API_KEY),
    url: 'https://openrouter.ai/api/v1/chat/completions',
    models: () => modelList(process.env.OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODELS),
    // Best-effort ask for no chain-of-thought; not every model honours it, which
    // is why looksLikeReasoning() below is the actual guard.
    extraBody: { reasoning: { exclude: true } },
    headers: () => ({
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
      'http-referer': process.env.PUBLIC_URL ?? 'http://localhost:3000',
      'x-title': 'PBIVIZ Compliance Checker',
    }),
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    enabled: () => Boolean(process.env.HF_API_KEY),
    url: 'https://router.huggingface.co/v1/chat/completions',
    models: () => modelList(process.env.HF_MODEL, DEFAULT_HF_MODELS),
    headers: () => ({
      authorization: `Bearer ${process.env.HF_API_KEY}`,
      'content-type': 'application/json',
    }),
  },
];

// Small free models can take 10s+; the checklist is already on screen either way.
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 20000);
const MAX_SUMMARY_CHARS = 1200;

const SYSTEM_PROMPT = `You help Power BI custom visual developers get through AppSource certification.
You are given the JSON result of an automated compliance check — never the developer's file or code.
Reply with exactly two parts and nothing else:
1. A plain-English summary of 3 to 4 sentences. No bullet points, no headings.
2. A line reading "FIXES:" followed by up to three numbered fixes, most severe first, one short sentence each, each naming the rule ID it addresses.
Be direct and concrete. Do not invent findings that are not in the JSON. If a check was skipped, do not treat it as a pass.`;

/** Strip the result down to the minimum the model needs to write prose. */
export function buildPayload(result) {
  return {
    score: result.score,
    band: result.band.label,
    confidence: { level: result.confidence.level, reason: result.confidence.reason },
    minified: result.detected.minified,
    counts: result.counts,
    failures: result.categories.flatMap((category) =>
      category.findings
        .filter((f) => f.status === 'fail')
        .map((f) => ({ id: f.id, category: category.label, severity: f.severity, title: f.title, reason: f.reason })),
    ),
    skipped: result.categories.flatMap((category) =>
      category.findings.filter((f) => f.status === 'skipped').map((f) => ({ id: f.id, reason: f.reason })),
    ),
  };
}

/**
 * Reasoning models narrate the instructions back before answering. That text is
 * useless to a developer, so it is rejected outright and the next model is tried.
 */
function looksLikeReasoning(summary) {
  return summary.length > MAX_SUMMARY_CHARS
    || /^(we|i|okay|let'?s|first,?)\s+(need|must|should|have|will|are|'ll|to\b|the\b)/i.test(summary)
    || /\b(the user (wants|asks)|per the instructions|as requested above)\b/i.test(summary);
}

/** Small models like to announce themselves: "Here is a 3-sentence summary:". */
function stripPreamble(text) {
  return text.replace(/^\s*(here(?:'s| is| are)|below is|sure[,!]?)[^\n:]{0,80}:\s*/i, '').trim();
}

function parseResponse(text) {
  // Strip explicit thinking blocks, then split on the LAST "FIXES:" so a model
  // that mentions the token while narrating doesn't derail the split.
  const trimmed = (text ?? '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
  if (!trimmed) return null;

  const marker = trimmed.toUpperCase().lastIndexOf('FIXES:');
  const summary = (marker === -1 ? trimmed : trimmed.slice(0, marker)).trim();
  const fixesPart = marker === -1 ? '' : trimmed.slice(marker + 'FIXES:'.length);

  // Some models put every fix on one line ("1. Do this. 2. Do that."), so split
  // on the numbering itself rather than trusting newlines.
  const fixes = fixesPart
    .split(/\n|(?=\s\d+[.)]\s)/)
    .map((line) => line.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);

  return { summary: stripPreamble(summary), fixes };
}

async function callModel(provider, model, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: provider.headers(),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1500,
        ...(provider.extraBody ?? {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    });
    if (!response.ok) {
      // The body carries the useful part ("unavailable for free", "rate limited"),
      // and contains nothing derived from the user's file.
      const detail = await response.text().catch(() => '');
      const message = detail.slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(`HTTP ${response.status}${message ? ` ${message}` : ''}`);
    }
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    const parsed = parseResponse(content);
    if (!parsed?.summary) throw new Error('empty summary');
    if (looksLikeReasoning(parsed.summary)) throw new Error('model returned reasoning instead of a summary');
    if (parsed.fixes.length === 0) throw new Error('no FIXES section in the response');
    return { ...parsed, provider: provider.label, model };
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<{summary,fixes,provider,model}|null>} null when no provider succeeded. */
export async function summarize(result) {
  const payload = buildPayload(result);
  const available = PROVIDERS.filter((p) => p.enabled());
  if (available.length === 0) return null;

  const attempts = [];
  for (const provider of available) {
    for (const model of provider.models()) {
      try {
        return await callModel(provider, model, payload);
      } catch (error) {
        // Fall through to the next model, then the next provider. The reason is
        // recorded so an operator can see *why* the prose went missing — a dead
        // model slug is otherwise indistinguishable from no key at all.
        attempts.push(`${provider.label}/${model}: ${error.message}`);
      }
    }
  }
  console.warn(`summary unavailable — ${attempts.join(' | ')}`);
  return null;
}

export function configuredProviders() {
  return PROVIDERS.filter((p) => p.enabled()).map((p) => `${p.label} (${p.models().join(', ')})`);
}

// Exported for tests: these two decide whether a model's answer is usable.
export const _internals = { parseResponse, looksLikeReasoning, stripPreamble };
