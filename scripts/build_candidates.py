#!/usr/bin/env python3
"""Main candidates (top Democrat and Republican) for every 2026 House, Senate and Governor race.

Source: Wikipedia's 2026 House, Senate and gubernatorial election pages (candidate lists
in the district and state tables). Seat briefs (assets/briefs.json) win where they name a
nominee. Used by the Racebook Sync triangulation (Calls.gs) to match headlines.

    python3 scripts/build_candidates.py
"""
import json, re, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'candidates-2026.json'
UA = {'User-Agent': 'Racebook (usstudies@takshashila.org.in)'}
STATES = {'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
          'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS', 'Kentucky': 'KY',
          'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
          'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
          'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
          'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY'}


def raw(title):
    u = 'https://en.wikipedia.org/w/index.php?' + urllib.parse.urlencode({'title': title, 'action': 'raw', 'redirects': 1})
    return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60).read().decode('utf-8')


CAND = re.compile(r'\{\{Party stripe\|([^}]+)\}\}\s*(?:\[\[(?:[^\]|]*\|)?([^\]]+)\]\]|([^(\n<{]+?))\s*\(([^)]+)\)')


def pick(block):
    d = r = None
    for m in CAND.finditer(block):
        name = re.sub(r'\s+', ' ', (m.group(2) or m.group(3) or '')).strip()
        party = (m.group(4) or '') + ' ' + m.group(1)
        if not name: continue
        if d is None and re.search(r'Democratic|DFL', party): d = name
        elif r is None and re.search(r'Republican', party): r = name
    return d, r


def main():
    out = {'_about': 'Main Democratic and Republican candidates per race, from Wikipedia 2026 election pages; seat briefs override. Built by scripts/build_candidates.py.',
           'house': {}, 'senate': {}, 'gov': {}}
    h = raw('2026 United States House of Representatives elections')
    h = h[h.index('\n==Alabama=='):h.index('\n==Non-voting delegates==')]
    for m in re.finditer(r'\{\{ushr\|([A-Z]{2})\|([A-Z0-9]+)\|X\}\}', h):
        st, n = m.groups(); sid = f"{st}-{'AL' if n == 'AL' else n.zfill(2)}"
        if sid in out['house']: continue
        blk = h[m.end():m.end() + 2500]; nxt = re.search(r'\{\{ushr\|', blk); blk = blk[:nxt.start()] if nxt else blk
        d, r = pick(blk)
        out['house'][sid] = {'D': d, 'R': r}
    s = raw('2026 United States Senate elections')
    for m in re.finditer(r'\[\[2026 United States Senate (?:special )?election in ([^|\]]+)\|', s):
        st = STATES.get(m.group(1).strip())
        if not st or ('Senate-' + st) in out['senate']: continue
        blk = s[m.end():m.end() + 3000]
        if 'Party stripe' not in blk[:2500]: continue
        nxt = re.search(r'\n\|-\n', blk); blk = blk[:nxt.start()] if nxt else blk
        d, r = pick(blk)
        if d or r: out['senate']['Senate-' + st] = {'D': d, 'R': r}
    g = raw('2026 United States gubernatorial elections')
    for m in re.finditer(r'\[\[2026 ([A-Z][A-Za-z ]+?) gubernatorial election\|', g):
        st = STATES.get(m.group(1).strip())
        if not st or ('Gov-' + st) in out['gov']: continue
        blk = g[m.end():m.end() + 3000]
        nxt = re.search(r'\n\|-\n', blk); blk = blk[:nxt.start()] if nxt else blk
        d, r = pick(blk)
        if d or r: out['gov']['Gov-' + st] = {'D': d, 'R': r}
    briefs = json.loads((ROOT / 'assets' / 'briefs.json').read_text())
    clean = lambda x: re.sub(r'\s*\(.*?\)\s*', ' ', x or '').strip() or None
    for sid, b in briefs.items():
        k = 'senate' if sid.startswith('Senate-') else 'gov' if sid.startswith('Gov-') else 'house'
        e = out[k].setdefault(sid, {'D': None, 'R': None})
        if b.get('dem') and clean(b['dem']) and clean(b['dem']) != 'None': e['D'] = clean(b['dem'])
        if b.get('rep') and clean(b['rep']) and clean(b['rep']) != 'None': e['R'] = clean(b['rep'])
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n')
    for k in ('house', 'senate', 'gov'):
        both = sum(1 for v in out[k].values() if v['D'] and v['R'])
        print(k, len(out[k]), 'with both:', both)


if __name__ == '__main__':
    main()
