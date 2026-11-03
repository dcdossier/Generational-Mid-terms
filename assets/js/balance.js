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

  var C = {
    D: '#1A2F7A', Dl: '#7F9BE0', R: '#7A1A1A', Rl: '#DC8C8C', I: '#5B5F66', Il: '#A3A6AB', un: '#C9C6BA',
    D218: '#8EB4F0', R218: '#F2A7B8', D290: '#0E1F5C', R290: '#5C0F0F', D60: '#3F62C4', R60: '#B54848',
    nuD: 'rgba(26,47,122,.35)', nuR: 'rgba(122,26,26,.35)'
  };
  var SEATS = { house: 435, senate: 100, gov: 50 };
  var UP = { house: 435, senate: 35, gov: 36 };
  var NAME = { house: 'House', senate: 'Senate', gov: 'Governors' };
  var uid = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function timeET(iso) { var d = new Date(iso); return !iso || isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'; }
  function signed(n) { return n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0'; }

  // 45° stripes for tonight's seats; not-up seats are solid (fill colour, no pattern).
  function patterns(id) {
    function pat(name, size, stroke, colour, bg) {
      return '<pattern id="' + id + name + '" width="' + size + '" height="' + size + '" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
        '<rect width="' + size + '" height="' + size + '" fill="' + bg + '"/>' +
        '<rect width="' + stroke + '" height="' + size + '" fill="' + colour + '"/></pattern>';
    }
    return '<defs>' +
      pat('d', 4, 3, C.D, '#3B54A0') + pat('dl', 7, 2, C.Dl, '#F3F6FD') +
      pat('r', 4, 3, C.R, '#A13A3A') + pat('rl', 7, 2, C.Rl, '#FDF4F4') +
      pat('i', 4, 3, C.I, '#7D8086') + pat('il', 7, 2, C.Il, '#F5F5F5') +
      pat('u', 7, 1.5, C.un, '#F4F2EC') +
      '</defs>';
  }
  function fillOf(id, type) { return type === 'nud' ? C.nuD : type === 'nur' ? C.nuR : 'url(#' + id + type + ')'; }

  // runs: [{type, n, label?}] left to right. One cell per seat; labelled runs get text inside.
  function barSvg(id, total, runs, width, markers) {
    var H = 30, top = 7, cw = width / total, gap = Math.min(cw * 0.18, 1.2), x = 0, cells = '', labels = '';
    runs.forEach(function (run) {
      var x0 = x;
      for (var k = 0; k < run.n; k++) {
        cells += '<rect x="' + (x + gap / 2).toFixed(2) + '" y="' + top + '" width="' + Math.max(0.2, cw - gap).toFixed(2) + '" height="' + (H - 2 * top + 6) + '" fill="' + fillOf(id, run.type) + '"/>';
        x += cw;
      }
      if (run.label && run.n * cw >= 62) {
        labels += '<text x="' + (x0 + run.n * cw / 2).toFixed(1) + '" y="' + (top + 15.5) + '" text-anchor="middle" class="bl-nu-t" fill="' + (run.type === 'nud' ? C.D : C.R) + '">' + esc(run.label) + '</text>';
      }
    });
    var lines = markers.map(function (m) {
      var mx = (m.at * cw).toFixed(2);
      return '<line x1="' + mx + '" x2="' + mx + '" y1="0" y2="' + (H + 6) + '" stroke="' + m.colour + '" stroke-width="2.5"/>';
    }).join('');
    return '<svg class="bl-svg" width="' + width + '" height="' + (H + 6) + '" viewBox="0 0 ' + width + ' ' + (H + 6) + '" aria-hidden="true" focusable="false">' +
      patterns(id) + cells + labels + lines + '</svg>';
  }

  function markerLabels(markers, total, side) {
    return '<div class="bl-labels bl-labels-' + side + '">' + markers.filter(function (m) { return m.side === side; }).map(function (m) {
      return '<span class="bl-ml bl-ml-' + side + '" style="left:' + (m.at / total * 100).toFixed(3) + '%;--c:' + m.colour + '"><b>' + m.n + '</b>' + esc(m.label) + '</span>';
    }).join('') + '</div>';
  }
  function markerKey(markers) {
    return '<ul class="bl-key">' + markers.map(function (m) {
      return '<li><span class="bl-sw" style="background:' + m.colour + '"></span>' + (m.side === 'top' ? 'D' : 'R') + ' ' + m.n + ' ' + esc(m.label) + '</li>';
    }).join('') + '</ul>';
  }
  function MARKERS(key) {
    if (key === 'house') return [{ n: 218, at: 218, side: 'top', colour: C.D218, label: 'majority' }, { n: 290, at: 290, side: 'top', colour: C.D290, label: 'two-thirds' },
      { n: 218, at: 435 - 218, side: 'bot', colour: C.R218, label: 'majority' }, { n: 290, at: 435 - 290, side: 'bot', colour: C.R290, label: 'two-thirds' }];
    if (key === 'senate') return [{ n: 51, at: 51, side: 'top', colour: C.D218, label: 'majority' }, { n: 60, at: 60, side: 'top', colour: C.D60, label: 'filibuster' }, { n: 67, at: 67, side: 'top', colour: C.D290, label: 'two-thirds' },
      { n: 50, at: 50, side: 'bot', colour: C.R218, label: 'majority (VP)' }, { n: 60, at: 40, side: 'bot', colour: C.R60, label: 'filibuster' }, { n: 67, at: 33, side: 'bot', colour: C.R290, label: 'two-thirds' }];
    return [{ n: 26, at: 26, side: 'top', colour: C.D218, label: 'majority' }, { n: 26, at: 50 - 26, side: 'bot', colour: C.R218, label: 'majority' }];
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

  function chamber(st, key, width) {
    var L = window.LiveMath, pre = L.phase(st.meta) === 'pre';
    var total = SEATS[key], up = UP[key], markers = MARKERS(key), nu = notUpOf(st, key);
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
      var calledN = x.D.won + x.R.won + x.I.won;
      var tonightUn = Math.max(0, up - calledN - x.D.leading - x.R.leading - x.I.leading);
      runs = (key === 'house' ? [] : [{ type: 'nud', n: nu.D, label: 'Not up (' + nu.D + ')' }]).concat([
        { type: 'd', n: x.D.won }, { type: 'dl', n: x.D.leading }, { type: 'i', n: x.I.won }, { type: 'il', n: x.I.leading },
        { type: 'u', n: tonightUn }, { type: 'rl', n: x.R.leading }, { type: 'r', n: x.R.won }]).concat(key === 'house' ? [] : [{ type: 'nur', n: nu.R, label: 'Not up (' + nu.R + ')' }]);
      g = L.gains(key, st.races, st.holders, st.chambers);
      var needs = function (p) {
        var n = x[p].need, s = needText(n.majority, 'needed for majority', 'Majority reached');
        if (key === 'senate') s += '<br>' + needText(n.filibuster, 'to break filibuster', 'Filibuster-proof') + '<br>' + needText(n.two_thirds, 'for supermajority', 'Supermajority reached');
        return s;
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
    return '<div class="bl-ch bl-ch-' + key + '">' +
      '<div class="bl-ch-head"><span class="bl-ch-name">' + nm + ' <small>' + total + ' seats</small></span>' +
        '<span class="bl-tot"><span class="bl-tot-d">D <b>' + t.D + '</b></span>' + (t.I ? '<span class="bl-tot-i">I <b>' + t.I + '</b></span>' : '') + '<span class="bl-tot-r">R <b>' + t.R + '</b></span></span></div>' +
      (summ ? '<p class="bl-summ">' + esc(summ) + '</p>' : '') +
      '<p class="sr-only">' + esc(sr) + '</p>' +
      '<div class="bl-bar">' + markerLabels(markers, total, 'top') + barSvg(id, total, runs, width, markers) + markerLabels(markers, total, 'bot') + '</div>' +
      markerKey(markers) +
      '<div class="bl-needs" aria-hidden="true"><span class="bl-need-d">' + t.textD + '</span>' + (t.mid ? '<span class="bl-mid">' + esc(t.mid) + '</span>' : '') + '<span class="bl-need-r">' + t.textR + '</span></div>' +
      '</div>';
  }

  function tipButton(id, label, text) {
    return '<button type="button" class="bl-q" aria-expanded="false" aria-controls="' + id + '" aria-label="' + esc(label) + '"></button>' +
      '<span class="bl-tip" id="' + id + '" role="tooltip" hidden>' + text + '</span>';
  }
  function legend(pre, base) {
    function sw(cls) { return '<span class="bl-lg-sw bl-lg-' + cls + '"></span>'; }
    if (pre) return '<div class="bl-legend">' + sw('called-d') + sw('called-r') + ' Current seats ' + sw('nu-d') + sw('nu-r') + ' Not up tonight ' + sw('un') + ' Vacant or other</div>';
    return '<div class="bl-legend">' + sw('nu-d') + sw('nu-r') + ' Not up ' + sw('called-d') + sw('called-r') + ' Called ' + sw('lead-d') + sw('lead-r') + ' Leading ' + sw('un') + ' Not yet called' +
      '<span class="bl-qwrap">' + tipButton(base + 'a', 'What does leading mean?', 'Leading is not won. A leading seat is one where a candidate is ahead in the votes counted so far; the lead can change as more votes are counted. Only called races are counted as won.') + '</span>' +
      '<span class="bl-qwrap bl-qgain">Gains and losses' + tipButton(base + 'b', 'What do gained, lost and net mean?',
        '<b>Gained</b>: called races a party won in seats another party held before the election. <b>Lost</b>: called races in seats the party held that another party won. <b>Net</b>: gained minus lost. Leading pickups and losses are the same comparison for races not yet called. In redrawn states the comparison is with the party expected under the new map.') + '</span></div>';
  }

  function html(el, st) {
    var L = window.LiveMath, ph = L.phase(st.meta), pre = ph === 'pre';
    var mEl = el.querySelector('.bl-measure');
    var width = Math.max(240, Math.floor(mEl ? mEl.getBoundingClientRect().width : el.clientWidth - 40));
    var sub = pre ? '<span class="bl-stage">Before the election</span> The 119th Congress and governorships as they stand. The bars switch to the live count when polls close.'
      : ph === 'final' ? '<span class="bl-stage bl-stage-final">Final count</span>' + (st.meta && st.meta.last_update ? ' Updated ' + timeET(st.meta.last_update) + '.' : '')
      : '<span class="bl-stage bl-stage-live">Live count</span>' + (st.meta && st.meta.last_update ? ' Updated ' + timeET(st.meta.last_update) + '.' : '');
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
