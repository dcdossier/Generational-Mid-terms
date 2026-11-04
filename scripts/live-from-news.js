#!/usr/bin/env node
/* Election-night results from our news sources only.
 *
 * Reads every feed in the master list (midterm_rss_feeds_v2.xlsx, as FEEDS in
 * fetch-news.js), finds race calls and reported vote shares, triangulates them and
 * writes assets/live.json for the site. Evidence is kept in data/live-evidence.json
 * so a call survives its articles dropping out of the feeds.
 *
 *   A call needs 3 distinct publishers naming the same winner (wire copies of AP,
 *   Reuters or AFP, and 90%+ identical text, count once), published after the state's
 *   first poll close, and no contradiction ("too close to call", the other candidate
 *   wins, call retracted, recount) in the last 60 minutes. 1-2 sources: pending.
 *   Items with primary, poll, endorse, debate, could, would, may, expected or if are ignored.
 *
 *   node scripts/live-from-news.js            one pass
 *   node scripts/live-from-news.js --test     run against test/live-samples.xml only
 */
const fs = require('fs');
const path = require('path');
const { FEEDS, fetchFeed } = require('./fetch-news');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets/live.json');
const EVID = path.join(ROOT, 'data/live-evidence.json');
const NEED = 3;
const CONTRA_MS = 60 * 60 * 1000;
const KEEP_MS = 72 * 3600 * 1000;
const FIRST_CLOSE = Date.parse('2026-11-03T23:00:00Z');

const WIN = '(?:wins?|won|defeats?|defeated|beats?|re-?elected|is the projected winner|projected winner|flips?|flipped|keeps? (?:her |his |the |their )?seat|holds? (?:on to )?(?:her |his |the |their )?seat|retains? (?:her |his |the |their )?seat)';
const EXCLUDE = /\b(primary|primaries|poll|polls|polling|endorses?|endorsed|endorsement|debate|could|would|may|expected|if)\b/i;
const CONTRA = /\b(too close to call|call (?:was )?retracted|retracts? (?:the |its |their )?(?:race )?call|recount)\b/i;
const DESKS = [[/\b(?:AP|Associated Press) (?:projects|calls|declares|has called)/i, 'AP'], [/\bNBC News (?:projects|calls)/i, 'NBC News'],
  [/\bDDHQ\b|Decision Desk HQ/i, 'DDHQ'], [/\bCNN (?:projects|calls)/i, 'CNN'], [/Fox News Decision Desk/i, 'Fox News'],
  [/\bABC News (?:projects|calls)/i, 'ABC News'], [/\bCBS News (?:projects|calls)/i, 'CBS News']];
const WIRES = [[/\(AP\)|\bAssociated Press\b|\bAP\s*[—–-]\s/, 'Associated Press'], [/\(Reuters\)|\bReuters\b/, 'Reuters'], [/\(AFP\)|\bAgence France-Presse\b/, 'AFP']];
const STATE_NAMES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };

const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const surname = n => { const p = norm(n).replace(/\b(jr|sr|ii|iii|iv)\.?$/, '').trim().split(' '); return p[p.length - 1]; };
const host = u => { const m = /^https?:\/\/([^\/?#]+)/i.exec(u || ''); return m ? m[1].toLowerCase().replace(/^www\./, '') : ''; };
function words(t) { const w = {}; norm(t).replace(/[^a-z0-9 ]/g, ' ').split(' ').forEach(x => { if (x.length > 2) w[x] = 1; }); return w; }
function similar(a, b) { let n = 0, u = 0, k; for (k in a) { u++; if (b[k]) n++; } for (k in b) if (!a[k]) u++; return u ? n / u : 0; }

// ── races ───────────────────────────────────────────────────────────────────
function buildRaces() {
  const cand = read('data/candidates-2026.json'), pc = read('data/poll-close.json');
  const races = [], bySur = {};
  for (const k of ['house', 'senate', 'gov']) {
    for (const [id, c] of Object.entries(cand[k] || {})) {
      const st = /^(?:Senate-|Gov-)?([A-Z]{2})/.exec(id)[1], p = pc.states[st];
      const people = ['D', 'R'].filter(x => c[x]).map(x => ({ party: x, name: c[x], full: norm(c[x]), sur: surname(c[x]) }));
      if (!people.length) continue;
      people.forEach(p2 => (bySur[p2.sur] = bySur[p2.sur] || []).push(p2.full));
      races.push({ id, kind: k, st, stateName: STATE_NAMES[st], close: p ? Date.parse(p.first_close_utc) : null, people });
    }
  }
  return { races, bySur };
}

// Who an item says won this race (null), whether it contradicts, or null if it is not about the race.
function readItem(race, txt, bySur) {
  const low = norm(txt), state = norm(race.stateName);
  const office = race.kind === 'senate' ? /\bsenat(e|or)\b/ : race.kind === 'gov' ? /\b(governor|gubernatorial|governorship)\b/ : /\b(house|congress(ional)?|district|representative|rep\.)\b/;
  const otherOffice = race.kind === 'house' ? /\b(senat(e|or)|governor|gubernatorial)\b/ : null;
  // House districts can be named as "NY-17", "NY 17" or "New York's 17th"
  let district = false;
  if (race.kind === 'house') {
    const n = race.id.split('-')[1], num = n === 'AL' ? null : String(+n);
    district = new RegExp('\\b' + race.st.toLowerCase() + '[- ]?(?:0?' + (num || 'al') + ')\\b').test(low) ||
      (num && new RegExp(esc(state) + "'s " + num + '(?:st|nd|rd|th)\\b').test(low));
  }
  const about = race.people.filter(p => {
    if (low.includes(p.full)) return true;
    if (district && new RegExp('\\b' + esc(p.sur) + '\\b').test(low)) return true;
    if (!new RegExp('\\b' + esc(p.sur) + '\\b').test(low) || !low.includes(state) || !office.test(low)) return false;
    if (otherOffice && otherOffice.test(low)) return false;
    return !(bySur[p.sur] || []).some(f => f !== p.full && low.includes(f));
  });
  if (!about.length) return null;
  const res = { winner: null, contra: CONTRA.test(txt) };
  if (EXCLUDE.test(pollsClosed(txt))) return res.contra ? res : null;
  const winners = {};
  for (const sen of low.split(/[.;:!?]\s/)) {
    const names = [];
    for (const p of race.people) {
      const re = new RegExp('\\b(?:' + esc(p.full) + '|' + esc(p.sur) + ")(?:'s)?\\b", 'g'); let m;
      while ((m = re.exec(sen))) names.push({ at: m.index, end: m.index + m[0].length, p });
    }
    if (!names.length) continue;
    names.sort((a, b) => a.at - b.at);
    const vre = new RegExp('\\b' + WIN + '\\b', 'g'); let v;
    while ((v = vre.exec(sen))) {
      if (/\bto\s+$/.test(sen.slice(Math.max(0, v.index - 4), v.index))) continue;
      if (/^(is the )?projected winner/.test(v[0])) {
        const after = names.find(n => n.at > v.index && n.at - v.index < 60);
        if (after) { winners[after.p.party] = 1; break; }
      }
      const before = names.filter(n => n.end <= v.index && v.index - n.end <= 60).pop();
      if (before) { winners[before.p.party] = 1; break; }
    }
    const c = /\bconced(?:es|ed)\b/.exec(sen);
    if (c) {
      const who = names.filter(n => n.end <= c.index && c.index - n.end <= 40).pop();
      if (who) race.people.forEach(o => { if (o.party !== who.p.party) winners[o.party] = 1; });
    }
  }
  const ks = Object.keys(winners);
  if (ks.length === 1) res.winner = ks[0]; else if (ks.length > 1) res.contra = true;
  return res;
}

// Reported shares for a race: "Talarico 51% to Paxton 47% with 64% of votes counted"
function readShares(race, txt) {
  if (race.people.length < 2) return null;
  const low = norm(txt), out = {};
  for (const p of race.people) {
    const m = new RegExp('\\b' + esc(p.sur) + "(?:'s)?\\b[^.%]{0,40}?(\\d{1,2}(?:\\.\\d)?)\\s?%").exec(low) ||
              new RegExp('(\\d{1,2}(?:\\.\\d)?)\\s?%[^.%]{0,25}?\\b(?:for )?' + esc(p.sur) + '\\b').exec(low);
    if (m) out[p.party] = +m[1];
  }
  if (out.D == null || out.R == null || out.D + out.R > 100.5) return null;
  const c = /(\d{1,3}(?:\.\d)?)\s?%\s+(?:of\s+(?:the\s+)?(?:expected\s+|estimated\s+)?(?:votes?|ballots?|precincts)\s+)?(?:counted|reporting|reported|in)\b/.exec(low);
  return { pct_d: out.D, pct_r: out.R, pct_counted: c && +c[1] <= 100 ? +c[1] : null };
}

const CONTROL = /\b(democrats|democratic party|republicans|gop|republican party)\b[^.;:!?]{0,40}?\b(win|wins|won|take|takes|took|flip|flips|flipped|capture|captures|captured|keep|keeps|kept|retain|retains|retained|hold|holds|held)\b[^.;:!?]{0,20}?\b(?:control of )?(?:the )?(house|senate)\b/i;
function readControl(txt) {
  if (EXCLUDE.test(pollsClosed(txt))) return null;
  const m = CONTROL.exec(norm(txt));
  return m ? { chamber: m[3].toLowerCase(), party: /^democrat/.test(m[1]) ? 'D' : 'R' } : null;
}

// Outlets that are the wire itself
const WIRE_OUTLETS = [[/^(?:the )?(?:associated press|ap|ap news)$|(?:^|\.)apnews\.com$/i, 'Associated Press'], [/^reuters$|(?:^|\.)reuters\.com$/i, 'Reuters'], [/^(?:afp|agence france-presse)$|(?:^|\.)afp\.com$/i, 'AFP']];
function publisher(it) {
  const txt = it.title + ' ' + it.description;
  for (const [re, name] of WIRES) if (re.test(txt)) return { key: name.toLowerCase(), name };
  for (const [re, name] of WIRE_OUTLETS) if (re.test(String(it.source || '').trim()) || re.test(host(it.url))) return { key: name.toLowerCase(), name };
  const h = host(it.url);
  if (it.source && (!h || /news\.google\.com$/.test(h) || it.source !== it.feed)) return { key: norm(it.source), name: it.source };
  return { key: h || norm(it.source), name: it.source || h };
}
// "polls closed at 8 pm" is routine in results stories; only opinion polls are excluded.
const pollsClosed = t => String(t).replace(/\bpolls? (?:have |had )?(?:closed|close|closes|closing)\b/gi, '');
const deskOf = txt => (DESKS.find(([re]) => re.test(txt)) || [])[1] || null;

// ── decision ────────────────────────────────────────────────────────────────
function decide(list, now) {
  const by = { D: [], R: [] }, contra = [];
  for (const e of list) {
    if (e.kind === 'contra') { if (now - e.at <= CONTRA_MS) contra.push(e); continue; }
    if (by[e.winner]) by[e.winner].push(e);
  }
  const clusters = items => {
    const out = [];
    for (const e of [...items].sort((a, b) => a.at - b.at)) {
      const same = out.find(c => c.key === e.pub || similar(c.words, e.words) >= 0.9);
      if (!same) out.push({ key: e.pub, name: e.pubName, url: e.url, title: e.title, at: e.at, words: e.words, desk: e.desk });
      else if (e.desk && !same.desk) same.desk = e.desk;
    }
    return out;
  };
  const cD = clusters(by.D), cR = clusters(by.R);
  const top = cD.length >= cR.length ? 'D' : 'R', cl = top === 'D' ? cD : cR;
  const recentOther = (top === 'D' ? by.R : by.D).filter(e => now - e.at <= CONTRA_MS);
  const held = cl.length > 0 && (contra.length + recentOther.length) > 0;
  return { winner: cl.length ? top : null, n: cl.length, sources: cl, held,
           reason: contra.length ? contra[0].title : recentOther.length ? 'another source names the other candidate as winner' : '' };
}
const srcList = d => d.sources.map(s => ({ publisher: s.name, url: s.url, title: s.title, at: new Date(s.at).toISOString(), ...(s.desk ? { desk: s.desk } : {}) }));

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const now = process.env.LIVE_NOW ? Date.parse(process.env.LIVE_NOW) : Date.now(), test = process.argv.includes('--test');
  const { races, bySur } = buildRaces();
  const cfg = read('assets/live-config.json'), base = read('assets/live-baseline.json');
  const featuredIds = cfg.senate.concat(cfg.house).map(r => r.race_id);
  const ev = fs.existsSync(EVID) && !test ? JSON.parse(fs.readFileSync(EVID, 'utf8')) : { races: {}, control: {}, shares: {} };
  ev.seen = {};   // per run only; evidence is de-duplicated by link below

  let items;
  if (test) items = require('../test/live-samples.json');
  else items = (await Promise.all(FEEDS.map(fetchFeed))).flat();

  let scanned = 0, matched = 0;
  for (const it of items) {
    const key = it.url || it.title;
    if (!key || ev.seen[key]) continue;
    ev.seen[key] = now; scanned++;
    const txt = it.title + '. ' + (it.description || ''), at = it.date ? Date.parse(it.date) : now;
    if (!(at >= FIRST_CLOSE)) continue;
    const pub = publisher(it), desk = deskOf(txt), w = words(txt);
    for (const r of races) {
      if (!r.close || at < r.close) continue;
      const m = readItem(r, txt, bySur);
      if (!m) continue;
      matched++;
      const base1 = { pub: pub.key, pubName: pub.name, url: it.url, title: it.title.slice(0, 200), at, desk, words: w };
      const list = ev.races[r.id] = ev.races[r.id] || [];
      const has = (kind, w) => list.some(e => e.url === it.url && e.kind === kind && (kind === 'contra' || e.winner === w));
      if (m.contra && !has('contra')) list.push({ kind: 'contra', ...base1 });
      if (m.winner && !has('win', m.winner)) list.push({ kind: 'win', winner: m.winner, ...base1 });
      if (featuredIds.includes(r.id) && !EXCLUDE.test(pollsClosed(txt))) {
        const s = readShares(r, txt);
        if (s && (!ev.shares[r.id] || at >= ev.shares[r.id].at)) ev.shares[r.id] = { ...s, leader: s.pct_d === s.pct_r ? null : s.pct_d > s.pct_r ? 'D' : 'R', source: pub.name, url: it.url, at };
      }
    }
    const c = readControl(txt);
    if (c && !(ev.control[c.chamber] || []).some(e => e.url === it.url)) (ev.control[c.chamber] = ev.control[c.chamber] || []).push({ kind: 'win', winner: c.party, pub: pub.key, pubName: pub.name, url: it.url, title: it.title.slice(0, 200), at, desk, words: w });
  }
  // keep the evidence file small: no per-item index, no word sets older than 3 days
  delete ev.seen;
  for (const list of [...Object.values(ev.races), ...Object.values(ev.control)]) for (let i = list.length - 1; i >= 0; i--) if (now - list[i].at > KEEP_MS) list.splice(i, 1);

  // decide calls
  const calls = [], pending = [], held = [];
  for (const [id, list] of Object.entries(ev.races)) {
    const d = decide(list, now);
    if (!d.winner) continue;
    const r = races.find(x => x.id === id), cand = r && r.people.find(p => p.party === d.winner);
    const desks = [...new Set(d.sources.map(s => s.desk).filter(Boolean))];
    const entry = { race_id: id, winner: d.winner, candidate: cand ? cand.name : null, sources: srcList(d),
                    called_by: (desks.length ? desks.join(', ') + ' · ' : '') + d.n + ' sources' };
    if (d.held) held.push({ ...entry, reason: d.reason });
    else if (d.n >= NEED) calls.push(entry);
    else pending.push(entry);
  }
  const control = {};
  for (const [ch, list] of Object.entries(ev.control)) {
    const d = decide(list, now);
    if (d.winner && !d.held && d.n >= NEED) control[ch] = { party: d.winner, called_by: d.n + ' sources', confirmations: srcList(d) };
  }

  // featured: latest reported shares
  const featured = {};
  for (const id of featuredIds) {
    const s = ev.shares[id];
    if (s) featured[id] = { leader: s.leader, pct_d: s.pct_d, pct_r: s.pct_r, pct_counted: s.pct_counted, source: s.source, url: s.url, at: new Date(s.at).toISOString() };
  }

  // chambers: won from calls, leading from featured leaders not yet called, plus not-up seats
  const kindOf = id => /^Senate-/.test(id) ? 'senate' : /^Gov-/.test(id) ? 'gov' : 'house';
  const notUp = { senate: cfg.senate_summary.not_up, gov: cfg.gov_summary.not_up, house: { D: 0, R: 0 } };
  const chambers = [];
  for (const ch of ['house', 'senate', 'gov']) for (const p of ['D', 'R', 'I']) {
    chambers.push({ chamber: ch, party: p, not_up: (notUp[ch] || {})[p] || 0,
      won: calls.filter(c => kindOf(c.race_id) === ch && c.winner === p).length,
      leading: Object.entries(featured).filter(([id, f]) => kindOf(id) === ch && f.leader === p && !calls.some(c => c.race_id === id)).length });
  }
  // gains and losses vs the party holding each seat before the election
  const holder = id => { const e = base[kindOf(id)][id]; return e ? (e.notional_party || e.holder) : null; };
  const gains = {};
  for (const ch of ['house', 'senate', 'gov']) {
    gains[ch] = { D: { gained: 0, lost: 0, net: 0 }, R: { gained: 0, lost: 0, net: 0 }, I: { gained: 0, lost: 0, net: 0 } };
    for (const c of calls.filter(c => kindOf(c.race_id) === ch)) {
      const was = holder(c.race_id);
      if (was && was !== c.winner && gains[ch][was]) { gains[ch][c.winner].gained++; gains[ch][was].lost++; }
    }
    for (const p of ['D', 'R', 'I']) gains[ch][p].net = gains[ch][p].gained - gains[ch][p].lost;
  }

  const out = {
    updated: new Date(now).toISOString(),
    status: now < FIRST_CLOSE ? 'pre' : 'counting',
    source: 'Our news sources only (midterm_rss_feeds_v2.xlsx, ' + FEEDS.length + ' feeds). A call needs ' + NEED + ' distinct publishers and no contradiction in the last 60 minutes.',
    feeds: FEEDS.length, items_scanned: scanned, candidates_matched: matched,
    calls, featured, chambers, gains, control, pending, held
  };
  if (test) { console.log(JSON.stringify(out, null, 1)); return out; }
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  const strip = o => JSON.stringify({ ...o, updated: 0, changed: 0, items_scanned: 0, candidates_matched: 0 });
  // changed: when calls or shares last changed (the site's "last change"); updated: this run
  out.changed = prev && strip(prev) === strip(out) ? (prev.changed || prev.updated) : out.updated;
  // Write when something changed, and at least every 10 minutes as a heartbeat for the site's watchdog
  if (!prev || strip(prev) !== strip(out) || now - Date.parse(prev.updated) >= 10 * 60 * 1000) {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    if (prev && strip(prev) === strip(out)) out.heartbeat_only = true;
  } else out.unchanged = true;
  fs.writeFileSync(EVID, JSON.stringify(ev));
  console.log(`[live] ${scanned} new items, ${matched} matches; ${calls.length} calls, ${pending.length} pending, ${held.length} held; ` +
              `${Object.keys(featured).length} featured with shares${out.unchanged ? ' (unchanged)' : out.heartbeat_only ? ' (heartbeat)' : ''}`);
  return out;
}

if (require.main === module) main().catch(e => { console.error('[live] fatal:', e); process.exit(1); });
module.exports = { readItem, readShares, readControl, publisher, decide, buildRaces };
