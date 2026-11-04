#!/usr/bin/env node
/*
 * Election-night live results from the Fox News results pages (Fox News Decision Desk,
 * with AP race calls as Fox shows them). Reads the House, Senate and Governor results
 * pages, decodes the data the pages embed, and writes assets/live.json.
 *
 * Usage: node scripts/live-from-fox.js            (one run)
 *        node scripts/live-from-fox.js --loop 55  (every 3 minutes for 55 minutes)
 * Never throws away the last good file: on any failure it keeps assets/live.json and
 * records the error in it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '../assets/live.json');
const BASE = 'https://www.foxnews.com/elections/2026/midterm-results/';
const PAGES = { house: BASE + 'house', senate: BASE + 'senate', governor: BASE + 'governor' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
// Governorships not up in 2026 (24 D and 26 R held now; 18 of each are up tonight)
const GOV_NOT_UP = { D: 6, R: 8, Oth: 0 };
const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);

// Nuxt "devalue" payload → plain object
function decodeNuxt(html) {
  const m = html.match(/<script type="application\/json" data-nuxt-data="nuxt-app"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no embedded data found (page layout changed?)');
  const arr = JSON.parse(m[1]);
  const memo = new Map();
  const WRAP = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef', 'NuxtError']);
  function rev(i) {
    if (typeof i !== 'number' || i < 0) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (v === null || typeof v !== 'object') { memo.set(i, v); return v; }
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && (WRAP.has(v[0]) || ['Date', 'Set', 'Map', 'BigInt'].includes(v[0]))) {
        if (v[0] === 'Date' || v[0] === 'BigInt') { memo.set(i, v[1]); return v[1]; }
        if (v[0] === 'Set') { const o = []; memo.set(i, o); v.slice(1).forEach(x => o.push(rev(x))); return o; }
        if (v[0] === 'Map') { const o = {}; memo.set(i, o); for (let k = 1; k < v.length; k += 2) o[rev(v[k])] = rev(v[k + 1]); return o; }
        const o = rev(v[1]); memo.set(i, o); return o;
      }
      const o = []; memo.set(i, o); v.forEach(x => o.push(rev(x))); return o;
    }
    const o = {}; memo.set(i, o);
    for (const k of Object.keys(v)) o[k] = rev(v[k]);
    return o;
  }
  return rev(0);
}

async function getPage(url) {
  const res = await fetch(url + '?t=' + Date.now(), { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const html = await res.text();
  const upd = (html.match(/Last Updated:\s*<time[^>]*datetime="([^"]+)"/) || [])[1] || null;
  return { root: decodeNuxt(html), lastUpdated: upd };
}

function seatId(kind, r) {
  const st = r.stateCode;
  if (kind === 'senate') return 'Senate-' + st;
  if (kind === 'governor') return 'Gov-' + st;
  const n = Number(r.districtNumber);
  if (AT_LARGE.has(st) || !n) return st + '-AL';
  return st + '-' + String(n).padStart(2, '0');
}

function slimRace(kind, r) {
  const cands = (r.results || []).map(c => ({
    name: [c.candidate && c.candidate.firstName, c.candidate && c.candidate.lastName].filter(Boolean).join(' '),
    party: c.partyCode, incumbent: !!c.isIncumbent, winner: !!c.isWinner,
    votes: c.votes ? c.votes.count : null, pct: c.votes ? c.votes.percentage : null,
    photo: c.headshotPath && !/fallback/.test(c.headshotPath) ? c.headshotPath : null,
  })).sort((a, b) => (b.votes || 0) - (a.votes || 0));
  const lead = cands[0];
  const total = cands.reduce((s, c) => s + (c.votes || 0), 0);
  return {
    id: seatId(kind, r), kind, state: r.stateCode, special: /special/i.test(r.raceType || ''),
    called: r.called === 1 || r.called === true, too_close: !!r.tooCloseToCall,
    flipped: !!r.isFlipped, runoff: !!r.isRunoff,
    pct_in: r.expectedPercentageInt != null ? r.expectedPercentageInt : (r.precinctsReporting != null ? Math.round(r.precinctsReporting) : null),
    winner_party: (cands.find(c => c.winner) || {}).party || null,
    leader_party: lead && lead.votes ? lead.party : null,
    margin_pct: cands.length > 1 && cands[0].pct != null && cands[1].pct != null ? +(cands[0].pct - cands[1].pct).toFixed(1) : null,
    total_votes: total, called_at: r.winnerTime || null, candidates: cands.slice(0, 4),
  };
}

function chamber(bopNode) {
  if (!bopNode) return null;
  const pr = {};
  (bopNode.partyResults || []).forEach(p => { pr[p.partyCode] = { won: p.count, net_gain: p.gain, flipped_to: p.flipped, majority_called: !!p.isWinner }; });
  return { not_up: bopNode.startValues || null, up_tonight: bopNode.seatsInPlayStart, total_seats: bopNode.totals && bopNode.totals.expectedTotal,
           remaining: bopNode.totals && bopNode.totals.seatsRemaining, parties: pr, first_poll_close: bopNode.pollClose || null };
}

// Fox's page has no governor balance block, so count it from the races.
function governorTotals(races, notUp) {
  const parties = { D: { won: 0, net_gain: 0, flipped_to: 0 }, R: { won: 0, net_gain: 0, flipped_to: 0 }, Oth: { won: 0, net_gain: 0, flipped_to: 0 } };
  let up = 0, remaining = 0;
  Object.values(races).filter(r => r.kind === 'governor').forEach(r => {
    up++;
    if (!r.called || !r.winner_party) { remaining++; return; }
    const k = parties[r.winner_party] ? r.winner_party : 'Oth';
    parties[k].won++;
    if (r.flipped) { parties[k].flipped_to++; parties[k].net_gain++; const other = k === 'D' ? 'R' : 'D'; parties[other].net_gain--; }
  });
  Object.keys(parties).forEach(k => { parties[k].majority_called = (notUp[k] || 0) + parties[k].won >= 26; });
  return { not_up: notUp, up_tonight: up, total_seats: 50, remaining, parties, computed: true };
}

async function runOnce() {
  const fetchedAt = new Date().toISOString();
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first run */ }
  try {
    const pages = {};
    for (const k of Object.keys(PAGES)) pages[k] = await getPage(PAGES[k]);
    const races = {}; const calls = [];
    for (const kind of ['house', 'senate', 'governor']) {
      const p = pages[kind].root.pinia || {};
      const rt = (p.raceTable && p.raceTable[kind]) || {};
      const list = rt.national || Object.values(rt).flat();
      (Array.isArray(list) ? list : []).forEach(r => { if (r && r.stateCode) { const s = slimRace(kind, r); if (!races[s.id] || s.special === false) races[s.id] = s; } });
      const lu = (p.elections && p.elections.liveUpdates && p.elections.liveUpdates[kind]) || [];
      lu.slice(0, 60).forEach(c => calls.push({ kind, race: c.race_id, state: c.state_full, district: c.district || null, party: c.winner_party_code,
        winner: [c.winner_first, c.winner_last].filter(Boolean).join(' '), at: c.call_time, pct_in: c.eevp }));
    }
    const bop = (pages.house.root.pinia.bop || {}).bop || {};
    const govBop = ((pages.governor.root.pinia.bop || {}).bop || {});
    const out = {
      source: { name: 'Fox News Decision Desk (race calls as shown by Fox News, including AP calls)', pages: PAGES },
      source_last_updated: [pages.house.lastUpdated, pages.senate.lastUpdated, pages.governor.lastUpdated].filter(Boolean).sort().pop() || null, fetched_at: fetchedAt, ok: true, error: null,
      chambers: { house: chamber(bop.congress && bop.congress.house), senate: chamber(bop.congress && bop.congress.senate),
                  governor: governorTotals(races, GOV_NOT_UP) },
      races,
      // Latest calls, newest first, built from the race data (complete for all three kinds)
      latest_calls: Object.values(races).filter(r => r.called && r.called_at)
        .sort((a, b) => String(b.called_at).localeCompare(String(a.called_at))).slice(0, 50)
        .map(r => { const w = r.candidates.find(c => c.winner) || {}; return { id: r.id, kind: r.kind, party: r.winner_party, winner: w.name || null, flipped: r.flipped, at: r.called_at }; }),
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    const h = out.chambers.house, s = out.chambers.senate;
    console.log(`[live] ${fetchedAt} ok · races ${Object.keys(races).length} · House D ${h && h.parties.D && h.parties.D.won} R ${h && h.parties.R && h.parties.R.won} (remaining ${h && h.remaining}) · Senate D ${s && s.parties.D && s.parties.D.won} R ${s && s.parties.R && s.parties.R.won}`);
    return true;
  } catch (err) {
    console.error('[live] failed, keeping last good file:', err.message);
    prev.ok = false; prev.error = String(err.message); prev.last_attempt = fetchedAt;
    if (prev.races) fs.writeFileSync(OUT, JSON.stringify(prev, null, 1) + '\n');
    return false;
  }
}

(async () => {
  const i = process.argv.indexOf('--loop');
  if (i < 0) { process.exitCode = (await runOnce()) ? 0 : 0; return; }
  const minutes = Number(process.argv[i + 1] || 55), end = Date.now() + minutes * 60000;
  while (Date.now() < end) {
    await runOnce();
    if (process.env.LIVE_COMMIT_CMD) require('child_process').spawnSync('bash', ['-c', process.env.LIVE_COMMIT_CMD], { stdio: 'inherit' });
    await new Promise(r => setTimeout(r, 3 * 60000));
  }
})();
