'use strict';

/**
 * ai.js — optional AI extraction shared by the fetch scripts.
 *
 * aiExtract() tries Groq, then Anthropic, then returns null. Every caller must
 * treat null as "no AI available" and fall back to its non-AI path.
 *
 * Env vars (both optional):
 *  GROQ_API_KEY      — Groq API key
 *  ANTHROPIC_API_KEY — Anthropic API key
 */

const fetch = require('node-fetch');

const GROQ_KEY        = process.env.GROQ_API_KEY || '';
// First one that Groq's models API lists as available is used. Checked against
// console.groq.com/docs/deprecations (Oct 2026): llama-3.1-8b-instant was shut
// down on 16 Aug 2026; these three are current production models.
const GROQ_MODEL_PREFERENCE = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// Once a provider fails with a non-retryable error (bad key, restricted
// account), skip it for the rest of the run instead of failing on every call.
const disabled = { groq: false, anthropic: false };

function parseJson(text, provider) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn(`  [AI] ${provider} reply had no JSON object: ${String(text || '').slice(0, 80)}`);
    return null;
  }
  try { return JSON.parse(match[0]); }
  catch (err) {
    console.warn(`  [AI] ${provider} reply was not valid JSON (${err.message}): ${match[0].slice(0, 80)}`);
    return null;
  }
}

// Picks a Groq model from the live models list (once per run). Returns null and
// disables Groq if the list can't be read with this key or no preferred model
// is available; network/5xx errors fall back to the first preference.
let groqModel = null;
async function resolveGroqModel() {
  if (groqModel || !GROQ_KEY || disabled.groq) return groqModel;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
      timeout: 15000,
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`  [AI] Groq models API HTTP ${res.status}: ${body.slice(0, 120)}`);
      if (res.status < 500 && res.status !== 429) { disabled.groq = true; return null; }
      groqModel = GROQ_MODEL_PREFERENCE[0];
    } else {
      const ids = ((await res.json()).data || []).filter(m => m.active !== false).map(m => m.id);
      groqModel = GROQ_MODEL_PREFERENCE.find(id => ids.includes(id)) || null;
      if (!groqModel) {
        console.warn(`  [AI] Groq models API lists none of ${GROQ_MODEL_PREFERENCE.join(', ')} — disabling Groq. Available: ${ids.join(', ')}`);
        disabled.groq = true;
        return null;
      }
      console.log(`  [AI] Groq models API: ${ids.length} models available; using ${groqModel}`);
    }
  } catch (err) {
    console.warn(`  [AI] Groq models API error: ${err.message} — trying ${GROQ_MODEL_PREFERENCE[0]}`);
    groqModel = GROQ_MODEL_PREFERENCE[0];
  }
  return groqModel;
}

async function tryGroq(systemPrompt, userContent, maxTokens) {
  const model = await resolveGroqModel();
  if (!model) return null;
  // One retry, and only for rate limits, server errors and network failures.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userContent },
          ],
        }),
        timeout: 30000,
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`  [AI] Groq HTTP ${res.status}: ${body.slice(0, 120)}`);
        if (res.status === 429 || res.status >= 500) continue;
        disabled.groq = true; // 4xx: bad key, restricted org, bad model — won't fix itself this run
        return null;
      }
      const json = await res.json();
      return parseJson(json.choices?.[0]?.message?.content, `Groq (${model})`);
    } catch (err) {
      console.warn(`  [AI] Groq error: ${err.message}`);
    }
  }
  return null;
}

let anthropicClient = null;

async function tryAnthropic(systemPrompt, userContent, maxTokens) {
  if (!ANTHROPIC_KEY || disabled.anthropic) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  // The SDK retries 408/409/429/5xx and connection errors itself (2 retries).
  anthropicClient = anthropicClient || new Anthropic({ apiKey: ANTHROPIC_KEY, timeout: 30000 });
  try {
    const response = await anthropicClient.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system: systemPrompt + ' Respond with a single JSON object and nothing else.',
      messages: [{ role: 'user', content: userContent }],
    });
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return parseJson(text, 'Anthropic');
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.warn(`  [AI] Anthropic ${err.status}: ${err.message.slice(0, 120)} — disabling for this run`);
      disabled.anthropic = true;
    } else if (err instanceof Anthropic.APIError) {
      console.warn(`  [AI] Anthropic ${err.status ?? 'connection error'}: ${err.message.slice(0, 120)}`);
    } else {
      console.warn(`  [AI] Anthropic error: ${err.message}`);
    }
    return null;
  }
}

/**
 * Ask an AI provider to return a JSON object.
 * @param {string} systemPrompt
 * @param {string} userContent
 * @param {{label?: string, maxTokens?: number}} [opts] label names the task in logs
 * @returns {Promise<object|null>} parsed JSON, or null if no provider succeeded
 */
async function aiExtract(systemPrompt, userContent, { label = 'extract', maxTokens = 512 } = {}) {
  const content = String(userContent || '').slice(0, 14000);

  const fromGroq = await tryGroq(systemPrompt, content, maxTokens);
  if (fromGroq) {
    console.log(`  [AI] ${label}: used Groq (${groqModel})`);
    return fromGroq;
  }
  const fromAnthropic = await tryAnthropic(systemPrompt, content, maxTokens);
  if (fromAnthropic) {
    console.log(`  [AI] ${label}: used Anthropic (${ANTHROPIC_MODEL})`);
    return fromAnthropic;
  }
  if (!warnedNoProvider.has(label)) {
    warnedNoProvider.add(label);
    console.warn(`  [AI] ${label}: no AI provider available — returning null (further misses for this task not logged)`);
  }
  return null;
}

const warnedNoProvider = new Set();

function aiStatus() {
  return `Groq ${GROQ_KEY ? '✓ set' : '✗ missing'}, Anthropic ${ANTHROPIC_KEY ? '✓ set' : '✗ missing'}`;
}

module.exports = { aiExtract, aiStatus };

// `node scripts/ai.js --check-models` logs which Groq model this run would use.
// Always exits 0: AI is optional, so this must never fail the workflow.
if (require.main === module && process.argv.includes('--check-models')) {
  console.log(`[AI] Keys: ${aiStatus()}`);
  resolveGroqModel().then(m => {
    console.log(m ? `[AI] Groq model for this run: ${m}` : '[AI] Groq unavailable for this run — Anthropic or non-AI paths will be used');
    process.exit(0);
  });
}
