#!/usr/bin/env python3
"""Build assets/map-timeline.json for the "How the map changed" timeline map
(assets/js/timeline-map.js, used on Trends and India's Interest).

Inputs
  assets/live-baseline.json   holders before the election (119th Congress), notional party
                              in redrawn states, Senate and Governor holders
  assets/factions119.json     houseMap / senateMap: member names (119th Congress)
  data.json                   redistricting (status, impact, Ballotpedia links) and
                              race_polls (every poll in each race's history)
  assets/districts2026.geojson, assets/districts119.geojson   district geometry

Geometry: both district files store islands as extra rings of one "Polygon", all wound
the same way, so d3 and mapshaper read them as holes and draw shapes inside-out (and
dropped MD-02 entirely). Every ring is split into its own polygon first; mapshaper
then snaps, cleans and simplifies to about 1 MB of TopoJSON (one topology: 2026
districts, 119th Congress districts for the states whose lines change inside the
timeline, and state outlines dissolved from the districts so borders line up).
Rings are written clockwise, which is what d3 expects; the build checks it.

Redistricting dates come from each state's Ballotpedia page (REDISTRICTING below). An
event whose date is not confirmed by its cited source gets "verified": false and shows
as a hollow dot on the slider; the build prints them.

  python3 scripts/build_map_timeline.py
"""
import glob
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'map-timeline.json')
MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
LABELS = ['Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026',
          '3 Nov · Election night', '120th Congress']
BP = 'https://ballotpedia.org/Redistricting_in_{}_ahead_of_the_2026_elections'
STATES = {'AL': 'Alabama', 'CA': 'California', 'FL': 'Florida', 'LA': 'Louisiana', 'MO': 'Missouri', 'NC': 'North Carolina',
          'OH': 'Ohio', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VA': 'Virginia'}
# "Potential result of new maps", Ballotpedia's table of congressional redistricting ahead of 2026
IMPACT = {'AL': '+1R', 'CA': '+5D', 'FL': '+4R', 'LA': '+1R', 'NC': '+1R', 'OH': '+2R', 'TN': '+1R', 'TX': '+5R', 'UT': '+1D'}

# (state, date, status, lines, summary, verified). lines=True: from this month the map
# shows the state's 2026 districts. Months use the state at the end of the month.
# Every date here is quoted from the state's Ballotpedia page (fetched 4 Nov 2026).
REDISTRICTING = [
    ('TX', '2025-08-29', 'Enacted', True, 'Gov. Greg Abbott signed a new map shifting five Democratic districts towards Republicans.', True),
    ('MO', '2025-09-28', 'Enacted', False, 'Gov. Mike Kehoe signed a new map; a referendum and court rulings later kept the 2022 map for November.', True),
    ('NC', '2025-10-22', 'Enacted', True, 'The General Assembly passed a new map (no governor\'s approval needed).', True),
    ('OH', '2025-10-31', 'Enacted', True, 'The Ohio Redistricting Commission unanimously approved a new map.', True),
    ('CA', '2025-11-04', 'Enacted', True, 'Voters approved Proposition 50, adopting the legislature\'s new map (AB 604) for 2026.', True),
    ('UT', '2025-11-10', 'Court-imposed', True, 'Judge Dianna Gibson chose the plaintiffs\' map, adding a Democratic-leaning district.', True),
    ('TX', '2025-11-18', 'Blocked', False, 'A three-judge panel blocked the 2025 map; three days later the Supreme Court paused that ruling.', True),
    ('TX', '2025-12-04', 'Upheld', False, 'The Supreme Court ruled Texas could use the 2025 map in 2026.', True),
    ('VA', '2026-01-27', 'Blocked', False, 'A state judge blocked the redistricting amendment from the ballot.', True),
    ('VA', '2026-02-13', 'Referendum allowed', False, 'The Virginia Supreme Court allowed the redistricting referendum on the 21 April ballot.', True),
    ('VA', '2026-04-21', 'Referendum passed', False, 'Voters approved the amendment allowing mid-decade redistricting.', True),
    ('FL', '2026-04-29', 'Passed', False, 'The legislature approved a new map in a special session (House 83–23, Senate 21–17).', True),
    ('LA', '2026-04-29', 'Struck down', False, 'The Supreme Court ruled Louisiana\'s map an unconstitutional racial gerrymander (Louisiana v. Callais).', True),
    ('FL', '2026-05-04', 'Enacted', True, 'Gov. Ron DeSantis signed the new map into law.', True),
    ('TN', '2026-05-07', 'Enacted', True, 'The legislature passed, and Gov. Bill Lee signed, a map splitting the Memphis district.', True),
    ('VA', '2026-05-08', 'Struck down', False, 'The Virginia Supreme Court blocked the voter-approved plan; the old map stays.', True),
    ('AL', '2026-05-11', 'Allowed', False, 'The Supreme Court lifted the injunctions against the 2023 legislature map.', True),
    ('AL', '2026-05-26', 'Blocked', False, 'A lower court again blocked the 2023 map as a racial gerrymander.', True),
    ('LA', '2026-05-29', 'Enacted', True, 'Gov. Jeff Landry signed a new map shifting one Democratic district towards Republicans.', True),
    ('AL', '2026-06-02', 'Enacted', True, 'The Supreme Court lifted the lower-court order, so the 2023 map is used in 2026.', True),
    ('MO', '2026-09-25', 'Old map kept', False, 'The Supreme Court stayed the Eighth Circuit order: the 2022 map is used in November.', True),
]
OLD_LINE_STATES = sorted({s for s, d, st, lines, *_ in REDISTRICTING if lines and d[:7] > MONTHS[0]})


def month_index(date):
    m = date[:7]
    return MONTHS.index(m) if m in MONTHS else (-1 if m < MONTHS[0] else len(MONTHS))


def date_label(d):
    y, m, day = d.split('-')
    return '%d %s %s' % (int(day), ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][int(m) - 1], y)


def ring_area(r):
    return sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1)) / 2


def split_rings(path, out, keep=None):
    """Every ring wound like the first is its own polygon; opposite rings are holes."""
    g = json.load(open(path))
    feats = []
    for f in g['features']:
        p = f['properties']
        if p['state'] == 'District of Columbia' or (keep and p['state'] not in keep):
            continue
        geo = f['geometry']
        polys = [geo['coordinates']] if geo['type'] == 'Polygon' else geo['coordinates']
        res = []
        for pl in polys:
            sign = ring_area(pl[0]) < 0
            for r in pl:
                if len(r) < 4:
                    continue
                if (ring_area(r) < 0) == sign or not res:
                    res.append([r])
                else:
                    res[-1].append(r)
        feats.append({'type': 'Feature', 'properties': {'state': p['state'], 'district': p['district']},
                      'geometry': {'type': 'MultiPolygon', 'coordinates': res}})
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(out, 'w'))
    return len(feats)


def mapshaper():
    found = glob.glob(os.path.expanduser('~/.npm/_npx/*/node_modules/mapshaper/bin/mapshaper')) + \
        glob.glob('/private/tmp/claude-*/**/node_modules/mapshaper/bin/mapshaper', recursive=True)
    return ['node', found[0]] if found else ['npx', '-y', 'mapshaper@0.6']


def build_topo(tmp):
    d26, d119 = os.path.join(tmp, 'd2026.json'), os.path.join(tmp, 'd119.json')
    n26 = split_rings(os.path.join(ROOT, 'assets', 'districts2026.geojson'), d26)
    n119 = split_rings(os.path.join(ROOT, 'assets', 'districts119.geojson'), d119, {STATES[s] for s in OLD_LINE_STATES})
    out = os.path.join(tmp, 'topo.json')
    cmd = mapshaper() + ['-i', d26, d119, 'combine-files', 'snap', 'snap-interval=0.002', '-rename-layers', 'd2026,d119',
                         '-clean', 'target=*', '-simplify', '22%', 'keep-shapes', 'target=*',
                         '-dissolve', 'state', 'target=d2026', '+', 'name=states',
                         '-o', out, 'format=topojson', 'quantization=60000', 'target=*']
    subprocess.run(cmd, check=True, capture_output=True)
    t = json.load(open(out))
    got = {k: len(o['geometries']) for k, o in t['objects'].items()}
    assert got['d2026'] == n26 == 435, ('2026 districts', got, n26)
    assert got['d119'] == n119, ('119 districts', got, n119)
    assert got['states'] == 50, got
    return t


def check_winding(t):
    """Decode arcs and check every polygon's first ring is clockwise (d3's inside)."""
    sx, sy = t['transform']['scale']
    tx, ty = t['transform']['translate']
    arcs = []
    for a in t['arcs']:
        x = y = 0
        pts = []
        for dx, dy in a:
            x += dx; y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        pts = []
        for i in idx:
            seg = arcs[i] if i >= 0 else arcs[~i][::-1]
            pts.extend(seg if not pts else seg[1:])
        return pts
    bad = 0
    for o in t['objects'].values():
        for g in o['geometries']:
            polys = [g['arcs']] if g['type'] == 'Polygon' else g.get('arcs', [])
            for pl in polys:
                if ring_area(ring(pl[0])) > 0:
                    # anticlockwise outer ring: reverse every ring of this polygon
                    for k, r in enumerate(pl):
                        pl[k] = [~i for i in reversed(r)]
                    bad += 1
    return bad


def main():
    base = json.load(open(os.path.join(ROOT, 'assets', 'live-baseline.json')))
    fac = json.load(open(os.path.join(ROOT, 'assets', 'factions119.json')))
    data = json.load(open(os.path.join(ROOT, 'data.json')))
    rp = data['race_polls']['races']
    ratings = {}
    for r in data['races']['house']['competitive']:
        a = r['district'].split('-')
        ratings['%s-%s' % (a[0], a[1].zfill(2) if a[1].isdigit() else a[1])] = r['rating']
    abbr = {v['state']: k.split('-')[1] for k, v in base['senate'].items()}
    abbr.update({v['state']: k.split('-')[1] for k, v in base['gov'].items()})
    for r in data['races']['senate']['races']:
        ratings['Senate-' + r['code']] = r['rating']
    for r in data['races']['governor']['races']:
        if r['state'] in abbr:
            ratings['Gov-' + abbr[r['state']]] = r['rating']

    def polls(id_):
        h = (rp.get(id_) or {}).get('history') or []
        # every poll; the margin is null when a third candidate is in the top two
        return sorted([[p[0], p[1], p[2]] for p in h], key=lambda p: p[0])

    seats = {}
    for id_, v in base['house'].items():
        seats[id_] = {'c': 'house', 'st': id_[:2], 'h': v.get('holder'), 'n': v.get('notional_party') if v.get('redrawn') else None,
                      'rd': bool(v.get('redrawn')), 'm': v.get('member'), 'p': polls(id_), 'rt': ratings.get(id_)}
    for k, c in (('senate', 'senate'), ('gov', 'gov')):
        for id_, v in base[k].items():
            seats[id_] = {'c': c, 'st': id_.split('-')[1], 'h': v.get('holder'), 'n': None, 'rd': False,
                          'm': v.get('incumbent'), 'p': polls(id_), 'rt': ratings.get(id_)}
    old119 = {id_: v.get('holder') for id_, v in base['house'].items() if id_[:2] in OLD_LINE_STATES}

    events = []
    for code, d, status, lines, summary, verified in REDISTRICTING:
        events.append({'code': code, 'state': STATES[code], 'date': d, 'date_label': date_label(d), 'month': month_index(d),
                       'status': status, 'lines': lines, 'impact': IMPACT.get(code) if lines else None, 'summary': summary,
                       'url': BP.format(STATES[code].replace(' ', '_')), 'source': 'Ballotpedia', 'verified': verified})

    with tempfile.TemporaryDirectory() as tmp:
        topo = build_topo(tmp)
    fixed = check_winding(topo)

    prev = json.load(open(OUT)) if os.path.exists(OUT) else {}
    out = {
        '_about': 'Built by scripts/build_map_timeline.py for assets/js/timeline-map.js. Do not edit by hand, except "certified".',
        'certified': bool(prev.get('certified', False)),
        'months': MONTHS, 'labels': LABELS, 'events': events, 'seats': seats, 'old119': old119,
        'old_line_states': OLD_LINE_STATES,
        'counts': {'seats': len(seats), 'polls': sum(len(s['p']) for s in seats.values()), 'events': len(events)},
        'sources': {
            'holders': 'assets/live-baseline.json (119th Congress holders; expected party on the new maps in redrawn states)',
            'redistricting': 'Ballotpedia state redistricting pages (dates checked 4 Nov 2026)',
            'polls': data['race_polls'].get('source', 'New York Times polling data') + ', every poll in each race',
            'results': 'Fox News Decision Desk (assets/live.json, live)',
        },
        'topo': topo,
    }
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))
    unv = [e for e in events if not e['verified']]
    print('map-timeline.json: %d KB · %d seats · %d polls · %d events (%d unverified) · %d rings rewound' % (
        os.path.getsize(OUT) // 1024, len(seats), out['counts']['polls'], len(events), len(unv), fixed))
    for e in unv:
        print('  unverified: %s %s %s' % (e['code'], e['date'], e['status']))


if __name__ == '__main__':
    sys.exit(main())
