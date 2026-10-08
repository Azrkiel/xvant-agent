// Builds a booking { room, guest, start, end } from request input.
export function makeBooking(input) {
  return {
    room: input.room,
    guest: input.guest,
    start: input.start,
    end: input.end,
  };
}
