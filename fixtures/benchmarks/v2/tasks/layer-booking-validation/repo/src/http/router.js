// Finds the route for a request: { name, params }. `name` is 'none' when no route fits.
export function matchRoute(method, path) {
  if (path === '/bookings') {
    if (method === 'POST') return { name: 'create', params: {} };
    if (method === 'GET') return { name: 'list', params: {} };
  }
  const match = /^\/bookings\/([^/]+)$/.exec(path);
  if (match && method === 'DELETE')
    return { name: 'cancel', params: { id: decodeURIComponent(match[1]) } };
  return { name: 'none', params: {} };
}
