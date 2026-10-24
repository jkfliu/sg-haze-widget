# SG Haze

A [Scriptable](https://scriptable.app) widget for iPhone that shows Singapore haze data for one region:

- the latest **1-hour PM2.5** reading and its NEA band (Normal, Elevated, High or Very High)
- the latest **24-hour PSI** reading and its band
- a **chart of 1-hour PM2.5 over the last 24 hours**, drawn as a black line over coloured NEA bands

Data comes from [data.gov.sg](https://data.gov.sg) (NEA). Tapping the widget opens [haze.gov.sg](https://www.haze.gov.sg).

## Using the widget

### Install the script

You need the free Scriptable app from the App Store.

- **From this Mac:** run `npm run deploy` (see [Development](#development)). This copies `SG Haze.js` into Scriptable's iCloud folder, and it appears in Scriptable on the phone within a minute or so.
- **By hand:** copy the contents of `dist/SG Haze.js` (from `npm run build`) into a new script in Scriptable, and name it `SG Haze`.

### Add a home screen widget

1. Long-press an empty spot on the home screen and tap **+** (or **Edit → Add Widget**).
2. Choose **Scriptable**, pick the **small** or **medium** size, and tap **Add Widget**.
3. Long-press the new widget and choose **Edit Widget**.
4. Set **Script** to `SG Haze`.
5. Set **Parameter** to the region you want (see below). Leave it empty for `central`.

### Add a lock screen widget

1. Long-press the lock screen, tap **Customise**, then the lock screen.
2. Tap the widget area, choose **Scriptable**, and add the **rectangular** widget.
3. Tap it and set **Script** and **Parameter** as above.

The lock screen version is text only: PM2.5, PSI and the time of the reading.

### Region parameter

| Parameter | Region |
|-----------|--------|
| `north`   | North  |
| `south`   | South  |
| `east`    | East   |
| `west`    | West   |
| `central` | Central (also used for an empty or unrecognised value) |

Capitals and spaces don't matter: ` West ` works. Each widget has its own parameter, so you can have one widget per region.

### What the widget shows

- **Updated 3:00pm** is the hour the reading is for. NEA publishes each hour's reading about 45 minutes later.
- **Checked 3:52pm** (medium only) is when the widget last fetched data successfully.
- **⚠ stale** means the data couldn't be refreshed, so the widget is showing the last saved readings, or the latest reading is more than 2 hours old.
- The widget asks iOS to refresh at 50 minutes past each hour. iOS decides the actual timing, so updates can be later.

### Optional API key

The widget works without a key. data.gov.sg limits requests without one, though at 3 requests an hour the widget shouldn't hit that limit. If you have a key:

1. Open Scriptable and tap **SG Haze**.
2. Choose **Set API key** and paste it in.

The key is stored in the iPhone's Keychain and sent only to data.gov.sg. The same menu can change or clear it, and preview each widget size. The previews always show `central`.

## Development

Requires Node 20 or later (`.nvmrc` pins 22, so run `nvm use`). There are no dependencies to install.

| Command | What it does |
|---------|--------------|
| `npm test` | Runs all tests |
| `npm run coverage` | Runs tests with line and branch coverage |
| `npm run build` | Bundles `src/core.js` and `src/widget.js` into `dist/SG Haze.js` |
| `npm run deploy` | Builds, then copies the bundle into the iCloud Scriptable folder |
| `npm run preview -- west` | Writes `dist/preview.html` and opens it: every widget size in light and dark mode, normal and offline. Add `--live` for current data, or `--no-open` to skip opening it |
| `npm run fixtures` | Downloads fresh API responses into `test/fixtures/` |
| `LIVE=1 npm test` | Also runs the opt-in test against the live API |

The preview runs the real bundle with stand-in versions of Scriptable's widget classes, so it shows what the code builds. It's an approximation of iOS layout, though: check final spacing and text fitting on the phone.

### Layout

```
src/core.js          pure logic: parsing, time window, bands, chart geometry, formatting (fully tested)
src/widget.js        Scriptable layer: requests, cache, Keychain, drawing, layouts, in-app menu
scripts/build.js     bundles core + widget into one script for Scriptable
scripts/deploy.sh    builds and copies the bundle to iCloud
scripts/preview.js   renders the widget as HTML on the Mac
scripts/fetch-fixtures.js  captures real API responses
test/                Node tests (node --test); fixtures in test/fixtures/
```

All logic lives in `src/core.js` and is tested under Node. `src/widget.js` is kept thin because it only runs inside Scriptable. The preview tests exercise it through the stand-in classes.

### Further reading

- [PLAN.md](PLAN.md): the original phased plan
- [DECISIONS.md](DECISIONS.md): changes to the plan agreed along the way
- [test/fixtures/README.md](test/fixtures/README.md): the API's response shape and quirks
