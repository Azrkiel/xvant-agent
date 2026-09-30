import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';
assert.equal(greet('Ana'), 'Hello, Ana!');
assert.equal(greet('Ana', 'Hi'), 'Hi, Ana!');
