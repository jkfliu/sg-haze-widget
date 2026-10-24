const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bundle, buildBundle } = require('../scripts/build.js');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// Scriptable runs scripts with top-level await, so parse inside an async function.
const parses = (src) => new vm.Script(`(async () => {\n${src}\n})`);

describe('bundle with small inputs', () => {
  const core = 'function a() { return 1; }\n\nmodule.exports = {\n  a,\n};\n';
  const widget = [
    "const { a } = require('./core.js');",
    '',
    "const VERSION = 'dev';",
    "const UPDATE_REPO = '';",
    '',
    'await a();',
    '',
  ].join('\n');
  const opts = { version: '1.2.3', updateRepo: 'jkfliu/sg-haze-widget' };

  test('strips the multi-line module.exports from core', () => {
    const out = bundle(core, widget, opts);
    assert.ok(!out.includes('module.exports'));
    assert.ok(out.includes('function a() { return 1; }'));
  });

  test('strips the require of core.js from the widget', () => {
    const out = bundle(core, widget, opts);
    assert.ok(!out.includes('require('));
    assert.ok(out.includes('await a();'));
  });

  test('puts core before the widget code', () => {
    const out = bundle(core, widget, opts);
    assert.ok(out.indexOf('function a()') < out.indexOf('await a();'));
  });

  test('starts with the Scriptable icon header', () => {
    const lines = bundle(core, widget, opts).split('\n');
    assert.equal(lines[0], '// Variables used by Scriptable.');
    assert.equal(lines[1], '// These must be at the very top of the file. Do not edit.');
    assert.match(lines[2], /^\/\/ icon-color: [\w-]+; icon-glyph: [\w-]+;$/);
  });

  test('sets VERSION and UPDATE_REPO', () => {
    const out = bundle(core, widget, opts);
    assert.match(out, /^const VERSION = '1\.2\.3';$/m);
    assert.match(out, /^const UPDATE_REPO = 'jkfliu\/sg-haze-widget';$/m);
    assert.ok(!out.includes("'dev'"));
  });

  test('throws if core has no module.exports to strip', () => {
    assert.throws(() => bundle('function a() {}\n', widget, opts), /module\.exports/);
  });

  test('throws if the widget has no require of core.js to strip', () => {
    assert.throws(() => bundle(core, widget.replace(/^const \{ a \}.*\n/, ''), opts), /require/);
  });

  test('throws if the widget has no VERSION or UPDATE_REPO line to set', () => {
    assert.throws(() => bundle(core, widget.replace(/^const VERSION.*\n/m, ''), opts), /VERSION/);
    assert.throws(() => bundle(core, widget.replace(/^const UPDATE_REPO.*\n/m, ''), opts), /UPDATE_REPO/);
  });

  test('throws on a malformed version or repo, so nothing odd gets baked in', () => {
    assert.throws(() => bundle(core, widget, { ...opts, version: '1.2' }), /version/);
    assert.throws(() => bundle(core, widget, { ...opts, version: "1.0.0'; evil()//" }), /version/);
    assert.throws(() => bundle(core, widget, { ...opts, updateRepo: 'not a repo' }), /repo/);
    assert.throws(() => bundle(core, widget, { ...opts, updateRepo: undefined }), /repo/);
  });
});

describe('bundle of the real sources', () => {
  const out = buildBundle();

  test('parses as JavaScript with top-level await', () => {
    assert.doesNotThrow(() => parses(out));
  });

  test('has no leftover CommonJS', () => {
    assert.ok(!/\brequire\(|module\.exports/.test(out));
  });

  test('carries the version and update repo from package.json', () => {
    assert.ok(out.includes(`const VERSION = '${pkg.version}';`));
    assert.ok(out.includes(`const UPDATE_REPO = '${pkg.updateRepo}';`));
  });

  test('a name declared in both files fails to parse, so the test above catches clashes', () => {
    assert.throws(() => parses(`${out}\nconst HOUR = 1;\n`), SyntaxError);
  });
});
