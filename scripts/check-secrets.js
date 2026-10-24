#!/usr/bin/env node
// Scans a file for API keys and personal data before it's published. Exits 1 if anything is found.
// Usage: node scripts/check-secrets.js <file>

const fs = require('node:fs');

const RULES = [
  { reason: 'x-api-key with a literal value', pattern: /['"]x-api-key['"]\s*\]?\s*[:=]\s*['"][^'"]+['"]/ },
  { reason: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/ },
  { reason: 'email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  { reason: 'Mac home folder path', pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  // A quoted run of 24+ key-like characters mixing lowercase, uppercase and digits, as generated
  // keys do, with no '.' (so not a URL). Timestamps and identifiers lack one of the three.
  {
    reason: 'key-like token',
    pattern: /['"`](?=[^'"`]*\d)(?=[^'"`]*[a-z])(?=[^'"`]*[A-Z])[A-Za-z0-9_:+/=-]{24,}['"`]/,
  },
];

// [{ line, reason, text }] for every line that matches a rule.
function findSecrets(source) {
  const findings = [];
  String(source ?? '').split('\n').forEach((text, i) => {
    for (const { reason, pattern } of RULES) {
      if (pattern.test(text)) findings.push({ line: i + 1, reason, text: text.trim() });
    }
  });
  return findings;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/check-secrets.js <file>');
    process.exit(2);
  }
  const findings = findSecrets(fs.readFileSync(file, 'utf8'));
  for (const f of findings) console.error(`${file}:${f.line}: ${f.reason}: ${f.text}`);
  if (findings.length) process.exit(1);
  console.log(`no secrets found in ${file}`);
}

if (require.main === module) main();

module.exports = { findSecrets };
