/* Observer comment threads.
 *
 * Any element with data-comments="<tab slug>" becomes a thread. It loads only when
 * it scrolls into view. Reads come from the comments_public view; every write goes
 * through a Supabase function (see supabase/comments.sql). The anon key below is
 * public by design: it can read visible comments and call those functions, nothing else.
 */
(function () {
  'use strict';

  var SB_URL = 'https://zxwrecjvhmoceyfsarwz.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4d3JlY2p2aG1vY2V5ZnNhcnd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NzQxMzUsImV4cCI6MjEwODA1MDEzNX0.v6JG5hyTbfl-Yon7GSATXkmfwpItUm5DKb8PLcmELlY';
  var LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
  var COLS = 'id,page,parent_id,name,body,created_at,edited_at,likes,is_team';
  var EDIT_WINDOW_MS = 15 * 60 * 1000;
  var MAX_DEPTH = 5;          // levels shown before "Continue thread"
  var MAX_IMAGES = 3;

  // Inside the site shell the page's own contact line is not needed
  try { if (window.self !== window.top) document.documentElement.classList.add('cm-in-frame'); }
  catch (e) { document.documentElement.classList.add('cm-in-frame'); }

  /* ── storage (every call may throw: private mode, blocked site data) ── */
  var mem = {};
  function sget(k) {
    try { var v = localStorage.getItem(k); return v === null ? mem[k] : v; } catch (e) { return mem[k]; }
  }
  function sset(k, v) {
    mem[k] = v;
    try { localStorage.setItem(k, v); } catch (e) { /* kept in memory for this visit */ }
  }
  function sjson(k, dflt) {
    try { var v = JSON.parse(sget(k) || 'null'); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function randomId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, ''); } catch (e) { /* fall through */ }
    var s = ''; for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
  function voterId() {
    var v = sget('cm_voter');
    if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) { v = randomId(); sset('cm_voter', v); }
    return v;
  }
  // Edit tokens: { commentId: { t: token, at: createdAtMs } }, pruned after the edit window
  function tokens() {
    var all = sjson('cm_tokens', {}), now = Date.now(), out = {};
    Object.keys(all).forEach(function (k) { if (all[k] && now - all[k].at < EDIT_WINDOW_MS + 60000) out[k] = all[k]; });
    return out;
  }
  function saveToken(id, t, at) { var all = tokens(); all[id] = { t: t, at: at }; sset('cm_tokens', JSON.stringify(all)); }
  function dropToken(id) { var all = tokens(); delete all[id]; sset('cm_tokens', JSON.stringify(all)); }
  function idSet(k) { return sjson(k, []); }
  function setId(k, id, on) {
    var a = idSet(k).filter(function (x) { return x !== id; });
    if (on) a.push(id);
    sset(k, JSON.stringify(a.slice(-500)));
  }

  /* ── Supabase client, loaded on first use ── */
  var clientP = null;
  function client() {
    if (clientP) return clientP;
    clientP = new Promise(function (resolve, reject) {
      function make() {
        resolve(window.supabase.createClient(SB_URL, SB_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
        }));
      }
      if (window.supabase && window.supabase.createClient) return make();
      var s = document.createElement('script');
      s.src = LIB; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { window.supabase && window.supabase.createClient ? make() : reject(new Error('lib')); };
      s.onerror = function () { clientP = null; reject(new Error('lib')); };
      document.head.appendChild(s);
    });
    return clientP;
  }
  // Calls a write function. Resolves with its JSON; rejects with {code}.
  function rpc(fn, args) {
    return client().then(function (sb) { return sb.rpc(fn, args); }).then(function (r) {
      if (r.error) throw { code: 'NETWORK', detail: r.error.message };
      if (!r.data || r.data.error) throw { code: (r.data && r.data.error) || 'UNKNOWN' };
      return r.data;
    }, function (e) { throw e && e.code ? e : { code: 'NETWORK' }; });
  }

  var MESSAGES = {
    RATE_LIMIT: 'You are posting quickly. Please wait a few minutes and try again. Your text is still here.',
    BLOCKED_WORD: 'Your comment includes language we do not allow. Please reword it and try again.',
    TOO_MANY_LINKS: 'Please include no more than 3 links in a comment.',
    NAME_LENGTH: 'Please enter a name of up to 60 characters.',
    BODY_LENGTH: 'Please write a comment of up to 4,000 characters.',
    RESERVED_NAME: 'That name is reserved for the Observer team. Please choose another, or enter the team code.',
    BAD_CODE: 'That team code is not right.',
    BAD_PARENT: 'The comment you are replying to is no longer available.',
    NOT_FOUND: 'That comment is no longer available.',
    NOT_AUTHOR: 'Only the author can change this comment, from the browser they posted it in.',
    TOO_LATE: 'Comments can be edited or deleted only within 15 minutes of posting.',
    REJECTED: 'Your comment could not be posted.',
    NETWORK: 'We could not reach the comments server. Check your connection and try again. Your text has been kept.',
    UNKNOWN: 'Something went wrong. Please try again. Your text has been kept.'
  };
  function msg(e) { return MESSAGES[(e && e.code) || 'UNKNOWN'] || MESSAGES.UNKNOWN; }

  /* ── text helpers ── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var URL_RE = /https?:\/\/[^\s<>"']+/gi;
  var IMG_RE = /^https:\/\/[^\s?#]+\.(?:jpe?g|png|gif|webp)(?:[?#][^\s]*)?$/i;
  // Plain text only: everything is escaped, then bare URLs become links
  function renderBody(text) {
    var out = '', last = 0, images = [], m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      var url = m[0], trail = '';
      while (/[.,;:!?)\]}'"]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
      out += esc(text.slice(last, m.index));
      var safe = esc(url);
      out += '<a href="' + safe + '" target="_blank" rel="nofollow ugc noopener">' + safe + '</a>' + esc(trail);
      if (IMG_RE.test(url) && images.length < MAX_IMAGES && images.indexOf(url) < 0) images.push(url);
      last = m.index + m[0].length;
    }
    out += esc(text.slice(last));
    var html = '<div class="cm-text">' + out + '</div>';
    if (images.length) {
      html += '<div class="cm-imgs">' + images.map(function (u) {
        return '<button type="button" class="cm-img" data-full="' + esc(u) + '" aria-label="Open image full size">' +
          '<img src="' + esc(u) + '" alt="Image shared in comment" loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>';
      }).join('') + '</div>';
    }
    return html;
  }
  function ago(iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) { var h = Math.round(s / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    if (s < 7 * 86400) { var d = Math.round(s / 86400); return d + (d === 1 ? ' day ago' : ' days ago'); }
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fullDate(iso) {
    return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function isDeleted(c) { return c.name === '[deleted]' && c.body === '[deleted]'; }

  /* ── one thread ── */
  function Thread(el) {
    this.el = el;
    this.page = el.getAttribute('data-comments');
    this.rows = {};           // id -> row
    this.pending = [];        // realtime inserts not yet shown
    this.sort = sget('cm_sort') || 'best';
    if (['best', 'new', 'old'].indexOf(this.sort) < 0) this.sort = 'best';
    this.collapsed = {};
    this.focus = null;        // id when following "Continue thread"
    this.open = null;         // {kind: 'reply'|'edit'|'delete'|'report', id}
    this.drafts = {};         // typed text survives re-renders and errors
    this.shell();
  }

  Thread.prototype.shell = function () {
    var p = this.page, name = esc(sget('cm_name') || '');
    this.el.classList.add('cm-thread');
    this.el.innerHTML =
      '<div class="cm-head">' +
        '<h2 class="cm-title" id="cm-h-' + p + '">Comments <span class="cm-count" aria-live="polite"></span></h2>' +
        '<div class="cm-sort" role="tablist" aria-label="Sort comments">' +
          ['best', 'new', 'old'].map(function (k) {
            return '<button type="button" role="tab" data-sort="' + k + '">' + k.charAt(0).toUpperCase() + k.slice(1) + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      this.formHtml('top', null, name) +
      '<div class="cm-newbar" hidden><button type="button" class="cm-shownew"></button></div>' +
      '<div class="cm-list" aria-labelledby="cm-h-' + p + '"><p class="cm-status">Loading comments…</p></div>';
    this.list = this.el.querySelector('.cm-list');
    this.markSort();
    var self = this;
    this.el.addEventListener('click', function (e) { self.onClick(e); });
    this.el.addEventListener('input', function (e) { self.onInput(e); });
    this.el.addEventListener('submit', function (e) { e.preventDefault(); self.onSubmit(e.target); });
    // an image link that does not load: drop the thumbnail, the link stays in the text
    this.el.addEventListener('error', function (e) {
      var b = e.target.closest && e.target.closest('.cm-img');
      if (b) { var row = b.parentNode; b.remove(); if (row && !row.children.length) row.remove(); }
    }, true);
  };

  Thread.prototype.formHtml = function (key, parentId, name) {
    var d = this.drafts[key] || {}, n = d.name != null ? d.name : name, uid = this.page + '-' + key;
    var team = d.team != null;
    return '<form class="cm-form" data-key="' + key + '"' + (parentId ? ' data-parent="' + parentId + '"' : '') + ' novalidate>' +
      '<div class="cm-row">' +
        '<label class="cm-lbl" for="cm-n-' + uid + '">Name</label>' +
        '<input class="cm-in" id="cm-n-' + uid + '" name="name" maxlength="60" required autocomplete="nickname" value="' + esc(n || '') + '">' +
      '</div>' +
      '<div class="cm-row">' +
        '<label class="cm-lbl" for="cm-b-' + uid + '">' + (parentId ? 'Reply' : 'Comment') + '</label>' +
        '<textarea class="cm-in cm-ta" id="cm-b-' + uid + '" name="body" maxlength="4000" required rows="' + (parentId ? 3 : 4) + '">' + esc(d.body || '') + '</textarea>' +
      '</div>' +
      // Honeypot: hidden from people and screen readers; bots tend to fill it
      '<div class="cm-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<div class="cm-row cm-team"' + (team ? '' : ' hidden') + '>' +
        '<label class="cm-lbl" for="cm-t-' + uid + '">Team code</label>' +
        '<input class="cm-in" id="cm-t-' + uid + '" name="code" type="password" autocomplete="off" value="' + esc(d.team || '') + '">' +
      '</div>' +
      '<div class="cm-formfoot">' +
        '<button type="submit" class="cm-btn cm-primary">' + (parentId ? 'Post reply' : 'Post comment') + '</button>' +
        (parentId ? '<button type="button" class="cm-btn cm-ghost" data-act="cancel">Cancel</button>' : '') +
        '<button type="button" class="cm-link cm-teamlink" data-act="team"' + (team ? ' hidden' : '') + '>Team?</button>' +
      '</div>' +
      '<p class="cm-err" role="alert" hidden></p>' +
      '<p class="cm-note">Comments are public. Be civil. Only your name is shown.</p>' +
    '</form>';
  };

  Thread.prototype.markSort = function () {
    var s = this.sort;
    this.el.querySelectorAll('[data-sort]').forEach(function (b) {
      var on = b.getAttribute('data-sort') === s;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  };

  Thread.prototype.load = function () {
    var self = this;
    this.list.innerHTML = '<p class="cm-status">Loading comments…</p>';
    return client().then(function (sb) {
      return sb.from('comments_public').select(COLS).eq('page', self.page)
        .order('created_at', { ascending: true }).limit(2000);
    }).then(function (r) {
      if (r.error) throw r.error;
      self.rows = {};
      r.data.forEach(function (c) { self.rows[c.id] = c; });
      self.render();
      self.listen();
    }).catch(function () {
      self.list.innerHTML = '<p class="cm-status">Comments could not be loaded. ' +
        '<button type="button" class="cm-link" data-act="retry">Try again</button></p>';
    });
  };

  // Realtime: new comments wait behind a bar instead of moving the page
  Thread.prototype.listen = function () {
    if (this.channel) return;
    var self = this;
    client().then(function (sb) {
      self.channel = sb.channel('comments-' + self.page)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments', filter: 'page=eq.' + self.page },
          function (ev) {
            var n = ev.new || {};
            if (!n.id || self.rows[n.id] || n.hidden === true) return;
            if (self.pending.some(function (p) { return p.id === n.id; })) return;
            var row = {};
            COLS.split(',').forEach(function (k) { row[k] = n[k] === undefined ? null : n[k]; });
            if (!row.likes) row.likes = 0;
            self.pending.push(row);
            self.showBar();
          })
        .subscribe();
    }).catch(function () { /* live updates are optional */ });
  };

  Thread.prototype.showBar = function () {
    var bar = this.el.querySelector('.cm-newbar'), n = this.pending.length;
    bar.hidden = !n;
    if (n) bar.querySelector('button').textContent = n + (n === 1 ? ' new comment' : ' new comments') + ' · Show';
  };

  /* tree and rendering */
  Thread.prototype.visibleCount = function () {
    var rows = this.rows;
    return Object.keys(rows).filter(function (k) { return !isDeleted(rows[k]); }).length;
  };

  Thread.prototype.tree = function () {
    var rows = this.rows, kids = {}, roots = [], ghosts = {};
    Object.keys(rows).forEach(function (id) {
      var c = rows[id], p = c.parent_id;
      if (p && !rows[p]) {
        // parent hidden or gone: keep the replies under a placeholder
        if (!ghosts[p]) ghosts[p] = { id: p, parent_id: null, removed: true, likes: -1, created_at: c.created_at };
        if (c.created_at < ghosts[p].created_at) ghosts[p].created_at = c.created_at;
      }
      if (p) (kids[p] = kids[p] || []).push(c); else roots.push(c);
    });
    Object.keys(ghosts).forEach(function (g) { roots.push(ghosts[g]); });
    return { kids: kids, roots: roots };
  };

  Thread.prototype.sorter = function () {
    var s = this.sort;
    return function (a, b) {
      if (s === 'old') return a.created_at < b.created_at ? -1 : 1;
      if (s === 'best' && b.likes !== a.likes) return b.likes - a.likes;
      return a.created_at < b.created_at ? 1 : -1;
    };
  };

  Thread.prototype.countDesc = function (id, kids) {
    var n = 0, st = (kids[id] || []).slice();
    while (st.length) { var c = st.pop(); n++; (kids[c.id] || []).forEach(function (k) { st.push(k); }); }
    return n;
  };

  Thread.prototype.render = function () {
    var n = this.visibleCount();
    this.el.querySelector('.cm-count').textContent = n ? '(' + n + ')' : '';
    var t = this.tree(), sorter = this.sorter(), self = this, html = '';
    var roots = t.roots;
    if (this.focus) {
      var f = this.rows[this.focus];
      if (f) {
        roots = [f];
        html += '<div class="cm-focusbar"><button type="button" class="cm-link" data-act="unfocus">← Back to all comments</button></div>';
      } else this.focus = null;
    }
    roots = roots.slice().sort(sorter);
    if (!roots.length) { this.list.innerHTML = '<p class="cm-empty">Be the first to comment.</p>'; return; }
    html += roots.map(function (c) { return self.nodeHtml(c, 0, t.kids, sorter); }).join('');
    this.list.innerHTML = html;
    this.restoreOpen();
  };

  Thread.prototype.nodeHtml = function (c, depth, kids, sorter) {
    var self = this, children = (kids[c.id] || []).slice().sort(sorter);
    var col = !!this.collapsed[c.id];
    var head, body = '', actions = '';
    if (c.removed) {
      head = '<span class="cm-name cm-muted">[removed]</span>';
      body = '<div class="cm-body cm-muted">This comment was removed.</div>';
    } else {
      var del = isDeleted(c);
      head = '<span class="cm-name">' + esc(c.name) + '</span>' +
        (c.is_team ? ' <span class="cm-badge">Team</span>' : '') +
        ' <span class="cm-dot" aria-hidden="true">·</span> <time datetime="' + esc(c.created_at) + '" title="' + esc(fullDate(c.created_at)) + '">' + ago(c.created_at) + '</time>' +
        (c.edited_at && !del ? ' <span class="cm-muted" title="Edited ' + esc(fullDate(c.edited_at)) + '">(edited)</span>' : '');
      body = '<div class="cm-body' + (del ? ' cm-muted' : '') + '">' + (del ? '<div class="cm-text">[deleted]</div>' : renderBody(c.body)) + '</div>';
      if (!del) {
        var liked = idSet('cm_liked').indexOf(c.id) >= 0, reported = idSet('cm_reported').indexOf(c.id) >= 0;
        var tok = tokens()[c.id], mine = tok && Date.now() - new Date(c.created_at).getTime() < EDIT_WINDOW_MS;
        actions = '<div class="cm-actions">' +
          '<button type="button" class="cm-act cm-like' + (liked ? ' on' : '') + '" data-act="like" aria-pressed="' + liked + '">' +
            '<span aria-hidden="true">▲</span> Like <span class="cm-n">' + (c.likes || 0) + '</span></button>' +
          '<button type="button" class="cm-act" data-act="reply">Reply</button>' +
          '<button type="button" class="cm-act" data-act="report"' + (reported ? ' disabled' : '') + '>' + (reported ? 'Reported' : 'Report') + '</button>' +
          (mine ? '<button type="button" class="cm-act" data-act="edit">Edit</button><button type="button" class="cm-act" data-act="delete">Delete</button>' : '') +
        '</div>';
      }
    }
    var more = '';
    if (children.length) {
      if (depth + 1 >= MAX_DEPTH) {
        more = '<div class="cm-children"><button type="button" class="cm-link cm-continue" data-act="focus">Continue thread → (' +
          this.countDesc(c.id, kids) + ')</button></div>';
      } else {
        more = '<div class="cm-children">' + children.map(function (k) { return self.nodeHtml(k, depth + 1, kids, sorter); }).join('') + '</div>';
      }
    }
    var hidden = col ? this.countDesc(c.id, kids) : 0;
    return '<article class="cm-c' + (col ? ' cm-collapsed' : '') + (depth ? '' : ' cm-root') + '" data-id="' + esc(c.id) + '" data-depth="' + depth + '">' +
      '<div class="cm-meta"><button type="button" class="cm-tog" data-act="collapse" aria-expanded="' + !col + '" aria-label="' + (col ? 'Expand' : 'Collapse') + ' comment">[' + (col ? '+' : '–') + ']</button> ' + head +
        (col && hidden ? ' <span class="cm-muted">(' + hidden + (hidden === 1 ? ' reply' : ' replies') + ' hidden)</span>' : '') + '</div>' +
      (col ? '' : body + actions + '<div class="cm-slot"></div>' + more) +
    '</article>';
  };

  // Re-open the reply/edit box that was open before a re-render, with its text
  Thread.prototype.restoreOpen = function () {
    var o = this.open;
    if (!o) return;
    var node = this.node(o.id);
    if (!node || node.classList.contains('cm-collapsed')) return;
    this.openBox(o.kind, o.id, node, true);
  };

  Thread.prototype.node = function (id) {
    return this.list.querySelector('.cm-c[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
  };

  Thread.prototype.openBox = function (kind, id, node, quiet) {
    var slot = node.querySelector(':scope > .cm-slot');
    if (!slot) return;
    this.open = { kind: kind, id: id };
    var c = this.rows[id];
    if (kind === 'reply') {
      slot.innerHTML = this.formHtml('r-' + id, id, sget('cm_name') || '');
    } else if (kind === 'edit') {
      var d = this.drafts['e-' + id];
      slot.innerHTML = '<form class="cm-form cm-editform" data-key="e-' + id + '" data-edit="' + esc(id) + '" novalidate>' +
        '<label class="cm-lbl" for="cm-e-' + esc(id) + '">Edit comment</label>' +
        '<textarea class="cm-in cm-ta" id="cm-e-' + esc(id) + '" name="body" maxlength="4000" rows="4">' + esc(d && d.body != null ? d.body : c.body) + '</textarea>' +
        '<div class="cm-formfoot"><button type="submit" class="cm-btn cm-primary">Save</button>' +
        '<button type="button" class="cm-btn cm-ghost" data-act="cancel">Cancel</button></div>' +
        '<p class="cm-err" role="alert" hidden></p></form>';
    } else if (kind === 'delete' || kind === 'report') {
      slot.innerHTML = '<div class="cm-confirm" role="group" aria-label="Confirm">' +
        '<span>' + (kind === 'delete' ? 'Delete this comment?' : 'Report this comment to the moderators?') + '</span>' +
        '<button type="button" class="cm-btn cm-primary" data-act="' + (kind === 'delete' ? 'do-delete' : 'do-report') + '">' + (kind === 'delete' ? 'Delete' : 'Report') + '</button>' +
        '<button type="button" class="cm-btn cm-ghost" data-act="cancel">Cancel</button>' +
        '<p class="cm-err" role="alert" hidden></p></div>';
    }
    if (!quiet) {
      var f = slot.querySelector('textarea, .cm-primary');
      if (f) { try { f.focus({ preventScroll: false }); } catch (e) { f.focus(); } }
    }
  };

  Thread.prototype.closeBox = function () {
    if (!this.open) return;
    var n = this.node(this.open.id);
    if (n) { var s = n.querySelector(':scope > .cm-slot'); if (s) s.innerHTML = ''; }
    this.open = null;
  };

  /* events */
  Thread.prototype.onInput = function (e) {
    var f = e.target.form;
    if (!f || !f.getAttribute('data-key')) return;
    var k = f.getAttribute('data-key'), d = this.drafts[k] = this.drafts[k] || {};
    if (e.target.name === 'name') d.name = e.target.value;
    if (e.target.name === 'body') d.body = e.target.value;
    if (e.target.name === 'code') d.team = e.target.value;
  };

  Thread.prototype.onClick = function (e) {
    var img = e.target.closest('.cm-img');
    if (img) { lightbox(img.getAttribute('data-full')); return; }
    var b = e.target.closest('[data-act], [data-sort], .cm-shownew');
    if (!b || !this.el.contains(b)) return;
    var self = this;
    if (b.hasAttribute('data-sort')) {
      this.sort = b.getAttribute('data-sort'); sset('cm_sort', this.sort); this.markSort(); this.render(); return;
    }
    if (b.classList.contains('cm-shownew')) {
      this.pending.forEach(function (r) { self.rows[r.id] = r; });
      this.pending = []; this.showBar(); this.render(); return;
    }
    var act = b.getAttribute('data-act'), node = b.closest('.cm-c'), id = node && node.getAttribute('data-id');
    switch (act) {
      case 'retry': this.load(); break;
      case 'team': {
        var form = b.closest('form'), row = form.querySelector('.cm-team');
        row.hidden = false; b.hidden = true; row.querySelector('input').focus();
        var k = form.getAttribute('data-key'); (this.drafts[k] = this.drafts[k] || {}).team = '';
        break;
      }
      case 'collapse': this.collapsed[id] = !this.collapsed[id]; this.render(); break;
      case 'focus': this.focus = id; this.render(); this.el.scrollIntoView({ block: 'start' }); break;
      case 'unfocus': this.focus = null; this.render(); break;
      case 'reply': case 'edit': case 'delete': case 'report':
        if (this.open && this.open.id === id && this.open.kind === act) { this.closeBox(); break; }
        this.closeBox(); this.openBox(act, id, node); break;
      case 'cancel': this.closeBox(); break;
      case 'like': this.like(id, b); break;
      case 'do-report': this.report(id, b); break;
      case 'do-delete': this.remove(id, b); break;
    }
  };

  function showErr(container, text) {
    var p = container.querySelector('.cm-err');
    if (p) { p.textContent = text; p.hidden = !text; }
  }
  function busy(btn, on) { if (btn) { btn.disabled = on; btn.classList.toggle('cm-busy', on); } }

  Thread.prototype.onSubmit = function (form) {
    if (form.getAttribute('data-edit')) return this.saveEdit(form);
    var self = this, key = form.getAttribute('data-key'), parent = form.getAttribute('data-parent') || null;
    var name = form.elements.name.value.trim(), body = form.elements.body.value.trim();
    var code = form.elements.code ? form.elements.code.value.trim() : '';
    if (!name) { showErr(form, 'Please enter your name.'); form.elements.name.focus(); return; }
    if (!body) { showErr(form, 'Please write a comment.'); form.elements.body.focus(); return; }
    if ((body.match(/https?:\/\//gi) || []).length > 3) { showErr(form, MESSAGES.TOO_MANY_LINKS); return; }
    showErr(form, '');
    var btn = form.querySelector('button[type=submit]');
    busy(btn, true);
    rpc('post_comment', {
      p_page: this.page, p_parent_id: parent, p_name: name, p_body: body,
      p_admin_code: code || null, p_honeypot: form.elements.website.value || null
    }).then(function (r) {
      sset('cm_name', name);
      saveToken(r.id, r.edit_token, new Date(r.created_at).getTime() || Date.now());
      self.rows[r.id] = { id: r.id, page: self.page, parent_id: parent, name: r.name, body: r.body,
        created_at: r.created_at, edited_at: null, likes: 0, is_team: !!r.is_team };
      self.pending = self.pending.filter(function (p) { return p.id !== r.id; });
      self.showBar();
      delete self.drafts[key];
      if (parent) { self.open = null; self.collapsed[parent] = false; }
      else { form.elements.body.value = ''; if (form.elements.code) form.elements.code.value = ''; }
      self.render();
      var n = self.node(r.id);
      if (n) { n.classList.add('cm-fresh'); if (parent) n.scrollIntoView({ block: 'nearest' }); }
    }).catch(function (e) {
      showErr(form, msg(e));
    }).then(function () { busy(btn, false); });
  };

  Thread.prototype.saveEdit = function (form) {
    var self = this, id = form.getAttribute('data-edit'), body = form.elements.body.value.trim();
    var tok = tokens()[id];
    if (!body) { showErr(form, 'Please write a comment.'); return; }
    if (!tok) { showErr(form, MESSAGES.TOO_LATE); return; }
    var btn = form.querySelector('button[type=submit]');
    busy(btn, true);
    rpc('edit_comment', { p_id: id, p_edit_token: tok.t, p_body: body }).then(function (r) {
      self.rows[id].body = r.body; self.rows[id].edited_at = r.edited_at;
      delete self.drafts['e-' + id]; self.open = null; self.render();
    }).catch(function (e) { showErr(form, msg(e)); busy(btn, false); });
  };

  Thread.prototype.remove = function (id, btn) {
    var self = this, tok = tokens()[id], box = btn.closest('.cm-confirm');
    if (!tok) { showErr(box, MESSAGES.TOO_LATE); return; }
    busy(btn, true);
    rpc('delete_comment', { p_id: id, p_edit_token: tok.t }).then(function (r) {
      dropToken(id); self.open = null;
      if (r.mode === 'soft') { self.rows[id].name = '[deleted]'; self.rows[id].body = '[deleted]'; self.rows[id].is_team = false; }
      else delete self.rows[id];
      self.render();
    }).catch(function (e) { showErr(box, msg(e)); busy(btn, false); });
  };

  Thread.prototype.like = function (id, btn) {
    var self = this, c = this.rows[id];
    if (!c || btn.disabled) return;
    var was = btn.classList.contains('on'), n = btn.querySelector('.cm-n');
    // optimistic, corrected by the server's answer
    btn.classList.toggle('on', !was); btn.setAttribute('aria-pressed', String(!was));
    n.textContent = Math.max(0, (c.likes || 0) + (was ? -1 : 1));
    btn.disabled = true;
    rpc('like_comment', { p_id: id, p_voter_id: voterId() }).then(function (r) {
      c.likes = r.likes; setId('cm_liked', id, r.liked);
      btn.classList.toggle('on', r.liked); btn.setAttribute('aria-pressed', String(r.liked)); n.textContent = r.likes;
    }).catch(function (e) {
      btn.classList.toggle('on', was); btn.setAttribute('aria-pressed', String(was)); n.textContent = c.likes || 0;
      flash(btn, msg(e));
    }).then(function () { btn.disabled = false; });
  };

  Thread.prototype.report = function (id, btn) {
    var self = this, box = btn.closest('.cm-confirm');
    busy(btn, true);
    rpc('report_comment', { p_id: id, p_voter_id: voterId() }).then(function (r) {
      setId('cm_reported', id, true); self.open = null;
      if (r.hidden) delete self.rows[id];
      self.render();
      var n = self.node(id);
      if (n) flash(n.querySelector('.cm-actions') || n, 'Thanks. The moderators will take a look.');
    }).catch(function (e) { showErr(box, msg(e)); busy(btn, false); });
  };

  // Short message under an element, for actions without a form
  function flash(el, text) {
    var host = el.closest('.cm-c') || el, old = host.querySelector(':scope > .cm-flash');
    if (old) old.remove();
    var p = document.createElement('p');
    p.className = 'cm-flash'; p.setAttribute('role', 'status'); p.textContent = text;
    var anchor = host.querySelector(':scope > .cm-actions') || el;
    anchor.insertAdjacentElement('afterend', p);
    setTimeout(function () { p.remove(); }, 6000);
  }

  /* full-size image */
  function lightbox(url) {
    var box = document.createElement('div');
    box.className = 'cm-lightbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Image, full size');
    box.innerHTML = '<button type="button" class="cm-lb-close" aria-label="Close">×</button>' +
      '<img src="' + esc(url) + '" alt="Image shared in comment, full size" referrerpolicy="no-referrer">' +
      '<a class="cm-lb-open" href="' + esc(url) + '" target="_blank" rel="nofollow ugc noopener">Open original ↗</a>';
    function close() { box.remove(); document.removeEventListener('keydown', key); }
    function key(e) { if (e.key === 'Escape') close(); }
    box.addEventListener('click', function (e) { if (!e.target.closest('.cm-lb-open')) close(); });
    document.addEventListener('keydown', key);
    document.body.appendChild(box);
    box.querySelector('.cm-lb-close').focus();
  }

  /* start each thread when it comes into view */
  var threads = [];
  function start(el) {
    if (el._cm) return;
    var t = el._cm = new Thread(el);
    threads.push(t);
    t.load();
  }
  function init() {
    var els = document.querySelectorAll('[data-comments]');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) { els.forEach(start); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); start(en.target); } });
    }, { rootMargin: '400px 0px' });
    els.forEach(function (el) { io.observe(el); });
  }
  // keep "5 min ago" and the 15-minute Edit/Delete buttons current
  setInterval(function () {
    threads.forEach(function (t) {
      if (t.rows && !t.el.querySelector('.cm-form:focus-within')) t.render();
      else if (t.rows) t.el.querySelectorAll('time[datetime]').forEach(function (x) { x.textContent = ago(x.getAttribute('datetime')); });
    });
  }, 60000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // for tests
  window.ObserverComments = { renderBody: renderBody, ago: ago };
})();
