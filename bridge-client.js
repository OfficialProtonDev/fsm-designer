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

  // Identifies this tab's writes so the poll can tell them apart from someone
  // else's. Without it a tab receives its own edit back and reloads the canvas
  // underneath the person drawing on it.
  var me = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);

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

  /*
   * Pairing with a server this tab was never told about.
   *
   * Someone who has been drawing for an hour should not have to open a fresh
   * link and hope their work survives. Instead the page can ask a local server
   * for the token itself -- but only once the person has said they want that,
   * because an unsolicited request to localhost on every visit is not
   * something to inflict on a stranger reading the site.
   *
   * The consent is a flag in localStorage, so it is remembered per browser and
   * per origin: opting in here never speaks for anyone else.
   */
  var PAIR_KEY = 'fsm-bridge-autopair';
  var DEFAULT_PORT = 4319;

  function optedIn() {
    try { return JSON.parse(localStorage.getItem(PAIR_KEY) || 'null'); } catch (e) { return null; }
  }

  function pair(port) {
    var base = 'http://localhost:' + (port || DEFAULT_PORT);
    return fetch(base + '/api/pair')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.token) return null;
        return { base: base, token: data.token };
      })
      .catch(function () { return null; });
  }

  function connectButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'bridge-connect';
    b.textContent = 'Connect to Claude';
    b.title = 'Link this diagram to a Claude session running on this computer';
    var bar = document.getElementById('toolbar');
    if (bar) bar.appendChild(b); else document.body.appendChild(b);

    b.addEventListener('click', function () {
      b.disabled = true;
      b.textContent = 'Connecting…';
      pair(DEFAULT_PORT).then(function (found) {
        if (!found) {
          b.disabled = false;
          b.textContent = 'Connect to Claude';
          flash('No Claude session found on this computer. Ask it to run open_designer.', true);
          return;
        }
        try {
          localStorage.setItem(PAIR_KEY, JSON.stringify({ port: DEFAULT_PORT }));
        } catch (e) {}
        b.remove();
        start(remember(found));
      });
    });
  }

  var link = null;
  var found = findLink();

  if (!found) {
    // No credentials were handed to us. If this browser has opted in, look for
    // a server; otherwise just offer the button and stay quiet.
    var choice = optedIn();
    if (choice) {
      pair(choice.port).then(function (found) {
        if (found) start(remember(found));
        else connectButton();
      });
    } else {
      connectButton();
    }
    return;
  }

  start(found);

  function start(chosen) {
    link = chosen;
    connect();
  }

  function api(path, options) {
    var opts = options || {};
    opts.headers = opts.headers || {};
    opts.headers.Authorization = 'Bearer ' + link.token;
    return fetch(link.base + path, opts);
  }

  /*
   * The indicator in the corner.
   *
   * There are two kinds of thing to say and they need different lifetimes. A
   * standing condition -- linked, or trying to get back -- has to persist, or
   * a page that has quietly lost its server looks exactly like one that is
   * fine. Passing news, like an edit arriving, should show briefly and then
   * give the standing condition back rather than leaving the corner blank.
   */
  var TONES = {
    live:  { border: '#cfe0ff', background: '#eef4ff', color: '#1a56db' },
    trying:{ border: '#f5dfb0', background: '#fdf6e7', color: '#8a5a00' },
    lost:  { border: '#f0cccc', background: '#fdeeee', color: '#a12c2c' }
  };
  var baseline = null;      // { text, tone } or null when unconnected

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

  function paint(text, tone) {
    var node = el();
    var colours = TONES[tone] || TONES.live;
    node.textContent = text;
    node.style.borderColor = colours.border;
    node.style.background = colours.background;
    node.style.color = colours.color;
    node.style.opacity = '1';
  }

  // A standing condition. Stays until something replaces it.
  function settle(text, tone) {
    baseline = { text: text, tone: tone };
    clearTimeout(flash.timer);
    paint(text, tone);
  }

  // Passing news. Shows, then hands the corner back to the standing condition.
  function flash(text, sticky) {
    paint(text, sticky ? 'lost' : (baseline ? baseline.tone : 'live'));
    clearTimeout(flash.timer);
    if (sticky) { baseline = { text: text, tone: 'lost' }; return; }
    flash.timer = setTimeout(function () {
      if (baseline) paint(baseline.text, baseline.tone);
      else el().style.opacity = '0';
    }, 2200);
  }

  function push() {
    if (applying) return;
    if (pushing) { pendingPush = true; return; }
    pushing = true;
    api('/api/machine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: window.fsmDesigner.getDoc(), client: me })
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
      .then(function (r) {
        // Without this the loop spins: a 403 parses fine, matches none of the
        // branches below, and re-polls immediately, forever.
        if (r.status === 403) throw new Error('stale');
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (data) {
        // Only a real answer counts as being connected. A 403 is a perfectly
        // successful HTTP response saying we are *not* welcome, and treating
        // it as healthy is how a page ends up cheerfully claiming a link it
        // does not have.
        if (baseline && baseline.tone !== 'live') settle('Connected to Claude', 'live');

        if (data && data.changed && data.client && data.client === me) {
          version = data.version;
          poll();
          return;
        }

        if (data && data.changed && data.doc) {
          version = data.version;
          var fromClaude = data.updatedBy === 'claude';
          applying = true;
          try {
            // Refit only for a machine Claude produced, which may arrive
            // anywhere on the canvas. Another tab's edit is someone working at
            // human scale, so leave their viewport where they put it.
            window.fsmDesigner.setDoc(data.doc, !fromClaude);
            flash(fromClaude ? 'Updated by Claude' : 'Updated in another tab');
          } finally {
            applying = false;
          }
        } else if (data && data.version) {
          version = Math.max(version, data.version);
        }
        poll();
      })
      .catch(function (err) {
        /*
         * A stale token means the server restarted and minted a new one. If
         * this browser has already agreed to pair, that is nothing the person
         * needs to hear about -- ask for the new token and carry on. Anything
         * else is the server being unreachable, which is worth showing,
         * because a silent corner is indistinguishable from a healthy link.
         */
        if (err && err.message === 'stale' && optedIn()) {
          settle('Reconnecting to Claude…', 'trying');
          pair(optedIn().port).then(function (fresh) {
            if (fresh) {
              link = remember(fresh);
              version = 0;         // the new server's numbering is its own
              settle('Connected to Claude', 'live');
              poll();
            } else {
              setTimeout(poll, 3000);
            }
          });
          return;
        }

        if (err && err.message === 'stale') {
          try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
          settle('This link has expired. Run open_designer again for a new one.', 'lost');
          return;                  // stop polling; nothing here will start working
        }

        settle('Reconnecting to Claude…', 'trying');
        setTimeout(poll, 3000);
      });
  }

  // Pick up whatever the server already has before listening for edits, so a
  // fresh tab shows the machine Claude is talking about.
  function connect() {
    api('/api/machine')
      .then(function (r) {
        if (r.status === 403) throw new Error('stale');
        return r.json();
      })
      .then(function (data) {
        version = data.version || 0;

        /*
         * Who wins when both sides have a diagram.
         *
         * The tab does, unless the server's copy is live -- meaning something
         * touched it this session, so Claude is mid-conversation about it. A
         * document merely restored from disk is last session's leftovers, and
         * losing an afternoon's drawing to it is the worse mistake by far.
         */
        var serverHas = data.doc && data.doc.nodes && data.doc.nodes.length;
        var tabHas = !window.fsmDesigner.isEmpty();
        var serverWins = serverHas && (!data.stale || !tabHas);

        if (serverWins) {
          applying = true;
          try { window.fsmDesigner.setDoc(data.doc, false); } finally { applying = false; }
        } else if (tabHas) {
          push();     // this tab's work is the real one: hand it over
        }
        window.fsmDesigner.onChange = push;
        settle('Connected to Claude', 'live');
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
  }
})();
