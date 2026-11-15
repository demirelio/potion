# Third-party notices

## Bundled

### Lucide icons (ISC; some derived from Feather, MIT)

The line icons in `mods/herdr-inline-markdown/` are Lucide icons (https://lucide.dev) reduced to a bare `<svg>` element:
`bold`, `check`, `code`, `file-plus`, `heading-1`, `heading-2`, `heading-3`, `image`, `italic`, `link`, `list`,
`list-ordered`, `list-todo`, `markdown` (Lucide's `file-text`), `message-square`, `message-square-plus`, `minus`, `plus`,
`search`, `strikethrough`, `table`, `text-quote`, `type` and `workflow`. `bold`, `code`, `heading-1` to `heading-3`,
`image`, `italic`, `link`, `list`, `list-ordered`, `list-todo`, `message-square`, `message-square-plus`, `minus`,
`search`, `strikethrough`, `table`, `text-quote`, `type` and `workflow` were taken from lucide-static 1.69.0. `check`, `file-plus`, `markdown` and `plus` have the path data of the current Lucide icons;
the release they were copied from was not recorded.

`check`, `code`, `italic`, `link`, `minus`, `plus`, `search` and `type` are among the Lucide icons derived from Feather,
which is under the MIT license below.

`spinner.svg` and `dots.svg` are not Lucide icons: both were drawn for this package.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

```
The MIT License (MIT) (for the icons derived from Feather)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Material Icon Theme (MIT)

`mods/herdr-inline-markdown/file-markdown.svg` is the markdown file icon of the Material Icon Theme for VS Code
(pkief.material-icon-theme, https://github.com/material-extensions/vscode-material-icon-theme), unmodified.

```
The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Test fixtures

`test/fixtures/markdown/commonmark-0.31.2.json` and `gfm-0.29.json` are the example lists of the CommonMark 0.31.2
and GitHub Flavored Markdown 0.29 specifications, used as test data only. Both specifications are published under
the Creative Commons Attribution-ShareAlike 4.0 license (CC BY-SA 4.0).

## Not bundled, installed on demand

`install.sh` downloads these into the renderer folder (`~/.local/share/herdr-inline-markdown/mermaid`); none of them is
part of this package. The versions are pinned in `tools/mermaid/package-lock.json`.

| Package | License (from the lock file) |
|---|---|
| `@mermaid-js/mermaid-cli` 12.2.0 | MIT |
| `mermaid` 12.3.0 | MIT |
| `puppeteer`, `puppeteer-core` 25.16.0 | Apache-2.0 |
| the other 198 packages of the lock file | MIT, ISC, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense and others, each stated in the lock file |

puppeteer also downloads a `chrome-headless-shell` build (Chrome for Testing) from its own download host; that
browser is under its own terms.
