#!/usr/bin/env node
// Combines src/core.js and src/widget.js into one Scriptable script: dist/SG Haze.js.
// Usage: node scripts/build.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'SG Haze.js');

const HEADER = [
  '// Variables used by Scriptable.',
  '// These must be at the very top of the file. Do not edit.',
  '// icon-color: blue; icon-glyph: smog;',
].join('\n');

const EXPORTS = /^module\.exports = \{[\s\S]*?^\};\n?/m;
const REQUIRE_CORE = /^const \{[^}]*\} = require\('\.\/core\.js'\);\n?/m;

// Throws rather than silently leaving CommonJS in the bundle, which Scriptable can't run.
function strip(source, pattern, what) {
  if (!pattern.test(source)) throw new Error(`build: expected ${what} to strip`);
  return source.replace(pattern, '');
}

function bundle(coreSource, widgetSource) {
  const core = strip(coreSource, EXPORTS, 'module.exports in core.js').trimEnd();
  const widget = strip(widgetSource, REQUIRE_CORE, "require('./core.js') in widget.js").trim();
  return `${HEADER}\n\n${core}\n\n${widget}\n`;
}

function main() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bundle(read('src/core.js'), read('src/widget.js')));
  console.log(`built ${path.relative(ROOT, OUT)}`);
}

if (require.main === module) main();

module.exports = { bundle };
