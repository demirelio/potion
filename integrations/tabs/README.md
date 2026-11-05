# tabs

Changes the **`tabs`** mod (the tab bar) of Herdr 0.1.12. Clone it as `my-tabs`.

## What it does

- The tab bar listens for the commands `markdown`, `markdown:tab` and `markdown:pane` and opens the Markdown
  file picker (the dialog of the `my-markdown` mod) for the active space. `markdown` and `markdown:tab` open the
  chosen file in a tab of its own, `markdown:pane` beside the focused pane. Bind keys to them with
  [`../keys`](../keys/).
- A tab whose panes are all Markdown panes shows the file icon of the mod (`mods/my-markdown/file-markdown.svg`)
  and is called "Markdown" while it has no name of its own.

The command loop is `nextCommand()` in the tab bar's `init`: one mod reads the commands sent to it, so if your
clone already has such a loop, add the `markdownCommand(command)` call to it instead of applying the loop twice.

## Apply

```sh
herdr-app do mod.clone '{"name":"tabs","as":"my-tabs"}'
patch -p1 -d ~/.config/herdr-app/mods/my-tabs < tabs.patch
```

Run it from this folder, then point the layout's tab bar at `my-tabs` (see [`../README.md`](../README.md)).

The `+` button of the same mod is changed by [`../new-menu`](../new-menu/), a separate patch that applies to
the same clone in either order.
