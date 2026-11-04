/* Election-night live results.
 *
 * Reads assets/live.json, which scripts/live-from-news.js writes from our news
 * sources only (GitHub Actions, every 5 minutes). Re-read every 5 minutes and at
 * once when the tab wakes. Any element with data-live-results becomes a results panel.
 * ?demo=1 fills the panel with made-up figures, locally, for testing; add
 * &stage=pre, early, majority or final to see each stage (default: mid-count).
 * ?delayed=1 (with demo=1) fakes a last push 15 minutes old to show the watchdog.
 * Arithmetic lives in live-math.js. Other components (live-strip.js, balance.js,
 * battleground.js) listen for the "racebook:live" event, sent on every change and
 * every 30 seconds. state.nextPollAt / lastCheckedAt drive the visible refresh line.
 */
(function () {
  'use strict';

  var POLL_MS = 5 * 60 * 1000;
  var DEMO = /[?&]demo=1\b/.test(location.search);
  var STAGE = (/[?&]stage=(pre|early|mid|majority|final)\b/.exec(location.search) || [])[1] || 'mid';
  var DELAYED = /[?&]delayed=1\b/.test(location.search);
  // Demo clock: 8:15 pm ET on election night, so some states are still voting,
  // some counting and some called. Runs on from page load.
  var DEMO_T0 = Date.parse('2026-11-04T01:15:00Z'), LOADED = Date.now();
  function liveNow() { return DEMO && STAGE !== 'pre' ? DEMO_T0 + (Date.now() - LOADED) : Date.now(); }

  var ST = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
  var ABBR = {}; Object.keys(ST).forEach(function (k) { ABBR[ST[k]] = k; });

  // Seats not up this year, so the bars are right before live.json loads.
  var SEED_CHAMBERS = [['senate', 'D', 34], ['senate', 'R', 31], ['gov', 'D', 6], ['gov', 'R', 8]].map(function (x) {
    return { chamber: x[0], party: x[1], won: 0, leading: 0, not_up: x[2] };
  });
  var state = { meta: null, chambers: SEED_CHAMBERS.slice(), races: [], holders: {}, baseline: null, config: null, current: null,
    live: false, loaded: false, error: null, demo: DEMO, connected: DEMO, hadResults: false, pollMs: POLL_MS, nextPollAt: null, lastCheckedAt: null, lastCheckOk: null,
    pollClose: null, earlyVote: null, now: liveNow };
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

  // ── context: 119th makeup, seats up, and who held each seat before tonight ─
  function getJson(url) { return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
  function loadContext() {
    var bust = Math.floor(Date.now() / 600000);
    return Promise.all([getJson('data.json?t=' + bust), getJson('assets/live-config.json?t=' + bust), getJson('assets/live-baseline.json?t=' + bust),
                        getJson('data/poll-close.json?t=' + bust), getJson('data/early-vote.json?t=' + bust)]).then(function (res) {
      var d = res[0], races = d && d.races, h = {};
      state.config = res[1]; state.baseline = res[2]; state.pollClose = res[3]; state.earlyVote = res[4];
      if (races) {
        // The 119th Congress as it stands, shown before polls close.
        var hb = races.house && races.house.current_balance || {}, sb = races.senate && races.senate.current_balance || {}, gb = races.governor && races.governor.current_balance || {};
        state.current = { house: { D: hb.d || 0, R: hb.r || 0, I: hb.i || 0, vacant: hb.vacant || 0 }, senate: { D: sb.d || 0, R: sb.r || 0, I: 0 }, gov: { D: gb.d || 0, R: gb.r || 0, I: 0 } };
        (races.senate && races.senate.races || []).forEach(function (r) { if (r.code) h['Senate-' + r.code] = r.party; });
        (races.governor && races.governor.races || []).forEach(function (r) { var a = ABBR[r.state]; if (a) h['Gov-' + a] = r.party; });
        (races.house && races.house.competitive || []).forEach(function (r) { if (r.district) h[r.district] = r.party; });
      }
      // Flips compare with the expected party under a new map, else the 119th holder.
      var b = state.baseline;
      if (b) ['house', 'senate', 'gov'].forEach(function (c) {
        Object.keys(b[c] || {}).forEach(function (id) { var e = b[c][id]; h[id] = e.notional_party || e.holder; });
      });
      state.holders = h;
    });
  }

  // ── results: assets/live.json, written from our news sources by scripts/live-from-news.js ──
  // (GitHub Actions, every 5 minutes). Nothing else feeds the live results.
  var LIVE_URL = 'assets/live.json';
  function readAll() {
    return fetch(LIVE_URL + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var featured = {};
      if (state.config) state.config.senate.concat(state.config.house).forEach(function (r, i) { featured[r.race_id] = i + 1; });
      state.meta = { id: 1, status: j.status || 'counting', polls_first_close: '2026-11-03T23:00:00Z',
        last_update: j.changed || j.updated, last_push: j.updated, control: j.control || {}, source: 'news sources' };
      state.chambers = (j.chambers || []).map(function (c) { return Object.assign({ source: 'News sources' }, c); });
      var rows = {};
      (j.calls || []).forEach(function (c) {
        rows[c.race_id] = { race_id: c.race_id, winner: c.winner, leader: c.winner, called_by: c.called_by, confirmations: c.sources || [] };
      });
      Object.keys(j.featured || {}).forEach(function (id) {
        var f = j.featured[id], r = rows[id] || (rows[id] = { race_id: id });
        r.pct_d = f.pct_d; r.pct_r = f.pct_r; r.pct_counted = f.pct_counted; r.source = f.source; r.source_url = f.url; r.updated_at = f.at;
        if (!r.winner) r.leader = f.leader;
      });
      state.races = Object.keys(rows).map(function (id) { var r = rows[id]; r.featured = !!featured[id]; r.featured_order = featured[id] || null; return r; });
      if (state.races.length) state.hadResults = true;
      state.loaded = true; state.error = null; state.lastCheckedAt = Date.now(); state.lastCheckOk = true;
    }).catch(function (e) { state.error = e.message; state.lastCheckedAt = Date.now(); state.lastCheckOk = false; })   // keep the last numbers
      .then(function () { state.connected = connected(); });
  }
  // Connected while live.json keeps updating (a run every 5 minutes, a heartbeat at least every 10).
  var STALE_MS = 20 * 60 * 1000;
  function connected() {
    if (DEMO) return true;
    var m = state.meta;
    return !state.error && !!m && !!m.last_push && Date.now() - Date.parse(m.last_push) <= STALE_MS;
  }

  // ── demo data (?demo=1): made up, never sent anywhere ─────────────────────
  // Every race gets a row; the shares of called and leading races depend on the stage.
  // Built-in scenarios: Senate-TX called R→D and Senate-MI called D→R (a flip each way),
  // FL-22 (redrawn Florida: held by D on the old map, expected R on the new one) called D,
  // and Senate-ME leading D, then called about 12 seconds after load.
  var DEMO_SHARE = { pre: [0, 0], early: [0.22, 0.6], mid: [0.55, 0.85], majority: [0.92, 0.9], final: [0.99, 1] };
  var DEMO_FLIP = { 'Senate-TX': 'D', 'Senate-MI': 'R', 'FL-22': 'D', 'PA-07': 'D', 'PA-08': 'D', 'IA-01': 'D', 'AZ-01': 'D', 'AZ-06': 'D',
    'CO-08': 'D', 'VA-02': 'D', 'WI-03': 'D', 'OH-09': 'D', 'TX-15': 'D', 'NC-11': 'D', 'ME-02': 'R', 'Gov-WI': 'D', 'Gov-NV': 'R', 'Gov-GA': 'D' };
  var DEMO_CALLED = ['Senate-TX', 'Senate-MI', 'FL-22'];
  var DEMO_LEAD = { 'Senate-ME': 'D', 'Senate-AK': 'D', 'Senate-IA': 'R', 'NY-17': 'D', 'MI-07': 'D', 'CA-22': 'R', 'Gov-AK': 'D' };
  function demoState() {
    var now = new Date(), iso = now.toISOString(), pre = STAGE === 'pre';
    var close = pre ? new Date(now.getTime() + (3 * 60 + 12) * 60000).toISOString() : '2026-11-03T23:00:00Z';
    state.meta = { status: pre ? 'pre' : STAGE === 'final' ? 'final' : 'counting', polls_first_close: close, counting_started: pre ? null : new Date(now.getTime() - (2 * 60 + 35) * 60000).toISOString(),
      last_update: new Date(now.getTime() - 95000).toISOString(), last_push: DELAYED ? new Date(now.getTime() - 15 * 60000).toISOString() : new Date(now.getTime() - 40000).toISOString(),
      turnout_pct: pre ? null : 48.6, turnout_source: 'Demo figure', turnout_updated: iso, notes: 'Demo data: these figures are made up.' };
    var seed = 11, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    var share = DEMO_SHARE[STAGE], b = state.baseline || { house: {}, senate: {}, gov: {} };
    var featured = {};
    if (state.config) state.config.senate.concat(state.config.house).forEach(function (r, i) { featured[r.race_id] = { order: i + 1, cfg: r }; });
    state.races = [];
    ['house', 'senate', 'gov'].forEach(function (c) {
      Object.keys(b[c] || {}).forEach(function (id) {
        var held = state.holders[id] || b[c][id].holder;
        var out = DEMO_FLIP[id] || held;
        var stc = state.pollClose && state.pollClose.states[/^(?:Senate-|Gov-)?([A-Z]{2})/.exec(id)[1]];
        var open = pre || (STAGE !== 'final' && STAGE !== 'majority' && stc && Date.parse(stc.first_close_utc) > liveNow());   // polls still open at the demo clock
        var called = !open && (DEMO_CALLED.indexOf(id) >= 0 || (!DEMO_LEAD[id] && rnd() < share[0]));
        var leader = open ? null : called ? out : DEMO_LEAD[id] || (rnd() < share[1] ? (rnd() < 0.85 ? out : (out === 'D' ? 'R' : 'D')) : null);
        var row = { race_id: id, featured: !!featured[id], featured_order: featured[id] ? featured[id].order : null, leader: leader,
          winner: called ? out : null, called_by: called ? 'AP' : null, called_at: called ? new Date(liveNow() - Math.round(rnd() * 40) * 60000).toISOString() : null,
          source: 'Demo', other_sources: [], updated_at: iso };
        if (featured[id] && leader) {
          var lead = 50 + rnd() * 3.5, trail = 100 - lead - 1 - rnd();
          row.pct_d = +(leader === 'D' ? lead : trail).toFixed(1); row.pct_r = +(leader === 'R' ? lead : trail).toFixed(1);
          row.pct_counted = called ? 92 + Math.round(rnd() * 7) : Math.round(35 + rnd() * 50);
          var v22 = b[c][id].votes_2022 || 260000;
          row.total_votes = Math.round(v22 * 1.08 * row.pct_counted / 100);
          if (featured[id].order % 4 === 1) row.other_sources = [{ name: 'State results feed (demo)', pct_d: +(row.pct_d - 0.3).toFixed(1), pct_r: +(row.pct_r + 0.3).toFixed(1), pct_counted: row.pct_counted - 2, at: iso }];
        }
        state.races.push(row);
      });
    });
    // triangulated calls (Calls.gs) for testing the "confirmed by n sources" display
    var conf = [{ publisher: 'The Texas Tribune', url: 'https://www.texastribune.org/', title: 'Talarico defeats Paxton to win Texas Senate seat (demo)' },
                { publisher: 'Houston Chronicle', url: 'https://www.houstonchronicle.com/', title: 'James Talarico wins Texas Senate race (demo)' },
                { publisher: 'NBC News', url: 'https://www.nbcnews.com/', title: 'NBC News projects James Talarico wins (demo)', desk: 'NBC News' }];
    state.races.forEach(function (r) { if (r.race_id === 'Senate-TX' && r.winner) { r.confirmations = conf; r.called_by = 'NBC News · 3 sources'; } });
    if (STAGE === 'majority' || STAGE === 'final') state.meta.control = { house: { party: 'D', called_by: '3 sources', confirmations: conf.map(function (c) { return { publisher: c.publisher, url: c.url, title: 'Democrats win control of the House (demo)' }; }) } };
    demoChambers();
    state.loaded = true; state.live = true; state.lastCheckedAt = Date.now(); state.lastCheckOk = true; state.nextPollAt = Date.now() + POLL_MS;
  }
  // Seat totals follow the demo rows, so every component agrees.
  function demoChambers() {
    var cfg = state.config || {}, nu = { senate: (cfg.senate_summary || {}).not_up || { D: 34, R: 31 }, gov: (cfg.gov_summary || {}).not_up || { D: 6, R: 8 } };
    var t = {};
    ['house', 'senate', 'gov'].forEach(function (c) { ['D', 'R', 'I'].forEach(function (p) { t[c + p] = { chamber: c, party: p, won: 0, leading: 0, not_up: (nu[c] || {})[p] || 0, source: 'Demo' }; }); });
    state.races.forEach(function (r) {
      var c = window.LiveMath.chamberOf(r.race_id);
      if (r.winner) t[c + r.winner].won++; else if (r.leader) t[c + r.leader].leading++;
    });
    state.chambers = Object.keys(t).map(function (k) { return t[k]; });
  }
  function demoTick() {   // pull one featured race towards a tie (sometimes past it) so lead changes can be seen
    var open = state.races.filter(function (r) { return r.featured && !r.called_by && r.pct_d != null && r.race_id !== 'Senate-ME'; });
    if (!open.length) return;
    var r = open[Math.floor(Math.random() * open.length)];
    var sw = (r.pct_d > r.pct_r ? -1 : 1) * (0.4 + Math.random() * 1.6);
    r.pct_d = +(r.pct_d + sw / 2).toFixed(1); r.pct_r = +(r.pct_r - sw / 2).toFixed(1);
    r.leader = r.pct_d === r.pct_r ? r.leader : (r.pct_d > r.pct_r ? 'D' : 'R');
    r.pct_counted = Math.min(99, r.pct_counted + 1);
    r.updated_at = new Date().toISOString(); state.meta.last_update = r.updated_at;
    demoChambers(); render(r.race_id);
  }
  function demoCallMaine() {   // a leading pickup becomes a called pickup
    var r = state.races.filter(function (x) { return x.race_id === 'Senate-ME'; })[0];
    if (!r || STAGE === 'pre') return;
    r.winner = 'D'; r.called_by = 'AP'; r.called_at = new Date(liveNow()).toISOString(); r.pct_counted = 94; r.updated_at = new Date().toISOString();
    state.meta.last_update = r.called_at; demoChambers(); render('Senate-ME');
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

    var foot = '<p class="lv-foot">Calls and vote shares come only from our news sources: a race is called when three different publishers report the same winner and none contradicts it. ' +
      'Vote shares are the latest a news report gave. Flips compare a called winner with the party holding the seat before the election.</p>';
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

  // ── polling: every 5 minutes, and at once when the tab wakes or comes back online ──
  var pollTimer = null;
  function schedule() { clearTimeout(pollTimer); state.nextPollAt = Date.now() + POLL_MS; pollTimer = setTimeout(poll, POLL_MS); emit(); }
  function poll() {
    if (DEMO) { state.lastCheckedAt = Date.now(); state.lastCheckOk = true; schedule(); return Promise.resolve(); }
    return readAll().then(render).then(schedule, schedule);
  }

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-live-results]'));
    if (!document.querySelector('[data-live-results], [data-live-strip], [data-live-balance], [data-live-battleground]')) return;
    setInterval(emit, 30000);   // countdowns and the automatic switch at first poll close
    mounts.forEach(function (el) { el.hidden = true; el.classList.add('lv'); el.setAttribute('aria-live', 'polite'); });
    loadContext().then(function () {
      document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
      window.addEventListener('online', function () { poll(); });
      if (DEMO) {
        demoState(); render(); schedule();
        if (STAGE !== 'pre') { setInterval(demoTick, 3500); setTimeout(demoCallMaine, 12000); }
        return;
      }
      readAll().then(function () { render(); schedule(); });
    });
  }

  window.RacebookLive = { state: state, ready: false, refresh: function () { return readAll().then(render); } };
  document.addEventListener('racebook:live', function () { window.RacebookLive.ready = true; });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
