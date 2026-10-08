# booking

An in-memory room booking service with a small HTTP-style request handler. There is no
server: `handle({ method, path, query, body })` takes a request object and returns
`{ status, body }`.

## Layers

- `src/domain/` booking rules and dates: `makeBooking(input)` builds a booking
- `src/service/` the booking service: `book`, `cancel`, `list`
- `src/http/` routes and responses
- `src/errors.js` error classes shared by all layers (`ValidationError`, `NotFoundError`, `ConflictError`)

## Routes

| Request | Success |
| --- | --- |
| `POST /bookings` with a JSON body `{ room, guest, start, end }` | `201 { booking }` |
| `GET /bookings` (optional `query.room`) | `200 { bookings }` |
| `DELETE /bookings/<id>` | `200 { id }` |

Dates are `YYYY-MM-DD`; `end` is the check-out day.
