const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { findSecrets } = require('../scripts/check-secrets.js');
const { buildBundle } = require('../scripts/build.js');

describe('findSecrets catches planted secrets', () => {
  const cases = {
    'x-api-key with a literal value': "req.headers = { 'x-api-key': 'abc123' };",
    'x-api-key with a double-quoted literal': 'headers["x-api-key"] = "abc123";',
    'a long key-like token': "const k = 'v2:aB3dE5gH7jK9mN1pQ3rS5tU7';",
    'a GitHub token': 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
    'an email address': '// contact someone@example.com',
    'a Mac home folder path': "const p = '/Users/someone/secrets.txt';",
  };
  for (const [name, source] of Object.entries(cases)) {
    test(name, () => assert.ok(findSecrets(source).length > 0, `not caught: ${source}`));
  }

  test('reports the line number', () => {
    const [finding] = findSecrets("const a = 1;\nconst b = 'x-api-key';\nh['x-api-key'] = 'abc123';");
    assert.equal(finding.line, 3);
  });
});

describe('findSecrets allows normal code', () => {
  test('x-api-key set from a variable', () => {
    assert.deepEqual(findSecrets("req.headers = { 'x-api-key': Keychain.get(KEYCHAIN_KEY) };"), []);
  });

  test('ordinary URLs, colours and identifiers', () => {
    const source = [
      "const API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';",
      "const c = '#3fae49';",
      "if (family === 'accessoryRectangular') {}",
    ].join('\n');
    assert.deepEqual(findSecrets(source), []);
  });

  test('ISO timestamps', () => {
    assert.deepEqual(findSecrets("const t = Date.parse('2026-10-24T15:52:00+08:00');"), []);
    assert.deepEqual(findSecrets('"timestamp": "2026-10-24T15:00:00.000Z"'), []);
  });

  test('an empty source', () => {
    assert.deepEqual(findSecrets(''), []);
  });
});

describe('the published bundle', () => {
  const bundle = buildBundle();

  test('contains no API key or personal data', () => {
    assert.deepEqual(findSecrets(bundle), []);
  });

  test('only talks to data.gov.sg, haze.gov.sg and the fixed GitHub repo', () => {
    const hosts = new Set([...bundle.matchAll(/https?:\/\/([^/'"`\s]+)/g)].map((m) => m[1]));
    assert.deepEqual([...hosts].sort(), ['api-open.data.gov.sg', 'raw.githubusercontent.com', 'www.haze.gov.sg']);
  });

  test('never runs downloaded code: no eval, Function constructor or importModule', () => {
    assert.ok(!/\beval\s*\(|new Function\s*\(|\bimportModule\s*\(/.test(bundle));
  });
});
