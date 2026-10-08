import assert from 'node:assert/strict';
import { createUsers } from '../src/services/users.js';

// An in-memory key-value store with the promise interface.
const map = new Map();
const kv = {
  get: async (key) => map.get(key),
  set: async (key, value) => void map.set(key, value),
  delete: async (key) => void map.delete(key),
  keys: async () => [...map.keys()].sort(),
};
const users = createUsers(kv);
assert.deepEqual(await users.create(' Ann '), { id: 'u1', name: 'Ann' });
assert.deepEqual(await users.create('Bo'), { id: 'u2', name: 'Bo' });
assert.deepEqual(await users.get('u2'), { id: 'u2', name: 'Bo' });
assert.equal(await users.get('u9'), undefined);
assert.deepEqual(await users.rename('u1', 'Anna'), { id: 'u1', name: 'Anna' });
assert.deepEqual((await users.list()).map((u) => u.name), ['Anna', 'Bo']);
await assert.rejects(() => users.rename('u9', 'X'), /user not found: u9/);
await assert.rejects(() => users.create('  '), TypeError);
