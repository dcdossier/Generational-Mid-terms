/* assets/js/figures.js
 *
 * Figures that appear on more than one panel are read from data.json, never
 * typed into HTML. Mark an element with data-fig="<name>" (its text is the
 * fallback shown until data loads); this script replaces the text with the
 * live value from FIGURES below. Shared by index.html, overview.html and
 * map.html.
 *
 * window.Figures.apply(data, root?) can be called by a page that already has
 * data.json loaded; otherwise this script fetches it once on load.
 */
(function () {
  'use strict';

  var ABBR = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA', 'Colorado': 'CO',
    'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
    'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA',
    'Maine': 'ME', 'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN',
    'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
    'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
    'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA',
    'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX',
    'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
    'Wisconsin': 'WI', 'Wyoming': 'WY'
  };
  var RATING_ORDER = ['Toss-up', 'Lean D', 'Likely D', 'Safe D', 'Lean R', 'Likely R', 'Safe R'];

  function get(o, path) {
    return path.split('.').reduce(function (a, k) { return a == null ? undefined : a[k]; }, o);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(String(iso).length === 10 ? iso + 'T00:00:00Z' : iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function listAnd(a) {
    return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }
  function count(list, fn) { return (list || []).filter(fn).length; }
  function sen(d) { return get(d, 'races.senate') || {}; }
  function hou(d) { return get(d, 'races.house') || {}; }
  function gov(d) { return get(d, 'races.governor') || {}; }
  function ret(d) { return d.retirements || {}; }

  // Every shared figure, by name. Each returns a string or number (null = keep fallback).
  var FIGURES = {
    // Senate
    'senate.up':        function (d) { return sen(d).seats_up; },
    'senate.specials':  function (d) { return (sen(d).specials || []).length; },
    'senate.class_up':  function (d) { var s = sen(d); return s.seats_up - (s.specials || []).length; },
    'senate.split':     function (d) { var s = sen(d), n = (s.specials || []).length; return (s.seats_up - n) + '+' + n; },
    'senate.not_up':    function (d) { return 100 - sen(d).seats_up; },
    'senate.r':         function (d) { return get(sen(d), 'current_balance.r'); },
    'senate.d':         function (d) { return get(sen(d), 'current_balance.d'); },
    'senate.r_up':      function (d) { return count(sen(d).races, function (r) { return r.party === 'R'; }); },
    'senate.d_up':      function (d) { return count(sen(d).races, function (r) { return r.party === 'D'; }); },
    'senate.tossups':   function (d) { return get(sen(d), 'ratings_summary.toss_up'); },
    'senate.battleground': function (d) { return get(d, 'battlegrounds.senate'); },
    // House
    'house.total':      function (d) { return hou(d).total_seats; },
    'house.r':          function (d) { return get(hou(d), 'current_balance.r'); },
    'house.d':          function (d) { return get(hou(d), 'current_balance.d'); },
    'house.i':          function (d) { return get(hou(d), 'current_balance.i'); },
    'house.vacant':     function (d) { return get(hou(d), 'current_balance.vacant'); },
    'house.needed':     function (d) { return hou(d).needed_majority; },
    'house.d_gain_needed': function (d) { var h = hou(d); return h.needed_majority - get(h, 'current_balance.d'); },
    'house.tossups':    function (d) { return get(hou(d), 'ratings_summary.toss_up'); },
    'house.battleground': function (d) { return get(d, 'battlegrounds.house'); },
    'house.tracked':    function (d) { return (hou(d).competitive || []).length; },
    'house.tracked_breakdown': function (d) {
      var c = {}; (hou(d).competitive || []).forEach(function (r) { c[r.rating] = (c[r.rating] || 0) + 1; });
      return RATING_ORDER.filter(function (k) { return c[k]; }).map(function (k) { return c[k] + ' ' + k; }).join(', ');
    },
    // Governors
    'gov.races':        function (d) { return (gov(d).races || []).length; },
    'gov.r':            function (d) { return get(gov(d), 'current_balance.r'); },
    'gov.d':            function (d) { return get(gov(d), 'current_balance.d'); },
    'gov.lead':         function (d) { var b = gov(d).current_balance || {}; return Math.abs(b.r - b.d); },
    'gov.r_up':         function (d) { return count(gov(d).races, function (r) { return r.party === 'R'; }); },
    'gov.d_up':         function (d) { return count(gov(d).races, function (r) { return r.party === 'D'; }); },
    'gov.open':         function (d) { return count(gov(d).races, function (r) { return r.open; }); },
    'gov.open_list':    function (d) {
      return listAnd((gov(d).races || []).filter(function (r) { return r.open; }).map(function (r) { return ABBR[r.state] || r.state; }));
    },
    'gov.tossups':      function (d) { return count(gov(d).races, function (r) { return r.rating === 'Toss-up'; }); },
    'gov.tossup_list':  function (d) {
      return listAnd((gov(d).races || []).filter(function (r) { return r.rating === 'Toss-up'; }).map(function (r) { return r.state; }));
    },
    'gov.battleground': function (d) { return get(d, 'battlegrounds.governor'); },
    // Who rated it: our composite of the three raters, with the date
    'ratings.rater':    function (d) {
      var asOf = fmtDate(hou(d).as_of || sen(d).as_of);
      return 'our composite of Cook, Inside Elections and Sabato' + (asOf ? ', ' + asOf : '');
    },
    'battlegrounds.source': function (d) {
      var b = d.battlegrounds || {}; return (b.source || 'Ballotpedia') + (b.as_of ? ', as of ' + fmtDate(b.as_of) : '');
    },
    // Retirements (Ballotpedia, with a Wikipedia fallback)
    'retire.total':     function (d) { return ret(d).total; },
    'retire.senate':    function (d) { return ret(d).senate; },
    'retire.house':     function (d) { return ret(d).house; },
    'retire.r':         function (d) { return ret(d).republican; },
    'retire.d':         function (d) { return ret(d).democrat; },
    'retire.other_office': function (d) {
      var r = ret(d); return r.senate_other_office == null ? null : r.senate_other_office + r.house_other_office;
    },
    'retire.pct_other': function (d) { return ret(d).seeking_office_pct; },
    'retire.house_r_pct': function (d) {
      var r = ret(d); return r.house_republican == null || !r.house ? null : Math.round(100 * r.house_republican / r.house);
    },
    'retire.house_r_share_of_conf': function (d) {
      var r = ret(d), seats = get(hou(d), 'current_balance.r');
      return r.house_republican == null || !seats ? null : Math.round(100 * r.house_republican / seats);
    },
    'retire.to_governor': function (d) { return get(ret(d), 'destinations.governor'); },
    'retire.to_senate':   function (d) { return get(ret(d), 'destinations.senate'); },
    'retire.to_other':    function (d) {
      var x = get(ret(d), 'destinations'); return x ? (x.attorney_general || 0) + (x.state_legislature || 0) + (x.other || 0) : null;
    },
    'retire.as_of':     function (d) { var r = ret(d); return r.as_of ? 'as of ' + fmtDate(r.as_of) : null; },
    'retire.source':    function (d) {
      var r = ret(d); return (r.source || 'Ballotpedia') + (r.as_of ? ', as of ' + fmtDate(r.as_of) : '');
    }
  };

  function apply(data, root) {
    if (!data) return;
    (root || document).querySelectorAll('[data-fig]').forEach(function (el) {
      var fn = FIGURES[el.getAttribute('data-fig')];
      if (!fn) { console.warn('[figures] unknown figure', el.getAttribute('data-fig')); return; }
      var v;
      try { v = fn(data); } catch (e) { v = null; }
      if (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) return;
      el.textContent = String(v);
    });
  }

  window.Figures = { apply: apply, FIGURES: FIGURES };

  // Self-load unless the page passes data in itself
  function boot() {
    if (window.FIGURES_MANUAL) return;
    fetch('data.json?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { apply(d); }).catch(function () { /* fallbacks stay */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
