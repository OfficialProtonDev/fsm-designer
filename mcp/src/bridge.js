'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

/*
 * The live link between the designer in a browser and this server.
 *
 * Two pages can drive it. The local copy served from here is the reliable
 * one: same origin, nothing for a browser to object to. The published copy on
 * GitHub Pages can also connect, given the port and a token, which is what the
 * fragment on the URL from open_designer carries.
 *
 * That second route is at the mercy of browser policy. http://localhost counts
 * as a trustworthy origin so mixed content is not the obstacle it looks like,
 * but Private Network Access rules govern a public page reaching a local
 * server and have been tightening. The preflight below answers what those
 * rules ask for; if a browser refuses anyway, the local URL still works and
 * the client says so rather than sitting there looking empty.
 *
 * The token pairs one browser session with one server. It is not protecting
 * much -- this is a diagram on someone's own machine -- but without it any
 * page in any tab could read and rewrite the canvas, which is a rude surprise
 * rather than a considered trade.
 *
 * Sync is a version number and polling, not a socket. A diagram is small and a
 * person edits it at human speed, so a poll is honest about what it costs and
 * has no reconnection logic to get wrong.
 */

const APP_ROOT = path.join(__dirname, '..', '..');
const APP_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/fsm.js': 'fsm.js',
  '/bridge-client.js': 'bridge-client.js'
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

// Where the published copy lives, for the linked-page URL open_designer hands
// out. Override if the site is deployed somewhere else.
const PUBLIC_URL = process.env.FSM_DESIGNER_PUBLIC_URL ||
  'https://officialprotondev.github.io/fsm-designer/';

let server = null;
let actualPort = null;
let token = null;
const waiters = [];   // long-poll clients waiting for a change

function notify() {
  const current = store.get();
  while (waiters.length) {
    const w = waiters.pop();
    clearTimeout(w.timer);
    respondJson(w.res, 200, { version: current.version, doc: current.doc, changed: true });
  }
}

// Any origin may ask; only a caller holding the token gets an answer. Letting
// the browser cache the preflight matters more than it looks: every long poll
// carries an Authorization header, so without this each one pays for a second
// round trip first.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '7200'
  };
}

function respondJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  }, corsHeaders()));
  res.end(text);
}

function ensureToken() {
  if (!token) token = crypto.randomBytes(24).toString('hex');
  return token;
}

// Bearer header for the browser; ?token= as well, because debugging this with
// curl should not require remembering header syntax.
function authorized(req, url) {
  if (!token) return true;
  const header = String(req.headers['authorization'] || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const given = match ? match[1] : url.searchParams.get('token');
  return given === token;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 4e6) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveFile(res, rel) {
  const full = path.join(APP_ROOT, rel);
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + rel);
      return;
    }
    let body = buf;
    // The page carries the sync client itself now, since the published copy
    // needs it too. What it cannot carry is the token, so that gets injected
    // ahead of the script that reads it. The local page then authenticates
    // exactly like the remote one, leaving a single path to get wrong.
    if (rel === 'index.html') {
      body = Buffer.from(buf.toString('utf8').replace(
        '<script src="bridge-client.js"></script>',
        `<script>window.__fsmBridge={token:"${ensureToken()}"};</script>\n` +
        '<script src="bridge-client.js"></script>'), 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  });
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (req.method === 'OPTIONS') { respondJson(res, 204, {}); return; }

  // Deliberately open: the linked page probes this to tell "server is not
  // there" apart from "browser blocked the request", and the two need
  // different advice. It reveals only that the server is running.
  if (route === '/api/hello') {
    respondJson(res, 200, { ok: true, name: 'fsm-designer-mcp', version: store.get().version });
    return;
  }

  if (route.startsWith('/api/') && !authorized(req, url)) {
    respondJson(res, 403, { error: 'bad or missing token' });
    return;
  }

  if (route === '/api/machine' && req.method === 'GET') {
    const s = store.get();
    respondJson(res, 200, { version: s.version, doc: s.doc, updatedBy: s.updatedBy });
    return;
  }

  if (route === '/api/machine' && req.method === 'POST') {
    readBody(req).then(text => {
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) {
        respondJson(res, 400, { error: 'invalid JSON' });
        return;
      }
      const doc = parsed && parsed.doc ? parsed.doc : parsed;
      const s = store.set(doc, 'designer');
      respondJson(res, 200, { version: s.version, ok: true });
      notify();
    }).catch(() => respondJson(res, 400, { error: 'bad request' }));
    return;
  }

  // Long poll: hold the request open until the document moves past `since`.
  if (route === '/api/poll' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const s = store.get();
    if (s.version > since) {
      respondJson(res, 200, { version: s.version, doc: s.doc, changed: true });
      return;
    }
    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      respondJson(res, 200, { version: store.get().version, changed: false });
    }, 25000);
    waiters.push(waiter);
    req.on('close', () => {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) { clearTimeout(waiter.timer); waiters.splice(idx, 1); }
    });
    return;
  }

  const file = APP_FILES[route];
  if (file) { serveFile(res, file); return; }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function start(port) {
  if (server) {
    return Promise.resolve({ port: actualPort, token: ensureToken(), alreadyRunning: true });
  }
  return new Promise((resolve, reject) => {
    server = http.createServer(handle);
    server.on('error', err => {
      server = null;
      reject(err);
    });
    server.listen(port || 4319, '127.0.0.1', () => {
      actualPort = server.address().port;
      resolve({ port: actualPort, token: ensureToken(), alreadyRunning: false });
    });
  });
}

function stop() {
  if (!server) return;
  for (const w of waiters.splice(0)) { clearTimeout(w.timer); try { w.res.end(); } catch (e) {} }
  server.close();
  server = null;
  actualPort = null;
  token = null;      // a restart mints a new one, retiring any link already handed out
}

// The token rides in the fragment, which browsers never send to the server the
// page came from: GitHub gets no chance to see it, and it stays out of referrer
// headers and access logs.
function linkedUrl() {
  if (!actualPort || !token) return null;
  const sep = PUBLIC_URL.includes('#') ? '&' : '#';
  return `${PUBLIC_URL}${sep}bridge=${actualPort}.${token}`;
}

function status() {
  return {
    running: !!server,
    port: actualPort,
    token,
    url: actualPort ? `http://localhost:${actualPort}/` : null,
    linkedUrl: linkedUrl()
  };
}

// Called after a tool changes the document, so an open designer picks it up.
function pushed() { notify(); }

module.exports = { start, stop, status, pushed };
