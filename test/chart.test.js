const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePm25Series, rolling24h, pm25Band, psiBand, chartPoints, chartY, chartBands, formatUpdated, formatChecked,
} = require('../src/core.js');
const { fixture, sgt, mulberry32 } = require('./helpers.js');

const HOUR = 3600e3;
const HEX = /^#[0-9a-f]{6}$/i;

describe('pm25Band', () => {
  const cases = [
    [0, 'Normal'], [55, 'Normal'],
    [56, 'Elevated'], [150, 'Elevated'],
    [151, 'High'], [250, 'High'],
    [251, 'Very High'], [999, 'Very High'],
  ];
  for (const [value, name] of cases) {
    test(`${value} is ${name}`, () => assert.equal(pm25Band(value).name, name));
  }

  test('each band has its own hex colour', () => {
    const colours = [0, 56, 151, 251].map((v) => pm25Band(v).colour);
    for (const c of colours) assert.match(c, HEX);
    assert.equal(new Set(colours).size, 4);
  });

  test('returns null for missing, negative, or non-numeric values', () => {
    for (const v of [null, undefined, NaN, -1, '40']) assert.equal(pm25Band(v), null, `value: ${v}`);
  });
});

describe('psiBand', () => {
  const cases = [
    [0, 'Good'], [50, 'Good'],
    [51, 'Moderate'], [100, 'Moderate'],
    [101, 'Unhealthy'], [200, 'Unhealthy'],
    [201, 'Very Unhealthy'], [300, 'Very Unhealthy'],
    [301, 'Hazardous'], [500, 'Hazardous'],
  ];
  for (const [value, name] of cases) {
    test(`${value} is ${name}`, () => assert.equal(psiBand(value).name, name));
  }

  test('each band has its own hex colour', () => {
    const colours = [0, 51, 101, 201, 301].map((v) => psiBand(v).colour);
    for (const c of colours) assert.match(c, HEX);
    assert.equal(new Set(colours).size, 5);
  });

  test('returns null for missing, negative, or non-numeric values', () => {
    for (const v of [null, undefined, NaN, -1, '40']) assert.equal(psiBand(v), null, `value: ${v}`);
  });
});

describe('bands are ordered', () => {
  test('a higher reading never falls in a lower band', () => {
    const order = (bandFn, names) => (v) => names.indexOf(bandFn(v).name);
    const pm = order(pm25Band, ['Normal', 'Elevated', 'High', 'Very High']);
    const psi = order(psiBand, ['Good', 'Moderate', 'Unhealthy', 'Very Unhealthy', 'Hazardous']);
    for (let v = 1; v <= 600; v++) {
      assert.ok(pm(v) >= pm(v - 1), `pm25 ${v}`);
      assert.ok(psi(v) >= psi(v - 1), `psi ${v}`);
    }
  });
});

describe('chartY', () => {
  test('maps 0 to the bottom edge and yMax to the top edge, inside the padding', () => {
    assert.equal(chartY(0, 60, 100, 10), 90);
    assert.equal(chartY(60, 60, 100, 10), 10);
    assert.equal(chartY(30, 60, 100, 10), 50);
  });
});

describe('chartBands', () => {
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  const names = (bands) => bands.map((b) => b.name);

  test('a normal-day scale shows Normal with a strip of Elevated on top', () => {
    const bands = chartBands(60, 100, 100, 10);
    assert.deepEqual(names(bands), ['Normal', 'Elevated']);
    // Plot area is y 10..90; 55 of 60 sits at y = 90 - 55/60 * 80.
    const y55 = 90 - (55 / 60) * 80;
    close(bands[0].y, y55); close(bands[0].height, 90 - y55);
    close(bands[1].y, 10); close(bands[1].height, y55 - 10);
  });

  test('a scale of 200 shows Normal, Elevated and High', () => {
    const bands = chartBands(200, 100, 100, 10);
    assert.deepEqual(names(bands), ['Normal', 'Elevated', 'High']);
    assert.deepEqual(bands.map((b) => [b.y, b.height]), [[68, 22], [30, 38], [10, 20]]);
  });

  test('a scale above 250 shows all four NEA bands, Very High on top', () => {
    const bands = chartBands(300, 100, 100, 0);
    assert.deepEqual(names(bands), ['Normal', 'Elevated', 'High', 'Very High']);
    // 250..300 of 300 on a 100px plot is the top 50/3 px.
    close(bands[3].y, 0); close(bands[3].height, 50 / 3);
  });

  test('a scale ending exactly on a boundary has no zero-height band above it', () => {
    assert.deepEqual(names(chartBands(150, 100, 100, 0)), ['Normal', 'Elevated']);
    assert.deepEqual(names(chartBands(250, 100, 100, 0)), ['Normal', 'Elevated', 'High']);
  });

  test('chart bands use the same names as pm25Band at each boundary', () => {
    for (const [value, name] of [[55, 'Normal'], [150, 'Elevated'], [250, 'High'], [300, 'Very High']]) {
      assert.equal(chartBands(value, 100, 100, 0).at(-1).name, name);
      assert.equal(pm25Band(value).name, name);
    }
  });

  test('each chart band has its own colour', () => {
    const colours = chartBands(300, 100, 100, 0).map((b) => b.colour);
    assert.equal(new Set(colours).size, 4);
  });

  test('bands span the padded width and use hex colours', () => {
    for (const b of chartBands(200, 120, 50, 4)) {
      assert.equal(b.x, 4);
      assert.equal(b.width, 112);
      assert.match(b.colour, HEX);
    }
  });

  test('properties: bands stack without gaps and fill the plot height', () => {
    const rand = mulberry32(55);
    for (let run = 0; run < 200; run++) {
      const yMax = 60 + Math.floor(rand() * 400);
      const [h, p] = [20 + Math.floor(rand() * 200), Math.floor(rand() * 10)];
      const bands = chartBands(yMax, 100, h, p);
      close(bands[0].y + bands[0].height, h - p); // starts at the bottom edge
      close(bands.at(-1).y, p); // ends at the top edge
      for (let i = 1; i < bands.length; i++) close(bands[i].y + bands[i].height, bands[i - 1].y);
    }
  });
});

describe('chartPoints', () => {
  const t0 = sgt('2026-10-24T00:00:00');
  const at = (h, value) => ({ time: t0 + h * HOUR, value });

  test('scales time across the width and value up the height (y grows downward)', () => {
    const { segments, yMax } = chartPoints([at(0, 0), at(1, 30), at(2, 60)], 220, 100, 10);
    assert.equal(yMax, 60);
    assert.deepEqual(segments, [[{ x: 10, y: 90 }, { x: 110, y: 50 }, { x: 210, y: 10 }]]);
  });

  test('y-axis goes up to at least 60 on a clean day', () => {
    const { yMax, segments } = chartPoints([at(0, 10), at(1, 20)], 100, 100, 0);
    assert.equal(yMax, 60);
    assert.equal(segments[0][1].y, 100 - (20 / 60) * 100);
  });

  test('y-axis extends to the highest reading when it is above 60', () => {
    const { yMax, segments } = chartPoints([at(0, 50), at(1, 180)], 100, 100, 0);
    assert.equal(yMax, 180);
    assert.equal(segments[0][1].y, 0);
  });

  test('a missing hour breaks the line into separate segments', () => {
    const { segments } = chartPoints([at(0, 10), at(1, 10), at(3, 10), at(4, 10)], 100, 60, 0);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map((s) => s.length), [2, 2]);
  });

  test('an isolated reading becomes its own one-point segment', () => {
    const { segments } = chartPoints([at(0, 10), at(2, 10), at(4, 10), at(5, 10)], 100, 60, 0);
    assert.deepEqual(segments.map((s) => s.length), [1, 1, 2]);
  });

  test('with the synthetic gappy fixture, central breaks around the removed hours', () => {
    const series = parsePm25Series(fixture('pm25-gappy.synthetic.json'), 'central');
    const { segments } = chartPoints(series, 300, 100, 4);
    // Hours present: 00-02 | 06-09 | 11-13 | 15-23 (03-05 and 14 removed, 10 null).
    assert.deepEqual(segments.map((s) => s.length), [3, 4, 3, 9]);
  });

  test('a single reading sits at the right-hand edge', () => {
    const { segments } = chartPoints([at(0, 30)], 100, 100, 10);
    assert.deepEqual(segments, [[{ x: 90, y: 50 }]]);
  });

  test('an empty or missing series gives no segments', () => {
    assert.deepEqual(chartPoints([], 100, 100, 0), { segments: [], yMax: 60 });
    assert.deepEqual(chartPoints(null, 100, 100, 0), { segments: [], yMax: 60 });
  });

  test('an optional time range fixes the x-axis and drops points outside it', () => {
    const range = { start: t0, end: t0 + 4 * HOUR };
    const { segments } = chartPoints([at(-1, 10), at(2, 10), at(3, 10)], 100, 60, 0, range);
    assert.deepEqual(segments, [[{ x: 50, y: 50 }, { x: 75, y: 50 }]]);
  });

  test('real fixture window: 24 joined points spanning the full width', () => {
    const now = sgt('2026-10-24T15:39:00');
    const series = rolling24h(
      parsePm25Series(fixture('pm25-today.json'), 'central'),
      parsePm25Series(fixture('pm25-yesterday.json'), 'central'),
      now,
    );
    const { segments, yMax } = chartPoints(series, 240, 80, 4);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].length, 24);
    assert.equal(segments[0][0].x, 4);
    assert.equal(segments[0].at(-1).x, 236);
    assert.equal(yMax, Math.max(...series.map((p) => p.value)));
  });

  test('properties: points stay inside the padded box and x always increases', () => {
    const rand = mulberry32(99);
    for (let run = 0; run < 200; run++) {
      const series = [...Array(24).keys()]
        .filter(() => rand() < 0.75)
        .map((h) => at(h, Math.floor(rand() * 300)));
      const [w, h, p] = [100 + Math.floor(rand() * 300), 40 + Math.floor(rand() * 200), Math.floor(rand() * 12)];
      const { segments } = chartPoints(series, w, h, p);
      const pts = segments.flat();
      assert.equal(pts.length, series.length);
      for (let i = 0; i < pts.length; i++) {
        assert.ok(pts[i].x >= p && pts[i].x <= w - p, `x=${pts[i].x}`);
        assert.ok(pts[i].y >= p && pts[i].y <= h - p, `y=${pts[i].y}`);
        if (i > 0) assert.ok(pts[i].x > pts[i - 1].x);
      }
    }
  });
});

describe('formatUpdated and formatChecked', () => {
  test('shows the Singapore reading time as h:mmam/pm', () => {
    assert.equal(formatUpdated(sgt('2026-10-24T15:00:00')), 'Updated 3:00pm');
    assert.equal(formatUpdated(sgt('2026-10-24T09:05:00')), 'Updated 9:05am');
  });

  test('handles midnight and noon', () => {
    assert.equal(formatUpdated(sgt('2026-10-24T00:00:00')), 'Updated 12:00am');
    assert.equal(formatUpdated(sgt('2026-10-24T12:00:00')), 'Updated 12:00pm');
  });

  test('uses Singapore time whatever the UTC date', () => {
    // 16:30 UTC is 00:30 SGT the next day.
    assert.equal(formatUpdated(new Date('2026-10-24T16:30:00Z')), 'Updated 12:30am');
  });

  test('formatChecked shows when the widget last refreshed (DECISIONS.md #2)', () => {
    assert.equal(formatChecked(sgt('2026-10-24T15:52:40')), 'Checked 3:52pm');
  });

  test('returns an empty string for a missing or invalid time', () => {
    for (const t of [null, undefined, NaN]) {
      assert.equal(formatUpdated(t), '');
      assert.equal(formatChecked(t), '');
    }
  });
});
