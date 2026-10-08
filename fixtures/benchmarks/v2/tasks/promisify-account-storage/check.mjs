import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path) => import(pathToFileURL(resolve(path)).href);
const cwd = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'xvant-promisify-'));
const isPromise = (value) => typeof value?.then === 'function';

// Services are exercised against an in-memory store with the promise interface.
const memory = () => {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
    keys: async () => [...map.keys()].sort(),
  };
};

try {
  // storage
  const { createKv } = await load('src/storage/kv.js');
  const kv = createKv(join(temp, 'kv', 'nested'));
  assert.equal(isPromise(kv.get('missing')), true);
  assert.equal(await kv.get('missing'), undefined);
  assert.deepEqual(await kv.keys(), []);
  await kv.set('a/b c', { n: 1 });
  await kv.set('z', [1, 2]);
  await kv.set('a/b c', { n: 2 });
  assert.deepEqual(await kv.get('a/b c'), { n: 2 });
  assert.deepEqual(await kv.get('z'), [1, 2]);
  assert.deepEqual(await kv.keys(), ['a/b c', 'z']);
  await kv.delete('z');
  await kv.delete('never-existed');
  assert.deepEqual(await kv.keys(), ['a/b c']);

  // users
  const { createUsers } = await load('src/services/users.js');
  const userStore = memory();
  const users = createUsers(userStore);
  assert.equal(isPromise(users.get('u1')), true);
  assert.deepEqual(await users.create(' Ann '), { id: 'u1', name: 'Ann' });
  assert.deepEqual(await users.create('Bo'), { id: 'u2', name: 'Bo' });
  for (const name of ['Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ivy', 'Jo']) await users.create(name);
  assert.deepEqual(await users.get('u2'), { id: 'u2', name: 'Bo' });
  assert.equal(await users.get('u99'), undefined);
  assert.deepEqual(await users.rename('u1', ' Anna '), { id: 'u1', name: 'Anna' });
  assert.deepEqual((await users.list()).map((u) => u.id), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10']);
  assert.equal((await users.list())[0].name, 'Anna');
  await assert.rejects(() => users.rename('u99', 'X'), { message: 'user not found: u99' });
  await assert.rejects(() => users.create('   '), TypeError);
  await assert.rejects(() => users.create(), TypeError);
  assert.deepEqual(await createUsers(memory()).list(), []);

  // sessions
  const { createSessions } = await load('src/services/sessions.js');
  const sessionStore = memory();
  let now = 1000;
  const sessions = createSessions(sessionStore, { clock: { now: () => now }, ttlMs: 500 });
  assert.equal(isPromise(sessions.check('nope')), true);
  const token = await sessions.start('u1');
  assert.equal(typeof token, 'string');
  const other = await sessions.start('u2');
  assert.notEqual(other, token);
  assert.equal(await sessions.check(token), 'u1');
  assert.equal(await sessions.check('nope'), undefined);
  now = 1499;
  assert.equal(await sessions.check(token), 'u1');
  await sessions.end(other);
  assert.equal(await sessions.check(other), undefined);
  now = 1500;
  assert.equal(await sessions.check(token), undefined);
  assert.deepEqual(await sessionStore.keys(), []);

  // settings
  const { createSettings } = await load('src/services/settings.js');
  const settings = createSettings(memory());
  assert.equal(isPromise(settings.all('u1')), true);
  assert.equal(await settings.get('u1', 'theme'), 'light');
  assert.equal(await settings.get('u1', 'pageSize'), 20);
  await settings.set('u1', 'theme', 'dark');
  await settings.set('u1', 'pageSize', 50);
  assert.equal(await settings.get('u1', 'theme'), 'dark');
  assert.equal(await settings.get('u2', 'theme'), 'light');
  assert.deepEqual(await settings.all('u1'), { theme: 'dark', pageSize: 50 });
  assert.deepEqual(await settings.all('u2'), { theme: 'light', pageSize: 20 });
  await assert.rejects(() => settings.set('u1', 'theme', 'blue'), RangeError);
  await assert.rejects(() => settings.set('u1', 'pageSize', 0), RangeError);
  await assert.rejects(() => settings.set('u1', 'pageSize', 101), RangeError);
  await assert.rejects(() => settings.set('u1', 'colour', 'x'), { message: 'unknown setting: colour' });
  await assert.rejects(() => settings.get('u1', 'colour'), { message: 'unknown setting: colour' });
  assert.equal(await settings.get('u1', 'pageSize'), 50);

  // command line, called as a function
  const { main } = await load('src/cli/cli.js');
  const lines = [];
  const io = { dir: join(temp, 'fn'), out: (line) => lines.push(line) };
  const pending = main(['user-add', 'Ann'], io);
  assert.equal(isPromise(pending), true);
  assert.equal(await pending, 0);
  assert.deepEqual(lines, ['created u1']);
  assert.equal(await main(['user-rename', 'u7', 'X'], io), 1);
  assert.equal(lines.at(-1), 'error: user not found: u7');
  assert.equal(await main(['bogus'], io), 1);

  // command line, as a process
  const env = { ...process.env, ACCOUNTS_DIR: join(temp, 'proc') };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [join(cwd, 'bin/accounts.js'), ...args], { cwd: temp, env, encoding: 'utf8' });
    return { code: r.status, lines: r.stdout.split('\n').filter(Boolean) };
  };
  assert.deepEqual(cli('user-add', 'Ann'), { code: 0, lines: ['created u1'] });
  assert.deepEqual(cli('user-add', 'Bo'), { code: 0, lines: ['created u2'] });
  assert.deepEqual(cli('user-rename', 'u2', 'Bob'), { code: 0, lines: ['renamed u2'] });
  assert.deepEqual(cli('user-list'), { code: 0, lines: ['u1 Ann', 'u2 Bob'] });
  const started = cli('session-start', 'u1');
  assert.equal(started.code, 0);
  assert.match(started.lines[0], /^s_[0-9a-f]+$/);
  assert.deepEqual(cli('session-start', 'u9'), { code: 1, lines: ['error: user not found: u9'] });
  assert.deepEqual(cli('get', 'u1', 'theme'), { code: 0, lines: ['light'] });
  assert.deepEqual(cli('set', 'u1', 'theme', 'dark'), { code: 0, lines: ['ok'] });
  assert.deepEqual(cli('set', 'u1', 'pageSize', '40'), { code: 0, lines: ['ok'] });
  assert.deepEqual(cli('get', 'u1', 'theme'), { code: 0, lines: ['dark'] });
  assert.deepEqual(cli('get', 'u1', 'pageSize'), { code: 0, lines: ['40'] });
  assert.equal(cli('set', 'u1', 'pageSize', '0').code, 1);
  assert.equal(cli('get', 'u1', 'nope').code, 1);
  assert.equal(cli().code, 1);
  assert.doesNotMatch(readFileSync(join(cwd, 'README.md'), 'utf8'), /callback[- ]based/i);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
