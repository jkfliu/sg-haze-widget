#!/usr/bin/env node
// Downloads real data.gov.sg responses into test/fixtures/ for the parser tests.
// Usage: node scripts/fetch-fixtures.js   (optional DATA_GOV_SG_API_KEY env var)

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const OUT = path.join(__dirname, '..', 'test', 'fixtures');
const REGIONS = ['north', 'south', 'east', 'west', 'central'];
const SEARCH_DAYS = 30;

// Singapore is UTC+8 with no daylight saving.
function sgtDate(daysAgo) {
  const d = new Date(Date.now() + 8 * 3600e3 - daysAgo * 86400e3);
  return d.toISOString().slice(0, 10);
}

// Unauthenticated requests are rate-limited after a handful of calls (HTTP 429), so back off and retry.
async function get(endpoint, date, attempt = 1) {
  const url = `${BASE}/${endpoint}${date ? `?date=${date}` : ''}`;
  const headers = {};
  if (process.env.DATA_GOV_SG_API_KEY) headers['x-api-key'] = process.env.DATA_GOV_SG_API_KEY;
  const res = await fetch(url, { headers });
  if (res.status === 429 && attempt <= 5) {
    const wait = 10e3 * attempt;
    console.log(`429 on ${date ?? 'latest'}, retrying in ${wait / 1000}s`);
    await sleep(wait);
    return get(endpoint, date, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function save(name, json) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(json, null, 2) + '\n');
  console.log(`saved ${name}`);
}

// A day is "gappy" if it has fewer than 24 hourly items or any region reading is missing/null.
function gapSummary(json) {
  const items = json?.data?.items ?? [];
  const missing = items.filter((it) =>
    REGIONS.some((r) => it?.readings?.pm25_one_hourly?.[r] == null));
  return { count: items.length, missingReadings: missing.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  save('pm25-today.json', await get('pm25', sgtDate(0)));
  save('pm25-yesterday.json', await get('pm25', sgtDate(1)));
  save('pm25-latest.json', await get('pm25'));
  save('psi-latest.json', await get('psi'));

  // Days 2..N back, since today is naturally partial and yesterday was saved above.
  for (let i = 2; i <= SEARCH_DAYS; i++) {
    const date = sgtDate(i);
    const json = await get('pm25', date);
    const { count, missingReadings } = gapSummary(json);
    if (count < 24 || missingReadings > 0) {
      console.log(`${date}: ${count} items, ${missingReadings} with missing readings`);
      save('pm25-gappy.json', json);
      return;
    }
    await sleep(2000); // stay under the unauthenticated rate limit
  }

  // No real gappy day found: derive a synthetic one from yesterday.
  const synthetic = JSON.parse(fs.readFileSync(path.join(OUT, 'pm25-yesterday.json'), 'utf8'));
  const dropHours = new Set(['03', '04', '05', '14']);
  synthetic.data.items = synthetic.data.items.filter(
    (it) => !dropHours.has(it.timestamp.slice(11, 13)));
  // One null reading as well, to cover a present hour with a missing region value.
  const nullItem = synthetic.data.items.find((it) => it.timestamp.slice(11, 13) === '10');
  if (nullItem) nullItem.readings.pm25_one_hourly.central = null;
  synthetic._synthetic = `Derived from pm25-yesterday.json: hours ${[...dropHours].join(', ')} removed; central at 10:00 set to null. No real gappy day found in the last ${SEARCH_DAYS} days.`;
  save('pm25-gappy.synthetic.json', synthetic);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
