/* Battleground live boxes (any element with data-live-battleground).
 * Races and candidates come from assets/live-config.json; results from live.js
 * ("racebook:live" events: Supabase Realtime, with a 5-minute fallback).
 * Each box shows the leader, vote share, margin, share counted, a "Called"
 * badge once called_by is set, "Ran on" items and other sources. When the
 * leader changes the box border flashes once (a static highlight under
 * prefers-reduced-motion). Tapping a box opens the seat panel on Election Trends.
 */
(function () {
  'use strict';

  var CONFIG_URL = 'assets/live-config.json?v=20261104';
  var ST = { AK:'Alaska',AZ:'Arizona',CA:'California',CO:'Colorado',FL:'Florida',GA:'Georgia',IA:'Iowa',KS:'Kansas',KY:'Kentucky',ME:'Maine',MI:'Michigan',MN:'Minnesota',MT:'Montana',NC:'North Carolina',NE:'Nebraska',NH:'New Hampshire',NV:'Nevada',NY:'New York',OH:'Ohio',PA:'Pennsylvania',SC:'South Carolina',TX:'Texas',VA:'Virginia',WI:'Wisconsin' };
  var PARTY = { D: 'Democrat', R: 'Republican', I: 'Independent' };

  var cfg = null, mounts = [], prevLeader = {}, lastState = null, demoRows = null;

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
    var list = (demoRows || (st && st.races) || []);
    for (var i = 0; i < list.length; i++) if (list[i].race_id === id) return list[i];
    return null;
  }

  function boxInner(race, kind, row) {
    var L = window.LiveMath;
    var d = race.candidates.filter(function (c) { return c.party === 'D'; })[0], r = race.candidates.filter(function (c) { return c.party === 'R'; })[0];
    var pd = row ? num(row.pct_d) : null, pr = row ? num(row.pct_r) : null, counted = row ? num(row.pct_counted) : null;
    var hasVotes = row && ((pd || 0) + (pr || 0) > 0);
    var win = row ? L.winnerOf(row) : null, lead = row ? (win || L.leaderOf(row)) : null;
    if (!hasVotes && !win) lead = null;
    var leader = lead === 'D' ? d : lead === 'R' ? r : null, other = lead === 'D' ? r : lead === 'R' ? d : null;
    var lp = lead === 'D' ? pd : pr, op = lead === 'D' ? pr : pd;
    var head = '<span class="bg-head"><span class="bg-id">' + esc(kind === 'senate' ? 'Senate · ' + race.state : race.race_id) + '</span>' +
      '<span class="bg-st">' + esc(kind === 'senate' ? race.label : ST[race.state] || race.state) + '</span>' +
      (row && row.called_by ? '<span class="bg-called">Called (' + esc(row.called_by) + ')</span>' : '') + '</span>';
    var main;
    if (leader) {
      var margin = lp !== null && op !== null ? Math.abs(lp - op) : null;
      main = '<span class="bg-main">' + face(leader, 'lg') +
        '<span class="bg-who"><span class="bg-name">' + esc(leader.name) + '</span>' +
        '<span class="bg-party bg-party-' + lead.toLowerCase() + '">' + (win ? 'Won' : 'Leads') + ' &middot; ' + PARTY[lead] + '</span>' +
        '<span class="bg-nums"><b class="bg-pct">' + pct(lp) + '</b>' + (margin !== null ? '<span class="bg-margin">+' + margin.toFixed(1) + ' pts</span>' : '') + '</span></span></span>' +
        '<span class="bg-vs">' + esc(other.name) + ' (' + other.party + ') ' + pct(op) + '</span>';
    } else {
      main = '<span class="bg-pair">' +
        '<span class="bg-cand">' + face(d, 'sm') + '<span>' + esc(d.name) + ' <small>(D)</small></span></span>' +
        '<span class="bg-cand">' + face(r, 'sm') + '<span>' + esc(r.name) + ' <small>(R)</small></span></span></span>' +
        '<span class="bg-wait">' + (row && row.called_by ? '' : 'Awaiting results') + '</span>';
    }
    var cnt = '<span class="bg-count"><span class="bg-count-l">' + (counted === null ? 'No votes counted yet' : pct(counted) + ' counted') + '</span>' +
      '<span class="bg-count-bar" aria-hidden="true"><span style="width:' + (counted === null ? 0 : Math.max(0, Math.min(100, counted))) + '%"></span></span></span>';
    var ran = race.ran_on && race.ran_on.length ? '<span class="bg-ran"><b>Ran on:</b> ' + race.ran_on.map(function (x) { return esc(x.text); }).join('; ') + '</span>' : '';
    var others = row && row.other_sources && row.other_sources.length ? '<span class="bg-other">' + row.other_sources.map(function (o) {
      return esc(o.name) + ': D ' + pct(o.pct_d) + ' · R ' + pct(o.pct_r) + (o.pct_counted != null ? ' · ' + pct(o.pct_counted) + ' in' : '') + (o.at ? ' (' + timeET(o.at) + ')' : '');
    }).join('<br>') + '</span>' : '';
    var src = row && row.source ? '<span class="bg-src">Source: ' + esc(row.source) + '</span>' : '';
    return { html: head + main + cnt + ran + others + src, lead: lead, called: !!(row && row.called_by),
      label: (kind === 'senate' ? race.label + ' Senate' : race.race_id) + ': ' + (leader ? leader.name + ' (' + lead + ') ' + (win ? 'won' : 'leads') + ' with ' + pct(lp) : 'awaiting results') +
        (counted !== null ? ', ' + pct(counted) + ' counted' : '') + '. Open seat details.' };
  }

  function grid(kind, races) {
    return '<div class="bg-group bg-group-' + kind + '"><h3 class="bg-gh">' + (kind === 'senate' ? 'Senate' : 'House') +
      ' <small>' + races.length + ' races</small></h3><div class="bg-grid bg-grid-' + kind + '">' +
      races.map(function (r) { return '<button type="button" class="bg-box bg-' + kind + '" data-race="' + esc(r.race_id) + '"></button>'; }).join('') + '</div></div>';
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
          if (box._html !== b.html) { box.innerHTML = b.html; box._html = b.html; }
          box.setAttribute('aria-label', b.label);
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

  // ── ?demo=1: made-up results for these races, with occasional lead changes ──
  var STAGE = (/[?&]stage=(pre|early|mid|majority|final)\b/.exec(location.search) || [])[1] || 'mid';
  function makeDemo() {
    if (STAGE === 'pre') { demoRows = []; return; }
    var seed = 7, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    var base = { early: 18, mid: 55, majority: 88, final: 97 }[STAGE];
    demoRows = cfg.senate.concat(cfg.house).map(function (r, i) {
      var d = 47 + rnd() * 6, rr = 100 - d - 1 - rnd() * 2;
      var counted = Math.min(99, Math.round(base + (rnd() - 0.5) * 20));
      var call = (STAGE === 'majority' || STAGE === 'final') && Math.abs(d - rr) > 2.2 ? 'AP' : null;
      return { race_id: r.race_id, pct_d: +d.toFixed(1), pct_r: +rr.toFixed(1), pct_counted: counted, called_by: call, winner: call ? (d > rr ? 'D' : 'R') : null,
        source: 'Demo', other_sources: i % 4 === 0 ? [{ name: 'State results feed (demo)', pct_d: +(d - 0.3).toFixed(1), pct_r: +(rr + 0.3).toFixed(1), pct_counted: counted - 2, at: new Date().toISOString() }] : [] };
    });
  }
  function demoTick() {
    var open = demoRows.filter(function (r) { return !r.called_by; });
    if (!open.length) return;
    var r = open[Math.floor(Math.random() * open.length)];
    var gap = r.pct_d - r.pct_r, sw = gap > 0 ? -(0.4 + Math.random() * 1.6) : (0.4 + Math.random() * 1.6);   // pull towards a tie, sometimes past it
    r.pct_d = +(r.pct_d + sw / 2).toFixed(1); r.pct_r = +(r.pct_r - sw / 2).toFixed(1);
    r.pct_counted = Math.min(99, r.pct_counted + 1);
    update(lastState || { demo: true });
  }

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-live-battleground]'));
    if (!mounts.length) return;
    fetch(CONFIG_URL).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (c) {
      cfg = c;
      mounts.forEach(function (el) { el.classList.add('bg'); build(el); el.hidden = false; });
      var demo = /[?&]demo=1\b/.test(location.search);
      if (demo) { makeDemo(); if (STAGE !== 'pre') setInterval(demoTick, 3500); }
      update(window.RacebookLive && window.RacebookLive.ready ? window.RacebookLive.state : (lastState || { demo: demo }));
    }).catch(function () { mounts.forEach(function (el) { el.hidden = true; }); });
    document.addEventListener('racebook:live', function (e) { lastState = e.detail; update(e.detail); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
