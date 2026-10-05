'use strict';

/**
 * news-utils.js — shared by fetch-news.js and fetch-candidate-news.js:
 * text cleaning, Google News title handling, and the candidate lists
 * (india.html MEMBERS, assets/briefs.json nominees).
 */

const fs   = require('fs');
const path = require('path');
const he   = require('he');

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Decodes HTML entities (twice, for feeds that double-encode "&amp;#8217;"),
// strips tags and collapses whitespace.
function cleanText(str) {
  let t = String(str ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = he.decode(t);
  t = t.replace(/<[^>]+>/g, ' ');
  t = he.decode(t);
  return t.replace(/\s+/g, ' ').trim();
}

// Google News titles end in " - Publisher"; the real publisher is also in <source>.
function splitGoogleNewsTitle(title, sourceEl) {
  const publisher = cleanText(typeof sourceEl === 'object' ? sourceEl['#text'] : sourceEl);
  if (publisher && title.endsWith(` - ${publisher}`)) {
    return { title: title.slice(0, -(publisher.length + 3)).trim(), publisher };
  }
  const m = title.match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
  return m ? { title: m[1], publisher: publisher || m[2].trim() } : { title, publisher };
}

// Surnames too common to identify a candidate on their own
const COMMON_SURNAMES = new Set(['smith', 'johnson', 'williams', 'brown', 'jones', 'miller', 'davis', 'wilson',
  'moore', 'taylor', 'anderson', 'thomas', 'jackson', 'white', 'harris', 'martin', 'thompson', 'garcia',
  'martinez', 'robinson', 'clark', 'rodriguez', 'lewis', 'walker', 'young', 'allen', 'king', 'wright', 'scott',
  'green', 'baker', 'adams', 'nelson', 'hill', 'campbell', 'mitchell', 'roberts', 'carter', 'phillips', 'evans',
  'turner', 'torres', 'parker', 'collins', 'edwards', 'stewart', 'morris', 'murphy', 'cook', 'rogers', 'morgan',
  'cooper', 'peterson', 'bailey', 'reed', 'kelly', 'howard', 'price', 'bennett', 'wood', 'barnes', 'ross',
  'henderson', 'coleman', 'jenkins', 'perry', 'powell', 'long', 'patterson', 'hughes', 'flores', 'washington',
  'butler', 'simmons', 'foster', 'gonzales', 'bryant', 'alexander', 'russell', 'griffin', 'hayes', 'myers',
  'ford', 'hamilton', 'graham', 'sullivan', 'wallace', 'woods', 'west', 'jordan', 'owens', 'reynolds', 'fisher',
  'ellis', 'harrison', 'gibson', 'marshall', 'warren', 'grant', 'hunter', 'black', 'stone', 'hudson', 'young',
  'house', 'senate', 'trump', 'biden', 'vance', 'bush', 'clinton', 'obama']);

// Turns "Brian Lambert (Libertarian); write-ins Salomon Hernandez Sr., Keith Varian"
// into ['Brian Lambert', 'Salomon Hernandez Sr', 'Keith Varian']
function candidateNames(field) {
  return String(field || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[“"][^”"]*[”"]/g, ' ')           // nicknames
    .split(/[;,/]| vs\.? /)
    .map(s => s.replace(/^\s*(write-ins?|and)\s+/i, '').replace(/\.$/, '').trim())
    .filter(s => /^\p{Lu}[\p{L}.'’-]*( (von|van|de|del|la|\p{Lu}[\p{L}.'’-]*)){1,3}$/u.test(s));
}

// india.html's MEMBERS array → [{ id, name, state, chamber }]
function loadMembers() {
  try {
    const html = fs.readFileSync(path.resolve(__dirname, '../india.html'), 'utf8');
    const start = html.indexOf('const MEMBERS = [');
    const block = html.slice(start, html.indexOf('];', start));
    const field = (row, key) => (row.match(new RegExp(`\\b${key}:'((?:[^'\\\\]|\\\\.)*)'`)) || [])[1]?.replace(/\\\\'/g, "'");
    return [...block.matchAll(/\{\s*id:\s*(\d+),[^\n]*/g)].map(m => ({
      id: parseInt(m[1], 10),
      name: field(m[0], 'name'),
      state: field(m[0], 'state'),
      chamber: field(m[0], 'chamber'),
    })).filter(m => m.name);
  } catch (err) {
    console.warn(`[news-utils] Could not read MEMBERS from india.html: ${err.message}`);
    return [];
  }
}

// assets/briefs.json, keyed by canonical seat ID ("AZ-01", "Senate-TX", "Gov-TX")
function loadBriefs() {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../assets/briefs.json'), 'utf8')); }
  catch (err) {
    console.warn(`[news-utils] Could not read assets/briefs.json: ${err.message}`);
    return {};
  }
}

// "Arizona District 1 (House)" / "Texas (Senate)" → state name
function seatState(brief) {
  return (brief.title || '').replace(/\s*(District \d+|At-Large)?\s*\(.*$/, '').trim();
}

module.exports = { COMMON_SURNAMES, candidateNames, cleanText, splitGoogleNewsTitle, loadMembers, loadBriefs, seatState, escapeRe };
