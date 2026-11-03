#!/usr/bin/env python3
"""Build a frozen, read-only copy of the site under archive/<congress>/.

Every file comes from one git commit (the snapshot), not the working tree, so the
archive shows the site exactly as it stood then. Pages are made read-only:
comment threads are removed, a banner is added, and archive-guard.js blocks any
network request that would leave the archive folder, so archived pages can never
fetch live data.

Members are cross-checked against the unitedstates/congress-legislators dataset;
the result is written next to the archive (members-crosscheck.json) without
changing the archived site data.

    python3 scripts/build_archive.py            # 119th Congress, pre-election snapshot
"""
import hashlib
import json
import re
import subprocess
import sys
import unicodedata
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONGRESS = '119'
SNAPSHOT = '6dfe737'                       # last commit before the first polls closed (3 Nov 2026, 23:00 UTC)
SNAPSHOT_LABEL = 'snapshot 3 Nov 2026'
BANNER = 'Archived: 119th Congress (2025–2027), ' + SNAPSHOT_LABEL
OUT = ROOT / 'archive' / CONGRESS

PAGES = ['index.html', 'map.html', 'india.html', 'analysis.html', 'about.html', 'overview.html', 'four-is-v3.html']
DATA = ['data.json', 'status.json', 'analysis.json', 'analysis-manual.json']
SKIP_ASSETS = set()                        # everything under assets/ is copied

LEGISLATORS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json'
LEGISLATORS_COMMITS = 'https://api.github.com/repos/unitedstates/congress-legislators/commits?path=legislators-current.yaml&per_page=1'

STATES = {'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT',
          'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
          'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI',
          'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH',
          'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
          'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN',
          'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY'}


def git_bytes(path):
    return subprocess.run(['git', 'show', f'{SNAPSHOT}:{path}'], cwd=ROOT, check=True, capture_output=True).stdout


def git_files(prefix):
    out = subprocess.run(['git', 'ls-tree', '-r', '--name-only', SNAPSHOT, prefix], cwd=ROOT, check=True, capture_output=True, text=True).stdout
    return [p for p in out.splitlines() if p]


def snapshot_time():
    return subprocess.run(['git', 'show', '-s', '--format=%cI', SNAPSHOT], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()


GUARD = r"""/* Archive guard: archived pages are read-only and must never fetch live data.
 * Any fetch, XHR, WebSocket, EventSource or beacon that would leave this archive
 * folder is refused. Loaded first in every archived page. */
(function () {
  'use strict';
  var me = document.currentScript && document.currentScript.src;
  var BASE = new URL('./', me || location.href).href;
  function inside(u) {
    try { var x = new URL(u, location.href); return x.href.indexOf(BASE) === 0; } catch (e) { return false; }
  }
  function refuse(kind, u) { try { console.info('[archive] ' + kind + ' blocked: ' + u); } catch (e) {} }
  var f = window.fetch;
  if (f) window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!inside(u)) { refuse('fetch', u); return Promise.reject(new TypeError('Archived page: network request blocked')); }
    return f.call(this, input, init);
  };
  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    if (!inside(u)) { refuse('XHR', u); throw new TypeError('Archived page: network request blocked'); }
    return open.apply(this, arguments);
  };
  window.WebSocket = function (u) { refuse('WebSocket', u); throw new TypeError('Archived page: live connections blocked'); };
  window.EventSource = function (u) { refuse('EventSource', u); throw new TypeError('Archived page: live connections blocked'); };
  if (navigator.sendBeacon) navigator.sendBeacon = function (u) { refuse('beacon', u); return false; };
  window.RACEBOOK_ARCHIVE = { congress: '__CONGRESS__', label: '__LABEL__' };
  if (window.self !== window.top) document.documentElement.classList.add('arch-in-frame');
})();
"""

BANNER_CSS = ('<style id="arch-style">.arch-banner{position:relative;z-index:1;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;'
              'gap:4px 14px;padding:8px 16px;background:#1E2232;color:#F5F0E8;font:600 14px/1.4 Inter,Lato,system-ui,sans-serif;text-align:center}'
              '.arch-banner a{color:#F7C060;text-decoration:underline;text-underline-offset:2px;display:inline-flex;align-items:center;min-height:32px}'
              '.arch-in-frame .arch-banner{display:none}</style>')
BANNER_HTML = ('<div class="arch-banner" role="note"><span>' + BANNER + '. Read-only; figures are as they stood before polls closed.</span>'
               '<a href="../">All archives</a><a href="../../" target="_top">Live site</a></div>')


def transform_html(name, html):
    n0 = len(html)
    # Comment threads write to Supabase: drop the script, its stylesheet and the mount points.
    html = re.sub(r'\s*<script[^>]+src="comments\.js[^"]*"[^>]*></script>', '', html)
    html = re.sub(r'\s*<link[^>]+href="comments\.css[^"]*"[^>]*>', '', html)
    html = re.sub(r'\s*<div class="issues-comments">\s*<section data-comments="[^"]*"[^>]*></section>\s*</div>', '', html)
    html = re.sub(r'\s*<section data-comments="[^"]*"[^>]*></section>', '', html)
    assert 'comments.js' not in html and 'data-comments=' not in html, name
    # Guard first in <head>, banner first in <body>.
    html = re.sub(r'(<head[^>]*>)', r'\1\n<script src="archive-guard.js"></script>\n<meta name="robots" content="noindex">', html, count=1)
    html = re.sub(r'(</head>)', BANNER_CSS + r'\n\1', html, count=1)
    html = re.sub(r'(<body[^>]*>)', r'\1\n' + BANNER_HTML, html, count=1)
    title = re.search(r'<title>(.*?)</title>', html, re.S)
    if title and 'Archived' not in title.group(1):
        html = html.replace(title.group(0), '<title>' + title.group(1).strip() + ' (Archived, 119th Congress)</title>', 1)
    assert 'archive-guard.js' in html and 'arch-banner' in html, name
    return html


def norm(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z ]', '', s)


def surname(s):
    parts = [p for p in re.sub(r'\b(jr|sr|ii|iii|iv)\b', '', norm(s)).split() if p]
    return parts[-1] if parts else ''


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Racebook archive builder (usstudies@takshashila.org.in)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def crosscheck(factions):
    leg = fetch_json(LEGISLATORS_URL)
    try:
        c = fetch_json(LEGISLATORS_COMMITS)[0]
        ds_commit = {'sha': c['sha'], 'date': c['commit']['committer']['date']}
    except Exception as e:  # the cross-check still works without the commit id
        ds_commit = {'sha': None, 'error': str(e)}
    party = {'Democrat': 'D', 'Republican': 'R', 'Independent': 'I'}
    house, senate = {}, {}
    for m in leg:
        t = m['terms'][-1]
        rec = {'name': m['name'].get('official_full') or f"{m['name']['first']} {m['name']['last']}", 'last': m['name']['last'],
               'party': party.get(t['party'], t['party'][:1]), 'bioguide': m['id']['bioguide'], 'term_start': t['start']}
        if t['type'] == 'rep':
            if t['state'] not in STATES.values():
                continue                                    # non-voting delegates
            house[f"{t['state']}-{'AL' if t['district'] == 0 else str(t['district']).zfill(2)}"] = rec
        else:
            senate.setdefault(t['state'], []).append(rec)

    per_state = Counter(k.split('|')[0] for k in factions['houseMap'])
    site = {}
    for k, v in factions['houseMap'].items():
        st, dn = k.split('|')
        sid = f"{STATES[st]}-{'AL' if per_state[st] == 1 and STATES[st] in ('AK', 'DE', 'ND', 'SD', 'VT', 'WY') else str(int(dn)).zfill(2)}"
        site[sid] = {'name': v['name'], 'party': {'D': 'D', 'R': 'R'}.get(v['code'][1:2], 'I')}
    issues = []
    for sid in sorted(set(site) | set(house)):
        a, b = site.get(sid), house.get(sid)
        if not a:
            issues.append({'chamber': 'house', 'seat': sid, 'issue': 'member in dataset, seat missing on site', 'dataset': b['name']})
        elif not b:
            issues.append({'chamber': 'house', 'seat': sid, 'issue': 'member on site, seat vacant in dataset', 'site': a['name']})
        elif surname(a['name']) != surname(b['last']) and norm(b['last']) not in norm(a['name']):
            issues.append({'chamber': 'house', 'seat': sid, 'issue': 'different member', 'site': a['name'], 'dataset': b['name']})
        elif a['party'] != b['party']:
            issues.append({'chamber': 'house', 'seat': sid, 'issue': 'party differs', 'site': a['party'], 'dataset': b['party']})
    for st, members in factions['senateMap'].items():
        ab = STATES[st]
        s_site = {surname(x['name'].split('(')[0]): x for x in members}
        s_ds = {surname(x['last']): x for x in senate.get(ab, [])}
        for k in set(s_site) - set(s_ds):
            issues.append({'chamber': 'senate', 'seat': 'Senate-' + ab, 'issue': 'senator on site not in dataset', 'site': s_site[k]['name'].strip(),
                           'dataset': ', '.join(x['name'] for x in senate.get(ab, []) if surname(x['last']) not in s_site)})
    counts = {'house': dict(Counter(r['party'] for r in house.values())), 'house_seats_filled': len(house),
              'senate': dict(Counter(r['party'] for v in senate.values() for r in v)), 'senate_seats_filled': sum(len(v) for v in senate.values())}
    members = {'_about': 'Members of the 119th Congress from the unitedstates/congress-legislators dataset (legislators-current), '
                         'fetched when this archive was built. Seat ids use the site\'s canonical form.',
               'source': LEGISLATORS_URL, 'dataset_commit': ds_commit, 'counts': counts, 'house': house, 'senate': senate}
    report = {'_about': 'Cross-check of the archived site\'s member data (assets/factions119.json) against unitedstates/congress-legislators. '
                        'The archived site data is left exactly as it was; differences are listed here.',
              'source': LEGISLATORS_URL, 'dataset_commit': ds_commit, 'site_file': 'assets/factions119.json',
              'site_counts': {'house_seats_listed': len(site), 'senate_states_listed': len(factions['senateMap'])},
              'dataset_counts': counts, 'issues': issues}
    return members, report


def main():
    if OUT.exists() and any(OUT.iterdir()) and '--force' not in sys.argv:
        sys.exit(f'{OUT} already exists. The archive is frozen; pass --force to rebuild it from {SNAPSHOT}.')
    OUT.mkdir(parents=True, exist_ok=True)
    files = {}

    def put(rel, data):
        p = OUT / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        files[rel] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    for name in PAGES:
        put(name, transform_html(name, git_bytes(name).decode('utf-8')).encode('utf-8'))
    for name in DATA:
        put(name, git_bytes(name))
    for rel in git_files('assets/'):
        if rel not in SKIP_ASSETS:
            put(rel, git_bytes(rel))
    put('archive-guard.js', GUARD.replace('__CONGRESS__', CONGRESS).replace('__LABEL__', SNAPSHOT_LABEL).encode('utf-8'))

    factions = json.loads(git_bytes('assets/factions119.json'))
    members, report = crosscheck(factions)
    put('assets/congress-legislators-119.json', json.dumps(members, indent=1, ensure_ascii=False).encode('utf-8'))
    put('members-crosscheck.json', json.dumps(report, indent=2, ensure_ascii=False).encode('utf-8'))

    manifest = {'congress': CONGRESS, 'label': BANNER, 'snapshot_commit': SNAPSHOT, 'snapshot_time': snapshot_time(),
                'note': 'Built from git, not the working tree. Pages are read-only and archive-guard.js blocks every request outside this folder.',
                'contents': ['members and seat holdings (assets/factions119.json, data.json, assets/congress-legislators-119.json)',
                             'factions (assets/factions119.json)', 'ratings and polls (data.json)', 'seat briefs (assets/briefs.json)',
                             'state issue briefs (assets/state-issues.json)', "India's Interest (india.html, data.json)",
                             'Analysis & Commentary (analysis.json, analysis-manual.json)'],
                'files': dict(sorted(files.items()))}
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f'archive/{CONGRESS}: {len(files)} files from {SNAPSHOT} ({manifest["snapshot_time"]})')
    print('cross-check issues:', len(report['issues']))
    for i in report['issues']:
        print('  ', i)


if __name__ == '__main__':
    main()
