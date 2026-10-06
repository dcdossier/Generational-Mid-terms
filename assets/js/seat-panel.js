// assets/js/seat-panel.js
//
// Slide-in seat brief panel, shared by map.html and india.html.
// Call window.SeatPanel.open(id, opts) / window.SeatPanel.close() once a
// page includes this script and assets/css/seat-panel.css.
//
// Reads assets/briefs.json (built by scripts/build_briefs.py) and, for
// House/Senate seats, assets/issues.json (Key Issues, independent of the
// briefs). Never hand-edit either file.
//
// IDs passed to open() must already be canonical (e.g. "AZ-01", "Senate-TX",
// "Gov-NE") -- see assets/js/seat-ids.js (toSeatId) for converting a raw
// site key before calling this. This file keeps its own tiny abbreviation
// table (below) for the fallback title and for resolving the Senate key
// into assets/issues.json's full-state-name keys; it does not otherwise
// depend on seat-ids.js.
//
// open(id, opts):
//   opts.mode       "default" (opens "Seat Overview") or "india" (opens
//                   "Strategic Outlook" and shows an India-significance
//                   callout up top, built from the brief's "india_angle"
//                   and "india" fields -- see buildIndiaCallout below).
//   opts.rating     optional current site rating string (e.g. "Toss-up"),
//                   shown as a badge -- this is the caller's own live
//                   data.json rating, distinct from the dated forecaster
//                   string inside the brief itself.
//   opts.incumbent  optional pre-formatted incumbent/open-seat line, e.g.
//                   "Jon Ossoff (incumbent)" or "Open seat -- X not
//                   seeking re-election".
//   opts.note       optional free-text race note from the caller's own data.
//   opts.returnFocus optional element to focus when the panel closes
//                   (default: whatever had focus when it opened).
// These three are supplementary context the caller already has in memory
// (e.g. map.html's data.json race object) -- SeatPanel does not fetch
// data.json itself.
//
// renderBriefInto(containerEl, id, opts) -> Promise<boolean>
//   Renders the SAME body content (India callout + sections + Key Issues)
//   used inside the panel's own #sp-body, into an arbitrary container
//   element instead -- for a host page that wants to embed a brief inside
//   its own existing detail UI (e.g. india.html's member side panel)
//   without duplicating the rendering logic. Resolves true and renders if
//   a briefs.json entry exists for id, resolves false and renders nothing
//   if it doesn't (so the caller can skip adding an empty section).
//   Does not touch the panel itself, the URL hash, or focus.
//
// The panel's own body also gets a "Latest news" block for the seat's
// nominees, from assets/candidate-news.json (built every 6 hours by
// scripts/fetch-candidate-news.js). renderBriefInto does not add it -- an
// embedding page shows its own news for the person it is about.
//
// loadCandidateNews(force) -> Promise<object>
//   Cached read of assets/candidate-news.json ({} if it fails); force
//   re-fetches past the cache and the browser cache.
// renderNewsList(containerEl, items, checkedAt)
//   Renders a list of {title, url, source, date} items into containerEl, or
//   "No coverage found in the last 7 days" with the time of the last check.
//   Shared with india.html's member side panel.
//
// It also gets a "Polls" block from data.json's race_polls (written by
// scripts/fetch-polls.js), and the header lists each forecaster's rating with
// its own date, flagged when older than 14 days (uses assets/js/data-labels.js
// when the page includes it).
//
// Dispatches 'seatpanel:open' / 'seatpanel:close' CustomEvents on window
// (detail: {id}) so a host page can sync its own UI (e.g. map/list
// highlighting, or closing its own competing detail panel) without polling.

(function () {
  'use strict';

  var BRIEFS_URL = 'assets/briefs.json';
  var ISSUES_URL = 'assets/issues.json';
  var NEWS_URL   = 'assets/candidate-news.json';
  var DATA_URL   = 'data.json';

  var ABBR_TO_STATE = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
    MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
    NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
    OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    DC: 'District of Columbia',
  };

  var briefsPromise = null;
  var newsPromise = null;
  var dataPromise = null;
  var issuesPromise = null;
  var dom = null;
  var isOpen = false;
  var currentId = null;
  var lastFocused = null;

  // ── helpers ──────────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fallbackType(id) {
    if (id.indexOf('Senate-') === 0) return 'Senate';
    if (id.indexOf('Gov-') === 0) return 'Governor';
    return 'House';
  }

  function fallbackTitle(id) {
    if (id.indexOf('Senate-') === 0) {
      var sAbbr = id.slice('Senate-'.length);
      return (ABBR_TO_STATE[sAbbr] || sAbbr) + ' (Senate)';
    }
    if (id.indexOf('Gov-') === 0) {
      var gAbbr = id.slice('Gov-'.length);
      return (ABBR_TO_STATE[gAbbr] || gAbbr) + ' (Governor)';
    }
    var m = id.match(/^([A-Z]{2})-(\d{2}|AL)$/);
    if (m) {
      var state = ABBR_TO_STATE[m[1]] || m[1];
      return m[2] === 'AL' ? state + ' At-Large (House)' : state + ' District ' + parseInt(m[2], 10) + ' (House)';
    }
    return id;
  }

  // Maps a canonical ID to its assets/issues.json lookup: { chamber, key }.
  // House district strings in data.json/issues.json are already in the
  // canonical "AZ-01" shape, so the house key is the id itself. Senate
  // issues.json is keyed by full state name. Governor has no issues.json
  // section at all (confirmed -- nothing to show there).
  function issuesLookupFor(id) {
    if (id.indexOf('Senate-') === 0) {
      var abbr = id.slice('Senate-'.length);
      return { chamber: 'senate', key: ABBR_TO_STATE[abbr] || abbr };
    }
    if (id.indexOf('Gov-') === 0) return null;
    return { chamber: 'house', key: id };
  }

  function loadJson(url, cachePromiseGetter, cachePromiseSetter) {
    var cached = cachePromiseGetter();
    if (cached) return cached;
    var p = fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (err) {
        console.error('[SeatPanel] failed to load ' + url, err);
        return {};
      });
    cachePromiseSetter(p);
    return p;
  }

  function loadBriefs() {
    return loadJson(BRIEFS_URL, function () { return briefsPromise; }, function (p) { briefsPromise = p; });
  }

  function loadIssues() {
    return loadJson(ISSUES_URL, function () { return issuesPromise; }, function (p) { issuesPromise = p; });
  }

  function loadData() {
    return loadJson(DATA_URL, function () { return dataPromise; }, function (p) { dataPromise = p; });
  }

  function loadCandidateNews(force) {
    if (force) newsPromise = null;
    var url = force ? NEWS_URL + '?t=' + Date.now() : NEWS_URL;
    return loadJson(url, function () { return newsPromise; }, function (p) { newsPromise = p; });
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  function ensureDom() {
    if (dom) return dom;

    var overlay = document.createElement('div');
    overlay.id = 'seat-panel-overlay';
    overlay.setAttribute('hidden', '');

    var panel = document.createElement('aside');
    panel.id = 'seat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'sp-title');
    panel.setAttribute('tabindex', '-1');
    panel.setAttribute('hidden', '');
    panel.innerHTML =
      '<div class="sp-header">' +
        '<button type="button" class="sp-close" id="sp-close" aria-label="Close seat brief">&times;</button>' +
        '<div class="sp-head-meta">' +
          '<span class="sp-type-pill" id="sp-type"></span>' +
          '<span class="sp-rating-pill" id="sp-rating" style="display:none"></span>' +
          '<span class="sp-status" id="sp-status"></span>' +
        '</div>' +
        '<h2 class="sp-title" id="sp-title"></h2>' +
        '<div class="sp-incumbent" id="sp-incumbent" style="display:none"></div>' +
        '<div class="sp-nominees">' +
          '<div class="sp-nominee sp-nominee-d"><span class="sp-nominee-label">D</span><span class="sp-nominee-name" id="sp-dem"></span></div>' +
          '<div class="sp-nominee sp-nominee-r"><span class="sp-nominee-label">R</span><span class="sp-nominee-name" id="sp-rep"></span></div>' +
        '</div>' +
        '<div class="sp-ratings" id="sp-ratings"></div>' +
        '<div class="sp-note" id="sp-note" style="display:none"></div>' +
      '</div>' +
      '<div class="sp-body" id="sp-body"></div>';

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    panel.querySelector('#sp-close').addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    // Bubble-phase click-outside-closes. The overlay itself is decorative
    // only (pointer-events: none, see seat-panel.css) so that clicking a
    // different seat on the page while the panel is open reaches that
    // seat's own click handler directly, instead of being swallowed by a
    // full-viewport scrim. Any such handler must call
    // event.stopPropagation() so this listener doesn't then close the
    // panel it just asked to re-open for a new seat.
    document.addEventListener('click', onDocumentClick);
    window.addEventListener('popstate', onPopState);

    dom = {
      overlay: overlay,
      panel: panel,
      type: panel.querySelector('#sp-type'),
      rating: panel.querySelector('#sp-rating'),
      status: panel.querySelector('#sp-status'),
      titleEl: panel.querySelector('#sp-title'),
      incumbent: panel.querySelector('#sp-incumbent'),
      dem: panel.querySelector('#sp-dem'),
      rep: panel.querySelector('#sp-rep'),
      ratings: panel.querySelector('#sp-ratings'),
      note: panel.querySelector('#sp-note'),
      body: panel.querySelector('#sp-body'),
    };
    return dom;
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && isOpen) close();
  }

  function onDocumentClick(e) {
    if (!isOpen || !dom) return;
    if (dom.panel.contains(e.target)) return;
    close();
  }

  // Canonical seat IDs only ("AZ-01", "AK-AL", "Senate-TX", "Gov-TX"); other
  // hashes (e.g. map.html's "#seats") belong to the host page.
  function isSeatId(s) {
    return /^([A-Z]{2}-(\d{2}|AL)|Senate-[A-Z]{2}|Gov-[A-Z]{2})$/.test(s);
  }

  function onPopState() {
    var hashId = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
    if (!hashId || !isSeatId(hashId)) {
      if (isOpen) close();
      return;
    }
    if (hashId === currentId) return;
    open(hashId, { mode: 'default' });
  }

  function setNominee(el, name) {
    if (name) {
      el.textContent = name;
      el.classList.remove('sp-nominee-empty');
    } else {
      el.textContent = 'Not available';
      el.classList.add('sp-nominee-empty');
    }
  }

  function setOptionalText(el, text) {
    if (text) {
      el.textContent = text;
      el.style.display = '';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  // ── Key Issues section (assets/issues.json) ─────────────────────────────

  function buildIssuesSection(issues) {
    var details = document.createElement('details');
    details.className = 'sp-section';
    var summary = document.createElement('summary');
    summary.textContent = 'Key Issues';
    var body = document.createElement('div');
    body.className = 'sp-section-body';
    body.innerHTML = issues.map(function (iss) {
      var relTag = iss.r ? '<span class="sp-issue-rel">' + escapeHtml(iss.r) + '</span>' : '';
      var srcLink = iss.su
        ? '<span class="sp-issue-src"><a href="' + escapeHtml(iss.su) + '" target="_blank" rel="noopener">' + escapeHtml(iss.sl || iss.su) + '</a></span>'
        : (iss.sl ? '<span class="sp-issue-src">' + escapeHtml(iss.sl) + '</span>' : '');
      return '<div class="sp-issue-item">' +
        '<div class="sp-issue-title">' + escapeHtml(iss.t || '') + '</div>' +
        '<div class="sp-issue-desc">' + escapeHtml(iss.d || '') + '</div>' +
        '<div class="sp-issue-footer">' + relTag + srcLink + '</div>' +
      '</div>';
    }).join('');
    details.appendChild(summary);
    details.appendChild(body);
    return details;
  }

  // ── body builder (shared by the panel's own #sp-body and renderBriefInto) ──

  // "India" mode always shows a callout, even with nothing to say -- the
  // explicit "No India-specific angle identified" message is itself useful
  // information (confirms the brief was checked, not just missing).
  function buildIndiaCallout(entry) {
    var angle = entry && entry.india_angle;
    var briefHtml = entry && entry.india;
    var inner = '';
    if (angle) inner += '<div class="sp-india-angle">' + escapeHtml(angle) + '</div>';
    if (briefHtml) inner += '<div class="sp-india-brief">' + briefHtml + '</div>';
    if (!inner) inner = '<div class="sp-india-none">No India-specific angle identified</div>';
    var callout = document.createElement('div');
    callout.className = 'sp-india-callout';
    callout.innerHTML = '<span class="sp-india-callout-label">Significance for India–US interests</span>' + inner;
    return callout;
  }

  // Renders India callout (if mode is 'india') + the 5 brief sections (or a
  // "coming soon" placeholder) + Key Issues, into targetEl. Used both for
  // the panel's own body and for embedding (renderBriefInto).
  function buildBody(targetEl, id, entry, opts, issuesData) {
    var mode = opts.mode;
    targetEl.innerHTML = '';

    if (mode === 'india') {
      targetEl.appendChild(buildIndiaCallout(entry));
    }

    var sections = entry && entry.sections;
    if (sections && sections.length) {
      var defaultOpenHeading = mode === 'india' ? 'Strategic Outlook' : 'Seat Overview';
      sections.forEach(function (s) {
        var details = document.createElement('details');
        details.className = 'sp-section';
        if (s.heading === defaultOpenHeading) details.setAttribute('open', '');
        var summary = document.createElement('summary');
        summary.textContent = s.heading;
        var body = document.createElement('div');
        body.className = 'sp-section-body';
        body.innerHTML = s.html; // sanitised HTML from build_briefs.py
        details.appendChild(summary);
        details.appendChild(body);
        targetEl.appendChild(details);
      });
    } else {
      var soon = document.createElement('div');
      soon.className = 'sp-coming-soon';
      soon.innerHTML = '<strong>Brief coming soon</strong>Full seat analysis for this race has not been published yet.';
      targetEl.appendChild(soon);
    }

    if (issuesData && issuesData.length) {
      targetEl.appendChild(buildIssuesSection(issuesData));
    }
  }

  // ── Latest news (assets/candidate-news.json) ────────────────────────────

  function formatDate(iso, withTime) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var o = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; o.timeZoneName = 'short'; }
    return d.toLocaleString('en-GB', o);
  }

  function renderNewsList(containerEl, items, checkedAt) {
    if (!containerEl) return;
    if (!items || !items.length) {
      var checked = checkedAt ? 'Last checked ' + formatDate(checkedAt, true) + '.' : 'News has not been checked yet.';
      containerEl.innerHTML = '<div class="sp-latest-empty">No coverage found in the last 7 days. ' + escapeHtml(checked) + '</div>';
      return;
    }
    containerEl.innerHTML = items.map(function (it) {
      return '<div class="sp-latest-item">' +
        '<div class="sp-latest-meta">' + escapeHtml(it.source || '') + ' · ' + escapeHtml(formatDate(it.date)) + '</div>' +
        '<a class="sp-latest-title" href="' + escapeHtml(it.url || '#') + '" target="_blank" rel="noopener">' + escapeHtml(it.title || '') + '</a>' +
      '</div>';
    }).join('');
  }

  // One sub-list per nominee in the brief (Democrat, then Republican).
  function buildNewsSection(id, entry, news) {
    var details = document.createElement('details');
    details.className = 'sp-section';
    details.setAttribute('open', '');
    var summary = document.createElement('summary');
    summary.textContent = 'Latest news';
    var body = document.createElement('div');
    body.className = 'sp-section-body';

    var seat = news && news.seats && news.seats[id];
    var candidates = (seat && seat.candidates) || [];
    var checkedAt = news && news.meta && news.meta.updated;
    // Fall back to the brief's nominee names if the seat isn't in the news file yet
    if (!candidates.length && entry) {
      if (entry.dem) candidates.push({ name: entry.dem, party: 'D', items: [] });
      if (entry.rep) candidates.push({ name: entry.rep, party: 'R', items: [] });
    }
    if (!candidates.length) {
      body.innerHTML = '<div class="sp-latest-empty">No nominees listed for this seat yet.</div>';
    }
    candidates.forEach(function (c) {
      var head = document.createElement('div');
      head.className = 'sp-latest-name';
      head.textContent = c.name + ' (' + c.party + ')';
      var list = document.createElement('div');
      list.className = 'sp-latest-list';
      renderNewsList(list, c.items, checkedAt);
      body.appendChild(head);
      body.appendChild(list);
    });
    details.appendChild(summary);
    details.appendChild(body);
    return details;
  }

  // ── Polls (data.json race_polls) ──────────────────────────────────────────

  function pollDates(p) {
    var f = function (iso, withYear) {
      var d = new Date(iso + 'T00:00:00Z');
      return isNaN(d) ? '' : d.toLocaleDateString('en-GB', withYear
        ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
        : { day: 'numeric', month: 'short', timeZone: 'UTC' });
    };
    if (!p.start || p.start === p.end) return f(p.end, true);
    // "2–3 Oct 2026" within a month, "29 Sept–1 Oct 2026" across months
    return p.start.slice(0, 7) === p.end.slice(0, 7)
      ? String(+p.start.slice(8, 10)) + '–' + f(p.end, true)
      : f(p.start, false) + '–' + f(p.end, true);
  }

  function candidateCell(c) {
    return c ? escapeHtml(c.name) + ' <strong>' + escapeHtml(c.pct) + '%</strong>' : '&#8212;';
  }

  function buildPollsSection(id, data) {
    var details = document.createElement('details');
    details.className = 'sp-section';
    details.setAttribute('open', '');
    var summary = document.createElement('summary');
    summary.textContent = 'Polls';
    var body = document.createElement('div');
    body.className = 'sp-section-body';

    var root = data && data.race_polls;
    var race = root && root.races && root.races[id];
    if (!race || !race.latest || !race.latest.length) {
      body.innerHTML = '<div class="sp-latest-empty">No polls of this matchup in the New York Times polling data.</div>';
    } else {
      var avg = race.average_30d;
      var html = avg
        ? '<div class="sp-poll-avg">30-day average: D ' + escapeHtml(avg.dem) + '% · R ' + escapeHtml(avg.rep) + '% (' +
          (avg.margin > 0 ? 'D+' + escapeHtml(avg.margin) : avg.margin < 0 ? 'R+' + escapeHtml(-avg.margin) : 'even') +
          ', ' + escapeHtml(avg.n_polls) + ' poll' + (avg.n_polls === 1 ? '' : 's') + ')</div>'
        : '<div class="sp-poll-avg">No non-partisan polls in the last 30 days.</div>';
      html += race.latest.map(function (p) {
        var others = (p.others || []).filter(function (o) { return o.pct >= 2; });
        return '<div class="sp-poll">' +
          '<div class="sp-poll-meta">' + escapeHtml(p.pollster) + (p.sponsors ? ' for ' + escapeHtml(p.sponsors) : '') +
            ' · ' + escapeHtml(pollDates(p)) +
            (p.sample ? ' · ' + escapeHtml(p.sample.toLocaleString('en-GB')) + ' ' + escapeHtml((p.population || '').toUpperCase()) : '') +
            (p.partisan ? ' · partisan (' + escapeHtml(p.partisan) + ')' : '') + '</div>' +
          '<div class="sp-poll-result">' + candidateCell(p.dem) + ' · ' + candidateCell(p.rep) +
            (others.length ? ' · ' + others.map(function (o) { return escapeHtml(o.name) + ' ' + escapeHtml(o.pct) + '%'; }).join(' · ') : '') +
          '</div>' +
        '</div>';
      }).join('');
      body.innerHTML = html;
    }
    var label = document.createElement('div');
    label.className = 'dl-label';
    if (window.DataLabels) label.innerHTML = window.DataLabels.html(race || root, { kind: 'poll' });
    body.appendChild(label);

    details.appendChild(summary);
    details.appendChild(body);
    return details;
  }

  function loadIssuesDataFor(id) {
    var lookup = issuesLookupFor(id);
    if (!lookup) return Promise.resolve(null);
    return loadIssues().then(function (issuesRoot) {
      return (issuesRoot && issuesRoot[lookup.chamber]) ? issuesRoot[lookup.chamber][lookup.key] : null;
    });
  }

  // ── render (the panel's own header + body) ──────────────────────────────

  function render(id, entry, opts, issuesData) {
    var d = ensureDom();
    var type = (entry && entry.type) || fallbackType(id);
    var title = (entry && entry.title) || fallbackTitle(id);
    var status = entry && entry.status;
    var ratings = entry && entry.ratings;

    d.type.textContent = type;
    setOptionalText(d.rating, opts.rating || null);
    // The caller's rating (data.json) carries no date of its own
    d.rating.title = opts.rating ? 'Site rating from data.json — date not recorded; see the dated forecaster ratings below' : '';
    d.status.textContent = status || '';
    d.status.style.display = status ? '' : 'none';
    d.titleEl.textContent = title;
    setOptionalText(d.incumbent, opts.incumbent || null);
    setNominee(d.dem, entry && entry.dem);
    setNominee(d.rep, entry && entry.rep);
    if (ratings && window.DataLabels) d.ratings.innerHTML = window.DataLabels.ratingsHtml(ratings);
    else d.ratings.textContent = ratings || '';
    d.ratings.style.display = ratings ? '' : 'none';
    setOptionalText(d.note, opts.note || null);

    buildBody(d.body, id, entry, opts, issuesData);
  }

  // ── public API ───────────────────────────────────────────────────────────

  function open(id, opts) {
    if (!id) return;
    opts = opts || {};
    if (opts.mode !== 'india') opts.mode = 'default';

    if (!isOpen) lastFocused = document.activeElement;
    // A host page can say where focus goes on close (e.g. map.html's banner)
    if (opts.returnFocus) lastFocused = opts.returnFocus;

    var d = ensureDom();
    currentId = id;
    isOpen = true;

    Promise.all([loadBriefs(), loadIssuesDataFor(id), loadCandidateNews(), loadData()]).then(function (results) {
      if (currentId !== id) return; // superseded by a later open() call
      render(id, results[0][id], opts, results[1]);
      // The caller's rating comes from data.json races.<chamber>; give it that block's date
      var chamber = id.indexOf('Senate-') === 0 ? 'senate' : id.indexOf('Gov-') === 0 ? 'governor' : 'house';
      var races = results[3] && results[3].races && results[3].races[chamber];
      var asOf = races && races.as_of && window.DataLabels ? window.DataLabels.parseAsOf(races.as_of) : null;
      if (opts.rating && asOf) {
        ensureDom().rating.title = 'Site rating, ratings last updated ' + asOf.text +
          (window.DataLabels.isStale(asOf.date, 'ratings') ? ' (may be outdated)' : '') + '; dated forecaster ratings below';
      }
      ensureDom().body.appendChild(buildPollsSection(id, results[3]));
      ensureDom().body.appendChild(buildNewsSection(id, results[0][id], results[2]));
    });

    d.overlay.removeAttribute('hidden');
    d.panel.removeAttribute('hidden');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        d.overlay.classList.add('sp-open');
        d.panel.classList.add('sp-open');
      });
    });
    d.panel.focus({ preventScroll: true });   // never move the page behind the panel

    if (location.hash.slice(1) !== encodeURIComponent(id)) {
      history.pushState(null, '', '#' + encodeURIComponent(id));
    }

    window.dispatchEvent(new CustomEvent('seatpanel:open', { detail: { id: id } }));
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    var d = ensureDom();
    var closedId = currentId;
    d.overlay.classList.remove('sp-open');
    d.panel.classList.remove('sp-open');

    setTimeout(function () {
      d.overlay.setAttribute('hidden', '');
      d.panel.setAttribute('hidden', '');
    }, 280);

    if (location.hash && decodeURIComponent(location.hash.slice(1)) === currentId) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    currentId = null;

    var toFocus = lastFocused;
    lastFocused = null;

    // Fire first so the host can un-hide elements (e.g. the banner on mobile)
    window.dispatchEvent(new CustomEvent('seatpanel:close', { detail: { id: closedId } }));

    if (toFocus && document.contains(toFocus) && typeof toFocus.focus === 'function') {
      toFocus.focus();
    }
  }

  // Embeds a brief into a host page's own container (see file header).
  function renderBriefInto(containerEl, id, opts) {
    if (!containerEl || !id) return Promise.resolve(false);
    opts = opts || {};
    if (opts.mode !== 'india') opts.mode = 'default';

    return Promise.all([loadBriefs(), loadIssuesDataFor(id)]).then(function (results) {
      var entry = results[0][id];
      if (!entry) return false;
      buildBody(containerEl, id, entry, opts, results[1]);
      return true;
    });
  }

  // ── deep link on load ────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    if (location.hash) {
      var hashId = decodeURIComponent(location.hash.slice(1));
      // Guard against redundant re-open: if something already opened this
      // exact seat (e.g. a caller-triggered open() that itself set this
      // hash moments earlier), calling open() again here would clobber any
      // richer opts (rating/incumbent/note) that call already supplied.
      if (hashId && isSeatId(hashId) && hashId !== currentId) open(hashId, { mode: 'default' });
    }
  });

  window.SeatPanel = {
    open: open,
    close: close,
    renderBriefInto: renderBriefInto,
    loadCandidateNews: loadCandidateNews,
    renderNewsList: renderNewsList,
  };
})();
