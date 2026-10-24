# Fixtures

Real responses from `https://api-open.data.gov.sg/v2/real-time/api/`, captured on 2026-10-24 around 15:39 SGT by `scripts/fetch-fixtures.js`. They were fetched without an API key.

| File | Request | Notes |
|------|---------|-------|
| `pm25-today.json` | `pm25?date=2026-10-24` | Partial day: 16 items, 00:00 to 15:00 |
| `pm25-yesterday.json` | `pm25?date=2026-10-23` | Full day: 24 items, 00:00 to 23:00 |
| `pm25-latest.json` | `pm25` (no date) | 1 item, the latest hour |
| `psi-latest.json` | `psi` (no date) | 1 item, the latest hour |
| `pm25-gappy.synthetic.json` | derived | **Synthetic.** No real day with gaps was found in the last 30 days. Made from `pm25-yesterday.json` with hours 03, 04, 05 and 14 removed, and `central` at 10:00 set to `null`. It has a top-level `_synthetic` note. |
| `pm25-not-found.json` | `pm25?date=2030-01-01` | Error response (HTTP 404) |

## Success shape (both endpoints)

```jsonc
{
  "code": 0,
  "errorMsg": "",
  "data": {
    "regionMetadata": [
      { "name": "north", "labelLocation": { "latitude": 1.41803, "longitude": 103.82 } }
      // ...south, east, west, central (the order varies between responses)
    ],
    "items": [
      {
        "date": "2026-10-24",                           // SGT calendar date
        "timestamp": "2026-10-24T15:00:00+08:00",       // the hour the reading is for
        "updatedTimestamp": "2026-10-24T15:00:55+08:00", // when it was published
        "readings": { /* see below */ }
      }
    ]
  }
}
```

- Readings are under `readings.<metric>.<region>`, and the values are integers.
- **PM2.5:** the only metric is `readings.pm25_one_hourly`.
- **PSI:** the 24-hour PSI is under `readings.psi_twenty_four_hourly`. The response also includes `pm25_twenty_four_hourly`, `pm10_twenty_four_hourly`, `so2_twenty_four_hourly`, `no2_one_hour_max`, `co_eight_hour_max`, `o3_eight_hour_max`, and `*_sub_index` values for pm25, pm10, so2, co and o3.
- Regions are `north`, `south`, `east`, `west` and `central`. **No metric includes `national`**, and the key order varies.
- Timestamps are ISO 8601 strings with a `+08:00` offset, so `new Date(timestamp)` parses them directly.

## Points the parsers need to handle

- **Items with `?date=` are listed newest first** (23:00 down to 00:00). The single item without a date is the latest hour. The parsers shouldn't rely on order: sort by `timestamp`.
- **Today's data is partial**, with one item for each hour published so far.
- **Publishing delay.** Some `updatedTimestamp` values are seconds after the hour, others about 45 minutes after (for example, 23:00 was published at 23:45:47). This is the reason for refreshing at :50 (see DECISIONS.md #1).
- **Just after midnight SGT**, today's date probably has no data until the 00:00 reading is published. That would return the 404 shape below, which should be treated as an empty series rather than an error. I inferred this from the 404 for a future date and haven't seen it happen yet.
- Missing values (`null`, a missing region key, or a missing hour) don't appear in real data from the last 30 days. They're covered by the synthetic fixture and small hand-written test inputs.

## Error shape

```json
{ "code": 17, "name": "REAL_TIME_API_DATA_NOT_FOUND", "data": null, "errorMsg": "Data not found" }
```

- A malformed date returns HTTP 400 with `{ "code": 4, "name": "ERROR_PARAMS", "data": null, "errorMsg": "Invalid date format..." }`.
- Without an API key, **HTTP 429** comes back after about 5 to 6 requests in quick succession. A retry after 10 s worked. I haven't checked whether the 429 response includes a `Retry-After` header. Three requests per widget refresh is fine, but the widget should treat a 429 like any other failure and fall back to cached data.
