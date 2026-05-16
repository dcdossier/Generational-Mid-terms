#!/usr/bin/env node
'use strict';

/**
 * fetch-news.js
 * Fetches RSS feeds from national political sources, filters for midterm-relevant
 * items, auto-tags them, deduplicates against existing data.json, and writes
 * the updated news array back to data.json.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');

const DATA_PATH = path.resolve(__dirname, '../data.json');

// ── RSS SOURCES ────────────────────────────────────────────────────────────────
const FEEDS = [
  { url: 'https://thehill.com/feed/',                        source: 'The Hill' },
  { url: 'https://thehill.com/homenews/house/feed/',         source: 'The Hill (House)' },
  { url: 'https://thehill.com/homenews/senate/feed/',        source: 'The Hill (Senate)' },
  { url: 'https://rss.politico.com/congress.xml',            source: 'Politico' },
  { url: 'https://rss.politico.com/politics-news.xml',       source: 'Politico' },
  { url: 'https://api.axios.com/feed/',                      source: 'Axios' },
  { url: 'https://rollcall.com/feed/',                       source: 'Roll Call' },
  { url: 'https://www.theguardian.com/us-news/us-politics/rss', source: 'The Guardian' },
  { url: 'https://www.realclearpolitics.com/xml/rss.xml',    source: 'RealClearPolitics' },
  { url: 'https://insideelections.com/feed/',                source: 'Inside Elections' },
  { url: 'https://centerforpolitics.org/crystalball/feed/',  source: 'Sabato\'s Crystal Ball' },
  {
    url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:apnews.com+congress+midterm',
    source: 'AP News (via Google)'
  },
  {
    url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=site:reuters.com+congress+midterm',
    source: 'Reuters (via Google)'
  },
];

// ── KEYWORD FILTERS ────────────────────────────────────────────────────────────
const FILTER_KEYWORDS = [
  'midterm', 'congress', 'senate', 'house', 'election 2026',
  'primary', 'redistrict', 'retirement', 'caucus', 'ballot',
];

// ── AUTO-TAGGING ───────────────────────────────────────────────────────────────
const TAG_RULES = [
  { tag: 'Major Update',  keywords: ['redistrict', 'retirement', 'retires', 'indictment', 'court ruling', 'primary result', 'flips', 'upset', 'breaks record'] },
  { tag: 'House',         keywords: ['house', 'representative', 'h.r.', 'speaker'] },
  { tag: 'Senate',        keywords: ['senate', 'senator', 's.', 'filibuster', 'cloture'] },
  { tag: 'Federal',       keywords: ['congress', 'federal', 'white house', 'administration', 'legislation', 'bill', 'vote'] },
  { tag: 'Governorship',  keywords: ['governor', 'gubernatorial', 'statehouse'] },
  { tag: 'Primary',       keywords: ['primary', 'runoff', 'nomination'] },
];

const MAX_NEWS_ITEMS = 100;

// ── HELPERS ────────────────────────────────────────────────────────────────────

function containsKeyword(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

function autoTag(title, description) {
  const combined = `${title} ${description}`.toLowerCase();
  const tags = [];
  for (const rule of TAG_RULES) {
    if (containsKeyword(combined, rule.keywords)) {
      tags.push(rule.tag);
    }
  }
  return [...new Set(tags)];
}

function stripHtml(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseDate(raw) {
  if (!raw) return new Date().toISOString();
  try {
    return new Date(raw).toISOString();
  } catch (_) {
    return new Date().toISOString();
  }
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'DCDossier/1.0 (+https://github.com/dcdossier/Generational-Mid-terms)' },
      timeout: 15000,
    });
    if (!res.ok) {
      console.warn(`[SKIP] ${feed.source}: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);

    const channel = parsed?.rss?.channel || parsed?.feed || {};
    const rawItems = channel.item || channel.entry || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    return items.map(item => {
      const title       = stripHtml(item.title || '');
      const url         = String(item.link || item['@_href'] || item.id || '').trim().replace(/^<|>$/g, '');
      const description = stripHtml(item.description || item.summary || item.content || '').slice(0, 280);
      const date        = parseDate(item.pubDate || item.published || item.updated || item['dc:date']);
      return { title, url, source: feed.source, date, description };
    }).filter(i => i.url && i.title);
  } catch (err) {
    console.warn(`[ERROR] ${feed.source}: ${err.message}`);
    return [];
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[fetch-news] Starting…');

  // Load existing data
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (err) {
    console.error('[fetch-news] Could not read data.json:', err.message);
    process.exit(1);
  }

  const existingUrls = new Set((data.news || []).map(n => n.url));

  // Fetch all feeds concurrently
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const allItems = results.flat();

  console.log(`[fetch-news] Fetched ${allItems.length} raw items from ${FEEDS.length} feeds.`);

  let newCount = 0;

  for (const item of allItems) {
    // Skip already-seen URLs
    if (existingUrls.has(item.url)) continue;

    // Filter by relevance keywords
    const relevant = containsKeyword(`${item.title} ${item.description}`, FILTER_KEYWORDS);
    if (!relevant) continue;

    // Auto-tag
    const tags = autoTag(item.title, item.description);

    data.news.push({
      title: item.title,
      url: item.url,
      source: item.source,
      date: item.date,
      tags,
      description: item.description,
    });

    existingUrls.add(item.url);
    newCount++;
  }

  // Sort by date descending and trim to max
  data.news.sort((a, b) => new Date(b.date) - new Date(a.date));
  data.news = data.news.slice(0, MAX_NEWS_ITEMS);

  // Write back
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`[fetch-news] Done. Added ${newCount} new items. Total: ${data.news.length}.`);
}

main().catch(err => {
  console.error('[fetch-news] Fatal error:', err);
  process.exit(1);
});
