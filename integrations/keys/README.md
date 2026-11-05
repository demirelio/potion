# keys

Two key bindings for the file picker of the Markdown mod:

| Keys | Action | What it does |
|---|---|---|
| `cmd-m` | `my-tabs.markdown:tab` | Asks for a file and opens it in a new tab |
| `cmd-shift-m` | `my-tabs.markdown:pane` | Asks for a file and opens it beside the focused pane |

An action of the form `<mod>.<command>` sends the command to that mod, so these need the [`../tabs`](../tabs/)
integration (the clone named `my-tabs`), which is what listens for `markdown:tab` and `markdown:pane`. Without it
the keys do nothing.

## Apply

Merge the two entries of [`keys.json`](keys.json) into the `"global"` section of
`~/.config/herdr-app/keys.json`. Herdr applies `keys.json` live.

`cmd-m` is also the macOS shortcut for minimizing a window; choose other keys if you want to keep that one.
