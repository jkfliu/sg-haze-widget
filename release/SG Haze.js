// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: smog;

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

// Scriptable layer: requests, Keychain, file cache and drawing. Kept thin: logic lives in core.js.
// Only runs inside Scriptable; tested by hand on the phone. The build strips the require below.

// Both set by scripts/build.js from package.json; the repo is fixed in the published script.
const VERSION = '1.0.0';
const UPDATE_REPO = 'jkfliu/sg-haze-widget';

const API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const HAZE_URL = 'https://www.haze.gov.sg';
const KEYCHAIN_KEY = 'sg-haze.api-key';
const CACHE_FILE = 'sg-haze-cache.json';
const SETTINGS_FILE = 'sg-haze-settings.json';
const BACKUP_NAME = 'SG Haze (previous).js';
const CHART_SPAN = 24 * 3600e3;
const CHART_LINE = '#000000';

const BG = Color.dynamic(new Color('#ffffff'), new Color('#1c1c1e'));
const FG = Color.dynamic(new Color('#111111'), new Color('#f2f2f7'));
const MUTED = Color.dynamic(new Color('#6e6e73'), new Color('#98989d'));

// --- Data ---

// Returns parsed JSON, or null for the API's 404 "not found" (e.g. today just after midnight).
async function fetchJson(endpoint, date) {
  const req = new Request(`${API_BASE}/${endpoint}${date ? `?date=${date}` : ''}`);
  req.timeoutInterval = 15;
  if (Keychain.contains(KEYCHAIN_KEY)) req.headers = { 'x-api-key': Keychain.get(KEYCHAIN_KEY) };
  const json = await req.loadJSON();
  const status = req.response.statusCode;
  if (status === 404) return null;
  if (status !== 200) throw new Error(`${endpoint}: HTTP ${status}`);
  return json;
}

function localPath(name) {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), name);
}

function readJsonFile(name) {
  try {
    return JSON.parse(FileManager.local().readString(localPath(name))) ?? {};
  } catch (e) {
    return {};
  }
}

const writeJsonFile = (name, value) => FileManager.local().writeString(localPath(name), JSON.stringify(value));
const readCache = () => readJsonFile(CACHE_FILE);

// { series, psi, fetchedAt, failed } for the region, falling back to the cache when a request fails.
async function loadData(region, now) {
  const { today, yesterday } = sgtDateStrings(now);
  const cache = readCache();
  try {
    const [todayJson, yesterdayJson, psiJson] = await Promise.all([
      fetchJson('pm25', today), fetchJson('pm25', yesterday), fetchJson('psi'),
    ]);
    const data = {
      series: rolling24h(parsePm25Series(todayJson, region), parsePm25Series(yesterdayJson, region), now),
      psi: parseLatestPsi(psiJson, region),
      fetchedAt: now,
    };
    cache[region] = data;
    writeJsonFile(CACHE_FILE, cache);
    return { ...data, failed: false };
  } catch (e) {
    console.error(`SG Haze: ${e}`);
    return cache[region] ? { ...cache[region], failed: true } : null;
  }
}

// --- Updates (on by default; see README "For friends") ---

// null in a dev build (no repo set), which turns all update features off.
const UPDATE_URLS = updateUrl(UPDATE_REPO);

// Settings: { updateChecks: boolean, lastChecked: ms, latest: { version, notes } }
// Update checks are on unless turned off in the menu (DECISIONS.md #16).
const readSettings = () => ({ updateChecks: true, ...readJsonFile(SETTINGS_FILE) });
const writeSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);

// The response body as text; throws on a non-200 status.
async function loadText(url, timeout) {
  const req = new Request(url);
  req.timeoutInterval = timeout;
  const text = await req.loadString();
  if (req.response.statusCode !== 200) throw new Error(`HTTP ${req.response.statusCode}`);
  return text;
}

// Fetches version.json and records it. Only reads the manifest: nothing is installed here.
async function checkForUpdate(settings, now) {
  settings.lastChecked = now; // even on failure, so a broken network doesn't mean a check every refresh
  try {
    const manifest = parseManifest(await loadText(UPDATE_URLS.manifest, 10));
    if (manifest) settings.latest = manifest;
  } catch (e) {
    console.error(`SG Haze update check: ${e}`);
  }
  writeSettings(settings);
}

const updateDue = (settings, now) =>
  Boolean(UPDATE_URLS) && settings.updateChecks && shouldCheckForUpdate(settings.lastChecked, now);

// Whether to show "update" in the widget and offer Install in the app.
const showUpdate = (settings) =>
  Boolean(UPDATE_URLS) && settings.updateChecks && compareVersions(settings.latest?.version, VERSION) === 1;

// The FileManager that owns a path: iCloud if it's in Scriptable's iCloud folder, else local.
function fileManagerFor(path) {
  try {
    const icloud = FileManager.iCloud();
    if (path.startsWith(icloud.documentsDirectory())) return icloud;
  } catch (e) {
    // iCloud is off for Scriptable, so the script must be stored locally.
  }
  return FileManager.local();
}

// Downloads the new script, checks it, backs up the current one, then overwrites it.
// Throws with a readable message on any failure, leaving the current script untouched.
async function installUpdate(latest) {
  let source;
  try {
    source = await loadText(UPDATE_URLS.script, 30);
  } catch (e) {
    throw new Error(`Download failed (${e.message ?? e}).`);
  }
  const check = isPlausibleUpdate(source, latest.version, VERSION);
  if (!check.ok) throw new Error(check.reason);

  // Overwrite this script wherever it's stored, iCloud or on the device (DECISIONS.md #4).
  const self = module.filename;
  const fm = fileManagerFor(self);
  fm.writeString(self.replace(/[^/]+$/, BACKUP_NAME), fm.readString(self));
  fm.writeString(self, source);
}

// Everything the layouts show, derived once.
function viewModel(region, data, now) {
  const series = rolling24h(data?.series, [], now);
  const pm = series.at(-1) ?? null;
  const psi = data?.psi ?? null;
  return {
    region: region[0].toUpperCase() + region.slice(1),
    series,
    pm,
    pmBand: pm25Band(pm?.value),
    psi,
    psiBand: psiBand(psi?.value),
    stale: !data || data.failed || isStale(pm?.time, now),
    updated: formatUpdated(pm?.time),
    checked: formatChecked(data?.fetchedAt),
    // Footer under the chart: says what the chart shows, then when the reading was taken.
    chartCaption: ['PM2.5 24h', formatUpdated(pm?.time)].filter(Boolean).join(' · '),
  };
}

// --- Drawing ---

function drawChart(series, width, height, now) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const pad = 3;
  const { segments, yMax } = chartPoints(series, width, height, pad, { start: now - CHART_SPAN, end: now });

  for (const band of chartBands(yMax, width, height, pad)) {
    ctx.setFillColor(new Color(band.colour));
    ctx.fillRect(new Rect(band.x, band.y, band.width, band.height));
  }

  const line = new Color(CHART_LINE);
  ctx.setStrokeColor(line);
  ctx.setFillColor(line);
  ctx.setLineWidth(1.5);
  for (const segment of segments) {
    if (segment.length === 1) {
      const { x, y } = segment[0];
      ctx.fillEllipse(new Rect(x - 1.5, y - 1.5, 3, 3));
      continue;
    }
    const path = new Path();
    path.addLines(segment.map(({ x, y }) => new Point(x, y)));
    ctx.addPath(path);
    ctx.strokePath();
  }
  return ctx.getImage();
}

function addText(stack, text, font, colour = FG) {
  const t = stack.addText(text);
  t.font = font;
  t.textColor = colour;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  return t;
}

// Label, big number, and a coloured dot with the band name.
function addReading(stack, label, point, band, size) {
  const col = stack.addStack();
  col.layoutVertically();
  addText(col, label, Font.mediumSystemFont(10), MUTED);
  addText(col, point ? String(point.value) : '–', Font.boldRoundedSystemFont(size));
  if (band) {
    const row = col.addStack();
    row.spacing = 3;
    row.centerAlignContent();
    addText(row, '●', Font.systemFont(8), new Color(band.colour));
    addText(row, band.name, Font.systemFont(10), MUTED);
  }
}

function addHeader(stack, view) {
  const row = stack.addStack();
  row.centerAlignContent();
  addText(row, view.region, Font.semiboldSystemFont(12));
  row.addSpacer();
  if (view.stale) addText(row, '⚠ stale', Font.mediumSystemFont(10), new Color('#f28c28'));
  if (view.stale && view.update) row.addSpacer(4);
  if (view.update) addText(row, '↑ update', Font.mediumSystemFont(10), new Color('#2e86de'));
}

// --- Layouts ---

function buildSmall(w, view, now) {
  w.setPadding(12, 12, 10, 12);
  addHeader(w, view);
  w.addSpacer(4);
  const row = w.addStack();
  addReading(row, 'PM2.5 1h', view.pm, view.pmBand, 24);
  row.addSpacer();
  addReading(row, 'PSI 24h', view.psi, view.psiBand, 24);
  w.addSpacer();
  const chart = w.addImage(drawChart(view.series, 132, 28, now));
  chart.imageSize = new Size(132, 28);
  w.addSpacer(3);
  addText(w, view.chartCaption, Font.systemFont(9), MUTED);
}

// Same arrangement as small, stretched wide: the extra room goes to the chart and the checked time.
function buildMedium(w, view, now) {
  w.setPadding(12, 14, 10, 14);
  addHeader(w, view);
  w.addSpacer(4);
  const row = w.addStack();
  addReading(row, 'PM2.5 1h', view.pm, view.pmBand, 24);
  row.addSpacer(40);
  addReading(row, 'PSI 24h', view.psi, view.psiBand, 24);
  row.addSpacer();
  w.addSpacer();
  const chart = w.addImage(drawChart(view.series, 300, 34, now));
  chart.imageSize = new Size(300, 34);
  w.addSpacer(3);
  const footer = w.addStack();
  addText(footer, view.chartCaption, Font.systemFont(9), MUTED);
  footer.addSpacer();
  addText(footer, view.checked, Font.systemFont(9), MUTED);
}

// Lock screen: text only.
function buildRectangular(w, view) {
  const line = (label, point, band) =>
    `${label} ${point ? point.value : '–'}${band ? ` ${band.name}` : ''}`;
  addText(w, `${view.region} · ${line('PM2.5', view.pm, view.pmBand)}`, Font.semiboldSystemFont(14));
  addText(w, line('PSI', view.psi, view.psiBand), Font.systemFont(12));
  const status = view.updated ? `${view.updated}${view.stale ? ' · stale' : ''}` : 'Stale';
  addText(w, status, Font.systemFont(10));
}

function buildWidget(family, region, data, now, update = false) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.url = HAZE_URL;
  w.refreshAfterDate = nextRefresh(now);
  const view = { ...viewModel(region, data, now), update };
  if (family === 'small') buildSmall(w, view, now);
  else if (family?.startsWith('accessory')) buildRectangular(w, view);
  else buildMedium(w, view, now); // medium, plus large until it gets its own layout
  return w;
}

// --- In-app menu ---

async function promptForApiKey() {
  const a = new Alert();
  a.title = 'data.gov.sg API key';
  a.message = 'Optional. Stored in this device\'s Keychain and sent only to data.gov.sg.';
  a.addSecureTextField('API key', '');
  a.addAction('Save');
  a.addCancelAction('Cancel');
  if ((await a.present()) !== 0) return;
  const key = a.textFieldValue(0).trim();
  if (key) Keychain.set(KEYCHAIN_KEY, key);
}

async function showMessage(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('OK');
  await a.present();
}

// true if the user taps `ok`.
async function confirm(title, message, ok, cancel = 'Cancel') {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction(ok);
  a.addCancelAction(cancel);
  return (await a.present()) === 0;
}

async function toggleUpdateChecks(settings, now) {
  if (settings.updateChecks) {
    settings.updateChecks = false;
    writeSettings(settings);
    return;
  }
  const message = `Once a day, SG Haze will look for a new version at github.com/${UPDATE_REPO}. `
    + 'Nothing installs by itself. If you tap Install, the new script downloaded from that repo '
    + 'replaces this one and runs on your phone.';
  if (!(await confirm('Turn on update checks?', message, 'Turn on'))) return;
  settings.updateChecks = true;
  await checkForUpdate(settings, now);
}

async function offerUpdate(settings) {
  const { version, notes } = settings.latest;
  const message = `${notes || 'No release notes.'}\n\nInstalled: ${VERSION}. The current script is kept as "${BACKUP_NAME}".`;
  if (!(await confirm(`Update to ${version}?`, message, 'Install update', 'Not now'))) return;
  try {
    await installUpdate(settings.latest);
    await showMessage('Update installed', `SG Haze ${version} is installed. Run the script again to use it.`);
  } catch (e) {
    await showMessage('Update not installed', `${e.message ?? e}\n\nYour current script hasn't changed.`);
  }
}

async function runInApp(region, now) {
  const data = await loadData(region, now);
  const settings = readSettings();
  for (;;) {
    const hasKey = Keychain.contains(KEYCHAIN_KEY);
    const update = showUpdate(settings);
    const menu = new Alert();
    menu.title = 'SG Haze';
    menu.message = [
      `Version ${VERSION}${update ? ` (${settings.latest.version} available)` : ''}`,
      `Region: ${region} (set per widget in its Parameter field)`,
      `API key: ${hasKey ? 'set' : 'not set'}`,
      ...(UPDATE_URLS ? [`Update checks: ${settings.updateChecks ? 'on' : 'off'}`] : []),
    ].join('\n');
    const actions = [
      ...(update ? [[`Install update ${settings.latest.version}`, () => offerUpdate(settings)]] : []),
      ['Preview medium widget', () => buildWidget('medium', region, data, now, update).presentMedium()],
      ['Preview small widget', () => buildWidget('small', region, data, now, update).presentSmall()],
      ['Preview lock screen widget',
        () => buildWidget('accessoryRectangular', region, data, now, update).presentAccessoryRectangular()],
      [hasKey ? 'Change API key' : 'Set API key', promptForApiKey],
      ...(UPDATE_URLS ? [[settings.updateChecks ? 'Turn off update checks' : 'Turn on update checks',
        () => toggleUpdateChecks(settings, now)]] : []),
    ];
    for (const [label] of actions) menu.addAction(label);
    if (hasKey) {
      menu.addDestructiveAction('Clear API key');
      actions.push(['Clear API key', () => Keychain.remove(KEYCHAIN_KEY)]);
    }
    menu.addCancelAction('Done');
    const choice = await menu.presentSheet();
    if (choice === -1) return;
    await actions[choice][1]();
  }
}

// --- Entry point ---

const now = Date.now();
const region = normaliseRegion(args.widgetParameter);
if (config.runsInWidget) {
  const settings = readSettings();
  // The update check runs alongside the data fetch, so it never delays the refresh.
  const [, data] = await Promise.all([
    updateDue(settings, now) ? checkForUpdate(settings, now) : null,
    loadData(region, now),
  ]);
  Script.setWidget(buildWidget(config.widgetFamily, region, data, now, showUpdate(settings)));
} else {
  await runInApp(region, now);
}
Script.complete();
