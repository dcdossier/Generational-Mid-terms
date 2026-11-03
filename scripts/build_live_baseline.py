#!/usr/bin/env python3
"""Build assets/live-baseline.json: who held each seat before the election.

Reads only the frozen archive (archive/119/), so the baseline cannot drift:
  House    every district: the 119th Congress holder (assets/factions119.json),
           vacancies from the unitedstates/congress-legislators cross-check with
           the last holder's party. Districts in states using a new 2026 map get
           notional_party (the party expected under the new map), pre-filled from
           the Cook PVI in data.json where data.json has one, else left blank.
  Senate   the 35 seats up tonight (data.json races.senate)
  Governor the 36 races (data.json races.governor)
Flips compare with notional_party when it is set, otherwise with the 119th holder.
Hand-filled notional_party values already in assets/live-baseline.json are kept.

Also writes the Senate and Governor "seats up" summaries into assets/live-config.json.

    python3 scripts/build_live_baseline.py
"""
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARCH = ROOT / 'archive' / '119'
OUT = ROOT / 'assets' / 'live-baseline.json'
CONFIG = ROOT / 'assets' / 'live-config.json'

# States voting on a new 2026 map (Missouri's is blocked, Virginia's was struck down,
# Georgia keeps its 2024 map). Matches the note on Election Trends.
REDRAWN = ['AL', 'CA', 'FL', 'LA', 'NC', 'OH', 'TN', 'TX', 'UT']
# Seats vacant on 3 Nov 2026 and their last holder (2026 House elections page, Wikipedia).
VACANT = {'FL-20': {'party': 'D', 'last_holder': 'Sheila Cherfilus-McCormick', 'note': 'resigned 21 Apr 2026'},
          'TX-23': {'party': 'R', 'last_holder': 'Tony Gonzales', 'note': 'resigned 14 Apr 2026'}}
AT_LARGE = {'AK', 'DE', 'ND', 'SD', 'VT', 'WY'}
FOOTNOTE = "In redrawn states, gains and losses compare with the new district's expected party."
# 2022 totals are only comparable where the district lines are the same as in 2022.
LINES_CHANGED_2024 = ['GA', 'NY']          # redrawn for 2024 (AL, LA, NC, OH were too, and again for 2026)
VOTES_2022 = ROOT / 'data' / 'house-votes-2022.json'
EARLY = ROOT / 'data' / 'early-vote.json'

STATES = {'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT',
          'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
          'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI',
          'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH',
          'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
          'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN',
          'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY'}


def load(p):
    return json.loads((ARCH / p).read_text())


def main():
    data, factions = load('data.json'), load('assets/factions119.json')
    legis = load('assets/congress-legislators-119.json')
    old = json.loads(OUT.read_text()) if OUT.exists() else {}
    kept = {k: v for k, v in (old.get('house') or {}).items() if v.get('notional_source') == 'hand'}

    # 119th holders by seat id; the dataset gives every filled seat, factions119 the names the site shows
    holders = {}
    for sid, m in legis['house'].items():
        holders[sid] = {'party': m['party'], 'member': m['name']}
    for sid, v in VACANT.items():
        holders[sid] = {'party': v['party'], 'member': None, 'vacant': True, 'last_holder': v['last_holder'], 'vacancy_note': v['note']}
    # districts per state from the two sources together
    seats = sorted(holders)
    assert len(seats) == 435, len(seats)

    pvi = {r['district']: r.get('pvp') for r in data['races']['house']['competitive'] if r.get('district')}
    v22 = json.loads(VOTES_2022.read_text())
    state22 = {st: v['turn_2022'] for st, v in json.loads(EARLY.read_text())['states'].items() if v.get('turn_2022')}
    house, blank = {}, []
    for sid in seats:
        st = sid[:2]
        h = holders[sid]
        e = {'holder': h['party']}
        if h.get('vacant'):
            e.update({'vacant': True, 'last_holder': h['last_holder'], 'vacancy_note': h['vacancy_note']})
        else:
            e['member'] = h['member']
        if st in REDRAWN:
            e['votes_2022'] = None; e['baseline_note'] = 'new district, no 2022 baseline'
        elif st in LINES_CHANGED_2024:
            e['votes_2022'] = None; e['baseline_note'] = 'district redrawn in 2024, no 2022 baseline'
        elif sid in v22['uncontested']:
            e['votes_2022'] = None; e['baseline_note'] = 'uncontested in 2022, no vote held'
        else:
            e['votes_2022'] = v22['districts'].get(sid)
        if st in REDRAWN:
            e['redrawn'] = True
            if sid in kept:
                e['notional_party'] = kept[sid]['notional_party']; e['notional_source'] = 'hand'
            else:
                p = pvi.get(sid)
                m = re.match(r'^([DR])\+\d+', p or '')
                e['notional_party'] = m.group(1) if m else None
                e['notional_source'] = ('Cook PVI ' + p + ' (data.json)') if m else None
                if not m:
                    blank.append(sid)
        house[sid] = e

    senate = {}
    for r in data['races']['senate']['races']:
        senate['Senate-' + r['code']] = {'holder': r['party'], 'incumbent': r['incumbent'], 'state': r['state'], 'votes_2022': state22.get(r['code']),
                                         'baseline_note': None if state22.get(r['code']) else 'no 2022 statewide total in the source'}
    gov = {}
    for r in data['races']['governor']['races']:
        ab = STATES[r['state']]
        gov['Gov-' + ab] = {'holder': r['party'], 'incumbent': r['incumbent'], 'state': r['state'], 'votes_2022': state22.get(ab),
                            'baseline_note': None if state22.get(ab) else 'no 2022 statewide total in the source'}

    sh = Counter(v['holder'] for v in senate.values())
    gh = Counter(v['holder'] for v in gov.values())
    sb = data['races']['senate']['current_balance']
    gb = data['races']['governor']['current_balance']
    s_not_up = {'D': sb['d'] - sh['D'], 'R': sb['r'] - sh['R']}
    g_not_up = {'D': gb['d'] - gh['D'], 'R': gb['r'] - gh['R']}

    out = {
        '_about': 'Party holding each seat before the 2026 election, built from archive/119 by scripts/build_live_baseline.py. '
                  'House: 119th Congress holders; vacancies use the last holder\'s party. In redrawn states notional_party is the '
                  'party expected under the new map; flips use it when set, otherwise the 119th holder. Edit a notional_party by hand '
                  'and set notional_source to "hand" to keep it on the next build.',
        'source': 'archive/119 (snapshot ' + json.loads((ARCH / 'manifest.json').read_text())['snapshot_commit'] + ')',
        'redrawn_states': REDRAWN, 'footnote': FOOTNOTE,
        'votes_2022_source': {'house': 'data/house-votes-2022.json (Wikipedia per-state 2022 House results)',
                              'statewide': 'UF Election Lab early-vote file, turn_2022 (total ballots in 2022)'},
        'counts': {'house': dict(Counter(v['holder'] for v in house.values())), 'house_vacant': sorted(VACANT),
                   'house_redrawn': sum(1 for v in house.values() if v.get('redrawn')),
                   'house_notional_set': sum(1 for v in house.values() if v.get('notional_party')),
                   'senate_up': dict(sh), 'gov_up': dict(gh),
                   'house_with_2022_baseline': sum(1 for v in house.values() if v.get('votes_2022'))},
        'notional_blank': blank,
        'house': house, 'senate': senate, 'gov': gov}
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n')

    cfg = json.loads(CONFIG.read_text())
    cfg['senate_summary'] = {
        'up': len(senate), 'held_by': {'D': sh['D'], 'R': sh['R']}, 'not_up': s_not_up, 'not_up_note': {'D': 'incl. 2 independents'},
        'text': f"{len(senate)} seats up tonight: {sh['D']} held by Democrats, {sh['R']} held by Republicans · "
                f"Not up: Democrats {s_not_up['D']} (incl. 2 independents), Republicans {s_not_up['R']}."}
    cfg['gov_summary'] = {
        'up': len(gov), 'held_by': {'D': gh['D'], 'R': gh['R']}, 'not_up': g_not_up,
        'text': f"{len(gov)} races tonight: {gh['D']} held by Democrats, {gh['R']} held by Republicans · "
                f"Not up: Democrats {g_not_up['D']}, Republicans {g_not_up['R']}."}
    CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + '\n')

    print('house', out['counts']['house'], 'vacant', out['counts']['house_vacant'],
          'redrawn', out['counts']['house_redrawn'], 'notional set', out['counts']['house_notional_set'], 'blank', len(blank))
    print('senate up', dict(sh), 'not up', s_not_up, '| gov up', dict(gh), 'not up', g_not_up)
    print(cfg['senate_summary']['text'])
    by = {}
    for sid in blank:
        by.setdefault(sid[:2], []).append(sid[3:])
    for st in REDRAWN:
        if st in by:
            print(f'  {st}: {", ".join(by[st])}')


if __name__ == '__main__':
    main()
