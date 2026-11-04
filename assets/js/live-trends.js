/* Trends (map.html): live results on every tracked seat, from the same reader as Home
 * (window.RacebookLive, "racebook:live" events; no fetch of its own).
 *   - Seat tables: each row's "Live result" cell (td[data-live-cell]) gets LiveSeat.summary.
 *   - Maps (House, Senate, Governor): called seats in the winner's colour, leading seats in
 *     a light tint, flips outlined in coral; tooltips add the live line. Ratings colours
 *     come back if live data goes away.
 * The Projected 120th Congress bars and Seats changing hands charts are balance.js, mounted
 * at the top of the page.
 */
(function () {
  'use strict';

  var ST = { Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY' };
  var FILL = { D: '#1f3a8a', R: '#9b1c1c', I: '#6b5b95' }, TINT = { D: '#b9c8ec', R: '#f1c4c4', I: '#d5cde6' }, FLIP = '#E8735A';
  var MAPS = { 'house-svg': 'house', 'senate-svg': 'senate', 'gov-svg': 'gov' };
  var last = null;

  function st() { return window.RacebookLive && window.RacebookLive.ready ? window.RacebookLive.state : last; }
  function on(s) { return s && s.races && s.races.some(function (r) { return r.winner || r.pct_counted > 0; }); }

  // Seat ID for a map path: tracked seats carry data-seat-id; other House districts from the shape.
  function pathId(el, kind) {
    var id = el.getAttribute('data-seat-id'); if (id) return id;
    var p = el.__data__ && el.__data__.properties; if (!p) return null;
    if (kind === 'house') {
      var a = ST[p.state]; if (!a) return null;
      var n = Number(p.district);
      return a + '-' + (n > 0 ? String(n).padStart(2, '0') : 'AL');
    }
    var b = ST[p.NAME]; return b ? (kind === 'senate' ? 'Senate-' : 'Gov-') + b : null;
  }
  function rowFor(s, id) {
    var L = window.LiveSeat, r = L.row(s, id);
    if (!r && /-01$/.test(id)) r = L.row(s, id.replace(/-01$/, '-AL'));
    return r;
  }

  function paintMaps(s) {
    var M = window.LiveMath, live = on(s);
    Object.keys(MAPS).forEach(function (svgId) {
      var svg = document.getElementById(svgId); if (!svg) return;
      var kind = MAPS[svgId];
      [].forEach.call(svg.querySelectorAll('path'), function (el) {
        var id = pathId(el, kind), r = live && id ? rowFor(s, id) : null;
        var win = r && M ? M.winnerOf(r) : null, lead = r && !win && r.pct_counted > 0 && M ? M.leaderOf(r) : null;
        if (!el.hasAttribute('data-rating-fill')) el.setAttribute('data-rating-fill', el.style.fill || '');
        if (win || lead) {
          var p = FILL[win || lead] ? (win || lead) : 'I';
          el.style.fill = win ? FILL[p] : TINT[p];
          el.style.stroke = win && r.flipped ? FLIP : '#fff';
          el.style.strokeWidth = win && r.flipped ? (kind === 'house' ? '1.2px' : '2px') : '';
          el.setAttribute('data-live-id', r.race_id);
        } else if (el.hasAttribute('data-live-id')) {
          el.style.fill = el.getAttribute('data-rating-fill'); el.style.stroke = '#fff'; el.style.strokeWidth = ''; el.removeAttribute('data-live-id');
        }
      });
      // labels on the state maps sit on the fill: white on solid, dark on tint
      [].forEach.call(svg.querySelectorAll('text'), function (t) {
        if (!t.hasAttribute('data-rating-fill')) t.setAttribute('data-rating-fill', t.style.fill || '');
        var p = t.__data__ && t.__data__.properties, b = p && ST[p.NAME], r = live && b ? rowFor(s, (kind === 'senate' ? 'Senate-' : 'Gov-') + b) : null;
        var w = r && M ? M.winnerOf(r) : null, l = r && !w && r.pct_counted > 0;
        t.style.fill = w ? '#fff' : l ? '#1c2430' : t.getAttribute('data-rating-fill');
      });
      keyFor(svg, live);
    });
  }
  function keyFor(svg, live) {
    var wrap = svg.closest('.d3-map-wrap'); if (!wrap) return;
    var k = wrap.previousElementSibling && wrap.previousElementSibling.classList.contains('lt-key') ? wrap.previousElementSibling : null;
    if (!live) { if (k) k.hidden = true; return; }
    if (!k) { k = document.createElement('div'); k.className = 'lt-key'; wrap.parentNode.insertBefore(k, wrap); }
    k.hidden = false;
    k.innerHTML = 'Live results (Fox News Decision Desk): <i style="background:' + FILL.D + '"></i><i style="background:' + FILL.R + '"></i>Won ' +
      '<i style="background:' + TINT.D + '"></i><i style="background:' + TINT.R + '"></i>Leading, not called ' +
      '<i class="lt-key-flip"></i>Flipped · other seats keep their rating colour until votes are counted';
  }

  function fillCells(s) {
    var L = window.LiveSeat; if (!L || !s) return;
    [].forEach.call(document.querySelectorAll('td[data-live-cell]'), function (td) {
      var h = L.summary(s, td.getAttribute('data-live-cell'));
      if (td._h !== h) { td.innerHTML = h; td._h = h; }
    });
  }

  // Map tooltips: add the live line under the ratings text.
  function wrapTip() {
    if (typeof window.showTip !== 'function' || window.showTip._live) return;
    var orig = window.showTip;
    window.showTip = function (e, html) {
      var s = st(), el = e && e.target && e.target.closest ? e.target.closest('path') : null, extra = '';
      if (s && on(s) && el && window.LiveSeat) {
        var svg = el.ownerSVGElement, kind = svg && MAPS[svg.id], id = kind ? pathId(el, kind) : null, r = id ? rowFor(s, id) : null;
        if (r) extra = '<div class="lt-tip">' + window.LiveSeat.summary(s, r.race_id) + '</div>';
      }
      return orig.call(this, e, html + extra);
    };
    window.showTip._live = true;
  }

  function render(s) {
    if (!s) return; last = s;
    fillCells(s); paintMaps(s);
  }
  function init() {
    wrapTip();
    document.addEventListener('racebook:live', function (e) { render(e.detail); });
    if (window.RacebookLive && window.RacebookLive.ready) render(window.RacebookLive.state);
    // tables re-render on sort and filter, maps draw when their tab opens: refill then
    var t = null, mo = new MutationObserver(function () { clearTimeout(t); t = setTimeout(function () { if (last) render(last); }, 60); });
    ['comp-tbody', 'race-tbody', 'gov-race-tbody', 'house-svg', 'senate-svg', 'gov-svg'].forEach(function (id) {
      var el = document.getElementById(id); if (el) mo.observe(el, { childList: true, subtree: id.indexOf('svg') < 0 ? false : true });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
