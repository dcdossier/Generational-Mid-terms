#!/usr/bin/env node
'use strict';

/**
 * enrich-manual.js — fills gaps in analysis-manual.json, the single source for
 * the Analysis & Commentary page ("entries", plus "posts" for safety).
 *
 * Every run first tidies all entries: links are cleaned (brackets, markdown
 * links, doubled "https://") and HTML entities in titles and summaries are
 * decoded.
 *
 * An entry is enriched when it has "needs_enrich": true, a blocked-page title,
 * or is missing a title, date or description. Only empty fields are filled;
 * nothing typed by hand (a date included) is ever overwritten.
 *
 *   fetching      the page is read with browser-like headers, then with a plain
 *                 browser User-Agent, then from the Wayback Machine. A response
 *                 that is a bot check ("Just a moment…", "Attention Required",
 *                 "Access denied" …) counts as a failed fetch. Last resort for
 *                 WordPress sites (e.g. ThePrint) whose links end in a post
 *                 number: the site's own REST API (/wp-json/wp/v2/posts/<id>).
 *   title         og:title, else <title>.
 *   date          the first that works, saved with "date_source":
 *                   json-ld    JSON-LD datePublished
 *                   meta       article:published_time, og:published_time,
 *                              parsely-pub-date, pubdate, date, DC.date.issued
 *                   time-tag   <time datetime> inside the <article>
 *                   url        a date in the link, e.g. /2026/07/10/
 *                   youtube    the video's publish date
 *                   spotify    the episode's release date
 *                   wordpress-api  date_gmt from the WordPress REST API
 *                 Never added_at or the day of the run; a date on or after
 *                 today is ignored (some sites stamp pages with the current
 *                 time). If nothing works the date stays empty and
 *                 "date_missing": true is set.
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
const he = require('he');
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
// A plain browser User-Agent: some bot checks reject the fuller header set above
const PLAIN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Accept': 'text/html',
};
const MAX_ATTEMPTS = 3;

// Titles of bot checks and error pages, never real article titles
const BLOCKED_TITLE = /^\s*(just a moment|attention required|access denied|access to this page has been denied|forbidden|403 forbidden|are you a robot|security check|verify(ing)? you are (a )?human|please wait|one more step|request blocked|you have been blocked|captcha|error \d{3}|page not found|404)\b/i;
const isBlockedTitle = t => BLOCKED_TITLE.test(String(t || ''));

const decode = s => he.decode(String(s || '')).replace(/\s+/g, ' ').trim();

// Content of the first <meta> whose property/name/itemprop is one of the names
function metaTag(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n.replace(/\./g, '\\.')}["'][^>]*>`, 'i');
    const tag = html.match(re);
    const c = tag && tag[0].match(/content=["']([^"']*)["']/i);
    if (c && c[1].trim()) return decode(c[1]);
  }
  return '';
}

// Cleans a pasted link: markdown [text](url), brackets, doubled or broken scheme
function cleanUrl(u) {
  let s = String(u || '').trim();
  const md = s.match(/\[[^\]]*\]\(\s*([^)\s]+)\s*\)/);
  if (md) s = md[1];
  s = s.replace(/[()[\]<>"'\s]/g, '');
  // Keep the last scheme when there is more than one ("https://(https//x" → "https//x")
  const schemes = [...s.matchAll(/https?:?\/\//gi)];
  if (schemes.length) s = s.slice(schemes[schemes.length - 1].index);
  s = s.replace(/^(https?):?\/\//i, (m, p) => p.toLowerCase() + '://');
  if (!/^https?:\/\//i.test(s) && /^[\w-]+(\.[\w-]+)+\//.test(s)) s = 'https://' + s;
  try { return new URL(s).href; } catch (e) { return String(u || '').trim(); }
}

// A usable publication date: a real date from 2000 up to yesterday (UTC)
function validDate(v) {
  if (!v) return '';
  const d = new Date(String(v).trim());
  if (isNaN(d)) return '';
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return d.getUTCFullYear() >= 2000 && d < today ? d.toISOString() : '';
}

// JSON-LD datePublished: parsed from every ld+json block, then a plain search
function jsonLdDate(html) {
  const found = [];
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.datePublished) found.push(o.datePublished);
    Object.values(o).forEach(walk);
  };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch (e) { /* malformed block */ }
  }
  const raw = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (raw) found.push(raw[1]);
  for (const v of found) { const d = validDate(v); if (d) return d; }
  return '';
}

function timeTagDate(html) {
  const article = html.match(/<article[\s\S]*?<\/article>/i);
  if (!article) return '';
  for (const m of article[0].matchAll(/<time[^>]+datetime=["']([^"']+)["']/gi)) { const d = validDate(m[1]); if (d) return d; }
  return '';
}

function urlDate(u) {
  const m = String(u).match(/\/(20\d{2})[\/-](0?[1-9]|1[0-2])[\/-](0?[1-9]|[12]\d|3[01])(?=[\/-]|$)/);
  return m ? validDate(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00Z`) : '';
}

// Publication date of a page, in the documented order; { date, source } or null
function pageDate(html, url) {
  let d;
  if (html && (d = jsonLdDate(html))) return { date: d, source: 'json-ld' };
  if (html && (d = validDate(metaTag(html, ['article:published_time', 'og:published_time', 'parsely-pub-date', 'pubdate', 'date', 'DC.date.issued'])))) return { date: d, source: 'meta' };
  if (html && (d = timeTagDate(html))) return { date: d, source: 'time-tag' };
  if ((d = urlDate(url))) return { date: d, source: 'url' };
  if (html && youTubeId(url)) {
    const raw = metaTag(html, ['datePublished', 'uploadDate']) || ((html.match(/"(?:publishDate|uploadDate)"\s*:\s*"([^"]+)"/) || [])[1]);
    if ((d = validDate(raw))) return { date: d, source: 'youtube' };
  }
  return null;
}

// Spotify episode pages are an app shell; the embed page carries the release date
async function spotifyDate(url) {
  const m = String(url).match(/open\.spotify\.com\/(episode|show)\/([A-Za-z0-9]+)/);
  if (!m) return '';
  const html = await getText(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, PLAIN_HEADERS, 'Spotify embed');
  const raw = html && (html.match(/"releaseDate"\s*:\s*\{\s*"isoString"\s*:\s*"([^"]+)"/) || [])[1];
  return validDate(raw);
}

async function getText(url, headers, label) {
  try {
    const res = await fetch(url, { headers, timeout: 25000, size: 4e6 });
    const body = await res.text();
    console.log(`  [fetch] ${label || url}: HTTP ${res.status}, ${Buffer.byteLength(body)} bytes`);
    return res.ok ? body : null;
  } catch (err) {
    console.log(`  [fetch] ${label || url}: ${err.message}`);
    return null;
  }
}

// HTML of a public page, trying three ways; a bot-check page counts as a failure.
// Returns { html, via } or null.
async function fetchHtml(url) {
  const tries = [
    { via: 'direct', url, headers: PAGE_HEADERS },
    { via: 'plain user-agent', url, headers: PLAIN_HEADERS },
    { via: 'wayback', url: `https://web.archive.org/web/2026id_/${url}`, headers: PLAIN_HEADERS },
  ];
  for (const t of tries) {
    const html = await getText(t.url, t.headers, `${t.via} ${url}`);
    if (!html) continue;
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    if (isBlockedTitle(decode(title)) || /challenge-platform|cf-chl-|_Incapsula_Resource|px-captcha/.test(html.slice(0, 20000)) && html.length < 30000) {
      console.log(`  [blocked] ${t.via} ${url}: bot check ("${decode(title).slice(0, 40)}")`);
      continue;
    }
    return { html, via: t.via };
  }
  return null;
}

// WordPress REST API for a link ending in a post number; same shape as readPage
async function wordpressPost(url) {
  const m = String(url).match(/^(https?:\/\/[^/]+)\/.*\/(\d{4,})\/?$/);
  if (!m) return null;
  const body = await getText(`${m[1]}/wp-json/wp/v2/posts/${m[2]}?_fields=date_gmt,title,excerpt,link,jetpack_featured_media_url`,
    { ...PLAIN_HEADERS, Accept: 'application/json' }, `wordpress-api ${url}`);
  let j;
  try { j = body && JSON.parse(body); } catch (e) { return null; }
  if (!j || !j.link || new URL(j.link).hostname.replace(/^www\./, '') !== new URL(url).hostname.replace(/^www\./, '')) return null;
  const date = validDate(j.date_gmt ? j.date_gmt + 'Z' : '');
  return {
    via: 'wordpress-api',
    image: j.jetpack_featured_media_url || '',
    title: decode(j.title && j.title.rendered),
    published: date ? { date, source: 'wordpress-api' } : null,
    description: decode(String((j.excerpt && j.excerpt.rendered) || '').replace(/<[^>]+>/g, ' ')),
    extract: null,
  };
}

// Reads a page once: metadata, publication date and a short plain-text extract
async function readPage(url) {
  const got = await fetchHtml(url);
  if (!got) return wordpressPost(url);
  const { html, via } = got;
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let body = html;
  const article = html.match(/<article[\s\S]*?<\/article>/i);
  if (article) body = article[0];
  const text = decode(body
    .replace(/<(script|style|nav|header|footer|aside|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
  const img = metaTag(html, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
  const title = metaTag(html, ['og:title', 'twitter:title']) || (titleTag ? decode(titleTag[1]) : '');
  return {
    via,
    image: img ? absUrl(img, url) : '',
    title: isBlockedTitle(title) ? '' : title,
    published: pageDate(html, url),
    description: metaTag(html, ['og:description', 'description', 'twitter:description']),
    extract: text.length > 200 ? text.slice(0, EXTRACT_CHARS) : null,
  };
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
const needsWork = e => e && e.url && (e.needs_enrich === true || blank(e.title) || isBlockedTitle(e.title) || !hasDate(e.date) || blank(e.description))
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
  let changed = 0;

  // Tidy every entry: clean links, decode HTML entities
  for (const p of posts) {
    if (!p || !p.url) continue;
    const url = cleanUrl(p.url);
    if (url !== p.url) {
      console.log(`  [url] ${p.url} → ${url}`);
      p.url = url; delete p.image_attempts; delete p.enrich_attempts; changed++;
    }
    for (const k of ['title', 'description']) {
      if (/&(#\d+|#x[\da-f]+|[a-z]+);/i.test(p[k] || '')) { p[k] = decode(p[k]); changed++; console.log(`  [entities] ${k} of ${p.url}`); }
    }
  }

  const todo = posts.filter(needsWork);
  const imageTodo = posts.filter(needsImage);
  console.log(`[enrich-manual] ${posts.length} entries, ${todo.length} to enrich, ${imageTodo.length} without an image`);
  const pageCache = new Map();

  const aiOn = todo.some(p => blank(p.description)) ? await initAI('ac') : false;   // AI_PROVIDER decides
  if (todo.length && !aiOn) console.log('[enrich-manual] AI is off or unavailable; summaries fall back to the page description');

  for (const p of todo) {
    const filled = [];
    const page = await readPage(p.url);
    pageCache.set(p.url, page);
    if (isBlockedTitle(p.title)) { p.title = ''; filled.push('bot-check title cleared'); }
    if (page) {
      if (blank(p.title) && page.title) { p.title = page.title; filled.push('title'); }
      if (page.via === 'wayback') p.fetched_via = 'wayback';
    }
    if (!hasDate(p.date)) {
      // Hand-set dates are never replaced; only an empty date is filled
      let found = page && page.published;
      if (!found && urlDate(p.url)) found = { date: urlDate(p.url), source: 'url' };
      if (!found && /open\.spotify\.com\//.test(p.url)) { const d = await spotifyDate(p.url); if (d) found = { date: d, source: 'spotify' }; }
      if (found) { p.date = found.date; p.date_source = found.source; delete p.date_missing; filled.push(`date (${found.source})`); }
      else { p.date = ''; p.date_missing = true; }
    } else delete p.date_missing;
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
    console.log(`  [${done ? 'ok' : 'partial'}] ${p.url} — ${page ? 'read ' + page.via : 'could not be read'}; filled: ${filled.join(', ') || 'nothing'}${missing.length ? `; still missing: ${missing.join(', ')} (attempt ${p.enrich_attempts} of ${MAX_ATTEMPTS})` : ''}`);
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
  console.log(`[enrich-manual] Done — ${changed} changes`);
  saveStatus();
  process.exit(0);
}

main().catch(err => {
  console.error('[enrich-manual] Fatal error:', err);
  saveStatus();
  process.exit(1);
});
