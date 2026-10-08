import { makeBooking } from '../domain/booking.js';
import { createSequence } from './ids.js';

export function createBookingService({ rooms }) {
  const bookings = new Map();
  const nextId = createSequence('b');
  return {
    // Returns the saved booking: { id, room, guest, start, end }.
    book(input) {
      const saved = { id: nextId(), ...makeBooking(input) };
      bookings.set(saved.id, saved);
      return saved;
    },
    // Returns the id of the cancelled booking.
    cancel(id) {
      bookings.delete(id);
      return id;
    },
    list({ room } = {}) {
      const all = [...bookings.values()];
      return room === undefined ? all : all.filter((b) => b.room === room);
    },
  };
}
