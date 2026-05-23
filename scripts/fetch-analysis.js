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
// Only include posts that DIRECTLY discuss Congress or US midterm elections.
// Broad policy topics (Iran, India, trade, foreign policy) are excluded unless
// they explicitly reference Congress or the midterms in the same breath.
const KW_RE = new RegExp([
  // Congress as an institution
  'us\\s+congress', 'u\\.s\\.\\s+congress', 'congress(?:ional)?\\s+(action|vote|bill|hearing|response|debate|race|seat|fail|pass|block|approv)',
  '\\bcongress\\b.*\\b(fail|pass|vote|debate|block|approv|respond|constrain|legislat)',
  '\\b(fail|pass|vote|debate|block|approv|respond|constrain|legislat)\\b.*\\bcongress\\b',
  'house\\s+of\\s+representatives', 'us\\s+senate', 'u\\.s\\.\\s+senate',
  'capitol\\s+hill', 'war\\s+powers\\s+resolution', 'war\\s+powers\\s+act',
  'filibuster', 'government\\s+shutdown', 'debt\\s+ceiling',
  'continuing\\s+resolution', 'appropriations\\s+bill',
  'speaker\\s+of\\s+the\\s+house', 'majority\\s+leader', 'minority\\s+leader',
  'senate\\s+(race|seat|hearing|vote|bill|election|runoff)',
  'house\\s+(race|seat|hearing|vote|bill|election|district)',
  '119th\\s+congress', '120th\\s+congress',
  // Midterms directly
  'mid-?term', 'midterm',
  '2026\\s+(election|race|midterm|senate|house|primary|ballot)',
  '(election|race|primary|ballot).*2026',
  'election\\s+cycle', 'senate\\s+majority', 'house\\s+majority',
  // Congressional role / war powers in context
  'war\\s+powers', 'congress.*iran', 'iran.*congress',
  'congress.*trump', 'trump.*congress',
  // DC Dossier issues that are explicitly about Congress or midterms
  'congressional\\s+perspective', 'house.*consensus', 'senate.*hearing',
].join('|'), 'i');

// Posts that should always be excluded even if they match KW_RE.
// Learning: Senate/House hearings that are primarily about bilateral
// diplomatic relations or ambassador nominations are OFF-TOPIC — Congress
// is just the venue, not the subject. Only include hearings where the
// central focus is congressional behaviour, partisanship, legislation,
// oversight, war powers, or the election cycle itself.
function isOffTopic(text) {
  const t = text.toLowerCase();
  const isHearing = /senate\s+hearing|house\s+hearing|confirmation\s+hearing/i.test(t);
  const isBilateral = /ambassador|bilateral|india.?us\s+relations|us.?india\s+relations|what\s+it\s+reveals\s+about|nomination\s+hearing/i.test(t);
  const isCongress  = /partisan|oversight|legislation|war\s+powers|midterm|accountability|filibuster|shutdown/i.test(t);
  // A hearing that is about bilateral/diplomatic topics but NOT about
  // congressional mechanics or accountability → off-topic
  if (isHearing && isBilateral && !isCongress) return true;
  // Historical/survey pieces on "Congressional perspectives towards India" — India-US
  // relations is the subject; Congress is the analytical lens, not an active actor
  if (/congressional\s+perspectives?\s+(towards?|on)\s+india/i.test(t)) return true;
  return false;
}

function matchesKw(title, desc) {
  const text = (title || '') + ' ' + (desc || '');
  if (isOffTopic(text)) return false;
  return KW_RE.test(text);
}

// ── TAG EXTRACTION ──────────────────────────────────────────────────────────
function extractTags(text) {
  const t = (text || '').toLowerCase();
  const tags = [];
  if (/congress(?:ional)?|capitol|legislat|filibuster|committee|hearing|shutdown|debt\s+ceiling|appropriations/.test(t)) tags.push('Congress');
  if (/mid-?term|2026.*(election|race|primary)|election.*2026|senate\s+majority|house\s+majority/.test(t)) tags.push('Midterms');
  if (/senate\s+(race|seat|vote|hearing|bill)|us\s+senate/.test(t)) tags.push('Senate');
  if (/house\s+(race|seat|vote|hearing|bill)|house\s+of\s+rep/.test(t)) tags.push('House');
  if (/war\s+powers|iran.*congress|congress.*iran/.test(t)) tags.push('War Powers');
  if (/trump.*congress|congress.*trump/.test(t)) tags.push('Trump');
  return tags.length ? tags : ['Congress'];
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

      // For absolute URLs, only follow known content domains
      const isAbsolute = /^https?:\/\//i.test(href);
      if (isAbsolute) {
        const isDomain = /takshashila\.org|open\.spotify\.com|substack\.com/.test(href);
        if (!isDomain) continue;
      }
      if (!matchesKw(rawText, '')) continue;

      // Resolve relative URLs (handles ../../content/... style paths)
      let fullUrl;
      try { fullUrl = new URL(href, pageUrl).href; }
      catch { continue; }

      const isSpotify  = /open\.spotify/.test(fullUrl);
      const isSubstack = /substack\.com/.test(fullUrl);
      const isPublication = /takshashila\.org.*\/content\/publications\//.test(fullUrl);
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
// These are permanent — add any post here that might fall off RSS feeds.
// Sorted newest-first; the main() sort will handle final ordering.
const SEED_POSTS = [
  // ── Takshashila Publications ──────────────────────────────────────────────
  {
    id: 'seed-taksh-pub-congress-iran-war-2026',
    type: 'research',
    title: 'Analysing US Congressional Oversight on the Iran War',
    description: "This policy brief examines congressional responses to President Trump's military action against Iran, which began February 28, 2026. The analysis explores two institutional mechanisms through which Congress can exercise oversight: the War Powers Resolution (WPR) and budgetary appropriations authority. The brief identifies deep partisan and intra-party divisions, tracks multiple failed legislative attempts, and concludes that budgetary restraint represents Congress's most viable constraint mechanism.",
    url: 'https://takshashila.org.in/content/publications/Congress-Iran-War-20052026.html',
    source: 'Takshashila Institution',
    date: '2026-05-20T00:00:00.000Z',
    tags: ['Congress', 'War Powers', 'Iran'],
    author: 'Abhishek Kadiyala',
  },
  // ── DC Dossier newsletters ────────────────────────────────────────────────
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
    id: 'seed-dcd-19-marchuary-iran-war-bills',
    type: 'newsletter',
    title: '#19 The \u201cMarch-uary\u201d of Iran War Bills',
    description: "How and why has the Congress failed to stop Trump\u2019s war in Iran",
    url: 'https://dcdossier.substack.com/p/the-march-uary-of-iran-war-bills',
    source: 'DC Dossier — Substack',
    date: '2026-03-28T20:01:10.000Z',
    tags: ['Congress', 'War Powers', 'Trump'],
    author: 'Abhishek Kadiyala',
  },
  {
    id: 'seed-dcd-18-congress-responded',
    type: 'newsletter',
    title: '#18 Why and How Has Congress Responded Differently to Venezuela, Greenland, and Iran?',
    description: "Dossier in Brief: comparing the legislative responses to three distinct foreign policy crises and what the divergence reveals about congressional incentives.",
    url: 'https://dcdossier.substack.com/p/why-and-how-has-congress-responded',
    source: 'DC Dossier — Substack',
    date: '2026-02-22T06:42:16.000Z',
    tags: ['Congress', 'War Powers'],
    author: 'Abhishek Kadiyala',
  },
  {
    id: 'seed-dcd-13-2025-recap',
    type: 'newsletter',
    title: '#13 DC Dossier 2025 Recap',
    description: "A year-end review of how the 119th Congress engaged with India-related legislation, hearings, and bilateral policy debates across 2025.",
    url: 'https://dcdossier.substack.com/p/dc-dossier-2025-recap',
    source: 'DC Dossier — Substack',
    date: '2026-01-01T19:41:36.000Z',
    tags: ['Congress'],
    author: 'Abhishek Kadiyala',
  },
  {
    id: 'seed-dcd-11-partisan-divides',
    type: 'newsletter',
    title: '#11 Partisan Divides and Strategic Expectations',
    description: "Key takeaways from the House hearing on the US\u2013India strategic partnership, analysing how partisan lines shaped members\u2019 priorities and the divergence between Democratic and Republican expectations of the relationship.",
    url: 'https://dcdossier.substack.com/p/partisan-divides-and-strategic-expectations',
    source: 'DC Dossier — Substack',
    date: '2025-12-20T00:12:47.000Z',
    tags: ['Congress', 'House'],
    author: 'Abhishek Kadiyala',
  },
  {
    id: 'seed-dcd-10-end-of-shutdown',
    type: 'newsletter',
    title: '#10 End of the Shutdown. Who Won and Lost',
    description: "Analysing the end of the longest government shutdown in United States history \u2014 which members and factions gained leverage, which lost it, and what the resolution signals for the 119th Congress\u2019s governing capacity.",
    url: 'https://dcdossier.substack.com/p/end-of-the-shutdown-who-won-and-lost',
    source: 'DC Dossier — Substack',
    date: '2025-12-10T09:14:17.000Z',
    tags: ['Congress'],
    author: 'Abhishek Kadiyala',
  },
  {
    id: 'seed-dcd-9-trump-economic-midterms',
    type: 'newsletter',
    title: "#9 Trump\u2019s Economic Policies Devastate His Base, Fuel Democratic Rout, and Imperil Midterms",
    description: "How the Trump administration\u2019s economic policies \u2014 tariffs, spending cuts, and fiscal pressure \u2014 have translated into a Democratic sweep in off-cycle elections and what the trend implies for the 2026 midterms.",
    url: 'https://dcdossier.substack.com/p/trumps-economic-policies-devastate',
    source: 'DC Dossier — Substack',
    date: '2025-11-15T10:30:29.000Z',
    tags: ['Midterms'],
    author: 'Abhishek Kadiyala',
  },
  {
    id: 'seed-dcd-5-government-shutdown',
    type: 'newsletter',
    title: '#5 Understanding US Government Shutdown',
    description: "DCD Brief: the causes, key legislative flashpoints, and likely duration of the 2025 US government shutdown \u2014 and what it reveals about dysfunction in the 119th Congress.",
    url: 'https://dcdossier.substack.com/p/understanding-us-government-shutdown',
    source: 'DC Dossier — Substack',
    date: '2025-10-09T13:35:57.000Z',
    tags: ['Congress'],
    author: 'Abhishek Kadiyala',
  },
  {
    id: 'seed-dcd-4-democracy-first-pakistan',
    type: 'newsletter',
    title: '#4 Democracy First: The House\u2019s Consensus on Pakistan Policy',
    description: "How does the 119th US House of Representatives view Pakistan? An analysis of bipartisan consensus \u2014 and its limits \u2014 on democracy conditionality, military aid, and human rights benchmarks in House engagement with Islamabad.",
    url: 'https://dcdossier.substack.com/p/democracy-first-the-houses-consensus',
    source: 'DC Dossier — Substack',
    date: '2025-09-18T04:59:38.000Z',
    tags: ['House'],
    author: 'Abhishek Kadiyala',
  },
  // ── All Things Policy podcasts ────────────────────────────────────────────
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
    id: 'seed-yt-2HZsdyLKkvQ',
    type: 'podcast',
    title: 'All Things Policy | The Iran Brief: War and MAGA Fissures',
    description: "Takshashila Institution's All Things Policy examines the fissures within the MAGA coalition in Congress over the Iran strikes, and what the split reveals about Congress\u2019s capacity \u2014 and willingness \u2014 to constrain the executive on war powers.",
    url: 'https://www.youtube.com/watch?v=2HZsdyLKkvQ',
    source: 'All Things Policy — Takshashila Institution (YouTube)',
    date: '2026-03-23T19:00:02.000Z',
    tags: ['Congress', 'War Powers', 'Iran'],
    author: 'Lokendra Sharma & Abhishek Kadiyala',
  },
  {
    id: 'seed-atp-5TA2xUQOIRtPurxcZ5k9uk',
    type: 'podcast',
    title: 'All Things Policy — US Congress, War Powers & Iran',
    description: "An episode of All Things Policy examining the US Congress's role and response in the context of military action, war powers, and the legislative dynamics of the current Congress.",
    url: 'https://open.spotify.com/episode/5TA2xUQOIRtPurxcZ5k9uk',
    source: 'All Things Policy — Takshashila Institution',
    date: '2026-03-15T00:00:00.000Z',
    tags: ['Congress', 'War Powers'],
    author: 'Abhishek Kadiyala & Brigadier Anil Raman',
  },
];

// ── RSS SOURCES ──────────────────────────────────────────────────────────────
const RSS_SOURCES = [
  // DC Dossier Substack — filtered by Congress/midterm keywords
  {
    url: 'https://dcdossier.substack.com/feed',
    source: 'DC Dossier — Substack',
    type: 'newsletter',
  },
  // Takshashila Institution YouTube channel (@TakshashilaInst → UC5AVrL4ryKhR1Vi0HxdgP2Q)
  { url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC5AVrL4ryKhR1Vi0HxdgP2Q', source: 'Takshashila Institution (YouTube)', type: 'podcast' },
  // Google News RSS — author and show searches
  { url: 'https://news.google.com/rss/search?q=%22Abhishek+Kadiyala%22+Congress&hl=en-US&gl=US&ceid=US%3Aen',                     source: 'Abhishek Kadiyala (Google News)', type: 'research' },
  { url: 'https://news.google.com/rss/search?q=%22Anil+Raman%22+Takshashila+Congress&hl=en-US&gl=US&ceid=US%3Aen',               source: 'Takshashila (Google News)',       type: 'research' },
  { url: 'https://news.google.com/rss/search?q=%22All+Things+Policy%22+Congress+midterm&hl=en-US&gl=US&ceid=US%3Aen',            source: 'All Things Policy (Google News)', type: 'podcast'  },
  { url: 'https://news.google.com/rss/search?q=%22DC+Dossier%22+Congress+midterm&hl=en-US&gl=US&ceid=US%3Aen',                   source: 'DC Dossier (Google News)',        type: 'newsletter'},
  { url: 'https://news.google.com/rss/search?q=%22DC+Dossier%22+%22Abhishek+Kadiyala%22&hl=en-US&gl=US&ceid=US%3Aen',           source: 'DC Dossier (Google News)',        type: 'newsletter'},
];

// ── YOUTUBE CHANNEL HELPER ───────────────────────────────────────────────────
// Fetches a YouTube @handle page, extracts the canonical channel_id, then
// returns the RSS feed items filtered by keyword.
async function fetchYouTubeChannel(handle) {
  const channelUrl = `https://www.youtube.com/@${handle}/videos`;
  try {
    const res = await fetch(channelUrl, {
      timeout: FETCH_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DCDossier-Bot/1.0)' },
    });
    if (!res.ok) return [];
    const html = await res.text();

    // YouTube embeds the channel_id in several places; try each
    const patterns = [
      /"channelId":"(UC[A-Za-z0-9_-]{22})"/,
      /\/channel\/(UC[A-Za-z0-9_-]{22})/,
      /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
    ];
    let channelId = null;
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) { channelId = m[1]; break; }
    }

    if (!channelId) {
      console.warn(`[fetch-analysis] Could not extract channel_id for @${handle}`);
      return [];
    }
    console.log(`[fetch-analysis] @${handle} → channel_id: ${channelId}`);

    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    return fetchRss(rssUrl, 'Takshashila Institution (YouTube)', 'podcast', false);
  } catch (e) {
    console.warn(`[fetch-analysis] YouTube channel fetch failed for @${handle}:`, e.message);
    return [];
  }
}

// ── AUTHOR PAGES ─────────────────────────────────────────────────────────────
const AUTHOR_PAGES = [
  { url: 'https://takshashila.org.in/content/team/anil-raman.html',       author: 'Brigadier Anil Raman',  source: 'Takshashila Institution' },
  { url: 'https://takshashila.org.in/content/team/abhishek-kadiyala.html', author: 'Abhishek Kadiyala',     source: 'Takshashila Institution' },
  { url: 'https://takshashila.org.in/pages/publications/',                  author: 'Abhishek Kadiyala',     source: 'Takshashila Institution' },
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

  // Fetch Takshashila YouTube channel
  const ytPosts = await fetchYouTubeChannel('TakshashilaInst');
  console.log(`[fetch-analysis] Takshashila YouTube: ${ytPosts.length} matching items`);
  for (const post of ytPosts) {
    if (seenUrls.has(post.url)) continue;
    seenUrls.add(post.url);
    allPosts.push(post);
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
      sources: ['DC Dossier (Substack)', 'All Things Policy (Takshashila)', 'Takshashila Author Pages', 'Takshashila Institution Publications'],
    },
    posts: capped,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[fetch-analysis] Done — ${capped.length} posts saved to analysis.json`);
}

main().catch(e => { console.error('[fetch-analysis] Fatal:', e); process.exit(1); });
