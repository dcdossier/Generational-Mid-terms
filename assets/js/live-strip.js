/* Election-night status strip (any element with data-live-strip).
 * Before the first polls close: a countdown, ticking every minute.
 * While counting: elapsed time, races called by chamber, and the last update.
 * Final: a short note. Data comes from live.js ("racebook:live" events).
 * Under it, one refresh line: "Next update in m:ss", ticking every second.
 */
(function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function hm(ms) {
    ms = Math.max(0, ms);
    var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
    return (h ? h + 'h ' : '') + m + 'm';
  }
  function ist(iso) {
    var d = new Date(iso); if (!iso || isNaN(d)) return '';
    return d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).replace(',', '') + ' IST';
  }

  function sourceOf(st) {
    var src = (st.chambers || []).map(function (c) { return c.source; }).filter(Boolean)[0];
    return src || 'Fox News';
  }

  // Turnout so far against 2022: all votes (UF Election Lab ballots) and each party's House vote
  // (Office of the Clerk). Counting continues, so a fall can still close as the last states report.
  var hist = null;
  fetch('data/turnout-history.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { hist = j; if (lastSt) render(lastSt); }).catch(function () {});
  function mil(n) { return (n / 1e6).toFixed(1) + 'M'; }
  function vs(now, then) {
    var d = now - then, pc = then ? d / then * 100 : 0, up = d >= 0;
    return '<span class="ls-tv ls-tv-' + (up ? 'up' : 'down') + '"><span aria-hidden="true">' + (up ? '▲' : '▼') + '</span> ' + (up ? 'up' : 'down') + ' ' + Math.abs(pc).toFixed(1) + '% (' + (up ? '+' : '−') + mil(Math.abs(d)) + ')</span>';
  }
  function turnoutItem(st) {
    var y = hist && hist.years.filter(function (x) { return x.year === 2022; })[0], hv = hist && hist.house_vote_2022, T = window.LiveMath.turnout(st);
    if (!y || !T.total) return '';
    return '<span class="ls-item ls-turn" title="2022: ' + mil(y.ballots) + ' ballots (UF Election Lab); House vote R ' + mil(hv.R) + ', D ' + mil(hv.D) + ' (Office of the Clerk). Counting continues.">' +
      'Turnout <b class="ls-n">' + mil(T.total) + '</b> ' + vs(T.total, y.ballots) + ' on 2022' +
      (hv ? ' <span class="ls-by">· Rep vote ' + mil(T.house.R) + ' ' + vs(T.house.R, hv.R) + ' · Dem vote ' + mil(T.house.D) + ' ' + vs(T.house.D, hv.D) + '</span>' : '') + '</span>';
  }

  function html(st) {
    var L = window.LiveMath, m = st.meta || {}, now = Date.now();
    var ph = L.phase(m, now);
    var close = new Date(m.polls_first_close || L.FIRST_CLOSE).getTime();
    if (ph === 'pre') {
      return '<div class="ls-row"><span class="ls-tag ls-tag-pre">Election Day</span>' +
        '<span class="ls-main">Polls close in <b class="ls-n">' + hm(close - now) + '</b></span></div>' +
        '<div class="ls-sub">First polls close 6 pm ET (04:30 IST). Last close 1 am ET (11:30 IST, Alaska).</div>';
    }
    if (ph === 'final') {
      return '<div class="ls-row"><span class="ls-tag ls-tag-final">Final</span>' +
        '<span class="ls-main">Counting continues in slow states.' + (m.last_update ? ' Last update ' + esc(ist(m.last_update)) + '.' : '') + '</span></div>';
    }
    var c = L.called(st.chambers), U = L.RACES_UP;
    var start = new Date(m.counting_started || m.polls_first_close || L.FIRST_CLOSE).getTime();
    var parts = [
      '<span class="ls-item"><b class="ls-n">' + hm(now - start) + '</b></span>',
      '<span class="ls-item"><b class="ls-n">' + c.total + '</b> of ' + c.up + ' races called ' +
        '<span class="ls-by">(House ' + c.house + '/' + U.house + ' &middot; Senate ' + c.senate + '/' + U.senate + ' &middot; Governors ' + c.gov + '/' + U.gov + ')</span></span>',
      '<span class="ls-item"><b class="ls-n">' + c.counting + '</b> still counting</span>',
      turnoutItem(st),
      '<span class="ls-item">' + (m.last_update ? 'Updated ' + esc(ist(m.last_update)) + ' (' + esc(sourceOf(st)) + ')' : 'Fox results loading') + '</span>'
    ];
    return '<div class="ls-row"><span class="ls-tag ls-tag-live"><span class="ls-dot" aria-hidden="true"></span>Counting active</span>' +
      parts.join('<span class="ls-sep" aria-hidden="true">&middot;</span>') + '</div>';
  }

  function mmss(ms) { ms = Math.max(0, ms); var m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000); return m + ':' + (s < 10 ? '0' : '') + s; }
  // "Next update in m:ss" and nothing else.
  function refreshHtml(st) {
    return st.nextPollAt ? '<span class="ls-ref-t">Next update in <b class="ls-n ls-count">' + mmss(st.nextPollAt - Date.now()) + '</b></span>' : '';
  }

  var mounts = [], lastSt = null;
  function render(st) {
    if (!window.LiveMath) return;
    lastSt = st || (window.RacebookLive && window.RacebookLive.state) || {};
    mounts.forEach(function (el) {
      el.innerHTML = '<div class="ls-top">' + html(lastSt) + '</div><div class="ls-refresh">' + refreshHtml(lastSt) + '</div>';
      el.hidden = false;
    });
  }
  function tick() {   // the countdown, every second, without redrawing the strip
    if (!window.LiveMath || !lastSt) return;
    mounts.forEach(function (el) { var r = el.querySelector('.ls-refresh'); if (r) r.innerHTML = refreshHtml(lastSt); });
  }

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-live-strip]'));
    if (!mounts.length) return;
    // No live region: the countdown changes every minute and would be read out each time.
    mounts.forEach(function (el) { el.classList.add('ls'); el.setAttribute('aria-label', 'Election status'); });
    if (!/[?&]demo=1\b/.test(location.search)) render({});   // the countdown needs no data
    document.addEventListener('racebook:live', function (e) { render(e.detail); });
    setInterval(tick, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
