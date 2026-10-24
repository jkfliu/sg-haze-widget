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

// Band tables. Source: NEA, haze.gov.sg ("1-hr PM2.5 concentration bands" and "PSI descriptors").
// Thresholds to be checked against haze.gov.sg. Colours are our own picks, not NEA's.
// `tint` is the pastel chart background for the band (see chartBands).
const PM25_BANDS = [
  { max: 55, name: 'Normal', colour: '#3fae49', tint: '#c8e6c9' },
  { max: 150, name: 'Elevated', colour: '#f4c430', tint: '#fff1b8' },
  { max: 250, name: 'High', colour: '#f28c28', tint: '#ffd8a8' },
  { max: Infinity, name: 'Very High', colour: '#d7263d', tint: '#f5b7b1' },
];
const PSI_BANDS = [
  { max: 50, name: 'Good', colour: '#3fae49' },
  { max: 100, name: 'Moderate', colour: '#2e86de' },
  { max: 200, name: 'Unhealthy', colour: '#f4c430' },
  { max: 300, name: 'Very Unhealthy', colour: '#f28c28' },
  { max: Infinity, name: 'Hazardous', colour: '#d7263d' },
];

function bandFor(bands, value) {
  if (typeof value !== 'number' || !(value >= 0)) return null;
  const { name, colour } = bands.find((b) => value <= b.max);
  return { name, colour };
}

const pm25Band = (value) => bandFor(PM25_BANDS, value);
const psiBand = (value) => bandFor(PSI_BANDS, value);

const MIN_Y_MAX = 60; // so a normal day doesn't fill the chart and look alarming
const GAP_AFTER = 1.5 * HOUR; // readings further apart than this are not joined

// Pixel y for a value. DrawContext's y grows downward, so 0 sits at the bottom.
function chartY(value, yMax, height, padding) {
  return height - padding - (value / yMax) * (height - 2 * padding);
}

// Chart background rectangles for the NEA PM2.5 bands within 0..yMax, bottom band first.
// Opaque pastel tints, because a drawn image can't follow light/dark mode and the black line
// must read on both.
function chartBands(yMax, width, height, padding) {
  const bands = [];
  let from = 0;
  for (const { max, name, tint: colour } of PM25_BANDS) {
    const to = Math.min(max, yMax);
    if (to > from) {
      const top = chartY(to, yMax, height, padding);
      bands.push({ name, colour, x: padding, y: top, width: width - 2 * padding, height: chartY(from, yMax, height, padding) - top });
    }
    if (to >= yMax) break;
    from = to;
  }
  return bands;
}

// Readings to pixel coordinates, split into segments wherever an hour is missing.
// The x-axis spans `range` ({ start, end } in ms) if given, otherwise the first to last reading.
function chartPoints(series, width, height, padding, range) {
  const sorted = [...(series ?? [])].sort((a, b) => a.time - b.time);
  const start = range?.start ?? sorted[0]?.time;
  const end = range?.end ?? sorted.at(-1)?.time;
  const points = sorted.filter((p) => p.time >= start && p.time <= end);
  const yMax = Math.max(MIN_Y_MAX, ...points.map((p) => p.value));

  const xFor = (time) => (end === start
    ? width - padding
    : padding + ((time - start) / (end - start)) * (width - 2 * padding));

  const segments = [];
  points.forEach((p, i) => {
    if (i === 0 || p.time - points[i - 1].time > GAP_AFTER) segments.push([]);
    segments.at(-1).push({ x: xFor(p.time), y: chartY(p.value, yMax, height, padding) });
  });
  return { segments, yMax };
}

// Singapore wall-clock time as "3:00pm".
function formatSgtTime(time) {
  const ms = toMs(time);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + SGT_OFFSET);
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${mm}${h < 12 ? 'am' : 'pm'}`;
}

// Time of the reading.
function formatUpdated(time) {
  const t = formatSgtTime(time);
  return t ? `Updated ${t}` : '';
}

// Time the widget last refreshed (DECISIONS.md #2).
function formatChecked(time) {
  const t = formatSgtTime(time);
  return t ? `Checked ${t}` : '';
}

// --- Versions and updates ---

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const UPDATE_CHECK_EVERY = DAY;
const SCRIPTABLE_HEADER = '// Variables used by Scriptable.';
const RELEASE_BRANCH = 'main';
const RELEASE_PATH = 'release/SG Haze.js'; // scripts/release.sh copies the bundle here

const parseVersion = (v) => (typeof v === 'string' && v.match(VERSION_PATTERN)?.slice(1).map(Number)) || null;
const isVersion = (v) => parseVersion(v) !== null;

// The line scripts/build.js writes into the bundle and isPlausibleUpdate looks for.
const versionLine = (version) => `const VERSION = '${version}';`;

// 1 if a is newer, -1 if older, 0 if equal; null if either isn't a plain x.y.z version.
function compareVersions(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

// version.json text to { version, notes }; null if it isn't valid.
function parseManifest(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!json || typeof json !== 'object' || !isVersion(json.version)) return null;
  return { version: json.version, notes: typeof json.notes === 'string' ? json.notes : '' };
}

// At most one check a day. A last check in the future means the clock changed, so check again.
function shouldCheckForUpdate(lastChecked, now) {
  const last = toMs(lastChecked);
  if (!Number.isFinite(last)) return true;
  const elapsed = toMs(now) - last;
  return elapsed < 0 || elapsed >= UPDATE_CHECK_EVERY;
}

// Raw GitHub URLs for the manifest and the released bundle, or null for anything but owner/repo.
function updateUrl(repo) {
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo.includes('..')) return null;
  const base = `https://raw.githubusercontent.com/${repo}/${RELEASE_BRANCH}`;
  return { manifest: `${base}/version.json`, script: `${base}/${RELEASE_PATH.split('/').map(encodeURIComponent).join('/')}` };
}

// Sanity checks on a downloaded script before it replaces the installed one.
function isPlausibleUpdate(source, expectedVersion, currentVersion) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof source !== 'string' || !source.trim()) return fail('The download was empty.');
  if (!source.startsWith(SCRIPTABLE_HEADER)) return fail("The download isn't a Scriptable script.");
  const newer = compareVersions(expectedVersion, currentVersion);
  if (newer === null) return fail('A version number was malformed.');
  if (newer <= 0) return fail(`${expectedVersion} isn't newer than the installed ${currentVersion}.`);
  if (!source.includes(`\n${versionLine(expectedVersion)}\n`)) {
    return fail(`The download's version doesn't match ${expectedVersion}.`);
  }
  return { ok: true };
}

module.exports = {
  REGIONS, normaliseRegion, parsePm25Series, parseLatestPsi,
  sgtDateStrings, rolling24h, nextRefresh, isStale,
  pm25Band, psiBand, chartY, chartBands, chartPoints, formatUpdated, formatChecked,
  compareVersions, parseManifest, shouldCheckForUpdate, updateUrl, isPlausibleUpdate,
  isVersion, versionLine, SCRIPTABLE_HEADER,
};
