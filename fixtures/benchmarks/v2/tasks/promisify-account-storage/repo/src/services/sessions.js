import { systemClock } from '../util/clock.js';
import { newToken } from '../util/tokens.js';

export function createSessions(kv, { clock = systemClock, ttlMs = 3_600_000 } = {}) {
  return {
    // cb(error, token)
    start(userId, cb) {
      const token = newToken();
      const session = { userId, expiresAt: clock.now() + ttlMs };
      kv.set('session:' + token, session, (err) =>
        err ? cb(err) : cb(null, token),
      );
    },
    // cb(error, userId); userId is undefined for an unknown or expired token.
    // An expired session is deleted.
    check(token, cb) {
      kv.get('session:' + token, (err, session) => {
        if (err) return cb(err);
        if (!session) return cb(null, undefined);
        if (clock.now() >= session.expiresAt)
          return kv.delete('session:' + token, (err2) =>
            err2 ? cb(err2) : cb(null, undefined),
          );
        cb(null, session.userId);
      });
    },
    end(token, cb) {
      kv.delete('session:' + token, cb);
    },
  };
}
