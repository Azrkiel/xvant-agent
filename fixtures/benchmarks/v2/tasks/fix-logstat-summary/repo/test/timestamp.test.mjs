import assert from 'node:assert/strict';
import { parseTimestamp } from '../src/parse/timestamp.js';

const utc = Date.UTC(2025, 2, 4, 15, 15, 30);
assert.equal(parseTimestamp('2025-03-04T15:15:30Z'), utc);
assert.equal(parseTimestamp('2025-03-04T10:15:30-05:00'), utc);
assert.equal(parseTimestamp('2025-03-04T17:15:30+02:00'), utc);
assert.equal(parseTimestamp('2025-03-04T20:45:30+05:30'), utc);
assert.equal(parseTimestamp('yesterday'), null);
