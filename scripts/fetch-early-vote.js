#!/usr/bin/env node
// Early vote totals from the University of Florida Election Lab 2026 Early Vote Tracker.
// The tracker page (https://election.lab.ufl.edu/early-vote/2026-early-voting/) loads
// /data-downloads/earlyvote/2026/US.csv; this script reads that file and writes
// data/early-vote.json. Party splits are by party registration, not votes cast.
//
//   node scripts/fetch-early-vote.js
const fs = require('fs');
const path = require('path');

const PAGE = 'https://election.lab.ufl.edu/early-vote/2026-early-voting/';
const CSV = 'https://election.lab.ufl.edu/data-downloads/earlyvote/2026/US.csv';
const OUT = path.resolve(__dirname, '../data/early-vote.json');

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const n = v => { const x = Number(String(v || '').replace(/,/g, '')); return isFinite(x) && x > 0 ? x : 0; };
function isoDate(mdy) { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdy || ''); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; }

(async () => {
  const res = await fetch(CSV, { headers: { 'User-Agent': 'Racebook (usstudies@takshashila.org.in)' } });
  if (!res.ok) throw new Error('UF Election Lab CSV: HTTP ' + res.status);
  const lastModified = res.headers.get('last-modified');
  const rows = parseCSV(await res.text());
  if (rows.length < 30) throw new Error('UF Election Lab CSV: only ' + rows.length + ' rows');

  const states = {};
  let total = 0, inPerson = 0, mailReturned = 0, mailRequested = 0, turn2022 = 0, latest = null;
  for (const r of rows) {
    const st = r.state_abbv;
    if (!/^[A-Z]{2}$/.test(st) || st === 'DC') continue;
    const e = {
      name: r.state, total: n(r.voted_all), in_person: n(r.inperson_all), mail_returned: n(r.accept_all), mail_requested: n(r.request_all),
      party_d: n(r.voted_dem), party_r: n(r.voted_rep), party_other: n(r.voted_none), turn_2022: n(r.turn_2022),
      updated: isoDate(r.last_update), source: r.data_source && r.data_source !== 'NA' ? r.data_source : null,
      notes: r.notes && r.notes !== 'NA' ? r.notes : null
    };
    e.has_party = e.party_d + e.party_r > 0;
    e.pct_of_2022 = e.turn_2022 ? Math.round(e.total / e.turn_2022 * 1000) / 10 : null;
    states[st] = e;
    total += e.total; inPerson += e.in_person; mailReturned += e.mail_returned; mailRequested += e.mail_requested;
    if (e.total && e.turn_2022) turn2022 += e.turn_2022;
    if (e.updated && (!latest || e.updated > latest)) latest = e.updated;
  }
  const out = {
    meta: {
      source: 'University of Florida Election Lab, 2026 Early Vote Tracker', source_url: PAGE, data_url: CSV,
      file_updated: lastModified ? new Date(lastModified).toISOString() : null, latest_state_update: latest,
      fetched: new Date().toISOString(), cadence: 'updated daily by source',
      party_note: 'by party registration, not votes cast',
      missing_states: ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'].filter(s => !states[s])
    },
    national: {
      total, in_person: inPerson, mail_returned: mailReturned, mail_requested: mailRequested,
      turn_2022_reporting_states: turn2022, pct_of_2022: turn2022 ? Math.round(total / turn2022 * 1000) / 10 : null,
      states_reporting: Object.values(states).filter(s => s.total).length
    },
    states
  };
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const strip = s => s.replace(/"fetched": "[^"]*"/, '');
  const next = JSON.stringify(out, null, 1) + '\n';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (strip(prev) !== strip(next)) fs.writeFileSync(OUT, next);
  console.log(`early vote: ${total.toLocaleString('en-US')} in ${out.national.states_reporting} states (${out.national.pct_of_2022}% of 2022 in those states); file ${out.meta.file_updated}; ${strip(prev) === strip(next) ? 'unchanged' : 'written'}`);
})().catch(e => { console.error(e.message); process.exit(1); });
