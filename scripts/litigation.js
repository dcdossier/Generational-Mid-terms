#!/usr/bin/env node
/* Litigation and interference tracker for election night -> data/litigation.json.
 *
 * Sources: the Ground News midterm-elections page (https://ground.news/interest/midterm-elections)
 * and every feed in midterm_rss_feeds_v2.xlsx (FEEDS in fetch-news.js).
 * An item counts when it names a state (or a race's candidate) together with an election
 * word and one of: lawsuit, sued, court, injunction, judge, recount, litigation, polling
 * hours extended, voter intimidation, interference, bomb threat, machine malfunction, cyber.
 * Items about the same thing (same state and type, similar headline) form one entry, and
 * an entry is published once 2 distinct publishers report it (a Ground News story that
 * itself lists 2+ outlets counts).
 *
 *   node scripts/litigation.js
 */
const fs = require('fs');
const path = require('path');
const { FEEDS, fetchFeed } = require('./fetch-news');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data/litigation.json');
const GN = 'https://ground.news/interest/midterm-elections';
const SINCE = Date.parse('2026-11-02T00:00:00Z');

const LAW = /\b(lawsuits?|sued|sues|suing|court|injunction|judge|recount|litigation)\b/i;
const INTERF = /\b(polling hours (?:were |was |are )?extended|extend(?:s|ed)? (?:polling|voting) hours|polls? (?:will )?(?:stay|stays|remain|remains) open|voter intimidation|intimidat\w+|interference|bomb threats?|machine malfunctions?|malfunction\w*|cyber\w*)\b/i;
const ELECTION = /\b(election|ballots?|vot(?:e|es|ers|ing)|polls?|polling|precincts?|county clerk|canvass|tabulat\w+|recount)\b/i;
const NOISE = /\b(primary|debate|endorse\w*|supreme court nominee|confirmation hearing)\b/i;
const STATES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const host = u => { const m = /^https?:\/\/([^\/?#]+)/i.exec(u || ''); return m ? m[1].toLowerCase().replace(/^www\./, '') : ''; };
const words = t => new Set(norm(t).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(w => w.length > 3));
function sim(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; const u = a.size + b.size - n; return u ? n / u : 0; }
const decode = s => String(s).replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&rsquo;|&#8217;/g, '’');

// Candidate full names -> race, so "Valadao sues county" maps to CA-22
function raceIndex() {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/candidates-2026.json'), 'utf8')), out = [];
  for (const k of ['house', 'senate', 'gov']) for (const [id, v] of Object.entries(c[k] || {})) for (const n of [v.D, v.R]) if (n && n.split(' ').length > 1) out.push([norm(n), id]);
  return out;
}

async function groundNews() {
  try {
    const res = await fetch(GN, { headers: { 'User-Agent': 'Mozilla/5.0 (Racebook; usstudies@takshashila.org.in)' } });
    if (!res.ok) { console.warn('[litigation] Ground News HTTP ' + res.status); return []; }
    const html = await res.text(), out = [];
    // Each story card: a link to /article/<slug>, a headline, and "<n> sources"
    const re = /<a[^>]+href="(\/article\/[^"#?]+)"[^>]*>([\s\S]{0,4000}?)<\/a>/g; let m;
    while ((m = re.exec(html))) {
      const block = m[2], h = /<h[2-5][^>]*>([^<]{15,240})</.exec(block);
      if (!h) continue;
      const n = /(\d{1,4})\s+sources?/i.exec(block);
      out.push({ title: decode(h[1]).trim(), url: 'https://ground.news' + m[1], source: 'Ground News', outlets: n ? +n[1] : 1, date: null, description: '' });
    }
    const seen = new Set();
    return out.filter(x => !seen.has(x.url) && seen.add(x.url));
  } catch (e) { console.warn('[litigation] Ground News failed: ' + e.message); return []; }
}

async function main() {
  const now = Date.now();
  const [gn, rss] = await Promise.all([groundNews(), Promise.all(FEEDS.map(fetchFeed)).then(r => r.flat())]);
  const races = raceIndex(), prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { entries: [] };
  const items = [];
  for (const it of [...gn, ...rss]) {
    const at = it.date ? Date.parse(it.date) : now;
    if (at < SINCE) continue;
    const txt = it.title + '. ' + (it.description || '');
    if (NOISE.test(txt) || !ELECTION.test(txt)) continue;
    const type = LAW.test(txt) ? 'lawsuit' : INTERF.test(txt) ? 'interference' : null;
    if (!type) continue;
    const low = norm(txt);
    const race = (races.find(([n]) => low.includes(n)) || [])[1] || null;
    const st = race ? /^(?:Senate-|Gov-)?([A-Z]{2})/.exec(race)[1] : (Object.entries(STATES).find(([, n]) => new RegExp('\\b' + norm(n) + '\\b').test(low)) || [])[0];
    if (!st) continue;
    const pub = it.source === 'Ground News' ? 'Ground News' : (it.source || host(it.url));
    items.push({ state: st, race_id: race, type, title: it.title, url: it.url, publisher: pub, outlets: it.outlets || 1, at, w: words(it.title) });
  }
  // cluster: same state and type, similar headlines
  const clusters = [];
  for (const it of items.sort((a, b) => a.at - b.at)) {
    const c = clusters.find(k => k.state === it.state && k.type === it.type && k.items.some(x => sim(x.w, it.w) >= 0.3 || x.url === it.url));
    if (c) { if (!c.items.some(x => x.url === it.url)) c.items.push(it); if (!c.race_id && it.race_id) c.race_id = it.race_id; }
    else clusters.push({ state: it.state, type: it.type, race_id: it.race_id, items: [it] });
  }
  const entries = [];
  for (const c of clusters) {
    const pubs = [...new Set(c.items.map(x => norm(x.publisher)))];
    const gnMany = c.items.some(x => x.publisher === 'Ground News' && x.outlets >= 2);
    if (pubs.length < 2 && !gnMany) continue;
    const seen = new Set();
    entries.push({
      id: c.type[0] + '-' + c.state + '-' + norm(c.items[0].title).replace(/[^a-z0-9]+/g, '-').slice(0, 40),
      state: c.state, race_id: c.race_id || null, type: c.type, summary: c.items[0].title,
      sources: c.items.filter(x => { const k = norm(x.publisher); if (seen.has(k)) return false; seen.add(k); return true; })
        .map(x => ({ publisher: x.publisher === 'Ground News' && x.outlets > 1 ? 'Ground News (' + x.outlets + ' outlets)' : x.publisher, url: x.url, at: new Date(x.at).toISOString() }))
    });
  }
  const out = {
    updated: new Date(now).toISOString(),
    source: 'Ground News midterm-elections page and the ' + FEEDS.length + ' feeds in midterm_rss_feeds_v2.xlsx; an entry needs 2 distinct publishers',
    counts: { lawsuits: entries.filter(e => e.type === 'lawsuit').length, interference: entries.filter(e => e.type === 'interference').length },
    entries
  };
  const strip = o => JSON.stringify({ ...o, updated: 0 });
  if (strip(prev) !== strip(out)) fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`[litigation] ${gn.length} Ground News stories, ${rss.length} feed items, ${items.length} matched; ${out.counts.lawsuits} lawsuits, ${out.counts.interference} interference reports${strip(prev) === strip(out) ? ' (unchanged)' : ''}`);
}

if (require.main === module) main().catch(e => { console.error('[litigation] failed:', e.message); process.exitCode = 0; });
