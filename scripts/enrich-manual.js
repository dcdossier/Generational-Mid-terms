#!/usr/bin/env node
'use strict';

/**
 * enrich-manual.js — backup summaries for analysis-manual.json.
 *
 * For each entry whose "description" is empty, asks the AI provider (feature
 * "ac", key MID_TERMS_AC, provider from AI_PROVIDER) for exactly three neutral
 * sentences in British English, each under 30 words, with no colons or dashes.
 * Generated text is marked "ai_summary": true. With Groq, compound-mini reads
 * the URL itself; with other providers this script fetches the page and sends
 * only a short text extract. AI_PROVIDER=none (the default) skips all of it.
 *
 * Never touches an entry that already has a description. If reading or the
 * checks fail, the entry is left as it is and the reason is logged. Capped at
 * the "ac" feature's call limit (see ai.js).
 */

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { initAI, aiExtract, hasWebModel } = require('./ai');
const { saveStatus } = require('./status');

const MANUAL_PATH = path.resolve(__dirname, '../analysis-manual.json');

const SYSTEM_PROMPT =
  'You summarise public web pages for a research website. Write in British English with a neutral tone. ' +
  'Never use colons or dashes. Reply with the summary only.';

const EXTRACT_CHARS = 5000;

// Short plain-text extract of a public page (article body if marked up), or null
async function pageExtract(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'DCDossier/2.0 (+https://github.com/dcdossier/Generational-Mid-terms)' }, timeout: 20000, size: 3e6 });
    if (!res.ok) { console.log(`  [page] ${url}: HTTP ${res.status}`); return null; }
    let html = await res.text();
    const article = html.match(/<article[\s\S]*?<\/article>/i);
    if (article) html = article[0];
    const text = html
      .replace(/<(script|style|nav|header|footer|aside|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return text.length > 200 ? text.slice(0, EXTRACT_CHARS) : null;
  } catch (err) {
    console.log(`  [page] ${url}: ${err.message}`);
    return null;
  }
}

// Returns null if the text is acceptable, otherwise the reason it isn't
function checkSummary(text) {
  const t = String(text || '').trim();
  if (!t) return 'empty reply';
  if (/\b(I (can(no|')t|am unable|was unable|could not)|unable to (access|read|open)|not able to access)\b/i.test(t)) return 'model could not read the page';
  if (/[:–—]|\s-\s|--/.test(t)) return 'contains a colon or dash';
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z"'‘“(])/).filter(Boolean);
  if (sentences.length !== 3) return `${sentences.length} sentences, not 3`;
  const long = sentences.find(s => s.split(/\s+/).length >= 30);
  if (long) return `a sentence has ${long.split(/\s+/).length} words (limit is under 30)`;
  return null;
}

async function main() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(MANUAL_PATH, 'utf8')); }
  catch (err) {
    console.error(`[enrich-manual] Could not read analysis-manual.json: ${err.message}`);
    process.exit(1);
  }
  const posts = Array.isArray(raw) ? raw : (raw.posts || []);
  const todo = posts.filter(p => p && p.url && !String(p.description || '').trim());
  console.log(`[enrich-manual] ${posts.length} entries, ${todo.length} without a description`);

  const aiOn = todo.length ? await initAI('ac') : false;   // AI_PROVIDER decides; lists models once
  if (todo.length && !aiOn) {
    console.log('[enrich-manual] AI is off or unavailable — entries left as they are');
    saveStatus();
    process.exit(0);
  }

  let written = 0;
  const rules = 'exactly three sentences, each under 30 words. British English, neutral tone, no colons, no dashes.';
  for (const p of todo) {
    const label = `summary "${String(p.title || p.url).slice(0, 60)}"`;
    let reply;
    if (hasWebModel('ac')) {
      reply = await aiExtract('ac', SYSTEM_PROMPT,
        `Read this page and summarise it in ${rules}\n\nURL: ${p.url}\nTitle: ${String(p.title || '').slice(0, 200)}`,
        { label, model: 'web', json: false, maxTokens: 300 });
    } else {
      const extract = await pageExtract(p.url);
      if (!extract) { console.log(`  [skip] ${p.url} — could not read the page; entry left unchanged`); continue; }
      reply = await aiExtract('ac', SYSTEM_PROMPT,
        `Summarise this article in ${rules}\n\nTitle: ${String(p.title || '').slice(0, 200)}\n\nArticle text (extract):\n${extract}`,
        { label, model: 'text', json: false, maxTokens: 300 });
    }
    if (reply === null) {
      console.log(`  [skip] ${p.url} — no AI summary (see the [AI] line above); entry left unchanged`);
      continue;
    }
    const text = reply.replace(/\s+/g, ' ').replace(/^["'“]|["'”]$/g, '').trim();
    const problem = checkSummary(text);
    if (problem) {
      console.log(`  [reject] ${p.url} — ${problem}; entry left unchanged`);
      continue;
    }
    p.description = text;
    p.ai_summary = true;
    written++;
    console.log(`  [ok] ${p.url}`);
  }

  if (written) fs.writeFileSync(MANUAL_PATH, JSON.stringify(raw, null, 2) + '\n');
  console.log(`[enrich-manual] Done — ${written} summaries written, ${todo.length - written} left without one`);
  saveStatus();
  process.exit(0);
}

main().catch(err => {
  console.error('[enrich-manual] Fatal error:', err);
  saveStatus();
  process.exit(1);
});
