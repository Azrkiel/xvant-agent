# strkit

Small string and data helpers with no dependencies.

- `src/text/slug.js` `slugify(text, { maxLength })` turns a title into a URL slug
- `src/text/wrap.js` `wrap(text, width)` breaks text into lines of at most `width` characters
- `src/version/` `parseVersion`, `compareVersions` and `satisfiesCaret` for semantic versions
- `src/data/` `parseCsv(text, { delimiter })` and `parseTsv(text)`
- `src/util/strings.js` shared helpers

Tests are plain Node scripts in `test/`, run with `node test/<name>.test.mjs`. They exit with a
non-zero code when an assertion fails. `node test/all.test.mjs` runs the whole set.
