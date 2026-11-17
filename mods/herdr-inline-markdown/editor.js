// A Markdown pane: one file, shown as a page (Reading) or as its source (Markdown). The file on disk is the truth:
// typing is saved a moment later, only over the text this pane last saw there, and a change on disk shows up here.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState, TextView, Editor as CodeView, EditorState } from "gpui-base";
import { theme, settings, home, appHome, window, focused, panes, layout, shared, setShared, exec, readTextFile, writeTextFile, watchFolder, nextCommand, notify } from "herdr";
import { MODES, basename, dirname, docToSource, eolOf, fileKey, isPictureName, modeOf, pictureMarkdown, pictureName, pictureSource, pictureWithAddress, pictureWithAlt, picturesOf, resolveLink, sourceSplice, sourceToDoc, stats, tildePath, toSource, toggleMode, touches, trimMap, writtenAddress } from "./lib.js";
import { applySplice, closeFence, diff, docToField, fenceGuard, field as fieldOf, fieldToDoc, indent, insertAfter, insertAt, insertBefore, insertLines, isCode, isText, lengthenFence, loneMarker, mergeIntoPrevious, mergeNext, move, nest, opensBlock, outdent, parse, parseInSteps, paste, pasteLines, picturesIn, remove, removePicture, removeRange, reparse, retype, sameDefs, separators, setLanguage, shortcut, split, toParagraph, toggleTask, type, unnest } from "./blocks.js";
import { BAR, BAR_MENU, BLOCK_BUTTON, CARD, CARDS, CHIP, CODE_HEAD, COLUMN, FRAME, LANG_MENU, LINK_BOX, LINK_POP, MENU, NOTES, NOTE_BOX, anchorBlock, barLayout, barMenuH, barMenuPlace, barPlace, blockAt, canZoom, cardLook, cardPlace, chipW, clampOffset, clampView, columnLeft, columnX, decideAxis, estimateHeight, frameBox, frameTool, gridAt, gridRowTop, isOneRow, languageMenuH, languageMenuPlace, lineOffsets, linkPopoverSize, marginLayout, maxOffset, menuPlace, nextCell, notesPlace, overflows, pageStep, passThrough, pictureLayout, popoverPlace, popoverSize, prefixSums, pressToField, revealAt, revealOffset as keepInView, sharpScale, slashX, stackCards, startView, startsGesture, tablePress, tableRowTop, toolsTop, topDown, wrapPlace, wrapRows, zoomAround, zoomStep } from "./geometry.js";
import { gridOf } from "./grid.js";
import { tableOf } from "./tables.js";
import { COMMANDS, follow, opensAt, step, track } from "./slash.js";
import { createHistory, mergeChange } from "./history.js";
import { openMarkdown, paneOf, registerPane, rememberRecent } from "./open.js";
import { Diagrams } from "./diagrams.js";
import { Images } from "./images.js";
import { DialogUnavailable, PictureDialog, altNames, imageStart, placePictures } from "./pick.js";
import { ACTIONS, KEYS_SETTLE_MS, LANG, NOTE, SOURCE, claimRebind, installKeys } from "./keys.js";
import { MENU_ROWS, infoWord, languageMatches, languageName, languageOf } from "./languages.js";
import { actedOn, colorOf, hasMark, highlightOf, setColor, setMark, toggleMark, wordAround } from "./format.js";
import { editOf, formatAt, mend } from "./mend.js";
import { MARK_BITS } from "./restyle.js";
import { copyOf, holdsBlocks, joinRuns, pasteInto, pasteParagraphs, splitRuns } from "./seams.js";
import { addLink, clipboardAddress, linkAddress, pictureCut, pictureForm, setAddress, setPicture, unlink } from "./links.js";
import { addComment, cellComments, commentable, commentsIn, editComment, noteText, oneLine, readNote, resolveComment, showComments, timeLabel } from "./comments.js";
import { addBlockNote, addPictureNote, blockUnit, editBlockNote, editCellNote, editPictureNote, notesAfter, ownerOf, ownsNotes, pairNotes, removeWithNotes, resolveBlockNote, resolveCellNote, resolvePictureNote } from "./blocknotes.js";
import { TEXT_COLORS, deepHighlightColor, highlightColor, textColor } from "./colors.js";
import { Block, CALIBRATED, Column, FRAMED, FRONT_BOX, BOX, INDENT, MARKER_W, PICTURE_FRAME, QUOTE_BAR, QUOTE_PAD, STYLES, displayText, isRaw, lookOf, markerOf, newOwnerId, owners, renderBlock, spaceBefore } from "./page.js";
import { parseInline, parsedInline, visibleMap } from "./inline.js";
import { drawnOffset, extentOf, piecesOf, pressedAt, richOf, sameTokens, tokensFor } from "./tokens.js";

const SAVE_MS = 700;
const LOCAL_POLL = 4000, REMOTE_POLL = 5000;
const MODES_KEY = "herdr-inline-markdown.modes", MODES_MAX = 200;
// Same names as in the my-pane header mod: mods can't import each other.
const HEADS_KEY = "herdr-inline-markdown.heads", TOGGLE_KEY = "herdr-inline-markdown.toggle", HEADER_MOD = "my-pane";
const MARKDOWN_ICON = "mods/herdr-inline-markdown/file-markdown.svg";
const WIDE = 560;
const BIG = 50000; // a longer buffer is counted when it settles (a save timer, a load, a mode switch), not on every key
// Texts this long are parsed in SLICE_MS slices so the app keeps running: one parse of 1 MiB blocks it for 330 ms or more.
const SLICE_FROM = 200 * 1024, SLICE_MS = 20;
const SANS = ".SystemUIFont";
const ARROW_STEP = 48;
const MOVES = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
const CLICK_SLOP = 4;
const REVEAL_AT = 1 / 3;
const UNUSUAL = "Read-only: unusual characters";
const RULE_H = 24, DIAGRAM_H = 120;
const CAL_SAMPLE = "abcdefghij klmnopqrst uvwxyzABCD EFGHIJK";
const CAL_MONO = "0123456789abcdefghijklmnopqrstuvwxyz{}()";
// A field takes the keyboard once it is drawn: focus is asked for again this long after an activation.
const REFOCUS_MS = 80;
// The field places its caret a moment after a mouse-up: it is read only then.
const READ_AFTER_UP_MS = 30;
const PIECES_KEPT = 2000;
const WRAPS_KEPT = 256;
// Herdr reports no change for a token set; one that did would come within a frame or two. Until this has passed, a
// change that leaves the text as it was is taken as that report, not as a forward Delete.
const ECHO_MS = 100;
const NO_CARET = { start: 0, end: 0, valid: false };
const MOUNT_ALL = 400;
const WINDOW_MARGIN = 1500, INLINE_MARGIN = 800;
// Screens above and below the viewport: a text block gets a field of its own within the first, and keeps it within the
// second, so scrolling to and fro across one edge does not make and let go the same fields.
const FIELDS_MADE_WITHIN = 1, FIELDS_KEPT_WITHIN = 3;
// The page is laid out before the viewport reports its size: the first window is made for a page this tall.
const UNSIZED_VIEW_H = 1200;
// A recalibration whose samples, once drawn, never report sizes keeps the measurements it had.
const CAL_GIVE_UP_MS = 2000;
const UNDO_ACTIONS = { "mdb-undo": -1, "mdb-redo": 1 }, UNDO_KEYS = { "cmd-z": -1, "cmd-shift-z": 1 };
// The mark each format action stands for, which the bar shows pressed; the link is made by the address box (linkKey).
const MARK_ACTIONS = {
  "mdb-bold": "bold", "mdb-italic": "italic", "mdb-underline": "underline", "mdb-strike": "strike", "mdb-code": "code",
  "mdb-highlight": "highlight", "mdb-link": "link",
};
// The format bar's groups of buttons, parted by thin rules. A button does what its key's `action` does, or opens its
// `menu`; the Text style and List buttons draw the edited block's style instead of an icon of their own.
const FORMAT_BAR = [
  [{ name: "comment", action: "mdb-comment", icon: "message-square-plus", tip: "Comment (Cmd+Alt+M)" }],
  [{ name: "style", menu: "style", tip: "Text style" }],
  [
    { name: "bold", action: "mdb-bold", icon: "bold", tip: "Bold (Cmd+B)" },
    { name: "italic", action: "mdb-italic", icon: "italic", tip: "Italic (Cmd+I)" },
    { name: "underline", action: "mdb-underline", icon: "underline", tip: "Underline (Cmd+U)" },
    { name: "strike", action: "mdb-strike", icon: "strikethrough", tip: "Strikethrough (Cmd+Shift+X)" },
    { name: "code", action: "mdb-code", icon: "code", tip: "Code (Cmd+Shift+C)" },
  ],
  [{ name: "color", menu: "color", icon: "palette", tip: "Colour" }],
  [{ name: "list", menu: "list", tip: "List" }],
  [{ name: "link", action: "mdb-link", icon: "link", tip: "Link (Cmd+K)" }],
];
const BAR_BUTTONS = new Map(FORMAT_BAR.flat().map(b => [b.name, b]));
const buttonW = b => (b.menu ? BAR.button + BAR.chevron : BAR.button);
const FORMAT_GROUPS = FORMAT_BAR.map(group => group.map(b => ({ name: b.name, w: buttonW(b) })));
const BAR_RULE_H = 16;
const commandOf = id => COMMANDS.find(c => c.id === id);
const STYLE_ROWS = ["text", "h1", "h2", "h3", "quote"], LIST_ROWS = ["ul", "ol", "todo"];
const LIST_COMMANDS = { bullet: "ul", ordered: "ol", task: "todo" };
// What the Text style button draws for a block its menu has no row for: an item, a heading deeper than the menu's.
const UNLISTED_STYLE = { heading: { icon: "heading" }, other: { icon: "type" } };
const capitalized = s => s[0].toUpperCase() + s.slice(1);
// The bar's menus by the button that opens them: sections of rows, under a title or not. A style row is a slash.js
// command, whose `to` the block becomes; a colour row sets a text `color` or puts a `highlight` on or off.
const BAR_MENUS = {
  style: [{ rows: STYLE_ROWS.map(commandOf) }],
  list: [{ rows: LIST_ROWS.map(commandOf) }],
  color: [
    { id: "text", title: "Text", rows: ["default", ...TEXT_COLORS].map(color => ({ id: `text-${color}`, name: capitalized(color), color })) },
    { id: "highlight", title: "Highlight", rows: [{ id: "highlight-none", name: "No highlight", highlight: false }, { id: "highlight-yellow", name: "Yellow", highlight: true }] },
  ],
};
const menuRowsOf = name => BAR_MENUS[name].flatMap(s => s.rows);
const HIGHLIGHT_ROWS = { none: "highlight-none", default: "highlight-yellow" };
const COMMENT_REFUSED = {
  overlap: "A comment can't cut through another one",
  code: "Comments can't go in code",
  paragraphs: "A comment stays within one paragraph",
};
const NOTE_CLIP = 80;
// The comment field grows with its text up to this many rows.
const NOTE_ROWS = 12;
const BLOCK_NOTES_MEMO = "block-notes", PICTURE_NOTES_MEMO = "picture-notes";
const COUNT_CHIP_GAP = 4;
// Where Reading's TextView draws a table: under its box's 1 px border and padding, each row a line of the cell style.
const TABLE_INSET = 1 + BOX.py, CELL_LINE_H = STYLES.cell.size * STYLES.cell.lh;
const holdsComments = b => isText(b) || b.kind === "table";
const shownText = markdown => parseInline(markdown).chars.map(c => c.text).join("").trim();
const noted = text => commentsIn(text).filter(c => c.note !== null);
// The comments of a paragraph of pictures (picturesOf's `list`) in the order they are written, each with the index of
// its picture and what names that picture.
const pictureNotesOf = list => list.flatMap((p, picture) => (p.comment ? [{ kind: "comment", note: p.comment.note, picture, name: pictureName(p) }] : []));
// Herdr writes Cmd+Alt+M `alt-cmd-m`: it is told by its key and modifiers.
const isCommentKey = ({ key, modifiers: m = {} }) => key === "m" && Boolean(m.platform && m.alt) && !m.control && !m.shift;
// The cards of field value `value`'s comments: each comment with where its card is level with, its time and text, and
// the look of its card when not active.
const cardsOf = value => noted(value).map((c, index) => {
  const { when, text } = readNote(c.note);
  return { c, index, at: c.kind === "point" ? c.start : c.from, when, text, look: cardLook({ text, header: true }) };
});
const clip = (text, n) => {
  const chars = [...text];
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : text;
};
const clipMiddle = (text, n) => {
  const chars = [...text], tail = Math.floor((n - 1) / 2);
  return chars.length > n ? `${chars.slice(0, n - 1 - tail).join("")}…${chars.slice(-tail).join("")}` : text;
};
// What a press on a token of a writable text block can pick, besides text: an element, which the press selects whole
// and whose float shows in place of the format bar. Keyed by the kind of its parseInline span; `float` is the method
// that draws it.
const ELEMENTS = {
  link: { float: "linkPopover" }, comment: { float: "commentFloat" }, point: { float: "commentFloat" }, image: { float: "imageFloat" },
};
const COMMENT_KINDS = new Set(["comment", "point"]);
const NEW_CARD = "md-card-new", FLOAT_CARD = "md-card-float";
// Cards this far above and below the viewport are drawn too, so a short scroll shows no gap before the next draw.
const CARD_SLACK = 200;
// Look letters (tokens.js) of the text a comment is being written on, and of the active comment's.
const TINT_NEW = "h", TINT_ACTIVE = "d";
const CARD_TIME_SIZE = 11.5;
const LINK_BUTTONS = [
  { name: "open", icon: "external-link", tip: "Open link" },
  { name: "copy", icon: "copy", tip: "Copy link", done: { icon: "check", tip: "Copied" } },
  { name: "edit", icon: "pencil", tip: "Edit link" },
  { name: "remove", icon: "unlink", tip: "Remove link" },
];
// The picked picture's float. `edits`: only on a file that can be edited; `markdown`: not on an HTML <img> tag;
// `linked`: only on a linked picture; `apart`: a rule before it.
const PICTURE_BUTTONS = [
  { name: "comment", icon: "message-square-plus", tip: "Comment (Cmd+Alt+M)", edits: true, markdown: true },
  { name: "change", icon: "image-up", tip: "Change picture", edits: true, markdown: true },
  { name: "alt", icon: "type", tip: "Alt text", edits: true, markdown: true },
  { name: "copy", icon: "copy", tip: "Copy address", done: { icon: "check", tip: "Copied" } },
  { name: "open", icon: "external-link", tip: "Open picture" },
  { name: "link", icon: "link", tip: "Open link", linked: true },
  { name: "delete", icon: "trash-2", tip: "Delete picture", edits: true, apart: true },
];
const PICTURE_CHANGED = "The picture changed meanwhile, so it wasn't replaced";
const NO_PICTURE_FILE = "This picture has no file to open";
const NO_ADDRESS = "No address";
// A picture's float for the address `src` and `buttons`: a rule after the address and before each button set apart.
const pictureFloatSize = (src, buttons) => {
  const shown = clipMiddle(src, LINK_POP.addressChars) || NO_ADDRESS;
  return popoverSize([...shown].length, buttons.length, 1 + buttons.filter(b => b.apart).length);
};
const LANG_ACTIONS = new Set(["mdb-lang-pick", "mdb-lang-close", "mdb-lang-up", "mdb-lang-down"]);
const CHIP_CHARS = 24;
// The language menu's rows for what was typed: languages, then a row ({ typed }) writing a word the list doesn't know.
const languageRows = query => {
  const { items, typed } = languageMatches(query);
  return typed ? [...items, { typed }] : items;
};
// A code block's box starts with the language strip, a diagram's only while its source is being edited.
const stripped = (b, active) => b.kind === "code" || (b.kind === "mermaid" && active);
const NO_STRIP = { strip: false, chip: "", chipW: 0, chipLive: false, chipOpen: false };
const codeStartIn = (doc, b) => fieldToDoc(fieldOf(doc, b), 0);
const inBox = (box, x, y) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const LINK_REFUSED = "A link can't hold another link";
// Whether a link can go somewhere does not depend on its address: this one stands in before one is typed.
const ANY_ADDRESS = "#";
const SOURCE_TYPING = "source";
const spliceOf = d => ({ start: d.at, end: d.at + d.removed, insert: d.inserted });
const HARD_BREAK = "\\\n", SPACE_OR_TAB = " \t";
// Field range [start, end) of `value` out over the spaces beside it, which a split drops.
function spacedOut(value, start, end) {
  let a = start, z = end;
  while (a > 0 && SPACE_OR_TAB.includes(value[a - 1])) a--;
  while (z < value.length && SPACE_OR_TAB.includes(value[z])) z++;
  return { start: a, end: z };
}
// The value of field `f` with the soft line breaks it shows as spaces written as line breaks again, at the same offsets.
function softBreaksIn(f) {
  let out = "", at = 0;
  for (const sep of separators(f)) {
    if (sep.shown !== " ") continue;
    out += `${f.value.slice(at, sep.at)}\n`;
    at = sep.at + 1;
  }
  return out + f.value.slice(at);
}

const ICON = name => `mods/herdr-inline-markdown/${name}.svg`;
const why = e => String(e?.message ?? e);
// What readTextFile says about a file over its 1 MiB limit is not written down anywhere: go by the usual words.
const tooBig = e => /mib|too (large|big)|exceed|larger than/i.test(why(e));
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Sizes and pointer positions come in screen pixels; the layout works in the pixels the zoom setting scales.
const zoom = () => Number(settings()?.zoom) || 1;
const windowPoint = e => (e?.position ? { x: e.position.x / zoom(), y: e.position.y / zoom() } : null);
const elementOrigin = e => (e?.position && e.local_position ? { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y } : null);
const monoFont = () => settings()?.font_family || "JetBrains Mono";
const sansFont = cx => {
  try { return cx.theme?.()?.typography?.sans || SANS; } catch { return SANS; }
};
const sameData = (a, b) => {
  for (const k in a) if (a[k] !== b[k]) return false;
  return true;
};
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameWindow = (a, b) => a === b || (Boolean(a) && Boolean(b) && a.order === b.order && a.from === b.from && a.to === b.to && a.extra === b.extra
  && a.held === b.held && a.split === b.split && a.above === b.above && sameList(a.gaps, b.gaps));
const diagramSig = (d, last) => (d ? `${d.state}:${d.key}:${d.width}x${d.height}:${d.error ?? ""}:${last?.key ?? ""}` : "");
const NO_FRAME = {
  frameW: 0, frameH: 0, frameMl: 0, frameLeft: 0, natW: 0, natH: 0, z0: 1, zMin: 1, startX: 0, startY: 0,
  imgKey: "", imgScale: 0, imgDim: false, boxAbove: false, sharpKey: "",
};
const boxOf = d => ({ w: d.frameW, h: d.frameH });
const natOf = d => ({ w: d.natW, h: d.natH });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Offset p of a text after the change d (diff's { at, removed, inserted }); -1 when d removed what was at p.
const mapPos = (d, p) => (p < d.at ? p : p >= d.at + d.removed ? p + d.inserted.length - d.removed : -1);
const mapCaret = (d, p) => {
  const q = mapPos(d, p);
  return q < 0 ? d.at + d.inserted.length : q;
};
// A field's selection { start, end } in UTF-16 offsets, start first; null when the field cannot say.
function caretOf(state) {
  try {
    const { start, end } = state.selected_range();
    return { start: Math.min(start, end), end: Math.max(start, end) };
  } catch { return null; }
}
const docRange = (f, r) => ({ start: fieldToDoc(f, r.start), end: fieldToDoc(f, r.end) });
// Whether field change `edit` is one a key makes at the caret or selection `known` (else the caret moved unread).
const madeAt = (known, edit) => known.valid && (known.start === known.end
  ? edit.at === known.start || edit.at + edit.removed === known.start
  : edit.at === known.start && edit.at + edit.removed === known.end);
// The key that made field change `edit` at caret `at`, as the history groups keys: "type" for text typed there,
// "backspace" or "delete" for a deletion ending or starting there; null for any other change.
function strokeAt(edit, at) {
  if (!edit.removed) return edit.at === at ? "type" : null;
  if (edit.inserted) return null;
  return edit.at + edit.removed === at ? "backspace" : edit.at === at ? "delete" : null;
}
const fieldRange = (f, r) => ({ start: docToField(f, r.start), end: docToField(f, r.end) });
// Field value `a` to `b` as splices { at, removed, inserted } on either side of the text both keep, the later first. A
// field shows a soft line break as a space, and typing over it would write the space into the file.
function marksEdits(a, b) {
  const d = diff(a, b), removed = a.slice(d.at, d.at + d.removed), inserted = d.inserted;
  const wrapAt = removed ? inserted.indexOf(removed) : -1, unwrapAt = inserted ? removed.indexOf(inserted) : -1;
  if (wrapAt >= 0) {
    return [
      { at: d.at + removed.length, removed: 0, inserted: inserted.slice(wrapAt + removed.length) },
      { at: d.at, removed: 0, inserted: inserted.slice(0, wrapAt) },
    ].filter(e => e.inserted);
  }
  if (unwrapAt >= 0) {
    return [
      { at: d.at + unwrapAt + inserted.length, removed: removed.length - unwrapAt - inserted.length, inserted: "" },
      { at: d.at, removed: unwrapAt, inserted: "" },
    ].filter(e => e.removed);
  }
  return [d];
}
// The field splices `edits` of a block's field map `f` (the later first, as marksEdits gives them) as one splice of the
// document, which keeps what lies between them as the document has it.
function docSplice(f, edits) {
  const at = e => fieldToDoc(f, e.at), past = e => fieldToDoc(f, e.at + e.removed);
  const start = at(edits.at(-1)), end = past(edits[0]);
  let insert = "", from = start;
  for (const e of [...edits].reverse()) {
    insert += f.text.slice(from, at(e)) + e.inserted;
    from = past(e);
  }
  return { start, end, insert: insert + f.text.slice(from, end) };
}

const byKey = (doc, key) => doc.blocks.find(b => b.key === key) ?? null;
// The link whose markup holds offset x of a field value, among parseInline's spans.
const linkAt = (spans, x) => spans.find(sp => sp.kind === "link" && sp.start <= x && x < sp.end) ?? null;
// The block whose span or gap holds document offset `at` (the first block for the lead).
function holdingIn(doc, at) {
  const bl = doc?.blocks ?? [];
  let lo = 0, hi = bl.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bl[mid].start <= at) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return bl[Math.max(0, found)] ?? null;
}
const topIn = (doc, b) => {
  let x = b;
  while (x.parent >= 0) x = doc.blocks[x.parent];
  return x;
};
const listOf = b => (b.task ? "task" : b.ordered ? "ordered" : "bullet");
// The slash.js command a text block's style is, or null: a heading deeper than the menu's, or no block.
function styleId(b) {
  if (b?.kind === "item") return LIST_COMMANDS[listOf(b)];
  if (b?.kind === "heading") return b.level <= 3 ? `h${b.level}` : null;
  return b?.kind === "quote" ? "quote" : b?.kind === "paragraph" ? "text" : null;
}
const styleIcon = b => (STYLE_ROWS.includes(styleId(b)) ? commandOf(styleId(b)).icon : (UNLISTED_STYLE[b?.kind] ?? UNLISTED_STYLE.other).icon);
const listIcon = b => commandOf(b?.kind === "item" ? styleId(b) : "ul").icon;

// A block not written yet (pending) is written with its first text by its `base`, (doc, text) -> splice: after the
// last block, after or before the block with a key. Its `steps` then run on the block that wrote. Nothing goes between
// a block and the paragraph of its comments: after the block is after them, before them is after them too.
const PLACEHOLDER = "x";
const atEnd = (doc, text) => {
  const last = doc.blocks.at(-1);
  return last ? insertAfter(doc, topIn(doc, last), "paragraph", text) : insertAt(doc, "paragraph", text);
};
const afterKey = (key, kind) => (doc, text) => {
  const b = byKey(doc, key);
  return b && insertAfter(doc, notesAfter(doc, b) ?? b, kind, text);
};
const beforeKey = (key, kind) => (doc, text) => {
  const b = byKey(doc, key);
  return b && (ownerOf(doc, b) ? insertAfter(doc, b, kind, text) : insertBefore(doc, b, kind, text));
};
// Where picked pictures go, written as a pending block is: a `base` and its `steps`.
const AT_END = { base: atEnd, steps: [] };
const belowBlock = key => ({ base: afterKey(key, "paragraph"), steps: [] });
const placeOf = pending => ({ base: pending.base, steps: pending.steps });
const PICTURES_ONLY = "Only pictures can be dropped here (PNG, JPEG, GIF, WebP, BMP, SVG)";
const STEPS = { indent, outdent, paragraph: toParagraph, nest, unnest };
const UNDOES = { indent: "outdent", outdent: "indent", nest: "unnest", unnest: "nest" };
// Splice `s` of doc, then each step (a name in STEPS, or (doc, block, caret) -> splice) on the block at the caret the
// splice before it left. -> { splice (one splice of doc's text), doc (after it), block (the one the steps worked on) },
// or null when a step does not apply.
function chain(doc, s, steps) {
  if (!s) return null;
  let d = reparse(doc, s), at = s.caret;
  for (const step of steps) {
    const b = holdingIn(d, at), t = b && (typeof step === "function" ? step(d, b, at) : STEPS[step](d, b));
    if (!t) return null;
    d = reparse(d, t);
    at = t.caret;
  }
  const x = diff(doc.text, d.text);
  return { splice: { start: x.at, end: x.at + x.removed, insert: x.inserted, caret: at }, doc: d, block: holdingIn(d, at) };
}
function pendingRecord(key, b) {
  return Object.assign(b.copy(), {
    key, start: -1, end: -1, gapEnd: -1, subtreeEnd: -1, index: -1, lines: [], content: "", render: "", source: "",
    image: false, task: b.task ? { checked: false, offset: -1 } : null,
  });
}
const FENCE_TYPED = /^(```|~~~)[^`\n]*$/;
const RULE_TYPED = /^(---|\*\*\*|___)$/;
const EMPTY_MARKS = /^(?:\*{4,}|~{4,})$/;
// The field of front matter with no line between its dashes shows an empty one there, so that the caret never has to
// sit on a dash line; the source gets that line with the first change typed in the field.
const withInnerLine = (b, value) => {
  if (b.kind !== "frontmatter") return value;
  const first = value.indexOf("\n"), inner = first >= 0 && value.indexOf("\n", first + 1) >= 0;
  if (inner) return value;
  const end = first < 0 ? value.length : first;
  return `${value.slice(0, end)}\n${value.slice(end)}`;
};
const leadingBlank = line => /^[ \t]*/.exec(line)[0];
const BLANK_LINE = /^[ \t]*$/;
function endsInTwoBlankLines(value) {
  const last = value.lastIndexOf("\n");
  if (last < 0) return false;
  const prev = last > 0 ? value.lastIndexOf("\n", last - 1) : -1;
  return BLANK_LINE.test(value.slice(last + 1)) && BLANK_LINE.test(value.slice(prev + 1, last));
}
const TAB_WIDTH = 4, SMALLEST_SPACE_INDENT = 2;
// What one Tab indents the code `value` by: a tab when more of its indented lines start with one than with a space,
// else its smallest space indent of two or more, else a tab's width of spaces.
function indentUnit(value) {
  let tabs = 0, spaces = 0, fewest = Infinity;
  for (const line of value.split("\n")) {
    const lead = leadingBlank(line);
    if (!lead || lead.length === line.length) continue;
    if (lead[0] === "\t") tabs++;
    else {
      spaces++;
      const n = /^ */.exec(lead)[0].length;
      if (n >= SMALLEST_SPACE_INDENT && n < fewest) fewest = n;
    }
  }
  if (tabs > spaces) return "\t";
  return " ".repeat(fewest < Infinity ? fewest : TAB_WIDTH);
}
// A selection ending right at a line's start leaves that line out.
function linesTouched(value, r) {
  const last = r.end > r.start && value[r.end - 1] === "\n" ? r.end - 1 : r.end;
  const starts = [r.start > 0 ? value.lastIndexOf("\n", r.start - 1) + 1 : 0];
  for (let p = value.indexOf("\n", starts[0]); p >= 0 && p < last; p = value.indexOf("\n", p + 1)) starts.push(p + 1);
  return starts;
}
const emptyLineAt = (value, at) => at === value.length || value[at] === "\n";
// A leading tab, else up to one indent unit of leading spaces.
function outdentWidth(value, at, unit) {
  if (value[at] === "\t") return 1;
  const most = unit === "\t" ? TAB_WIDTH : unit.length;
  let n = 0;
  while (n < most && value[at + n] === " ") n++;
  return n;
}
// Where field offset `p` lands once `edits` ({ at, removed, inserted }, in order, apart) are applied: past what was
// inserted at or before it; inside removed text, at the end of what replaced it.
function mappedThrough(edits, p) {
  let shift = 0;
  for (const e of edits) {
    if (e.at > p) break;
    if (p < e.at + e.removed) return e.at + shift + e.inserted.length;
    shift += e.inserted.length - e.removed;
  }
  return p + shift;
}

// What `herdr-app check` opens (no props; every real opener passes a file): every kind of block, its text blocks drawn
// by fields of their own, block 2 edited with its slash menu open, a diagram frame wider than the column, a commented
// picture picked with its float, the comments of the quote, the js block, a table cell and the picture on their cards in
// the margin while a new comment's card is being written, and the js block's language menu open.
const FIXTURE = [
  "---", "title: herdr-inline-markdown check fixture", "---",
  "# Every kind of block", "",
  "A paragraph with **bold**, _emphasis_, `code` and a [link](https://example.com). /", "",
  "Plain words only.", "",
  "- A bullet item", "  - A nested item", "    - A third level", "- [ ] An open task", "- [x] A done task", "",
  "1. First", "2. Second", "",
  "> A quote with a [reference link][ref] and {==a remark==}{>>2026-11-16 20:51 | a comment on it<<}.", "",
  "```js", "const answer = 42;", "```", "",
  "{>>2026-11-17 09:00 | why 42?<<}", "",
  "```mermaid", "graph TD", "A-->B", "```", "",
  "    indented code", "",
  "| Column | Other |", "|--------|-------|", "| a      | {==b==}{>>2026-11-17 09:00 \\| on a cell<<} |", "",
  "<div>Some html</div>", "",
  "<!-- a comment -->", "",
  "***", "",
  "[ref]: https://example.com", "",
  "{==![A picture](picture.png)==}{>>2026-11-17 09:00 | a comment on the picture<<}", "",
  "A setext heading", "----------------", "",
].join("\n");
const FIXTURE_DIAGRAM = { key: "check-fixture", state: "ok", width: 1800, height: 300, scale: 2, error: null };
const FIXTURE_PICTURE = { state: "ok", path: MARKDOWN_ICON, width: 32, height: 32, error: null };

export class Editor {
  init(props, cx) {
    this.file = typeof props?.file === "string" && props.file ? props.file : null;
    this.machine = props?.machine ?? null;
    this.remote = Boolean(this.machine); // a file on another machine is read and followed, never written
    this.mode = "reading";
    // disk: the text the file had when we last looked (what a save must still find there); saving: the text being
    // written; conflict: what the file holds when it is not what we expected; relook: a look moved `disk` mid-write.
    this.disk = ""; this.text = ""; this.settled = "";
    this.saving = null; this.conflict = null; this.missing = false; this.saveError = null;
    this.loaded = false; this.error = null; this.closed = false; this.locked = null;
    this.stamp = 0; this.checking = false; this.again = false; this.relook = false; this.lookAfterLoad = false;
    this.parsing = false; this.readWhenParsed = false;
    this.saveTask = null; this.pollTask = null;
    this.size = null;
    this.claimed = null;
    // The header's last toggle request is old news to a copy that starts after it.
    this.toggleSeen = shared(TOGGLE_KEY)?.n ?? null; this.headSig = null; this.headedFor = undefined; this.headedIs = false;
    this.countsFor = null; this.countList = { words: 0, lines: 0 };
    this.fonts = { sans: SANS, mono: monoFont() };
    this.handle = cx.focus_handle();
    // Herdr parses every context of the table: a refused table fails `herdr-app check`, while an editor of a file goes
    // on without it, its fields typing as plain text fields do.
    this.keysBound = true;
    try { installKeys(cx); } catch (e) { if (!this.file) throw e; this.keysBound = false; }
    // Every change of the buffer must reach it, ours as entries and outside ones as a rebase: an entry's offsets are
    // only good for the text it left.
    this.history = createHistory();

    // Markdown state: the source field shows `srcFor` mapped by `src`; `srcSeen` is its value as last seen or set.
    this.source = TextareaState.new({ value: "" });
    this.source.set_soft_wrap(true);
    this.source.on("change", (_e, cx) => this.sourceChanged(cx));
    this.src = toSource(""); this.srcFor = ""; this.srcSeen = "";
    this.viewer = this.remote ? EditorState.new({ language: "markdown", readonly: true, line_numbers: false, folding: false, soft_wrap: true, font_family: monoFont(), font_size: 13.5 }) : null;

    // Reading: one Block entity per block of `doc` (and a pending one) inside the Column entity, scrolled by `offset`.
    // `sums` are the block tops from measured or estimated heights; `at` maps a key to its index in `blocks`; `win` is
    // what the Column mounts of a long page (windowFor).
    this.doc = null; this.blocks = []; this.at = new Map(); this.order = []; this.diagramKeys = []; this.data = new Map(); this.entities = new Map();
    this.heights = new Map(); this.estimates = new WeakMap(); this.sums = [0]; this.offset = 0; this.viewport = null; this.reveal = null; this.win = null; this.winTimer = null;
    this.press = null; this.thumb = null; this.pointer = null; this.fieldPress = null; this.fieldHeld = null; this.dragFrom = null; this.linked = false;
    this.diagrams = new Diagrams();
    this.diagrams.onChange = cx => this.assetsChanged(cx);
    this.images = new Images();
    this.images.onChange = cx => this.assetsChanged(cx);
    this.picking = false; this.dialog = null;
    this.shown = new Map(); this.good = new Map(); // block key -> what the diagram answered, and its last image
    // block key -> the pictures of an image paragraph: { content, list (picturesOf), notes (pictureNotesOf), items (list
    // with what Images answered), layout }
    this.pictures = new Map();
    // Diagram frames: `frames` the view ({ z, x, y }) of each frame panned or zoomed (none: its starting view), `pan` a
    // press on a frame ({ key, from, x0, y0, moved }), `hoverTop` where the hovered frame's − % + group sits, `gesture`
    // the wheel gesture going on, `zoomed` the frames zoomed since the zoom last rested. `hoverBox` is the code block or
    // table under the pointer, which shows its Comment button.
    this.frames = new Map(); this.pan = null; this.hoverFrame = null; this.hoverTop = null; this.gesture = null;
    this.zoomed = new Set(); this.settleTimer = null; this.hoverBox = null;

    // Every text block near the viewport is drawn by a field of its own (`blockFields`: key -> { state, and what its
    // value and tokens were made from }; `fieldKeys` the other way), edited or not, so a press lands in it natively and
    // nothing moves. A block with no field of its own (code, a table, one not written yet) is edited in `loose`.
    // The edited block: `field` is its text state (`loose` while none is edited), `f` its field map, `seen` the
    // field's value as last seen or set, `opened` its value when the block was opened, `known` the caret as last read
    // or set (what a key-up's caret is compared with, and where typing went in when its change alone cannot tell),
    // `act` the activation number, `stale` that text was typed since `doc`. `shiftField` is the block whose field a
    // Shift+press went into, which selects blocks instead; `cmdPress` ({ key, opened }) a Cmd+press in a block's field,
    // which may open a link instead. `fieldGen` counts the times blocks got or lost a field of their own.
    this.blockFields = new Map(); this.fieldKeys = new Map(); this.defs = null; this.fieldGen = 0;
    this.loose = this.newField();
    this.field = this.loose;
    this.activeKey = null; this.pending = null; this.pendings = 0;
    this.f = null; this.seen = ""; this.opened = ""; this.known = NO_CARET; this.act = 0; this.rows = "many";
    this.stale = false; this.stored = null; this.focusedState = null;
    this.ownKeyUp = null; this.menuKeyUp = null; this.revealNext = false; this.inbox = []; this.watching = false; this.shiftField = null; this.cmdPress = null;
    // `owed`: per field state, the change events still to come for changes already taken in (our own replace() calls,
    // and typing an action took in before its event). An unowed change that leaves the value as it was is forward
    // Delete at the end of the field.
    this.owed = new Map();
    // Inline tokens of the active field: `rich` the layout of its value (tokens.js), kept with what it was made from;
    // `pieces` what each token draws; `tokensHeld` while the editor's own edits run; `tokensOff` when the field took none;
    // `echoes`, per field state, the numbers of the token sets made in the last ECHO_MS, oldest first.
    // `tinted` what tintNow last gave, with what it was worked out from.
    this.rich = null; this.tinted = null; this.pieces = new Map(); this.tokensHeld = false; this.tokensOff = false;
    this.echoes = new Map(); this.tokenSets = 0;
    // The typing style: the formatting text typed next at one caret gets ({ act, value, at, format }), set by a format
    // key at a caret outside a word and by the key typed or deleted before; null while none.
    this.typingStyle = null;
    // Floats: `pressed` the last press in a field (its window x, which a token click lacks, the field's window origin,
    // the press in the field) and `released` where it ended; `pin` where a press or a drag put the floats of a range,
    // while the field draws it there; `wraps` the wrap estimates last asked for.
    this.pressed = null; this.released = null; this.pin = null; this.wraps = new Map();
    // `sel` names the selected blocks' two ends by key, `selKeys` the blocks it covers, `gens` each block's TextView
    // generation, raised to drop the TextView's own text selection when the block is selected.
    this.sel = null; this.selKeys = new Set(); this.gens = new Map();
    this.slash = null; this.bar = null; this.barMenu = null;
    // Comments: `card` names the block whose comments are listed, `note` the comment the box is writing (`noteField`)
    // for one activation, `highlight` the colour Reading marks them in and `deep` the active one's, `notesFor` the
    // count of each block of a doc. In the margin layout (`margin`, geometry.js marginLayout) they are cards: `cards`
    // their places as last worked out, `cardMemo` what each commented block's cards are read from, `raised` the
    // measured height of the active card.
    this.card = null; this.note = null; this.highlight = highlightColor(theme()); this.deep = deepHighlightColor(theme()); this.notesFor = null;
    this.margin = null; this.cards = null; this.cardMemo = new Map(); this.raised = null;
    // A code block's, diagram's or table's comments, those on the pictures of a paragraph of pictures and those in a
    // table's cells: `pairing` which block owns which comments paragraph in `doc` (blocknotes.js), `cellMemo` each
    // table's cell comments as its cards show them, `blockNote` the active one of them ({ key: the block's, index,
    // editing, cell: whether it is in a cell }), `blockAdd` the one being written for one activation ({ key: the
    // block's, act, caret: the block's own when it is the edited one, picture: the index of the picture it goes on or
    // -1 }).
    this.pairing = null; this.cellMemo = new Map(); this.blockNote = null; this.blockAdd = null;
    // Tables drawn as grids: `grids` each table's memo for grid.js gridOf, `rowHeights` its rows' measured heights.
    this.grids = new Map(); this.rowHeights = new Map();
    this.noteField = TextareaState.new({ placeholder: "Add a comment…" });
    this.noteField.set_auto_grow(1, NOTE_ROWS);
    this.noteField.on("submit", (_e, cx) => this.submitNote(cx));
    // Links: `element` the element a press picked (its popover shows while the selection stays in it), `pressedOn` the
    // one that was picked when the press began, `linkBox` what the address box (`linkField`) is open for.
    this.element = null; this.pressedOn = null; this.linkBox = null;
    this.linkField = InputState.new({ placeholder: "Paste or type a link" });
    this.linkField.on("submit", (_e, cx) => this.applyLinkBox(cx));
    // Pictures: `picked` the one a click picked in a paragraph of pictures ({ key, index, copied, box }), shown by its
    // float while no block is edited; `box` names the field open in the float's place, the alt text's or the address's.
    // A picture in a line of text is an element; `imageBox` is what the alt text's or address's field is open for there.
    // Herdr's input takes its placeholder only when it is made, so each box has a field of its own.
    this.picked = null; this.imageBox = null;
    this.altField = InputState.new({ placeholder: "Describe the picture" });
    this.altField.on("submit", (_e, cx) => this.savePictureBox(cx));
    this.addressField = InputState.new({ placeholder: "Paste a picture address or path" });
    this.addressField.on("submit", (_e, cx) => this.savePictureBox(cx));
    // The language menu a code block's chip opened ({ key, act, caret, query, items, index, first }), for one activation:
    // `caret` is the edited block's selection when the menu opened over it, which gets the keyboard back after it.
    this.lang = null;
    this.langField = InputState.new({ placeholder: "Search or type a language" });
    this.langField.on("change", (_e, cx) => this.languagesTyped(cx));
    this.langField.on("submit", (_e, cx) => this.languageKey("mdb-lang-pick", cx));

    // Calibration: `cal` is in use while `calNext` collects a run's measurements; `look` is the theme, fonts and zoom
    // last drawn in (a change reruns calibration; `calGen` names each run, `calTimed` the last one whose give-up clock
    // started).
    this.cal = {}; this.calNext = {}; this.calSizes = {}; this.calibrating = true; this.calGen = 0; this.calTimed = 0; this.calStates = {}; this.look = null;
    for (const name of CALIBRATED) {
      const one = TextareaState.new({ value: "Ag" }), three = TextareaState.new({ value: "Ag\nAg\nAg" });
      one.set_auto_grow(1, 10); three.set_auto_grow(1, 10);
      this.calStates[name] = { f1: one, f3: three };
    }

    this.id = newOwnerId();
    owners.set(this.id, this);
    this.inline = !this.file;
    if (!this.inline) {
      try { this.column = cx.new(Column, { owner: this.id }); } catch { this.inline = true; this.column = null; }
    }
    this.woken = null; this.wakeLater = false;
    if (!this.file) return this.openFixture();
    this.watchSizes(cx);
    this.load(cx);
    this.listen(cx);
    this.watch(cx);
    this.watchKeys(cx);
    rememberRecent(this.file, this.machine);
  }

  openFixture() {
    this.disk = this.text = this.settled = FIXTURE;
    this.loaded = true;
    this.doc = parse(FIXTURE);
    const active = this.doc.blocks[2];
    this.activeKey = active.key;
    this.f = fieldOf(this.doc, active); this.seen = this.opened = this.f.value;
    this.field = this.fieldFor(active);
    this.guard(() => this.field.set_value(this.seen));
    const slashAt = this.seen.length - 1;
    this.known = { start: slashAt + 1, end: slashAt + 1, valid: true };
    this.retoken();
    this.slash = { act: this.act, at: slashAt, end: slashAt + 1, query: "", items: COMMANDS, index: 0, first: 0, side: null };
    this.note = { act: this.act, kind: "add", value: this.seen, range: { start: 2, end: 11 }, comment: null };
    const diagram = this.doc.blocks.find(b => b.kind === "mermaid");
    this.shown.set(diagram.key, FIXTURE_DIAGRAM); this.good.set(diagram.key, FIXTURE_DIAGRAM);
    const pictures = this.doc.blocks.find(b => b.image);
    this.setPictures(pictures, () => FIXTURE_PICTURE);
    this.picked = { key: pictures.key, index: 0, copied: false, box: null };
    this.hoverFrame = diagram.key;
    const code = this.doc.blocks.find(b => b.kind === "code");
    this.lang = { key: code.key, act: this.act, caret: null, query: "", items: languageRows(""), index: 0, first: 0 };
    this.rebuild(null, null);
  }

  // This copy publishes { name, mode } under its pane for the my-pane header, which asks for a toggle by raising a
  // counter under the pane.
  syncHead(cx) {
    const pane = this.claimed;
    if (!pane) return;
    const req = shared(TOGGLE_KEY);
    if (req?.pane === pane && req.n !== this.toggleSeen) {
      this.toggleSeen = req.n;
      // A task spawned here starts inside the draw, where focus and notify throw: a timer runs it after.
      cx.timer.after(0, cx => this.toggle(cx));
    }
    const head = { name: this.file ? basename(this.file) : "Markdown", mode: this.mode }, sig = `${pane}\0${head.name}\0${head.mode}`;
    if (sig === this.headSig) return;
    this.headSig = sig;
    cx.spawn(async () => {
      const live = new Set(panes().map(p => p.pane));
      const kept = Object.entries(shared(HEADS_KEY) ?? {}).filter(([p]) => live.has(p) && p !== pane);
      setShared(HEADS_KEY, { ...Object.fromEntries(kept), [pane]: head });
    });
  }

  // Whether the shown layout draws its panes' headers with my-pane, which then shows what the toolbar would.
  headed() {
    const name = shared("layout");
    if (this.headedFor !== name) {
      this.headedFor = name;
      this.headedIs = JSON.stringify(layout() ?? null).includes(`"mod":"${HEADER_MOD}"`);
    }
    return this.headedIs && Boolean(this.claimed);
  }

  // Only the draw knows this copy's pane: at init panes() does not list it yet, and Herdr draws a copy only while its
  // tab is shown, so focused().tab is its own then. The registry is written once per pane, not on every draw.
  claim(cx) {
    if (!this.file) return;
    if (this.claimed && panes().some(p => p.pane === this.claimed)) return;
    const found = paneOf(focused()?.tab, this.file, this.machine);
    this.claimed = found?.pane ?? null;
    if (found && !found.filed) cx.spawn(async () => registerPane(found.pane, this.file, this.machine));
  }

  load(cx) {
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(this.file, { on: this.machine });
        if (this.closed) return;
        if (text === null) this.missing = true;
        const reading = this.openingMode() === "reading";
        if (reading && (text ?? "").length >= SLICE_FROM) {
          this.doc = await this.parseInSlices(text, cx);
          if (!this.doc) return;
        }
        this.loaded = true;
        this.first(text ?? "", cx);
        if (!reading) this.parseAhead(cx);
        if (this.lookAfterLoad) cx.spawn(cx => this.recheck(cx));
      } catch (e) {
        if (this.closed) return;
        this.error = tooBig(e) ? "This file is over 1 MiB: too big to open here" : `Can't open this file: ${why(e)}`;
      }
      this.loaded = true;
      cx.notify();
    });
  }

  // -> the blocks of `text`, parsed a slice at a time, or null when the tab closed meanwhile.
  async parseInSlices(text, cx) {
    let until = 0;
    const steps = parseInSteps(text, {}, () => Date.now() >= until);
    for (;;) {
      until = Date.now() + SLICE_MS;
      const r = steps.next();
      if (r.done) return r.value;
      await new Promise(done => cx.timer.after(0, () => done()));
      if (this.closed) return null;
    }
  }

  // The parse covers the text as it was when it began; refresh parses in later changes. A page made meanwhile (the text
  // got short, and Reading parsed it at once) is the one edits go into, so it stays. A switch to Reading asked for
  // meanwhile (readWhenParsed) is made once the parse is done.
  parseAhead(cx) {
    if (this.doc || this.parsing || this.text.length < SLICE_FROM) return;
    this.parsing = true;
    cx.spawn(async cx => {
      let doc = null;
      try { doc = await this.parseInSlices(this.text, cx); } finally { this.parsing = false; }
      if (!doc) return;
      this.doc ??= doc;
      if (!this.readWhenParsed) return;
      this.readWhenParsed = false;
      this.setMode("reading", cx);
    });
  }

  // -> true while a long text is not parsed yet: Reading shows Loading… until it is.
  waitForPage(cx) {
    if (this.doc || this.text.length < SLICE_FROM) return false;
    this.readWhenParsed = true;
    // A focused field that is not drawn keeps the keyboard, but its keys reach none of the root's handlers.
    this.handle.focus();
    this.parseAhead(cx);
    cx.notify();
    return true;
  }

  openingMode() {
    const kept = modeOf(shared(MODES_KEY)?.[fileKey(this.machine, this.file)]);
    return this.remote || this.locked ? "reading" : kept ?? "reading";
  }

  first(text, cx) {
    this.disk = this.text = this.settled = text;
    this.history.clear();
    if (this.viewer) this.guard(() => this.viewer.set_value(text));
    else this.fillSource();
    this.mode = this.openingMode();
    if (this.mode !== "reading") return this.placeSource(0, cx);
    this.refresh(cx);
    if (!this.doc.blocks.length && this.editable()) this.openPending(cx);
    else this.handle.focus();
  }

  // A text from outside becomes the buffer: the file's, or ours with their change merged in (`disk` is then theirs).
  // Only the state that shows takes it in at once; the other one catches up when it is next shown.
  apply(text, cx, { disk = text, clear = false } = {}) {
    this.commit(cx);
    if (clear) this.history.clear();
    else if (text !== this.text) this.history.rebase(spliceOf(diff(this.text, text)));
    this.text = this.settled = text;
    this.disk = disk;
    if (this.viewer) this.guard(() => this.viewer.set_value(text));
    if (this.mode === "markdown") this.patchSource();
    else this.refresh(cx);
  }

  // `rec`: history.record's meta plus the `splice` that made `text` when known; false when the history already has the
  // change (undo or redo moved its entry, or history.amend folded it into the last one). edited() takes `rec` too.
  setText(text, cx, rec) {
    this.track(text, rec);
    this.text = text;
    if (text.length <= BIG) this.settled = text;
    this.scheduleSave(cx);
    if (this.mode === "reading") this.refresh(cx);
    cx.notify();
  }

  // Typing in a block's field edits the buffer; nothing is parsed until the block is committed.
  edited(text, cx, rec) {
    this.track(text, rec);
    this.text = text;
    if (text.length <= BIG) this.settled = text;
    this.stale = true;
    this.scheduleSave(cx);
    cx.notify();
  }

  track(text, rec) {
    if (rec === false || text === this.text) return;
    this.history.record(this.text, rec?.splice ?? spliceOf(diff(this.text, text)), rec ?? {});
  }

  change(s, cx, meta = {}) {
    this.setText(applySplice(this.text, s), cx, { ...meta, splice: s });
  }

  // A block's typing is keyed by its activation (`act`), not its key: the paragraph that a first letter writes below
  // the last block only gets its key then, and the letters after it continue the same run.
  typing(key, caretBefore, caretAfter) {
    return { typing: true, key, time: Date.now(), caretBefore, caretAfter };
  }

  sourceChanged(cx) {
    if (this.closed || !this.loaded || this.remote || this.locked) return;
    const value = this.source.value();
    if (value === this.srcSeen) return; // our own edits, set_value reporting itself
    const d = diff(this.srcSeen, value);
    const s = sourceSplice(this.src, d, eolOf(this.text), this.srcSeen.charAt(d.at - 1));
    this.srcSeen = value;
    const text = applySplice(this.text, s);
    this.srcFor = text;
    this.setText(text, cx, { ...this.typing(SOURCE_TYPING, s.end, s.start + s.insert.length), splice: s });
  }

  // A value that differs from what we last saw is typing whose change event has not arrived yet.
  syncSource(cx) {
    if (this.mode === "markdown" && !this.remote && !this.locked && this.source.value() !== this.srcSeen) this.sourceChanged(cx);
  }

  // Text the field refuses (a lone surrogate makes set_value throw) leaves the file read-only.
  guard(f) {
    try { f(); return true; } catch {
      this.locked = UNUSUAL;
      this.saveTask?.cancel(); this.saveTask = null;
      return false;
    }
  }

  // The value is taken as seen before set_value, which may report it as a change.
  fillSource() {
    if (this.srcFor === this.text && this.srcSeen === this.source.value()) return;
    const map = toSource(this.text);
    this.src = map; this.srcFor = this.text; this.srcSeen = map.value;
    this.guard(() => this.source.set_value(map.value));
  }

  // A change not typed in the field (a disk change, an undo) goes in as a select and a replace, which keep its scroll.
  // Without our key table, which owns Cmd+Z there, set_value is used instead: it clears the field's own undo, which
  // could take the edit back and let the autosave write it over the file. The caret goes to document offset `caret`,
  // else follows its text. A pasted "\r\n" is two characters in the field but one "\n" in the incoming value, so the
  // caret is first moved onto the old text as the incoming value shows it.
  patchSource(caret = null) {
    if (this.remote || this.locked || this.srcFor === this.text) return;
    const old = caret === null ? caretOf(this.source) : null, was = toSource(this.srcFor), map = toSource(this.text), d = diff(was.value, map.value);
    const shift = x => (x <= d.at ? x : x >= d.at + d.removed ? x + d.inserted.length - d.removed : d.at + d.inserted.length);
    const move = f => shift(docToSource(was, sourceToDoc(this.src, f)));
    const at = caret === null ? null : docToSource(map, caret);
    const next = at !== null ? { start: at, end: at } : old && { start: move(old.start), end: move(old.end) };
    const edit = diff(this.srcSeen, map.value);
    this.src = map; this.srcFor = this.text; this.srcSeen = map.value;
    this.guard(() => {
      if (!this.keysBound) this.source.set_value(map.value);
      else if (edit.removed || edit.inserted) {
        this.source.set_selected_range({ start: edit.at, end: edit.at + edit.removed });
        this.source.replace(edit.inserted);
        if (this.source.value() !== map.value) this.source.set_value(map.value);
      }
      if (next) this.showSource(next);
    });
  }

  owe(state) {
    this.owed.set(state, (this.owed.get(state) ?? 0) + 1);
  }

  paid(state) {
    const n = this.owed.get(state) ?? 0;
    if (n > 0) this.owed.set(state, n - 1);
    return n > 0;
  }

  // The selection goes to `range` and the field is asked to show it: a replace of nothing at the caret scrolls it there.
  showSource(range) {
    this.source.set_selected_range({ start: range.end, end: range.end });
    this.source.replace("");
    if (range.start !== range.end) this.source.set_selected_range(range);
  }

  placeSource(f, cx) {
    if (this.remote) return this.handle.focus();
    const go = () => {
      this.guard(() => this.showSource({ start: f, end: f }));
      this.source.focus();
    };
    const untouched = () => {
      const c = caretOf(this.source);
      return c?.start === f && c.end === f;
    };
    go();
    cx.timer.after(REFOCUS_MS, () => { if (!this.closed && this.mode === "markdown" && untouched()) go(); });
  }

  writable() {
    return this.loaded && Boolean(this.file) && !this.error && !this.remote && !this.locked && this.conflict === null && !this.missing;
  }

  scheduleSave(cx) {
    this.saveTask?.cancel();
    this.saveTask = cx.timer.after(SAVE_MS, cx => {
      this.saveTask = null;
      this.settled = this.text;
      cx.notify();
      cx.spawn(cx => this.save(cx));
    });
  }

  save(cx) {
    this.saveTask?.cancel(); this.saveTask = null;
    if (this.closed || this.saving !== null || !this.writable() || this.text === this.disk) return Promise.resolve();
    return this.persist(this.text, cx);
  }

  async persist(text, cx) {
    const expected = this.disk;
    this.saving = text; this.saveError = null; this.stamp++;
    cx.notify();
    let landed = false;
    try {
      await writeTextFile(this.file, text, expected);
      landed = true;
    } catch (e) { await this.explain(e, text, expected, cx); }
    // A look moved `disk` while the write was out, so the file has held other text since: it is looked at again
    // rather than taken to hold ours.
    if (landed && this.disk !== expected) this.relook = true;
    else if (landed) this.disk = text;
    this.saving = null; this.stamp++;
    if (this.closed) return;
    this.lookAfterWrite(cx);
    if (this.writable() && this.text !== this.disk && !this.saveError) this.scheduleSave(cx);
    cx.notify();
  }

  // A change seen while a write was out may be built on the text written or on the text it replaced, which only the
  // write's answer tells apart: it is looked at once the write has answered.
  lookAfterWrite(cx) {
    if (!this.relook) return;
    this.relook = false;
    cx.spawn(cx => this.recheck(cx));
  }

  // A write was refused: look at the file to tell why. Our text there is as good as saved, nothing there means it was
  // deleted, and the text we expected means the write failed for itself. Other text is somebody else's change: merged
  // in when it keeps apart from the unsaved edits, else the banner asks. `expected` is what the write was made over:
  // if `disk` differs, a look moved it while the write was out, so the file holds what we expect and the save that
  // follows writes the buffer over it.
  async explain(e, text, expected, cx) {
    let now;
    try { now = await readTextFile(this.file, { on: this.machine }); } catch { now = undefined; }
    if (now === text) { this.disk = text; this.missing = false; }
    else if (now === null) { if (this.missing) this.saveError = why(e); else this.missing = true; }
    else if (typeof now !== "string") this.saveError = why(e);
    else if (now === this.disk && expected !== this.disk && !this.missing) { /* not an error */ }
    else if (now === this.disk && !this.missing) this.saveError = why(e);
    else if (!this.missing && this.merge(now, cx)) this.conflict = null;
    else { this.conflict = now; this.missing = false; }
  }

  // The file's text becomes the one a write must find there, so the write goes through.
  keepMine(cx) {
    if (this.conflict === null) return;
    this.disk = this.conflict; this.conflict = null;
    cx.notify();
    cx.spawn(cx => this.save(cx));
  }

  loadTheirs(cx) {
    if (this.conflict === null) return;
    this.syncSource(cx);
    this.syncField(cx);
    this.saveTask?.cancel(); this.saveTask = null;
    this.apply(this.conflict, cx, { clear: true });
    this.conflict = null; this.saveError = null;
    cx.notify();
  }

  saveAgain(cx) {
    if (!this.missing || this.remote || this.saving !== null || this.closed) return;
    cx.spawn(cx => this.recreate(this.text, cx));
  }

  async recreate(text, cx) {
    this.saving = text; this.saveError = null; this.stamp++;
    cx.notify();
    try {
      await writeTextFile(this.file, text, null);
      this.disk = text; this.missing = false;
    } catch (e) { await this.explain(e, text, null, cx); }
    this.saving = null; this.stamp++;
    if (this.closed) return;
    this.lookAfterWrite(cx);
    if (this.writable() && this.text !== this.disk) this.scheduleSave(cx);
    cx.notify();
  }

  saveNow(cx) {
    cx.spawn(cx => this.save(cx));
  }

  async recheck(cx) {
    if (this.checking) { this.again = true; return; }
    this.checking = true;
    try {
      do {
        this.again = false;
        await this.compare(cx);
      } while (this.again && !this.closed);
    } finally { this.checking = false; }
  }

  async compare(cx) {
    if (!this.loaded && !this.error && !this.closed) this.lookAfterLoad = true;
    if (!this.loaded || this.error || this.closed) return;
    const stamp = this.stamp;
    let now;
    try { now = await readTextFile(this.file, { on: this.machine }); } catch { return; }
    if (this.closed) return;
    // Our own write began or ended while we read: the answer may be older than it. Look again.
    if (stamp !== this.stamp) { this.again = true; return; }
    this.syncSource(cx);
    this.syncField(cx);
    const before = [this.disk, this.text, this.conflict, this.missing], blocked = this.missing || this.conflict !== null;
    if (now === null) { this.missing = true; this.conflict = null; }
    else {
      this.missing = false;
      if (now === this.saving) { /* our own write is landing */ }
      else if (now === this.text) { this.disk = now; this.conflict = null; }
      else if (now === this.disk) this.conflict = null;
      else if (this.saving !== null) this.relook = true;
      else if (this.text === this.disk) { this.apply(now, cx); this.conflict = null; }
      else if (this.merge(now, cx)) this.conflict = null;
      else this.conflict = now;
    }
    if (blocked && this.writable() && this.text !== this.disk) this.scheduleSave(cx);
    if ([this.disk, this.text, this.conflict, this.missing].some((v, i) => v !== before[i])) cx.notify();
  }

  // -> false when the unsaved edits and their change overlap (mergeChange): the banner asks. Typing no change event has
  // reported yet is taken in and parsed first (a commit may still close a fence), so the buffer compared is the one
  // that is saved and the field is not rewritten from a buffer without it.
  merge(theirs, cx) {
    if (this.closed || this.remote || this.locked || typeof theirs !== "string") return false;
    this.syncSource(cx);
    this.commit(cx);
    const E = mergeChange(this.disk, this.text, theirs);
    if (!E) return false;
    this.apply(applySplice(this.text, E), cx, { disk: theirs });
    this.scheduleSave(cx);
    return true;
  }

  poll(ms, cx) {
    this.pollTask = cx.timer.every(ms, cx => { if (!this.closed) cx.spawn(cx => this.recheck(cx)); });
  }

  watch(cx) {
    if (this.remote) return this.poll(REMOTE_POLL, cx);
    const dir = dirname(this.file);
    // The home folder (or /) holds too much to watch: it would wake us for everything that happens in it.
    if (dir === "/" || dir === home().replace(/\/+$/, "")) return this.poll(LOCAL_POLL, cx);
    cx.spawn(async cx => {
      try {
        for (;;) {
          const paths = await watchFolder(dir);
          if (this.closed) return;
          if (paths.some(p => touches(p, this.file))) cx.spawn(cx => this.recheck(cx));
          if (this.images.forget(paths)) this.assetsChanged(cx);
        }
      } catch { if (!this.closed) this.poll(LOCAL_POLL, cx); }
    });
  }

  setMode(next, cx) {
    if (!this.loaded || this.error || !MODES.includes(next)) return;
    if (this.readWhenParsed) {
      if (next === "markdown") { this.readWhenParsed = false; this.source.focus(); cx.notify(); }
      return;
    }
    if (next === this.mode || (this.locked && next === "markdown")) return;
    this.syncSource(cx);
    this.syncField(cx);
    this.history.close();
    if (this.text !== this.disk) this.saveNow(cx);
    if (next === "reading" && this.waitForPage(cx)) return;
    if (next === "markdown") this.toMarkdown(cx);
    else this.toReading(cx);
    this.settled = this.text;
    if (this.mode === next) this.remember(next);
    cx.notify();
  }

  // The source caret goes where the edited block's caret was, else to the start of the top block. The page is not
  // drawn in Markdown, so the pointer is unknown.
  toMarkdown(cx) {
    this.setSel(null, cx);
    this.unpick(cx);
    this.dropLanguages(cx);
    this.endBlockNote(cx);
    this.closeBlockAdd(cx);
    this.pointer = null;
    this.updateHover(cx);
    let at = null;
    this.writeHeld(cx);
    if (this.activeKey && !this.pending) {
      this.commit(cx);
      const c = this.caretNow();
      if (this.f) at = fieldToDoc(this.f, c ? c.end : 0);
    }
    this.leave(cx);
    at = at === null ? this.topBlock()?.start ?? 0 : Math.min(at, this.text.length);
    this.mode = "markdown";
    if (this.remote) return this.handle.focus();
    this.fillSource();
    if (this.locked) { this.mode = "reading"; return; }
    this.placeSource(docToSource(this.src, at), cx);
  }

  toReading(cx) {
    let at = null;
    if (!this.remote && !this.locked) {
      const caret = caretOf(this.source);
      if (caret) at = sourceToDoc(this.src, caret.start);
    }
    this.mode = "reading";
    this.refresh(cx);
    if (!this.doc.blocks.length && this.editable()) return this.openPending(cx);
    const b = at === null ? null : this.holding(at);
    // A caret at a block's end is on the line after it, unless the file ends there without a newline.
    const inside = b && (at < b.end || (at === b.end && this.text.charCodeAt(at - 1) !== 10));
    if (inside && this.editable() && !this.hiddenNotes(b.key)) this.activate(b.key, docToField(fieldOf(this.doc, b), at), cx);
    else this.handle.focus();
    if (at !== null) this.revealOffset(at);
    this.syncWindow(cx);
  }

  toggle(cx) {
    this.setMode(this.readWhenParsed ? "markdown" : toggleMode(this.mode), cx);
  }

  remember(mode) {
    if (this.remote || !this.file) return;
    const key = fileKey(this.machine, this.file), modes = { ...shared(MODES_KEY) };
    if (modes[key] === mode) return;
    delete modes[key]; // the newest goes last, so trimMap keeps the ones used most recently
    modes[key] = mode;
    setShared(MODES_KEY, trimMap(modes, MODES_MAX));
  }

  keys(e, cx) {
    const k = e.keystroke;
    if (k === "cmd-s") { cx.stop_propagation(); this.saveNow(cx); return; }
    if (k === "cmd-e") { cx.stop_propagation(); this.toggle(cx); return; }
    if (k === "escape" && this.card) { cx.stop_propagation(); this.closeCard(cx); return; }
    // Keys typed into a picture's box, the language menu or a block's comment reach this root too, and one stopped here
    // never reaches the box's field.
    if (this.mode !== "reading" || !this.loaded || this.error || this.activeKey || this.pictureBoxOpen() || this.langOpen() || this.blockNoteEditing() || this.blockAddOpen()) return;
    // A comment active while a picture is picked is that picture's: both go.
    if (k === "escape" && this.blockNote) { cx.stop_propagation(); this.endBlockNote(cx); this.unpick(cx); return; }
    if (this.sel && this.selectionKey(e, cx)) return;
    if (this.picked && this.pictureKey(e, cx)) return;
    if (k === "enter" && this.editable()) { cx.stop_propagation(); this.resume(cx); return; }
    if (UNDO_KEYS[k]) { cx.stop_propagation(); this.undo(UNDO_KEYS[k], cx); return; }
    const page = pageStep(this.viewH());
    const to = { up: this.offset - ARROW_STEP, down: this.offset + ARROW_STEP, pageup: this.offset - page, pagedown: this.offset + page,
      space: this.offset + page, "shift-space": this.offset - page, home: 0, end: Infinity }[k];
    if (to === undefined) return;
    cx.stop_propagation();
    this.scrollTo(to, cx);
  }

  // The key table's actions reach md-root along the focus path from the active field or the source.
  action(name, cx) {
    if (UNDO_ACTIONS[name]) {
      this.closeSlash(cx);
      return this.undo(UNDO_ACTIONS[name], cx);
    }
    if (name === "mdb-note-cancel") {
      this.typingStyle = null;
      if (this.blockAddOpen()) return this.cancelBlockAdd(cx);
      if (this.blockNoteEditing()) return this.cancelBlockNote(cx);
      if (this.pictureBoxOpen()) return this.cancelPictureBox(cx);
      if (this.imageBoxOpen()) return this.cancelImageBox(cx);
      return this.linkBoxOpen() ? this.cancelLinkBox(cx) : this.cancelNote(cx);
    }
    if (name === "mdb-note-save") {
      if (this.blockAddOpen() || this.blockNoteEditing()) return this.submitNote(cx);
      if (this.pictureBoxOpen() || this.imageBoxOpen()) return this.savePictureBox(cx);
      return this.linkBoxOpen() ? this.applyLinkBox(cx) : this.saveNote(cx);
    }
    if (LANG_ACTIONS.has(name)) return this.languageKey(name, cx);
    if (name === "mdb-escape" && this.blockNote) return this.endBlockNote(cx);
    if (this.mode !== "reading" || !this.activeKey || !this.editable()) return;
    this.syncField(cx);
    if (name === "mdb-escape") this.typingStyle = null;
    if (name === "mdb-copy" || name === "mdb-cut") return this.copyText(name === "mdb-cut", cx);
    if (this.slashOpen()) {
      if (this.slashAction(name, cx)) return;
    } else if ((name === "mdb-up" || name === "mdb-down") && this.rows === "many") {
      // The menu's binding still matches until the field's next draw drops its context: in a field of many rows
      // these keys are the field's own, and a crossing on their key-up would be wrong.
      this.ownKeyUp = name === "mdb-up" ? "up" : "down";
      return;
    }
    if (name === "mdb-enter") this.enter(cx);
    else if (name === "mdb-shift-enter") this.shiftEnter(cx);
    else if (name === "mdb-cmd-enter") this.cmdEnter(cx);
    else if (name === "mdb-backspace-start") this.backspaceStart(cx);
    else if (name === "mdb-tab" || name === "mdb-shift-tab") this.tab(name === "mdb-tab" ? 1 : -1, cx);
    else if (name === "mdb-pageup" || name === "mdb-pagedown") this.pageCaret(name === "mdb-pageup" ? -1 : 1, cx);
    else if (name === "mdb-move-up" || name === "mdb-move-down") this.moveBlock(name === "mdb-move-up" ? -1 : 1, cx);
    else if (name === "mdb-paste") this.pasteText(cx);
    else if (name === "mdb-up" || name === "mdb-down") this.crossRow(name === "mdb-up" ? -1 : 1, cx);
    else if (name === "mdb-left-start") { this.cross(-1, cx); this.ownKeyUp = "left"; }
    else if (name === "mdb-right-end") { this.cross(1, cx); this.ownKeyUp = "right"; }
    else if (name === "mdb-escape" && this.elementNow()) this.closeElement(cx);
    else if (name === "mdb-escape" && this.barMenuOpen()) this.closeBarMenu(cx);
    else if (name === "mdb-escape" && this.barOpen()) this.closeBar(cx);
    else if (name === "mdb-escape") this.escape(cx);
    else if (name === "mdb-link") this.linkKey(cx);
    else if (MARK_ACTIONS[name]) this.format(MARK_ACTIONS[name], cx);
    else if (name === "mdb-comment") this.openNote(cx);
  }

  watchKeys(cx) {
    if (!this.keysBound || this.remote) return;
    const dir = appHome().replace(/\/+$/, "");
    cx.spawn(async cx => {
      for (;;) {
        let paths;
        try { paths = await watchFolder(dir); } catch { return; }
        if (this.closed) return;
        if (!paths.some(p => p === `${dir}/keys.json`) || !claimRebind()) continue;
        await new Promise(done => cx.timer.after(KEYS_SETTLE_MS, () => done()));
        if (this.closed) return;
        installKeys(cx, { again: true });
      }
    });
  }

  listen(cx) {
    cx.spawn(async cx => {
      for (;;) {
        const name = await nextCommand();
        if (this.closed) return;
        if (name === "save") this.saveNow(cx);
        else if (name === "toggle") this.toggle(cx);
        else if (modeOf(name)) this.setMode(modeOf(name), cx);
        else if (name === "focus") {
          if (this.mode === "markdown" && !this.remote && !this.readWhenParsed) this.source.focus();
          else if (this.noteOpen() || this.blockNoteEditing() || this.blockAddOpen()) this.noteField.focus();
          else if (this.linkBoxOpen()) this.linkField.focus();
          else if (this.pictureBoxOpen()) this.pictureField().focus();
          else if (this.imageBoxOpen()) this.pictureField(this.imageBox.kind).focus();
          else if (this.langOpen()) this.langField.focus();
          else if (this.activeKey) this.field.focus();
          else this.handle.focus();
        }
      }
    });
  }

  // The browser gets web pages; a mail link goes to the computer's own opener (a mod's cx can only open web pages).
  web(url, cx) {
    if (/^https?:/i.test(url)) return cx.open_url(url);
    if (/^mailto:/i.test(url)) this.openWithSystem(url, "Can't open this link", cx);
  }

  // `target` (a file, a mail address) in the app the computer opens it with; `failed` is the notice when it can't.
  openWithSystem(target, failed, cx) {
    cx.spawn(async () => {
      try {
        const r = await exec(window()?.platform === "macos" ? "open" : "xdg-open", [target]);
        if (r.code === 0) return;
      } catch { /* told below */ }
      notify({ title: failed, level: "info" });
    });
  }

  // A press on a link is not a click on its block: the viewport's mouse-up that follows opens nothing.
  link(url, cx) {
    this.linked = true;
    if (!this.file) return;
    const r = resolveLink(url, this.file);
    if (r.kind === "web") this.web(r.url, cx);
    else if (r.kind === "markdown") openMarkdown({ file: r.path, machine: this.machine, place: "pane", pane: this.claimed ?? undefined, space: focused()?.space });
    else if (r.kind === "file") notify({ title: `Can't open ${basename(r.path)} here`, level: "info" });
  }

  // The host allows about 250 ms on close, so a write in progress is not awaited: write over `saving` (about to land),
  // and if it has not landed the file still has `disk`, so once more over that. Never more than two writes.
  async close(cx) {
    if (this.closed) return;
    if (cx) { this.syncSource(cx); this.syncField(cx); this.writeHeld(cx); }
    this.closed = true; this.slash = null;
    this.saveTask?.cancel(); this.pollTask?.cancel(); this.settleTimer?.cancel();
    this.diagrams?.close();
    this.images?.close();
    this.dialog?.stop();
    owners.delete(this.id);
    const fields = [...this.blockFields.values()].map(kept => kept.state);
    for (const e of [...this.entities.values(), this.column, ...fields]) { try { e?.release(); } catch { /* the host let it go already */ } }
    this.entities.clear(); this.blockFields.clear(); this.fieldKeys.clear();
    this.woken?.();
    if (!this.writable() || this.text === this.disk) return;
    const { text, disk } = this, first = this.saving ?? disk;
    try { await writeTextFile(this.file, text, first); }
    catch {
      if (first === disk) return; // already tried over `disk`
      try { await writeTextFile(this.file, text, disk); } catch { /* both writes refused: nothing more to try */ }
    }
  }

  // `doc` catches up with the buffer (a re-parse of the edited span only), and the blocks with `doc`. The edited block
  // is found again through `place` when given ({ at, kind, caretDoc }: what was typed made it), else where the change
  // left it. -> the change parsed in, or null.
  refresh(cx, place) {
    const anchor = this.anchor(), editing = this.activeKey && !this.pending;
    const held = place === undefined && editing && this.f ? this.held() : null;
    let d = null;
    if (!this.doc) this.doc = parse(this.text);
    else if (this.doc.text !== this.text) {
      d = diff(this.doc.text, this.text);
      this.doc = reparse(this.doc, { start: d.at, end: d.at + d.removed, insert: d.inserted });
      for (const key of this.doc.released ?? []) this.forget(key);
    }
    this.stale = false;
    const p = place ?? (held && d ? this.mapped(held, d) : null);
    if (p && this.activeKey && !this.pending) this.refind(p, cx);
    this.rebuild(cx, anchor);
    return d;
  }

  // Parses in what was typed since the last parse; the block stays the edited one as whatever it became, never one
  // that begins before it. A block emptied so that nothing of it is left goes with its blank lines and its comments. A
  // fence typed into it that runs past what was typed is closed at once.
  commit(cx, caretDoc = null) {
    this.syncField(cx);
    if (!this.stale) return;
    const h = this.activeKey && !this.pending && this.f ? this.held() : null, b = h && this.blockByKey(this.activeKey);
    const base = this.doc.text, gone = b && this.seen === "" && b.subtreeEnd === b.end ? removeWithNotes(this.doc, b) : null;
    const at = caretDoc ?? h?.caret ?? h?.field;
    const d = this.refresh(cx, at === undefined ? null : { at, kind: null, caretDoc: caretDoc ?? h?.caret ?? null, from: h?.start });
    // Everything typed in the emptied block lies inside its span, so removing it from the text before the typing
    // removes the typing as well.
    if (gone && !this.activeKey) return this.setText(applySplice(base, gone), cx);
    const g = d && fenceGuard(this.doc, spliceOf(d));
    if (!g) return;
    this.history.amend(this.text, g);
    this.setText(applySplice(this.text, g), cx, false);
  }

  // The edited block's place in the text as document offsets: its start, its field's start, the caret.
  held() {
    const b = this.blockByKey(this.activeKey), f = this.f;
    if (!b || !f) return null;
    return { kind: b.kind, start: b.start, field: f.start0, caret: this.caretDoc() };
  }

  // Where a change from outside the field leaves the edited block: the caret (or field start) moved across it, else the
  // block's start. When the change took both, only a block it wrote in their place, of the same kind, can be the one.
  mapped(h, d) {
    const p = mapPos(d, h.caret ?? h.field), q = mapPos(d, h.start);
    if (p >= 0) return { at: p, kind: h.kind, caretDoc: null };
    if (q >= 0) return { at: q, kind: h.kind, caretDoc: null };
    return { at: d.at + Math.max(0, d.inserted.length - 1), kind: h.kind, caretDoc: null, from: d.inserted ? d.at : Infinity };
  }

  // After a re-parse the block at document offset `at` is the edited one if it is of `kind` (any when null), starts at
  // `from` or later and is no paragraph of pictures, nor another block's comments. Its field is set only when its value
  // differs: the caret goes to `caretDoc`, else follows its text.
  refind({ at, kind, caretDoc, from = -Infinity }, cx) {
    const b = this.holding(at);
    if (!b || b.start > at || (kind && b.kind !== kind) || b.start < from || b.image || this.hiddenNotes(b.key) || !this.editable()) return this.drop();
    const f = fieldOf(this.doc, b), value = withInnerLine(b, f.value);
    this.activeKey = b.key; this.f = f;
    this.adoptField(b);
    if (value === this.seen) return;
    const c = caretDoc !== null && caretDoc !== undefined ? docToField(f, caretDoc) : mapCaret(diff(this.seen, value), caretOf(this.field)?.end ?? 0);
    const n = clamp(c, 0, value.length);
    this.slash = null; this.bar = null; this.note = null;
    if (!this.setField(value, { start: n, end: n })) return this.drop();
    this.retoken();
    this.rows = this.rowsFlag();
    this.revealNext = true;
    this.wake();
  }

  // The edited block may be another one after a re-parse (its key went, or the block not written yet was written):
  // the field being edited stays, as the drawer of the block it now is when that is a text block.
  adoptField(b) {
    const owner = this.fieldKeys.get(this.field);
    if (owner === b.key) return;
    if (owner !== undefined) this.disown(owner);
    if (!this.ownsField(b)) return;
    if (this.field === this.loose) this.loose = this.newField();
    this.releaseField(this.disown(b.key));
    this.own(b.key, this.field);
  }

  holding(at) {
    return holdingIn(this.doc, at);
  }

  blockByKey(key) {
    return key && this.doc ? byKey(this.doc, key) : null;
  }

  forget(key) {
    const e = this.entities.get(key);
    if (e) { try { e.release(); } catch { /* already gone */ } }
    for (const m of [this.entities, this.data, this.heights, this.shown, this.good, this.pictures, this.gens, this.frames, this.cardMemo, this.cellMemo, this.grids, this.rowHeights]) m.delete(key);
    this.zoomed.delete(key);
    this.releaseField(this.disown(key));
    if (this.hoverFrame === key) this.hoverFrame = null;
    if (this.pan?.key === key) this.pan = null;
    if (this.lang?.key === key) this.letLanguagesGo();
    if (this.blockNote?.key === key) this.blockNote = null;
    if (this.blockAdd?.key === key) this.blockAdd = null;
    if (this.hoverBox === key) this.hoverBox = null;
  }

  // Only blocks with different data are redrawn, the Column only when the blocks, their order or its window moved.
  // With no cx (the check fixture) nothing is told.
  rebuild(cx, anchor) {
    this.margin = this.marginNow();
    if (this.blockNote && !this.blockNoteNow()) this.blockNote = null;
    if (this.blockAdd && !this.blockAddNow()) this.blockAdd = null;
    const blocks = this.pageBlocks(this.placePending(this.doc.blocks)), width = this.textWidth();
    this.blocks = blocks;
    this.at = new Map(blocks.map((b, i) => [b.key, i]));
    this.updateSel();
    if (cx && this.file) {
      for (const b of this.doc.blocks) {
        if (b.key === this.activeKey) continue;
        if (b.kind === "mermaid") {
          const d = this.diagrams.get(b.source, cx);
          this.shown.set(b.key, d);
          if (d.state === "ok") this.good.set(b.key, d);
        } else if (b.image) this.setPictures(b, p => this.images.get(p.src, this.file, { remote: this.remote }, cx));
      }
    }
    for (let i = 0; i < blocks.length; i++) {
      const key = blocks[i].key, next = this.dataFor(blocks, i, width), old = this.data.get(key), same = old && sameData(old, next);
      this.data.set(key, same ? old : next);
      const e = !this.inline && cx ? this.entities.get(key) : null;
      if (e && old && !same) cx.notify(e);
    }
    const order = blocks.map(b => b.key);
    if (!sameList(order, this.order)) {
      this.order = order;
      this.diagramKeys = this.doc.blocks.filter(b => b.kind === "mermaid").map(b => b.key);
      if (cx && this.column && !this.inline) cx.notify(this.column);
    }
    const offset = this.offset;
    this.layout(anchor);
    if (cx) this.syncWindow(cx, true);
    else this.syncFields(null, true);
    // A shorter page can pull the offset back, moving another frame under a resting pointer.
    if (this.offset !== offset) this.updateHover(cx);
  }

  // What the Column mounts: null while it mounts every block, else { order, from, to, extra, gaps, held, split, above }:
  // blocks [from, to) plus the edited block (`extra`, -1 when among them), with spacers of `gaps` px around them. Blocks
  // first drawn above `held` (the block the eye held when the window was made) grow upward: [from, split) is drawn from
  // the bottom of a box `above` px tall, so their unmeasured heights move nothing below. A window stays until the
  // viewport comes within half the margin of its edge or the blocks change.
  windowFor(prev) {
    const n = this.blocks.length, s = this.sums, margin = this.inline ? INLINE_MARGIN : WINDOW_MARGIN;
    if (!this.file || s.length !== n + 1 || (!this.inline && n <= MOUNT_ALL)) return null;
    const top = this.offset - COLUMN.padTop, bottom = top + (this.viewport ? this.viewH() : UNSIZED_VIEW_H);
    const holds = prev && prev.order === this.order && (prev.from === 0 || s[prev.from] <= top - margin / 2) && (prev.to === n || s[prev.to] >= bottom + margin / 2);
    const from = holds ? prev.from : blockAt(s, top - margin), to = holds ? prev.to : blockAt(s, bottom + margin) + 1;
    const a = this.at.get(this.activeKey) ?? -1, extra = a >= 0 && (a < from || a >= to) ? a : -1;
    const gaps = extra < 0 ? [s[from], s[n] - s[to]]
      : extra < from ? [s[extra], s[from] - s[extra + 1], s[n] - s[to]]
        : [s[from], s[extra] - s[to], s[n] - s[extra + 1]];
    const held = holds ? prev.held : this.heldIn(from, to), split = this.boxEnd(from, held);
    return { order: this.order, from, to, extra, gaps, held, split, above: s[split] - s[from] };
  }

  // A pending reveal's block is where the eye goes; else the anchor, which the size task keeps where it is.
  heldIn(from, to) {
    const key = this.reveal?.key ?? this.anchor()?.key, i = key ? this.at.get(key) ?? -1 : -1;
    return i > from && i < to ? i : from;
  }

  // The box ends just past the last block above `held` not measured yet (at `from` when there is none), and before
  // the block being edited.
  boxEnd(from, held) {
    const a = this.at.get(this.activeKey) ?? -1, end = a >= from && a < held ? a : held;
    for (let i = end - 1; i >= from; i--) if (!this.heights.has(this.blocks[i].key)) return i + 1;
    return from;
  }

  // A view or a field can be made in a handler or a task, never in a draw: blocks that enter the window get theirs
  // here. `refresh`: the document may have changed under the fields.
  syncWindow(cx, refresh = false) {
    const next = this.windowFor(this.win), moved = !sameWindow(next, this.win), fresh = new Set();
    this.win = next;
    for (const key of this.mountedKeys()) {
      if (this.inline) break;
      if (this.entities.has(key)) continue;
      this.made(key, cx);
      fresh.add(key);
    }
    this.syncFields(cx, refresh, fresh);
    if (!moved) return;
    if (this.inline) cx.notify();
    else if (this.column) cx.notify(this.column);
  }

  mountedKeys() {
    const w = this.win;
    if (!w) return this.order;
    const keys = this.order.slice(w.from, w.to);
    if (w.extra >= 0) keys.push(this.order[w.extra]);
    return keys;
  }

  mountedItems(draw) {
    const w = this.win;
    if (!w) return this.order.map(draw).filter(Boolean);
    const gap = i => div().id(`md-gap-${i}`).w_full().h(w.gaps[i]);
    const keys = this.order.slice(w.from, w.to), cut = w.split - w.from;
    const upward = cut > 0 ? [div().id("md-above").relative().w_full().h(w.above)
      .child(v_flex().id("md-above-run").absolute().left(0).right(0).bottom(0).children(keys.slice(0, cut).map(draw).filter(Boolean)))] : [];
    const run = [...upward, ...keys.slice(cut).map(draw)];
    const parts = w.extra < 0 ? [gap(0), ...run, gap(1)]
      : w.extra < w.from ? [gap(0), draw(this.order[w.extra]), gap(1), ...run, gap(2)]
        : [gap(0), ...run, gap(1), draw(this.order[w.extra]), gap(2)];
    return parts.filter(Boolean);
  }

  // A draw may not notify: a window change no handler took to the Column (a reveal when the page is shown again) goes
  // there on a 0 ms timer.
  checkWindow(cx) {
    if (this.winTimer || sameWindow(this.windowFor(this.win), this.win)) return;
    this.winTimer = cx.timer.after(0, cx => {
      this.winTimer = null;
      if (!this.closed && this.mode === "reading") this.syncWindow(cx);
    });
  }

  // The page's blocks with the pending one where it will be written. When the text under it is replaced, its place is
  // worked out again; when it stops fitting there (its block went), editing stops.
  placePending(blocks) {
    const p = this.pending;
    if (!p) return blocks;
    if (p.for !== this.doc.text && !this.simulate(p)) {
      this.release();
      this.handle.focus();
      return blocks;
    }
    const j = p.before ? blocks.findIndex(b => b.key === p.before) : -1;
    return j < 0 ? [...blocks, p.block] : [...blocks.slice(0, j), p.block, ...blocks.slice(j)];
  }

  // The page leaves out a block's comments paragraph, which shows as the block's cards, unless it is being edited.
  pageBlocks(blocks) {
    const hidden = this.notesNow().hidden;
    return hidden.size ? blocks.filter(b => !hidden.has(b.key) || b.key === this.activeKey) : blocks;
  }

  // Which block owns which comments paragraph, paired once for each document.
  notesNow() {
    if (this.pairing?.doc !== this.doc) this.pairing = pairNotes(this.doc, this.pairing);
    return this.pairing;
  }

  hiddenNotes(key) {
    return key !== this.activeKey && this.notesNow().hidden.has(key);
  }

  // Block `key`'s comments as its cards and count show them: none while their paragraph is the edited block, which
  // shows them as its own.
  shownNotes(key) {
    const owned = this.notesNow().owners.get(key);
    return owned && owned.para.key !== this.activeKey ? owned : null;
  }

  // The pending block written with a stand-in text on a copy: what it draws as, and the block it comes before.
  simulate(p) {
    const w = chain(this.doc, p.base(this.doc, PLACEHOLDER), p.steps);
    if (!w?.block) return false;
    p.block = pendingRecord(p.key, w.block);
    p.before = this.doc.blocks[w.block.index]?.key ?? null;
    p.for = this.doc.text;
    return true;
  }

  // No set_soft_wrap(true): the field wraps by default, and the call makes every set_value before the field's first
  // layout wrap the text at a width of 0, which costs milliseconds a block in Herdr.
  newField() {
    const s = TextareaState.new({ value: "" });
    s.set_auto_grow(1, 10000);
    s.on("change", (_e, cx) => this.fieldChanged(s, cx));
    s.on("focus", (_e, cx) => this.fieldFocus(s, true, cx));
    s.on("blur", (_e, cx) => this.fieldFocus(s, false, cx));
    return s;
  }

  ownsField(b) {
    return Boolean(b) && isText(b) && !b.image && !this.remote && !this.locked;
  }

  blockField(key) {
    return this.blockFields.get(key)?.state ?? null;
  }

  own(key, state) {
    this.blockFields.set(key, { state, src: null, value: null, defs: null, checked: false, rich: null });
    this.fieldKeys.set(state, key);
  }

  // -> the field block `key` owned, now nobody's, or null.
  disown(key) {
    const kept = this.blockFields.get(key);
    if (!kept) return null;
    this.blockFields.delete(key);
    this.fieldKeys.delete(kept.state);
    return kept.state;
  }

  releaseField(state) {
    if (!state || state === this.field || state === this.loose || this.fieldKeys.has(state)) return;
    this.owed.delete(state); this.echoes.delete(state);
    try { state.release(); } catch { /* the host let it go already */ }
  }

  // The field block b is edited in: its own, made now when it has none yet, or `loose`.
  fieldFor(b) {
    if (!this.ownsField(b)) return this.loose;
    if (!this.blockFields.has(b.key)) this.own(b.key, this.newField());
    return this.blockFields.get(b.key).state;
  }

  // A text block mounted near the viewport (FIELDS_MADE_WITHIN) gets a field of its own; one far from it
  // (FIELDS_KEPT_WITHIN), out of the window or out of the document lets it go and is drawn as text again, at the same
  // height. Making a field costs a few milliseconds in Herdr, and each one kept holds its text and layout. The edited
  // block (with its format bar or comment box) keeps its field, and so does one a press is under way in. `refresh`: the
  // fields not being edited take their block's value and tokens where those changed. `fresh`: views made just now.
  syncFields(cx, refresh = false, fresh = null) {
    if (!this.doc || this.mode !== "reading") return;
    const mounted = new Set(this.mountedKeys()), changed = [], blockOf = key => this.blocks[this.at.get(key)] ?? null, locked = this.locked;
    const kept = new Set(this.nearKeys(mounted, FIELDS_KEPT_WITHIN));
    for (const key of [...this.blockFields.keys()]) {
      if (key === this.activeKey) continue;
      const b = mounted.has(key) ? blockOf(key) : null;
      if (!this.ownsField(b) || (!kept.has(key) && !this.fieldInUse(key))) {
        this.releaseField(this.disown(key));
        changed.push(key);
      } else if (refresh) this.fillField(b, this.blockFields.get(key));
    }
    for (const key of this.nearKeys(mounted, FIELDS_MADE_WITHIN)) {
      const b = blockOf(key);
      if (key === this.activeKey || this.blockFields.has(key) || !this.ownsField(b)) continue;
      this.own(key, this.newField());
      changed.push(key);
      this.fillField(b, this.blockFields.get(key));
    }
    // A value a field refused (fillField) left the file read-only: its text is drawn as text again.
    if (this.locked && !locked) return this.syncFields(cx, false, fresh);
    if (!changed.length) return;
    this.fieldGen++;
    this.redraw(changed, cx, fresh);
  }

  // The keys of the mounted blocks within `screens` screens above or below the viewport.
  nearKeys(mounted, screens) {
    const n = this.blocks.length, s = this.sums;
    if (s.length !== n + 1) return [...mounted];
    const screen = this.viewport ? this.viewH() : UNSIZED_VIEW_H, top = this.offset - COLUMN.padTop;
    const keys = [];
    for (let i = Math.max(0, blockAt(s, top - screens * screen)); i < n && s[i] < top + (1 + screens) * screen; i++) {
      if (mounted.has(this.blocks[i].key)) keys.push(this.blocks[i].key);
    }
    return keys;
  }

  // A press is under way in its field: the only time a block not being edited shows a selection there, since leaving a
  // block and a drag on to other blocks clear it.
  fieldInUse(key) {
    return key === this.fieldHeld || key === this.shiftField || key === this.cmdPress?.key;
  }

  // The document's link definitions as one object for as long as they read the same: a re-parse makes new ones.
  defsNow() {
    const defs = this.doc.defs;
    if (!this.defs || (this.defs.map !== defs && !sameDefs(this.defs.map, defs))) this.defs = { map: defs };
    this.defs.map = defs;
    return this.defs;
  }

  // A field not being edited shows its block's value with its words as tokens, none split into letters; it is set
  // only when those changed. A checked task's words are all tokens: the field draws no line through plain text. A
  // block left has `src` null: its field may still hold what editing left there.
  fillField(b, kept) {
    const src = this.doc.text.slice(b.start, b.end), defs = this.defsNow(), checked = Boolean(b.task?.checked);
    if (kept.src === src && kept.defs === defs && kept.checked === checked) return;
    const value = fieldOf(this.doc, b).value;
    if (!kept.rich || value !== kept.value || checked !== kept.checked || (defs !== kept.defs && value.includes("["))) {
      kept.rich = richOf(value, parsedInline(value, defs.map), { everyWord: checked });
    }
    Object.assign(kept, { src, value, defs, checked });
    const tokens = tokensFor(kept.rich, null).tokens, state = kept.state;
    if (state.value() === value && sameTokens(state.tokens(), tokens)) return;
    try { state.set_value({ text: value, tokens }); } catch { this.guard(() => state.set_value(value)); }
  }

  // `fresh`: the keys whose views were made just now, which draw for the first time anyway.
  redraw(keys, cx, fresh = null) {
    const width = this.textWidth();
    for (const key of keys) {
      const i = key ? this.at.get(key) : undefined;
      if (i === undefined) continue;
      const next = this.dataFor(this.blocks, i, width), old = this.data.get(key), e = this.entities.get(key), same = old && sameData(old, next);
      this.data.set(key, same ? old : next);
      if (cx && e && !this.inline && old && !same && !fresh?.has(key)) cx.notify(e);
    }
    if (this.inline) cx?.notify();
  }

  made(key, cx) {
    try { this.entities.set(key, cx.new(Block, { owner: this.id, key })); } catch { this.inline = true; }
  }

  dataFor(blocks, i, width) {
    const b = blocks[i], grid = b.kind === "table" && b.key !== this.activeKey ? this.gridNow(b, width) : null;
    const look = lookOf(b, Boolean(grid)), cal = this.calOf(look.style), marker = markerOf(b);
    const text = grid ? "" : look.look === "text" ? displayText(b, this.highlight) : b.kind === "table" ? this.tableText(b) : look.look === "boxed" ? b.render : b.content;
    const space = spaceBefore(blocks, i, this.doc.blocks);
    return {
      key: b.key, kind: b.kind, look: look.look, style: look.style, color: look.color, grid,
      space, depth: b.depth, text, ...this.notesData(b, look, space, cal, width), ...this.chipData(b),
      marker, label: marker === "number" ? `${b.number}${b.delim}` : "", checked: Boolean(b.task?.checked),
      diagram: look.look === "diagram" ? diagramSig(this.shown.get(b.key), this.good.get(b.key)) : "",
      mode: b.key === this.activeKey ? "active" : this.blockFields.has(b.key) ? "field" : "rendered",
      tokens: look.look === "text" && (b.key === this.activeKey || this.blockFields.has(b.key)),
      rows: b.key === this.activeKey ? this.rows : "many", menu: b.key === this.activeKey && this.slashOpen(),
      gen: this.gens.get(b.key) ?? 0, selected: this.selKeys.has(b.key), framed: this.framedAs(b),
      row: cal.row, ratio: cal.ratio, padRendered: cal.padRendered, padActive: cal.padActive,
      ...(look.look === "diagram" ? this.frameData(b, width) : {}),
      ...(look.look === "picture" ? this.pictureData(b, width) : {}),
    };
  }

  // A text block shows its comments' count where notesPlace puts it, unless they show as cards in the margin; the edited
  // one counts what its field holds. A code block, diagram or table shows its comments paragraph's count level with its
  // top (a table's with the comments in its cells), left of a code block's language chip where the chip would be under
  // it; a paragraph of pictures its pictures' comments' count level with its top.
  notesData(b, look, space, cal, width) {
    const owned = this.shownNotes(b.key), pictures = look.look === "picture", table = b.kind === "table", own = owned ? owned.points.length : 0;
    const notes = this.margin ? 0 : table ? own + this.cellNotesOf(b).cards.length : owned ? own : pictures ? this.pictureNotes(b).length
      : look.look === "text" ? noted(b.key === this.activeKey ? this.seen : b.content).length : 0;
    if (!notes) return { notes: 0, notesX: 0, notesY: 0 };
    const viewW = this.viewport?.width ?? this.size?.width ?? 900, at = notesPlace({ viewW, textW: width, space, rowH: owned || table || pictures ? NOTES.h : cal.row });
    const chip = owned ? this.chipData(b) : NO_STRIP, beside = chip.chipW ? this.chipIn({ space, chipW: chip.chipW }) : null;
    if (beside && at.x + NOTES.w > beside.x) return { notes, notesX: beside.x - COUNT_CHIP_GAP - NOTES.w, notesY: beside.y + (CHIP.h - NOTES.h) / 2 };
    return { notes, notesX: at.x, notesY: at.y };
  }

  // The strip a code block's box starts with, and its language chip: the language's name (an unknown word as written,
  // Plain text for none; on a file that can't be edited, no chip for none), and whether it opens the menu.
  chipData(b) {
    if (!stripped(b, b.key === this.activeKey)) return NO_STRIP;
    const live = !this.file || this.editable(), word = infoWord(b.info), chip = word || live ? clip(languageName(word), CHIP_CHARS) : "";
    const open = Boolean(chip) && this.lang?.key === b.key && this.lang.act === this.act;
    return { strip: true, chip, chipW: chip ? chipW(chip, live) : 0, chipLive: live, chipOpen: open };
  }

  // Block data d's language chip from the block's top-left: at the right of the strip under the box's border and padding.
  chipIn(d) {
    return { x: this.textWidth() - 1 - BOX.px - d.chipW, y: d.space + 1 + BOX.py + (CODE_HEAD - CHIP.h) / 2, w: d.chipW, h: CHIP.h };
  }

  // Whether what changes the file is drawn: on a file that can be edited, and in the check fixture.
  showsEdits() {
    return !this.file || this.editable();
  }

  // A code block's or table's Comment button shows while the pointer is over the block, and on the code block, table or
  // diagram source being edited.
  blockButtonShown(d) {
    if (!(d.strip || d.kind === "table") || d.key === this.pending?.key || !this.showsEdits()) return false;
    return d.key === this.activeKey || d.key === this.hoverBox;
  }

  // Block data d's Comment button from the block's top-left while it shows, else null: left of a code block's language
  // chip, right of a table's grid by its top right corner (in the column's padding when the grid is as wide as the
  // column), inside the box of a table kept as source at its top right, or left of the block's comment count where it
  // would cover that.
  blockButtonIn(d) {
    if (!this.blockButtonShown(d)) return null;
    const B = BLOCK_BUTTON, chip = d.chipW ? this.chipIn(d) : null;
    const own = chip ? { x: chip.x - B.gap - B.size, y: chip.y }
      : d.grid ? { x: d.depth * INDENT + d.grid.w + B.gap, y: d.space + B.inset } : { x: this.textWidth() - B.inset - B.size, y: d.space + B.inset };
    const box = { ...own, w: B.size, h: B.size }, count = d.notes ? { x: d.notesX, y: d.notesY, w: NOTES.w, h: NOTES.h } : null;
    return count && overlap(box, count) ? { ...box, x: count.x - B.gap - B.size, y: count.y + (NOTES.h - B.size) / 2 } : box;
  }

  // A paragraph of pictures frames the pictures themselves instead (pictureFrames); a table's active cell comment deepens
  // its cell's text (tableText).
  framedAs(b) {
    if (b.image) return "";
    if (this.blockNote?.key === b.key && !this.blockNote.cell) return FRAMED.active;
    return this.blockAdd?.key === b.key && this.blockAddOpen() ? FRAMED.adding : "";
  }

  // What table b's grid draws (grid.js gridOf) in a column `width` px wide, the same object while that stays the same;
  // null for a table kept as source.
  gridNow(b, width) {
    let kept = this.grids.get(b.key);
    if (!kept) this.grids.set(b.key, (kept = {}));
    const opts = { room: width - b.depth * INDENT, head: this.calOf("head"), body: this.calOf("cell"), color: this.highlight, deep: this.cellDeep(b), defs: this.defsNow() };
    return gridOf(kept, this.doc, b, opts);
  }

  // Table b's active cell comment as its grid deepens it: its cell and where it starts in the cell's text; else null.
  cellDeep(b) {
    const n = this.blockNote;
    if (!n?.cell || n.key !== b.key) return null;
    const card = this.cellNotesOf(b).cards[n.index];
    return card ? { row: card.row, column: card.column, at: card.c.start - card.cell.start, color: this.deep } : null;
  }

  // The heights of table data d's grid rows: as measured, else as estimated.
  gridHeights(d) {
    const measured = this.rowHeights.get(d.key);
    return measured ? d.grid.heights.map((h, r) => measured[r] ?? h) : d.grid.heights;
  }

  // A grid row's measured height is kept for its table, which isn't drawn again for it: a press and the cells' cards go
  // by it. The size task lays the page out again, and a new layout places the cards anew.
  rowSized(key, r, size) {
    const h = size.height / zoom(), rows = this.rowHeights.get(key) ?? [];
    if (rows[r] === h) return;
    rows[r] = h;
    this.rowHeights.set(key, rows);
    this.wake();
  }

  // What Reading's TextView draws of a table kept as source: the comments in its cells highlighted as in text, the
  // active one's in the deeper colour, their marks and notes left out; kept with its cell comments while it draws the
  // same. The table being edited shows its source in its field instead.
  tableText(b) {
    if (b.key === this.activeKey) return b.render;
    const memo = this.cellNotesOf(b), n = this.blockNote, kept = memo.look;
    const at = n?.cell && n.key === b.key ? memo.cards[n.index]?.c.start ?? -1 : -1;
    if (kept?.render === b.render && kept.at === at && kept.highlight === this.highlight && kept.deep === this.deep) return kept.text;
    const text = showComments(b.content, this.highlight, at < 0 ? null : { at, color: this.deep }) + b.render.slice(b.content.length);
    memo.look = { render: b.render, at, highlight: this.highlight, deep: this.deep, text };
    return text;
  }

  // `answer` says how one picture of the paragraph stands, as { state, path, width, height, error }: Images.get's answer.
  // A picture being read again keeps the one it showed, as a diagram keeps its last good image.
  setPictures(b, answer) {
    const kept = this.pictures.get(b.key), same = kept?.content === b.content, list = same ? kept.list : picturesOf(b.content);
    const stands = (now, i) => (same && now.state === "pending" && kept.items[i].state === "ok" ? kept.items[i] : now);
    const notes = same ? kept.notes : pictureNotesOf(list);
    this.pictures.set(b.key, { content: b.content, list, notes, items: list.map((p, i) => ({ ...p, ...stands(answer(p), i) })), layout: null });
  }

  pictureNotes(b) {
    const kept = this.pictures.get(b.key);
    return kept?.content === b.content ? kept.notes : pictureNotesOf(picturesOf(b.content));
  }

  // The picture that comment `index` of paragraph of pictures `key` is on, else -1.
  notePicture(key, index) {
    const b = this.blockByKey(key);
    return b?.image ? this.pictureNotes(b)[index]?.picture ?? -1 : -1;
  }

  pictureNoteActive(key, index) {
    return this.blockNote?.key === key && this.notePicture(key, this.blockNote.index) === index;
  }

  // The pictures of block `key` laid out in a column `width` px wide: { items, boxes, height }, which the page draws and
  // a click is tested against.
  pictureOf(key, width) {
    const kept = this.pictures.get(key);
    if (!kept) return { items: [], boxes: [], height: 0 };
    if (kept.layout?.width !== width) {
      const sized = kept.items.map(item => ({ state: item.state, natW: item.width, natH: item.height }));
      kept.layout = { width, ...pictureLayout(sized, width) };
    }
    return { items: kept.items, boxes: kept.layout.boxes, height: kept.layout.height };
  }

  // Primitive fields only, so that a block whose pictures stand as before is not drawn again. `picked`: the index of
  // its picked picture, -1 for none; `pictureFrames` as pictureFrames gives them.
  pictureData(b, width) {
    const pictureW = Math.max(1, width - b.depth * INDENT), picked = this.picked?.key === b.key ? this.picked.index : -1;
    if (b.key === this.activeKey || !this.pictures.has(b.key)) return { pictureSig: "", pictureW, pictureH: 0, picked, pictureFrames: "" };
    const { items, height } = this.pictureOf(b.key, pictureW);
    const pictureSig = JSON.stringify(items.map(i => [i.state, i.path, i.width, i.height, i.error, i.href]));
    return { pictureSig, pictureW, pictureH: height, picked, pictureFrames: this.pictureFrames(b, items) };
  }

  // One PICTURE_FRAME letter a picture of paragraph of pictures b: in the highlight colour a highlighted picture's
  // frame, or one whose comment is being written; in the deeper one the active comment's picture's.
  pictureFrames(b, items) {
    const a = this.blockAdd?.key === b.key ? this.blockAddNow() : null, n = this.blockNote?.key === b.key ? this.blockNoteNow() : null;
    const adding = a ? a.picture : -1, active = n ? this.notePicture(b.key, n.index) : -1;
    return items.map((p, i) => (i === active ? PICTURE_FRAME.deep : i === adding || p.marked ? PICTURE_FRAME.light : PICTURE_FRAME.none)).join("");
  }

  // The index of the picture whose box holds the point (x, y) in the paragraph's content box, else -1.
  pictureAt(d, x, y) {
    return this.pictureOf(d.key, d.pictureW).boxes.findIndex(box => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h);
  }

  // The frame of a diagram block: the picture that is ready, else the last one dimmed, sized for the viewport. A
  // block being edited, or with nothing drawn yet, or with no renderer, has none.
  frameData(b, width) {
    const d = this.shown.get(b.key), last = this.good.get(b.key);
    const g = b.key === this.activeKey ? null : d?.state === "ok" ? d : d?.state !== "missing" ? last : null;
    const natW = g ? g.width / g.scale : 0, natH = g ? g.height / g.scale : 0;
    if (!(natW > 0 && natH > 0)) return NO_FRAME;
    const viewW = this.viewport?.width ?? this.size?.width ?? 900, viewH = this.viewport?.height ?? UNSIZED_VIEW_H;
    const blockLeft = columnLeft(viewW, this.margin) + b.depth * INDENT, blockW = Math.max(120, width - b.depth * INDENT);
    const box = frameBox({ viewW, viewH, blockLeft, blockW, natW, natH });
    const start = startView(box, { w: natW, h: natH }, box.z0, topDown(b.source));
    const sharp = g === d ? this.diagrams.sharpOf(g.key) : null;
    return {
      frameW: box.w, frameH: box.h, frameMl: box.ml, frameLeft: box.left, natW, natH, z0: box.z0, zMin: box.zMin, startX: start.x, startY: start.y,
      imgKey: g.key, imgScale: g.scale, imgDim: g !== d, boxAbove: d?.state === "error", sharpKey: sharp?.state === "ok" ? sharp.key : "",
    };
  }

  blockData(key) {
    return this.data.get(key) ?? null;
  }

  columnElement() {
    return v_flex().id("md-column").w_full().children(this.mountedItems(k => this.entities.get(k)));
  }

  // A diagram was drawn or a picture loaded: the page draws again, when Reading is the view.
  assetsChanged(cx) {
    if (this.closed || this.mode !== "reading" || !this.doc) return;
    this.rebuild(cx, this.anchor());
  }

  textWidth() {
    const page = this.margin ? this.margin.pageW : Math.min(COLUMN.maxWidth, this.size?.width ?? 900);
    return Math.max(120, Math.floor(page - 2 * COLUMN.padX));
  }

  // The margin layout while the file has comments and the pane has room for them, kept as the same object while it
  // stays the same; null for the page as usual.
  marginNow() {
    const next = this.mode === "reading" && this.commentCount() > 0 ? marginLayout(this.paneW()) : null, was = this.margin;
    return next && was && next.pageW === was.pageW && next.pageLeft === was.pageLeft ? was : next;
  }

  // The page is laid out again when the file gained its first comment or lost its last since it was.
  checkMargin(cx) {
    if (this.doc && this.marginNow() !== this.margin) this.rebuild(cx, this.anchor());
  }

  viewH() {
    return this.viewport?.height ?? 0;
  }

  contentH() {
    return COLUMN.padTop + this.sums[this.sums.length - 1] + COLUMN.padBottom;
  }

  calOf(style) {
    const st = STYLES[style], c = this.cal[style];
    return c ?? { row: st.size * st.lh, ratio: st.lh, padRendered: 0, padActive: 0, advance: st.size * (st.mono ? 0.6 : 0.47) };
  }

  // The height of a block not measured yet, kept with its drawing data: every layout asks for each block not mounted.
  estimate(b, width = this.textWidth()) {
    const d = this.data.get(b.key);
    if (!d) return 0;
    const kept = this.estimates.get(d);
    if (kept && kept.width === width && kept.cal === this.cal) return kept.h;
    const h = this.estimateOf(d, this.chromeOf(d, false).w, this.calOf(d.style).advance);
    this.estimates.set(d, { width, cal: this.cal, h });
    return h;
  }

  // Rows of the text, each line wrapped at `advance` px a character in a column `w` px wide; a grid's rows as estimated
  // cell by cell. A table kept as source counts a line a row: TextView spreads a line over its cells.
  estimateOf(d, w, advance) {
    if (d.look === "grid") return d.space + d.grid.h;
    if (d.look === "rule") return d.space + RULE_H;
    if (d.look === "diagram") return d.space + (d.frameH ? d.frameH + (d.boxAbove ? DIAGRAM_H + 8 : 0) : DIAGRAM_H);
    if (d.look === "picture" && d.mode === "rendered") return d.space + d.pictureH;
    const box = d.look === "code" || d.look === "boxed" ? 2 * BOX.py + 2 : d.look === "front" ? 2 * FRONT_BOX.py + 2 : 0;
    const lines = d.text.split("\n"), perRow = Math.max(1, Math.floor(w / advance));
    const rows = d.look === "boxed" ? lines.length : lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perRow)), 0);
    return estimateHeight(rows, d.row, d.space) + box + (d.strip ? CODE_HEAD : 0);
  }

  // Where a block's field (when `active`) or rendered content sits inside its root: x and y from its top-left, the
  // width, and what its box adds below. The space above, marker column, quote bar, box padding and a code block's strip
  // come before it.
  chromeOf(d, active) {
    let x = d.depth * INDENT, w = this.textWidth() - x, y = d.space, below = 0;
    if (d.kind === "item") { x += MARKER_W; w -= MARKER_W; }
    else if (d.kind === "quote") { x += QUOTE_BAR + QUOTE_PAD; w -= QUOTE_BAR + QUOTE_PAD; }
    const box = active ? (d.kind === "frontmatter" ? FRONT_BOX : isRaw(d.kind) ? BOX : null)
      : d.look === "front" ? FRONT_BOX : d.look === "code" || d.look === "boxed" ? BOX : null;
    if (box) { x += box.px + 1; w -= 2 * (box.px + 1); y += box.py + 1; below = box.py + 1; }
    if (stripped(d, active)) y += CODE_HEAD;
    return { x, y, w: Math.max(1, w), below };
  }

  rowsOf(d, active) {
    const h = this.heights.get(d.key);
    if (h === undefined) return undefined;
    const c = this.chromeOf(d, active);
    return Math.max(1, Math.round((h - c.y - c.below - (active ? d.padActive : d.padRendered)) / d.row));
  }

  // The block the eye holds on to while heights change, and where on the screen it is: the edited block while its
  // caret row is on the page, else the first block whose bottom is below the page top. A block drawn upward sits where
  // the blocks below it in its box put it, not at its estimated top: the block below the box stands in.
  anchor() {
    const blocks = this.blocks;
    if (!blocks.length || this.sums.length !== blocks.length + 1) return null;
    const a = this.at.get(this.activeKey) ?? -1, y = a >= 0 ? this.caretTop(a) : null;
    const i = anchorBlock({ sums: this.sums, offset: this.offset - COLUMN.padTop, viewportH: this.viewH(), active: y === null ? -1 : a, caretY: y });
    if (i < 0) return null;
    const w = this.win, j = w && w.order === this.order && i >= w.from && i < w.split ? w.split : i;
    return { key: blocks[j].key, y: COLUMN.padTop + this.sums[j] - this.offset };
  }

  layout(anchor) {
    const blocks = this.blocks, width = this.textWidth();
    this.sums = prefixSums(blocks.map(b => this.heights.get(b.key) ?? this.estimate(b, width)));
    const at = key => this.at.get(key) ?? -1;
    const revealed = this.reveal ? at(this.reveal.key) : -1;
    if (revealed < 0) this.reveal = null;
    if (this.reveal) {
      this.offset = revealAt({ top: COLUMN.padTop + this.sums[revealed], rowY: this.reveal.rowY, fraction: this.reveal.fraction, viewportH: this.viewH(), contentH: this.contentH() });
    } else if (anchor) {
      const i = at(anchor.key);
      if (i >= 0) this.offset = COLUMN.padTop + this.sums[i] - anchor.y;
    }
    this.offset = this.viewport ? clampOffset(this.offset, this.contentH(), this.viewH()) : Math.max(0, this.offset);
  }

  // Blocks report their heights from their own views, which cannot redraw this one, so they wake this task, whose cx is
  // this view's. One wake takes in every height reported before it runs and runs the work the blocks' handlers handed over.
  watchSizes(cx) {
    this.watching = true;
    cx.spawn(async cx => {
      for (;;) {
        await new Promise(done => {
          if (this.wakeLater) { this.wakeLater = false; done(); } else this.woken = done;
        });
        if (this.closed) return;
        for (const job of this.inbox.splice(0)) {
          try { job(cx); } catch { /* one failed job must not end the task that lays out the page */ }
        }
        this.layout(this.anchor());
        if (this.activeKey && this.mode === "reading") {
          this.updateRows(cx);
          if (this.revealNext) { this.revealNext = false; this.revealCaret(cx); }
        }
        this.updateHover(cx);
        if (this.mode === "reading") this.syncWindow(cx);
        cx.notify();
      }
    });
  }

  wake() {
    const done = this.woken;
    if (done) { this.woken = null; done(); } else this.wakeLater = true;
  }

  post(job) {
    if (this.closed || !this.watching) return;
    this.inbox.push(job);
    this.wake();
  }

  blockSized(key, size) {
    const h = size.height / zoom();
    if (this.heights.get(key) === h) return;
    // The tops still on screen are the old ones until the size task runs: the anchor is taken from them.
    this.heights.set(key, h);
    if (key === this.activeKey) this.revealNext = true;
    this.wake();
  }

  // Puts the row holding document offset `at` a third of the way down until the page is scrolled; an offset on a blank
  // line puts the next block there.
  revealOffset(at) {
    const blocks = this.doc?.blocks ?? [];
    let i = blocks.findIndex(b => at < b.gapEnd);
    if (i < 0) i = blocks.length - 1;
    if (i < 0) return;
    let line = 0;
    if (at >= blocks[i].end && i + 1 < blocks.length) i++;
    else {
      const b = blocks[i], hidden = b.fence || b.kind === "frontmatter" ? 1 : 0;
      line = Math.max(0, this.text.slice(b.start, Math.max(b.start, at)).split("\n").length - 1 - hidden);
    }
    // A block's comments paragraph is not on the page: its block is shown instead.
    if (!this.at.has(blocks[i].key) && i > 0) [i, line] = [i - 1, 0];
    const d = this.data.get(blocks[i].key);
    // A grid draws the header from the source's first line and no delimiter row.
    const rowY = d.grid ? gridRowTop(this.gridHeights(d), Math.max(0, line - 1)) : line * d.row;
    this.reveal = { key: blocks[i].key, fraction: REVEAL_AT, rowY: d.space + rowY };
    this.layout(null);
  }

  topBlock() {
    const blocks = this.blocks;
    if (!blocks.length || this.sums.length !== blocks.length + 1) return blocks[0] ?? null;
    const top = this.offset - COLUMN.padTop, bottom = top + this.viewH();
    for (let k = blockAt(this.sums, top); k >= 0 && k < blocks.length && this.sums[k] < bottom; k++) {
      const first = this.sums[k] + (this.data.get(blocks[k].key)?.space ?? 0);
      if (first >= top && first < bottom) return blocks[k];
    }
    return blocks[anchorBlock({ sums: this.sums, offset: top, viewportH: this.viewH() })] ?? null;
  }

  onPage(i) {
    const top = this.offset - COLUMN.padTop;
    return this.sums[i + 1] > top && this.sums[i] < top + this.viewH();
  }

  scrollTo(offset, cx) {
    this.reveal = null;
    const next = clampOffset(offset, this.contentH(), this.viewH());
    if (next === this.offset) return;
    this.offset = next;
    this.updateHover(cx);
    this.syncWindow(cx);
    cx.notify();
  }

  viewportSized(size, cx) {
    const z = zoom(), next = { width: size.width / z, height: size.height / z };
    if (next.width === this.viewport?.width && next.height === this.viewport?.height) return;
    this.viewport = next;
    // A diagram's frame is sized from the viewport, so its block's data changes with it; so does every block's width
    // when the margin for comments comes, goes or narrows the page.
    const reading = this.doc && this.mode === "reading";
    if (reading && (this.diagramKeys.length || this.marginNow() !== this.margin)) this.rebuild(cx, this.anchor());
    else this.layout(this.anchor());
    this.updateHover(cx);
    this.syncWindow(cx);
    cx.notify();
  }

  // A gesture keeps what it began as: with Cmd or Ctrl over a frame it zooms that frame; over a frame whose picture is
  // wider than it, it pans the frame sideways once it shows it goes sideways; anything else scrolls the page.
  wheel(e, cx) {
    this.closeSlash(cx);
    const z = zoom(), m = e?.modifiers ?? {}, phase = e?.touch_phase, now = Date.now(), p = this.point(e) ?? this.pointer;
    let dx = (Number(e?.delta?.x) || 0) / z, dy = (Number(e?.delta?.y) || 0) / z;
    if (startsGesture(this.gesture, phase, now)) {
      const f = p ? this.frameAt(p) : null, v = f && this.viewOf(f.block.key);
      const mode = !v ? "page" : m.platform || m.control ? "zoom" : overflows(boxOf(f.d), natOf(f.d), v.z).x ? "decide" : "page";
      this.gesture = { mode, key: f?.block.key ?? null, sx: 0, sy: 0, ended: false };
    }
    const g = this.gesture;
    g.at = now;
    if (g.mode === "zoom") {
      // Momentum comes after "ended": it would zoom on to a limit.
      if (!g.ended && dy && p) this.zoomWheel(g.key, dy, p, cx);
      g.ended ||= phase === "ended" || phase === "cancelled";
      return;
    }
    // A mouse wheel with Shift that macOS did not turn sideways.
    if (g.mode !== "page" && m.shift && !dx) [dx, dy] = [dy, 0];
    if (g.mode === "decide") {
      g.sx += dx; g.sy += dy;
      const axis = decideAxis(g.sx, g.sy);
      if (!axis) return;
      g.mode = axis === "x" ? "x" : "page";
      [dx, dy] = [g.sx, g.sy];
    }
    if (g.mode === "x") {
      const v = this.viewOf(g.key);
      if (v && dx) this.setView(g.key, { ...v, x: v.x + dx }, cx);
      return;
    }
    if (dy) this.scrollPage(dy, p, cx);
  }

  scrollPage(dy, p, cx) {
    const f = p ? this.frameAt(p) : null, v = f && this.viewOf(f.block.key);
    if (!v || !overflows(boxOf(f.d), natOf(f.d), v.z).y) return this.scrollTo(this.offset - dy, cx);
    const r = passThrough({
      down: -dy, offset: this.offset, maxOffset: maxOffset(this.contentH(), this.viewH()), top: this.frameTop(f.i, f.d), h: f.d.frameH,
      viewH: this.viewH(), y: v.y, minY: Math.min(v.y, f.d.frameH - FRAME.pad - f.d.natH * v.z), maxY: Math.max(v.y, FRAME.pad),
    });
    if (r.y !== v.y) this.setView(f.block.key, { ...v, y: r.y }, cx);
    this.scrollTo(r.offset, cx);
  }

  zoomWheel(key, dy, p, cx) {
    const d = this.data.get(key), v = this.viewOf(key), i = this.at.get(key);
    if (!v || i === undefined) return;
    const z1 = clamp(v.z * Math.exp(dy * FRAME.zoomPerPx), d.zMin, FRAME.zMax);
    this.setView(key, zoomAround(boxOf(d), natOf(d), v, z1, p.x - d.frameLeft, p.y - this.frameTop(i, d)), cx);
  }

  thumbGeometry() {
    const view = this.viewH(), content = this.contentH();
    if (!(view > 0) || content <= view) return null;
    const h = Math.max(28, (view * view) / content), max = maxOffset(content, view);
    return { h, top: max ? (this.offset / max) * (view - h) : 0, scale: max / Math.max(1, view - h) };
  }

  thumbDown(e, cx) {
    cx.stop_propagation();
    this.closeSlash(cx);
    this.thumb = { y: (e.position?.y ?? 0) / zoom(), offset: this.offset };
    this.press = null;
    cx.notify();
  }

  endThumb(cx) {
    if (!this.thumb) return false;
    this.thumb = null;
    cx.notify();
    return true;
  }

  point(e) {
    const l = e?.local_position;
    if (!l) return null;
    const z = zoom();
    return { x: l.x / z, y: l.y / z };
  }

  // A press the field's own wrapper took also reaches the viewport when events cross the block's view: it is the same
  // press when it is at the same window position.
  tookPress(e, kind) {
    const c = this.fieldPress;
    if (!c || c.kind !== kind || c.x !== e?.position?.x || c.y !== e?.position?.y) return false;
    this.fieldPress = null;
    return true;
  }

  // A press beside the edited block's field would take the keyboard from it: it is given back at once, and again on the
  // mouse-up if the root took it anyway. `beside` is that block's key, `key` the block pressed, from which a drag
  // selects blocks. A press anywhere but on the picked picture lets it go, one anywhere but on the chip whose language
  // menu is open closes the menu, and any press on the page ends a block's active comment and closes a new one, drawn
  // or scrolled out of sight.
  viewportDown(e, cx) {
    this.closeSlash(cx);
    this.closeBar(cx);
    this.closeCard(cx);
    this.endBlockNote(cx);
    if (this.blockAdd) this.closeBlockAddOut(cx);
    this.endThumb(cx);
    this.endPan(cx);
    this.linked = false;
    if (!e?.modifiers?.shift) this.setSel(null, cx);
    const p = this.point(e), hit = p ? this.hit(p) : null;
    if (!this.onPicked(hit)) this.unpick(cx);
    if (this.lang && !(hit?.on === "chip" && hit.block.key === this.lang.key)) this.letLanguagesGo(cx);
    if (this.tookPress(e, "down")) { this.press = null; return; }
    this.fieldHeld = null;
    this.dragFrom = windowPoint(e);
    if (p && e.modifiers?.shift) { this.press = null; return this.shiftTo(hit?.block, cx); }
    this.press = p ? { ...p, beside: null, key: hit?.block?.key ?? null, on: hit?.on ?? null } : null;
    const v = hit?.on === "frame" && this.dragFrom ? this.viewOf(hit.block.key) : null;
    if (v) this.pan = { key: hit.block.key, from: this.dragFrom, x0: v.x, y0: v.y, moved: false };
    if (!this.press || !this.activeKey) return;
    if (hit?.block && hit.block.key === this.activeKey) {
      this.press.beside = this.activeKey;
      this.field.focus();
    }
  }

  // A drag that stayed in a block not being edited, code say, selected its rendered text, for a Cmd+C where the press
  // left the keyboard: editing goes on, and neither this nor the root's mouse-up gives the field the keyboard back. A
  // press that began in a field and ended beside it is that field's mouse-up. Any other press, a frame pan included,
  // leaves the field the keyboard (keepKeyboard).
  viewportUp(e, cx) {
    if (this.endThumb(cx)) return this.keepKeyboard();
    const down = this.press, held = this.fieldHeld, p = this.point(e), linked = this.linked, panned = this.endPan(cx);
    this.press = null; this.linked = false; this.fieldHeld = null;
    if (panned) return this.keepKeyboard();
    if (this.tookPress(e, "up")) return;
    if (held) {
      this.released = { key: held, at: this.paneToField(held, p) };
      this.fieldReleased(held, cx);
    }
    const pressed = down && !linked ? down : null;
    if (pressed && p && e.click_count >= 1 && Math.hypot(p.x - pressed.x, p.y - pressed.y) <= CLICK_SLOP) this.clickAt(p, cx, e.click_count, Boolean(e.modifiers?.platform));
    else if (pressed?.key && this.activeKey && pressed.key !== this.activeKey && !this.sel) return cx.stop_propagation();
    this.keepKeyboard();
  }

  // A press beside the field (a task box, link, toolbar, banner, scrollbar) can take the keyboard from it, and the
  // root's keys ignore the page while a block is edited, so the field gets it back.
  keepKeyboard() {
    if (this.activeKey && this.editable() && this.focusedState !== this.field && !this.boxOpen()) this.field.focus();
  }

  // A frame fills much of the pane, so a single click on it (a tap, a click to focus the window) opens nothing: a
  // double-click opens the diagram's source. The − % + group works on files that cannot be edited too. `cmd`: a
  // Cmd+click.
  clickAt(p, cx, count = 1, cmd = false) {
    const hit = this.hit(p);
    if (!hit) return;
    if (hit.on === "tool") return this.toolClick(hit.block.key, hit.tool, cx);
    if (hit.on === "task") return this.tick(hit.block, cx);
    if (hit.on === "notes") return this.openCard(hit.block.key, cx);
    if (hit.on === "picture") return this.pictureClick(hit, cx, cmd);
    if (!this.editable()) return;
    if (hit.on === "comment") return this.commentPress(hit.block.key, cx);
    if (hit.on === "chip") return this.chipPress(hit.block, cx);
    if (hit.on === "frame") {
      if (count >= 2) this.clickBlock(hit.block.key, p, cx);
      return;
    }
    if (hit.on === "outside") return this.deactivate(cx);
    if (hit.on === "end") return this.openPending(cx);
    if (hit.block.key !== this.activeKey) this.clickBlock(hit.block.key, p, cx);
  }

  // A click on a picture picks it, a double-click too, and the block being edited is left; Cmd+click follows a linked
  // picture's link instead, on files that cannot be edited too. The space between pictures picks none. In the margin
  // a commented picture's comment becomes active with it: its card is there to show it.
  pictureClick(hit, cx, cmd) {
    const item = this.pictures.get(hit.block.key)?.items[hit.item];
    if (cmd && item?.href) return this.link(item.href, cx);
    if (hit.item < 0) return;
    if (this.activeKey) this.deactivate(cx);
    this.setSel(null, cx);
    this.pick(hit.block.key, hit.item, cx);
    if (item.comment && this.margin && this.editable()) this.setBlockNote({ key: hit.block.key, index: item.comment.index, editing: false }, cx);
  }

  // A right-click on a picture picks it, its float standing for a menu; anywhere else it lets the picked one go.
  viewportRightDown(e, cx) {
    const p = this.point(e), hit = p ? this.hit(p) : null;
    this.letLanguagesGo(cx);
    if (hit?.on === "picture" && hit.item >= 0) return this.pictureClick(hit, cx, false);
    this.unpick(cx);
  }

  onPicked(hit) {
    const p = this.picked;
    return Boolean(p) && hit?.on === "picture" && hit.block.key === p.key && hit.item === p.index;
  }

  // A move event says nothing of the buttons: while a press is under way, on the page or in a field, a drag that
  // reaches another block selects whole blocks.
  viewportMove(e, cx) {
    if (this.thumb) {
      const g = this.thumbGeometry();
      if (g) this.scrollTo(this.thumb.offset + ((e.position?.y ?? 0) / zoom() - this.thumb.y) * g.scale, cx);
      return;
    }
    this.pointer = this.point(e);
    if (this.pan) return this.panTo(e, cx);
    this.updateHover(cx);
    const held = this.press ? this.press.key : this.fieldHeld;
    if (held && this.pointer && this.dragged(e)) this.dragTo(held, this.pointer, cx);
  }

  // A click's jitter is no drag: across a block's edge it would select blocks and end the editing the press began.
  dragged(e) {
    const from = this.dragFrom, p = windowPoint(e);
    if (from && p && Math.hypot(p.x - from.x, p.y - from.y) <= CLICK_SLOP) return false;
    this.dragFrom = null;
    return true;
  }

  viewportHover(hovered, cx) {
    if (hovered) return;
    this.endThumb(cx);
    this.endPan(cx);
    this.press = null; this.fieldHeld = null; this.pointer = null;
    this.updateHover(cx);
  }

  // The frame of the diagram block at viewport point p: { block, i, d, fx, fy }, the point in frame coordinates.
  frameAt(p) {
    const blocks = this.blocks, n = blocks.length, y = p.y + this.offset - COLUMN.padTop;
    if (!n || this.sums.length !== n + 1 || y < 0 || y >= this.sums[n]) return null;
    const i = blockAt(this.sums, y), b = blocks[i], d = this.data.get(b.key);
    if (!d?.frameW) return null;
    const fx = p.x - d.frameLeft, fy = y - (this.sums[i + 1] - d.frameH);
    return fx >= 0 && fx < d.frameW && fy >= 0 ? { block: b, i, d, fx, fy } : null;
  }

  // A frame is its block's last child: its top in the viewport.
  frameTop(i, d) {
    return COLUMN.padTop + this.sums[i + 1] - d.frameH - this.offset;
  }

  viewOf(key) {
    const d = this.data.get(key);
    if (!d?.frameW) return null;
    const kept = this.frames.get(key);
    if (!kept) return { z: d.z0, x: d.startX, y: d.startY };
    return clampView(boxOf(d), natOf(d), { ...kept, z: clamp(kept.z, d.zMin, FRAME.zMax) });
  }

  frameView(key) {
    const v = this.viewOf(key), d = this.data.get(key);
    if (!v) return null;
    return {
      ...v,
      sharp: d.sharpKey && FRAME.dpr * zoom() * v.z > d.imgScale ? d.sharpKey : "",
      tools: this.toolsShown(key) ? { top: this.toolsTopOf(key), pct: Math.round(v.z * 100), out: canZoom(v.z, -1, d.zMin), in: canZoom(v.z, 1, d.zMin), comment: this.showsEdits() } : null,
      cursor: this.pan?.moved && this.pan.key === key ? "grabbing" : "grab",
    };
  }

  toolsShown(key) {
    return this.hoverFrame === key || Boolean(this.pan?.moved && this.pan.key === key);
  }

  toolsTopOf(key) {
    const i = this.at.get(key), d = this.data.get(key);
    return i === undefined || !d?.frameW || this.sums.length !== this.blocks.length + 1 ? FRAME.tools.top : toolsTop(d.frameH, this.frameTop(i, d));
  }

  // The page moving under a resting pointer can change which frame, code block or table it is over, or where that
  // frame's − % + group must sit to stay on the page. The blocks whose controls come, go or move draw again.
  updateHover(cx) {
    const p = this.pointer, frame = (p && this.frameAt(p)?.block.key) ?? null, top = frame ? this.toolsTopOf(frame) : null;
    const box = p && !frame ? this.boxAt(p) : null;
    if (frame === this.hoverFrame && top === this.hoverTop && box === this.hoverBox) return;
    const was = [this.hoverFrame, this.hoverBox];
    this.hoverFrame = frame; this.hoverTop = top; this.hoverBox = box;
    this.notifyBlocks([...new Set([...was, frame, box])], cx);
  }

  // The code block or table whose box holds viewport point p, a diagram's source being edited counting as code, and a
  // grid with its Comment button beside it; null where no Comment button would show.
  boxAt(p) {
    const blocks = this.blocks, n = blocks.length, y = p.y + this.offset - COLUMN.padTop;
    if (!n || this.sums.length !== n + 1 || y < 0 || y >= this.sums[n] || !this.showsEdits()) return null;
    const i = blockAt(this.sums, y), b = blocks[i], d = this.data.get(b.key);
    if (!d || !(d.strip || d.kind === "table") || y < this.sums[i] + d.space) return null;
    const x = columnX(p.x, this.viewport?.width ?? this.size?.width ?? 0, this.margin);
    const right = d.grid ? b.depth * INDENT + d.grid.w + BLOCK_BUTTON.gap + BLOCK_BUTTON.size : this.textWidth();
    return x >= b.depth * INDENT && x < right ? b.key : null;
  }

  notifyBlocks(keys, cx) {
    if (!cx || !keys.some(Boolean)) return;
    if (this.inline) return cx.notify();
    for (const key of keys) {
      const e = key && this.entities.get(key);
      if (e) cx.notify(e);
    }
  }

  setView(key, v, cx) {
    const d = this.data.get(key), now = this.viewOf(key);
    if (!now) return false;
    const next = clampView(boxOf(d), natOf(d), v);
    if (next.z === now.z && next.x === now.x && next.y === now.y) return false;
    this.frames.set(key, next);
    this.notifyBlocks([key], cx);
    if (next.z !== now.z) this.zoomedNow(key, cx);
    return true;
  }

  panTo(e, cx) {
    const pan = this.pan, w = windowPoint(e);
    if (!w) return;
    const dx = w.x - pan.from.x, dy = w.y - pan.from.y, first = !pan.moved;
    if (first && Math.hypot(dx, dy) <= CLICK_SLOP) return;
    pan.moved = true;
    const v = this.viewOf(pan.key);
    if (!(v && this.setView(pan.key, { ...v, x: pan.x0 + dx, y: pan.y0 + dy }, cx)) && first) this.notifyBlocks([pan.key], cx);
  }

  endPan(cx) {
    const pan = this.pan;
    this.pan = null;
    if (pan?.moved) this.notifyBlocks([pan.key], cx);
    return Boolean(pan?.moved);
  }

  toolClick(key, tool, cx) {
    if (tool === "comment") return this.commentPress(key, cx);
    const d = this.data.get(key), v = this.viewOf(key);
    if (!v) return;
    if (tool === "pct") {
      if (this.frames.delete(key)) this.notifyBlocks([key], cx);
      return;
    }
    const z1 = zoomStep(v.z, tool === "in" ? 1 : -1, d.z0, d.zMin);
    if (z1 !== v.z) this.setView(key, zoomAround(boxOf(d), natOf(d), v, z1, d.frameW / 2, d.frameH / 2), cx);
  }

  zoomedNow(key, cx) {
    this.zoomed.add(key);
    this.settleTimer?.cancel();
    this.settleTimer = cx.timer.after(FRAME.settleMs, cx => {
      this.settleTimer = null;
      if (this.closed) return;
      for (const k of this.zoomed) this.askSharp(k, cx);
      this.zoomed.clear();
    });
  }

  // The base picture is drawn for a zoom of 100 % on a 2x screen. Past that, by a margin, a sharper one is drawn
  // (one per diagram), when the pixel budget allows a scale clearly above the base's.
  askSharp(key, cx) {
    const d = this.data.get(key), v = this.viewOf(key), b = this.blockByKey(key), g = this.shown.get(key);
    if (!v || !b || d.imgDim || g?.key !== d.imgKey || FRAME.dpr * zoom() * v.z <= d.imgScale * 1.1) return;
    const scale = sharpScale(natOf(d), zoom());
    if (scale >= d.imgScale + 0.5) this.diagrams.sharp(g.key, b.source, scale, cx);
  }

  // Shift+click on a block selects whole blocks from the one being edited (or the one Escape left, or where the
  // selection began) to it. A Shift+click in the block being edited is that block's own.
  shiftTo(b, cx) {
    const known = k => (k && this.blockByKey(k) ? k : null);
    if (!b || b.key === this.activeKey || !known(b.key)) return;
    const from = known(this.sel?.from) ?? known(this.activeKey) ?? known(this.pending?.origin?.key) ?? known(this.stored?.key) ?? b.key;
    this.select(from, b.key, cx);
  }

  // The field the drag began in goes on selecting while the button is down: with blocks selected, it shows none.
  dragTo(from, p, cx) {
    const b = this.hit(p)?.block;
    if (!b || !this.blockByKey(from) || !this.blockByKey(b.key) || (!this.sel && b.key === from)) return;
    this.select(from, b.key, cx);
    this.unselect(this.blockField(from));
  }

  select(from, to, cx) {
    if (this.sel?.from === from && this.sel.to === to) return;
    this.leave(cx);
    this.handle.focus();
    this.setSel({ from, to }, cx);
  }

  // A field that is not being edited shows no selection.
  unselect(state) {
    const c = state && state !== this.field ? caretOf(state) : null;
    if (c && c.start !== c.end) this.guard(() => state.set_selected_range({ start: c.end, end: c.end }));
  }

  // The blocks a selection covers, as indices into doc.blocks: [first, last], the sub-blocks of the last ones
  // included, as removeRange takes them, and the comments paragraph of a last block that has one; null when either end
  // is gone.
  selRange(sel = this.sel) {
    const bl = this.doc?.blocks ?? [], a = sel ? bl.findIndex(b => b.key === sel.from) : -1, z = sel ? bl.findIndex(b => b.key === sel.to) : -1;
    if (a < 0 || z < 0) return null;
    let k = Math.max(a, z), end = 0;
    for (let j = Math.min(a, z); j <= k; j++) {
      end = Math.max(end, bl[j].subtreeEnd);
      if (j === k && bl[k + 1]?.start < end) k++;
    }
    return [Math.min(a, z), notesAfter(this.doc, bl[k])?.index ?? k];
  }

  keysIn(range) {
    return new Set(range ? this.doc.blocks.slice(range[0], range[1] + 1).map(b => b.key) : []);
  }

  setSel(sel, cx) {
    if (sel) this.unpick(cx);
    if (!sel && !this.sel) return;
    const before = this.selKeys, range = sel && this.selRange(sel);
    this.sel = range ? sel : null;
    this.selKeys = this.keysIn(range);
    for (const k of this.selKeys) if (!before.has(k)) this.gens.set(k, (this.gens.get(k) ?? 0) + 1);
    this.redraw([...new Set([...before, ...this.selKeys])], cx);
    cx?.notify();
  }

  updateSel() {
    if (!this.sel) return;
    const range = this.selRange();
    if (!range) this.sel = null;
    this.selKeys = this.keysIn(range);
  }

  selectionKey(e, cx) {
    const k = e.keystroke, m = e.modifiers ?? {};
    if (isCommentKey(e)) {
      cx.stop_propagation();
      if (this.sel.from === this.sel.to) this.openBlockAdd(this.sel.from, cx);
      return true;
    }
    if (k === "cmd-c" || k === "cmd-x") {
      cx.stop_propagation();
      this.copySel(cx);
      if (k === "cmd-x") this.removeSel(cx);
      return true;
    }
    if (k === "backspace" || k === "delete") {
      cx.stop_propagation();
      this.removeSel(cx);
      return true;
    }
    if (k === "escape" || (e.key_char && !m.platform && !m.control)) {
      cx.stop_propagation();
      this.setSel(null, cx);
      return true;
    }
    return false;
  }

  copySel(cx) {
    const r = this.selRange(), bl = this.doc?.blocks;
    if (r) cx.write_to_clipboard(this.doc.text.slice(bl[r[0]].start, bl[r[1]].end).replace(/\r?\n$/, ""));
  }

  // One splice and one entry of the history: Cmd+Z brings the blocks back with the caret at the start of the first.
  removeSel(cx) {
    const r = this.selRange();
    if (!r || !this.editable()) return;
    const bl = this.doc.blocks, s = removeRange(this.doc, bl[r[0]], bl[r[1]]);
    this.setSel(null, cx);
    if (s) this.change(s, cx, { caretBefore: bl[r[0]].start, caretAfter: s.caret });
    this.handle.focus();
  }

  // The block under a viewport point and what on it: a diagram's frame (also where it reaches into the margins), a cell
  // of its − % + group or its Comment button, a picture block (`item` the picture under the point, or -1), a code
  // block's or table's Comment button, a code block's language chip, a checkbox, a body, the space below the last block
  // ("end"), or a margin outside every block ("outside"). x and y are relative to the block's root, fx and fy to the
  // frame. A page with no blocks is all "end".
  hit(p) {
    const blocks = this.blocks, n = blocks.length;
    if (this.sums.length !== n + 1) return null;
    const y = p.y + this.offset - COLUMN.padTop, x = columnX(p.x, this.viewport?.width ?? this.size?.width ?? 0, this.margin);
    const counted = this.countAt(x, y);
    if (counted) return { block: counted, on: "notes" };
    const f = this.frameAt(p);
    if (f) {
      const tool = this.toolsShown(f.block.key) ? frameTool(f.fx, f.fy, f.d.frameW, this.toolsTopOf(f.block.key), this.showsEdits()) : null;
      return { block: f.block, on: tool ? "tool" : "frame", tool, fx: f.fx, fy: f.fy };
    }
    const button = this.buttonAt(x, y);
    if (button) return { block: button, on: "comment" };
    if (x < 0 || x >= this.textWidth()) return { on: "outside" };
    if (!n) return { on: "end" };
    if (y < 0) return { on: "outside" };
    if (y >= this.sums[n]) return { on: "end" };
    const i = blockAt(this.sums, y), b = blocks[i], d = this.data.get(b.key);
    const inX = x - b.depth * INDENT, inY = y - this.sums[i] - d.space;
    if (d.look === "picture" && d.mode === "rendered") return { block: b, on: "picture", item: this.pictureAt(d, inX, inY), x, y: y - this.sums[i] };
    if (d.chip && this.editable() && inBox(this.chipIn(d), x, y - this.sums[i])) return { block: b, on: "chip" };
    const on = d.marker === "task" && inX >= 0 && inX < MARKER_W && inY >= 0 && inY < d.row ? "task" : "block";
    return { block: b, on, x, y: y - this.sums[i] };
  }

  // The block whose Comment button holds column point (x, y); a grid's lies right of the text column when the grid is
  // as wide as the column.
  buttonAt(x, y) {
    const n = this.blocks.length;
    if (!n || y < 0 || y >= this.sums[n]) return null;
    const i = blockAt(this.sums, y), b = this.blocks[i], box = this.blockButtonIn(this.data.get(b.key));
    return box && inBox(box, x, y - this.sums[i]) ? b : null;
  }

  // The block whose comment count holds column point (x, y), which may lie right of the text column.
  countAt(x, y) {
    const n = this.blocks.length;
    if (!n || y < 0 || y >= this.sums[n]) return null;
    const i = blockAt(this.sums, y), b = this.blocks[i], d = this.data.get(b.key), by = y - this.sums[i];
    return d?.notes && x >= d.notesX && x < d.notesX + NOTES.w && by >= d.notesY && by < d.notesY + NOTES.h ? b : null;
  }

  tick(b, cx) {
    if (this.remote || this.locked || !this.file) return;
    const key = b.key;
    this.commit(cx);
    const now = this.blockByKey(key), s = now && toggleTask(this.doc, now);
    if (!s) return;
    this.change(s, cx);
    this.saveNow(cx);
  }

  editable() {
    return Boolean(this.file) && this.loaded && !this.error && !this.remote && !this.locked && !this.closed && this.mode === "reading";
  }

  // Block `key` becomes the edited one, the caret at field offset `caret` (a number or a range). `shift` moves the page
  // down by that much; `reveal` keeps the caret row in view, which a press does not want: the page does not move on a click.
  // A paragraph of pictures is never edited: the picture at the caret is picked instead. Nor is a block's comments
  // paragraph: nothing opens. Another block's active comment ends. -> whether a block is edited.
  activate(key, caret, cx, { shift = 0, reveal = true } = {}) {
    if (!this.editable() || this.hiddenNotes(key)) return false;
    if (this.blockNote && this.blockNote.key !== key) this.endBlockNote(cx);
    this.setSel(null, cx);
    if (this.activeKey && this.activeKey !== key) this.leave(cx, key);
    else if (this.activeKey) this.commit(cx);
    const b = this.blockByKey(key);
    if (!b) return false;
    if (b.image) {
      const f = fieldOf(this.doc, b), at = typeof caret === "number" ? caret : caret?.start ?? 0;
      this.pickNear(b, fieldToDoc(f, at), cx);
      if (reveal) this.revealPicked(cx);
      return false;
    }
    this.unpick(cx);
    const anchor = this.anchor(), f = fieldOf(this.doc, b), value = withInnerLine(b, f.value), n = value.length;
    const r = typeof caret === "number" ? { start: caret, end: caret } : caret ?? { start: 0, end: 0 };
    this.f = f; this.opened = value;
    this.field = this.fieldFor(b); this.tokensOff = false;
    if (!this.setField(value, { start: clamp(r.start, 0, n), end: clamp(r.end, 0, n) })) { this.drop(); this.rebuild(cx, anchor); return false; }
    const was = this.activeKey;
    this.activeKey = key; this.act++;
    this.retoken();
    this.rows = this.rowsFlag();
    if (was === key) this.redraw([key], cx);
    else this.rebuild(cx, anchor);
    if (shift) this.offset = clampOffset(this.offset + shift, this.contentH(), this.viewH());
    this.focusField(cx);
    if (reveal) this.revealCaret(cx);
    this.syncWindow(cx);
    cx.notify();
    return true;
  }

  // The value is taken as seen before set_value, which may report it as a change. A field that holds it already (a
  // block's own) keeps it, with its tokens.
  setField(value, range) {
    this.seen = value;
    this.known = { start: range.start, end: range.end, valid: true };
    return this.guard(() => {
      if (this.field.value() !== value) this.field.set_value(value);
      this.field.set_selected_range(range);
    });
  }

  // The edited text block's layout (tokens.js), made once per value, or taken from its own field's when that was made
  // from the same; null for a block that shows its source.
  richNow() {
    if (!this.activeKey || this.pending || this.mode !== "reading" || !this.doc) return null;
    const key = this.activeKey, value = this.seen, defs = this.defsNow(), kept = this.rich, b = this.blockByKey(key);
    const checked = Boolean(b?.task?.checked), tint = this.tintNow();
    if (kept && kept.key === key && kept.value === value && kept.defs === defs && kept.checked === checked && kept.tint === tint) return kept.layout;
    const own = this.blockFields.get(key), same = !tint && own?.rich && own.value === value && own.defs === defs && own.checked === checked;
    const layout = !b || !isText(b) || b.image ? null
      : same ? own.rich : richOf(value, parsedInline(value, defs.map), { everyWord: checked, tint });
    this.rich = { key, value, defs, checked, tint, layout };
    return layout;
  }

  // What of the edited field draws in another highlight: the text a comment is being written on, in the highlight, or
  // the active comment's, deeper. Kept as the same object while it stays the same. -> { start, end, letter } or null.
  tintNow() {
    const n = this.noteOpen() ? this.note : null, e = this.element;
    const kept = this.tinted;
    if (kept && kept.seen === this.seen && kept.note === n && kept.element === e && kept.act === this.act) return kept.tint;
    let tint = null;
    if (n?.kind === "add") tint = n.range.start < n.range.end ? { start: n.range.start, end: n.range.end, letter: TINT_NEW } : null;
    else if (n || (e && e.act === this.act && COMMENT_KINDS.has(e.kind))) tint = this.deepTint(n ? n.comment.start : e.start);
    this.tinted = { seen: this.seen, note: n, element: e, act: this.act, tint };
    return tint;
  }

  deepTint(start) {
    const c = noted(this.seen).find(x => x.start === start);
    if (!c) return null;
    return c.kind === "point" ? { start: c.start, end: c.end, letter: TINT_ACTIVE } : { start: c.from, end: c.to, letter: TINT_ACTIVE };
  }

  // The active field's text as it draws it, for the estimates of rows and columns.
  drawnNow() {
    const r = this.tokensOff ? null : this.richNow();
    return r ? r.drawn : this.seen;
  }

  drawnAt(at) {
    const r = this.tokensOff ? null : this.richNow();
    return r ? drawnOffset(r, at) : at;
  }

  // The active field's tokens, set only when they differ from the field's, so typing in plain words sets none (a key
  // mend repaired sets them with its value, through refill). A set the field refuses is tried again without letters at
  // the caret, then without tokens.
  retoken() {
    if (this.tokensHeld || !this.activeKey || this.field.value() !== this.seen) return;
    const sel = this.known.valid ? this.known : caretOf(this.field);
    if (!sel) return;
    const r = this.richNow(), want = r ? tokensFor(r, sel) : { tokens: [], sel };
    if (sameTokens(this.field.tokens(), want.tokens)) {
      if (want.sel.start !== sel.start || want.sel.end !== sel.end) this.selectField(want.sel);
      return;
    }
    this.putTokens(r, want);
  }

  // The field takes `this.seen` with the tokens `want` gives it, else without letters at the caret, else with none.
  putTokens(r, want) {
    for (const tokens of [want.tokens, r ? tokensFor(r, null).tokens : null, []]) {
      if (tokens && this.setTokens(tokens, want.sel)) {
        this.tokensOff = !tokens.length && want.tokens.length > 0;
        return true;
      }
    }
    return false;
  }

  // The field shows `this.seen`, a repair of what was typed, with its tokens and the caret at field offset `caret`: one
  // set_value, made as a token set is.
  refill(caret) {
    const sel = { start: caret, end: caret }, r = this.richNow();
    return this.putTokens(r, r ? tokensFor(r, sel) : { tokens: [], sel });
  }

  // Herdr has no set_tokens: set_value takes the text with its tokens, and the selection goes back after it. A change
  // of the same text it reported would read as a forward Delete at the end of the block, so for ECHO_MS one is taken as
  // the set's (takeEcho); a set never outlives that, or it would swallow a real Delete.
  setTokens(tokens, sel) {
    const state = this.field, set = ++this.tokenSets, sets = this.echoes.get(state) ?? [];
    this.echoes.set(state, sets);
    sets.push(set);
    try {
      state.set_value({ text: this.seen, tokens });
    } catch {
      this.letGo(state, set);
      return false;
    }
    this.post(cx => cx.timer.after(ECHO_MS, () => this.letGo(state, set)));
    this.selectField(sel);
    return true;
  }

  letGo(state, set) {
    const sets = this.echoes.get(state), i = sets ? sets.indexOf(set) : -1;
    if (i >= 0) sets.splice(i, 1);
  }

  // -> whether a change event of field `state` that left its text alone is the report of a recent token set.
  takeEcho(state) {
    const sets = this.echoes.get(state);
    if (!sets?.length) return false;
    sets.shift();
    return true;
  }

  // What a token draws (page.js), from its id and label.
  tokenPieces(token) {
    const key = `${token.id}\u{0}${token.label}`;
    let pieces = this.pieces.get(key);
    if (!pieces) {
      if (this.pieces.size >= PIECES_KEPT) this.pieces.clear();
      pieces = piecesOf(token.id, token.label);
      this.pieces.set(key, pieces);
    }
    return pieces;
  }

  // A click on a token gives its bounds, not where it was: the x of the press across them picks the letter edge, and
  // the word holding it splits into letters there. With Cmd a click on a link opens it.
  tokenClick(key, ev) {
    const press = this.pressed;
    this.post(cx => this.pressToken(key, ev, press, cx));
  }

  // A press on an element picks it: all of it is selected and its float shows. A press on the element already picked
  // places the caret, so its text can be edited.
  pressToken(key, ev, press, cx) {
    if (!this.editable()) return;
    if (ev?.modifiers?.platform && this.openLinkIn(key, ev.range, cx)) return;
    if (key !== this.activeKey) this.takeField(key, cx);
    if (key !== this.activeKey) return;
    this.syncField(cx);
    const r = this.richNow(), box = ev?.bounds, range = ev?.range, x = press?.x;
    if (!r || !range) return;
    const at = pressedAt(r, range, typeof x === "number" && box?.width > 0 ? (x - box.x) / box.width : 1);
    const span = this.elementPressed(range, at);
    if (span && !this.wasPicked(span)) {
      this.pickElement(span, cx);
      this.pinToken(r, span, range, box, press);
      return;
    }
    this.placeCaret(at, cx);
    if (span) this.element = { act: this.act, kind: span.kind, start: span.start };
    if (span && COMMENT_KINDS.has(span.kind)) this.retoken();
    cx.notify();
  }

  // The element span the token at field range `range` shows part of (a point comment, or a picture with no alt text,
  // shows nothing of its own: its token holds all of it); when it shows more than one, the innermost holding the press's
  // letter edge `at`. A picture the token shows wins over the element holding it, whose marks the letter edge can fall
  // on (a link around the picture alone).
  elementPressed(range, at) {
    const shows = sp => (sp.from === sp.to ? range.start <= sp.start && sp.end <= range.end : sp.from < range.end && range.start < sp.to);
    const hit = parsedInline(this.seen, this.defsNow().map).spans.filter(sp => ELEMENTS[sp.kind] && shows(sp));
    let inner = null;
    for (const sp of hit) if (sp.from <= at && at <= sp.to) inner = sp;
    inner ??= hit[0] ?? null;
    return hit.find(sp => sp.kind === "image" && inner.start <= sp.start && sp.end <= inner.end) ?? inner;
  }

  wasPicked(span) {
    const p = this.pressedOn;
    return Boolean(p) && p.key === this.activeKey && p.value === this.seen && p.kind === span.kind && p.start === span.start;
  }

  pickElement(span, cx) {
    this.endBlockNote(cx);
    this.element = { act: this.act, kind: span.kind, start: span.start };
    this.known = { start: span.start, end: span.end, valid: true };
    this.retoken();
    this.selectField(this.known);
    this.slashCaret(this.known, cx);
    this.closeBar(cx);
    cx.notify();
  }

  // The element picked, while the selection lies inside it: { kind, span, extent }, or null.
  elementNow() {
    const e = this.element, k = this.known;
    if (!e || e.act !== this.act || !this.activeKey || this.pending || !this.editable() || !k.valid || this.noteOpen()) return null;
    return this.elementHolding(e.kind, k);
  }

  // The element of `kind` whose text, with the hidden marks that go with it (its extent), holds `range` of the field.
  elementHolding(kind, range) {
    const r = this.tokensOff ? null : this.richNow();
    for (const span of parsedInline(this.seen, this.defsNow().map).spans) {
      if (span.kind !== kind) continue;
      const extent = r ? extentOf(r, span) : { start: span.start, end: span.end };
      if (extent.start <= range.start && range.end <= extent.end) return { kind, span, extent };
    }
    return null;
  }

  // After the selection was read or typed in: the element picked stays while the selection lies inside it.
  keepElement() {
    if (this.element && this.known.valid && !this.elementNow()) this.element = null;
  }

  closeElement(cx) {
    if (!this.element) return;
    const tinted = COMMENT_KINDS.has(this.element.kind);
    this.element = null;
    if (tinted) this.retoken();
    cx?.notify();
  }

  // A press outside the element's float: one in the edited field is that field's to judge (fieldDown, pressToken);
  // any other closes it, once the press has gone where it goes.
  elementPressOut() {
    const picked = this.element;
    if (picked) this.post(cx => { if (this.element === picked) this.closeElement(cx); });
  }

  // Drawn by the root, the element picked's float or the box open over it.
  elementFloat(t) {
    if (this.linkBoxOpen()) return this.linkBoxView(t);
    if (this.imageBoxOpen()) return this.imageBoxView(t);
    const picked = this.elementNow();
    return picked ? this[ELEMENTS[picked.kind].float](picked, t) : null;
  }

  placeCaret(at, cx) {
    this.known = { start: at, end: at, valid: true };
    this.retoken();
    this.selectField(this.known);
    this.slashCaret(this.known, cx);
    this.openBar(cx);
  }

  // A Cmd+press on a link token of block `key` opens the link, as a click on it in Reading does: the block it went
  // into is not opened for it (fieldReleased), and an edited block keeps its caret after the link's word. -> false
  // when the token is no link's.
  openLinkIn(key, range, cx) {
    const value = key === this.activeKey ? this.seen : this.blockField(key)?.value();
    const link = range && typeof value === "string" ? linkAt(parseInline(value, { defs: this.doc.defs }).spans, range.start) : null;
    if (!link) return false;
    if (this.cmdPress?.key === key) this.cmdPress.opened = true;
    this.link(link.url, cx);
    if (key === this.activeKey) this.placeCaret(range.end, cx);
    return true;
  }

  focusField(cx) {
    const act = this.act, state = this.field;
    state.focus();
    cx.timer.after(REFOCUS_MS, () => { if (!this.closed && this.act === act && this.activeKey && !this.boxOpen()) state.focus(); });
  }

  // What was typed is parsed in, an emptied block goes with its comments (a fenced one keeps its fences), and a pending
  // one is never written unless it holds a marker held back (writeHeld). While its caret row is on the page the block
  // keeps its top where it is; a pending block, which goes, leaves block `keep` (the one opened next) where it is, else
  // the block above it.
  leave(cx, keep = null) {
    if (!this.activeKey) return;
    this.syncField(cx);
    this.writeHeld(cx);
    const pending = this.pending, b = pending ? null : this.blockByKey(this.activeKey);
    let anchor = this.anchor();
    if (pending && anchor?.key === pending.key) {
      const i = this.at.get(keep) ?? (this.at.get(pending.key) ?? 0) - 1;
      anchor = i >= 0 && this.blocks[i] ? { key: this.blocks[i].key, y: COLUMN.padTop + this.sums[i] - this.offset } : null;
    }
    const gone = b && this.seen === "" && this.opened !== "" && b.subtreeEnd === b.end && !b.fence ? removeWithNotes(this.doc, b) : null;
    const base = this.doc.text;
    if (gone) this.f = null;
    this.commit(cx);
    this.activeKey = null; this.pending = null; this.f = null; this.known = NO_CARET; this.act++; this.rows = "many"; this.ownKeyUp = null; this.menuKeyUp = null; this.slash = null; this.bar = null; this.note = null;
    this.element = null; this.linkBox = null; this.imageBox = null; this.typingStyle = null;
    this.letField();
    if (pending) this.forget(pending.key);
    if (gone) this.setText(applySplice(base, gone), cx);
    this.rebuild(cx, anchor);
    cx.notify();
  }

  // The field of the block no longer edited stays its drawer, with no selection showing; one no block owns any more
  // (its block became code, say) goes.
  letField() {
    const was = this.field, key = this.fieldKeys.get(was);
    this.field = this.loose;
    if (was === this.loose) return;
    if (key === undefined) return this.releaseField(was);
    this.unselect(was);
    this.blockFields.get(key).src = null;
  }

  deactivate(cx) {
    this.leave(cx);
    this.handle.focus();
    cx.notify();
  }

  // The edited block went away under a change: nothing is left of it to commit.
  drop() {
    this.release();
    this.handle.focus();
  }

  // Editing stops without the rules of leaving (an emptied block goes, a held marker is written, a fence is closed):
  // an undo, paste or op is about to replace the text around the block, and those rules would record entries of their own.
  release() {
    const pending = this.pending;
    this.activeKey = null; this.pending = null; this.f = null; this.known = NO_CARET; this.act++; this.rows = "many"; this.ownKeyUp = null; this.menuKeyUp = null; this.slash = null; this.bar = null; this.note = null;
    this.element = null; this.linkBox = null; this.imageBox = null; this.typingStyle = null;
    this.letField();
    if (pending) this.forget(pending.key);
  }

  openPending(cx) {
    if (this.pending?.atEnd) { this.focusField(cx); return; }
    this.openPendingWith({ base: atEnd, atEnd: true }, cx);
  }

  // An empty block the text does not have yet becomes the one being edited: `base` and `steps` write it (see
  // PLACEHOLDER), `origin` ({ key, caret }) is where it was opened from by a key, which Cmd+Z goes back to.
  openPendingWith({ base, steps = [], origin = null, atEnd: end = false }, cx) {
    if (!this.editable()) return false;
    this.leave(cx);
    const p = { key: `p${++this.pendings}`, base, steps, origin, atEnd: end };
    if (!this.simulate(p)) return false;
    this.setSel(null, cx);
    this.unpick(cx);
    const anchor = this.anchor();
    this.pending = p;
    this.f = null; this.opened = "";
    if (!this.setField("", { start: 0, end: 0 })) { this.drop(); this.rebuild(cx, anchor); return false; }
    this.activeKey = p.key; this.act++; this.rows = "one";
    this.rebuild(cx, anchor);
    this.focusField(cx);
    this.revealCaret(cx);
    cx.notify();
    return true;
  }

  // The first text typed into the pending block writes it where it was opened. Spaces alone write nothing, as they
  // would make no block. A marker alone (`#`, `-`, `1.`, `>`) is held back until the shortcut's space, any other
  // character, Enter or leaving the block writes it as typed (writeHeld). So is a slash that opens the menu, with what
  // follows it, while the menu is open: a pick writes the block it makes instead. So are the marks of bold or
  // strikethrough around nothing, which alone would make a rule or a fence. A typing style waits with what is held back,
  // formats the text that writes the block, and goes on in the block written.
  pendingTyped(before, value, edit, own, style, cx) {
    let k = edit.at + edit.inserted.length;
    this.seen = value;
    this.known = { start: k, end: k, valid: true };
    this.slashChanged({ a: edit.at, r: edit.removed, ins: edit.inserted }, value, own, cx);
    if (!value.trim() || loneMarker(value) || EMPTY_MARKS.test(value) || this.slashOpen()) return this.keepStyleAt(k, style);
    const mended = style ? mend(before, edit, { defs: this.defsNow().map, style }) : null;
    if (mended && mended.value !== value) {
      this.seen = mended.value;
      if (this.refill(mended.caret)) k = mended.caret;
      else this.seen = value;
    }
    if (this.writePending(this.seen, k, cx) && this.known.valid) this.keepStyleAt(this.known.end, mended?.style ?? null);
  }

  // The typing style `format` stays with field caret `at` of the value now shown.
  keepStyleAt(at, format) {
    this.typingStyle = format ? { act: this.act, value: this.seen, at, format } : null;
  }

  // The typing style the change `edit` was made at: one set at the caret it typed at, or deleted from (Backspace ends
  // there, Delete starts there), in the value it changed.
  styleFor(edit) {
    const t = this.typingStyle;
    if (!t || t.act !== this.act || t.value !== this.seen) return null;
    return t.at === edit.at || (edit.removed > 0 && t.at === edit.at + edit.removed) ? t.format : null;
  }

  // Whether the change `edit` typed in the field is checked, and repaired if need be, so that it keeps the formatting it
  // did not delete: the person's own typing in a paragraph, heading, item or quote whose field draws it formatted. A
  // field that shows its source (its tokens refused) is the person's to edit, marks and all: only text typed with a
  // typing style is written there, with that style's marks.
  mends(own, edit, style) {
    if (own || this.mode !== "reading" || !this.takesMarks()) return false;
    return (!this.tokensOff && this.richNow() !== null) || (style !== null && !edit.removed);
  }

  // Writes the pending block where it was opened, holding `value`, the caret at field offset k; Cmd+Z takes it away with
  // the caret back where it was opened. A marker written alone (`held`) makes a block with nothing in its field, which,
  // being what was typed, stays when left so.
  writePending(value, k, cx, held = false, intoStandIn = false) {
    const p = this.pending;
    // Text that makes another block than the stand-in did (`# ` in an item is a heading inside it) can leave the steps
    // nothing to apply to: it then goes into the block the stand-in wrote, where the empty block is drawn. A marker the
    // slash menu picked always goes there.
    const w = (intoStandIn ? null : chain(this.doc, p.base(this.doc, value), p.steps))
      ?? chain(this.doc, p.base(this.doc, PLACEHOLDER), [...p.steps, (doc, b) => type(fieldOf(doc, b), value)]);
    if (!w) return false;
    const s = w.splice, caretDoc = fieldToDoc(fieldOf(w.doc, w.block), k), from = this.originDoc(p) ?? s.start;
    this.forget(p.key);
    this.pending = null; this.opened = value;
    this.edited(applySplice(this.text, s), cx, { ...this.typing(this.act, from, caretDoc), splice: s, join: caretDoc });
    this.refresh(cx, { at: caretDoc, kind: null, caretDoc });
    if (held) this.opened = this.seen;
    this.revealCaret(cx);
    return true;
  }

  writeHeld(cx) {
    if (!this.pending || !this.seen.trim() || !this.editable()) return false;
    return this.writePending(this.seen, caretOf(this.field)?.end ?? this.seen.length, cx, true);
  }

  originDoc(p) {
    const o = p?.origin, b = o && this.blockByKey(o.key);
    return b ? fieldToDoc(fieldOf(this.doc, b), o.caret.end) : null;
  }

  pendingKey(key, cx) {
    const p = this.pending, item = p.block.kind === "item";
    if (key === "tab") return this.restep(item ? "indent" : "nest", cx);
    if (key === "shift-tab") return this.restep(item ? "outdent" : "unnest", cx);
    if (this.seen.trim()) {
      if (key === "enter" && this.writeHeld(cx) && this.activeKey) {
        this.openPendingWith({ base: afterKey(this.activeKey, "paragraph"), origin: { key: this.activeKey, caret: { start: 0, end: 0 } } }, cx);
      }
      return;
    }
    if (item) return this.restep(p.block.depth > 0 ? "outdent" : "paragraph", cx);
    if (key === "backspace") this.cross(-1, cx);
  }

  restep(step, cx) {
    const p = this.pending, steps = UNDOES[step] && p.steps.at(-1) === UNDOES[step] ? p.steps.slice(0, -1) : [...p.steps, step];
    const next = { ...p, steps };
    if (!this.simulate(next)) return;
    const anchor = this.anchor();
    this.pending = next;
    this.rebuild(cx, anchor);
    this.updateRows(cx);
    cx.notify();
  }

  // What was typed in the active field goes into the text as one splice of its block's source; nothing is parsed. A
  // space that completes a markdown shortcut makes the block what its source says. `event`: the field told us, not an
  // action finding its value moved on. `own`: our own replace(), whose event is owed already; any other change is the
  // user's, whose event is this one or one still to come. The user's typing in a text block keeps the formatting it
  // did not delete (mend.js): a repair goes into the field with its tokens, and is one change of the text with the key.
  fieldChanged(state, cx, { event = true, own = false } = {}) {
    if (state !== this.field || !this.activeKey || !this.editable()) {
      // Nobody types in a field that is not open: its changes are owed ones, from our replace() just before it was left.
      if (event && !this.paid(state)) this.takeEcho(state);
      return;
    }
    const value = state.value(), before = this.seen;
    if (value !== before && !own) this.owe(state);
    const owed = event && (this.paid(state) || (value === before && this.takeEcho(state)));
    if (value === before) {
      if (event && !owed) this.deleteAtEnd(cx);
      return;
    }
    this.closeBar(cx);
    const edit = editOf(before, value, this.known, caretOf(state)?.end), style = own ? null : this.styleFor(edit);
    this.typingStyle = null;
    if (this.pending) return this.pendingTyped(before, value, edit, own, style, cx);
    // The field showed what its source does not have yet (withInnerLine): that goes in first.
    const innerLine = this.f.value !== before ? type(this.f, before) : null;
    const from = !innerLine && madeAt(this.known, edit) ? docRange(this.f, this.known) : null;
    const stroke = !own && from && from.start === from.end ? strokeAt(edit, this.known.start) : null;
    const keyed = own ? null : this.imageKeyed(before, edit);
    const mended = keyed ?? (this.mends(own, edit, style) ? mend(before, edit, { defs: this.defsNow().map, style }) : null);
    if (keyed) this.element = null;
    let change = edit;
    if (mended && mended.value !== value) {
      this.seen = mended.value;
      if (this.refill(mended.caret)) change = mended.edit;
      else this.seen = value;
    } else this.seen = value;
    const s = type(this.f, this.seen, change);
    if (!s) return this.retoken();
    if (change === edit) this.known = { start: s.fieldCaret, end: s.fieldCaret, valid: true };
    this.keepElement();
    this.slashChanged({ a: change.at, r: change.removed, ins: change.inserted }, this.seen, own, cx);
    const caretAfter = change === edit ? s.caret : fieldToDoc(this.f, this.known.end);
    const rec = this.typing(this.act, from ? from.end : s.end, caretAfter);
    if (change !== edit) rec.join = fieldToDoc(this.f, mended.caret);
    if (stroke) rec.stroke = stroke;
    if (innerLine) this.edited(applySplice(applySplice(this.text, innerLine), s), cx, rec);
    else this.edited(applySplice(this.text, s), cx, { ...rec, splice: s });
    this.lengthenFences(change, cx);
    if (!own && from && from.start < from.end) this.history.select(this.text, from);
    if (change === edit && !edit.removed && edit.inserted === " " && this.shortcutAt(s.fieldCaret - 1, cx)) return this.retoken();
    this.retoken();
    this.updateRows(cx);
    this.revealCaret(cx);
    if (!own && this.known.start === this.known.end) this.keepStyleAt(this.known.end, mended?.style ?? null);
  }

  // A line typed into a fenced block that would close its fence makes both fences longer at once, in the history entry
  // of the typing that wrote it: the block keeps every line its field shows, and no save writes it ending early.
  lengthenFences(change, cx) {
    const g = lengthenFence(this.f, change.at, change.at + change.inserted.length);
    if (!g) return;
    this.history.amend(this.text, { ...g, caret: fieldToDoc(this.f, this.known.end) });
    this.edited(applySplice(this.text, g), cx, false);
  }

  // A key the person made over all of the picture picked in the edited field: Backspace or Delete takes it as the
  // float's Delete does, and typed text takes its place with the formatting the picture had. -> mend's answer for that,
  // its `edit` the change from `before`, or null for any other change.
  imageKeyed(before, edit) {
    const picked = this.wholeImage({ start: edit.at, end: edit.at + edit.removed });
    if (!picked) return null;
    const left = this.imageRemoved(before, picked.span, !edit.inserted);
    const next = edit.inserted ? mend(left.value, { at: left.caret, removed: 0, inserted: edit.inserted }, { defs: this.defsNow().map, style: left.style }) : left;
    return { ...next, edit: diff(before, next.value) };
  }

  // The picture picked in the edited field, drawn formatted, when field range `r` is all of it: elementNow's answer, or
  // null.
  wholeImage(r) {
    const picked = this.element?.kind === "image" && this.formatted() ? this.elementNow() : null;
    return picked?.kind === "image" && picked.extent.start === r.start && picked.extent.end === r.end ? picked : null;
  }

  // Field value `value` without the picture `span`, as pictureCut takes it (with a space beside it when `space`), what
  // is left keeping its formatting: mend's answer.
  imageRemoved(value, span, space) {
    const defs = this.defsNow().map, cut = pictureCut(value, span, { defs, space });
    return mend(value, { at: cut.start, removed: cut.end - cut.start, inserted: "" }, { defs });
  }

  shortcutAt(k, cx) {
    const sc = shortcut(this.f, k);
    if (!sc) return false;
    this.history.isolateLast();
    if (sc.splice) {
      this.history.amend(this.text, sc.splice);
      this.edited(applySplice(this.text, sc.splice), cx, false);
      this.commit(cx, sc.splice.start + sc.splice.insert.length);
    } else this.commit(cx, fieldToDoc(this.f, k + 1));
    this.updateRows(cx);
    this.revealCaret(cx);
    return true;
  }

  syncField(cx, own = false) {
    if (this.activeKey && this.mode === "reading" && this.field.value() !== this.seen) this.fieldChanged(this.field, cx, { event: false, own });
  }

  fieldFocus(state, on, cx) {
    if (on) this.focusedState = state;
    else if (this.focusedState === state) this.focusedState = null;
    if (!on && state === this.field) this.closeBar(cx);
    if (!on && state === this.field && !this.boxOpen()) this.closeElement(cx);
    const key = on && state !== this.field ? this.fieldKeys.get(state) : undefined;
    if (key !== undefined && key !== this.shiftField && key !== this.cmdPress?.key) this.takeField(key, cx);
  }

  // "one" while the active field has no line break, measures under 1.5 rows and its text is estimated to fit, so the
  // flag drops before a wrap is measured.
  rowsFlag() {
    const d = this.data.get(this.activeKey);
    if (!d) return this.seen.includes("\n") ? "many" : "one";
    const cal = this.calOf(d.style), rows = this.rowsOf(d, true) ?? 1;
    return isOneRow({ value: this.drawnNow(), height: rows * d.row, rowPx: d.row, width: this.chromeOf(d, true).w, advance: cal.advance }) ? "one" : "many";
  }

  updateRows(cx) {
    const r = this.rowsFlag();
    if (r === this.rows) return;
    this.rows = r;
    this.redraw([this.activeKey], cx);
  }

  // The y in the column (block tops are 0-based there) of the row holding the active field's offset `at`, or null for a
  // block not drawn yet.
  caretTop(i, at = caretOf(this.field)?.end ?? 0) {
    const d = this.data.get(this.blocks[i]?.key);
    if (!d) return null;
    return this.sums[i] + this.chromeOf(d, true).y + this.wrapAt(at).row * d.row;
  }

  // Where the edited field draws offset `at`: { row, x }, x from the field's left. `end` takes an offset where a row
  // starts as the end of the row before.
  wrapAt(at, end = false) {
    const d = this.data.get(this.activeKey);
    return this.estimateIn(d, this.drawnNow(), this.drawnAt(at), this.chromeOf(d, true).w, true, end);
  }

  // Where a field of block data `d`, `width` px wide, draws offset `at` of `drawn`: wrapped at the calibrated advance,
  // and not at all while the field measures no more rows than it has lines. The measured rows cap it, unless lines were
  // typed since they were measured.
  estimateIn(d, drawn, at, width, asField, end = false) {
    const advance = this.calOf(d.style).advance, wrap = this.wrapOf(drawn, width, advance), rows = this.rowsOf(d, asField);
    const unwrapped = rows !== undefined && rows <= wrap.lines.length, place = wrapPlace(unwrapped ? wrap.lines : wrap.rows, at, advance, end);
    return { row: rows ? Math.min(place.row, Math.max(rows, wrap.lines.length) - 1) : place.row, x: Math.min(place.x, width) };
  }

  wrapOf(text, width, advance) {
    const kept = this.wraps.get(text);
    if (kept && kept.width === width && kept.advance === advance) return kept;
    if (this.wraps.size >= WRAPS_KEPT) this.wraps.clear();
    const wrap = { width, advance, rows: wrapRows(text, width, advance), lines: lineOffsets(text) };
    this.wraps.set(text, wrap);
    return wrap;
  }

  fieldInPane(i) {
    const d = this.data.get(this.blocks[i]?.key), c = this.chromeOf(d, true);
    return { x: columnLeft(this.paneW(), this.margin) + c.x, y: COLUMN.padTop + this.sums[i] + c.y - this.offset };
  }

  paneToField(key, p) {
    const i = this.at.get(key);
    if (!p || i === undefined || !this.data.get(key) || this.sums.length !== this.blocks.length + 1) return null;
    const o = this.fieldInPane(i);
    return { x: p.x - o.x, y: p.y - o.y };
  }

  // `first` and `last` are rows of the field, `x` from its left.
  setPin(k, first, last, x) {
    const d = this.data.get(this.activeKey);
    this.pin = { key: this.activeKey, act: this.act, value: this.seen, width: this.chromeOf(d, true).w, cal: this.cal, start: k.start, end: k.end, first, last, x };
  }

  pinFor(k, width) {
    const p = this.pin;
    const holds = p && p.key === this.activeKey && p.act === this.act && p.value === this.seen && p.width === width && p.cal === this.cal;
    return holds && p.start === k.start && p.end === k.end ? p : null;
  }

  // The float of an element picked on a token: over the token's row, at the element's start there (the token's left less
  // the estimated width of the element's text before it). The token's bounds are window pixels; the press that led to
  // the click says where the field is in the window.
  pinToken(r, span, range, box, press) {
    const key = this.activeKey, d = this.data.get(key);
    if (press?.key !== key || !press.origin || !box || !d) return;
    const z = zoom(), extent = extentOf(r, span), advance = this.calOf(d.style).advance;
    const before = (drawnOffset(r, range.start) - drawnOffset(r, extent.start)) * advance;
    const row = this.rowAtY(d, (box.y - press.origin.y) / z + d.row / 2);
    this.setPin(extent, row, row, Math.max(0, (box.x - press.origin.x) / z - before));
  }

  // A drag's selection starts at the press going forward, at the release going back. A double-click's word starts left
  // of the press by at most the word's width, which bounds the estimate. A click picks no range here (see pinToken).
  pinSelection(c) {
    const p = this.pressed, r = this.released, key = this.activeKey, d = this.data.get(key);
    if (!c || c.start === c.end || !d || p?.key !== key || r?.key !== key || !p.at || !r.at) return;
    const from = { row: this.rowAtY(d, p.at.y), x: p.at.x }, to = { row: this.rowAtY(d, r.at.y), x: r.at.x };
    if (p.clicks === 2) {
      const width = (this.drawnAt(c.end) - this.drawnAt(c.start)) * this.calOf(d.style).advance;
      return this.setPin(c, from.row, from.row, clamp(this.wrapAt(c.start).x, from.x - width, from.x));
    }
    if (Math.hypot(r.at.x - p.at.x, r.at.y - p.at.y) <= CLICK_SLOP) return;
    const back = to.row < from.row || (to.row === from.row && to.x < from.x), [a, b] = back ? [to, from] : [from, to];
    this.setPin(c, a.row, b.row, clamp(a.x, 0, this.chromeOf(d, true).w));
  }

  rowAtY(d, y) {
    const rows = this.rowsOf(d, true), row = Math.max(0, Math.floor(y / d.row));
    return rows ? Math.min(row, rows - 1) : row;
  }

  revealCaret(cx) {
    const i = this.at.get(this.activeKey), top = i === undefined ? null : this.caretTop(i);
    if (top === null || !this.viewport || this.sums.length !== this.blocks.length + 1) return;
    const d = this.data.get(this.activeKey), y = COLUMN.padTop + top;
    const next = keepInView({ offset: this.offset, viewportH: this.viewH(), y, rowPx: d.row, contentH: this.contentH() });
    if (next === this.offset) return;
    this.offset = next; this.reveal = null;
    this.updateHover(cx);
    if (cx) this.syncWindow(cx);
    cx?.notify();
  }

  // The clicked line stays under the pointer when the field shows front matter's dash line above it.
  clickBlock(key, p, cx) {
    const i = this.at.get(key), b = this.blockByKey(key);
    if (i === undefined || !b) return;
    const { x, y } = this.blockPoint(i, p);
    this.activate(key, this.pressCaret(b, x, y), cx, { shift: b.kind === "frontmatter" ? this.data.get(key).row : 0, reveal: false });
  }

  // View point p as x from the column's left edge and y from the top of block i.
  blockPoint(i, p) {
    return { x: columnX(p.x, this.viewport?.width ?? this.size?.width ?? 0, this.margin), y: p.y + this.offset - COLUMN.padTop - this.sums[i] };
  }

  // The field caret for a press at (x, y) on block b, x from the column's left edge and y from the block's top,
  // estimated from the block as currently drawn: rendered, or a field (the edited block's, or a text block's own); on a
  // table in Reading, grid or source, the pressed cell's start; in a paragraph of pictures, where the picture at y
  // begins. A press only the page heard (beside a text block's field: its marker, the space above it) and Page Up / Down
  // use it.
  pressCaret(b, x, y) {
    const d = this.data.get(b.key), active = b.key === this.activeKey, asField = active || d.mode === "field";
    if (d.grid && !active) return this.gridCaret(b, d, x - d.depth * INDENT, y - d.space);
    const c = this.chromeOf(d, asField), cal = this.calOf(d.style), value = active ? this.seen : this.openedValue(b);
    if (b.kind === "mermaid" && !active) return this.entry(b, value, 1, null);
    if (d.look === "picture" && !active) return this.pictureStartAt(b, d, y);
    const height = (this.heights.get(b.key) ?? this.estimate(b)) - c.y - c.below - (asField ? d.padActive : d.padRendered);
    const fenced = !active && b.kind === "frontmatter", target = { kind: b.kind, value, fenced, rows: this.rowsOf(d, asField), width: c.w, height };
    if (b.kind === "table" && !active) return tablePress(target, x - c.x, y - c.y);
    return pressToField(target, x - c.x, y - c.y, { rowPx: d.row, advance: cal.advance, monoAdvance: cal.advance });
  }

  openedValue(b) {
    return withInnerLine(b, fieldOf(this.doc, b).value);
  }

  // The field caret for a press at (x, y) from the top-left of table b's grid (data d): the start of the pressed cell's
  // text, or of the row's last cell where the row lacks the pressed one.
  gridCaret(b, d, x, y) {
    const { row, column } = gridAt(this.gridHeights(d), d.grid.widths, x, y), cells = tableOf(this.doc, b).rows[row].cells;
    let c = Math.min(column, cells.length - 1);
    while (c > 0 && !cells[c]) c--;
    return docToField(fieldOf(this.doc, b), cells[c].start);
  }

  // Where the caret lands in block b, whose field shows `value`, coming from above (dir > 0) or below: in front matter,
  // never on its dash lines; at `column`, counted in characters as drawn, when the block is one row, else at its start
  // or end, which in a paragraph of pictures is its first or last picture.
  entry(b, value, dir, column) {
    if (b.image) return dir > 0 ? 0 : value.length;
    const lines = value.split("\n");
    if (b.kind === "frontmatter") return dir > 0 ? lines[0].length + 1 : value.length - lines.at(-1).length - 1;
    if (column === null || lines.length !== 1) return dir > 0 ? 0 : value.length;
    const shown = isText(b) ? visibleMap(value) : null, count = shown ? shown.length - 1 : value.length;
    if (!this.fitsOneRow(b, count)) return dir > 0 ? 0 : value.length;
    return shown ? shown[Math.min(column, count)] : Math.min(column, value.length);
  }

  // Whether `count` characters, as drawn, fit one row of block b's field.
  fitsOneRow(b, count) {
    const d = this.data.get(b.key);
    return Boolean(d) && count * this.calOf(d.style).advance < 0.9 * this.chromeOf(d, true).w;
  }

  // The column of field offset c on its line, in characters as drawn.
  columnOf(c) {
    const text = this.drawnNow(), at = this.drawnAt(c);
    return at - (text.lastIndexOf("\n", at - 1) + 1);
  }

  // The index of the block that crossing from block i lands in, rules skipped: below 0 past the first block, the
  // number of blocks past the last.
  crossedTo(i, dir) {
    const blocks = this.blocks;
    let j = i + dir;
    while (j >= 0 && j < blocks.length && blocks[j].kind === "hr") j += dir;
    return j;
  }

  // The caret leaves the edited block for the previous (dir < 0) or next block, rules skipped. Past the end of a raw
  // block that is the last one, an empty paragraph opens below it.
  cross(dir, cx, column = null) {
    this.syncField(cx);
    const blocks = this.blocks, i = this.at.get(this.activeKey);
    if (i === undefined) return;
    const j = this.crossedTo(i, dir);
    if (j < 0) return;
    if (j >= blocks.length) {
      if (dir > 0 && i === blocks.length - 1 && isRaw(blocks[i].kind)) this.openPending(cx);
      return;
    }
    const target = blocks[j];
    this.activate(target.key, this.entry(target, this.openedValue(target), dir, column), cx);
  }

  // Up or Down in a one-row field, which the table takes from it: the caret crosses at once, so a held key glides.
  crossRow(dir, cx) {
    const c = caretOf(this.field);
    this.cross(dir, cx, c ? this.columnOf(c.start) : null);
    this.ownKeyUp = dir < 0 ? "up" : "down";
  }

  // A key-up in the active field, handed over by its wrapper: the caret is read after a key that moved it, and a plain
  // Up or Down that left it where it was crossed the block's edge. The key-up of a key whose press crossed into this
  // block is no edge signal, but a held key's repeats may have moved the caret here since: it is read too. Other keys,
  // Shift ones included (a capital, `/` on some layouts), move the caret only as typing does, which its change tracks.
  keyUp(e, cx) {
    if (!this.activeKey || !this.editable()) return;
    const k = e?.key, m = e?.modifiers ?? {}, crossed = this.ownKeyUp === k, menuTook = this.menuKeyUp === k;
    const selects = e?.keystroke === "cmd-a" || (m.shift && MOVES.has(k));
    this.ownKeyUp = null; this.menuKeyUp = null;
    if (selects) {
      this.element = null;
      this.syncField(cx);
      this.caretNow();
      this.retoken();
      this.closeSlash(cx);
      this.openBar(cx);
      return;
    }
    if (!MOVES.has(k)) return;
    const plainVertical = (k === "up" || k === "down") && !m.alt && !m.platform && !m.control;
    // A plain Up or Down the menu took moved its highlight, not the caret. One it did not take (Cmd with it, or a press
    // in the frame before the menu's binding applies) moved the caret, and reading it closes the menu.
    if (menuTook && plainVertical) return;
    this.syncField(cx);
    const before = this.known, c = this.caretNow();
    this.retoken();
    this.slashCaret(c, cx);
    this.openBar(cx);
    if (!c) return;
    const still = before.valid && before.start === before.end && c.start === c.end && c.start === before.start;
    if (!crossed && plainVertical && this.rows === "many" && still) return this.cross(k === "up" ? -1 : 1, cx, this.columnOf(c.start));
    this.revealCaret(cx);
  }

  // Reads the caret once the field has put it where the press went. It is under the pointer, so the page stays put.
  // Herdr 0.1.16 draws nothing for a notify() from a timer the size task started, so the reading goes back to it.
  readLater(cx) {
    const act = this.act;
    cx.timer.after(READ_AFTER_UP_MS, () => this.post(cx => {
      if (this.closed || this.act !== act || !this.activeKey || !this.editable()) return;
      this.syncField(cx);
      const c = this.caretNow();
      this.pinSelection(c);
      this.retoken();
      this.slashCaret(c, cx);
      this.openBar(cx);
    }));
  }

  // The field's wrapper lives in the block's view, whose cx cannot redraw this one: what needs a cx goes to the size
  // task. The press is marked so the viewport, if it hears it too, leaves it to the field. With Shift the press selects
  // blocks and the field's focus is not taken; with Cmd it may open a link (openLinkIn). A press in the edited field
  // leaves its caret unknown until it is read after the mouse-up, so that a key-up meanwhile crosses no edge. The
  // element picked is let go: only a click on a token picks one (pressToken), so a drag shows the bar. So is a picked
  // picture.
  fieldDown(key, e) {
    this.fieldPress = { kind: "down", x: e?.position?.x, y: e?.position?.y };
    this.press = null; this.fieldHeld = key; this.dragFrom = windowPoint(e);
    this.pressed = { key, x: e?.position?.x ?? null, origin: elementOrigin(e), at: this.point(e), clicks: e?.click_count ?? 1 };
    this.released = null;
    this.cmdPress = e?.modifiers?.platform ? { key, opened: false } : null;
    const picked = key === this.activeKey ? this.elementNow() : null;
    this.pressedOn = picked && { key, value: this.seen, kind: picked.kind, start: picked.span.start };
    this.element = null;
    if (this.picked) this.post(cx => this.unpick(cx));
    if (this.sel && !e?.modifiers?.shift) this.post(cx => this.setSel(null, cx));
    if (key === this.activeKey) {
      this.known = { ...this.known, valid: false }; this.ownKeyUp = null;
      if (this.slash) this.post(cx => this.closeSlash(cx));
      if (this.bar) this.post(cx => this.closeBar(cx));
    }
    else if (e?.modifiers?.shift) {
      this.fieldHeld = null; this.shiftField = key;
      this.post(cx => {
        this.shiftField = null;
        this.shiftTo(this.blockByKey(key), cx);
      });
    }
  }

  fieldUp(key, e) {
    this.fieldPress = { kind: "up", x: e?.position?.x, y: e?.position?.y };
    this.released = { key, at: this.point(e) };
    const began = this.fieldHeld === key;
    this.fieldHeld = null;
    this.post(cx => {
      if (began) this.fieldReleased(key, cx);
      else if (key === this.activeKey) this.readLater(cx);
    });
  }

  // Herdr's field has already kept the selection under a right-click, or moved the caret there: on a picture, which its
  // token holds whole, the caret is at its edge or in its alt text, and the picture is picked with its float; else the
  // bar shows over the selection, or over the word at the caret.
  fieldRightUp(key) {
    this.post(cx => {
      if (key !== this.activeKey) this.takeField(key, cx);
      if (key !== this.activeKey || !this.editable()) return;
      this.syncField(cx);
      this.element = null;
      const c = this.caretNow(), picture = c && this.formatted() ? this.elementHolding("image", c) : null;
      if (picture) return this.pickElement(picture.span, cx);
      const word = c && c.start === c.end ? wordAround(this.seen, c.start) : null;
      if (word) this.selectField(word);
      this.retoken();
      this.openBar(cx);
    });
  }

  fieldKeyUp(_key, e) {
    this.post(cx => this.keyUp(e, cx));
  }

  // The press that began in block `key`'s field is over. Its field has the keyboard: a block not being edited becomes
  // the edited one, unless the drag went on to select blocks or a Cmd+press opened a link; then the field gives the
  // keyboard back. The caret the press placed is read.
  fieldReleased(key, cx) {
    const cmd = this.cmdPress;
    this.cmdPress = null;
    if (cmd?.key === key && cmd.opened) return this.giveBackKeyboard();
    if (key !== this.activeKey && !this.sel) this.takeField(key, cx);
    if (key === this.activeKey) this.readLater(cx);
  }

  giveBackKeyboard() {
    if (this.activeKey) this.keepKeyboard();
    else this.handle.focus();
  }

  // A press in the field of block `key` gave it the keyboard: that field becomes the edited one with no set_value, its
  // value already there and its caret where the press put it (read out after the mouse-up). Its focus event or the
  // mouse-up, whichever comes first, does this.
  takeField(key, cx) {
    if (key === this.activeKey || !this.blockFields.has(key) || !this.editable()) return;
    this.unpick(cx);
    this.leave(cx, key);
    const b = this.blockByKey(key), state = this.blockField(key);
    if (!b || !state) return;
    const anchor = this.anchor(), f = fieldOf(this.doc, b);
    this.field = state; this.tokensOff = false;
    this.f = f; this.opened = f.value; this.known = NO_CARET;
    if (state.value() === f.value) this.seen = f.value;
    else if (!this.setField(f.value, { start: 0, end: 0 })) { this.drop(); this.rebuild(cx, anchor); return; }
    this.activeKey = key; this.act++;
    this.retoken();
    this.rows = this.rowsFlag();
    this.rebuild(cx, anchor);
    if (this.focusedState !== this.field) this.field.focus();
    cx.notify();
  }

  // The caret is kept (`stored`) for Enter to come back to.
  escape(cx) {
    this.writeHeld(cx);
    this.commit(cx);
    this.stored = null;
    if (this.activeKey && !this.pending) {
      const c = this.caretNow();
      this.stored = { key: this.activeKey, caret: c ? { start: c.start, end: c.end } : { start: 0, end: 0 } };
    }
    this.deactivate(cx);
  }

  resume(cx) {
    const s = this.stored, i = s ? this.at.get(s.key) : undefined;
    if (i !== undefined && this.onPage(i)) { this.activate(s.key, s.caret, cx); return; }
    const b = this.topBlock();
    if (b) this.activate(b.key, this.entry(b, this.openedValue(b), 1, null), cx);
    else this.openPending(cx);
  }

  // The typing style stays only while the caret is where it was set.
  caretNow() {
    const c = caretOf(this.field);
    this.known = c ? { ...c, valid: true } : NO_CARET;
    this.keepElement();
    if (!c || c.start !== c.end || !this.styleFor({ at: c.start, removed: 0 })) this.typingStyle = null;
    return c;
  }

  caretDoc() {
    const c = this.f && !this.pending ? caretOf(this.field) : null;
    return c ? fieldToDoc(this.f, c.end) : null;
  }

  // A structural op is an entry of its own in the history, parsed in at once. Then the block at document offset `at`
  // (the op's caret) is opened with field caret `caret` (null: where `at` falls in it), or `then` runs instead.
  op(s, cx, { at = s?.caret, caret = null, then = null } = {}) {
    if (!s) return false;
    const before = this.caretDoc();
    this.release();
    this.change(s, cx, { caretBefore: before ?? s.start, caretAfter: at });
    if (then) then();
    else this.openAt(at, cx, caret);
    return true;
  }

  // Enter in the edited block; one that shows its source goes to enterRaw. In a text block a selection that reaches an
  // end of the field is deleted first, as a key deletes it.
  enter(cx) {
    this.typingStyle = null;
    if (this.pending) return this.pendingKey("enter", cx);
    const b = this.blockByKey(this.activeKey), value = this.seen;
    if (!b) return;
    if (!isText(b)) return this.enterRaw(b, cx);
    if (!value) return this.enterEmpty(b, cx);
    if (b.kind === "paragraph" && (FENCE_TYPED.test(value) || RULE_TYPED.test(value))) return this.enterTyped(cx);
    const r = this.caretNow();
    if (!r) return;
    if (r.start !== r.end && (r.start === 0 || r.end === value.length)) {
      if (this.deleteSelection(r, cx)) this.enter(cx);
      return;
    }
    const caretAt = this.caretDoc();
    this.commit(cx);
    const now = this.blockByKey(this.activeKey);
    if (!now) {
      if (r.start === value.length) this.paragraphAfterPictures(caretAt, cx);
      return;
    }
    const kind = now.kind === "item" ? "item" : "paragraph", origin = { key: now.key, caret: { start: r.start, end: r.end } };
    if (now.kind === "quote") {
      if (r.end === value.length && value.endsWith("\n")) return this.leaveQuote(now, cx);
    } else if (r.end === 0) return this.openPendingWith({ base: beforeKey(now.key, kind), origin }, cx);
    else if (r.start === value.length) return this.openPendingWith({ base: afterKey(now.key, kind), origin }, cx);
    const selected = r.start < r.end ? docRange(fieldOf(this.doc, now), r) : null;
    if (this.op(this.splitAt(now, r), cx) && selected) this.history.select(this.text, selected);
  }

  // Enter in a block that shows its source: in code a line break whose new line starts with the spaces and tabs of the
  // caret's line up to the caret, unless the caret is at the end of two blank last lines (leaveCode); elsewhere a plain
  // line break.
  enterRaw(b, cx) {
    const r = this.caretNow();
    if (!r) return;
    if (!isCode(b)) return this.typeText("\n", cx);
    const value = this.seen;
    if (r.start === r.end && r.end === value.length && endsInTwoBlankLines(value)) return this.leaveCode(b, cx);
    const lineStart = r.start > 0 ? value.lastIndexOf("\n", r.start - 1) + 1 : 0;
    this.typeText(`\n${leadingBlank(value.slice(lineStart, r.start))}`, cx);
  }

  // The third Enter after the last line of code: the two blank lines it left go, as one entry of the history whose undo
  // puts the caret back after them, and an empty paragraph opens below the block.
  leaveCode(b, cx) {
    const value = this.seen, last = value.lastIndexOf("\n");
    const cut = last > 0 ? Math.max(0, value.lastIndexOf("\n", last - 1)) : 0;
    if (!this.selectField({ start: cut, end: value.length }) || !this.typeText("", cx)) return;
    this.openPendingWith({ base: afterKey(b.key, "paragraph") }, cx);
  }

  // Whether the edited field draws its block formatted, its marks hidden: there the editor's own edits keep the
  // formatting of what they leave (mend.js, seams.js). A field that shows its source is edited as it shows.
  formatted() {
    return this.mode === "reading" && this.takesMarks() && !this.tokensOff && this.richNow() !== null;
  }

  // The field range `r` deleted as a key deletes a selection: in a field drawn formatted what is left keeps its
  // formatting. One entry of the history, whose undo selects it again. -> false when the field stopped showing what was
  // typed.
  deleteSelection(r, cx) {
    const left = this.formatted() ? mend(this.seen, { at: r.start, removed: r.end - r.start, inserted: "" }, { defs: this.defsNow().map })
      : { value: this.seen.slice(0, r.start) + this.seen.slice(r.end), caret: r.start };
    return this.typeChange(this.seen, r, { value: left.value, start: left.caret, end: left.caret }, cx);
  }

  // The splice Enter makes at field range `r` of text block b, formatting kept on both sides (splitWith).
  splitAt(b, r) {
    const plain = () => split(this.doc, b, r.start, r.end);
    return this.formatted() ? this.splitWith(b, r, (d, nb, at) => split(d, nb, at.start, at.end)) ?? plain() : plain();
  }

  // Text block b split at field range `r` by `step(doc, block, { start, end })` as one splice: a selection deleted first
  // as a key deletes it, the spaces beside the caret dropped, and the runs open there closed at the end of the first half
  // and opened again at the start of the second (seams.js). Null when the step does not apply.
  splitWith(b, r, step) {
    const f = fieldOf(this.doc, b), defs = this.defsNow().map;
    let value = f.value, at = r;
    if (r.start < r.end) {
      const left = mend(value, { at: r.start, removed: r.end - r.start, inserted: "" }, { defs });
      value = left.value;
      at = { start: left.caret, end: left.caret };
    }
    const { start, end } = spacedOut(value, at.start, at.end), next = splitRuns(value, start, end, { defs }) ?? { value, start, end };
    if (next.value === f.value) return step(this.doc, b, next);
    return chain(this.doc, type(f, next.value), [(d, nb) => step(d, nb, next)])?.splice ?? null;
  }

  // An empty item moves out a level, or out of its list at the top as an empty paragraph. A heading the file already
  // has with no text gets a paragraph below it; any other empty block is replaced by one.
  enterEmpty(b, cx) {
    if (b.kind === "item") {
      this.commit(cx);
      const now = this.blockByKey(this.activeKey);
      if (!now) return;
      if (now.depth > 0) return this.op(outdent(this.doc, now), cx, { caret: 0 });
      return this.emptyInPlace(now, cx);
    }
    if (b.kind === "heading" && this.opened === "") {
      return this.openPendingWith({ base: afterKey(b.key, "paragraph"), origin: { key: b.key, caret: { start: 0, end: 0 } } }, cx);
    }
    this.paragraphInPlace(b, cx);
  }

  paragraphInPlace(b, cx) {
    const pos = b.start, depth = b.depth;
    this.leave(cx);
    const left = this.blockByKey(b.key), s = left && removeWithNotes(this.doc, left);
    if (s) this.change(s, cx);
    this.openPendingWith({ base: this.baseAt(pos, depth) }, cx);
  }

  // With its marker gone a heading, quote or item with no text is a blank line, not a block: the empty paragraph it
  // becomes is one not written yet.
  emptyInPlace(b, cx) {
    const s = b.subtreeEnd > b.end ? toParagraph(this.doc, b) : remove(this.doc, b);
    return this.op(s, cx, { then: () => this.openPendingWith({ base: this.baseAt(s.caret, b.depth) }, cx) });
  }

  baseAt(pos, depth) {
    const bl = this.doc.blocks, j = bl.findIndex(b => b.start >= pos), next = j < 0 ? null : bl[j];
    let prev = bl[(j < 0 ? bl.length : j) - 1] ?? null;
    while (prev && prev.depth > depth) prev = bl[prev.parent] ?? null;
    if (prev && prev.depth === depth) return afterKey(prev.key, "paragraph");
    if (next && next.depth === depth) return beforeKey(next.key, "paragraph");
    return prev ? afterKey(prev.key, "paragraph") : next ? beforeKey(next.key, "paragraph") : atEnd;
  }

  // The commit makes a paragraph holding only a fence (```js) or a rule (---) what its source says, closing a fence
  // that would take in what follows in the typing's own entry; one that ends the file is closed here, in the same entry.
  enterTyped(cx) {
    this.commit(cx);
    let b = this.blockByKey(this.activeKey);
    if (b?.kind === "hr") return this.openPendingWith({ base: afterKey(b.key, "paragraph") }, cx);
    if (!b?.fence) return;
    if (!b.closed) {
      const s = closeFence(this.doc, b);
      this.history.amend(this.text, s);
      this.setText(applySplice(this.text, s), cx, false);
      b = this.blockByKey(this.activeKey);
      if (!b?.fence) return;
    }
    this.activate(b.key, this.entry(b, this.openedValue(b), 1, null), cx);
  }

  leaveQuote(b, cx) {
    const f = fieldOf(this.doc, b), s = type(f, f.value.replace(/\n+$/, ""));
    this.op(s, cx, {
      then: () => {
        const q = this.holding(s.caret);
        if (q) this.openPendingWith({ base: afterKey(q.key, "paragraph") }, cx);
      },
    });
  }

  // Shift+Enter: a line break that stays one (a backslash before it). A heading has none: there it is Enter.
  shiftEnter(cx) {
    if (this.pending) return;
    if (this.blockByKey(this.activeKey)?.kind === "heading") return this.enter(cx);
    if (!this.breakCode(cx)) this.typeOwn("\\\n", cx);
  }

  // Shift+Enter in inline code: code can't hold a line break, so the runs open at the caret close before the break and
  // open again after it. One entry of the history. -> false when the caret is not in code.
  breakCode(cx) {
    const r = this.caretNow(), defs = this.defsNow().map;
    if (!r || r.start !== r.end || !this.formatted() || !(formatAt(this.seen, r.start, { defs }).bits & MARK_BITS.code)) return false;
    const { start, end } = spacedOut(this.seen, r.start, r.end), halves = splitRuns(this.seen, start, end, { defs });
    if (!halves) return false;
    const value = `${halves.value.slice(0, halves.start)}${HARD_BREAK}${halves.value.slice(halves.end)}`, at = halves.start + HARD_BREAK.length;
    return this.typeChange(this.seen, r, { value, start: at, end: at }, cx);
  }

  cmdEnter(cx) {
    const b = this.pending ? null : this.blockByKey(this.activeKey);
    if (!b) return;
    if (b.kind === "item" && b.task) return this.tick(b, cx);
    if (!isRaw(b.kind)) return;
    const r = this.caretNow() ?? { start: 0, end: 0 };
    this.openPendingWith({ base: afterKey(b.key, "paragraph"), origin: { key: b.key, caret: { start: r.start, end: r.end } } }, cx);
  }

  // The field gives Backspace away only at its start. A paragraph joins nothing into a paragraph of pictures above it:
  // its last picture is picked.
  backspaceStart(cx) {
    if (this.pending) return this.pendingKey("backspace", cx);
    const key = this.activeKey, b = this.blockByKey(key), i = this.at.get(key);
    if (!b || i === undefined) return;
    const prev = this.blocks[i - 1] ?? null;
    if (!isText(b)) return this.removeEmptyRaw(b, i, cx);
    if (b.kind === "paragraph" && !this.seen) {
      if (prev) this.cross(-1, cx);
      return;
    }
    this.commit(cx);
    const now = this.blockByKey(this.activeKey);
    if (!now) return;
    if (now.kind === "item" && now.depth > 0) return this.op(outdent(this.doc, now), cx, { caret: 0 });
    if (now.kind !== "paragraph" && !this.seen && !fieldOf(this.doc, now).childOnMarker) return this.emptyInPlace(now, cx);
    if (now.kind !== "paragraph") return this.op(toParagraph(this.doc, now), cx, { caret: 0 });
    const p = prev && byKey(this.doc, prev.key);
    if (!p) return;
    if (p.image) return this.cross(-1, cx);
    if (p.kind === "hr") {
      const s = remove(this.doc, p);
      return this.op(s, cx, { at: s && s.start + s.insert.length, caret: 0 });
    }
    if (isRaw(p.kind)) return this.cross(-1, cx);
    this.op(this.joined(mergeIntoPrevious(this.doc, p, now)), cx);
  }

  // A join's splice `s` with the joined block's text written so that each block's characters show as they did, runs of
  // the same formatting that meet made one (seams.js), and its caret at the join, as one splice.
  joined(s) {
    if (!s) return s;
    const defs = this.defsNow().map;
    const runs = (d, b, at) => {
      const f = fieldOf(d, b), r = joinRuns(f.value, docToField(f, at), { defs }), t = r && type(f, r.value);
      return t ? { ...t, caret: fieldToDoc(f, r.at) } : { start: at, end: at, insert: "", caret: at };
    };
    return chain(this.doc, s, [runs])?.splice ?? s;
  }

  // Backspace at the start of an empty raw block removes it, with its comments. A block whose source typing emptied goes
  // as the caret leaves it: a commit would take it away with the block being edited. An emptied fenced block still has
  // its fences.
  removeEmptyRaw(b, i, cx) {
    const lines = this.seen.split("\n"), inner = b.kind === "frontmatter" ? lines.slice(1, -1) : lines;
    if (inner.some(l => l.trim())) return;
    const j = this.crossedTo(i, -1);
    if (j < 0) return this.paragraphInPlace(b, cx);
    if (!this.seen && !b.fence) return this.cross(-1, cx);
    this.commit(cx);
    const now = this.blockByKey(this.activeKey), back = this.blocks[j].key;
    this.op(now && removeWithNotes(this.doc, now), cx, {
      then: () => {
        const p = this.blockByKey(back);
        if (p) this.activate(p.key, this.entry(p, this.openedValue(p), -1, null), cx);
        else this.handle.focus();
      },
    });
  }

  // Forward Delete at the end of a block, which the field reports as a change that left its value alone: when the
  // caret is there, the next text block joins this one or the rule after it goes; a paragraph of pictures after it
  // joins nothing, its first picture is picked.
  deleteAtEnd(cx) {
    if (this.pending || !this.activeKey) return;
    const c = this.caretNow(), end = this.seen.length;
    if (!c || c.start !== c.end || c.end !== end) return;
    this.commit(cx);
    const b = this.blockByKey(this.activeKey), i = b ? this.at.get(b.key) : undefined, next = i === undefined ? null : this.blocks[i + 1];
    const n = next && byKey(this.doc, next.key);
    if (!n) return;
    if (n.kind === "hr") return this.op(remove(this.doc, n), cx, { at: this.caretDoc(), caret: end });
    if (n.image) return this.cross(1, cx);
    if (isText(b) && isText(n)) this.op(this.joined(mergeNext(this.doc, b, n)), cx);
  }

  tab(dir, cx) {
    if (this.pending) return this.pendingKey(dir > 0 ? "tab" : "shift-tab", cx);
    const b = this.blockByKey(this.activeKey), r = b && this.caretNow();
    if (!b || !r) return;
    if (b.kind === "table") return this.toCell(dir, r, cx);
    if (isCode(b)) return this.indentCode(dir, r, cx);
    this.commit(cx);
    const now = this.blockByKey(this.activeKey);
    if (!now) return;
    const op = now.kind === "item" ? (dir > 0 ? indent : outdent) : dir > 0 ? nest : unnest;
    if (this.op(op(this.doc, now), cx, { caret: { start: r.start, end: r.end } })) return;
    if (isRaw(now.kind) && dir > 0 && r.start === r.end) this.typeText("    ", cx);
  }

  // Tab (dir > 0) and Shift+Tab in code, with the block's own indent unit: at a caret Tab types it there; Tab adds it
  // to every line field range `r` touches that is not empty, the same text staying selected, and Shift+Tab takes up to
  // one off each. One entry of the history, whose undo selects `r` again. Each line is typed on its own: typed as one
  // span, the lines inside it would be written with the block's prefix instead of the one their file lines have.
  indentCode(dir, r, cx) {
    const value = this.seen, unit = indentUnit(value);
    const lineEdit = at => (dir > 0 ? { at, removed: 0, inserted: unit } : { at, removed: outdentWidth(value, at, unit), inserted: "" });
    const lines = linesTouched(value, r).filter(at => !emptyLineAt(value, at));
    const edits = dir > 0 && r.start === r.end ? [{ at: r.start, removed: 0, inserted: unit }] : lines.map(lineEdit);
    const made = edits.filter(e => e.removed || e.inserted);
    if (!made.length) return;
    let next = "", from = 0;
    for (const e of made) {
      next += value.slice(from, e.at) + e.inserted;
      from = e.at + e.removed;
    }
    const range = { start: mappedThrough(made, r.start), end: mappedThrough(made, r.end) };
    this.typeChange(value, r, { value: next + value.slice(from), ...range }, cx, [...made].reverse());
  }

  toCell(dir, r, cx) {
    const cell = nextCell(this.seen, r.start, dir);
    if (!cell || !this.selectField(cell)) return;
    this.revealCaret(cx);
  }

  selectField({ start, end }) {
    if (!this.guard(() => this.field.set_selected_range({ start, end }))) return false;
    this.known = { start, end, valid: true };
    return true;
  }

  // The page and the caret move a page, the caret to the start of the row at its place on screen unless the page
  // could not move that far; past the first or last block it goes to that block's start or end.
  pageCaret(dir, cx) {
    const i = this.at.get(this.activeKey), top = i === undefined ? null : this.caretTop(i), blocks = this.blocks;
    if (top === null || !this.viewport || this.sums.length !== blocks.length + 1) return;
    const page = pageStep(this.viewH()), y = top + dir * page, edge = y < 0 || y >= this.sums[blocks.length];
    const j = this.caretBlockNear(edge ? (dir > 0 ? blocks.length - 1 : 0) : blockAt(this.sums, y), edge ? -dir : dir);
    const b = j < 0 ? null : this.blockByKey(blocks[j].key);
    if (!b) return;
    this.offset = clampOffset(this.offset + dir * page, this.contentH(), this.viewH()); this.reveal = null;
    const value = b.key === this.activeKey ? this.seen : this.openedValue(b);
    this.activate(b.key, edge ? this.entry(b, value, -dir, null) : this.pressCaret(b, 0, y - this.sums[j]), cx);
    this.updateHover(cx);
    cx.notify();
  }

  // A block not written yet is not in the document, so it cannot be opened as the others are.
  caretBlockNear(j, step) {
    const blocks = this.blocks, takes = k => blocks[k].kind !== "hr" && blocks[k] !== this.pending?.block;
    for (const s of [step, -step]) for (let k = j; k >= 0 && k < blocks.length; k += s) if (takes(k)) return k;
    return -1;
  }

  moveBlock(dir, cx) {
    if (this.pending) return;
    const r = this.caretNow();
    this.commit(cx);
    const b = this.blockByKey(this.activeKey), doc = this.doc;
    if (b) this.op(move(doc, b, dir, x => blockUnit(doc, x)), cx, { caret: r ? { start: r.start, end: r.end } : 0 });
  }

  // Cmd+C and Cmd+X in a text block: the selection as markdown that stands alone (seams.js), each character with its
  // formatting; a field that shows its source copies that. Soft line breaks, which the field shows as spaces, are copied
  // as line breaks. Cut then deletes the selection as a key does, one entry whose undo selects it again; a picture
  // picked whole goes as its float's Delete takes it. A caret copies nothing.
  copyText(cut, cx) {
    const r = this.caretNow();
    if (!r || r.start === r.end) return;
    const value = this.f && !this.pending && this.f.value === this.seen ? softBreaksIn(this.f) : this.seen;
    cx.write_to_clipboard(this.formatted() ? copyOf(value, r, { defs: this.defsNow().map }) : value.slice(r.start, r.end));
    if (!cut) return;
    const picture = this.wholeImage(r);
    if (picture) this.deleteImage(picture.span, r, cx);
    else this.deleteSelection(r, cx);
  }

  // The line breaks that end the clipboard's text are left out of a text block, so that the text after the caret stays
  // on the last pasted line; a raw block takes the text exactly. In a field drawn formatted the clipboard is read as
  // markdown on its own and takes the formatting of where it lands (pasteFormatted).
  pasteText(cx) {
    const clip = cx.read_from_clipboard?.();
    if (typeof clip !== "string" || !clip) return;
    const lf = clip.replace(/\r\n/g, "\n"), b = this.pending ? null : this.blockByKey(this.activeKey);
    if (!b && !this.pending) return;
    const text = lf.replace(/\n+$/, "");
    if ((b && !isText(b)) || !text) return this.typeText(lf, cx);
    if (this.pasteFormatted(text, cx)) return;
    const r = text.includes("\n") ? this.caretNow() : null;
    if (!r) return this.typeText(text, cx);
    if (this.pending) {
      const value = this.seen.slice(0, r.start) + text + this.seen.slice(r.end), p = this.pending;
      const w = chain(this.doc, p.base(this.doc, PLACEHOLDER), [...p.steps, (d, b) => paste(d, b, 0, PLACEHOLDER.length, value)]);
      if (!w) return this.typeText(text, cx);
      return this.pasted({ ...w.splice, caret: w.splice.caret - (value.length - r.start - text.length) }, cx);
    }
    // A paragraph left with no text is no block once parsed: the lines take its place as it is.
    if (b.kind === "paragraph" && !this.seen.trim() && this.f?.text === this.text) {
      const s = type(this.f, text, 0, b.depth > 0 ? b.contPrefix : "");
      return s && this.pasted(s, cx);
    }
    this.commit(cx);
    const now = this.blockByKey(this.activeKey), c = caretOf(this.field);
    if (!now) return;
    const s = isText(now) && c ? paste(this.doc, now, c.start, c.end, text) : null;
    if (s) this.pasted(s, cx);
    else this.typeText(text, cx);
  }

  // Clipboard text pasted where the field draws its block formatted (seams.js), read as markdown on its own and given
  // what text typed there gets: one paragraph stays in the block; text that makes more blocks splits it there as Enter
  // does, its first and last paragraphs joining the halves and its other lines between them as it writes them. A picture
  // picked whole gives way to what is pasted, as to typed text. One entry of the history, whose undo selects a selection
  // pasted over again. -> false to paste the text as it is.
  pasteFormatted(text, cx) {
    const r = this.caretNow(), defs = this.defsNow().map, lines = text.split("\n");
    if (!r) return false;
    const style = r.start === r.end ? this.styleFor({ at: r.start, removed: 0 }) : null;
    if (this.pending || !this.seen.trim()) return this.pasteAlone(text, r, style, cx);
    if (!this.formatted()) return false;
    const picture = this.wholeImage(r), seen = this.seen;
    this.commit(cx);
    const b = this.blockByKey(this.activeKey);
    if (!b || !isText(b) || this.mode !== "reading") return false;
    const f = fieldOf(this.doc, b), before = docRange(f, r), into = out => out && pasteLines(this.doc, b, out.value, r.start, out.caret);
    const left = picture && f.value === seen ? this.imageRemoved(f.value, picture.span, false) : null;
    const [value, at, typed] = left ? [left.value, { start: left.caret, end: left.caret }, left.style] : [f.value, r, style];
    const s = lines.length > 1 && opensBlock(lines[0]) ? this.splitWith(b, r, (d, nb, at) => insertLines(d, nb, at.start, at.end, lines))
      : holdsBlocks(text) ? into(pasteParagraphs(value, at, text, { defs, style: typed }))
        : into(pasteInto(value, at, text, { defs, style: typed }));
    if (!s) return false;
    this.pasted(s, cx);
    if (r.start < r.end) this.history.select(this.text, before);
    return true;
  }

  // A paste into a block that holds no text: text on one line, or lines on their own in a block not written yet, read as
  // markdown alone with the typing style. Lines that make blocks, and lines in a written block emptied by typing, which
  // take its place, are pasted as they are. -> false to paste the text as it is.
  pasteAlone(text, r, style, cx) {
    const lines = text.split("\n");
    if (opensBlock(lines[0]) || holdsBlocks(text) || (lines.length > 1 && !this.pending)) return false;
    const out = pasteInto(this.seen, r, text, { defs: this.defsNow().map, style });
    if (!out) return false;
    if (lines.length === 1) return this.selectField({ start: 0, end: this.seen.length }) && this.typeText(out.value, cx);
    const p = this.pending, w = chain(this.doc, p.base(this.doc, PLACEHOLDER), [...p.steps, (d, b) => paste(d, b, 0, PLACEHOLDER.length, out.value)]);
    if (!w) return false;
    this.pasted({ ...w.splice, caret: w.splice.caret - (out.value.length - out.caret) }, cx);
    return true;
  }

  typeText(text, cx) {
    this.history.close();
    const typed = this.typeOwn(text, cx);
    this.history.close();
    return typed;
  }

  typeOwn(text, cx) {
    this.syncField(cx);
    if (!this.guard(() => { this.field.replace(text); this.owe(this.field); })) return false;
    this.syncField(cx, true);
    return true;
  }

  format(mark, cx) {
    if (!this.styleAt(mark)) this.formatWith((value, r) => toggleMark(value, r, mark, { defs: this.doc?.defs }), cx);
  }

  // A format key at a caret outside a word writes nothing: it switches `mark` on or off for the text typed next at that
  // caret, starting from the formatting typed text gets there; what is typed after it is an entry of the history of its
  // own, as after any format key. -> false for a selection or a caret in a word.
  styleAt(mark) {
    const bit = MARK_BITS[mark];
    if ((!bit && mark !== "highlight") || !this.takesMarks()) return false;
    const r = this.caretNow();
    if (!r || r.start !== r.end || actedOn(this.seen, r).start !== undefined) return false;
    const now = this.styleFor({ at: r.start, removed: 0 }) ?? formatAt(this.seen, r.start, { defs: this.defsNow().map });
    const format = bit ? { ...now, bits: now.bits ^ bit } : { ...now, mark: now.mark === null ? "" : null };
    this.keepStyleAt(r.start, format);
    this.history.close();
    return true;
  }

  // The bar's colour menu: every character of the selection (or the word holding the caret) in text colour `name`, one
  // of colors.js TEXT_COLORS, or "default" for none. One entry of the history, as a format key is.
  setColor(name, cx) {
    this.formatWith((value, r) => setColor(value, r, name, { defs: this.doc?.defs }), cx);
  }

  // The bar's menus: `mark` (as a format key names it) on the whole selection, or off it, whatever it has now.
  setMark(mark, on, cx) {
    this.formatWith((value, r) => setMark(value, r, mark, on, { defs: this.doc?.defs }), cx);
  }

  // `edit(value, selection)` -> { value, start, end } or null, typed into the field as one entry of the history, whose
  // undo puts the selection back. An open format bar stays over what is left selected.
  formatWith(edit, cx) {
    if (!this.takesMarks()) return;
    const bar = this.barOpen(), r = this.caretNow(), value = this.seen;
    const next = r && edit(value, r);
    if (next && this.typeChange(value, r, next, cx) && bar) this.openBar(cx);
  }

  // Field value `value` with `range` selected becomes `next` ({ value, start, end }), its range selected, as one entry
  // of the history whose undo puts `range` back. `edits` are the field splices typed for it, the later first.
  // -> false when the field stopped showing what was typed.
  typeChange(value, range, next, cx, edits = marksEdits(value, next.value)) {
    const before = this.f && !this.pending ? docRange(this.f, range) : null, was = this.text;
    const typed = this.typeEdits(value, edits, cx) && this.selectField(next);
    this.retoken();
    if (typed && before && this.text !== was) this.history.select(this.text, before, docRange(this.f, next));
    return typed;
  }

  takesMarks() {
    if (this.pending) return true;
    const b = this.blockByKey(this.activeKey);
    return Boolean(b && isText(b));
  }

  // Types the field splices `edits` of `value`, the later first, as one entry of the history. -> false when the field
  // stops showing what they leave: the first can write a block not written yet, whose parse may change the field.
  // The field would widen a range selected inside a token to the token's edges, so the tokens go first and are set
  // again by the caller once the selection is back.
  typeEdits(value, edits, cx) {
    if (this.field.tokens().length && !this.setTokens([], this.known.valid ? this.known : { start: 0, end: 0 })) return false;
    this.tokensHeld = true;
    try {
      let shown = value, entries = 0;
      for (const e of edits) {
        const text = this.text;
        if (this.field.value() !== shown || !this.selectField({ start: e.at, end: e.at + e.removed }) || !this.typeText(e.inserted, cx)) return false;
        shown = shown.slice(0, e.at) + e.inserted + shown.slice(e.at + e.removed);
        if (this.text !== text) entries++;
      }
      for (; entries > 1; entries--) this.history.joinLast(this.text);
      return this.field.value() === shown;
    } finally {
      this.tokensHeld = false;
    }
  }

  pasted(s, cx) {
    this.release();
    this.change(s, cx, { caretAfter: s.caret });
    this.openAt(s.caret, cx);
  }

  // No commit first: its rules of leaving would record entries that this undo then took back, and Cmd+Z on a block
  // emptied by typing would seem to do nothing. An empty block that a key opened, with nothing typed in yet, is undone
  // by going back to where the key was pressed. An entry that opens nothing (a block's comment written) leaves the page
  // the keyboard.
  undo(dir, cx) {
    if (!this.file || !this.loaded || this.error || this.remote || this.locked) return;
    this.syncSource(cx);
    this.syncField(cx);
    this.typingStyle = null;
    const o = dir < 0 && this.mode === "reading" ? this.pending?.origin : null;
    if (o && this.blockByKey(o.key)) {
      this.release();
      if (!this.activate(o.key, o.caret, cx)) this.handle.focus();
      return;
    }
    if (!(dir < 0 ? this.history.canUndo : this.history.canRedo)) return;
    const u = dir < 0 ? this.history.undo(this.text) : this.history.redo(this.text);
    if (!u) return;
    const text = applySplice(this.text, u);
    if (this.mode === "markdown") {
      this.setText(text, cx, false);
      this.patchSource(u.caret);
      return;
    }
    this.release();
    this.picked = null; this.blockNote = null; this.blockAdd = null;
    this.setText(text, cx, false);
    if (u.opensNothing) this.handle.focus();
    else this.openAt(u.caret, cx, null, u.select);
  }

  // The block holding document offset `at` opens with field caret `caret`, else the document range `select` selected,
  // else the caret where `at` falls.
  openAt(at, cx, caret = null, select = null) {
    if (!this.editable()) return this.handle.focus();
    const b = this.holding(at);
    if (!b) return this.openPending(cx);
    if (!this.activate(b.key, caret ?? fieldRange(fieldOf(this.doc, b), select ?? { start: at, end: at }), cx)) this.handle.focus();
  }

  // The menu belongs to one activation of a writable block and only while its field shows "/" + query where the menu
  // says, so a stale menu draws nothing and takes no key should a close be missed. The check fixture has no file and
  // shows its menu anyway.
  slashOpen() {
    const s = this.slash;
    return Boolean(s) && s.act === this.act && Boolean(this.activeKey) && (!this.file || this.editable()) && this.seen.slice(s.at, s.end) === `/${s.query}`;
  }

  // A change typed in the field: the field range [a, a + r) became `ins`, leaving `value`. An open menu follows it; a
  // slash typed alone in a text block opens one, as an entry of the history of its own, so that a pick's Cmd+Z leaves
  // "/query" and the next one takes it away. Our own changes (a paste) open nothing.
  slashChanged(change, value, own, cx) {
    if (this.slash?.act === this.act) {
      const next = track(this.slash, change, value);
      if (!next) return this.closeSlash(cx);
      this.slash = next;
      cx.notify();
      return;
    }
    this.slash = null;
    if (own || change.r || change.ins !== "/" || !this.slashable() || !opensAt(value, change.a)) return;
    this.history.close();
    this.slash = { act: this.act, at: change.a, end: change.a + 1, query: "", items: COMMANDS, index: 0, first: 0, side: null };
    this.redraw([this.activeKey], cx);
    cx.notify();
  }

  // In code, tables and diagram source a slash is text, and Enter a line break there. Without the key table Enter is
  // the field's own, so nothing could pick a row.
  slashable() {
    if (this.mode !== "reading" || !this.keysBound || !this.editable()) return false;
    const b = this.pending ? null : this.blockByKey(this.activeKey);
    return Boolean(this.pending) || Boolean(b && isText(b));
  }

  closeSlash(cx) {
    if (!this.slash) return;
    this.slash = null;
    this.redraw([this.activeKey], cx);
    cx?.notify();
  }

  slashCaret(c, cx) {
    const s = this.slash;
    if (s && !(c && c.start === c.end && c.end > s.at && c.end <= s.end)) this.closeSlash(cx);
  }

  // -> true when the menu took the key (Up and Down move the highlight, Enter and Tab pick, Escape closes). Enter and
  // Tab with no rows, and every other key, close it and then do what they always do.
  slashAction(name, cx) {
    const s = this.slash;
    if (name === "mdb-up" || name === "mdb-down") {
      this.menuKeyUp = name === "mdb-up" ? "up" : "down";
      this.slash = step(s, name === "mdb-up" ? -1 : 1, this.slashPlace()?.visible);
      cx.notify();
      return true;
    }
    if ((name === "mdb-enter" || name === "mdb-tab") && s.items.length) {
      this.slashPick(s.items[s.index], cx);
      return true;
    }
    this.closeSlash(cx);
    return name === "mdb-escape";
  }

  slashHover(i, cx) {
    if (!this.slashOpen() || this.slash.index === i) return;
    this.slash = { ...this.slash, index: i };
    cx.notify();
  }

  // Command c picked: the block becomes what it names, or its lines go in where the slash was, and "/query" goes, as one
  // history entry. A block a text style leaves empty goes when left so, as one the user emptied would: it keeps the
  // value it was opened with. A line the commit parses as a raw block (`~~~ /code`) takes no command, nor does a block
  // retype refuses: both stay as typed. A command with `picture` on a file asks for image files first (slashPicture),
  // and does nothing while a dialog is already open.
  slashPick(c, cx) {
    if (c.picture && this.picking) return;
    this.syncField(cx);
    if (!this.slashOpen()) return;
    const s = this.slash;
    this.closeSlash(cx);
    if (this.pending) return this.slashPending(c, cx);
    const opened = this.opened;
    this.commit(cx);
    const b = this.blockByKey(this.activeKey);
    if (!b || !isText(b) || !this.f || this.seen.slice(s.at, s.end) !== `/${s.query}`) return;
    const at = fieldToDoc(this.f, s.at), length = s.end - s.at;
    const unquery = { start: at, end: at + length, insert: "", caret: at };
    if (c.picture && this.file) return this.slashPicture(c, b, s, unquery, opened, cx);
    if (c.lines) return this.slashLines(c, b, s, unquery, cx);
    if (c.to.kind === "paragraph" && !(this.seen.slice(0, s.at) + this.seen.slice(s.end)).trim()) return this.emptyParagraphFor(b, unquery, cx);
    // Retyped first: a block holding only the query is no block once the query goes.
    const w = chain(this.doc, retype(this.doc, b, c.to, at), [(_d, _b, p) => ({ start: p, end: p + length, insert: "", caret: p })]);
    if (!w) return;
    this.op(w.splice, cx);
    this.opened = opened;
  }

  // Lines of their own where the query was (insertLines): beside the block's text, or in its place when the query
  // was all of it. An item whose sub-items they would take gets them after its subtree.
  slashLines(c, b, s, unquery, cx) {
    const sp = insertLines(this.doc, b, s.at, s.end, c.lines)
      ?? chain(this.doc, unquery, [(d, x) => insertAfter(d, x, "lines", c.lines.join("\n"))])?.splice;
    if (!sp) return;
    if (c.caret === undefined) this.op(sp, cx, { then: () => this.paragraphAfter(sp.caret, cx) });
    else this.op(sp, cx, { caret: c.caret });
  }

  // A block that takes no caret (a rule) gets an empty paragraph after it to go on typing in.
  paragraphAfter(at, cx) {
    const b = this.holding(at);
    if (b) this.openPendingWith({ base: afterKey(b.key, "paragraph") }, cx);
    else this.handle.focus();
  }

  // Text picked in a block that holds nothing but the query: an item keeps its sub-items, moved out with it.
  emptyParagraphFor(b, unquery, cx) {
    if (b.subtreeEnd === b.end) return this.paragraphInPlace(b, cx);
    const w = chain(this.doc, unquery, ["paragraph"]);
    if (w) this.op(w.splice, cx, { then: () => this.openPendingWith({ base: this.baseAt(w.splice.caret, b.depth) }, cx) });
  }

  // A pick in a block not written yet, which holds nothing but the query: lines are written where it was opened; a
  // style is written as its marker alone, the caret after it, as typing it would. An item Enter opened leaves its list
  // for any other style (or `# ` would be a heading inside it); for its own list it stays as it is.
  slashPending(c, cx) {
    const p = this.pending;
    if (c.picture && this.file) {
      this.setField("", { start: 0, end: 0 });
      return this.askForPictures(placeOf(p), c, cx);
    }
    if (c.lines) {
      const w = chain(this.doc, p.base(this.doc, PLACEHOLDER), [...p.steps, (d, b) => insertLines(d, b, 0, PLACEHOLDER.length, c.lines)]);
      if (!w) return;
      const from = this.originDoc(p) ?? w.splice.start;
      this.release();
      this.change(w.splice, cx, { caretBefore: from, caretAfter: w.splice.caret });
      if (c.caret === undefined) this.paragraphAfter(w.splice.caret, cx);
      else this.openAt(w.splice.caret, cx, c.caret);
      return;
    }
    this.setField("", { start: 0, end: 0 });
    const item = p.block.kind === "item", same = item && c.to.kind === "item" && c.to.list === listOf(p.block);
    if (item && !same) this.restep("paragraph", cx);
    if (c.to.kind !== "paragraph" && !same) this.writePending(c.marker, c.marker.length, cx, false, true);
  }

  // Image picked on a file: the query goes (a block that held only it goes too, as for Text), the file dialog opens, and
  // what it answers is written where the slash was. A block with other text keeps it, and the pictures go below it.
  slashPicture(c, b, s, unquery, opened, cx) {
    if (!(this.seen.slice(0, s.at) + this.seen.slice(s.end)).trim() && b.subtreeEnd === b.end) {
      this.paragraphInPlace(b, cx);
      const p = this.pending;
      return this.askForPictures(p ? placeOf(p) : AT_END, c, cx);
    }
    const w = chain(this.doc, unquery, []);
    if (!w) return;
    this.op(w.splice, cx);
    this.opened = opened;
    this.askForPictures(belowBlock(b.key), c, cx);
  }

  // Without osascript the command's own lines are written, as for any command with lines: an empty picture, picked
  // with the address box open.
  askForPictures(target, c, cx) {
    this.picking = true;
    cx.spawn(async cx => {
      const { paths, problem } = await this.dialogAnswer(imageStart(), {}, cx);
      if (this.closed) return;
      if (problem instanceof DialogUnavailable) {
        if (this.writePictures(target, c.lines, cx, { caret: c.caret })) this.showPictureBox("address", cx);
        return;
      }
      if (problem) {
        notify({ title: "Can't choose pictures", body: why(problem), level: "error" });
        return;
      }
      if (!paths?.length || !this.placeable()) return;
      const items = await placePictures(paths, this.file);
      if (items.length) this.writePictures(target, pictureMarkdown(items).split("\n"), cx);
    });
  }

  // One dialog at a time (`picking`, set before the task that waits here starts), kept open as long as the person
  // needs; closing the pane ends it. `options` go to PictureDialog. -> { paths, problem } once it has answered.
  async dialogAnswer(startFolder, options, cx) {
    let paths = null, problem = null;
    const dialog = this.dialog = new PictureDialog(ms => new Promise(done => cx.timer.after(ms, () => done())), options);
    try { paths = await dialog.pick(startFolder); } catch (e) { problem = e; }
    this.dialog = null;
    this.picking = false;
    return { paths, problem };
  }

  placeable() {
    if (this.closed) return false;
    if (this.editable()) return true;
    notify({ title: "The pictures weren't added", body: "This note can't be edited right now", level: "info" });
    return false;
  }

  // `lines` become blocks at `target`, at the end of the page when that place is gone. The caret then goes into them at
  // `caret`, or to a new empty paragraph below; `keepFocus` leaves no block open (a drop).
  writePictures(target, lines, cx, { caret, keepFocus = false } = {}) {
    if (!this.placeable()) return false;
    this.leave(cx);
    const write = (d, b) => insertLines(d, b, 0, PLACEHOLDER.length, lines);
    const w = chain(this.doc, target.base(this.doc, PLACEHOLDER), [...target.steps, write]) ?? chain(this.doc, atEnd(this.doc, PLACEHOLDER), [write]);
    if (!w) return false;
    const then = keepFocus ? () => this.handle.focus() : caret === undefined ? () => this.paragraphAfter(w.splice.caret, cx) : null;
    return this.op(w.splice, cx, { caret, then });
  }

  // Image files dropped on the page go below the block the pointer was last over, else below the one being edited, else
  // at the end; any other file is ignored.
  dropped(e, cx) {
    if (!this.editable()) return;
    const paths = (e?.paths ?? []).filter(isPictureName);
    if (!paths.length) {
      notify({ title: PICTURES_ONLY, level: "info" });
      return;
    }
    const target = this.dropTarget();
    cx.spawn(async cx => {
      const items = await placePictures(paths, this.file);
      if (items.length) this.writePictures(target, pictureMarkdown(items).split("\n"), cx, { keepFocus: true });
    });
  }

  dropTarget() {
    const key = (this.pointer && this.hit(this.pointer)?.block?.key) || this.activeKey;
    if (!key) return AT_END;
    const p = this.pending;
    return p?.key === key ? placeOf(p) : belowBlock(key);
  }

  // Where the menu goes: over or under the caret row, its edge at the slash. Null while that row has no place.
  slashPlace() {
    const s = this.slash, key = this.activeKey, i = this.at.get(key), d = this.data.get(key);
    if (i === undefined || !d || this.sums.length !== this.blocks.length + 1) return null;
    const top = this.caretTop(i, s.end);
    if (top === null) return null;
    const viewW = this.viewport?.width ?? this.size?.width ?? 900, viewH = this.viewport?.height ?? UNSIZED_VIEW_H;
    const place = menuPlace({ rowTop: COLUMN.padTop + top - this.offset, rowH: d.row, viewH, n: s.items.length, side: s.side });
    s.side = place.side;
    return { ...place, left: slashX({ x: this.fieldInPane(i).x + this.wrapAt(s.at).x, viewW, margin: this.margin }) };
  }

  // Drawn by the root over the page; its rows take presses and the pointer before anything under them.
  slashMenu(t) {
    if (!this.slashOpen()) return null;
    const place = this.slashPlace();
    if (!place) return null;
    const s = this.slash, n = s.items.length, first = follow(s.first, s.index, place.visible, n);
    const rows = n
      ? s.items.slice(first, first + place.visible).map((c, j) => this.slashRow(c, first + j, t))
      : [div().id("md-slash-none").h(MENU.rowH).px(8).flex().items_center().text_color(t.muted).child("No results")];
    return v_flex().id("md-slash").absolute().left(place.left).top(place.top).w(MENU.w).p(MENU.pad)
      .bg(t.popover).rounded(10).border_1().border_color(t.border).shadow_lg().text_size(12.8)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => this.closeSlash(cx))
      .children(rows);
  }

  // A row is picked on the press: the release lands on whatever is under the pointer once the menu is gone.
  slashRow(c, i, t) {
    return h_flex().id(`md-slash-${c.id}`).h(MENU.rowH).flex_none().px(8).gap(9).rounded(7).items_center().cursor_pointer()
      .text_color(t.foreground)
      .when(i === this.slash.index, el => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.slashPick(c, cx); })
      .on_mouse_move((_e, cx) => { cx.stop_propagation(); this.slashHover(i, cx); })
      .child(svg(ICON(c.icon)).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(c.name))
      .when(Boolean(c.hint), el => el.child(div().flex_none().font_family(this.fonts.mono).text_size(11.5).text_color(t.dim).child(c.hint)));
  }

  // The format bar belongs to one activation of a writable text block, as the menu does, and shows while the selection
  // last read or set holds more than spaces, the menu and the boxes are shut, and no element is picked.
  barOpen() {
    const k = this.known;
    return this.bar?.act === this.act && Boolean(this.activeKey) && this.editable() && k.valid
      && Boolean(this.seen.slice(k.start, k.end).trim()) && !this.slashOpen() && !this.boxOpen() && !this.elementNow() && this.takesMarks();
  }

  // After a readout of the field's selection, or a format key while the bar is open: the bar shows over a selection and
  // goes at a caret.
  openBar(cx) {
    const was = this.bar;
    this.bar = { act: this.act };
    if (!this.barOpen()) this.bar = null;
    if (this.barMenu && !this.barMenuOpen()) this.barMenu = null;
    if (was || this.bar) cx.notify();
  }

  closeBar(cx) {
    if (!this.bar) return;
    this.bar = null;
    this.barMenu = null;
    cx?.notify();
  }

  // One of the bar's menus at a time, belonging to the bar over one value of the field: typing closes it.
  barMenuOpen() {
    const menu = this.barMenu;
    return Boolean(menu) && menu.act === this.act && menu.value === this.seen && this.barOpen();
  }

  toggleBarMenu(name, cx) {
    const shut = this.barMenuOpen() && this.barMenu.name === name;
    this.barMenu = shut ? null : { act: this.act, value: this.seen, name, index: -1 };
    cx.notify();
  }

  closeBarMenu(cx) {
    if (!this.barMenu) return;
    this.barMenu = null;
    cx?.notify();
  }

  barMenuHover(i, cx) {
    if (!this.barMenuOpen() || this.barMenu.index === i) return;
    this.barMenu = { ...this.barMenu, index: i };
    cx.notify();
  }

  // A row of menu `name` picked: the menu closes and the bar stays over the same text.
  barPick(name, row, cx) {
    this.closeBarMenu(cx);
    this.syncField(cx);
    if (!this.barOpen()) return;
    if (row.color) return this.setColor(row.color, cx);
    if (row.highlight !== undefined) return this.setMark("highlight", row.highlight, cx);
    const b = this.blockByKey(this.activeKey), back = name === "list" && row.id === styleId(b);
    this.turnInto(back ? { kind: "paragraph" } : row.to, cx);
  }

  // The bar's Text style and List menus: the edited block becomes `to` (as slash.js COMMANDS name it) as one entry of the
  // history, whose undo puts the selection back, with the same text selected after it and the bar over it.
  turnInto(to, cx) {
    if (this.pending) return;
    const r = this.caretNow();
    this.commit(cx);
    const b = this.blockByKey(this.activeKey);
    if (!r || !b || !isText(b) || !this.f) return;
    const before = docRange(this.f, r), s = retype(this.doc, b, to, before.start), e = retype(this.doc, b, to, before.end);
    if (!s || !e || (s.start === s.end && !s.insert)) return;
    const was = this.text, after = { start: s.caret, end: e.caret };
    this.release();
    this.change(s, cx, { caretBefore: before.start, caretAfter: s.caret });
    this.openAt(s.caret, cx, null, after);
    if (this.text !== was) this.history.select(this.text, before, after);
    this.openBar(cx);
  }

  // Over the first row of field range `k`, else under its last, its left edge at the range's start, as pinned by a press
  // or a drag, else as estimated; the bar, or a float of `size`. Null while that row is off the page.
  placeBar(k = this.known, size = this.barLayout(), place = barPlace) {
    const key = this.activeKey, i = this.at.get(key), d = this.data.get(key);
    if (i === undefined || !d || this.sums.length !== this.blocks.length + 1) return null;
    const o = this.fieldInPane(i), pin = this.pinFor(k, this.chromeOf(d, true).w);
    const first = pin ? { row: pin.first, x: pin.x } : this.wrapAt(k.start), last = pin ? pin.last : this.wrapAt(k.end, k.end > k.start).row;
    return place({
      firstTop: o.y + first.row * d.row, lastTop: o.y + last * d.row, rowH: d.row, size, x: o.x + first.x,
      viewW: this.paneW(), viewH: this.viewport?.height ?? UNSIZED_VIEW_H,
    });
  }

  paneW() {
    return this.viewport?.width ?? this.size?.width ?? 900;
  }

  barLayout() {
    return barLayout(FORMAT_GROUPS, this.paneW() - 2 * BAR.margin);
  }

  // Where the bar and its open menu go: { place, layout, name, menu } (no `menu` while none is open), or null while the
  // bar does not show.
  barPlaces() {
    if (!this.barOpen()) return null;
    const layout = this.barLayout(), place = this.placeBar(this.known, layout);
    if (!place) return null;
    if (!this.barMenuOpen()) return { place, layout, name: null, menu: null };
    const name = this.barMenu.name, sections = BAR_MENUS[name];
    const h = barMenuH(menuRowsOf(name).length, sections.filter(s => s.title).length);
    const menu = barMenuPlace({ bar: place, button: layout.at[name], h, viewW: this.paneW(), viewH: this.viewport?.height ?? UNSIZED_VIEW_H });
    return { place, layout, name, menu };
  }

  // A press outside the bar closes it, unless it is on the bar's open menu: that one is the menu's to take.
  barPressOut(e, cx) {
    const at = this.barPlaces(), p = this.point(e);
    if (at?.menu && p) {
      const x = at.place.left + p.x, y = at.place.top + p.y, m = at.menu;
      if (x >= m.left && x < m.left + m.w && y >= m.top && y < m.top + m.h) return;
    }
    this.closeBar(cx);
  }

  // Drawn by the root over the page, as the menu is. Presses on it reach neither the page nor the field under it, so the
  // field keeps the keyboard and the selection; one on its padding is outside its menu.
  formatBar({ place, layout, name }, t) {
    const look = this.barLook(t);
    let rules = 0;
    const entry = e => (e.sep
      ? div().id(`md-format-rule-${++rules}`).flex_none().w(1).h(BAR_RULE_H).mx((BAR.sep - 1) / 2).bg(t.border)
      : this.barButton(BAR_BUTTONS.get(e.name), look, e.name === name, t));
    return v_flex().id("md-format").absolute().left(place.left).top(place.top).w(place.w).h(place.h).p(BAR.pad).gap(BAR.rowGap)
      .bg(t.popover).rounded(10).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.closeBarMenu(cx); })
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((e, cx) => this.barPressOut(e, cx))
      .children(layout.rows.map(row => h_flex().h(BAR.button).flex_none().items_center().children(row.map(entry))));
  }

  // What the bar's buttons show for the selection: the marks every character of it has (their keys would take them
  // off), the block's style and list, and the selection's text colour and highlight when it has one of each.
  barLook(t) {
    const value = this.seen, k = this.known, at = { defs: this.doc?.defs }, b = this.pending?.block ?? this.blockByKey(this.activeKey);
    const pressed = new Set([...BAR_BUTTONS.values()].filter(x => MARK_ACTIONS[x.action] && hasMark(value, k, MARK_ACTIONS[x.action], at)).map(x => x.name));
    if (b?.kind === "item") pressed.add("list");
    const highlight = highlightOf(value, k, at);
    return {
      pressed,
      icons: { style: styleIcon(b), list: listIcon(b) },
      tint: { color: textColor(t, colorOf(value, k, at)) },
      backdrop: { color: highlight === "default" ? highlightColor(t) : textColor(t, highlight) },
    };
  }

  barButton(b, look, open, t) {
    const pressed = look.pressed.has(b.name), bg = look.backdrop[b.name] ?? (pressed || open ? t.hover : null);
    return h_flex().id(`md-format-${b.name}`).w(buttonW(b)).h(BAR.button).flex_none().items_center().justify_center().gap(1).rounded(6).cursor_pointer()
      .tooltip(b.tip)
      .when(Boolean(bg), el => el.bg(bg))
      .when(!pressed, el => el.hover(s => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.barButtonPress(b, cx); })
      .child(svg(ICON(look.icons[b.name] ?? b.icon)).size(16).flex_none().text_color(pressed ? t.accent : look.tint[b.name] ?? t.muted))
      .when(Boolean(b.menu), el => el.child(svg(ICON("chevron-down")).size(10).flex_none().text_color(t.dim)));
  }

  barButtonPress(b, cx) {
    if (b.menu) return this.toggleBarMenu(b.menu, cx);
    this.closeBarMenu(cx);
    this.action(b.action, cx);
  }

  // Drawn by the root beside the bar. Presses and pointer moves on it go no further, as on the bar.
  barMenuOf({ name, menu }, t) {
    const checks = this.barChecks(name);
    let i = 0;
    const row = r => this.barMenuRow(name, r, i++, checks.has(r.id), t);
    const title = s => div().id(`md-bar-title-${s.id}`).h(BAR_MENU.titleH).flex_none().px(8).flex().items_center().text_size(11.5).text_color(t.dim).child(s.title);
    return v_flex().id(`md-bar-menu-${name}`).absolute().left(menu.left).top(menu.top).w(menu.w).h(menu.h).p(BAR_MENU.pad)
      .bg(t.popover).rounded(8).border_1().border_color(t.border).shadow_lg().text_size(12.8)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation())
      .children(BAR_MENUS[name].flatMap(s => [...(s.title ? [title(s)] : []), ...s.rows.map(row)]));
  }

  // The rows that show the block's style, or the selection's colour and highlight when all of it has the same.
  barChecks(name) {
    if (name !== "color") return new Set([styleId(this.pending?.block ?? this.blockByKey(this.activeKey))]);
    const at = { defs: this.doc?.defs };
    return new Set([`text-${colorOf(this.seen, this.known, at)}`, HIGHLIGHT_ROWS[highlightOf(this.seen, this.known, at)]]);
  }

  // A row is picked on the press, as the slash menu's are.
  barMenuRow(name, row, i, checked, t) {
    const lead = row.icon ? svg(ICON(row.icon)).size(14).flex_none().text_color(t.muted) : this.swatch(row, t);
    return h_flex().id(`md-bar-row-${row.id}`).h(BAR_MENU.rowH).flex_none().px(8).gap(9).rounded(6).items_center().cursor_pointer()
      .text_color(t.foreground)
      .when(i === this.barMenu.index, el => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.barPick(name, row, cx); })
      .on_mouse_move((_e, cx) => { cx.stop_propagation(); this.barMenuHover(i, cx); })
      .child(lead)
      .child(div().flex_1().min_w(0).truncate().child(row.name))
      .when(checked, el => el.child(svg(ICON("check")).size(14).flex_none().text_color(t.foreground)));
  }

  // In the colour the text or the highlight draws in; no highlight is a dashed outline.
  swatch(row, t) {
    const box = div().id(`md-bar-swatch-${row.id}`).size(16).flex_none().rounded(4);
    if (row.highlight === false) return box.border_1().border_dashed().border_color(t.muted);
    return box.bg(row.highlight ? highlightColor(t) : row.color === "default" ? t.foreground : textColor(t, row.color));
  }

  // The comment box belongs to one activation of a writable block, as the bar does. The check fixture shows it anyway.
  noteOpen() {
    const n = this.note;
    return Boolean(n) && n.act === this.act && Boolean(this.activeKey) && (!this.file || this.editable());
  }

  // Cmd+Alt+M or the bar's Comment button: a comment on the selection of a written text block, or at its caret, unless
  // it would land where a comment can't be; in a code block, diagram or table, a comment on the block.
  openNote(cx) {
    const b = this.pending ? null : this.blockByKey(this.activeKey);
    if (b && ownsNotes(b)) return this.openBlockAdd(b.key, cx);
    const r = b && isText(b) ? this.caretNow() : null;
    if (!r) return;
    const why = commentable(this.seen, r);
    if (why) return notify({ title: COMMENT_REFUSED[why], level: "info" });
    this.showNote({ kind: "add", range: r, text: "" }, cx);
  }

  // The box takes the keyboard, holding `text`, while the field keeps `range` selected.
  showNote({ kind, range, text, comment = null }, cx) {
    this.closeSlash(cx);
    this.closeBar(cx);
    this.note = { act: this.act, kind, value: this.seen, range, comment };
    this.retoken();
    this.guard(() => {
      this.noteField.set_value(text);
      this.noteField.set_selected_range({ start: text.length, end: text.length });
    });
    this.noteField.focus();
    cx.notify();
  }

  // Enter in the box writes the comment as one entry of the history, whose undo puts the selection back, and the field
  // gets the keyboard back with the caret after it. A field rewritten from outside meanwhile takes nothing.
  saveNote(cx) {
    const n = this.note;
    if (!this.noteOpen() || this.seen !== n.value) return this.closeNote(cx);
    const text = this.noteField.value();
    if (n.kind === "edit" && !oneLine(text)) return this.resolveIn(n.comment, n.range, cx);
    const next = n.kind === "add" ? addComment(n.value, n.range, text, new Date()) : editComment(n.value, n.comment, text);
    if (!next || next.refused) return this.cancelNote(cx);
    this.note = null;
    this.typeChange(n.value, n.range, next, cx);
    this.focusField(cx);
    this.checkMargin(cx);
    cx.notify();
  }

  // Enter in the comment's field: a block's new comment, a block's comment being edited, or a text comment.
  submitNote(cx) {
    if (this.blockAddOpen()) return this.saveBlockAdd(cx);
    return this.blockNoteEditing() ? this.saveBlockNote(cx) : this.saveNote(cx);
  }

  // Escape in the box: the field gets the keyboard back with the selection it had.
  cancelNote(cx) {
    const n = this.note;
    if (!this.noteOpen()) return this.closeNote(cx);
    this.note = null;
    this.selectField(n.range);
    this.retoken();
    this.focusField(cx);
    cx.notify();
  }

  closeNote(cx) {
    if (!this.note) return;
    this.note = null;
    this.retoken();
    cx?.notify();
  }

  // Drawn by the root where the bar goes, or over the top of a block or picture whose comment it writes or edits.
  // Presses on it go no further, so the field under it keeps its selection.
  noteBox(t) {
    const adding = this.blockAddNow(), block = this.margin ? null : this.blockNoteBox(adding);
    const place = block ?? (this.noteOpen() && !this.margin ? this.placeBar(this.note.range, NOTE_BOX) : null);
    if (!place) return null;
    const out = cx => (adding ? this.closeBlockAddOut(cx) : block ? this.closeBlockEdit(cx) : this.closeNote(cx));
    return div().id("md-note").absolute().left(place.left).top(place.top).w(place.w).min_h(place.h).p(NOTE_BOX.pad).flex()
      .bg(t.popover).rounded(8).border_1().border_color(t.border).shadow_lg().key_context(NOTE)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => out(cx))
      .child(Textarea.new(this.noteField).flex_1().text_size(13).text_color(t.foreground));
  }

  // Where the box goes that writes the new comment `adding`, else edits a block's or picture's comment; null for none.
  blockNoteBox(adding) {
    if (adding) return this.blockBoxPlace(adding.key, adding.picture);
    const n = this.blockNoteEditing() ? this.blockNote : null;
    return n && this.blockBoxPlace(n.key, this.notePicture(n.key, n.index), n.cell ? n.index : -1);
  }

  // The box writing or editing block `key`'s comment where no margin shows its card: over the block's top edge, under
  // it when there is no room above, at the block's left; over the row of a table's cell comment `cell` the same way;
  // over picture `picture` of a paragraph of pictures as its float would be. Null while that edge is out of the pane.
  blockBoxPlace(key, picture = -1, cell = -1) {
    if (picture >= 0) return this.placeOverPicture(key, picture, NOTE_BOX);
    const i = this.at.get(key), d = this.data.get(key), card = cell >= 0 ? this.blockNotesOf(key, true)[cell] : null;
    if (i === undefined || !d || this.sums.length !== this.blocks.length + 1) return null;
    const viewW = this.viewport?.width ?? this.size?.width ?? 900, viewH = this.viewport?.height ?? UNSIZED_VIEW_H;
    const top = COLUMN.padTop + (card ? this.cellTop(i, d, card) : this.sums[i] + d.space) - this.offset;
    return popoverPlace({ firstTop: top, lastTop: top, rowH: 0, size: NOTE_BOX, viewW, viewH, x: columnLeft(viewW, this.margin) + d.depth * INDENT });
  }

  // A box over the page that holds the keyboard: the comment box (a block's comment being written or edited included),
  // the link's address box, a picture's box or the language menu's search box.
  boxOpen() {
    return this.noteOpen() || this.blockNoteEditing() || this.blockAddOpen() || this.linkBoxOpen() || this.pictureBoxOpen() || this.imageBoxOpen() || this.langOpen();
  }

  // A float at `place` in the link popover's look. Presses on it go no further, so what is under it keeps the keyboard
  // and the selection.
  popoverFrame(id, place, t) {
    return h_flex().id(id).absolute().left(place.left).top(place.top).w(place.w).h(place.h).p(BAR.pad).items_center()
      .bg(t.popover).rounded(8).border_1().border_color(t.border).shadow_lg().text_size(12.5)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation());
  }

  // A float's address, clipped in the middle, the whole of it as its tooltip.
  popoverAddress(id, address, t) {
    return div().id(id).flex_1().min_w(0).px(LINK_POP.addressPad).truncate().text_color(address ? t.muted : t.dim)
      .tooltip(address || NO_ADDRESS).child(clipMiddle(address, LINK_POP.addressChars) || NO_ADDRESS);
  }

  popoverRule(t) {
    return div().flex_none().w(1).h(BAR_RULE_H).mx((BAR.sep - 1) / 2).bg(t.border);
  }

  popoverButton(id, look, run, t) {
    return h_flex().id(id).size(BAR.button).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .tooltip(look.tip)
      .hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); run(cx); })
      .child(svg(ICON(look.icon)).size(16).flex_none().text_color(t.muted));
  }

  // Drawn by the root over the link picked, under it when there is no room.
  linkPopover({ span, extent }, t) {
    const shown = clipMiddle(span.url, LINK_POP.addressChars), place = this.placeBar(extent, linkPopoverSize([...shown].length), popoverPlace);
    if (!place) return null;
    const copied = Boolean(this.element.copied);
    return this.popoverFrame("md-link", place, t)
      .on_mouse_down_out(() => this.elementPressOut())
      .child(this.popoverAddress("md-link-address", span.url, t))
      .child(this.popoverRule(t))
      .children(LINK_BUTTONS.map(b => this.popoverButton(`md-link-${b.name}`, copied && b.done ? b.done : b, cx => this.linkAction(b.name, cx), t)));
  }

  // The popover's buttons. Open goes where Cmd+click goes; Copy puts the address on the clipboard; Edit opens the
  // address box in the popover's place; Remove takes the link off, its text staying selected, as one entry of the history.
  linkAction(name, cx) {
    const picked = this.elementNow();
    if (picked?.kind !== "link") return;
    const { span, extent } = picked;
    if (name === "open") return this.link(span.url, cx);
    if (name === "copy") {
      cx.write_to_clipboard(span.url);
      this.element = { ...this.element, copied: true };
      return cx.notify();
    }
    if (name === "edit") return this.showLinkBox({ link: span, place: extent, text: span.url, back: true }, cx);
    const value = this.seen, next = unlink(value, span, { defs: this.doc.defs });
    if (!next) return;
    this.element = null;
    this.typeChange(value, this.known, next, cx);
    cx.notify();
  }

  // Cmd+K or the bar's Link button: the address box, for the link picked or the one the selection lies in (a caret at
  // its edge is outside it), else for a new link over the selection, the word holding the caret, or at the caret,
  // offering the address the clipboard holds.
  linkKey(cx) {
    if (!this.takesMarks()) return;
    const r = this.caretNow();
    if (!r) return;
    const picked = this.elementNow(), held = picked?.kind === "link" ? picked : this.elementHolding("link", r);
    const inside = held && (picked || r.start !== r.end || (held.extent.start < r.start && r.start < held.extent.end));
    if (inside) return this.showLinkBox({ link: held.span, place: held.extent, text: held.span.url, back: false }, cx);
    const sel = actedOn(this.seen, r), target = sel.start === undefined ? { start: sel.caret, end: sel.caret } : { start: sel.start, end: sel.end };
    if (!addLink(this.seen, target, ANY_ADDRESS, { defs: this.doc.defs })) return notify({ title: LINK_REFUSED, level: "info" });
    this.closeElement(cx);
    this.showLinkBox({ link: null, target, place: target, text: clipboardAddress(cx.read_from_clipboard?.()), back: false }, cx);
  }

  // The address box belongs to one activation of a writable block, over the field value it was opened on.
  linkBoxOpen() {
    const b = this.linkBox;
    return Boolean(b) && b.act === this.act && Boolean(this.activeKey) && this.editable() && b.value === this.seen;
  }

  // The box takes the keyboard holding `text`, all selected, while the field keeps its selection. `link` is the link it
  // changes (none: a new one goes over `target`), `place` the range it sits under, and `back` whether Escape goes back
  // to the link's popover.
  showLinkBox({ link, target = null, place, text, back }, cx) {
    this.closeSlash(cx);
    this.closeBar(cx);
    this.linkBox = { act: this.act, value: this.seen, range: this.known, link: link && { start: link.start }, target, place, back };
    this.guard(() => {
      this.linkField.set_value(text);
      this.linkField.set_selected_range({ start: 0, end: text.length });
    });
    this.linkField.focus();
    cx.notify();
  }

  // Enter in the address box: the link gets the address typed (an empty one takes the link off), or a new link to it is
  // made, as one entry of the history whose undo puts the selection back. The link stays selected with its popover
  // showing the new address. An empty address for a new link changes nothing.
  applyLinkBox(cx) {
    const b = this.linkBox;
    if (!this.linkBoxOpen()) return this.closeLinkBox(cx);
    const address = linkAddress(this.linkField.value()), value = this.seen, defs = { defs: this.doc.defs };
    const span = b.link && parsedInline(value, this.defsNow().map).spans.find(sp => sp.kind === "link" && sp.start === b.link.start);
    if (!span && !address) return this.cancelLinkBox(cx);
    const next = span ? (address ? setAddress(value, span, address, defs) : unlink(value, span, defs)) : addLink(value, b.target, address, defs);
    this.linkBox = null;
    if (next) this.typeChange(value, b.range, next, cx);
    else this.selectField(b.range);
    this.element = next && address ? { act: this.act, kind: "link" } : null;
    this.focusField(cx);
    cx.notify();
  }

  // Escape in the address box: nothing changes, the field gets the keyboard back with its selection, and the popover
  // shows again when the box came from it.
  cancelLinkBox(cx) {
    const b = this.linkBox;
    if (!this.linkBoxOpen()) return this.closeLinkBox(cx);
    this.linkBox = null;
    this.selectField(b.range);
    this.retoken();
    if (!b.back) this.element = null;
    this.focusField(cx);
    cx.notify();
  }

  closeLinkBox(cx) {
    if (!this.linkBox) return;
    this.linkBox = null;
    cx?.notify();
  }

  // Drawn by the root where the link's popover goes. One press outside closes it, writing nothing.
  linkBoxView(t) {
    const place = this.placeBar(this.linkBox.place, LINK_BOX, popoverPlace);
    if (!place) return null;
    return this.boxFrame("md-link-box", place, this.linkField, t)
      .on_mouse_down_out((_e, cx) => { this.closeLinkBox(cx); this.elementPressOut(); });
  }

  // A one-line field `state` at `place` over the page, in the link's address box look, its Enter and Escape the note
  // keys. Presses on it go no further.
  boxFrame(id, place, state, t) {
    return div().id(id).absolute().left(place.left).top(place.top).w(place.w).h(place.h).p(LINK_BOX.pad).flex()
      .bg(t.popover).rounded(8).border_1().border_color(t.border).shadow_lg().key_context(NOTE)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation())
      .child(Input.new(state).flex_1().h_full().text_size(13).text_color(t.foreground));
  }

  // The picture picked while its paragraph still holds it: { key, index, copied, box, b, item }, `item` as picturesOf
  // reads it with what Images answered; null for none.
  pickedNow() {
    const p = this.picked;
    if (!p || this.mode !== "reading" || !this.doc) return null;
    const b = this.blockByKey(p.key), item = b?.image ? this.pictures.get(p.key)?.items[p.index] : null;
    return item ? { ...p, b, item } : null;
  }

  // Picture `index` of the paragraph of pictures `key` is picked, with its ring and its float, and the page holds the
  // keyboard. The one picked already keeps its float as it is. Any active comment but this picture's ends.
  pick(key, index, cx) {
    const was = this.picked;
    if (!this.blockByKey(key)?.image || !this.pictures.get(key)?.items[index]) return;
    if (was?.key !== key || was.index !== index) this.picked = { key, index, copied: false, box: null };
    if (this.blockNote && !this.pictureNoteActive(key, index)) this.endBlockNote(cx);
    this.handle.focus();
    this.redraw([...new Set([was?.key, key])], cx);
    cx.notify();
  }

  // The picked picture's comment, active with it, goes with it.
  unpick(cx) {
    const was = this.picked;
    if (!was) return;
    this.picked = null;
    if (this.pictureNoteActive(was.key, was.index)) this.endBlockNote(cx);
    if (was.box) this.handle.focus();
    this.redraw([was.key], cx);
    cx?.notify();
  }

  // Picks the picture of paragraph of pictures b whose markdown holds or follows document offset `at`, else its last.
  pickNear(b, at, cx) {
    const all = picturesIn(this.doc, b), i = all.findIndex(p => at < p.end);
    this.pick(b.key, i < 0 ? all.length - 1 : i, cx);
  }

  // -> whether a paragraph of pictures holds document offset `at`, its picture there now picked.
  pickAt(at, cx) {
    const b = this.holding(at);
    if (!b?.image) return false;
    this.pickNear(b, at, cx);
    return true;
  }

  // The picked picture's markdown as picturesIn gives it, and `at`, its start in its paragraph's field.
  pickedSource(p) {
    const s = picturesIn(this.doc, p.b)[p.index];
    return s ? { ...s, at: docToField(fieldOf(this.doc, p.b), s.start) } : null;
  }

  // The field offset where the picture of paragraph of pictures b at y (from the block's top) begins: the first whose
  // row reaches below y, else the last.
  pictureStartAt(b, d, y) {
    const boxes = this.pictureOf(b.key, d.pictureW).boxes, all = picturesIn(this.doc, b);
    const i = boxes.findIndex(box => d.space + box.y + box.h > y), p = all[i < 0 ? all.length - 1 : i];
    return p ? docToField(fieldOf(this.doc, b), p.start) : 0;
  }

  // Picture `index` of paragraph of pictures `key`: its box in pane coordinates, or null while its block has no place on
  // the page.
  pictureBoxOf(key, index) {
    const i = this.at.get(key), d = this.data.get(key), box = d && this.pictureOf(key, d.pictureW).boxes[index];
    if (i === undefined || !box || this.sums.length !== this.blocks.length + 1) return null;
    const x = columnLeft(this.paneW(), this.margin) + d.depth * INDENT + box.x;
    return { x, y: COLUMN.padTop + this.sums[i] + d.space + box.y - this.offset, w: box.w, h: box.h };
  }

  // A float of `size` over that picture's top edge from its left edge, else under its bottom edge, as low as the pane
  // keeps it; null while the picture is off the pane. Worked out at each draw, so it follows the page.
  placeOverPicture(key, index, size) {
    const box = this.pictureBoxOf(key, index);
    return box && popoverPlace({ firstTop: box.y, lastTop: box.y, rowH: box.h, size, x: box.x, viewW: this.paneW(), viewH: this.viewport?.height ?? UNSIZED_VIEW_H });
  }

  // The page scrolls the least that shows the picked picture's top, as much of it as half the pane.
  revealPicked(cx) {
    const p = this.pickedNow(), box = p && this.pictureBoxOf(p.key, p.index);
    if (!box || !this.viewport) return;
    const next = keepInView({ offset: this.offset, viewportH: this.viewH(), y: box.y + this.offset, rowPx: Math.min(box.h, this.viewH() / 2), contentH: this.contentH() });
    if (next !== this.offset) this.scrollTo(next, cx);
  }

  // A key while a picture is picked, which the page hears. -> whether it was the picture's; Cmd+Z, Page Up / Down,
  // space, Home and End undo and scroll as they would.
  pictureKey(e, cx) {
    const k = e.keystroke, p = this.pickedNow();
    if (!p || p.box) return false;
    if (isCommentKey(e)) this.commentPicture(p, cx);
    else if (k === "escape") this.unpick(cx);
    else if (k === "backspace" || k === "delete") this.deletePicture(p, cx);
    else if (k === "cmd-c" || k === "cmd-x") this.copyPictureSource(p, k === "cmd-x", cx);
    else if (k === "enter") this.paragraphBelow(p.b, this.pickedSource(p).at, cx);
    else if (k === "left" || k === "right") this.stepPicture(p, k === "left" ? -1 : 1, cx);
    else if (k === "up" || k === "down") this.leavePictures(p, k === "up" ? -1 : 1, cx);
    else return false;
    cx.stop_propagation();
    return true;
  }

  stepPicture(p, dir, cx) {
    const next = p.index + dir;
    if (next < 0 || next >= this.pictures.get(p.key).items.length) return this.leavePictures(p, dir, cx);
    this.pick(p.key, next, cx);
    this.revealPicked(cx);
  }

  // The block before (dir < 0) or after the picked picture's paragraph opens as crossing opens it, rules skipped: at its
  // end or its start, or its last or first picture picked.
  leavePictures(p, dir, cx) {
    const target = this.blocks[this.crossedTo(this.at.get(p.key), dir)];
    if (!target) return;
    if (!target.image) return this.activate(target.key, this.entry(target, this.openedValue(target), dir, null), cx);
    this.pickNear(target, dir > 0 ? -Infinity : Infinity, cx);
    this.revealPicked(cx);
  }

  // A new empty paragraph below paragraph of pictures b, being edited; Cmd+Z there goes back to the picture at field
  // offset `at`.
  paragraphBelow(b, at, cx) {
    this.openPendingWith({ base: afterKey(b.key, "paragraph"), origin: { key: b.key, caret: { start: at, end: at } } }, cx);
  }

  // Enter at the end of text that the commit made a paragraph of pictures, which then stopped being edited.
  paragraphAfterPictures(at, cx) {
    const b = at === null ? null : this.holding(at);
    if (b?.image) this.paragraphBelow(b, fieldOf(this.doc, b).value.length, cx);
  }

  // A change of a paragraph of pictures as one entry of the history, whose undo and redo pick the picture at document
  // offset `before` and `after`; the one at `after` is picked now, and with none the page keeps the keyboard.
  pictureChange(s, before, after, cx) {
    if (this.activeKey) this.release();
    this.picked = null;
    this.change(s, cx, { caretBefore: before, caretAfter: after ?? s.start });
    if (after === null || !this.pickAt(after, cx)) this.handle.focus();
  }

  // The picked picture goes as removePicture takes it, ending its comment if active, whose index the next picture's
  // comment would take; the one before it is picked, else the one after it.
  deletePicture(p, cx) {
    if (!this.editable()) return;
    const all = picturesIn(this.doc, p.b), s = removePicture(this.doc, p.b, p.index);
    if (!s) return;
    if (this.pictureNoteActive(p.key, p.index)) this.endBlockNote(cx);
    const kept = all[p.index - 1] ?? all[p.index + 1] ?? null, shift = s.insert.length - (s.end - s.start);
    this.pictureChange(s, all[p.index].start, kept && (kept.start >= s.end ? kept.start + shift : kept.start), cx);
  }

  // Cmd+C and Cmd+X: the picture's markdown as the file writes it, with its link, highlight and comment; Cut then
  // deletes it as Delete does.
  copyPictureSource(p, cut, cx) {
    const s = this.pickedSource(p);
    cx.write_to_clipboard(this.doc.text.slice(s.start, s.end));
    if (cut) this.deletePicture(p, cx);
  }

  copyPicture(p, cx) {
    this.writeAddress(p.item.src, cx);
    this.picked = { ...this.picked, copied: true };
    cx.notify();
  }

  // A file's full path, which pastes into Finder or a terminal; any other address as written.
  writeAddress(src, cx) {
    const source = pictureSource(src, this.file);
    cx.write_to_clipboard(source.kind === "file" ? source.path : src);
  }

  // A web picture in the browser, a file in the app the computer opens it with; a file on another machine can't be.
  openPicture(src, cx) {
    if (/^https?:/i.test(src)) return cx.open_url(src);
    const source = pictureSource(src, this.file);
    if (source.kind !== "file") return notify({ title: NO_PICTURE_FILE, level: "info" });
    const failed = `Can't open ${basename(source.path)}`;
    if (this.remote) return notify({ title: failed, level: "info" });
    this.openWithSystem(source.path, failed, cx);
  }

  // Change on a paragraph's picture: the file chosen replaces its address (replacePicture), and without osascript its
  // address box opens.
  changePicture(p, cx) {
    const { key, index } = p, src = p.item.src;
    this.choosePicture(src, {
      chosen: (placed, cx) => this.replacePicture(key, index, src, placed, cx),
      noDialog: cx => this.addressBoxFor(key, index, src, cx),
    }, cx);
  }

  // The dialog for one picture, opened where the picture at `src` is a file, else where Image opens it. The file chosen,
  // placed as Image places it, goes to `chosen(placed, cx)`; without osascript `noDialog(cx)` runs instead.
  choosePicture(src, { chosen, noDialog }, cx) {
    if (this.picking) return;
    const source = pictureSource(src, this.file);
    this.picking = true;
    cx.spawn(async cx => {
      const { paths, problem } = await this.dialogAnswer(source.kind === "file" ? dirname(source.path) : imageStart(), { one: true }, cx);
      if (this.closed) return;
      if (problem instanceof DialogUnavailable) return noDialog(cx);
      if (problem) return notify({ title: "Can't choose a picture", body: why(problem), level: "error" });
      if (!paths?.length || !this.placeable()) return;
      const [placed] = await placePictures(paths.slice(0, 1), this.file);
      if (placed && this.mode === "reading" && this.placeable()) chosen(placed, cx);
    });
  }

  addressBoxFor(key, index, src, cx) {
    const p = this.pickedNow();
    if (p?.key === key && p.index === index && p.item.src === src) this.showPictureBox("address", cx);
  }

  // Picture `index` of paragraph `key`, still at address `src`, takes the address of `chosen` (placePictures' { alt,
  // address }), its title, link, highlight and comment kept; an alt text that named the old file names the new one.
  replacePicture(key, index, src, chosen, cx) {
    this.commit(cx);
    const b = this.blockByKey(key), at = b?.image ? picturesIn(this.doc, b)[index] : null;
    const source = at ? this.doc.text.slice(at.from, at.to) : "", was = picturesOf(source)[0];
    if (was?.src !== src) return notify({ title: PICTURE_CHANGED, level: "info" });
    const old = pictureSource(src, this.file), named = altNames(was.alt, old.kind === "file" ? old.path : src);
    const next = pictureWithAddress(named ? pictureWithAlt(source, chosen.alt) : source, chosen.address);
    this.pictureChange({ start: at.from, end: at.to, insert: next }, at.start, at.start, cx);
  }

  pictureField(box = this.picked?.box) {
    return box === "alt" ? this.altField : this.addressField;
  }

  // The float gives its place to the box of the picked picture's alt text or address (`box`), which holds it all
  // selected and takes the keyboard.
  showPictureBox(box, cx) {
    const p = this.pickedNow();
    if (!p || !this.editable()) return;
    const field = this.pictureField(box), text = box === "alt" ? p.item.alt : p.item.src;
    this.picked = { ...this.picked, box };
    this.guard(() => {
      field.set_value(text);
      field.set_selected_range({ start: 0, end: text.length });
    });
    field.focus();
    cx.notify();
  }

  pictureBoxOpen() {
    return Boolean(this.pickedNow()?.box) && this.editable();
  }

  // Enter in the box: the alt text exactly as typed, or the address typed, trimmed (an empty one writes nothing), as one
  // entry of the history; a highlight and comment around the picture stay. What is unchanged writes nothing. The float
  // comes back.
  applyPictureBox(cx) {
    const p = this.pickedNow(), s = p?.box && this.editable() ? this.pickedSource(p) : null;
    if (!s) return this.cancelPictureBox(cx);
    const typed = this.pictureField(p.box).value(), source = this.doc.text.slice(s.from, s.to), address = typed.trim();
    const next = p.box === "alt" ? (typed === p.item.alt ? source : pictureWithAlt(source, typed))
      : !address || address === p.item.src ? source : pictureWithAddress(source, writtenAddress(address));
    if (next === source) return this.cancelPictureBox(cx);
    this.pictureChange({ start: s.from, end: s.to, insert: next }, s.start, s.start, cx);
  }

  // Escape in the box: nothing is written, and the float comes back.
  cancelPictureBox(cx) {
    if (this.picked?.box) this.picked = { ...this.picked, box: null };
    this.handle.focus();
    cx.notify();
  }

  // Edits only on a file that can be edited (and in the check fixture, which draws them all), Open link only on a
  // linked picture.
  pictureButtons(p) {
    const edits = !this.file || this.editable();
    return PICTURE_BUTTONS.filter(b => (edits || !b.edits) && (Boolean(p.item.href) || !b.linked));
  }

  pictureAction(name, cx) {
    const p = this.pickedNow();
    if (!p) return;
    if (name === "copy") return this.copyPicture(p, cx);
    if (name === "open") return this.openPicture(p.item.src, cx);
    if (name === "link") return this.link(p.item.href, cx);
    if (!this.editable()) return;
    if (name === "comment") this.commentPicture(p, cx);
    else if (name === "change") this.changePicture(p, cx);
    else if (name === "alt") this.showPictureBox("alt", cx);
    else if (name === "delete") this.deletePicture(p, cx);
  }

  // Comment and Cmd+Alt+M on the picked picture: its comment edited when it has one (a picture holds one), else a new
  // one written on it.
  commentPicture(p, cx) {
    if (!this.editable()) return;
    if (p.item.comment) this.openPictureNote(p.key, p.item.comment.index, cx);
    else this.startBlockAdd({ key: p.key, act: this.act, caret: null, picture: p.index }, cx);
  }

  // Comment `index` of paragraph of pictures `key` edited where a new one would be written: on its card, or in the
  // box over its picture. Whatever else was being written closes, writing nothing; a picked picture stays so.
  openPictureNote(key, index, cx) {
    this.closeCard(cx);
    this.closeBlockAdd(cx);
    this.setBlockNote({ key, index, editing: false }, cx);
    this.startBlockEdit(cx);
  }

  // Whether the comment box stands in the picked picture's float's place: with no margin, a comment on it is being
  // written or edited.
  noteOverPicture(p) {
    if (this.margin) return false;
    const a = this.blockAddNow();
    return a ? a.key === p.key && a.picture === p.index : this.blockNoteEditing() && this.pictureNoteActive(p.key, p.index);
  }

  // Drawn by the root after the bar: the picked picture's address and buttons, or its box; a press outside the box
  // closes it and the float, writing nothing. Nothing while the comment box stands in its place.
  pictureFloat(t) {
    const p = this.pickedNow();
    if (!p || this.noteOverPicture(p)) return null;
    if (p.box) {
      const place = this.editable() && this.placeOverPicture(p.key, p.index, LINK_BOX);
      return place ? this.boxFrame("md-picture-box", place, this.pictureField(p.box), t).on_mouse_down_out((_e, cx) => this.unpick(cx)) : null;
    }
    const buttons = this.pictureButtons(p), place = this.placeOverPicture(p.key, p.index, pictureFloatSize(p.item.src, buttons));
    return place && this.pictureFloatAt(place, p.item.src, { buttons, copied: p.copied, run: (name, cx) => this.pictureAction(name, cx) }, t);
  }

  // A picture's float at `place`: its address `src`, then `buttons` (some of PICTURE_BUTTONS), which `run(name, cx)`.
  pictureFloatAt(place, src, { buttons, copied, run }, t) {
    const button = b => this.popoverButton(`md-picture-${b.name}`, copied && b.done ? b.done : b, cx => run(b.name, cx), t);
    return this.popoverFrame("md-picture", place, t)
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .child(this.popoverAddress("md-picture-address", src, t))
      .child(this.popoverRule(t))
      .children(buttons.flatMap(b => (b.apart ? [this.popoverRule(t), button(b)] : [button(b)])));
  }

  // The language menu while it stands, with its block `b`: a code block, or the diagram whose source is being edited, in
  // the activation the menu opened in, on a file that can be edited (or the check fixture).
  langNow() {
    const l = this.lang;
    if (!l || l.act !== this.act || this.mode !== "reading" || !this.doc || (this.file && !this.editable())) return null;
    const b = this.blockByKey(l.key);
    return b && stripped(b, b.key === this.activeKey) ? { ...l, b } : null;
  }

  langOpen() {
    return Boolean(this.langNow());
  }

  // A press on code block b's chip opens its language menu, whose search box takes the keyboard, or closes the one it
  // opened. Editing another block stops and b is not opened; b being edited stays so.
  chipPress(b, cx) {
    if (this.langNow()?.key === b.key) return this.closeLanguages(cx);
    if (this.activeKey && this.activeKey !== b.key) this.deactivate(cx);
    const caret = b.key === this.activeKey ? this.caretNow() : null;
    this.lang = { key: b.key, act: this.act, caret, query: "", items: languageRows(""), index: 0, first: 0 };
    this.guard(() => this.langField.set_value(""));
    this.langField.focus();
    this.redraw([b.key], cx);
    cx.notify();
  }

  // The menu goes, and the keyboard goes back where it took it from: the edited block's field with its caret, else the
  // page.
  closeLanguages(cx) {
    const l = this.langNow();
    this.dropLanguages(cx);
    if (!l) return;
    if (l.key !== this.activeKey) return this.handle.focus();
    if (l.caret) this.selectField(l.caret);
    this.focusField(cx);
  }

  // A press elsewhere closes the menu and gives the keyboard to whatever it lands on, the page when no block is edited.
  letLanguagesGo(cx) {
    this.dropLanguages(cx);
    if (!this.activeKey) this.handle.focus();
  }

  dropLanguages(cx) {
    const l = this.lang;
    if (!l) return;
    this.lang = null;
    this.redraw([l.key], cx);
    cx?.notify();
  }

  languagesTyped(cx) {
    const query = this.langField.value();
    if (!this.langOpen() || query === this.lang.query) return;
    this.lang = { ...this.lang, query, items: languageRows(query), index: 0, first: 0 };
    cx.notify();
  }

  languageKey(name, cx) {
    if (!this.langOpen()) return;
    if (name === "mdb-lang-close") return this.closeLanguages(cx);
    if (name === "mdb-lang-pick") return this.pickLanguage(this.lang.items[this.lang.index], cx);
    this.lang = step(this.lang, name === "mdb-lang-up" ? -1 : 1);
    cx.notify();
  }

  languageHover(i, cx) {
    if (!this.langOpen() || this.lang.index === i) return;
    this.lang = { ...this.lang, index: i };
    cx.notify();
  }

  // A row picked: setLanguage writes a language's id or a typed word as one entry of the history, and the block's own
  // language writes nothing. A block not being edited leaves the page the keyboard; undo opens it where its code starts.
  pickLanguage(row, cx) {
    const l = this.langNow();
    if (!l || !row || !this.editable()) return;
    if (!row.typed && languageOf(infoWord(l.b.info)) === row) return this.closeLanguages(cx);
    const id = row.typed ?? row.id;
    if (l.key === this.activeKey) return this.languageOfEdited(l, id, cx);
    this.dropLanguages(cx);
    const s = setLanguage(this.doc, l.b, id);
    if (s) {
      const next = reparse(this.doc, s);
      this.change(s, cx, { caretBefore: codeStartIn(this.doc, l.b), caretAfter: codeStartIn(next, holdingIn(next, s.start)) });
    }
    this.handle.focus();
  }

  // The edited block is let go, written and opened again (op) with the caret it had: its field shows the same code, and
  // undo and redo put the caret back there.
  languageOfEdited(l, id, cx) {
    this.dropLanguages(cx);
    this.commit(cx);
    const b = this.blockByKey(l.key), s = b && setLanguage(this.doc, b, id), n = this.seen.length;
    const c = l.caret ? { start: Math.min(l.caret.start, n), end: Math.min(l.caret.end, n) } : { start: 0, end: 0 };
    this.selectField(c);
    if (!s) return this.focusField(cx);
    const next = reparse(this.doc, s), f = fieldOf(next, holdingIn(next, s.start));
    this.op(s, cx, { at: fieldToDoc(f, Math.min(c.end, f.value.length)), caret: c });
  }

  // Block `key`'s chip in pane coordinates, or null while it has none or no place on the page.
  chipBox(key) {
    const i = this.at.get(key), d = this.data.get(key);
    if (i === undefined || !d?.chip || this.sums.length !== this.blocks.length + 1) return null;
    const c = this.chipIn(d);
    return { ...c, x: columnLeft(this.paneW(), this.margin) + c.x, y: COLUMN.padTop + this.sums[i] + c.y - this.offset };
  }

  // Drawn by the root over the page at its chip, in the bar menus' look: the search box, then the rows. Presses and
  // pointer moves on it go no further.
  languageMenu(t) {
    const l = this.langNow(), chip = l && this.chipBox(l.key);
    if (!chip) return null;
    const viewH = this.viewport?.height ?? UNSIZED_VIEW_H, h = languageMenuH(Math.max(1, l.items.length));
    const place = languageMenuPlace({ chip, h, full: languageMenuH(MENU_ROWS), viewW: this.paneW(), viewH });
    const current = languageOf(infoWord(l.b.info));
    const rows = l.items.length
      ? l.items.map((row, i) => this.languageRow(row, i, row === current, t))
      : [div().id("md-lang-none").h(BAR_MENU.rowH).px(8).flex().items_center().text_color(t.muted).child("No results")];
    return v_flex().id("md-lang").absolute().left(place.left).top(place.top).w(place.w).h(place.h).p(BAR_MENU.pad)
      .bg(t.popover).rounded(8).border_1().border_color(t.border).shadow_lg().text_size(12.8)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation())
      .child(h_flex().id("md-lang-search").h(LANG_MENU.searchH).flex_none().items_center().key_context(LANG)
        .child(Input.new(this.langField).flex_1().text_size(12.8).text_color(t.foreground)))
      .children(rows);
  }

  // A row is picked on the press, as the bar menus' are; the row for a typed word names what it writes.
  languageRow(row, i, checked, t) {
    const typed = row.typed !== undefined;
    return h_flex().id(`md-lang-row-${typed ? "use" : row.id || "plain"}`).h(BAR_MENU.rowH).flex_none().px(8).gap(9).rounded(6).items_center().cursor_pointer()
      .text_color(t.foreground)
      .when(i === this.lang.index, el => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.pickLanguage(row, cx); })
      .on_mouse_move((_e, cx) => { cx.stop_propagation(); this.languageHover(i, cx); })
      .child(div().flex_1().min_w(0).truncate().child(typed ? `Use “${row.typed}”` : row.name))
      .when(checked, el => el.child(svg(ICON("check")).size(14).flex_none().text_color(t.foreground)));
  }

  // Drawn by the root over the picture picked in the edited text, under it when there is no room: a paragraph's
  // picture's float, less what an <img> tag can't do.
  imageFloat({ span, extent }, t) {
    const buttons = this.imageButtons(span), place = this.placeBar(extent, pictureFloatSize(span.url, buttons), popoverPlace);
    if (!place) return null;
    return this.pictureFloatAt(place, span.url, { buttons, copied: Boolean(this.element.copied), run: (name, cx) => this.imageAction(name, cx) }, t)
      .on_mouse_down_out(() => this.elementPressOut());
  }

  imageButtons(span) {
    const tag = pictureForm(this.seen, span) === "html", linked = Boolean(this.linkAround(span));
    return PICTURE_BUTTONS.filter(b => (!tag || !b.markdown) && (linked || !b.linked));
  }

  // The link whose text holds the picture `span` of the edited field, or null.
  linkAround(span) {
    return parsedInline(this.seen, this.defsNow().map).spans.find(sp => sp.kind === "link" && sp.from <= span.start && span.end <= sp.to) ?? null;
  }

  // The float's buttons on the picture picked in the edited field, as on a paragraph's (pictureAction); Comment comments
  // its source, which is what is selected, as any selection is commented.
  imageAction(name, cx) {
    const picked = this.elementNow();
    if (picked?.kind !== "image") return;
    const { span } = picked;
    if (name === "comment") this.openNote(cx);
    else if (name === "copy") {
      this.writeAddress(span.url, cx);
      this.element = { ...this.element, copied: true };
      cx.notify();
    } else if (name === "open") this.openPicture(span.url, cx);
    else if (name === "link") this.link(this.linkAround(span).url, cx);
    else if (name === "change") this.changeImage(span, cx);
    else if (name === "alt") this.showImageBox("alt", picked, cx);
    else if (name === "delete") this.deleteImage(span, this.known, cx);
  }

  // The picture `span` of the edited field goes as pictureCut takes it, what is left keeping its formatting, as one entry
  // of the history whose undo selects `range` again; the caret stays where it began, and its float closes.
  deleteImage(span, range, cx) {
    const value = this.seen, left = this.imageRemoved(value, span, true);
    this.element = null;
    this.typeChange(value, range, { value: left.value, start: left.caret, end: left.caret }, cx);
    cx.notify();
  }

  // The picture picked in the edited field, which held `range`, becomes `next` (setPicture's answer) as one entry of the
  // history whose undo selects `range` again; it stays picked.
  writeImage(range, next, cx) {
    this.typeChange(this.seen, range, next, cx);
    this.element = { act: this.act, kind: "image", start: next.start };
    cx.notify();
  }

  // Change on the picture `span` of the edited field, as on a paragraph's. The answer finds it again by its block, the
  // field's value, its start and its address (`at`).
  changeImage(span, cx) {
    const at = { key: this.activeKey, value: this.seen, start: span.start, src: span.url };
    this.choosePicture(span.url, { chosen: (placed, cx) => this.replaceImage(at, placed, cx), noDialog: cx => this.imageBoxFor(at, cx) }, cx);
  }

  // The picture `at` names takes the address of `placed` (placePictures' { alt, address }), its title kept and an alt
  // text that named the old file naming the new one, while its block still holds the value Change was pressed on; the
  // block is edited again with the picture picked if it no longer was. Else nothing is written, and a notice says why.
  replaceImage(at, placed, cx) {
    const span = this.imageAgain(at, cx);
    if (!span) return notify({ title: PICTURE_CHANGED, level: "info" });
    const old = pictureSource(span.url, this.file), named = altNames(span.alt, old.kind === "file" ? old.path : span.url);
    const next = setPicture(this.seen, span, named ? placed : { address: placed.address }, { defs: this.defsNow().map });
    if (!next) return;
    this.writeImage(this.known, next, cx);
    this.focusField(cx);
  }

  // The picture span `at` names (block, value, start and address) while its block still holds that value, picked in that
  // block's field, which is edited again if it no longer was; null when anything changed.
  imageAgain(at, cx) {
    const b = this.blockByKey(at.key), value = at.key === this.activeKey ? this.seen : b && isText(b) && fieldOf(this.doc, b).value;
    const found = value === at.value && parsedInline(value, this.defsNow().map).spans.find(sp => sp.kind === "image" && sp.start === at.start && sp.url === at.src);
    if (!found || (at.key !== this.activeKey && !this.activate(at.key, { start: found.start, end: found.end }, cx))) return null;
    const span = this.seen === at.value ? found : null;
    if (span) this.pickElement(span, cx);
    return span;
  }

  // Change without a dialog: the address box, while the picture `at` names is still the one picked.
  imageBoxFor(at, cx) {
    const picked = this.elementNow();
    if (picked?.kind === "image" && this.activeKey === at.key && this.seen === at.value && picked.span.start === at.start) this.showImageBox("address", picked, cx);
  }

  // The float of the picture picked in the edited field gives its place to the box of its alt text or its address
  // (`kind`), which takes the keyboard holding it all selected while the field keeps its selection.
  showImageBox(kind, { span, extent }, cx) {
    const field = this.pictureField(kind), text = kind === "alt" ? span.alt : span.url;
    this.imageBox = { act: this.act, value: this.seen, range: this.known, start: span.start, kind, place: extent };
    this.guard(() => {
      field.set_value(text);
      field.set_selected_range({ start: 0, end: text.length });
    });
    field.focus();
    cx.notify();
  }

  // The box belongs to one activation of a writable block, over the field value it was opened on.
  imageBoxOpen() {
    const b = this.imageBox;
    return Boolean(b) && b.act === this.act && Boolean(this.activeKey) && this.editable() && b.value === this.seen;
  }

  // Enter in a picture's box, of a paragraph's picture or of one picked in text.
  savePictureBox(cx) {
    if (this.imageBoxOpen()) this.applyImageBox(cx);
    else this.applyPictureBox(cx);
  }

  // Enter in the box of a picture in text: the alt text exactly as typed, or the address typed, trimmed (an empty one
  // writes nothing), as one entry of the history whose undo puts the selection back. What is unchanged writes nothing.
  // The picture stays picked, and its float comes back.
  applyImageBox(cx) {
    const b = this.imageBox, defs = this.defsNow().map, span = parsedInline(this.seen, defs).spans.find(sp => sp.kind === "image" && sp.start === b.start);
    const change = span && this.imageBoxChange(b.kind, span), next = change && setPicture(this.seen, span, change, { defs });
    if (!next) return this.cancelImageBox(cx);
    this.imageBox = null;
    this.writeImage(b.range, next, cx);
    this.focusField(cx);
  }

  // What the box of `kind` asks of the picture `span`: { alt } or { address } as setPicture takes them, or null.
  imageBoxChange(kind, span) {
    const typed = this.pictureField(kind).value(), address = typed.trim();
    if (kind === "alt") return typed === span.alt ? null : { alt: typed };
    return !address || address === span.url ? null : { address: writtenAddress(address) };
  }

  // Escape in the box: nothing changes, the field gets the keyboard back with its selection, and the float shows again.
  cancelImageBox(cx) {
    const b = this.imageBox;
    if (!this.imageBoxOpen()) return this.closeImageBox(cx);
    this.imageBox = null;
    this.selectField(b.range);
    this.retoken();
    this.focusField(cx);
    cx.notify();
  }

  closeImageBox(cx) {
    if (!this.imageBox) return;
    this.imageBox = null;
    cx?.notify();
  }

  // Drawn by the root where the picture's float goes. One press outside closes box and float, writing nothing.
  imageBoxView(t) {
    const place = this.placeBar(this.imageBox.place, LINK_BOX, popoverPlace);
    if (!place) return null;
    return this.boxFrame("md-picture-box", place, this.pictureField(this.imageBox.kind), t)
      .on_mouse_down_out((_e, cx) => { this.closeImageBox(cx); this.elementPressOut(); });
  }

  openCard(key, cx) {
    if (key === this.activeKey) this.commit(cx);
    this.card = { key };
    cx.notify();
  }

  closeCard(cx) {
    if (!this.card) return;
    this.card = null;
    cx?.notify();
  }

  // The comments of the card's block as its field shows them (a soft line break a space), a code block's, diagram's or
  // table's as its comments paragraph's field does, then a table's cells' (`cell`, each with its `index` among them and
  // its cell's text as Reading shows it), a paragraph of pictures' as pictureNotes gives them (all `block`); null when it
  // has none.
  cardComments() {
    const key = this.card?.key, b = key ? this.blockByKey(key) : null, owned = b ? this.shownNotes(key) : null;
    if (b?.image) {
      const list = this.pictureNotes(b);
      return list.length ? { b, f: null, list, block: true } : null;
    }
    if (!b || (!owned && !holdsComments(b))) return null;
    const f = owned ? fieldOf(this.doc, owned.para) : isText(b) ? fieldOf(this.doc, b) : null, list = f ? noted(f.value) : [];
    if (b.kind === "table") {
      const memo = this.cellNotesOf(b);
      for (const card of memo.cards) list.push({ kind: card.c.kind, note: card.note, name: this.cellName(memo, card), cell: true, index: card.index });
    }
    return list.length ? { b, f, list, block: !isText(b) } : null;
  }

  cellName(memo, card) {
    card.name ??= shownText(memo.value.slice(card.cell.start, card.cell.end));
    return card.name;
  }

  // Edit on the card: the block opens with the comment's marked text selected (a point comment's place), and the box
  // holds the comment. A block's comment, a table cell's among them, is edited in the box over the block, which opens
  // nothing.
  editNote(i, cx) {
    const found = this.cardComments(), c = found?.list[i];
    if (!c || !this.editable()) return;
    if (found.block) {
      this.pickBlockNote(found.b.key, c.cell ? c.index : i, cx, Boolean(c.cell));
      return this.startBlockEdit(cx);
    }
    const range = { start: c.from, end: c.to };
    this.closeCard(cx);
    if (this.activate(found.b.key, range, cx)) this.showNote({ kind: "edit", range, text: noteText(c.note), comment: c }, cx);
  }

  // Resolve on the card: the comment and its marks go, its marked text stays, as one entry of the history.
  resolveNote(i, cx) {
    if (!this.editable()) return;
    this.commit(cx);
    const found = this.cardComments(), c = found?.list[i];
    if (!c) return;
    if (found.block) return this.resolveBlockNoteAt(found.b.key, c.cell ? c.index : i, cx, Boolean(c.cell));
    const next = resolveComment(found.f.value, c);
    this.change(docSplice(found.f, marksEdits(found.f.value, next.value)), cx);
  }

  placeCard({ b, list }) {
    const i = this.at.get(b.key), d = this.data.get(b.key);
    if (i === undefined || !d?.notes || this.sums.length !== this.blocks.length + 1) return null;
    const viewW = this.viewport?.width ?? this.size?.width ?? 900, viewH = this.viewport?.height ?? UNSIZED_VIEW_H;
    const iconTop = COLUMN.padTop + this.sums[i] - this.offset + d.notesY;
    return cardPlace({ iconTop, iconLeft: columnLeft(viewW) + d.notesX, n: list.length, viewW, viewH });
  }

  // Drawn by the root by the block's comment count. Presses on it go no further. A file that can't be edited shows
  // the comments only.
  commentsCard(t) {
    const found = this.card ? this.cardComments() : null, place = found && this.placeCard(found);
    if (!place) return null;
    const writable = !this.file || this.editable();
    return v_flex().id("md-notes-card").absolute().left(place.left).w(place.w)
      .when(place.side === "below", el => el.top(place.top))
      .when(place.side === "above", el => el.bottom(place.bottom))
      .p(CARD.pad).gap(10).bg(t.popover).rounded(8).border_1().border_color(t.border).shadow_lg().text_size(12.5)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => this.closeCard(cx))
      .children(found.list.map((c, i) => this.cardEntry(c.name ?? (c.kind === "comment" ? found.f.value.slice(c.from, c.to) : ""), c, i, writable, new Date(), t)));
  }

  // `marked`: what the comment is on, as its first line: the marked text, a picture's name, a table cell's whole text,
  // or nothing for a point outside a table.
  cardEntry(marked, c, i, writable, now, t) {
    const button = (id, label, run) => div().id(id).h(24).px(8).flex().items_center().rounded(6).cursor_pointer()
      .bg(t.hover).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); run(cx); })
      .child(label);
    const { when, text } = readNote(c.note), label = timeLabel(when, now);
    return v_flex().id(`md-note-${i}`).gap(4)
      .when(Boolean(marked), el => el.child(div().truncate().text_color(t.muted).child(clip(marked, NOTE_CLIP))))
      .when(Boolean(label), el => el.child(div().text_size(CARD_TIME_SIZE).text_color(t.dim).child(label)))
      .child(div().whitespace_normal().text_color(t.foreground).child(text))
      .when(writable, el => el.child(h_flex().gap(6)
        .child(button(`md-note-edit-${i}`, "Edit", cx => this.editNote(i, cx)))
        .child(button(`md-note-resolve-${i}`, "Resolve", cx => this.resolveNote(i, cx)))));
  }

  // The file's comments, those of the block being edited as its field shows them.
  commentCount() {
    if (!this.doc) return 0;
    if (this.notesFor?.doc !== this.doc) {
      const byKey = new Map();
      for (const b of this.doc.blocks) {
        const n = holdsComments(b) ? noted(b.content).length : 0;
        if (n) byKey.set(b.key, n);
      }
      this.notesFor = { doc: this.doc, byKey, total: [...byKey.values()].reduce((sum, n) => sum + n, 0) };
    }
    const { byKey, total } = this.notesFor, b = this.activeKey && !this.pending ? this.blockByKey(this.activeKey) : null;
    return b && holdsComments(b) ? total - (byKey.get(b.key) ?? 0) + noted(this.seen).length : total;
  }

  // The comment that is active in the edited block: picked by a press on its text or its card, or being edited; a
  // comment being written is `adding`. Else a code block's, diagram's or table's comment being written, or its active
  // comment (`block`, its `index`), a picture's and a table cell's (`cell`) among them. -> { key, start, editing, adding,
  // id } or null.
  activeComment() {
    const a = this.blockAddNow();
    if (a) return { key: a.key, index: -1, block: true, editing: true, adding: true, id: `add:${a.key}:${a.picture}` };
    const n = this.blockNoteNow();
    if (n) return { key: n.key, index: n.index, block: true, cell: Boolean(n.cell), editing: n.editing, adding: false, id: `block:${n.key}:${n.cell ? "cell:" : ""}${n.index}:${n.editing}` };
    if (!this.activeKey || this.pending) return null;
    if (this.noteOpen()) {
      const n = this.note;
      if (n.kind === "add") return { key: this.activeKey, start: -1, editing: true, adding: true, id: "add" };
      return { key: this.activeKey, start: n.comment.start, editing: true, adding: false, id: `edit:${n.comment.start}` };
    }
    const e = this.element;
    if (!e || e.act !== this.act || !COMMENT_KINDS.has(e.kind) || !this.elementNow()) return null;
    return { key: this.activeKey, start: e.start, editing: false, adding: false, id: `pick:${e.start}` };
  }

  // The margin's cards in document order: one per comment of the window's text blocks (the edited one's as its field
  // holds them), each level with the row its text starts on, one per comment of its code blocks, diagrams and tables,
  // level with the block's top, then one per comment in a table's cells, level with its row, one per commented picture,
  // level with the picture's top, and one for a comment being written; each pushed down off the one before. Worked out
  // again only when something they are placed by has changed, not on every draw.
  cardList() {
    const m = this.margin;
    if (!m || !this.doc || this.sums.length !== this.blocks.length + 1) return [];
    const focus = this.activeComment();
    const sig = [this.doc, this.sums, this.win, m, this.activeKey, this.seen, this.tokensOff, focus?.id ?? "", this.raised, this.note, this.fieldGen];
    if (this.cards && sameList(this.cards.sig, sig)) return this.cards.list;
    this.commentCount();
    const list = [];
    for (const key of this.mountedKeys()) this.blockCards(key, focus, list);
    const written = !focus?.adding ? null : focus.block ? this.newBlockCard(this.blockAdd) : this.newCard();
    if (written) list.push(written);
    list.sort((a, b) => a.i - b.i || a.at - b.at);
    const tops = stackCards(list);
    for (let k = 0; k < list.length; k++) list[k].top = tops[k];
    this.cards = { sig, list };
    return list;
  }

  blockCards(key, focus, list) {
    const i = this.at.get(key), b = this.blocks[i], active = key === this.activeKey, owned = b && this.shownNotes(key);
    if (owned) this.ownerCards(i, b, owned.para, focus, list);
    if (b?.kind === "table") return this.cellCards(i, b, focus, list, owned ? owned.points.length + 1 : 1);
    if (owned) return;
    if (b?.image) return this.pictureCards(i, b, focus, list);
    if (!b || !isText(b) || b === this.pending?.block || (!active && !this.notesFor.byKey.has(key))) return;
    const memo = active ? { value: this.seen, cards: cardsOf(this.seen) } : this.cardMemoOf(b);
    for (const card of memo.cards) {
      const { c, index, at, when, text } = card, mine = Boolean(focus) && !focus.block && focus.key === key && focus.start === c.start, id = `md-card-${key}-${index}`;
      const look = mine ? cardLook({ text, header: true, full: true }) : card.look;
      list.push({ id, key, index, c, when, text: look.text, i, at, want: this.rowTop(i, b, memo, at), h: this.raisedH(id, look.h), active: mine, editing: mine && focus.editing });
    }
  }

  // Read from the comments paragraph even while b is edited, all level with b's top.
  ownerCards(i, b, para, focus, list) {
    const want = this.sums[i] + this.data.get(b.key).space;
    this.blockNoteCards(i, b, this.ownerMemoOf(b, para), focus, list, card => ({ at: card.index, want }));
  }

  ownerMemoOf(b, para) {
    const kept = this.cardMemo.get(b.key);
    if (kept && kept.content === para.content && kept.kind === BLOCK_NOTES_MEMO) return kept;
    const memo = { content: para.content, kind: BLOCK_NOTES_MEMO, value: para.content, cards: cardsOf(para.content) };
    this.cardMemo.set(b.key, memo);
    return memo;
  }

  // `after`: the table's own cards and the one written on it come first.
  cellCards(i, b, focus, list, after) {
    if (b.key !== this.activeKey && !this.notesFor.byKey.has(b.key)) return;
    const d = this.data.get(b.key);
    this.blockNoteCards(i, b, this.cellNotesOf(b), focus, list, card => ({ at: after + card.index, want: this.cellTop(i, d, card) }), true);
  }

  // The page y that cell comment `card` of table data d (page index i) is level with: its grid row's top, measured or
  // estimated; while the table's source is edited, the top of the line holding the comment; for a table kept as
  // source, its row's top as Reading's TextView draws a table of one-line rows.
  cellTop(i, d, card) {
    if (d.key === this.activeKey) return this.caretTop(i, card.c.start);
    if (d.grid) return this.sums[i] + d.space + gridRowTop(this.gridHeights(d), card.row);
    return this.sums[i] + d.space + tableRowTop(card.row, CELL_LINE_H, TABLE_INSET);
  }

  // Table b's cell comments as its cards show them (comments.js cellComments: each comment with its cell, row and note;
  // its time, text and card look), read from the edited table's field, else from its content, and kept while that
  // stays the same.
  cellNotesOf(b) {
    const value = b.key === this.activeKey ? this.seen : b.content, kept = this.cellMemo.get(b.key);
    if (kept?.value === value) return kept;
    const cards = cellComments(value).map((x, index) => {
      const { when, text } = readNote(x.note);
      return { c: x.comment, index, row: x.row, column: x.column, cell: x.cell, note: x.note, when, text, look: cardLook({ text, header: true }) };
    });
    const memo = { value, cards, look: null };
    this.cellMemo.set(b.key, memo);
    return memo;
  }

  // Each level with its picture's top, in the pictures' order.
  pictureCards(i, b, focus, list) {
    const d = this.data.get(b.key);
    this.blockNoteCards(i, b, this.pictureMemoOf(b), focus, list, card => ({ at: card.picture, want: this.noteTop(i, d, card.picture) }));
  }

  pictureMemoOf(b) {
    const kept = this.cardMemo.get(b.key);
    if (kept && kept.content === b.content && kept.kind === PICTURE_NOTES_MEMO) return kept;
    const cards = this.pictureNotes(b).map((c, index) => {
      const { when, text } = readNote(c.note);
      return { c, index, picture: c.picture, when, text, look: cardLook({ text, header: true }) };
    });
    const memo = { content: b.content, kind: PICTURE_NOTES_MEMO, cards };
    this.cardMemo.set(b.key, memo);
    return memo;
  }

  // One `block` card a comment of block b (page index i), placed by `placeOf(card)` -> { at, want }; `cell` for the
  // comments in a table's cells.
  blockNoteCards(i, b, memo, focus, list, placeOf, cell = false) {
    for (const card of memo.cards) {
      const { c, index, when, text } = card, mine = Boolean(focus?.block) && focus.key === b.key && Boolean(focus.cell) === cell && focus.index === index;
      const id = cell ? `md-card-${b.key}-cell-${index}` : `md-card-${b.key}-${index}`, look = mine ? cardLook({ text, header: true, full: true }) : card.look;
      list.push({ id, key: b.key, index, c, when, text: look.text, i, ...placeOf(card), h: this.raisedH(id, look.h), active: mine, editing: mine && focus.editing, block: true, cell });
    }
  }

  // The card of the comment being written, at the start of the text it goes on.
  newCard() {
    const i = this.at.get(this.activeKey), at = this.note.range.start, id = NEW_CARD;
    const look = cardLook({ text: this.noteField.value(), header: true, full: true });
    return { id, key: this.activeKey, index: -1, c: null, when: null, text: "", i, at, want: this.rowTop(i, this.blocks[i], null, at), h: this.raisedH(id, look.h), active: true, editing: true };
  }

  // The card of a comment being written on code block, diagram or table `key`, level with its top, after its cards; or
  // on its picture `picture`, level with the picture's top, among the cards of the pictures around it.
  newBlockCard({ key, picture }) {
    const i = this.at.get(key), d = this.data.get(key);
    if (i === undefined || !d) return null;
    const look = cardLook({ text: this.noteField.value(), header: true, full: true }), at = picture >= 0 ? picture : this.shownNotes(key)?.points.length ?? 0;
    return { id: NEW_CARD, key, index: -1, c: null, when: null, text: "", i, at, want: this.noteTop(i, d, picture), h: this.raisedH(NEW_CARD, look.h), active: true, editing: true, block: true, adding: true };
  }

  // The page y that block data d's comments are level with (page index i): its top, or its picture `picture`'s.
  noteTop(i, d, picture = -1) {
    const box = picture >= 0 ? this.pictureOf(d.key, d.pictureW).boxes[picture] : null;
    return this.sums[i] + d.space + (box?.y ?? 0);
  }

  raisedH(id, estimate) {
    return this.raised?.id === id ? this.raised.h : estimate;
  }

  // The column y of the row holding field offset `at` of block b (index i): the edited block's from its field, another
  // one's from its own field's token layout, the rows wrapped as the field wraps them. A block more than a screen away
  // has no field: its value as written stands in for what it draws, as making a token layout for every commented block
  // would cost milliseconds each in Herdr.
  rowTop(i, b, memo, at) {
    if (b.key === this.activeKey) return this.caretTop(i, at);
    const d = this.data.get(b.key), asField = d.mode === "field", c = this.chromeOf(d, asField), own = this.blockFields.get(b.key);
    const r = own?.rich && own.value === memo.value ? own.rich : null, drawn = r ? r.drawn : memo.value;
    return this.sums[i] + c.y + this.estimateIn(d, drawn, r ? drawnOffset(r, at) : at, c.w, asField).row * d.row;
  }

  // What a commented block's cards are read from, kept while its content stays the same: its field value and cards.
  cardMemoOf(b) {
    const kept = this.cardMemo.get(b.key);
    if (kept && kept.content === b.content && kept.kind === b.kind) return kept;
    const value = fieldOf(this.doc, b).value, memo = { content: b.content, kind: b.kind, value, cards: cardsOf(value) };
    this.cardMemo.set(b.key, memo);
    return memo;
  }

  // The cards near the viewport, drawn in the scrolled page so that they move with it as the text does.
  marginCards(t) {
    const list = this.cardList();
    if (!list.length) return [];
    const top = this.offset - COLUMN.padTop - CARD_SLACK, bottom = top + (this.viewport ? this.viewH() : UNSIZED_VIEW_H) + 2 * CARD_SLACK;
    const writable = !this.file || this.editable(), now = new Date();
    return list.filter(e => e.top + e.h > top && e.top < bottom).map(e => this.marginCard(e, writable, now, t));
  }

  // A press on a card makes its comment active, one on its text edits it. The active card stands out and grows with
  // its text; the others are as tall as cardLook says, so they never overlap.
  marginCard(e, writable, now, t) {
    const m = this.margin;
    return v_flex().id(e.id).absolute().left(m.cardLeft).top(COLUMN.padTop + e.top).w(m.cardW).p(CARDS.pad).gap(CARDS.rowGap)
      .rounded(8).border_1().bg(t.raised).border_color(e.active ? deepHighlightColor(t) : t.border).cursor_pointer()
      .when(e.active, el => el.shadow_lg().on_size_change((size, cx) => this.cardSized(e.id, size, cx)))
      .when(!e.active, el => el.h(e.h).overflow_hidden())
      .when(e.editing, el => el.on_mouse_down_out((_e, cx) => this.cardOut(e, cx)))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.cardDown(e, false, cx); })
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .children(this.cardBody(e, writable, now, t));
  }

  // The card's header (its time, "Comment" for a note written with none) and, on the active card of a file that can be
  // edited, Edit and Resolve; then its text, or the field it is edited in.
  cardBody(e, writable, now, t) {
    const buttons = e.active && writable && Boolean(e.c), out = [];
    const button = (name, icon, tip, run) => h_flex().id(`${e.id}-${name}`).size(CARDS.headH).flex_none().items_center().justify_center()
      .rounded(5).cursor_pointer().tooltip(tip).hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); run(cx); })
      .child(svg(ICON(icon)).size(14).flex_none().text_color(t.muted));
    out.push(h_flex().id(`${e.id}-head`).h(CARDS.headH).flex_none().items_center().gap(6)
      .child(svg(ICON("message-square")).size(13).flex_none().text_color(t.dim))
      .child(div().id(`${e.id}-time`).flex_1().min_w(0).truncate().text_size(CARD_TIME_SIZE).text_color(t.dim).child(timeLabel(e.when, now) || "Comment"))
      .when(buttons && !e.editing, el => el.child(button("edit", "pencil", "Edit", cx => this.cardDown(e, true, cx))))
      .when(buttons, el => el.child(button("resolve", "check", "Resolve", cx => (e.block ? this.resolveBlockNoteAt(e.key, e.index, cx, e.cell) : this.resolveCard(e, cx))))));
    if (e.editing) {
      out.push(div().id(`${e.id}-input`).w_full().key_context(NOTE)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.noteField).w_full().text_size(CARDS.textSize).line_height(CARDS.lineH / CARDS.textSize).text_color(t.foreground)));
    } else {
      out.push(div().id(`${e.id}-text`).w_full().whitespace_normal().text_size(CARDS.textSize).line_height(CARDS.lineH / CARDS.textSize)
        .text_color(t.foreground)
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.cardDown(e, true, cx); })
        .child(e.text));
    }
    return out;
  }

  // The active card reports its height: the cards under it follow.
  cardSized(id, size, cx) {
    const h = size.height / zoom();
    if (this.raised?.id === id && this.raised.h === h) return;
    this.raised = { id, h };
    cx.notify();
  }

  // A press on a card makes its comment active, as a press on its text does; one on the card's text edits it there. A
  // press on the card of a picture picked with its comment lets the picture go.
  cardDown(e, onText, cx) {
    if (!this.editable() || !e.c || this.activeComment()?.editing) return;
    if (e.block) {
      if (!e.active || this.picked) this.pickBlockNote(e.key, e.index, cx, e.cell);
      if (onText) this.startBlockEdit(cx);
      return;
    }
    if (this.pickComment(e.key, e.index, cx) && onText) this.editPicked(cx);
  }

  // A press outside a card being written or edited closes it, writing nothing.
  cardOut(e, cx) {
    if (e.adding && e.block) return this.closeBlockAddOut(cx);
    return e.block ? this.closeBlockEdit(cx) : this.closeNote(cx);
  }

  // Comment `index` of block `key` picked: the block is the edited one, all of the comment selected in its field, which
  // keeps the keyboard. -> whether it was.
  pickComment(key, index, cx) {
    const b = this.blockByKey(key);
    if (!b || !isText(b)) return false;
    if (key !== this.activeKey) {
      const c = noted(fieldOf(this.doc, b).value)[index];
      if (!c || !this.activate(key, { start: c.start, end: c.end }, cx, { reveal: false })) return false;
    }
    this.syncField(cx);
    const c = noted(this.seen)[index], span = c && parsedInline(this.seen, this.defsNow().map).spans.find(sp => sp.kind === c.kind && sp.start === c.start);
    if (!span) return false;
    this.pickElement(span, cx);
    this.focusField(cx);
    return true;
  }

  // The picked comment's text in the box that edits it: its card in the margin, else the comment box over it.
  editPicked(cx) {
    const picked = this.elementNow(), c = picked && noted(this.seen).find(x => x.start === picked.span.start);
    if (c) this.showNote({ kind: "edit", range: this.known, text: noteText(c.note), comment: c }, cx);
  }

  // Resolve on the active card: the comment's marks and note go, its text stays and is selected, as one entry of the
  // history.
  resolveCard(e, cx) {
    if (!this.editable() || e.key !== this.activeKey) return;
    this.syncField(cx);
    const c = noted(this.seen)[e.index];
    if (c) this.resolveIn(c, this.known.valid ? this.known : { start: c.start, end: c.end }, cx);
  }

  resolveIn(c, range, cx) {
    const value = this.seen;
    this.element = null; this.note = null;
    this.typeChange(value, range, resolveComment(value, c), cx);
    this.focusField(cx);
    this.checkMargin(cx);
    cx.notify();
  }

  blockNoteNow() {
    const n = this.blockNote;
    return n && this.doc && n.index < this.blockNotesOf(n.key, n.cell).length ? n : null;
  }

  // Block `key`'s comments as its cards show them: a code block's, diagram's or table's from its comments paragraph, a
  // paragraph of pictures' from around its pictures, a table's `cell` comments from its cells; [] for none.
  blockNotesOf(key, cell = false) {
    if (cell) {
      const b = this.blockByKey(key);
      return b?.kind === "table" ? this.cellNotesOf(b).cards : [];
    }
    const owned = this.notesNow().owners.get(key);
    if (owned) return owned.points;
    const b = this.blockByKey(key);
    return b?.image ? this.pictureNotes(b) : [];
  }

  // The splices that edit and resolve block b's comment `index` (among its `cell` comments, for those of a table's
  // cells), and what their history entry says: one of a block opens nothing when undone or redone, one of a picture
  // picks the picture (its start, the splice's caret).
  noteEdit(b, index, note, cell = false) {
    if (cell) return editCellNote(this.doc, b, index, note);
    if (!b.image) return editBlockNote(this.doc, b, index, note);
    const at = this.notePicture(b.key, index);
    return at < 0 ? null : editPictureNote(this.doc, b, at, note);
  }

  noteResolve(b, index, cell = false) {
    if (cell) return resolveCellNote(this.doc, b, index);
    if (!b.image) return resolveBlockNote(this.doc, b, index);
    const at = this.notePicture(b.key, index);
    return at < 0 ? null : resolvePictureNote(this.doc, b, at);
  }

  noteMeta(b, s) {
    return b.image ? { caretBefore: s.caret, caretAfter: s.caret } : { opensNothing: true };
  }

  blockNoteEditing() {
    return Boolean(this.blockNoteNow()?.editing) && this.editable();
  }

  setBlockNote(next, cx) {
    const was = this.blockNote?.key;
    this.blockNote = next;
    this.redraw([...new Set([was, next?.key])].filter(Boolean), cx);
    cx?.notify();
  }

  endBlockNote(cx) {
    if (this.blockNote) this.setBlockNote(null, cx);
  }

  // A press on a block's or a picture's card: its comment active and the block, or the picture, framed, opening nothing;
  // a picked picture is let go. A table cell's comment (`cell`) deepens its cell's text instead of a frame. The editing
  // of another block ends and the page has the keyboard; the block itself, when edited, stays so with the keyboard in
  // its field.
  pickBlockNote(key, index, cx, cell = false) {
    this.closeCard(cx);
    this.setSel(null, cx);
    this.unpick(cx);
    this.letLanguagesGo(cx);
    if (this.activeKey && this.activeKey !== key) this.deactivate(cx);
    this.setBlockNote({ key, index, editing: false, cell }, cx);
    this.giveBackKeyboard();
  }

  startBlockEdit(cx) {
    const n = this.blockNoteNow();
    if (!n || !this.editable()) return;
    const text = noteText(this.blockNotesOf(n.key, n.cell)[n.index].note);
    this.setBlockNote({ ...n, editing: true }, cx);
    this.guard(() => {
      this.noteField.set_value(text);
      this.noteField.set_selected_range({ start: text.length, end: text.length });
    });
    this.noteField.focus();
  }

  // The edited block is committed first, so it stays edited with its caret.
  saveBlockNote(cx) {
    const n = this.blockNoteNow(), text = this.noteField.value();
    if (!n?.editing) return;
    if (!oneLine(text)) return this.resolveBlockNoteAt(n.key, n.index, cx, n.cell);
    this.commit(cx);
    const b = this.blockByKey(n.key), s = b && this.noteEdit(b, n.index, text, n.cell);
    this.setBlockNote(this.editedBlockNote(n), cx);
    if (s) this.change(s, cx, this.noteMeta(b, s));
    this.giveBackKeyboard();
  }

  cancelBlockNote(cx) {
    this.closeBlockEdit(cx);
    this.giveBackKeyboard();
  }

  closeBlockEdit(cx) {
    const n = this.blockNote;
    if (n?.editing) this.setBlockNote(this.editedBlockNote(n), cx);
  }

  // A block's comment once its edit is closed: active again on its card, or ended with the floating box that a pane
  // without a margin edits it in, as no card would say which comment the frame marks.
  editedBlockNote(n) {
    return this.margin ? { ...n, editing: false } : null;
  }

  // A press on block `key`'s Comment button, which goes no further: as a press on the page does, it lets a block
  // selection go.
  commentPress(key, cx) {
    this.setSel(null, cx);
    this.openBlockAdd(key, cx);
  }

  // A new comment on code block, diagram or table `key`: written in a card level with the block, or in the box over it
  // where there is no margin, the block framed in the highlight colour. Every other comment box, card and menu closes,
  // writing nothing; the editing of another block ends, the block's own goes on.
  openBlockAdd(key, cx) {
    const target = this.blockByKey(key);
    if (!this.editable() || !target || !ownsNotes(target)) return;
    const edited = key === this.activeKey;
    if (edited) this.commit(cx);
    else if (this.activeKey) this.deactivate(cx);
    const b = this.blockByKey(edited ? this.activeKey : key);
    if (!b || !ownsNotes(b)) return;
    this.unpick(cx);
    this.startBlockAdd({ key: b.key, act: this.act, caret: edited ? this.caretNow() : null, picture: -1 }, cx);
  }

  // The new comment `add` (as `blockAdd` holds it) takes the note field, empty; every other comment box, card and menu
  // closes, writing nothing.
  startBlockAdd(add, cx) {
    const was = this.blockAdd?.key;
    this.closeCard(cx);
    this.endBlockNote(cx);
    this.dropLanguages(cx);
    this.blockAdd = add;
    this.guard(() => {
      this.noteField.set_value("");
      this.noteField.set_selected_range({ start: 0, end: 0 });
    });
    this.noteField.focus();
    this.revealBlockAdd(cx);
    this.redraw([...new Set([was, add.key])].filter(Boolean), cx);
    cx.notify();
  }

  // The page scrolls the least that shows where the new comment is written: its card, else the top edge of its block
  // or picture, as the box is not drawn while that edge is off the pane.
  revealBlockAdd(cx) {
    const a = this.blockAddNow(), i = a ? this.at.get(a.key) : undefined, d = a && this.data.get(a.key);
    if (i === undefined || !d || !this.viewport || this.sums.length !== this.blocks.length + 1) return;
    const card = this.margin ? this.cardList().find(e => e.id === NEW_CARD) : null;
    const y = COLUMN.padTop + (card ? card.top : this.noteTop(i, d, a.picture)), rowPx = card ? Math.min(card.h, this.viewH() / 2) : 0;
    const next = keepInView({ offset: this.offset, viewportH: this.viewH(), y, rowPx, contentH: this.contentH() });
    if (next !== this.offset) this.scrollTo(next, cx);
  }

  blockAddNow() {
    const a = this.blockAdd;
    return a && a.act === this.act && this.editable() && this.blockByKey(a.key) ? a : null;
  }

  blockAddOpen() {
    return Boolean(this.blockAddNow());
  }

  // Enter in the new comment's card or box: the comment stamped with the time as one entry of the history, a block's
  // under it with an undo that opens nothing, a picture's as savePictureAdd writes it; an empty one writes nothing.
  saveBlockAdd(cx) {
    const a = this.blockAddNow(), text = this.noteField.value();
    if (!a) return this.cancelBlockAdd(cx);
    if (a.picture >= 0) return this.savePictureAdd(a, text, cx);
    this.commit(cx);
    const b = this.blockByKey(a.key), s = b && addBlockNote(this.doc, b, text, new Date());
    this.closeBlockAdd(cx);
    if (s) this.change(s, cx, { opensNothing: true });
    this.checkMargin(cx);
    this.backFromBlockAdd(a, cx);
  }

  // A picture's new comment, written around it; the picture stays picked, and undo and redo pick it too.
  savePictureAdd(a, text, cx) {
    const b = this.blockByKey(a.key), s = b?.image ? addPictureNote(this.doc, b, a.picture, text, new Date()) : null;
    this.closeBlockAdd(cx);
    if (s) this.pictureChange(s, s.caret, s.caret, cx);
    else this.handle.focus();
    this.checkMargin(cx);
  }

  cancelBlockAdd(cx) {
    const a = this.blockAdd;
    this.closeBlockAdd(cx);
    if (a) this.backFromBlockAdd(a, cx);
  }

  closeBlockAdd(cx) {
    const a = this.blockAdd;
    if (!a) return;
    this.blockAdd = null;
    this.redraw([a.key], cx);
    cx?.notify();
  }

  // A press outside the new comment's card or box: what it lands on may take the keyboard after.
  closeBlockAddOut(cx) {
    this.closeBlockAdd(cx);
    this.giveBackKeyboard();
  }

  // The keyboard goes back where the new comment took it from: the edited block's field with its caret, which the page
  // scrolls back to when showing the comment took it off the pane, else the page.
  backFromBlockAdd(a, cx) {
    if (!a.caret || a.key !== this.activeKey) return this.giveBackKeyboard();
    this.selectField(a.caret);
    this.focusField(cx);
    this.revealCaret(cx);
  }

  resolveBlockNoteAt(key, index, cx, cell = false) {
    if (!this.editable()) return;
    this.commit(cx);
    const b = this.blockByKey(key), s = b && this.noteResolve(b, index, cell);
    this.endBlockNote(cx);
    if (s) this.change(s, cx, this.noteMeta(b, s));
    this.checkMargin(cx);
    this.giveBackKeyboard();
  }

  // The picked comment's card under its text, while the comments have no margin to show in. Presses on it go no
  // further; one outside closes it.
  commentFloat({ span, extent }, t) {
    const comments = this.margin ? [] : noted(this.seen), index = comments.findIndex(x => x.start === span.start), c = comments[index];
    if (!c) return null;
    const { when, text } = readNote(c.note), look = cardLook({ text, header: true, full: true });
    const place = this.placeBar(extent, { w: CARDS.w, h: this.raisedH(FLOAT_CARD, look.h) }, popoverPlace);
    if (!place) return null;
    const e = { id: FLOAT_CARD, key: this.activeKey, index, c, when, text, active: true, editing: false };
    return v_flex().id(FLOAT_CARD).absolute().left(place.left).top(place.top).w(place.w).p(CARDS.pad).gap(CARDS.rowGap)
      .rounded(8).border_1().bg(t.popover).border_color(deepHighlightColor(t)).shadow_lg()
      .on_size_change((size, cx) => this.cardSized(FLOAT_CARD, size, cx))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_move((_e, cx) => cx.stop_propagation())
      .on_mouse_down_out(() => this.elementPressOut())
      .children(this.cardBody(e, true, new Date(), t));
  }

  calSized(gen, name, part, size, cx) {
    if (gen !== this.calGen || !this.calibrating) return;
    const z = zoom(), sizes = (this.calSizes[name] ??= {});
    sizes[part] = part === "adv" ? size.width / z : size.height / z;
    if (!["tv1", "tv3", "f1", "f3", "adv"].every(p => sizes[p] > 0)) return;
    const st = STYLES[name], rowTV = (sizes.tv3 - sizes.tv1) / 2, rowF = (sizes.f3 - sizes.f1) / 2;
    if (!(rowTV > 0) || !(rowF > 0)) return;
    const cTV = sizes.tv1 - rowTV, cF = sizes.f1 - rowF;
    const sample = st.mono ? CAL_MONO : CAL_SAMPLE;
    this.calNext[name] = { row: rowTV, ratio: rowTV / st.size, padActive: Math.max(0, cTV - cF), padRendered: Math.max(0, cF - cTV), advance: sizes.adv / sample.length };
    if (!CALIBRATED.every(n => this.calNext[n])) return;
    this.cal = this.calNext;
    this.endCalibration(cx);
  }

  endCalibration(cx) {
    this.calibrating = false;
    if (this.doc) this.rebuild(cx, this.anchor());
    cx.notify();
  }

  // A draw may not notify, so a theme, font or zoom change is handled on a timer.
  checkLook(t, cx) {
    const look = [Object.values(t).join(), this.fonts.sans, this.fonts.mono, zoom()].join("|");
    if (this.look === look) return;
    const first = this.look === null;
    this.look = look;
    this.highlight = highlightColor(t);
    this.deep = deepHighlightColor(t);
    if (!first) cx.timer.after(0, cx => this.restyle(cx));
  }

  restyle(cx) {
    if (this.closed) return;
    ++this.calGen;
    this.calibrating = true; this.calNext = {}; this.calSizes = {};
    if (!this.inline) for (const e of [...this.entities.values(), this.column]) if (e) cx.notify(e);
    if (this.doc && this.mode === "reading") this.rebuild(cx, this.anchor());
    cx.notify();
  }

  // Only Reading draws the samples, so a run started in Markdown or while loading waits for it: its clock starts
  // when its samples are first drawn.
  giveUpLater(cx) {
    const gen = this.calGen;
    if (!gen || this.calTimed === gen) return;
    this.calTimed = gen;
    cx.timer.after(CAL_GIVE_UP_MS, cx => { if (!this.closed && this.calGen === gen && this.calibrating) this.endCalibration(cx); });
  }

  // The samples get ids of their own in each run, so that each run's elements report their first size.
  calStrip(t) {
    const { sans, mono } = this.fonts, gen = this.calGen, base = gen ? `md-cal${gen}` : "md-cal";
    const strip = v_flex().id(base).absolute().top(-10000).left(0).w(600);
    for (const name of CALIBRATED) {
      const st = STYLES[name], s = this.calStates[name], font = st.mono ? mono : sans;
      const typed = el => el.font_family(font).text_size(st.size).font_weight(st.weight).line_height(st.lh).text_color(t.foreground);
      const shown = (part, rows) => (st.mono
        ? typed(v_flex().w_full()).children(Array.from({ length: rows }, () => div().child("Ag")))
        : typed(div().w_full()).child(TextView.markdown(`${base}-${name}-${part}-view`, Array(rows).fill("Ag").join("\\\n"))));
      const measured = (part, el) => div().id(`${base}-${name}-${part}`).w_full().on_size_change((size, cx) => this.calSized(gen, name, part, size, cx)).child(el);
      const input = state => Textarea.new(state).w_full().font_family(font).text_size(st.size).font_weight(st.weight).line_height(st.lh);
      strip.child(measured("tv1", shown("tv1", 1))).child(measured("tv3", shown("tv3", 3)))
        .child(measured("f1", input(s.f1))).child(measured("f3", input(s.f3)))
        .child(h_flex().child(typed(div().id(`${base}-${name}-adv`).flex_none().whitespace_nowrap())
          .on_size_change((size, cx) => this.calSized(gen, name, "adv", size, cx)).child(st.mono ? CAL_MONO : CAL_SAMPLE)));
    }
    return strip;
  }

  counts() {
    const text = this.text.length > BIG ? this.settled : this.text;
    if (this.countsFor !== text) { this.countsFor = text; this.countList = stats(text); }
    return this.countList;
  }

  status(t) {
    const dirty = this.text !== this.disk;
    if (this.conflict !== null) return { text: "Conflict", color: t.blocked };
    if (this.missing) return { text: "Deleted", color: t.blocked };
    if (this.saveError) return { text: "Not saved", color: t.blocked, tip: this.saveError };
    if (this.remote) return { text: `Read-only · ${this.machine}`, color: t.muted };
    if (this.locked) return { text: this.locked, color: t.muted };
    if (this.saving !== null) return { text: "Saving…", color: t.muted };
    if (dirty) return { text: "Unsaved", color: t.muted, dot: t.accent };
    return { text: "Saved", color: t.dim };
  }

  saveState(t) {
    const status = this.status(t);
    return h_flex().id("md-status").flex_none().gap(6).items_center().text_color(status.color)
      .when(Boolean(status.tip), el => el.tooltip(status.tip))
      .when(Boolean(status.dot), el => el.child(div().size(6).flex_none().rounded(3).bg(status.dot)))
      .child(status.text);
  }

  toolbar(t) {
    const labels = (this.size?.width ?? Infinity) >= WIDE, on = this.mode === "markdown";
    const toggle = h_flex().id("md-markdown").h(26).flex_none().px(labels ? 10 : 8).gap(5).items_center().rounded(7).border_1().border_color(t.border)
      .cursor_pointer().text_size(12).text_color(on ? t.foreground : t.muted)
      .when(on, el => el.bg(t.selected))
      .when(!on, el => el.hover(s => s.bg(t.hover)))
      .when(!labels, el => el.tooltip("Markdown"))
      .on_click((_e, cx) => this.toggle(cx))
      .child(svg(ICON("code")).size(13).flex_none())
      .when(labels, el => el.child("Markdown"));
    return h_flex().id("md-toolbar").h(40).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
      .child(image(MARKDOWN_ICON).w(14).h(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().font_medium().child(this.file ? basename(this.file) : "Markdown"))
      .child(toggle);
  }

  banner(t) {
    const act = (id, label, primary, run) => div().id(id).h(26).px(10).flex().items_center().flex_none().rounded(6).cursor_pointer().text_size(12)
      .bg(primary ? t.solid : t.hover).text_color(primary ? t.solid_foreground : t.foreground)
      .on_click((_e, cx) => run(cx))
      .child(label);
    let title, detail, buttons = [];
    if (this.conflict !== null) {
      title = "Changed on disk";
      detail = "This file was saved by something else while you had unsaved changes.";
      buttons = [act("md-keep-mine", "Keep mine", true, cx => this.keepMine(cx)), act("md-load-theirs", "Load theirs", false, cx => this.loadTheirs(cx))];
    } else if (this.missing) {
      title = "This file was deleted or moved";
      detail = this.saveError ? `Couldn't save it again: ${this.saveError}` : this.remote ? "" : "What is here is not saved anywhere else.";
      if (!this.remote) buttons = [act("md-save-again", "Save again", true, cx => this.saveAgain(cx))];
    } else if (this.saveError) {
      title = "Couldn't save";
      detail = this.saveError;
    } else return null;
    return h_flex().id("md-banner").flex_none().px(14).py(10).gap(12).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(12.5)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().font_medium().child(title))
        .when(Boolean(detail), el => el.child(div().text_size(12).text_color(t.muted).child(detail))))
      .children(buttons);
  }

  page(t, cx) {
    const vp = div().id("md-viewport").relative().flex_1().min_h(0).w_full().overflow_hidden()
      .on_size_change((size, cx) => this.viewportSized(size, cx))
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .on_mouse_down("left", (e, cx) => this.viewportDown(e, cx))
      .on_mouse_up("left", (e, cx) => this.viewportUp(e, cx))
      .on_mouse_down("right", (e, cx) => this.viewportRightDown(e, cx))
      .on_mouse_move((e, cx) => this.viewportMove(e, cx))
      .on_hover((hovered, cx) => this.viewportHover(hovered, cx))
      .on_drop((e, cx) => this.dropped(e, cx));
    if (!this.blocks.length) {
      if (!this.editable()) vp.child(div().id("md-note-empty").absolute().left(0).right(0).top(0).bottom(0).flex().items_center().justify_center().text_color(t.muted).child("This note is empty."));
    } else {
      const column = this.inline
        ? v_flex().id("md-column").w_full().children(this.mountedItems(k => renderBlock(this, this.data.get(k))))
        : this.column;
      const m = this.margin, page = div().id("md-page").px(COLUMN.padX).pt(COLUMN.padTop).pb(COLUMN.padBottom).child(column);
      vp.child(div().id("md-scroller").absolute().left(0).right(0).top(-this.offset)
        .child(m ? page.w(m.pageW).ml(m.pageLeft) : page.w_full().max_w(COLUMN.maxWidth).mx_auto())
        .children(this.marginCards(t)));
      const g = this.thumbGeometry();
      if (g) {
        vp.child(div().id("md-thumb").absolute().right(3).top(g.top).w(6).h(g.h).min_h(28).rounded(3).bg(this.thumb ? t.muted : t.border)
          .hover(s => s.bg(t.muted))
          .on_mouse_down("left", (e, cx) => this.thumbDown(e, cx)));
      }
    }
    const card = this.commentsCard(t);
    if (card) vp.child(card);
    const note = this.noteBox(t);
    if (note) vp.child(note);
    const menu = this.slashMenu(t);
    if (menu) vp.child(menu);
    const bar = this.barPlaces();
    if (bar) vp.child(this.formatBar(bar, t));
    if (bar?.menu) vp.child(this.barMenuOf(bar, t));
    const float = this.elementFloat(t);
    if (float) vp.child(float);
    const picture = this.pictureFloat(t);
    if (picture) vp.child(picture);
    const languages = this.languageMenu(t);
    if (languages) vp.child(languages);
    if (this.calibrating) {
      vp.child(this.calStrip(t));
      this.giveUpLater(cx);
    }
    return vp;
  }

  sourceBox(mono) {
    const inner = this.viewer
      ? CodeView.new(this.viewer).size_full()
      : Textarea.new(this.source).size_full().font_family(mono).text_size(13.5);
    return div().id("md-source").flex_1().min_h(0).flex()
      .child(v_flex().id("md-source-column").w_full().max_w(860).h_full().mx_auto().px(24).py(16).key_context(SOURCE)
        .child(inner));
  }

  diagramStatus() {
    if (this.mode !== "reading" || !this.doc) return "";
    const all = this.diagramKeys.map(key => this.shown.get(key)).filter(Boolean);
    if (!all.length) return "";
    if (this.diagrams.nodeMissing) return "Diagrams need Node.js";
    if (this.diagrams.renderer === null) return "Diagrams need the mermaid renderer: run install.sh";
    if (all.some(d => d.state === "pending")) return "Drawing diagrams…";
    const bad = all.filter(d => d.state === "error").length;
    return count(all.length, "diagram", "diagrams") + (bad ? ` · ${count(bad, "error", "errors")}` : "");
  }

  footer(t) {
    const { words, lines } = this.counts(), status = this.diagramStatus(), comments = this.mode === "reading" ? this.commentCount() : 0;
    const path = !this.file ? "" : this.remote ? `${this.machine}:${this.file}` : tildePath(this.file, home());
    return h_flex().id("md-footer").h(26).flex_none().px(14).gap(12).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
      .child(this.saveState(t))
      .child(div().id("md-counts").flex_none().child(`${count(words, "word", "words")} · ${count(lines, "line", "lines")}`))
      .when(comments > 0, el => el.child(div().id("md-comments").flex_none().child(count(comments, "comment", "comments"))))
      .when(Boolean(status), el => el.child(div().id("md-diagrams").flex_none().child(status)))
      .child(div().flex_1().min_w(0).truncate().text_right().child(path));
  }

  message(t, text) {
    return div().flex_1().flex().items_center().justify_center().px(24).text_center().text_color(t.muted).child(text);
  }

  render(cx) {
    this.claim(cx);
    this.syncHead(cx);
    const t = theme();
    this.fonts = { sans: sansFont(cx), mono: monoFont() };
    this.checkLook(t, cx);
    if (this.mode === "reading" && this.loaded) this.checkWindow(cx);
    let root = v_flex().id("md-root").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .font_family(this.fonts.sans).text_size(13)
      .on_key_down((e, cx) => this.keys(e, cx))
      .on_mouse_up("left", () => this.keepKeyboard())
      .on_size_change((size, cx) => this.rootSized(size, cx));
    for (const name of ACTIONS) root = root.on_action(name, (_e, cx) => this.action(name, cx));
    if (!this.loaded) return root.child(this.message(t, "Loading…"));
    if (this.error) return root.child(this.message(t, this.error));
    const body = this.readWhenParsed ? this.message(t, "Loading…") : this.mode === "markdown" ? this.sourceBox(this.fonts.mono) : this.page(t, cx);
    const banner = this.banner(t);
    return root.when(!this.headed(), el => el.child(this.toolbar(t))).when(Boolean(banner), el => el.child(banner)).child(body).child(this.footer(t));
  }

  rootSized(size, cx) {
    const z = zoom(), width = size.width / z, height = size.height / z;
    if (width === this.size?.width && height === this.size?.height) return;
    const wider = width !== this.size?.width;
    this.size = { width, height };
    if (wider && this.mode === "reading" && this.doc) this.rebuild(cx, this.anchor());
    cx.notify();
  }
}
