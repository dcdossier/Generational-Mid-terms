#!/usr/bin/env node
'use strict';

/**
 * enrich-manual.js — fills gaps in analysis-manual.json, the single source for
 * the Analysis & Commentary page ("entries", plus "posts" for safety).
 *
 * An entry is enriched when it has "needs_enrich": true or is missing a title,
 * date or description. Only empty fields are filled; nothing typed by hand is
 * ever overwritten.
 *
 *   title, date   from the page's own metadata (og:title / <title>,
 *                 article:published_time / datePublished / date meta tags).
 *   description   exactly three neutral sentences in British English, each
 *                 under 30 words, no colons or dashes, from the AI provider
 *                 (feature "ac", key MID_TERMS_AC, provider from AI_PROVIDER),
 *                 marked "ai_summary": true. With Groq, compound-mini reads the
 *                 URL itself; other providers get a short text extract. If AI is
 *                 off (AI_PROVIDER=none, the default) or its reply fails the
 *                 checks, the page's own meta description is used instead,
 *                 marked "summary_source": "page".
 *
 *   image         every type except "research": YouTube and Spotify from their
 *                 oEmbed thumbnail_url (YouTube falls back to i.ytimg.com),
 *                 newsletters from the Substack feed's channel logo (one image
 *                 for the whole publication), everything else from og:image,
 *                 else twitter:image. An entry that already has an image (for
 *                 example one set on the input page) is never changed.
 *
 * "needs_enrich" is cleared once title, date and description are all present.
 * Each entry gets at most MAX_ATTEMPTS tries ("enrich_attempts"), so a page
 * that cannot be read is not fetched on every run. AI calls are capped at the
 * "ac" feature's call limit (see ai.js).
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
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-GB,en;q=0.9',
};
const MAX_ATTEMPTS = 3;

const decode = s => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Content of the first <meta> whose property/name/itemprop is one of the names
function metaTag(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*>`, 'i');
    const tag = html.match(re);
    const c = tag && tag[0].match(/content=["']([^"']*)["']/i);
    if (c && c[1].trim()) return decode(c[1]);
  }
  return '';
}

// Fetches a public page once: its metadata plus a short plain-text extract
async function readPage(url) {
  try {
    // Browser-like headers: several news sites refuse requests that look automated
    const res = await fetch(url, { headers: PAGE_HEADERS, timeout: 20000, size: 3e6 });
    const html = await res.text();
    console.log(`  [fetch] ${url}: HTTP ${res.status}, ${Buffer.byteLength(html)} bytes`);
    if (!res.ok) return null;
    const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const dateRaw = metaTag(html, ['article:published_time', 'datePublished', 'og:published_time', 'publish-date', 'pubdate', 'date', 'DC.date.issued', 'uploadDate'])
      || (ld ? ld[1] : '');
    const date = dateRaw && !isNaN(new Date(dateRaw)) ? new Date(dateRaw).toISOString() : '';
    let body = html;
    const article = html.match(/<article[\s\S]*?<\/article>/i);
    if (article) body = article[0];
    const text = decode(body
      .replace(/<(script|style|nav|header|footer|aside|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#?\w+;/g, m => decode(m)));
    const img = metaTag(html, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
    return {
      image: img ? absUrl(img, res.url || url) : '',
      title: metaTag(html, ['og:title', 'twitter:title']) || (titleTag ? decode(titleTag[1]) : ''),
      date,
      description: metaTag(html, ['og:description', 'description', 'twitter:description']),
      extract: text.length > 200 ? text.slice(0, EXTRACT_CHARS) : null,
    };
  } catch (err) {
    console.log(`  [page] ${url}: ${err.message}`);
    return null;
  }
}

function absUrl(u, base) {
  try { const x = new URL(u, base); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href.replace(/^http:/, 'https:') : ''; }
  catch (e) { return ''; }
}

async function getJson(url, label) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DCDossier/2.0)' }, timeout: 15000 });
    const body = await res.text();
    console.log(`  [fetch] ${label}: HTTP ${res.status}, ${Buffer.byteLength(body)} bytes`);
    return res.ok ? JSON.parse(body) : null;
  } catch (err) { console.log(`  [fetch] ${label}: ${err.message}`); return null; }
}

function youTubeId(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^(www|m)\./, '');
    if (h === 'youtu.be') return x.pathname.slice(1).split('/')[0] || null;
    if (h === 'youtube.com') return x.searchParams.get('v') || (x.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1] || null;
  } catch (e) { /* not a URL */ }
  return null;
}

// Channel <image><url> of a publication's RSS feed (Substack: <origin>/feed), cached per origin
const _feedLogos = new Map();
async function feedLogo(entryUrl) {
  let origin;
  try { origin = new URL(entryUrl).origin; } catch (e) { return ''; }
  if (_feedLogos.has(origin)) return _feedLogos.get(origin);
  let logo = '';
  try {
    const res = await fetch(origin + '/feed', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DCDossier/2.0)' }, timeout: 15000 });
    const xml = await res.text();
    console.log(`  [fetch] ${origin}/feed: HTTP ${res.status}, ${Buffer.byteLength(xml)} bytes`);
    const chan = res.ok ? xml.split(/<item[\s>]/i)[0] : '';
    const m = chan.match(/<image>[\s\S]*?<url>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/i);
    if (m) logo = absUrl(decode(m[1]), origin);
  } catch (err) { console.log(`  [fetch] ${origin}/feed: ${err.message}`); }
  _feedLogos.set(origin, logo);
  return logo;
}

// Best image for an entry, or '' (pageCache avoids fetching a page twice in one run)
async function findImage(p, pageCache) {
  const yt = youTubeId(p.url);
  if (yt) {
    const o = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(p.url)}`, `YouTube oEmbed ${yt}`);
    return (o && o.thumbnail_url) || `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`;
  }
  if (/^https?:\/\/open\.spotify\.com\//i.test(p.url)) {
    const o = await getJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(p.url)}`, 'Spotify oEmbed');
    if (o && o.thumbnail_url) return o.thumbnail_url;
  }
  if (p.type === 'newsletter') {
    const logo = await feedLogo(p.url);
    if (logo) return logo;
  }
  if (!pageCache.has(p.url)) pageCache.set(p.url, await readPage(p.url));
  const page = pageCache.get(p.url);
  return (page && page.image) || '';
}

const MAX_IMAGE_ATTEMPTS = 3;
const needsImage = p => p && p.url && String(p.type || '').toLowerCase() !== 'research'
  && !String(p.image || '').trim() && (p.image_attempts || 0) < MAX_IMAGE_ATTEMPTS;

const blank = v => !String(v || '').trim();
const hasDate = v => !blank(v) && !isNaN(new Date(v));
const needsWork = e => e && e.url && (e.needs_enrich === true || blank(e.title) || !hasDate(e.date) || blank(e.description))
  && (e.enrich_attempts || 0) < MAX_ATTEMPTS;

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

async function aiSummary(p, page) {
  const label = `summary "${String(p.title || p.url).slice(0, 60)}"`;
  const rules = 'exactly three sentences, each under 30 words. British English, neutral tone, no colons, no dashes.';
  let reply;
  if (hasWebModel('ac')) {
    reply = await aiExtract('ac', SYSTEM_PROMPT,
      `Read this page and summarise it in ${rules}\n\nURL: ${p.url}\nTitle: ${String(p.title || '').slice(0, 200)}`,
      { label, model: 'web', json: false, maxTokens: 300 });
  } else {
    if (!page || !page.extract) { console.log(`  [ai] ${p.url} — no page text to summarise`); return null; }
    reply = await aiExtract('ac', SYSTEM_PROMPT,
      `Summarise this article in ${rules}\n\nTitle: ${String(p.title || '').slice(0, 200)}\n\nArticle text (extract):\n${page.extract}`,
      { label, model: 'text', json: false, maxTokens: 300 });
  }
  if (reply === null) return null;   // reason already logged by ai.js
  const text = reply.replace(/\s+/g, ' ').replace(/^["'“]|["'”]$/g, '').trim();
  const problem = checkSummary(text);
  if (problem) { console.log(`  [reject] ${p.url} — AI summary: ${problem}`); return null; }
  return text;
}

async function main() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(MANUAL_PATH, 'utf8')); }
  catch (err) {
    console.error(`[enrich-manual] Could not read analysis-manual.json: ${err.message}`);
    process.exit(1);
  }
  const posts = Array.isArray(raw) ? raw : [...(raw.entries || []), ...(raw.posts || [])];
  const todo = posts.filter(needsWork);
  const imageTodo = posts.filter(needsImage);
  console.log(`[enrich-manual] ${posts.length} entries, ${todo.length} to enrich, ${imageTodo.length} without an image`);
  if (!todo.length && !imageTodo.length) { saveStatus(); process.exit(0); }
  const pageCache = new Map();

  const aiOn = todo.some(p => blank(p.description)) ? await initAI('ac') : false;   // AI_PROVIDER decides
  if (!aiOn) console.log('[enrich-manual] AI is off or unavailable; summaries fall back to the page description');

  let changed = 0;
  for (const p of todo) {
    const filled = [];
    const page = await readPage(p.url);
    pageCache.set(p.url, page);
    if (page) {
      if (blank(p.title) && page.title) { p.title = page.title; filled.push('title'); }
      if (!hasDate(p.date) && page.date) { p.date = page.date; filled.push('date'); }
    }
    if (blank(p.description)) {
      const text = aiOn ? await aiSummary(p, page) : null;
      if (text) { p.description = text; p.ai_summary = true; filled.push('AI summary'); }
      else if (page && page.description.length >= 60) {
        p.description = page.description; p.summary_source = 'page'; filled.push('page description');
      }
    }
    const done = !blank(p.title) && hasDate(p.date) && !blank(p.description);
    if (done) { p.needs_enrich = false; delete p.enrich_attempts; }
    else { p.needs_enrich = true; p.enrich_attempts = (p.enrich_attempts || 0) + 1; }
    changed++;
    const missing = ['title', 'date', 'description'].filter(k => k === 'date' ? !hasDate(p.date) : blank(p[k]));
    console.log(`  [${done ? 'ok' : 'partial'}] ${p.url} — filled: ${filled.join(', ') || 'nothing'}${missing.length ? `; still missing: ${missing.join(', ')} (attempt ${p.enrich_attempts} of ${MAX_ATTEMPTS})` : ''}`);
  }

  for (const p of imageTodo) {
    const img = await findImage(p, pageCache);
    if (img) { p.image = img; delete p.image_attempts; console.log(`  [image] ${p.url} — ${img}`); }
    else { p.image_attempts = (p.image_attempts || 0) + 1; console.log(`  [image] ${p.url} — none found (attempt ${p.image_attempts} of ${MAX_IMAGE_ATTEMPTS})`); }
    changed++;
  }

  if (changed) {
    if (!Array.isArray(raw)) { raw.meta = raw.meta || {}; raw.meta.last_updated = new Date().toISOString(); }
    fs.writeFileSync(MANUAL_PATH, JSON.stringify(raw, null, 2) + '\n');
  }
  console.log(`[enrich-manual] Done — ${changed} entries updated`);
  saveStatus();
  process.exit(0);
}

main().catch(err => {
  console.error('[enrich-manual] Fatal error:', err);
  saveStatus();
  process.exit(1);
});
