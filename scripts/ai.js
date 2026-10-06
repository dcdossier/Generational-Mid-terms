'use strict';

/**
 * ai.js — optional Groq calls, one API key per site tab ("feature").
 *
 *   feature  secret            used for                               max calls/run
 *   home     MID_TERMS_HOME    Home tab: Congress approval backup     4
 *   et       MID_TERMS_ET      Election Trends (reserved)             0
 *   ii       MID_TERMS_II      India's Interest (reserved)            0
 *   ac       MID_TERMS_AC      Analysis & Commentary summariser       10
 *
 * A feature only ever uses its own key. If the key is missing, the model it
 * needs isn't listed, its call cap is reached, or Groq returns a 4xx, that
 * feature gets null for the rest of the run and the caller uses its non-AI
 * path. Calls are made one at a time, at least 2 seconds apart; a 429 is
 * retried once after a wait. Keys are never logged.
 *
 * Usage: await initAI('home') once at the start of a run (lists Groq's models
 * and logs them), then aiExtract('home', systemPrompt, userContent, opts).
 */

const fetch = require('node-fetch');
const { recordAI } = require('./status');

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const FEATURES = {
  home: { env: 'MID_TERMS_HOME', maxCalls: 4 },
  et:   { env: 'MID_TERMS_ET',   maxCalls: 0 },
  ii:   { env: 'MID_TERMS_II',   maxCalls: 0 },
  ac:   { env: 'MID_TERMS_AC',   maxCalls: 10 },
};
// Extraction: first of these the models list shows. Reading a web page: compound-mini.
const TEXT_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const WEB_MODEL = 'groq/compound-mini';
const GAP_MS = 2000;
const MAX_INPUT_CHARS = 6000;          // short extracts only, never whole pages
const MAX_RETRY_WAIT_MS = 30000;

const state = {};                      // feature → { calls, disabled, models, textModel, webModel }
let lastCallAt = 0;
let queue = Promise.resolve();         // serialises every Groq request

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
  recordAI(feature, { calls_this_run: st.calls, ...patch });
}

/**
 * Lists Groq's models with this feature's key (once per run) and picks the
 * models it will use. Returns true if the feature can make calls.
 */
async function initAI(feature) {
  const f = FEATURES[feature];
  if (!f) throw new Error(`Unknown AI feature "${feature}"`);
  const st = featureState(feature);
  if (st.models) return !st.disabled;
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
    const res = await serial(() => fetch(`${GROQ_BASE}/models`, {
      headers: { 'Authorization': `Bearer ${keyFor(feature)}` },
      timeout: 15000,
    }));
    console.log(`[AI] ${feature}: models list HTTP ${res.status}`);
    if (!res.ok) {
      const body = redact(await res.text()).slice(0, 160);
      st.disabled = true;
      st.models = [];
      note(feature, { key_present: true, last_error: `models list HTTP ${res.status}: ${body}`, last_error_at: new Date().toISOString() });
      return false;
    }
    st.models = ((await res.json()).data || []).filter(m => m.active !== false).map(m => m.id).sort();
  } catch (err) {
    st.disabled = true;
    st.models = [];
    note(feature, { key_present: true, last_error: `models list: ${redact(err.message)}`, last_error_at: new Date().toISOString() });
    console.warn(`[AI] ${feature}: models list failed: ${redact(err.message)}`);
    return false;
  }
  console.log(`[AI] ${feature}: ${st.models.length} models available: ${st.models.join(', ')}`);
  st.textModel = TEXT_MODELS.find(m => st.models.includes(m)) || null;
  st.webModel = st.models.includes(WEB_MODEL) ? WEB_MODEL : null;
  if (!st.textModel) console.warn(`[AI] ${feature}: none of ${TEXT_MODELS.join(', ')} listed — extraction will be skipped`);
  if (!st.webModel) console.warn(`[AI] ${feature}: ${WEB_MODEL} not listed — page reading will be skipped`);
  console.log(`[AI] ${feature}: extraction model ${st.textModel || '—'}, page-reading model ${st.webModel || '—'}, cap ${f.maxCalls} calls`);
  note(feature, { key_present: true, text_model: st.textModel, web_model: st.webModel });
  return true;
}

function parseJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * One Groq chat completion for a feature.
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
      res = await serial(() => fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${keyFor(feature)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          temperature: 0,
          max_tokens: maxTokens,
          ...(json && model === 'text' ? { response_format: { type: 'json_object' } } : {}),
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
      console.warn(`[AI] feature=${feature} model=${modelId} ${label}: HTTP 429 — retrying once in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const msg = redact(body).slice(0, 160);
      console.warn(`[AI] feature=${feature} model=${modelId} ${label}: failed HTTP ${res.status}: ${msg}`);
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
      console.warn(`[AI] feature=${feature} model=${modelId} ${label}: HTTP ${res.status} but no usable reply`);
      note(feature, { last_error: `${label}: no usable reply`, last_error_at: new Date().toISOString() });
      return null;
    }
    console.log(`[AI] feature=${feature} model=${modelId} ${label}: success HTTP ${res.status}`);
    note(feature, { last_success: new Date().toISOString(), last_model: modelId });
    return out;
  }
  console.warn(`[AI] feature=${feature} ${label}: still rate-limited after one retry — skipped`);
  note(feature, { last_error: `${label}: HTTP 429 after retry`, last_error_at: new Date().toISOString() });
  return null;
}

module.exports = { initAI, aiExtract, FEATURES };
