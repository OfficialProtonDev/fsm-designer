/*
 * Keeps the designer in step with a local fsm-designer MCP server.
 *
 * The page ships with this file whether or not a server is involved, so the
 * published copy can connect too. Finding no credentials it does nothing at
 * all, and the site stays the plain static page it has always been.
 *
 * Credentials arrive one of two ways. Served locally, the server injects
 * window.__fsmBridge before this script runs. Loaded from the published site,
 * they come in the URL fragment as #bridge=port.token, put there by
 * open_designer; the fragment never reaches GitHub's servers. Either way they
 * go to sessionStorage so a reload does not drop the link, and the fragment is
 * wiped from the address bar so the token is not sitting in a URL the user
 * might copy to someone.
 *
 * The rule for resolving a clash is deliberately blunt: whoever wrote last
 * wins. A diagram is one person's working document, not a shared one, and the
 * alternative -- merging two drawings -- has no sensible answer.
 */
(function () {
  'use strict';

  if (!window.fsmDesigner) return;

  var STORE_KEY = 'fsm-bridge';

  var version = 0;
  var pushing = false;
  var pendingPush = null;
  var applying = false;      // guards against echoing a change we just received
  var status = null;

  function remember(link) {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(link)); } catch (e) {}
    return link;
  }

  // Local injection first, then a fresh fragment, then whatever this tab was
  // using before a reload.
  function findLink() {
    if (window.__fsmBridge && window.__fsmBridge.token) {
      return { base: '', token: window.__fsmBridge.token };
    }

    var match = /[#&]bridge=(\d+)\.([a-f0-9]+)/i.exec(window.location.hash || '');
    if (match) {
      var link = { base: 'http://localhost:' + match[1], token: match[2] };
      var clean = window.location.hash.replace(match[0], '').replace(/^[#&]+/, '');
      try {
        history.replaceState(null, '',
          window.location.pathname + window.location.search + (clean ? '#' + clean : ''));
      } catch (e) {}
      return remember(link);
    }

    try {
      var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      if (saved && saved.token && typeof saved.base === 'string') return saved;
    } catch (e) {}

    return null;
  }

  var link = findLink();
  if (!link) return;         // an ordinary visit to the static site

  function api(path, options) {
    var opts = options || {};
    opts.headers = opts.headers || {};
    opts.headers.Authorization = 'Bearer ' + link.token;
    return fetch(link.base + path, opts);
  }

  function el() {
    if (status) return status;
    status = document.createElement('div');
    status.id = 'bridge-status';
    status.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'z-index:50',
      'font:12px "Helvetica Neue",Helvetica,Arial,sans-serif',
      'padding:6px 11px', 'border-radius:14px', 'border:1px solid #cfe0ff',
      'background:#eef4ff', 'color:#1a56db', 'pointer-events:none',
      'transition:opacity .3s', 'opacity:0'
    ].join(';');
    document.body.appendChild(status);
    return status;
  }

  function flash(text, sticky) {
    var node = el();
    node.textContent = text;
    node.style.opacity = '1';
    clearTimeout(flash.timer);
    if (!sticky) flash.timer = setTimeout(function () { node.style.opacity = '0'; }, 2200);
  }

  function push() {
    if (applying) return;
    if (pushing) { pendingPush = true; return; }
    pushing = true;
    api('/api/machine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: window.fsmDesigner.getDoc() })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.version) version = data.version;
    }).catch(function () { /* server went away; polling will notice */ })
      .then(function () {
        pushing = false;
        if (pendingPush) { pendingPush = false; push(); }
      });
  }

  function poll() {
    api('/api/poll?since=' + version)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.changed && data.doc) {
          version = data.version;
          applying = true;
          try {
            window.fsmDesigner.setDoc(data.doc, false);
            flash('Updated by Claude');
          } finally {
            applying = false;
          }
        } else if (data && data.version) {
          version = Math.max(version, data.version);
        }
        poll();
      })
      .catch(function () {
        flash('Disconnected from the local server', true);
        setTimeout(poll, 3000);
      });
  }

  // Pick up whatever the server already has before listening for edits, so a
  // fresh tab shows the machine Claude is talking about.
  api('/api/machine')
    .then(function (r) {
      if (r.status === 403) throw new Error('stale');
      return r.json();
    })
    .then(function (data) {
      version = data.version || 0;
      var hasServerDoc = data.doc && data.doc.nodes && data.doc.nodes.length;
      if (hasServerDoc) {
        applying = true;
        try { window.fsmDesigner.setDoc(data.doc, false); } finally { applying = false; }
      } else if (!window.fsmDesigner.isEmpty()) {
        push();     // server is empty but this tab has work: hand it over
      }
      window.fsmDesigner.onChange = push;
      flash('Connected to Claude');
      poll();
    })
    .catch(function (err) {
      // We were handed credentials, so silence here would be the wrong
      // answer -- an empty canvas that looks like it synced is exactly the
      // confusion this is meant to end.
      try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}

      if (err && err.message === 'stale') {
        flash('This link has expired. Run open_designer again for a new one.', true);
        return;
      }
      if (link.base) {
        // Cross-origin and it did not get through. Whether the server is down
        // or the browser refused to let a public page touch localhost is not
        // something the page can tell from here, and either way the local URL
        // is the way out.
        flash('Could not reach the local server. Open ' + link.base + '/ directly.', true);
        return;
      }
      flash('Disconnected from the local server', true);
    });
})();
