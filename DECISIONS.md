# Decisions

Changes to the original plan, agreed on 2026-10-24.

| # | Topic | Decision |
|---|-------|----------|
| 1 | Refresh time | `nextRefresh(now)` returns **50 minutes past** the next hour, not 5 past. NEA publishes each hour's reading at about :45. |
| 2 | Last refresh shown | If there's room, the widget also shows when it last refreshed, as well as the time of the reading. |
| 3 | 24-hour window | The window **excludes** the reading from exactly 24 hours ago (`now - 24h < time <= now`), giving at most 24 points. |
| 4 | Update install path | The installer overwrites the script at its own location (`module.filename`), so it works whether scripts are stored in iCloud or on the device. |
| 5 | Downgrade guard | The installer refuses a download whose `VERSION` isn't newer than the installed one. |
| 6 | Gap fixture | Use a real day with missing hours if one turns up in the last 30 days. Otherwise make a labelled synthetic fixture from a real day with hours removed. |
| 7 | Caching yesterday | Not done. Each refresh fetches today, yesterday and latest PSI (3 requests). |
| 8 | Git | Repo set up in Phase 1, with a first commit after review. |

## Technical fixes (no decision needed)

- The bundle-parse test wraps the bundle in an `async function` before parsing it, because Scriptable allows top-level `await`.
- The secret-scan test allows `"x-api-key": <variable>` and fails only on a string literal value or a key-shaped token.
- `psi_twenty_four_hourly` has no `national` value in the live API, so the parsers only use the five regions.
- Node 20 or later is pinned with `.nvmrc` (22), because nvm's default on this Mac is 18.
