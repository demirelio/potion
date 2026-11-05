# pane-header

Changes the **`pane`** mod (the header drawn above each pane in layouts that frame their panes) of Herdr 0.1.12.
Clone it as `my-pane`.

## What it does

For a Markdown pane the header shows the file's icon (`mods/my-markdown/file-markdown.svg`) and name, then a
**Markdown** toggle that switches the pane between its page and its source, and leaves the folder text empty. Other
panes keep their header as it was.

The header and the mod talk through two keys in Herdr's shared state:

- `my-markdown.heads`: each Markdown pane publishes `{ name, mode }` under its pane id.
- `my-markdown.toggle`: the header raises `{ pane, n }`; the pane whose id matches switches its view.

When the shown layout draws its pane headers with a mod called `my-pane`, the Markdown pane hides its own toolbar
(`headed()` in the mod's `editor.js`), because the header shows the same things. With another clone name, change
`HEADER_MOD` there to match.

## Apply

```sh
herdr-app do mod.clone '{"name":"pane","as":"my-pane"}'
patch -p1 -d ~/.config/herdr-app/mods/my-pane < pane.patch
```

Run it from this folder. Then make the layout draw its pane headers with `my-pane`; layouts name the header mod in
`pane.header.content.mod` (see Herdr's `AGENTS.md`).
