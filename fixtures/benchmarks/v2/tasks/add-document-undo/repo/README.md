# texted

A tiny line editor driven by a script of commands, read from standard input:

```
printf 'insert 1 hello\ninsert 2 world\nprint\n' | node bin/texted.js
```

Line numbers start at 1. Commands:

| Command | Effect |
| --- | --- |
| `insert <n> <text>` | insert a line before line `n` (`n` may be one past the last line) |
| `delete <n>` | remove line `n` |
| `replace <n> <text>` | replace line `n` |
| `print` | print every line as `<n>: <text>` |

A failing command prints `error: <message>` and the script goes on.

## Layout

- `src/core/` pure line operations (`buffer.js`) and the document that holds the lines
- `src/cli/` command parsing and the script runner
- `src/io/` output formatting
