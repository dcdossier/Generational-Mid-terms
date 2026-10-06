'use strict';

/**
 * ai.js — optional AI calls, one API key per site tab ("feature").
 *
 * Provider: AI_PROVIDER env var, one of
 *   none    (default) — no AI calls at all; nothing is logged as an error
 *   groq    — https://api.groq.com/openai/v1
 *   xai     — https://api.x.ai/v1
 *   gemini  — https://generativelanguage.googleapis.com/v1beta/openai
 * All three are called through their OpenAI-compatible endpoints
 * (GET /models, POST /chat/completions). The per-tab keys below must belong
 * to the chosen provider.
 *
 *   feature  secret            used for                               max calls/run
 *   home     MID_TERMS_HOME    Home tab: Congress approval backup     4
 *   et       MID_TERMS_ET      Election Trends (reserved)             0
 *   ii       MID_TERMS_II      India's Interest (reserved)            0
 *   ac       MID_TERMS_AC      Analysis & Commentary summariser       10
 *
 * A feature only ever uses its own key. If the key is missing, the model it
 * needs isn't listed, its call cap is reached, or the provider returns a 4xx, that
 * feature gets null for the rest of the run and the caller uses its non-AI
 * path. Calls are made one at a time, at least 2 seconds apart; a 429 is
 * retried once after a wait. Keys are never logged.
 *
 * Usage: await initAI('home') once at the start of a run (lists the
 * provider's models and logs them), then aiExtract('home', system, user, opts).
 */

const fetch = require('node-fetch');
const { recordAI, getAI } = require('./status');

// Text model: the first preferred id the provider lists, else the first listed
// id matching `match`. Page reading: a model that browses by itself, if the
// provider has one; otherwise callers send a short extract to the text model.
const PROVIDERS = {
  groq: {
    base: 'https://api.groq.com/openai/v1',
    text: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    match: /^(llama-3\.3-70b|openai\/gpt-oss)/,
    web: 'groq/compound-mini',
    jsonMode: true,
  },
  xai: {
    base: 'https://api.x.ai/v1',
    text: ['grok-4-fast-non-reasoning', 'grok-3-mini', 'grok-4'],
    match: /^grok-(?!.*(image|imagine|vision|video))/,
    web: null,
    jsonMode: false,
  },
  gemini: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    text: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    match: /^gemini-[\d.]+-flash(?!.*(image|tts|audio|live|embedding))/,
    web: null,
    jsonMode: false,
  },
};
const PROVIDER_NAME = String(process.env.AI_PROVIDER || 'none').trim().toLowerCase();
const PROVIDER = PROVIDERS[PROVIDER_NAME] || null;
const FEATURES = {
  home: { env: 'MID_TERMS_HOME', maxCalls: 4 },
  et:   { env: 'MID_TERMS_ET',   maxCalls: 0 },
  ii:   { env: 'MID_TERMS_II',   maxCalls: 0 },
  ac:   { env: 'MID_TERMS_AC',   maxCalls: 10 },
};
const GAP_MS = 2000;
const MAX_INPUT_CHARS = 6000;          // short extracts only, never whole pages
const MAX_RETRY_WAIT_MS = 30000;

const state = {};                      // feature → { calls, disabled, models, textModel, webModel }
let lastCallAt = 0;
let queue = Promise.resolve();         // serialises every AI request

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Belt and braces: nothing that looks like a key reaches the logs
const redact = s => String(s || '').replace(/\b(gsk_|sk-)[A-Za-z0-9_-]+/g, '[redacted]');

function keyFor(feature) {
  const f = FEATURES[feature];
  return f ? (process.env[f.env] || '') : '';
}

function featureState(feature) {
  if (!state[feature]) state[feature] = { calls: 0, disabled: false, models: null, textModel: null, webModel: null };
  return state[feature];
}

// Runs fn after the previous request has finished and 2 s have passed
function serial(fn) {
  const run = queue.then(async () => {
    const wait = lastCallAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); }
    finally { lastCallAt = Date.now(); }
  });
  queue = run.catch(() => {});
  return run;
}

function note(feature, patch) {
  const st = featureState(feature);
  recordAI(feature, { provider: PROVIDER_NAME, calls_this_run: st.calls, ...patch });
}

let announced = false;

/**
 * Lists the provider's models with this feature's key (once per run) and picks the
 * models it will use. Returns true if the feature can make calls.
 */
async function initAI(feature) {
  const f = FEATURES[feature];
  if (!f) throw new Error(`Unknown AI feature "${feature}"`);
  const st = featureState(feature);
  if (st.models) return !st.disabled;
  // A different provider than last run: start this feature's status afresh
  if ((getAI(feature) || {}).provider !== PROVIDER_NAME) recordAI(feature, {}, { reset: true });
  if (!PROVIDER) {
    if (!announced) {
      console.log(PROVIDER_NAME === 'none'
        ? '[AI] AI_PROVIDER=none — AI is off for this run'
        : `[AI] AI_PROVIDER="${PROVIDER_NAME}" is not one of none, groq, xai, gemini — AI is off for this run`);
      announced = true;
    }
    st.disabled = true;
    st.models = [];
    note(feature, { status: 'off', key_present: !!keyFor(feature) });
    return false;
  }
  if (!keyFor(feature)) {
    console.log(`[AI] ${feature}: ${f.env} not set — AI skipped for this feature`);
    st.disabled = true;
    st.models = [];
    note(feature, { key_present: false });
    return false;
  }
  if (f.maxCalls === 0) {
    console.log(`[AI] ${feature}: no AI features yet (cap 0) — skipped`);
    st.disabled = true;
    st.models = [];
    note(feature, { key_present: true });
    return false;
  }
  try {
    const res = await serial(() => fetch(`${PROVIDER.base}/models`, {
      headers: { 'Authorization': `Bearer ${keyFor(feature)}` },
      timeout: 15000,
    }));
    const listBody = await res.text();
    console.log(`[AI] ${feature}: models list HTTP ${res.status}, ${Buffer.byteLength(listBody)} bytes`);
    if (!res.ok) {
      const body = redact(listBody).slice(0, 160);
      st.disabled = true;
      st.models = [];
      note(feature, { key_present: true, last_error: `models list HTTP ${res.status}: ${body}`, last_error_at: new Date().toISOString() });
      return false;
    }
    // Gemini lists ids as "models/gemini-…"; the chat endpoint takes them without the prefix
    st.models = ((JSON.parse(listBody)).data || []).filter(m => m.active !== false)
      .map(m => String(m.id).replace(/^models\//, '')).sort();
  } catch (err) {
    st.disabled = true;
    st.models = [];
    note(feature, { key_present: true, last_error: `models list: ${redact(err.message)}`, last_error_at: new Date().toISOString() });
    console.warn(`[AI] ${feature}: models list failed: ${redact(err.message)}`);
    return false;
  }
  console.log(`[AI] ${feature}: ${PROVIDER_NAME} lists ${st.models.length} models: ${st.models.join(', ')}`);
  st.textModel = PROVIDER.text.find(m => st.models.includes(m)) || st.models.find(m => PROVIDER.match.test(m)) || null;
  st.webModel = PROVIDER.web && st.models.includes(PROVIDER.web) ? PROVIDER.web : null;
  if (!st.textModel) console.warn(`[AI] ${feature}: no current text model listed — extraction will be skipped`);
  if (!st.webModel) console.log(`[AI] ${feature}: no page-reading model — pages will be read here and a short extract sent to the text model`);
  console.log(`[AI] ${feature}: extraction model ${st.textModel || '—'}, page-reading model ${st.webModel || '—'}, cap ${f.maxCalls} calls`);
  note(feature, { status: 'on', key_present: true, text_model: st.textModel, web_model: st.webModel });
  return true;
}

function parseJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * One chat completion for a feature.
 * opts: { label, maxTokens = 512, model: 'text' | 'web', json = true }
 * Returns parsed JSON (json: true), the reply text (json: false), or null.
 */
async function aiExtract(feature, systemPrompt, userContent, { label = 'extract', maxTokens = 512, model = 'text', json = true } = {}) {
  const f = FEATURES[feature];
  if (!f) throw new Error(`Unknown AI feature "${feature}"`);
  const st = featureState(feature);
  if (!st.models) await initAI(feature);
  if (st.disabled) return null;
  const modelId = model === 'web' ? st.webModel : st.textModel;
  if (!modelId) {
    console.warn(`[AI] ${feature} ${label}: no listed ${model} model — skipped`);
    return null;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (st.calls >= f.maxCalls) {
      console.warn(`[AI] ${feature} ${label}: cap of ${f.maxCalls} calls reached — skipped`);
      return null;
    }
    st.calls++;
    let res, body;
    try {
      res = await serial(() => fetch(`${PROVIDER.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${keyFor(feature)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          temperature: 0,
          max_tokens: maxTokens,
          ...(json && model === 'text' && PROVIDER.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: String(userContent || '').slice(0, MAX_INPUT_CHARS) },
          ],
        }),
        timeout: 60000,
      }));
      body = await res.text();
    } catch (err) {
      console.warn(`[AI] feature=${feature} model=${modelId} ${label}: failed (network: ${redact(err.message)})`);
      note(feature, { last_error: `${label}: ${redact(err.message)}`, last_error_at: new Date().toISOString() });
      return null;
    }

    if (res.status === 429 && attempt === 1) {
      const wait = Math.min((parseFloat(res.headers.get('retry-after')) || 10) * 1000, MAX_RETRY_WAIT_MS);
      console.warn(`[AI] feature=${feature} model=${modelId} ${label}: HTTP 429, ${Buffer.byteLength(body)} bytes — retrying once in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const msg = redact(body).slice(0, 160);
      console.warn(`[AI] feature=${feature} model=${modelId} ${label}: failed HTTP ${res.status}, ${Buffer.byteLength(body)} bytes: ${msg}`);
      if (res.status >= 400 && res.status < 500) {
        st.disabled = true; // any 4xx: no more calls for this feature this run
        console.warn(`[AI] ${feature}: disabled for the rest of this run`);
      }
      note(feature, { last_error: `${label}: HTTP ${res.status}: ${msg}`, last_error_at: new Date().toISOString() });
      return null;
    }

    let content = '';
    try { content = JSON.parse(body).choices?.[0]?.message?.content || ''; } catch { /* handled below */ }
    const out = json ? parseJson(content) : content.trim();
    if (!out) {
      console.warn(`[AI] feature=${feature} model=${modelId} ${label}: HTTP ${res.status}, ${Buffer.byteLength(body)} bytes but no usable reply`);
      note(feature, { last_error: `${label}: no usable reply`, last_error_at: new Date().toISOString() });
      return null;
    }
    console.log(`[AI] feature=${feature} model=${modelId} ${label}: success HTTP ${res.status}, ${Buffer.byteLength(body)} bytes`);
    note(feature, { last_success: new Date().toISOString(), last_model: modelId });
    return out;
  }
  console.warn(`[AI] feature=${feature} ${label}: still rate-limited after one retry — skipped`);
  note(feature, { last_error: `${label}: HTTP 429 after retry`, last_error_at: new Date().toISOString() });
  return null;
}

// True if the feature can read a page by URL itself (Groq compound-mini)
function hasWebModel(feature) {
  const st = featureState(feature);
  return !st.disabled && !!st.webModel;
}

module.exports = { initAI, aiExtract, hasWebModel, FEATURES, PROVIDER_NAME };
