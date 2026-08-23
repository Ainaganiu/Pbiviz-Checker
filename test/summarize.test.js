import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, _internals } from '../src/llm/summarize.js';

const { parseResponse, looksLikeReasoning } = _internals;

test('a well-formed response splits into summary and fixes', () => {
  const parsed = parseResponse(`This visual has two critical problems. Fix them before submitting.

FIXES:
1. BLK-001 — Remove the eval() call.
2. NET-003 — Declare the Mixpanel endpoint.`);
  assert.match(parsed.summary, /^This visual has two critical problems\./);
  assert.equal(parsed.fixes.length, 2);
  assert.equal(parsed.fixes[0], 'BLK-001 — Remove the eval() call.');
});

test('explicit thinking blocks are stripped', () => {
  const parsed = parseResponse('<think>We need three sentences. FIXES: hmm.</think>The visual is clean.\n\nFIXES:\n1. Nothing to fix.');
  assert.equal(parsed.summary, 'The visual is clean.');
  assert.equal(parsed.fixes.length, 1);
});

test('the split uses the last FIXES marker, not the first', () => {
  // A model that narrates the instructions mentions the token before answering.
  const parsed = parseResponse('Then a line reading FIXES: follows.\nThe visual is clean.\n\nFIXES:\n1. Nothing to fix.');
  assert.equal(parsed.fixes.length, 1);
  assert.equal(parsed.fixes[0], 'Nothing to fix.');
});

test('leaked chain-of-thought is recognised so the next model can be tried', () => {
  // Verbatim shape of what a reasoning model actually returned in testing.
  assert.ok(looksLikeReasoning('We need to respond with exactly two parts and nothing else.'));
  assert.ok(looksLikeReasoning('Okay, the user wants a summary of the failures.'));
  assert.ok(looksLikeReasoning('a'.repeat(1300)));
});

test('a genuine summary is not mistaken for reasoning', () => {
  assert.ok(!looksLikeReasoning('This visual has critical security flaws: it uses eval() and sends data to Mixpanel without disclosing it.'));
  assert.ok(!looksLikeReasoning('Weak accessibility support is the main remaining problem.'));
});

test('the payload carries no file content, only derived findings', () => {
  const result = {
    score: 40,
    band: { label: 'Several issues to resolve' },
    confidence: { level: 'medium', reason: 'readable code' },
    detected: { minified: false, hosts: ['api.secret-internal.example'], codeLength: 999 },
    counts: { total: 27, passed: 20, failed: 7, skipped: 0, bySeverity: {} },
    visual: { displayName: 'Secret Internal Visual', guid: 'abc123' },
    categories: [{ findings: [{ id: 'BLK-001', status: 'fail', severity: 'critical', title: 't', reason: 'Found eval() x1.' }] }],
  };
  const payload = buildPayload(result);
  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes('Secret Internal Visual'), 'the visual name must not be sent');
  assert.ok(!serialised.includes('abc123'), 'the guid must not be sent');
  assert.equal(payload.failures.length, 1);
  assert.equal(payload.failures[0].id, 'BLK-001');
});

test('a model announcing itself has the preamble removed', () => {
  // Verbatim shape returned by Llama-3.1-8B-Instruct in live testing.
  const parsed = parseResponse('Here is a 3-sentence plain-English summary:\n\nThe code has two critical security issues.\n\nFIXES:\n1. Replace eval().');
  assert.equal(parsed.summary, 'The code has two critical security issues.');
});

test('a summary that merely starts with "Here" is left alone', () => {
  assert.equal(_internals.stripPreamble('Here the visual fails on two counts.'), 'Here the visual fails on two counts.');
});

test('fixes crammed onto one line are still split apart', () => {
  // Verbatim shape returned by Qwen2.5-72B-Instruct in live testing.
  const parsed = parseResponse('The visual has issues.\n\nFIXES: 1. Remove the wildcard (NET-002). 2. Declare local storage (STO-001). 3. Add error handling (PKG-005).');
  assert.equal(parsed.fixes.length, 3);
  assert.equal(parsed.fixes[1], 'Declare local storage (STO-001).');
});

test('a fix containing a decimal is not split mid-sentence', () => {
  const parsed = parseResponse('Summary here.\n\nFIXES:\n1. Upgrade lodash to 4.17.21 immediately.');
  assert.equal(parsed.fixes.length, 1);
  assert.equal(parsed.fixes[0], 'Upgrade lodash to 4.17.21 immediately.');
});
