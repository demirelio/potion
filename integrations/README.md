# Integrations

The Markdown mod works on its own: it shows whatever file it is given. These integrations are the optional
pieces that give you ways to open one: keys, the `+` menu, a click in a file panel. Install the mod first
(`../install.sh`), then add the integrations you want.

| Folder | Changes | What you get |
|---|---|---|
| [`tabs/`](tabs/) | clone of the shipped `tabs` mod | `markdown`, `markdown:tab` and `markdown:pane` commands that open the file picker; a tab whose panes are all Markdown shows the Markdown icon and is named "Markdown" until it has a name |
| [`files/`](files/) | clone of the shipped `files` mod | A click on a `.md` file opens it beside the focused pane, shift+click in a tab of its own, right-click offers "Open as new tab" |
| [`pane-header/`](pane-header/) | clone of the shipped `pane` (pane header) mod | The pane header shows a Markdown pane's file icon and name, and the Markdown toggle |
| [`new-menu/`](new-menu/) | clone of the shipped `new-menu` mod, and a one-line change to the `tabs` clone | A Markdown row in the `+` menu (key `m`) |
| [`keys/`](keys/) | your `keys.json` | `cmd-m` opens the picker for a new tab, `cmd-shift-m` for a pane beside the focused one |

## How to apply a patch

Herdr's own mods are read-only: it replaces them on every start. A patch therefore goes onto a clone, which is
yours and is never updated. The patches are made against the mods shipped with **Herdr 0.1.12**, and the
folders below name the clone each one expects.

```sh
herdr-app do mod.clone '{"name":"tabs","as":"my-tabs"}'
patch -p1 -d ~/.config/herdr-app/mods/my-tabs < integrations/tabs/tabs.patch
```

`-d` is the clone's folder and the patch edits its `main.js`, so run `patch` from the root of this package (or
give the path to the `.patch` file). A clone rewrites its own `mods/<name>/` asset paths, which the patches
allow for; a patch that reports rejected hunks is for another Herdr version and needs applying by hand.

Then point your layout at the clone: a cloned layout keeps its references to the shipped mods, so change the
layout's `content.mod` entry for the tab bar, the file panel, the pane header or the `+` menu to the clone's
name (`my-tabs`, `my-files`, `my-pane`, `my-new-menu`). See Herdr's `AGENTS.md` in the app folder for how
layouts name their mods.

The clone names matter. The patches and the key bindings spell `herdr-inline-markdown`, `my-tabs`, `my-new-menu` and
`my-pane`; use other names and the matching strings have to change with them.

## Mods cannot share code

Herdr refuses a mod that imports another mod's file, so each integration carries what it needs. The `files` patch
holds a copy of `openMarkdown` (the logic of the mod's `open.js`), and the pane header and the mod repeat the names
of the two shared-state keys they exchange (`herdr-inline-markdown.heads`, `herdr-inline-markdown.toggle`).
`test/integrations.test.mjs` checks that the copies of `openMarkdown` act like the original.

## Undo

Delete the clone folder (or restore the layout entry that pointed at it). The Markdown mod itself needs no
integration to keep working.
