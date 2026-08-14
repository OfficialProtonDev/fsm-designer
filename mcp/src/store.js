'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * The shared document.
 *
 * One machine is "current" at a time -- the one the user is looking at in the
 * designer and the one the tools default to. It is held in memory, mirrored to
 * disk so a restarted server picks up where it left off, and stamped with a
 * version so the browser can tell whether what it has is stale.
 */

const DIR = path.join(os.homedir(), '.fsm-designer-mcp');
const FILE = path.join(DIR, 'current.json');

const EMPTY = { nodes: [], links: [] };

let state = {
  version: 1,
  doc: EMPTY,
  updatedBy: 'server',
  updatedAt: new Date().toISOString()
};

const named = new Map();   // scratch machines the tools can refer to by name

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.doc) {
      state = {
        version: parsed.version || 1,
        doc: parsed.doc,
        updatedBy: parsed.updatedBy || 'disk',
        updatedAt: parsed.updatedAt || new Date().toISOString()
      };
    }
    if (parsed && parsed.named) {
      for (const [k, v] of Object.entries(parsed.named)) named.set(k, v);
    }
  } catch (e) { /* first run, or an unreadable file: start empty */ }
}

function persist() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({
      version: state.version,
      doc: state.doc,
      updatedBy: state.updatedBy,
      updatedAt: state.updatedAt,
      named: Object.fromEntries(named)
    }, null, 2));
  } catch (e) { /* disk trouble should never take the server down */ }
}

function get() { return state; }

function set(doc, updatedBy) {
  state = {
    version: state.version + 1,
    doc: doc || EMPTY,
    updatedBy: updatedBy || 'server',
    updatedAt: new Date().toISOString()
  };
  persist();
  return state;
}

function saveNamed(name, doc) {
  named.set(String(name), doc);
  persist();
}

function getNamed(name) {
  return named.get(String(name)) || null;
}

function listNamed() {
  return [...named.keys()];
}

function deleteNamed(name) {
  const had = named.delete(String(name));
  if (had) persist();
  return had;
}

load();

module.exports = { get, set, saveNamed, getNamed, listNamed, deleteNamed, FILE, DIR };
