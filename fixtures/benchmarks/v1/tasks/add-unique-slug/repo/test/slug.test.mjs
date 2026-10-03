import assert from 'node:assert/strict';
import { slugify, uniqueSlug } from '../src/slug.js';
assert.equal(slugify('Hello World'), 'hello-world');
assert.equal(uniqueSlug('Hello World', new Set()), 'hello-world');
assert.equal(uniqueSlug('Hello World', new Set(['hello-world'])), 'hello-world-2');
