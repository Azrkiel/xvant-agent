# Bug report

`node bin/logstat.js summary samples/app.log` prints a wrong table. Expected output:

```
hour               service  count  errors  p50  p95
-----------------  -------  -----  ------  ---  ---
2025-03-04T15:00Z  api      4      1       160  480
2025-03-04T15:00Z  web      1      0       90   90
2025-03-04T16:00Z  web      3      2       100  300
```

What users see instead, and what they expect:

1. **Entries from the Americas land in the wrong hour.** `2025-03-04T10:15:30-05:00` is
   15:15 UTC and belongs in the `15:00Z` row; it is counted somewhere else. Offsets east
   of UTC (`+02:00`) are fine.
2. **Medians and p95 are off by one rank.** The p50 of the four `api` latencies
   120, 160, 200, 480 is 160 and not 200. Percentiles use the nearest-rank method: the
   smallest value that at least p percent of the values are less than or equal to.
3. **Columns run into each other.** A column must be as wide as its widest cell, not just
   its header, and columns are separated by two spaces.
4. **`--level error` prints an empty table.** Level names must match without regard to
   case: `--level error`, `--level Error` and `--level ERROR` all select `ERROR` entries.

Do not change the log format or the command line.
