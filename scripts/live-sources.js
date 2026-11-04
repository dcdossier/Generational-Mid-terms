#!/usr/bin/env node
/* Cross-checks Fox News race calls against every news source in the 2026 Mid-term
 * source sheet, the Financial Times and Ground News -> data/live-sources.json.
 *
 * Sources
 *   - The source sheet (read fresh each run, so edits to it take effect): every URL in
 *     the National tab's news rows and every Media row in the All States tab.
 *   - Financial Times (ft.com). The FT blocks automated readers, so only its headlines
 *     are read, through Google News.
 *   - Ground News (https://ground.news/interest/midterm-elections), its story headlines.
 *   Sheet and FT domains are read through Google News search ("site:" queries, 8 per
 *   request), which works for every outlet whether or not it has a feed.
 *
 * A headline counts as a report when it names a candidate in a Fox race (full name, or a
 * surname that is unique and not common, with the state or a local outlet) followed by a
 * win verb ("wins", "defeats", "re-elected" ...), and does not hedge ("expected to win",
 * "could", "?"). The named candidate is the one closest before the verb. "X concedes"
 * counts as a report against X. Office words must match (a "Senate" headline never
 * counts for a House race).
 *
 * Fox stays the only source of calls and vote counts. This file only says, per race,
 * which other outlets report the same winner, which report a different one, and
 * which report a winner Fox has not yet called. Reports are kept across runs.
 *
 *   node scripts/live-sources.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fetchFeed } = require('./fetch-news');
const { COMMON_SURNAMES } = require('./news-utils');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data/live-sources.json');
const LIVE = path.join(ROOT, 'assets/live.json');
const SHEET = 'https://docs.google.com/spreadsheets/d/1FMZeIE--DE2NgejAgABePCe_HfMaKYKyRtqVxcBaMCE';
const GN = 'https://ground.news/interest/midterm-elections';
const SINCE = Date.parse('2026-11-03T23:00:00Z');   // first polls close
const FT = { name: 'Financial Times', domain: 'ft.com', state: null };

const STATES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]));

const WIN = /\b(wins?|won|defeats?|defeated|beats?|topples?|toppled|ousts?|ousted|unseats?|unseated|flips?|flipped|holds? off|fends? off|re-?elected|elected|prevails?|captures?|takes|clinch(?:es)?|keeps|retains|projected (?:winner|to win)|declared (?:the )?winner|victory|victorious)\b/i;
const LOSS = /\bconcedes?\b/i;
const HEDGE = /\?|\b(expected to|poised to|favou?red to|could|might|may|would|aims? to|seeks? to|hopes? to|bid to|race to|path to|odds|if |what if|how .+ could|preview|live results|live updates|results:|polls? show|forecast)\b/i;
const OFFICE = { senate: /\bsenate\b/i, governor: /\b(governor|gubernatorial|governorship)\b/i, house: /\b(house|congress(?:ional)?|district|rep\.)\b/i };

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'");
const host = u => { try { return new URL(/^https?:/.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function csvRows(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function sheetTab(name) {
  const res = await fetch(SHEET + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(name));
  if (!res.ok) throw new Error('sheet ' + name + ': HTTP ' + res.status);
  return csvRows(await res.text());
}

// News outlets from the sheet: National news row(s) and every Media row per state
async function sheetSources(prev) {
  try {
    const out = new Map();
    for (const r of await sheetTab('National')) {
      if (!/news/i.test(r[0] || '')) continue;
      for (const u of r.slice(1)) { const d = host(u.trim().split(/\s/)[0]); if (d && !out.has(d)) out.set(d, { name: d, domain: d, state: null }); }
    }
    for (const r of (await sheetTab('All States')).slice(1)) {
      if (!/media/i.test(r[1] || '') || !r[4]) continue;
      const d = host(r[4].trim()), st = BY_NAME[norm(r[0]).replace(/[^a-z ]/g, '').trim()] || null;
      if (d) out.set(d, { name: r[3].trim(), domain: d, state: st });
    }
    if (!out.size) throw new Error('no sources in the sheet');
    return [...out.values()];
  } catch (e) {
    console.warn('[sources] sheet unreadable, using the last list: ' + e.message);
    return (prev.sources || []).filter(s => s.domain !== FT.domain && s.domain !== 'ground.news').map(({ name, domain, state }) => ({ name, domain, state }));
  }
}

async function googleNews(group) {
  const q = '(' + group.map(s => 'site:' + s.domain).join(' OR ') + ') (wins OR won OR defeats OR beats OR elected OR "re-elected" OR reelected OR concedes OR ousts OR unseats OR flips OR victory) when:2d';
  return fetchFeed({ url: 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=' + encodeURIComponent(q), source: 'Google News', statusName: null });
}
async function groundNews() {
  try {
    const res = await fetch(GN, { headers: { 'User-Agent': 'Mozilla/5.0 (Racebook; usstudies@takshashila.org.in)' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text(), out = [], seen = new Set();
    const re = /<a[^>]+href="(\/article\/[^"#?]+)"[^>]*>([\s\S]{0,4000}?)<\/a>/g; let m;
    while ((m = re.exec(html))) {
      const h = /<h[2-5][^>]*>([^<]{15,240})</.exec(m[2]); if (!h || seen.has(m[1])) continue; seen.add(m[1]);
      const n = /(\d{1,4})\s+sources?/i.exec(m[2]);
      out.push({ title: h[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim(), url: 'https://ground.news' + m[1],
                 source: n && +n[1] > 1 ? 'Ground News (' + n[1] + ' outlets)' : 'Ground News', date: null, ground: true });
    }
    return { ok: true, items: out };
  } catch (e) { console.warn('[sources] Ground News: ' + e.message); return { ok: false, error: e.message, items: [] }; }
}

// Candidate index from Fox: full names everywhere, surnames only when unique and uncommon
function candidateIndex(races) {
  const all = [], sur = new Map();
  for (const r of Object.values(races)) for (const c of (r.candidates || []).slice(0, 3)) {
    if (!c.name || c.name.split(' ').length < 2) continue;
    const full = norm(c.name), last = full.split(' ').filter(w => !/^(jr\.?|sr\.?|ii|iii|iv)$/.test(w)).pop();
    const e = { race: r, cand: c, full, last }; all.push(e);
    sur.set(last, (sur.get(last) || 0) + 1);
  }
  all.forEach(e => { e.surOk = sur.get(e.last) === 1 && !COMMON_SURNAMES.has(e.last) && e.last.length > 3; });
  return all;
}

function readHeadline(item, outletState, idx) {
  const t = norm(item.title);
  if (HEDGE.test(t)) return [];
  const verb = WIN.exec(t) || LOSS.exec(t); if (!verb) return [];
  const loss = !WIN.exec(t) || (LOSS.exec(t) && LOSS.exec(t).index < verb.index);
  const at = loss ? LOSS.exec(t).index : verb.index;
  const before = t.slice(0, at);
  // candidates named before the verb, the closest one wins
  let best = null;
  for (const e of idx) {
    let pos = before.lastIndexOf(e.full);
    if (pos < 0 && e.surOk) {
      const st = e.race.state, stateNamed = new RegExp('\\b' + esc(norm(STATES[st] || '')) + '\\b').test(t) || outletState === st;
      const m = stateNamed && [...before.matchAll(new RegExp('\\b' + esc(e.last) + '\\b', 'g'))].pop();
      pos = m ? m.index : -1;
    }
    if (pos < 0) continue;
    const kind = e.race.kind, offices = Object.keys(OFFICE).filter(k => OFFICE[k].test(t));
    if (offices.length && !offices.includes(kind)) continue;
    if (!best || pos > best.pos) best = { pos, e };
  }
  if (!best) return [];
  const { race, cand } = best.e;
  return [{ race: race.id, name: cand.name, party: cand.party, result: loss ? 'lost' : 'won' }];
}

async function main() {
  const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const sheet = await sheetSources(prev);
  const outlets = [...sheet, FT];
  const groups = []; for (let i = 0; i < outlets.length; i += 8) groups.push(outlets.slice(i, i + 8));
  const items = [], seenPub = new Map(), byDomain = Object.fromEntries(outlets.map(o => [o.domain, o]));
  const okGroups = new Set();
  for (const g of groups) {
    const r = await googleNews(g);
    if (r.length) g.forEach(o => okGroups.add(o.domain));
    for (const it of r) {
      // Google News links are redirects, so match the outlet by publisher name or domain in the name
      const o = g.find(x => norm(it.source).includes(norm(x.name)) || norm(it.source).replace(/[^a-z]/g, '').includes(x.domain.split('.')[0].replace(/[^a-z]/g, ''))) || null;
      items.push({ ...it, outlet: o });
    }
    await new Promise(r => setTimeout(r, 400));
  }
  const gn = await groundNews();
  gn.items.forEach(it => items.push({ ...it, outlet: { name: 'Ground News', domain: 'ground.news', state: null } }));

  const idx = candidateIndex(live.races);
  const reports = new Map((prev.reports || []).map(r => [r.url + '|' + r.race, r]));
  for (const it of items) {
    if (it.date && Date.parse(it.date) < SINCE) continue;
    const st = it.outlet && it.outlet.state;
    for (const h of readHeadline(it, st, idx)) {
      const k = it.url + '|' + h.race; if (reports.has(k)) continue;
      reports.set(k, { ...h, publisher: it.ground ? it.source : (it.source || (it.outlet && it.outlet.name)), outlet: it.outlet ? it.outlet.domain : null,
                       url: it.url, title: it.title, at: it.date ? new Date(it.date).toISOString() : new Date().toISOString() });
    }
  }

  // Per race: agree / disagree with Fox, or report a winner Fox has not called. One entry per publisher.
  const races = {};
  for (const r of reports.values()) {
    const fox = live.races[r.race]; if (!fox) continue;
    const named = (fox.candidates || []).find(c => c.name === r.name);
    const others = (fox.candidates || []).filter(c => c.name !== r.name);
    const winner = r.result === 'won' ? named : (others.length === 1 ? others[0] : null);   // a concession names the loser
    if (!winner) continue;
    const x = races[r.race] || (races[r.race] = { fox_winner: null, agree: [], disagree: [], reported: [] });
    const fw = fox.called ? (fox.candidates || []).find(c => c.winner) : null;
    x.fox_winner = fw ? fw.name : null;
    const list = !fw ? x.reported : fw.name === winner.name ? x.agree : x.disagree;
    const pub = norm(r.publisher);
    if (list.some(y => norm(y.publisher) === pub)) continue;
    list.push({ publisher: r.publisher, url: r.url, title: r.title, winner: winner.name, party: winner.party, at: r.at });
  }

  const sources = outlets.map(o => ({ ...o, ok: okGroups.has(o.domain) }))
    .concat([{ name: 'Ground News', domain: 'ground.news', state: null, ok: gn.ok }]);
  const out = {
    updated: new Date().toISOString(),
    about: 'Cross-check of Fox News race calls against the outlets in the 2026 Mid-term source sheet, the Financial Times (headlines via Google News) and Ground News. Fox remains the source of calls and vote counts.',
    sources, reports: [...reports.values()].sort((a, b) => a.at.localeCompare(b.at)), races,
    counts: { sources: sources.length, read: sources.filter(s => s.ok).length, races_confirmed: Object.values(races).filter(r => r.agree.length).length,
              races_disputed: Object.values(races).filter(r => r.disagree.length).length, races_reported_not_called: Object.values(races).filter(r => r.reported.length).length },
  };
  const strip = o => JSON.stringify({ ...o, updated: 0 });
  if (strip(prev) !== strip(out)) fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`[sources] ${out.counts.read}/${out.counts.sources} sources read, ${items.length} headlines, ${reports.size} reports · confirmed ${out.counts.races_confirmed}, disputed ${out.counts.races_disputed}, reported not called ${out.counts.races_reported_not_called}`);
}

if (require.main === module) main().catch(e => { console.error('[sources] failed:', e.message); process.exitCode = 0; });
