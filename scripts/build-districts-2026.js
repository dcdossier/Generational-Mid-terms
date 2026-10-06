#!/usr/bin/env node
'use strict';

/**
 * build-districts-2026.js — builds assets/districts2026.geojson.
 *
 * States that redrew their maps for the 2026 elections take their districts
 * from the Census TIGERweb "120th Congressional Districts" layer. Every other
 * state keeps its feature from assets/districts119.geojson unchanged.
 *
 * Output features carry the same properties as the 119 file:
 *   { state: "Texas", district: 22, statefp: "48" }   (at-large = 0)
 * Rings are rewound to d3's convention (exterior clockwise), coordinates are
 * rounded to 3 decimals, as in the 119 file.
 *
 * Usage: node scripts/build-districts-2026.js
 */

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

// FIPS → state name for states using new 2026 maps.
// Missouri (29) is left out on purpose: its 2025 map is blocked for 2026.
const NEW_MAP_STATES = {
  '01': 'Alabama', '06': 'California', '12': 'Florida', '22': 'Louisiana',
  '37': 'North Carolina', '39': 'Ohio', '47': 'Tennessee', '48': 'Texas', '49': 'Utah',
};

const OLD_PATH = path.resolve(__dirname, '../assets/districts119.geojson');
const OUT_PATH = path.resolve(__dirname, '../assets/districts2026.geojson');
const TIGERWEB = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/0/query';

const round = n => Math.round(n * 1000) / 1000;

// Signed area > 0 means clockwise in lon/lat (shoelace with y up)
function isClockwise(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  return s > 0;
}

// Round, drop repeated points, and wind exterior clockwise, holes anticlockwise (d3-geo)
function cleanPolygon(rings) {
  return rings.map((ring, i) => {
    const out = [];
    for (const [x, y] of ring) {
      const p = [round(x), round(y)];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0].slice());
    const wantCW = i === 0;
    if (isClockwise(out) !== wantCW) out.reverse();
    return out;
  }).filter(r => r.length >= 4);
}

function cleanGeometry(g) {
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: cleanPolygon(g.coordinates) };
  const polys = g.coordinates.map(cleanPolygon).filter(p => p.length);
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

async function fetchState(fp) {
  const q = new URLSearchParams({
    where: `STATE='${fp}'`, outFields: 'STATE,CD120', returnGeometry: 'true',
    outSR: '4326', maxAllowableOffset: '0.0015', geometryPrecision: '3', f: 'geojson',
  });
  const res = await fetch(`${TIGERWEB}?${q}`, { timeout: 120000 });
  const body = await res.text();
  console.log(`  [fetch] TIGERweb state ${fp}: HTTP ${res.status}, ${Buffer.byteLength(body)} bytes`);
  if (!res.ok) throw new Error(`TIGERweb HTTP ${res.status} for state ${fp}`);
  return JSON.parse(body).features;
}

async function main() {
  const old = JSON.parse(fs.readFileSync(OLD_PATH, 'utf8'));
  const features = old.features.filter(f => !NEW_MAP_STATES[f.properties.statefp]);
  console.log(`[districts] ${features.length} districts kept from the 119 file`);

  for (const [fp, name] of Object.entries(NEW_MAP_STATES)) {
    const got = await fetchState(fp);
    const before = old.features.filter(f => f.properties.statefp === fp).length;
    const valid = got.filter(f => /^\d+$/.test(f.properties.CD120));   // skips "ZZ" (no district)
    if (valid.length !== before) throw new Error(`${name}: ${valid.length} districts from TIGERweb, ${before} in the 119 file`);
    for (const f of valid) {
      const d = parseInt(f.properties.CD120, 10);
      features.push({
        type: 'Feature',
        properties: { state: name, district: d === 98 ? 0 : d, statefp: fp },
        geometry: cleanGeometry(f.geometry),
      });
    }
    console.log(`  ${name}: ${valid.length} districts replaced`);
    await new Promise(r => setTimeout(r, 1000));
  }

  features.sort((a, b) => a.properties.statefp.localeCompare(b.properties.statefp) || a.properties.district - b.properties.district);
  fs.writeFileSync(OUT_PATH, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`[districts] Wrote ${features.length} districts, ${fs.statSync(OUT_PATH).size} bytes → ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch(err => { console.error('[districts] Fatal:', err.message); process.exit(1); });
