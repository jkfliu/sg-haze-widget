# SG Haze — Scriptable widget

> Original plan. Agreed changes are recorded in [DECISIONS.md](DECISIONS.md) and take precedence.

## Goal
Build a Scriptable widget for the iOS Today View that shows Singapore haze data for one region:
- the latest **1-hr PM2.5** reading
- the latest **24-hr PSI** reading
- a **rolling 24-hour chart of 1-hr PM2.5**

The region is set per widget through Scriptable's Parameter field. If the field is empty, it defaults to `central`. The script should be easy to share with friends, with optional update checks.

## Ground rules
- Work test-first. Write a failing test, make it pass, then tidy up.
- After each phase, summarise what changed and wait for my approval before starting the next.
- Don't add dependencies. Use Node's built-in test runner (`node --test`) on Node 20 or later.
- All logic goes in pure functions tested under Node. Scriptable-specific code stays thin and untested.

## Data source
- Endpoints:
  - `https://api-open.data.gov.sg/v2/real-time/api/pm25`
  - `https://api-open.data.gov.sg/v2/real-time/api/psi`
- `?date=YYYY-MM-DD` returns all readings for that day. With no `date`, the endpoint returns only the latest reading.
- An API key is optional. If one is stored, send it in the `x-api-key` header.
- Regions: `north`, `south`, `east`, `west`, `central`. PSI also reports `national`.
- Don't assume the response shape. Phase 1 captures real responses, and the parsers are built from those.

## Repo layout
```
src/core.js         pure logic, exported with module.exports
src/widget.js       Scriptable code (requests, Keychain, file cache, drawing)
test/*.test.js      Node tests
test/fixtures/      real API responses
scripts/build.js    combines core + widget into dist/SG Haze.js
scripts/deploy.sh   copies dist into the iCloud Scriptable folder
scripts/release.sh  tests, build, version update
version.json        { "version": "1.0.0", "notes": "..." }, published with each release
CHANGELOG.md
```
The result is a single bundled file, so there's no `importModule` setup on the phone. On a Mac, the deploy script copies it to `~/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents/`, and it appears in Scriptable automatically.

## Phases

### Phase 1: Fixtures
Write a small Node script that downloads and saves real responses to `test/fixtures/`:
- PM2.5 with today's date
- PM2.5 with yesterday's date
- the latest PSI reading
- if possible, a day that has missing hours

Then document the response shape in `test/fixtures/README.md`. Stop for review.

### Phase 2: Parsing and region selection (tests first)
- `parsePm25Series(json, region)` returns an array of `{ time, value }`.
- `parseLatestPsi(json, region)` returns `{ time, value }`.
- `normaliseRegion(param)` should be case-insensitive, trim spaces, and fall back to `central` for an empty or unknown value.
- Missing or null readings must be handled without crashing.

### Phase 3: Time and the 24-hour window (tests first)
- `sgtDateStrings(now)` returns today's and yesterday's dates in Singapore time. Singapore is UTC+8 with no daylight saving. Include tests where the time is near midnight in UTC versus Singapore.
- `rolling24h(todaySeries, yesterdaySeries, now)` merges both days, removes duplicates, sorts by time, and keeps only the last 24 hours.
- `nextRefresh(now)` returns 5 minutes past the next hour, since NEA publishes hourly.
- `isStale(latestTime, now)` returns true if the data is more than 2 hours old.

### Phase 4: Bands and chart geometry (tests first)
- `pm25Band(value)` returns a band name and colour. Use NEA's 1-hr PM2.5 bands: Normal 0–55, Elevated 56–150, High 151–250, Very High 251+.
- `psiBand(value)` returns a band name and colour: Good 0–50, Moderate 51–100, Unhealthy 101–200, Very Unhealthy 201–300, Hazardous 301+.
- Note the source for both band tables in a code comment. I'll check them against haze.gov.sg.
- `chartPoints(series, width, height, padding)` converts readings into pixel coordinates.
  - The y-axis starts at 0 and goes up to at least 60, so normal days don't look alarming.
  - Gaps in the data should produce breaks in the line rather than joining across them.
- `formatUpdated(time)` returns text like `"Updated 3:00pm"`.

### Phase 5: The Scriptable layer
This part can only be tested on a phone, so keep it small.
- Read the region from `args.widgetParameter`.
- Fetch PM2.5 for today and yesterday, plus the latest PSI, all at the same time.
- Save the last successful result with `FileManager.local()`. If a request fails, show the saved data with a stale indicator.
- Build a `ListWidget` for each size:
  - **Small:** both numbers and a mini trend line
  - **Medium:** the numbers on the left and the chart on the right
  - **accessoryRectangular:** text only, for the lock screen
- Draw the chart with `DrawContext` using the points from `chartPoints`. Add faint band lines at 55 and 150.
- Set `widget.refreshAfterDate = nextRefresh(now)` and `widget.url = "https://www.haze.gov.sg"`.
- When the script runs inside the app rather than in a widget, show:
  - a preview of the medium widget
  - a menu to set or clear the API key, stored in `Keychain`

### Phase 6: Build and deploy
- `scripts/build.js` combines the files into one and strips the `module.exports` lines.
- Add a test that checks the bundled file parses as valid JavaScript.
- `scripts/deploy.sh` copies the bundled file into the iCloud folder.
- Write a README covering how to add the widget and set the region parameter.

### Phase 7: Sharing and updates

**Version number (tests first)**
- Add a `VERSION` constant to the script. `scripts/build.js` sets it from `package.json`.
- `compareVersions(a, b)` compares version numbers like `1.10.0` and `1.9.0`. Test that case, equal versions, and malformed input.
- `parseManifest(json)` reads `version.json` and returns `{ version, notes }`. It returns `null` if the file is invalid.
- `shouldCheckForUpdate(lastChecked, now)` allows at most one check per day.
- `updateUrl(repoBase)` builds the raw GitHub URL for the bundled script and `version.json`.

**Update check (Scriptable layer)**
- The check is turned off by default. A menu item in the app turns it on or off, and the setting is saved.
- When it's on, the widget checks `version.json` at most once a day. If a newer version exists, the widget shows a small "Update available" label. It never installs anything by itself.
- Running the script in the app shows the release notes and an **Install update** button. Installing:
  1. downloads the new bundled script
  2. checks it's plausible: the file isn't empty and contains the expected `VERSION` line
  3. backs up the current script as `SG Haze (previous).js`
  4. overwrites the current script file in Scriptable's iCloud folder
- If anything fails, the current script stays as it is and the app shows an error.

**Sharing rules**
- The published bundle must contain no API key or other personal data. Add a test that fails if the bundle contains `x-api-key` with a value attached, or anything that looks like a key.
- The update URL points to my public GitHub repo and is fixed in the build. Friends can't change it, and nothing else in the script fetches code.

**Docs and release**
- Add a **"For friends"** section to `README.md` covering:
  - installing the script by AirDrop or by pasting it into Scriptable
  - adding the widget and setting the region parameter (`north`, `south`, `east`, `west`, `central`)
  - adding an optional API key of their own
  - turning on update checks, with a plain statement that this means running code downloaded from my repo
- `scripts/release.sh`:
  1. runs the tests
  2. builds the bundle
  3. updates the version number in `version.json`
  4. reminds me to update `CHANGELOG.md` and push

## Out of scope for now
- Lock screen circular and inline widgets
- Notifications or alerts when a threshold is crossed
- A large widget size
- Android support (could reuse `core.js` with Tasker later)
