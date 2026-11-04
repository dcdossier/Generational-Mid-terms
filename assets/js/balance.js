/* "Projected 120th Congress": House, Senate and Governor seat bars (any element with data-live-balance).
 *
 * One cell per seat (435 House, 100 Senate, 50 governorships). Democrats fill from the
 * left, Republicans from the right. Seats not up tonight are the outermost segments in
 * a muted solid tone ("Not up (34)"); tonight's seats use 45° stripes: dense in the
 * party colour for called seats, sparse and lighter for leading, grey for not yet called.
 * Under each party: what it still needs, and gains and losses against the party that
 * held each seat before the election (live-baseline.json; notional party in redrawn
 * states). Before polls close the bars show the makeup as it stands.
 * Data and phase come from live.js / live-math.js ("racebook:live" events).
 */
(function () {
  'use strict';

  // Colours and stripes follow ~/Downloads/balance-mock.html (Prompt 45).
  var C = {
    D: '#2b4c9b', Dl: '#dbe4f6', R: '#b4232a', Rl: '#f6dcdc', I: '#5B5F66', Il: '#E4E5E7', un: '#eceae4',
    dText: '#1f3a8a', rText: '#9b1c1c', d60: '#3a5bb0', r60: '#a33a3a', d67: '#1f3a8a', r67: '#7f1d1d', ink: '#1c2430'
  };
  var SEATS = { house: 435, senate: 100, gov: 50 };
  var UP = { house: 435, senate: 35, gov: 36 };
  var NAME = { house: 'House', senate: 'Senate', gov: 'Governors' };
  var uid = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function timeET(iso) { var d = new Date(iso); return !iso || isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'; }
  function timeIST(iso) { var d = new Date(iso); return !iso || isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST'; }
  function signed(n) { return n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0'; }

  // Called: solid party colour with faint white 45° stripes. Leading: pale fill with
  // party-colour stripes. Not yet called: flat grey. Not up: party colour at 35%, no stripes.
  function patterns(id) {
    function pat(name, bg, line, op) {
      return '<pattern id="' + id + name + '" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
        '<rect width="8" height="8" fill="' + bg + '"/><line x1="0" y1="0" x2="0" y2="8" stroke="' + line + '" stroke-opacity="' + op + '" stroke-width="2"/></pattern>';
    }
    return '<defs>' + pat('d', C.D, '#fff', '.18') + pat('dl', C.Dl, C.D, '.35') + pat('r', C.R, '#fff', '.18') + pat('rl', C.Rl, C.R, '.35') +
      pat('i', C.I, '#fff', '.18') + pat('il', C.Il, C.I, '.35') + '</defs>';
  }
  function fillOf(id, type) {
    if (type === 'nud') return C.D + '" fill-opacity=".35';
    if (type === 'nur') return C.R + '" fill-opacity=".35';
    if (type === 'u') return C.un;
    return 'url(#' + id + type + ')';
  }

  // runs: [{type, n, label?}] left to right; o: {maj, majLabel, marks:[{v, l, dcol, rcol}]}
  function barSvg(id, total, runs, width, o, compact) {
    var H = 20, many = o.marks.length > 0, top = compact ? 26 : (many ? 62 : 40), bottom = compact ? 14 : (many ? 50 : 14), x = function (v) { return v / total * width; };
    var a = 0, g = '';
    runs.forEach(function (run) {
      if (run.n <= 0) return;
      var w = Math.max(0, x(run.n) - 1.5);
      g += '<rect x="' + x(a).toFixed(2) + '" y="' + top + '" width="' + w.toFixed(2) + '" height="' + H + '" rx="3" fill="' + fillOf(id, run.type) + '"/>';
      if (run.label && w >= 70) g += '<text x="' + (x(a) + w / 2).toFixed(1) + '" y="' + (top + 14) + '" text-anchor="middle" class="bl-nu-t" fill="' + (run.type === 'nud' ? C.dText : C.rText) + '">' + esc(run.label) + '</text>';
      a += run.n;
    });
    var mx = x(o.maj);
    g += '<line x1="' + mx.toFixed(1) + '" y1="' + (top - 8) + '" x2="' + mx.toFixed(1) + '" y2="' + (top + H + 8) + '" stroke="' + C.ink + '" stroke-width="1.5" stroke-dasharray="3 3"/>';
    if (!compact) g += '<text x="' + mx.toFixed(1) + '" y="' + (top - 32) + '" text-anchor="middle" font-size="12" font-weight="600" fill="' + C.ink + '">' + esc(o.majLabel) + '</text>';
    o.marks.forEach(function (m, i) {
      var dx = x(m.v), rx = x(total - m.v), up = i % 2 ? 32 : 14, dn = i % 2 ? 40 : 24;
      g += '<path d="M' + (dx - 5).toFixed(1) + ',' + (top - 9) + ' L' + (dx + 5).toFixed(1) + ',' + (top - 9) + ' L' + dx.toFixed(1) + ',' + (top - 2) + 'z" fill="' + m.dcol + '"/>';
      g += '<path d="M' + (rx - 5).toFixed(1) + ',' + (top + H + 9) + ' L' + (rx + 5).toFixed(1) + ',' + (top + H + 9) + ' L' + rx.toFixed(1) + ',' + (top + H + 2) + 'z" fill="' + m.rcol + '"/>';
      if (!compact) {
        g += '<text x="' + dx.toFixed(1) + '" y="' + (top - up) + '" text-anchor="middle" font-size="11.5" fill="' + m.dcol + '">Dem ' + esc(m.l) + ' ' + m.v + '</text>';
        g += '<text x="' + rx.toFixed(1) + '" y="' + (top + H + dn) + '" text-anchor="middle" font-size="11.5" fill="' + m.rcol + '">Rep ' + esc(m.l) + ' ' + m.v + '</text>';
      }
    });
    return '<svg class="bl-svg" width="' + width + '" height="' + (top + H + bottom) + '" viewBox="0 0 ' + width + ' ' + (top + H + bottom) + '" aria-hidden="true" focusable="false" style="overflow:visible">' +
      patterns(id) + g + '</svg>';
  }

  // Marks: Democratic thresholds above the bar (from the left), Republican below (from the right).
  function MARKS(key) {
    if (key === 'house') return { maj: 217.5, majLabel: 'Majority 218', marks: [{ v: 290, l: 'two-thirds', dcol: C.d67, rcol: C.r67 }] };
    if (key === 'senate') return { maj: 50.5, majLabel: 'Majority · Dem 51 / Rep 50 (VP)',
      marks: [{ v: 60, l: 'filibuster', dcol: C.d60, rcol: C.r60 }, { v: 67, l: 'two-thirds', dcol: C.d67, rcol: C.r67 }] };
    return { maj: 25, majLabel: 'Majority 26', marks: [] };
  }
  // Phones: the marks' words move under the bar.
  function markKey(o) {
    return '<ul class="bl-key"><li><span class="bl-sw bl-sw-dash"></span>' + esc(o.majLabel) + '</li>' + o.marks.map(function (m) {
      return '<li><span class="bl-tri" style="color:' + m.dcol + '">▼</span>Dem ' + esc(m.l) + ' ' + m.v + ' <span class="bl-tri" style="color:' + m.rcol + '">▲</span>Rep ' + esc(m.l) + ' ' + m.v + '</li>';
    }).join('') + '</ul>';
  }

  function needText(n, what, done) { return n === 0 ? '<b>' + done + '</b>' : '<b class="bl-n">' + n + '</b> ' + what; }
  function notUpOf(st, key) {
    var c = st.config && st.config[key === 'senate' ? 'senate_summary' : 'gov_summary'];
    if (key !== 'house' && c && c.not_up) return c.not_up;
    return key === 'senate' ? { D: 34, R: 31 } : key === 'gov' ? { D: 6, R: 8 } : { D: 0, R: 0 };
  }
  function summaryText(st, key) {
    if (key === 'house') return '';
    var c = st.config && st.config[key === 'senate' ? 'senate_summary' : 'gov_summary'];
    return c && c.text ? c.text : '';
  }

  function gainLines(g, p) {
    if (!g) return '';
    var x = g[p];
    var line = 'Gained ' + x.gained + ' &middot; Lost ' + x.lost + ' &middot; Net ' + signed(x.net) + (g.basis === 'desk' ? ' <small>(desk tally)</small>' : '');
    var lead = x.leadGain + ' more leading pickup' + (x.leadGain === 1 ? '' : 's') + ' &middot; ' + x.leadLoss + ' more leading loss' + (x.leadLoss === 1 ? '' : 'es');
    return '<span class="bl-gain">' + line + '</span>' + (g.basis === 'desk' ? '' : '<span class="bl-glead">' + lead + '</span>');
  }

  // Without results (or with the live tables unreachable) show the makeup before the election, never zeros.
  function showPre(st) {
    if (window.LiveMath.phase(st.meta) === 'pre') return true;
    if (st.demo) return false;
    var any = (st.chambers || []).some(function (c) { return c.won || c.leading; });
    return !any;
  }
  // Per chamber: one with no calls or leads yet keeps showing its seats before the election.
  function showPreFor(st, key) {
    if (showPre(st)) return true;
    if (st.demo) return false;
    return !(st.chambers || []).some(function (c) { return c.chamber === key && (c.won || c.leading); });
  }
  function chamber(st, key, width) {
    var L = window.LiveMath, pre = showPreFor(st, key);
    var total = SEATS[key], up = UP[key], mk = MARKS(key), nu = notUpOf(st, key), compact = width < 560;
    var runs, t, sr, g = null, nm = NAME[key];

    if (pre) {
      var cur = (st.current && st.current[key]) || { D: 0, R: 0, I: 0, vacant: 0 };
      var D = cur.D, R = cur.R, I = cur.I || 0;
      var dUp = Math.max(0, D - nu.D), rUp = Math.max(0, R - nu.R);
      var gapSeats = Math.max(0, total - D - R - I);
      runs = key === 'house'
        ? [{ type: 'd', n: D }, { type: 'i', n: I }, { type: 'u', n: gapSeats }, { type: 'r', n: R }]
        : [{ type: 'nud', n: nu.D, label: 'Not up (' + nu.D + ')' }, { type: 'd', n: dUp }, { type: 'u', n: gapSeats }, { type: 'r', n: rUp }, { type: 'nur', n: nu.R, label: 'Not up (' + nu.R + ')' }];
      var maj = key === 'house' ? 218 : key === 'senate' ? 51 : 26;
      var holder = R >= (key === 'senate' ? 50 : maj) ? 'Republicans' : D >= maj ? 'Democrats' : null;
      t = { D: D, R: R, I: I,
        textD: '<b class="bl-n">' + D + '</b> Democrats' + (key === 'senate' ? ' (incl. 2 independents)' : ''),
        textR: '<b class="bl-n">' + R + '</b> Republicans',
        mid: key === 'house' ? (I ? I + ' independent' : '') + (I && cur.vacant ? ' · ' : '') + (cur.vacant ? cur.vacant + ' vacant' : '') : up + ' up tonight' };
      sr = nm + ' before the election: Democrats ' + D + ', Republicans ' + R + (I ? ', independents ' + I : '') + (cur.vacant ? ', ' + cur.vacant + ' vacant' : '') +
        (key !== 'house' ? '. ' + up + ' seats are up tonight; Democrats ' + nu.D + ' and Republicans ' + nu.R + ' are not up' : '') + '. ' + (holder ? holder + ' hold the majority.' : '');
    } else {
      var x = key === 'house' ? L.house(st.chambers) : key === 'senate' ? L.senate(st.chambers) : L.gov(st.chambers);
      if (key !== 'house') {
        x.D.not_up = nu.D; x.R.not_up = nu.R;
        x.D.total = nu.D + x.D.won + x.D.leading; x.R.total = nu.R + x.R.won + x.R.leading;
        var thr = key === 'senate' ? { D: [51, 60, 67], R: [50, 60, 67] } : { D: [26], R: [26] };
        ['D', 'R'].forEach(function (p) { x[p].need = { majority: L.need(thr[p][0], x[p].total), filibuster: L.need(thr[p][1] || 0, x[p].total), two_thirds: L.need(thr[p][2] || 0, x[p].total) }; });
      }
      // Totals and what each party still needs count called seats only (plus seats not up);
      // leads stay visible as the lighter stripes but never reach a majority on their own.
      ['D', 'R', 'I'].forEach(function (p) { x[p].total = (x[p].not_up || 0) + x[p].won; });
      var thrC = key === 'senate' ? { D: [51, 60, 67], R: [50, 60, 67] } : key === 'gov' ? { D: [26], R: [26] } : { D: [218, 0, 290], R: [218, 0, 290] };
      ['D', 'R'].forEach(function (p) { x[p].need = { majority: L.need(thrC[p][0], x[p].total), filibuster: L.need(thrC[p][1] || 0, x[p].total), two_thirds: L.need(thrC[p][2] || 0, x[p].total) }; });
      var calledN = x.D.won + x.R.won + x.I.won;
      var tonightUn = Math.max(0, up - calledN - x.D.leading - x.R.leading - x.I.leading);
      runs = (key === 'house' ? [] : [{ type: 'nud', n: nu.D, label: 'Not up (' + nu.D + ')' }]).concat([
        { type: 'd', n: x.D.won }, { type: 'dl', n: x.D.leading }, { type: 'i', n: x.I.won }, { type: 'il', n: x.I.leading },
        { type: 'u', n: tonightUn }, { type: 'rl', n: x.R.leading }, { type: 'r', n: x.R.won }]).concat(key === 'house' ? [] : [{ type: 'nur', n: nu.R, label: 'Not up (' + nu.R + ')' }]);
      g = L.gains(key, st.races, st.holders, st.chambers);
      // Fox's own flip counts (flipped_to per party) win over our baseline comparison
      if (st.flips && st.flips[key]) ['D', 'R', 'I'].forEach(function (p) {
        var f = st.flips[key][p]; if (!f) return;
        g[p].gained = f.gained; g[p].lost = f.lost; g[p].net = f.net; g.basis = 'races';
      });
      var needs = function (p) {
        var n = x[p].need, s = needText(n.majority, 'needed for majority', 'Majority reached');
        if (key === 'house') s += ' · ' + needText(n.two_thirds, 'for two-thirds', 'Two-thirds reached');
        if (key === 'senate') s += ' · ' + needText(n.filibuster, 'to break filibuster', 'Filibuster-proof') + ' · ' + needText(n.two_thirds, 'for supermajority', 'Supermajority reached');
        return '<span class="bl-needline">' + s + '</span>';
      };
      t = { D: x.D.total, R: x.R.total, I: x.I.total, textD: needs('D') + gainLines(g, 'D'), textR: needs('R') + gainLines(g, 'R'),
        mid: (up - calledN) + ' of ' + up + ' not yet called' };
      var line = function (name, y, p) {
        var n = y.need, parts = [name + ' ' + y.total + ' (' + (y.not_up ? y.not_up + ' not up, ' : '') + y.won + ' won, ' + y.leading + ' leading)'];
        parts.push(n.majority ? n.majority + ' needed for majority' : 'majority reached');
        if (key === 'senate') { parts.push(n.filibuster ? n.filibuster + ' to break filibuster' : 'filibuster-proof'); parts.push(n.two_thirds ? n.two_thirds + ' for supermajority' : 'supermajority reached'); }
        var q = g[p]; parts.push('gained ' + q.gained + ', lost ' + q.lost + ', net ' + signed(q.net).replace('−', 'minus '));
        if (g.basis !== 'desk') parts.push(q.leadGain + ' more leading pickups, ' + q.leadLoss + ' more leading losses');
        return parts.join(', ');
      };
      sr = nm + ': ' + line('Democrats', x.D, 'D') + '. ' + line('Republicans', x.R, 'R') + '. ' + (x.I.total ? 'Independents ' + x.I.total + '. ' : '') +
        (up - calledN) + ' of ' + up + ' races tonight not yet called.' +
        (key === 'senate' ? ' Democrats need 51 for a majority; Republicans need 50 because the Vice President breaks ties.' : key === 'house' ? ' 218 seats are needed for a majority.' : ' 26 governorships are a majority.');
    }

    var id = 'blp' + (++uid) + '-', summ = summaryText(st, key);
    var ctl = !pre && st.meta && st.meta.control && st.meta.control[key];
    var ctlHtml = ctl && ctl.party ? '<div class="bl-control bl-control-' + ctl.party.toLowerCase() + '">' + (ctl.party === 'D' ? 'Democrats' : 'Republicans') + ' win control · ' +
      (window.LiveSeat ? window.LiveSeat.confHtml({ text: 'confirmed by ' + (ctl.confirmations || []).length + ' sources', conf: ctl.confirmations }, 'bl-conf') : 'confirmed by ' + (ctl.confirmations || []).length + ' sources') + '</div>' : '';
    return '<div class="bl-ch bl-ch-' + key + '">' +
      '<div class="bl-ch-head"><span class="bl-ch-name">' + nm + ' <small>' + total + ' seats</small></span>' +
        '<span class="bl-tot"><span class="bl-tot-d">D ' + t.D + '</span>' + (t.I ? '<span class="bl-tot-i">I ' + t.I + '</span>' : '') + '<span class="bl-tot-r">R ' + t.R + '</span></span></div>' +
      (summ ? '<p class="bl-summ">' + esc(summ) + '</p>' : '') + ctlHtml +
      (pre && !showPre(st) ? '<p class="bl-summ bl-nocalls">No calls yet in this chamber: showing seats before the election.</p>' : '') +
      '<p class="sr-only">' + esc(sr) + '</p>' +
      '<div class="bl-bar">' + barSvg(id, total, runs, width, mk, compact) + '</div>' +
      (compact ? markKey(mk) : '') +
      '<div class="bl-needs" aria-hidden="true"><span class="bl-need-d">' + t.textD + '</span>' + (t.mid ? '<span class="bl-mid">' + esc(t.mid) + '</span>' : '') + '<span class="bl-need-r">' + t.textR + '</span></div>' +
      '</div>';
  }

  function tipButton(id, label, text) {
    return '<button type="button" class="bl-q" aria-expanded="false" aria-controls="' + id + '" aria-label="' + esc(label) + '"></button>' +
      '<span class="bl-tip" id="' + id + '" role="tooltip" hidden>' + text + '</span>';
  }
  function legend(pre, base) {
    function sw(cls) { return '<i class="bl-lg-sw bl-lg-' + cls + '"></i>'; }
    var marks = '<span class="bl-lg-marks">▼ Democratic marks above · ▲ Republican marks below</span>';
    if (pre) return '<div class="bl-legend"><span>' + sw('called-d') + sw('called-r') + 'Current seats</span><span>' + sw('nu-d') + sw('nu-r') + 'Not up tonight</span><span>' + sw('un') + 'Vacant or other</span>' + marks + '</div>';
    return '<div class="bl-legend"><span>' + sw('nu-d') + sw('nu-r') + 'Not up</span><span>' + sw('called-d') + sw('called-r') + 'Called</span><span>' + sw('lead-d') + sw('lead-r') + 'Leading</span><span>' + sw('un') + 'Not yet called</span>' +
      '<span class="bl-qwrap">' + tipButton(base + 'a', 'What does leading mean?', 'Leading is not won. A leading seat is one where a candidate is ahead in the votes counted so far; the lead can change as more votes are counted. Only called races are counted as won.') + '</span>' +
      '<span class="bl-qwrap bl-qgain">Gains and losses' + tipButton(base + 'b', 'What do gained, lost and net mean?',
        '<b>Gained</b>: called races a party won in seats another party held before the election. <b>Lost</b>: called races in seats the party held that another party won. <b>Net</b>: gained minus lost. Leading pickups and losses are the same comparison for races not yet called. In redrawn states the comparison is with the party expected under the new map.') + '</span>' + marks + '</div>';
  }

  function html(el, st) {
    var L = window.LiveMath, ph = L.phase(st.meta), pre = showPre(st);
    var mEl = el.querySelector('.bl-measure');
    var width = Math.max(240, Math.floor(mEl ? mEl.getBoundingClientRect().width : el.clientWidth - 40));
    var sub = pre && ph !== 'pre' ? '<span class="bl-stage bl-stage-off">' + (st.connected === false ? 'Updates delayed' : 'No calls yet') + '</span> Showing seats before the election until results arrive.'
      : pre ? '<span class="bl-stage">Before the election</span> The 119th Congress and governorships as they stand. The bars switch to the live count when polls close.'
      : ph === 'final' ? '<span class="bl-stage bl-stage-final">Final count</span>' + (st.meta && st.meta.last_update ? ' Updated ' + timeET(st.meta.last_update) + '.' : '')
      : 'Live count' + (st.meta && st.meta.last_update ? ' · updated ' + timeIST(st.meta.last_update) : '') + ' · Senate includes seats not up this year';
    if (st.demo) sub += ' <b>Demo data.</b>';
    var foot = !pre && st.baseline && st.baseline.footnote ? '<p class="bl-foot">' + esc(st.baseline.footnote) + '</p>' : '';
    return '<div class="bl-head"><h2 class="bl-title">Projected 120th Congress</h2><p class="bl-sub">' + sub + '</p></div>' +
      '<div class="bl-measure"></div>' +
      chamber(st, 'house', width) + chamber(st, 'senate', width) + chamber(st, 'gov', width) + legend(pre, 'bl-tip-' + (++uid)) + foot;
  }

  var mounts = [], last = null;
  function render(st) {
    if (!window.LiveMath || !st) return;
    last = st;
    mounts.forEach(function (el) {
      var open = [].map.call(el.querySelectorAll('.bl-q[aria-expanded="true"]'), function (b) { return b.getAttribute('aria-label'); });
      el.innerHTML = html(el, st);
      [].forEach.call(el.querySelectorAll('.bl-q'), function (b) { if (open.indexOf(b.getAttribute('aria-label')) >= 0) toggleTip(b, true); });
    });
  }
  function toggleTip(btn, show) {
    var tip = btn && document.getElementById(btn.getAttribute('aria-controls'));
    if (!tip) return;
    show = show == null ? tip.hidden : show;
    tip.hidden = !show; btn.setAttribute('aria-expanded', String(show));
  }

  function init() {
    mounts = [].slice.call(document.querySelectorAll('[data-live-balance]'));
    if (!mounts.length) return;
    mounts.forEach(function (el) {
      el.classList.add('bl');
      el.addEventListener('click', function (e) {
        var b = e.target.closest('.bl-q'); if (!b) return;
        [].forEach.call(el.querySelectorAll('.bl-q[aria-expanded="true"]'), function (o) { if (o !== b) toggleTip(o, false); });
        toggleTip(b);
      });
      el.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var b = el.querySelector('.bl-q[aria-expanded="true"]'); if (b) { toggleTip(b, false); b.focus(); } } });
    });
    document.addEventListener('racebook:live', function (e) { render(e.detail); });
    if (window.RacebookLive && window.RacebookLive.ready) render(window.RacebookLive.state);
    // Redraw at the new width (also when a hidden tab becomes visible).
    var t, widths = mounts.map(function (el) { return el.clientWidth; });
    var redraw = function () { clearTimeout(t); t = setTimeout(function () {
      var now = mounts.map(function (el) { return el.clientWidth; });
      if (last && now.join() !== widths.join()) { widths = now; render(last); }
    }, 120); };
    if (window.ResizeObserver) mounts.forEach(function (el) { new ResizeObserver(redraw).observe(el); });
    else window.addEventListener('resize', redraw);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
