/* Battleground live boxes (any element with data-live-battleground).
 * Races and candidates come from assets/live-config.json; results from live.js
 * ("racebook:live" events: Supabase Realtime, with a 5-minute fallback).
 * Each box shows the leader, vote share, margin, share counted, a "Called"
 * badge once called_by is set, "Ran on" items and other sources. When the
 * leader changes the box border flashes once (a static highlight under
 * prefers-reduced-motion). Tapping a box opens the seat panel on Election Trends;
 * "Read more" goes to the Trends page itself, opened at the seat brief
 * (map.html?seat=ID&open=brief). Countdown, counting and votes-counted lines come
 * from live-seat.js.
 */
(function () {
  'use strict';

  var CONFIG_URL = 'assets/live-config.json?v=20261104d';
  var ST = { AK:'Alaska',AZ:'Arizona',CA:'California',CO:'Colorado',FL:'Florida',GA:'Georgia',IA:'Iowa',KS:'Kansas',KY:'Kentucky',ME:'Maine',MI:'Michigan',MN:'Minnesota',MT:'Montana',NC:'North Carolina',NE:'Nebraska',NH:'New Hampshire',NV:'Nevada',NY:'New York',OH:'Ohio',PA:'Pennsylvania',SC:'South Carolina',TX:'Texas',VA:'Virginia',WI:'Wisconsin' };
  var PARTY = { D: 'Democrat', R: 'Republican', I: 'Independent' };

  var cfg = null, mounts = [], prevLeader = {}, lastState = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; v = Number(v); return isFinite(v) ? v : null; }
  function pct(v) { v = num(v); return v === null ? '—' : v.toFixed(1) + '%'; }
  function timeET(iso) { var d = new Date(iso); return !iso || isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'; }
  function reduced() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  function credit(c) {
    var p = c.photo; if (!p) return '';
    return 'Photo: ' + p.author + ' (' + p.licence + '), Wikimedia Commons';
  }
  function face(c, size) {
    if (c.photo) return '<img class="bg-photo bg-photo-' + size + '" src="' + esc(c.photo.file) + '" alt="" loading="lazy" width="96" height="96" title="' + esc(credit(c)) + '">';
    return '<span class="bg-photo bg-photo-' + size + ' bg-init bg-init-' + c.party.toLowerCase() + '" aria-hidden="true">' + esc(c.initials) + '</span>';
  }

  // The live row for a race, with shares as numbers.
  function rowFor(st, id) {
    var list = (st && st.races) || [];
    for (var i = 0; i < list.length; i++) if (list[i].race_id === id) return list[i];
    return null;
  }

  function liveLines(id) {
    var st = lastState, S = window.LiveSeat;
    if (!S || !st) return '';
    var s = S.status(st, id), v = S.votes(st, id), m = S.mailNote(st, id);
    return (s.text ? '<span class="bg-when bg-when-' + (s.phase || 'none') + '">' + S.confHtml(s, 'bg-conf') + '</span>' : '') +
      (s.note ? '<span class="bg-note">' + S.noteHtml(s, 'bg-conf') + '</span>' : '') +
      (v ? '<span class="bg-votes">' + esc(v) + '</span>' : '') + (m ? '<span class="bg-mail">' + esc(m) + '</span>' : '');
  }

  // Litigation or interference reports for this race or its state (data/litigation.json)
  function litFor(race) {
    var L = lastState && lastState.litigation, e = (L && L.entries) || [];
    return e.filter(function (x) { return x.race_id === race.race_id || (!x.race_id && x.state === race.state); });
  }
  function litHtml(race) {
    var e = litFor(race); if (!e.length) return '';
    return '<details class="bg-lit"><summary aria-label="' + e.length + ' litigation or interference report' + (e.length > 1 ? 's' : '') + '">▲</summary><ul>' +
      e.map(function (x) { return '<li><b>' + (x.type === 'lawsuit' ? 'Lawsuit' : 'Interference') + ':</b> ' + esc(x.summary) + '<br>' +
        x.sources.map(function (s) { return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.publisher) + '</a>'; }).join(' · ') + '</li>'; }).join('') + '</ul></details>';
  }

  // Both candidates always: Fox's top two (shares, winner), photos from live-config where the name matches.
  function boxInner(race, kind, row) {
    var S = window.LiveSeat, st = lastState || {};
    var fox = row && row.candidates && row.candidates.length ? row.candidates.slice(0, 2) : null;
    var cfgBy = {}; race.candidates.forEach(function (c) { cfgBy[c.party] = c; });
    var people = fox ? fox.map(function (x) {
      var c = cfgBy[x.party] && cfgBy[x.party].name.split(' ').pop().toLowerCase() === String(x.name).split(' ').pop().toLowerCase() ? cfgBy[x.party] : null;
      return { name: x.name, party: x.party, pct: x.pct, winner: !!x.winner, photo: c ? c.photo : null, initials: c ? c.initials : String(x.name).split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2) };
    }) : race.candidates.map(function (c) { return { name: c.name, party: c.party, pct: null, winner: false, photo: c.photo, initials: c.initials }; });
    var s = S ? S.status(st, race.race_id) : { phase: null, html: '' };
    var called = s.phase === 'called', lead = row ? (row.winner || row.leader) : null;
    if (!(row && ((row.pct_counted || 0) > 0 || called))) lead = null;
    var head = '<button type="button" class="bg-head bg-open"><span class="bg-id">' + esc(kind === 'senate' ? 'Senate · ' + race.state : race.race_id) + '</span>' +
      '<span class="bg-st">' + esc(kind === 'senate' ? race.label : ST[race.state] || race.state) + '</span></button>' +
      '<span class="bg-badges">' + (called ? '<span class="bg-called">Called</span>' : '') + (called && row.flipped ? '<span class="bg-flipped">Flipped</span>' : '') + litHtml(race) + '</span>';
    var list = '<span class="bg-cands">' + people.map(function (p) {
      var pp = p.party === 'D' || p.party === 'R' ? p.party.toLowerCase() : 'i', isLead = lead && p.party === lead && (!called || p.winner);
      return '<span class="bg-cand2' + (isLead ? ' bg-ahead' : '') + '">' + face({ photo: p.photo, party: p.party === 'D' || p.party === 'R' ? p.party : 'I', initials: p.initials }, 'sm') +
        '<span class="bg-cname">' + esc(p.name) + ' <small class="bg-p-' + pp + '">(' + esc(p.party) + ')</small>' + (p.winner ? ' <span class="bg-check" aria-label="winner">✓</span>' : '') + '</span>' +
        '<b class="bg-cpct">' + (p.pct != null && (row && (row.pct_counted || 0) > 0 || p.winner) ? Number(p.pct).toFixed(1) + '%' : '') + '</b></span>';
    }).join('') + '</span>';
    var counted = row && row.pct_counted != null ? Number(row.pct_counted) : 0;
    var margin = row && row.margin != null && counted > 0 ? '<span class="bg-margin2">Margin ' + Number(row.margin).toFixed(1) + ' pts · ' + Math.round(counted) + '% counted</span>' : '';
    var bar = '<span class="bg-count-bar" aria-hidden="true"><span style="width:' + Math.max(0, Math.min(100, counted)) + '%"></span></span>';
    var when = '<span class="bg-when bg-when-' + (s.phase || 'none') + '">' + s.html + '</span>';
    var v = S ? S.votes(st, race.race_id) : '', m = S ? S.mailNote(st, race.race_id) : '';
    var ran = race.ran_on && race.ran_on.length ? '<span class="bg-ran"><b>Ran on:</b> ' + race.ran_on.map(function (x) { return esc(x.text); }).join('; ') + '</span>' : '';
    var leaderP = people.filter(function (p) { return p.party === lead; })[0];
    return { html: head + list + margin + bar + when + (v ? '<span class="bg-votes">' + esc(v) + '</span>' : '') + (m ? '<span class="bg-mail">' + esc(m) + '</span>' : '') + ran,
      lead: lead === 'D' || lead === 'R' ? lead : null, called: called,
      label: (kind === 'senate' ? race.label + ' Senate' : race.race_id) + ': ' + (leaderP ? leaderP.name + (called ? ' won' : ' leads') : s.text) + (counted ? ', ' + Math.round(counted) + '% counted' : '') + '. Open seat details.' };
  }

  function grid(kind, races) {
    return '<div class="bg-group bg-group-' + kind + '"><h3 class="bg-gh">' + (kind === 'senate' ? 'Senate' : 'House') +
      ' <small>' + races.length + ' races</small></h3><div class="bg-grid bg-grid-' + kind + '">' +
      races.map(function (r) {
        var href = 'map.html?seat=' + encodeURIComponent(r.race_id) + '&open=brief' + (/[?&]demo=1\b/.test(location.search) ? '&demo=1' : '');
        return '<div class="bg-box bg-' + kind + '" data-race="' + esc(r.race_id) + '"><span class="bg-inner"></span>' +
          '<a class="bg-more" href="' + esc(href) + '" target="_self">Read more <span aria-hidden="true">&rarr;</span><span class="sr-only"> about ' + esc(kind === 'senate' ? r.label + ' Senate' : r.race_id) + '</span></a></div>';
      }).join('') + '</div></div>';
  }

  function credits() {
    var all = cfg.senate.concat(cfg.house).reduce(function (a, r) { return a.concat(r.candidates); }, []).filter(function (c) { return c.photo; });
    var seen = {};
    all = all.filter(function (c) { if (seen[c.name]) return false; seen[c.name] = 1; return true; });
    return '<details class="bg-credits"><summary>Photo credits</summary><ul>' + all.map(function (c) {
      return '<li>' + esc(c.name) + ': <a href="' + esc(c.photo.source) + '" target="_blank" rel="noopener">' + esc(c.photo.author) + '</a>, ' +
        (c.photo.licence_url ? '<a href="' + esc(c.photo.licence_url) + '" target="_blank" rel="noopener">' + esc(c.photo.licence) + '</a>' : esc(c.photo.licence)) + '</li>';
    }).join('') + '</ul><p>From Wikimedia Commons. Candidates without a freely licensed photo are shown by their initials.</p></details>';
  }

  function build(el) {
    el.innerHTML = '<div class="bg-headrow"><h2 class="bg-title">Battleground races</h2><p class="bg-sub" aria-live="off"></p></div>' +
      grid('senate', cfg.senate) + grid('house', cfg.house) + credits();
    el.addEventListener('click', function (e) {
      if (e.target.closest('a') || e.target.closest('details')) return;   // links, sources and litigation lists
      var b = e.target.closest('.bg-box'); if (!b) return;
      var id = b.getAttribute('data-race');
      if (typeof window.openSeatFromHome === 'function') window.openSeatFromHome(id);
      else location.href = 'map.html#seat=' + encodeURIComponent(id);
    });
  }

  function update(st) {
    if (!cfg || !window.LiveMath) return;
    lastState = st;
    var m = (st && st.meta) || {}, ph = window.LiveMath.phase(m);
    mounts.forEach(function (el) {
      var sub = el.querySelector('.bg-sub');
      sub.innerHTML = (ph === 'pre' ? 'Results appear here when polls close. ' : (st && st.live ? '<span class="bg-live">Live</span> ' : 'Checking every 5 minutes. ') + (m.last_update ? 'Updated ' + timeET(m.last_update) + '. ' : '')) +
        'Tap a race for the full seat brief.' + (st && st.demo ? ' <b>Demo data.</b>' : '');
      [['senate', cfg.senate], ['house', cfg.house]].forEach(function (g) {
        g[1].forEach(function (race) {
          var box = el.querySelector('.bg-box[data-race="' + race.race_id + '"]');
          if (!box) return;
          var b = boxInner(race, g[0], rowFor(st, race.race_id));
          var inner = box.querySelector('.bg-inner');
          if (box._html !== b.html) { inner.innerHTML = b.html; box._html = b.html; }
          var ob = inner.querySelector('.bg-open'); if (ob) ob.setAttribute('aria-label', b.label);
          box.classList.toggle('bg-lead-d', b.lead === 'D');
          box.classList.toggle('bg-lead-r', b.lead === 'R');
          box.classList.toggle('bg-is-called', b.called);
          var was = prevLeader[race.race_id];
          if (was !== undefined && b.lead && was !== b.lead) flash(box);
        });
      });
    });
    [cfg.senate, cfg.house].forEach(function (list) { list.forEach(function (race) {
      var row = rowFor(st, race.race_id), L = window.LiveMath;
      var has = row && ((num(row.pct_d) || 0) + (num(row.pct_r) || 0) > 0 || row.called_by);
      prevLeader[race.race_id] = has ? (L.winnerOf(row) || L.leaderOf(row)) : null;
    }); });
  }

  function flash(box) {
    var cls = reduced() ? 'bg-flash-static' : 'bg-flash';
    box.classList.remove('bg-flash', 'bg-flash-static'); void box.offsetWidth;
    box.classList.add(cls);
    setTimeout(function () { box.classList.remove(cls); }, reduced() ? 4000 : 1400);
  }

  // ?demo=1 rows come from live.js, so the boxes agree with the bars and the strip.

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-live-battleground]'));
    if (!mounts.length) return;
    fetch(CONFIG_URL).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (c) {
      cfg = c;
      mounts.forEach(function (el) { el.classList.add('bg'); build(el); el.hidden = false; });
      update(window.RacebookLive && window.RacebookLive.ready ? window.RacebookLive.state : (lastState || { demo: /[?&]demo=1\b/.test(location.search) }));
    }).catch(function () { mounts.forEach(function (el) { el.hidden = true; }); });
    document.addEventListener('racebook:live', function (e) { lastState = e.detail; update(e.detail); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
