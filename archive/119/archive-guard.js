/* Archive guard: archived pages are read-only and must never fetch live data.
 * Any fetch, XHR, WebSocket, EventSource or beacon that would leave this archive
 * folder is refused. Loaded first in every archived page. */
(function () {
  'use strict';
  var me = document.currentScript && document.currentScript.src;
  var BASE = new URL('./', me || location.href).href;
  function inside(u) {
    try { var x = new URL(u, location.href); return x.href.indexOf(BASE) === 0; } catch (e) { return false; }
  }
  function refuse(kind, u) { try { console.info('[archive] ' + kind + ' blocked: ' + u); } catch (e) {} }
  var f = window.fetch;
  if (f) window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!inside(u)) { refuse('fetch', u); return Promise.reject(new TypeError('Archived page: network request blocked')); }
    return f.call(this, input, init);
  };
  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    if (!inside(u)) { refuse('XHR', u); throw new TypeError('Archived page: network request blocked'); }
    return open.apply(this, arguments);
  };
  window.WebSocket = function (u) { refuse('WebSocket', u); throw new TypeError('Archived page: live connections blocked'); };
  window.EventSource = function (u) { refuse('EventSource', u); throw new TypeError('Archived page: live connections blocked'); };
  if (navigator.sendBeacon) navigator.sendBeacon = function (u) { refuse('beacon', u); return false; };
  window.RACEBOOK_ARCHIVE = { congress: '119', label: 'snapshot 3 Nov 2026' };
  if (window.self !== window.top) document.documentElement.classList.add('arch-in-frame');
})();
