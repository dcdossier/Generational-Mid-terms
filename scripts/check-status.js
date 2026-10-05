#!/usr/bin/env node
'use strict';

/**
 * check-status.js — fails the workflow when a primary source has been failing
 * for more than 48 hours, so GitHub sends a failure email.
 *
 * Usage: node scripts/check-status.js <group> [<group> …]   e.g. polls analysis
 *
 * Prints a summary of every source in the given groups; exits 1 if any primary
 * source has failing_since older than the threshold.
 */

const fs = require('fs');
const { STATUS_PATH } = require('./status');

const MAX_FAILING_HOURS = 48;

const groups = process.argv.slice(2);
if (!groups.length) {
  console.error('Usage: node scripts/check-status.js <group> [<group> …]');
  process.exit(2);
}

let sources;
try { sources = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')).sources || {}; }
catch (err) {
  console.error(`::error::Could not read status.json: ${err.message}`);
  process.exit(1);
}

const now = Date.now();
const hoursSince = iso => iso ? (now - new Date(iso).getTime()) / 36e5 : null;
const entries = Object.entries(sources).filter(([, s]) => groups.includes(s.group));

const failing = entries.filter(([, s]) => s.failing_since);
console.log(`[check-status] ${entries.length} sources in ${groups.join(', ')}: ${entries.length - failing.length} OK, ${failing.length} failing on their last attempt`);
for (const [name, s] of failing) {
  const h = hoursSince(s.failing_since).toFixed(1);
  console.log(`  ${s.primary ? 'PRIMARY ' : ''}${name}: failing for ${h}h — ${s.error}`);
}

const stale = failing.filter(([, s]) => s.primary && hoursSince(s.failing_since) > MAX_FAILING_HOURS);
if (stale.length) {
  for (const [name, s] of stale) {
    const last = s.last_success ? `last success ${s.last_success}` : 'never succeeded';
    console.log(`::error title=${name} failing for over ${MAX_FAILING_HOURS}h::${s.error} (${last})`);
  }
  process.exit(1);
}
console.log(`[check-status] No primary source has been failing for more than ${MAX_FAILING_HOURS}h.`);
