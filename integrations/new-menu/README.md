# new-menu

Adds a **Markdown** row to the `+` popup. Two patches, because two shipped mods are involved (Herdr 0.1.12):

| Patch | Applies to | Clone name |
|---|---|---|
| `new-menu.patch` | the **`new-menu`** mod (the `+` popup) | `my-new-menu` |
| `tabs-plus-button.patch` | the **`tabs`** mod (the tab bar), where the `+` button lives | `my-tabs` |

## What it does

- A "Markdown" row under "Terminal" opens the file picker for a new tab. It shows the global key bound to
  `mod.open:potion` (`cmd-m`, from the plugin's `keys.json`) as its hint, or `M` when none is.
- While the menu is open, pressing `m` does the same.
- The popup is 31 px taller to fit the row.
- The tab bar's `+` button opens `my-new-menu` instead of `new-menu`.

The row is disabled when there is no space, as the worktree rows are.

## Apply

```sh
herdr-app do mod.clone '{"name":"new-menu","as":"my-new-menu"}'
patch -p1 -d ~/.config/herdr-app/mods/my-new-menu < new-menu.patch

herdr-app do mod.clone '{"name":"tabs","as":"my-tabs"}'    # skip if you already cloned it for ../tabs
patch -p1 -d ~/.config/herdr-app/mods/my-tabs < tabs-plus-button.patch
```

Run it from this folder, then point the layout's tab bar at `my-tabs`. This patch and [`../tabs`](../tabs/) both
change the tab bar clone; they apply in either order.
