'use strict';

/**
 * status.js — per-source health record shared by the fetch scripts.
 *
 * status.json holds one entry per source:
 *   { group, primary, last_attempt, last_success, item_count, error, failing_since }
 *
 * A run only counts as a success if it returned at least one item. Failures and
 * empty results update last_attempt/error but never overwrite last_success or
 * item_count, so the last good values survive.
 */

const fs   = require('fs');
const path = require('path');

const STATUS_PATH = path.resolve(__dirname, '../status.json');

let state = null;

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); }
  catch { state = {}; }
  state.sources = state.sources || {};
  return state;
}

/**
 * @param {string} name   source name, e.g. 'NYT polling CSVs'
 * @param {{group: string, primary?: boolean, ok: boolean, count?: number|null, error?: string|null}} result
 */
function recordStatus(name, { group, primary = false, ok, count = null, error = null }) {
  const sources = load().sources;
  const prev = sources[name] || {};
  const now = new Date().toISOString();
  const success = ok && typeof count === 'number' && count > 0;

  const entry = {
    group,
    primary,
    last_attempt: now,
    last_success: prev.last_success || null,
    item_count: prev.item_count ?? null,
    error: null,
    failing_since: null,
  };
  if (success) {
    entry.last_success = now;
    entry.item_count = count;
  } else {
    entry.error = error || (ok ? 'returned 0 items' : 'failed');
    entry.failing_since = prev.failing_since || now;
  }
  sources[name] = entry;
}

function saveStatus() {
  const s = load();
  s.updated = new Date().toISOString();
  s.sources = Object.fromEntries(Object.entries(s.sources).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(STATUS_PATH, JSON.stringify(s, null, 2) + '\n');
}

module.exports = { recordStatus, saveStatus, STATUS_PATH };
