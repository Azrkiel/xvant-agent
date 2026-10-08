import { errorBody, json } from './respond.js';
import { matchRoute } from './router.js';

export function createHandler(service) {
  return function handle(request) {
    const route = matchRoute(request.method, request.path);
    switch (route.name) {
      case 'create':
        return json(201, { booking: service.book(JSON.parse(request.body)) });
      case 'list':
        return json(200, { bookings: service.list({ room: request.query?.room }) });
      case 'cancel':
        return json(200, { id: service.cancel(route.params.id) });
      default:
        return json(404, errorBody('NOT_FOUND', 'no such route'));
    }
  };
}
