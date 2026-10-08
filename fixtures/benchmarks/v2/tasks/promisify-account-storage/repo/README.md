# accounts

Users, sessions and per-user settings on top of a tiny file-backed key-value store.
Everything is callback based (`callback(error, result)`), and the project is being moved
to promises.

## Layout

- `src/storage/kv.js` the key-value store: `get`, `set`, `delete`, `keys`
- `src/services/users.js` create, get, rename and list users
- `src/services/sessions.js` start, check and end sessions
- `src/services/settings.js` per-user settings with defaults
- `src/cli/cli.js` the command line, run by `bin/accounts.js`
- `src/util/` clock and token helpers

## Command line

```
ACCOUNTS_DIR=data node bin/accounts.js user-add <name>            prints "created <id>"
ACCOUNTS_DIR=data node bin/accounts.js user-list                  prints "<id> <name>" lines
ACCOUNTS_DIR=data node bin/accounts.js user-rename <id> <name>    prints "renamed <id>"
ACCOUNTS_DIR=data node bin/accounts.js session-start <id>         prints a session token
ACCOUNTS_DIR=data node bin/accounts.js set <id> <name> <value>    prints "ok"
ACCOUNTS_DIR=data node bin/accounts.js get <id> <name>            prints the value
```

Errors print `error: <message>` and exit with code 1.
