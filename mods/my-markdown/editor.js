// A Markdown pane, alone in a tab or beside others: one file, shown as a page (Reading) or as its source (Markdown).
// The file on disk is the truth: what is typed is written back a moment later, only over the text this pane last
// saw there (so nothing another program wrote is overwritten without asking), and a change on disk shows up here as
// soon as the folder watcher says so.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState, TextView, Editor as CodeView, EditorState } from "gpui-base";
import { theme, settings, home, window, focused, panes, layout, shared, setShared, exec, readTextFile, writeTextFile, watchFolder, nextCommand, notify } from "herdr";
import { MODES, basename, dirname, docToSource, eolOf, fileKey, modeOf, resolveLink, sourceSplice, sourceToDoc, stats, tildePath, toSource, toggleMode, trimMap } from "./lib.js";
import { applySplice, closeFence, diff, docToField, fenceGuard, field as fieldOf, fieldToDoc, indent, insertAfter, insertAt, insertBefore, insertLines, isText, loneMarker, mergeIntoPrevious, mergeNext, move, nest, outdent, parse, parseInSteps, paste, remove, removeRange, reparse, retype, shortcut, split, toParagraph, toggleTask, type, unnest } from "./blocks.js";
import { COLUMN, FRAME, MENU, anchorBlock, blockAt, canZoom, caretRow, clampOffset, clampView, columnLeft, columnX, decideAxis, estimateHeight, frameBox, frameTool, isOneRow, maxOffset, menuPlace, nextCell, overflows, pageStep, passThrough, prefixSums, pressToField, revealAt, revealOffset as keepInView, sharpScale, slashX, startView, startsGesture, toolsTop, topDown, zoomAround, zoomStep } from "./geometry.js";
import { COMMANDS, follow, opensAt, step, track } from "./slash.js";
import { createHistory, mergeChange } from "./history.js";
import { openMarkdown, paneOf, registerPane, rememberRecent } from "./open.js";
import { Diagrams } from "./diagrams.js";
import { ACTIONS, SOURCE, installKeys } from "./keys.js";
import { Block, CALIBRATED, Column, FRONT_BOX, BOX, INDENT, MARKER_W, QUOTE_BAR, QUOTE_PAD, STYLES, displayText, isRaw, lookOf, markerOf, newOwnerId, owners, renderBlock, spaceBefore } from "./page.js";

const SAVE_MS = 700; // quiet time after typing before the file is saved
const LOCAL_POLL = 4000, REMOTE_POLL = 5000; // looking at the file again when nothing can tell us it changed
const MODES_KEY = "my-markdown.modes", MODES_MAX = 200;
// Shared with the my-pane header of integrations/pane-header (mods can't import each other, so it has the same names).
const HEADS_KEY = "my-markdown.heads", TOGGLE_KEY = "my-markdown.toggle", HEADER_MOD = "my-pane";
const MARKDOWN_ICON = "mods/my-markdown/file-markdown.svg";
const WIDE = 560; // below this width the toggle loses its label
const BIG = 50000; // a buffer longer than this is counted when it settles, not on every key
// A text this long is parsed on opening in slices of SLICE_MS, between which the app goes on: one parse of 1 MiB
// holds the whole app up for a third of a second or more.
const SLICE_FROM = 200 * 1024, SLICE_MS = 20;
const SANS = ".SystemUIFont";
// A character no file holds in practice: the caret readout writes it at the selection and finds it again.
const MARK = String.fromCharCode(0xffff);
const marks = s => s.split(MARK).length - 1;
// A change that leaves more MARKs than the field had is a readout's leftover; a file's own MARKs are text.
const addsMark = (d, before) => d.inserted.includes(MARK) && marks(d.inserted) > marks(before.slice(d.at, d.at + d.removed));
const ARROW_STEP = 48;
const MOVES = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
const CLICK_SLOP = 4;
const REVEAL_AT = 1 / 3;
const PARSE_OPTS = { armHeadings: true, armChecked: false };
const UNUSUAL = "Read-only: unusual characters";
const RULE_H = 24, DIAGRAM_H = 120;
const CAL_SAMPLE = "abcdefghij klmnopqrst uvwxyzABCD EFGHIJK";
const CAL_MONO = "0123456789abcdefghijklmnopqrstuvwxyz{}()";
// A field takes the keyboard once it is drawn: focus is asked for again this long after an activation.
const REFOCUS_MS = 80;
// After a mouse-up in the field its caret is read this long after, when the field has placed it.
const READ_AFTER_UP_MS = 30;
// An armed field that measures further than this from the block it replaced is not used for that block again.
const ARM_SLACK = 1;
const NO_CARET = { start: 0, end: 0, valid: false };
// Up to this many blocks the Column mounts every block; above it, only those within the margin of the viewport.
const MOUNT_ALL = 400;
const WINDOW_MARGIN = 1500, INLINE_MARGIN = 800;
// The page is laid out before the viewport reports its size: the first window is made for a page this tall.
const UNSIZED_VIEW_H = 1200;
// A recalibration whose samples, once drawn, never report sizes keeps the measurements it had.
const CAL_GIVE_UP_MS = 2000;
const UNDO_ACTIONS = { "mdb-undo": -1, "mdb-redo": 1 }, UNDO_KEYS = { "cmd-z": -1, "cmd-shift-z": 1 };
const SOURCE_TYPING = "source";
const spliceOf = d => ({ start: d.at, end: d.at + d.removed, insert: d.inserted });

const ICON = name => `mods/my-markdown/${name}.svg`;
const why = e => String(e?.message ?? e);
// What readTextFile says about a file over its 1 MiB limit is not written down anywhere: go by the usual words.
const tooBig = e => /mib|too (large|big)|exceed|larger than/i.test(why(e));
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// A path the watcher reports belongs to this file when it is the file, a folder above it (a root path means "look
// at everything"), or has its name (the watcher may spell the folder differently, /private/var for /var).
const touches = (path, file) => path === file || file.startsWith(path.endsWith("/") ? path : `${path}/`) || basename(path) === basename(file);
// Sizes and pointer positions come in screen pixels; the layout works in the pixels the zoom setting scales.
const zoom = () => Number(settings()?.zoom) || 1;
const windowPoint = e => (e?.position ? { x: e.position.x / zoom(), y: e.position.y / zoom() } : null);
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

const byKey = (doc, key) => doc.blocks.find(b => b.key === key) ?? null;
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

// A block not written yet (pending) is written with its first text by its `base`, (doc, text) -> splice: after the
// last block, after or before the block with a key. Its `steps` then run on the block that wrote.
const PLACEHOLDER = "x";
const atEnd = (doc, text) => {
  const last = doc.blocks.at(-1);
  return last ? insertAfter(doc, topIn(doc, last), "paragraph", text) : insertAt(doc, "paragraph", text);
};
const afterKey = (key, kind) => (doc, text) => {
  const b = byKey(doc, key);
  return b && insertAfter(doc, b, kind, text);
};
const beforeKey = (key, kind) => (doc, text) => {
  const b = byKey(doc, key);
  return b && insertBefore(doc, b, kind, text);
};
const STEPS = { indent, outdent, paragraph: toParagraph, nest, unnest };
const UNDOES = { indent: "outdent", outdent: "indent", nest: "unnest", unnest: "nest" };
// Splice `s` of doc, then each step (a name in STEPS, or (doc, block, caret) -> splice) on the block holding the caret
// the splice before it left: -> { splice (one splice of doc's text), doc (after it), block (the one the steps worked
// on) }, or null when one of them does not apply.
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
// What a pending block draws as: the block it would be once written, with no text yet.
function pendingRecord(key, b) {
  return Object.assign(b.copy(), {
    key, start: -1, end: -1, gapEnd: -1, subtreeEnd: -1, index: -1, lines: [], content: "", render: "", source: "",
    armable: false, image: false, task: b.task ? { checked: false, offset: -1 } : null,
  });
}
// Enter on a paragraph holding only these makes a code block or a rule.
const FENCE_TYPED = /^(```|~~~)[^`\n]*$/;
const RULE_TYPED = /^(---|\*\*\*|___)$/;
// The field of a fenced block or front matter with no line between its fences shows an empty one there, so that the
// caret never has to sit on a fence line; the source gets that line with the first change typed in the field.
const withInnerLine = (b, value) => {
  if (!b.fence && b.kind !== "frontmatter") return value;
  const first = value.indexOf("\n"), inner = first >= 0 && (b.closed === false || value.indexOf("\n", first + 1) >= 0);
  if (inner) return value;
  const end = first < 0 ? value.length : first;
  return `${value.slice(0, end)}\n${value.slice(end)}`;
};

// What `herdr-app check` opens (it gives no props, and every opener passes a file): every kind of block, drawn
// through renderBlock in the root, with block 2 in the field and its slash menu open, the spare field over block 4
// and the diagram in a frame wider than the column, its − % + group showing.
const FIXTURE = [
  "---", "title: my-markdown check fixture", "---",
  "# Every kind of block", "",
  "A paragraph with **bold**, _emphasis_, `code` and a [link](https://example.com). /", "",
  "Plain words only, so this paragraph can be armed.", "",
  "- A bullet item", "  - A nested item", "    - A third level", "- [ ] An open task", "- [x] A done task", "",
  "1. First", "2. Second", "",
  "> A quote with a [reference link][ref].", "",
  "```js", "const answer = 42;", "```", "",
  "```mermaid", "graph TD", "A-->B", "```", "",
  "    indented code", "",
  "| Column | Other |", "|--------|-------|", "| a      | b     |", "",
  "<div>Some html</div>", "",
  "<!-- a comment -->", "",
  "***", "",
  "[ref]: https://example.com", "",
  "![A picture](picture.png)", "",
  "A setext heading", "----------------", "",
].join("\n");
const FIXTURE_DIAGRAM = { key: "check-fixture", state: "ok", width: 1800, height: 300, scale: 2, error: null };

export class Editor {
  init(props, cx) {
    this.file = typeof props?.file === "string" && props.file ? props.file : null;
    this.machine = props?.machine ?? null;
    this.remote = Boolean(this.machine); // a file on another machine is read and followed, never written
    this.mode = "reading";
    // disk: the text the file had when we last looked (what a save must still find there); text: the buffer;
    // saving: the text being written now; conflict: what the file holds when it is not what we expected; relook: the
    // file changed while a write was out, and is looked at again once it answers.
    this.disk = ""; this.text = ""; this.settled = "";
    this.saving = null; this.conflict = null; this.missing = false; this.saveError = null;
    this.loaded = false; this.error = null; this.closed = false; this.locked = null;
    this.stamp = 0; this.checking = false; this.again = false; this.relook = false; this.lookAfterLoad = false;
    this.parsing = false; this.readWhenParsed = false;
    this.saveTask = null; this.pollTask = null;
    this.size = null;
    this.claimed = null; // the pane this copy is drawn in, once known (see claim)
    // The header's last toggle request is old news to a copy that starts after it.
    this.toggleSeen = shared(TOGGLE_KEY)?.n ?? null; this.headSig = null; this.headedFor = undefined; this.headedIs = false;
    this.countsFor = null; this.countList = { words: 0, lines: 0 };
    this.fonts = { sans: SANS, mono: monoFont() };
    this.handle = cx.focus_handle();
    // Herdr parses every context of the table: in the check fixture a refused table fails `herdr-app check`; an
    // editor of a file goes on without it, its fields typing as plain text fields do.
    this.keysBound = true;
    try { installKeys(cx); } catch (e) { if (!this.file) throw e; this.keysBound = false; }
    // Every change of the buffer must reach it, ours as entries and outside ones as a rebase: an entry's offsets are
    // only good for the text it left.
    this.history = createHistory();

    // The Markdown state: the source field shows `srcFor` mapped by `src`; `srcSeen` is its value as we last saw or
    // set it, `srcCaret` its caret while we know it.
    this.source = TextareaState.new({ value: "" });
    this.source.set_soft_wrap(true);
    this.source.on("change", (_e, cx) => this.sourceChanged(cx));
    this.src = toSource(""); this.srcFor = ""; this.srcSeen = ""; this.srcCaret = null;
    this.viewer = this.remote ? EditorState.new({ language: "markdown", readonly: true, line_numbers: false, folding: false, soft_wrap: true, font_family: monoFont(), font_size: 13.5 }) : null;

    // Reading: the blocks of `doc` (and a pending empty block among them), drawn by one Block entity each inside the
    // Column entity, in a viewport scrolled by `offset`. `sums` are the block tops from their measured (or estimated)
    // heights; `at` maps a key to its index in `blocks`; `win` is what the Column mounts of a long page (windowFor).
    this.doc = null; this.blocks = []; this.at = new Map(); this.order = []; this.diagramKeys = []; this.data = new Map(); this.entities = new Map();
    this.heights = new Map(); this.estimates = new WeakMap(); this.sums = [0]; this.offset = 0; this.viewport = null; this.reveal = null; this.win = null; this.winTimer = null;
    this.press = null; this.thumb = null; this.pointer = null; this.fieldPress = null; this.fieldHeld = null; this.dragFrom = null; this.linked = false;
    this.diagrams = new Diagrams();
    this.diagrams.onChange = cx => this.diagramsChanged(cx);
    this.shown = new Map(); this.good = new Map(); // block key -> what the diagram answered, and its last image
    // Diagram frames: `frames` the view ({ z, x, y }) of each frame panned or zoomed (none: its starting view),
    // `pan` a press on a frame ({ key, from, x0, y0, moved }), `hoverFrame` the frame under the pointer and
    // `hoverTop` where its − % + group sits, `gesture` the wheel gesture going on, `zoomed` the frames zoomed since
    // the zoom last rested.
    this.frames = new Map(); this.pan = null; this.hoverFrame = null; this.hoverTop = null; this.gesture = null;
    this.zoomed = new Set(); this.settleTimer = null;

    // The block being edited: `field` is its text state and `spare` the one armed over the block under the pointer;
    // the two trade places when a press lands in the spare. `f` is the block's field map (kept in step by the typing
    // splice), `seen` the field's value as last seen or set, `opened` its value when the block was opened, `known`
    // the caret while we know it, `act` the activation's number. `stale` says the text was typed into since `doc`.
    // `armedValue` is what the spare holds for the armed block; `armedNewText` says that block's text changed while
    // it was armed, so it has no rendered height for its text.
    this.field = TextareaState.new({ value: "" });
    this.spare = TextareaState.new({ value: "" });
    for (const s of [this.field, this.spare]) {
      s.set_auto_grow(1, 10000);
      s.set_soft_wrap(true);
      s.on("change", (_e, cx) => this.fieldChanged(s, cx));
      s.on("focus", (_e, cx) => this.fieldFocus(s, true, cx));
      s.on("blur", (_e, cx) => this.fieldFocus(s, false, cx));
    }
    this.activeKey = null; this.armedKey = null; this.armedValue = null; this.armedNewText = false; this.pending = null; this.pendings = 0;
    this.f = null; this.seen = ""; this.opened = ""; this.known = NO_CARET; this.act = 0; this.rows = "many";
    this.stale = false; this.reading = 0; this.stored = null; this.disarmed = new Set(); this.focusedState = null;
    this.ownKeyUp = null; this.menuKeyUp = null; this.revealNext = false; this.inbox = []; this.watching = false; this.swapping = false; this.shiftField = null;
    // `owed`: per field state, the change events still to come for changes already taken in: those of our own
    // replace() calls, and those of the user's typing that an action took in before its event came. A change that
    // leaves the value as it was and is none of those is forward Delete at the end of the field.
    this.owed = new Map();
    // Block selection: `sel` names its two ends by key, `selKeys` are the blocks it covers, `gens` each block's
    // TextView generation, raised to drop the TextView's own text selection when the block is selected.
    this.sel = null; this.selKeys = new Set(); this.gens = new Map();
    // The slash menu open in the field being edited (slash.js), or null.
    this.slash = null;

    // Calibration: `cal` is in use while `calNext` collects a run's measurements; `look` is the theme, fonts and zoom
    // the page was last drawn in, and a change of them runs calibration again (`calGen` names each run, `calTimed`
    // the last one whose give-up clock was started).
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
    rememberRecent(this.file, this.machine);
  }

  openFixture() {
    this.disk = this.text = this.settled = FIXTURE;
    this.loaded = true;
    this.doc = parse(FIXTURE, PARSE_OPTS);
    const active = this.doc.blocks[2], armed = this.doc.blocks[4];
    this.activeKey = active.key; this.armedKey = armed.key; this.armedValue = fieldOf(this.doc, armed).value;
    this.f = fieldOf(this.doc, active); this.seen = this.opened = this.f.value;
    this.guard(() => {
      this.field.set_value(this.seen);
      this.spare.set_value(this.armedValue);
    });
    const slashAt = this.seen.length - 1;
    this.slash = { act: this.act, at: slashAt, end: slashAt + 1, query: "", items: COMMANDS, index: 0, first: 0, side: null };
    const diagram = this.doc.blocks.find(b => b.kind === "mermaid");
    this.shown.set(diagram.key, FIXTURE_DIAGRAM); this.good.set(diagram.key, FIXTURE_DIAGRAM);
    this.hoverFrame = diagram.key;
    this.rebuild(null, null);
  }

  // The my-pane header shows this pane's file name and the Markdown toggle in place of the toolbar. This copy publishes
  // { name, mode } under its pane, and the header asks for a toggle by raising a counter under the pane.
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

  // The pane registry (open.js) needs this copy's pane, which only the draw knows: at init panes() does not list the
  // new pane yet, and Herdr draws a copy only while its tab is shown, so focused().tab is its own tab only then.
  // The write is a task of its own: a draw writes nothing shared.
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

  // A long text is parsed for the page a slice at a time: before the page first shows, or, for one that opens as
  // its source, in the background (parseAhead). -> its blocks, or null when the tab closed meanwhile.
  async parseInSlices(text, cx) {
    let until = 0;
    const steps = parseInSteps(text, PARSE_OPTS, () => Date.now() >= until);
    for (;;) {
      until = Date.now() + SLICE_MS;
      const r = steps.next();
      if (r.done) return r.value;
      await new Promise(done => cx.timer.after(0, () => done()));
      if (this.closed) return null;
    }
  }

  // The page's parse is of the text as it was when it began; refresh parses in what changed since. A page made
  // meanwhile (the text got short, and Reading parsed it at once) is the one edits go into, so it stays. A switch to
  // Reading asked for meanwhile (readWhenParsed) is made once it is done.
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

  // Reading waits for its page: a long text not parsed yet shows Loading… in place of its source until it is.
  // -> true while it waits.
  waitForPage(cx) {
    if (this.doc || this.text.length < SLICE_FROM) return false;
    this.sourceCaret();
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

  // A note with nothing in it opens with an empty paragraph to type in.
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
  // The state that shows takes it in at once (the source field with its caret on the same text, Reading by a
  // re-parse); the other one catches up when it is next shown.
  apply(text, cx, { disk = text, clear = false } = {}) {
    this.commit(cx);
    if (this.activeKey && !this.pending && !this.known.valid && this.editable()) {
      const c = this.caretOf(this.field);
      if (c) this.known = { start: c.start, end: c.end, valid: true };
    }
    if (clear) this.history.clear();
    else if (text !== this.text) this.history.rebase(spliceOf(diff(this.text, text)));
    this.text = this.settled = text;
    this.disk = disk;
    if (this.viewer) this.guard(() => this.viewer.set_value(text));
    if (this.mode === "markdown") this.patchSource();
    else this.refresh(cx);
  }

  // The buffer changed by an edit of ours. `rec`: history.record's meta, plus the `splice` that made `text` when known;
  // false when the caller has already put the change in the history (an undo or a redo moved its entry, or
  // history.amend folded it into the last one). edited() takes `rec` the same way.
  setText(text, cx, rec) {
    this.track(text, rec);
    this.text = text;
    if (text.length <= BIG) this.settled = text; // a small buffer is counted as it is typed
    this.scheduleSave(cx);
    if (this.mode === "reading") this.refresh(cx);
    cx.notify();
  }

  // The buffer changed by typing in a block's field: nothing is parsed until the block is committed.
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
    if (value === this.srcSeen) return; // our own edits, a readout, set_value reporting itself
    const d = diff(this.srcSeen, value);
    if (addsMark(d, this.srcSeen)) return this.restoreSource();
    const s = sourceSplice(this.src, d, eolOf(this.text), this.srcSeen.charAt(d.at - 1));
    this.srcSeen = value;
    this.srcCaret = { start: d.at + d.inserted.length, end: d.at + d.inserted.length };
    const text = applySplice(this.text, s);
    this.srcFor = text;
    this.setText(text, cx, { ...this.typing(SOURCE_TYPING, s.end, s.start + s.insert.length), splice: s });
  }

  // A field value that differs from what we last saw is typing that its change event has not told us about yet.
  syncSource(cx) {
    if (this.mode === "markdown" && !this.remote && !this.locked && this.source.value() !== this.srcSeen) this.sourceChanged(cx);
  }

  restoreSource() {
    const caret = this.srcCaret;
    this.guard(() => {
      this.source.set_value(this.srcSeen);
      if (caret) this.source.set_selected_range(caret);
    });
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
    this.src = map; this.srcFor = this.text; this.srcSeen = map.value; this.srcCaret = null;
    this.guard(() => this.source.set_value(map.value));
  }

  // A change not typed in the field (a disk change, an undo) goes in as a select and a replace, which keep its scroll.
  // The field's own undo could take that edit back and the autosave would write it over the file: without our key
  // table, which owns Cmd+Z there, it goes in by set_value, which clears that undo. The caret goes to document offset
  // `caret`, else follows its text. A "\r\n" pasted into the field is two characters there but one "\n" in the new
  // value, so the caret is first moved onto the old text as the new value shows it.
  patchSource(caret = null) {
    if (this.remote || this.locked || this.srcFor === this.text) return;
    const old = caret === null ? this.sourceCaret() : null, was = toSource(this.srcFor), map = toSource(this.text), d = diff(was.value, map.value);
    const shift = x => (x <= d.at ? x : x >= d.at + d.removed ? x + d.inserted.length - d.removed : d.at + d.inserted.length);
    const move = f => shift(docToSource(was, sourceToDoc(this.src, f)));
    const at = caret === null ? null : docToSource(map, caret);
    const next = at !== null ? { start: at, end: at } : old && { start: move(old.start), end: move(old.end) };
    const edit = diff(this.srcSeen, map.value);
    this.src = map; this.srcFor = this.text; this.srcSeen = map.value; this.srcCaret = next;
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

  // The source field's selection: known from its last change or our last placement, else read out.
  sourceCaret() {
    if (!this.srcCaret) this.srcCaret = this.caretOf(this.source);
    return this.srcCaret;
  }

  // A field's selection, read by writing MARK over it and putting back what it covered: { start, end }, or null when
  // that failed (the field is then put back whole). Its change events come after we are done, and find the value we
  // left, which is the one we saw.
  caretOf(state) {
    let before, range = null;
    this.reading++;
    try {
      before = state.value();
      this.replaceIn(state, MARK);
      const d = diff(before, state.value());
      if (d.inserted === MARK) range = { start: d.at, end: d.at + d.removed };
    } catch { /* restored below */ } finally {
      try {
        if (range) {
          state.set_selected_range({ start: range.start, end: range.start + 1 });
          this.replaceIn(state, before.slice(range.start, range.end));
          state.set_selected_range(range);
        }
        if (before !== undefined && state.value() !== before) { state.set_value(before); range = null; }
      } catch {
        try { state.set_value(before); } catch { /* the field refuses its own text: nothing more to do */ }
        range = null;
      }
      this.reading--;
    }
    return range;
  }

  replaceIn(state, text) {
    state.replace(text);
    this.owe(state);
  }

  owe(state) {
    this.owed.set(state, (this.owed.get(state) ?? 0) + 1);
  }

  // -> true when a change event was owed to `state`, which this one then pays.
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
    const placed = { start: f, end: f };
    const go = () => {
      this.guard(() => this.showSource(placed));
      this.source.focus();
    };
    this.srcCaret = placed;
    go();
    cx.timer.after(REFOCUS_MS, () => { if (!this.closed && this.mode === "markdown" && this.srcCaret === placed) go(); });
  }

  forgetSourceCaret() {
    this.srcCaret = null;
  }

  // Typing is known from its change; a key that only moves the caret or the selection is not.
  sourceKeyUp(e) {
    if (e?.modifiers?.shift || MOVES.has(e?.key) || e?.keystroke === "cmd-a") this.forgetSourceCaret();
  }

  writable() {
    return this.loaded && Boolean(this.file) && !this.error && !this.remote && !this.locked && this.conflict === null && !this.missing;
  }

  scheduleSave(cx) {
    this.saveTask?.cancel();
    this.saveTask = cx.timer.after(SAVE_MS, cx => {
      this.saveTask = null;
      this.settled = this.text; // a big buffer's footer counts catch up here
      cx.notify();
      cx.spawn(cx => this.save(cx));
    });
  }

  // One write at a time: typing during a write is saved after it (persist).
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

  // A write was refused: look at the file to tell why. The same text there is as good as saved, nothing there means
  // it was deleted, and the text we expected means the write failed for itself. Other text is somebody else's change:
  // merged in when it keeps apart from the unsaved edits, else the banner asks.
  // `expected` is what the refused write was made over: if `disk` is something else by now, a look moved it while the
  // write was out, the file holds what we now expect, and the save that follows writes the buffer over it.
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

  // Keep mine: the file's text is now the one to replace, so the write goes through.
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

  // Save again: the file is gone, make it again with the buffer (it must still not exist).
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

  // The watcher (or a poll) says something may have changed. One look at a time; a request that comes in during
  // a look makes it look once more afterwards.
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

  // A change reported while the file is still being read (or parsed) is looked at once it is loaded.
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
    // What held the autosave back (a deleted file, a conflict) is gone: the unsaved text can go out again.
    if (blocked && this.writable() && this.text !== this.disk) this.scheduleSave(cx);
    if ([this.disk, this.text, this.conflict, this.missing].some((v, i) => v !== before[i])) cx.notify();
  }

  // -> false when the unsaved edits and their change come together (mergeChange), which the banner asks about. Typing
  // that no change event has reported yet is taken in and parsed first (a commit may still close a fence): the buffer
  // compared must be the one that is saved, and the field must not be rewritten from a buffer without it.
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
    // Whatever is typed goes to the disk before the view changes.
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

  // The source caret goes where the caret of the block being edited was, else to the start of the first block at
  // the top of the page. The page is not drawn in Markdown, so nothing stays armed and the pointer is not known.
  toMarkdown(cx) {
    this.disarm(cx);
    this.setSel(null, cx);
    this.pointer = null;
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

  // The block holding the source caret is opened with the caret on the same character, and its row goes a third of
  // the way down the page. A caret on a blank line opens nothing.
  toReading(cx) {
    let at = null;
    if (!this.remote && !this.locked) {
      const caret = this.sourceCaret();
      if (caret) at = sourceToDoc(this.src, caret.start);
    }
    this.mode = "reading";
    this.refresh(cx);
    if (!this.doc.blocks.length && this.editable()) return this.openPending(cx);
    const b = at === null ? null : this.holding(at);
    // A caret at a block's end is on the line after it, unless the file ends there without a newline.
    const inside = b && (at < b.end || (at === b.end && this.text.charCodeAt(at - 1) !== 10));
    if (inside && this.editable()) this.activate(b.key, docToField(fieldOf(this.doc, b), at), cx);
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
    if (this.mode !== "reading" || !this.loaded || this.error || this.activeKey) return;
    if (this.sel && this.selectionKey(e, cx)) return;
    if (k === "enter" && this.editable()) { cx.stop_propagation(); this.resume(cx); return; }
    if (UNDO_KEYS[k]) { cx.stop_propagation(); this.undo(UNDO_KEYS[k], cx); return; }
    const page = pageStep(this.viewH());
    const to = { up: this.offset - ARROW_STEP, down: this.offset + ARROW_STEP, pageup: this.offset - page, pagedown: this.offset + page,
      space: this.offset + page, "shift-space": this.offset - page, home: 0, end: Infinity }[k];
    if (to === undefined) return;
    cx.stop_propagation();
    this.scrollTo(to, cx);
  }

  // The actions of the key table, which reach md-root along the focus path from the active field or the source.
  action(name, cx) {
    if (UNDO_ACTIONS[name]) {
      this.closeSlash(cx);
      return this.undo(UNDO_ACTIONS[name], cx);
    }
    if (this.mode !== "reading" || !this.activeKey || !this.editable()) return;
    this.syncField(cx);
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
    else if (name === "mdb-escape") this.escape(cx);
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
          else if (this.activeKey) this.field.focus();
          else this.handle.focus();
        }
      }
    });
  }

  // The browser gets web pages; a mail link goes to the computer's own opener (a mod's cx can only open web pages).
  web(url, cx) {
    if (/^https?:/i.test(url)) return cx.open_url(url);
    if (!/^mailto:/i.test(url)) return;
    cx.spawn(async () => {
      try {
        const r = await exec(window()?.platform === "macos" ? "open" : "xdg-open", [url]);
        if (r.code === 0) return;
      } catch { /* told below */ }
      notify({ title: "Can't open this link", level: "info" });
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

  // The last look: what is typed goes to the disk now if it can (the host allows about 250 ms, so no waiting for a
  // write in progress). That write is about to leave `saving` in the file, so go over that; if it has not landed yet
  // the file still has `disk`, so once more over that. Never more than two writes.
  async close(cx) {
    if (this.closed) return;
    if (cx) { this.syncSource(cx); this.syncField(cx); this.writeHeld(cx); }
    this.closed = true; this.slash = null;
    this.saveTask?.cancel(); this.pollTask?.cancel(); this.settleTimer?.cancel();
    this.diagrams?.close();
    owners.delete(this.id);
    for (const e of [...this.entities.values(), this.column]) { try { e?.release(); } catch { /* the host let it go already */ } }
    this.entities.clear();
    this.woken?.();
    if (!this.writable() || this.text === this.disk) return;
    const { text, disk } = this, first = this.saving ?? disk;
    try { await writeTextFile(this.file, text, first); }
    catch {
      if (first === disk) return; // nothing left to tell anyone
      try { await writeTextFile(this.file, text, disk); } catch { /* nor now */ }
    }
  }

  // `doc` catches up with the buffer (a re-parse of the changed span only), and the blocks with `doc`. The block
  // being edited is found again: through `place` when given ({ at, kind, caretDoc }: what was typed made it), else
  // where the change left it. -> the change parsed in, or null.
  refresh(cx, place) {
    const anchor = this.anchor(), editing = this.activeKey && !this.pending;
    const held = place === undefined && editing && this.f ? this.held() : null;
    let d = null;
    if (!this.doc) this.doc = parse(this.text, PARSE_OPTS);
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

  // What was typed since the last parse is parsed in, and the block stays the one being edited, as whatever it
  // became, but never a block that begins before it. A block emptied so that nothing of it is left goes with its
  // blank lines. A fence typed into it that now runs past what was typed is closed at once.
  commit(cx, caretDoc = null) {
    this.syncField(cx);
    if (!this.stale) return;
    const h = this.activeKey && !this.pending && this.f ? this.held() : null, b = h && this.blockByKey(this.activeKey);
    const base = this.doc.text, gone = b && this.seen === "" && b.subtreeEnd === b.end ? remove(this.doc, b) : null;
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

  // Where the block being edited is in the text now, as document offsets: its start, its field's start, the caret.
  held() {
    const b = this.blockByKey(this.activeKey), f = this.f;
    if (!b || !f) return null;
    return { kind: b.kind, start: b.start, field: f.start0, caret: this.known.valid ? fieldToDoc(f, this.known.end) : null };
  }

  // Where a change from outside the field leaves the block being edited: the caret (or field start) moved across it,
  // else the block's start. When the change took both, only a block it wrote in their place can be the one, and
  // only a block of the same kind.
  mapped(h, d) {
    const p = mapPos(d, h.caret ?? h.field), q = mapPos(d, h.start);
    if (p >= 0) return { at: p, kind: h.kind, caretDoc: null };
    if (q >= 0) return { at: q, kind: h.kind, caretDoc: null };
    return { at: d.at + Math.max(0, d.inserted.length - 1), kind: h.kind, caretDoc: null, from: d.inserted ? d.at : Infinity };
  }

  // After a re-parse, the block holding document offset `at` is the one being edited, when it is of kind `kind`
  // (any when null) and starts at `from` or later. Its field is set only when its value changed: the caret goes to
  // `caretDoc`, else follows the text it was in.
  refind({ at, kind, caretDoc, from = -Infinity }, cx) {
    const b = this.holding(at);
    if (!b || b.start > at || (kind && b.kind !== kind) || b.start < from || !this.editable()) return this.drop();
    const f = fieldOf(this.doc, b), value = withInnerLine(b, f.value);
    this.activeKey = b.key; this.f = f;
    if (value === this.seen) return;
    const c = caretDoc !== null && caretDoc !== undefined ? docToField(f, caretDoc) : mapCaret(diff(this.seen, value), this.known.valid ? this.known.end : 0);
    const n = clamp(c, 0, value.length);
    this.slash = null;
    if (!this.setField(value, { start: n, end: n })) return this.drop();
    this.rows = this.rowsFlag();
    this.revealNext = true;
    this.wake();
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
    for (const m of [this.entities, this.data, this.heights, this.shown, this.good, this.gens, this.frames]) m.delete(key);
    this.disarmed.delete(key); this.zoomed.delete(key);
    if (this.armedKey === key) this.armedKey = null;
    if (this.hoverFrame === key) this.hoverFrame = null;
    if (this.pan?.key === key) this.pan = null;
  }

  // What each block draws, compared with what it drew: only the blocks whose data changed are redrawn, the Column
  // only when the blocks are not the same ones in the same order or its window moved. With no cx (the check fixture)
  // nothing is told.
  rebuild(cx, anchor) {
    const blocks = this.placePending(this.doc.blocks), width = this.textWidth();
    this.blocks = blocks;
    this.at = new Map(blocks.map((b, i) => [b.key, i]));
    this.updateArmed();
    this.updateSel();
    if (cx && this.file) {
      for (const b of this.doc.blocks) {
        if (b.kind !== "mermaid" || b.key === this.activeKey) continue;
        const d = this.diagrams.get(b.source, cx);
        this.shown.set(b.key, d);
        if (d.state === "ok") this.good.set(b.key, d);
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
    if (cx) this.syncWindow(cx);
    // A shorter page can pull the offset back, moving other text under a resting pointer. While an armed press is
    // being taken, the pressed block is still under it and must not be armed again.
    if (this.offset !== offset && !this.swapping) this.rearm(cx);
  }

  // What the Column mounts: null while it mounts every block, else { order, from, to, extra, gaps, held, split,
  // above }: blocks [from, to) and the block being edited (`extra`, -1 when it is among them), with spacers of `gaps`
  // px around them. Blocks drawn for the first time above `held`, the block the eye held when the window was made,
  // grow upward: [from, split) is drawn from the bottom of a box `above` px tall, so that their heights, not measured
  // yet, move nothing below them. Every other block keeps its top as it grows. A window stays until the viewport
  // comes within half the margin of its edge or the blocks change.
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

  // A view can be made in a handler or a task, never in a draw: blocks that enter the window get theirs here.
  syncWindow(cx) {
    const next = this.windowFor(this.win), moved = !sameWindow(next, this.win);
    this.win = next;
    for (const key of this.mountedKeys()) {
      if (this.inline) break;
      if (!this.entities.has(key)) this.made(key, cx);
    }
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

  // A change of the offset or of the heights that no handler took to the Column (a reveal while the page is shown
  // again) is taken there right after this draw, which may not notify.
  checkWindow(cx) {
    if (this.winTimer || sameWindow(this.windowFor(this.win), this.win)) return;
    this.winTimer = cx.timer.after(0, cx => {
      this.winTimer = null;
      if (!this.closed && this.mode === "reading") this.syncWindow(cx);
    });
  }

  // The page's blocks with the pending one among them, where it will be written. When the text changed under it, it
  // is worked out again; when it no longer fits there (its block went), editing stops.
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

  // The pending block written with a stand-in text on a copy: what it draws as, and the block it comes before.
  simulate(p) {
    const w = chain(this.doc, p.base(this.doc, PLACEHOLDER), p.steps);
    if (!w?.block) return false;
    p.block = pendingRecord(p.key, w.block);
    p.before = this.doc.blocks[w.block.index]?.key ?? null;
    p.for = this.doc.text;
    return true;
  }

  // The armed block's text changed under it (a reload from disk): the spare takes the new text, or the block draws
  // its text again when it can no longer be armed.
  updateArmed() {
    const key = this.armedKey;
    if (!key) return;
    const b = this.blockByKey(key);
    if (!b?.armable || this.disarmed.has(key)) { this.armedKey = null; return; }
    const value = fieldOf(this.doc, b).value;
    if (value === this.armedValue) return;
    if (!this.guard(() => this.spare.set_value(value))) { this.armedKey = null; return; }
    this.armedValue = value; this.armedNewText = true;
  }

  redraw(keys, cx) {
    const width = this.textWidth();
    for (const key of keys) {
      const i = key ? this.at.get(key) : undefined;
      if (i === undefined) continue;
      const next = this.dataFor(this.blocks, i, width), old = this.data.get(key), e = this.entities.get(key), same = old && sameData(old, next);
      this.data.set(key, same ? old : next);
      if (cx && e && !this.inline && old && !same) cx.notify(e);
    }
    if (this.inline) cx?.notify();
  }

  made(key, cx) {
    try { this.entities.set(key, cx.new(Block, { owner: this.id, key })); } catch { this.inline = true; }
  }

  dataFor(blocks, i, width) {
    const b = blocks[i], look = lookOf(b), cal = this.calOf(look.style), marker = markerOf(b);
    const text = look.look === "text" ? displayText(b) : look.look === "boxed" ? b.render : b.content;
    return {
      key: b.key, kind: b.kind, look: look.look, style: look.style, color: look.color,
      space: spaceBefore(blocks, i, this.doc.blocks), depth: b.depth, text,
      info: b.kind === "code" ? b.info.trim().split(/\s+/)[0] : "",
      marker, label: marker === "number" ? `${b.number}${b.delim}` : "", checked: Boolean(b.task?.checked),
      diagram: look.look === "diagram" ? diagramSig(this.shown.get(b.key), this.good.get(b.key)) : "",
      mode: b.key === this.activeKey ? "active" : b.key === this.armedKey ? "armed" : "rendered",
      rows: b.key === this.activeKey ? this.rows : "many", menu: b.key === this.activeKey && this.slashOpen(),
      gen: this.gens.get(b.key) ?? 0, selected: this.selKeys.has(b.key),
      row: cal.row, ratio: cal.ratio, padRendered: cal.padRendered, padActive: cal.padActive,
      ...(look.look === "diagram" ? this.frameData(b, width) : {}),
    };
  }

  // The frame of a diagram block: the picture that is ready, else the last one dimmed, sized for the viewport. A
  // block being edited, or with nothing drawn yet, or with no renderer, has none.
  frameData(b, width) {
    const d = this.shown.get(b.key), last = this.good.get(b.key);
    const g = b.key === this.activeKey ? null : d?.state === "ok" ? d : d?.state !== "missing" ? last : null;
    const natW = g ? g.width / g.scale : 0, natH = g ? g.height / g.scale : 0;
    if (!(natW > 0 && natH > 0)) return NO_FRAME;
    const viewW = this.viewport?.width ?? this.size?.width ?? 900, viewH = this.viewport?.height ?? UNSIZED_VIEW_H;
    const blockLeft = columnLeft(viewW) + b.depth * INDENT, blockW = Math.max(120, width - b.depth * INDENT);
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

  diagramsChanged(cx) {
    if (this.closed || this.mode !== "reading" || !this.doc) return;
    this.rebuild(cx, this.anchor());
  }

  textWidth() {
    return Math.max(120, Math.floor(Math.min(COLUMN.maxWidth, this.size?.width ?? 900) - 2 * COLUMN.padX));
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

  // Its lines, each wrapped at `advance` px a character in its column `w` px wide; a table's rows do not wrap so.
  estimateOf(d, w, advance) {
    if (d.look === "rule") return d.space + RULE_H;
    if (d.look === "diagram") return d.space + (d.frameH ? d.frameH + (d.boxAbove ? DIAGRAM_H + 8 : 0) : DIAGRAM_H);
    const box = d.look === "code" || d.look === "boxed" ? 2 * BOX.py + 2 : d.look === "front" ? 2 * FRONT_BOX.py + 2 : 0;
    const lines = d.text.split("\n"), perRow = Math.max(1, Math.floor(w / advance));
    const rows = d.look === "boxed" ? lines.length : lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perRow)), 0);
    return estimateHeight(rows, d.row, d.space) + box;
  }

  // Where a block's field (when `active`) or rendered content sits inside its root: x and y from its top-left, the
  // width, and what its box adds below. The space above, marker column, quote bar and box padding come before it.
  chromeOf(d, active) {
    let x = d.depth * INDENT, w = this.textWidth() - x, y = d.space, below = 0;
    if (d.kind === "item") { x += MARKER_W; w -= MARKER_W; }
    else if (d.kind === "quote") { x += QUOTE_BAR + QUOTE_PAD; w -= QUOTE_BAR + QUOTE_PAD; }
    const box = active ? (d.kind === "frontmatter" ? FRONT_BOX : isRaw(d.kind) ? BOX : null)
      : d.look === "front" ? FRONT_BOX : d.look === "code" || d.look === "boxed" ? BOX : null;
    if (box) { x += box.px + 1; w -= 2 * (box.px + 1); y += box.py + 1; below = box.py + 1; }
    return { x, y, w: Math.max(1, w), below };
  }

  rowsOf(d, active) {
    const h = this.heights.get(d.key);
    if (h === undefined) return undefined;
    const c = this.chromeOf(d, active);
    return Math.max(1, Math.round((h - c.y - c.below - (active ? d.padActive : d.padRendered)) / d.row));
  }

  // The block the eye holds on to while heights change, and where on the screen it is: the block being edited while
  // its caret row is on the page, else the first block whose bottom is below the top of the page. A block drawn
  // upward is where the blocks below it in its box put it, not its estimated top: the block below the box stands in.
  anchor() {
    const blocks = this.blocks;
    if (!blocks.length || this.sums.length !== blocks.length + 1) return null;
    const a = this.at.get(this.activeKey) ?? -1, y = a >= 0 ? this.caretTop(a) : null;
    const i = anchorBlock({ sums: this.sums, offset: this.offset - COLUMN.padTop, viewportH: this.viewH(), active: y === null ? -1 : a, caretY: y });
    if (i < 0) return null;
    const w = this.win, j = w && w.order === this.order && i >= w.from && i < w.split ? w.split : i;
    return { key: blocks[j].key, y: COLUMN.padTop + this.sums[j] - this.offset };
  }

  // Block tops from the heights; the offset then follows a pending reveal, or keeps the anchor where it was. A reveal
  // whose block went away is dropped.
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

  // The size task: blocks report their heights from their own views, which cannot redraw this one, so they wake
  // this task, whose cx is this view's. One wake takes in every height reported before it runs, and runs the work
  // the blocks' own handlers handed over.
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
        this.rearm(cx);
        if (this.mode === "reading") this.syncWindow(cx);
        cx.notify();
      }
    });
  }

  wake() {
    const done = this.woken;
    if (done) { this.woken = null; done(); } else this.wakeLater = true;
  }

  // Work for this view's cx from a handler that runs in a block's view.
  post(job) {
    if (this.closed || !this.watching) return;
    this.inbox.push(job);
    this.wake();
  }

  // An armed block keeps the height it had rendered; an armed field that measures otherwise is not armed again. A
  // block whose text changed while armed was never measured rendered with that text: the field's height is its height.
  blockSized(key, size) {
    const h = size.height / zoom();
    if (key === this.armedKey && !this.armedNewText) {
      if (Math.abs(h - (this.heights.get(key) ?? h)) > ARM_SLACK) {
        this.disarmed.add(key);
        this.post(cx => { if (this.armedKey === key) this.disarm(cx); });
      }
      return;
    }
    if (key === this.armedKey) this.armedNewText = false;
    if (this.heights.get(key) === h) return;
    // The tops still on screen are the old ones until the size task runs: the anchor is taken from them.
    this.heights.set(key, h);
    if (key === this.activeKey) this.revealNext = true;
    this.wake();
  }

  // Puts the row holding document offset `at` a third of the way down, until the page is scrolled. An offset on a
  // blank line puts the next block there.
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
    const d = this.data.get(blocks[i].key);
    this.reveal = { key: blocks[i].key, fraction: REVEAL_AT, rowY: d.space + line * d.row };
    this.layout(null);
  }

  // The first block whose first row (below its space) is on the page, else the block the top of the page is in.
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
    this.rearm(cx);
    this.syncWindow(cx);
    cx.notify();
  }

  viewportSized(size, cx) {
    const z = zoom(), next = { width: size.width / z, height: size.height / z };
    if (next.width === this.viewport?.width && next.height === this.viewport?.height) return;
    this.viewport = next;
    // A diagram's frame is sized from the viewport, so its block's data changes with it.
    if (this.diagramKeys.length && this.doc && this.mode === "reading") this.rebuild(cx, this.anchor());
    else this.layout(this.anchor());
    this.rearm(cx);
    this.syncWindow(cx);
    cx.notify();
  }

  // A gesture keeps what it began as: with Cmd or Ctrl over a frame it zooms that frame; over a frame whose picture
  // is wider than it, it pans the frame sideways once it shows it goes sideways; anything else scrolls the page,
  // through any frame under the pointer whose picture is taller than it.
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

  // A vertical wheel step: the page, passing through a frame under the pointer whose picture is taller than it.
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

  // Cmd or Ctrl and the wheel: up zooms in, around the picture's point under the pointer.
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

  // A press the field's own wrapper took also reaches the viewport when events cross the block's view: it is the
  // same press when it is at the same window position.
  tookPress(e, kind) {
    const c = this.fieldPress;
    if (!c || c.kind !== kind || c.x !== e?.position?.x || c.y !== e?.position?.y) return false;
    this.fieldPress = null;
    return true;
  }

  // A press on the block being edited, beside its field, would take the keyboard from the field: it is given back
  // now, and again on the mouse-up if the root took it all the same. `beside` is that block's key, `key` the block
  // pressed, which a drag onto another block selects from. A press clears a block selection, unless Shift extends it.
  viewportDown(e, cx) {
    this.closeSlash(cx);
    this.endThumb(cx);
    this.endPan(cx);
    this.linked = false;
    if (!e?.modifiers?.shift) this.setSel(null, cx);
    if (this.tookPress(e, "down")) { this.press = null; return; }
    this.fieldHeld = null;
    this.dragFrom = windowPoint(e);
    const p = this.point(e);
    if (p && e.modifiers?.shift) { this.press = null; return this.shiftTo(this.hit(p)?.block, cx); }
    const hit = p ? this.hit(p) : null;
    this.press = p ? { ...p, beside: null, key: hit?.block?.key ?? null } : null;
    const v = hit?.on === "frame" && this.dragFrom ? this.viewOf(hit.block.key) : null;
    if (v) this.pan = { key: hit.block.key, from: this.dragFrom, x0: v.x, y0: v.y, moved: false };
    if (!this.press || !this.activeKey) return;
    if (hit?.block && hit.block.key === this.activeKey) {
      this.press.beside = this.activeKey;
      this.field.focus();
    }
  }

  // A drag that stayed in a block not being edited selected its rendered text, for a Cmd+C where the press left the
  // keyboard: the editing goes on, and neither this nor the root's mouse-up gives the field the keyboard back. Any
  // other press, a pan of a frame among them, leaves the field the keyboard, as a press elsewhere in the pane does
  // (keepKeyboard).
  viewportUp(e, cx) {
    if (this.endThumb(cx)) return this.keepKeyboard();
    const down = this.press, p = this.point(e), linked = this.linked, panned = this.endPan(cx);
    this.press = null; this.linked = false; this.fieldHeld = null;
    if (panned) return this.keepKeyboard();
    if (this.tookPress(e, "up")) return;
    const pressed = down && !linked ? down : null;
    if (pressed && p && e.click_count >= 1 && Math.hypot(p.x - pressed.x, p.y - pressed.y) <= CLICK_SLOP) this.clickAt(p, cx, e.click_count);
    else if (pressed?.key && this.activeKey && pressed.key !== this.activeKey && !this.sel) return cx.stop_propagation();
    this.keepKeyboard();
  }

  // A press beside the field (a task box, a link, the toolbar, the banner, the scrollbar) can take the keyboard from
  // it, and the root's own keys ignore the page while a block is being edited: the field is given the keyboard back.
  // A press on the armed block went into the spare field, which takes the editing once its focus event comes.
  keepKeyboard() {
    if (this.activeKey && !this.armedKey && this.editable() && this.focusedState !== this.field) this.field.focus();
  }

  // A frame fills much of the pane, so a single click on it (a tap, a click to focus the window) opens nothing: a
  // double-click opens the diagram's source. The − % + group works on files that cannot be edited too.
  clickAt(p, cx, count = 1) {
    const hit = this.hit(p);
    if (!hit) return;
    if (hit.on === "tool") return this.toolClick(hit.block.key, hit.tool, cx);
    if (hit.on === "task") return this.tick(hit.block, cx);
    if (!this.editable()) return;
    if (hit.on === "frame") {
      if (count >= 2) this.clickBlock(hit.block.key, p, cx);
      return;
    }
    if (hit.on === "outside") return this.deactivate(cx);
    if (hit.on === "end") return this.openPending(cx);
    const key = hit.block.key;
    if (key === this.activeKey) return;
    if (key === this.armedKey) {
      this.takeArmed(cx);
      this.readLater(cx);
      return;
    }
    this.clickBlock(key, p, cx);
  }

  // A move event says nothing of the buttons: while a press is under way, on the page or in a field, nothing is armed,
  // and a drag that reaches another block selects whole blocks. With Shift held nothing stays armed, so that a
  // Shift+click lands on the page and not in a field.
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
    if (held && this.pointer) {
      if (this.dragged(e)) this.dragTo(held, this.pointer, cx);
      return;
    }
    if (e?.modifiers?.shift) return this.disarm(cx);
    if (!this.press && !this.fieldHeld) this.arm(this.pointer, cx);
  }

  // A click's jitter is no drag: across a block's edge it would select blocks and end the editing the press began.
  dragged(e) {
    const from = this.dragFrom, p = windowPoint(e);
    if (from && p && Math.hypot(p.x - from.x, p.y - from.y) <= CLICK_SLOP) return false;
    this.dragFrom = null;
    return true;
  }

  modifiersChanged(e, cx) {
    if (e?.modifiers?.shift) this.disarm(cx);
  }

  viewportHover(hovered, cx) {
    if (hovered) return;
    this.endThumb(cx);
    this.endPan(cx);
    this.press = null; this.fieldHeld = null; this.pointer = null;
    this.updateHover(cx);
    this.arm(null, cx);
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

  // What a frame draws besides its block's data: its view, the sharp picture while the zoom needs it, the − % +
  // group while the pointer is over the frame or pans it, and the cursor.
  frameView(key) {
    const v = this.viewOf(key), d = this.data.get(key);
    if (!v) return null;
    return {
      ...v,
      sharp: d.sharpKey && FRAME.dpr * zoom() * v.z > d.imgScale ? d.sharpKey : "",
      tools: this.toolsShown(key) ? { top: this.toolsTopOf(key), pct: Math.round(v.z * 100), out: canZoom(v.z, -1, d.zMin), in: canZoom(v.z, 1, d.zMin) } : null,
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

  // The frame under the pointer shows its − % + group; the page moving under a resting pointer can change which
  // frame that is, or where the group must sit to stay on the page.
  updateHover(cx) {
    const key = (this.pointer && this.frameAt(this.pointer)?.block.key) ?? null, top = key ? this.toolsTopOf(key) : null;
    if (key === this.hoverFrame && top === this.hoverTop) return;
    const old = this.hoverFrame;
    this.hoverFrame = key; this.hoverTop = top;
    this.notifyFrames(old === key ? [key] : [old, key], cx);
  }

  notifyFrames(keys, cx) {
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
    this.notifyFrames([key], cx);
    if (next.z !== now.z) this.zoomedNow(key, cx);
    return true;
  }

  // The picture follows the pointer once it has moved past the click slop, and never arms, selects or clicks.
  panTo(e, cx) {
    const pan = this.pan, w = windowPoint(e);
    if (!w) return;
    const dx = w.x - pan.from.x, dy = w.y - pan.from.y, first = !pan.moved;
    if (first && Math.hypot(dx, dy) <= CLICK_SLOP) return;
    pan.moved = true;
    const v = this.viewOf(pan.key);
    if (!(v && this.setView(pan.key, { ...v, x: pan.x0 + dx, y: pan.y0 + dy }, cx)) && first) this.notifyFrames([pan.key], cx);
  }

  endPan(cx) {
    const pan = this.pan;
    this.pan = null;
    if (pan?.moved) this.notifyFrames([pan.key], cx);
    return Boolean(pan?.moved);
  }

  toolClick(key, tool, cx) {
    const d = this.data.get(key), v = this.viewOf(key);
    if (!v) return;
    if (tool === "pct") {
      if (this.frames.delete(key)) this.notifyFrames([key], cx);
      return;
    }
    const z1 = zoomStep(v.z, tool === "in" ? 1 : -1, d.z0, d.zMin);
    if (z1 !== v.z) this.setView(key, zoomAround(boxOf(d), natOf(d), v, z1, d.frameW / 2, d.frameH / 2), cx);
  }

  // A sharp picture is asked for once the zoom of a frame has rested.
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

  dragTo(from, p, cx) {
    const b = this.hit(p)?.block;
    if (!b || !this.blockByKey(from) || !this.blockByKey(b.key) || (!this.sel && b.key === from)) return;
    this.select(from, b.key, cx);
  }

  select(from, to, cx) {
    if (this.sel?.from === from && this.sel.to === to) return;
    this.leave(cx);
    this.disarm(cx);
    this.handle.focus();
    this.setSel({ from, to }, cx);
  }

  // The blocks a selection covers, as indices into doc.blocks: [first, last], the sub-blocks of the last ones
  // included, as removeRange takes them; null when either end is gone.
  selRange(sel = this.sel) {
    const bl = this.doc?.blocks ?? [], a = sel ? bl.findIndex(b => b.key === sel.from) : -1, z = sel ? bl.findIndex(b => b.key === sel.to) : -1;
    if (a < 0 || z < 0) return null;
    let k = Math.max(a, z), end = 0;
    for (let j = Math.min(a, z); j <= k; j++) {
      end = Math.max(end, bl[j].subtreeEnd);
      if (j === k && bl[k + 1]?.start < end) k++;
    }
    return [Math.min(a, z), k];
  }

  keysIn(range) {
    return new Set(range ? this.doc.blocks.slice(range[0], range[1] + 1).map(b => b.key) : []);
  }

  setSel(sel, cx) {
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

  // -> true when the key acted on the selection.
  selectionKey(e, cx) {
    const k = e.keystroke, m = e.modifiers ?? {};
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

  // The block under a viewport point and what on it: a diagram's frame (also where it reaches into the margins) or
  // a cell of its − % + group, its checkbox, its body, the space below the last block ("end"), or a margin outside
  // every block ("outside"). x and y are relative to the block's root, fx and fy to the frame. On a page with no
  // blocks the whole column is the space below the last block.
  hit(p) {
    const blocks = this.blocks, n = blocks.length;
    if (this.sums.length !== n + 1) return null;
    const f = this.frameAt(p);
    if (f) {
      const tool = this.toolsShown(f.block.key) ? frameTool(f.fx, f.fy, f.d.frameW, this.toolsTopOf(f.block.key)) : null;
      return { block: f.block, on: tool ? "tool" : "frame", tool, fx: f.fx, fy: f.fy };
    }
    const y = p.y + this.offset - COLUMN.padTop, x = columnX(p.x, this.viewport?.width ?? this.size?.width ?? 0);
    if (x < 0 || x >= this.textWidth()) return { on: "outside" };
    if (!n) return { on: "end" };
    if (y < 0) return { on: "outside" };
    if (y >= this.sums[n]) return { on: "end" };
    const i = blockAt(this.sums, y), b = blocks[i], d = this.data.get(b.key);
    const inX = x - b.depth * INDENT, inY = y - this.sums[i] - d.space;
    const on = d.marker === "task" && inX >= 0 && inX < MARKER_W && inY >= 0 && inY < d.row ? "task" : "block";
    return { block: b, on, x, y: y - this.sums[i] };
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

  // Block `key` becomes the one being edited, the caret at field offset `caret` (a number or a range). The block
  // being edited before is left first. `shift` moves the page down by that much; `reveal` keeps the caret row in view,
  // which a press does not want: the page does not move on a click.
  activate(key, caret, cx, { shift = 0, reveal = true } = {}) {
    if (!this.editable()) return false;
    this.setSel(null, cx);
    if (this.activeKey && this.activeKey !== key) this.leave(cx, key);
    else if (this.activeKey) this.commit(cx);
    const b = this.blockByKey(key);
    if (!b) return false;
    const anchor = this.anchor(), f = fieldOf(this.doc, b), value = withInnerLine(b, f.value), n = value.length;
    const r = typeof caret === "number" ? { start: caret, end: caret } : caret ?? { start: 0, end: 0 };
    this.f = f; this.opened = value;
    if (!this.setField(value, { start: clamp(r.start, 0, n), end: clamp(r.end, 0, n) })) { this.drop(); this.rebuild(cx, anchor); return false; }
    const was = this.activeKey;
    this.activeKey = key; this.act++;
    if (this.armedKey === key) this.armedKey = null;
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

  // The value is taken as seen before set_value, which may report it as a change.
  setField(value, range) {
    this.seen = value;
    this.known = { start: range.start, end: range.end, valid: true };
    return this.guard(() => {
      this.field.set_value(value);
      this.field.set_selected_range(range);
    });
  }

  focusField(cx) {
    const act = this.act, state = this.field;
    state.focus();
    cx.timer.after(REFOCUS_MS, () => { if (!this.closed && this.act === act && this.activeKey) state.focus(); });
  }

  // The block being edited is left: what was typed is parsed in, a block emptied there goes, and a pending one was
  // never written unless it holds a marker held back (writeHeld). While its caret row is on the page the block keeps
  // its top where it is; a pending block, which goes, leaves block `keep` (the one opened next) where it is, else the
  // block above it.
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
    const gone = b && this.seen === "" && this.opened !== "" && b.subtreeEnd === b.end ? remove(this.doc, b) : null;
    const base = this.doc.text;
    if (gone) this.f = null;
    this.commit(cx);
    this.activeKey = null; this.pending = null; this.f = null; this.known = NO_CARET; this.act++; this.rows = "many"; this.ownKeyUp = null; this.menuKeyUp = null; this.slash = null;
    if (pending) this.forget(pending.key);
    if (gone) this.setText(applySplice(base, gone), cx);
    this.rebuild(cx, anchor);
    cx.notify();
  }

  deactivate(cx) {
    this.leave(cx);
    this.handle.focus();
    cx.notify();
  }

  // The block being edited went away under a change: there is nothing left of it to commit.
  drop() {
    this.release();
    this.handle.focus();
  }

  // Editing stops without the rules of leaving (an emptied block goes, a held marker is written, a fence is closed):
  // an undo, a paste or an op is about to replace the text around the block, and those rules would record entries of
  // their own.
  release() {
    const pending = this.pending;
    this.activeKey = null; this.pending = null; this.f = null; this.known = NO_CARET; this.act++; this.rows = "many"; this.ownKeyUp = null; this.menuKeyUp = null; this.slash = null;
    if (pending) this.forget(pending.key);
  }

  // An empty paragraph after the last block, written into the text only once something is typed in it.
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
  // would make no block. A marker alone (`#`, `-`, `1.`, `>`) is held back: the shortcut's space, or any other
  // character, writes it as typed, and so do Enter and leaving the block (writeHeld). So is a slash that opens the
  // menu, with what is typed after it, while the menu is open: a pick writes the block it makes instead.
  pendingTyped(value, d, own, cx) {
    const k = d.at + d.inserted.length;
    this.seen = value;
    this.known = { start: k, end: k, valid: true };
    this.slashChanged({ a: d.at, r: d.removed, ins: d.inserted }, value, own, cx);
    if (!value.trim() || loneMarker(value) || this.slashOpen()) return;
    this.writePending(value, k, cx);
  }

  // The pending block is written where it was opened, holding `value`, with the caret at field offset k. Cmd+Z then
  // takes it away with the caret back where it was opened. A marker written alone (`held`) makes a block with
  // nothing in its field, which, being what was typed, stays when it is left so.
  writePending(value, k, cx, held = false, intoStandIn = false) {
    const p = this.pending;
    // Text that makes another block than the stand-in did (`# ` in an item is a heading inside it) can leave the steps
    // nothing to apply to: it then goes into the block the stand-in wrote, where the empty block is drawn. A marker
    // the slash menu picked always goes there, as what the block the user sees becomes.
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

  // A marker typed alone and held back is written as typed. -> true when it was.
  writeHeld(cx) {
    if (!this.pending || !this.seen.trim() || !this.editable()) return false;
    return this.writePending(this.seen, this.known.valid ? this.known.end : this.seen.length, cx, true);
  }

  originDoc(p) {
    const o = p?.origin, b = o && this.blockByKey(o.key);
    return b ? fieldToDoc(fieldOf(this.doc, b), o.caret.end) : null;
  }

  // Keys in a block not written yet change what it will be written as. Enter on a marker held back writes it, and
  // an empty paragraph opens below what it made.
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

  // What was typed in the active field goes into the text as one splice of its block's source; nothing is parsed.
  // A space that completes a markdown shortcut makes the block what its source now says. `event`: the field told us,
  // rather than an action finding its value moved on. `own`: the change is our own replace(), whose event is owed
  // already; any other change is the user's, whose event is this one or one still to come.
  fieldChanged(state, cx, { event = true, own = false } = {}) {
    if (state !== this.field || this.reading || !this.activeKey || !this.editable()) {
      // Nobody types in a field that is not open: its changes are owed ones, such as a readout's made on leaving.
      if (event) this.paid(state);
      return;
    }
    const value = state.value(), before = this.seen;
    if (value !== before && !own) this.owe(state);
    const owed = event && this.paid(state);
    if (value === before) {
      if (event && !owed) this.deleteAtEnd(cx);
      return;
    }
    const d = diff(before, value);
    if (addsMark(d, before)) return this.repairField();
    if (this.pending) return this.pendingTyped(value, d, own, cx);
    const hint = this.known.valid && this.known.start === this.known.end ? this.known.start : undefined;
    // The field showed what its source does not have yet (withInnerLine): that goes in first.
    const innerLine = this.f.value !== before ? type(this.f, before) : null;
    const s = type(this.f, value, hint);
    this.seen = value;
    if (!s) return;
    this.known = { start: s.fieldCaret, end: s.fieldCaret, valid: true };
    const a = s.fieldCaret - d.inserted.length;
    this.slashChanged({ a, r: d.removed, ins: value.slice(a, s.fieldCaret) }, value, own, cx);
    const rec = this.typing(this.act, s.end, s.caret);
    if (innerLine) this.edited(applySplice(applySplice(this.text, innerLine), s), cx, rec);
    else this.edited(applySplice(this.text, s), cx, { ...rec, splice: s });
    if (!d.removed && d.inserted === " " && this.shortcutAt(s.fieldCaret - 1, cx)) return;
    this.updateRows(cx);
    this.revealCaret(cx);
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

  // A readout's marker found in the field outside a readout: the last good value and caret come back.
  repairField() {
    const k = this.known;
    this.guard(() => {
      this.field.set_value(this.seen);
      if (k.valid) this.field.set_selected_range(k);
    });
  }

  syncField(cx, own = false) {
    if (this.activeKey && this.mode === "reading" && !this.reading && this.field.value() !== this.seen) this.fieldChanged(this.field, cx, { event: false, own });
  }

  fieldFocus(state, on, cx) {
    if (on) this.focusedState = state;
    else if (this.focusedState === state) this.focusedState = null;
    if (on && state === this.spare && this.armedKey && this.shiftField !== this.armedKey) this.takeArmed(cx);
  }

  // The rows flag of the active field: one row while it has no line break, measures under 1.5 rows and its text is
  // estimated to fit, so the flag drops before a wrap is measured.
  rowsFlag() {
    const d = this.data.get(this.activeKey);
    if (!d) return this.seen.includes("\n") ? "many" : "one";
    const cal = this.calOf(d.style), rows = this.rowsOf(d, true) ?? 1;
    return isOneRow({ value: this.seen, height: rows * d.row, rowPx: d.row, width: this.chromeOf(d, true).w, advance: cal.advance }) ? "one" : "many";
  }

  updateRows(cx) {
    const r = this.rowsFlag();
    if (r === this.rows) return;
    this.rows = r;
    this.redraw([this.activeKey], cx);
  }

  // The row of the active field's offset `at` (the caret), as a y in the column (block tops are 0-based there), or
  // null for a block not drawn yet.
  caretTop(i, at = this.known.valid ? this.known.end : 0) {
    const d = this.data.get(this.blocks[i]?.key);
    if (!d) return null;
    const c = this.chromeOf(d, true);
    const row = caretRow(this.seen, at, this.rowsOf(d, true));
    return this.sums[i] + c.y + row * d.row;
  }

  revealCaret(cx) {
    const i = this.at.get(this.activeKey), top = i === undefined ? null : this.caretTop(i);
    if (top === null || !this.viewport || this.sums.length !== this.blocks.length + 1) return;
    const d = this.data.get(this.activeKey), y = COLUMN.padTop + top;
    const next = keepInView({ offset: this.offset, viewportH: this.viewH(), y, rowPx: d.row, contentH: this.contentH() });
    if (next === this.offset) return;
    this.offset = next; this.reveal = null;
    this.rearm(cx);
    if (cx) this.syncWindow(cx);
    cx?.notify();
  }

  // A click on a block that is not armed: the caret goes where the press estimate puts it, and the clicked line
  // stays under the pointer when the field shows a fence or dash line above it.
  clickBlock(key, p, cx) {
    const i = this.at.get(key), b = this.blockByKey(key);
    if (i === undefined || !b) return;
    const x = columnX(p.x, this.viewport?.width ?? this.size?.width ?? 0), y = p.y + this.offset - COLUMN.padTop - this.sums[i];
    const fenced = Boolean(b.fence) || b.kind === "frontmatter";
    this.activate(key, this.pressCaret(b, x, y), cx, { shift: fenced && b.kind !== "mermaid" ? this.data.get(key).row : 0, reveal: false });
  }

  // The field caret a press at (x, y) on block b gives, x from the column's left edge and y from the block's top: the
  // press estimate of its field as drawn now, rendered or (for the block being edited) the field itself.
  pressCaret(b, x, y) {
    const d = this.data.get(b.key), active = b.key === this.activeKey, c = this.chromeOf(d, active), cal = this.calOf(d.style);
    const value = active ? this.seen : this.openedValue(b);
    if (b.kind === "mermaid" && !active) return this.entry(b, value, 1, null);
    const height = (this.heights.get(b.key) ?? this.estimate(b)) - c.y - c.below - (active ? d.padActive : d.padRendered);
    const fenced = !active && (Boolean(b.fence) || b.kind === "frontmatter");
    return pressToField({ kind: b.kind, value, fenced, closed: b.closed, rows: this.rowsOf(d, active), width: c.w, height }, x - c.x, y - c.y, { rowPx: d.row, advance: cal.advance, monoAdvance: cal.advance });
  }

  openedValue(b) {
    return withInnerLine(b, fieldOf(this.doc, b).value);
  }

  // Where the caret lands in block b, whose field shows `value`, coming from above (dir > 0) or below: inside a
  // fence, never on its fence lines; at `column` when the block is one row, else at its start or end.
  entry(b, value, dir, column) {
    const lines = value.split("\n");
    if (b.fence || b.kind === "frontmatter") {
      const lastInner = b.closed !== false ? lines.length - 2 : lines.length - 1;
      if (dir > 0) return lines[0].length + 1;
      return value.length - lines.slice(lastInner + 1).reduce((n, l) => n + l.length + 1, 0);
    }
    if (column !== null && lines.length === 1 && this.fitsOneRow(b, value)) return Math.min(column, value.length);
    return dir > 0 ? 0 : value.length;
  }

  fitsOneRow(b, value) {
    const d = this.data.get(b.key);
    return Boolean(d) && value.length * this.calOf(d.style).advance < 0.9 * this.chromeOf(d, true).w;
  }

  columnOf(c) {
    return c - (this.seen.lastIndexOf("\n", c - 1) + 1);
  }

  // The index of the block that crossing from block i lands in, rules skipped: below 0 past the first block, the
  // number of blocks past the last.
  crossedTo(i, dir) {
    const blocks = this.blocks;
    let j = i + dir;
    while (j >= 0 && j < blocks.length && blocks[j].kind === "hr") j += dir;
    return j;
  }

  // The caret leaves the block being edited for the previous (dir < 0) or next block, rules skipped. Past the end of
  // a raw block that is the last one, an empty paragraph opens below it.
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
    const c = this.known.valid ? this.known : this.caretOf(this.field);
    this.cross(dir, cx, c ? this.columnOf(c.start) : null);
    this.ownKeyUp = dir < 0 ? "up" : "down";
  }

  // A key-up in the active field, handed over by its wrapper: the caret is read out after a key that moved it, and a
  // plain Up or Down that left it where it was crossed the block's edge. The key-up of a key whose press crossed into
  // this block is no edge signal, but a held key's repeats may have moved the caret here since: it is read out too.
  keyUp(e, cx) {
    if (!this.activeKey || !this.editable()) return;
    const k = e?.key, m = e?.modifiers ?? {}, crossed = this.ownKeyUp === k, menuTook = this.menuKeyUp === k;
    const selects = e?.keystroke === "cmd-a" || (m.shift && MOVES.has(k));
    this.ownKeyUp = null; this.menuKeyUp = null;
    // Shift also types characters (a capital, `/` on some layouts), which move no caret but the one typing tracks.
    if (m.shift || selects) {
      this.known = { ...this.known, valid: false };
      if (selects) this.closeSlash(cx);
      return;
    }
    if (!MOVES.has(k)) return;
    const plainVertical = (k === "up" || k === "down") && !m.alt && !m.platform && !m.control;
    // A plain Up or Down the menu took moved its highlight, not the caret. One it did not take (Alt or Cmd with it, or
    // a press in the frame before the menu's binding applies) moved the caret, and the readout closes the menu.
    if (menuTook && plainVertical) return;
    this.syncField(cx);
    const before = this.known, c = this.caretOf(this.field);
    this.slashCaret(c, cx);
    if (!c) { this.known = NO_CARET; return; }
    this.known = { start: c.start, end: c.end, valid: true };
    const still = before.valid && before.start === before.end && c.start === c.end && c.start === before.start;
    if (!crossed && plainVertical && this.rows === "many" && still) return this.cross(k === "up" ? -1 : 1, cx, this.columnOf(c.start));
    this.revealCaret(cx);
  }

  // The caret, read 30 ms after a mouse-up in the field, once the field has put it where the press went. It is under
  // the pointer, so the page stays where it is.
  readLater(cx) {
    const act = this.act;
    cx.timer.after(READ_AFTER_UP_MS, cx => {
      if (this.closed || this.act !== act || !this.activeKey || !this.editable()) return;
      this.syncField(cx);
      const c = this.caretOf(this.field);
      this.known = c ? { start: c.start, end: c.end, valid: true } : NO_CARET;
      this.slashCaret(c, cx);
    });
  }

  // The field's wrapper lives in the block's view, whose cx cannot redraw this one: what needs a cx goes to the size
  // task. The press is marked so that the viewport, if it hears it too, leaves it to the field. An armed block is
  // opened by a mouse-up only when the press began in its field; a press there with Shift selects blocks instead, and
  // the field's focus is not taken. Any other press clears a block selection.
  fieldDown(key, e) {
    this.fieldPress = { kind: "down", x: e?.position?.x, y: e?.position?.y };
    this.press = null; this.fieldHeld = key; this.dragFrom = windowPoint(e);
    if (this.sel && !e?.modifiers?.shift) this.post(cx => this.setSel(null, cx));
    if (key === this.activeKey) {
      this.known = { ...this.known, valid: false }; this.ownKeyUp = null;
      if (this.slash) this.post(cx => this.closeSlash(cx));
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
    const began = this.fieldHeld === key;
    this.fieldHeld = null;
    this.post(cx => {
      if (began && key === this.armedKey) this.takeArmed(cx);
      if (key === this.activeKey) this.readLater(cx);
    });
  }

  fieldKeyUp(_key, e) {
    this.post(cx => this.keyUp(e, cx));
  }

  // The press on the armed block landed in the spare field, which becomes the active one with the caret the press
  // gave it (read out after the mouse-up). Its focus event or the mouse-up, whichever comes first, does this.
  takeArmed(cx) {
    const key = this.armedKey;
    if (!key || !this.editable()) return;
    this.armedKey = null;
    this.swapping = true;
    try { this.leave(cx, key); } finally { this.swapping = false; }
    const b = this.blockByKey(key);
    if (!b) return;
    const anchor = this.anchor(), f = fieldOf(this.doc, b);
    [this.field, this.spare] = [this.spare, this.field];
    this.f = f; this.opened = f.value; this.known = NO_CARET;
    if (this.field.value() === f.value) this.seen = f.value;
    else if (!this.setField(f.value, { start: 0, end: 0 })) { this.drop(); this.rebuild(cx, anchor); return; }
    this.activeKey = key; this.act++;
    this.rows = this.rowsFlag();
    this.rebuild(cx, anchor);
    if (this.focusedState !== this.field) this.field.focus();
    cx.notify();
  }

  // The block under the pointer gets the spare field, drawn in its own type in place of its text, so that a press
  // lands natively. Only plain one-line text blocks that are measured, and never again one that measured off.
  arm(p, cx) {
    const hit = p && this.editable() && !this.calibrating ? this.hit(p) : null, b = hit?.on === "block" ? hit.block : null;
    const want = b && b.armable && b.key !== this.activeKey && !this.disarmed.has(b.key) && this.heights.has(b.key) ? b.key : null;
    if (want === this.armedKey) return;
    const value = want ? fieldOf(this.doc, b).value : null;
    if (want && !this.guard(() => this.spare.set_value(value))) return;
    const old = this.armedKey;
    this.armedKey = want; this.armedValue = value; this.armedNewText = false;
    this.redraw([old, want], cx);
  }

  // The page moved under a resting pointer: the block now under it is armed. A press under way arms nothing.
  rearm(cx) {
    this.updateHover(cx);
    if (this.pointer && !this.press && !this.fieldHeld) this.arm(this.pointer, cx);
  }

  disarm(cx) {
    const old = this.armedKey;
    if (!old) return;
    this.armedKey = null;
    this.redraw([old], cx);
  }

  // Escape: the caret is kept for Enter to come back to, and editing stops.
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

  // Enter with no block being edited: back to the caret kept at Escape when its block is on the page, else to the
  // start of the first block at the top of the page; a page with no blocks gets an empty paragraph.
  resume(cx) {
    const s = this.stored, i = s ? this.at.get(s.key) : undefined;
    if (i !== undefined && this.onPage(i)) { this.activate(s.key, s.caret, cx); return; }
    const b = this.topBlock();
    if (b) this.activate(b.key, this.entry(b, this.openedValue(b), 1, null), cx);
    else this.openPending(cx);
  }

  // The caret as the field has it now, for a key that acts on it. `known` can be a native move behind: the key-up that
  // reads such a move out may come after the next key's press.
  caretNow() {
    const c = this.caretOf(this.field);
    this.known = c ? { start: c.start, end: c.end, valid: true } : NO_CARET;
    return c;
  }

  caretDoc() {
    return this.f && !this.pending && this.known.valid ? fieldToDoc(this.f, this.known.end) : null;
  }

  // A structural op: an entry of its own in the history, parsed in at once. Then the block holding document offset
  // `at` (the op's caret) is opened with field caret `caret` (null: where `at` falls in it), or `then` runs instead.
  op(s, cx, { at = s?.caret, caret = null, then = null } = {}) {
    if (!s) return false;
    const before = this.caretDoc();
    this.release();
    this.change(s, cx, { caretBefore: before ?? s.start, caretAfter: at });
    if (then) then();
    else this.openAt(at, cx, caret);
    return true;
  }

  // Enter in a text block (a raw block keeps the field's own newline). A selection that reaches an end of the field
  // is deleted first, as typing.
  enter(cx) {
    if (this.pending) return this.pendingKey("enter", cx);
    const b = this.blockByKey(this.activeKey), value = this.seen;
    if (!b || !isText(b)) return;
    if (!value) return this.enterEmpty(b, cx);
    if (b.kind === "paragraph" && (FENCE_TYPED.test(value) || RULE_TYPED.test(value))) return this.enterTyped(cx);
    const r = this.caretNow();
    if (!r) return;
    if (r.start !== r.end && (r.start === 0 || r.end === value.length)) {
      if (this.typeText("", cx)) this.enter(cx);
      return;
    }
    this.commit(cx);
    const now = this.blockByKey(this.activeKey);
    if (!now) return;
    const kind = now.kind === "item" ? "item" : "paragraph", origin = { key: now.key, caret: { start: r.start, end: r.end } };
    if (now.kind === "quote") {
      if (r.end === value.length && value.endsWith("\n")) return this.leaveQuote(now, cx);
    } else if (r.end === 0) return this.openPendingWith({ base: beforeKey(now.key, kind), origin }, cx);
    else if (r.start === value.length) return this.openPendingWith({ base: afterKey(now.key, kind), origin }, cx);
    this.op(split(this.doc, now, r.start, r.end), cx);
  }

  // Enter in a block with no text. An item moves out a level, or out of its list at the top, where it is an empty
  // paragraph. Any other block goes for an empty paragraph in its place, unless the file has it with no text (a
  // heading): then the paragraph opens below it.
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

  // Block b goes, emptied by typing or as the file has it, and an empty paragraph not written yet takes its place.
  paragraphInPlace(b, cx) {
    const pos = b.start, depth = b.depth;
    this.leave(cx);
    const left = this.blockByKey(b.key), s = left && remove(this.doc, left);
    if (s) this.change(s, cx);
    this.openPendingWith({ base: this.baseAt(pos, depth) }, cx);
  }

  // A heading, quote or item with no text loses its marker: what is left is a blank line, no block, so the empty
  // paragraph it becomes is one not written yet, in its place.
  emptyInPlace(b, cx) {
    const s = b.subtreeEnd > b.end ? toParagraph(this.doc, b) : remove(this.doc, b);
    return this.op(s, cx, { then: () => this.openPendingWith({ base: this.baseAt(s.caret, b.depth) }, cx) });
  }

  // Where an empty paragraph at depth `depth` goes at document offset `pos`, a line start where a block was: after the
  // block of that depth that ends there, else before the one that starts there, else after what is there.
  baseAt(pos, depth) {
    const bl = this.doc.blocks, j = bl.findIndex(b => b.start >= pos), next = j < 0 ? null : bl[j];
    let prev = bl[(j < 0 ? bl.length : j) - 1] ?? null;
    while (prev && prev.depth > depth) prev = bl[prev.parent] ?? null;
    if (prev && prev.depth === depth) return afterKey(prev.key, "paragraph");
    if (next && next.depth === depth) return beforeKey(next.key, "paragraph");
    return prev ? afterKey(prev.key, "paragraph") : next ? beforeKey(next.key, "paragraph") : atEnd;
  }

  // Enter on a paragraph holding only a fence (```js) or a rule (---): the commit makes it what its source says. A code
  // block takes the caret onto its empty line, closed: the commit closes a fence that would take in what follows, in
  // the typing's own entry, and one that ends the file is closed here, in the same entry. A rule gets an empty
  // paragraph below it.
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

  // Enter at the end of a quote whose last paragraph is empty: that paragraph goes, and an empty paragraph opens after
  // the quote.
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
    this.typeOwn("\\\n", cx);
  }

  cmdEnter(cx) {
    const b = this.pending ? null : this.blockByKey(this.activeKey);
    if (!b) return;
    if (b.kind === "item" && b.task) return this.tick(b, cx);
    if (!isRaw(b.kind)) return;
    const r = this.caretNow() ?? { start: 0, end: 0 };
    this.openPendingWith({ base: afterKey(b.key, "paragraph"), origin: { key: b.key, caret: { start: r.start, end: r.end } } }, cx);
  }

  // The field gives Backspace away only at its start.
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
    if (p.kind === "hr") {
      const s = remove(this.doc, p);
      return this.op(s, cx, { at: s && s.start + s.insert.length, caret: 0 });
    }
    if (isRaw(p.kind)) return this.cross(-1, cx);
    this.op(mergeIntoPrevious(this.doc, p, now), cx);
  }

  // Backspace at the start of a raw block with nothing between its fences, or nothing at all: the block goes and the
  // caret goes to the end of the block above, past any rules, or to an empty paragraph in its place when nothing but
  // rules is above it. A block emptied by typing goes as the caret leaves it: a commit would take it away with the
  // block being edited.
  removeEmptyRaw(b, i, cx) {
    const lines = this.seen.split("\n"), fenced = Boolean(b.fence) || b.kind === "frontmatter";
    const inner = fenced ? lines.slice(1, b.closed !== false ? -1 : undefined) : lines;
    if (inner.some(l => l.trim())) return;
    const j = this.crossedTo(i, -1);
    if (j < 0) return this.paragraphInPlace(b, cx);
    if (!this.seen) return this.cross(-1, cx);
    this.commit(cx);
    const now = this.blockByKey(this.activeKey), back = this.blocks[j].key;
    this.op(now && remove(this.doc, now), cx, {
      then: () => {
        const p = this.blockByKey(back);
        if (p) this.activate(p.key, this.entry(p, this.openedValue(p), -1, null), cx);
        else this.handle.focus();
      },
    });
  }

  // Forward Delete at the end of a block, which the field reports as a change that left its value alone: once a
  // readout shows the caret there, the next text block joins this one, or the rule after it goes. A raw block takes
  // nothing in.
  deleteAtEnd(cx) {
    if (this.pending || !this.activeKey) return;
    const c = this.caretOf(this.field), end = this.seen.length;
    this.known = c ? { start: c.start, end: c.end, valid: true } : NO_CARET;
    if (!c || c.start !== c.end || c.end !== end) return;
    this.commit(cx);
    const b = this.blockByKey(this.activeKey), i = b ? this.at.get(b.key) : undefined, next = i === undefined ? null : this.blocks[i + 1];
    const n = next && byKey(this.doc, next.key);
    if (!n) return;
    if (n.kind === "hr") return this.op(remove(this.doc, n), cx, { at: this.caretDoc(), caret: end });
    if (isText(b) && isText(n)) this.op(mergeNext(this.doc, b, n), cx, { caret: end });
  }

  tab(dir, cx) {
    if (this.pending) return this.pendingKey(dir > 0 ? "tab" : "shift-tab", cx);
    const b = this.blockByKey(this.activeKey), r = b && this.caretNow();
    if (!b || !r) return;
    if (b.kind === "table") return this.toCell(dir, r, cx);
    this.commit(cx);
    const now = this.blockByKey(this.activeKey);
    if (!now) return;
    const op = now.kind === "item" ? (dir > 0 ? indent : outdent) : dir > 0 ? nest : unnest;
    if (this.op(op(this.doc, now), cx, { caret: { start: r.start, end: r.end } })) return;
    if (isRaw(now.kind) && dir > 0 && r.start === r.end) this.typeText("    ", cx);
  }

  toCell(dir, r, cx) {
    const cell = nextCell(this.seen, r.start, dir);
    if (!cell || !this.guard(() => this.field.set_selected_range(cell))) return;
    this.known = { start: cell.start, end: cell.end, valid: true };
    this.revealCaret(cx);
  }

  // Page Up / Page Down while editing: the page moves by its height less 40 and the caret a page with it, to the start
  // of the row there, which is the row now at its place on the screen unless the page could not move that far. Past
  // the first or last block the caret goes to its start or end.
  pageCaret(dir, cx) {
    this.caretNow();
    const i = this.at.get(this.activeKey), top = i === undefined ? null : this.caretTop(i), blocks = this.blocks;
    if (top === null || !this.viewport || this.sums.length !== blocks.length + 1) return;
    const page = pageStep(this.viewH()), y = top + dir * page, edge = y < 0 || y >= this.sums[blocks.length];
    const j = this.caretBlockNear(edge ? (dir > 0 ? blocks.length - 1 : 0) : blockAt(this.sums, y), edge ? -dir : dir);
    const b = j < 0 ? null : this.blockByKey(blocks[j].key);
    if (!b) return;
    this.offset = clampOffset(this.offset + dir * page, this.contentH(), this.viewH()); this.reveal = null;
    const value = b.key === this.activeKey ? this.seen : this.openedValue(b);
    this.activate(b.key, edge ? this.entry(b, value, -dir, null) : this.pressCaret(b, 0, y - this.sums[j]), cx);
    this.rearm(cx);
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
    const b = this.blockByKey(this.activeKey);
    if (b) this.op(move(this.doc, b, dir), cx, { caret: r ? { start: r.start, end: r.end } : 0 });
  }

  // The line breaks that end the clipboard's text are left out of a text block, so that the text after the caret stays
  // on the last pasted line; a raw block takes the text exactly.
  pasteText(cx) {
    const clip = cx.read_from_clipboard?.();
    if (typeof clip !== "string" || !clip) return;
    const lf = clip.replace(/\r\n/g, "\n"), b = this.pending ? null : this.blockByKey(this.activeKey);
    if (!b && !this.pending) return;
    const text = lf.replace(/\n+$/, "");
    if ((b && !isText(b)) || !text) return this.typeText(lf, cx);
    const r = text.includes("\n") ? this.caretNow() : null;
    if (!r) return this.typeText(text, cx);
    if (this.pending) {
      // Written with a stand-in text where it goes, which the paste then replaces.
      const value = this.seen.slice(0, r.start) + text + this.seen.slice(r.end), p = this.pending;
      const w = chain(this.doc, p.base(this.doc, PLACEHOLDER), [...p.steps, (d, b) => paste(d, b, 0, PLACEHOLDER.length, value)]);
      if (!w) return this.typeText(text, cx);
      return this.pasted({ ...w.splice, caret: w.splice.caret - (value.length - r.start - text.length) }, cx);
    }
    // A paragraph left with no text is no block once parsed: the lines take its place as it is now.
    if (b.kind === "paragraph" && !this.seen.trim() && this.f?.text === this.text) {
      const s = type(this.f, text, 0, b.depth > 0 ? b.contPrefix : "");
      return s && this.pasted(s, cx);
    }
    this.known = { start: r.start, end: r.end, valid: true };
    this.commit(cx);
    const now = this.blockByKey(this.activeKey);
    if (!now) return;
    const s = isText(now) && this.known.valid ? paste(this.doc, now, this.known.start, this.known.end, text) : null;
    if (s) this.pasted(s, cx);
    else this.typeText(text, cx);
  }

  typeText(text, cx) {
    this.history.close();
    const typed = this.typeOwn(text, cx);
    this.history.close();
    return typed;
  }

  // Our text goes in at the field's selection and is taken in at once, apart from typing not taken in yet.
  typeOwn(text, cx) {
    this.syncField(cx);
    if (!this.guard(() => this.replaceIn(this.field, text))) return false;
    this.syncField(cx, true);
    return true;
  }

  pasted(s, cx) {
    this.release();
    this.change(s, cx, { caretAfter: s.caret });
    this.openAt(s.caret, cx);
  }

  // Cmd+Z (dir < 0) and Cmd+Shift+Z. No commit first: its rules of leaving would record entries that this undo then
  // took back, and Cmd+Z on a block emptied by typing would seem to do nothing. An empty block that a key opened, and
  // nothing was typed in yet, is undone by going back to where the key was pressed.
  undo(dir, cx) {
    if (!this.file || !this.loaded || this.error || this.remote || this.locked) return;
    this.syncSource(cx);
    this.syncField(cx);
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
    this.setText(text, cx, false);
    this.openAt(u.caret, cx);
  }

  openAt(at, cx, caret = null) {
    if (!this.editable()) return this.handle.focus();
    const b = this.holding(at);
    if (!b) return this.openPending(cx);
    if (!this.activate(b.key, caret ?? docToField(fieldOf(this.doc, b), at), cx)) this.handle.focus();
  }

  // The slash menu belongs to one activation of a block that can still be written, and only while its field shows
  // "/" + query where the menu says: a stale menu draws nothing and takes no key, should a close be missed. The check
  // fixture has no file and shows its menu all the same.
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
    this.disarm(cx);
    this.redraw([this.activeKey], cx);
    cx.notify();
  }

  // In code, tables and diagram source a slash is text, and Enter a new line there. Without the key table Enter is
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

  // The caret read out after a key or a press moved it: the menu stays only while the caret is in its query.
  slashCaret(c, cx) {
    const s = this.slash;
    if (s && !(c && c.start === c.end && c.end > s.at && c.end <= s.end)) this.closeSlash(cx);
  }

  // A key of the table while the menu is open. -> true when the menu took it: Up and Down move the highlight, Enter
  // and Tab pick it, Escape closes the menu. Enter and Tab with no rows, and every other key, close it and then do
  // what they always do.
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

  // Command c picked: the block becomes what it names, or its lines go in where the slash was, and "/query" goes.
  // That is one entry of the history. A block a text style leaves empty goes when it is left so, as one the user
  // emptied would: it keeps the value it was opened with. A line the commit parses as a raw block (`~~~ /code`)
  // takes no command, and neither does a block retype refuses: both stay as typed.
  slashPick(c, cx) {
    this.syncField(cx);
    if (!this.slashOpen()) return;
    const s = this.slash;
    this.closeSlash(cx);
    if (this.pending) return this.slashPending(c, cx);
    // A Shift key-up (`/` on some layouts) leaves the caret unknown, and the pick's undo puts it back where it was.
    if (!this.known.valid) this.caretNow();
    const opened = this.opened;
    this.commit(cx);
    const b = this.blockByKey(this.activeKey);
    if (!b || !isText(b) || !this.f || this.seen.slice(s.at, s.end) !== `/${s.query}`) return;
    const at = fieldToDoc(this.f, s.at), length = s.end - s.at;
    const unquery = { start: at, end: at + length, insert: "", caret: at };
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

  // Text picked in a block that holds nothing but the query: an empty paragraph, which is one not written yet, in its
  // place. An item keeps its sub-items, moved out with it.
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

  // Where the menu goes now: over or under the caret row, its edge at the slash. Null while that row has no place.
  slashPlace() {
    const s = this.slash, key = this.activeKey, i = this.at.get(key), d = this.data.get(key);
    if (i === undefined || !d || this.sums.length !== this.blocks.length + 1) return null;
    const top = this.caretTop(i, s.end);
    if (top === null) return null;
    const viewW = this.viewport?.width ?? this.size?.width ?? 900, viewH = this.viewport?.height ?? UNSIZED_VIEW_H;
    const place = menuPlace({ rowTop: COLUMN.padTop + top - this.offset, rowH: d.row, viewH, n: s.items.length, side: s.side });
    s.side = place.side;
    const c = this.chromeOf(d, true), col = s.at - (this.seen.lastIndexOf("\n", s.at - 1) + 1);
    return { ...place, left: slashX({ col, advance: this.calOf(d.style).advance, fieldW: c.w, fieldX: c.x, viewW }) };
  }

  // The menu, drawn by the root over the page. Its rows take presses and the pointer before anything under them.
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

  // A calibration sample was measured: once all of a style's samples are, its row, field line height and pads follow,
  // and they are used once every style has them.
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

  // The theme, the fonts or the zoom changed since the last draw. A draw may not notify, so the work goes to a timer.
  checkLook(t, cx) {
    const look = [Object.values(t).join(), this.fonts.sans, this.fonts.mono, zoom()].join("|");
    if (this.look === look) return;
    const first = this.look === null;
    this.look = look;
    if (!first) cx.timer.after(0, cx => this.restyle(cx));
  }

  // Every block draws again in the new look, even those not mounted now, the samples are measured again in it, and
  // each diagram is asked for in the new colours, showing its last image until the new one is drawn.
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

  // A big buffer is counted as of the last time it settled (a save timer, a load, a mode switch), not on every key.
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
      .on_mouse_move((e, cx) => this.viewportMove(e, cx))
      .on_hover((hovered, cx) => this.viewportHover(hovered, cx));
    if (!this.blocks.length) {
      if (!this.editable()) vp.child(div().id("md-note-empty").absolute().left(0).right(0).top(0).bottom(0).flex().items_center().justify_center().text_color(t.muted).child("This note is empty."));
    } else {
      const column = this.inline
        ? v_flex().id("md-column").w_full().children(this.mountedItems(k => renderBlock(this, this.data.get(k))))
        : this.column;
      vp.child(div().id("md-scroller").absolute().left(0).right(0).top(-this.offset)
        .child(div().id("md-page").w_full().max_w(COLUMN.maxWidth).mx_auto().px(COLUMN.padX).pt(COLUMN.padTop).pb(COLUMN.padBottom).child(column)));
      const g = this.thumbGeometry();
      if (g) {
        vp.child(div().id("md-thumb").absolute().right(3).top(g.top).w(6).h(g.h).min_h(28).rounded(3).bg(this.thumb ? t.muted : t.border)
          .hover(s => s.bg(t.muted))
          .on_mouse_down("left", (e, cx) => this.thumbDown(e, cx)));
      }
    }
    const menu = this.slashMenu(t);
    if (menu) vp.child(menu);
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
        .on_mouse_down("left", () => this.forgetSourceCaret())
        .on_key_up(e => this.sourceKeyUp(e))
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
    const { words, lines } = this.counts(), status = this.diagramStatus();
    const path = !this.file ? "" : this.remote ? `${this.machine}:${this.file}` : tildePath(this.file, home());
    return h_flex().id("md-footer").h(26).flex_none().px(14).gap(12).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
      .child(this.saveState(t))
      .child(div().id("md-counts").flex_none().child(`${count(words, "word", "words")} · ${count(lines, "line", "lines")}`))
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
      .on_modifiers_changed((e, cx) => this.modifiersChanged(e, cx))
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
