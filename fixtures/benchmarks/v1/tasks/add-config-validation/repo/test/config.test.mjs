import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
assert.deepEqual(loadConfig({ host: 'example.test', port: 3000 }), {
  host: 'example.test',
  port: 3000,
});
assert.deepEqual(loadConfig({}), { host: 'localhost', port: 8080 });
assert.throws(() => loadConfig({ port: 70000 }), TypeError);
