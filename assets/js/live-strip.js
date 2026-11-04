/* Election-night status strip (any element with data-live-strip).
 * Before the first polls close: a countdown, ticking every minute.
 * While counting: elapsed time, races called by chamber, and the last update.
 * Final: a short note. Data comes from live.js ("racebook:live" events).
 * Under it, a refresh line: "Auto-updates every 5 min · next check in m:ss ·
 * last checked … · last change …", ticking every second, and an amber
 * "Updates delayed" badge when the Results Desk's last push is over 12 minutes old.
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
      '<span class="ls-item">' + (m.last_update ? 'Updated ' + esc(ist(m.last_update)) + ' (' + esc(sourceOf(st)) + ')' : 'Fox results loading') + '</span>'
    ];
    return '<div class="ls-row"><span class="ls-tag ls-tag-live"><span class="ls-dot" aria-hidden="true"></span>Counting active</span>' +
      parts.join('<span class="ls-sep" aria-hidden="true">&middot;</span>') + '</div>';
  }

  var STALE_MS = 12 * 60 * 1000;
  function istTime(t, secs) {
    var d = new Date(t); if (!t || isNaN(d)) return '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: secs ? '2-digit' : undefined, timeZone: 'Asia/Kolkata' }) + ' IST';
  }
  function mmss(ms) { ms = Math.max(0, ms); var m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000); return m + ':' + (s < 10 ? '0' : '') + s; }
  // "Live results: Fox News Decision Desk · Fox updated <IST> · next check m:ss";
  // "Updates delayed. Last good data <IST>." when Fox's file is stale or the last fetch failed.
  function refreshHtml(st) {
    var m = st.meta || {}, now = Date.now();
    var parts = ['Live results: <b class="ls-n">Fox News Decision Desk</b>'];
    if (m.last_update) parts.push('Fox updated ' + istTime(m.last_update));
    if (st.nextPollAt) parts.push('next check <b class="ls-n ls-count">' + mmss(st.nextPollAt - now) + '</b>');
    var delayed = !st.demo && st.loaded && st.connected === false;
    return (delayed ? '<span class="ls-delay" role="status">Updates delayed. Last good data ' + esc(istTime(m.last_push)) + '.</span>' : '') +
      '<span class="ls-ref-t">' + parts.join(' &middot; ') + '</span>';
  }

  // One line: national early votes (UF Election Lab), under the strip.
  function earlyHtml(st) {
    var ev = st.earlyVote; if (!ev || !ev.national) return '';
    var N = ev.national, M = ev.meta || {}, f = function (v) { return Number(v || 0).toLocaleString('en-US'); };
    var upd = M.file_updated ? new Date(M.file_updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
    return '<div class="ls-early">Early votes cast nationally: <b class="ls-n">' + f(N.total) + '</b> (mail ' + f(N.mail_returned) + ' · in person ' + f(N.in_person) + ') · ' +
      '<a href="' + esc(M.source_url || '#') + '" target="_blank" rel="noopener">UF Election Lab</a>' + (upd ? ', updated ' + esc(upd) : '') + '</div>';
  }

  var mounts = [], lastSt = null;
  function render(st) {
    if (!window.LiveMath) return;
    lastSt = st || (window.RacebookLive && window.RacebookLive.state) || {};
    mounts.forEach(function (el) {
      el.innerHTML = '<div class="ls-top">' + html(lastSt) + '</div><div class="ls-refresh">' + refreshHtml(lastSt) + '</div>' + earlyHtml(lastSt);
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
