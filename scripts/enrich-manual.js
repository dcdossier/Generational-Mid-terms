#!/usr/bin/env node
'use strict';

/**
 * enrich-manual.js — backup summaries for analysis-manual.json.
 *
 * For each entry whose "description" is empty, asks Groq's compound-mini model
 * (feature "ac", key MID_TERMS_AC) to read the entry's URL and write exactly
 * three neutral sentences in British English, each under 30 words, with no
 * colons or dashes. Generated text is marked "ai_summary": true.
 *
 * Never touches an entry that already has a description. If reading or the
 * checks fail, the entry is left as it is and the reason is logged. Capped at
 * the "ac" feature's call limit (see ai.js).
 */

const fs   = require('fs');
const path = require('path');
const { initAI, aiExtract } = require('./ai');
const { saveStatus } = require('./status');

const MANUAL_PATH = path.resolve(__dirname, '../analysis-manual.json');

const SYSTEM_PROMPT =
  'You summarise public web pages for a research website. Write in British English with a neutral tone. ' +
  'Never use colons or dashes. Reply with the summary only.';

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

  await initAI('ac');   // lists Groq models once per run

  let written = 0;
  for (const p of todo) {
    const reply = await aiExtract('ac', SYSTEM_PROMPT,
      `Read this page and summarise it in exactly three sentences, each under 30 words. ` +
      `British English, neutral tone, no colons, no dashes.\n\nURL: ${p.url}\nTitle: ${String(p.title || '').slice(0, 200)}`,
      { label: `summary "${String(p.title || p.url).slice(0, 60)}"`, model: 'web', json: false, maxTokens: 300 });
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
