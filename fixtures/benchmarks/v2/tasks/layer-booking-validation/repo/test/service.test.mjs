import assert from 'node:assert/strict';
import { createRooms } from '../src/domain/rooms.js';
import { ConflictError, NotFoundError } from '../src/errors.js';
import { createBookingService } from '../src/service/bookings.js';

const service = createBookingService({ rooms: createRooms(['101', '102']) });
const first = service.book({ room: '101', guest: 'Ann', start: '2025-03-01', end: '2025-03-04' });
assert.equal(first.id, 'b1');
assert.throws(() => service.book({ room: '999', guest: 'Bo', start: '2025-03-01', end: '2025-03-02' }), NotFoundError);
assert.throws(() => service.book({ room: '101', guest: 'Bo', start: '2025-03-03', end: '2025-03-06' }), ConflictError);
assert.equal(service.book({ room: '101', guest: 'Bo', start: '2025-03-04', end: '2025-03-06' }).id, 'b2');
assert.throws(() => service.cancel('b9'), NotFoundError);
