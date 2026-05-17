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
 * Extract a percentage near `keyword` in text.  Tries three patterns in order:
 *   P1 — explicit %:     "44%"  /  "44.5%"
 *   P2 — word "percent": "52 percent"
 *   P3 — bare number immediately after keyword (within 35 chars): "approve 44"
 *         (restricted to 20–79 to rule out years, sentence counts, etc.)
 * Returns the first match as a float, or null.
 */
function extractPct(text, keyword, windowChars = 150) {
  const lower = text.toLowerCase();
  const idx   = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return null;
  const slice = text.slice(Math.max(0, idx - windowChars), idx + windowChars);

  // P1: "NN%" — most reliable
  let m = slice.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
  if (m) return parseFloat(m[1]);

  // P2: "NN percent" or "NN.N percent"
  m = slice.match(/(\d{1,3}(?:\.\d{1,2})?)\s+percent\b/i);
  if (m) return parseFloat(m[1]);

  // P3: keyword then bare number within 35 chars — e.g. "approve 44", "approval at 44"
  const afterKw = text.slice(idx + keyword.length, idx + keyword.length + 35);
  m = afterKw.match(/\b([2-7]\d(?:\.\d{1,2})?)\b/);
  if (m) return parseFloat(m[1]);

  return null;
}

/**
 * Try multiple keyword variants; return the first non-null result.
 */
function extractAny(text, keywords, windowChars = 150) {
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

// ── SOURCE GROUPS ──────────────────────────────────────────────────────────────
// Controls which fields each source is trusted to populate.

const SRC_TRUMP_APPROVAL  = new Set(['Gallup', 'RealClearPolitics', 'YouGov']);
const SRC_CONGRESS        = new Set(['Gallup', 'YouGov', 'Pew Research']);
const SRC_GENERIC_BALLOT  = new Set(['RealClearPolitics', 'YouGov']);
const SRC_PARTY_FAVOR     = new Set(['Pew Research', 'YouGov', 'Gallup']);

// ── SIGNAL EXTRACTION ──────────────────────────────────────────────────────────
// Returns an object of { fieldName: value } for every signal extracted from the
// item.  Logs a single line per item that yields at least one signal.

function extractSignals(item, accum) {
  const text  = `${item.title} ${item.description}`;
  const lower = text.toLowerCase();
  const src   = item.source;
  const hints = item.hints;
  const found = {};   // field → value, for per-item logging

  // ── Trump approve / disapprove ───────────────────────────────────────────────
  // Trusted sources: Gallup, RCP, YouGov  +  any feed hinting 'trump_approval'
  const doTrump = (SRC_TRUMP_APPROVAL.has(src) || hints.includes('trump_approval'))
    && lower.includes('trump')
    && (lower.includes('approv') || lower.includes('disapprov'));

  if (doTrump) {
    const approve    = extractAny(text, ['approve', 'approval', 'job approval']);
    const disapprove = extractAny(text, ['disapprove', 'disapproval']);

    if (approve    !== null && approve    > 25 && approve    < 75) {
      accum.push('trump_approve', approve, src);
      found.trump_approve = approve;
    }
    if (disapprove !== null && disapprove > 25 && disapprove < 75) {
      accum.push('trump_disapprove', disapprove, src);
      found.trump_disapprove = disapprove;
    }
  }

  // ── Congress approve / disapprove ───────────────────────────────────────────
  // Trusted sources: Gallup, YouGov, Pew  +  congress_approval hint
  const doCongress = (SRC_CONGRESS.has(src) || hints.includes('congress_approval'))
    && (lower.includes('congress') || lower.includes('congressional'))
    && lower.includes('approv');

  if (doCongress) {
    const approve    = extractAny(text, ['congress approve', 'congressional approve', 'approve', 'approval']);
    const disapprove = extractAny(text, ['congress disapprove', 'disapprove', 'disapproval']);

    if (approve    !== null && approve    >  5 && approve    < 55) {
      accum.push('congress_approve', approve, src);
      found.congress_approve = approve;
    }
    if (disapprove !== null && disapprove > 30 && disapprove < 95) {
      accum.push('congress_disapprove', disapprove, src);
      found.congress_disapprove = disapprove;
    }
  }

  // ── Generic ballot D / R ────────────────────────────────────────────────────
  // Trusted sources: RealClearPolitics, YouGov  +  generic_ballot hint
  const doBallot = (SRC_GENERIC_BALLOT.has(src) || hints.includes('generic_ballot'))
    && lower.includes('generic ballot');

  if (doBallot) {
    const demPct = extractAny(text, ['democrat', 'democratic']);
    const repPct = extractAny(text, ['republican', 'gop']);

    if (demPct !== null && demPct > 30 && demPct < 70) {
      accum.push('ballot_dem', demPct, src);
      found.ballot_dem = demPct;
    }
    if (repPct !== null && repPct > 30 && repPct < 70) {
      accum.push('ballot_rep', repPct, src);
      found.ballot_rep = repPct;
    }
  }

  // ── Democrat party favourability ────────────────────────────────────────────
  // Trusted sources: Pew Research, YouGov, Gallup  +  dem_favor hint
  const doDemFavor = (SRC_PARTY_FAVOR.has(src) || hints.includes('dem_favor'))
    && (lower.includes('democrat') || lower.includes('democratic party'))
    && (lower.includes('favor') || lower.includes('unfavor') || lower.includes('favour'));

  if (doDemFavor) {
    const fav   = extractAny(text, ['favorable', 'favourable', 'positive view']);
    const unfav = extractAny(text, ['unfavorable', 'unfavourable', 'negative view']);

    if (fav   !== null && fav   > 15 && fav   < 75) { accum.push('dem_favor',   fav,   src); found.dem_favor   = fav; }
    if (unfav !== null && unfav > 15 && unfav < 85) { accum.push('dem_unfavor', unfav, src); found.dem_unfavor = unfav; }
  }

  // ── Republican party favourability ─────────────────────────────────────────
  // Trusted sources: Pew Research, YouGov, Gallup  +  rep_favor hint
  const doRepFavor = (SRC_PARTY_FAVOR.has(src) || hints.includes('rep_favor'))
    && (lower.includes('republican') || lower.includes('gop'))
    && (lower.includes('favor') || lower.includes('unfavor') || lower.includes('favour'));

  if (doRepFavor) {
    const fav   = extractAny(text, ['favorable', 'favourable', 'positive view']);
    const unfav = extractAny(text, ['unfavorable', 'unfavourable', 'negative view']);

    if (fav   !== null && fav   > 15 && fav   < 75) { accum.push('rep_favor',   fav,   src); found.rep_favor   = fav; }
    if (unfav !== null && unfav > 15 && unfav < 85) { accum.push('rep_unfavor', unfav, src); found.rep_unfavor = unfav; }
  }

  // ── Per-item log ────────────────────────────────────────────────────────────
  if (Object.keys(found).length > 0) {
    const pairs  = Object.entries(found).map(([k, v]) => `${k}=${v}`).join(', ');
    const title  = item.title.length > 72 ? item.title.slice(0, 69) + '…' : item.title;
    console.log(`  [${src}] "${title}" → ${pairs}`);
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

  // Extract signals — per-item log lines emitted inside extractSignals()
  const accum = makeAccum();
  for (const item of allItems) {
    extractSignals(item, accum);
  }

  // Summary: how many signals collected per field
  const ALL_FIELDS = ['trump_approve', 'trump_disapprove', 'congress_approve', 'congress_disapprove',
                      'ballot_dem', 'ballot_rep', 'dem_favor', 'dem_unfavor', 'rep_favor', 'rep_unfavor'];
  const summary = ALL_FIELDS.filter(f => accum.count(f) > 0)
    .map(f => `${f}(${accum.count(f)})`).join(', ');
  console.log(`[fetch-polls] Signals collected: ${summary || 'none'}`);
  console.log('[fetch-polls] Applying medians…');

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
