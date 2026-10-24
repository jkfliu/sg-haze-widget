// Shared test helpers. Not a test file: the npm scripts only pass test/*.test.js to node --test.

const fs = require('node:fs');
const path = require('node:path');

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

// Epoch ms for a Singapore wall-clock time, e.g. sgt('2026-10-24T15:00:00').
const sgt = (iso) => new Date(`${iso}+08:00`).getTime();

// Seeded PRNG for property tests (no fast-check: the plan forbids dependencies).
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { fixture, sgt, mulberry32 };
