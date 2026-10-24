const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { renderPreview } = require('../scripts/preview.js');

// The <section> for one state, e.g. 'normal', 'offline-saved', 'offline-empty'.
const section = (html, state) => {
  const match = html.match(new RegExp(`<section data-state="${state}"[\\s\\S]*?</section>`));
  assert.ok(match, `no section for ${state}`);
  return match[0];
};

// Rendering is deterministic with fixtures, so the west preview is built once and shared.
let westHtml;
const westPreview = () => (westHtml ??= renderPreview({ region: 'west' }));

describe('renderPreview with fixtures', () => {
  test('shows the readings for the region in every widget size', async () => {
    const normal = section(await westPreview(), 'normal');
    for (const text of [
      'West', 'PM2.5 1h', '76', 'Elevated', 'PSI 24h', '152', 'Unhealthy',
      'Updated 3:00pm', 'Checked 3:52pm', // small/medium
      'West · PM2.5 76 Elevated', 'PSI 152 Unhealthy', // lock screen
    ]) assert.ok(normal.includes(text), `missing: ${text}`);
    for (const family of ['small', 'medium', 'accessoryRectangular']) {
      assert.ok(normal.includes(`data-family="${family}"`), `missing family ${family}`);
    }
  });

  test('draws the 24-hour chart as one unbroken 24-point black line', async () => {
    const normal = section(await westPreview(), 'normal');
    const lines = [...normal.matchAll(/<path d="([^"]*)" fill="none" stroke="([^"]*)"/g)];
    const line = lines.find(([, d]) => (d.match(/L/g) ?? []).length === 23);
    assert.ok(line, 'no 24-point line');
    assert.equal(line[2], 'rgba(0,0,0,1)');
  });

  test('draws coloured band backgrounds behind the chart', async () => {
    const normal = section(await westPreview(), 'normal');
    assert.ok((normal.match(/<rect /g) ?? []).length >= 2, 'expected band rectangles');
  });

  test('footer says the chart is PM2.5 over 24 hours', async () => {
    const normal = section(await westPreview(), 'normal');
    assert.ok(normal.includes('PM2.5 24h · Updated 3:00pm'));
  });

  test('renders each size in light and dark', async () => {
    const html = await westPreview();
    assert.ok(html.includes('data-theme="light"'));
    assert.ok(html.includes('data-theme="dark"'));
  });

  test('offline with saved data shows the saved readings marked stale', async () => {
    const offline = section(await westPreview(), 'offline-saved');
    assert.ok(offline.includes('⚠ stale'));
    assert.ok(offline.includes('76'));
  });

  test('offline with nothing saved shows dashes, not readings', async () => {
    const empty = section(await westPreview(), 'offline-empty');
    assert.ok(empty.includes('–'));
    assert.ok(!empty.includes('76'));
  });

  test('lock screen with nothing saved says "stale" without a stray separator', async () => {
    const empty = section(await westPreview(), 'offline-empty');
    assert.ok(empty.includes('>Stale<'), 'expected a standalone "Stale" line');
    assert.ok(!empty.includes('>· stale<'));
  });

  test('an empty or unknown region previews central', async () => {
    const normal = section(await renderPreview({ region: '' }), 'normal');
    assert.ok(normal.includes('Central · PM2.5 64 Elevated'));
  });

  test('a script that fails names the widget size in the error', async () => {
    await assert.rejects(renderPreview({ source: 'notAScriptableApi();' }), /small.*notAScriptableApi/s);
  });

  test('a script that never calls Script.setWidget is reported', async () => {
    await assert.rejects(renderPreview({ source: 'Script.complete();' }), /setWidget/);
  });
});

// Opt-in: hits the real API. Run with LIVE=1.
test('live preview renders current data', { skip: !process.env.LIVE }, async () => {
  const html = await renderPreview({ region: 'central', live: true });
  assert.match(section(html, 'normal'), /Updated \d{1,2}:\d{2}[ap]m/);
});
