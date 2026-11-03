/* Early vote card (any element with data-early-vote; data-early-vote="full" adds the
 * sortable state table). Data: data/early-vote.json, built from the University of
 * Florida Election Lab's 2026 Early Vote Tracker by scripts/fetch-early-vote.js.
 * National turnout (VEP) comes from the Results Desk "Turnout" tab via live.js.
 * Party splits are by party registration, not votes cast.
 */
(function () {
  'use strict';

  var URL_EV = 'data/early-vote.json';
  var FALLBACK_BG = ['AK', 'IA', 'KS', 'ME', 'TX', 'OH', 'MI', 'SC', 'CA', 'CO', 'FL', 'MT', 'NY', 'PA', 'VA', 'KY'];
  var ev = null, cfg = null, live = null, mounts = [], sort = { key: 'total', dir: -1 };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function n(v) { return Number(v || 0).toLocaleString('en-US'); }
  function mil(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + ' million' : n(v); }
  function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : null; }
  function day(iso) { var d = new Date(iso); return !iso || isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  function istTime(iso) { var d = new Date(iso); return !iso || isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).replace(',', '') + ' IST'; }

  function battlegroundStates() {
    var list = cfg ? cfg.senate.concat(cfg.house).map(function (r) { return r.state; }) : FALLBACK_BG;
    return list.filter(function (s, i) { return list.indexOf(s) === i; });
  }

  function turnoutLine() {
    var m = live && live.meta, ph = window.LiveMath && live ? window.LiveMath.phase(m) : 'pre', N = ev.national;
    var early = 'Early votes so far = <b>' + N.pct_of_2022 + '%</b> of the 2022 total (in the ' + N.states_reporting + ' states reporting).';
    if (ph !== 'pre' && m && m.turnout_pct != null) {
      return 'National turnout estimate: <b>' + Number(m.turnout_pct).toFixed(1) + '%</b> of eligible voters (VEP)' +
        (m.turnout_source ? ', ' + esc(m.turnout_source) : '') + (m.turnout_updated ? ', ' + istTime(m.turnout_updated) : '') + '. ' + early;
    }
    return early;
  }

  function card(full) {
    var N = ev.national, S = ev.states, M = ev.meta;
    var methodTot = N.mail_returned + N.in_person, mailPct = pct(N.mail_returned, methodTot) || 0;
    var bg = battlegroundStates().filter(function (s) { return S[s] && S[s].total; })
      .sort(function (a, b) { return S[b].total - S[a].total; }).slice(0, 10);
    var maxPct = Math.max.apply(null, bg.map(function (s) { return S[s].pct_of_2022 || 0; }).concat([100]));
    var party = Object.keys(S).filter(function (s) { return S[s].has_party; });
    var pd = 0, pr = 0, po = 0;
    party.forEach(function (s) { pd += S[s].party_d; pr += S[s].party_r; po += S[s].party_other; });
    var pt = pd + pr + po;
    var rows = bg.map(function (s) {
      var e = S[s], w = e.pct_of_2022 ? Math.min(100, e.pct_of_2022 / maxPct * 100) : 0;
      return '<li class="ev-row"><span class="ev-st">' + esc(e.name) + '</span>' +
        '<span class="ev-bar" aria-hidden="true"><span style="width:' + w.toFixed(1) + '%"></span></span>' +
        '<span class="ev-num">' + n(e.total) + (e.pct_of_2022 ? ' <small>' + e.pct_of_2022 + '% of 2022</small>' : '') + '</span></li>';
    }).join('');
    return '<div class="ev-head"><h2 class="ev-title">Early vote</h2>' +
        '<p class="ev-src">Source: <a href="' + esc(M.source_url) + '" target="_blank" rel="noopener">' + esc(M.source) + '</a> · file updated ' + esc(istTime(M.file_updated)) + ' · ' + esc(M.cadence) + '</p></div>' +
      '<div class="ev-top">' +
        '<div class="ev-nat"><span class="ev-big">' + mil(N.total) + '</span><span class="ev-lbl">early votes in ' + N.states_reporting + ' states' +
          (M.missing_states && M.missing_states.length ? ' (no data yet: ' + esc(M.missing_states.join(', ')) + ')' : '') + '</span></div>' +
        '<div class="ev-split"><div class="ev-split-bar" role="img" aria-label="' + esc('Mail ' + mailPct + '%, in person ' + (100 - mailPct).toFixed(1) + '%') + '">' +
          '<span class="ev-mail" style="width:' + mailPct + '%"></span><span class="ev-inp" style="width:' + (100 - mailPct) + '%"></span></div>' +
          '<div class="ev-split-l"><span><i class="ev-sw ev-sw-mail"></i>Mail returned ' + n(N.mail_returned) + ' (' + mailPct.toFixed(0) + '%)</span>' +
          '<span><i class="ev-sw ev-sw-inp"></i>In person ' + n(N.in_person) + ' (' + (100 - mailPct).toFixed(0) + '%)</span></div></div>' +
      '</div>' +
      '<p class="ev-turn">' + turnoutLine() + '</p>' +
      '<h3 class="ev-h3">Battleground states <small>early votes, and as a share of the 2022 total vote</small></h3>' +
      '<ul class="ev-list">' + rows + '</ul>' +
      (pt ? '<p class="ev-party">Party split in the ' + party.length + ' states that report it: D ' + pct(pd, pt) + '% · R ' + pct(pr, pt) + '% · other or none ' + pct(po, pt) + '%. <b>By party registration, not votes cast.</b></p>' : '') +
      (full ? table() : '');
  }

  var COLS = [['name', 'State'], ['total', 'Early votes'], ['in_person', 'In person'], ['mail_returned', 'Mail returned'], ['mail_requested', 'Mail requested'],
              ['pct_of_2022', '% of 2022'], ['reg_d', 'Reg. D %'], ['reg_r', 'Reg. R %'], ['updated', 'Updated']];
  function table() {
    var S = ev.states, ids = Object.keys(S);
    var val = function (s, k) {
      var e = S[s], t = e.party_d + e.party_r + e.party_other;
      if (k === 'reg_d') return e.has_party ? pct(e.party_d, t) : null;
      if (k === 'reg_r') return e.has_party ? pct(e.party_r, t) : null;
      return e[k];
    };
    ids.sort(function (a, b) {
      var x = val(a, sort.key), y = val(b, sort.key);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir;
    });
    return '<div class="ev-tw"><table class="ev-table"><caption>All states <small>(party columns: by party registration, not votes cast)</small></caption><thead><tr>' +
      COLS.map(function (c) {
        var on = sort.key === c[0];
        return '<th scope="col" aria-sort="' + (on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none') + '"' + (c[0] === 'name' ? '' : ' class="ev-n"') + '>' +
          '<button type="button" class="ev-sort" data-k="' + c[0] + '">' + c[1] + (on ? (sort.dir > 0 ? ' ▲' : ' ▼') : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>' +
      ids.map(function (s) {
        var e = S[s];
        return '<tr><th scope="row">' + esc(e.name) + '</th><td class="ev-n">' + n(e.total) + '</td><td class="ev-n">' + (e.in_person ? n(e.in_person) : '—') + '</td>' +
          '<td class="ev-n">' + (e.mail_returned ? n(e.mail_returned) : '—') + '</td><td class="ev-n">' + (e.mail_requested ? n(e.mail_requested) : '—') + '</td>' +
          '<td class="ev-n">' + (e.pct_of_2022 != null ? e.pct_of_2022 + '%' : '—') + '</td>' +
          '<td class="ev-n">' + (val(s, 'reg_d') != null ? val(s, 'reg_d') + '%' : '—') + '</td><td class="ev-n">' + (val(s, 'reg_r') != null ? val(s, 'reg_r') + '%' : '—') + '</td>' +
          '<td class="ev-n">' + esc(day(e.updated)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function render() {
    if (!ev) return;
    mounts.forEach(function (el) {
      var full = el.getAttribute('data-early-vote') === 'full';
      var focus = document.activeElement && el.contains(document.activeElement) && document.activeElement.getAttribute('data-k');
      el.innerHTML = card(full); el.hidden = false;
      if (focus) { var b = el.querySelector('.ev-sort[data-k="' + focus + '"]'); if (b) b.focus(); }
    });
  }

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-early-vote]'));
    if (!mounts.length) return;
    mounts.forEach(function (el) {
      el.classList.add('ev');
      el.addEventListener('click', function (e) {
        var b = e.target.closest('.ev-sort'); if (!b) return;
        var k = b.getAttribute('data-k');
        sort = { key: k, dir: sort.key === k ? -sort.dir : (k === 'name' ? 1 : -1) };
        render();
      });
    });
    var bust = Math.floor(Date.now() / 600000);
    Promise.all([fetch(URL_EV + '?t=' + bust).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
                 fetch('assets/live-config.json?t=' + bust).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })])
      .then(function (res) { ev = res[0]; cfg = res[1]; if (!ev) { mounts.forEach(function (el) { el.hidden = true; }); return; } render(); });
    document.addEventListener('racebook:live', function (e) {
      var m = e.detail && e.detail.meta, key = m ? [m.status, m.turnout_pct, m.turnout_updated].join('|') : '';
      live = e.detail;
      if (key !== render._k) { render._k = key; render(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
