const idNumber = (id) => Number(id.slice(1));

export function createUsers(kv) {
  return {
    create(name, cb) {
      if (typeof name !== 'string' || !name.trim())
        return cb(new TypeError('name is required'));
      kv.get('user-seq', (err, seq) => {
        if (err) return cb(err);
        const next = (seq ?? 0) + 1;
        const user = { id: 'u' + next, name: name.trim() };
        kv.set('user-seq', next, (err2) => {
          if (err2) return cb(err2);
          kv.set('user:' + user.id, user, (err3) =>
            err3 ? cb(err3) : cb(null, user),
          );
        });
      });
    },
    // cb(error, user); user is undefined when there is none.
    get(id, cb) {
      kv.get('user:' + id, cb);
    },
    rename(id, name, cb) {
      kv.get('user:' + id, (err, user) => {
        if (err) return cb(err);
        if (!user) return cb(new Error('user not found: ' + id));
        const renamed = { ...user, name: String(name).trim() };
        kv.set('user:' + id, renamed, (err2) =>
          err2 ? cb(err2) : cb(null, renamed),
        );
      });
    },
    // cb(error, users): all users in id order.
    list(cb) {
      kv.keys((err, keys) => {
        if (err) return cb(err);
        const ids = keys
          .filter((key) => key.startsWith('user:'))
          .map((key) => key.slice(5))
          .sort((a, b) => idNumber(a) - idNumber(b));
        const users = [];
        const next = (i) => {
          if (i === ids.length) return cb(null, users);
          kv.get('user:' + ids[i], (err2, user) => {
            if (err2) return cb(err2);
            users.push(user);
            next(i + 1);
          });
        };
        next(0);
      });
    },
  };
}
