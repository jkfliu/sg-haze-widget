const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bundle } = require('../scripts/build.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Scriptable runs scripts with top-level await, so parse inside an async function.
const parses = (src) => new vm.Script(`(async () => {\n${src}\n})`);

describe('bundle with small inputs', () => {
  const core = 'function a() { return 1; }\n\nmodule.exports = {\n  a,\n};\n';
  const widget = "const { a } = require('./core.js');\n\nawait a();\n";

  test('strips the multi-line module.exports from core', () => {
    const out = bundle(core, widget);
    assert.ok(!out.includes('module.exports'));
    assert.ok(out.includes('function a() { return 1; }'));
  });

  test('strips the require of core.js from the widget', () => {
    const out = bundle(core, widget);
    assert.ok(!out.includes('require('));
    assert.ok(out.includes('await a();'));
  });

  test('puts core before the widget code', () => {
    const out = bundle(core, widget);
    assert.ok(out.indexOf('function a()') < out.indexOf('await a();'));
  });

  test('starts with the Scriptable icon header', () => {
    const lines = bundle(core, widget).split('\n');
    assert.equal(lines[0], '// Variables used by Scriptable.');
    assert.equal(lines[1], '// These must be at the very top of the file. Do not edit.');
    assert.match(lines[2], /^\/\/ icon-color: [\w-]+; icon-glyph: [\w-]+;$/);
  });

  test('throws if core has no module.exports to strip', () => {
    assert.throws(() => bundle('function a() {}\n', widget), /module\.exports/);
  });

  test('throws if the widget has no require of core.js to strip', () => {
    assert.throws(() => bundle(core, 'await a();\n'), /require/);
  });
});

describe('bundle of the real sources', () => {
  const out = bundle(read('src/core.js'), read('src/widget.js'));

  test('parses as JavaScript with top-level await', () => {
    assert.doesNotThrow(() => parses(out));
  });

  test('has no leftover CommonJS', () => {
    assert.ok(!/\brequire\(|module\.exports/.test(out));
  });

  test('a name declared in both files fails to parse, so the test above catches clashes', () => {
    assert.throws(() => parses(`${out}\nconst HOUR = 1;\n`), SyntaxError);
  });
});
