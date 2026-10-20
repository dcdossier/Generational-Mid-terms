#!/usr/bin/env node
'use strict';

/**
 * enrich-manual.js — fills gaps in analysis-manual.json, the single source for
 * the Analysis & Commentary page ("entries", plus "posts" for safety).
 *
 * Every run first tidies all entries: links are cleaned (brackets, markdown
 * links, doubled "https://"), HTML entities in titles and summaries are
 * decoded, titles lose "Opinion |" prefixes and " - Site.com" suffixes, titles
 * that are bot-check pages or bare links are cleared (so the entry is fetched
 * again), and publication names are normalised (SOURCE_NAMES).
 *
 * An entry is enriched when it has "needs_enrich": true, a blocked-page title,
 * or is missing a title, date or description. Only empty fields are filled;
 * nothing typed by hand (a date included) is ever overwritten.
 *
 *   substack      any Substack link is read from Substack's JSON API first:
 *                   substack.com/@x/note/p-<id>, substack.com/home/post/p-<id>,
 *                   open.substack.com/... p-<id>  →  substack.com/api/v1/posts/by-id/<id>
 *                   <pub>.substack.com/p/<slug> or a custom domain /p/<slug>
 *                                                 →  https://<host>/api/v1/posts/<slug>
 *                 It gives the title, post_date, subtitle (the summary), cover_image
 *                 and canonical_url. Note and app links are replaced by the
 *                 canonical post link; the link as pasted is kept in "source_url".
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
 * Tracking parameters (utm_*, r, s, triedRedirect) are removed from every link.
 *
 * Retries: a failed entry is tried again 6 hours later, then every 24 hours
 * ("next_try_at"), up to MAX_ATTEMPTS tries ("enrich_attempts"); images follow
 * the same rule ("image_attempts", "next_image_try_at"). The exact reason for
 * every failure (HTTP status, bot check, timeout) is logged and kept in
 * "last_error". After MAX_ATTEMPTS failed tries an entry still missing its title
 * or date is marked "needs_manual": true and left for the input page.
 * AI calls are capped at the "ac" feature's call limit (see ai.js).
 */

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const he = require('he');
const { initAI, aiExtract, hasWebModel } = require('./ai');
const { saveStatus } = require('./status');

// ENRICH_FILE lets a test run work on a copy
const MANUAL_PATH = path.resolve(process.env.ENRICH_FILE || path.resolve(__dirname, '../analysis-manual.json'));

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
const MAX_ATTEMPTS = 5;
const RETRY_HOURS = [6, 24];      // after the 1st failure wait 6 h, after later ones 24 h
const IN_ACTIONS = !!process.env.GITHUB_ACTIONS;

// Titles of bot checks and error pages, never real article titles
const BLOCKED_TITLE = /^\s*(just a moment|attention required|access denied|access to this page has been denied|forbidden|403 forbidden|are you a robot|security check|verify(ing)? you are (a )?human|please wait|one more step|request blocked|you have been blocked|captcha|error \d{3}|page not found|404)\b/i;
const isBlockedTitle = t => BLOCKED_TITLE.test(String(t || ''));
// Bot-check text anywhere in the title, or a title that is just a link
const isBadTitle = t => /^\s*substack\s*$/i.test(String(t || '')) || /just a moment|access denied|attention required/i.test(String(t || '')) || /https?:\/\/|www\.\S+\.\w{2,}/i.test(String(t || '')) || isBlockedTitle(t);

// "OPINION | Title - Moneycontrol.com" → "Title"
function cleanTitle(t) {
  return decode(t)
    .replace(/^\s*opinion\s*[|:–—-]\s*/i, '')
    .replace(/\s+[-–—|]\s*[\w.-]+\.(com|in|org|net|co\.in|co\.uk)\s*$/i, '')
    .replace(/\s*[-–—|]+\s*$/, '')
    .trim();
}

// One spelling per publication (case-insensitive match on the stored name)
const SOURCE_NAMES = [
  [/^the\s*print$|^theprint\.in$/i, 'ThePrint'],
  [/^(the hindu|thehindu\.com|frontline|frontline\.thehindu\.com|frontline \(the hindu\))$/i, 'The Hindu'],
  [/^money\s*control(\.com)?$/i, 'Moneycontrol'],
  [/^ndtv(\.com| opinion)?$/i, 'NDTV'],
  [/^(dc dossier\s*[—–,-]\s*substack|dc dossier, substack|dc dossier \(substack\)|dcdossier\.substack\.com|substack)$/i, 'Substack (DC Dossier)'],
];
function cleanSource(src) {
  const t = String(src || '').trim();
  for (const [re, name] of SOURCE_NAMES) if (re.test(t)) return name;
  return t;
}

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
  try { return stripTracking(new URL(s).href); } catch (e) { return String(u || '').trim(); }
}

// Removes utm_*, r, s and triedRedirect (Substack shares add r= and s=)
function stripTracking(u) {
  try {
    const x = new URL(u);
    [...x.searchParams.keys()].forEach(k => { if (/^utm_/i.test(k) || ['r', 's', 'triedRedirect'].includes(k)) x.searchParams.delete(k); });
    return x.href;
  } catch (e) { return u; }
}

// A usable publication date: a real date from 2000 up to yesterday (UTC)
// (upToNow: a trusted API date, which may be today)
function validDate(v, upToNow) {
  if (!v) return '';
  const d = new Date(String(v).trim());
  if (isNaN(d)) return '';
  const limit = new Date();
  if (upToNow) limit.setUTCMinutes(limit.getUTCMinutes() + 5); else limit.setUTCHours(0, 0, 0, 0);
  return d.getUTCFullYear() >= 2000 && d < limit ? d.toISOString() : '';
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

// Why fetches failed while working on the current entry ("HTTP 403", "timeout" …)
let failures = [];
function noteFailure(label, reason) {
  failures.push(`${label}: ${reason}`);
}
function errReason(err) {
  if (err.type === 'request-timeout' || /timeout/i.test(err.message)) return 'timeout';
  if (err.type === 'max-size') return 'too large';
  return `network error (${err.code || err.message})`;
}

async function getText(url, headers, label) {
  label = label || url;
  try {
    const res = await fetch(url, { headers, timeout: 25000, size: 4e6 });
    const body = await res.text();
    console.log(`  [fetch] ${label}: HTTP ${res.status}, ${Buffer.byteLength(body)} bytes`);
    if (!res.ok) noteFailure(label, `HTTP ${res.status}`);
    return res.ok ? body : null;
  } catch (err) {
    const why = errReason(err);
    console.log(`  [fetch] ${label}: ${why} (${err.message})`);
    noteFailure(label, why);
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
      noteFailure(`${t.via} ${url}`, `bot check ("${decode(title).slice(0, 40)}")`);
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

async function getJson(url, label, headers) {
  try {
    const res = await fetch(url, { headers: headers || { 'User-Agent': 'Mozilla/5.0 (compatible; DCDossier/2.0)' }, timeout: 15000 });
    const body = await res.text();
    console.log(`  [fetch] ${label}: HTTP ${res.status}, ${Buffer.byteLength(body)} bytes`);
    if (!res.ok) { noteFailure(label, `HTTP ${res.status}`); return null; }
    try { return JSON.parse(body); }
    catch (e) { noteFailure(label, /<html|<!doctype/i.test(body.slice(0, 500)) ? 'HTML instead of JSON (bot check or not an API)' : 'invalid JSON'); return null; }
  } catch (err) {
    const why = errReason(err);
    console.log(`  [fetch] ${label}: ${why} (${err.message})`);
    noteFailure(label, why);
    return null;
  }
}

/* ── Substack ── */

// API address for a Substack link, or null
function substackApi(u) {
  let x;
  try { x = new URL(u); } catch (e) { return null; }
  const host = x.hostname.toLowerCase(), p = x.pathname;
  const id = (p.match(/(?:^|\/)p-(\d+)(?:\/|$)/) || [])[1];
  if (id && /(^|\.)substack\.com$/.test(host)) return `https://substack.com/api/v1/posts/by-id/${id}`;
  const pub = p.match(/^\/pub\/([\w-]+)\/p\/([\w-]+)/);
  if (host === 'open.substack.com' && pub) return `https://${pub[1]}.substack.com/api/v1/posts/${pub[2]}`;
  const slug = (p.match(/^\/p\/([\w-]+)\/?$/) || [])[1];
  if (slug) return `https://${host}/api/v1/posts/${slug}`;   // <pub>.substack.com or a custom domain
  return null;
}
// Note, app and share links that should be replaced by the post's own link
const isSubstackAppLink = u => !!substackApi(u) && /^https?:\/\/(open\.)?substack\.com\/(@[^/]+\/note\/|home\/post\/|app-link\/|pub\/[^/]+\/p\/|.*\bp-\d+)/i.test(String(u || ''));

// { title, date, description, image, canonical, publication } from Substack's API, or null
async function substackPost(u) {
  const api = substackApi(u);
  if (!api) return null;
  const j = await getJson(api, `substack-api ${api}`, { 'User-Agent': PAGE_HEADERS['User-Agent'], Accept: 'application/json' });
  const post = j && (j.post || j);
  if (!post || !post.title || !post.post_date) {
    if (j) noteFailure(`substack-api ${api}`, 'reply has no title or post_date');
    return null;
  }
  return {
    title: decode(post.title),
    date: validDate(post.post_date, true),
    description: decode(post.subtitle || post.description || ''),
    image: absUrl(post.cover_image || '', 'https://substack.com/'),
    canonical: post.canonical_url ? stripTracking(post.canonical_url) : '',
    publication: decode((j.publication && j.publication.name) || ''),
  };
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

const NOW = Date.now();
const due = at => !at || isNaN(new Date(at)) || new Date(at).getTime() <= NOW;
// After a failed try: next try in 6 h, then every 24 h; returns the time or '' when out of tries
function nextTry(attempts) {
  if (attempts >= MAX_ATTEMPTS) return '';
  const h = RETRY_HOURS[Math.min(attempts, RETRY_HOURS.length) - 1];
  return new Date(NOW + h * 3600e3).toISOString();
}

const needsImage = p => p && p.url && String(p.type || '').toLowerCase() !== 'research'
  && !String(p.image || '').trim() && (p.image_attempts || 0) < MAX_ATTEMPTS && due(p.next_image_try_at);

const blank = v => !String(v || '').trim();
const hasDate = v => !blank(v) && !isNaN(new Date(v));
const needsWork = e => e && e.url && !e.needs_manual
  && (e.needs_enrich === true || blank(e.title) || isBlockedTitle(e.title) || !hasDate(e.date) || blank(e.description) || isSubstackAppLink(e.url))
  && (e.enrich_attempts || 0) < MAX_ATTEMPTS && due(e.next_try_at);

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
      // A Substack note or app link is replaced later; keep it exactly as pasted
      if (!p.source_url && isSubstackAppLink(url)) p.source_url = p.url;
      console.log(`  [url] ${p.url} → ${url}`);
      p.url = url; ['image_attempts', 'enrich_attempts', 'next_try_at', 'next_image_try_at', 'needs_manual'].forEach(k => delete p[k]); changed++;
    }
    for (const k of ['title', 'description']) {
      if (/&(#\d+|#x[\da-f]+|[a-z]+);/i.test(p[k] || '')) { p[k] = decode(p[k]); changed++; console.log(`  [entities] ${k} of ${p.url}`); }
    }
    if (p.title && isBadTitle(p.title)) {
      console.log(`  [title] cleared bad title "${p.title}" for ${p.url}`);
      p.title = ''; p.needs_enrich = true; delete p.enrich_attempts; changed++;
    } else if (p.title) {
      const t = cleanTitle(p.title);
      if (t !== p.title) { console.log(`  [title] "${p.title}" → "${t}"`); p.title = t; changed++; }
    }
    const src = cleanSource(p.source);
    if (src !== (p.source || '')) { console.log(`  [source] "${p.source}" → "${src}"`); p.source = src; changed++; }
  }

  const todo = posts.filter(needsWork);
  const imageTodo = posts.filter(needsImage);
  console.log(`[enrich-manual] ${posts.length} entries, ${todo.length} to enrich, ${imageTodo.length} without an image`);
  const pageCache = new Map();

  const aiOn = todo.some(p => blank(p.description)) ? await initAI('ac') : false;   // AI_PROVIDER decides
  if (todo.length && !aiOn) console.log('[enrich-manual] AI is off or unavailable; summaries fall back to the page description');

  for (const p of todo) {
    const filled = [];
    failures = [];
    let page = null;
    // Substack: the JSON API first, then the page as for any other site
    const sub = await substackPost(p.url);
    if (sub) {
      page = { via: 'substack-api', title: sub.title, published: sub.date ? { date: sub.date, source: 'substack-api' } : null,
               description: sub.description, image: sub.image, extract: null, substack: true };
      if (sub.canonical && sub.canonical !== p.url) {
        if (!p.source_url) p.source_url = p.url;
        console.log(`  [url] ${p.url} → ${sub.canonical} (canonical post link)`);
        p.url = sub.canonical; filled.push('canonical link');
      }
      if (sub.publication && (blank(p.source) || /^(open\.)?substack\.com$/i.test(p.source))) { p.source = sub.publication; filled.push('publication'); }
      if (sub.image && blank(p.image)) { p.image = sub.image; delete p.image_attempts; delete p.next_image_try_at; filled.push('image (cover_image)'); }
    } else if (isSubstackAppLink(p.url)) {
      // Note and app pages are an app shell (title "Substack", Substack's logo): nothing to read
      console.log(`  [skip] ${p.url}: Substack app link, the API gave nothing and the page has no post details`);
    } else {
      page = await readPage(p.url);
    }
    pageCache.set(p.url, page);
    if (isBlockedTitle(p.title)) { p.title = ''; filled.push('bot-check title cleared'); }
    if (page) {
      if (blank(p.title) && page.title && !isBadTitle(page.title)) { p.title = cleanTitle(page.title); filled.push('title'); }
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
      const text = aiOn && !(page && page.substack && page.description) ? await aiSummary(p, page) : null;
      if (page && page.substack && page.description) {
        p.description = page.description; p.summary_source = 'substack'; filled.push('subtitle');
      } else if (text) { p.description = text; p.ai_summary = true; filled.push('AI summary'); }
      else if (page && page.description.length >= 60) {
        p.description = page.description; p.summary_source = 'page'; filled.push('page description');
      }
    }
    const done = !blank(p.title) && hasDate(p.date) && !blank(p.description);
    const missing = ['title', 'date', 'description'].filter(k => k === 'date' ? !hasDate(p.date) : blank(p[k]));
    if (done) {
      p.needs_enrich = false;
      ['enrich_attempts', 'next_try_at', 'last_error', 'needs_manual', 'date_missing'].forEach(k => delete p[k]);
    } else {
      p.needs_enrich = true;
      p.enrich_attempts = (p.enrich_attempts || 0) + 1;
      const reason = failures.length ? failures.join('; ') : (page ? `page read (${page.via}) but no ${missing.join(' or ')} on it` : 'no response');
      p.last_error = reason.slice(0, 500);
      const next = nextTry(p.enrich_attempts);
      if (next) p.next_try_at = next;
      else {
        delete p.next_try_at;
        if (blank(p.title) || !hasDate(p.date)) p.needs_manual = true;   // hidden on the site: needs a person
      }
      const msg = `${p.url} — still missing ${missing.join(', ')} after try ${p.enrich_attempts} of ${MAX_ATTEMPTS}. Reason: ${reason}. ` +
        (next ? `Next try ${next}.` : p.needs_manual ? 'Marked needs_manual.' : 'No more tries.');
      console.log(`  [fail] ${msg}`);
      if (IN_ACTIONS) console.log(`::warning title=Enrichment failed::${msg.replace(/[\r\n]+/g, ' ')}`);
    }
    changed++;
    console.log(`  [${done ? 'ok' : 'partial'}] ${p.url} — ${page ? 'read ' + page.via : 'could not be read'}; filled: ${filled.join(', ') || 'nothing'}`);
  }

  for (const p of imageTodo) {
    if (!blank(p.image)) continue;   // filled from the Substack API above
    if (isSubstackAppLink(p.url)) continue;   // wait for the post link; the app page has only Substack's logo
    failures = [];
    const img = await findImage(p, pageCache);
    if (img) { p.image = img; delete p.image_attempts; delete p.next_image_try_at; console.log(`  [image] ${p.url} — ${img}`); }
    else {
      p.image_attempts = (p.image_attempts || 0) + 1;
      const next = nextTry(p.image_attempts);
      if (next) p.next_image_try_at = next; else delete p.next_image_try_at;
      console.log(`  [image] ${p.url} — none found (try ${p.image_attempts} of ${MAX_ATTEMPTS})${failures.length ? '. Reason: ' + failures.join('; ') : ''}${next ? '. Next try ' + next : ''}`);
    }
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
