import { randomBytes } from 'node:crypto';

export function newToken() {
  return 's_' + randomBytes(12).toString('hex');
}
