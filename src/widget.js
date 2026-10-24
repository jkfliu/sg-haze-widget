// Scriptable layer: requests, Keychain, file cache and drawing. Kept thin: logic lives in core.js.
// Only runs inside Scriptable; tested by hand on the phone. The build strips the require below.
const {
  normaliseRegion, parsePm25Series, parseLatestPsi, sgtDateStrings, rolling24h, nextRefresh,
  isStale, pm25Band, psiBand, chartPoints, chartBands, formatUpdated, formatChecked,
} = require('./core.js');

const API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const HAZE_URL = 'https://www.haze.gov.sg';
const KEYCHAIN_KEY = 'sg-haze.api-key';
const CACHE_FILE = 'sg-haze-cache.json';
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

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
}

function readCache() {
  try {
    return JSON.parse(FileManager.local().readString(cachePath())) ?? {};
  } catch (e) {
    return {};
  }
}

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
    FileManager.local().writeString(cachePath(), JSON.stringify(cache));
    return { ...data, failed: false };
  } catch (e) {
    console.error(`SG Haze: ${e}`);
    return cache[region] ? { ...cache[region], failed: true } : null;
  }
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

function buildWidget(family, region, data, now) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.url = HAZE_URL;
  w.refreshAfterDate = nextRefresh(now);
  const view = viewModel(region, data, now);
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

async function runInApp(region, now) {
  const data = await loadData(region, now);
  for (;;) {
    const hasKey = Keychain.contains(KEYCHAIN_KEY);
    const menu = new Alert();
    menu.title = 'SG Haze';
    menu.message = `Region: ${region} (set per widget in its Parameter field)\nAPI key: ${hasKey ? 'set' : 'not set'}`;
    const actions = [
      ['Preview medium widget', () => buildWidget('medium', region, data, now).presentMedium()],
      ['Preview small widget', () => buildWidget('small', region, data, now).presentSmall()],
      ['Preview lock screen widget',
        () => buildWidget('accessoryRectangular', region, data, now).presentAccessoryRectangular()],
      [hasKey ? 'Change API key' : 'Set API key', promptForApiKey],
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
  Script.setWidget(buildWidget(config.widgetFamily, region, await loadData(region, now), now));
} else {
  await runInApp(region, now);
}
Script.complete();
