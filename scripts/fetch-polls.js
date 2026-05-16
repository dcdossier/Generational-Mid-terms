#!/usr/bin/env node
'use strict';

/**
 * fetch-polls.js
 * Fetches RSS feeds from RealClearPolitics, Gallup, and Pew Research.
 * Looks for approval, generic ballot, and favourability data, updates
 * the approval and generic_ballot fields in data.json, and stamps
 * meta.last_updated.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');

const DATA_PATH = path.resolve(__dirname, '../data.json');

const POLL_FEEDS = [
  { url: 'https://www.realclearpolitics.com/xml/rss.xml', source: 'RealClearPolitics' },
  { url: 'https://news.gallup.com/rss/gallup_politics_rss.xml', source: 'Gallup' },
  { url: 'https://www.pewresearch.org/feed/', source: 'Pew Research' },
];

const POLL_KEYWORDS = [
  'approval', 'disapproval', 'disapprove', 'generic ballot',
  'congress poll', 'favorability', 'favourability', 'job approval',
  'trump approval', 'biden approval', 'congressional approval',
];

function containsKeyword(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
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

    return items.map(item => ({
      title:       stripHtml(item.title || ''),
      description: stripHtml(item.description || item.summary || '').slice(0, 500),
      link:        String(item.link || item['@_href'] || '').trim(),
      source:      feed.source,
    }));
  } catch (err) {
    console.warn(`[ERROR] ${feed.source}: ${err.message}`);
    return [];
  }
}

/**
 * Attempt to extract a percentage figure near a keyword in text.
 * Returns null if nothing reliable is found.
 */
function extractPct(text, keyword) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return null;
  // Look for a number (with optional decimal) within 120 chars either side of the keyword
  const window = text.slice(Math.max(0, idx - 60), idx + 120);
  const match = window.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

async function main() {
  console.log('[fetch-polls] Starting…');

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (err) {
    console.error('[fetch-polls] Could not read data.json:', err.message);
    process.exit(1);
  }

  const results = await Promise.all(POLL_FEEDS.map(fetchFeed));
  const allItems = results.flat();

  console.log(`[fetch-polls] Fetched ${allItems.length} items from ${POLL_FEEDS.length} feeds.`);

  let updatesApplied = 0;

  for (const item of allItems) {
    const combined = `${item.title} ${item.description}`;
    if (!containsKeyword(combined, POLL_KEYWORDS)) continue;

    const lower = combined.toLowerCase();

    // Trump approval
    if (lower.includes('trump') && lower.includes('approv')) {
      const approve = extractPct(combined, 'approv');
      const disapprove = extractPct(combined, 'disapprov');
      if (approve !== null && approve > 20 && approve < 80) {
        data.approval.trump.approve = approve;
        console.log(`  [trump.approve] ${approve}% from "${item.source}"`);
        updatesApplied++;
      }
      if (disapprove !== null && disapprove > 20 && disapprove < 80) {
        data.approval.trump.disapprove = disapprove;
        console.log(`  [trump.disapprove] ${disapprove}% from "${item.source}"`);
        updatesApplied++;
      }
    }

    // Congress approval
    if (lower.includes('congress') && lower.includes('approv')) {
      const approve = extractPct(combined, 'approv');
      if (approve !== null && approve > 5 && approve < 50) {
        data.approval.congress.approve = approve;
        console.log(`  [congress.approve] ${approve}% from "${item.source}"`);
        updatesApplied++;
      }
    }

    // Generic ballot — look for Democrat vs Republican split
    if (lower.includes('generic ballot')) {
      const demPct = extractPct(combined, 'democrat');
      const repPct = extractPct(combined, 'republican');
      if (demPct !== null && demPct > 30 && demPct < 70) {
        data.generic_ballot.democrat = demPct;
        console.log(`  [generic_ballot.democrat] ${demPct}% from "${item.source}"`);
        updatesApplied++;
      }
      if (repPct !== null && repPct > 30 && repPct < 70) {
        data.generic_ballot.republican = repPct;
        console.log(`  [generic_ballot.republican] ${repPct}% from "${item.source}"`);
        updatesApplied++;
      }
    }

    // Democrat party favourability
    if ((lower.includes('democrat') || lower.includes('democratic party')) && lower.includes('favor')) {
      const approve = extractPct(combined, 'favor');
      if (approve !== null && approve > 20 && approve < 80) {
        data.approval.democrat_party.approve = approve;
        console.log(`  [democrat_party.approve] ${approve}% from "${item.source}"`);
        updatesApplied++;
      }
    }

    // Republican party favourability
    if ((lower.includes('republican') || lower.includes('gop')) && lower.includes('favor')) {
      const approve = extractPct(combined, 'favor');
      if (approve !== null && approve > 20 && approve < 80) {
        data.approval.republican_party.approve = approve;
        console.log(`  [republican_party.approve] ${approve}% from "${item.source}"`);
        updatesApplied++;
      }
    }
  }

  // Always stamp the last_updated time
  data.meta.last_updated = new Date().toISOString();

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`[fetch-polls] Done. ${updatesApplied} field(s) updated. last_updated set to ${data.meta.last_updated}.`);
}

main().catch(err => {
  console.error('[fetch-polls] Fatal error:', err);
  process.exit(1);
});
