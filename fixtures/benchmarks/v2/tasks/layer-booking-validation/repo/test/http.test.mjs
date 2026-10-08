import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';

const { handle } = createApp({ rooms: ['101'] });
const post = (body) => handle({ method: 'POST', path: '/bookings', body });

const created = post(JSON.stringify({ room: '101', guest: 'Ann', start: '2025-03-01', end: '2025-03-04' }));
assert.equal(created.status, 201);
assert.equal(created.body.booking.id, 'b1');

const bad = post('{not json');
assert.equal(bad.status, 400);
assert.equal(bad.body.error.code, 'BAD_JSON');

const invalid = post(JSON.stringify({ room: '101', guest: '', start: '2025-03-01', end: '2025-03-04' }));
assert.equal(invalid.status, 400);
assert.equal(invalid.body.error.code, 'VALIDATION');
assert.equal(invalid.body.error.field, 'guest');

assert.equal(handle({ method: 'GET', path: '/nowhere' }).status, 404);
