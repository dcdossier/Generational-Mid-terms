#!/usr/bin/env node
'use strict';

/**
 * fetch-polls.js
 * Fetches polling data from RSS feeds and Google News targeted searches.
 * Updates approval ratings, generic ballot, party favourability, and
 * related history arrays / trend fields in data.json.
 */

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');

const DATA_PATH = path.resolve(__dirname, '../data.json');

// ── SOURCES ────────────────────────────────────────────────────────────────────
// Each feed may carry an optional `hints` array of signal types to look for.
const POLL_FEEDS = [
  // Polling organisations
  { url: 'https://news.gallup.com/rss/gallup_politics_rss.xml',
    source: 'Gallup' },
  { url: 'https://www.pewresearch.org/feed/',
    source: 'Pew Research' },
  { url: 'https://yougov.com/en-us/rss',
    source: 'YouGov' },
  { url: 'https://www.realclearpolitics.com/xml/rss.xml',
    source: 'RealClearPolitics' },

  // Forecasters / election sites
  { url: 'https://centerforpolitics.org/crystalball/feed/',
    source: "Sabato's Crystal Ball" },
  { url: 'https://www.cookpolitical.com/feed',
    source: 'Cook Political Report' },
  { url: 'https://insideelections.com/feed/',
    source: 'Inside Elections' },
  { url: 'https://www.brookings.edu/feed/',
    source: 'Brookings' },

  // Google News targeted searches — cast a wide net
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Trump+approval+rating+poll+percent+2026',
    source: 'GNews:TrumpApproval',   hints: ['trump_approval'] },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=generic+ballot+2026+Democrats+Republicans+percent',
    source: 'GNews:GenericBallot',   hints: ['generic_ballot'] },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=congressional+approval+rating+Congress+poll+percent',
    source: 'GNews:CongressApproval', hints: ['congress_approval'] },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Republican+party+favorability+unfavorable+poll',
    source: 'GNews:RepFavor',         hints: ['rep_favor'] },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Democratic+party+favorability+unfavorable+poll',
    source: 'GNews:DemFavor',         hints: ['dem_favor'] },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Gallup+Trump+approval+disapproval',
    source: 'GNews:GallupTrump',      hints: ['trump_approval'] },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Quinnipiac+poll+Trump+approve+disapprove',
    source: 'GNews:QuinnTrump',       hints: ['trump_approval'] },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Emerson+poll+generic+ballot+2026',
    source: 'GNews:EmersonBallot',    hints: ['generic_ballot'] },
  { url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=FiveThirtyEight+polling+average+2026',
    source: 'GNews:538',              hints: ['trump_approval', 'generic_ballot'] },
];

// ── HELPERS ────────────────────────────────────────────────────────────────────

function stripHtml(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Search for a number (with optional decimal) within ±windowChars of keyword.
 * Returns the first match, or null.
 */
function extractPct(text, keyword, windowChars = 120) {
  const lower = text.toLowerCase();
  const idx   = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return null;
  const window = text.slice(Math.max(0, idx - windowChars), idx + windowChars);
  const m = window.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Try multiple keyword variants and return the first non-null result.
 */
function extractAny(text, keywords, windowChars = 120) {
  for (const kw of keywords) {
    const v = extractPct(text, kw, windowChars);
    if (v !== null) return v;
  }
  return null;
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
    const xml    = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);

    const channel  = parsed?.rss?.channel || parsed?.feed || {};
    const rawItems = channel.item || channel.entry || [];
    const items    = Array.isArray(rawItems) ? rawItems : [rawItems];

    return items.map(item => ({
      title:       stripHtml(item.title || ''),
      description: stripHtml(item.description || item.summary || item.content || '').slice(0, 600),
      link:        String(item.link || item['@_href'] || '').trim(),
      source:      feed.source,
      hints:       feed.hints || [],
    }));
  } catch (err) {
    console.warn(`[ERROR] ${feed.source}: ${err.message}`);
    return [];
  }
}

// ── MONTH HELPERS ──────────────────────────────────────────────────────────────

/** Returns "Mon YYYY" string for a Date, e.g. "May 2026" */
function monthLabel(date = new Date()) {
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * Upsert a history array entry for the current month.
 * If the current month already exists, update specified fields.
 * Otherwise append a new object with defaults merged with updates.
 */
function upsertHistory(historyArr, monthStr, updates, defaults = {}) {
  const existing = historyArr.find(h => h.month === monthStr);
  if (existing) {
    Object.assign(existing, updates);
  } else {
    historyArr.push({ month: monthStr, ...defaults, ...updates });
  }
}

/**
 * Calculate trend vs. the previous entry in a history array.
 * Returns the delta (positive = up, negative = down) for a given field.
 */
function calcTrend(historyArr, field) {
  if (historyArr.length < 2) return 0;
  const last = historyArr[historyArr.length - 1];
  const prev = historyArr[historyArr.length - 2];
  if (last?.[field] == null || prev?.[field] == null) return 0;
  return parseFloat((last[field] - prev[field]).toFixed(1));
}

// ── SIGNAL ACCUMULATORS ────────────────────────────────────────────────────────
// We collect values across all articles then average per field to reduce noise.

function makeAccum() {
  const buckets = {};
  return {
    push(field, value, source) {
      if (!buckets[field]) buckets[field] = [];
      buckets[field].push({ value, source });
    },
    /**
     * Return the median (or simple average) of collected values for a field,
     * clamped to [min, max].  Returns null if no values collected.
     */
    avg(field, min = 0, max = 100) {
      const vals = (buckets[field] || []).map(x => x.value).filter(v => v >= min && v <= max);
      if (!vals.length) return null;
      vals.sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      const median = vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
      return parseFloat(median.toFixed(1));
    },
    sources(field) {
      return [...new Set((buckets[field] || []).map(x => x.source))];
    },
    count(field) {
      return (buckets[field] || []).length;
    },
  };
}

// ── SIGNAL EXTRACTION ──────────────────────────────────────────────────────────

function extractSignals(item, accum) {
  const text  = `${item.title} ${item.description}`;
  const lower = text.toLowerCase();

  // ── Trump approval ──────────────────────────────────────────────────────────
  const isTrumpApproval = (lower.includes('trump') && (lower.includes('approv') || lower.includes('disapprov')))
    || item.hints.includes('trump_approval');

  if (isTrumpApproval) {
    const approve    = extractAny(text, ['approve', 'approval']);
    const disapprove = extractAny(text, ['disapprove', 'disapproval']);

    if (approve    !== null && approve    > 25 && approve    < 75) accum.push('trump_approve',    approve,    item.source);
    if (disapprove !== null && disapprove > 25 && disapprove < 75) accum.push('trump_disapprove', disapprove, item.source);
  }

  // ── Congress approval ───────────────────────────────────────────────────────
  const isCongressApproval = ((lower.includes('congress') || lower.includes('congressional'))
    && lower.includes('approv'))
    || item.hints.includes('congress_approval');

  if (isCongressApproval) {
    const approve = extractAny(text, ['approve', 'approval']);
    if (approve !== null && approve > 5 && approve < 55) accum.push('congress_approve', approve, item.source);

    const disapprove = extractAny(text, ['disapprove', 'disapproval']);
    if (disapprove !== null && disapprove > 30 && disapprove < 95) accum.push('congress_disapprove', disapprove, item.source);
  }

  // ── Generic ballot ──────────────────────────────────────────────────────────
  const isGenericBallot = lower.includes('generic ballot')
    || item.hints.includes('generic_ballot');

  if (isGenericBallot) {
    const demPct = extractAny(text, ['democrat', 'democratic']);
    const repPct = extractAny(text, ['republican', 'gop']);
    if (demPct !== null && demPct > 30 && demPct < 70) accum.push('ballot_dem', demPct, item.source);
    if (repPct !== null && repPct > 30 && repPct < 70) accum.push('ballot_rep', repPct, item.source);
  }

  // ── Democrat party favourability ────────────────────────────────────────────
  const isDemFavor = ((lower.includes('democrat') || lower.includes('democratic party'))
    && (lower.includes('favor') || lower.includes('favour') || lower.includes('unfavor')))
    || item.hints.includes('dem_favor');

  if (isDemFavor) {
    const fav = extractAny(text, ['favorable', 'favourably', 'approve', 'positive']);
    if (fav !== null && fav > 15 && fav < 75) accum.push('dem_favor', fav, item.source);
    const unfav = extractAny(text, ['unfavorable', 'unfavourably', 'disapprove', 'negative']);
    if (unfav !== null && unfav > 15 && unfav < 85) accum.push('dem_unfavor', unfav, item.source);
  }

  // ── Republican party favourability ─────────────────────────────────────────
  const isRepFavor = ((lower.includes('republican') || lower.includes('gop'))
    && (lower.includes('favor') || lower.includes('favour') || lower.includes('unfavor')))
    || item.hints.includes('rep_favor');

  if (isRepFavor) {
    const fav = extractAny(text, ['favorable', 'favourably', 'approve', 'positive']);
    if (fav !== null && fav > 15 && fav < 75) accum.push('rep_favor', fav, item.source);
    const unfav = extractAny(text, ['unfavorable', 'unfavourably', 'disapprove', 'negative']);
    if (unfav !== null && unfav > 15 && unfav < 85) accum.push('rep_unfavor', unfav, item.source);
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[fetch-polls] Starting…');

  // Load existing data
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (err) {
    console.error('[fetch-polls] Could not read data.json:', err.message);
    process.exit(1);
  }

  // Ensure required sub-trees exist
  data.approval         = data.approval         || {};
  data.approval.trump   = data.approval.trump   || { approve: null, disapprove: null, trend: 0, history: [] };
  data.approval.congress = data.approval.congress || { approve: null, disapprove: null, trend: 0, history: [] };
  data.approval.democrat_party   = data.approval.democrat_party   || { approve: null, disapprove: null };
  data.approval.republican_party = data.approval.republican_party || { approve: null, disapprove: null };
  data.generic_ballot   = data.generic_ballot   || { democrat: null, republican: null, trend_d: 0, trend_r: 0, history: [], pollsters: [] };

  // Fetch all feeds concurrently
  const results  = await Promise.all(POLL_FEEDS.map(fetchFeed));
  const allItems = results.flat();
  console.log(`[fetch-polls] Fetched ${allItems.length} items from ${POLL_FEEDS.length} feeds.`);

  // Accumulate signals across all items
  const accum = makeAccum();
  for (const item of allItems) {
    extractSignals(item, accum);
  }

  // Log collected signal counts
  for (const field of ['trump_approve', 'trump_disapprove', 'congress_approve', 'congress_disapprove',
                        'ballot_dem', 'ballot_rep', 'dem_favor', 'dem_unfavor', 'rep_favor', 'rep_unfavor']) {
    if (accum.count(field) > 0) {
      console.log(`  [${field}] ${accum.count(field)} signal(s) from: ${accum.sources(field).join(', ')}`);
    }
  }

  const month = monthLabel();
  let updatesApplied = 0;

  // ── Apply Trump approval ────────────────────────────────────────────────────
  const trumpApprove    = accum.avg('trump_approve',    30, 70);
  const trumpDisapprove = accum.avg('trump_disapprove', 30, 70);

  if (trumpApprove !== null) {
    data.approval.trump.approve = trumpApprove;
    upsertHistory(data.approval.trump.history, month,
      { approve: trumpApprove, disapprove: data.approval.trump.disapprove },
      { approve: trumpApprove, disapprove: 0 });
    updatesApplied++;
    console.log(`  → trump.approve = ${trumpApprove}%`);
  }
  if (trumpDisapprove !== null) {
    data.approval.trump.disapprove = trumpDisapprove;
    // Also update the history entry we may have just inserted
    const entry = data.approval.trump.history.find(h => h.month === month);
    if (entry) entry.disapprove = trumpDisapprove;
    updatesApplied++;
    console.log(`  → trump.disapprove = ${trumpDisapprove}%`);
  }
  if (trumpApprove !== null || trumpDisapprove !== null) {
    data.approval.trump.trend = calcTrend(data.approval.trump.history, 'approve');
  }

  // ── Apply Congress approval ─────────────────────────────────────────────────
  const congressApprove    = accum.avg('congress_approve',    5, 50);
  const congressDisapprove = accum.avg('congress_disapprove', 30, 95);

  if (congressApprove !== null) {
    data.approval.congress.approve = congressApprove;
    upsertHistory(data.approval.congress.history, month,
      { approve: congressApprove, disapprove: data.approval.congress.disapprove },
      { approve: congressApprove, disapprove: 0 });
    updatesApplied++;
    console.log(`  → congress.approve = ${congressApprove}%`);
  }
  if (congressDisapprove !== null) {
    data.approval.congress.disapprove = congressDisapprove;
    const entry = data.approval.congress.history.find(h => h.month === month);
    if (entry) entry.disapprove = congressDisapprove;
    updatesApplied++;
    console.log(`  → congress.disapprove = ${congressDisapprove}%`);
  }
  if (congressApprove !== null || congressDisapprove !== null) {
    data.approval.congress.trend = calcTrend(data.approval.congress.history, 'approve');
  }

  // ── Apply Generic ballot ────────────────────────────────────────────────────
  const ballotDem = accum.avg('ballot_dem', 33, 65);
  const ballotRep = accum.avg('ballot_rep', 33, 65);

  if (ballotDem !== null) {
    const prevDem = data.generic_ballot.democrat;
    data.generic_ballot.democrat = ballotDem;
    upsertHistory(data.generic_ballot.history, month,
      { democrat: ballotDem, republican: data.generic_ballot.republican || ballotRep },
      { democrat: ballotDem, republican: ballotRep || 0 });
    if (prevDem !== null) data.generic_ballot.trend_d = parseFloat((ballotDem - prevDem).toFixed(1));
    updatesApplied++;
    console.log(`  → generic_ballot.democrat = ${ballotDem}%`);

    // Add to pollsters list (de-dup by month)
    const pollsterSources = accum.sources('ballot_dem').concat(accum.sources('ballot_rep'));
    const label = [...new Set(pollsterSources)].join(' / ');
    const pollsterEntry = data.generic_ballot.pollsters.find(p =>
      p.date === month && p.name === label);
    if (!pollsterEntry && label) {
      data.generic_ballot.pollsters.unshift({ name: label, democrat: ballotDem, republican: ballotRep, date: month });
      // Keep list to 10 entries
      data.generic_ballot.pollsters = data.generic_ballot.pollsters.slice(0, 10);
    }
  }
  if (ballotRep !== null) {
    const prevRep = data.generic_ballot.republican;
    data.generic_ballot.republican = ballotRep;
    const entry = data.generic_ballot.history.find(h => h.month === month);
    if (entry) entry.republican = ballotRep;
    if (prevRep !== null) data.generic_ballot.trend_r = parseFloat((ballotRep - prevRep).toFixed(1));
    updatesApplied++;
    console.log(`  → generic_ballot.republican = ${ballotRep}%`);
  }

  // ── Apply party favourability ───────────────────────────────────────────────
  const demFavor   = accum.avg('dem_favor',   20, 75);
  const demUnfavor = accum.avg('dem_unfavor', 20, 80);
  const repFavor   = accum.avg('rep_favor',   20, 75);
  const repUnfavor = accum.avg('rep_unfavor', 20, 80);

  if (demFavor !== null) {
    data.approval.democrat_party.approve = demFavor;
    updatesApplied++;
    console.log(`  → democrat_party.approve = ${demFavor}%`);
  }
  if (demUnfavor !== null) {
    data.approval.democrat_party.disapprove = demUnfavor;
    updatesApplied++;
    console.log(`  → democrat_party.disapprove = ${demUnfavor}%`);
  }
  if (repFavor !== null) {
    data.approval.republican_party.approve = repFavor;
    updatesApplied++;
    console.log(`  → republican_party.approve = ${repFavor}%`);
  }
  if (repUnfavor !== null) {
    data.approval.republican_party.disapprove = repUnfavor;
    updatesApplied++;
    console.log(`  → republican_party.disapprove = ${repUnfavor}%`);
  }

  // ── Always stamp last_updated ───────────────────────────────────────────────
  data.meta.last_updated = new Date().toISOString();

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`[fetch-polls] Done. ${updatesApplied} field(s) updated. last_updated = ${data.meta.last_updated}`);
}

main().catch(err => {
  console.error('[fetch-polls] Fatal error:', err);
  process.exit(1);
});
