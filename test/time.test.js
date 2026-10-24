const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePm25Series, sgtDateStrings, rolling24h, nextRefresh, isStale,
} = require('../src/core.js');
const { fixture, sgt, mulberry32 } = require('./helpers.js');

const HOUR = 3600e3;
const utc = (iso) => new Date(`${iso}Z`);

describe('sgtDateStrings', () => {
  test('uses the Singapore date in the middle of the day', () => {
    assert.deepEqual(sgtDateStrings(utc('2026-10-24T07:39:00')),
      { today: '2026-10-24', yesterday: '2026-10-23' });
  });

  test('UTC evening is already the next day in Singapore', () => {
    // 16:00 UTC on the 24th is 00:00 SGT on the 25th.
    assert.deepEqual(sgtDateStrings(utc('2026-10-24T16:00:00')),
      { today: '2026-10-25', yesterday: '2026-10-24' });
  });

  test('one millisecond before Singapore midnight is still the same day', () => {
    assert.deepEqual(sgtDateStrings(utc('2026-10-24T15:59:59.999')),
      { today: '2026-10-24', yesterday: '2026-10-23' });
  });

  test('UTC just before midnight is mid-morning the next day in Singapore', () => {
    assert.deepEqual(sgtDateStrings(utc('2026-10-23T23:30:00')),
      { today: '2026-10-24', yesterday: '2026-10-23' });
  });

  test('crosses month and year boundaries', () => {
    assert.deepEqual(sgtDateStrings(utc('2026-12-31T16:30:00')),
      { today: '2027-01-01', yesterday: '2026-12-31' });
    assert.deepEqual(sgtDateStrings(utc('2026-10-31T17:00:00')),
      { today: '2026-11-01', yesterday: '2026-10-31' });
  });

  test('handles a leap day', () => {
    assert.deepEqual(sgtDateStrings(new Date(sgt('2028-03-01T08:00:00'))),
      { today: '2028-03-01', yesterday: '2028-02-29' });
  });

  test('accepts epoch ms as well as a Date', () => {
    assert.deepEqual(sgtDateStrings(utc('2026-10-24T16:00:00').getTime()),
      { today: '2026-10-25', yesterday: '2026-10-24' });
  });
});

describe('rolling24h with real fixtures', () => {
  const today = parsePm25Series(fixture('pm25-today.json'), 'central');
  const yesterday = parsePm25Series(fixture('pm25-yesterday.json'), 'central');

  test('keeps yesterday from 16:00 onward plus all of today at 15:39 SGT', () => {
    const series = rolling24h(today, yesterday, sgt('2026-10-24T15:39:00'));
    assert.equal(series.length, 24);
    assert.equal(series[0].time, sgt('2026-10-23T16:00:00'));
    assert.deepEqual(series.at(-1), { time: sgt('2026-10-24T15:00:00'), value: 64 });
  });

  test('excludes the reading from exactly 24 hours ago (DECISIONS.md #3)', () => {
    const series = rolling24h(today, yesterday, sgt('2026-10-24T15:00:00'));
    assert.equal(series.length, 24);
    assert.ok(!series.some((p) => p.time === sgt('2026-10-23T15:00:00')));
    assert.equal(series.at(-1).time, sgt('2026-10-24T15:00:00')); // reading at now is kept
  });

  test('does not modify the input arrays', () => {
    const t = structuredClone(today);
    const y = structuredClone(yesterday);
    rolling24h(t, y, sgt('2026-10-24T15:39:00'));
    assert.deepEqual(t, today);
    assert.deepEqual(y, yesterday);
  });
});

describe('rolling24h edge cases', () => {
  const now = sgt('2026-10-24T12:30:00');

  test('keeps a point 1 ms inside the window and drops future points', () => {
    const series = rolling24h(
      [{ time: now, value: 3 }, { time: now + 1, value: 4 }],
      [{ time: now - 24 * HOUR, value: 1 }, { time: now - 24 * HOUR + 1, value: 2 }],
      now,
    );
    assert.deepEqual(series.map((p) => p.value), [2, 3]);
  });

  test('removes duplicate times, preferring the today series value', () => {
    const t = sgt('2026-10-24T00:00:00');
    const series = rolling24h([{ time: t, value: 50 }], [{ time: t, value: 49 }], now);
    assert.deepEqual(series, [{ time: t, value: 50 }]);
  });

  test('removes duplicates within one series', () => {
    const t = sgt('2026-10-24T05:00:00');
    const series = rolling24h([{ time: t, value: 7 }, { time: t, value: 7 }], [], now);
    assert.equal(series.length, 1);
  });

  test('sorts unordered input', () => {
    const series = rolling24h(
      [{ time: sgt('2026-10-24T02:00:00'), value: 2 }, { time: sgt('2026-10-24T01:00:00'), value: 1 }],
      [{ time: sgt('2026-10-23T23:00:00'), value: 0 }],
      now,
    );
    assert.deepEqual(series.map((p) => p.value), [0, 1, 2]);
  });

  test('works with only one day of data, or none', () => {
    const point = { time: sgt('2026-10-24T01:00:00'), value: 9 };
    assert.deepEqual(rolling24h([point], [], now), [point]);
    assert.deepEqual(rolling24h([], [point], now), [point]);
    assert.deepEqual(rolling24h([], [], now), []);
    assert.deepEqual(rolling24h(null, undefined, now), []);
  });
});

describe('rolling24h properties', () => {
  test('output is sorted, unique, inside the window, and drops nothing in range', () => {
    const rand = mulberry32(424242);
    for (let run = 0; run < 300; run++) {
      const now = sgt('2026-10-24T00:00:00') + Math.floor(rand() * 24 * HOUR);
      const randomSeries = () => [...Array(Math.floor(rand() * 30))].map(() => ({
        time: now - Math.floor(rand() * 50 - 2) * HOUR, // some points in the future
        value: Math.floor(rand() * 200),
      }));
      const today = randomSeries();
      const yesterday = randomSeries();
      const series = rolling24h(today, yesterday, now);

      const inRange = new Set([...today, ...yesterday]
        .filter((p) => p.time > now - 24 * HOUR && p.time <= now).map((p) => p.time));
      assert.equal(series.length, inRange.size);
      for (let i = 0; i < series.length; i++) {
        assert.ok(series[i].time > now - 24 * HOUR && series[i].time <= now);
        if (i > 0) assert.ok(series[i].time > series[i - 1].time);
      }
    }
  });
});

describe('nextRefresh', () => {
  test('returns 50 past the current hour when that is still ahead (DECISIONS.md #1)', () => {
    assert.equal(nextRefresh(sgt('2026-10-24T15:39:12')).getTime(), sgt('2026-10-24T15:50:00'));
  });

  test('moves to the next hour once :50 has passed', () => {
    assert.equal(nextRefresh(sgt('2026-10-24T15:55:00')).getTime(), sgt('2026-10-24T16:50:00'));
  });

  test('exactly :50 schedules the following hour, never now', () => {
    assert.equal(nextRefresh(sgt('2026-10-24T15:50:00')).getTime(), sgt('2026-10-24T16:50:00'));
  });

  test('crosses midnight', () => {
    assert.equal(nextRefresh(sgt('2026-10-24T23:51:00')).getTime(), sgt('2026-10-25T00:50:00'));
  });

  test('returns a Date, as Scriptable refreshAfterDate needs', () => {
    assert.ok(nextRefresh(sgt('2026-10-24T15:39:00')) instanceof Date);
  });

  test('is always in the future and at most an hour away', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const now = sgt('2026-10-24T00:00:00') + Math.floor(rand() * 48 * HOUR);
      const next = nextRefresh(now).getTime();
      assert.ok(next > now && next - now <= HOUR, `now=${new Date(now).toISOString()}`);
      assert.equal(new Date(next).getUTCMinutes(), 50);
      assert.equal(next % 60e3, 0);
    }
  });
});

describe('isStale', () => {
  const now = sgt('2026-10-24T15:39:00');

  test('fresh data is not stale', () => {
    assert.equal(isStale(sgt('2026-10-24T15:00:00'), now), false);
  });

  test('exactly 2 hours old is not stale; 1 ms more is', () => {
    assert.equal(isStale(now - 2 * HOUR, now), false);
    assert.equal(isStale(now - 2 * HOUR - 1, now), true);
  });

  test('accepts Dates as well as epoch ms', () => {
    assert.equal(isStale(new Date(now - 3 * HOUR), new Date(now)), true);
  });

  test('missing or invalid time counts as stale', () => {
    assert.equal(isStale(null, now), true);
    assert.equal(isStale(undefined, now), true);
    assert.equal(isStale(NaN, now), true);
  });

  test('a time in the future is not stale', () => {
    assert.equal(isStale(now + HOUR, now), false);
  });
});
