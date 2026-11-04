/* "How the map changed": one shared timeline map (Trends and India's Interest).
 *
 *   TimelineMap.mount(el, { chamber, chambers, lens, lenses, extraLenses, onSeat })
 *
 * Data: assets/map-timeline.json (scripts/build_map_timeline.py): months, events
 * (redistricting, with dates from cited sources), seats (holders, notional party,
 * every poll), old119 holders, the TopoJSON geometry, and "certified".
 * Live results: window.RacebookLive ("racebook:live"), the same reader and 3-minute
 * refresh as Home. The last two stops are never static:
 *   12  "3 Nov · Election night": calls and leads together
 *   13  "120th Congress · live" / "· all races called" / "· certified"
 * Every map on a page shares one month (slider, play, ticks) so they move together.
 * Seats open the shared seat panel (opts.onSeat, else SeatPanel.open).
 */
(function () {
  'use strict';

  var DATA_URL = 'assets/map-timeline.json?v=20261104a';
  var AB = { Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY' };
  var AT_LARGE = { AK: 1, DE: 1, ND: 1, SD: 1, VT: 1, WY: 1 };
  var COL = { d1: '#1f3a8a', d2: '#4f6fc1', d3: '#9fb3e3', d4: '#d5ddf1', r1: '#9b1c1c', r2: '#cc4b4b', r3: '#eaa4a4', r4: '#f4d7d7', tu: '#ddd3e6', none: '#ebe8df', off: '#f4f2ec', gold: '#c98a12', i1: '#5b4a8a', i3: '#c9bfe0' };
  var LENSES = [['story', 'Story'], ['rd', 'Redistricting'], ['poll', 'Polling'], ['res', 'Result']];
  var CH = [['house', 'House'], ['senate', 'Senate'], ['gov', 'Governors']];
  var ELEC = 12, FINAL = 13;
  var HOVER = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)').matches : true;

  var shared = { month: 0, timer: null, insts: [], data: null, geo: null, loading: null };
  var uid = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function idOf(p) { var a = AB[p.state]; if (!a) return null; return AT_LARGE[a] || !+p.district ? a + '-AL' : a + '-' + String(+p.district).padStart(2, '0'); }
  function stateId(ch, name) { var a = AB[name]; return a ? (ch === 'senate' ? 'Senate-' : 'Gov-') + a : null; }
  function istTime(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).replace(',', '') + ' IST'; }

  // d3 draws a ring clockwise as its inside; a ring wound the other way covers the globe.
  function rewind(fs) {
    fs.forEach(function (f) {
      var g = f.geometry; if (!g) return;
      var flip = function (rings) { return rings.map(function (r) { return r.slice().reverse(); }); };
      if (g.type === 'Polygon' && d3.geoArea(f) > 2 * Math.PI) g.coordinates = flip(g.coordinates);
      else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map(function (p) { return d3.geoArea({ type: 'Polygon', coordinates: p }) > 2 * Math.PI ? flip(p) : p; });
    });
    return fs;
  }

  function load() {
    if (shared.loading) return shared.loading;
    var topo = window.topojson ? Promise.resolve() : new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s);
    });
    shared.loading = Promise.all([fetch(DATA_URL).then(function (r) { if (!r.ok) throw new Error('map-timeline.json HTTP ' + r.status); return r.json(); }), topo]).then(function (res) {
      var B = res[0], T = B.topo;
      shared.data = B;
      shared.geo = {
        d2026: rewind(topojson.feature(T, T.objects.d2026).features),
        d119: rewind(topojson.feature(T, T.objects.d119).features),
        states: rewind(topojson.feature(T, T.objects.states).features),
      };
      B.byCode = {}; B.lineEvent = {};
      B.events.forEach(function (e) { (B.byCode[e.code] = B.byCode[e.code] || []).push(e); if (e.lines) B.lineEvent[e.code] = e; });
      return B;
    });
    return shared.loading;
  }

  // ── live results (RacebookLive) ─────────────────────────────────────────
  function live() { return window.RacebookLive && window.RacebookLive.ready ? window.RacebookLive.state : null; }
  function res(id) {
    var st = live(), L = window.LiveMath; if (!st || !st.races) return null;
    var r = null; for (var i = 0; i < st.races.length; i++) if (st.races[i].race_id === id) { r = st.races[i]; break; }
    if (!r) return null;
    var w = L ? L.winnerOf(r) : r.winner, l = !w && (r.pct_counted || 0) > 0 ? (L ? L.leaderOf(r) : r.leader) : null;
    return { w: w, l: l, in: r.pct_counted || 0, f: !!r.flipped && !!w, c: (r.candidates || []).slice(0, 2), at: r.called_at };
  }
  function finalStop() {
    var B = shared.data, st = live(), f = st && st.flips || {};
    var rem = { house: f.house && f.house.remaining, senate: f.senate && f.senate.remaining, gov: f.gov && f.gov.remaining };
    if (B && B.certified) return { label: '120th Congress · certified', rem: rem, done: true };
    var known = rem.house != null && rem.senate != null && rem.gov != null;
    if (known && !rem.house && !rem.senate && !rem.gov) return { label: '120th Congress · all races called', rem: rem, done: true };
    return { label: '120th Congress · live', rem: rem, done: false, at: st && st.meta && (st.meta.last_update || st.meta.last_push) };
  }
  function label(i) { return i === FINAL ? finalStop().label : shared.data.labels[i]; }

  // ── colours ─────────────────────────────────────────────────────────────
  function newLines(code, i) { var e = shared.data.lineEvent[code]; return !e || e.month <= i; }
  function monthEnd(i) { return i < 12 ? shared.data.months[i] + '-31' : '2026-11-03'; }
  function pollAt(s, i) { var lim = monthEnd(i), last = null; (s.p || []).forEach(function (p) { if (p[0] <= lim) last = p; }); return last; }
  function pollCol(m) { var a = Math.abs(m); if (a < 2) return COL.tu; var k = m > 0 ? 'd' : 'r'; return COL[k + (a >= 10 ? 1 : a >= 5 ? 2 : 3)]; }
  function heldCol(p) { return p === 'D' ? COL.d4 : p === 'R' ? COL.r4 : COL.none; }
  function resCol(r, hatch) {
    if (r && r.w) return r.w === 'D' ? COL.d1 : r.w === 'R' ? COL.r1 : COL.i1;
    if (r && r.l) return r.l === 'D' ? COL.d3 : r.l === 'R' ? COL.r3 : COL.i3;
    return hatch;
  }

  function Inst(el, opts) {
    this.el = el; this.o = opts || {}; this.id = ++uid;
    this.ch = this.o.chamber || 'house';
    this.chambers = this.o.chambers || CH.map(function (c) { return c[0]; });
    this.extra = this.o.extraLenses || [];
    this.lens = this.o.lens || 'story';
    this.filter = null;
    this.build();
  }
  Inst.prototype.lensDef = function () { var l = this.lens; return this.extra.filter(function (x) { return x.id === l; })[0] || null; };

  Inst.prototype.build = function () {
    var self = this, el = this.el, o = this.o;
    el.classList.add('tm');
    var chs = CH.filter(function (c) { return self.chambers.indexOf(c[0]) > -1; });
    var lenses = this.extra.map(function (x) { return [x.id, x.label]; }).concat((o.lenses || LENSES.map(function (l) { return l[0]; })).map(function (k) { return LENSES.filter(function (l) { return l[0] === k; })[0]; }).filter(Boolean));
    el.innerHTML =
      (o.title === false ? '' : '<div class="tm-head"><h2 class="tm-title">' + esc(o.title || 'How the map changed') + '</h2>' +
        '<p class="tm-sub">' + esc(o.sub || 'November 2025 to the 120th Congress: redistricting, polling leads and the result, month by month.') + '</p></div>') +
      '<div class="tm-controls">' +
        (chs.length > 1 ? '<span class="tm-ctl"><span class="tm-lab">Chamber</span><span class="tm-seg" data-k="ch">' + chs.map(function (c) { return '<button type="button" data-v="' + c[0] + '"' + (c[0] === self.ch ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + c[1] + '</button>'; }).join('') + '</span></span>' : '') +
        '<span class="tm-ctl"><span class="tm-lab">Lens</span><span class="tm-seg" data-k="lens">' + lenses.map(function (l) { return '<button type="button" data-v="' + l[0] + '"' + (l[0] === self.lens ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + esc(l[1]) + '</button>'; }).join('') + '</span></span>' +
        '<button type="button" class="tm-play">▶ Play the year</button>' +
      '</div>' +
      '<div class="tm-grid"><div class="tm-mapcol">' +
        '<div class="tm-zoom"><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">−</button><button type="button" data-z="reset" aria-label="Reset view">↺</button></div>' +
        '<div class="tm-mapwrap"><svg class="tm-map" viewBox="0 0 975 610" role="img" aria-label="Map of the United States"></svg>' +
          '<div class="tm-loading">Loading the map…</div></div>' +
        '<div class="tm-slider"><div class="tm-ticks"></div><input type="range" min="0" max="13" step="1" value="' + shared.month + '" aria-label="Month"><div class="tm-mlabels"></div></div>' +
      '</div><div class="tm-side"><h3 class="tm-frame" aria-live="polite"></h3><div class="tm-cap"></div><div class="tm-stats"></div><div class="tm-legend"></div></div></div>' +
      '<p class="tm-note"></p><div class="tm-tip" role="tooltip" hidden></div>';
    this.svg = d3.select(el.querySelector('svg'));
    var defs = this.svg.append('defs');
    this.hatch = 'tm-hatch-' + this.id;
    var pat = defs.append('pattern').attr('id', this.hatch).attr('patternUnits', 'userSpaceOnUse').attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)');
    pat.append('rect').attr('width', 6).attr('height', 6).attr('fill', '#f2efe7');
    pat.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('stroke', '#c9c3b3').attr('stroke-width', 2);
    this.root = this.svg.append('g');
    this.gOld = this.root.append('g'); this.gNew = this.root.append('g'); this.gSt = this.root.append('g'); this.gOut = this.root.append('g'); this.gRd = this.root.append('g');
    this.proj = d3.geoAlbersUsa().scale(1280).translate([487, 305]); this.path = d3.geoPath(this.proj);
    var root = this.root;
    this.zoom = d3.zoom().scaleExtent([1, 12]).on('zoom', function (e) { root.attr('transform', e.transform); root.selectAll('path').attr('vector-effect', 'non-scaling-stroke'); });
    this.svg.call(this.zoom).on('wheel.zoom', null);   // wheel scrolls the page; buttons and pinch zoom
    el.querySelector('.tm-zoom').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var z = b.getAttribute('data-z');
      self.svg.transition().duration(300).call(self.zoom[z === 'reset' ? 'transform' : 'scaleBy'], z === 'reset' ? d3.zoomIdentity : z === 'in' ? 1.6 : 1 / 1.6);
    });
    el.querySelector('.tm-controls').addEventListener('click', function (e) {
      var b = e.target.closest('.tm-seg button'); if (!b) return;
      var k = b.parentNode.getAttribute('data-k');
      [].forEach.call(b.parentNode.children, function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      if (k === 'ch') self.ch = b.getAttribute('data-v'); else self.lens = b.getAttribute('data-v');
      self.hideTip(); self.draw();
    });
    el.querySelector('.tm-play').addEventListener('click', togglePlay);
    var sl = el.querySelector('input[type=range]');
    sl.addEventListener('input', function () { stopPlay(); setMonth(+sl.value); });
    this.tip = el.querySelector('.tm-tip');
    // touch: taps open the tip (with a button for the seat panel); a tap elsewhere closes it
    document.addEventListener('click', function (e) { if (!self.tip.hidden && !e.target.closest('.tm-tip') && !e.target.closest('.tm-map path')) self.hideTip(); });
    // stopPropagation: the seat panel closes on clicks outside it, and this click would reach it
    this.tip.addEventListener('click', function (e) { var b = e.target.closest('[data-open]'); if (b) { e.stopPropagation(); self.hideTip(); self.open(b.getAttribute('data-open')); } });
    load().then(function () { el.querySelector('.tm-loading').hidden = true; self.ticks(); self.draw(); })
      .catch(function (err) { el.querySelector('.tm-loading').textContent = 'The map could not be loaded. Please refresh the page.'; if (window.console) console.warn('[timeline-map]', err); });
  };

  Inst.prototype.open = function (id) {
    if (this.o.onSeat) this.o.onSeat(id);
    else if (window.SeatPanel) window.SeatPanel.open(id, { mode: 'default' });
  };

  Inst.prototype.ticks = function () {
    var B = shared.data, el = this.el, tk = el.querySelector('.tm-ticks');
    var seen = {};
    tk.innerHTML = B.events.filter(function (e) { return e.month >= 0; }).map(function (e) {
      var k = e.month + '|' + e.code; if (seen[k]) return ''; seen[k] = 1;
      var n = B.events.filter(function (x) { return x.month === e.month && x.code === e.code; });
      var unv = n.some(function (x) { return !x.verified; });
      return '<button type="button" class="tm-tick' + (unv ? ' tm-unv' : '') + '" style="left:' + (e.month / 13 * 100) + '%" data-m="' + e.month + '" title="' + esc(e.state + ': ' + n.map(function (x) { return x.status; }).join(', ') + (unv ? ' (date to verify)' : '')) + '" aria-label="' + esc(e.state + ', ' + B.labels[e.month]) + '"><span></span></button>';
    }).join('');
    tk.onclick = function (e) { var b = e.target.closest('[data-m]'); if (b) { stopPlay(); setMonth(+b.getAttribute('data-m')); } };
    // labels sit under their stops; the first and last are pinned to the ends
    el.querySelector('.tm-mlabels').innerHTML = B.labels.map(function (l, i) {
      var t = i === ELEC ? '3 Nov' : i === FINAL ? '120th' : (i % 3 === 0 ? l : '');
      if (!t) return '';
      return '<span class="' + (i >= ELEC ? 'tm-end' : '') + (i === FINAL ? ' tm-last' : '') + (i % 6 === 3 ? ' tm-mid' : '') + '" style="left:' + (i / 13 * 100) + '%;transform:translateX(' + (i === 0 ? '0' : i >= ELEC ? '-100%' : '-50%') + ')">' + esc(t) + '</span>';
    }).join('');
  };

  Inst.prototype.fill = function (id, i) {
    var B = shared.data, s = B.seats[id], ld = this.lensDef();
    if (ld) return ld.fill(id) || COL.none;
    if (!s) return COL.none;
    var held = s.n || s.h, lens = this.lens;
    if (lens === 'rd') return heldCol(held);
    if (lens === 'res' || i >= ELEC) return resCol(res(id), 'url(#' + this.hatch + ')');
    var p = pollAt(s, i);
    if (p && p[1] != null) return pollCol(p[1]);
    return lens === 'poll' && !p ? COL.none : heldCol(held);
  };
  Inst.prototype.flipped = function (id, i) {
    if (this.lensDef() || !(i >= ELEC || this.lens === 'res')) return false;
    var r = res(id); return !!(r && r.f);
  };

  Inst.prototype.draw = function () {
    if (!shared.data) return;
    var self = this, B = shared.data, G = shared.geo, i = shared.month, ch = this.ch, path = this.path;
    this.el.querySelector('input[type=range]').value = i;
    [].forEach.call(this.el.querySelectorAll('.tm-tick'), function (t) { t.classList.toggle('on', +t.getAttribute('data-m') === i); });
    var ev = function (sel, idf, name) {
      sel.on('mousemove', function (e, f) { if (HOVER) self.showTip(e, idf(f), name(f), this.__old); })
        .on('mouseleave', function () { if (HOVER) self.hideTip(); })
        .on('click', function (e, f) {
          e.stopPropagation();
          var id = idf(f); if (!id) return;
          if (HOVER) { if (B.seats[id] || res(id)) self.open(id); }
          else self.showTip(e, id, name(f), this.__old, true);
        });
    };
    var dim = function (id) { return self.filter && id && !self.filter(id) ? 0.15 : 1; };
    this.gOld.selectAll('*').remove(); this.gNew.selectAll('*').remove(); this.gSt.selectAll('*').remove(); this.gOut.selectAll('*').remove(); this.gRd.selectAll('*').remove();
    if (ch === 'house') {
      var nw = this.gNew.selectAll('path').data(G.d2026.filter(function (f) { return newLines(AB[f.properties.state], i); })).join('path')
        .attr('class', function (f) { return 'tm-dist' + (self.flipped(idOf(f.properties), i) ? ' tm-flip' : ''); })
        .attr('d', path).attr('data-seat-id', function (f) { return idOf(f.properties); }).attr('fill', function (f) { return self.fill(idOf(f.properties), i); })
        .attr('opacity', function (f) { return dim(idOf(f.properties)); });
      ev(nw, function (f) { return idOf(f.properties); }, function (f) { return f.properties.state; });
      var old = this.gOld.selectAll('path').data(G.d119.filter(function (f) { return !newLines(AB[f.properties.state], i); })).join('path')
        .attr('class', 'tm-dist tm-old').attr('d', path)
        .attr('fill', function (f) { var ld = self.lensDef(), id = idOf(f.properties); return ld ? (ld.fill(id, true) || COL.none) : heldCol(B.old119[id]); })
        .attr('opacity', function (f) { return dim(idOf(f.properties)); })
        .each(function () { this.__old = true; });
      ev(old, function (f) { return idOf(f.properties); }, function (f) { return f.properties.state; });
      this.gOut.selectAll('path').data(G.states).join('path').attr('class', 'tm-st-out').attr('d', path);
      if ((this.lens === 'rd' || this.lens === 'story') && i < ELEC) {
        this.gRd.selectAll('path').data(G.states.filter(function (f) { var e = B.lineEvent[AB[f.properties.state]]; return e && e.month <= i; })).join('path').attr('class', 'tm-rd-out').attr('d', path);
      }
    } else {
      var sel = this.gSt.selectAll('path').data(G.states).join('path')
        .attr('class', function (f) { var id = stateId(ch, f.properties.state); return 'tm-state' + (B.seats[id] && self.flipped(id, i) ? ' tm-flip' : ''); })
        .attr('d', path).attr('data-seat-id', function (f) { return stateId(ch, f.properties.state); })
        .attr('fill', function (f) { var id = stateId(ch, f.properties.state); return B.seats[id] || self.lensDef() ? self.fill(id, i) : COL.off; })
        .attr('opacity', function (f) { return dim(stateId(ch, f.properties.state)); });
      ev(sel, function (f) { return stateId(ch, f.properties.state); }, function (f) { return f.properties.state; });
    }
    this.caption();
  };

  Inst.prototype.showTip = function (e, id, stName, old, tap) {
    var B = shared.data, s = B.seats[id], i = shared.month, t = this.tip, ld = this.lensDef();
    var h = '<b>' + esc(id || stName) + '</b> · ' + esc(stName) + '<br>';
    if (ld && ld.tip) h += ld.tip(id, old) || '';
    else if (old) h += 'Old (119th Congress) lines until the new map takes effect.<br>Held by: ' + esc(B.old119[id] || 'not known');
    else if (s) {
      h += 'Held before: ' + esc(s.h || 'not known') + (s.n ? ' · expected on the new map: ' + esc(s.n) : '') + (s.m ? '<br>' + esc(s.m) : '') + '<br>';
      if (i < ELEC) {
        var p = pollAt(s, i);
        h += p ? 'Latest poll by month end (' + esc(p[0]) + ', ' + esc(p[2] || '') + '): ' + (p[1] == null ? 'no two-party margin' : p[1] === 0 ? 'tied' : (p[1] > 0 ? 'D +' : 'R +') + Math.abs(p[1])) + '<br>' : (s.p && s.p.length ? 'No poll yet by this month<br>' : '');
        if (s.p && s.p.length) h += '<small>' + s.p.length + ' poll' + (s.p.length === 1 ? '' : 's') + ' in all</small><br>';
      }
      if (i >= ELEC || this.lens === 'res') {
        var r = res(id);
        if (r) {
          h += (r.w ? 'Called: ' + r.w : r.l ? 'Leading: ' + r.l : 'No votes counted yet') + (r.in ? ' · ' + Math.round(r.in) + '% counted' : '') + (r.f ? ' · <b>Flipped</b>' : '') + '<br>';
          r.c.forEach(function (c) { h += esc(c.name) + ' (' + esc(c.party) + ') ' + (c.pct != null && (r.in || r.w) ? Number(c.pct).toFixed(1) + '%' : '') + '<br>'; });
        } else h += 'No results yet<br>';
      }
    } else if (!res(id)) h += 'No race in 2026';
    if (tap && (s || res(id)) && !old) h += '<button type="button" class="tm-tip-open" data-open="' + esc(id) + '">Open seat details →</button>';
    t.innerHTML = h; t.hidden = false;
    t.classList.toggle('tm-tip-tap', !!tap);
    var r0 = this.el.getBoundingClientRect(), x = e.clientX - r0.left, y = e.clientY - r0.top, w = Math.min(280, r0.width - 16);
    t.style.maxWidth = w + 'px';
    t.style.left = Math.max(8, Math.min(x + 14, r0.width - w - 8)) + 'px';
    t.style.top = (y + 14) + 'px';
  };
  Inst.prototype.hideTip = function () { this.tip.hidden = true; };

  Inst.prototype.caption = function () {
    var B = shared.data, i = shared.month, ch = this.ch, el = this.el, ld = this.lensDef();
    el.querySelector('.tm-frame').textContent = label(i);
    var evs = B.events.filter(function (e) { return i < ELEC && (e.month === i || (i === 0 && e.month < 0)); });
    var h = '';
    if (i === 0) h += '<p>The starting point. Gold dashed outlines mark states whose congressional maps have changed for 2026 by the end of the month shown.</p>';
    if (ch === 'house' || ld) evs.forEach(function (e) {
      h += '<div class="tm-ev' + (e.verified ? '' : ' tm-ev-unv') + '"><b>' + esc(e.state) + '</b> · ' + esc(e.status) + (e.impact ? ' · ' + esc(e.impact) : '') + '<br>' + esc(e.summary) +
        '<small>' + esc(e.date_label) + (e.month < 0 ? ' (before November 2025)' : '') + ' · <a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.source || 'Source') + '</a>' + (e.verified ? '' : ' · date not confirmed by the source') + '</small></div>';
    });
    var ss = Object.keys(B.seats).map(function (k) { return B.seats[k]; }).filter(function (s) { return s.c === ch; });
    var ids = Object.keys(B.seats).filter(function (k) { return B.seats[k].c === ch; });
    if (ld && ld.caption) h += ld.caption(ch) || '';
    else if (i < ELEC) {
      var pl = ss.map(function (s) { return pollAt(s, i); }).filter(function (p) { return p && p[1] != null; });
      var d = pl.filter(function (p) { return p[1] >= 2; }).length, r = pl.filter(function (p) { return p[1] <= -2; }).length;
      if (this.lens !== 'rd') h += '<p>' + (pl.length ? 'Public polls in <b>' + pl.length + '</b> races by month end: Democrats lead ' + d + ', Republicans lead ' + r + ', within 2 points ' + (pl.length - d - r) + '.' : 'No public race polls yet in our data for this month.') + '</p>';
    } else {
      var rs = ids.map(res), w = function (t) { return rs.filter(function (x) { return x && x.w === t; }).length; }, l = function (t) { return rs.filter(function (x) { return x && x.l === t; }).length; }, f = function (t) { return rs.filter(function (x) { return x && x.f && x.w === t; }).length; };
      h += '<p>Called: Democrats <b>' + w('D') + '</b>, Republicans <b>' + w('R') + '</b>. Leading: Democrats ' + l('D') + ', Republicans ' + l('R') + '. Flipped: to Democrats ' + f('D') + ', to Republicans ' + f('R') + '.</p>';
      if (i === ELEC) h += '<p class="tm-small">Election night shows calls and leads together, from the Fox News Decision Desk, refreshed every 3 minutes.</p>';
      if (i === FINAL) {
        var fs = finalStop(), rm = fs.rem;
        if (!fs.done && !live()) h += '<p class="tm-small">Live results are loading.</p>';
        else if (!fs.done) h += '<p class="tm-small">As of ' + esc(istTime(fs.at)) + ' · ' + (rm.house != null ? rm.house : '—') + ' House, ' + (rm.senate != null ? rm.senate : '—') + ' Senate, ' + (rm.gov != null ? rm.gov : '—') + ' Governor races still uncalled.</p>';
      }
    }
    el.querySelector('.tm-cap').innerHTML = h;
    var rdN = Object.keys(B.lineEvent).filter(function (c) { return B.lineEvent[c].month <= Math.min(i, 11); }).length;
    var flips = i >= ELEC ? ids.map(res).filter(function (x) { return x && x.f; }).length : null;
    el.querySelector('.tm-stats').innerHTML = (ch === 'house' ? '<div class="tm-stat"><b>' + rdN + '</b><span>states on new maps</span></div>' : '') +
      '<div class="tm-stat"><b>' + ss.filter(function (s) { return (s.n || s.h) === 'D'; }).length + ' / ' + ss.filter(function (s) { return (s.n || s.h) === 'R'; }).length + '</b><span>held D / R before' + (ch === 'house' ? ' (expected party on new maps)' : '') + '</span></div>' +
      (flips != null ? '<div class="tm-stat"><b>' + flips + '</b><span>seats flipped so far</span></div>' : '');
    var Lg = [];
    if (ld) Lg = ld.legend || [];
    else {
      if (ch === 'house' && (this.lens === 'rd' || this.lens === 'story') && i < ELEC) Lg.push([COL.gold, 'New map (outline)', 'outline']);
      if (i < ELEC && this.lens !== 'res' && this.lens !== 'rd') Lg.push([COL.d1, 'Poll lead D 10+'], [COL.d2, 'D 5–10'], [COL.d3, 'D 2–5'], [COL.tu, 'Within 2'], [COL.r3, 'R 2–5'], [COL.r2, 'R 5–10'], [COL.r1, 'R 10+']);
      if (i >= ELEC || this.lens === 'res') {
        Lg.push([COL.d1, 'Called D'], [COL.d3, 'Leading D'], [COL.r3, 'Leading R'], [COL.r1, 'Called R']);
        var oth = ids.map(res).filter(function (x) { return x && (x.w || x.l) && (x.w || x.l) !== 'D' && (x.w || x.l) !== 'R'; });
        if (oth.length) Lg.push([COL.i1, 'Called, other party'], [COL.i3, 'Leading, other party']);
        Lg.push(['hatch', 'No votes counted yet'], ['#111', 'Flipped (outline)', 'outline']);
      }
      if (i < ELEC && this.lens !== 'res') Lg.push([COL.d4, 'Held D' + (this.lens === 'rd' ? '' : ', no polls')], [COL.r4, 'Held R' + (this.lens === 'rd' ? '' : ', no polls')]);
    }
    el.querySelector('.tm-legend').innerHTML = Lg.map(function (x) {
      var sw = x[0] === 'hatch' ? 'background:repeating-linear-gradient(45deg,#f2efe7 0 3px,#c9c3b3 3px 5px)' : x[2] === 'outline' ? 'border:2px solid ' + x[0] + ';background:#fff' : 'background:' + x[0];
      return '<span><i class="tm-sw" style="' + sw + '"></i>' + esc(x[1]) + '</span>';
    }).join('');
    el.querySelector('.tm-note').innerHTML = ld && ld.note ? ld.note : 'Sources: ' + esc(B.sources.holders) + ' · ' + esc(B.sources.redistricting) + ' · ' + esc(B.sources.polls) + ' (' + B.counts.polls + ' polls) · ' + esc(B.sources.results) + '.' +
      (B.events.some(function (e) { return !e.verified; }) ? ' Hollow dots on the slider are dates not yet confirmed by a cited source.' : '');
  };
  Inst.prototype.setFilter = function (fn) { this.filter = typeof fn === 'function' ? fn : null; this.draw(); };
  Inst.prototype.setLens = function (k) {
    this.lens = k;
    [].forEach.call(this.el.querySelectorAll('[data-k="lens"] button'), function (x) { x.classList.toggle('on', x.getAttribute('data-v') === k); x.setAttribute('aria-pressed', String(x.getAttribute('data-v') === k)); });
    this.draw();
  };

  // ── shared month, play ──────────────────────────────────────────────────
  function setMonth(i) { shared.month = Math.max(0, Math.min(FINAL, i)); shared.insts.forEach(function (x) { x.draw(); }); }
  function playLabel(t) { shared.insts.forEach(function (x) { x.el.querySelector('.tm-play').textContent = t; }); }
  function stopPlay() { if (shared.timer) { clearInterval(shared.timer); shared.timer = null; playLabel('▶ Play the year'); } }
  function togglePlay() {
    if (shared.timer) return stopPlay();
    if (shared.month >= FINAL) setMonth(0);
    playLabel('❚❚ Pause');
    shared.timer = setInterval(function () { if (shared.month >= FINAL) return stopPlay(); setMonth(shared.month + 1); }, 1400);
  }

  document.addEventListener('racebook:live', function () { if (shared.data) shared.insts.forEach(function (x) { if (shared.month >= ELEC || x.lens === 'res') x.draw(); else x.caption(); }); });

  window.TimelineMap = {
    mount: function (el, opts) { if (!el) return null; var x = new Inst(el, opts); shared.insts.push(x); return x; },
    setMonth: setMonth,
    get month() { return shared.month; },
    get data() { return shared.data; },
    load: load,
  };
})();
