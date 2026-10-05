// assets/js/seat-ids.js
//
// Canonical seat ID rules (see CLAUDE.md):
//   House:    "AZ-01"        (2-letter abbr, dash, 2-digit district; at-large = "XX-AL")
//   Senate:   "Senate-TX"    (2-letter abbr)
//   Governor: "Gov-TX"       (2-letter abbr)
//
// toSeatId(type, raw) converts any existing site key format (map.html's
// "Arizona_1" join keys, factions119.json's "Alabama|2" keys, data.json's
// "AZ-01"/"AZ-1" district strings, plain state names/abbreviations, and
// brief-title fragments like "Arizona District 1") into the canonical ID.
//
// IMPORTANT: scripts/build_briefs.py re-implements this exact same logic in
// Python. If you change the rules here, change them there too.

const STATE_TO_ABBR = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA',
  'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA',
  'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
  'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
  'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
  'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
  'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT',
  'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
  'District of Columbia': 'DC',
};

const ABBR_SET = new Set(Object.values(STATE_TO_ABBR));
const NAME_LOWER_TO_ABBR = {};
for (const name in STATE_TO_ABBR) NAME_LOWER_TO_ABBR[name.toLowerCase()] = STATE_TO_ABBR[name];

// Accepts a 2-letter abbreviation (any case) or a full state name (any case).
// Returns the 2-letter abbreviation, or null if unrecognised.
function resolveStateAbbr(token) {
  if (!token) return null;
  const t = token.trim();
  const up = t.toUpperCase();
  if (ABBR_SET.has(up)) return up;
  return NAME_LOWER_TO_ABBR[t.toLowerCase()] || null;
}

function toSeatId(type, raw) {
  if (!type || raw == null) return null;
  const kind = String(type).trim().toLowerCase();
  let str = String(raw).trim();
  if (!str) return null;

  if (kind === 'senate' || kind === 'governor') {
    const abbr = resolveStateAbbr(str);
    if (!abbr) return null;
    return kind === 'senate' ? `Senate-${abbr}` : `Gov-${abbr}`;
  }

  if (kind !== 'house') return null;

  // Normalise separators and strip "District"/"Dist." noise words so
  // "Arizona District 1", "Arizona_1", "Alabama|2", "AZ-1" all collapse
  // to the same "<state-token> <district-token>" shape.
  str = str
    .replace(/\bdistrict\b|\bdist\.?\b/gi, ' ')
    .replace(/[_|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // At-large: "AK-AL", "AK AL", "AK-AT-LARGE", "Alaska At-Large"
  let m = str.match(/^(.+?)[\s-]+(AL|AT-?LARGE)$/i);
  if (m) {
    const abbr = resolveStateAbbr(m[1].trim());
    return abbr ? `${abbr}-AL` : null;
  }

  // "<state or abbr> <district number>", dash or space separated:
  // "AZ-1", "AZ-01", "AZ 1", "Arizona 1", "Arizona-1"
  m = str.match(/^(.+?)[\s-]+(\d{1,2})$/);
  if (m) {
    const abbr = resolveStateAbbr(m[1].trim());
    if (!abbr) return null;
    const districtNum = parseInt(m[2], 10);
    // map.html/india.html use district 0 as their at-large convention.
    if (districtNum === 0) return `${abbr}-AL`;
    return `${abbr}-${String(districtNum).padStart(2, '0')}`;
  }

  return null;
}

// ── Quick sanity check — open the browser console on any page that loads
//    this file to see 10 sample conversions. ──────────────────────────────
(function () {
  const samples = [
    ['house',    'AZ-1'],
    ['house',    'AZ-01'],
    ['house',    'Arizona District 1'],
    ['senate',   'Texas'],
    ['governor', 'Texas'],
    ['house',    'AK-AL'],
    ['house',    'Arizona_1'],
    ['house',    'Alabama|2'],
    ['house',    'ND-0'],
    ['senate',   'CA'],
  ];
  console.log('[seat-ids.js] sample conversions:');
  samples.forEach(([type, raw]) => {
    console.log(`  toSeatId(${JSON.stringify(type)}, ${JSON.stringify(raw)}) -> ${toSeatId(type, raw)}`);
  });
})();
