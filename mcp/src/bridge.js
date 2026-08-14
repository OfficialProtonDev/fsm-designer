'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');

/*
 * The live link between the designer in a browser and this server.
 *
 * The app is served from here rather than pointed at from the hosted copy on
 * purpose: a page on https://…github.io cannot call http://localhost, because
 * browsers block mixed content. Serving the very same files locally makes the
 * page and the sync endpoint the same origin, and the problem disappears.
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

let server = null;
let actualPort = null;
const waiters = [];   // long-poll clients waiting for a change

function notify() {
  const current = store.get();
  while (waiters.length) {
    const w = waiters.pop();
    clearTimeout(w.timer);
    respondJson(w.res, 200, { version: current.version, doc: current.doc, changed: true });
  }
}

function respondJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(text);
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
    // The designer's own page knows nothing about this server; the sync client
    // is injected here so the published copy stays a plain static site.
    if (rel === 'index.html') {
      body = Buffer.from(buf.toString('utf8').replace(
        '</body>', '<script src="bridge-client.js"></script>\n</body>'), 'utf8');
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

  if (route === '/api/hello') {
    respondJson(res, 200, { ok: true, name: 'fsm-designer-mcp', version: store.get().version });
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
  if (server) return Promise.resolve({ port: actualPort, alreadyRunning: true });
  return new Promise((resolve, reject) => {
    server = http.createServer(handle);
    server.on('error', err => {
      server = null;
      reject(err);
    });
    server.listen(port || 4319, '127.0.0.1', () => {
      actualPort = server.address().port;
      resolve({ port: actualPort, alreadyRunning: false });
    });
  });
}

function stop() {
  if (!server) return;
  for (const w of waiters.splice(0)) { clearTimeout(w.timer); try { w.res.end(); } catch (e) {} }
  server.close();
  server = null;
  actualPort = null;
}

function status() {
  return { running: !!server, port: actualPort, url: actualPort ? `http://localhost:${actualPort}/` : null };
}

// Called after a tool changes the document, so an open designer picks it up.
function pushed() { notify(); }

module.exports = { start, stop, status, pushed };
