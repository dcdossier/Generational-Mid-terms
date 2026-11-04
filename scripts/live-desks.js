#!/usr/bin/env node
/*
 * Three decision desks for the live results: Fox News, AP and NBC News.
 * Runs after scripts/live-from-fox.js in the live loop and adds to assets/live.json:
 *   races[id].desks      { fox, ap, nbc }  party each desk has called ('D' | 'R' | 'I' | null)
 *   races[id].consensus  party when at least two desks call the same winner, else null
 *   desks                per desk: ok, updated, and called seats per chamber
 *   consensus_rule       plain-English rule shown on the site
 *
 * Sources (public JSON behind each outlet's own results pages)
 *   AP: interactives.apelections.org/election-results/data-live/2026-11-03/results/national/
 *       (metadata.json + progress.json; the feed behind apnews.com/live/midterm-election-2026
 *       and the results embeds on Politico's live page, so Politico shows AP calls).
 *   NBC News: nbcnews.com/firecracker/api/v2/national-results/2026-elections/{senate,house,governor}-results
 *       (per race for Senate and Governor; House calls per state, so House counts at chamber level).
 *
 * Rule: a race counts as won when two of the three desks call it for the same party.
 * House races are matched per race between Fox and AP; NBC House calls come per state, so a
 * Fox and AP call also stands when NBC's state count for that party leaves room for it.
 * Uncontested House races (one candidate; AP does not tabulate them) go to that candidate.
 * A desk that fails keeps its last good calls. Never throws; exits 0.
 *
 *   node scripts/live-desks.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LIVE = path.resolve(__dirname, '../assets/live.json');
const AP_BASE = 'https://interactives.apelections.org/election-results/data-live/2026-11-03/results/national/';
const NBC_BASE = 'https://www.nbcnews.com/firecracker/api/v2/national-results/2026-elections/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
const PARTY = p => { p = String(p || '').toLowerCase(); return /^(dem|d|dfl)$/.test(p) ? 'D' : /^(gop|rep|r)$/.test(p) ? 'R' : p ? 'I' : null; };

// Browser-like headers per desk: the feeds refuse bare requests from data-centre addresses.
const SITE = {
  ap: { Referer: 'https://apnews.com/', Origin: 'https://apnews.com' },
  nbc: { Referer: 'https://www.nbcnews.com/politics/2026-elections/senate-results', Origin: 'https://www.nbcnews.com' },
};
const RETRIES = 3, RETRY_MS = 5000, TIMEOUT_MS = 20000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One try plus up to 3 retries, 5 seconds apart; the last error is thrown.
async function getJson(url, site) {
  const headers = Object.assign({ 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-GB,en;q=0.9', 'Cache-Control': 'no-cache' }, SITE[site] || {});
  let err;
  for (let i = 0; i <= RETRIES; i++) {
    if (i) { console.warn(`[desks] ${site.toUpperCase()} retry ${i}/${RETRIES} after: ${err.message}`); await sleep(RETRY_MS); }
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
      return await res.json();
    } catch (e) { err = e; }
  }
  throw err;
}

// AP: { calls: {seatId: party}, tabulated: Set of seat ids, updated }
function parseAP(meta, prog) {
  const calls = {}, tabulated = new Set(); let updated = null;
  Object.keys(meta).forEach(rid => {
    const m = meta[rid], o = m.officeID, st = m.statePostal;
    if (!['H', 'S', 'G'].includes(o) || !st) return;
    let id;
    if (o === 'S') id = 'Senate-' + st;
    else if (o === 'G') id = 'Gov-' + st;
    else { const n = Number(m.seatNum); id = AT_LARGE.has(st) || !n ? st + '-AL' : st + '-' + String(n).padStart(2, '0'); }
    tabulated.add(id);
    const p = prog[rid]; if (!p) return;
    if (p.lastUpdated && (!updated || p.lastUpdated > updated)) updated = p.lastUpdated;
    const w = (p.candidates || []).find(c => c.winner === 'X' || c.winner === true);
    if (w && m.raceCallStatus === 'Called') calls[id] = PARTY((m.candidates && m.candidates[w.candidateID] || {}).party);
  });
  return { calls, tabulated, updated };
}

// NBC: per race for Senate and Governor; House per-state counts and chamber totals
function parseNBC(pages) {
  const calls = {}, houseByState = {}, totals = {}; let updated = null;
  ['senate', 'governor'].forEach(k => {
    const pp = pages[k].pageProps || pages[k];
    if (pp.lastModified) { const t = new Date(pp.lastModified).toISOString(); if (!updated || t > updated) updated = t; }
    (((pp.tableData || {}).states) || []).forEach(s => {
      const id = (k === 'senate' ? 'Senate-' : 'Gov-') + s.stateAbbr;
      const p = s.dem && s.dem.isWinner ? 'D' : s.rep && s.rep.isWinner ? 'R' : s.ind && s.ind.isWinner ? 'I' : null;
      if (p) calls[id] = p;
    });
  });
  const hp = pages.house.pageProps || pages.house;
  if (hp.lastModified) { const t = new Date(hp.lastModified).toISOString(); if (!updated || t > updated) updated = t; }
  (((hp.tableData || {}).states) || []).forEach(s => { houseByState[s.stateAbbr] = { D: (s.dem || {}).seatsWon || 0, R: (s.rep || {}).seatsWon || 0 }; });
  const bar = ((hp.bopData || {}).bar) || {};
  totals.house = { D: (bar.dem || {}).total || 0, R: (bar.rep || {}).total || 0, I: (bar.ind || {}).total || 0 };
  return { calls, houseByState, totals, updated };
}

function count(races, key, kind) {
  const t = { D: 0, R: 0, I: 0 };
  Object.values(races).forEach(r => { if (r.kind === kind && r.desks && r.desks[key]) t[r.desks[key]] = (t[r.desks[key]] || 0) + 1; });
  return t;
}

async function main() {
  let live;
  try { live = JSON.parse(fs.readFileSync(LIVE, 'utf8')); } catch (e) { console.error('[desks] no live.json'); return; }
  if (!live.races) return;
  const prev = live.desks || {};
  const desks = { fox: { name: 'Fox News', ok: live.ok !== false, updated: live.source_last_updated || live.fetched_at } };

  let ap = null, nbc = null;
  try {
    const [meta, prog] = await Promise.all([getJson(AP_BASE + 'metadata.json', 'ap'), getJson(AP_BASE + 'progress.json', 'ap')]);
    ap = parseAP(meta, prog); desks.ap = { name: 'AP', ok: true, updated: ap.updated, via: 'apnews.com, also shown by Politico' };
  } catch (e) { console.error('[desks] AP failed:', e.message); desks.ap = Object.assign({}, prev.ap || { name: 'AP' }, { ok: false, error: e.message }); }
  try {
    const pages = {};
    for (const k of ['senate', 'house', 'governor']) pages[k] = await getJson(NBC_BASE + k + '-results', 'nbc');
    nbc = parseNBC(pages); desks.nbc = { name: 'NBC News', ok: true, updated: nbc.updated };
  } catch (e) { console.error('[desks] NBC failed:', e.message); desks.nbc = Object.assign({}, prev.nbc || { name: 'NBC News' }, { ok: false, error: e.message }); }

  // House: Fox+AP consensus per state may not exceed NBC's own count for that state and party
  const room = {};
  if (nbc) Object.keys(nbc.houseByState).forEach(st => { room[st] = Object.assign({}, nbc.houseByState[st]); });

  Object.keys(live.races).forEach(id => {
    const r = live.races[id], old = r.desks || {};
    const fox = r.called && r.winner_party ? (r.winner_party === 'D' || r.winner_party === 'R' ? r.winner_party : 'I') : null;
    const apCall = ap ? (ap.calls[id] || null) : (old.ap || null);
    const nbcCall = r.kind === 'house' ? null : nbc ? (nbc.calls[id] || null) : (old.nbc || null);
    r.desks = { fox, ap: apCall, nbc: nbcCall };
    const votes = [fox, apCall, nbcCall].filter(Boolean), tally = {};
    votes.forEach(p => { tally[p] = (tally[p] || 0) + 1; });
    let c = Object.keys(tally).find(p => tally[p] >= 2) || null;
    // uncontested House seats: AP does not tabulate them, so the Fox call stands
    if (!c && r.kind === 'house' && ap && !ap.tabulated.has(id) && (r.candidates || []).length === 1) { c = PARTY(r.candidates[0].party) || fox; r.desks.ap_note = 'uncontested, not tabulated by AP'; }
    if (c && r.kind === 'house' && nbc && room[r.state]) r.desks.nbc_state_ok = room[r.state][c] > 0;
    r.consensus = c;
    r.consensus_by = c ? ['fox', 'ap', 'nbc'].filter(k => r.desks[k] === c).map(k => ({ fox: 'Fox News', ap: 'AP', nbc: 'NBC News' })[k]) : [];
  });

  ['house', 'senate', 'governor'].forEach(kind => {
    desks.fox[kind] = count(live.races, 'fox', kind);
    if (desks.ap.ok) desks.ap[kind] = count(live.races, 'ap', kind);
    if (desks.nbc.ok) desks.nbc[kind] = kind === 'house' ? nbc.totals.house : count(live.races, 'nbc', kind);
  });
  // AP leaves uncontested House seats out of its feed; add them so its total matches apnews.com
  // (Fox lists them without a call; its own headline total includes them, so add them there too)
  Object.values(live.races).forEach(r => {
    if (!r.desks.ap_note || !r.consensus) return;
    if (desks.ap.ok) desks.ap.house[r.consensus]++;
    if (!r.desks.fox) desks.fox.house[r.consensus]++;
  });
  // Fox's own House headline (its balance-of-power block) is what foxnews.com shows; use it
  const fh = live.chambers && live.chambers.house && live.chambers.house.parties;
  if (fh && fh.D && fh.R) desks.fox.house = { D: fh.D.won || 0, R: fh.R.won || 0, I: (fh.Oth || {}).won || 0 };

  live.desks = desks;
  live.consensus_rule = 'A seat counts as won when two of three decision desks (Fox News, AP, NBC News) call it for the same party. Politico shows AP calls.';
  live.desks_checked_at = new Date().toISOString();
  fs.writeFileSync(LIVE, JSON.stringify(live, null, 1) + '\n');
  const h = Object.values(live.races).filter(r => r.kind === 'house' && r.consensus);
  console.log(`[desks] AP ${desks.ap.ok ? 'ok' : 'FAILED'} · NBC ${desks.nbc.ok ? 'ok' : 'FAILED'} · House agreed D ${h.filter(r => r.consensus === 'D').length} R ${h.filter(r => r.consensus === 'R').length}`);
}

module.exports = { parseAP, parseNBC, main };
if (require.main === module) main().catch(e => { console.error('[desks] error:', e.message); });
