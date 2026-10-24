const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  compareVersions, parseManifest, shouldCheckForUpdate, updateUrl, isPlausibleUpdate,
} = require('../src/core.js');
const { mulberry32 } = require('./helpers.js');

const HOUR = 3600e3;

describe('compareVersions', () => {
  test('compares numerically, not as text: 1.10.0 is newer than 1.9.0', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  });

  test('equal versions compare as 0', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  test('major outranks minor, minor outranks patch', () => {
    assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
    assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
    assert.equal(compareVersions('1.1.2', '1.1.10'), -1);
  });

  test('returns null when either side is malformed', () => {
    for (const bad of ['', '1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '1.-2.3', ' 1.2.3', null, undefined, 123, 'dev']) {
      assert.equal(compareVersions(bad, '1.0.0'), null, `a=${bad}`);
      assert.equal(compareVersions('1.0.0', bad), null, `b=${bad}`);
    }
  });

  test('properties: antisymmetric and consistent with equality', () => {
    const rand = mulberry32(17);
    const v = () => [0, 0, 0].map(() => Math.floor(rand() * 12)).join('.');
    for (let i = 0; i < 500; i++) {
      const [a, b] = [v(), v()];
      assert.equal(compareVersions(a, b), -compareVersions(b, a) || 0);
      assert.equal(compareVersions(a, b) === 0, a === b);
    }
  });
});

describe('parseManifest', () => {
  test('reads version and notes from JSON text', () => {
    assert.deepEqual(parseManifest('{"version":"1.1.0","notes":"Bigger chart"}'),
      { version: '1.1.0', notes: 'Bigger chart' });
  });

  test('missing or non-string notes become an empty string', () => {
    assert.deepEqual(parseManifest('{"version":"1.1.0"}'), { version: '1.1.0', notes: '' });
    assert.deepEqual(parseManifest('{"version":"1.1.0","notes":42}'), { version: '1.1.0', notes: '' });
  });

  test('ignores extra fields', () => {
    assert.deepEqual(parseManifest('{"version":"1.1.0","notes":"","script":"evil"}'), { version: '1.1.0', notes: '' });
  });

  test('returns null for invalid JSON, a missing or malformed version, or non-objects', () => {
    for (const bad of ['', 'not json', '{"version":', '[]', 'null', '"1.0.0"', '{}', '{"version":"1.0"}',
      '{"version":1}', null, undefined]) {
      assert.equal(parseManifest(bad), null, `input: ${bad}`);
    }
  });
});

describe('shouldCheckForUpdate', () => {
  const now = Date.parse('2026-10-24T15:52:00+08:00');

  test('checks when it has never checked', () => {
    assert.equal(shouldCheckForUpdate(null, now), true);
    assert.equal(shouldCheckForUpdate(undefined, now), true);
    assert.equal(shouldCheckForUpdate(NaN, now), true);
  });

  test('does not check again within a day', () => {
    assert.equal(shouldCheckForUpdate(now - HOUR, now), false);
    assert.equal(shouldCheckForUpdate(now - 24 * HOUR + 1, now), false);
  });

  test('checks again once a full day has passed', () => {
    assert.equal(shouldCheckForUpdate(now - 24 * HOUR, now), true);
    assert.equal(shouldCheckForUpdate(now - 30 * 24 * HOUR, now), true);
  });

  test('checks if the last check is in the future (clock was changed)', () => {
    assert.equal(shouldCheckForUpdate(now + HOUR, now), true);
  });

  test('accepts Dates as well as epoch ms', () => {
    assert.equal(shouldCheckForUpdate(new Date(now - HOUR), new Date(now)), false);
  });
});

describe('updateUrl', () => {
  test('builds raw GitHub URLs for version.json and the released script on main', () => {
    assert.deepEqual(updateUrl('jkfliu/sg-haze-widget'), {
      manifest: 'https://raw.githubusercontent.com/jkfliu/sg-haze-widget/main/version.json',
      script: 'https://raw.githubusercontent.com/jkfliu/sg-haze-widget/main/release/SG%20Haze.js',
    });
  });

  test('returns null for anything that is not owner/repo', () => {
    for (const bad of ['', 'jkfliu', 'jkfliu/', '/repo', 'a/b/c', 'https://github.com/a/b', 'a/b?x=1', 'a b/c', '../x', null]) {
      assert.equal(updateUrl(bad), null, `input: ${bad}`);
    }
  });
});

describe('isPlausibleUpdate', () => {
  const script = (version) => [
    '// Variables used by Scriptable.',
    '// These must be at the very top of the file. Do not edit.',
    '// icon-color: blue; icon-glyph: smog;',
    '',
    `const VERSION = '${version}';`,
    'Script.complete();',
  ].join('\n');

  test('accepts a Scriptable script carrying the expected newer version', () => {
    assert.deepEqual(isPlausibleUpdate(script('1.1.0'), '1.1.0', '1.0.0'), { ok: true });
  });

  test('rejects an empty or non-string download', () => {
    for (const bad of ['', '   ', null, undefined]) {
      assert.equal(isPlausibleUpdate(bad, '1.1.0', '1.0.0').ok, false);
    }
  });

  test('rejects a download whose VERSION line does not match the manifest', () => {
    const result = isPlausibleUpdate(script('1.0.5'), '1.1.0', '1.0.0');
    assert.equal(result.ok, false);
    assert.match(result.reason, /version/i);
  });

  test('rejects something that is not a Scriptable script, e.g. an HTML error page', () => {
    const result = isPlausibleUpdate("<html>404</html>\nconst VERSION = '1.1.0';", '1.1.0', '1.0.0');
    assert.equal(result.ok, false);
    assert.match(result.reason, /Scriptable/);
  });

  test('refuses a version that is not newer than the installed one (DECISIONS.md #5)', () => {
    assert.equal(isPlausibleUpdate(script('1.0.0'), '1.0.0', '1.0.0').ok, false);
    const older = isPlausibleUpdate(script('0.9.0'), '0.9.0', '1.0.0');
    assert.equal(older.ok, false);
    assert.match(older.reason, /newer/);
  });

  test('refuses when either version is malformed', () => {
    assert.equal(isPlausibleUpdate(script('dev'), 'dev', '1.0.0').ok, false);
    assert.equal(isPlausibleUpdate(script('1.1.0'), '1.1.0', 'dev').ok, false);
  });
});
