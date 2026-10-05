#!/usr/bin/env node
'use strict';

/**
 * fetch-candidate-news.js
 * Recent news for each tracked person, from Google News RSS:
 *   - every member in india.html's MEMBERS array
 *   - the Democratic and Republican nominees for every seat in assets/briefs.json
 *
 * One query per person: "Full Name" when:7d (plus the state for common surnames).
 * An item is kept only if the full name, or "Rep./Sen./Gov. Surname", appears in
 * its title or summary. Results go to assets/candidate-news.json, keyed by member
 * ID and canonical seat ID: up to 6 items per person, newest first, kept 14 days.
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const { COMMON_SURNAMES, candidateNames, cleanText, splitGoogleNewsTitle, loadMembers, loadBriefs, seatState, escapeRe } = require('./news-utils');
const { recordStatus, saveStatus } = require('./status');

const OUT_PATH       = path.resolve(__dirname, '../assets/candidate-news.json');
const MAX_ITEMS      = 6;
const KEEP_MS        = 14 * 24 * 60 * 60 * 1000;
const QUERY_DELAY_MS = 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SUFFIX_RE = /^(Jr|Sr|II|III|IV)\.?$/;

// ── WHO TO SEARCH FOR ─────────────────────────────────────────────────────────
// One entry per unique name; a person can be both a member and a nominee.
function buildPeople() {
  const people = new Map();
  const add = (name, state, target) => {
    if (!people.has(name)) people.set(name, { name, state, targets: [] });
    people.get(name).targets.push(target);
  };
  for (const m of loadMembers()) add(m.name, m.state, { type: 'member', id: m.id });
  for (const [seatId, brief] of Object.entries(loadBriefs())) {
    const state = seatState(brief);
    for (const [field, party] of [['dem', 'D'], ['rep', 'R']]) {
      for (const name of candidateNames(brief[field])) add(name, state, { type: 'seat', seat: seatId, party });
    }
  }
  return [...people.values()];
}

// "André" → "Andre", so accents don't decide a match
const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '');

const INITIAL_RE = /^\p{Lu}\.?$/u;
const PARTICLE_RE = /^(van|von|de|del|der|la|le|da|di|du|st\.?)$/i;

// "Chris Van Hollen" → "Van Hollen"; "Danny K. Davis" → "Davis"
function surnameOf(name) {
  const words = name.split(' ').filter(w => !SUFFIX_RE.test(w));
  let i = words.length - 1;
  while (i > 1 && PARTICLE_RE.test(words[i - 1])) i--;
  return words.slice(i).join(' ');
}

// Drops middle initials and suffixes only: "Danny K. Davis" → "Danny Davis",
// "Kevin Lincoln II" → "Kevin Lincoln"; "Marjorie Taylor Greene" is unchanged.
function shortName(name) {
  return name.split(' ').filter((w, i) => i === 0 || !(INITIAL_RE.test(w) || SUFFIX_RE.test(w))).join(' ');
}

function queryFor(person) {
  const common = COMMON_SURNAMES.has(surnameOf(person.name).toLowerCase());
  return `"${shortName(person.name)}"${common && person.state ? ` ${person.state}` : ''} when:7d`;
}

// Full name (with or without middle name/initial), or a title + surname:
// Rep./Sen./Gov. and the spelled-out Representative/Senator/Governor/Congressman/
// Congresswoman. Matched on accent-folded text.
function nameMatcher(name) {
  const variants = new Set([name, shortName(name)].map(fold));
  const alt = [...variants].map(escapeRe).join('|');
  const surname = escapeRe(fold(surnameOf(name)));
  const titles = '(Rep|Sen|Gov)\\.?|Representative|Senator|Governor|Congressman|Congresswoman';
  const re = new RegExp(`(?<![\\p{L}])(${alt}|(${titles}) ${surname})(?![\\p{L}])`, 'u');
  return { test: text => re.test(fold(text)) };
}

// ── GOOGLE NEWS ──────────────────────────────────────────────────────────────
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false });

async function searchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'DCDossier/2.0 (+https://github.com/dcdossier/Generational-Mid-terms)' }, timeout: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const channel = parser.parse(await res.text())?.rss?.channel || {};
  const raw = channel.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
  return raw.map(item => {
    const { title, publisher } = splitGoogleNewsTitle(cleanText(item.title), item.source);
    let summary = cleanText(item.description);
    if (summary.startsWith(title)) summary = ''; // Google News summaries repeat the headline
    const date = new Date(item.pubDate);
    return {
      title,
      url: cleanText(item.link),
      source: publisher || 'Google News',
      date: isNaN(date) ? null : date.toISOString(),
      summary,
    };
  }).filter(i => i.title && i.url && i.date);
}

// ── MERGE ────────────────────────────────────────────────────────────────────
// Previous items + new ones, deduped by URL and headline, within 14 days, newest first.
function mergeItems(previous, fresh, now) {
  const seen = new Set();
  const key = t => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return [...fresh, ...(previous || [])]
    .filter(i => now - new Date(i.date).getTime() <= KEEP_MS)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .filter(i => {
      const k = key(i.title);
      if (seen.has(i.url) || seen.has(k)) return false;
      seen.add(i.url); seen.add(k);
      return true;
    })
    .slice(0, MAX_ITEMS)
    .map(({ title, url, source, date }) => ({ title, url, source, date }));
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const start = Date.now();
  const people = buildPeople();
  console.log(`[candidate-news] ${people.length} people to search (members + nominees)`);

  let previous = { members: {}, seats: {} };
  try { previous = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { /* first run */ }

  const out = { meta: {}, members: {}, seats: {} };
  const zero = [];
  let failures = 0, matchedTotal = 0;
  const now = Date.now();

  for (let i = 0; i < people.length; i++) {
    const person = people[i];
    if (i > 0) await sleep(QUERY_DELAY_MS);
    const query = queryFor(person);
    let matched = [];
    try {
      const items = await searchGoogleNews(query);
      const re = nameMatcher(person.name);
      matched = items.filter(it => re.test(it.title) || re.test(it.summary));
      if (!matched.length) {
        zero.push(person.name);
        console.log(`  [zero] ${person.name} — ${items.length} results, none name them (${query})`);
      }
    } catch (err) {
      failures++;
      console.warn(`  [error] ${person.name}: ${err.message} (${query})`);
    }
    matchedTotal += matched.length;

    for (const t of person.targets) {
      if (t.type === 'member') {
        const prev = previous.members?.[t.id]?.items;
        out.members[t.id] = { name: person.name, items: mergeItems(prev, matched, now) };
      } else {
        const seat = out.seats[t.seat] = out.seats[t.seat] || { candidates: [] };
        const prev = previous.seats?.[t.seat]?.candidates?.find(c => c.name === person.name)?.items;
        seat.candidates.push({ name: person.name, party: t.party, items: mergeItems(prev, matched, now) });
      }
    }
  }

  out.meta = {
    updated: new Date().toISOString(),
    window_days: 14,
    max_items: MAX_ITEMS,
    people: people.length,
    zero_results: zero,
    errors: failures,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');

  const ok = failures < people.length / 2;
  recordStatus('Candidate news (Google News)', {
    group: 'candidates', primary: true, ok, count: matchedTotal,
    error: ok ? null : `${failures} of ${people.length} queries failed`,
  });
  saveStatus();

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`[candidate-news] Done in ${elapsed}s — ${matchedTotal} matching items, ${zero.length} people with zero results, ${failures} query errors`);
  process.exit(0);
}

main().catch(err => {
  console.error('[candidate-news] Fatal error:', err);
  saveStatus();
  process.exit(1);
});
