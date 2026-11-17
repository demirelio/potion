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

- **Herdr 0.1.16.** The mod reads the selection of its text fields, which Herdr 0.1.16 added. The patches were built
  and tested against Herdr 0.1.12's mod API and shipped mods.
- **Node.js**, for two things `install.sh` does. It merges the keys into your `keys.json` with `node`; without it
  the script leaves that file alone, and the two keys of `keys.json` have to be added by hand. The diagram renderer
  needs Node.js 22.12 or newer; without it the mod works and a diagram shows as a code block. Running the tests
  needs Node.js 22 or newer.
- **Disk for diagrams:** about 440 MB of `node_modules` and about 200 MB for the `chrome-headless-shell` build that
  puppeteer downloads (figures vary by platform), and a few minutes the first time.
- `git` on the machine of the folder you open files from: the picker lists markdown files with `git ls-files`,
  or with `find` outside a repository.
- `curl`, for pictures from the web (macOS ships it). Without it those pictures show an error box and the rest works.
- `osascript`, for the picture dialog (macOS ships it). Without it Image writes an empty picture and opens its address
  box for you to type the address in, Change picture opens that box too, and dropping pictures still works.

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

- **Links in Reading:** Cmd+click on a link opens it; a plain click selects it and shows its [popover](#links), and a
  second click puts the caret in it. In a file you can't edit, a click opens it. `http(s)` opens in the browser and
  `mailto` in the mail app; a link to another
  markdown file opens in a pane beside this one, on the same machine; `#anchor` does nothing; any other file gives a
  notice "Can't open <name> here".
  A paragraph made only of images is drawn as pictures (see [Pictures](#pictures)); an image inside a line of text
  shows as a picture icon and its alt text, and a click picks it with the same menu.
- **Saving:** 700 ms after you stop typing, on a tick, on a switch between Reading and Markdown, on `cmd-s` and when
  its pane or tab closes. The footer says Saving…, Unsaved or Saved. Every write names the text it last read, so a
  file that changed on disk is never overwritten silently.
- **When the file changes under you:** with nothing unsaved, the view updates, so an agent writing a plan renders as
  it goes (the folder is watched; if it can't be, the file is checked every 4 s). With unsaved edits, a change
  elsewhere in the file is merged into yours and saved; only when it touches the lines you changed does a banner say
  "Changed on disk" and offer **Keep mine** or **Load theirs**. If the file is deleted or moved, the banner says so
  and **Save again** writes the buffer back.
- **Footer:** save state, words and lines, the number of [comments](#comments), the diagram status, and the path with
  `~` for the home folder.
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
  `mkdir -p` and `cp` put a picture from outside the note's folder into `images/` beside it, and Open picture runs
  `open` (macOS) or `xdg-open` with a picture's file. Files are written only on
  this computer: the one you edit, a new note, the diagram and picture caches (the dialog's answer too), and the
  pictures copied beside a note. Herdr's own folder (`~/.config/herdr-app`) is watched for changes to `keys.json`:
  Herdr drops the keys a mod bound each time it reads that file again, so the editor binds its keys again half a
  second after each change.

### Block editing

Reading draws every paragraph, heading, list item and quote as editable text, the same whether you are editing it or
not, so nothing moves when you click one: the caret lands where you click, and a drag selects what it crosses. Bold
stays bold, a link shows its text in the link colour with no address, code keeps its font and background, a
comment's text stays highlighted, and escapes and entities show as their characters. No markdown mark
ever shows in Reading, its `#`, `-`, `1.`, `[ ]` or `>` included; the marks stay in the file, and the Markdown view
shows them. A word with formatting moves as one piece until the caret is in it: click into it or arrow up to it, and
the caret stops between its letters. A code block, or a diagram's source, shows only its code, in the terminal font,
where Reading draws it: its fences stay in the file, out of sight, its language stays at the top right, and a diagram
is drawn again when you leave it. An indented code block (four spaces, no fence) shows without its indent and stays
indented. A table, HTML block or front matter shows its source. A paragraph of pictures never shows its source: a click
[picks a picture](#pictures). A hard-wrapped paragraph shows its line breaks as spaces, so it wraps as it did on the
page, and keeps them in the file.

In code, typing stays as typed: no formatting, shortcut or slash menu. Enter starts the new line with the indent of
the line the caret is on, and Tab and Shift+Tab indent (see the table). To leave a code block, press Enter three times
after its last line (the two blank lines go and a new paragraph opens below) or Cmd+Enter (a new paragraph below), or
Down on its last row or Right at its very end (on to the next block, or a new paragraph after the last block of the
file). A line that would end the code block early, such as ```` ``` ```` in a block fenced with three backticks, makes
both fences longer as you type it, so the block keeps that line; the same Cmd+Z takes back the line and the longer
fences.

| Key or click | What it does |
|---|---|
| Click | Edits the block under the pointer. In a paragraph, heading, item or quote the caret lands where you click, between the letters of a formatted word too, and nothing on the page moves; in code on the clicked line and column, the page staying put too; in a table at the start of the clicked cell (there the second click is exact) |
| Click a link | Selects the whole link and shows its [popover](#links) over it; a second click puts the caret in its text |
| Cmd+click a link | Opens it, as described under [Links in Reading](#reading-and-markdown-views) |
| Click beside the page / below the last block | Stops editing / starts a new paragraph at the end |
| Double-click a diagram | Shows its source to edit, without its fences (a single click does nothing, so a drag or a stray click never opens it) |
| Click a picture | [Picks it](#pictures): a ring around it and its menu over it. A double-click or a right-click does the same, a linked picture included. A picture inside a line of text is selected whole with the same menu, and a second click puts the caret in its alt text |
| Cmd+click a linked picture | Opens its link, as Cmd+click on a link in text does, also in a file you can't edit |
| Click a checkbox | Ticks or unticks it |
| Enter | At the end of a block: a new one below (a list continues). At the start: a new one above. In the middle: splits the block, and the formatting goes on on both sides: Enter inside a bold, coloured, highlighted, underlined or code run leaves both halves with it, inside a link both halves link to its address, and in commented text the first half keeps the comment. In a web address, an autolink or a picture the split goes after it, so it is never cut. On an empty item: out a level, then out of the list. In code: a new line that starts with the spaces and tabs the caret's line has before the caret; at the end of the code, the third Enter after its last line leaves for a new paragraph below, taking the two blank lines away. In a table, HTML block or front matter: a line break |
| Shift+Enter | A line break inside the block, written as `\` at the end of the line; in inline code the code closes before the break and opens again after it, as code can't hold one. In a heading it is Enter |
| Cmd+Enter | Ticks the task being edited; in a code block, leaves it for a new paragraph below |
| Backspace / Delete | In a paragraph, heading, item or quote what is left keeps its formatting: a bold run keeps its marks while a letter of it is left and they go with its last letter; a link keeps its address and commented text its comment the same way, and a link or comment whose text all went goes whole. A letter typed where you deleted takes the formatting of the first letter deleted, so a typo at the end of a bold word is retyped bold. Option+Backspace and a selection deleted or cut work the same |
| Typing over a selection | The typed text takes the formatting of the selection's first letter. Typing over a clicked link renames it and keeps its address; the same in commented text |
| Typing | Text typed inside a formatted word has its formatting, typed right after or before it is plain, and typed markdown works as a shortcut (`**bold**` turns bold as you close it). A character that would make hidden marks show is written so that it shows as typed |
| Backspace at the start | A heading or quote becomes a paragraph; an item moves out a level, then becomes a paragraph; a paragraph joins the one above, or picks the last picture of a paragraph of pictures above it. An empty block goes, an empty code block with its fences; in a code block holding code it does nothing |
| Delete at the end | Joins the next paragraph, heading or item to this one, removes the rule after it, or picks the first picture of a paragraph of pictures after it |
| Joining blocks | Every letter of both keeps its formatting and shows as before: a bold word at the end of one and another at the start of the next become one bold word, and a `*` that showed as a character still does. The caret lands at the join |
| Tab / Shift+Tab | Nests / un-nests a list item with its sub-items; in a table, selects the next / previous cell. In code, Tab types the block's indent at the caret: a tab when its lines are indented with tabs, else its smallest indent of two spaces or more, else four spaces. With a selection Tab indents every line it touches except empty ones, and Shift+Tab takes one indent off them, or off the caret's line; the same text stays selected. A code block is never nested into an item this way |
| Option+Up / Down | Moves the block (an item with its sub-items) above or below its neighbour |
| Arrow keys | Move inside the block, and on to the block above or below at its edge; into a paragraph of pictures they pick its first picture from above, its last from below |
| Page Up / Page Down | Scrolls a page and takes the caret along |
| Escape | Closes a link's popover, else the format bar's open menu, else the format bar when it shows, else stops editing; Enter picks up where you were. In the address box it goes back to the popover |
| Cmd+Z / Cmd+Shift+Z | Undo and redo everything, in Reading and Markdown and across switching between them. Undo puts the caret back where it was before the key, and a deleted or typed-over selection comes back selected; a picture changed or deleted comes back picked |
| Cmd+C / Cmd+X | In a paragraph, heading, item or quote: copies the selection as markdown that keeps its formatting and stands on its own (part of a bold word is copied bold, part of a link as a link to its address, a picture whole, line breaks kept); comments are left out, their text kept. Cmd+X then deletes the selection as Backspace does. In a code block they copy the code, in a table the source |
| Cmd+V | Pasted markdown (a chat answer, say) arrives as blocks: its headings, lists and code. Pasted into a paragraph, heading, item or quote, text keeps its own formatting and takes the formatting of where it lands, as typing does: inside a bold word it is bold too, and over a selection it takes its first letter's. A mark that pairs with nothing on the clipboard (`**wo`) is pasted as the characters it shows. Paragraphs or blocks pasted in the middle of a block split it there as Enter does: the first pasted paragraph joins the text before, the last joins the text after, and lists, rules and code in between arrive as the blocks they write |
| Cmd+B / Cmd+I / Cmd+U / Cmd+Shift+X | In a paragraph, heading, item or quote: bold, italic, underline or strikethrough on the selection, all or nothing. If every letter of the selection has it already, the key takes it off all of them; otherwise it puts it on all of them, so a selection that is partly bold becomes all bold first. Text outside the selection keeps its formatting: a bold run the selection cuts is split, and runs that end up touching join into one. Every other formatting stays (bold-italic text that loses bold stays italic; a link keeps its address, a comment its note). The same letters stay selected, so the key again undoes it. Spaces at the ends of the selection stay outside. On a caret in a word they act on the word; elsewhere they write nothing and set the formatting of what you type next there, which stays one run as you type on (Cmd+B, `word`, Cmd+B, `s` gives **word**s) |
| Cmd+Shift+C | The same for inline code: other formatting goes around the code (`` **`x`** ``), and making formatted text code keeps its formatting, splitting the code where it changes |
| Cmd+Shift+H | The same for a highlight |
| Cmd+K | Opens the [address box](#links) under the selection, offering the web or mail address the clipboard holds; Enter makes the selection a link to what you typed. On a caret in a word it links the word; elsewhere Enter writes the address as a link. In a link the box holds its address, to change it |
| Cmd+Alt+M | In a paragraph, heading, item or quote: a [comment](#comments) on the selection, or at the caret |
| Select text in a paragraph, heading, item or quote | A [format bar](#the-format-bar) over the selection (under it at the top of the pane): Comment, Text style, Bold, Italic, Underline, Strikethrough, Code, Colour, List and Link. It stays for the next mark, until the selection goes, you type, press Escape or click elsewhere; Link and Comment close it, opening their box. A drag or a double-click in one that is not being edited selects there as in the one being edited, and the bar shows when you let go. A right-click on selected text shows the bar over it; on a word with nothing selected it selects the word first. In a code block or table not being edited a drag selects the drawn text, for Cmd+C |
| Drag across blocks, or Shift+click | Selects whole blocks: Cmd+C copies their markdown, Cmd+X cuts it, Backspace or Delete removes them, Escape or a click clears the selection |

The file stays plain markdown. Bold, italic, strikethrough and code are written `**…**`, `*…*`, `~~…~~` and
`` `…` ``; where markdown can't open or close a mark at that spot (the closing `**` in `**"quote"**word`, say) the
key writes the tag Reading draws instead: `<strong>`, `<em>` or `<s>`. Underline is written `<u>…</u>`, a highlight
`<mark>…</mark>`, and a text colour `<span style="color: red">…</span>` (red, yellow, green, teal or purple, from the
theme's terminal colours, so they suit light and dark themes). A `<mark color="…">` written by hand keeps its own
colour. Text colours have no keys: the format bar's Colour menu sets them. Read-only files, and blocks far from the
part of the page you are looking at, are drawn by Herdr's markdown view, which hides a span's tags but draws its text
uncoloured.

At the start of a paragraph, `# ` … `###### ` makes a heading, `- `, `* ` or `+ ` a bullet, `1. ` or `1) ` a numbered
item, `[] ` or `[ ] ` a task, and `> ` a quote; Cmd+Z right after gives back what you typed. ```` ```js ```` then Enter
starts an empty code block with the caret in it, and `---`, `***` or `___` then Enter makes a rule. A block you open
and leave empty disappears and writes nothing to the file; a code block you empty keeps its fences.

**Known limits:** in code blocks and tables the first click puts the caret near the click, and the second is exact;
code has no syntax colours; blank lines typed at the end of an indented code block show while you edit it but not in
Reading, which leaves them out as markdown does;
selecting across blocks selects whole blocks (the middle of one block to the middle of another needs the Markdown
view); a drag inside a formatted word that the caret is not in selects the whole word; typing never re-wraps the
source; input methods that compose characters (Japanese, Chinese) may misbehave with Enter, and inside or next to
formatted words, while direct typing in any script is fine. **Left out on purpose:** drag handles, drawing images
inside text, HTML `<img>` and reference-style images as the picture (they show as an icon and their alt text; only a
paragraph made of pictures is drawn), footnotes (a reference stays text, a definition shows as a dim source line),
jumping to `#anchor` links, and any button besides the one toggle, a diagram's zoom, the format bar, a link's popover,
a picture's menu and the comments' cards.

### The format bar

Selecting text in a paragraph, heading, item or quote shows a bar over it, its groups parted by thin lines:

| Button | What it does |
|---|---|
| Comment | A [comment](#comments) on the selection, as Cmd+Alt+M |
| Text style ▾ | A menu: Text, Heading 1, Heading 2, Heading 3 and Quote, the block's style checked. A pick turns the block into it. The button shows the block's style |
| Bold, Italic, Underline, Strikethrough, Code | What their keys do. A button shows pressed, in the accent colour, when every letter of the selection has its mark |
| Colour ▾ | A menu: Text (Default, Red, Yellow, Green, Teal, Purple) and Highlight (No highlight, Yellow), each with a swatch in the colour it draws in. The selection's colour and highlight are checked when all of it has the same one. A pick gives the whole selection that colour, takes it off (Default), or puts the highlight on or off. The button's icon takes the selection's colour, and its background the highlight |
| List ▾ | A menu: Bulleted list, Numbered list and To-do list. A pick turns the block into an item of that list, written with one space after its marker (`- [ ] `), the item's other lines and sub-items moving with its text; the checked one, the list the block is in, turns it back into text. The button shows the block's list, pressed in one |
| Link | What Cmd+K does: the [address box](#links) |

A menu opens under its button and closes on a second press of it, a pick, Escape or a press elsewhere; one menu
shows at a time. Each pick is one Cmd+Z, the same text stays selected and the bar stays over it. The field keeps the
keyboard throughout. In a pane too narrow for the bar it wraps onto more rows.

### Links

A link shows only its text, in the link colour; its brackets and address stay in the file. A click on a link selects
all of it and shows a popover over the row you clicked, its left edge at the link's start (under the row at the top of
the pane), in place of the format bar: the address, shortened in the middle when long (the whole one in its tooltip),
then four buttons. It stays with its row as the page scrolls.

| Button | What it does |
|---|---|
| Open | Opens the link, as Cmd+click does |
| Copy | Puts the address on the clipboard; the button shows a check |
| Edit | Turns the popover into the address box, holding the address |
| Remove | Takes the link off: its text stays, selected, without the link |

A second click on the link puts the caret in its text to edit it; the popover stays while the caret is in the link and
goes when it leaves, on Escape or on a click elsewhere. A drag over the link's text, or a selection with the keyboard,
shows the format bar instead.

The **address box** is a one-line field in the popover's place, its address selected so typing replaces it. Enter
applies it and the popover comes back showing it; Escape goes back to the popover, changing nothing; Enter on an empty
box takes the link off. Cmd+K and the bar's Link button open the same box for a new link (Escape then closes it, and
Enter on an empty box does nothing). A web host typed without its scheme (`google.com`, `www.x.org/a`) gets `https://`;
`mailto:` and other schemes, `#anchors` and paths to files (`other.md`, `notes/plan.md`) are written as typed. An
address with spaces or a parenthesis out of its pair is written in `<…>`. Each change is one Cmd+Z, which brings the
link and its selection back.

A reference link (`[text][label]`, `[label]`) shows its definition's address; Edit gives that one link an inline
address of its own and leaves the definition. An autolink (`<https://…>`) or an address written bare shows its address
as its text, so Edit changes both and keeps its form (as an inline link when the new address can't be one, a path for
instance). Remove leaves such an address as plain text, with a backslash before its `:` (or the `.` after `www`, or
its `@`) so it is not linked again: `https\://example.com`.

### Comments

Comments are written into the file as [CriticMarkup](https://criticmarkup.com), so an agent reading the file sees each
one next to the text it is about, with the time it was written:

```
The release {==ships on Friday==}{>>2026-11-16 20:51 | too early? QA needs a day<<} and the docs follow on Monday.
A comment at a point{>>check the date<<} marks no text.
```

The time is the local date and time, 24-hour (`YYYY-MM-DD HH:MM`), then ` | ` and the comment. The editor writes it on
every new comment and keeps it when the comment is edited. A person or an agent writing a comment by hand can use the
same form, or leave the time out: such a comment's card says "Comment" where the time would be (comments written
before the editor stored times are like that). Only the comment's text is ever shown, never the time as written.

- **In the margin.** When the file has comments and the pane is wide enough (836 px: a page column of at least 520 px
  and a column of cards 260 px wide), the page and the cards are centered together, the page narrower than its usual
  780 px when it must be. Each comment shows as a card beside its text, level with the row where its marked text
  starts (a comment at a point, level with the point): when it was written (the hour today, the day this year, the day
  and year before that) and the comment, cut to three lines. Cards that would overlap go down in order, a little
  apart, and they scroll with the page. The page makes room when the file gets its first comment and gives it back
  when it loses its last.
- **The active comment.** A click on a card, or on commented text, makes its comment active: all of its text is
  selected (the keyboard stays in the text), its highlight turns a deeper ochre, and its card stands out with an ochre
  border, showing the whole comment and two buttons: Edit (pencil) and Resolve (✓). Escape, a click elsewhere or moving
  the caret out of the comment ends it. A
  link inside commented text takes a click on it; the comment's card or the rest of its text picks the comment.
- **Editing in place.** Edit, or a click on a card's text, turns it into a field holding the comment, the caret at its end,
  growing with it. Enter saves it, keeping its time, as one undo step; Escape leaves it as it was; Enter on an emptied
  comment resolves it.
- **A new comment.** Select text in a paragraph, heading, list item or quote you are editing and press Cmd+Alt+M, or
  Comment on the format bar: the selection keeps a highlight and a new card opens beside it, "Add a comment…". Enter
  writes the comment with the time; Escape, or Enter with nothing typed, drops it and the selection is back. With
  nothing selected the comment goes at the caret. Spaces at the ends of the selection stay outside it. Saving is one
  undo step, and the caret lands after the comment.
- **Resolve** takes the comment and its marks off; the marked text stays, selected. It is one undo step, whose undo
  brings the comment back with its time.
- **Narrower panes**, and a file with no comment yet, have no margin. A new comment is written in a small box over the
  selection, with the time too. A count at the right of a block's first row says how many comments it holds, also
  while the block is being edited; a click on it opens a card listing them: the marked text, the time, the comment, and
  **Edit** (the block opens with the marked text selected and the box holds the comment) and **Resolve**. A click on
  commented text shows that comment's card over it, with Edit and Resolve; Edit, or a click on the card's text, opens
  the box to edit it. A file that can't be edited shows its cards without Resolve or Edit. The footer counts the file's comments.
- **Reading** highlights the marked text in a muted ochre as light as the page (dark brown on a dark theme, whatever
  its tint, soft beige on a light one), the colour `<mark>` highlights get too, its formatting still drawn, and leaves out the marks
  and the comment; a comment at a point shows as a highlighted 💬. A highlight with no comment (`{==text==}`) is
  highlighted too. The block being edited looks the same: the marks and the comment stay hidden.
- **Rules:** a comment is one line (line breaks typed into it become spaces, and `<<}` in it is written `<< }` so it
  can't end the comment early). It stays within one paragraph and never goes inside inline code, a code block, a
  diagram or a table, where CriticMarkup is plain text. A selection that would cut through or hold another comment, or
  reach into code, is refused with a notice; comments don't nest. CriticMarkup's suggestions (`{++ ++}`, `{-- --}`,
  `{~~ ~> ~~}`) are shown as written.

### Slash menu

Type `/` at the start of a block or after a space for a menu of block types: Text, Heading 1-3, Bulleted, Numbered
and To-do list, Quote, Code block, Mermaid diagram, Image, Table and Divider. Typing on narrows it (`/h2`, `/todo`,
`/img`, `/mer`); Up and Down move the highlight, Enter, Tab or a click picks it, and Escape closes it and keeps what
you typed. A text style changes the block you are in and keeps its words; the others add a block where the slash was
(a table with "Column 1" selected, a diagram with a starter flowchart), or take the block's place when it held nothing
else. Image opens the macOS file dialog: choose one picture or several, and they are written as one paragraph where the
slash was, with the caret in a new paragraph below (see [Pictures](#pictures)); Cancel writes nothing. Where the dialog
can't run (no `osascript`, so not on macOS), Image writes an empty picture, picks it and opens its address box: type an
address or a path and press Enter, and the picture is drawn; Escape leaves it empty. Cmd+Z right after a pick gives
back the `/h2` you typed, and a second Cmd+Z removes it; after the dialog one Cmd+Z removes the pictures and leaves the
copies. A pick writes the same markdown as typing it. There is no menu in code, tables or diagram source, where a slash
is text.

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
drawn. An image inside a line of text, an HTML `<img>` and a reference-style image (`![alt][ref]`) show as a picture
icon and the alt text, and a click picks them too (see **Pictures in text** below).

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
- **Picking:** a click on a picture picks it: a ring in the accent colour goes around it and its menu shows over it
  (under it at the top of the pane), and its markdown never shows. A double-click or a right-click does the same, and a
  picture still loading or one that can't be shown is picked too. A click elsewhere, Escape or the Markdown view lets
  it go. The arrow keys into a paragraph of pictures, Backspace at the start of the paragraph under it, Delete at the
  end of the one over it and an undo that lands in it pick a picture there instead of showing its source; the Markdown
  view still shows the source.
- **The menu** shows the picture's address as written in the file (cut in the middle when long, all of it in its
  tooltip) and these buttons:
  - **Change picture:** the macOS file dialog for one picture, opened in the picture's folder (where Image opens it
    for a web picture). The file you choose takes the picture's place, linked where it is or copied into `images/` as
    Image does; the alt text, title and link stay, except an alt text that was the old file's name, which becomes the
    new one's. While a dialog is open, Change picture and Image do nothing; if the picture changed meanwhile, nothing is
    replaced and a notice says so. Without `osascript` it opens the address box instead: Enter writes the address you
    typed, in `<…>` when it holds a space and with `(` and `)` as `%28` and `%29`. In a path, `#`, `?` and a `%` that
    starts no `%XX` escape are written as `%23`, `%3F` and `%25` too; a web address keeps them.
  - **Alt text:** the menu becomes a box holding the alt text. Enter writes what you typed, escaped so that it reads
    back exactly so (`*`, `_`, brackets and backticks too); Escape goes back to the menu, and a click outside closes
    both, writing nothing.
  - **Copy address:** a file's full path, so it pastes into Finder or a terminal; any other address as written. The
    button shows a check until the menu closes.
  - **Open picture:** the file in your default app, a web picture in the browser; a `data:` picture has no file to open.
  - **Open link**, on a linked picture: follows its link.
  - **Delete picture:** removes the picture (a linked one with its link), its whole line when it stood alone on one,
    and the paragraph when it was the only one. The picture before it is picked, else the one after it.

  Each change is one Cmd+Z, which brings the picture back picked.
- **Keys** while a picture is picked: Backspace or Delete deletes it, Enter starts a new paragraph below the pictures,
  Left and Right pick the picture before or after it and leave the paragraph at its ends, Up and Down leave it at
  once, Escape lets it go. Cmd+C copies its markdown as the file writes it (`![alt](address)`, with its link around it
  when it has one) and Cmd+X cuts it as Delete does; pasted into a line of text it is a picture there, and pasted alone
  into a new paragraph it makes a paragraph of pictures. Page Up, Page Down, space, Home and End scroll and keep it
  picked; other keys do nothing.
- **Pictures in text:** a click on the icon or the alt text of a picture inside a line of text picks it: the whole
  picture is selected (its markdown never shows) and the same menu shows over it, where you clicked. A second click
  puts the caret in its alt text, to type there; a right-click picks it too. Inside a link the picture is picked and
  its menu has Open link; Cmd+click opens the link. Change picture and Alt text work as above; a reference-style
  picture is written inline for that picture alone when its address changes, or its alt text when that is its label
  (`![cat]`), and its definition stays. Delete picture removes it (a link holding only it too) and one of the spaces
  around it, so `see ![a](a.png) here` becomes `see here`. An HTML `<img>` tag's menu has no Change or Alt text:
  Copy address, Open picture, Delete picture, and Open link when a link holds it. With a picture picked, Backspace or Delete removes it as Delete picture does, typing
  replaces it with what you type, Escape closes the menu, and Cmd+C and Cmd+X copy or cut its markdown (a
  reference-style picture is copied inline). Each change is one Cmd+Z, which selects the picture again.
- **Linked pictures:** a click picks one like any other picture; Cmd+click opens its link, also in a file you can't
  edit.
- **Files you can't edit** (on another machine, read-only): a click picks a picture, and its menu has Copy address,
  Open picture and Open link only.
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
  contexts (`MdText5`...), the asset paths in the mod, `keys.json`, `install.sh`, the patches and the tests. The integrations also assume the
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
- **Icon provenance.** Twenty icons are from lucide-static 1.69.0 and ten from 1.73.0; four more match the path
  data of current Lucide icons, but the release they were copied from was not recorded. `spinner.svg` and `dots.svg` were drawn for
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
