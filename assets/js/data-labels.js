// assets/js/data-labels.js
//
// "Source: X · Data as of DATE" labels for data.json blocks, shared by
// index.html, overview.html, map.html and india.html (and seat-panel.js).
//
// Markup: an empty placeholder naming the data.json block it describes:
//   <div class="dl-label" data-block="approval.trump" data-kind="poll"></div>
// then DataLabels.fill(data) once the page has loaded data.json.
//
//   data-block       dot path to a block carrying source / as_of / fetched
//                    (written by scripts/fetch-polls.js)
//   data-kind        "poll" (stale after 14 days), "monthly" (45 days) or
//                    "ratings" (14 days) -- see STALE_DAYS
//   data-asof-path   optional: read as_of from this path instead
//   data-source      optional: source name when the block has none
//   data-href        optional: link for the source name
//
// A block without a usable as_of shows "Data date not recorded"; blocks of
// kind "ratings" without one are also tagged "May be outdated", since an
// undated rating can't be shown to be current.

(function () {
  'use strict';

  var STALE_DAYS = { poll: 14, monthly: 45, ratings: 14 };
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

  // Known source pages, by block path (the block's own source_url wins)
  var SOURCE_URLS = {
    'approval.trump': 'https://www.natesilver.net/p/trump-approval-ratings-nate-silver-bulletin',
    'approval.congress': 'https://news.gallup.com/poll/1600/congress-public.aspx',
    'congress_approval.combined': 'https://news.gallup.com/poll/1600/congress-public.aspx',
    'cpi': 'https://www.bls.gov/cpi/',
  };

  // Used only when a block has no "source" field yet (data.json written
  // before scripts/fetch-polls.js added provenance fields)
  var DEFAULT_SOURCES = {
    'generic_ballot': 'New York Times polling data',
    'race_polls': 'New York Times polling data',
    'approval.trump': 'Nate Silver Bulletin',
    'approval.congress': 'Gallup',
    'congress_approval.combined': 'Gallup',
    'cpi': 'US Bureau of Labor Statistics',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getPath(obj, path) {
    return String(path || '').split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }

  // "2026-10-05" → that day; "2026-08" → { display month, stale-check from month end }
  function parseAsOf(asOf) {
    var s = String(asOf || '');
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      return { date: d, text: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) };
    }
    m = s.match(/^(\d{4})-(\d{2})$/);
    if (m) {
      var start = new Date(Date.UTC(+m[1], +m[2] - 1, 1));
      var end = new Date(Date.UTC(+m[1], +m[2], 0));
      return { date: end, text: start.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) };
    }
    return null;
  }

  function isStale(date, kind) {
    return !!date && (Date.now() - date.getTime()) > (STALE_DAYS[kind] || 14) * DAY_MS;
  }

  function staleTag() {
    return '<span class="dl-stale">May be outdated</span>';
  }

  // "Gallup, Congress and the Public (news.gallup.com/poll/1600)" → "Gallup, Congress and the Public"
  function shortSource(s) {
    return String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  // Label HTML for one block. opts: { kind, asOfPath, source, href, data }
  function html(block, opts) {
    opts = opts || {};
    var kind = opts.kind || 'poll';
    var full = (block && block.source) || opts.source || '';
    var name = shortSource(full) || 'Unknown source';
    var href = (block && block.source_url) || opts.href || '';
    var src = href
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener" title="' + esc(full) + '">' + esc(name) + '</a>'
      : '<span title="' + esc(full) + '">' + esc(name) + '</span>';
    var asOf = parseAsOf(opts.asOfPath && opts.data ? getPath(opts.data, opts.asOfPath) : block && block.as_of);
    var when = asOf ? 'Data as of ' + esc(asOf.text) : (kind === 'ratings' ? 'Rating date not recorded' : 'Data date not recorded');
    var stale = asOf ? isStale(asOf.date, kind) : kind === 'ratings';
    return 'Source: ' + src + ' · ' + when + (stale ? ' ' + staleTag() : '');
  }

  function fill(data, root) {
    if (!data) return;
    (root || document).querySelectorAll('.dl-label[data-block]').forEach(function (el) {
      var path = el.getAttribute('data-block');
      el.innerHTML = html(getPath(data, path), {
        kind: el.getAttribute('data-kind'),
        asOfPath: el.getAttribute('data-asof-path'),
        source: el.getAttribute('data-source') || DEFAULT_SOURCES[path],
        href: el.getAttribute('data-href') || SOURCE_URLS[path],
        data: data,
      });
    });
  }

  // ── Forecaster ratings from briefs.json ─────────────────────────────────
  // "Cook Toss Up (Sept 23); IE Toss-up (late September); Sabato Lean D (Sept 29; moved from Lean R on July 30)"
  // → [{ forecaster, rating, dateText, date, approx, note }]. Parts that don't
  // fit the pattern (e.g. "Sabato not on competitive list") come back as
  // { text } with no date.
  var RATING_RE = /^(Cook|IE|Inside Elections|Sabato|Silver Bulletin)\s+(.+?)\s*\(([^)]*)\)\s*$/;

  function parseRatingDate(text) {
    var now = new Date();
    var m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})\b/i);
    var approx = false, month, day;
    if (m) { month = MONTHS[m[1].toLowerCase()]; day = +m[2]; }
    else {
      m = text.match(/\b(early|mid|late)[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*/i);
      if (!m) return null;
      month = MONTHS[m[2].toLowerCase()];
      day = { early: 5, mid: 15, late: 25 }[m[1].toLowerCase()];
      approx = true;
    }
    if (month == null) return null;
    var d = new Date(Date.UTC(now.getUTCFullYear(), month, day));
    if (d.getTime() - now.getTime() > 7 * DAY_MS) d = new Date(Date.UTC(now.getUTCFullYear() - 1, month, day));
    return { date: d, approx: approx };
  }

  function parseRatings(str) {
    return String(str || '').split(/;\s*(?![^()]*\))/).map(function (p) { return p.trim(); }).filter(Boolean).map(function (part) {
      var m = part.match(RATING_RE);
      if (!m) return { text: part };
      var inner = m[3].split(/[;,]/);
      var parsed = parseRatingDate(inner[0]);
      return {
        forecaster: m[1] === 'IE' ? 'Inside Elections' : m[1],
        rating: m[2],
        dateText: inner[0].trim(),
        note: inner.slice(1).join(',').trim() || null,
        date: parsed ? parsed.date : null,
        approx: parsed ? parsed.approx : false,
      };
    });
  }

  // <ul> of forecaster ratings, each with its own date and a stale tag
  function ratingsHtml(str) {
    var rows = parseRatings(str);
    if (!rows.length) return '';
    return '<ul class="dl-ratings">' + rows.map(function (r) {
      if (r.text) return '<li>' + esc(r.text) + '</li>';
      return '<li><strong>' + esc(r.forecaster) + '</strong> ' + esc(r.rating) +
        ' <span class="dl-rating-date">(' + esc(r.dateText) + (r.note ? '; ' + esc(r.note) : '') + ')</span>' +
        (isStale(r.date, 'ratings') ? ' ' + staleTag() : '') + '</li>';
    }).join('') + '</ul>';
  }

  window.DataLabels = {
    fill: fill,
    html: html,
    isStale: isStale,
    parseAsOf: parseAsOf,
    parseRatings: parseRatings,
    ratingsHtml: ratingsHtml,
    staleTag: staleTag,
  };
})();
