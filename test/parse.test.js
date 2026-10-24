const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normaliseRegion, parsePm25Series, parseLatestPsi } = require('../src/core.js');

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const sgt = (iso) => new Date(`${iso}+08:00`).getTime();
const REGIONS = ['north', 'south', 'east', 'west', 'central'];

describe('normaliseRegion', () => {
  test('returns each known region unchanged', () => {
    for (const r of REGIONS) assert.equal(normaliseRegion(r), r);
  });

  test('is case-insensitive and trims spaces', () => {
    assert.equal(normaliseRegion('NORTH'), 'north');
    assert.equal(normaliseRegion('  East  '), 'east');
    assert.equal(normaliseRegion('\tWest\n'), 'west');
  });

  test('falls back to central for empty or missing input', () => {
    assert.equal(normaliseRegion(''), 'central');
    assert.equal(normaliseRegion('   '), 'central');
    assert.equal(normaliseRegion(null), 'central');
    assert.equal(normaliseRegion(undefined), 'central');
  });

  test('falls back to central for unknown or non-string input', () => {
    assert.equal(normaliseRegion('nort'), 'central');
    assert.equal(normaliseRegion('national'), 'central'); // not reported by the API
    assert.equal(normaliseRegion(42), 'central');
    assert.equal(normaliseRegion({}), 'central');
  });
});

describe('parsePm25Series with real fixtures', () => {
  test('parses a partial day oldest first with epoch-ms times', () => {
    const series = parsePm25Series(fixture('pm25-today.json'), 'central');
    assert.equal(series.length, 16);
    assert.deepEqual(series[0], { time: sgt('2026-10-24T00:00:00'), value: 92 });
    assert.deepEqual(series.at(-1), { time: sgt('2026-10-24T15:00:00'), value: 64 });
  });

  test('parses a full day for another region', () => {
    const series = parsePm25Series(fixture('pm25-yesterday.json'), 'west');
    assert.equal(series.length, 24);
    assert.deepEqual(series.at(-1), { time: sgt('2026-10-23T23:00:00'), value: 137 });
  });

  test('is sorted ascending even though the API lists newest first', () => {
    const times = parsePm25Series(fixture('pm25-yesterday.json'), 'north').map((p) => p.time);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  test('skips missing hours and null readings in the gappy fixture', () => {
    const json = fixture('pm25-gappy.synthetic.json');
    const central = parsePm25Series(json, 'central');
    assert.equal(central.length, 19); // 20 hours present, central null at 10:00
    assert.ok(!central.some((p) => p.time === sgt('2026-10-23T10:00:00')));
    assert.ok(!central.some((p) => p.time === sgt('2026-10-23T03:00:00')));
    assert.equal(parsePm25Series(json, 'east').length, 20);
  });

  test('returns an empty array for the 404 not-found response', () => {
    assert.deepEqual(parsePm25Series(fixture('pm25-not-found.json'), 'central'), []);
  });
});

describe('parsePm25Series with malformed input', () => {
  test('returns an empty array for null, garbage, or missing items', () => {
    for (const json of [null, undefined, 'oops', 42, {}, { data: {} }, { data: { items: null } }]) {
      assert.deepEqual(parsePm25Series(json, 'central'), [], `input: ${JSON.stringify(json)}`);
    }
  });

  test('returns an empty array for a region not in the readings', () => {
    assert.deepEqual(parsePm25Series(fixture('pm25-today.json'), 'national'), []);
  });

  test('skips items with bad timestamps, readings, or values', () => {
    const json = {
      data: {
        items: [
          { timestamp: '2026-10-24T01:00:00+08:00', readings: { pm25_one_hourly: { central: 10 } } },
          { timestamp: 'not a date', readings: { pm25_one_hourly: { central: 11 } } },
          { readings: { pm25_one_hourly: { central: 12 } } },
          { timestamp: '2026-10-24T02:00:00+08:00' },
          { timestamp: '2026-10-24T03:00:00+08:00', readings: { pm25_one_hourly: null } },
          { timestamp: '2026-10-24T04:00:00+08:00', readings: { pm25_one_hourly: { central: '15' } } },
          { timestamp: '2026-10-24T05:00:00+08:00', readings: { pm25_one_hourly: { central: -1 } } },
          { timestamp: '2026-10-24T06:00:00+08:00', readings: { pm25_one_hourly: { central: NaN } } },
          null,
          { timestamp: '2026-10-24T07:00:00+08:00', readings: { pm25_one_hourly: { central: 0 } } },
        ],
      },
    };
    assert.deepEqual(parsePm25Series(json, 'central'), [
      { time: sgt('2026-10-24T01:00:00'), value: 10 },
      { time: sgt('2026-10-24T07:00:00'), value: 0 },
    ]);
  });
});

// Property test with a seeded PRNG (no fast-check: the plan forbids dependencies).
describe('parsePm25Series properties', () => {
  function mulberry32(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const JUNK = [null, undefined, 'x', -5, NaN, Infinity];

  test('output is sorted, valid, and keeps exactly the valid readings', () => {
    const rand = mulberry32(20261024);
    for (let run = 0; run < 300; run++) {
      const hours = [...Array(24).keys()].filter(() => rand() < 0.8).sort(() => rand() - 0.5);
      let expectedValid = 0;
      const items = hours.map((h) => {
        const ok = rand() < 0.7;
        const value = ok ? Math.floor(rand() * 400) : JUNK[Math.floor(rand() * JUNK.length)];
        if (ok) expectedValid++;
        const ts = `2026-10-24T${String(h).padStart(2, '0')}:00:00+08:00`;
        return { timestamp: ts, readings: { pm25_one_hourly: { central: value } } };
      });
      const series = parsePm25Series({ data: { items } }, 'central');

      assert.equal(series.length, expectedValid);
      for (let i = 0; i < series.length; i++) {
        assert.ok(Number.isFinite(series[i].value) && series[i].value >= 0);
        if (i > 0) assert.ok(series[i].time > series[i - 1].time);
      }
    }
  });
});

describe('parseLatestPsi', () => {
  test('reads the 24-hr PSI for the region from the real fixture', () => {
    const json = fixture('psi-latest.json');
    assert.deepEqual(parseLatestPsi(json, 'central'), { time: sgt('2026-10-24T15:00:00'), value: 135 });
    assert.deepEqual(parseLatestPsi(json, 'west'), { time: sgt('2026-10-24T15:00:00'), value: 152 });
  });

  test('picks the newest valid item when several are present', () => {
    const json = {
      data: {
        items: [
          { timestamp: '2026-10-24T13:00:00+08:00', readings: { psi_twenty_four_hourly: { central: 60 } } },
          { timestamp: '2026-10-24T15:00:00+08:00', readings: { psi_twenty_four_hourly: { central: null } } },
          { timestamp: '2026-10-24T14:00:00+08:00', readings: { psi_twenty_four_hourly: { central: 61 } } },
        ],
      },
    };
    assert.deepEqual(parseLatestPsi(json, 'central'), { time: sgt('2026-10-24T14:00:00'), value: 61 });
  });

  test('ignores other PSI metrics such as pm25_sub_index', () => {
    const json = {
      data: {
        items: [{ timestamp: '2026-10-24T15:00:00+08:00', readings: { pm25_sub_index: { central: 99 } } }],
      },
    };
    assert.equal(parseLatestPsi(json, 'central'), null);
  });

  test('returns null for not-found, garbage, or unknown region', () => {
    assert.equal(parseLatestPsi(fixture('pm25-not-found.json'), 'central'), null);
    assert.equal(parseLatestPsi(null, 'central'), null);
    assert.equal(parseLatestPsi({ data: { items: [] } }, 'central'), null);
    assert.equal(parseLatestPsi(fixture('psi-latest.json'), 'national'), null);
  });
});
