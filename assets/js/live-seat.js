/* Per-seat live lines, shared by the battleground boxes, the seat panel and the status strip.
 *
 *   status(state, id)   before polls close: "Polls close 8 pm ET (06:30 IST) · counting starts in 1h 5m"
 *                       then "Counting · 64% counted", then "Called 9:42 pm ET (08:12 IST)"
 *   votes(state, id)    "Votes counted: 812,400 (61% of 2022 total)"; redrawn districts get the
 *                       count only, with "new district, no 2022 baseline"
 *   mailNote(state, id) states that may only start processing mail ballots on Election Day
 *   nextClose(state)    the next poll-closing time and the states closing then
 *
 * Poll-closing times come from data/poll-close.json and are used only once its
 * "approved" flag is true (or in ?demo=1). Results come from live.js state.
 */
(function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function stateOf(id) { var m = /^(?:Senate-|Gov-)?([A-Z]{2})/.exec(id || ''); return m ? m[1] : null; }
  function now(st) { return st && typeof st.now === 'function' ? st.now() : Date.now(); }
  function enabled(st) { return !!(st && st.pollClose && (st.pollClose.approved || st.demo)); }
  function pc(st, id) { return enabled(st) ? st.pollClose.states[stateOf(id)] || null : null; }
  function row(st, id) {
    var list = (st && st.races) || [];
    for (var i = 0; i < list.length; i++) if (list[i].race_id === id) return list[i];
    return null;
  }
  function hm(ms) {
    ms = Math.max(0, ms); var h = Math.floor(ms / 3600000), m = Math.ceil(ms % 3600000 / 60000);
    if (m === 60) { h++; m = 0; }
    return h ? h + 'h ' + m + 'm' : m + 'm';
  }
  function clock(iso, tz) {
    var d = new Date(iso); if (!iso || isNaN(d)) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, hour12: tz !== 'Asia/Kolkata' }).replace(':00', '').replace(' AM', ' am').replace(' PM', ' pm');
  }
  function etIst(iso) { return clock(iso, 'America/New_York') + ' ET (' + clock(iso, 'Asia/Kolkata') + ' IST)'; }
  function closeText(p) {
    if (!p.split) return p.first_close.et + ' (' + p.first_close.ist + ')';
    return p.first_close.et.replace(' ET', '') + '–' + p.last_close.et + ' (' + p.first_close.ist.replace(' IST', '') + '–' + p.last_close.ist + ')';
  }

  function status(st, id) {
    var L = window.LiveMath, r = row(st, id), p = pc(st, id), t = now(st);
    if (r && L && L.winnerOf(r)) {
      var conf = Array.isArray(r.confirmations) ? r.confirmations : [];
      if (conf.length) return { phase: 'called', conf: conf, text: 'Called · confirmed by ' + conf.length + ' source' + (conf.length === 1 ? '' : 's') + (r.called_at ? ' · ' + etIst(r.called_at) : '') };
      return { phase: 'called', text: 'Called' + (r.called_at ? ' ' + etIst(r.called_at) : '') + (r.called_by ? ' by ' + r.called_by : '') };
    }
    var counted = r && r.pct_counted != null && r.pct_counted !== '' ? Number(r.pct_counted) : null;
    if (p && t < Date.parse(p.first_close_utc)) {
      return { phase: 'before', text: 'Polls close ' + closeText(p) + ' · counting starts in ' + hm(Date.parse(p.first_close_utc) - t) };
    }
    if (p || counted !== null) {
      return { phase: 'counting', text: 'Counting · ' + (counted !== null ? Math.round(counted) + '% counted' : 'no results yet') };
    }
    return { phase: null, text: '' };
  }

  function votes(st, id) {
    var r = row(st, id), b = st && st.baseline;
    var kind = /^Senate-/.test(id) ? 'senate' : /^Gov-/.test(id) ? 'gov' : 'house';
    var base = b && b[kind] && b[kind][id];
    var n = r && r.total_votes != null ? Number(r.total_votes) : null;
    if (n === null || !isFinite(n)) return '';
    var s = 'Votes counted: ' + n.toLocaleString('en-US');
    if (base && base.votes_2022) s += ' (' + Math.round(n / base.votes_2022 * 100) + '% of 2022 total)';
    else if (base && base.baseline_note) s += ' · ' + base.baseline_note;
    return s;
  }

  function mailNote(st, id) {
    var p = pc(st, id);
    return p && p.mail && p.mail.late ? p.mail.note : '';
  }

  // The next closing time after now, and which states (or parts of states) close then.
  function nextClose(st) {
    if (!enabled(st)) return null;
    var t = now(st), best = null, names = [];
    Object.keys(st.pollClose.states).forEach(function (k) {
      var p = st.pollClose.states[k];
      [[p.first_close_utc, p.split ? 'parts of ' + p.name : p.name], p.split ? [p.last_close_utc, 'rest of ' + p.name] : null].forEach(function (x) {
        if (!x) return;
        var at = Date.parse(x[0]);
        if (at <= t) return;
        if (best === null || at < best) { best = at; names = [x[1]]; }
        else if (at === best) names.push(x[1]);
      });
    });
    return best === null ? null : { at: best, inMs: best - t, states: names, et: etIst(new Date(best).toISOString()) };
  }

  // One line for the seat's state: early votes (UF Election Lab).
  function earlyLine(st, id) {
    var ev = st.earlyVote, e = ev && ev.states && ev.states[stateOf(id)];
    if (!e || !e.total) return '';
    var upd = ev.meta && ev.meta.file_updated ? new Date(ev.meta.file_updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
    return 'Early votes in ' + e.name + ': ' + e.total.toLocaleString('en-US') + (e.pct_of_2022 ? ' (' + e.pct_of_2022 + '% of the 2022 total)' : '') + ' · UF Election Lab' + (upd ? ', updated ' + upd : '');
  }

  // Seat panel header: the same lines as the boxes, plus the mail note and early votes.
  function panelHtml(id) {
    var st = window.RacebookLive && window.RacebookLive.state;
    if (!st) return '';
    var s = status(st, id), v = votes(st, id), m = mailNote(st, id), e = earlyLine(st, id);
    if (!s.text && !v && !m && !e) return '';
    return (s.text ? '<div class="sp-live-status sp-live-' + (s.phase || 'none') + '">' + confHtml(s, 'sp-conf') + '</div>' : '') +
      (v ? '<div class="sp-live-votes">' + esc(v) + '</div>' : '') +
      (m ? '<div class="sp-live-mail">' + esc(m) + '</div>' : '') +
      (e ? '<div class="sp-live-votes">' + esc(e) + '</div>' : '');
  }

  // "Called · confirmed by n sources", opening to the publishers with links (tap or hover).
  function confHtml(s, cls) {
    if (!s.conf || !s.conf.length) return '<span class="' + cls + '">' + esc(s.text) + '</span>';
    return '<details class="lv-conf ' + cls + '"><summary>' + esc(s.text) + '</summary><ul>' + s.conf.map(function (c) {
      var u = /^https?:\/\//.test(c.url || '') ? c.url : null;
      return '<li>' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(c.publisher) + '</a>' : esc(c.publisher)) +
        (c.desk ? ' <small>(' + esc(c.desk) + ' decision desk)</small>' : '') + (c.title ? '<br><small>' + esc(c.title) + '</small>' : '') + '</li>';
    }).join('') + '</ul></details>';
  }

  window.LiveSeat = { confHtml: confHtml, status: status, votes: votes, mailNote: mailNote, nextClose: nextClose, panelHtml: panelHtml, enabled: enabled, etIst: etIst };

  function hook() { if (window.SeatPanel && window.SeatPanel.setLiveProvider) window.SeatPanel.setLiveProvider(panelHtml); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook); else hook();
})();
