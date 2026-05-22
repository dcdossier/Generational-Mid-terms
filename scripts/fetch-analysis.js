#!/usr/bin/env node
'use strict';

/**
 * fetch-analysis.js
 * Fetches content from:
 *   - DC Dossier Substack (RSS)
 *   - All Things Policy podcast (Takshashila — multiple RSS attempts)
 *   - Takshashila author pages for Anil Raman & Abhishek Kadiyala
 *   - Google News RSS searches for author/show content
 *
 * Filters by Congress / midterm keywords, deduplicates against existing
 * analysis.json, and writes the updated posts array back to analysis.json.
 */

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');

const OUT_PATH     = path.resolve(__dirname, '../analysis.json');
const FETCH_TIMEOUT = 14000;
const MAX_POSTS    = 150;

// ── KEYWORD FILTER ──────────────────────────────────────────────────────────
const KW_RE = new RegExp([
  'congress(?:ional)?', 'mid-?term', 'midterm', 'election', 'electoral',
  'senate', '\\bhouse\\b', 'capitol', 'legislat', 'filibuster', 'caucus',
  'bipartisan', 'partisan', 'committee', 'subcommittee', 'hearing',
  'war\\s+powers', 'trump', 'republican', 'democrat', '\\bgop\\b',
  '2026', 'primary', 'ballot', 'campaign', 'incumbent',
  'speaker\\s+of\\s+the\\s+house', 'majority\\s+leader', 'minority\\s+leader',
  'appropriations', 'debt\\s+ceiling', 'continuing\\s+resolution',
  'tariff', 'sanction', 'iran', 'india', '\\bh-1b\\b', 'immigration',
  'geopolit', 'south\\s+asia', 'foreign\\s+policy', 'national\\s+security',
  'takshashila', 'dc\\s+dossier', 'all\\s+things\\s+policy',
  'abhishek\\s+kadiyala', 'anil\\s+raman', 'bhumika', 'soren\\s+dayton',
].join('|'), 'i');

function matchesKw(title, desc) {
  return KW_RE.test((title || '') + ' ' + (desc || ''));
}

// ── TAG EXTRACTION ──────────────────────────────────────────────────────────
function extractTags(text) {
  const t = (text || '').toLowerCase();
  const tags = [];
  if (/congress(?:ional)?|capitol|legislat|filibuster|committee|hearing|bill/.test(t)) tags.push('Congress');
  if (/mid-?term|2026|election|primary|ballot|electoral/.test(t)) tags.push('Midterms');
  if (/senate|senator/.test(t)) tags.push('Senate');
  if (/\bhouse\b|representative/.test(t)) tags.push('House');
  if (/iran|war\s+powers/.test(t)) tags.push('Iran');
  if (/india|south\s+asia/.test(t)) tags.push('India');
  if (/trump/.test(t)) tags.push('Trump');
  if (/h-1b|immigration|visa/.test(t)) tags.push('Immigration');
  if (/tariff|trade/.test(t)) tags.push('Trade');
  if (/foreign\s+policy|geopolit|national\s+security/.test(t)) tags.push('Foreign Policy');
  if (/sanction/.test(t)) tags.push('Sanctions');
  return tags.length ? tags : ['Analysis'];
}

// ── XML / HTML HELPERS ──────────────────────────────────────────────────────
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function stripHtml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}

function safeUrl(raw) {
  if (!raw) return '';
  if (typeof raw === 'object') return raw['#text'] || raw['@_href'] || '';
  return String(raw);
}

function parseRssItem(raw) {
  const title = stripHtml(raw.title || raw['itunes:title'] || '');
  const link   = safeUrl(raw.link || raw['feedburner:origLink'] || raw.guid);
  const desc   = stripHtml(
    raw.description || raw['itunes:summary'] || raw.summary ||
    raw['content:encoded'] || raw.content || ''
  ).slice(0, 700);
  const pub = raw.pubDate || raw.published || raw['dc:date'] || raw.updated || '';
  const date = pub ? new Date(pub) : new Date();
  return { title, link, desc, date: isNaN(date) ? new Date() : date };
}

// ── FETCH RSS ───────────────────────────────────────────────────────────────
async function fetchRss(url, source, type, forceInclude) {
  try {
    const res = await fetch(url, {
      timeout: FETCH_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DCDossier-Bot/1.0; +https://dcdossier.substack.com)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const feed = xmlParser.parse(xml);
    const channel = feed?.rss?.channel || feed?.feed || {};
    let items = channel.item || channel.entry || [];
    if (!Array.isArray(items)) items = items ? [items] : [];

    return items.flatMap(raw => {
      const { title, link, desc, date } = parseRssItem(raw);
      if (!title || !link) return [];
      if (!forceInclude && !matchesKw(title, desc)) return [];
      // Use full URL hash for unique id (avoid base64 prefix collisions)
      const id = 'rss-' + Buffer.from(link).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(-24);
      return [{
        id,
        type,
        title,
        description: desc,
        url: link,
        source,
        date: date.toISOString(),
        tags: extractTags(title + ' ' + desc),
        author: '',
      }];
    });
  } catch (e) {
    console.warn(`[fetch-analysis] RSS failed (${source}):`, e.message);
    return [];
  }
}

// ── SCRAPE AUTHOR PAGE ───────────────────────────────────────────────────────
async function scrapeAuthorPage(pageUrl, author, sourceName) {
  try {
    const res = await fetch(pageUrl, {
      timeout: FETCH_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DCDossier-Bot/1.0)' },
    });
    if (!res.ok) return [];
    const html = await res.text();

    const posts = [];
    const seen  = new Set();
    const linkRe = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;

    while ((m = linkRe.exec(html)) !== null) {
      const href    = m[1].trim();
      const rawText = stripHtml(m[2]).trim();
      if (!rawText || rawText.length < 15 || seen.has(href)) continue;
      // Skip nav links and quoted labels (e.g. 'DC Dossier')
      if (/^['"].*['"]$/.test(rawText) || /^(home|about|contact|login|sign in|subscribe|menu|close)$/i.test(rawText)) continue;
      seen.add(href);

      // Only follow content on known domains
      const isDomain = /takshashila\.org|open\.spotify\.com|substack\.com/.test(href);
      if (!isDomain && !href.startsWith('/')) continue;
      if (!matchesKw(rawText, '')) continue;

      const fullUrl  = href.startsWith('http') ? href : 'https://takshashila.org.in' + href;
      const isSpotify  = /open\.spotify/.test(fullUrl);
      const isSubstack = /substack\.com/.test(fullUrl);
      const postType   = isSpotify ? 'podcast' : isSubstack ? 'newsletter' : 'research';

      const id = 'page-' + Buffer.from(fullUrl).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(-24);
      posts.push({
        id,
        type: postType,
        title: rawText,
        description: '',
        url: fullUrl,
        source: sourceName,
        date: new Date().toISOString(),
        tags: extractTags(rawText),
        author,
      });
    }
    console.log(`[fetch-analysis] Author page ${pageUrl}: ${posts.length} items found`);
    return posts;
  } catch (e) {
    console.warn(`[fetch-analysis] Author page failed (${pageUrl}):`, e.message);
    return [];
  }
}

// ── SEED POSTS (always preserved regardless of fetch results) ───────────────
const SEED_POSTS = [
  {
    id: 'seed-atp-1VFAsloVxSyHCH3Uw4XUZb',
    type: 'podcast',
    title: 'The Iran Brief: US Congress and Trump',
    description: "With the 60-day War Powers Resolution clock ticking, this episode examines why Congress has again failed to constrain Trump's military operations against Iran. The panel unpacks the structural weaknesses of the War Powers Resolution — including the Trump administration filing only classified reports. The core argument: the real obstacle is political will, not legal ambiguity.",
    url: 'https://open.spotify.com/episode/1VFAsloVxSyHCH3Uw4XUZb',
    source: 'All Things Policy — Takshashila Institution',
    date: '2026-04-29T00:00:00.000Z',
    tags: ['Congress', 'Foreign Policy', 'Iran'],
    author: 'Abhishek Kadiyala & Brigadier Anil Raman',
  },
  {
    id: 'seed-atp-4wmWyfx1HxWvqTo6P5jNYG',
    type: 'podcast',
    title: 'The Iran Brief: Why Is US Congress Failing To Stop Trump On Iran?',
    description: "Congress has repeatedly failed to constrain President Trump's military actions against Iran despite multiple legislative attempts. The episode traces failed resolutions invoking the War Powers Resolution of 1973 — sponsored by Tim Kaine, Thomas Massie, Ro Khanna, and Chris Murphy — and examines how partisanship, electoral incentives, and ideological splits (cutting across party lines) have shaped outcomes.",
    url: 'https://open.spotify.com/episode/4wmWyfx1HxWvqTo6P5jNYG',
    source: 'All Things Policy — Takshashila Institution',
    date: '2026-04-01T00:00:00.000Z',
    tags: ['Congress', 'Foreign Policy', 'War Powers'],
    author: 'Abhishek Kadiyala & Bhumika Sevkani',
  },
  {
    id: 'seed-dcd-21-generational-midterm',
    type: 'newsletter',
    title: '#21 — A Generational Mid-term?',
    description: "At least one in eight members of Congress is departing ahead of the 2026 midterms — the highest retirement rate since 1992. The piece examines the three forces driving the exodus: institutional frustration with a gridlocked Congress, deepening partisan polarisation that makes legislating increasingly thankless, and a declining appeal of federal service relative to state-level or private-sector alternatives.",
    url: 'https://dcdossier.substack.com/p/21-a-generational-mid-term',
    source: 'DC Dossier — Substack',
    date: '2026-05-10T00:00:00.000Z',
    tags: ['Congress', 'Midterms', 'Retirements'],
    author: 'Abhishek Kadiyala',
  },
  {
    id: 'seed-atp-5TA2xUQOIRtPurxcZ5k9uk',
    type: 'podcast',
    title: 'All Things Policy — US Congress, War Powers & Iran',
    description: "An episode of All Things Policy examining the US Congress's role and response in the context of military action, war powers, and the legislative dynamics of the current Congress.",
    url: 'https://open.spotify.com/episode/5TA2xUQOIRtPurxcZ5k9uk',
    source: 'All Things Policy — Takshashila Institution',
    date: '2026-03-15T00:00:00.000Z',
    tags: ['Congress', 'Foreign Policy', 'War Powers'],
    author: 'Abhishek Kadiyala & Brigadier Anil Raman',
  },
];

// ── RSS SOURCES ──────────────────────────────────────────────────────────────
const RSS_SOURCES = [
  // DC Dossier Substack — all posts relevant by definition
  {
    url: 'https://dcdossier.substack.com/feed',
    source: 'DC Dossier — Substack',
    type: 'newsletter',
    forceInclude: true,
  },
  // All Things Policy podcast — try several known hosting endpoints
  { url: 'https://feeds.acast.com/public/shows/all-things-policy',                   source: 'All Things Policy',           type: 'podcast' },
  { url: 'https://anchor.fm/all-things-policy/podcast/rss',                          source: 'All Things Policy',           type: 'podcast' },
  { url: 'https://anchor.fm/s/takshashila/podcast/rss',                             source: 'All Things Policy',           type: 'podcast' },
  { url: 'https://takshashila.org.in/all-things-policy.xml',                        source: 'All Things Policy',           type: 'podcast' },
  { url: 'https://takshashila.org.in/feed/podcast',                                  source: 'Takshashila Podcasts',        type: 'podcast' },
  // Google News RSS — author and show searches
  { url: 'https://news.google.com/rss/search?q=%22Abhishek+Kadiyala%22+Congress&hl=en-US&gl=US&ceid=US%3Aen',                     source: 'Abhishek Kadiyala (Google News)', type: 'research' },
  { url: 'https://news.google.com/rss/search?q=%22Anil+Raman%22+Takshashila+Congress&hl=en-US&gl=US&ceid=US%3Aen',               source: 'Takshashila (Google News)',       type: 'research' },
  { url: 'https://news.google.com/rss/search?q=%22All+Things+Policy%22+Congress+midterm&hl=en-US&gl=US&ceid=US%3Aen',            source: 'All Things Policy (Google News)', type: 'podcast'  },
  { url: 'https://news.google.com/rss/search?q=%22DC+Dossier%22+Congress+midterm&hl=en-US&gl=US&ceid=US%3Aen',                   source: 'DC Dossier (Google News)',        type: 'newsletter'},
  { url: 'https://news.google.com/rss/search?q=%22DC+Dossier%22+%22Abhishek+Kadiyala%22&hl=en-US&gl=US&ceid=US%3Aen',           source: 'DC Dossier (Google News)',        type: 'newsletter'},
];

// ── AUTHOR PAGES ─────────────────────────────────────────────────────────────
const AUTHOR_PAGES = [
  { url: 'https://takshashila.org.in/content/team/anil-raman.html',       author: 'Brigadier Anil Raman',  source: 'Takshashila Institution' },
  { url: 'https://takshashila.org.in/content/team/abhishek-kadiyala.html', author: 'Abhishek Kadiyala',     source: 'Takshashila Institution' },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load existing file for deduplication and metadata preservation
  let existing = { meta: {}, posts: [] };
  if (fs.existsSync(OUT_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); }
    catch (e) { console.warn('[fetch-analysis] Could not parse existing analysis.json'); }
  }
  const existingByUrl = new Map((existing.posts || []).map(p => [p.url, p]));

  const seedUrls = new Set(SEED_POSTS.map(p => p.url));
  const seenUrls = new Set(seedUrls);
  // Start with seeds (always preserved)
  const allPosts = [...SEED_POSTS];

  // Fetch RSS sources
  for (const src of RSS_SOURCES) {
    const posts = await fetchRss(src.url, src.source, src.type, src.forceInclude || false);
    console.log(`[fetch-analysis] ${src.source}: ${posts.length} matching items`);
    for (const post of posts) {
      if (seenUrls.has(post.url)) continue;
      seenUrls.add(post.url);
      // Preserve any manually-set fields from the existing file
      const prev = existingByUrl.get(post.url);
      allPosts.push(prev ? Object.assign({}, post, { author: prev.author || post.author, description: prev.description || post.description }) : post);
    }
  }

  // Scrape author pages
  for (const pg of AUTHOR_PAGES) {
    const posts = await scrapeAuthorPage(pg.url, pg.author, pg.source);
    for (const post of posts) {
      if (seenUrls.has(post.url)) continue;
      seenUrls.add(post.url);
      allPosts.push(post);
    }
  }

  // Sort newest-first
  allPosts.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Cap at MAX_POSTS but always keep seeds at the top of their date position
  const capped = allPosts.slice(0, MAX_POSTS);

  const out = {
    meta: {
      last_updated: new Date().toISOString(),
      count: capped.length,
      sources: ['DC Dossier (Substack)', 'All Things Policy (Takshashila)', 'Takshashila Author Pages'],
    },
    posts: capped,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[fetch-analysis] Done — ${capped.length} posts saved to analysis.json`);
}

main().catch(e => { console.error('[fetch-analysis] Fatal:', e); process.exit(1); });
