// Bindings are app-wide and cannot be removed, so the table goes in once per runtime and never changes within a
// version: any change raises VERSION, which is part of every context's name. An action keeps its meaning and a
// handler for as long as any build shipped it.
// A binding at `X > Input` takes the key from the field entirely; one at `X` fires only for the keys the field gives
// away there (Backspace and Left at offset 0, Right at the end, Tab, Escape).
const VERSION = 2;
export const TEXT = `MdText${VERSION}`, RAW = `MdRaw${VERSION}`, SOURCE = `MdSource${VERSION}`;

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
  ...bind("cmd-shift-up", "mdb-move-up", BLOCKS),
  ...bind("cmd-shift-down", "mdb-move-down", BLOCKS),
  ...bind("cmd-v", "mdb-paste", BLOCKS),
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
export { INSTALLED };

export function installKeys(cx) {
  if (globalThis[INSTALLED]) return false;
  cx.bind_keys(BINDINGS);
  globalThis[INSTALLED] = true;
  return true;
}
