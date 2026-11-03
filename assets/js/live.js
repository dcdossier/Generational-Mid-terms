/* Election-night live results.
 *
 * Reads live_meta, live_chamber and live_races from Supabase with the public
 * anon key (SELECT only; see supabase/live.sql). Changes arrive over Realtime
 * within seconds; a full re-read every 5 minutes is the backup if the socket
 * drops. Any element with data-live-results becomes a results panel.
 * ?demo=1 fills the panel with made-up figures, locally, for testing; add
 * &stage=pre, early, majority or final to see each stage (default: mid-count).
 * Arithmetic lives in live-math.js. Other components (live-strip.js, balance.js)
 * listen for the "racebook:live" event, sent on every change and once a minute.
 */
(function () {
  'use strict';

  var SB_URL = 'https://zxwrecjvhmoceyfsarwz.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4d3JlY2p2aG1vY2V5ZnNhcnd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NzQxMzUsImV4cCI6MjEwODA1MDEzNX0.v6JG5hyTbfl-Yon7GSATXkmfwpItUm5DKb8PLcmELlY';
  var LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
  var POLL_MS = 5 * 60 * 1000;
  var DEMO = /[?&]demo=1\b/.test(location.search);
  var STAGE = (/[?&]stage=(pre|early|mid|majority|final)\b/.exec(location.search) || [])[1] || 'mid';

  var ST = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
  var ABBR = {}; Object.keys(ST).forEach(function (k) { ABBR[ST[k]] = k; });

  // Same not-up seats as supabase/live.sql, so the bars are right before the tables answer.
  var SEED_CHAMBERS = [['senate', 'D', 34], ['senate', 'R', 31], ['gov', 'D', 6], ['gov', 'R', 8]].map(function (x) {
    return { chamber: x[0], party: x[1], won: 0, leading: 0, not_up: x[2] };
  });
  var state = { meta: null, chambers: SEED_CHAMBERS.slice(), races: [], holders: {}, current: null, live: false, loaded: false, error: null, demo: DEMO };
  var mounts = [];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function pct(v) { return v == null || v === '' || !isFinite(Number(v)) ? '—' : Number(v).toFixed(1) + '%'; }
  function timeET(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
  }
  function raceLabel(id) {
    var m;
    if ((m = /^Senate-([A-Z]{2})$/.exec(id))) return { kind: 'Senate', name: ST[m[1]] || m[1] };
    if ((m = /^Gov-([A-Z]{2})$/.exec(id))) return { kind: 'Governor', name: ST[m[1]] || m[1] };
    return { kind: 'House', name: id };
  }

  // ── current holders, for flips ────────────────────────────────────────────
  function loadHolders() {
    return fetch('data.json?t=' + Math.floor(Date.now() / 600000)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var h = {}, races = d && d.races;
      if (!races) return h;
      // The 119th Congress as it stands, shown before polls close.
      var hb = races.house && races.house.current_balance || {}, sb = races.senate && races.senate.current_balance || {};
      state.current = { house: { D: hb.d || 0, R: hb.r || 0, I: hb.i || 0, vacant: hb.vacant || 0 }, senate: { D: sb.d || 0, R: sb.r || 0, I: 0 } };
      (races.senate && races.senate.races || []).forEach(function (r) { if (r.code) h['Senate-' + r.code] = r.party; });
      (races.governor && races.governor.races || []).forEach(function (r) { var a = ABBR[r.state]; if (a) h['Gov-' + a] = r.party; });
      (races.house && races.house.competitive || []).forEach(function (r) { if (r.district) h[r.district] = r.party; });
      return h;
    }).catch(function () { return {}; });
  }

  // ── Supabase reads ─────────────────────────────────────────────────────────
  function rest(path) {
    return fetch(SB_URL + '/rest/v1/' + path, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function readAll() {
    return Promise.all([
      rest('live_meta?select=*&id=eq.1'),
      rest('live_chamber?select=*'),
      rest('live_races?select=*&order=featured_order.asc.nullslast,race_id.asc')
    ]).then(function (res) {
      state.meta = res[0][0] || null; state.chambers = res[1].length ? res[1] : SEED_CHAMBERS.slice(); state.races = res[2];
      state.loaded = true; state.error = null;
    }).catch(function (e) { state.error = e.message; });
  }
  function upsertLocal(list, row, keyFn) {
    var k = keyFn(row), i;
    for (i = 0; i < list.length; i++) if (keyFn(list[i]) === k) { list[i] = row; return; }
    list.push(row);
  }
  function startRealtime() {
    loadLib().then(function () {
      var client = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      client.channel('racebook-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_meta' }, function (p) { if (p.new && p.new.id) state.meta = p.new; render(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_chamber' }, function (p) {
          if (p.new && p.new.chamber) upsertLocal(state.chambers, p.new, function (r) { return r.chamber + '/' + r.party; }); render();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_races' }, function (p) {
          if (p.eventType === 'DELETE' && p.old) state.races = state.races.filter(function (r) { return r.race_id !== p.old.race_id; });
          else if (p.new && p.new.race_id) upsertLocal(state.races, p.new, function (r) { return r.race_id; });
          render();
        })
        .subscribe(function (status) {
          var was = state.live;
          state.live = status === 'SUBSCRIBED';
          if (state.live && !was) readAll().then(render);   // catch anything missed while connecting
          else if (was !== state.live) render();
        });
    }).catch(function () { state.live = false; render(); });
  }
  function loadLib() {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) return resolve();
      var s = document.createElement('script');
      s.src = LIB; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { window.supabase && window.supabase.createClient ? resolve() : reject(new Error('lib')); };
      s.onerror = function () { reject(new Error('lib')); };
      document.head.appendChild(s);
    });
  }

  // ── demo data (?demo=1): made up, never sent anywhere ─────────────────────
  // [house D won, lead, R won, lead], [senate …], [gov …] for each demo stage
  var DEMO_STAGES = {
    pre:      [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    early:    [[38, 22, 41, 19], [3, 5, 6, 4], [4, 6, 5, 4]],
    mid:      [[168, 41, 141, 38], [11, 4, 13, 3], [15, 4, 11, 3]],
    majority: [[221, 9, 186, 7], [18, 1, 14, 1], [20, 1, 13, 1]],
    final:    [[226, 2, 199, 1], [19, 0, 15, 0], [21, 0, 14, 0]]
  };
  function demoState() {
    var now = new Date(), iso = now.toISOString(), pre = STAGE === 'pre';
    var close = pre ? new Date(now.getTime() + (3 * 60 + 12) * 60000).toISOString() : '2026-11-03T23:00:00Z';
    state.meta = { status: pre ? 'pre' : STAGE === 'final' ? 'final' : 'counting', polls_first_close: close, counting_started: pre ? null : new Date(now.getTime() - (2 * 60 + 35) * 60000).toISOString(),
      last_update: iso, turnout_pct: pre ? null : 48.6, turnout_source: 'Demo figure', turnout_updated: iso, notes: 'Demo data: these figures are made up.' };
    var g = DEMO_STAGES[STAGE], NU = { house: [0, 0], senate: [34, 31], gov: [6, 8] };
    state.chambers = [];
    ['house', 'senate', 'gov'].forEach(function (c, i) {
      state.chambers.push({ chamber: c, party: 'D', won: g[i][0], leading: g[i][1], not_up: NU[c][0], source: 'Demo' });
      state.chambers.push({ chamber: c, party: 'R', won: g[i][2], leading: g[i][3], not_up: NU[c][1], source: 'Demo' });
      state.chambers.push({ chamber: c, party: 'I', won: 0, leading: 0, not_up: 0, source: 'Demo' });
    });
    var R = function (id, o, cd, cr, d, r, c, call, win) {
      return { race_id: id, featured: true, featured_order: o, cand_d: cd, cand_r: cr, pct_d: d, pct_r: r, pct_counted: c,
        leader: null, winner: win || null, called_by: call || null, called_at: call ? now : null,
        source: 'Demo', source_url: null, other_sources: [], updated_at: now };
    };
    state.races = [
      R('Senate-NC', 1, 'Roy Cooper', 'Michael Whatley', 52.4, 46.1, 91, 'AP', 'D'),
      R('Senate-TX', 2, 'Democratic nominee', 'Republican nominee', 49.8, 49.0, 74),
      R('Senate-ME', 3, 'Democratic nominee', 'Susan Collins', 48.2, 50.1, 63),
      R('Senate-OH', 4, 'Democratic nominee', 'Jon Husted', 50.9, 48.3, 88),
      R('Senate-KS', 5, 'Democratic nominee', 'Roger Marshall', 47.5, 51.2, 70),
      R('Gov-NV', 6, 'Democratic nominee', 'Joe Lombardo', 49.1, 49.4, 55),
      R('PA-07', 7, 'Democratic nominee', 'Ryan Mackenzie', 51.8, 48.2, 97, 'AP', 'D'),
      R('NY-17', 8, 'Democratic nominee', 'Mike Lawler', 49.6, 50.4, 82),
      R('CA-22', 9, 'Randy Villegas', 'David G. Valadao', 50.3, 49.7, 41)
    ];
    state.holders = Object.assign({ 'Senate-NC': 'R', 'Senate-TX': 'R', 'Senate-ME': 'R', 'Senate-OH': 'R', 'Senate-KS': 'R', 'Gov-NV': 'R', 'PA-07': 'R', 'NY-17': 'R', 'CA-22': 'R' }, state.holders);
    if (pre) state.races.forEach(function (r) { r.pct_d = r.pct_r = r.pct_counted = null; r.called_by = r.winner = null; });
    state.loaded = true; state.live = true;
  }
  function demoTick() {   // nudge one race so updates can be seen arriving
    var r = state.races[Math.floor(Math.random() * state.races.length)];
    if (r.called_by || r.pct_d == null) return;
    var sw = (Math.random() - 0.5) * 0.8;
    r.pct_d = Math.max(0, Math.min(100, +(r.pct_d + sw).toFixed(1)));
    r.pct_r = Math.max(0, Math.min(100, +(r.pct_r - sw).toFixed(1)));
    r.pct_counted = Math.min(100, +(r.pct_counted + Math.random() * 3).toFixed(0));
    r.updated_at = new Date().toISOString(); state.meta.last_update = r.updated_at;
    render(r.race_id);
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  function hasData() {
    if (DEMO) return window.LiveMath.phase(state.meta) !== 'pre';
    if (!state.loaded || !state.meta) return false;
    if (state.meta.status !== 'pre') return true;
    return state.chambers.some(function (c) { return c.won || c.leading; }) || state.races.some(function (r) { return r.pct_counted || r.called_by; });
  }

  function bar(t, seats, mark, markLabel) {
    var w = function (n) { return (Math.max(0, n) / seats * 100).toFixed(2) + '%'; };
    var dSafe = t.D.not_up + t.D.won, rSafe = t.R.not_up + t.R.won;
    var rest = seats - t.D.total - t.R.total - t.I.total;
    return '<div class="lv-bar" role="img" aria-label="' + esc('Democrats ' + t.D.total + ', Republicans ' + t.R.total + ' of ' + seats) + '">' +
      '<span class="lv-seg lv-d" style="width:' + w(dSafe) + '"></span>' +
      '<span class="lv-seg lv-dl" style="width:' + w(t.D.leading) + '"></span>' +
      '<span class="lv-seg lv-i" style="width:' + w(t.I.total) + '"></span>' +
      '<span class="lv-seg lv-un" style="width:' + w(rest) + '"></span>' +
      '<span class="lv-seg lv-rl" style="width:' + w(t.R.leading) + '"></span>' +
      '<span class="lv-seg lv-r" style="width:' + w(rSafe) + '"></span>' +
      '<span class="lv-mark" style="left:' + w(mark) + '" title="' + esc(markLabel) + '"></span>' +
      '</div>';
  }
  function needLine(p, n, label) { return n === 0 ? '<b>' + label + ' reached</b>' : n + ' short of ' + label; }

  function chamberCard(title, t, seats, mark, markLabel, needs, notUpNote) {
    return '<div class="lv-card">' +
      '<div class="lv-card-h">' + esc(title) + '</div>' +
      '<div class="lv-tot"><span class="lv-tot-d"><span class="lv-n">' + t.D.total + '</span> D</span>' +
      (t.I.total ? '<span class="lv-tot-i"><span class="lv-n">' + t.I.total + '</span> I</span>' : '') +
      '<span class="lv-tot-r">R <span class="lv-n">' + t.R.total + '</span></span></div>' +
      bar(t, seats, mark, markLabel) +
      '<div class="lv-sub"><span>' + t.D.won + ' won &middot; ' + t.D.leading + ' leading</span><span>' + t.R.won + ' won &middot; ' + t.R.leading + ' leading</span></div>' +
      '<ul class="lv-need">' + needs + '</ul>' +
      (notUpNote ? '<div class="lv-note">' + notUpNote + '</div>' : '') +
      '</div>';
  }

  function raceRow(r, flipIds, fresh) {
    var L = window.LiveMath, lab = raceLabel(r.race_id);
    var lead = L.leaderOf(r), win = L.winnerOf(r);
    var status = win ? '<span class="lv-call lv-call-' + win.toLowerCase() + '">' + (win === 'D' ? 'Dem' : win === 'R' ? 'Rep' : 'Ind') + ' win' + (r.called_by ? ' &middot; ' + esc(r.called_by) : '') + '</span>'
      : lead ? '<span class="lv-lead lv-lead-' + lead.toLowerCase() + '">' + lead + ' leads</span>' : '<span class="lv-wait">Awaiting results</span>';
    var flip = flipIds[r.race_id] ? '<span class="lv-flip">Flip</span>' : '';
    var src = r.source_url ? '<a href="' + esc(r.source_url) + '" target="_blank" rel="noopener">' + esc(r.source || 'Source') + '</a>' : esc(r.source || '');
    var dCls = (win || lead) === 'D' ? ' lv-ahead' : '', rCls = (win || lead) === 'R' ? ' lv-ahead' : '';
    return '<tr class="' + (fresh === r.race_id ? 'lv-fresh' : '') + '" data-race="' + esc(r.race_id) + '">' +
      '<th scope="row"><span class="lv-kind">' + esc(lab.kind) + '</span> ' + esc(lab.name) + flip + '</th>' +
      '<td class="lv-cand' + dCls + '" data-label="Democrat"><span class="lv-cn">' + esc(r.cand_d || 'Democrat') + '</span><span class="lv-pc">' + pct(r.pct_d) + '</span></td>' +
      '<td class="lv-cand' + rCls + '" data-label="Republican"><span class="lv-cn">' + esc(r.cand_r || 'Republican') + '</span><span class="lv-pc">' + pct(r.pct_r) + '</span></td>' +
      '<td class="lv-num" data-label="Counted">' + pct(r.pct_counted) + '</td>' +
      '<td data-label="Status">' + status + '</td>' +
      '<td class="lv-src" data-label="Source">' + src + '</td>' +
      '</tr>';
  }

  function html(fresh) {
    var L = window.LiveMath, m = state.meta || {};
    var H = L.house(state.chambers), S = L.senate(state.chambers), G = L.gov(state.chambers);
    var holders = state.holders;
    var F = L.flips(state.races, holders), flipIds = {};
    F.list.forEach(function (f) { flipIds[f.race_id] = true; });
    var featured = state.races.filter(function (r) { return r.featured; });

    var statusTxt = { pre: 'Before polls close', counting: 'Counting', final: 'Final' }[m.status] || 'Counting';
    var conn = DEMO ? 'Demo data' : state.live ? 'Live' : 'Checking every 5 minutes';
    var head = '<div class="lv-head"><div><h2 class="lv-title">Election night: live results</h2>' +
      '<div class="lv-meta"><span class="lv-status lv-st-' + esc(m.status || 'counting') + '">' + statusTxt + '</span>' +
      '<span class="lv-conn' + (state.live ? ' on' : '') + '">' + conn + '</span>' +
      (m.last_update ? '<span>Updated ' + timeET(m.last_update) + '</span>' : '') + '</div></div>' +
      (m.turnout_pct != null ? '<div class="lv-turnout"><span class="lv-n">' + Number(m.turnout_pct).toFixed(1) + '%</span> turnout' +
        (m.turnout_source ? '<small>' + esc(m.turnout_source) + (m.turnout_updated ? ', ' + timeET(m.turnout_updated) : '') + '</small>' : '') + '</div>' : '') +
      '</div>';
    var notes = m.notes ? '<p class="lv-notes">' + esc(m.notes) + '</p>' : '';

    var cards = '<div class="lv-cards">' +
      chamberCard('House', H, 435, 218, '218 for a majority',
        '<li class="lv-d-t">D: ' + needLine('D', H.D.need.majority, '218') + '; ' + needLine('D', H.D.need.two_thirds, '290') + '</li>' +
        '<li class="lv-r-t">R: ' + needLine('R', H.R.need.majority, '218') + '; ' + needLine('R', H.R.need.two_thirds, '290') + '</li>') +
      chamberCard('Senate', S, 100, 50, 'Democrats need 51; Republicans 50 with the Vice President',
        '<li class="lv-d-t">D: ' + needLine('D', S.D.need.majority, '51') + '; ' + needLine('D', S.D.need.filibuster, '60') + '</li>' +
        '<li class="lv-r-t">R: ' + needLine('R', S.R.need.majority, '50') + '; ' + needLine('R', S.R.need.filibuster, '60') + '</li>',
        'Includes seats not up: ' + S.D.not_up + ' D (with 2 independents), ' + S.R.not_up + ' R. Republicans hold the tie-break.') +
      chamberCard('Governors', G, 50, 25, '26 for a majority',
        '<li class="lv-d-t">D: ' + needLine('D', G.D.need.majority, '26') + '</li><li class="lv-r-t">R: ' + needLine('R', G.R.need.majority, '26') + '</li>',
        'Includes ' + G.D.not_up + ' D and ' + G.R.not_up + ' R governors not up this year.') +
      '</div>';

    var flips = '<div class="lv-flips"><b>Flips so far</b> ' + (F.list.length
      ? F.list.map(function (f) { return '<span class="lv-fl lv-fl-' + f.to.toLowerCase() + '">' + esc(raceLabel(f.race_id).name) + ' ' + f.from + '&rarr;' + f.to + '</span>'; }).join(' ')
      : '<span class="lv-wait">None called yet</span>') + '</div>';

    var table = featured.length ? '<div class="lv-tw"><table class="lv-races"><caption>Featured races</caption>' +
      '<thead><tr><th scope="col">Race</th><th scope="col">Democrat</th><th scope="col">Republican</th><th scope="col" class="lv-num">Counted</th><th scope="col">Status</th><th scope="col">Source</th></tr></thead>' +
      '<tbody>' + featured.map(function (r) { return raceRow(r, flipIds, fresh); }).join('') + '</tbody></table></div>' : '';

    var foot = '<p class="lv-foot">Seat totals and calls come from our Results Desk. Vote shares come from official state results where a state publishes a feed, ' +
      'otherwise from the desk. &ldquo;Counted&rdquo; is the share of precincts reporting where that is all a state publishes. Flips compare a called winner with the party holding the seat now.</p>';
    return head + notes + cards + flips + table + foot;
  }

  var renderPending = null;
  function render(fresh) {
    if (!window.LiveMath) return;
    mounts.forEach(function (el) {
      if (!hasData()) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = html(fresh);
    });
    if (fresh) { clearTimeout(renderPending); renderPending = setTimeout(function () { mounts.forEach(function (el) { var t = el.querySelector('.lv-fresh'); if (t) t.classList.remove('lv-fresh'); }); }, 2500); }
    emit();
  }
  function emit() { document.dispatchEvent(new CustomEvent('racebook:live', { detail: state })); }

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-live-results]'));
    if (!document.querySelector('[data-live-results], [data-live-strip], [data-live-balance]')) return;
    setInterval(emit, 30000);   // countdowns and the automatic switch at first poll close
    mounts.forEach(function (el) { el.hidden = true; el.classList.add('lv'); el.setAttribute('aria-live', 'polite'); });
    loadHolders().then(function (h) {
      state.holders = h;
      if (DEMO) { demoState(); render(); setInterval(demoTick, 4000); return; }
      readAll().then(function () { render(); startRealtime(); });
      setInterval(function () { readAll().then(render); }, POLL_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) readAll().then(render); });
    });
  }

  window.RacebookLive = { state: state, ready: false, refresh: function () { return readAll().then(render); } };
  document.addEventListener('racebook:live', function () { window.RacebookLive.ready = true; });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
