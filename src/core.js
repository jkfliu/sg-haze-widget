// Pure logic for the SG Haze widget. No Scriptable APIs here: everything is tested under Node.

const REGIONS = ['north', 'south', 'east', 'west', 'central'];
const DEFAULT_REGION = 'central';

function normaliseRegion(param) {
  if (typeof param !== 'string') return DEFAULT_REGION;
  const region = param.trim().toLowerCase();
  return REGIONS.includes(region) ? region : DEFAULT_REGION;
}

// Valid { time, value } points for one metric and region, oldest first.
// The API lists items newest first; bad timestamps and non-numeric or negative values are dropped.
function readMetric(json, metric, region) {
  const items = json?.data?.items;
  if (!Array.isArray(items)) return [];
  const points = [];
  for (const item of items) {
    const time = Date.parse(item?.timestamp);
    const value = item?.readings?.[metric]?.[region];
    if (Number.isNaN(time) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    points.push({ time, value });
  }
  return points.sort((a, b) => a.time - b.time);
}

function parsePm25Series(json, region) {
  return readMetric(json, 'pm25_one_hourly', region);
}

function parseLatestPsi(json, region) {
  return readMetric(json, 'psi_twenty_four_hourly', region).at(-1) ?? null;
}

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const SGT_OFFSET = 8 * HOUR; // Singapore is UTC+8 with no daylight saving
const STALE_AFTER = 2 * HOUR;
const REFRESH_MINUTE = 50; // NEA publishes each hour's reading at about :45

const toMs = (t) => (t instanceof Date ? t.getTime() : t);

// Today's and yesterday's dates in Singapore, as YYYY-MM-DD for the API's ?date= parameter.
function sgtDateStrings(now) {
  const shifted = toMs(now) + SGT_OFFSET;
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { today: ymd(shifted), yesterday: ymd(shifted - DAY) };
}

// Merge both days into the readings with now - 24h < time <= now, oldest first.
// On a duplicate time, the today series wins.
function rolling24h(todaySeries, yesterdaySeries, now) {
  const end = toMs(now);
  const byTime = new Map();
  for (const p of [...(yesterdaySeries ?? []), ...(todaySeries ?? [])]) byTime.set(p.time, p);
  return [...byTime.values()]
    .filter((p) => p.time > end - DAY && p.time <= end)
    .sort((a, b) => a.time - b.time);
}

// The next :50 strictly after now (DECISIONS.md #1). Whole-hour SGT offset, so UTC minutes match.
function nextRefresh(now) {
  const next = new Date(toMs(now));
  next.setUTCMinutes(REFRESH_MINUTE, 0, 0);
  if (next.getTime() <= toMs(now)) next.setTime(next.getTime() + HOUR);
  return next;
}

function isStale(latestTime, now) {
  const time = toMs(latestTime);
  if (!Number.isFinite(time)) return true;
  return toMs(now) - time > STALE_AFTER;
}

module.exports = {
  REGIONS, normaliseRegion, parsePm25Series, parseLatestPsi,
  sgtDateStrings, rolling24h, nextRefresh, isStale,
};
