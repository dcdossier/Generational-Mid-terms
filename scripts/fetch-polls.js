#!/usr/bin/env node
'use strict';

/**
 * fetch-polls.js — comprehensive live data updater
 *
 * Sources (in priority order):
 *  1. NYT polling CSVs       → generic_ballot, state_polls   (structured CSV)
 *  2. BLS public API         → cpi.history                   (structured JSON)
 *  3. Nate Silver Bulletin   → approval.trump                (Datawrapper CSV direct API)
 *     Chart: datawrapper.dwcdn.net/kSCt4/ — fetches latest version, downloads CSV
 *  4. Groq + Gallup          → congress_approval             (AI-extracted HTML)
 *  5. Groq + Ballotpedia     → retirements totals/split      (AI-extracted HTML)
 *  6. RSS feed fallbacks     → backup only if primary sources fail (regex extraction)
 *
 * Env vars:
 *  GROQ_API_KEY  — Groq API key (required for sources 3-5)
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');

const DATA_PATH  = path.resolve(__dirname, '../data.json');
const GROQ_KEY   = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function stripHtml(str) {
  return String(str || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{3,}/g, '\n').trim();
}

function monthLabel(date = new Date()) {
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function upsertHistory(arr, monthStr, updates, defaults = {}) {
  const existing = arr.find(h => h.month === monthStr);
  if (existing) Object.assign(existing, updates);
  else arr.push({ month: monthStr, ...defaults, ...updates });
}

function calcTrend(arr, field) {
  if (arr.length < 2) return 0;
  const last = arr[arr.length - 1];
  const prev = arr[arr.length - 2];
  if (last?.[field] == null || prev?.[field] == null) return 0;
  return parseFloat((last[field] - prev[field]).toFixed(1));
}

// Quoted-field CSV parser
function parseCSVRow(line) {
  const fields = []; let inQ = false, cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { fields.push(cur); cur = ''; }
    else cur += c;
  }
  fields.push(cur);
  return fields;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const headers = parseCSVRow(lines[0]).map(h => h.replace(/"/g, '').trim());
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  return { idx, rows: lines.slice(1) };
}

async function safeFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DCDossier/2.0 (+https://github.com/dcdossier/Generational-Mid-terms)' },
    timeout: 25000,
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ AI EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

async function groqExtract(systemPrompt, userContent) {
  if (!GROQ_KEY) {
    console.warn('  [Groq] No GROQ_API_KEY set — skipping AI extraction');
    return null;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0,
          max_tokens: 512,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userContent.slice(0, 14000) },
          ],
        }),
        timeout: 30000,
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`  [Groq] HTTP ${res.status} on attempt ${attempt}: ${body.slice(0, 120)}`);
        if (res.status === 401) return null; // bad key, don't retry
        continue;
      }
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content || '';
      const match = content.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (err) {
      console.warn(`  [Groq] Error attempt ${attempt}: ${err.message}`);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NYT POLLING CSV → generic_ballot + state_polls
// ─────────────────────────────────────────────────────────────────────────────

async function fetchNYTPolls(data) {
  console.log('[1/6] NYT Polling CSVs…');
  const polls = {};
  const CSVS = [
    'https://www.nytimes.com/newsgraphics/polls/house.csv',
    'https://www.nytimes.com/newsgraphics/polls/senate.csv',
  ];

  for (const csvUrl of CSVS) {
    let text;
    try {
      const res = await safeFetch(csvUrl);
      text = await res.text();
    } catch (err) {
      console.warn(`  [NYT] ${csvUrl.split('/').pop()} fetch failed: ${err.message}`);
      continue;
    }

    const { idx, rows } = parseCSV(text);
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days

    for (const line of rows) {
      const f = parseCSVRow(line);
      const get = k => (f[idx[k]] || '').replace(/"/g, '').trim();

      if (get('stage') !== 'general') continue;
      if (!['rv', 'lv', 'v'].includes(get('population'))) continue;
      if (!['DEM', 'REP'].includes(get('party'))) continue;

      const parts = get('end_date').split('/');
      if (parts.length !== 3) continue;
      const date = new Date(2000 + parseInt(parts[2], 10), parseInt(parts[0], 10) - 1, parseInt(parts[1], 10));
      if (isNaN(date.getTime()) || date.getTime() < cutoff) continue;

      const key = get('poll_id') + '_' + get('question_id');
      if (!polls[key]) {
        polls[key] = {
          state:   get('state'),
          seatNum: get('seat_number'),
          partisan:get('partisan'),
          n:       parseInt(get('sample_size'), 10) || 1000,
          date,
          DEM: null, REP: null,
        };
      }
      polls[key][get('party')] = parseFloat(get('pct'));
    }
  }

  const complete = Object.values(polls).filter(p => p.DEM !== null && p.REP !== null);
  if (!complete.length) { console.warn('  [NYT] No complete polls found'); return false; }

  // ── National generic ballot ───────────────────────────────────────────────
  const national = complete.filter(p => p.state === 'US' && p.seatNum === '' && !p.partisan);
  if (national.length >= 3) {
    let tw = 0, wd = 0, wr = 0;
    national.forEach(p => { const w = Math.min(p.n, 3000); tw += w; wd += p.DEM * w; wr += p.REP * w; });
    const avgD = parseFloat((wd / tw).toFixed(1));
    const avgR = parseFloat((wr / tw).toFixed(1));
    const month = monthLabel();

    const prevD = data.generic_ballot.democrat;
    const prevR = data.generic_ballot.republican;
    data.generic_ballot.democrat   = avgD;
    data.generic_ballot.republican = avgR;
    data.generic_ballot.undecided  = parseFloat((100 - avgD - avgR).toFixed(1));
    if (prevD != null) data.generic_ballot.trend_d = parseFloat((avgD - prevD).toFixed(1));
    if (prevR != null) data.generic_ballot.trend_r = parseFloat((avgR - prevR).toFixed(1));

    upsertHistory(data.generic_ballot.history, month,
      { democrat: avgD, republican: avgR },
      { democrat: avgD, republican: avgR });

    console.log(`  Generic ballot: D=${avgD}% R=${avgR}% (${national.length} polls, 60-day weighted avg)`);
  }

  // ── State-level polls ─────────────────────────────────────────────────────
  const byState = {};
  for (const p of complete.filter(p => p.state !== 'US' && /^[A-Z]{2}$/.test(p.state))) {
    if (!byState[p.state]) byState[p.state] = [];
    byState[p.state].push(p);
  }

  data.state_polls = data.state_polls || {};
  let stateCount = 0;
  for (const [st, stPolls] of Object.entries(byState)) {
    if (!stPolls.length) continue;
    let tw = 0, wd = 0, wr = 0;
    stPolls.forEach(p => { const w = Math.min(p.n, 3000); tw += w; wd += p.DEM * w; wr += p.REP * w; });
    const avgD = parseFloat((wd / tw).toFixed(1));
    const avgR = parseFloat((wr / tw).toFixed(1));
    data.state_polls[st] = {
      DEM:     avgD,
      REP:     avgR,
      margin:  parseFloat((avgD - avgR).toFixed(1)),
      n_polls: stPolls.length,
      updated: new Date().toISOString().slice(0, 10),
    };
    stateCount++;
  }
  if (stateCount) console.log(`  State polls updated: ${stateCount} states`);

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. BLS API → cpi.history
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCPI(data) {
  console.log('[2/6] BLS CPI API…');
  try {
    // Series CUUR0000SA0 = CPI-U All Items, not seasonally adjusted
    const res = await safeFetch(
      'https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0?startyear=2023&endyear=2026'
    );
    const json = await res.json();

    if (json.status !== 'REQUEST_SUCCEEDED') throw new Error(json.message?.[0] || 'BLS API error');
    const series = json.Results?.series?.[0]?.data || [];
    if (!series.length) throw new Error('Empty BLS response');

    // Build index lookup: "YYYY-M" → value
    const byPeriod = {};
    for (const d of series) {
      byPeriod[`${d.year}-${parseInt(d.period.slice(1), 10)}`] = parseFloat(d.value);
    }

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Compute YoY % change for months where we have both current + prior year
    const history = [];
    const sorted = [...series].sort((a, b) => {
      const aVal = parseInt(a.year) * 100 + parseInt(a.period.slice(1));
      const bVal = parseInt(b.year) * 100 + parseInt(b.period.slice(1));
      return aVal - bVal;
    });

    for (const d of sorted) {
      const yr = parseInt(d.year, 10);
      const mo = parseInt(d.period.slice(1), 10);
      if (yr < 2025) continue; // only show 2025+
      const curr = parseFloat(d.value);
      const priorKey = `${yr - 1}-${mo}`;
      const prior = byPeriod[priorKey];
      if (!prior) continue;
      const yoy = parseFloat(((curr - prior) / prior * 100).toFixed(1));
      history.push({ month: `${MONTHS[mo - 1]} ${yr}`, all_items: yoy, estimated: false });
    }

    if (!history.length) throw new Error('Could not compute YoY CPI');

    // Merge: keep manual entries for months BLS hasn't released yet, replace real months
    const blsMonths = new Set(history.map(h => h.month));
    const preserved = (data.cpi.history || []).filter(h => !blsMonths.has(h.month));
    const merged = [...history, ...preserved].sort((a, b) => {
      const toMs = s => { const [mo, yr] = s.split(' '); return new Date(`${mo} 1 ${yr}`).getTime(); };
      return toMs(a.month) - toMs(b.month);
    });

    const latest = merged[merged.length - 1];
    data.cpi.history  = merged;
    data.cpi.current  = latest?.all_items ?? null;
    data.cpi.month    = latest?.month ?? null;
    data.cpi.updated  = new Date().toISOString().slice(0, 10);

    console.log(`  CPI: ${latest?.all_items}% YoY (${latest?.month}), ${merged.length} months history`);
    return true;
  } catch (err) {
    console.warn(`  [BLS] CPI fetch failed: ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TRUMP APPROVAL — Nate Silver Bulletin (Datawrapper CSV, direct API)
//    Source: https://www.natesilver.net/p/trump-approval-ratings-nate-silver-bulletin
//    Chart:  https://datawrapper.dwcdn.net/kSCt4/ (approval average model)
//    Method: fetch base chart URL → extract latest version → download CSV → take latest row
// ─────────────────────────────────────────────────────────────────────────────

const DW_APPROVAL_CHART = 'kSCt4';   // Nate Silver approval average chart ID
const DW_BASE_URL       = 'https://datawrapper.dwcdn.net';
const NATE_SILVER_URL   = 'https://www.natesilver.net/p/trump-approval-ratings-nate-silver-bulletin';

async function fetchTrumpApproval(data) {
  console.log('[3/6] Trump approval (Nate Silver Bulletin / Datawrapper CSV)…');

  // ── Step 1: discover the latest chart version ────────────────────────────
  // The base URL (no version) always returns the latest chart HTML.
  // That HTML contains the versioned path we need for the CSV endpoint.
  let latestVersion = null;
  try {
    const res = await safeFetch(`${DW_BASE_URL}/${DW_APPROVAL_CHART}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DCDossier/2.0)' },
    });
    const html = await res.text();
    // e.g. src="https://datawrapper.dwcdn.net/kSCt4/5899/"
    const m = html.match(new RegExp(`${DW_APPROVAL_CHART}/(\\d+)`));
    if (m) latestVersion = m[1];
  } catch (err) {
    console.warn(`  [DW] Version discovery failed: ${err.message}`);
  }

  if (!latestVersion) {
    console.warn('  [DW] Could not determine chart version — skipping Datawrapper');
  } else {
    console.log(`  Chart version: ${DW_APPROVAL_CHART}/${latestVersion}`);

    // ── Step 2: fetch the CSV dataset ───────────────────────────────────────
    const csvUrl = `${DW_BASE_URL}/${DW_APPROVAL_CHART}/${latestVersion}/dataset.csv`;
    let csvText = '';
    try {
      const res = await safeFetch(csvUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DCDossier/2.0)' },
      });
      csvText = await res.text();
    } catch (err) {
      console.warn(`  [DW] CSV fetch failed: ${err.message}`);
    }

    if (csvText) {
      // ── Step 3: parse CSV and extract latest data point ──────────────────
      // CSV columns: modeldate,approve,disapprove,approve_lo,approve_hi,disapprove_lo,disapprove_hi
      const lines = csvText.trim().split('\n').filter(l => l.trim());
      if (lines.length >= 2) {
        const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
        const appIdx  = headers.findIndex(h => h === 'approve');
        const disIdx  = headers.findIndex(h => h === 'disapprove');
        const dateIdx = headers.findIndex(h => h === 'modeldate' || h === 'date');

        if (appIdx !== -1 && disIdx !== -1) {
          const lastLine = lines[lines.length - 1];
          const cols     = lastLine.split(',').map(c => c.replace(/"/g, '').trim());
          const approve    = parseFloat(parseFloat(cols[appIdx]).toFixed(1));
          const disapprove = parseFloat(parseFloat(cols[disIdx]).toFixed(1));
          const modelDate  = dateIdx !== -1 ? cols[dateIdx] : 'unknown';

          // ── Step 4: validate before writing ─────────────────────────────
          const valid = (
            approve    > 25 && approve    < 70 &&
            disapprove > 30 && disapprove < 75 &&
            Math.abs(approve + disapprove - 100) < 30  // not wildly off 100%
          );

          // Sanity: don't jump more than 15 points from last stored value
          const prevApprove = data.approval.trump.approve;
          const saneChange  = prevApprove == null || Math.abs(approve - prevApprove) < 15;

          if (valid && saneChange) {
            const net   = parseFloat((approve - disapprove).toFixed(1));
            const month = monthLabel();

            data.approval.trump.approve    = approve;
            data.approval.trump.disapprove = disapprove;
            data.approval.trump.net        = net;
            data.approval.trump.source     = 'Nate Silver Bulletin';
            upsertHistory(data.approval.trump.history, month,
              { approve, disapprove, net }, { approve, disapprove, net });
            data.approval.trump.trend = calcTrend(data.approval.trump.history, 'approve');

            console.log(`  ✓ Trump approval [Nate Silver/${DW_APPROVAL_CHART} v${latestVersion}] as of ${modelDate}: ${approve}% / ${disapprove}% / net ${net >= 0 ? '+' : ''}${net}`);
            return true;
          } else {
            console.warn(`  [DW] Validation failed — approve=${approve} disapprove=${disapprove} prevApprove=${prevApprove} (sane=${saneChange})`);
          }
        } else {
          console.warn(`  [DW] CSV missing approve/disapprove columns. Headers: ${headers.join(', ')}`);
        }
      }
    }
  }

  console.warn('  [Trump] Datawrapper primary failed — RSS fallback will run if needed');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONGRESS APPROVAL — Groq + Gallup
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCongressApproval(data) {
  console.log('[4/6] Congress approval (Groq + Gallup)…');

  let html;
  try {
    const res = await safeFetch('https://news.gallup.com/poll/1600/congress-public.aspx', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    });
    html = await res.text();
  } catch (err) {
    console.warn(`  [Gallup] Congress page fetch failed: ${err.message}`);
    return false;
  }

  const text = stripHtml(html).slice(0, 14000);
  const result = await groqExtract(
    'You are a precise data extraction assistant. Extract polling numbers only. Return valid JSON.',
    `From this Gallup page tracking Congressional approval ratings, extract the most recent approve and disapprove percentages.
Return JSON exactly: {"approve": NUMBER, "disapprove": NUMBER}
Numbers should be between 5 and 55 for approve, and 40 and 95 for disapprove.

Page text:
${text}`
  );

  if (result?.approve > 5 && result?.approve < 55 && result?.disapprove > 30 && result?.disapprove < 95) {
    const approve    = parseFloat(Number(result.approve).toFixed(1));
    const disapprove = parseFloat(Number(result.disapprove).toFixed(1));
    const month = monthLabel();

    // Update both congress_approval and approval.congress
    data.congress_approval.combined.approve    = approve;
    data.congress_approval.combined.disapprove = disapprove;
    data.congress_approval.combined.trend      = calcTrend(
      (data.approval.congress?.history || []).concat([{ approve }]), 'approve'
    );

    data.approval.congress.approve    = approve;
    data.approval.congress.disapprove = disapprove;
    upsertHistory(data.approval.congress.history, month,
      { approve, disapprove }, { approve, disapprove });
    data.approval.congress.trend = calcTrend(data.approval.congress.history, 'approve');

    console.log(`  Congress approval: ${approve}% approve / ${disapprove}% disapprove`);
    return true;
  }

  console.warn('  [Congress] Could not extract approval — keeping existing values');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RETIREMENTS — Groq + Ballotpedia
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRetirements(data) {
  console.log('[5/6] Retirements (Ballotpedia — regex + Groq)…');
  const BP_URL = 'https://ballotpedia.org/List_of_U.S._Congress_incumbents_who_are_not_running_for_re-election_in_2026';

  let html;
  try {
    const res = await safeFetch(BP_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    });
    html = await res.text();
  } catch (err) {
    console.warn(`  [Ballotpedia] Fetch failed: ${err.message}`);
    return false;
  }

  // Strip HTML and find the summary paragraph (it appears after the page JS noise)
  const fullText = stripHtml(html);

  // ── Regex-first: Ballotpedia always has a sentence like:
  // "As of [date], 68 voting members of the U.S. Congress — 11 members of the U.S. Senate
  //  and 57 members of the U.S. House of Representatives — are not seeking re-election"
  const summaryMatch = fullText.match(
    /(\d+)\s+voting members of the U\.S\. Congress[^.]*?(\d+)\s+members of the U\.S\. Senate[^.]*?(\d+)\s+members of the U\.S\. House/i
  );

  let total = null, senate = null, house = null;
  if (summaryMatch) {
    total  = parseInt(summaryMatch[1], 10);
    senate = parseInt(summaryMatch[2], 10);
    house  = parseInt(summaryMatch[3], 10);
    console.log(`  [Regex] total=${total} senate=${senate} house=${house}`);
  }

  // ── Groq: extract R/D breakdown and verify/supplement totals
  // Send the key summary paragraphs (skip the first 5k of JS boilerplate)
  const summaryStart = fullText.indexOf('voting members of the U.S. Congress');
  const relevantText = summaryStart > 0
    ? fullText.slice(Math.max(0, summaryStart - 200), summaryStart + 4000)
    : fullText.slice(0, 8000);

  const result = await groqExtract(
    'You are a precise data extraction assistant. Extract congressional retirement counts from Ballotpedia. Return valid JSON with integers only.',
    `From this Ballotpedia summary about US Congress members NOT seeking re-election in 2026, extract the counts.
The text contains sentences like "X Democrats and Y Republicans" for Senate and House separately.
Sum them across all categories (retiring + running for other office) to get total R and total D.

Return JSON: {"total": INTEGER, "republican": INTEGER, "democrat": INTEGER, "house": INTEGER, "senate": INTEGER}

Text:
${relevantText}`
  );

  // Merge regex (more reliable for totals) with Groq (better for R/D split)
  const merged = {
    total:      total  ?? result?.total,
    senate:     senate ?? result?.senate,
    house:      house  ?? result?.house,
    republican: result?.republican || null,
    democrat:   result?.democrat   || null,
  };

  if (merged.total > 20 && merged.total < 250) {
    const prev = data.retirements.total;
    data.retirements.total  = merged.total;
    if (merged.senate > 0 && merged.senate < 100) data.retirements.senate = merged.senate;
    if (merged.house  > 0 && merged.house  < 200) data.retirements.house  = merged.house;
    if (merged.republican > 0 && merged.republican < 200) data.retirements.republican = merged.republican;
    if (merged.democrat   > 0 && merged.democrat   < 200) data.retirements.democrat   = merged.democrat;

    const changed = prev !== merged.total ? ` (was ${prev})` : '';
    console.log(`  Retirements: ${merged.total} total${changed} (R=${merged.republican ?? '?'} D=${merged.democrat ?? '?'} House=${merged.house} Senate=${merged.senate})`);
    return true;
  }

  console.warn(`  [Retirements] Could not extract valid counts: ${JSON.stringify(merged)}`);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. RSS FALLBACK — supplemental signals for any fields not yet updated
// ─────────────────────────────────────────────────────────────────────────────

const RSS_FEEDS = [
  { url: 'https://news.gallup.com/rss/gallup_politics_rss.xml',                                               source: 'Gallup' },
  { url: 'https://www.pewresearch.org/feed/',                                                                   source: 'Pew Research' },
  { url: 'https://yougov.com/en-us/rss',                                                                       source: 'YouGov' },
  { url: 'https://www.realclearpolitics.com/xml/rss.xml',                                                      source: 'RealClearPolitics' },
  { url: 'https://centerforpolitics.org/crystalball/feed/',                                                     source: "Sabato's Crystal Ball" },
  { url: 'https://www.cookpolitical.com/feed',                                                                  source: 'Cook Political Report' },
  { url: 'https://insideelections.com/feed/',                                                                   source: 'Inside Elections' },
  { url: 'https://news.google.com/rss/search?q=Trump+approval+rating+poll+2026&hl=en-US&gl=US&ceid=US:en',     source: 'GNews:Trump',    hints: ['trump'] },
  { url: 'https://news.google.com/rss/search?q=congressional+approval+rating+Gallup+2026&hl=en-US&gl=US&ceid=US:en', source: 'GNews:Congress', hints: ['congress'] },
  { url: 'https://news.google.com/rss/search?q=generic+ballot+2026+Democrats+Republicans&hl=en-US&gl=US&ceid=US:en', source: 'GNews:Ballot',   hints: ['ballot'] },
];

function extractPct(text, keyword, windowChars = 150) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return null;
  const slice = text.slice(Math.max(0, idx - windowChars), idx + windowChars);
  let m = slice.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
  if (m) return parseFloat(m[1]);
  m = slice.match(/(\d{1,3}(?:\.\d{1,2})?)\s+percent\b/i);
  if (m) return parseFloat(m[1]);
  const after = text.slice(idx + keyword.length, idx + keyword.length + 35);
  m = after.match(/\b([2-7]\d(?:\.\d{1,2})?)\b/);
  if (m) return parseFloat(m[1]);
  return null;
}

async function fetchRSSFallback(data, needsTrump, needsCongress) {
  if (!needsTrump && !needsCongress) {
    console.log('[6/6] RSS fallback skipped (all primary sources succeeded)');
    return;
  }
  console.log('[6/6] RSS fallback (supplemental signals)…');

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const accum = { trump: [], congress: [] };

  for (const feed of RSS_FEEDS) {
    let items = [];
    try {
      const res = await fetch(feed.url, { headers: { 'User-Agent': 'DCDossier/2.0' }, timeout: 12000 });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parser.parse(xml);
      const channel = parsed?.rss?.channel || parsed?.feed || {};
      const rawItems = channel.item || channel.entry || [];
      items = (Array.isArray(rawItems) ? rawItems : [rawItems]).map(item => ({
        title: String(item.title || '').replace(/<[^>]+>/g, ''),
        description: String(item.description || item.summary || '').replace(/<[^>]+>/g, '').slice(0, 600),
        hints: feed.hints || [],
        source: feed.source,
      }));
    } catch { continue; }

    for (const item of items) {
      const text  = `${item.title} ${item.description}`;
      const lower = text.toLowerCase();
      const hints = item.hints;

      // Trump approval
      if (needsTrump && (feed.source === 'Gallup' || hints.includes('trump'))
          && lower.includes('trump') && (lower.includes('approv') || lower.includes('disapprov'))) {
        const approve    = extractPct(text, 'approve');
        const disapprove = extractPct(text, 'disapprove');
        if (approve > 25 && approve < 75) accum.trump.push({ approve, disapprove });
      }

      // Congress approval
      if (needsCongress && (feed.source === 'Gallup' || hints.includes('congress'))
          && lower.includes('congress') && lower.includes('approv')) {
        const approve    = extractPct(text, 'approve');
        const disapprove = extractPct(text, 'disapprove');
        if (approve > 5 && approve < 55) accum.congress.push({ approve, disapprove });
      }
    }
  }

  const month = monthLabel();

  if (needsTrump && accum.trump.length >= 2) {
    const vals = accum.trump.map(x => x.approve).sort((a, b) => a - b);
    const med  = vals[Math.floor(vals.length / 2)];
    const disVals = accum.trump.map(x => x.disapprove).filter(x => x > 25 && x < 75).sort((a, b) => a - b);
    const dismed  = disVals.length ? disVals[Math.floor(disVals.length / 2)] : null;
    data.approval.trump.approve    = med;
    if (dismed) data.approval.trump.disapprove = dismed;
    upsertHistory(data.approval.trump.history, month,
      { approve: med, disapprove: dismed || data.approval.trump.disapprove },
      { approve: med, disapprove: data.approval.trump.disapprove });
    data.approval.trump.trend = calcTrend(data.approval.trump.history, 'approve');
    console.log(`  [RSS] Trump approval fallback: ${med}% (${accum.trump.length} signals)`);
  }

  if (needsCongress && accum.congress.length >= 2) {
    const vals = accum.congress.map(x => x.approve).sort((a, b) => a - b);
    const med  = vals[Math.floor(vals.length / 2)];
    data.congress_approval.combined.approve = med;
    data.approval.congress.approve = med;
    upsertHistory(data.approval.congress.history, month,
      { approve: med }, { approve: med, disapprove: data.approval.congress.disapprove });
    data.approval.congress.trend = calcTrend(data.approval.congress.history, 'approve');
    console.log(`  [RSS] Congress approval fallback: ${med}% (${accum.congress.length} signals)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const start = Date.now();
  console.log('════════════════════════════════════════');
  console.log(' fetch-polls.js — live data update');
  console.log(`  Groq key: ${GROQ_KEY ? '✓ set' : '✗ missing (Groq sources will be skipped)'}`);
  console.log('════════════════════════════════════════');

  // Load data.json
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (err) {
    console.error('Fatal: could not read data.json:', err.message);
    process.exit(1);
  }

  // Ensure required sub-trees exist
  data.approval               = data.approval               || {};
  data.approval.trump         = data.approval.trump         || { approve: null, disapprove: null, trend: 0, history: [] };
  data.approval.congress      = data.approval.congress      || { approve: null, disapprove: null, trend: 0, history: [] };
  data.generic_ballot         = data.generic_ballot         || { democrat: null, republican: null, trend_d: 0, trend_r: 0, history: [], pollsters: [] };
  data.congress_approval      = data.congress_approval      || {};
  data.congress_approval.combined = data.congress_approval.combined || { approve: null, disapprove: null, trend: 0 };
  data.cpi                    = data.cpi                    || { history: [] };
  data.state_polls            = data.state_polls            || {};

  // Run all fetchers
  const nytOk     = await fetchNYTPolls(data);
  const cpiOk     = await fetchCPI(data);
  const trumpOk   = await fetchTrumpApproval(data);
  const congressOk= await fetchCongressApproval(data);
  const retireOk  = await fetchRetirements(data);

  // RSS fallback for any primary sources that failed
  await fetchRSSFallback(data, !trumpOk, !congressOk);

  // Stamp last_updated
  data.meta = data.meta || {};
  data.meta.last_updated = new Date().toISOString();

  // Write
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('════════════════════════════════════════');
  console.log(`  Results: NYT=${nytOk?'✓':'✗'}  CPI=${cpiOk?'✓':'✗'}  Trump=${trumpOk?'✓':'✗'}  Congress=${congressOk?'✓':'✗'}  Retirements=${retireOk?'✓':'✗'}`);
  console.log(`  data.json written. Elapsed: ${elapsed}s`);
  console.log('════════════════════════════════════════');
}

main().catch(err => {
  console.error('[fetch-polls] Fatal error:', err);
  process.exit(1);
});
