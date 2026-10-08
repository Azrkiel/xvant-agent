# notes

A one-line-notes command line tool. Notes are kept in a JSON file named by the
`NOTES_FILE` environment variable (default `notes.json` in the current directory).

## Commands

```
node bin/notes.js add <text...>     add a note, prints "added <id>"
node bin/notes.js list              list notes, one per line
node bin/notes.js done <id>         mark a note done
node bin/notes.js rm <id>           remove a note
```

A listed note looks like `3 [ ] Buy milk` (`[x]` once done).

## Layout

- `src/parse/` turns a typed line into a note
- `src/store/` keeps notes in the JSON file
- `src/cli/` argument handling, output format and the commands
