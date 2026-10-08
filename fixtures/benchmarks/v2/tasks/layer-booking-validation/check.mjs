import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path) => import(pathToFileURL(resolve(path)).href);
const { makeBooking } = await load('src/domain/booking.js');
const { createRooms } = await load('src/domain/rooms.js');
const { createBookingService } = await load('src/service/bookings.js');
const { createHandler } = await load('src/http/handler.js');
const { createApp } = await load('src/index.js');
const { ValidationError, NotFoundError, ConflictError } = await load('src/errors.js');

// domain: first failing field wins, in the order room, guest, start, end
const ok = { room: '101', guest: ' Ann ', start: '2025-03-01', end: '2025-03-04' };
assert.deepEqual(makeBooking(ok), { room: '101', guest: 'Ann', start: '2025-03-01', end: '2025-03-04' });
const failure = (input) => {
  try {
    makeBooking(input);
  } catch (error) {
    assert.ok(error instanceof ValidationError, 'expected a ValidationError for ' + JSON.stringify(input));
    assert.equal(error.code, 'VALIDATION');
    assert.equal(typeof error.message, 'string');
    return error.field;
  }
  return 'no error';
};
assert.equal(failure(null), 'booking');
assert.equal(failure('x'), 'booking');
assert.equal(failure([ok]), 'booking');
assert.equal(failure({ ...ok, room: '' }), 'room');
assert.equal(failure({ ...ok, room: '  ' }), 'room');
assert.equal(failure({ ...ok, room: 101 }), 'room');
assert.equal(failure({ ...ok, room: undefined }), 'room');
assert.equal(failure({ ...ok, guest: '   ' }), 'guest');
assert.equal(failure({ ...ok, guest: 5 }), 'guest');
assert.equal(failure({ ...ok, guest: 'x'.repeat(81) }), 'guest');
assert.equal(failure({ ...ok, guest: 'x'.repeat(80) }), 'no error');
assert.equal(failure({ ...ok, start: '2025-02-30' }), 'start');
assert.equal(failure({ ...ok, start: '2025-3-1' }), 'start');
assert.equal(failure({ ...ok, start: 20250301 }), 'start');
assert.equal(failure({ ...ok, start: undefined }), 'start');
assert.equal(failure({ ...ok, end: 'tomorrow' }), 'end');
assert.equal(failure({ ...ok, end: '2025-13-01' }), 'end');
assert.equal(failure({ ...ok, end: '2025-03-01' }), 'end');
assert.equal(failure({ ...ok, end: '2025-02-28' }), 'end');
assert.equal(failure({ ...ok, end: '2025-03-31' }), 'no error');
assert.equal(failure({ ...ok, end: '2025-04-01' }), 'end');
assert.equal(failure({ ...ok, start: '2024-02-28', end: '2024-03-01' }), 'no error');
assert.equal(failure({ room: '', guest: '', start: 'x', end: 'y' }), 'room');
assert.equal(failure({ ...ok, guest: '', start: 'x' }), 'guest');
assert.equal(failure({ ...ok, start: 'x', end: 'y' }), 'start');

// service: validation first, then the room, then conflicts
const stay = (room, start, end, guest = 'Ann') => ({ room, guest, start, end });
const service = createBookingService({ rooms: createRooms(['101', '102']) });
assert.deepEqual(service.book(stay('101', '2025-03-10', '2025-03-15')), {
  id: 'b1',
  room: '101',
  guest: 'Ann',
  start: '2025-03-10',
  end: '2025-03-15',
});
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return 'no error';
};
assert.throws(() => service.book(stay('999', '2025-03-10', '2025-03-15')), NotFoundError);
assert.equal(code(() => service.book(stay('999', '2025-03-10', '2025-03-15'))), 'NOT_FOUND');
assert.equal(code(() => service.book({ ...stay('999', '2025-03-10', '2025-03-15'), guest: '' })), 'VALIDATION');
assert.throws(() => service.book(stay('101', '2025-03-12', '2025-03-13')), ConflictError);
assert.equal(code(() => service.book(stay('101', '2025-03-01', '2025-03-11'))), 'CONFLICT');
assert.equal(code(() => service.book(stay('101', '2025-03-14', '2025-03-20'))), 'CONFLICT');
assert.equal(code(() => service.book(stay('101', '2025-03-01', '2025-03-30'))), 'CONFLICT');
assert.equal(code(() => service.book(stay('101', '2025-03-10', '2025-03-15'))), 'CONFLICT');
assert.equal(service.book(stay('101', '2025-03-15', '2025-03-16')).id, 'b2');
assert.equal(service.book(stay('101', '2025-03-05', '2025-03-10')).id, 'b3');
assert.equal(service.book(stay('102', '2025-03-10', '2025-03-15')).id, 'b4');
assert.deepEqual(service.list().map((b) => b.id), ['b1', 'b2', 'b3', 'b4']);
assert.deepEqual(service.list({ room: '102' }).map((b) => b.id), ['b4']);
assert.equal(service.cancel('b1'), 'b1');
assert.equal(service.book(stay('101', '2025-03-10', '2025-03-15')).id, 'b5');
assert.equal(code(() => service.cancel('b1')), 'NOT_FOUND');
assert.throws(() => service.cancel('nope'), NotFoundError);
assert.equal(service.list({ room: '101' }).length, 3);

// http, through the whole application
const { handle } = createApp({ rooms: ['101', '102'] });
const post = (body) => handle({ method: 'POST', path: '/bookings', body });
const body = (input) => JSON.stringify({ room: '101', guest: 'Ann', start: '2025-03-01', end: '2025-03-04', ...input });
const created = post(body({}));
assert.equal(created.status, 201);
assert.deepEqual(created.body.booking, { id: 'b1', room: '101', guest: 'Ann', start: '2025-03-01', end: '2025-03-04' });
const invalid = post(body({ end: '2025-03-01' }));
assert.equal(invalid.status, 400);
assert.equal(invalid.body.error.code, 'VALIDATION');
assert.equal(invalid.body.error.field, 'end');
assert.equal(typeof invalid.body.error.message, 'string');
for (const text of ['{not json', '', undefined, '[1]', 'null', '"text"', '12']) {
  const bad = post(text);
  assert.equal(bad.status, 400, 'body ' + text);
  assert.equal(bad.body.error.code, 'BAD_JSON');
  assert.equal(typeof bad.body.error.message, 'string');
}
const noRoom = post(body({ room: '999' }));
assert.equal(noRoom.status, 404);
assert.equal(noRoom.body.error.code, 'NOT_FOUND');
const clash = post(body({ start: '2025-03-03', end: '2025-03-05' }));
assert.equal(clash.status, 409);
assert.equal(clash.body.error.code, 'CONFLICT');
assert.equal(post(body({ start: '2025-03-04', end: '2025-03-05' })).body.booking.id, 'b2');
const listed = handle({ method: 'GET', path: '/bookings', query: { room: '101' } });
assert.equal(listed.status, 200);
assert.deepEqual(listed.body.bookings.map((b) => b.id), ['b1', 'b2']);
assert.deepEqual(handle({ method: 'GET', path: '/bookings', query: { room: '102' } }).body, { bookings: [] });
assert.deepEqual(handle({ method: 'GET', path: '/bookings' }).body.bookings.length, 2);
assert.deepEqual(handle({ method: 'DELETE', path: '/bookings/b1' }), { status: 200, body: { id: 'b1' } });
const gone = handle({ method: 'DELETE', path: '/bookings/b1' });
assert.equal(gone.status, 404);
assert.equal(gone.body.error.code, 'NOT_FOUND');
const route = handle({ method: 'GET', path: '/nowhere' });
assert.equal(route.status, 404);
assert.equal(route.body.error.code, 'NOT_FOUND');
for (const [method, path] of [['PUT', '/bookings'], ['DELETE', '/bookings'], ['POST', '/bookings/b2'], ['GET', '/bookings/b2']]) {
  const r = handle({ method, path });
  assert.equal(r.status, 405, method + ' ' + path);
  assert.equal(r.body.error.code, 'METHOD_NOT_ALLOWED');
}

// http: unexpected failures do not leak details
const broken = createHandler({
  book() {
    throw new Error('secret database password');
  },
  cancel() {
    throw new TypeError('secret cancel detail');
  },
  list() {
    throw new RangeError('secret list detail');
  },
});
for (const request of [
  { method: 'POST', path: '/bookings', body: '{}' },
  { method: 'DELETE', path: '/bookings/b1' },
  { method: 'GET', path: '/bookings' },
]) {
  const r = broken(request);
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'INTERNAL');
  assert.doesNotMatch(JSON.stringify(r.body), /secret/);
}
const mapped = createHandler({
  book() {
    throw new ValidationError('room', 'bad room');
  },
  cancel() {
    throw new ConflictError('already');
  },
  list() {
    throw new NotFoundError('thing', 'x');
  },
});
assert.deepEqual(mapped({ method: 'POST', path: '/bookings', body: '{}' }), {
  status: 400,
  body: { error: { code: 'VALIDATION', message: 'bad room', field: 'room' } },
});
assert.equal(mapped({ method: 'DELETE', path: '/bookings/x' }).status, 409);
assert.equal(mapped({ method: 'GET', path: '/bookings' }).status, 404);

// documentation
const readme = readFileSync('README.md', 'utf8');
for (const name of ['VALIDATION', 'BAD_JSON', 'NOT_FOUND', 'CONFLICT', 'METHOD_NOT_ALLOWED', 'INTERNAL'])
  assert.ok(readme.includes(name), 'README mentions ' + name);
