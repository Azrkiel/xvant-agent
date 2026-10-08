import { createRooms } from './domain/rooms.js';
import { createBookingService } from './service/bookings.js';
import { createHandler } from './http/handler.js';

export { makeBooking } from './domain/booking.js';
export { createRooms, createBookingService, createHandler };
export * from './errors.js';

export function createApp({ rooms }) {
  const service = createBookingService({ rooms: createRooms(rooms) });
  return { service, handle: createHandler(service) };
}
