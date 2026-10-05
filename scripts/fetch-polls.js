#!/usr/bin/env node
'use strict';

/**
 * fetch-polls.js — comprehensive live data updater
 *
 * Sources (in priority order):
 *  1. NYT polling CSVs       → generic_ballot, race_polls    (House/Senate/Governor CSVs)
 *  2. BLS public API         → cpi.history                   (structured JSON)
 *  3. Nate Silver Bulletin   → approval.trump                (Datawrapper CSV direct API)
 *     Chart: datawrapper.dwcdn.net/kSCt4/ — fetches latest version, downloads CSV
 *  4. Gallup                 → congress_approval             (HTML table; AI backup)
 *  5. Wikipedia API          → retirements totals/split      (Ballotpedia fallback)
 *  6. RSS feed fallbacks     → backup only if primary sources fail (regex extraction)
 *
 * Env vars (both optional — every source has a non-AI path; see ai.js):
 *  GROQ_API_KEY      — Groq API key
 *  ANTHROPIC_API_KEY — Anthropic API key (used if Groq fails)
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');

const { aiExtract, aiStatus } = require('./ai');
const { recordStatus, saveStatus } = require('./status');

const DATA_PATH  = path.resolve(__dirname, '../data.json');

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
    .replace(/[ \t]+/g, ' ')
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

// Fetches a URL, reads the body and logs status and size for every source.
// Treats non-2xx, 202 (often a bot challenge) and bodies under opts.minBytes as
// failures. Returns a minimal response with text() and json().
// Warnings double as the error message recorded in status.json for a source.
let lastWarning = null;
function warn(msg) {
  console.warn(msg);
  lastWarning = String(msg).trim();
}

// Runs one primary fetcher and records the outcome in status.json. Fetchers
// return the number of items they got (0/false on failure).
async function track(name, fn, data) {
  lastWarning = null;
  let result = 0, error = null;
  try { result = await fn(data); }
  catch (err) { error = err.message; warn(`  [${name}] ${err.message}`); }
  const ok = typeof result === 'number' && result > 0;
  recordStatus(name, { group: 'polls', primary: true, ok, count: ok ? result : 0, error: ok ? null : (error || lastWarning) });
  return ok;
}

async function safeFetch(url, opts = {}) {
  const u = new URL(url);
  const { label = u.hostname + u.pathname.replace(/^.*\//, '/'), minBytes = 0, headers, ...rest } = opts;
  const res = await fetch(url, {
    headers: headers || { 'User-Agent': 'DCDossier/2.0 (+https://github.com/dcdossier/Generational-Mid-terms)' },
    timeout: 25000,
    ...rest,
  });
  const body = await res.text();
  const bytes = Buffer.byteLength(body);
  console.log(`  [fetch] ${label}: HTTP ${res.status}, ${bytes} bytes`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 202) throw new Error('HTTP 202 (likely a bot challenge)');
  if (bytes < minBytes) throw new Error(`body ${bytes} bytes, under ${minBytes} — likely a bot challenge or empty page`);
  return { status: res.status, text: async () => body, json: async () => JSON.parse(body) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NYT POLLING CSVs → generic_ballot (+ pollster table) and race_polls
// ─────────────────────────────────────────────────────────────────────────────
//
// One CSV row is one candidate's share in one question of one poll. A poll can
// ask several questions about the same race (likely vs registered voters,
// ranked-choice rounds); pickQuestion() keeps one per poll per race.

const NYT_CSVS = {
  House:    'https://www.nytimes.com/newsgraphics/polls/house.csv',
  Senate:   'https://www.nytimes.com/newsgraphics/polls/senate.csv',
  Governor: 'https://www.nytimes.com/newsgraphics/polls/governor.csv',
};
const NYT_SOURCE = 'New York Times polling averages data (nytimes.com/newsgraphics/polls)';
const AT_LARGE_STATES = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
const POPULATION_RANK = { lv: 0, rv: 1, v: 2 };   // 'a' (all adults) is not used
const MAJOR_PARTIES = new Set(['DEM', 'REP']);
const DAY_MS = 24 * 60 * 60 * 1000;

// "9/28/26" → Date at UTC midnight
function parseNytDate(s) {
  const p = String(s || '').split('/');
  if (p.length !== 3) return null;
  const d = new Date(Date.UTC(2000 + parseInt(p[2], 10), parseInt(p[0], 10) - 1, parseInt(p[1], 10)));
  return isNaN(d) ? null : d;
}
const isoDay = d => d.toISOString().slice(0, 10);

// Canonical seat IDs: "AZ-01", "AK-AL", "Senate-TX", "Gov-TX"
function canonicalSeatId(office, state, seatNumber) {
  if (office === 'Senate') return `Senate-${state}`;
  if (office === 'Governor') return `Gov-${state}`;
  if (AT_LARGE_STATES.has(state)) return `${state}-AL`;
  const n = parseInt(seatNumber, 10);
  return Number.isFinite(n) && n > 0 ? `${state}-${String(n).padStart(2, '0')}` : null;
}

// Reads the three CSVs into questions: { office, raceKey, pollId, pollster, …, answers: [] }
async function loadNytQuestions() {
  const questions = new Map();
  for (const [office, url] of Object.entries(NYT_CSVS)) {
    let text;
    try { text = await (await safeFetch(url)).text(); }
    catch (err) { warn(`  [NYT] ${office} CSV fetch failed: ${err.message}`); continue; }
    const { idx, rows } = parseCSV(text);
    for (const line of rows) {
      const f = parseCSVRow(line);
      const get = k => (f[idx[k]] || '').replace(/"/g, '').trim();
      if (get('cycle') !== '2026' || get('stage') !== 'general') continue;
      if (get('hypothetical') === 'true' || !(get('population') in POPULATION_RANK)) continue;
      const end = parseNytDate(get('end_date'));
      if (!end) continue;
      const qKey = `${office}|${get('question_id')}|${get('ranked_choice_round')}`;
      if (!questions.has(qKey)) {
        questions.set(qKey, {
          office,
          state: get('state'),
          seatNumber: get('seat_number'),
          raceKey: `${office}|${get('race_id')}`,
          pollId: get('poll_id'),
          pollster: get('display_name') || get('pollster'),
          sponsors: get('sponsors'),
          start: parseNytDate(get('start_date')),
          end,
          sample: parseInt(get('sample_size'), 10) || null,
          population: get('population'),
          partisan: get('partisan'),
          internal: get('internal') === 'true',
          rcvRound: parseInt(get('ranked_choice_round'), 10) || 0,
          answers: [],
        });
      }
      const pct = parseFloat(get('pct'));
      if (Number.isFinite(pct)) questions.get(qKey).answers.push({ name: get('candidate_name') || get('answer'), party: get('party'), pct });
    }
  }
  return [...questions.values()];
}

// One question per poll per race: likely voters first, then registered, then
// all voters; first-round results where a poll reports ranked-choice rounds.
function pickQuestion(qs) {
  return qs.slice().sort((a, b) =>
    (POPULATION_RANK[a.population] - POPULATION_RANK[b.population]) ||
    ((a.rcvRound || 1) - (b.rcvRound || 1)) ||
    (b.answers.length - a.answers.length))[0];
}

function toPollEntry(q) {
  const byPct = q.answers.slice().sort((a, b) => b.pct - a.pct);
  const top = party => byPct.find(a => a.party === party) || null;
  const dem = top('DEM'), rep = top('REP');
  return {
    pollster: q.pollster,
    sponsors: q.sponsors || null,
    start: q.start ? isoDay(q.start) : null,
    end: isoDay(q.end),
    sample: q.sample,
    population: q.population,
    partisan: q.partisan || null,
    dem: dem ? { name: dem.name, pct: dem.pct } : null,
    rep: rep ? { name: rep.name, pct: rep.pct } : null,
    others: byPct.filter(a => a !== dem && a !== rep && a.party !== 'NONE').map(a => ({ name: a.name, party: a.party, pct: a.pct })),
  };
}

// Nominee surnames per canonical seat ID from assets/briefs.json, used to drop
// polls of matchups that won't be on the ballot (pre-primary or hypothetical
// pairings, which the CSV doesn't always flag). Seats without a brief keep all polls.
const fold = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function surnameKey(name) {
  const words = String(name || '').replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(w => !/^(jr|sr|ii|iii|iv)\.?$/i.test(w));
  return fold(words[words.length - 1]);
}
function loadNominees() {
  try {
    const briefs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../assets/briefs.json'), 'utf8'));
    const out = {};
    for (const [id, b] of Object.entries(briefs)) {
      const names = [b.dem, b.rep].filter(Boolean).join(' / ').replace(/\([^)]*\)/g, ' ').split(/[\/;,]/).map(s => s.trim()).filter(Boolean);
      if (names.length) out[id] = new Set(names.map(surnameKey));
    }
    return out;
  } catch (err) {
    warn(`  [NYT] Could not read assets/briefs.json for nominee filter: ${err.message}`);
    return {};
  }
}
function isNomineeMatchup(entry, nominees) {
  const names = [entry.dem, entry.rep].filter(Boolean).map(c => c.name);
  if (names.some(n => /\bgeneric\b/i.test(n))) return false;
  if (!nominees) return true;
  return names.length > 0 && names.every(n => nominees.has(surnameKey(n)));
}

// Sample-weighted (capped at 3,000) D and R average of the given poll entries
function weightedAverage(entries) {
  let tw = 0, wd = 0, wr = 0;
  for (const p of entries) {
    const w = Math.min(p.sample || 1000, 3000);
    tw += w; wd += p.dem.pct * w; wr += p.rep.pct * w;
  }
  if (!tw) return null;
  const dem = +(wd / tw).toFixed(1), rep = +(wr / tw).toFixed(1);
  return { dem, rep, margin: +(dem - rep).toFixed(1), n_polls: entries.length };
}

async function fetchNYTPolls(data) {
  console.log('[1/6] NYT Polling CSVs…');
  const fetched = new Date().toISOString();
  const questions = await loadNytQuestions();
  if (!questions.length) { warn('  [NYT] No usable poll questions in the CSVs'); return false; }

  // Group: race → poll → questions, then keep one question per poll
  const races = new Map();
  for (const q of questions) {
    if (!races.has(q.raceKey)) races.set(q.raceKey, new Map());
    const polls = races.get(q.raceKey);
    if (!polls.has(q.pollId)) polls.set(q.pollId, []);
    polls.get(q.pollId).push(q);
  }

  // ── National generic ballot (House CSV, state "US") ────────────────────────
  const national = [];
  const racePolls = {};
  const nominees = loadNominees();
  let droppedMatchups = 0;
  const now = Date.now();
  for (const polls of races.values()) {
    const picked = [...polls.values()].map(pickQuestion).sort((a, b) => b.end - a.end);
    const first = picked[0];
    if (first.office === 'House' && first.state === 'US') { national.push(...picked); continue; }

    const id = canonicalSeatId(first.office, first.state, first.seatNumber);
    if (!id) continue;
    const all = picked.map(toPollEntry);
    const entries = all.filter(e => isNomineeMatchup(e, nominees[id]));
    droppedMatchups += all.length - entries.length;
    if (!entries.length) continue;
    const recent = entries.filter(p => p.dem && p.rep && !p.partisan && now - Date.parse(p.end) <= 30 * DAY_MS);
    const race = {
      office: first.office,
      state: first.state,
      source: NYT_SOURCE,
      as_of: entries[0].end,
      fetched,
      n_polls: entries.length,
      latest: entries.slice(0, 5),
      average_30d: recent.length ? { ...weightedAverage(recent), window_days: 30 } : null,
    };
    // Two races can share a seat ID (e.g. a special election); keep the one polled most recently
    if (!racePolls[id] || racePolls[id].as_of < race.as_of) racePolls[id] = race;
  }

  const nationalEntries = national
    .map(toPollEntry)
    .filter(p => p.dem && p.rep && !p.partisan)
    .sort((a, b) => b.end.localeCompare(a.end));
  const last60 = nationalEntries.filter(p => now - Date.parse(p.end) <= 60 * DAY_MS);
  if (last60.length >= 3) {
    const avg = weightedAverage(last60);
    const prevD = data.generic_ballot.democrat;
    const prevR = data.generic_ballot.republican;
    data.generic_ballot.democrat   = avg.dem;
    data.generic_ballot.republican = avg.rep;
    data.generic_ballot.undecided  = +(100 - avg.dem - avg.rep).toFixed(1);
    if (prevD != null) data.generic_ballot.trend_d = +(avg.dem - prevD).toFixed(1);
    if (prevR != null) data.generic_ballot.trend_r = +(avg.rep - prevR).toFixed(1);
    upsertHistory(data.generic_ballot.history, monthLabel(new Date(nationalEntries[0].end)),
      { democrat: avg.dem, republican: avg.rep }, { democrat: avg.dem, republican: avg.rep });

    // Pollster table: the 10 most recent national polls, latest one per pollster
    const seenPollsters = new Set();
    data.generic_ballot.pollsters = nationalEntries.filter(p => {
      if (seenPollsters.has(p.pollster)) return false;
      seenPollsters.add(p.pollster);
      return true;
    }).slice(0, 10).map(p => ({
      name: p.sponsors ? `${p.pollster} (${p.sponsors})` : p.pollster,
      democrat: p.dem.pct,
      republican: p.rep.pct,
      date: new Date(p.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      start: p.start,
      end: p.end,
      sample: p.sample,
      population: p.population,
    }));
    data.generic_ballot.source  = NYT_SOURCE;
    data.generic_ballot.as_of   = nationalEntries[0].end;
    data.generic_ballot.fetched = fetched;
    console.log(`  Generic ballot: D=${avg.dem}% R=${avg.rep}% (${last60.length} polls, 60-day weighted avg); pollster table: ${data.generic_ballot.pollsters.length} pollsters`);
  } else {
    warn(`  [NYT] Only ${last60.length} national polls in 60 days — generic ballot left unchanged`);
  }

  // ── Race polls ─────────────────────────────────────────────────────────────
  const ids = Object.keys(racePolls).sort();
  const asOf = ids.map(id => racePolls[id].as_of).sort().pop() || null;
  data.race_polls = {
    source: NYT_SOURCE,
    as_of: asOf,
    fetched,
    races: Object.fromEntries(ids.map(id => [id, racePolls[id]])),
  };
  delete data.state_polls; // replaced by race_polls
  const byOffice = o => ids.filter(id => racePolls[id].office === o).length;
  console.log(`  Race polls: ${ids.length} races (House ${byOffice('House')}, Senate ${byOffice('Senate')}, Governor ${byOffice('Governor')}), latest poll ${asOf}; ${droppedMatchups} polls of non-nominee matchups dropped`);

  return questions.length;
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
    // BLS lists newest first; period "M08" → as_of "2026-08"
    const newest = series.find(s => /^M(0[1-9]|1[0-2])$/.test(s.period));
    data.cpi.source  = 'US Bureau of Labor Statistics, CPI-U all items (CUUR0000SA0)';
    data.cpi.as_of   = newest ? `${newest.year}-${newest.period.slice(1)}` : null;
    data.cpi.fetched = new Date().toISOString();

    console.log(`  CPI: ${latest?.all_items}% YoY (${latest?.month}), ${merged.length} months history`);
    return merged.length;
  } catch (err) {
    warn(`  [BLS] CPI fetch failed: ${err.message}`);
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
    warn(`  [DW] Version discovery failed: ${err.message}`);
  }

  if (!latestVersion) {
    warn('  [DW] Could not determine chart version — skipping Datawrapper');
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
      warn(`  [DW] CSV fetch failed: ${err.message}`);
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
            const dataDate = new Date(modelDate);   // "10/5/2026"
            const month = monthLabel(isNaN(dataDate) ? new Date() : dataDate);

            data.approval.trump.approve    = approve;
            data.approval.trump.disapprove = disapprove;
            data.approval.trump.net        = net;
            data.approval.trump.source     = 'Nate Silver Bulletin';
            data.approval.trump.as_of      = isNaN(dataDate) ? null : `${dataDate.getFullYear()}-${String(dataDate.getMonth() + 1).padStart(2, '0')}-${String(dataDate.getDate()).padStart(2, '0')}`;
            data.approval.trump.fetched    = new Date().toISOString();
            upsertHistory(data.approval.trump.history, month,
              { approve, disapprove, net }, { approve, disapprove, net });
            data.approval.trump.trend = calcTrend(data.approval.trump.history, 'approve');

            console.log(`  ✓ Trump approval [Nate Silver/${DW_APPROVAL_CHART} v${latestVersion}] as of ${modelDate}: ${approve}% / ${disapprove}% / net ${net >= 0 ? '+' : ''}${net}`);
            return lines.length - 1;
          } else {
            warn(`  [DW] Validation failed — approve=${approve} disapprove=${disapprove} prevApprove=${prevApprove} (sane=${saneChange})`);
          }
        } else {
          warn(`  [DW] CSV missing approve/disapprove columns. Headers: ${headers.join(', ')}`);
        }
      }
    }
  }

  warn('  [Trump] Datawrapper primary failed — RSS fallback will run if needed');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONGRESS APPROVAL — Gallup table, AI as backup
// ─────────────────────────────────────────────────────────────────────────────

// Reads the newest row of Gallup's "Congress Approval Table" (overall
// approval of Congress), e.g. "2026 Sep 1-17 | 16 | 79 | 4". The page has
// other Approve/Disapprove tables (Republicans/Democrats in Congress, leaders,
// own member) whose newest rows can be years old, so only the table with that
// caption is used. If the page has no captions at all, the first table with
// Approve/Disapprove headers is used instead.
function parseGallupApprovalTable(html) {
  const cellText = c => stripHtml(c).replace(/\s+/g, ' ').trim();
  const found = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const caption = cellText((table.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i) || [])[1] || '');
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || [])
      .map(r => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(cellText));
    const headerIdx = rows.findIndex(r => r.some(c => /^approve$/i.test(c)) && r.some(c => /^disapprove$/i.test(c)));
    if (headerIdx === -1) continue;
    const aCol = rows[headerIdx].findIndex(c => /^approve$/i.test(c));
    const dCol = rows[headerIdx].findIndex(c => /^disapprove$/i.test(c));
    for (const row of rows.slice(headerIdx + 1)) {
      const approve    = parseFloat(row[aCol]);
      const disapprove = parseFloat(row[dCol]);
      if (!isNaN(approve) && !isNaN(disapprove)) { found.push({ approve, disapprove, period: row[0] || '', caption }); break; }
    }
  }
  const main = found.find(r => /congress approval table/i.test(r.caption));
  if (main) return main;
  if (found.length && found.every(r => !r.caption)) return found[0];
  return null;
}

// A reading counts only if its field period ended within the last 120 days
const GALLUP_MAX_AGE_DAYS = 120;

// Gallup field period → reading month and end date (UTC):
//   "2026 Sep 1-17"        → { month: 'Sep 2026', end: '2026-09-17' }
//   "2026 Aug 25-Sep 7"    → { month: 'Aug 2026', end: '2026-09-07' }
//   "2025 Dec 29-2026 Jan 9" → { month: 'Dec 2025', end: '2026-01-09' }
function parseGallupPeriod(period) {
  const m = String(period || '').match(/^(\d{4}) ([A-Z][a-z]{2})\w* (\d{1,2})\s*[-–]\s*(?:(\d{4}) )?(?:([A-Z][a-z]{2})\w* )?(\d{1,2})$/);
  if (!m) return null;
  const [, y1, mon1, , y2, mon2, d2] = m;
  const start = new Date(`${mon1} 1, ${y1} UTC`);
  const end = new Date(`${mon2 || mon1} ${d2}, ${y2 || y1} UTC`);
  if (isNaN(start) || isNaN(end)) return null;
  return { month: monthLabel(new Date(start.getTime() + 12 * 3600e3)), end: end.toISOString().slice(0, 10) };
}

async function fetchCongressApproval(data) {
  console.log('[4/6] Congress approval (Gallup table, AI backup)…');

  let html;
  try {
    const res = await safeFetch('https://news.gallup.com/poll/1600/congress-public.aspx', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    });
    html = await res.text();
  } catch (err) {
    warn(`  [Gallup] Congress page fetch failed: ${err.message}`);
    return false;
  }

  const isFresh = r => {
    const p = r && parseGallupPeriod(r.period);
    return !!p && Date.now() - Date.parse(p.end) <= GALLUP_MAX_AGE_DAYS * 24 * 3600e3;
  };
  let result = parseGallupApprovalTable(html);
  if (result && !isFresh(result)) {
    warn(`  [Gallup] Table's newest row is "${result.period}" — older than ${GALLUP_MAX_AGE_DAYS} days or unreadable; ignoring it`);
    result = null;
  }
  if (result) {
    console.log(`  [Gallup] Parsed "${result.caption || 'table'}" row "${result.period}": ${result.approve} / ${result.disapprove}`);
  } else {
    warn('  [Gallup] Congress Approval Table not found — trying AI backup');
    const text = stripHtml(html).slice(0, 14000);
    result = await aiExtract(
      'You are a precise data extraction assistant. Extract polling numbers only. Return valid JSON.',
      `From this Gallup page tracking Congressional approval ratings, extract the most recent approve and disapprove percentages.
Return JSON exactly: {"approve": NUMBER, "disapprove": NUMBER, "period": "YYYY Mon D-D"}
Numbers should be between 5 and 55 for approve, and 40 and 95 for disapprove.
"period" is the survey's field dates as Gallup writes them, e.g. "2026 Sep 1-17".

Page text:
${text}`,
      { label: 'Congress approval' }
    );
    if (result && !isFresh(result)) {
      warn(`  [Gallup] AI reading "${result.period}" is older than ${GALLUP_MAX_AGE_DAYS} days or has no readable period — not used`);
      result = null;
    }
  }

  if (result?.approve > 5 && result?.approve < 55 && result?.disapprove > 30 && result?.disapprove < 95) {
    const approve    = parseFloat(Number(result.approve).toFixed(1));
    const disapprove = parseFloat(Number(result.disapprove).toFixed(1));
    const reading = parseGallupPeriod(result.period);
    if (!reading) warn(`  [Gallup] Could not read the field period "${result.period}" — history not updated`);
    const provenance = {
      source: 'Gallup, Congress and the Public (news.gallup.com/poll/1600)',
      as_of: reading ? reading.end : null,
      period: result.period || null,
      fetched: new Date().toISOString(),
    };

    // Update both congress_approval and approval.congress
    data.congress_approval.combined.approve    = approve;
    data.congress_approval.combined.disapprove = disapprove;
    data.congress_approval.combined.trend      = calcTrend(
      (data.approval.congress?.history || []).concat([{ approve }]), 'approve'
    );
    Object.assign(data.congress_approval.combined, provenance);

    data.approval.congress.approve    = approve;
    data.approval.congress.disapprove = disapprove;
    Object.assign(data.approval.congress, provenance);
    if (reading) {
      upsertHistory(data.approval.congress.history, reading.month,
        { approve, disapprove }, { approve, disapprove });
    }
    data.approval.congress.trend = calcTrend(data.approval.congress.history, 'approve');

    console.log(`  Congress approval: ${approve}% approve / ${disapprove}% disapprove (field period ${result.period || 'unknown'}, recorded as ${reading ? reading.month : '—'})`);
    return 1;
  }

  warn('  [Congress] Could not extract approval — keeping existing values');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RETIREMENTS — Wikipedia API (Ballotpedia fallback), no AI
// ─────────────────────────────────────────────────────────────────────────────
//
// Primary: the "Retirements" sections of Wikipedia's 2026 House and Senate
// election pages, read through the MediaWiki API and counted per chamber.
// Wikipedia's Senate table doesn't say who is running for another office, so
// the Senate retiring/other-office split is null when Wikipedia is the source.
//
// Fallback: Ballotpedia's page has one table per category ("Retiring from public office,
// 2026", "Running for governor, 2026", …) under a Senate and a House heading.
// Every row is one member, so chamber, party and retiring-vs-other-office are
// counted directly from the rows. Ballotpedia counts voting members only and
// excludes senators not up in 2026 who are running for another office.

const BP_RETIRE_URL = 'https://ballotpedia.org/List_of_U.S._Congress_incumbents_who_are_not_running_for_re-election_in_2026';
const WIKI_API = 'https://en.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2';

function partyKey(text) {
  if (/republican/i.test(text)) return 'republican';
  if (/democrat|\bDFL\b/i.test(text)) return 'democrat';
  return 'others';
}

function emptyCounts() {
  return { total: 0, senate: 0, house: 0, republican: 0, democrat: 0, others: 0,
           senate_retiring: 0, senate_other_office: 0, house_retiring: 0, house_other_office: 0 };
}

// "Oct. 2, 2026" / "Sept. 30, 2026" → Date at UTC midnight (no timezone drift)
function parseUtcDate(text) {
  return new Date(text.replace('.', '').replace(/^Sept\b/, 'Sep') + ' UTC');
}

function parseBallotpediaRetirements(html) {
  const cell = c => stripHtml(c).replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
  const counts = emptyCounts();
  const tableRe = /<table[^>]*>[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const table = m[0];
    const caption = cell((table.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i) || [])[1] || '');
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || [])
      .map(r => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(cell));
    // Only the "not seeking re-election" lists: Name | Party | Seat | Date announced
    if (!rows.length || rows[0].join('|') !== 'Name|Party|Seat|Date announced') continue;
    const retiring = /retiring from public office/i.test(caption);
    for (const row of rows.slice(1)) {
      if (row.length < 3 || !row[0]) continue;
      const chamber = /congressional district/i.test(row[2]) ? 'house' : 'senate';
      counts.total++;
      counts[chamber]++;
      counts[partyKey(row[1])]++;
      counts[`${chamber}_${retiring ? 'retiring' : 'other_office'}`]++;
    }
  }
  // Cross-check against the page's own summary sentence
  const text = stripHtml(html);
  const summary = text.match(/As of ([A-Z][a-z]+\.? \d{1,2}, \d{4}), (\d+) voting members of the U\.S\. Congress[^.]*?(\d+) members of the U\.S\. Senate[^.]*?(\d+) members of the U\.S\. House/i);
  return {
    counts,
    asOf: summary ? parseUtcDate(summary[1]) : null,
    summary: summary ? { total: +summary[2], senate: +summary[3], house: +summary[4] } : null,
  };
}

// Wikipedia fallback: House "Retirements" lists ({{ushr|ST|N|X}} lines under
// ===Democratic=== / ===Republican===) and the Senate "Retirements" table
// ({{Party shading/…}} cells). Non-voting delegates are excluded.
async function fetchWikipediaRetirements() {
  const wikitext = async (page, sectionName) => {
    const sections = await (await safeFetch(`${WIKI_API.replace('prop=wikitext', 'prop=sections')}&page=${page}`, { label: `Wikipedia ${page} sections` })).json();
    const sec = (sections.parse?.sections || []).find(s => s.line.trim().toLowerCase() === sectionName);
    if (!sec) throw new Error(`No "${sectionName}" section on ${page}`);
    const res = await safeFetch(`${WIKI_API}&page=${page}&section=${sec.index}`, { label: `Wikipedia ${page} §${sec.index}` });
    return (await res.json()).parse?.wikitext || '';
  };
  const counts = emptyCounts();

  const house = await wikitext('2026_United_States_House_of_Representatives_elections', 'retirements');
  let party = null;
  for (const line of house.split('\n')) {
    const heading = line.match(/^===\s*(Democratic|Republican|[^=]+?)\s*===/);
    if (heading) { party = heading[1]; continue; }
    const seat = line.match(/^#\s*\{\{ushr\|([A-Z]{2})\|/);
    if (!seat || !party || /^Summary$/i.test(party)) continue;
    if (['DC', 'PR', 'GU', 'VI', 'AS', 'MP'].includes(seat[1])) continue; // delegates
    counts.total++; counts.house++;
    counts[partyKey(party)]++;
    counts[/retiring to .*run for|to run for/i.test(line) ? 'house_other_office' : 'house_retiring']++;
  }

  const senate = await wikitext('2026_United_States_Senate_elections', 'retirements');
  for (const shading of senate.match(/\{\{Party shading\/[^}]+\}\}/g) || []) {
    counts.total++; counts.senate++;
    counts[partyKey(shading)]++;
  }
  // The Senate table doesn't say who is running for another office
  counts.senate_retiring = null;
  counts.senate_other_office = null;

  // as_of: the later of the two pages' last edits — the date of the data itself
  const revs = await (await safeFetch(
    'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=timestamp&format=json&formatversion=2' +
    '&titles=2026_United_States_House_of_Representatives_elections|2026_United_States_Senate_elections',
    { label: 'Wikipedia revision dates' })).json();
  const stamps = (revs.query?.pages || []).map(p => p.revisions?.[0]?.timestamp).filter(Boolean).sort();
  return { counts, asOf: stamps.length ? new Date(stamps[stamps.length - 1]) : null };
}

function retirementsAddUp(c) {
  return c.total > 20 && c.total < 250
    && c.senate + c.house === c.total
    && c.republican + c.democrat + c.others === c.total;
}

async function fetchRetirements(data) {
  console.log('[5/6] Retirements (Wikipedia election pages, Ballotpedia fallback)…');
  let counts = null, source = null, asOf = null;

  // Primary: Wikipedia API — House and Senate "Retirements" sections, counted separately
  try {
    const wiki = await fetchWikipediaRetirements();
    const c = wiki.counts;
    console.log(`  [Wikipedia] Counted: total=${c.total} senate=${c.senate} house=${c.house} R=${c.republican} D=${c.democrat} other=${c.others}`);
    const ok = retirementsAddUp(c);
    if (ok) { counts = c; source = 'Wikipedia'; asOf = wiki.asOf; }
    else warn(`  [Wikipedia] Counts don't add up: ${JSON.stringify(c)} — trying Ballotpedia`);
    recordStatus('Retirements (Wikipedia)', { group: 'polls', primary: true, ok, count: ok ? c.total : 0, error: ok ? null : 'Counts did not add up' });
  } catch (err) {
    warn(`  [Wikipedia] Failed: ${err.message} — trying Ballotpedia`);
    recordStatus('Retirements (Wikipedia)', { group: 'polls', primary: true, ok: false, error: err.message });
  }

  // Fallback: Ballotpedia list tables, cross-checked against its summary sentence
  if (!counts) {
    lastWarning = null;
    let bpError = null, bpCount = 0;
    try {
      const res = await safeFetch(BP_RETIRE_URL, {
        label: 'Ballotpedia',
        minBytes: 50 * 1024, // smaller means a bot challenge or an empty page
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
      });
      const parsed = parseBallotpediaRetirements(await res.text());
      const c = parsed.counts, s = parsed.summary;
      console.log(`  [Ballotpedia] Table rows: total=${c.total} senate=${c.senate} house=${c.house} R=${c.republican} D=${c.democrat} other=${c.others}`);
      if (s && s.total === c.total && s.senate === c.senate && s.house === c.house && retirementsAddUp(c)) {
        counts = c; source = 'Ballotpedia'; asOf = parsed.asOf; bpCount = c.total;
      } else {
        bpError = s ? `Table counts disagree with summary (total=${s.total} senate=${s.senate} house=${s.house})` : 'Summary sentence not found';
        warn(`  [Ballotpedia] ${bpError}`);
      }
    } catch (err) {
      bpError = err.message;
      warn(`  [Ballotpedia] Failed: ${err.message}`);
    }
    recordStatus('Retirements (Ballotpedia fallback)', { group: 'polls', ok: bpCount > 0, count: bpCount, error: bpError });
  }

  if (!counts || !retirementsAddUp(counts)) {
    if (counts) warn(`  [Retirements] Counts don't add up — keeping old values: ${JSON.stringify(counts)}`);
    else warn('  [Retirements] No source succeeded — keeping old values');
    return 0;
  }

  const r = data.retirements = data.retirements || {};
  const prev = r.total;
  Object.assign(r, counts);
  const otherOffice = (counts.senate_other_office ?? 0) + counts.house_other_office;
  if (counts.senate_other_office !== null) r.seeking_office_pct = Math.round(100 * otherOffice / counts.total);
  r.source = source;
  r.source_url = source === 'Ballotpedia' ? BP_RETIRE_URL : 'https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_elections#Retirements';
  r.as_of = asOf && !isNaN(asOf) ? asOf.toISOString().slice(0, 10) : null;
  r.fetched = new Date().toISOString();
  // Keep the 2026 bar of the historical chart in step with the live counts
  const bar2026 = (r.historical_chart || []).find(d => d.year === '2026');
  if (bar2026) { bar2026.house = counts.house; bar2026.senate = counts.senate; }

  const changed = prev !== counts.total ? ` (was ${prev})` : '';
  console.log(`  Retirements [${source}, as of ${r.as_of}]: ${counts.total} total${changed} — Senate ${counts.senate}, House ${counts.house}; R ${counts.republican}, D ${counts.democrat}, other ${counts.others}`);
  return counts.total;
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
      const res = await safeFetch(feed.url, { label: `RSS ${feed.source}`, headers: { 'User-Agent': 'DCDossier/2.0' }, timeout: 12000 });
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
      recordStatus(`RSS fallback: ${feed.source}`, { group: 'polls', ok: true, count: items.length });
    } catch (err) {
      warn(`  [RSS] ${feed.source}: ${err.message}`);
      recordStatus(`RSS fallback: ${feed.source}`, { group: 'polls', ok: false, error: err.message });
      continue;
    }

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
    Object.assign(data.approval.trump, { source: 'RSS fallback (median of headline figures)', as_of: null, fetched: new Date().toISOString() });
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
    const rssProvenance = { source: 'RSS fallback (median of headline figures)', as_of: null, period: null, fetched: new Date().toISOString() };
    Object.assign(data.congress_approval.combined, rssProvenance);
    Object.assign(data.approval.congress, rssProvenance);
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
  console.log(`  AI keys: ${aiStatus()} (AI is optional)`);
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

  // Run all fetchers
  const nytOk     = await track('NYT polling CSVs', fetchNYTPolls, data);
  const cpiOk     = await track('BLS CPI', fetchCPI, data);
  const trumpOk   = await track('Trump approval (Datawrapper)', fetchTrumpApproval, data);
  const congressOk= await track('Congress approval (Gallup)', fetchCongressApproval, data);
  const retireOk  = (await fetchRetirements(data)) > 0; // records its own status

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
  saveStatus();
  process.exit(0);
}

main().catch(err => {
  console.error('[fetch-polls] Fatal error:', err);
  saveStatus();
  process.exit(1);
});
