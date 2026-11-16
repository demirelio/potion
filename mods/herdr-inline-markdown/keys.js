// Bindings are app-wide and cannot be removed, so the table goes in once per runtime and never changes within a
// version: any change raises VERSION, which is part of every context's name. An action keeps its meaning and a
// handler for as long as any build shipped it.
// A binding at `X > Input` takes the key from the field entirely; one at `X` fires only for the keys the field gives
// away there (Backspace and Left at offset 0, Right at the end, Tab, Escape).
const VERSION = 7;
// NOTE is the field of a box over the page, the comment box's or the link's address box's: Enter there saves it, and
// Escape cancels it.
export const TEXT = `MdText${VERSION}`, RAW = `MdRaw${VERSION}`, SOURCE = `MdSource${VERSION}`, NOTE = `MdNote${VERSION}`;

const deep = ctx => `${ctx} > Input`;
const oneRow = ctx => `${ctx} && rows == one > Input`;
// While the slash menu is open, Up and Down move its highlight in a field of any height. A one-row field matches
// both bindings, which name the same action, so it does not matter which one wins.
const menuOpen = ctx => `${ctx} && menu == open > Input`;
const bind = (keystroke, action, contexts) => contexts.map(context => ({ keystroke, action, context }));
const BLOCKS = [deep(TEXT), deep(RAW)];

export const BINDINGS = [
  ...bind("enter", "mdb-enter", [deep(TEXT)]),
  ...bind("shift-enter", "mdb-shift-enter", [deep(TEXT)]),
  ...bind("cmd-enter", "mdb-cmd-enter", BLOCKS),
  ...bind("tab", "mdb-tab", BLOCKS),
  ...bind("shift-tab", "mdb-shift-tab", BLOCKS),
  ...bind("up", "mdb-up", [oneRow(TEXT), oneRow(RAW), menuOpen(TEXT)]),
  ...bind("down", "mdb-down", [oneRow(TEXT), oneRow(RAW), menuOpen(TEXT)]),
  ...bind("pageup", "mdb-pageup", BLOCKS),
  ...bind("pagedown", "mdb-pagedown", BLOCKS),
  ...bind("alt-up", "mdb-move-up", BLOCKS),
  ...bind("alt-down", "mdb-move-down", BLOCKS),
  ...bind("cmd-v", "mdb-paste", BLOCKS),
  ...bind("cmd-b", "mdb-bold", [deep(TEXT)]),
  ...bind("cmd-i", "mdb-italic", [deep(TEXT)]),
  ...bind("cmd-u", "mdb-underline", [deep(TEXT)]),
  ...bind("cmd-shift-x", "mdb-strike", [deep(TEXT)]),
  ...bind("cmd-shift-c", "mdb-code", [deep(TEXT)]),
  ...bind("cmd-shift-h", "mdb-highlight", [deep(TEXT)]),
  ...bind("cmd-k", "mdb-link", [deep(TEXT)]),
  ...bind("cmd-alt-m", "mdb-comment", [deep(TEXT)]),
  ...bind("enter", "mdb-note-save", [deep(NOTE)]),
  ...bind("escape", "mdb-note-cancel", [deep(NOTE)]),
  ...bind("cmd-z", "mdb-undo", [...BLOCKS, deep(SOURCE)]),
  ...bind("cmd-shift-z", "mdb-redo", [...BLOCKS, deep(SOURCE)]),
  ...bind("backspace", "mdb-backspace-start", [TEXT, RAW]),
  ...bind("left", "mdb-left-start", [TEXT, RAW]),
  ...bind("right", "mdb-right-end", [TEXT, RAW]),
  ...bind("escape", "mdb-escape", [TEXT, RAW]),
];

export const ACTIONS = [...new Set(BINDINGS.map(b => b.action))];

// A flag on globalThis outlives a reload of the mod, which a module variable does not.
const INSTALLED = `herdr-inline-markdown.keys.${VERSION}`;
// Herdr 0.1.16 clears every binding mods made each time it reads keys.json again, keeping its own and the person's,
// so a change to keys.json puts the table back: once for all open editors (REBOUND holds when), after Herdr has read it.
const REBOUND = "herdr-inline-markdown.keys.rebound";
export const KEYS_SETTLE_MS = 500;
export { INSTALLED, REBOUND };

// -> whether this editor puts the table back for a keys.json change, which only the first to ask does.
export function claimRebind(now = Date.now()) {
  if (now - (globalThis[REBOUND] ?? -Infinity) < 2 * KEYS_SETTLE_MS) return false;
  globalThis[REBOUND] = now;
  return true;
}

export function installKeys(cx, { again = false } = {}) {
  if (globalThis[INSTALLED] && !again) return false;
  cx.bind_keys(BINDINGS);
  globalThis[INSTALLED] = true;
  return true;
}
