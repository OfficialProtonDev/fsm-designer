/*
 * Keeps the designer in step with a local fsm-designer MCP server.
 *
 * This file is only ever loaded when the page is being served *by* that
 * server, which injects the script tag. The published copy on GitHub Pages
 * never sees it, so the site stays a plain static page with no idea any of
 * this exists.
 *
 * The rule for resolving a clash is deliberately blunt: whoever wrote last
 * wins. A diagram is one person's working document, not a shared one, and the
 * alternative -- merging two drawings -- has no sensible answer.
 */
(function () {
  'use strict';

  if (!window.fsmDesigner) return;

  var version = 0;
  var pushing = false;
  var pendingPush = null;
  var applying = false;      // guards against echoing a change we just received
  var status = null;

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
    fetch('/api/machine', {
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
    fetch('/api/poll?since=' + version)
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
  fetch('/api/machine')
    .then(function (r) { return r.json(); })
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
    .catch(function () { /* not served by the bridge after all */ });
})();
