# logstat

Summarises application logs: request counts, errors and latency percentiles per UTC hour
and service.

```
node bin/logstat.js summary <file> [--level LEVEL] [--service NAME]
```

A log line is `<ISO timestamp with zone> <LEVEL> <service> <latency>ms <message>`, for
example `2025-03-04T10:15:30-05:00 INFO api 120ms GET /users`. Lines that do not have this
shape are skipped. `samples/app.log` is an example.

Known problems are listed in `BUGS.md`.

## Layout

- `src/parse/` timestamps and log lines
- `src/aggregate/` hour buckets, percentiles and the per-hour summary
- `src/report/` the text table
- `src/cli/` argument handling and the command
