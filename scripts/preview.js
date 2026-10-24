#!/usr/bin/env node
// Mac preview: runs the real bundle against stand-ins for Scriptable's widget classes and renders
// the result as an HTML page. An approximation of iOS layout for checking the arrangement;
// fonts and spacing differ slightly, so the phone has the final say.
// Usage: node scripts/preview.js [region] [--live] [--no-open]

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { buildBundle } = require('./build.js');
const { sgtDateStrings } = require('../src/core.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'preview.html');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const FIXTURE_NOW = Date.parse('2026-10-24T15:52:00+08:00'); // just after the fixtures were captured

// Widget sizes in points for a 6.1" iPhone (393 pt wide). Pro Max sizes are about 8% larger.
const SIZES = { small: [158, 158], medium: [338, 158], accessoryRectangular: [160, 72] };
const STATES = [
  { id: 'normal', label: 'Normal' },
  { id: 'offline-saved', label: 'Offline, saved data', offline: true, saved: true },
  { id: 'offline-empty', label: 'Offline, nothing saved', offline: true },
];
const THEMES = {
  light: { page: '#e5e5ea', text: '#000000' },
  dark: { page: '#000000', text: '#ffffff' },
};
const LOCK_SCREEN_TEXT = 'rgba(255,255,255,0.92)'; // lock screen widgets render in one tint

// --- Data sources ---

const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

async function fixtureResponder(url) {
  const u = new URL(url);
  if (u.pathname.endsWith('/psi')) return { status: 200, json: readFixture('psi-latest.json') };
  const { today, yesterday } = sgtDateStrings(FIXTURE_NOW);
  const file = { [today]: 'pm25-today.json', [yesterday]: 'pm25-yesterday.json' }[u.searchParams.get('date')];
  return file ? { status: 200, json: readFixture(file) } : { status: 404, json: readFixture('pm25-not-found.json') };
}

// Fetches each URL once per preview, so several widget renders don't trip the API's rate limit.
function liveResponder() {
  const seen = new Map();
  return (url) => {
    if (!seen.has(url)) {
      seen.set(url, fetch(url).then(async (res) => ({ status: res.status, json: await res.json() })));
    }
    return seen.get(url);
  };
}

async function offlineResponder() {
  throw new Error('offline (preview)');
}

// --- Scriptable stand-ins: just enough of the API that widget.js uses ---

class Color {
  constructor(hex, alpha = 1) { this.hex = hex; this.alpha = alpha; }
  static dynamic(light, dark) { return { light, dark }; }
}

const WEIGHTS = {
  ultralight: 100, thin: 200, light: 300, regular: 400, medium: 500,
  semibold: 600, bold: 700, heavy: 800, black: 900,
};
const Font = new Proxy({}, {
  get: (_, name) => (size) => {
    const n = String(name);
    const weight = Object.entries(WEIGHTS).find(([w]) => n.toLowerCase().startsWith(w))?.[1] ?? 400;
    return { size, weight, rounded: n.includes('Rounded'), italic: /italic/i.test(n) };
  },
});

class Size { constructor(width, height) { this.width = width; this.height = height; } }
class Point { constructor(x, y) { this.x = x; this.y = y; } }
class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }

class Path {
  constructor() { this.ops = []; }
  move(p) { this.ops.push(`M${p.x} ${p.y}`); }
  addLine(p) { this.ops.push(`L${p.x} ${p.y}`); }
  addLines(points) { points.forEach((p, i) => this.ops.push(`${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`)); }
  closeSubpath() { this.ops.push('Z'); }
}

class DrawContext {
  constructor() {
    this.size = new Size(0, 0);
    this.elements = [];
    this.paths = [];
    this.stroke = null;
    this.fill = null;
    this.lineWidth = 1;
  }
  setStrokeColor(c) { this.stroke = c; }
  setFillColor(c) { this.fill = c; }
  setLineWidth(w) { this.lineWidth = w; }
  addPath(p) { this.paths.push(p.ops.join(' ')); }
  strokePath() {
    for (const d of this.paths) this.elements.push({ tag: 'path', d, stroke: this.stroke, width: this.lineWidth });
    this.paths = [];
  }
  fillPath() {
    for (const d of this.paths) this.elements.push({ tag: 'path', d, fill: this.fill });
    this.paths = [];
  }
  fillEllipse(r) { this.elements.push({ tag: 'ellipse', rect: r, fill: this.fill }); }
  fillRect(r) { this.elements.push({ tag: 'rect', rect: r, fill: this.fill }); }
  getImage() {
    return { kind: 'drawing', width: this.size.width, height: this.size.height, elements: [...this.elements] };
  }
}

class WidgetText {
  constructor(text) { this.kind = 'text'; this.text = String(text); this.align = 'left'; }
  leftAlignText() { this.align = 'left'; }
  centerAlignText() { this.align = 'center'; }
  rightAlignText() { this.align = 'right'; }
}

class WidgetImage {
  constructor(image) { this.kind = 'image'; this.image = image; this.imageSize = null; }
  leftAlignImage() {}
  centerAlignImage() {}
  rightAlignImage() {}
}

class WidgetStack {
  constructor() {
    this.kind = 'stack';
    this.children = [];
    this.vertical = false;
    this.align = 'flex-start';
    this.spacing = 0;
    this.padding = null;
    this.size = null;
  }
  layoutVertically() { this.vertical = true; }
  layoutHorizontally() { this.vertical = false; }
  topAlignContent() { this.align = 'flex-start'; }
  centerAlignContent() { this.align = 'center'; }
  bottomAlignContent() { this.align = 'flex-end'; }
  setPadding(top, leading, bottom, trailing) { this.padding = [top, leading, bottom, trailing]; }
  useDefaultPadding() { this.padding = null; }
  addStack() { return this.push(new WidgetStack()); }
  addText(text) { return this.push(new WidgetText(text)); }
  addImage(image) { return this.push(new WidgetImage(image)); }
  addSpacer(length) { return this.push({ kind: 'spacer', length: length ?? null }); }
  push(node) { this.children.push(node); return node; }
}

class ListWidget extends WidgetStack {
  constructor() { super(); this.kind = 'widget'; this.vertical = true; }
  presentSmall() {}
  presentMedium() {}
  presentLarge() {}
  presentAccessoryRectangular() {}
}

// Runs the bundle once as a home or lock screen widget and returns the ListWidget it built.
async function runWidget(source, { family, region, now, responder, files }) {
  let widget = null;
  const RealDate = Date;
  class PreviewDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  }
  class Request {
    constructor(url) { this.url = url; this.headers = {}; this.response = {}; }
    async loadJSON() {
      const { status, json } = await responder(this.url);
      this.response.statusCode = status;
      return json;
    }
  }
  const fm = {
    documentsDirectory: () => '/documents',
    joinPath: (a, b) => `${a}/${b}`,
    readString: (p) => { if (!(p in files)) throw new Error(`no file ${p}`); return files[p]; },
    writeString: (p, s) => { files[p] = s; },
  };
  const quiet = { log() {}, warn() {}, error() {} };
  const sandbox = {
    console: quiet, Date: PreviewDate, Request, Color, Font, Size, Point, Rect, Path, DrawContext, ListWidget,
    Keychain: { contains: () => false, get: () => null, set() {}, remove() {} },
    FileManager: { local: () => fm, iCloud: () => fm },
    Alert: class { constructor() { throw new Error('Alert is not available in the preview'); } },
    Script: { setWidget: (w) => { widget = w; }, complete() {} },
    args: { widgetParameter: region },
    config: { runsInWidget: true, runsInApp: false, widgetFamily: family },
  };
  vm.createContext(sandbox);
  try {
    await vm.runInContext(`(async () => {\n${source}\n})()`, sandbox, { filename: 'SG Haze.js' });
  } catch (e) {
    throw new Error(`preview of ${family} widget failed: ${e.message}`);
  }
  if (!widget) throw new Error(`preview of ${family} widget: script never called Script.setWidget`);
  return widget;
}

// --- HTML rendering ---

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function cssColour(c, theme) {
  const resolved = c && 'light' in c ? c[theme] : c;
  if (!resolved) return null;
  const n = parseInt(resolved.hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${resolved.alpha})`;
}

function renderDrawing(drawing, size, theme) {
  const [w, h] = size ? [size.width, size.height] : [drawing.width, drawing.height];
  const els = drawing.elements.map((e) => {
    const fill = cssColour(e.fill, theme) ?? 'none';
    if (e.tag === 'path') {
      return e.stroke
        ? `<path d="${e.d}" fill="none" stroke="${cssColour(e.stroke, theme)}" stroke-width="${e.width}" stroke-linejoin="round" stroke-linecap="round"/>`
        : `<path d="${e.d}" fill="${fill}"/>`;
    }
    const { x, y, width, height } = e.rect;
    return e.tag === 'ellipse'
      ? `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${fill}"/>`
      : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"/>`;
  }).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${drawing.width} ${drawing.height}" style="flex-shrink:0;display:block">${els}</svg>`;
}

function renderNode(node, ctx, parentVertical) {
  if (node.kind === 'spacer') {
    if (node.length == null) return '<div style="flex:1 1 0"></div>';
    return `<div style="flex:0 0 ${node.length}px"></div>`;
  }
  if (node.kind === 'text') {
    const f = node.font ?? { size: 17, weight: 400 };
    const colour = ctx.lockScreen ? LOCK_SCREEN_TEXT : (cssColour(node.textColor, ctx.theme) ?? THEMES[ctx.theme].text);
    const wrap = node.lineLimit === 1 ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' : '';
    const family = f.rounded ? 'ui-rounded,-apple-system,system-ui,sans-serif' : '-apple-system,system-ui,sans-serif';
    return `<div style="font:${f.italic ? 'italic ' : ''}${f.weight} ${f.size}px/1.2 ${family};color:${colour};${wrap}text-align:${node.align};max-width:100%;min-width:0">${escapeHtml(node.text)}</div>`;
  }
  if (node.kind === 'image') {
    return node.image?.kind === 'drawing' ? renderDrawing(node.image, node.imageSize, ctx.theme) : '<div>[image]</div>';
  }
  // Stack. One that holds a flexible spacer fills its parent's width, as in WidgetKit.
  const stretches = node.children.some((c) => c.kind === 'spacer' && c.length == null);
  const style = [
    'display:flex',
    `flex-direction:${node.vertical ? 'column' : 'row'}`,
    `align-items:${node.align}`,
    `gap:${node.spacing}px`,
    'min-width:0',
    stretches && parentVertical ? 'align-self:stretch' : '',
    stretches && !parentVertical ? 'flex:1 1 0' : '',
    node.size?.width ? `width:${node.size.width}px;flex-shrink:0` : '',
    node.size?.height ? `height:${node.size.height}px` : '',
    node.padding ? `padding:${node.padding.map((p) => `${p}px`).join(' ')}` : '',
    node.backgroundColor ? `background:${cssColour(node.backgroundColor, ctx.theme)}` : '',
    node.cornerRadius ? `border-radius:${node.cornerRadius}px` : '',
  ].filter(Boolean).join(';');
  return `<div style="${style}">${node.children.map((c) => renderNode(c, ctx, node.vertical)).join('')}</div>`;
}

function renderWidget(widget, family, theme) {
  const lockScreen = family.startsWith('accessory');
  const [w, h] = SIZES[family];
  const padding = widget.padding ?? (lockScreen ? [0, 0, 0, 0] : [16, 16, 16, 16]);
  // Lock screen widgets sit on the wallpaper whatever the theme, so show them on a dark one.
  const background = lockScreen ? '#3a3a3c' : cssColour(widget.backgroundColor, theme) ?? '#fff';
  const ctx = { theme, lockScreen };
  const children = widget.children.map((c) => renderNode(c, ctx, true)).join('');
  return `<figure data-family="${family}">
  <div class="widget${lockScreen ? ' lock' : ''}" style="width:${w}px;height:${h}px;padding:${padding.map((p) => `${p}px`).join(' ')};background:${background}">${children}</div>
  <figcaption>${family} · ${w}×${h}</figcaption>
</figure>`;
}

function pageHtml(rows, { region, live, now }) {
  const when = new Date(now + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const sections = rows.map(({ state, widgets }) => `<section data-state="${state.id}">
<h2>${state.label}</h2>
${Object.keys(THEMES).map((theme) => `<div class="theme" data-theme="${theme}">
${Object.entries(widgets).map(([family, w]) => renderWidget(w, family, theme)).join('\n')}
</div>`).join('\n')}
</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SG Haze preview</title>
<style>
  body { margin: 0; padding: 24px 16px; font: 14px/1.4 -apple-system, system-ui, sans-serif; background: #f5f5f7; color: #1d1d1f; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; }
  p.note { margin: 0; color: #6e6e73; max-width: 70ch; }
  .theme { display: flex; flex-wrap: wrap; gap: 20px; padding: 20px; border-radius: 14px; margin-bottom: 12px; }
  .theme[data-theme="light"] { background: ${THEMES.light.page}; }
  .theme[data-theme="dark"] { background: ${THEMES.dark.page}; }
  .theme[data-theme="dark"] figcaption { color: #98989d; }
  figure { margin: 0; }
  figcaption { font-size: 11px; color: #6e6e73; margin-top: 6px; }
  .widget { box-sizing: border-box; border-radius: 22px; overflow: hidden; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; }
  .widget.lock { border-radius: 14px; }
</style>
</head>
<body>
<h1>SG Haze preview · ${escapeHtml(region || '(empty: central)')}</h1>
<p class="note">${live ? 'Live data' : 'Fixture data'} at ${when} SGT. An approximation of iOS layout at 6.1-inch iPhone sizes: fonts and spacing differ slightly, and text doesn't shrink to fit as it does on iOS. The phone has the final say.</p>
${sections}
</body>
</html>
`;
}

// Builds the page for a region. `source` overrides the bundle (used by tests).
async function renderPreview({ region = '', live = false, source } = {}) {
  const script = source ?? buildBundle();
  const now = live ? Date.now() : FIXTURE_NOW;
  const online = live ? liveResponder() : fixtureResponder;
  const rows = [];
  for (const state of STATES) {
    const files = {};
    if (state.saved) await runWidget(script, { family: 'small', region, now, responder: online, files });
    const responder = state.offline ? offlineResponder : online;
    const widgets = {};
    for (const family of Object.keys(SIZES)) {
      widgets[family] = await runWidget(script, { family, region, now, responder, files });
    }
    rows.push({ state, widgets });
  }
  return pageHtml(rows, { region, live, now });
}

async function main() {
  const argv = process.argv.slice(2);
  const region = argv.find((a) => !a.startsWith('--')) ?? '';
  const html = await renderPreview({ region, live: argv.includes('--live') });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
  if (!argv.includes('--no-open')) execFile('open', [OUT]);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { renderPreview };
