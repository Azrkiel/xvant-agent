import assert from 'node:assert/strict';
import { makeBooking } from '../src/domain/booking.js';
import { ValidationError } from '../src/errors.js';

const ok = { room: '101', guest: ' Ann ', start: '2025-03-01', end: '2025-03-04' };
assert.deepEqual(makeBooking(ok), { room: '101', guest: 'Ann', start: '2025-03-01', end: '2025-03-04' });

const field = (input) => {
  try {
    makeBooking(input);
  } catch (error) {
    assert.ok(error instanceof ValidationError, 'expected a ValidationError');
    assert.equal(error.code, 'VALIDATION');
    return error.field;
  }
  return 'no error';
};
assert.equal(field({ ...ok, room: '' }), 'room');
assert.equal(field({ ...ok, guest: '   ' }), 'guest');
assert.equal(field({ ...ok, start: '2025-02-30' }), 'start');
assert.equal(field({ ...ok, end: '2025-03-01' }), 'end');
assert.equal(field(null), 'booking');
