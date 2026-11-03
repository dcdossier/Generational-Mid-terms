#!/usr/bin/env python3
"""2022 general-election total votes per House district -> data/house-votes-2022.json.

Source: Wikipedia's "2022 United States House of Representatives elections in <State>"
pages (each district's general-election results box; ranked-choice tables for AK and
ME-02). The MIT Election Data + Science Lab file needs a guestbook form to download,
so it is not used. Totals are on the 2022 district lines.

    python3 scripts/build_votes_2022.py
"""
import json, re, time, urllib.parse, urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'house-votes-2022.json'
UA = {'User-Agent': 'Racebook (usstudies@takshashila.org.in)'}
STATES = {'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
          'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS', 'Kentucky': 'KY',
          'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
          'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
          'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
          'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY'}
AT_LARGE = {'AK', 'DE', 'ND', 'SD', 'VT', 'WY'}
UNCONTESTED = {'LA-04': 'Mike Johnson was unopposed in 2022 (no vote held)'}


def raw(title):
    u = 'https://en.wikipedia.org/w/index.php?' + urllib.parse.urlencode({'title': title, 'action': 'raw', 'redirects': 1})
    return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40).read().decode('utf-8')


def num(s): return int(re.sub(r'[^\d]', '', s))
def box_max(text):
    v = [num(x) for x in re.findall(r'Election box total[^}]*?votes\s*=\s*([\d,]+)', text, re.I)]
    return max(v) if v else None
def table_total(text):
    i = text.find("'''Total votes'''")
    if i < 0: return None
    v = [num(x) for x in re.findall(r"([\d]{1,3}(?:,\d{3})+)", text[i:i + 500])]
    return max(v) if v else None


def main():
    out, pages = {}, {}
    for name, st in STATES.items():
        title = f"2022 United States House of Representatives election{'' if st in AT_LARGE else 's'} in {name}"
        t = raw(title); pages[st] = 'https://en.wikipedia.org/wiki/' + urllib.parse.quote(title.replace(' ', '_'))
        time.sleep(0.3)
        if st in AT_LARGE:
            v = table_total(t) if st == 'AK' else box_max(t)
            if v: out[f'{st}-AL'] = v
            continue
        parts = re.split(r'\n==+\s*District\s+(\d+)\s*==+\s*\n', t)
        for i in range(1, len(parts) - 1, 2):
            d = str(int(parts[i])).zfill(2); sec = parts[i + 1]
            nxt = re.search(r'\n==\s*[^=]', sec); sec = sec[:nxt.start()] if nxt else sec
            v = (table_total(sec) if f'{st}-{d}' == 'ME-02' else None) or box_max(sec)
            if v: out[f'{st}-{d}'] = v
    doc = {'_about': '2022 general-election total votes per House district, on the 2022 district lines. Source: Wikipedia per-state 2022 House election pages '
                     '(results boxes; ranked-choice tables for AK-AL and ME-02). Built by scripts/build_votes_2022.py.',
           'total': sum(out.values()), 'uncontested': UNCONTESTED, 'source_pages': pages, 'districts': dict(sorted(out.items()))}
    OUT.write_text(json.dumps(doc, indent=1) + '\n')
    print(len(out), 'districts;', doc['total'], 'votes')


if __name__ == '__main__':
    main()
