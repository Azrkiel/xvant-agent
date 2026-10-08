import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKv } from '../src/storage/kv.js';

const kv = createKv(join(mkdtempSync(join(tmpdir(), 'kv-')), 'data'));
assert.equal(await kv.get('missing'), undefined);
await kv.set('a/b', { n: 1 });
await kv.set('c', [1, 2]);
assert.deepEqual(await kv.get('a/b'), { n: 1 });
assert.deepEqual(await kv.keys(), ['a/b', 'c']);
await kv.delete('c');
await kv.delete('never-existed');
assert.deepEqual(await kv.keys(), ['a/b']);
