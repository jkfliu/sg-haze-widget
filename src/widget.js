// Scriptable layer: requests, Keychain, file cache and drawing. Kept thin: logic lives in core.js.
// Only runs inside Scriptable; tested by hand on the phone. The build strips the require below.
const {
  normaliseRegion, parsePm25Series, parseLatestPsi, sgtDateStrings, rolling24h, nextRefresh,
  isStale, pm25Band, psiBand, chartPoints, chartBands, formatUpdated, formatChecked,
  compareVersions, parseManifest, shouldCheckForUpdate, updateUrl, isPlausibleUpdate,
} = require('./core.js');

// Both set by scripts/build.js from package.json; the repo is fixed in the published script.
const VERSION = 'dev';
const UPDATE_REPO = '';

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
