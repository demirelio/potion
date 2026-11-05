# files

Changes the **`files`** mod (the file browser panel) of Herdr 0.1.12. Clone it as `my-files`.

## What it does

- A click on a markdown file (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdx`) opens it in a Markdown pane to
  the right of the focused pane. If the focused tab already shows that file in a pane, the pane gets the focus
  instead.
- Shift+click opens it in a tab of its own; a file that already has a Markdown tab goes to that tab, in whichever
  space it is.
- Right-click on a markdown file opens a small popup of the Markdown mod with one row, "Open as new tab".
- While a Markdown pane has the focus, the panel stays on the folder it was showing instead of falling back to the
  space's folder (a Markdown pane has no folder of its own).
- Other files still preview in the panel.

The patch carries a copy of the mod's `openMarkdown` and `isMarkdown`, because mods cannot import each other.

## Apply

```sh
herdr-app do mod.clone '{"name":"files","as":"my-files"}'
patch -p1 -d ~/.config/herdr-app/mods/my-files < files.patch
```

Run it from this folder, then point the layout's file panel at `my-files` (see [`../README.md`](../README.md)).
