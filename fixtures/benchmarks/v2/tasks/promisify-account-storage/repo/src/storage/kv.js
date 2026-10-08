import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs';
import { join } from 'node:path';

const fileFor = (dir, key) => join(dir, encodeURIComponent(key) + '.json');

// A key-value store with one JSON file per key. Every method takes a
// node-style callback as its last argument.
export function createKv(dir) {
  return {
    // cb(error, value); value is undefined for a missing key.
    get(key, cb) {
      readFile(fileFor(dir, key), 'utf8', (err, text) => {
        if (err) return err.code === 'ENOENT' ? cb(null, undefined) : cb(err);
        let value;
        try {
          value = JSON.parse(text);
        } catch (parseError) {
          return cb(parseError);
        }
        cb(null, value);
      });
    },
    set(key, value, cb) {
      mkdir(dir, { recursive: true }, (err) => {
        if (err) return cb(err);
        writeFile(fileFor(dir, key), JSON.stringify(value), (err2) =>
          cb(err2 ?? null),
        );
      });
    },
    delete(key, cb) {
      rm(fileFor(dir, key), { force: true }, (err) => cb(err ?? null));
    },
    // cb(error, keys): every stored key, sorted.
    keys(cb) {
      readdir(dir, (err, names) => {
        if (err) return err.code === 'ENOENT' ? cb(null, []) : cb(err);
        cb(
          null,
          names
            .filter((name) => name.endsWith('.json'))
            .map((name) => decodeURIComponent(name.slice(0, -5)))
            .sort(),
        );
      });
    },
  };
}
