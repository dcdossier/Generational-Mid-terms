/* Election-night status strip (any element with data-live-strip).
 * Before the first polls close: a countdown, ticking every minute.
 * While counting: elapsed time, races called by chamber, and the last update.
 * Final: a short note. Data comes from live.js ("racebook:live" events).
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
    return src || 'Results Desk';
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
      '<span class="ls-item">' + (m.last_update ? 'Updated ' + esc(ist(m.last_update)) + ' (' + esc(sourceOf(st)) + ')' : 'Awaiting first results') + '</span>'
    ];
    return '<div class="ls-row"><span class="ls-tag ls-tag-live"><span class="ls-dot" aria-hidden="true"></span>Counting active</span>' +
      parts.join('<span class="ls-sep" aria-hidden="true">&middot;</span>') + '</div>';
  }

  var mounts = [];
  function render(st) {
    if (!window.LiveMath) return;
    mounts.forEach(function (el) { el.innerHTML = html(st || (window.RacebookLive && window.RacebookLive.state) || {}); el.hidden = false; });
  }

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-live-strip]'));
    if (!mounts.length) return;
    // No live region: the countdown changes every minute and would be read out each time.
    mounts.forEach(function (el) { el.classList.add('ls'); el.setAttribute('aria-label', 'Election status'); });
    if (!/[?&]demo=1\b/.test(location.search)) render({});   // the countdown needs no data
    document.addEventListener('racebook:live', function (e) { render(e.detail); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
