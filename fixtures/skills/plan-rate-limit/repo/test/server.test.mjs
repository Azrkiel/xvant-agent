import assert from 'node:assert/strict';
import { handle } from '../src/server.js';
assert.equal(handle({ path: '/health' }).status, 200);
