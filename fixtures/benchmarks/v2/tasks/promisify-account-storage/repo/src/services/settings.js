export const DEFAULTS = { theme: 'light', pageSize: 20 };

function validate(name, value) {
  if (!(name in DEFAULTS)) return new Error('unknown setting: ' + name);
  if (name === 'theme' && !['light', 'dark'].includes(value))
    return new RangeError('theme must be light or dark');
  if (name === 'pageSize' && !(Number.isInteger(value) && value >= 1 && value <= 100))
    return new RangeError('pageSize must be an integer from 1 to 100');
  return null;
}

export function createSettings(kv) {
  const read = (userId, cb) =>
    kv.get('settings:' + userId, (err, stored) =>
      err ? cb(err) : cb(null, stored ?? {}),
    );
  return {
    // cb(error, value): the stored value or the default.
    get(userId, name, cb) {
      if (!(name in DEFAULTS)) return cb(new Error('unknown setting: ' + name));
      read(userId, (err, stored) =>
        err ? cb(err) : cb(null, stored[name] ?? DEFAULTS[name]),
      );
    },
    set(userId, name, value, cb) {
      const problem = validate(name, value);
      if (problem) return cb(problem);
      read(userId, (err, stored) => {
        if (err) return cb(err);
        kv.set('settings:' + userId, { ...stored, [name]: value }, cb);
      });
    },
    // cb(error, settings): defaults overlaid with stored values.
    all(userId, cb) {
      read(userId, (err, stored) =>
        err ? cb(err) : cb(null, { ...DEFAULTS, ...stored }),
      );
    },
  };
}
