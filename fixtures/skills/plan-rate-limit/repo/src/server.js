import { allow } from './limiter.js';

export function handle(request) {
  if (request.path === '/health') return { status: 200 };
  return { status: 200, body: 'ok ' + request.client };
}
