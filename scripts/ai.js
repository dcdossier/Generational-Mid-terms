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
const GROQ_MODEL      = 'llama-3.3-70b-versatile';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// Once a provider fails with a non-retryable error (bad key, restricted
// account), skip it for the rest of the run instead of failing on every call.
const disabled = { groq: false, anthropic: false };

function parseJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function tryGroq(systemPrompt, userContent, maxTokens) {
  if (!GROQ_KEY || disabled.groq) return null;
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
          model: GROQ_MODEL,
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
      return parseJson(json.choices?.[0]?.message?.content);
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
    return parseJson(text);
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
    console.log(`  [AI] ${label}: used Groq (${GROQ_MODEL})`);
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
