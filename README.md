# herdr-inline-markdown

A Markdown reader and editor for the Herdr app, with mermaid diagrams and pictures.

A **Markdown pane** shows one markdown file, as a rendered page you edit in place or as its source, and saves what
you type. It opens beside your terminals in the current tab, or in a tab of its own. It is meant for reading the
plans an agent writes into a file as they appear, and for writing notes next to your terminals.

The package holds:

| Path | What it is |
|---|---|
| `mods/herdr-inline-markdown/` | The mod: the Markdown pane, the file picker and the right-click popup. Plain JavaScript, no build step |
| `mods/herdr-inline-markdown-beside/` | A small second mod, behind `cmd-shift-m`: it opens the picker for a pane beside the focused one (see [Keys](#keys)) |
| `keys.json` | The two keys the mods expect; `install.sh` merges them into yours |
| `tools/mermaid/` | The diagram renderer: mermaid-cli driving a headless Chrome. Not a Herdr mod; `install.sh` puts it where the mod looks |
| `tools/merge-keys.mjs` | What `install.sh` merges `keys.json` with |
| `integrations/` | Optional patches that give you more ways to open a file and mark Markdown tabs: the `+` menu, file panels, the pane header, the tab bar |

## Requirements

- **Herdr 0.1.12.** The mod and the patches were built and tested against that version's mod API and shipped mods.
- **Node.js**, for two things `install.sh` does. It merges the keys into your `keys.json` with `node`; without it
  the script leaves that file alone, and the two keys of `keys.json` have to be added by hand. The diagram renderer
  needs Node.js 22.12 or newer; without it the mod works and a diagram shows as a code block. Running the tests
  needs Node.js 22 or newer.
- **Disk for diagrams:** about 440 MB of `node_modules` and about 200 MB for the `chrome-headless-shell` build that
  puppeteer downloads (figures vary by platform), and a few minutes the first time.
- `git` on the machine of the folder you open files from: the picker lists markdown files with `git ls-files`,
  or with `find` outside a repository.
- `curl`, for pictures from the web (macOS ships it). Without it those pictures show an error box and the rest works.
- `osascript`, for the picture dialog (macOS ships it). Without it Image writes `![]()` for you to type the address in,
  and dropping pictures still works.

## Install

```sh
./install.sh                 # the two mods, their keys, then the diagram renderer
./install.sh --no-mermaid    # no diagram renderer
./install.sh --no-keys       # leave your keys.json alone
./install.sh --replace-keys  # also take over cmd-m / cmd-shift-m when you bound them to something else
```

The script copies `mods/herdr-inline-markdown` and `mods/herdr-inline-markdown-beside` into
`${HERDR_APP_HOME:-~/.config/herdr-app}/mods/`, merges `keys.json` into the `keys.json` there (see [Keys](#keys)),
and installs the renderer in `~/.local/share/herdr-inline-markdown/mermaid` (`npm ci` there, then the headless
browser; the mod reads that exact path). It can be run again at any time: files of an older copy of a mod that are
gone are removed, a copy that differed is saved under `~/.local/state/herdr-inline-markdown/backups/` first, and
`npm ci` only runs again when `tools/mermaid/package-lock.json` changed. A first install puts each mod folder in
place whole, so Herdr never sees one without its `mod.json`. Herdr reloads mods and `keys.json` as their files
change, so there is nothing to restart.

`HERDR_APP_HOME` and `HERDR_MERMAID_HOME` override the two folders. The mod itself only looks for the renderer in
the default place, so the second one is for trying an install somewhere else.

The mods place themselves nowhere: a file opens from the keys, or from Herdr's `tab.new` or `pane.split` command
with `mod: "herdr-inline-markdown"` and `props: { file: "/absolute/path/note.md" }` (`herdr-app commands` lists
the arguments), or from the [integrations](integrations/README.md).

### Keys

| Keys | Action in `keys.json` | What it does |
|---|---|---|
| `cmd-m` | `mod.open:herdr-inline-markdown` | Opens the file picker; the chosen file opens in a new tab |
| `cmd-shift-m` | `mod.open:herdr-inline-markdown-beside` | Opens the same picker; the chosen file opens beside the focused pane |

Herdr's `mod.open` shows a mod as the overlay its `mod.json` describes, and a mod opened that way gets no props but
the overlay's id, so it can't tell which key opened it. That is why there are two mods. `cmd-m` opens the Markdown
mod itself, which takes an overlay with nothing else in its props as the picker for a new tab. `cmd-shift-m` opens
`herdr-inline-markdown-beside`, an empty 2 px popup that, once it has started, closes itself and opens the Markdown
mod's picker with `place: "pane"`. Both pickers look in the folder of the focused pane, in the active space.

There is one picker at a time. A picker that opens closes any other still open (from the other key or the `+`
menu), and with a picker open `cmd-shift-m` closes it, as a second `cmd-m` closes the one `cmd-m` opened. The open
picker is named in the shared key `herdr-inline-markdown.picker`.

`install.sh` merges the keys the way Herdr asks a shared mod's `keys.json` to be merged: a key your `keys.json`
lacks is added at the end of its section; a key that already has the action stays; a key you bound to something
else stays yours, and the script names it and how to take it over (`--replace-keys`). Everything else in the file
stays as it was, byte for byte, and a `keys.json` that changes is saved under the backups folder first. The merge
needs `node` (without it the script says so and leaves the file alone), and a `keys.json` that is there: Herdr's own
holds its whole default keymap, so the script never makes one that would hold only these two keys, and says so.
Its last lines say whether both keys open the picker now, and if not, how to get there.

`cmd-m` is also the macOS shortcut for minimizing a window: Herdr's key wins while it is bound. Bind other keys to
the two actions in `keys.json` if you want it back, and run `install.sh --no-keys` from then on (otherwise a run
adds `cmd-m` again when it is unbound).

Coming from the bindings of an earlier version (`cmd-m` and `cmd-shift-m` sent to a `my-tabs` clone), a plain
`./install.sh` keeps them and says so; `./install.sh --replace-keys` moves them to the two actions above.

## Features

### Panes and tabs

- By default a file opens as a new pane to the right of the focused pane, so it sits next to the terminal in the same
  tab. The file already shown in a pane of that tab gets the focus instead of a second pane.
- In a tab of its own it opens from `cmd-m`, or from a shift+click or a right-click and "Open as new tab" (added by
  the integrations); `cmd-shift-m` opens one beside the focused pane. A file that already has a Markdown tab goes to
  that tab, in whichever space it is.
  A tab whose panes are all Markdown is a **Markdown tab**: it renames, moves and closes like any other.
- **The file picker** lists the markdown files of the folder of the focused pane (from a Markdown pane, its file's
  folder), else of the space's. Type to filter, Up and Down to move, Enter to open; recent files come first.
  **New note** makes `untitled.md` (`untitled-2.md` when taken). A name no file has offers **Create <name>** (`.md` is
  added when the name has no markdown extension, and folders in the name are made). A new file opens with an empty
  line to type in.

### Reading and Markdown views

A file opens as a page, called **Reading**, and the page is the editor: click any paragraph, heading, list item,
table or code block and type. The **Markdown** button at the right of the toolbar, or `cmd-e` from anywhere in the
pane (also while typing in a block), shows the whole file as source in the terminal font, and back. Both ways your
place and your caret are kept: the source opens on the line you were editing, and back in Reading the block holding
the source caret is being edited. Each file opens in the state it was last in, Reading the first time; an empty
note opens in Reading with an empty line to type in. `cmd-s` saves now. With a pane-header integration the toolbar
gives way to the pane's header, which shows the same file name and toggle.

- **Links in Reading:** a click on a link opens it (in the block being edited a link is text you can edit).
  `http(s)` opens in the browser and `mailto` in the mail app; a link to another markdown file opens in a pane beside
  this one, on the same machine; `#anchor` does nothing; any other file gives a notice "Can't open <name> here".
  A paragraph made only of images is drawn as pictures (see [Pictures](#pictures)); an image inside a line of text is
  not.
- **Saving:** 700 ms after you stop typing, on a tick, on a switch between Reading and Markdown, on `cmd-s` and when
  its pane or tab closes. The footer says Saving…, Unsaved or Saved. Every write names the text it last read, so a
  file that changed on disk is never overwritten silently.
- **When the file changes under you:** with nothing unsaved, the view updates, so an agent writing a plan renders as
  it goes (the folder is watched; if it can't be, the file is checked every 4 s). With unsaved edits, a change
  elsewhere in the file is merged into yours and saved; only when it touches the lines you changed does a banner say
  "Changed on disk" and offer **Keep mine** or **Load theirs**. If the file is deleted or moved, the banner says so
  and **Save again** writes the buffer back.
- **Footer:** save state, words and lines, the diagram status, and the path with `~` for the home folder.
- **Limits:** a file over 1 MiB (Herdr's `readTextFile` limit) or an unreadable one shows a message instead of its
  text; one over 200 KB says Loading… for a moment while its page is made. A file holding a character the text field
  cannot hold (a lone UTF-16 surrogate) opens read-only. A file on another machine is read-only for now: it reloads by
  checking every 5 s, a click never edits, and Markdown shows its source read-only.
- **What it runs:** `git ls-files` in the folder to list markdown files (tracked and untracked, not ignored; at most
  2,000), or outside a repository `find` up to 5 folders deep without `node_modules`, `.git`, hidden folders,
  `Library` and `.cache` (at most 1,000), on the machine of the space. Creating a file runs `mkdir -p` for the folders
  in its name. `curl` downloads the https pictures a file names, and once each time Herdr starts `find` deletes the
  files of the picture cache older than 45 days. `sh` starts `osascript` in the background to show the file dialog for
  pictures (macOS), because Herdr stops a command after 30 s and a dialog can stay open longer; the mod waits for it
  by checking, every 0.3 s, for the files `osascript` writes into the picture cache folder (`pick-*`, deleted once
  read), looks with `kill -0` every 2 s that it is still running, and ends it with `kill` when its pane closes.
  `mkdir -p` and `cp` put a picture from outside the note's folder into `images/` beside it. Files are written only on
  this computer: the one you edit, a new note, the diagram and picture caches (the dialog's answer too), and the
  pictures copied beside a note.

### Block editing

The block you click keeps its size, font and place. Only its own raw marks appear while you are in it (`**bold**`,
`` `code` ``, link addresses); its `#`, `-`, `1.`, `[ ]` or `>` stays hidden. A code block, table, HTML block, front
matter or diagram shows its source, fences included, in the terminal font, and a diagram is drawn again when you leave
it; a paragraph of pictures shows its source in a smaller terminal font and is drawn again the same way. A
hard-wrapped paragraph shows its line breaks as spaces, so it wraps as it did on the page, and keeps them in the
file.

| Key or click | What it does |
|---|---|
| Click | Edits the block under the pointer. In plain text the caret lands where you click; in text with formatting it lands at the nearest word boundary, in code on the clicked line and column, in a table at the start of the clicked cell. The second click is exact |
| Click beside the page / below the last block | Stops editing / starts a new paragraph at the end |
| Double-click a diagram or a picture | Shows its source to edit (a single click does nothing, so a drag or a stray click never opens it) |
| Click a linked picture | Opens its link, as a click on a link in text does; the picture itself is never opened for editing by a click |
| Click a checkbox | Ticks or unticks it |
| Enter | At the end of a block: a new one below (a list continues). At the start: a new one above. In the middle: splits the block. On an empty item: out a level, then out of the list. In code: a new line |
| Shift+Enter | A line break inside the block, written as `\` at the end of the line; in a heading it is Enter |
| Cmd+Enter | Ticks the task being edited; in a code block, leaves it for a new paragraph below |
| Backspace at the start | A heading or quote becomes a paragraph; an item moves out a level, then becomes a paragraph; a paragraph joins the one above. An empty block goes |
| Delete at the end | Joins the next paragraph, heading or item to this one, or removes the rule after it |
| Tab / Shift+Tab | Nests / un-nests a list item with its sub-items; in a table, selects the next / previous cell; in code, Tab types four spaces |
| Option+Up / Down | Moves the block (an item with its sub-items) above or below its neighbour |
| Arrow keys | Move inside the block, and on to the block above or below at its edge |
| Page Up / Page Down | Scrolls a page and takes the caret along |
| Escape | Stops editing; Enter picks up where you were |
| Cmd+Z / Cmd+Shift+Z | Undo and redo everything, in Reading and Markdown and across switching between them |
| Cmd+V | Pasted markdown (a chat answer, say) arrives as blocks: its headings, lists and code |
| Drag across blocks, or Shift+click | Selects whole blocks: Cmd+C copies their markdown, Cmd+X cuts it, Backspace or Delete removes them, Escape or a click clears the selection |

At the start of a paragraph, `# ` … `###### ` makes a heading, `- `, `* ` or `+ ` a bullet, `1. ` or `1) ` a numbered
item, `[] ` or `[ ] ` a task, and `> ` a quote; Cmd+Z right after gives back what you typed. ```` ```js ```` then Enter
starts a code block with the caret inside it, and `---`, `***` or `___` then Enter makes a rule. A block you open and
leave empty disappears and writes nothing to the file.

**Known limits:** in blocks with formatting, code or tables the first click puts the caret near the click, and
the second is exact; selecting across blocks selects whole blocks (the middle of one block to the middle of another
needs the Markdown view); typing never re-wraps the source; input methods that compose characters (Japanese,
Chinese) may misbehave with Enter, while direct typing in any script is fine. **Left out on purpose:** drag handles,
Cmd+B / Cmd+I, images inside text, HTML `<img>` and reference-style images (only a paragraph made of pictures is
drawn), footnotes (a reference stays text, a definition shows as a dim source line), jumping to `#anchor` links, and
any button besides the one toggle and a diagram's zoom.

### Slash menu

Type `/` at the start of a block or after a space for a menu of block types: Text, Heading 1-3, Bulleted, Numbered
and To-do list, Quote, Code block, Mermaid diagram, Image, Table and Divider. Typing on narrows it (`/h2`, `/todo`,
`/img`, `/mer`); Up and Down move the highlight, Enter, Tab or a click picks it, and Escape closes it and keeps what
you typed. A text style changes the block you are in and keeps its words; the others add a block where the slash was
(a table with "Column 1" selected, a diagram with a starter flowchart), or take the block's place when it held nothing
else. Image opens the macOS file dialog: choose one picture or several, and they are written as one paragraph where the
slash was, with the caret in a new paragraph below (see [Pictures](#pictures)); Cancel writes nothing. Where the dialog
can't run (no `osascript`, so not on macOS), Image writes `![]()` with the caret between the parentheses for you to
type an address, and the picture is drawn when you leave the paragraph. Cmd+Z right after a pick gives back the `/h2`
you typed, and a second Cmd+Z removes it; after the dialog one Cmd+Z removes the pictures and leaves the copies. A pick
writes the same markdown as typing it. There is no menu in code, tables or diagram source, where a slash is text.

### Diagrams

Fenced blocks tagged `mermaid` are drawn as pictures in Reading, in the colors of the current Herdr theme. Herdr can't
draw mermaid itself, so `tools/mermaid` holds a small renderer: mermaid-cli 12.2.0 driving a headless Chrome, set up
by `install.sh`. Without it the footer says "Diagrams need the mermaid renderer: run install.sh" and a diagram shows as
a code block; without Node.js it says "Diagrams need Node.js".

Each diagram is drawn once per text, theme and renderer version, and the picture is kept in
`~/.config/herdr-app/data/herdr-inline-markdown/diagrams/` (`.mmd` source, `.png`, `.json` result; the renderer deletes
entries older than 45 days, and the folder can be emptied by hand at any time). The diagrams of a document are drawn
together, one Chrome start per batch. A diagram with a syntax error shows mermaid's message in its place, over the
last good picture if there was one.

A diagram sits in a frame, on a canvas a shade lighter than the page (a shade darker on a light theme). A wide one
leaves the text column and takes the pane's width, less 32 px on each side; a tall one takes the page's height, less
24 px above and below. It opens at a size you can read: all of it when that is 75 % or more, else its full width, but
never under 75 % or over 100 % (mermaid's own size).

- **Move it:** drag it, or swipe sideways over it. Scrolling up or down over a diagram taller than its frame goes
  through it: the page brings the frame fully into view, the picture scrolls to its end, then the page goes on.
- **Zoom:** Cmd+scroll (or Ctrl+scroll) over it zooms around the pointer, from the whole diagram up to 200 %. With
  the pointer over the frame, `− % +` shows at its top right: − and + step the zoom, and the percentage takes the
  frame back to where it opened.
- **Edit it:** double-click it to open its source.
- Each frame keeps its view while you edit elsewhere, switch the theme or open its source.

### Pictures

A paragraph made only of images is drawn as pictures in Reading: `![alt](address)`, one or several, on one line or on
several. A linked image, `[![alt](address)](https://…)`, counts too, so the row of badges at the top of a README is
drawn. An image inside a line of text, an HTML `<img>` and a reference-style image (`![alt][ref]`) are not drawn.

- **Adding pictures:** pick them or drop them, in a note on this computer that you can edit. **Image** in the
  [slash menu](#slash-menu) opens the macOS file dialog, which offers PNG, JPEG, GIF, WebP, BMP and SVG files (not
  HEIC) and lets you choose several; it stays open as long as you need, and closing the pane closes it. The dialog
  opens in the folder the last picture came from, else on the Desktop, where macOS saves screenshots (your home
  folder when there is no Desktop). Image files dragged from Finder onto the page are added the same way, below the
  block the pointer was last over, else below the block you are editing, else at the end; any other file is ignored,
  and a drop with no picture says so.
  A picture already in the note's folder or below it is linked where it is, as `a.png` or `img/a.png`. Any other is
  copied into an `images/` folder beside the note, made when needed, and linked as `images/<name>`. The copy's name is
  the original's with each run of whitespace turned into `-` (macOS puts a narrow no-break space in screenshot names);
  when `images/` already holds that name with other bytes the copy is numbered `-2`, `-3`…, and with the same bytes
  that file is linked and nothing is copied. The alt text is the file's name without its extension. An address with a
  space is written in `<…>`; `(`, `)`, `%`, `#` and `?` in a name are written as `%28`, `%29`, `%25`, `%23` and `%3F`.
  A copy that fails is left out, and a notice names it with the reason. Cmd+Z removes the pictures you added and
  leaves the copies.
- **Addresses:** a path relative to the markdown file, an absolute path or a `file://` address, an `https://`
  address, and `data:image/…` (base64 or percent-encoded). `http://` and every other scheme are never fetched: they
  show an error box. Web pictures are downloaded with `curl` when the file opens (https only, redirects too, 10 MB at
  most, 20 s). The pictures of a file on another machine aren't shown yet, except the ones from the web.
- **Formats:** PNG, JPEG, GIF, WebP, BMP and SVG, told by the file's bytes, not its name. A file over 25 MB or a
  picture over 50 megapixels shows an error box.
- **Size:** a picture keeps its own size, shrunk to the width of the text when it is wider, never enlarged. Pictures
  that fit sit side by side and the rest wrap to the next row, so badges make a row and screenshots stack.
- **Clicks:** a single click does nothing; a double-click shows the paragraph's source to edit, and leaving it draws
  the pictures again. A click on a linked picture opens its link instead, as a click on a link in text does, also on
  a file you can't edit, and never edits: arrow into the paragraph, or use the Markdown view.
- **Updates:** when the folder watcher reports a picture's file, the page reads it again and swaps the new picture in
  when it is loaded, so a picture an agent writes after the markdown appears without reopening. Where the folder
  isn't watched (your home folder, `/`, a file on another machine) pictures are read when they are first drawn and
  not again.
- **Errors:** a picture that can't be shown is a box with its name and the reason: not found, not a picture, too big,
  the download failed. A box says Loading picture… while one loads.
- **Cache:** every picture is copied into `~/.config/herdr-app/data/herdr-inline-markdown/images/` under a name made
  from its bytes, because Herdr draws only pictures from its app folder. Once each time Herdr starts, files there
  older than 45 days are deleted, and the folder can be emptied by hand at any time.

Besides the file itself, the mod keeps in Herdr's shared state which pane shows which file, the 30 most recent files,
each file's last state (Reading or Markdown) and the folder the last picture came from.

## Integrations

[`integrations/`](integrations/README.md) has one folder per optional integration, each with a patch and a README:
the tab bar (Markdown tab icon and name), the file panel (click a `.md` file), the pane header (file name and
Markdown toggle) and the `+` menu (a Markdown row). They patch clones of Herdr's shipped mods, because Herdr replaces
its own mods on every start. The keys need none of them.

## Tests

```sh
npm test    # node 22+, nothing to install; never starts Herdr
```

The tests cover the mod's pure functions (`lib.js`), its block model (`blocks.js`, run over the CommonMark and GFM
spec examples, the documents in `test/fixtures/markdown/docs` and variants of each), the caret, page and
diagram-frame arithmetic (`geometry.js`), the undo history, the page's drawing, opening a file, the picker, the
editor, the diagram service, the picture service and its image-size reader, the picture dialog and the placing of
pictures beside a note, the keys and the companion mod, `install.sh` and its merge of `keys.json`, the assets, and
that the files integration's copy of `openMarkdown` acts like `open.js`. The renderer's tests run the installed copy
and skip when there isn't one; to run them without touching your install, point `HERDR_MERMAID_HOME` at one. The patch
tests apply each patch to Herdr 0.1.12's shipped mods, read from `${HERDR_APP_HOME:-~/.config/herdr-app}` (Herdr
rewrites them on every start), and skip when the files there are not exactly 0.1.12's.

## Before open-sourcing

- **Rename the mod.** `herdr-inline-markdown` is a personal prefix. It names the two mod folders, the shared-state keys
  (`herdr-inline-markdown.panes`, `.recent`, `.modes`, `.heads`, `.toggle`, `.picker`, `.imageFolder`), the cache folder (`data/herdr-inline-markdown`), the key
  contexts (`MdText3`...), the asset paths in the mod, `keys.json`, `install.sh`, the patches and the tests. The integrations also assume the
  clone names `my-tabs`, `my-files`, `my-pane` and `my-new-menu`. Rename them together, with one search and replace
  and `npm test`.
- **Choose a license** and add `LICENSE`. `package.json` is `"private": true` and carries no author or license.
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) lists the bundled icons and the test fixtures taken from the
  CommonMark and GFM specs, which are CC BY-SA 4.0: they are test data only, but decide whether that fits the license
  you pick.
- **Check the claims about Herdr.** Every patch and the install paths were made for Herdr 0.1.12. The patches were
  checked by applying them to copies of that version's shipped mods, also with the `mods/<name>/` asset paths
  rewritten the way a clone does it (simulated, not cloned by Herdr), and by loading the mod against test mocks;
  nothing here has been run inside the app or in another version. The keys rely on `mod.open` showing each mod as
  its `mod.json` overlay says (the companion's 2 px frameless popup included). Say so in the compatibility notes.
- **Icon provenance.** Fourteen icons are from lucide-static 1.69.0; four more match the path data of current
  Lucide icons, but the release they were copied from was not recorded. `spinner.svg` and `dots.svg` were drawn for
  this package, and `file-markdown.svg` is the Material Icon Theme's markdown icon.
- **Opening a file can fetch https pictures.** A markdown file can name pictures on the web, and the mod downloads
  them with `curl` when the file opens (https only, 10 MB at most, 20 s), so the server of each one sees your address.
  Say so, or put the download behind a setting.
- **The installer fetches about 650 MB** (mermaid-cli and its dependencies, then a headless Chrome from the
  puppeteer download host) and runs `npm ci --ignore-scripts`. Say so before anyone runs it, and consider an
  opt-in for the Chrome download.
- **Node.js versions.** Tested on a current Node.js release; Node.js 22 is untested. The test loader has a fallback
  for versions without `module.registerHooks`, and the renderer needs 22.12.
- **Remote machines are read-only.** A file on another machine opens, but is never edited. Say so near the top,
  or build it.
- **`cmd-m` is the macOS shortcut for minimizing a window**, and `install.sh` binds it by default (unless it is
  taken). Pick another default, or make the keys opt-in.
- **No LICENSE, CHANGELOG, CI or issue templates yet.**
