---
title: Release plan
status: in progress
---

Release plan
============

The next release is a small one: it fixes the import bug, makes search faster,
and adds the export command. This plan lists the work in order, with what
"done" means for each item.

Phase 1: import fixes
---------------------

- [x] Reproduce the crash with a file that has a byte order mark
- [x] Add a test that fails on it
- [ ] Strip the mark before parsing
  - [ ] Handle UTF-16 files too
  - [ ] Keep the original bytes when the file is saved back unchanged
- [ ] Say in the changelog that imports now accept both encodings

Done when `npm test` passes and the sample files in `fixtures/import/` open
without a warning.

## Phase 2: faster search

1) Measure the current time for 10,000 notes and write it down.
2) Build the index in a worker, so typing never waits for it.
3) Compare the new time with the old one and keep the number in the pull
   request description.

The target is under 50 ms for a query of three words.\
A slower result is acceptable only if the index is much smaller[^size].

[^size]: Measured as the size of `.cache/` after a full index of the sample
    folder.

## Phase 3: export

The command takes a folder and a format:

```sh
notes export ./notes --format html
notes export ./notes --format pdf --out ./book
```

| Format | Needs | Status |
|---|---|---|
| html | nothing | done |
| pdf | a headless browser | planned |
| epub | `zip` on the path | idea |

> **Note**
> The pdf export starts a browser, so it is slower than the others and is only
> run when asked for.
>
> - It never runs in the background.
> - It prints the browser version it used.

## Risks

* The worker may not start on very old systems. We fall back to indexing in the
  foreground and say so once.
* A large folder can make the first index slow. We show progress and let the
  person keep working.
+ Export formats multiply the test matrix. We add one format per release.

***

See the [changelog][changes] and the [contributing guide](CONTRIBUTING.md) for how
to propose a change.

[changes]: https://example.com/changelog "Changelog"
