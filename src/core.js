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

module.exports = { REGIONS, normaliseRegion, parsePm25Series, parseLatestPsi };
