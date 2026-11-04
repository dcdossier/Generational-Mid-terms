/* Info row under the projected balance (any element with data-live-info): five cells.
 *   a. Flips per chamber and party (Fox: flipped_to, net_gain) and progress to a majority
 *   b. Litigation and interference (data/litigation.json), opening to the list
 *   c. Turnout rates: 2026 against 2022, as a share of eligible voters and in votes, nationally
 *      and for the states that have finished counting
 *   d. Polls: countdown to the last poll close (Alaska), then when all polls closed
 *   e. Counting: races still uncalled per chamber; never an estimated finish time
 * Data from live.js ("racebook:live" events).
 */
(function () {
  'use strict';

  var MAJ = { house: { D: 218, R: 218, I: 218 }, senate: { D: 51, R: 50, I: 51 }, gov: { D: 26, R: 26, I: 26 } };
  var NAME = { house: 'House', senate: 'Senate', gov: 'Governors' };
  var PARTY = { D: 'Democrats', R: 'Republicans' };
  var ST = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
  var votes22 = null, history = null, mounts = [], last = null, uid = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function mil(n) { return (n / 1e6).toFixed(1) + 'M'; }
  function ist(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).replace(',', '') + ' IST'; }
  function hms(ms) { ms = Math.max(0, ms); var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); s = s % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function now(st) { return st && typeof st.now === 'function' ? st.now() : Date.now(); }
  function cd(at) { return '<b class="li-cd" data-cd="' + at + '">' + hms(at - Date.now()) + '</b>'; }

  function flipsCell(st) {
    var rows = ['house', 'senate', 'gov'].map(function (k) {
      var f = st.flips && st.flips[k];
      if (!f) return '';
      return '<div class="li-ch"><b>' + NAME[k] + '</b>' + ['D', 'R'].map(function (p) {
        var x = f[p] || { gained: 0, lost: 0, net: 0 };
        var c = (st.chambers || []).filter(function (r) { return r.chamber === k && r.party === p; })[0] || { won: 0, not_up: 0 };
        var total = (c.not_up || 0) + (c.won || 0), maj = MAJ[k][p], won = x.majority_called || total >= maj;
        return '<div class="li-party li-' + p.toLowerCase() + '">' + PARTY[p] + ': gained ' + x.gained + ', lost ' + x.lost + ', net ' + (x.net > 0 ? '+' : x.net < 0 ? '−' : '') + Math.abs(x.net) +
          ' · ' + total + '/' + maj + ' <span class="' + (won ? 'li-won' : 'li-not') + '">(' + (won ? 'MAJORITY WON' : 'majority not yet') + ')</span></div>';
      }).join('') + '</div>';
    }).join('');
    return '<h3 class="li-h">Flips</h3>' + (rows || '<p class="li-muted">No results yet.</p>') +
      (st.flips && st.flips.senate ? '<p class="li-note">Senate majority: 51 for Democrats, 50 for Republicans (the Vice President breaks ties). Counts include seats not up this year.</p>' : '');
  }

  function litCell(st) {
    var L = st.litigation, e = (L && L.entries) || [], c = (L && L.counts) || { lawsuits: 0, interference: 0 };
    var list = e.length ? '<ul class="li-list">' + e.map(function (x) {
      return '<li><span class="li-tag li-tag-' + x.type + '">' + (x.type === 'lawsuit' ? 'Lawsuit' : 'Interference') + '</span> ' +
        '<b>' + esc(x.race_id || ST[x.state] || x.state) + '</b>: ' + esc(x.summary) + '<br>' +
        x.sources.map(function (s) { return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.publisher) + '</a>'; }).join(' · ') + '</li>';
    }).join('') + '</ul>' : '<p class="li-muted">Nothing reported by 2 or more publishers yet.</p>';
    return '<h3 class="li-h">Litigation and interference</h3><details class="li-det"><summary>' + c.lawsuits + ' lawsuit' + (c.lawsuits === 1 ? '' : 's') + ' · ' +
      c.interference + ' interference report' + (c.interference === 1 ? '' : 's') + '</summary>' + list +
      '<p class="li-note">From Ground News and our news feeds; an entry needs 2 distinct publishers.' + (L && L.updated ? ' Checked ' + ist(L.updated) + '.' : '') + '</p></details>';
  }

  // Turnout against 2022 (UF Election Lab: national ballots and turnout of eligible voters,
  // and total ballots per state). 2026 votes per state are the largest count among its races
  // (a statewide race, or the House districts added up), so every ballot cast is counted once.
  var MIN_STATES = 5;
  function stateVotes(st) { return window.LiveMath.turnout(st).states; }
  function signed(n, f) { return (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n)); }
  function change(now, then, label) {
    var d = now - then, pc = then ? d / then * 100 : 0, up = d >= 0;
    return '<p class="li-trend li-trend-' + (up ? 'up' : 'down') + '"><span class="li-arrow" aria-hidden="true">' + (up ? '▲' : '▼') + '</span> ' +
      '<b>' + signed(d, mil) + ' (' + signed(pc, function (v) { return v.toFixed(1) + '%'; }) + ')</b> on 2022 <span class="li-small">' + label + '</span>' +
      '<span class="sr-only"> ' + (up ? 'Up' : 'Down') + ' ' + mil(Math.abs(d)) + ' votes, ' + Math.abs(pc).toFixed(1) + ' per cent, on 2022.</span></p>';
  }

  function turnoutCell(st) {
    var y22 = history && history.years.filter(function (y) { return y.year === 2022; })[0];
    var evs = (st.earlyVote && st.earlyVote.states) || {}, by = stateVotes(st);
    var total = Object.keys(by).reduce(function (a, s) { return a + by[s].votes; }, 0);
    var id = 'li-tip-' + (++uid);
    var tip = history ? '<span class="li-tip" id="' + id + '" role="tooltip" hidden>Turnout of eligible voters (VEP), national: ' +
      history.years.map(function (y) { return y.year + ' ' + y.vep_pct.toFixed(1) + '% (' + y.kind + ')'; }).join(' · ') +
      '. The 2026 rate divides votes counted so far by the 2022 eligible population, so it is an estimate until UF publishes 2026 figures. Source: <a href="' + esc(history.source_url) + '" target="_blank" rel="noopener">UF Election Lab</a>.</span>' : '';
    var h = '<h3 class="li-h">Turnout rates ' + (tip ? '<button type="button" class="li-i" aria-expanded="false" aria-controls="' + id + '" aria-label="About turnout rates"></button>' : '') + '</h3>' + tip;
    if (y22 && total) {
      var vep = y22.ballots / (y22.vep_pct / 100), rate = total / vep * 100;
      h += '<p class="li-big">2026: <b>' + rate.toFixed(1) + '%</b> of eligible voters so far · 2022: <b>' + y22.vep_pct.toFixed(1) + '%</b></p>' +
        '<p>Votes counted: <b>' + mil(total) + '</b> · 2022 total: ' + mil(y22.ballots) + '</p>' +
        change(total, y22.ballots, '(nationally, counting continues)');
    } else h += '<p class="li-big">Votes counted: <b>' + mil(total) + '</b></p>';
    // like for like: states at least 95% counted
    var now = 0, then = 0, n = 0;
    Object.keys(by).forEach(function (s) { var e = evs[s]; if (e && e.turn_2022 && by[s].counted >= 95 && by[s].votes) { now += by[s].votes; then += e.turn_2022; n++; } });
    if (n >= MIN_STATES) h += change(now, then, '(' + n + ' states at least 95% counted: ' + mil(now) + ' against ' + mil(then) + ')');
    return h;
  }

  function lastClose(st) {
    var pc = st.pollClose; if (!pc) return null;
    var t = 0; Object.keys(pc.states).forEach(function (k) { t = Math.max(t, Date.parse(pc.states[k].last_close_utc)); });
    return t || null;
  }
  function pollsCell(st) {
    var t = lastClose(st); if (!t) return '<h3 class="li-h">Polls</h3><p class="li-muted">Poll times unavailable.</p>';
    return '<h3 class="li-h">Polls</h3>' + (now(st) < t ? '<p class="li-big">Last polls close in ' + cd(t) + '</p><p class="li-small">Alaska, 1 am ET (11:30 IST)</p>'
      : '<p class="li-big">All polls closed</p><p>' + ist(new Date(t).toISOString()) + '</p>');
  }
  function countingCell(st) {
    var f = st.flips || {}, t = lastClose(st);
    var rem = function (k) { return f[k] && f[k].remaining != null ? f[k].remaining : '—'; };
    return '<h3 class="li-h">Counting</h3><p class="li-big">Still counting: House ' + rem('house') + ' · Senate ' + rem('senate') + ' · Governors ' + rem('gov') + '</p>' +
      (t && now(st) < t ? '<p class="li-small">Last counting starts in ' + cd(t) + '</p>' : '');
  }

  // "Live trends": one collapsible panel (closed by default, remembers this viewer's choice);
  // the grid inside is redrawn on every update without closing the panel.
  var FOLD_KEY = 'li-fold';
  function fold(el) {
    var d = el.querySelector('.li-fold');
    if (d) return d.querySelector('.li-grid');
    el.innerHTML = '<details class="li-fold"><summary class="li-fold-s"><h2 class="li-title">Live trends</h2>' +
      '<span class="li-fold-sub">Flips, litigation, turnout rates, polls and counting</span><span class="li-fold-hint" aria-hidden="true"></span></summary><div class="li-grid"></div></details>';
    d = el.querySelector('.li-fold');
    try { if (localStorage.getItem(FOLD_KEY) === 'open') d.open = true; } catch (e) {}
    d.addEventListener('toggle', function () { try { localStorage.setItem(FOLD_KEY, d.open ? 'open' : 'closed'); } catch (e) {} });
    return d.querySelector('.li-grid');
  }
  function render(st) {
    if (!st) return; last = st;
    mounts.forEach(function (el) {
      var g = fold(el), open = g.querySelector('.li-det[open]') ? 1 : 0;
      g.innerHTML = '<div class="li-cell li-flips">' + flipsCell(st) + '</div><div class="li-cell">' + litCell(st) + '</div><div class="li-cell">' + turnoutCell(st) + '</div>' +
        '<div class="li-cell">' + pollsCell(st) + '</div><div class="li-cell">' + countingCell(st) + '</div>';
      if (open) { var d = g.querySelector('.li-det'); if (d) d.open = true; }
      el.hidden = false;
    });
  }
  function tick() { [].forEach.call(document.querySelectorAll('.li-cd[data-cd]'), function (e) { e.textContent = hms(+e.getAttribute('data-cd') - Date.now()); }); }

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-live-info]'));
    if (!mounts.length) return;
    mounts.forEach(function (el) {
      el.classList.add('li');
      el.addEventListener('click', function (e) {
        var b = e.target.closest('.li-i'); if (!b) return;
        var tip = document.getElementById(b.getAttribute('aria-controls')); if (!tip) return;
        tip.hidden = !tip.hidden; b.setAttribute('aria-expanded', String(!tip.hidden));
      });
    });
    Promise.all(['data/house-votes-2022.json', 'data/turnout-history.json'].map(function (u) { return fetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }))
      .then(function (r) { votes22 = r[0]; history = r[1]; if (last) render(last); });
    document.addEventListener('racebook:live', function (e) { render(e.detail); });
    if (window.RacebookLive && window.RacebookLive.ready) render(window.RacebookLive.state);
    setInterval(tick, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
