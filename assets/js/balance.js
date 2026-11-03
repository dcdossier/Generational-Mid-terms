/* "Projected 120th Congress": House and Senate seat bars (any element with data-live-balance).
 *
 * One cell per seat (435 House, 100 Senate). Democrats fill from the left, Republicans
 * from the right, seats not yet called sit in the middle. Fills are 45° stripes:
 * dense in the party colour for called seats, sparse and lighter for leading.
 * Before polls close the bars show the 119th Congress as it stands. Data and phase
 * come from live.js / live-math.js ("racebook:live" events).
 */
(function () {
  'use strict';

  var C = {
    D: '#1A2F7A', Dl: '#7F9BE0', R: '#7A1A1A', Rl: '#DC8C8C', I: '#5B5F66', Il: '#A3A6AB', un: '#C9C6BA',
    D218: '#8EB4F0', R218: '#F2A7B8', D290: '#0E1F5C', R290: '#5C0F0F', D60: '#3F62C4', R60: '#B54848'
  };
  var uid = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function timeET(iso) { var d = new Date(iso); return !iso || isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'; }

  // 45° stripes. Called: wide stripe on a tint. Leading: thin stripe on near-white. Pending: thin grey.
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

  // seats: [{type, n}] left to right. Returns SVG of one cell per seat.
  function barSvg(id, total, runs, width, markers) {
    var H = 30, top = 7, cw = width / total, gap = Math.min(cw * 0.18, 1.2), x = 0, cells = '';
    runs.forEach(function (run) {
      for (var k = 0; k < run.n; k++) {
        cells += '<rect x="' + (x + gap / 2).toFixed(2) + '" y="' + top + '" width="' + Math.max(0.2, cw - gap).toFixed(2) + '" height="' + (H - 2 * top + 6) + '" fill="url(#' + id + run.type + ')"/>';
        x += cw;
      }
    });
    var lines = markers.map(function (m) {
      var mx = (m.at * cw).toFixed(2);
      return '<line x1="' + mx + '" x2="' + mx + '" y1="0" y2="' + (H + 6) + '" stroke="' + m.colour + '" stroke-width="2.5"/>';
    }).join('');
    return '<svg class="bl-svg" width="' + width + '" height="' + (H + 6) + '" viewBox="0 0 ' + width + ' ' + (H + 6) + '" aria-hidden="true" focusable="false">' +
      patterns(id) + cells + lines + '</svg>';
  }

  function markerLabels(markers, total, side) {
    return '<div class="bl-labels bl-labels-' + side + '">' + markers.filter(function (m) { return m.side === side; }).map(function (m) {
      var pct = (m.at / total * 100).toFixed(3);
      return '<span class="bl-ml bl-ml-' + side + '" style="left:' + pct + '%;--c:' + m.colour + '"><b>' + m.n + '</b>' + esc(m.label) + '</span>';
    }).join('') + '</div>';
  }
  function markerKey(markers) {
    return '<ul class="bl-key">' + markers.map(function (m) {
      return '<li><span class="bl-sw" style="background:' + m.colour + '"></span>' + (m.side === 'top' ? 'D' : 'R') + ' ' + m.n + ' ' + esc(m.label) + '</li>';
    }).join('') + '</ul>';
  }

  function needText(n, what, done) { return n === 0 ? '<b>' + done + '</b>' : '<b class="bl-n">' + n + '</b> ' + what; }

  function chamber(st, key, width) {
    var L = window.LiveMath, pre = L.phase(st.meta) === 'pre', cur = st.current && st.current[key];
    var total = key === 'house' ? 435 : 100, t, runs, D, R, I, sr;
    var markers = key === 'house'
      ? [{ n: 218, at: 218, side: 'top', colour: C.D218, label: 'majority' }, { n: 290, at: 290, side: 'top', colour: C.D290, label: 'two-thirds' },
         { n: 218, at: 435 - 218, side: 'bot', colour: C.R218, label: 'majority' }, { n: 290, at: 435 - 290, side: 'bot', colour: C.R290, label: 'two-thirds' }]
      : [{ n: 51, at: 51, side: 'top', colour: C.D218, label: 'majority' }, { n: 60, at: 60, side: 'top', colour: C.D60, label: 'filibuster' }, { n: 67, at: 67, side: 'top', colour: C.D290, label: 'two-thirds' },
         { n: 50, at: 50, side: 'bot', colour: C.R218, label: 'majority (VP)' }, { n: 60, at: 40, side: 'bot', colour: C.R60, label: 'filibuster' }, { n: 67, at: 33, side: 'bot', colour: C.R290, label: 'two-thirds' }];

    if (pre) {
      cur = cur || { D: 0, R: 0, I: 0, vacant: 0 };
      D = cur.D; R = cur.R; I = cur.I || 0;
      var gapSeats = Math.max(0, total - D - R - I);
      runs = [{ type: 'd', n: D }, { type: 'i', n: I }, { type: 'u', n: gapSeats }, { type: 'r', n: R }];
      var holder = R >= (key === 'house' ? 218 : 50) ? 'Republicans' : D >= (key === 'house' ? 218 : 51) ? 'Democrats' : null;
      t = { D: D, R: R, I: I,
        textD: '<b class="bl-n">' + D + '</b> Democrats' + (key === 'senate' ? ' (incl. 2 independents)' : ''),
        textR: '<b class="bl-n">' + R + '</b> Republicans',
        mid: (I ? I + ' independent' + (I > 1 ? 's' : '') : '') + (I && cur.vacant ? ' · ' : '') + (cur.vacant ? cur.vacant + ' vacant' : '') };
      sr = (key === 'house' ? 'House' : 'Senate') + ' before the election: Democrats ' + D + ', Republicans ' + R +
        (I ? ', independents ' + I : '') + (cur.vacant ? ', ' + cur.vacant + ' vacant' : '') + '. ' + (holder ? holder + ' hold the majority.' : '');
    } else {
      var x = key === 'house' ? L.house(st.chambers) : L.senate(st.chambers);
      var dCalled = x.D.not_up + x.D.won, rCalled = x.R.not_up + x.R.won, iTot = x.I.total;
      var un = Math.max(0, total - x.D.total - x.R.total - iTot);
      runs = [{ type: 'd', n: dCalled }, { type: 'dl', n: x.D.leading }, { type: 'i', n: x.I.not_up + x.I.won }, { type: 'il', n: x.I.leading },
              { type: 'u', n: un }, { type: 'rl', n: x.R.leading }, { type: 'r', n: rCalled }];
      var needD = key === 'house'
        ? needText(x.D.need.majority, 'needed for majority', 'Majority reached')
        : needText(x.D.need.majority, 'needed for majority', 'Majority reached') + '<br>' + needText(x.D.need.filibuster, 'to break filibuster', 'Filibuster-proof') + '<br>' + needText(x.D.need.two_thirds, 'for supermajority', 'Supermajority reached');
      var needR = key === 'house'
        ? needText(x.R.need.majority, 'needed for majority', 'Majority reached')
        : needText(x.R.need.majority, 'needed for majority', 'Majority reached') + '<br>' + needText(x.R.need.filibuster, 'to break filibuster', 'Filibuster-proof') + '<br>' + needText(x.R.need.two_thirds, 'for supermajority', 'Supermajority reached');
      t = { D: x.D.total, R: x.R.total, I: iTot, textD: needD, textR: needR, mid: un + ' not yet called' };
      var nm = key === 'house' ? 'House' : 'Senate';
      var line = function (p, name, y) {
        var n = y.need, parts = [name + ' ' + y.total + ' (' + (y.not_up ? y.not_up + ' not up, ' : '') + y.won + ' won, ' + y.leading + ' leading)'];
        parts.push(n.majority ? n.majority + ' needed for majority' : 'majority reached');
        if (key === 'senate') { parts.push(n.filibuster ? n.filibuster + ' to break filibuster' : 'filibuster-proof'); parts.push(n.two_thirds ? n.two_thirds + ' for supermajority' : 'supermajority reached'); }
        return parts.join(', ');
      };
      sr = nm + ': ' + line('D', 'Democrats', x.D) + '. ' + line('R', 'Republicans', x.R) + '. ' + (iTot ? 'Independents ' + iTot + '. ' : '') + un + ' not yet called.' +
        (key === 'senate' ? ' Democrats need 51 for a majority; Republicans need 50 because the Vice President breaks ties.' : ' 218 seats are needed for a majority.');
    }

    var id = 'blp' + (++uid) + '-';
    return '<div class="bl-ch bl-ch-' + key + '">' +
      '<div class="bl-ch-head"><span class="bl-ch-name">' + (key === 'house' ? 'House' : 'Senate') + ' <small>' + total + ' seats</small></span>' +
        '<span class="bl-tot"><span class="bl-tot-d">D <b>' + t.D + '</b></span>' + (t.I ? '<span class="bl-tot-i">I <b>' + t.I + '</b></span>' : '') + '<span class="bl-tot-r">R <b>' + t.R + '</b></span></span></div>' +
      '<p class="sr-only">' + esc(sr) + '</p>' +
      '<div class="bl-bar">' + markerLabels(markers, total, 'top') + barSvg(id, total, runs, width, markers) + markerLabels(markers, total, 'bot') + '</div>' +
      markerKey(markers) +
      '<div class="bl-needs" aria-hidden="true"><span class="bl-need-d">' + t.textD + '</span>' + (t.mid ? '<span class="bl-mid">' + esc(t.mid) + '</span>' : '') + '<span class="bl-need-r">' + t.textR + '</span></div>' +
      '</div>';
  }

  function legend(pre, tipId) {
    function sw(cls) { return '<span class="bl-lg-sw bl-lg-' + cls + '"></span>'; }
    if (pre) return '<div class="bl-legend">' + sw('called-d') + sw('called-r') + ' Current seats ' + sw('un') + ' Vacant or other</div>';
    return '<div class="bl-legend">' + sw('called-d') + sw('called-r') + ' Called ' + sw('lead-d') + sw('lead-r') + ' Leading ' + sw('un') + ' Not yet called' +
      '<button type="button" class="bl-q" aria-expanded="false" aria-controls="' + tipId + '" aria-label="What does leading mean?"></button>' +
      '<span class="bl-tip" id="' + tipId + '" role="tooltip" hidden>Leading is not won. A leading seat is one where a candidate is ahead in the votes counted so far; the lead can change as more votes are counted. Only called races are counted as won.</span></div>';
  }

  function html(el, st) {
    var L = window.LiveMath, ph = L.phase(st.meta), pre = ph === 'pre';
    var width = Math.max(240, Math.floor(el.querySelector('.bl-measure') ? el.querySelector('.bl-measure').getBoundingClientRect().width : el.clientWidth - 40));
    var sub = pre ? '<span class="bl-stage">Before the election</span> The 119th Congress as it stands. The bars switch to the live count when polls close.'
      : ph === 'final' ? '<span class="bl-stage bl-stage-final">Final count</span>' + (st.meta && st.meta.last_update ? ' Updated ' + timeET(st.meta.last_update) + '.' : '')
      : '<span class="bl-stage bl-stage-live">Live count</span>' + (st.meta && st.meta.last_update ? ' Updated ' + timeET(st.meta.last_update) + '.' : '') + ' Seats not up this year are included in the Senate.';
    if (st.demo) sub += ' <b>Demo data.</b>';
    return '<div class="bl-head"><h2 class="bl-title">Projected 120th Congress</h2><p class="bl-sub">' + sub + '</p></div>' +
      '<div class="bl-measure"></div>' +
      chamber(st, 'house', width) + chamber(st, 'senate', width) + legend(pre, 'bl-tip-' + (++uid));
  }

  var mounts = [], last = null;
  function render(st) {
    if (!window.LiveMath || !st) return;
    last = st;
    mounts.forEach(function (el) {
      var open = el.querySelector('.bl-q[aria-expanded="true"]');
      el.innerHTML = html(el, st);
      if (open) toggleTip(el.querySelector('.bl-q'), true);
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
      el.addEventListener('click', function (e) { var b = e.target.closest('.bl-q'); if (b) toggleTip(b); });
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
