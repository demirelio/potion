# tabs

Changes the **`tabs`** mod (the tab bar) of Herdr 0.1.12. Clone it as `my-tabs`.

## What it does

A tab whose panes are all Markdown panes shows the file icon of the mod (`mods/potion/file-markdown.svg`)
and is called "Potion" while it has no name of its own. Nothing else changes: the tab bar opens nothing for the
Markdown mod. The `cmd-m` and `cmd-shift-m` keys come with the plugin itself (`../../keys.json`, merged by
`../../install.sh`).

A clone patched by an earlier version of this patch also has a `nextCommand()` loop in `init`, with
`markdownCommand` and `openPicker`, that served the old key bindings. Once `../../install.sh --replace-keys` has
bound `cmd-m` and `cmd-shift-m` to `mod.open`, nothing sends those commands and that part can go; keep the loop
itself if other code in your clone reads commands through it.

## Apply

```sh
herdr-app do mod.clone '{"name":"tabs","as":"my-tabs"}'
patch -p1 -d ~/.config/herdr-app/mods/my-tabs < tabs.patch
```

Run it from this folder, then point the layout's tab bar at `my-tabs` (see [`../README.md`](../README.md)).

The `+` button of the same mod is changed by [`../new-menu`](../new-menu/), a separate patch that applies to
the same clone in either order.
