import { createKv } from '../storage/kv.js';
import { createSessions } from '../services/sessions.js';
import { createSettings } from '../services/settings.js';
import { createUsers } from '../services/users.js';

// Runs one command, then calls done(exitCode).
export function main(argv, { dir, out, clock }, done) {
  const kv = createKv(dir);
  const users = createUsers(kv);
  const sessions = createSessions(kv, clock ? { clock } : {});
  const settings = createSettings(kv);
  const [command, ...a] = argv;
  const finish = (err) => {
    if (err) {
      out('error: ' + err.message);
      return done(1);
    }
    done(0);
  };
  switch (command) {
    case 'user-add':
      return users.create(a[0], (err, user) => {
        if (err) return finish(err);
        out('created ' + user.id);
        finish();
      });
    case 'user-list':
      return users.list((err, list) => {
        if (err) return finish(err);
        for (const user of list) out(user.id + ' ' + user.name);
        finish();
      });
    case 'user-rename':
      return users.rename(a[0], a[1], (err) => {
        if (err) return finish(err);
        out('renamed ' + a[0]);
        finish();
      });
    case 'session-start':
      return users.get(a[0], (err, user) => {
        if (err) return finish(err);
        if (!user) return finish(new Error('user not found: ' + a[0]));
        sessions.start(user.id, (err2, token) => {
          if (err2) return finish(err2);
          out(token);
          finish();
        });
      });
    case 'set': {
      const value = /^\d+$/.test(a[2] ?? '') ? Number(a[2]) : a[2];
      return settings.set(a[0], a[1], value, (err) => {
        if (err) return finish(err);
        out('ok');
        finish();
      });
    }
    case 'get':
      return settings.get(a[0], a[1], (err, value) => {
        if (err) return finish(err);
        out(String(value));
        finish();
      });
    default:
      out('usage: accounts <user-add|user-list|user-rename|session-start|set|get> ...');
      return done(1);
  }
}
