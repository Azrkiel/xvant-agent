import assert from 'node:assert/strict';
import { parseNote } from '../src/parse/line.js';

assert.deepEqual(parseNote('  Buy   milk '), { text: 'Buy milk', tags: [], done: false });
assert.deepEqual(parseNote('Buy milk #Home #errands #home'), {
  text: 'Buy milk',
  tags: ['home', 'errands'],
  done: false,
});
assert.equal(parseNote('learn c# today').text, 'learn c# today');
assert.throws(() => parseNote('#home'), TypeError);
