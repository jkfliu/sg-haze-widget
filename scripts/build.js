#!/usr/bin/env node
// Combines src/core.js and src/widget.js into one Scriptable script: dist/SG Haze.js.
// VERSION and UPDATE_REPO are set from package.json's "version" and "updateRepo".
// Usage: node scripts/build.js

const fs = require('node:fs');
const path = require('node:path');
const { isVersion, updateUrl, versionLine, SCRIPTABLE_HEADER } = require('../src/core.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'SG Haze.js');

const HEADER = [
  SCRIPTABLE_HEADER,
  '// These must be at the very top of the file. Do not edit.',
  '// icon-color: blue; icon-glyph: smog;',
].join('\n');

const EXPORTS = /^module\.exports = \{[\s\S]*?^\};\n?/m;
const REQUIRE_CORE = /^const \{[^}]*\} = require\('\.\/core\.js'\);\n?/m;
const VERSION_LINE = /^const VERSION = '[^']*';$/m;
const REPO_LINE = /^const UPDATE_REPO = '[^']*';$/m;

// Throws rather than silently leaving CommonJS in the bundle, which Scriptable can't run.
function strip(source, pattern, what) {
  if (!pattern.test(source)) throw new Error(`build: expected ${what} to strip`);
  return source.replace(pattern, '');
}

function setLine(source, pattern, line, what) {
  if (!pattern.test(source)) throw new Error(`build: expected a ${what} line in widget.js`);
  return source.replace(pattern, line);
}

function bundle(coreSource, widgetSource, { version, updateRepo } = {}) {
  // Validated with the same rules the installed widget uses, so a built script can always update.
  if (!isVersion(version)) throw new Error(`build: bad version ${version}`);
  if (!updateUrl(updateRepo)) throw new Error(`build: bad update repo ${updateRepo}`);
  const core = strip(coreSource, EXPORTS, 'module.exports in core.js').trimEnd();
  let widget = strip(widgetSource, REQUIRE_CORE, "require('./core.js') in widget.js").trim();
  widget = setLine(widget, VERSION_LINE, versionLine(version), 'VERSION');
  widget = setLine(widget, REPO_LINE, `const UPDATE_REPO = '${updateRepo}';`, 'UPDATE_REPO');
  return `${HEADER}\n\n${core}\n\n${widget}\n`;
}

// The bundle for the current sources and package.json.
function buildBundle() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const { version, updateRepo } = JSON.parse(read('package.json'));
  return bundle(read('src/core.js'), read('src/widget.js'), { version, updateRepo });
}

function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buildBundle());
  console.log(`built ${path.relative(ROOT, OUT)}`);
}

if (require.main === module) main();

module.exports = { bundle, buildBundle };
