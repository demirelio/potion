# Pocket Ledger

A small command line tool that keeps a plain-text ledger of expenses. It reads
and writes one file per month, never talks to the network, and prints reports
as tables you can paste into a chat or a note. The format is simple enough to
edit by hand when you need to, and every command tells you which file it
touched.

## Use

```sh
pocket-ledger add 12.50 lunch --tag food
pocket-ledger report --month 2026-03
pocket-ledger export --format csv > march.csv
```

`add` appends one line to the current month's file, `report` sums a month by
tag, and `export` writes every entry of a month in the format you ask for. The
ledger folder is `~/ledger` unless `POCKET_LEDGER_HOME` says otherwise.

| Command | What it does | Writes a file |
|---|---|---|
| `add <amount> <note>` | Appends an entry to the current month | yes |
| `report` | Sums the month by tag, largest first | no |
| `export` | Prints the entries as CSV or JSON | no |
| `fix <id>` | Opens one entry in `$EDITOR` | yes |

## Files

Each month lives in `YYYY-MM.ledger`. A line has a date, an amount, a tag and a
note, separated by two spaces:

```text
2026-03-04  12.50  food   lunch with the team
2026-03-04   3.20  bus    ticket
```

Lines that start with `#` are comments and are kept when a file is rewritten.
A blank line ends nothing; the parser skips it.

### Settings

The settings file is `ledger.json` in the ledger folder:

```json
{
  "currency": "EUR",
  "decimals": 2,
  "tags": ["food", "bus", "books", "other"]
}
```

1. Unknown keys are ignored, so an older version can read a newer file.
2. A tag that is not in `tags` is accepted with a warning.
3. `decimals` only changes how amounts print, never how they are stored.

## Contributing

Run `npm test` before you open a pull request. New behaviour needs a test that
fails without it, and a change to the file format needs a line in the
changelog and a note in this README.

- Keep functions short and give them names that say what they do.
- Prefer a new test over a comment that explains a surprise.
  - If a comment is the only way, put it next to the code it explains.
  - Link the issue when the code works around a bug elsewhere.
- Do not add a dependency for something ten lines of code can do.

> Small tools stay small when every addition has to earn its place.

Licensed under the MIT license; see `LICENSE`.
