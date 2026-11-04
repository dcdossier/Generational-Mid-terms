/* Trends (map.html): live results in every tracked seat row, from the same reader as Home
 * (window.RacebookLive, "racebook:live" events; no fetch of its own).
 *   - Seat tables: each row's "Live result" cell (td[data-live-cell]) gets LiveSeat.summary.
 * The maps are the timeline map (assets/js/timeline-map.js), which reads the same state.
 * The Projected 120th Congress bars and Seats changing hands charts are balance.js, mounted
 * at the top of the page.
 */
(function () {
  'use strict';

  var last = null;

  function fillCells(s) {
    var L = window.LiveSeat; if (!L || !s) return;
    [].forEach.call(document.querySelectorAll('td[data-live-cell]'), function (td) {
      var h = L.summary(s, td.getAttribute('data-live-cell'));
      if (td._h !== h) { td.innerHTML = h; td._h = h; }
    });
  }

  function render(s) { if (!s) return; last = s; fillCells(s); }
  function init() {
    document.addEventListener('racebook:live', function (e) { render(e.detail); });
    if (window.RacebookLive && window.RacebookLive.ready) render(window.RacebookLive.state);
    // tables re-render on sort and filter: refill then
    var t = null, mo = new MutationObserver(function () { clearTimeout(t); t = setTimeout(function () { if (last) render(last); }, 60); });
    ['comp-tbody', 'race-tbody', 'gov-race-tbody'].forEach(function (id) {
      var el = document.getElementById(id); if (el) mo.observe(el, { childList: true });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
