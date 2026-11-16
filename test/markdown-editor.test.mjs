import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { state, calls, reset } from "./mocks/herdr.mjs";
import { files, log, hold } from "./mocks/fs.mjs";
import { all, find, textOf, fire } from "./mocks/element.mjs";
import { makeCx, fire_timers, space, must } from "./helpers.mjs";
import { png } from "./pictures.mjs";

const { Editor } = await import("../mods/herdr-inline-markdown/editor.js");
const { default: Markdown } = await import("../mods/herdr-inline-markdown/main.js");
const { stats, fileKey, diagramKey, mermaidConfig, sharpName } = await import("../mods/herdr-inline-markdown/lib.js");
const { owners, STYLES, INDENT, MARKER_W, QUOTE_BAR, QUOTE_PAD, spaceBefore } = await import("../mods/herdr-inline-markdown/page.js");
const { theme } = await import("./mocks/herdr.mjs");
const { liveFields, TextareaState } = await import("./mocks/gpui-base.mjs");
const { parse, diff } = await import("../mods/herdr-inline-markdown/blocks.js");
const { bigDocument } = await import("./markdown-corpus.mjs");
const { TEXT, RAW, SOURCE, NOTE, INSTALLED } = await import("../mods/herdr-inline-markdown/keys.js");
const { COMMANDS } = await import("../mods/herdr-inline-markdown/slash.js");
const { PICTURE, pictureLayout, BAR, barSize, NOTE_BOX, NOTES, CARD } = await import("../mods/herdr-inline-markdown/geometry.js");
const { POINT } = await import("../mods/herdr-inline-markdown/comments.js");

const FILE = "/n/docs/note.md";
const DOC = "# Title\n\nHello **world**.\n\n```mermaid\ngraph TD\nA-->B\n```\n\nBye\n";
// The blocks of DOC: the heading, the paragraph, the diagram (block 2), the last paragraph.
const MERMAID = "/home/user/.local/share/herdr-inline-markdown/mermaid";
const SANS = ".SystemUIFont";
const NONCHAR = String.fromCharCode(0xffff), BOM = String.fromCharCode(0xfeff);

// Herdr draws the Column and Block views itself; the mock draws them when they are looked into.
const keyAt = (m, i) => m.view.doc.blocks[i].key;
const blockAt = (m, i, t = m.tree()) => must(t, `md-block-${keyAt(m, i)}`);
const viewAt = (m, i, t) => all(blockAt(m, i, t), n => n.kind === "textview")[0];
const viewportOf = (m, width = 900, height = 600) => fire(must(m.tree(), "md-viewport"), "on_size_change", { width, height }, m.cx);
// Blocks report their heights from their own views; the size task takes them in on its next turn.
async function heights(m, list) {
  const t = m.tree();
  for (const [i, h] of Object.entries(list)) fire(blockAt(m, Number(i), t), "on_size_change", { width: 716, height: h }, m.cx);
  await flush();
}
const press = (point, more = {}) => ({ button: "left", click_count: 1, position: point, local_position: point, modifiers: { shift: false, control: false, alt: false, platform: false }, ...more });
const act = (m, name) => fire(must(m.tree(), "md-root"), `on_action:${name}`, { action: name }, m.cx);
const escape = m => act(m, "mdb-escape");
async function clickAt(m, point) {
  const vp = must(m.tree(), "md-viewport");
  fire(vp, "on_mouse_down:left", press(point), m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press(point), m.cx);
  await flush();
}

beforeEach(() => reset());

// The nextCommand and watchFolder loops never end, so a cx must not wait for every task: settle is a few trips
// through the event loop, which is long enough for anything the mocks answer at once.
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(done => setImmediate(done)); };

// What Herdr does, as seen in the running app: a copy starts while focused() still names the tab before its own and
// panes() does not list its pane yet; it is drawn only while its tab is the shown one, then focused().tab is its own.
const PANES = "herdr-inline-markdown.panes";
const tabOf = (id, name) => ({ id, name, active: false, zoomed: false, status: null });
const farFocus = (tab, pane = null) => { state.focused = { space: "s1", tab, pane, terminal: null, shown: null, agent: null, cwd: null }; };
const shellPane = { pane: "p1", terminal: "t-p1", tab: "tb1", cwd: "/n", focused: true };
const mdPane = (pane, tab) => ({ pane, terminal: null, tab, cwd: null, focused: false, mod: "herdr-inline-markdown" });
const mdPaneOf = tab => ({ ...mdPane(`p-${tab}`, tab), focused: true });
const split = (pane, file, machine = null) => ["pane.split", { direction: "right", pane, mod: "herdr-inline-markdown", props: { file, machine } }];

async function mount({ file = FILE, machine, disk, props } = {}) {
  if (disk !== undefined) state.disk.set(file, disk);
  const commands = [], watching = [];
  state.nextCommand = () => new Promise(done => commands.push(done));
  state.watchFolder = dir => new Promise((done, fail) => watching.push({ dir, done, fail }));
  const p = props ?? { file, machine };
  state.props = p;
  const cx = makeCx();
  cx.settle = flush;
  const view = new Editor();
  view.init(p, cx);
  await flush();
  const tree = () => view.render(cx);
  return {
    view, cx, tree, watching,
    send: async name => { commands.shift()(name); await flush(); },
    touch: async paths => { watching.shift().done(paths); await flush(); },
    // Typing in the source, which leaves its caret after what changed.
    type: async text => {
      const d = diff(view.source.value(), text);
      view.source.edit(text, cx);
      view.source.select(d.at + d.inserted.length);
      await flush();
    },
    click: async id => { fire(must(tree(), id), "on_click", {}, cx); await flush(); },
    key: async keystroke => { fire(must(tree(), "md-root"), "on_key_down", { keystroke }, cx); await flush(); },
    save: async () => { await fire_timers(cx, { ms: 700 }); },
    status: () => textOf(must(tree(), "md-status")).trim(),
    banner: () => textOf(find(tree(), "md-banner") ?? { kind: "text", text: "", kids: [] }).trim(),
  };
}

// Writes that wait to be answered: pending[i].land() puts the text on disk and answers, .fail(error) refuses.
function slowWrites() {
  const pending = [];
  const real = state.writeTextFile;
  state.writeTextFile = (path, text, expected) => new Promise((done, fail) => pending.push({
    path, text, expected,
    land: () => real(path, text, expected).then(done, fail),
    answer: () => done(null),
    fail,
  }));
  return pending;
}

// Every element with a handler, hover, tooltip, scroll or focus has an id, and ids are unique.
function audit(tree) {
  const seen = new Set();
  for (const n of all(tree)) {
    const interactive = Object.keys(n.handlers).length || n.hover || n.style.tooltip !== undefined || n.style.overflow_y_scrollbar || n.focus;
    if (interactive) assert.ok(n.id, `${n.kind} "${textOf(n).slice(0, 30)}" needs an id`);
    if (n.id !== null) {
      assert.ok(!seen.has(n.id), `duplicate id ${n.id}`);
      seen.add(n.id);
    }
  }
  return seen;
}

function renderer({ width = 800, height = 400, version = "mmdc-test+1" } = {}) {
  state.disk.set(`${MERMAID}/version`, version);
  state.disk.set(`${MERMAID}/node-path`, "/usr/local/bin/node");
  state.exec = async (_c, args) => ({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: args.slice(5).map(f => ({ key: f.slice(f.lastIndexOf("/") + 1).replace(/\.mmd$/, ""), ok: true, width, height, scale: 2 })) })}\n` });
  return version;
}
const keyOf = (source, version) => diagramKey(source, JSON.stringify(mermaidConfig(theme())), version);
const imageOf = (tree, id) => all(find(tree, id), n => n.kind === "image")[0];

test("a file opens in Reading: a centered page of blocks in a viewport, the Column and each block nested views", async () => {
  const m = await mount({ disk: DOC });
  assert.equal(m.view.mode, "reading");
  const t = m.tree();
  assert.equal(find(t, "md-source"), null, "nothing to type in");
  const vp = must(t, "md-viewport");
  assert.ok(vp.style.relative && vp.style.overflow_hidden && vp.style.flex_1 && vp.style.min_h === 0);
  for (const h of ["on_scroll_wheel", "on_mouse_down:left", "on_mouse_up:left", "on_mouse_move", "on_hover", "on_size_change"]) assert.equal(typeof vp.handlers[h], "function", h);
  const scroller = must(t, "md-scroller");
  assert.deepEqual([scroller.style.absolute, scroller.style.left, scroller.style.right, scroller.style.top], [true, 0, 0, -0]);
  const page = must(t, "md-page");
  assert.deepEqual([page.style.max_w, page.style.px, page.style.pt, page.style.pb, page.style.mx_auto], [780, 32, 28, 160, true]);
  const column = page.kids[0];
  assert.equal(column.kind, "entity");
  assert.equal(column.entity.view.constructor.name, "Column");
  const blocks = must(t, "md-column").kids;
  assert.deepEqual(blocks.map(k => [k.kind, k.entity.view.constructor.name, k.entity.props.key]), m.view.doc.blocks.map(b => ["entity", "Block", b.key]));
  assert.deepEqual(blocks.map(k => k.entity.props.owner), Array(4).fill(m.view.id), "every block names its editor");
  assert.ok(blocks.every(k => Object.values(k.entity.props).every(v => typeof v === "string")), "props carry only strings");
  assert.equal(owners.get(m.view.id), m.view);
  const title = viewAt(m, 0, t);
  assert.equal(title.markdown, "Title");
  assert.equal(title.style.selectable, true);
  assert.equal(typeof title.handlers.on_link_click, "function");
  assert.equal(viewAt(m, 1, t).markdown, "Hello **world**.");
  assert.ok(find(t, `md-diagram-${keyAt(m, 2)}`));
  assert.equal(viewAt(m, 3, t).markdown, "Bye");
  audit(t);
});

test("the font: the theme's sans on the root and on every TextView's parent, so weights show", async () => {
  const m = await mount({ disk: "# Big\n\n**bold** and _em_\n\n- item\n\n> quote\n\n| a |\n|---|\n| b |\n" });
  const t = m.tree();
  assert.equal(must(t, "md-root").style.font_family, SANS);
  const parents = [];
  const visit = n => { for (const k of n.kids) { if (k.kind === "textview") parents.push(n); visit(k); } };
  visit(must(t, "md-column"));
  assert.ok(parents.length >= 5);
  for (const p of parents) assert.equal(p.style.font_family, SANS);
});

test("type: each block is drawn in its kind's style, headings by level, code, front matter and definitions in mono; space above comes from the document", async () => {
  const doc = "---\na: 1\n---\n# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n\nPara\n\n```js\nx\n```\n\n[r]: https://e.com\n\n<!-- note -->\n";
  const m = await mount({ disk: doc });
  const t = m.tree();
  const typeOf = i => {
    const el = all(blockAt(m, i, t), n => n.style.text_size !== undefined && n.style.font_family !== undefined)[0];
    return [el.style.text_size, el.style.font_weight, el.style.line_height, el.style.font_family];
  };
  const styled = name => [STYLES[name].size, STYLES[name].weight, STYLES[name].lh, STYLES[name].mono ? "Mono" : SANS];
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(typeOf), [1, 2, 3, 4, 5, 6].map(level => styled(`h${level}`)));
  assert.deepEqual(typeOf(7), styled("p"));
  assert.deepEqual(typeOf(8), styled("mono"));
  assert.deepEqual([0, 9, 10].map(typeOf), [styled("small"), styled("small"), styled("small")]);
  assert.deepEqual([9, 10].map(i => all(blockAt(m, i, t), n => n.style.text_color)[0].style.text_color), ["dim", "dim"]);
  assert.deepEqual(m.view.doc.blocks.map((_, i) => blockAt(m, i, t).style.pt), m.view.doc.blocks.map((_, i) => spaceBefore(m.view.doc.blocks, i)));
  assert.equal(all(blockAt(m, 7, t), n => n.style.min_h === 24).length, 1, "a text block is at least a row tall");
});

test("chrome: markers by depth, numbers, checkboxes, the quote bar, the code language, front matter, the rule", async () => {
  const doc = "---\nt: x\n---\n- a\n  - b\n    - c\n- [ ] open\n- [x] done\n\n3. three\n4) four\n\n> said\n\n```py\nprint()\n```\n\n---\n";
  const m = await mount({ disk: doc });
  const t = m.tree();
  const front = blockAt(m, 0, t).kids[0];
  assert.equal(textOf(front).trim(), "t: x");
  const markerOf = i => blockAt(m, i, t).kids[0].kids[0];
  assert.deepEqual([markerOf(1).style.w, markerOf(1).style.h], [MARKER_W, m.view.data.get(keyAt(m, 1)).row], "a marker column, one row tall");
  assert.deepEqual([1, 2, 3].map(i => blockAt(m, i, t).style.pl), [0, INDENT, 2 * INDENT], "one indent per depth");
  const dot = markerOf(1).kids[0], ring = markerOf(2).kids[0], square = markerOf(3).kids[0];
  assert.deepEqual([dot.style.bg, Boolean(dot.style.rounded), dot.style.border], ["foreground", true, undefined], "a filled round dot");
  assert.deepEqual([ring.style.bg, Boolean(ring.style.rounded), Boolean(ring.style.border), ring.style.border_color], [undefined, true, true, "foreground"], "a bordered, unfilled ring");
  assert.deepEqual([square.style.bg, square.style.rounded, square.style.border], ["foreground", undefined, undefined], "a filled square corner");
  const open = must(t, `md-task-${keyAt(m, 4)}`), done = must(t, `md-task-${keyAt(m, 5)}`);
  assert.deepEqual([open.style.border_color, open.style.bg, open.style.cursor_pointer], ["input", undefined, true]);
  assert.deepEqual([done.style.bg, done.style.border_color], ["accent", "accent"]);
  assert.deepEqual(all(done, n => n.kind === "svg").map(n => [n.path, n.style.text_color]), [["mods/herdr-inline-markdown/check.svg", "accent_foreground"]]);
  assert.equal(viewAt(m, 5, t).markdown, "done");
  assert.equal(all(blockAt(m, 5, t), n => n.style.line_through).length, 1, "a done task is struck through on the TextView's parent");
  assert.equal(all(blockAt(m, 4, t), n => n.style.line_through).length, 0);
  assert.deepEqual([6, 7].map(i => [textOf(markerOf(i)).trim(), markerOf(i).style.justify_end]), [["3.", true], ["4)", true]]);
  const quote = blockAt(m, 8, t).kids[0];
  assert.deepEqual([quote.kids[0].style.w, quote.kids[0].style.bg, quote.kids[1].style.pl], [QUOTE_BAR, "input", QUOTE_PAD]);
  const code = blockAt(m, 9, t).kids[0];
  const lang = all(code, n => n.style.absolute)[0];
  assert.deepEqual([textOf(lang).trim(), lang.style.text_color], ["py", "dim"]);
  assert.equal(all(code, n => n.kind === "textview").length, 0, "code is plain mono text, as the field draws it");
  assert.equal(blockAt(m, 10, t).kids[0].kids[0].style.bg, "border", "the rule is a line in the border colour");
  audit(t);
});

test("an empty local note opens in Reading with an empty paragraph open and the keyboard in it; nothing is written for it", async () => {
  for (const disk of ["", "\n \n"]) {
    reset();
    const m = await mount({ disk });
    assert.equal(m.view.mode, "reading");
    const key = m.view.activeKey;
    assert.ok(key && m.view.pending, "an empty paragraph that the text does not have");
    assert.equal(m.view.field.focused, true);
    assert.equal(m.view.field.value(), "");
    assert.deepEqual(must(m.tree(), "md-column").kids.map(k => k.entity.props.key), [key]);
    assert.ok(find(m.tree(), `md-field-${key}`));
    assert.equal(must(m.tree(), `md-field-${key}`).style.key_context, `${TEXT} rows=one`);
    for (const id of ["md-note-empty", "md-start", "md-empty"]) assert.equal(find(m.tree(), id), null, id);
    audit(m.tree());
    fire(must(m.tree(), "md-root"), "on_action:mdb-escape", { action: "mdb-escape" }, m.cx);
    assert.equal(m.view.activeKey, null);
    assert.deepEqual([find(m.tree(), "md-note-empty"), find(m.tree(), "md-column")], [null, null], "left empty, it is gone, and no placeholder shows");
    await m.save();
    assert.equal(calls.writeTextFile.length, 0);
  }
  reset();
  const fm = await mount({ disk: "---\na: 1\n---\n" });
  assert.equal(fm.view.mode, "reading", "front matter is something");
  assert.equal(fm.view.activeKey, null);
  assert.equal(find(fm.tree(), "md-note-empty"), null);
});

test("a new empty note takes typing at once: the first letter writes the paragraph, the rest go into it", async () => {
  const m = await mount({ disk: "" });
  const pending = m.view.activeKey;
  m.view.field.type("H", m.cx);
  assert.equal(m.view.text, "H");
  assert.equal(m.view.pending, null);
  assert.notEqual(m.view.activeKey, pending, "the paragraph is a block of the text now");
  assert.equal(m.view.doc.blocks[0].key, m.view.activeKey);
  assert.equal(m.view.field.log.filter(([c]) => c === "set_value").length, 1, "the field was not set again: the caret stays");
  m.view.field.type("ello world", m.cx);
  assert.equal(m.view.text, "Hello world");
  await m.save();
  assert.equal(state.disk.get(FILE), "Hello world");
  assert.ok(find(m.tree(), `md-field-${m.view.activeKey}`));
  reset();
  const blank = await mount({ disk: "\n \n" });
  blank.view.field.type("  ", blank.cx);
  assert.equal(blank.view.text, "\n \n", "spaces alone make no block and write nothing");
  blank.view.field.type("x", blank.cx);
  assert.equal(blank.view.text, "\n \n  x");
  assert.deepEqual(blank.view.doc.blocks.map(b => b.kind), ["paragraph"]);
});

test("the file's text and the opening state: Reading for a file with text, the root with the keyboard", async () => {
  const full = await mount({ disk: "some text" });
  assert.equal(full.view.mode, "reading");
  assert.equal(full.view.handle.focused, true, "the root takes the keyboard at the end of a load");
  assert.equal(full.view.source.focused, false);
  assert.equal(full.view.source.value(), "some text", "the source field holds it too");
  assert.deepEqual(calls.readTextFile[0], { path: FILE, options: { on: null } });
});

test("Loading… until the file is read", async () => {
  let answer;
  state.readTextFile = () => new Promise(done => { answer = done; });
  const m = await mount();
  assert.equal(textOf(m.tree()).trim(), "Loading…");
  assert.equal(find(m.tree(), "md-toolbar"), null);
  answer("# Hi");
  await flush();
  assert.ok(find(m.tree(), "md-toolbar"));
  audit(m.tree());
});

test("a file that is missing when the tab opens starts empty, with an empty paragraph open, and the Deleted banner", async () => {
  const m = await mount();
  assert.equal(m.view.mode, "reading");
  assert.ok(m.view.pending);
  assert.equal(m.status(), "Deleted");
  assert.match(m.banner(), /This file was deleted or moved/);
  assert.ok(find(m.tree(), "md-save-again"));
});

test("unreadable files say why and show nothing else: over 1 MiB, other errors", async () => {
  state.readTextFile = async () => { throw new Error("file is larger than 1 MiB"); };
  const big = await mount();
  assert.match(textOf(big.tree()), /1 MiB/);
  for (const id of ["md-toolbar", "md-footer", "md-banner", "md-viewport", "md-source"]) assert.equal(find(big.tree(), id), null, id);
  assert.ok(find(big.tree(), "md-root"));
  audit(big.tree());
  reset();
  state.readTextFile = async () => { throw new Error("permission denied"); };
  const denied = await mount();
  assert.match(textOf(denied.tree()), /Can't open this file: permission denied/);
});

test("ids are unique and every element with a handler has one, in both states and every banner", async () => {
  const m = await mount({ disk: DOC });
  viewportOf(m, 900, 100);
  await heights(m, { 0: 60, 1: 60, 2: 200, 3: 60 });
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    for (const id of audit(m.tree())) seen.add(id);
    await m.click("md-markdown");
  }
  for (const id of ["md-root", "md-toolbar", "md-status", "md-markdown", "md-footer", "md-viewport", "md-page", "md-thumb", "md-source", "md-source-column"]) assert.ok(seen.has(id), id);
  state.disk.set(FILE, "other");
  await m.click("md-markdown");
  await m.type("mine");
  await m.save();
  assert.ok(find(m.tree(), "md-keep-mine"));
  audit(m.tree());
  state.disk.delete(FILE);
  await m.touch([FILE]);
  assert.ok(find(m.tree(), "md-save-again"));
  audit(m.tree());
});

test("the Markdown toggle: pressed while the source shows, which takes the keyboard; back in Reading the block holding the source caret has it", async () => {
  const m = await mount({ disk: DOC });
  const button = () => must(m.tree(), "md-markdown");
  assert.equal(find(m.tree(), "md-modes"), null, "the three-way switch is gone");
  let b = button();
  assert.deepEqual([b.style.bg, b.style.text_color, b.hover], [undefined, "muted", true], "off: muted, with a hover background");
  assert.deepEqual(all(b, n => n.kind === "svg").map(n => n.path), ["mods/herdr-inline-markdown/code.svg"]);
  assert.equal(textOf(b).trim(), "Markdown");
  m.view.handle.focused = false;
  await m.click("md-markdown");
  assert.equal(m.view.mode, "markdown");
  b = button();
  assert.deepEqual([b.style.bg, b.style.text_color], ["selected", "foreground"]);
  assert.ok(find(m.tree(), "md-source") && !find(m.tree(), "md-viewport"));
  assert.equal(m.view.source.focused, true);
  await m.click("md-markdown");
  assert.equal(m.view.mode, "reading");
  assert.equal(m.view.activeKey, keyAt(m, 0), "the source caret was at the start of the first block");
  assert.deepEqual([m.view.field.focused, m.view.field.selection], [true, { start: 0, end: 0 }]);
  assert.ok(find(m.tree(), "md-viewport"));
  m.view.source.focused = false;
  await fire_timers(m.cx, { ms: 80 });
  assert.equal(m.view.source.focused, false, "the late focus does not pull the keyboard back into the source field in Reading");
  assert.equal(calls.writeTextFile.length, 0, "nothing was unsaved");
});

test("the state is remembered per file as reading or markdown (newest last, at most 200), and used the next time the file opens", async () => {
  const a = await mount({ disk: DOC });
  await a.click("md-markdown");
  assert.deepEqual(calls.setShared.filter(([k]) => k === "herdr-inline-markdown.modes").at(-1), ["herdr-inline-markdown.modes", { [fileKey(null, FILE)]: "markdown" }]);
  const b = await mount();
  assert.equal(b.view.mode, "markdown");
  reset();
  state.shared["herdr-inline-markdown.modes"] = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`:/old/${i}.md`, "edit"]));
  const c = await mount({ disk: DOC });
  await c.click("md-markdown");
  const kept = state.shared["herdr-inline-markdown.modes"];
  assert.equal(Object.keys(kept).length, 200);
  assert.equal(Object.keys(kept).at(-1), fileKey(null, FILE));
  assert.ok(!(":/old/0.md" in kept) && ":/old/1.md" in kept);
  await c.click("md-markdown");
  assert.equal(Object.keys(state.shared["herdr-inline-markdown.modes"]).at(-1), fileKey(null, FILE), "switching again keeps it newest");
  assert.equal(state.shared["herdr-inline-markdown.modes"][fileKey(null, FILE)], "reading");
});

test("remembered states from the old modes: a stored split or edit opens in Markdown, read in Reading, nonsense is ignored", async () => {
  for (const [stored, disk, mode] of [["split", DOC, "markdown"], ["edit", DOC, "markdown"], ["read", "", "reading"], ["sideways", "x", "reading"], ["reading", "", "reading"]]) {
    reset();
    state.shared["herdr-inline-markdown.modes"] = { [fileKey(null, FILE)]: stored };
    const m = await mount({ disk });
    assert.equal(m.view.mode, mode, stored);
  }
});

test("cmd-e toggles Reading and Markdown, cmd-s saves now; both stop the key, others pass", async () => {
  const m = await mount({ disk: "old" });
  await m.key("cmd-e");
  assert.deepEqual([m.view.mode, m.cx.stopped], ["markdown", 1]);
  await m.type("new");
  await m.key("cmd-s");
  assert.deepEqual([m.cx.stopped, calls.writeTextFile], [2, [{ path: FILE, text: "new", expected: "old" }]], "written without waiting for the 700 ms");
  await fire_timers(m.cx, { ms: 700 });
  assert.equal(calls.writeTextFile.length, 1, "the waiting save was cancelled by it");
  await m.key("space");
  assert.equal(m.cx.stopped, 2, "Markdown keeps its own keys");
  await m.key("cmd-e");
  assert.equal(m.view.mode, "reading");
  await m.key("cmd-shift-e");
  await m.key("cmd-w");
  await m.key("a");
  assert.deepEqual([m.view.mode, m.cx.stopped], ["reading", 3], "other keys are left alone");
});

test("commands: save, toggle, reading, markdown, the old read / edit / split, focus; anything else is ignored", async () => {
  const m = await mount({ disk: "old" });
  await m.send("toggle");
  assert.equal(m.view.mode, "markdown");
  await m.type("new");
  await m.send("save");
  assert.deepEqual(calls.writeTextFile.map(c => c.text), ["new"]);
  for (const [name, mode] of [["reading", "reading"], ["markdown", "markdown"], ["read", "reading"], ["edit", "markdown"], ["read", "reading"], ["split", "markdown"]]) {
    await m.send(name);
    assert.equal(m.view.mode, mode, name);
  }
  m.view.source.focused = false;
  await m.send("focus");
  assert.equal(m.view.source.focused, true, "focus goes to where typing goes");
  await m.send("toggle");
  assert.equal(m.view.mode, "reading");
  assert.ok(m.view.activeKey, "the block holding the source caret is open");
  m.view.field.focused = false;
  await m.send("focus");
  assert.equal(m.view.field.focused, true, "in the block being edited");
  fire(must(m.tree(), "md-root"), "on_action:mdb-escape", { action: "mdb-escape" }, m.cx);
  m.view.handle.focused = false;
  await m.send("focus");
  assert.equal(m.view.handle.focused, true, "with no block open, on the page");
  await m.send("nonsense");
  assert.equal(m.view.mode, "reading");
});

test("the root takes the keyboard, hears size changes (one redraw per change), and the toggle drops its label below 560 px", async () => {
  const m = await mount({ disk: "x" });
  const root = must(m.tree(), "md-root");
  assert.equal(root.focus, m.view.handle);
  const label = () => textOf(must(m.tree(), "md-markdown")).trim();
  assert.equal(label(), "Markdown");
  fire(root, "on_size_change", { width: 500, height: 600 }, m.cx);
  assert.deepEqual([label(), must(m.tree(), "md-markdown").style.tooltip, must(m.tree(), "md-markdown").style.px], ["", "Markdown", 8], "icon only, the label in a tooltip");
  const before = m.cx.notified;
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 500, height: 600 }, m.cx);
  assert.equal(m.cx.notified, before, "the same size draws nothing again");
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 560, height: 600 }, m.cx);
  assert.equal(label(), "Markdown");
  assert.equal(must(m.tree(), "md-markdown").style.tooltip, undefined);
});

test("sizes come in screen pixels and are divided by the zoom setting: the label, the columns and the redraw check all work in layout pixels", async () => {
  state.settings = { ...state.settings, zoom: 1.5 };
  renderer({ width: 3200, height: 1600 });
  const m = await mount({ disk: DOC });
  const label = () => textOf(must(m.tree(), "md-markdown")).trim();
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 900, height: 1200 }, m.cx); // 600 x 800 layout pixels
  assert.deepEqual(m.view.size, { width: 600, height: 800 });
  assert.equal(label(), "Markdown", "600 >= 560");
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 810, height: 1200 }, m.cx); // 540 layout pixels
  assert.deepEqual(m.view.size, { width: 540, height: 800 });
  assert.equal(label(), "", "810 screen pixels are less than 560 once zoomed");
  const before = m.cx.notified;
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 810, height: 1200 }, m.cx);
  assert.equal(m.cx.notified, before, "the same size draws nothing again");
  // The diagram's frame is sized in layout pixels: a 1000 x 600 viewport is 936 x 420 at most (1436 x 630 unzoomed).
  await drawn(m);
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 1500, height: 1000 }, m.cx);
  viewportOf(m, 1500, 900);
  assert.deepEqual(m.view.viewport, { width: 1000, height: 600 }, "the viewport's size too");
  const frame = must(m.tree(), `md-frame-${keyAt(m, 2)}`);
  assert.deepEqual([frame.style.w, frame.style.h], [936, 420]);
  const img = all(frame, n => n.kind === "image")[0];
  assert.deepEqual([img.style.w, img.style.h], [1200, 600], "at the readable 75 %");
});

test("at zoom 1 (or none, or nonsense) the size is taken as it is", async () => {
  for (const zoom of [1, undefined, 0, "x"]) {
    reset();
    state.settings = { ...state.settings, zoom };
    const m = await mount({ disk: "x" });
    fire(must(m.tree(), "md-root"), "on_size_change", { width: 700, height: 500 }, m.cx);
    assert.deepEqual(m.view.size, { width: 700, height: 500 }, String(zoom));
  }
  reset();
  state.settings = null;
  const m = await mount({ disk: "x" });
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 700, height: 500 }, m.cx);
  assert.deepEqual(m.view.size, { width: 700, height: 500 });
});

// Ten paragraphs: block 0 is 24 px tall, the others 38 (14 above, one row); the column is 28 + 366 + 160 = 554 px.
const TEN = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n";
async function tall(viewH = 200) {
  const m = await mount({ disk: TEN });
  viewportOf(m, 900, viewH);
  await heights(m, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, i ? 38 : 24])));
  return m;
}
const wheel = (m, dy) => fire(must(m.tree(), "md-viewport"), "on_scroll_wheel", { delta: { x: 0, y: dy }, touch_phase: "moved" }, m.cx);

test("the wheel moves the page by its pixel delta and the offset clamps to the content", async () => {
  const m = await tall();
  assert.equal(m.view.contentH(), 554);
  wheel(m, -100);
  assert.equal(m.view.offset, 100);
  assert.equal(must(m.tree(), "md-scroller").style.top, -100, "the column moves up by the offset");
  wheel(m, -10000);
  assert.equal(m.view.offset, 354, "no further than the last row on the page");
  wheel(m, 30);
  assert.equal(m.view.offset, 324);
  const before = m.cx.notified;
  wheel(m, 10000);
  assert.equal(m.view.offset, 0);
  wheel(m, 50);
  assert.equal(m.cx.notified, before + 1, "a wheel that cannot move draws nothing");
  state.settings = { ...state.settings, zoom: 2 };
  wheel(m, -100);
  assert.equal(m.view.offset, 50, "deltas are screen pixels too");
});

test("keys with no block active: Up and Down 48 px, Page Up / Page Down / Space a page less 40, Home and End", async () => {
  const m = await tall();
  const step = async (key, offset) => { await m.key(key); assert.equal(m.view.offset, offset, key); };
  await step("down", 48);
  await step("down", 96);
  await step("up", 48);
  await step("pagedown", 208);
  await step("space", 354);
  await step("shift-space", 194);
  await step("pageup", 34);
  await step("end", 354);
  await step("home", 0);
  assert.equal(m.cx.stopped, 9, "each one is ours");
  await m.key("x");
  assert.equal(m.cx.stopped, 9);
});

test("the thumb: 6 px at the right, as tall as the page's share, at the offset's share; a drag scrolls, and ends when the pointer leaves", async () => {
  const m = await tall();
  let thumb = must(m.tree(), "md-thumb");
  const h = (200 * 200) / 554;
  assert.deepEqual([thumb.style.w, thumb.style.right, thumb.style.rounded, thumb.style.min_h, thumb.style.bg, thumb.hover], [6, 3, 3, 28, "border", true]);
  assert.ok(Math.abs(thumb.style.h - h) < 1e-9);
  assert.equal(thumb.style.top, 0);
  fire(thumb, "on_mouse_down:left", press({ x: 895, y: 10 }), m.cx);
  assert.equal(m.cx.stopped, 1, "the page does not see the press");
  assert.equal(must(m.tree(), "md-thumb").style.bg, "muted", "muted while dragged");
  fire(must(m.tree(), "md-viewport"), "on_mouse_move", { position: { x: 895, y: 60 }, local_position: { x: 895, y: 60 } }, m.cx);
  const offset = (50 * 354) / (200 - h);
  assert.ok(Math.abs(m.view.offset - offset) < 1e-9, `${m.view.offset}`);
  thumb = must(m.tree(), "md-thumb");
  assert.ok(Math.abs(thumb.style.top - 50) < 1e-9, "the thumb follows the pointer");
  fire(must(m.tree(), "md-viewport"), "on_hover", false, m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_move", { position: { x: 895, y: 150 }, local_position: { x: 895, y: 150 } }, m.cx);
  assert.ok(Math.abs(m.view.offset - offset) < 1e-9, "the drag ended when the pointer left");
  fire(must(m.tree(), "md-thumb"), "on_mouse_down:left", press({ x: 895, y: 60 }), m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press({ x: 895, y: 60 }), m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_move", { position: { x: 895, y: 0 }, local_position: { x: 895, y: 0 } }, m.cx);
  assert.ok(Math.abs(m.view.offset - offset) < 1e-9, "and on mouse-up");
  reset();
  const short = await mount({ disk: "one line" });
  viewportOf(short, 900, 600);
  await heights(short, { 0: 24 });
  assert.equal(find(short.tree(), "md-thumb"), null, "no thumb when everything fits");
});

test("a height change above the first visible block leaves that block's screen y unchanged", async () => {
  const m = await tall();
  m.view.scrollTo(28 + 24 + 38 * 4 + 10, m.cx); // block 5 is the first one whose bottom is on the page
  const y = () => 28 + m.view.sums[5] - m.view.offset;
  const before = y();
  await heights(m, { 2: 138 });
  assert.equal(y(), before, "block 2 grew by 100 px: the page moved with it");
  assert.equal(m.view.offset, 28 + 24 + 38 * 4 + 10 + 100);
  await heights(m, { 0: 4, 1: 30 });
  assert.equal(y(), before);
  await heights(m, { 8: 200 });
  assert.equal(y(), before, "a change below moves nothing");
  m.view.scrollTo(0, m.cx);
  await heights(m, { 0: 60 });
  assert.equal(m.view.offset, 0, "at the top the page stays at the top");
});

test("a disk change above the first visible block keeps it where it was, measured or estimated", async () => {
  const m = await tall();
  m.view.scrollTo(28 + 24 + 38 * 4 + 10, m.cx);
  const key = keyAt(m, 5), y = () => 28 + m.view.sums[m.view.doc.blocks.findIndex(b => b.key === key)] - m.view.offset;
  const before = y();
  state.disk.set(FILE, `New first line\n\n${TEN}`);
  await m.touch([FILE]);
  assert.equal(keyAt(m, 6), key, "the block kept its key");
  assert.equal(y(), before);
  await heights(m, { 0: 24, 1: 38 });
  assert.equal(y(), before, "and again once the new block is measured");
});

test("a click on a task box changes exactly that byte on disk; a click on the item's text does nothing", async () => {
  const disk = "Intro\n\n- [ ] first\n- [x] second\n  - [ ] nested\n";
  const m = await mount({ disk });
  viewportOf(m, 900, 600);
  await heights(m, { 0: 24, 1: 62, 2: 30, 3: 30 }); // "first" wraps onto a second row
  const x0 = 60 + 32, top = i => 28 + m.view.sums[i] + m.view.data.get(keyAt(m, i)).space;
  m.cx.notifiedEntities.length = 0;
  await clickAt(m, { x: x0 + 12, y: top(1) + 12 });
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "Intro\n\n- [x] first\n- [x] second\n  - [ ] nested\n", expected: disk }], "saved at once");
  assert.deepEqual(m.cx.notifiedEntities, [m.view.entities.get(keyAt(m, 1))], "the ticked item alone is told to draw again");
  await clickAt(m, { x: x0 + 12, y: top(2) + 12 });
  await flush();
  assert.equal(state.disk.get(FILE), "Intro\n\n- [x] first\n- [ ] second\n  - [ ] nested\n");
  await clickAt(m, { x: x0 + 24 + 12, y: top(3) + 12 });
  await flush();
  assert.equal(state.disk.get(FILE), "Intro\n\n- [x] first\n- [ ] second\n  - [x] nested\n", "the nested box sits 24 px in");
  const writes = calls.writeTextFile.length;
  await clickAt(m, { x: x0 + 100, y: top(1) + 12 });
  await clickAt(m, { x: x0 + 12, y: top(1) + 30 });
  await clickAt(m, { x: x0 + 12, y: top(0) + 12 });
  assert.equal(calls.writeTextFile.length, writes, "the text, below the first row, a paragraph");
  const vp = must(m.tree(), "md-viewport");
  fire(vp, "on_mouse_down:left", press({ x: x0 + 12, y: top(1) + 12 }), m.cx);
  fire(vp, "on_mouse_up:left", press({ x: x0 + 40, y: top(1) + 12 }, { click_count: 0 }), m.cx);
  await flush();
  assert.equal(calls.writeTextFile.length, writes, "a drag is not a click");
  assert.equal(must(m.tree(), `md-task-${keyAt(m, 1)}`).kids.length, 1, "the ticked box shows its check");
});

test("a task box takes clicks at the offset the page is scrolled to", async () => {
  const disk = `${TEN}\n- [ ] last\n`;
  const m = await mount({ disk });
  viewportOf(m, 900, 200);
  await heights(m, { ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, i ? 38 : 24])), 10: 38 });
  m.view.scrollTo(300, m.cx);
  const top = 28 + m.view.sums[10] + 14 - 300;
  await clickAt(m, { x: 92 + 12, y: top + 12 });
  await flush();
  assert.equal(state.disk.get(FILE), `${TEN}\n- [x] last\n`);
});

test("calibration: one and three rows of each style, rendered and in a field, set the rows, the field's line height and the pads", async () => {
  const m = await mount({ disk: "# Title\n\nText\n" });
  const strip = must(m.tree(), "md-cal");
  assert.deepEqual([strip.style.absolute, strip.style.top], [true, -10000]);
  assert.equal(must(strip, "md-cal-p-tv3-view").markdown, "Ag\\\nAg\\\nAg", "three rows made with hard breaks");
  assert.equal(all(must(strip, "md-cal-p-f3"), n => n.kind === "textarea")[0].state.value(), "Ag\nAg\nAg");
  const sizes = { p: [24, 72, 24, 72, 283.2], h1: [35, 105, 35, 105, 527], h2: [28.5, 85.5, 30, 88, 414], h3: [25, 75, 25, 75, 339], h4: [24, 72, 24, 72, 301], h5: [24, 72, 24, 72, 283], h6: [24.5, 69.5, 22, 66, 264], mono: [19.5, 58.5, 20, 60, 321.2], small: [18, 54, 18, 54, 296] };
  const t = m.tree();
  m.cx.notifiedEntities.length = 0;
  for (const [name, [tv1, tv3, f1, f3, adv]] of Object.entries(sizes)) {
    for (const [part, h] of [["tv1", tv1], ["tv3", tv3], ["f1", f1], ["f3", f3]]) fire(must(t, `md-cal-${name}-${part}`), "on_size_change", { width: 600, height: h }, m.cx);
    fire(must(t, `md-cal-${name}-adv`), "on_size_change", { width: adv, height: 20 }, m.cx);
  }
  assert.deepEqual(m.view.cal.p, { row: 24, ratio: 1.6, padActive: 0, padRendered: 0, advance: 283.2 / 40 });
  assert.deepEqual(m.view.cal.h2, { row: 28.5, ratio: 28.5 / 22, padActive: 0, padRendered: 1, advance: 414 / 40 }, "the field's extra pixel goes under the rendered heading");
  assert.deepEqual([m.view.cal.h6.row, m.view.cal.h6.padActive, m.view.cal.h6.padRendered], [22.5, 2, 0], "a field shorter than TextView gets the difference under it");
  assert.equal(find(m.tree(), "md-cal"), null, "the strip is gone once measured");
  assert.deepEqual([m.view.data.get(keyAt(m, 0)).row, m.view.data.get(keyAt(m, 0)).ratio], [35, 1.25]);
  assert.deepEqual(m.cx.notifiedEntities, [], "a calibration that matches the defaults redraws no block");
});

test("calibration that differs from the defaults redraws the blocks of that style with the measured row and pad", async () => {
  const m = await mount({ disk: "## Title\n\nText\n" });
  const t = m.tree();
  for (const name of ["p", "h1", "h2", "h3", "h4", "h5", "h6", "mono", "small"]) {
    const [tv1, tv3, f1, f3] = name === "h2" ? [28.5, 85.5, 30, 88] : [24, 72, 24, 72];
    for (const [part, h] of [["tv1", tv1], ["tv3", tv3], ["f1", f1], ["f3", f3]]) fire(must(t, `md-cal-${name}-${part}`), "on_size_change", { width: 600, height: h }, m.cx);
    fire(must(t, `md-cal-${name}-adv`), "on_size_change", { width: 300, height: 20 }, m.cx);
  }
  const title = m.view.entities.get(keyAt(m, 0));
  assert.ok(m.cx.notifiedEntities.includes(title));
  const wrap = all(blockAt(m, 0), n => n.style.min_h !== undefined)[0];
  assert.deepEqual([wrap.style.min_h, wrap.style.pb], [28.5, 1]);
});

test("typing saves 700 ms after the last key, over the text the file had; another key moves the wait", async () => {
  const m = await mount({ disk: "old\n" });
  await m.click("md-markdown");
  assert.equal(m.status(), "Saved");
  await m.type("new");
  assert.equal(m.status(), "Unsaved");
  assert.ok(find(m.tree(), "md-status").kids.some(k => k.style.bg === "accent" && k.style.size === 6), "with a small accent dot");
  await m.type("new!");
  const waits = m.cx.timers.filter(t => t.ms === 700);
  assert.deepEqual(waits.map(t => Boolean(t.cancelled)), [true, false]);
  assert.equal(calls.writeTextFile.length, 0);
  await m.save();
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "new!", expected: "old\n" }]);
  assert.equal(state.disk.get(FILE), "new!");
  assert.equal(m.status(), "Saved");
  assert.equal(find(m.tree(), "md-banner"), null);
  await m.type("newer");
  await m.save();
  assert.deepEqual(calls.writeTextFile.at(-1), { path: FILE, text: "newer", expected: "new!" }, "each write expects what the last one left");
});

test("while a write is in flight the status says Saving…, and there is never a second write beside it", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("one");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  assert.equal(writes.length, 1);
  assert.equal(m.status(), "Saving…");
  await m.key("cmd-s");
  assert.equal(writes.length, 1, "cmd-s while saving does not start another");
  writes[0].land();
  await fired;
  await flush();
  assert.equal(m.status(), "Saved");
  assert.equal(writes.length, 1);
});

test("what is typed during a write is saved after it, over the text that write left", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("one");
  const first = fire_timers(m.cx, { ms: 700 });
  await flush();
  await m.type("two");
  await fire_timers(m.cx, { ms: 700 });
  assert.equal(writes.length, 1, "the timer fired during the write and did nothing");
  writes[0].land();
  await first;
  await flush();
  assert.equal(m.status(), "Unsaved", "not saved yet: the newer text waits its 700 ms");
  const second = fire_timers(m.cx, { ms: 700 });
  await flush();
  assert.deepEqual([writes.length, writes[1].text, writes[1].expected], [2, "two", "one"]);
  writes[1].land();
  await second;
  await flush();
  assert.equal(state.disk.get(FILE), "two");
  assert.equal(m.status(), "Saved");
});

test("typing text back to what the file has writes nothing", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("older");
  await m.type("old");
  await m.save();
  assert.equal(calls.writeTextFile.length, 0);
  assert.equal(m.status(), "Saved");
});

test("a change event for text we already have (set_value reporting itself) is ignored", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  m.view.source.handlers.change({}, m.cx); // a report with the text we already have
  assert.equal(m.cx.timers.filter(t => t.ms === 700).length, 0);
  state.disk.set(FILE, "newer");
  // An external apply whose set_value reports a change at once (the real box may): still no save, no unsaved mark.
  m.view.source.set_value = function (next) { this.text = String(next); this.handlers.change({}, m.cx); };
  await m.touch([FILE]);
  assert.equal(m.view.text, "newer");
  assert.equal(m.status(), "Saved");
  assert.equal(m.cx.timers.filter(t => t.ms === 700).length, 0);
  await m.save();
  assert.equal(calls.writeTextFile.length, 0);
});

test("a write refused because the file changed is a conflict: nothing overwritten, no more saves, Keep mine writes over theirs", async () => {
  const m = await mount({ disk: "old\n" });
  await m.click("md-markdown");
  await m.type("mine");
  state.disk.set(FILE, "theirs"); // somebody else saved; the watcher has not told us yet
  await m.save();
  assert.deepEqual(calls.writeTextFile.map(c => c.expected), ["old\n"]);
  assert.equal(state.disk.get(FILE), "theirs", "their text is still there");
  assert.equal(m.status(), "Conflict");
  assert.equal(must(m.tree(), "md-status").style.text_color, "blocked");
  assert.match(m.banner(), /Changed on disk/);
  assert.ok(find(m.tree(), "md-keep-mine") && find(m.tree(), "md-load-theirs"));
  assert.equal(find(m.tree(), "md-save-again"), null);
  assert.equal(m.view.text, "mine", "what was typed stays");
  await m.type("mine!");
  await m.save();
  await m.key("cmd-s");
  assert.equal(calls.writeTextFile.length, 1, "nothing is written while the question is open");
  await m.click("md-keep-mine");
  assert.deepEqual(calls.writeTextFile.at(-1), { path: FILE, text: "mine!", expected: "theirs" });
  assert.equal(state.disk.get(FILE), "mine!");
  assert.equal(m.status(), "Saved");
  assert.equal(find(m.tree(), "md-banner"), null);
});

test("a disk change seen while our write is out waits for the write's answer: refused, it is the conflict (no error), and Keep mine writes over theirs", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("mine");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  assert.deepEqual([writes.length, writes[0].expected], [1, "old"]);
  state.disk.set(FILE, "theirs");
  await m.touch([FILE]); // the watcher: not our text, not what we had, and we have unsaved text
  assert.deepEqual([m.status(), m.banner(), m.view.conflict], ["Saving…", "", null], "nothing asked before the write answers");
  writes[0].land(); // refused: the file has "theirs", not "old"
  await fired;
  await flush();
  assert.deepEqual([m.status(), m.view.conflict, m.view.saveError], ["Conflict", "theirs", null], "not 'Not saved': nothing went wrong");
  assert.match(m.banner(), /Changed on disk/);
  await m.click("md-keep-mine");
  assert.deepEqual([writes.length, writes[1].text, writes[1].expected], [2, "mine", "theirs"]);
  writes[1].land();
  await flush();
  assert.equal(state.disk.get(FILE), "mine");
  assert.equal(m.status(), "Saved");
});

test("the file seen holding our buffer while an older write of it is out: refused, that write is no error; landed, the file is looked at again, not taken to hold the older text", async () => {
  for (const ending of ["refused", "landed"]) {
    reset();
    const writes = slowWrites();
    const m = await mount({ disk: "old" });
    await m.click("md-markdown");
    await m.type("one");
    const fired = fire_timers(m.cx, { ms: 700 });
    await flush();
    await m.type("two");
    state.disk.set(FILE, "two"); // somebody wrote what the buffer holds
    await m.touch([FILE]);
    assert.equal(m.view.disk, "two");
    if (ending === "refused") writes[0].land();
    else writes[0].answer(); // ours landed before theirs
    await fired;
    await flush();
    assert.deepEqual([m.view.disk, m.view.saveError, m.view.conflict, m.status()], ["two", null, null, "Saved"], ending);
    await m.save();
    assert.equal(writes.length, 1, `${ending}: nothing more to write`);
  }
});

test("a refused write over the text the file really has (nothing moved it meanwhile) is still Not saved", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  state.writeTextFile = async () => { throw new Error("EROFS: read-only file system"); };
  await m.type("mine");
  await m.save();
  assert.equal(m.status(), "Not saved");
  assert.equal(must(m.tree(), "md-status").style.tooltip, "EROFS: read-only file system");
});

test("Load theirs drops what was typed and shows the file's text; the autosave that was waiting writes nothing", async () => {
  const m = await mount({ disk: "old\n" });
  await m.click("md-markdown");
  await m.type("mine");
  state.disk.set(FILE, "theirs");
  await m.save();
  assert.equal(m.status(), "Conflict");
  await m.type("mine again");
  const log = m.view.source.log.length;
  await m.click("md-load-theirs");
  assert.deepEqual([m.view.text, m.view.source.value(), m.view.disk], ["theirs", "theirs", "theirs"]);
  assert.deepEqual(m.view.source.log.slice(log).map(([call]) => call).slice(0, 2), ["set_selected_range", "replace"], "an edit of the field, which keeps its scroll");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "theirs", "Cmd+Z brings nothing of what was dropped back");
  await m.click("md-markdown");
  assert.equal(m.view.field.value(), "theirs", "and Reading has it, in the block the caret went to");
  escape(m);
  assert.equal(viewAt(m, 0).markdown, "theirs");
  assert.equal(find(m.tree(), "md-banner"), null);
  assert.equal(m.status(), "Saved");
  await m.save();
  await fire_timers(m.cx);
  assert.equal(calls.writeTextFile.length, 1, "only the refused write");
  assert.equal(state.disk.get(FILE), "theirs");
});

test("a refused write where the file now holds our own text is just saved; where it is gone, the file was deleted", async () => {
  const same = await mount({ disk: "old" });
  await same.click("md-markdown");
  state.writeTextFile = async () => { state.disk.set(FILE, "mine"); throw new Error("stale"); };
  await same.type("mine");
  await same.save();
  assert.equal(same.status(), "Saved");
  assert.equal(find(same.tree(), "md-banner"), null);
  assert.equal(same.view.disk, "mine");
  reset();
  const gone = await mount({ disk: "old" });
  await gone.click("md-markdown");
  state.writeTextFile = async () => { state.disk.delete(FILE); throw new Error("stale"); };
  await gone.type("mine");
  await gone.save();
  assert.equal(gone.status(), "Deleted");
  assert.match(gone.banner(), /deleted or moved/);
});

test("a write that fails for its own reason says Not saved with the reason, does not loop, and is tried again on the next edit or cmd-s", async () => {
  state.disk.set(FILE, "old");
  const m = await mount();
  await m.click("md-markdown");
  let refuse = true;
  const real = state.writeTextFile;
  state.writeTextFile = async (...args) => { if (refuse) throw new Error("EACCES: permission denied"); return real(...args); };
  await m.type("mine");
  await m.save();
  assert.equal(m.status(), "Not saved");
  assert.equal(must(m.tree(), "md-status").style.tooltip, "EACCES: permission denied");
  assert.match(m.banner(), /Couldn't save[\s\S]*EACCES/);
  assert.equal(find(m.tree(), "md-keep-mine"), null, "not a conflict");
  await fire_timers(m.cx);
  await fire_timers(m.cx);
  assert.equal(calls.writeTextFile.length, 1, "no retry on its own");
  refuse = false;
  await m.key("cmd-s");
  assert.equal(calls.writeTextFile.length, 2);
  assert.equal(m.status(), "Saved");
  assert.equal(find(m.tree(), "md-banner"), null);
  refuse = true;
  await m.type("mine?");
  await m.save();
  assert.equal(m.status(), "Not saved");
  refuse = false;
  await m.type("mine!!");
  await m.save();
  assert.equal(m.status(), "Saved");
});

test("switching the mode saves what is unsaved first", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("new");
  await m.click("md-markdown");
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "new", expected: "old" }]);
  escape(m);
  assert.equal(viewAt(m, 0).markdown, "new", "Reading shows what was typed");
  assert.equal(m.status(), "Saved");
  await fire_timers(m.cx, { ms: 700 });
  assert.equal(calls.writeTextFile.length, 1);
});

test("a mode switch does not write while a conflict or a deletion stands", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("mine");
  state.disk.set(FILE, "theirs");
  await m.save();
  await m.click("md-markdown");
  assert.equal(calls.writeTextFile.length, 1, "only the refused write");
  assert.equal(m.status(), "Conflict");
});

test("a change on disk with nothing unsaved is shown at once in Reading, and in the source field when it next shows; no write", async () => {
  const m = await mount({ disk: "one\n" });
  assert.deepEqual(calls.watchFolder, ["/n/docs"], "the folder of the file is watched");
  state.disk.set(FILE, "# two\n");
  await m.touch([FILE]);
  assert.deepEqual([m.view.text, m.view.disk], ["# two\n", "# two\n"]);
  assert.equal(viewAt(m, 0).markdown, "two");
  assert.equal(m.view.doc.blocks[0].kind, "heading");
  assert.equal(m.status(), "Saved");
  assert.equal(find(m.tree(), "md-banner"), null);
  assert.equal(calls.writeTextFile.length, 0);
  assert.equal(calls.watchFolder.length, 2, "and watched again after each report");
  state.disk.set(FILE, "three");
  await m.touch([FILE]);
  assert.equal(viewAt(m, 0).markdown, "three");
  await m.click("md-markdown");
  assert.equal(m.view.source.value(), "three");
});

test("a change on disk while the source shows is set into the field, and its caret stays on the same text, shown", async () => {
  const m = await mount({ disk: "alpha\nbeta\ngamma\n" });
  await m.click("md-markdown");
  const field = m.view.source;
  field.set_selected_range({ start: 8, end: 8 }); // inside "beta", where the user clicked
  const before = field.log.length;
  state.disk.set(FILE, "intro\nalpha\nbeta\ngamma\n");
  await m.touch([FILE]);
  assert.equal(field.value(), "intro\nalpha\nbeta\ngamma\n");
  assert.deepEqual(field.log.slice(before), [["set_selected_range", { start: 0, end: 0 }], ["replace", "intro\n"], ["set_selected_range", { start: 14, end: 14 }], ["replace", ""]], "an edit of the field, never set_value, which would scroll it to the top");
  assert.deepEqual(field.selection, { start: 14, end: 14 }, "the caret moved with its text");
  assert.equal(m.view.text, "intro\nalpha\nbeta\ngamma\n");
  await flush();
  assert.equal(m.view.text, "intro\nalpha\nbeta\ngamma\n", "the change events of that edit are ours");
});

test("Cmd+Z after a disk change shown in the source takes back the user's typing and keeps the agent's line", async () => {
  const m = await mount({ disk: "plan\n" });
  await m.click("md-markdown");
  await m.type("plan!\n");
  await m.save();
  assert.equal(state.disk.get(FILE), "plan!\n");
  state.disk.set(FILE, "plan!\nagent step\n");
  await m.touch([FILE]);
  assert.equal(m.view.source.value(), "plan!\nagent step\n");
  act(m, "mdb-undo");
  await flush();
  await m.save();
  assert.equal(m.view.source.value(), "plan\nagent step\n");
  assert.equal(state.disk.get(FILE), "plan\nagent step\n");
  assert.deepEqual(calls.writeTextFile.map(w => w.expected), ["plan\n", "plan!\nagent step\n"], "the undo is saved over the agent's text");
});

test("without the key table the field keeps its own Cmd+Z: a disk change goes in by set_value, so that undo cannot take it back", async () => {
  delete globalThis[INSTALLED];
  state.disk.set(FILE, "plan\n");
  const cx = makeCx(), commands = [], watching = [];
  cx.settle = flush;
  cx.bind_keys = () => { throw new Error("unknown context"); };
  state.nextCommand = () => new Promise(done => commands.push(done));
  state.watchFolder = () => new Promise(done => watching.push(done));
  const view = new Editor();
  view.init({ file: FILE }, cx);
  await flush();
  fire(must(view.render(cx), "md-markdown"), "on_click", {}, cx);
  view.source.edit("plan!\n", cx);
  await fire_timers(cx, { ms: 700 });
  state.disk.set(FILE, "plan!\nagent step\n");
  const before = view.source.log.length;
  watching.shift()([FILE]);
  await flush();
  assert.ok(view.source.log.slice(before).some(([call, text]) => call === "set_value" && text === "plan!\nagent step\n"), "the disk text goes in by set_value");
  view.source.undo(cx);
  await flush();
  await fire_timers(cx, { ms: 700 });
  assert.equal(view.source.value(), "plan!\nagent step\n");
  assert.equal(state.disk.get(FILE), "plan!\nagent step\n");
  assert.equal(calls.writeTextFile.length, 1, "only the user's own save");
  delete globalThis[INSTALLED];
});

test("a selection made in the source with no event reaching the mod (a drag) stays on its text across a disk change", async () => {
  const m = await mount({ disk: "alpha\nbeta\n" });
  await m.click("md-markdown");
  const field = m.view.source;
  field.select(7, 9); // "et"
  state.disk.set(FILE, "intro\nalpha\nbeta\n");
  await m.touch([FILE]);
  assert.equal(field.value(), "intro\nalpha\nbeta\n");
  assert.deepEqual(field.selection, { start: 13, end: 15 }, "still \"et\"");
});

test("the watcher's paths: the file, a folder above it or a root path are ours; other files in the folder are not", async () => {
  const m = await mount({ disk: "x" });
  const reads = () => calls.readTextFile.length;
  const base = reads();
  await m.touch(["/n/docs/other.md", "/n/docs/sub/deep.md", "/n/docs/note.md.swp"]);
  assert.equal(reads(), base, "other files do not make us read");
  for (const [i, paths] of [[1, ["/n/docs/note.md"]], [2, ["/n/docs"]], [3, ["/n"]], [4, ["/"]], [5, ["/n/docs/other.md", "/n/docs/note.md"]], [6, ["/private/n/docs/note.md"]]]) {
    await m.touch(paths);
    assert.equal(reads(), base + i, `${paths}`);
  }
});

test("a change on disk while there are unsaved edits is a conflict that keeps the buffer; the banner follows the file", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("mine");
  state.disk.set(FILE, "theirs");
  await m.touch([FILE]);
  assert.equal(m.status(), "Conflict");
  assert.match(m.banner(), /Changed on disk/);
  assert.deepEqual([m.view.text, m.view.source.value(), m.view.conflict], ["mine", "mine", "theirs"]);
  assert.equal(calls.writeTextFile.length, 0, "found by looking, nothing written");
  state.disk.set(FILE, "theirs, edited");
  await m.touch([FILE]);
  assert.equal(m.view.conflict, "theirs, edited", "the newest text of theirs is the one offered");
  await m.click("md-load-theirs");
  assert.deepEqual([m.view.text, m.view.source.value()], ["theirs, edited", "theirs, edited"]);
  assert.equal(m.status(), "Saved");
});

test("an empty file on disk is a change like any other (empty is not 'nothing')", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("mine");
  state.disk.set(FILE, "");
  await m.touch([FILE]);
  assert.equal(m.view.conflict, "");
  assert.equal(m.status(), "Conflict");
  await m.click("md-load-theirs");
  assert.equal(m.view.text, "");
  assert.equal(m.status(), "Saved");
});

test("a conflict goes away when the file goes back to what we had, and the unsaved text is saved after all", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("mine");
  state.disk.set(FILE, "theirs");
  await m.touch([FILE]);
  assert.equal(m.status(), "Conflict");
  await m.save(); // the autosave comes due during the conflict and does nothing
  assert.equal(calls.writeTextFile.length, 0);
  state.disk.set(FILE, "old");
  await m.touch([FILE]);
  assert.equal(m.status(), "Unsaved");
  assert.equal(find(m.tree(), "md-banner"), null);
  await m.save();
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "mine", expected: "old" }]);
});

test("somebody saving the very text we have is no conflict", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("same");
  state.disk.set(FILE, "same");
  await m.touch([FILE]);
  assert.equal(m.status(), "Saved");
  assert.equal(find(m.tree(), "md-banner"), null);
  await m.save();
  assert.equal(calls.writeTextFile.length, 0);
});

test("the file changing while our own write is in flight (watcher sees saving === now) is our write: no conflict, no reload", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("new");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  assert.equal(writes.length, 1);
  state.disk.set(FILE, "new"); // the write has landed; its answer is not back yet
  const reads = calls.readTextFile.length;
  await m.touch([FILE]);
  assert.equal(calls.readTextFile.length, reads + 1, "the watcher made us look");
  assert.deepEqual([m.view.conflict, m.view.text, m.status()], [null, "new", "Saving…"]);
  assert.equal(find(m.tree(), "md-banner"), null);
  writes[0].answer();
  await fired;
  await flush();
  assert.deepEqual([m.view.conflict, m.view.text, m.view.disk, m.status()], [null, "new", "new", "Saved"]);
  assert.equal(calls.writeTextFile.length, 1);
});

test("our write landing while more is being typed: the watcher sees the text being saved, which is ours, not a conflict", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("new");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  await m.type("new, and more"); // the buffer has moved on from what is being written
  state.disk.set(FILE, "new");
  await m.touch([FILE]);
  assert.deepEqual([m.view.conflict, m.view.text, m.status()], [null, "new, and more", "Saving…"]);
  assert.equal(find(m.tree(), "md-banner"), null);
  writes[0].answer();
  await fired;
  await flush();
  assert.equal(m.status(), "Unsaved", "the rest is still to be saved");
  await m.save();
  assert.deepEqual(calls.writeTextFile.at(-1), { path: FILE, text: "new, and more", expected: "new" });
});

test("a look at the file that began before our write finished, and answers with the older text, is thrown away and repeated", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("new");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  const reads = [];
  state.readTextFile = () => new Promise(done => reads.push(done));
  const watched = m.touch([FILE]); // a look begins while the write is still going
  await flush();
  assert.equal(reads.length, 1);
  state.disk.set(FILE, "new");
  writes[0].answer(); // the write finishes while the look is out
  await fired;
  await flush();
  reads[0]("old"); // ...and the look answers with what the file held before it
  await flush();
  assert.equal(reads.length, 2, "it looked again instead of believing the old answer");
  reads[1]("new");
  await watched;
  await flush();
  assert.deepEqual([m.view.text, m.view.source.value(), m.view.disk, m.view.conflict, m.status()], ["new", "new", "new", null, "Saved"]);
});

test("looks are one at a time: a report during a look makes one more look after it", async () => {
  const m = await mount({ disk: "a" });
  const answers = [];
  state.readTextFile = () => new Promise(done => answers.push(done));
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 900, height: 600 }, m.cx);
  const base = answers.length;
  await m.touch([FILE]);
  await m.touch([FILE]);
  await m.touch([FILE]);
  assert.equal(answers.length - base, 1, "one look is out");
  answers[base]("b");
  await flush();
  assert.equal(answers.length - base, 2, "and one more came of the reports meanwhile");
  answers[base + 1]("c");
  await flush();
  assert.equal(m.view.text, "c");
  assert.equal(answers.length - base, 2);
});

test("a file deleted on disk shows the banner; nothing is written until Save again, which recreates it with the buffer", async () => {
  const m = await mount({ disk: "keep me" });
  state.disk.delete(FILE);
  await m.touch([FILE]);
  assert.equal(m.status(), "Deleted");
  assert.match(m.banner(), /This file was deleted or moved/);
  assert.ok(find(m.tree(), "md-save-again"));
  assert.equal(find(m.tree(), "md-keep-mine"), null);
  assert.equal(m.view.text, "keep me", "what is shown stays");
  await m.click("md-markdown");
  await m.type("keep me!");
  await m.save();
  await m.key("cmd-s");
  assert.equal(calls.writeTextFile.length, 0, "the file is not made again behind the person's back");
  await m.click("md-save-again");
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "keep me!", expected: null }]);
  assert.equal(state.disk.get(FILE), "keep me!");
  assert.equal(m.status(), "Saved");
  assert.equal(find(m.tree(), "md-banner"), null);
  await m.type("more");
  await m.save();
  assert.deepEqual(calls.writeTextFile.at(-1), { path: FILE, text: "more", expected: "keep me!" });
});

test("Save again over a file that came back meanwhile is a conflict, not an overwrite", async () => {
  const m = await mount({ disk: "old" });
  state.disk.delete(FILE);
  await m.touch([FILE]);
  state.disk.set(FILE, "someone's new file"); // back, and we have not looked yet
  await m.click("md-save-again");
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "old", expected: null }]);
  assert.equal(state.disk.get(FILE), "someone's new file");
  assert.equal(m.status(), "Conflict");
  assert.ok(find(m.tree(), "md-keep-mine"));
  assert.equal(find(m.tree(), "md-save-again"), null);
});

test("Save again that cannot create the file says why and stays Deleted", async () => {
  const m = await mount({ disk: "old" });
  state.disk.delete(FILE);
  await m.touch([FILE]);
  state.writeTextFile = async () => { throw new Error("No such file or directory"); };
  await m.click("md-save-again");
  assert.equal(m.status(), "Deleted");
  assert.match(m.banner(), /Couldn't save it again: No such file or directory/);
  assert.ok(find(m.tree(), "md-save-again"));
});

test("a file that comes back: the banner goes and a clean buffer shows the new text; unsaved text waits for its autosave", async () => {
  const clean = await mount({ disk: "old" });
  state.disk.delete(FILE);
  await clean.touch([FILE]);
  assert.equal(clean.status(), "Deleted");
  state.disk.set(FILE, "back again");
  await clean.touch([FILE]);
  assert.equal(clean.status(), "Saved");
  assert.equal(clean.view.text, "back again");
  assert.equal(find(clean.tree(), "md-banner"), null);

  reset();
  const dirty = await mount({ disk: "old" });
  await dirty.click("md-markdown");
  await dirty.type("mine");
  state.disk.delete(FILE);
  await dirty.touch([FILE]);
  assert.equal(dirty.status(), "Deleted");
  await dirty.save(); // the autosave comes due while it is gone and does nothing
  assert.equal(calls.writeTextFile.length, 0);
  state.disk.set(FILE, "old"); // back as it was
  await dirty.touch([FILE]);
  assert.equal(dirty.status(), "Unsaved");
  await dirty.save();
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "mine", expected: "old" }]);
  assert.equal(dirty.status(), "Saved");

  reset();
  const other = await mount({ disk: "old" });
  await other.click("md-markdown");
  await other.type("mine");
  state.disk.delete(FILE);
  await other.touch([FILE]);
  state.disk.set(FILE, "different");
  await other.touch([FILE]);
  assert.equal(other.status(), "Conflict", "back with other text while we have edits");
});

test("a failed look (the read rejects) changes nothing", async () => {
  const m = await mount({ disk: "x" });
  state.readTextFile = async () => { throw new Error("EIO"); };
  await m.touch([FILE]);
  assert.equal(m.status(), "Saved");
  assert.equal(find(m.tree(), "md-banner"), null);
  assert.equal(m.view.text, "x");
});

test("when watching fails the file is looked at every 4 s instead; a poll that finds nothing redraws nothing", async () => {
  state.disk.set(FILE, "one");
  state.watchFolder = () => Promise.reject(new Error("too many directories"));
  state.nextCommand = () => new Promise(() => {});
  const cx = makeCx();
  cx.settle = flush;
  const view = new Editor();
  view.init({ file: FILE }, cx);
  await flush();
  assert.equal(calls.watchFolder.length, 1, "asked once, not in a loop");
  const polls = cx.timers.filter(t => !t.once);
  assert.deepEqual(polls.map(t => t.ms), [4000]);
  const before = cx.notified;
  polls[0].fn(cx);
  await flush();
  assert.equal(cx.notified, before, "nothing changed, nothing drawn");
  state.disk.set(FILE, "two");
  polls[0].fn(cx);
  await flush();
  assert.equal(view.text, "two");
  assert.ok(cx.notified > before);
});

test("a file straight in the home folder (or /) is polled, not watched", async () => {
  for (const file of ["/home/user/todo.md", "/todo.md"]) {
    reset();
    state.disk.set(file, "x");
    const m = await mount({ file });
    assert.equal(calls.watchFolder.length, 0, file);
    assert.deepEqual(m.cx.timers.filter(t => !t.once).map(t => t.ms), [4000]);
  }
});

test("a file on another machine opens in Reading, shows Read-only, is polled every 5 s, and is never written", async () => {
  state.shared["herdr-inline-markdown.modes"] = { [fileKey("devbox", FILE)]: "markdown" };
  state.disk.set(FILE, "remote text\n\n- [ ] a task\n");
  const m = await mount({ machine: "devbox" });
  assert.equal(m.view.mode, "reading", "whatever was remembered");
  assert.equal(m.status(), "Read-only · devbox");
  assert.deepEqual(calls.readTextFile[0], { path: FILE, options: { on: "devbox" } });
  assert.equal(calls.watchFolder.length, 0, "only this computer's folders can be watched");
  assert.deepEqual(m.cx.timers.filter(t => !t.once).map(t => t.ms), [5000]);
  let t = m.tree();
  assert.match(textOf(must(t, "md-footer")), /devbox:\/n\/docs\/note\.md/);
  assert.doesNotMatch(textOf(must(t, "md-toolbar")), /devbox|\/n\/docs/, "the place is in the footer, not the toolbar");
  const box = must(t, `md-task-${keyAt(m, 1)}`);
  assert.deepEqual([box.style.cursor_pointer, box.style.cursor_default], [undefined, true], "a checkbox that does nothing keeps the default cursor");
  audit(t);

  viewportOf(m);
  await heights(m, { 0: 24, 1: 30 });
  assert.equal(m.view.hit({ x: 92 + 12, y: 28 + 24 + 14 + 12 })?.on, "task", "the press below is on the box");
  await clickAt(m, { x: 92 + 12, y: 28 + 24 + 14 + 12 });
  assert.equal(m.view.text, "remote text\n\n- [ ] a task\n", "the box does not tick");

  await m.click("md-markdown");
  assert.equal(m.view.mode, "markdown", "the toggle shows the source");
  t = m.tree();
  const code = all(must(t, "md-source"), n => n.kind === "editor")[0];
  assert.equal(code.state, m.view.viewer);
  assert.deepEqual(m.view.viewer.options, { language: "markdown", readonly: true, line_numbers: false, folding: false, soft_wrap: true, font_family: "Mono", font_size: 13.5 });
  assert.equal(m.view.viewer.value(), "remote text\n\n- [ ] a task\n");
  assert.equal(all(t, n => n.kind === "textarea").length, 0, "nothing to type in");
  await m.key("cmd-e");
  for (const name of ["edit", "split", "toggle", "save"]) await m.send(name);
  assert.equal(m.view.source.focused, false);
  m.view.source.edit("hacked", m.cx); // even if something typed into the source field
  await m.key("cmd-s");
  await fire_timers(m.cx);
  assert.equal(m.view.text, "remote text\n\n- [ ] a task\n");
  assert.deepEqual(calls.setShared.filter(([k]) => k === "herdr-inline-markdown.modes"), [], "its state is not remembered");

  state.disk.set(FILE, "remote changed");
  m.cx.timers.find(x => !x.once).fn(m.cx);
  await flush();
  assert.equal(m.view.text, "remote changed", "the poll brought the change in");
  assert.equal(m.view.viewer.value(), "remote changed");
  await m.send("reading");
  assert.equal(viewAt(m, 0).markdown, "remote changed");
  await m.view.close(m.cx);
  assert.equal(calls.writeTextFile.length, 0, "never, by any route");
});

test("a remote file that is deleted says so without offering to save; an empty remote note offers no writing", async () => {
  state.disk.set(FILE, "x");
  const m = await mount({ machine: "devbox" });
  state.disk.delete(FILE);
  m.cx.timers.find(x => !x.once).fn(m.cx);
  await flush();
  assert.equal(m.status(), "Deleted");
  assert.match(m.banner(), /deleted or moved/);
  assert.equal(find(m.tree(), "md-save-again"), null);
  reset();
  state.disk.set(FILE, "");
  const empty = await mount({ machine: "devbox" });
  assert.equal(empty.view.mode, "reading");
  const note = must(empty.tree(), "md-note-empty");
  assert.match(textOf(note), /This note is empty/);
  assert.deepEqual([note.style.text_color, note.style.items_center, note.style.justify_center], ["muted", true, true]);
  assert.equal(find(empty.tree(), "md-start"), null);
});

test("close() writes what is unsaved, over the text the file had", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("typed just now");
  await m.view.close(m.cx);
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "typed just now", expected: "old" }]);
  assert.equal(state.disk.get(FILE), "typed just now");
});

test("close() writes nothing when nothing is unsaved, or while a conflict or a deletion stands, or the write was refused", async () => {
  const clean = await mount({ disk: "old" });
  await clean.view.close(clean.cx);
  assert.equal(calls.writeTextFile.length, 0);

  reset();
  const conflict = await mount({ disk: "old" });
  await conflict.click("md-markdown");
  await conflict.type("mine");
  state.disk.set(FILE, "theirs");
  await conflict.touch([FILE]);
  await conflict.view.close(conflict.cx);
  assert.equal(calls.writeTextFile.length, 0);
  assert.equal(state.disk.get(FILE), "theirs");

  reset();
  const gone = await mount({ disk: "old" });
  await gone.click("md-markdown");
  await gone.type("mine");
  state.disk.delete(FILE);
  await gone.touch([FILE]);
  await gone.view.close(gone.cx);
  assert.equal(calls.writeTextFile.length, 0);
  assert.equal(state.disk.has(FILE), false);

  reset();
  const stale = await mount({ disk: "old" });
  await stale.click("md-markdown");
  await stale.type("mine");
  state.disk.set(FILE, "theirs");
  await stale.view.close(stale.cx); // nobody has looked yet: the write is refused, and that is all
  assert.equal(state.disk.get(FILE), "theirs");
});

test("close() does not wait for a write in flight: it writes the newest text at once, over the text that write carries", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("one");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  assert.equal(writes.length, 1);
  await m.type("two");
  const closing = m.view.close(m.cx);
  await flush();
  assert.equal(writes.length, 2, "the write in flight is still out, and the last one is already on its way");
  assert.deepEqual([writes[1].text, writes[1].expected], ["two", "one"]);
  writes[0].land();
  writes[1].land();
  await closing;
  await fired;
  await flush();
  assert.equal(state.disk.get(FILE), "two");
  assert.equal(writes.length, 2, "nothing more, and no save after the close");
});

test("close(): when the write in flight has not landed, the last write is refused and goes once more over the old text; never a third", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("one");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  await m.type("two");
  const closing = m.view.close(m.cx);
  await flush();
  assert.deepEqual([writes[1].text, writes[1].expected], ["two", "one"]);
  writes[1].fail(new Error("stale")); // the file still has "old"
  await flush();
  assert.equal(writes.length, 3);
  assert.deepEqual([writes[2].text, writes[2].expected], ["two", "old"]);
  writes[2].land();
  await closing;
  assert.equal(state.disk.get(FILE), "two");
  writes[0].land(); // refused: the file moved on
  await fired;
  await flush();
  assert.equal(state.disk.get(FILE), "two", "the late write overwrote nothing");
  assert.equal(writes.length, 3);

  reset();
  const refused = slowWrites();
  const n = await mount({ disk: "old" });
  await n.click("md-markdown");
  await n.type("one");
  const fired2 = fire_timers(n.cx, { ms: 700 });
  await flush();
  await n.type("two");
  const closing2 = n.view.close(n.cx);
  await flush();
  refused[1].fail(new Error("stale"));
  await flush();
  refused[2].fail(new Error("stale"));
  await closing2; // does not hang and does not throw
  assert.equal(refused.length, 3, "two writes from the close, at most");
  refused[0].land();
  await fired2;
});

test("close() with no write in flight: one write, and one only when it is refused (a second one would be the same)", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("mine");
  state.disk.set(FILE, "theirs");
  await m.view.close(m.cx);
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "mine", expected: "old" }]);
  assert.equal(state.disk.get(FILE), "theirs");
});

test("close() while the write in flight carries the whole buffer still writes once more over it, harmlessly", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("one");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  const closing = m.view.close(m.cx);
  await flush();
  assert.deepEqual([writes[1].text, writes[1].expected], ["one", "one"]);
  writes[0].land();
  writes[1].land();
  await closing;
  await fired;
  assert.equal(state.disk.get(FILE), "one");
});

test("after close() nothing runs: the waiting save, the watcher, the polls and the commands all stop", async () => {
  const m = await mount({ disk: "old" });
  await m.click("md-markdown");
  await m.type("new");
  assert.ok(m.cx.timers.some(t => t.ms === 700 && !t.cancelled), "a save is waiting");
  await m.view.close(m.cx);
  const saves = m.cx.timers.filter(t => t.ms === 700);
  assert.ok(saves.length > 0 && saves.every(t => t.cancelled), "the waiting save is cancelled, not left to fire");
  const writes = calls.writeTextFile.length, reads = calls.readTextFile.length;
  assert.equal(writes, 1);
  await fire_timers(m.cx);
  state.disk.set(FILE, "elsewhere");
  await m.touch([FILE]);
  await m.send("toggle");
  assert.equal(calls.writeTextFile.length, writes);
  assert.equal(calls.readTextFile.length, reads);
  assert.equal(m.view.mode, "markdown");
  assert.equal(owners.has(m.view.id), false, "the nested views no longer find it");
  await m.view.close(m.cx);
  assert.equal(calls.writeTextFile.length, writes, "a second close does nothing");
});

test("after close() the poll of a file on another machine is cancelled, and a tick already due reads nothing", async () => {
  const m = await mount({ machine: "devbox", disk: "remote\n" });
  const [poll] = m.cx.timers.filter(t => !t.once);
  assert.equal(poll.cancelled, undefined, "polling while open");
  await m.view.close(m.cx);
  assert.equal(poll.cancelled, true);
  const reads = calls.readTextFile.length;
  poll.fn(m.cx);
  await flush();
  assert.equal(calls.readTextFile.length, reads);
});

test("a read that was out when the tab closed is ignored when it answers", async () => {
  let answer;
  state.readTextFile = () => new Promise(done => { answer = done; });
  const m = await mount();
  await m.view.close(m.cx);
  answer("late");
  await flush();
  assert.equal(m.view.loaded, false);
  assert.equal(m.view.text, "");
});

test("links: web pages go to the browser, markdown files open beside this pane, other files say so, anchors do nothing", async () => {
  state.exec = async () => ({ code: 0, stdout: "", stderr: "" }); // the mail link below goes to `open`
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb2", "note.md")] })];
  state.panes = [mdPaneOf("tb2")];
  farFocus("tb2");
  const m = await mount({ disk: "[a](b)" });
  const view = () => viewAt(m, 0);
  const go = url => fire(view(), "on_link_click", url, m.cx);
  go("https://example.com/x?y=1#z");
  go("HTTP://example.com/upper");
  go("mailto:a@b.co");
  await flush();
  assert.deepEqual(m.cx.opened, ["https://example.com/x?y=1#z", "HTTP://example.com/upper"], "the browser opens web pages only");
  const splits = () => calls.run.filter(([n]) => n === "pane.split");
  go("other.md");
  assert.deepEqual(splits().at(-1), split("p-tb2", "/n/docs/other.md"), "relative to this file, to the right of this pane");
  go("../up/It%20Is.md#part");
  assert.deepEqual(splits().at(-1)[1].props, { file: "/n/up/It Is.md", machine: null });
  go("file:///abs/path.markdown");
  assert.equal(splits().at(-1)[1].props.file, "/abs/path.markdown");
  assert.equal(calls.run.every(([n]) => n === "pane.split"), true, "never a tab");
  const before = [m.cx.opened.length, splits().length];
  go("#section");
  go("javascript:alert(1)");
  go("");
  assert.deepEqual([m.cx.opened.length, splits().length, calls.notify.length], [...before, 0]);
  go("../img/diagram.png");
  assert.deepEqual(calls.notify, [{ title: "Can't open diagram.png here", level: "info" }]);
  go("https://example.com/");
  assert.equal(m.cx.opened.length, 3);
});

test("a link opens beside the pane this copy is drawn in, even when another pane of the tab has the focus", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [shellPane, mdPane("pa", "tb1")];
  farFocus("tb1", "p1");
  const m = await mount({ disk: "[a](b)" });
  fire(viewAt(m, 0), "on_link_click", "other.md", m.cx);
  assert.deepEqual(calls.run, [split("pa", "/n/docs/other.md")]);
});

test("a link to a file that another pane of the tab already shows moves the focus there", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [shellPane, mdPane("pa", "tb1"), mdPane("pb", "tb1")];
  state.shared[PANES] = { pb: fileKey(null, "/n/docs/other.md") };
  farFocus("tb1", "p1");
  const m = await mount({ disk: "[a](b)" });
  fire(viewAt(m, 0), "on_link_click", "other.md", m.cx);
  assert.deepEqual(calls.run, [["pane.focus", { pane: "pb" }]]);
});

test("a link before the copy knows its pane opens beside the focused pane", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [shellPane, mdPane("pa", "tb1"), mdPane("pb", "tb1")];
  farFocus("tb1", "p1");
  const m = await mount({ disk: "[a](b)" });
  fire(viewAt(m, 0), "on_link_click", "other.md", m.cx);
  assert.equal(m.view.claimed, null, "two Markdown panes that nobody has filed yet");
  assert.deepEqual(calls.run, [split("p1", "/n/docs/other.md")]);
});

test("a link with no pane to open beside opens a tab, in the space being looked at", async () => {
  const m = await mount({ disk: "[a](b)" });
  fire(viewAt(m, 0), "on_link_click", "next.md", m.cx);
  assert.deepEqual(calls.run, [["tab.new", { name: "next.md", mod: "herdr-inline-markdown", props: { file: "/n/docs/next.md", machine: null } }]], "no space when none is focused");
  calls.run.length = 0;
  state.focused = { space: "s7", tab: "t", pane: null, terminal: null, shown: null, agent: null, cwd: null };
  fire(viewAt(m, 0), "on_link_click", "next.md", m.cx);
  assert.deepEqual(calls.run.map(c => [c[0], c[1].space]), [["tab.new", "s7"]]);
});

test("a mail link goes to the computer's opener, not to cx.open_url: open on macOS, xdg-open elsewhere, always on this computer", async () => {
  const asked = [];
  state.exec = async (command, args, options) => { asked.push({ command, args, options }); return { code: 0, stdout: "", stderr: "" }; };
  state.disk.set(FILE, "[a](b)");
  const m = await mount({ machine: "devbox" }); // the file is on another machine; the mail program is here
  fire(viewAt(m, 0), "on_link_click", "mailto:a@b.co?subject=Hi%20there", m.cx);
  await flush();
  assert.deepEqual(asked, [{ command: "open", args: ["mailto:a@b.co?subject=Hi%20there"], options: undefined }]);
  assert.deepEqual([m.cx.opened, calls.notify], [[], []]);
  state.window = { ...state.window, platform: "linux" };
  fire(viewAt(m, 0), "on_link_click", "mailto:x@y.zz", m.cx);
  await flush();
  assert.deepEqual(asked.at(-1), { command: "xdg-open", args: ["mailto:x@y.zz"], options: undefined });
  state.window = null;
  fire(viewAt(m, 0), "on_link_click", "mailto:x@y.zz", m.cx);
  await flush();
  assert.equal(asked.at(-1).command, "xdg-open", "no window info: not macOS");
});

test("a mail link that cannot be opened (no opener, or it fails) says so", async () => {
  const m = await mount({ disk: "[a](b)" });
  const go = () => fire(viewAt(m, 0), "on_link_click", "mailto:a@b.co", m.cx);
  state.exec = async () => { throw new Error("spawn xdg-open ENOENT"); };
  go();
  await flush();
  assert.deepEqual(calls.notify, [{ title: "Can't open this link", level: "info" }]);
  state.exec = async () => ({ code: 3, stdout: "", stderr: "no mail program" });
  go();
  await flush();
  assert.equal(calls.notify.length, 2);
  assert.deepEqual(calls.notify[1], { title: "Can't open this link", level: "info" });
  state.exec = async () => ({ code: 0, stdout: "", stderr: "" });
  go();
  await flush();
  assert.equal(calls.notify.length, 2, "an opener that works says nothing");
});

test("a link to a markdown file from a file on another machine opens it on that machine", async () => {
  state.disk.set(FILE, "[a](b)");
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [mdPane("pa", "tb1")];
  farFocus("tb1");
  const m = await mount({ machine: "devbox" });
  fire(viewAt(m, 0), "on_link_click", "sibling.md", m.cx);
  assert.deepEqual(calls.run, [split("pa", "/n/docs/sibling.md", "devbox")]);
});

test("typing Enter in the Markdown field of a CRLF file writes CRLF and leaves every other byte", async () => {
  const disk = `${BOM}# Plan\r\n\r\nfirst step\r\nsecond\r\n`;
  const m = await mount({ disk });
  await m.click("md-markdown");
  assert.equal(m.view.source.value(), "# Plan\n\nfirst step\nsecond\n", "the field shows \\n line ends and no BOM");
  await m.type("# Plan\n\nfirst\n step\nsecond\n");
  await m.save();
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: `${BOM}# Plan\r\n\r\nfirst\r\n step\r\nsecond\r\n`, expected: disk }]);
  await m.type("# Plan\n\nfirst\n step\nsecond\nmore");
  await m.save();
  assert.equal(state.disk.get(FILE), `${BOM}# Plan\r\n\r\nfirst\r\n step\r\nsecond\r\nmore`);
});

test("a \\r\\n pasted into the Markdown field of a CRLF file is written as one CRLF, and a disk change after it keeps the caret on its text", async () => {
  const m = await mount({ disk: "# Plan\r\n\r\nlast\r\n" });
  await m.click("md-markdown");
  const field = m.view.source;
  await m.type("# Plan\n\nstep one\r\nstep two\nlast\n"); // Cmd+V of lines copied from a CRLF file: the field keeps "\r\n"
  await m.save();
  assert.equal(state.disk.get(FILE), "# Plan\r\n\r\nstep one\r\nstep two\r\nlast\r\n");
  field.set_selected_range({ start: 13, end: 13 }); // before "one", ahead of the pasted "\r\n"
  state.disk.set(FILE, "intro\r\n# Plan\r\n\r\nstep one\r\nstep two\r\nlast\r\n");
  await m.touch([FILE]);
  assert.equal(field.value(), "intro\n# Plan\n\nstep one\nstep two\nlast\n");
  assert.deepEqual(field.selection, { start: 19, end: 19 }, "still before \"one\"");
  assert.equal(m.view.text, state.disk.get(FILE));
  state.disk.set(FILE, "intro\n# Plan\n\nstep one\nstep two\nlast\n");
  await m.touch([FILE]);
  assert.deepEqual(field.selection, { start: 19, end: 19 }, "a rewrite that only changes the line ends leaves the caret");
});

test("Reading to Markdown: the source caret goes to the start of the first block whose first row is on the page, and the field is asked to show it", async () => {
  const doc = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n";
  const m = await mount({ disk: doc });
  viewportOf(m, 900, 200);
  await heights(m, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, i ? 38 : 24])));
  const field = m.view.source, block4 = 28 + 24 + 38 * 3;
  m.view.scrollTo(block4 + 5, m.cx); // only block 4's space above its row is above the page
  await m.click("md-markdown");
  let at = doc.indexOf("Paragraph 4");
  assert.deepEqual(field.selection, { start: at, end: at });
  await m.click("md-markdown");
  assert.equal(m.view.activeKey, keyAt(m, 4), "back in Reading, block 4 holds the caret");
  m.view.field.select(5);
  await m.click("md-markdown");
  assert.deepEqual(field.selection, { start: at + 5, end: at + 5 }, "with a block open, the source caret goes to its caret");
  await m.click("md-markdown");
  escape(m);
  m.view.scrollTo(block4 + 20, m.cx); // block 4's row is cut by the top of the page, block 5's is on it
  const before = field.log.length;
  await m.click("md-markdown");
  at = doc.indexOf("Paragraph 5");
  assert.deepEqual(field.log.slice(before).slice(-2), [["set_selected_range", { start: at, end: at }], ["replace", ""]]);
  assert.deepEqual(field.selection, { start: at, end: at });
  assert.equal(field.value(), doc, "the replace of nothing changed nothing");
  field.log.length = 0;
  await fire_timers(m.cx, { ms: 80 });
  assert.deepEqual(field.log.map(([c]) => c), ["set_selected_range", "replace"], "asked again once it is drawn");
});

test("Reading to Markdown from inside a block taller than the page: the caret goes to that block's start, not to the next one below the page", async () => {
  const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const doc = `Intro\n\n\`\`\`\n${code}\n\`\`\`\n\nAfter\n`;
  const m = await mount({ disk: doc });
  viewportOf(m, 900, 200);
  await heights(m, { 0: 24, 1: 820, 2: 38 });
  m.view.scrollTo(28 + 24 + 300, m.cx);
  await m.click("md-markdown");
  const at = doc.indexOf("```");
  assert.deepEqual(m.view.source.selection, { start: at, end: at });
});

test("Markdown to Reading: the block holding the source caret is put a third of the way down; a caret on a blank line puts the next block there", async () => {
  const doc = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n";
  const m = await mount({ disk: doc });
  viewportOf(m, 900, 300);
  await heights(m, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, i ? 38 : 24])));
  await m.click("md-markdown");
  const at = doc.indexOf("Paragraph 8") + 3;
  m.view.source.set_selected_range({ start: at, end: at });
  await m.click("md-markdown");
  const top = 28 + 24 + 38 * 7;
  assert.equal(m.view.offset, top + 14 - 100, "the row is at a third of 300 px");
  await m.click("md-markdown");
  const blank = doc.indexOf("Paragraph 3") - 1;
  m.view.source.set_selected_range({ start: blank, end: blank });
  await m.click("md-markdown");
  assert.equal(m.view.offset, 28 + 24 + 38 * 2 + 14 - 100);
  await heights(m, { 0: 124 });
  assert.equal(m.view.offset, 28 + 124 + 38 * 2 + 14 - 100, "the reveal holds while heights above it change");
  fire(must(m.tree(), "md-viewport"), "on_scroll_wheel", { delta: { x: 0, y: -10 }, touch_phase: "moved" }, m.cx);
  await heights(m, { 0: 24 });
  assert.equal(m.view.reveal, null, "until the page is scrolled");
});

test("a pending reveal whose block an agent rewrote is dropped, and the first visible block holds its place again", async () => {
  const doc = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n";
  const m = await mount({ disk: doc });
  viewportOf(m, 900, 300);
  await heights(m, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, i ? 38 : 24])));
  await m.click("md-markdown");
  const at = doc.indexOf("Paragraph 8") + 3;
  m.view.source.set_selected_range({ start: at, end: at });
  await m.click("md-markdown");
  const revealed = keyAt(m, 8);
  assert.equal(m.view.reveal.key, revealed);
  state.disk.set(FILE, doc.replace("Paragraph 8", "## Paragraph 8"));
  await m.touch([FILE]);
  assert.ok(!m.view.doc.blocks.some(b => b.key === revealed), "the paragraph became a heading: its key went away");
  assert.equal(m.view.reveal, null);
  const first = keyAt(m, 5), y = () => 28 + m.view.sums[m.view.doc.blocks.findIndex(b => b.key === first)] - m.view.offset;
  const before = y();
  await heights(m, { 0: 124 });
  assert.equal(y(), before, "a block measured above the page moves nothing on it");
});

test("the source field: terminal font at 13.5, in a column of at most 860 px that declares the source context; fallback font when none is set", async () => {
  const m = await mount({ disk: "x" });
  await m.click("md-markdown");
  const t = m.tree();
  const source = must(t, "md-source");
  assert.ok(source.style.flex_1 && source.style.min_h === 0);
  const column = source.kids[0];
  assert.deepEqual([column.style.max_w, column.style.px, column.style.py, column.style.key_context], [860, 24, 16, SOURCE]);
  assert.ok(column.style.mx_auto);
  const area = all(source, n => n.kind === "textarea")[0];
  assert.deepEqual([area.style.font_family, area.style.text_size, area.style.size_full], ["Mono", 13.5, true]);
  assert.equal(area.state, m.view.source);
  assert.equal(m.view.source.options.value, "", "created empty, in init");
  state.settings = { zoom: 1 };
  assert.equal(all(must(m.tree(), "md-source"), n => n.kind === "textarea")[0].style.font_family, "JetBrains Mono");
});

test("the source field is made once, in init, wraps long lines, and is the only field drawn in Markdown", async () => {
  const wrapping = [], real = TextareaState.prototype.set_soft_wrap;
  TextareaState.prototype.set_soft_wrap = function (on) { if (on) wrapping.push(this); return real.call(this, on); };
  let m;
  try { m = await mount({ disk: "x" }); } finally { TextareaState.prototype.set_soft_wrap = real; }
  assert.ok([m.view.source, m.view.field, m.view.spare].every(s => wrapping.includes(s)), "the source, the active and the armed field wrap long lines");
  const states = new Set();
  for (let i = 0; i < 4; i++) {
    await m.click("md-markdown");
    if (m.view.mode === "markdown") for (const n of all(m.tree(), n => n.kind === "textarea")) states.add(n.state);
  }
  assert.deepEqual([...states], [m.view.source], "the same retained state every time");
});

test("leaving Markdown takes the source caret as the field has it, though no event told the mod of it, and writes nothing to read it", async () => {
  const m = await mount({ disk: "one\n\ntwo\n" });
  await m.click("md-markdown");
  await m.type("one!\n\ntwo\n");
  m.view.source.select(7);
  const before = m.view.source.log.length;
  await m.click("md-markdown");
  assert.deepEqual(m.view.source.log.slice(before), []);
  assert.equal(m.view.reveal.key, keyAt(m, 1), "the caret was in the second block");
  assert.equal(m.view.source.value(), "one!\n\ntwo\n");
});

test("a file the field cannot hold (set_value refuses it) opens read-only, with Reading only", async () => {
  state.disk.set(FILE, "odd \ud800 text");
  const cx = makeCx();
  cx.settle = flush;
  const view = new Editor();
  view.init({ file: FILE }, cx);
  view.source.set_value = text => { if (/[\ud800-\udbff](?![\udc00-\udfff])/.test(text)) throw new Error("invalid utf-8"); };
  await flush();
  assert.equal(view.locked, "Read-only: unusual characters");
  assert.equal(view.mode, "reading");
  assert.equal(textOf(must(view.render(cx), "md-status")).trim(), "Read-only: unusual characters");
  fire(must(view.render(cx), "md-markdown"), "on_click", {}, cx);
  assert.equal(view.mode, "reading", "the source cannot show it");
  view.text = "changed";
  await view.save(cx);
  assert.equal(calls.writeTextFile.length, 0);
});

test("U+FFFF is text like any other: typed in a block or in the source, it is written", async () => {
  const m = await page("abc\n", { 0: 24 });
  await openBlock(m, 0, 3);
  m.view.field.type(NONCHAR, m.cx);
  assert.equal(m.view.text, `abc${NONCHAR}\n`);
  await m.key("cmd-e");
  await m.type(`ab${NONCHAR}c${NONCHAR}\n`);
  assert.deepEqual([m.view.source.value(), m.view.text], [`ab${NONCHAR}c${NONCHAR}\n`, `ab${NONCHAR}c${NONCHAR}\n`]);
  await m.save();
  assert.equal(state.disk.get(FILE), `ab${NONCHAR}c${NONCHAR}\n`);
});

test("the document is parsed once for a text; a draw, a size change or a state switch parses nothing, an edit re-parses its span", async () => {
  const m = await mount({ disk: DOC });
  m.tree();
  const doc = m.view.doc, counts = m.view.countList;
  for (let i = 0; i < 5; i++) m.tree();
  viewportOf(m, 800, 500);
  await heights(m, { 0: 40 });
  assert.equal(m.view.doc, doc, "same text, same document");
  assert.equal(m.view.countList, counts);
  await m.click("md-markdown");
  await m.type(`${DOC}more`);
  m.tree();
  assert.equal(m.view.doc, doc, "Markdown does not parse while typing");
  assert.notEqual(m.view.countList, counts, "the counts follow the buffer");
  await m.click("md-markdown");
  assert.notEqual(m.view.doc, doc);
  assert.deepEqual(m.view.doc.blocks.map(b => b.key), [...doc.blocks.slice(0, 3).map(b => b.key), doc.blocks[3].key], "the blocks keep their keys");
  const parsed = m.view.doc;
  escape(m);
  assert.equal(m.view.doc, parsed, "leaving a block nothing was typed in parses nothing");
  assert.equal(viewAt(m, 3).markdown, "Bye\n    more");
});

test("only the blocks whose drawing changed are redrawn; the Column only when the blocks change", async () => {
  const m = await mount({ disk: "one\n\ntwo\n\nthree\n" });
  const [a, b, c] = m.view.doc.blocks.map(x => m.view.entities.get(x.key));
  m.cx.notifiedEntities.length = 0;
  state.disk.set(FILE, "one\n\nTWO\n\nthree\n");
  await m.touch([FILE]);
  assert.deepEqual(m.cx.notifiedEntities, [b], "the changed block only");
  m.cx.notifiedEntities.length = 0;
  state.disk.set(FILE, "one\n\nTWO\n\nthree\n\nfour\n");
  await m.touch([FILE]);
  assert.deepEqual(m.cx.notifiedEntities, [m.view.column], "a new block: the Column");
  assert.equal(m.view.entities.size, 4);
  state.disk.set(FILE, "one\n\nfour\n");
  await m.touch([FILE]);
  assert.equal([a, b, c].filter(e => e.released).length, 2, "the views of blocks that went are let go");
  assert.equal(a.released, false);
});

test("the footer counts words and lines of the buffer and shows the path with ~ for the home folder", async () => {
  const m = await mount({ file: "/home/user/notes/plan.md", disk: DOC });
  const { words, lines } = stats(DOC);
  assert.equal(textOf(must(m.tree(), "md-counts")), `${words} words · ${lines} lines`);
  const footer = must(m.tree(), "md-footer");
  assert.match(textOf(footer), /~\/notes\/plan\.md$/);
  const place = all(footer, n => n.style.truncate && n.style.text_right)[0];
  assert.ok(place && place.style.min_w === 0 && place.style.flex_1);
  const bar = must(m.tree(), "md-toolbar");
  assert.equal(textOf(bar).includes("plan.md"), true);
  assert.equal(textOf(bar).includes("~/notes"), false, "the folder is in the footer, not the toolbar");
  assert.deepEqual(all(bar, n => n.kind === "image").map(n => n.path), ["mods/herdr-inline-markdown/file-markdown.svg"], "the file's own full-colour icon");
  assert.deepEqual(all(bar, n => n.kind === "svg").map(n => n.path), ["mods/herdr-inline-markdown/code.svg"], "the toggle at the right end");
  assert.equal(bar.kids.at(-1).id, "md-markdown");
  await m.click("md-markdown");
  await m.type("one");
  assert.equal(textOf(must(m.tree(), "md-counts")), "1 word · 1 line", "follows typing, singular");
  await m.type("");
  assert.equal(textOf(must(m.tree(), "md-counts")), "0 words · 0 lines");
});

test("a buffer over 50000 characters is counted when it settles (save timer, load, mode switch), not on every key", async () => {
  const big = "word ".repeat(10001); // 50005 characters, one line
  const m = await mount({ disk: big });
  const counts = () => textOf(must(m.tree(), "md-counts"));
  assert.equal(counts(), "10001 words · 1 line", "counted once it is loaded");
  await m.click("md-markdown");
  await m.type(`${big}more words\nand a new line`);
  assert.equal(counts(), "10001 words · 1 line", "typing does not recount");
  await m.type(`${big}more words\nand a new line, and more`);
  assert.equal(counts(), "10001 words · 1 line");
  await m.save();
  assert.equal(counts(), "10009 words · 2 lines", "the save timer catches up");
  await m.type(`${big}a`);
  assert.equal(counts(), "10009 words · 2 lines");
  await m.click("md-markdown");
  assert.equal(counts(), "10002 words · 1 line", "so does a switch to Reading");
  await m.type("short again");
  assert.equal(counts(), "2 words · 1 line", "under the limit it follows every key again");
  await m.type(`${big}x`);
  assert.equal(counts(), "2 words · 1 line", "back over it: settled text again");
});

test("a buffer exactly 50000 characters long is still counted live", async () => {
  const m = await mount({ disk: "a" });
  await m.click("md-markdown");
  await m.type("a ".repeat(25000));
  assert.equal(textOf(must(m.tree(), "md-counts")), "25000 words · 1 line");
  await m.type("a ".repeat(25000) + "b");
  assert.equal(textOf(must(m.tree(), "md-counts")), "25000 words · 1 line", "50001: settled text");
});

test("a file loaded or reloaded from disk (apply) settles the counts of a big buffer", async () => {
  const m = await mount({ disk: "small" });
  const next = "word ".repeat(10002);
  state.disk.set(FILE, next);
  await m.touch([FILE]);
  assert.equal(textOf(must(m.tree(), "md-counts")), "10002 words · 1 line");
});

test("the path outside the home folder is shown whole; a home folder that only shares a prefix is not abbreviated", async () => {
  const a = await mount({ file: "/srv/notes/a.md", disk: "x" });
  assert.match(textOf(must(a.tree(), "md-footer")), /\/srv\/notes\/a\.md$/);
  reset();
  const b = await mount({ file: "/home/user2/a.md", disk: "x" });
  assert.match(textOf(must(b.tree(), "md-footer")), /\/home\/user2\/a\.md$/);
});

const dia =m => `md-diagram-${keyAt(m, 2)}`;

// What the app does: the first draw asks for the diagrams, the renderer's version arrives and draws again, and the
// diagrams asked for then wait their 400 ms and are made.
async function drawn(m) {
  m.tree();
  await flush();
  m.tree();
  await fire_timers(m.cx, { ms: 400 });
}

test("diagrams: pending box, then the image, with the footer saying what is going on", async () => {
  renderer({ width: 800, height: 400 });
  const m = await mount({ disk: DOC });
  let t = m.tree();
  assert.match(textOf(must(t, dia(m))), /Drawing diagram…/);
  assert.equal(textOf(must(t, "md-diagrams")), "Drawing diagrams…");
  await flush();
  t = m.tree();
  assert.match(textOf(must(t, dia(m))), /Drawing diagram…/, "still waiting its 400 ms");
  m.cx.notifiedEntities.length = 0;
  await fire_timers(m.cx, { ms: 400 });
  assert.deepEqual(m.cx.notifiedEntities, [m.view.entities.get(keyAt(m, 2))], "the diagram's block alone is told to draw again");
  t = m.tree();
  const img = imageOf(t, dia(m));
  assert.equal(img.path, `data/herdr-inline-markdown/diagrams/${keyOf("graph TD\nA-->B", "mmdc-test+1")}.png`);
  assert.deepEqual([img.style.w, img.style.h], [400, 200]);
  assert.equal(textOf(must(t, "md-diagrams")), "1 diagram");
  audit(t);
});

// DOC in a pane 1900 x 1000 (layout px) whose diagram the renderer draws `width` x `height` px at 2x (the stress
// diagram by default: 2321 x 2722 natural), every block measured. The diagram's frame is then 1836 x 700.
async function framed({ width = 4642, height = 5444, disk = DOC, viewH = 1000, i = 2, more = {}, file, machine } = {}) {
  renderer({ width, height });
  const m = await mount({ disk, file, machine });
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 1900, height: viewH + 66 }, m.cx);
  viewportOf(m, 1900, viewH);
  await drawn(m);
  const d = m.view.data.get(keyAt(m, i));
  await heights(m, { 0: 35, 1: 32, [i]: d.space + d.frameH, ...more });
  return m;
}
function frameOn(m, i = 2) {
  const d = m.view.data.get(keyAt(m, i)), el = find(m.tree(), `md-frame-${keyAt(m, i)}`);
  return { left: d.frameLeft, top: 28 + m.view.sums[i + 1] - d.frameH - m.view.offset, w: d.frameW, h: d.frameH, d, el, img: el ? all(el, n => n.kind === "image") : [] };
}
// The stress diagram as block 11 after ten paragraphs: its 700 px frame starts 451 px down the page, so its bottom
// is below the pane, with 40 more paragraphs after it unless `tail` is false.
const framedLow = ({ tail = true } = {}) => framed({
  disk: `# Title\n\n${paragraphs(10)}\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`\n${tail ? `\n${paragraphs(40)}` : ""}`,
  i: 11, more: Object.fromEntries(Array.from({ length: 9 }, (_, k) => [k + 2, 38])),
});
const MODS = { shift: false, control: false, alt: false, platform: false };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// A point in DOC's paragraph (block 1), whose column starts at 592 in a 1900 px viewport.
const PARA = m => ({ x: 592 + 10, y: topOf(m, 1) + 20 });
const scroll = (m, p, dx, dy, more = {}) => fire(must(m.tree(), "md-viewport"), "on_scroll_wheel",
  { delta: { x: dx, y: dy }, touch_phase: "moved", position: p, local_position: p, modifiers: MODS, ...more, ...(more.modifiers ? { modifiers: { ...MODS, ...more.modifiers } } : {}) }, m.cx);
const down = (m, p, more = {}) => fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", press(p, more), m.cx);
const up = (m, p, more = {}) => fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press(p, more), m.cx);
// A drag's release has click_count 0.
function drag(m, from, to, steps = 4) {
  down(m, from);
  for (let k = 1; k <= steps; k++) hover(m, { x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps });
  up(m, to, { click_count: 0 });
}
async function doubleClickAt(m, p) {
  down(m, p); up(m, p);
  down(m, p, { click_count: 2 }); up(m, p, { click_count: 2 });
  await flush();
}

test("a diagram is a frame as wide as the pane less 32 px a side and at most 70 % as tall as the page, opening at a readable zoom", async () => {
  const m = await framed();
  const f = frameOn(m);
  assert.deepEqual([f.w, f.h, f.left, f.el.style.ml], [1836, 700, 32, 32 - 592]);
  assert.equal(f.img.length, 1);
  const img = f.img[0].style;
  assert.deepEqual([img.left, img.top, img.w], [12, 12, 1812], "78 %: the full width shows, from the top");
  assert.ok(Math.abs(img.h - 2125) < 1);
  assert.equal(f.el.style.cursor_grab, true, "the picture is taller than the frame: it can be moved");
  assert.equal(find(m.tree(), `md-frame-tools-${keyAt(m, 2)}`), null, "no controls without the pointer");
  audit(m.tree());
});

test("a small diagram's frame is the column, as tall as the pending box; one inside an item is centred too", async () => {
  const m = await framed({ width: 1104, height: 116 });
  const f = frameOn(m);
  assert.deepEqual([f.w, f.h, f.el.style.ml], [716, 120, 0]);
  assert.deepEqual([f.img[0].style.left, f.img[0].style.top, f.img[0].style.w, f.img[0].style.h], [82, 31, 552, 58], "centred");
  assert.deepEqual([f.el.style.cursor_grab, f.el.style.cursor_default, f.el.style.cursor_pointer], [true, undefined, undefined], "a picture that fits is still grabbed");
  await clickAt(m, { x: f.left + 300, y: f.top + 60 });
  assert.equal(m.view.activeKey, null, "a single click opens nothing");
  reset();
  const nested = await framed({ disk: "- step\n\n  ```mermaid\n  graph TD\n  A-->B\n  ```\n", i: 1, more: { 0: 24 } });
  const n = frameOn(nested, 1);
  assert.deepEqual([n.w, n.left, n.el.style.ml], [1836, 32, 32 - (592 + 24)], "centred in the pane from the item's indent");
});

test("a click on a frame opens nothing, even with a paragraph being edited; a double-click opens the source, also in the margin part", async () => {
  const m = await framed();
  const f = frameOn(m), key = keyAt(m, 2), margin = { x: f.left + 20, y: f.top + 300 };
  assert.equal(m.view.hit(margin).on, "frame", "left of the column");
  await clickAt(m, margin);
  assert.equal(m.view.activeKey, null);
  await clickAt(m, PARA(m));
  const para = keyAt(m, 1);
  assert.equal(m.view.activeKey, para);
  m.view.field.focused = false;
  await clickAt(m, margin);
  assert.equal(m.view.activeKey, para, "the paragraph is still being edited");
  assert.equal(m.view.field.focused, true, "and keeps the keyboard");
  down(m, margin); up(m, margin);
  down(m, margin, { click_count: 2 }); up(m, { x: margin.x + 5, y: margin.y }, { click_count: 2 });
  await flush();
  assert.equal(m.view.activeKey, para, "a double-click released past the click slop opens nothing");
  await doubleClickAt(m, margin);
  assert.equal(m.view.activeKey, key);
  assert.equal(m.view.field.value(), "```mermaid\ngraph TD\nA-->B\n```");
  assert.deepEqual(m.view.field.selection, { start: 11, end: 11 }, "at the start of its first line, nothing selected");
  escape(m);
  assert.ok(find(m.tree(), `md-frame-${key}`), "Escape shows the frame again");
  await clickAt(m, PARA(m));
  act(m, "mdb-down");
  assert.equal(m.view.activeKey, key, "the keyboard crossing in from the paragraph opens it too");
  assert.deepEqual(m.view.field.selection, { start: 11, end: 11 });
});

test("a drag pans the picture with the pointer, clamped; it activates, selects and clicks nothing, and only the diagram draws again", async () => {
  const m = await framed({ width: 6000, height: 800 });
  const f = frameOn(m), key = keyAt(m, 2), diagram = m.view.entities.get(key);
  assert.deepEqual([f.w, f.h], [1836, 324], "3000 x 400 at 75 %: wider than the pane");
  const at = { x: 900, y: f.top + 100 }, start = f.img[0].style.left;
  assert.equal(start, (1836 - 2250) / 2, "a top-down flowchart starts at its centre");
  m.cx.notifiedEntities.length = 0;
  down(m, at);
  hover(m, { x: at.x + 3, y: at.y });
  assert.equal(frameOn(m).img[0].style.left, start, "inside the click slop nothing moves");
  hover(m, { x: at.x + 100, y: at.y + 40 });
  assert.equal(frameOn(m).el.style.cursor_grabbing, true);
  assert.deepEqual([frameOn(m).img[0].style.left, frameOn(m).img[0].style.top], [start + 100, 12 + 40], "the picture's height fits, and the canvas still follows the pointer up and down");
  hover(m, { x: at.x + 5000, y: at.y });
  assert.equal(frameOn(m).img[0].style.left, 1836 / 2, "its left edge stops at the frame's centre");
  up(m, { x: at.x + 5000, y: at.y }, { click_count: 1 });
  await flush();
  assert.deepEqual([m.view.activeKey, m.view.sel], [null, null], "a pan is no click and no block selection");
  assert.ok(m.cx.notifiedEntities.length > 0 && m.cx.notifiedEntities.every(e => e === diagram), "only the diagram's block draws again");
  assert.equal(frameOn(m).el.style.cursor_grab, true, "the pan is over");
  hover(m, { x: at.x, y: at.y });
  assert.equal(frameOn(m).img[0].style.left, 1836 / 2, "a move after the release pans nothing");
});

test("a pan while a paragraph is being edited leaves it the keyboard; a drag from a paragraph across a frame still selects blocks", async () => {
  const m = await framed({ width: 6000, height: 800 });
  const para = keyAt(m, 1);
  await clickAt(m, PARA(m));
  assert.equal(m.view.activeKey, para);
  m.view.field.focused = false;
  const f = frameOn(m);
  drag(m, { x: 900, y: f.top + 100 }, { x: 700, y: f.top + 100 });
  assert.equal(m.view.activeKey, para);
  assert.equal(m.view.field.focused, true);
  drag(m, PARA(m), { x: 900, y: f.top + 100 });
  assert.deepEqual([...m.view.selKeys], [para, keyAt(m, 2)]);
});

test("the wheel over a frame wider than its picture fits: sideways pans it, the page stays; up and down scroll the page", async () => {
  const m = await framed({ width: 6000, height: 800, more: { 3: 38 }, disk: `${DOC}\n${paragraphs(40)}` });
  const f = frameOn(m), key = keyAt(m, 2), at = { x: 900, y: f.top + 100 }, start = f.img[0].style.left;
  scroll(m, at, -60, 0, { touch_phase: "started" });
  assert.equal(frameOn(m).img[0].style.left, start - 60);
  assert.equal(m.view.offset, 0);
  scroll(m, at, 0, -200, { touch_phase: "started" });
  assert.equal(m.view.offset, 200, "a vertical swipe over it scrolls the page");
  assert.equal(m.view.viewOf(key).x, start - 60);
  // Finger jitter first: (1, 0), then down. Undecided until 8 px, then the page.
  const on = () => ({ x: 900, y: frameOn(m).top + 200 });
  scroll(m, on(), 1, 0, { touch_phase: "started" });
  assert.deepEqual([m.view.offset, m.view.viewOf(key).x], [200, start - 60], "nothing decided yet");
  scroll(m, on(), 0, -10);
  assert.deepEqual([m.view.offset, m.view.viewOf(key).x], [210, start - 60], "the page took the gesture");
  scroll(m, on(), -30, -5);
  assert.equal(m.view.viewOf(key).x, start - 60, "a gesture that went to the page ignores later sideways deltas");
  assert.equal(m.view.offset, 215);
});

test("Shift with a mouse wheel over a wide frame pans it sideways; outside the frame the wheel scrolls the page as it always did", async () => {
  const m = await framed({ width: 6000, height: 800, disk: `${DOC}\n${paragraphs(40)}` });
  const f = frameOn(m), key = keyAt(m, 2), x0 = m.view.viewOf(key).x;
  scroll(m, { x: 900, y: f.top + 100 }, 0, -40, { touch_phase: "started", modifiers: { shift: true } });
  assert.deepEqual([m.view.viewOf(key).x, m.view.offset], [x0 - 40, 0]);
  scroll(m, { x: 10, y: f.top + 100 }, 0, -40, { touch_phase: "started", modifiers: { shift: true } });
  assert.equal(m.view.offset, 40, "in the margin beside the frame: the page");
  scroll(m, { x: 900, y: 20 }, 5, -30, { touch_phase: "started" });
  assert.equal(m.view.offset, 70, "over text a sideways part is ignored, as before");
});

test("scrolling down over a frame whose bottom is below the page brings it fully into view, pans through its picture, then goes on with the page; up is the mirror", async () => {
  const m = await framedLow();
  const at = () => ({ x: 900, y: clamp(frameOn(m, 11).top + 200, 10, 990) });
  const key = keyAt(m, 11), start = frameOn(m, 11).top, h = frameOn(m, 11).h, y0 = m.view.viewOf(key).y;
  const bottom = h - 12 - 2722 * m.view.data.get(key).z0, lift = start + h - (1000 - 24);
  assert.deepEqual([start, h, lift], [28 + 35 + 32 + 9 * 38 + 14, 700, 175], "the frame's top on the page, and how far its bottom is from fully in view");
  assert.ok(Math.abs(y0 - bottom - 1449) < 1, "1449 px of the picture are below the frame");
  scroll(m, at(), 0, -(lift + 100), { touch_phase: "started" });
  assert.equal(frameOn(m, 11).top + h, 1000 - 24, "the page moves until the frame is fully in view…");
  assert.equal(m.view.viewOf(key).y, y0 - 100, "…and the picture takes the rest");
  const passing = m.view.offset;
  assert.equal(passing, lift);
  scroll(m, at(), 0, 0, { touch_phase: "ended" });
  for (let k = 0; k < 30; k++) scroll(m, at(), 0, -40);
  assert.deepEqual([m.view.offset, frameOn(m, 11).top], [passing, start - lift], "the page holds while the picture pans");
  for (let k = 0; k < 31; k++) scroll(m, at(), 0, -40);
  assert.ok(Math.abs(m.view.viewOf(key).y - bottom) < 1e-6, "momentum after the end pans on, to the picture's bottom");
  assert.ok(Math.abs(m.view.offset - (passing + 61 * 40 - (y0 - bottom - 100))) < 1e-6, "what the picture could not take went to the page");
  assert.ok(frameOn(m, 11).top + h < 0, "then the page moved on, past the frame");
  const offset = m.view.offset;
  for (let k = 0; k < 200 && frameOn(m, 11).top < 24 - 0.5; k++) scroll(m, { x: 900, y: clamp(frameOn(m, 11).top + h - 100, 10, 990) }, 0, 40);
  assert.ok(Math.abs(frameOn(m, 11).top - 24) < 1e-6, "going up, the page stops with the frame's top 24 px down");
  assert.ok(Math.abs(m.view.offset - (start - 24)) < 1e-6 && m.view.offset < offset);
  const y1 = m.view.viewOf(key).y;
  assert.ok(y1 > bottom && y1 - bottom < 40, "the picture took only what the last step had left");
  scroll(m, { x: 900, y: 500 }, 0, 600);
  assert.ok(Math.abs(m.view.viewOf(key).y - (y1 + 600)) < 1e-6, "and the picture pans back");
  assert.ok(Math.abs(frameOn(m, 11).top - 24) < 1e-6);
  scroll(m, { x: 900, y: 500 }, 0, 3000);
  assert.deepEqual([m.view.viewOf(key).y, m.view.offset], [12, 0], "to its top, then the page to its own");
});

test("a picture dragged past its edge is not snapped back by the wheel: the page takes what the picture cannot, and the picture pans on from where it is", async () => {
  const m = await framedLow();
  const key = keyAt(m, 11), at = () => ({ x: 900, y: frameOn(m, 11).top + 200 });
  scroll(m, { x: 10, y: 500 }, 0, -175, { touch_phase: "started" });
  assert.equal(frameOn(m, 11).top + frameOn(m, 11).h, 1000 - 24, "the frame is fully in view");
  m.view.setView(key, { ...m.view.viewOf(key), y: 300 }, m.cx);
  assert.equal(m.view.viewOf(key).y, 300, "dragged 288 px down from its top edge");
  scroll(m, at(), 0, 60, { touch_phase: "started" });
  assert.deepEqual([m.view.viewOf(key).y, m.view.offset], [300, 115], "up: the picture stays where it is, the page goes up");
  scroll(m, at(), 0, -100, { touch_phase: "started" });
  assert.deepEqual([m.view.viewOf(key).y, m.view.offset], [260, 175], "down: the page brings the frame fully into view, the picture pans on by the rest");
});

test("the wheel over the frame's part in the side margin passes through it too; beside it, on the scrollbar and with the keys, only the page moves", async () => {
  const m = await framed({ disk: `${DOC}\n${paragraphs(80)}`, more: { 3: 38 } });
  const key = keyAt(m, 2), y0 = m.view.viewOf(key).y;
  assert.equal(m.view.hit({ x: 40, y: 500 }).on, "frame", "left of the column");
  scroll(m, { x: 40, y: 500 }, 0, -100, { touch_phase: "started" });
  assert.equal(m.view.viewOf(key).y, y0 - 100, "on the frame's part left of the column: the frame is fully in view, so the picture takes it all");
  const y1 = m.view.viewOf(key).y, o1 = m.view.offset;
  scroll(m, { x: 10, y: 500 }, 0, -100, { touch_phase: "started" });
  assert.deepEqual([m.view.viewOf(key).y, m.view.offset], [y1, o1 + 100], "in the margin beside it");
  assert.ok(find(m.tree(), "md-thumb"));
  scroll(m, { x: 1894, y: 500 }, 0, -100, { touch_phase: "started" });
  assert.deepEqual([m.view.viewOf(key).y, m.view.offset], [y1, o1 + 200], "on the scrollbar");
  await m.key("pagedown");
  assert.deepEqual([m.view.viewOf(key).y, m.view.offset], [y1, o1 + 200 + 960], "Page Down");
  await m.key("space");
  assert.deepEqual([m.view.viewOf(key).y, m.view.offset], [y1, o1 + 200 + 2 * 960], "Space");
});

test("at the top of the page a zoomed frame whose bottom is below the pane still scrolls up through its picture", async () => {
  const m = await framedLow();
  const key = keyAt(m, 11), at = { x: 900, y: frameOn(m, 11).top + 400 };
  assert.ok(frameOn(m, 11).top + frameOn(m, 11).h > 1000, "the frame's bottom is below the pane");
  scroll(m, at, 0, 200, { touch_phase: "started", modifiers: { platform: true } });
  const y0 = m.view.viewOf(key).y;
  assert.ok(y0 < -40, "zoomed in, the picture's top is above the frame");
  scroll(m, at, 0, 40, { touch_phase: "started" });
  assert.deepEqual([m.view.offset, m.view.viewOf(key).y], [0, y0 + 40]);
});

test("at the end of the page a frame that is the last block still scrolls down through its picture", async () => {
  const m = await framedLow({ tail: false });
  const key = keyAt(m, 11), y0 = m.view.viewOf(key).y;
  scroll(m, { x: 10, y: 500 }, 0, -10000, { touch_phase: "started" });
  const end = m.view.offset;
  assert.ok(end > 0 && frameOn(m, 11).top > 0, "beside the frame the page went to its end, with the frame on the page");
  scroll(m, { x: 900, y: 500 }, 0, -100, { touch_phase: "started" });
  assert.deepEqual([m.view.offset, m.view.viewOf(key).y], [end, y0 - 100]);
});

test("a frame the page left fully on screen with its top 10 px down the pane: scrolling over it pans the picture first", async () => {
  const m = await framed({ disk: `${DOC}\n${paragraphs(40)}`, more: { 3: 38 } });
  const key = keyAt(m, 2), y0 = m.view.viewOf(key).y, lift = frameOn(m).top - 10;
  scroll(m, { x: 10, y: 500 }, 0, -lift, { touch_phase: "started" });
  assert.equal(frameOn(m).top, 10);
  scroll(m, { x: 900, y: 500 }, 0, -100, { touch_phase: "started" });
  assert.deepEqual([m.view.offset, m.view.viewOf(key).y], [lift, y0 - 100]);
});

test("Cmd or Ctrl with the wheel over a frame zooms it around the pointer; the gesture stays a zoom, and stops at its end; elsewhere Cmd+wheel scrolls", async t => {
  const time = { now: 1_000_000 };
  t.mock.method(Date, "now", () => time.now);
  const m = await framed({ disk: `${DOC}\n${paragraphs(40)}`, more: { 3: 38 } });
  const key = keyAt(m, 2), f = frameOn(m), d = f.d, at = { x: 700, y: f.top + 300 };
  const v0 = m.view.viewOf(key), fx = at.x - f.left, fy = at.y - f.top;
  scroll(m, at, 0, 40, { touch_phase: "started", modifiers: { platform: true } });
  const v1 = m.view.viewOf(key);
  assert.ok(Math.abs(v1.z - v0.z * Math.exp(0.2)) < 1e-9, "a notch of 40 px is about 22 % more");
  assert.ok(Math.abs((fx - v1.x) / v1.z - (fx - v0.x) / v0.z) < 1e-6 && Math.abs((fy - v1.y) / v1.z - (fy - v0.y) / v0.z) < 1e-6, "the point under the pointer stays");
  assert.equal(m.view.offset, 0, "the page does not move");
  assert.deepEqual([frameOn(m).w, frameOn(m).h], [f.w, f.h], "a zoom never changes the frame");
  scroll(m, at, 0, -2000, { modifiers: {} });
  assert.ok(Math.abs(m.view.viewOf(key).z - d.zMin) < 1e-9, "Cmd let go mid-gesture: still the zoom, down to the whole diagram");
  scroll(m, at, 0, 0, { touch_phase: "ended", modifiers: { platform: true } });
  scroll(m, at, 0, 3000, { modifiers: { platform: true } });
  assert.ok(Math.abs(m.view.viewOf(key).z - d.zMin) < 1e-9, "momentum after the end zooms nothing");
  time.now += 500;
  scroll(m, at, 0, 3000, { modifiers: { control: true } });
  assert.equal(m.view.viewOf(key).z, 2, "Ctrl too, up to 200 %");
  time.now += 500;
  scroll(m, { x: 900, y: 10 }, 0, -100, { modifiers: { platform: true } });
  assert.equal(m.view.offset, 100, "over text Cmd+wheel scrolls the page");
  const y2 = m.view.viewOf(key).y;
  scroll(m, { x: 900, y: frameOn(m).top + 100 }, 0, -40, { modifiers: { platform: true } });
  assert.deepEqual([m.view.viewOf(key).z, m.view.offset, m.view.viewOf(key).y], [2, 100, y2 - 40], "a scroll that began over text stays a scroll when a frame comes under the pointer, passing through it");
});

test("the − % + group shows while the pointer is over the frame, kept on the page; − and + step the zoom, % goes back to the start", async () => {
  const m = await framed({ disk: `${DOC}\n${paragraphs(40)}`, more: { 3: 38 } });
  const key = keyAt(m, 2), f = frameOn(m), id = `md-frame-tools-${key}`;
  hover(m, { x: 900, y: f.top + 300 });
  let tools = must(m.tree(), id);
  assert.deepEqual([tools.style.top, tools.style.right], [8, 8]);
  assert.equal(textOf(must(m.tree(), `md-frame-pct-${key}`)), "78%");
  const cell = (name, top = tools.style.top) => ({ x: f.left + f.w - 8 - 102 + { out: 10, pct: 50, in: 90 }[name], y: frameOn(m).top + top + 10 });
  await clickAt(m, cell("in"));
  assert.equal(m.view.viewOf(key).z, 1);
  await clickAt(m, cell("in"));
  assert.equal(m.view.viewOf(key).z, 1.25);
  await clickAt(m, cell("out"));
  await clickAt(m, cell("out"));
  assert.ok(Math.abs(m.view.viewOf(key).z - f.d.z0) < 1e-9, "the starting zoom is a step");
  await clickAt(m, cell("out"));
  assert.equal(m.view.viewOf(key).z, 0.75);
  for (let k = 0; k < 4; k++) await clickAt(m, cell("out"));
  assert.equal(m.view.viewOf(key).z, 0.25, "the ladder ends at the step within half a percent of the whole diagram's zoom");
  assert.ok(m.view.viewOf(key).z - f.d.zMin < 0.005);
  assert.equal(must(m.tree(), `md-frame-out-${key}`).style.text_color, "dim", "nothing further out");
  await clickAt(m, cell("pct"));
  assert.equal(m.view.frames.has(key), false, "back to the starting view");
  assert.equal(m.view.activeKey, null, "the group opens nothing");
  // The frame's top scrolled above the page: the group comes down with it, 24 px below the top.
  m.view.scrollTo(f.top + m.view.offset + 300, m.cx);
  hover(m, { x: 900, y: 200 });
  tools = must(m.tree(), id);
  assert.equal(tools.style.top, 300 + 24);
  await clickAt(m, cell("in", 324));
  assert.equal(m.view.viewOf(key).z, 1, "where it is drawn, it takes the click");
  fire(must(m.tree(), "md-viewport"), "on_hover", false, m.cx);
  assert.equal(find(m.tree(), id), null, "gone when the pointer leaves");
});

test("the − % + group with a paragraph being edited keeps it being edited; on a file of another machine it works, and a double-click opens nothing", async () => {
  const m = await framed();
  const key = keyAt(m, 2), para = keyAt(m, 1);
  await clickAt(m, PARA(m));
  const f = frameOn(m), tool = { x: f.left + f.w - 8 - 102 + 90, y: f.top + 18 };
  hover(m, { x: 900, y: f.top + 300 });
  await clickAt(m, tool);
  assert.deepEqual([m.view.viewOf(key).z, m.view.activeKey], [1, para]);
  reset();
  renderer({ width: 4642, height: 5444 });
  const r = await mount({ file: "/home/dev/n.md", machine: "devbox", disk: DOC });
  fire(must(r.tree(), "md-root"), "on_size_change", { width: 1900, height: 1066 }, r.cx);
  viewportOf(r, 1900, 1000);
  await drawn(r);
  const g = frameOn(r);
  hover(r, { x: 900, y: g.top + 300 });
  await clickAt(r, { x: g.left + g.w - 8 - 102 + 90, y: g.top + 18 });
  assert.equal(r.view.viewOf(keyAt(r, 2)).z, 1);
  drag(r, { x: 900, y: g.top + 300 }, { x: 900, y: g.top + 100 });
  assert.ok(r.view.viewOf(keyAt(r, 2)).y < 12, "pans");
  await doubleClickAt(r, { x: 900, y: g.top + 300 });
  assert.equal(r.view.activeKey, null);
});

test("on a file of another machine a frame whose picture fits has the grab cursor too, and a double-click on it opens nothing", async () => {
  const m = await framed({ width: 1104, height: 116, file: "/home/dev/n.md", machine: "devbox" });
  const f = frameOn(m);
  assert.deepEqual([f.el.style.cursor_grab, f.el.style.cursor_default, f.el.style.cursor_pointer], [true, undefined, undefined]);
  await doubleClickAt(m, { x: f.left + 300, y: f.top + 60 });
  assert.equal(m.view.activeKey, null);
});

const DIR = "/n/docs", SHOT = png(40, 30);
const PICDOC = "# Title\n\n![x](a.png)\n\nBye\n";
const LINKED = "# Title\n\n[![x](a.png)](https://e.com/page)\n\nBye\n";
const cached = (bytes, ext = "png") => `data/herdr-inline-markdown/images/${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
const picsOf = (m, i = 1) => `md-pictures-${keyAt(m, i)}`;
const serveDownloads = bytes => {
  state.exec = async (command, args) => {
    if (command === "curl") files.set(args[args.indexOf("-o") + 1], bytes);
    return { code: 0, stdout: "", stderr: "" };
  };
};

// Pictures are loaded when the page first draws; every block is then measured as drawn.
async function pictured(disk = PICDOC, { file, machine, bytes = SHOT } = {}) {
  files.set(`${DIR}/a.png`, bytes);
  const m = await mount({ disk, file, machine });
  viewportOf(m, 900, 600);
  await flush();
  const sizes = {};
  m.view.blocks.forEach((b, i) => {
    const d = m.view.data.get(b.key);
    sizes[i] = d.look === "picture" ? d.space + d.pictureH : 30;
  });
  await heights(m, sizes);
  return m;
}
const onPicture = (m, dx = 10, i = 1) => ({ x: X + dx, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 10 });

test("pictures: a pending box, then the picture from the cache folder at the size the layout gives, and the block's estimate is that height", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  const release = hold(`${DIR}/a.png`);
  const m = await mount({ disk: PICDOC });
  const key = keyAt(m, 1), id = picsOf(m);
  assert.match(textOf(must(m.tree(), id)), /Loading picture…/);
  const waiting = m.view.data.get(key);
  assert.deepEqual([waiting.pictureH, m.view.estimate(m.view.blocks[1])], [PICTURE.boxH, waiting.space + PICTURE.boxH]);
  release();
  await flush();
  const t = m.tree(), img = imageOf(t, id), { height } = pictureLayout([{ state: "ok", natW: 40, natH: 30 }], 716);
  assert.equal(img.path, cached(SHOT));
  assert.deepEqual([img.style.w, img.style.h, must(t, id).style.h], [40, 30, height]);
  const d = m.view.data.get(key);
  assert.deepEqual([d.pictureH, m.view.estimate(m.view.blocks[1])], [height, d.space + height]);
  assert.equal(blockAt(m, 1, t).style.cursor_default, true);
  audit(t);
});

test("pictures: a single click changes nothing, a double-click shows the source with the caret at its end, leaving draws the picture again", async () => {
  const m = await pictured(), key = keyAt(m, 1);
  assert.deepEqual([m.view.hit(onPicture(m)).on, m.view.hit(onPicture(m)).item, m.view.hit(onPicture(m, 300)).item], ["picture", 0, -1]);
  await clickAt(m, onPicture(m));
  assert.equal(m.view.activeKey, null);
  await doubleClickAt(m, onPicture(m));
  assert.equal(m.view.activeKey, key);
  assert.equal(m.view.field.value(), "![x](a.png)");
  assert.deepEqual(m.view.field.selection, { start: 11, end: 11 });
  assert.equal(find(m.tree(), picsOf(m)), null, "the source is shown in its place");
  escape(m);
  assert.equal(imageOf(m.tree(), picsOf(m)).path, cached(SHOT));
});

test("pictures: a click on a picture opens nothing while another block is being edited, and the keyboard stays there", async () => {
  const m = await pictured();
  await clickAt(m, { x: X + 20, y: topOf(m, 2) + 10 });
  assert.equal(m.view.activeKey, keyAt(m, 2));
  m.view.field.focused = false;
  await clickAt(m, onPicture(m));
  assert.deepEqual([m.view.activeKey, m.view.field.focused], [keyAt(m, 2), true]);
});

test("pictures: a click on a linked picture opens its link, on a file that cannot be edited too, and a double-click never edits it", async () => {
  const m = await pictured(LINKED);
  assert.equal(m.view.hit(onPicture(m)).item, 0);
  await clickAt(m, onPicture(m));
  assert.deepEqual([m.cx.opened, m.view.activeKey], [["https://e.com/page"], null]);
  await doubleClickAt(m, onPicture(m));
  assert.deepEqual([m.cx.opened.length, m.view.activeKey], [2, null], "the first click of a double-click opens it, the second does nothing");
  m.view.locked = "Read-only: unusual characters";
  await clickAt(m, onPicture(m));
  assert.equal(m.cx.opened.length, 3);
  assert.equal(imageOf(m.tree(), picsOf(m)).style.cursor_pointer, true);
});

test("pictures: a picture file that changes on disk is read again and drawn from its new cache path; another file's event reads nothing", async () => {
  const m = await pictured(), id = picsOf(m), bigger = png(60, 20);
  assert.deepEqual(log.readFile, [`${DIR}/a.png`]);
  await m.touch([`${DIR}/other.txt`]);
  assert.deepEqual(log.readFile, [`${DIR}/a.png`], "nothing was read");
  assert.equal(imageOf(m.tree(), id).path, cached(SHOT));
  files.set(`${DIR}/a.png`, bigger);
  await m.touch([`${DIR}/a.png`]);
  assert.deepEqual(log.readFile, [`${DIR}/a.png`, `${DIR}/a.png`]);
  const img = imageOf(m.tree(), id);
  assert.deepEqual([img.path, img.style.w, img.style.h], [cached(bigger), 60, 20]);
  assert.equal(m.view.data.get(keyAt(m, 1)).pictureH, 20);
});

test("pictures: a picture that changes on disk stays until the new one is in, with no pending box and no jump; one that is gone shows its error", async () => {
  const m = await pictured(), id = picsOf(m), key = keyAt(m, 1), bigger = png(60, 20);
  files.set(`${DIR}/a.png`, bigger);
  const release = hold(`${DIR}/a.png`);
  await m.touch([`${DIR}/a.png`]);
  assert.equal(log.readFile.length, 2, "the new bytes are being read");
  assert.doesNotMatch(textOf(must(m.tree(), id)), /Loading/);
  assert.deepEqual([imageOf(m.tree(), id).path, m.view.data.get(key).pictureH], [cached(SHOT), 30]);
  release();
  await flush();
  const img = imageOf(m.tree(), id);
  assert.deepEqual([img.path, img.style.w, img.style.h, m.view.data.get(key).pictureH], [cached(bigger), 60, 20, 20]);
  files.delete(`${DIR}/a.png`);
  await m.touch([`${DIR}/a.png`]);
  assert.equal(textOf(must(m.tree(), id)).trim(), "x: Not found", "only a load in progress is covered up");
});

test("pictures: another address in the paragraph does not keep the old picture while the new one loads", async () => {
  const m = await pictured(), key = keyAt(m, 1), other = png(60, 20);
  files.set(`${DIR}/b.png`, other);
  const release = hold(`${DIR}/b.png`);
  state.disk.set(FILE, PICDOC.replace("a.png", "b.png"));
  await m.touch([FILE]);
  assert.equal(keyAt(m, 1), key, "the same block");
  assert.match(textOf(must(m.tree(), picsOf(m))), /Loading picture…/);
  assert.equal(imageOf(m.tree(), picsOf(m)), undefined);
  release();
  await flush();
  assert.equal(imageOf(m.tree(), picsOf(m)).path, cached(other));
});

test("pictures: a missing picture shows its error box, and the picture appears once the file exists and the watcher says so", async () => {
  const m = await mount({ disk: PICDOC });
  assert.equal(textOf(must(m.tree(), picsOf(m))).trim(), "x: Not found");
  assert.equal(m.view.data.get(keyAt(m, 1)).pictureH, PICTURE.boxH);
  files.set(`${DIR}/a.png`, SHOT);
  await m.touch([`${DIR}/a.png`]);
  assert.equal(imageOf(m.tree(), picsOf(m)).path, cached(SHOT));
});

test("pictures: on a file of another machine local pictures show the error box and nothing is read, while https pictures load", async () => {
  files.set("/home/dev/a.png", SHOT);
  const web = png(80, 20);
  serveDownloads(web);
  const doc = "# Title\n\n![x](a.png)\n\n[![w](https://e.com/w.png)](https://e.com/page)\n\nBye\n";
  const m = await mount({ file: "/home/dev/n.md", machine: "devbox", disk: doc });
  viewportOf(m, 900, 600);
  await flush();
  assert.equal(textOf(must(m.tree(), picsOf(m))).trim(), "x: Pictures on another machine aren't shown yet");
  assert.equal(imageOf(m.tree(), picsOf(m, 2)).path, cached(web));
  assert.deepEqual(log.readFile.filter(path => !path.endsWith(".part")), [], "no picture file was read");
  const sizes = {};
  m.view.blocks.forEach((b, i) => { const d = m.view.data.get(b.key); sizes[i] = d.look === "picture" ? d.space + d.pictureH : 30; });
  await heights(m, sizes);
  await doubleClickAt(m, onPicture(m));
  assert.equal(m.view.activeKey, null);
  await clickAt(m, onPicture(m, 10, 2));
  assert.deepEqual(m.cx.opened, ["https://e.com/page"], "its link opens on a read-only file");
});

test("pictures: a narrower pane shrinks them to the column and the block's estimate follows; they are never enlarged", async () => {
  const wide = png(1000, 500), m = await pictured(PICDOC, { bytes: wide }), id = picsOf(m);
  assert.deepEqual([imageOf(m.tree(), id).style.w, imageOf(m.tree(), id).style.h], [716, 358]);
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 464, height: 700 }, m.cx);
  const img = imageOf(m.tree(), id), d = m.view.data.get(keyAt(m, 1));
  assert.deepEqual([img.style.w, img.style.h, must(m.tree(), id).style.h], [400, 200, 200]);
  assert.equal(m.view.estimate(m.view.blocks[1]), d.space + 200);
});

test("pictures: a picture inside a list item is laid out in the column less the indent, and a point left of it is no picture", async () => {
  const m = await pictured("- item\n\n  ![x](a.png)\n", { bytes: png(716, 100) });
  const img = imageOf(m.tree(), picsOf(m)), key = keyAt(m, 1);
  assert.deepEqual([img.style.w, img.style.h], [716 - INDENT, Math.round((100 * (716 - INDENT)) / 716)]);
  assert.equal(m.view.data.get(key).pictureW, 716 - INDENT);
  assert.deepEqual([m.view.hit(onPicture(m, INDENT + 5)).item, m.view.hit(onPicture(m, 5)).item], [0, -1]);
});

test("pictures: one that arrives while the source is shown is there when Reading is back; closing the pane stops the loads", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  const release = hold(`${DIR}/a.png`);
  const m = await mount({ disk: PICDOC });
  await m.click("md-markdown");
  assert.equal(m.view.mode, "markdown");
  release();
  await flush();
  await m.click("md-markdown");
  assert.equal(imageOf(m.tree(), picsOf(m)).path, cached(SHOT));
  await m.view.close(m.cx);
  assert.equal(m.view.images.closed, true);
});

test("a frame's view survives a theme switch, an edit elsewhere, and opening its source then Escape", async () => {
  const m = await framed({ width: 6000, height: 800 });
  const key = keyAt(m, 2), f = frameOn(m);
  drag(m, { x: 900, y: f.top + 100 }, { x: 800, y: f.top + 100 });
  const view = m.view.viewOf(key), runs = calls.exec.length;
  state.theme = { ...theme(), background: "night" };
  m.tree();
  await fire_timers(m.cx, { ms: 0 });
  assert.deepEqual([frameOn(m).img[0].style.opacity, m.view.viewOf(key)], [undefined, view], "the same picture, not dimmed, in the same place");
  await fire_timers(m.cx, { ms: 400 });
  assert.deepEqual([frameOn(m).img[0].style.opacity, m.view.viewOf(key)], [undefined, view], "still the same place");
  assert.equal(calls.exec.length, runs, "nothing drawn again");
  await clickAt(m, PARA(m));
  m.view.field.type(" more", m.cx);
  escape(m);
  assert.deepEqual(m.view.viewOf(key), view, "an edit elsewhere");
  await doubleClickAt(m, { x: 900, y: frameOn(m).top + 100 });
  assert.equal(m.view.activeKey, key);
  assert.equal(find(m.tree(), `md-frame-${key}`), null, "the source shows instead");
  escape(m);
  assert.deepEqual(m.view.viewOf(key), view, "back with the same view");
});

test("a diagram that draws at another size keeps a zoom and clamps the pan; an untouched one takes its new starting view", async () => {
  const m = await framed({ disk: `${DOC}\n\`\`\`mermaid\nsequenceDiagram\nA->>B: hi\n\`\`\`\n` });
  const key = keyAt(m, 2), other = keyAt(m, 4), f = frameOn(m);
  scroll(m, { x: 700, y: f.top + 300 }, 0, 200, { touch_phase: "started", modifiers: { platform: true } });
  const z = m.view.viewOf(key).z;
  assert.equal(z, 2);
  m.view.frames.set(key, { z, x: -1e6, y: -1e6 });
  state.exec = async (_c, args) => ({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: args.slice(5).map(file => ({ key: file.slice(file.lastIndexOf("/") + 1).replace(/\.mmd$/, ""), ok: true, width: 2000, height: 1000, scale: 2 })) })}\n` });
  await m.click("md-markdown");
  await m.type(m.view.source.value().replace("A-->B", "A-->C").replace("A->>B", "A->>C"));
  await m.click("md-markdown");
  escape(m);
  await fire_timers(m.cx, { ms: 400 });
  const d = m.view.data.get(key), v = m.view.viewOf(key);
  assert.deepEqual([d.natW, d.natH], [1000, 500]);
  assert.equal(v.z, z, "the zoom is kept");
  assert.deepEqual([v.x, v.y], [d.frameW / 2 - 1000 * z, d.frameH / 2 - 500 * z], "the pan clamped: the picture's far edge at the frame's centre");
  const o = m.view.data.get(other);
  assert.equal(m.view.frames.has(other), false);
  assert.deepEqual([o.natW, m.view.viewOf(other)], [1000, { z: o.z0, x: o.startX, y: o.startY }], "the other one follows its new size");
});

test("a new viewport height resizes the frames: only diagrams draw again, and the block the eye holds keeps its place", async () => {
  const m = await framed({ disk: `${DOC}\n${paragraphs(30)}` });
  await heights(m, Object.fromEntries(Array.from({ length: 30 }, (_, k) => [k + 3, 38])));
  m.view.scrollTo(1500, m.cx);
  const anchor = m.view.anchor(), diagram = m.view.entities.get(keyAt(m, 2));
  assert.ok(m.view.at.get(anchor.key) > 2, "a paragraph below the diagram");
  m.cx.notifiedEntities.length = 0;
  viewportOf(m, 1900, 800);
  assert.equal(frameOn(m).h, 560, "70 % of 800");
  assert.deepEqual(m.cx.notifiedEntities, [diagram], "only the diagram's block");
  await heights(m, { 2: 14 + 560 });
  assert.equal(28 + m.view.sums[m.view.at.get(anchor.key)] - m.view.offset, anchor.y, "the anchor's screen y");
});

test("a diagram block not measured yet with a picture of known size is estimated at its space and its frame", async () => {
  renderer({ width: 4642, height: 5444 });
  const m = await mount({ disk: DOC });
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 1900, height: 1066 }, m.cx);
  viewportOf(m, 1900, 1000);
  assert.equal(m.view.estimate(m.view.blocks[2]), 14 + 120, "nothing known: the box that says it is being drawn");
  await drawn(m);
  assert.equal(m.view.estimate(m.view.blocks[2]), 14 + 700);
});

const drawsAt =(natW, natH) => async (_c, args) => {
  const at = args.indexOf("--scale"), scale = at < 0 ? 2 : Number(args[at + 1]);
  return { code: 0, stderr: "", stdout: `${JSON.stringify({ results: args.slice(at < 0 ? 5 : 9).map(file => ({ key: file.slice(file.lastIndexOf("/") + 1).replace(/\.mmd$/, ""), ok: true, width: Math.round(natW * scale), height: Math.round(natH * scale), scale })) })}\n` };
};
const sharpRuns = () => calls.exec.filter(c => c.args.includes("--scale"));
const sharpFile = (key, scale) => sharpName(key, "transparent", scale);

test("zoomed past what its picture holds, a frame asks 300 ms later for one transparent sharp picture, and draws it over the base", async () => {
  const m = await framed({ width: 1104, height: 116 });
  const key = keyAt(m, 2), f = frameOn(m), at = { x: f.left + 300, y: f.top + 40 }, baseKey = f.d.imgKey;
  state.exec = drawsAt(552, 58);
  scroll(m, at, 0, 10, { touch_phase: "started", modifiers: { platform: true } });
  await fire_timers(m.cx, { ms: 300 });
  assert.equal(sharpRuns().length, 0, "105 % on a 2x screen: the base is sharp enough");
  scroll(m, at, 0, 200, { modifiers: { platform: true } });
  assert.equal(m.view.viewOf(key).z, 2);
  assert.equal(sharpRuns().length, 0, "not while zooming");
  await fire_timers(m.cx, { ms: 300 });
  assert.equal(sharpRuns().length, 1);
  assert.deepEqual(sharpRuns()[0].args.slice(5), ["--scale", "4", "--background", "transparent", `/home/user/.config/herdr-app/data/herdr-inline-markdown/diagrams/${sharpFile(baseKey, 4)}.mmd`]);
  const img = frameOn(m).img;
  assert.deepEqual(img.map(i => i.path), [`data/herdr-inline-markdown/diagrams/${baseKey}.png`, `data/herdr-inline-markdown/diagrams/${sharpFile(baseKey, 4)}.png`], "over the base");
  assert.deepEqual([img[1].style.w, img[1].style.h], [img[0].style.w, img[0].style.h]);
  hover(m, at);
  await clickAt(m, { x: f.left + f.w - 8 - 102 + 50, y: f.top + 8 + 10 });
  assert.equal(m.view.viewOf(key).z, 1, "% back to 100 %");
  assert.equal(frameOn(m).img.length, 1, "at 100 % only the base draws");
  scroll(m, at, 0, 200, { touch_phase: "started", modifiers: { platform: true } });
  await fire_timers(m.cx, { ms: 300 });
  assert.equal(sharpRuns().length, 1, "never asked for twice");
});

test("zoomed to 200 %, the stress diagram asks 300 ms later for one sharp picture at 2.5x, inside the pixel budget, and draws it over the base", async () => {
  const m = await framed();
  const f = frameOn(m), baseKey = f.d.imgKey;
  state.exec = drawsAt(2321, 2722);
  await fire_timers(m.cx);
  assert.deepEqual(sharpRuns(), [], "shown at its starting zoom, it asks for none");
  scroll(m, { x: 700, y: f.top + 300 }, 0, 400, { touch_phase: "started", modifiers: { platform: true } });
  assert.equal(m.view.viewOf(keyAt(m, 2)).z, 2);
  await fire_timers(m.cx, { ms: 400 });
  assert.deepEqual(sharpRuns(), [], "not before the zoom has rested 300 ms");
  await fire_timers(m.cx, { ms: 300 });
  assert.deepEqual(sharpRuns().map(c => c.args.slice(5)), [["--scale", "2.5", "--background", "transparent", `/home/user/.config/herdr-app/data/herdr-inline-markdown/diagrams/${sharpFile(baseKey, 2.5)}.mmd`]]);
  assert.deepEqual(frameOn(m).img.map(i => i.path), [`data/herdr-inline-markdown/diagrams/${baseKey}.png`, `data/herdr-inline-markdown/diagrams/${sharpFile(baseKey, 2.5)}.png`]);
});

test("at app zoom 1.5 a frame that opens at 100 % asks for no sharp picture until a zoom of it rests; a theme switch keeps the one it has and asks for no other", async () => {
  state.settings = { ...state.settings, zoom: 1.5 };
  const m = await framed({ width: 1104, height: 116 });
  state.exec = drawsAt(552, 58);
  await fire_timers(m.cx);
  assert.deepEqual(sharpRuns(), [], "nobody zoomed");
  const f = frameOn(m), at = { x: (f.left + 300) * 1.5, y: (f.top + 40) * 1.5 };
  scroll(m, at, 0, 10, { touch_phase: "started", modifiers: { platform: true } });
  await fire_timers(m.cx, { ms: 300 });
  assert.deepEqual(sharpRuns().map(c => c.args[c.args.indexOf("--scale") + 1]), ["6"]);
  state.theme = { ...theme(), background: "night" };
  m.tree();
  await fire_timers(m.cx, { ms: 0 });
  await fire_timers(m.cx, { ms: 400 });
  assert.equal(frameOn(m).d.imgKey, f.d.imgKey, "the same picture: the key does not follow the theme");
  assert.equal(sharpRuns().length, 1, "a theme switch asks for none");
  scroll(m, at, 0, -10, { touch_phase: "started", modifiers: { platform: true } });
  await fire_timers(m.cx, { ms: 300 });
  assert.equal(sharpRuns().length, 1, "nor does the next zoom: one sharp picture per diagram");
  assert.ok(sharpRuns()[0].args.at(-1).endsWith(`/${sharpFile(f.d.imgKey, 6)}.mmd`));
  assert.ok(frameOn(m).img.some(i => i.path === `data/herdr-inline-markdown/diagrams/${sharpFile(f.d.imgKey, 6)}.png`), "which the frame still draws");
});

test("diagrams keep their last image across edits made in Markdown: dimmed while the changed one is drawn, at once when unchanged", async () => {
  renderer({ width: 800, height: 400 });
  const m = await mount({ disk: DOC });
  await drawn(m);
  const key = keyAt(m, 2), first = imageOf(m.tree(), dia(m)).path;
  await m.click("md-markdown");
  await m.type(`# A new title\n\nInserted above.\n\n${DOC.replace("A-->B", "A-->C").slice(DOC.indexOf("Hello"))}`);
  await m.click("md-markdown");
  assert.equal(m.view.doc.blocks.find(b => b.kind === "mermaid").key, key, "the diagram's block kept its key");
  assert.equal(m.view.activeKey, key, "the source caret was in the diagram's source: its block opens as source");
  assert.ok(find(m.tree(), `md-field-${key}`));
  escape(m);
  let t = m.tree();
  const dim = imageOf(t, `md-diagram-${key}`);
  assert.deepEqual([dim.path, dim.style.opacity], [first, 0.5]);
  assert.doesNotMatch(textOf(must(t, `md-diagram-${key}`)), /Drawing diagram/);
  assert.equal(textOf(must(t, "md-diagrams")), "Drawing diagrams…");
  await fire_timers(m.cx, { ms: 400 });
  t = m.tree();
  const now = imageOf(t, `md-diagram-${key}`);
  assert.notEqual(now.path, first);
  assert.equal(now.style.opacity, undefined);
  assert.equal(textOf(must(t, "md-diagrams")), "1 diagram");
  await m.click("md-markdown");
  await m.type(m.view.source.value().replace("Bye", "Goodbye"));
  await m.click("md-markdown");
  assert.notEqual(m.view.activeKey, key);
  assert.equal(imageOf(m.tree(), `md-diagram-${key}`).path, now.path);
  assert.equal(imageOf(m.tree(), `md-diagram-${key}`).style.opacity, undefined);
});

test("a diagram that cannot be drawn shows its error; the footer counts it", async () => {
  renderer();
  state.exec = async (_c, args) => ({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: args.slice(5).map(f => ({ key: f.slice(f.lastIndexOf("/") + 1).replace(/\.mmd$/, ""), ok: false, error: "Parse error on line 2" })) })}\n` });
  const m = await mount({ disk: DOC });
  await drawn(m);
  const t = m.tree();
  assert.match(textOf(must(t, dia(m))), /Mermaid error/);
  assert.match(textOf(must(t, dia(m))), /Parse error on line 2/);
  assert.equal(textOf(must(t, "md-diagrams")), "1 diagram · 1 error");
});

test("two diagrams: both drawn, '2 diagrams'; no diagrams: no status; Edit: no status", async () => {
  renderer();
  const two = DOC + "\n```mermaid\nsequenceDiagram\nA->>B: hi\n```\n";
  const m = await mount({ disk: two });
  await drawn(m);
  assert.equal(textOf(must(m.tree(), "md-diagrams")), "2 diagrams");
  assert.equal(calls.exec.filter(c => c.args[0].endsWith("render.mjs")).length, 1, "both in one run");
  await m.click("md-markdown");
  assert.equal(find(m.tree(), "md-diagrams"), null, "nothing is drawn while editing");
  reset();
  const none = await mount({ disk: "# no diagrams" });
  assert.equal(find(none.tree(), "md-diagrams"), null);
});

test("no renderer installed: the diagram says how to get it, with its source, and the footer says so", async () => {
  const m = await mount({ disk: DOC });
  m.tree();
  await flush();
  const t = m.tree();
  assert.match(textOf(must(t, dia(m))), /Diagrams need the mermaid renderer/);
  assert.match(textOf(must(t, dia(m))), /Run install\.sh in the herdr-inline-markdown folder/);
  assert.equal(must(t, `${dia(m)}-source`).markdown, "```mermaid\ngraph TD\nA-->B\n```");
  assert.equal(textOf(must(t, "md-diagrams")), "Diagrams need the mermaid renderer: run install.sh");
  assert.equal(calls.exec.length, 0);
  audit(t);
});

test("a renderer installed while a note is open draws its diagram 10 s later, with nothing edited or resized", async t => {
  const time = { now: 1_000_000 };
  t.mock.method(Date, "now", () => time.now);
  const m = await mount({ disk: DOC });
  assert.match(textOf(must(m.tree(), dia(m))), /Diagrams need the mermaid renderer/);
  renderer();
  time.now += 10_000;
  await fire_timers(m.cx, { ms: 10_000 });
  await fire_timers(m.cx, { ms: 400 });
  assert.ok(imageOf(m.tree(), dia(m)), "the diagram is drawn");
  assert.equal(textOf(must(m.tree(), "md-diagrams")), "1 diagram");
});

test("no node: the diagram says so and so does the footer", async () => {
  renderer();
  state.exec = async () => { throw new Error("spawn ENOENT"); };
  const m = await mount({ disk: DOC });
  await drawn(m);
  const t = m.tree();
  assert.match(textOf(must(t, dia(m))), /Diagrams need Node\.js/);
  assert.equal(textOf(must(t, "md-diagrams")), "Diagrams need Node.js");
});

test("a Markdown editor remembers the file as a recent one as it starts", async () => {
  await mount({ disk: "x" });
  assert.deepEqual(state.shared["herdr-inline-markdown.recent"], [{ machine: null, path: FILE }]);
});

const registry = () => state.shared[PANES];
const claimedWrites = () => calls.setShared.filter(c => c[0] === PANES);

test("the pane registry: not at init (focused() is still the previous tab), but when the pane is first drawn", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [shellPane];
  farFocus("tb1");
  const m = await mount({ disk: "x" });
  assert.equal(registry(), undefined, "init filed nothing: the previous tab is a terminal, and the other one is not there yet");
  // Herdr has made the tab and shows it
  state.spaces[0].tabs.push(tabOf("tb2", "note.md"));
  state.panes = [shellPane, mdPaneOf("tb2")];
  farFocus("tb2");
  m.tree();
  await flush();
  assert.deepEqual(registry(), { "p-tb2": fileKey(null, FILE) });
  assert.deepEqual(state.shared["herdr-inline-markdown.heads"], { "p-tb2": { name: "note.md", mode: "reading" } });
  const writes = calls.setShared.length;
  m.tree(); m.tree();
  await flush();
  assert.equal(calls.setShared.length, writes, "once per pane, not once per draw");
  assert.equal(m.view.claimed, "p-tb2");
});

test("init files nothing, and a draw while the previous tab is focused does not file its Markdown pane", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "other.md"), tabOf("tb2", "note.md")] })];
  state.panes = [mdPaneOf("tb1")];
  state.shared[PANES] = { "p-tb1": fileKey(null, "/n/docs/other.md") };
  farFocus("tb1"); // the tab being left shows another file; this copy's pane is not listed yet
  const m = await mount({ disk: "x" });
  m.tree();
  await flush();
  assert.deepEqual(registry(), { "p-tb1": fileKey(null, "/n/docs/other.md") }, "the other pane keeps its own file");
  assert.deepEqual(calls.setShared.map(c => c[0]), ["herdr-inline-markdown.recent"]);
  assert.equal(m.view.claimed, null);
});

test("the pane registry waits until the focused tab has a Markdown pane, then files it", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main"), tabOf("tb2", "note.md")] })];
  state.panes = [shellPane];
  farFocus("tb2"); // focused already, the pane is not in panes() yet
  const m = await mount({ disk: "x" });
  m.tree();
  await flush();
  assert.equal(registry(), undefined);
  state.panes = [shellPane, mdPaneOf("tb2")];
  m.tree();
  await flush();
  assert.deepEqual(registry(), { "p-tb2": fileKey(null, FILE) });
});

test("a draw while nothing is focused, or the focused tab is a terminal, files nothing", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main"), tabOf("tb2", "note.md")] })];
  state.panes = [shellPane, mdPaneOf("tb2")];
  state.focused = null;
  const m = await mount({ disk: "x" });
  m.tree();
  farFocus("tb1");
  m.tree();
  farFocus("tb-unknown");
  m.tree();
  await flush();
  assert.equal(registry(), undefined);
});

test("a copy with no file files no pane, reads, watches and writes nothing: it is the check fixture", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb2", "note.md")] })];
  state.panes = [mdPaneOf("tb2")];
  farFocus("tb2");
  const m = await mount({ props: {} });
  assert.ok(isFixture(m.tree()));
  await flush();
  assert.equal(registry(), undefined);
  await clickAt(m, { x: 0, y: 0 });
  await m.click("md-markdown");
  await m.type("typed into the fixture");
  await m.save();
  assert.deepEqual([calls.readTextFile.length, calls.watchFolder.length, calls.writeTextFile.length], [0, 0, 0]);
});

const isFixture = tree => all(tree, n => n.kind === "textview").some(n => n.markdown === "Every kind of block");

test("the check fixture: every kind of block drawn in the root through renderBlock, block 2 in the field with its slash menu open, the spare over block 4", async () => {
  const cx = makeCx();
  const view = new Editor();
  view.init(undefined, cx);
  assert.equal(cx.entities.length, 0, "no nested views: check does not draw them");
  const t = view.render(cx);
  const kinds = new Set(view.doc.blocks.map(b => b.kind));
  for (const k of ["frontmatter", "heading", "paragraph", "item", "quote", "code", "mermaid", "table", "html", "hr", "definition"]) assert.ok(kinds.has(k), k);
  assert.ok(view.doc.blocks.some(b => b.image) && view.doc.blocks.some(b => b.task?.checked) && view.doc.blocks.some(b => b.ordered) && view.doc.blocks.some(b => b.setext));
  const column = must(t, "md-column");
  assert.deepEqual(column.kids.map(k => k.id), view.doc.blocks.map(b => `md-block-${b.key}`));
  const [active, armed] = [view.doc.blocks[2], view.doc.blocks[4]];
  const field = all(must(t, `md-field-${active.key}`), n => n.kind === "textarea")[0];
  assert.equal(field.state, view.field);
  assert.equal(view.field.value(), "A paragraph with **bold**, _emphasis_, `code` and a [link](https://example.com). /");
  assert.equal(must(t, `md-field-${active.key}`).style.key_context, `${TEXT} rows=many menu=open`, "its slash menu open");
  const menu = must(t, "md-slash");
  assert.equal(must(t, "md-viewport").kids.indexOf(menu), must(t, "md-viewport").kids.findIndex(k => k.id?.startsWith("md-cal")) - 1, "drawn last on the page, before the calibration strip");
  assert.deepEqual(all(menu, n => n.kind === "svg").map(n => n.path.split("/").at(-1)), COMMANDS.map(c => `${c.icon}.svg`), "each command's icon, in the table's order");
  assert.ok(menu.style.shadow_lg && typeof menu.handlers.on_mouse_down_out === "function");
  assert.deepEqual([field.style.font_family, field.style.text_size, field.style.line_height], [SANS, 15, 1.6]);
  const spare = all(must(t, `md-field-${armed.key}`), n => n.kind === "textarea")[0];
  assert.equal(spare.state, view.spare);
  assert.equal(view.spare.value(), "A bullet item");
  assert.equal(must(t, `md-field-${armed.key}`).style.key_context, undefined, "only the active field has the block keys");
  assert.ok(find(t, "md-cal"), "the calibration strip");
  assert.ok(find(t, `md-diagram-${view.doc.blocks.find(b => b.kind === "mermaid").key}`));
  const picture = imageOf(t, `md-pictures-${view.doc.blocks.find(b => b.image).key}`);
  assert.deepEqual([picture.path, picture.style.w, picture.style.h], ["mods/herdr-inline-markdown/file-markdown.svg", 32, 32], "a real picture, so check draws an image");
  const quote = view.doc.blocks.find(b => b.kind === "quote");
  assert.match(all(must(t, `md-block-${quote.key}`), n => n.kind === "textview")[0].markdown, /<mark color="#[0-9a-f]{8}">a remark<\/mark>/, "a comment, highlighted");
  assert.ok(find(t, `md-notes-${quote.key}`), "its count");
  const card = must(t, "md-notes-card"), box = must(t, "md-note");
  assert.ok(find(card, "md-note-edit-0") && find(card, "md-note-resolve-0"), "the card with its buttons");
  assert.equal(all(box, n => n.kind === "input")[0].state, view.noteField, "the comment box");
  audit(t);
});

test("a copy beside another Markdown pane files its own pane and leaves the other one's entry alone", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [shellPane, mdPane("pa", "tb1"), mdPane("pb", "tb1")];
  state.shared[PANES] = { pa: fileKey(null, "/n/docs/other.md") };
  farFocus("tb1");
  const m = await mount({ disk: "x" });
  m.tree();
  await flush();
  assert.deepEqual(registry(), { pa: fileKey(null, "/n/docs/other.md"), pb: fileKey(null, FILE) });
  assert.equal(m.view.claimed, "pb");
});

test("two Markdown panes the registry does not know yet cannot be told apart: nothing is filed until one of them is", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [mdPane("pa", "tb1"), mdPane("pb", "tb1")];
  farFocus("tb1");
  const m = await mount({ disk: "x" });
  m.tree();
  await flush();
  assert.equal(registry(), undefined);
  assert.equal(m.view.claimed, null);
  state.shared[PANES] = { pa: fileKey(null, "/n/docs/other.md") };
  m.tree();
  await flush();
  assert.equal(m.view.claimed, "pb", "the other one filed itself, so this one is the one left");
  assert.deepEqual(registry(), { pa: fileKey(null, "/n/docs/other.md"), pb: fileKey(null, FILE) });
});

test("a pane the registry already files under the file (after a restart) is claimed without a write", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [mdPane("pa", "tb1"), mdPane("pb", "tb1")];
  state.shared[PANES] = { pb: fileKey(null, FILE) };
  farFocus("tb1");
  const m = await mount({ disk: "x" });
  m.tree();
  await flush();
  assert.equal(m.view.claimed, "pb");
  assert.deepEqual(claimedWrites(), []);
});

test("once claimed it stops looking while its pane is listed, and looks again when the pane is gone", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main"), tabOf("tb2", "note.md")] })];
  state.panes = [shellPane, mdPane("pa", "tb2")];
  farFocus("tb2");
  const m = await mount({ disk: "x" });
  m.tree();
  await flush();
  assert.equal(m.view.claimed, "pa");
  farFocus("tb1");
  m.tree();
  await flush();
  assert.equal(m.view.claimed, "pa", "the focus moved to another tab; the pane is still there");
  assert.equal(claimedWrites().length, 1);
  farFocus("tb2");
  state.panes = [shellPane, mdPane("pc", "tb2")];
  m.tree();
  await flush();
  assert.equal(m.view.claimed, "pc");
  assert.deepEqual(registry(), { pc: fileKey(null, FILE) }, "the entry of the pane that is gone is dropped with it");
});

test("a file's pane is filed under its machine, and openMarkdown then goes to it instead of opening another", async () => {
  const { openMarkdown } = await import("../mods/herdr-inline-markdown/open.js");
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main"), tabOf("tb2", "note.md")] })];
  state.panes = [shellPane, mdPaneOf("tb2")];
  farFocus("tb1");
  const m = await mount({ machine: "devbox", disk: "x" });
  farFocus("tb2");
  openMarkdown({ file: FILE, machine: "devbox", place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["space.select", "tab.select"], "not drawn yet: found by its name");
  calls.run.length = 0;
  m.tree();
  await flush();
  assert.deepEqual(registry(), { "p-tb2": fileKey("devbox", FILE) });
  openMarkdown({ file: FILE, machine: "devbox", place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "tb2" }]], "found by the registry");
  calls.run.length = 0;
  openMarkdown({ file: FILE, machine: "devbox", place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [["pane.split", { direction: "right", pane: "p1", mod: "herdr-inline-markdown", props: { file: FILE, machine: "devbox" } }]], "tb1 does not show it");
  calls.run.length = 0;
  openMarkdown({ file: FILE, machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"], "the same path on this computer is another file");
});

test("main.js: a tab (or no props) is the editor, a dialog with action open is the picker; render and close are forwarded", async () => {
  state.disk.set(FILE, "old");
  state.props = { file: FILE };
  const cx = makeCx();
  cx.settle = flush;
  const tab = new Markdown();
  tab.init({ file: FILE }, cx);
  await flush();
  assert.equal(tab.role.constructor.name, "Editor");
  assert.ok(find(tab.render(cx), "md-root"));
  tab.role.source.edit("changed", cx);
  await tab.close(cx);
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "changed", expected: "old" }], "close reaches the editor");

  reset();
  state.props = undefined;
  state.exec = async () => ({ code: 1, stdout: "", stderr: "" });
  const bare = new Markdown();
  const bcx = makeCx();
  bcx.settle = flush;
  bare.init(undefined, bcx);
  assert.equal(bare.role.constructor.name, "Editor");
  assert.ok(isFixture(bare.render(bcx)));

  reset();
  state.props = { action: "open", space: "s1", folder: "/n", machine: null, overlay: "ov-1" };
  state.exec = async () => ({ code: 0, stdout: "", stderr: "" });
  const dialog = new Markdown();
  const dcx = makeCx();
  dcx.settle = flush;
  dialog.init(undefined, dcx);
  await flush();
  assert.equal(dialog.role.constructor.name, "Picker");
  assert.ok(find(dialog.render(dcx), "mdp-root"), "render reaches the picker");
  assert.equal(state.shared["herdr-inline-markdown.picker"], "ov-1", "the dialog is the open picker");
  await dialog.close(dcx);
  assert.equal(state.shared["herdr-inline-markdown.picker"], null, "close reaches the picker, which gives up its place");
});

test("props come from the init argument when props() has none", async () => {
  state.disk.set(FILE, "x");
  state.props = undefined;
  const cx = makeCx();
  cx.settle = flush;
  const view = new Markdown();
  view.init({ file: FILE }, cx);
  await flush();
  assert.equal(view.role.file, FILE);
  assert.equal(view.role.mode, "reading");
});

// The column's left edge in a 900 px viewport ((900 - 780) / 2 + 32), and block i's top on the screen.
const X = 92;
const topOf = (m, i) => 28 + m.view.sums[i] - m.view.offset;
async function page(disk, sizes, viewH = 600) {
  const m = await mount({ disk });
  viewportOf(m, 900, viewH);
  await heights(m, sizes);
  return m;
}
const NO_MODS = { shift: false, control: false, alt: false, platform: false };
const keyUp =(m, key, modifiers = {}) => fire(must(m.tree(), `md-field-${m.view.activeKey}`), "on_key_up", { key, keystroke: key, modifiers: { ...NO_MODS, ...modifiers } }, m.cx);
const hover = (m, p) => fire(must(m.tree(), "md-viewport"), "on_mouse_move", { position: p, local_position: p, modifiers: NO_MODS }, m.cx);
// Every style measured as drawn by default: arming waits for the measurements.
function calibrate(m) {
  const t = m.tree();
  for (const [name, st] of Object.entries(STYLES)) {
    if (!find(t, `md-cal-${name}-tv1`)) continue;
    const row = st.size * st.lh;
    for (const [part, h] of [["tv1", row], ["tv3", 3 * row], ["f1", row], ["f3", 3 * row]]) fire(must(t, `md-cal-${name}-${part}`), "on_size_change", { width: 600, height: h }, m.cx);
    fire(must(t, `md-cal-${name}-adv`), "on_size_change", { width: 40 * st.size * (st.mono ? 0.6 : 0.47), height: row }, m.cx);
  }
  assert.equal(m.view.calibrating, false);
}

test("the key table goes in once per runtime: versioned contexts of the editor's own fields only, mdb-* actions that md-root handles", async () => {
  delete globalThis[INSTALLED];
  const a = await mount({ disk: "x" }), b = await mount({ disk: "y" });
  assert.equal(a.cx.bound.length, 1);
  assert.equal(b.cx.bound.length, 0, "a second editor, or the mod reloaded, adds nothing");
  assert.equal(globalThis[INSTALLED], true);
  const table = a.cx.bound[0];
  for (const { action, context } of table) {
    assert.match(action, /^mdb-[a-z-]+$/);
    assert.match(context, new RegExp(`^(${TEXT}|${RAW}|${SOURCE}|${NOTE})( && (rows == one|menu == open))?( > Input)?$`), "never a bare Input: only inside the editor's fields");
  }
  const contexts = key => table.filter(x => x.keystroke === key).map(x => x.context).sort();
  const actions = key => [...new Set(table.filter(x => x.keystroke === key).map(x => x.action))];
  assert.deepEqual(contexts("enter"), [`${TEXT} > Input`]);
  assert.deepEqual(contexts("shift-enter"), [`${TEXT} > Input`]);
  for (const key of ["up", "down"]) {
    assert.deepEqual(contexts(key), [`${RAW} && rows == one > Input`, `${TEXT} && menu == open > Input`, `${TEXT} && rows == one > Input`], `${key}: where the field has one row, and in a text field with the slash menu open`);
    assert.deepEqual(actions(key), [`mdb-${key}`], `${key}: one action for both, so it does not matter which binding wins`);
  }
  assert.deepEqual(contexts("cmd-z"), [`${RAW} > Input`, `${SOURCE} > Input`, `${TEXT} > Input`]);
  assert.deepEqual(contexts("cmd-v"), [`${RAW} > Input`, `${TEXT} > Input`]);
  for (const [key, action] of [["alt-up", "mdb-move-up"], ["alt-down", "mdb-move-down"]]) {
    assert.deepEqual(contexts(key), [`${RAW} > Input`, `${TEXT} > Input`], `${key}: moves the block, in both block contexts`);
    assert.deepEqual(actions(key), [action], key);
  }
  assert.deepEqual(table.filter(x => /^cmd-shift-(up|down)$/.test(x.keystroke)), [], "the keys that moved a block before are not bound");
  for (const [key, action] of [["cmd-b", "mdb-bold"], ["cmd-i", "mdb-italic"], ["cmd-shift-x", "mdb-strike"], ["cmd-shift-c", "mdb-code"], ["cmd-k", "mdb-link"]]) {
    assert.deepEqual(contexts(key), [`${TEXT} > Input`], `${key}: formats the selection in a text block only`);
    assert.deepEqual(actions(key), [action], key);
  }
  assert.deepEqual(contexts("cmd-alt-m"), [`${TEXT} > Input`], "a comment on the selection, in a text block only");
  assert.deepEqual(actions("cmd-alt-m"), ["mdb-comment"]);
  assert.deepEqual([TEXT, RAW, SOURCE, NOTE], ["MdText5", "MdRaw5", "MdSource5", "MdNote5"], "the table changed, so its contexts are new ones and the old ones stay inert");
  assert.deepEqual(table.filter(x => /\bMd(?:Text|Raw|Source|Note)[0-4]\b/.test(x.context)), [], "no context of an older table");
  for (const key of ["backspace", "left", "right"]) assert.deepEqual(contexts(key), [RAW, TEXT], `${key}: only when the field gives it away`);
  assert.deepEqual(contexts("escape"), [`${NOTE} > Input`, RAW, TEXT], "the comment box takes Escape whatever its field holds; the block fields only give it away");
  assert.deepEqual(actions("escape"), ["mdb-note-cancel", "mdb-escape"]);
  for (const key of ["delete", "cmd-a", "cmd-c", "cmd-x", "home", "end", "shift-up", "alt-left", "cmd-s", "cmd-e", "a"]) assert.deepEqual(contexts(key), [], key);
  const root = must(a.tree(), "md-root");
  for (const name of new Set(table.map(x => x.action))) assert.equal(typeof root.handlers[`on_action:${name}`], "function", name);
});

test("a press on a code block puts the caret on the pressed line and column, which stays under the pointer; on a table, at the pressed cell's start", async () => {
  const code = "```js\nconst a = 1;\nlet b = 2;\nreturn a + b;\n```", table = "| name | value |\n|------|-------|\n| a    | 12345 |";
  const m = await page(`Intro\n\n${code}\n\n${table}\n`, { 0: 24, 1: 14 + 26 + 3 * 19.5, 2: 14 + 26 + 60 }, 150);
  const [codeKey, tableKey] = [keyAt(m, 1), keyAt(m, 2)];
  await clickAt(m, { x: X + 15 + 4 * 7.8 + 1, y: topOf(m, 1) + 14 + 13 + 19.5 + 5 }); // line 2 of the drawn code, column 4
  assert.equal(m.view.activeKey, codeKey);
  assert.equal(m.view.field.value(), code, "a raw block edits as its source, fences included");
  const at = code.indexOf("let") + 4;
  assert.deepEqual(m.view.field.selection, { start: at, end: at });
  assert.equal(m.view.field.focused, true);
  assert.equal(must(m.tree(), `md-field-${codeKey}`).style.key_context, `${RAW} rows=many`);
  assert.equal(m.view.offset, 19.5, "the fence line the field shows above moves the page one row: the line stays under the pointer");
  await clickAt(m, { x: X + 15 + 400, y: topOf(m, 2) + 14 + 13 + 30 + 5 }); // the body row, the second column
  assert.equal(m.view.activeKey, tableKey);
  const cell = table.indexOf("12345");
  assert.deepEqual(m.view.field.selection, { start: cell, end: cell });
  assert.equal(calls.writeTextFile.length, 0, "opening blocks writes nothing");
});

test("typing in block 0 then ticking block 3's box changes only that bracket", async () => {
  const m = await page("Intro\n\nMiddle\n\nThird\n\n- [ ] task\n", { 0: 24, 1: 38, 2: 38, 3: 38 });
  await clickAt(m, { x: X + 30, y: topOf(m, 0) + 10 });
  assert.equal(m.view.activeKey, keyAt(m, 0));
  m.view.field.select(5);
  m.view.field.type("!", m.cx);
  const typed = m.view.text;
  assert.equal(typed, "Intro!\n\nMiddle\n\nThird\n\n- [ ] task\n");
  await clickAt(m, { x: X + 12, y: topOf(m, 3) + 14 + 12 });
  assert.equal(m.view.text, "Intro!\n\nMiddle\n\nThird\n\n- [x] task\n");
  assert.deepEqual([...m.view.text].map((c, i) => (c === typed[i] ? null : i)).filter(i => i !== null), [typed.indexOf("[ ]") + 1], "one byte");
  await flush();
  assert.equal(state.disk.get(FILE), m.view.text, "saved at once");
  assert.equal(m.view.activeKey, keyAt(m, 0), "the paragraph is still the one being edited");
});

test("ticking the box of the item being edited keeps it open, with the caret and the keyboard where they were", async () => {
  const m = await page("- [ ] first\n- [ ] second\n", { 0: 24, 1: 30 });
  await clickAt(m, { x: X + 24 + 20, y: topOf(m, 0) + 10 });
  const key = keyAt(m, 0), field = m.view.field;
  assert.equal(m.view.activeKey, key);
  field.select(3);
  keyUp(m, "right");
  await flush();
  assert.deepEqual(m.view.known, { start: 3, end: 3, valid: true }, "read out after the key that moved it");
  field.focused = false;
  const log = field.log.length, box = { x: X + 12, y: topOf(m, 0) + 12 };
  fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", press(box), m.cx);
  assert.equal(field.focused, true, "a press beside the field gives the keyboard straight back to it");
  fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press(box), m.cx);
  await flush();
  assert.equal(m.view.text, "- [x] first\n- [ ] second\n");
  assert.equal(m.view.activeKey, key);
  assert.deepEqual(field.log.slice(log), [], "the field is not touched");
  assert.deepEqual([field.value(), field.selection], ["first", { start: 3, end: 3 }]);
  assert.ok(must(m.tree(), `md-task-${key}`).kids.length, "its box shows the check");
});

test("a press beside the field being edited that let the root take the keyboard gives it back on the mouse-up: a tick of its own box, or a press that moved", async () => {
  const m = await page("- [ ] first\n- [ ] second\n", { 0: 24, 1: 30 });
  await clickAt(m, { x: X + 24 + 20, y: topOf(m, 0) + 10 });
  const key = keyAt(m, 0), field = m.view.field, box = { x: X + 12, y: topOf(m, 0) + 12 }, vp = () => must(m.tree(), "md-viewport");
  fire(vp(), "on_mouse_down:left", press(box), m.cx);
  field.blur(m.cx); // the root took the keyboard after the press gave it to the field
  fire(vp(), "on_mouse_up:left", press(box), m.cx);
  await flush();
  assert.deepEqual([m.view.text, m.view.activeKey, field.focused], ["- [x] first\n- [ ] second\n", key, true]);
  fire(vp(), "on_mouse_down:left", press(box), m.cx);
  field.blur(m.cx);
  fire(vp(), "on_mouse_up:left", press({ x: box.x + 10, y: box.y }, { click_count: 0 }), m.cx);
  await flush();
  assert.deepEqual([m.view.text, field.focused], ["- [x] first\n- [ ] second\n", true], "no tick, and the keyboard is back");
});

test("an agent ticking the task being edited keeps it open, and what is typed next lands in it", async () => {
  const m = await page("- [ ] task\n\nOther\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 24 + 20, y: topOf(m, 0) + 10 });
  const key = keyAt(m, 0), field = m.view.field;
  field.select(4);
  keyUp(m, "end");
  await flush();
  const log = field.log.length;
  state.disk.set(FILE, "- [x] task\n\nOther\n");
  await m.touch([FILE]);
  assert.equal(m.view.text, "- [x] task\n\nOther\n");
  assert.equal(m.view.activeKey, key);
  assert.deepEqual(field.log.slice(log), [], "its field value did not change: the field is left alone");
  assert.ok(must(m.tree(), `md-task-${key}`).kids.length, "the box shows their tick");
  field.type("!", m.cx);
  assert.equal(m.view.text, "- [x] task!\n\nOther\n");
  await m.save();
  assert.equal(state.disk.get(FILE), "- [x] task!\n\nOther\n");
});

test("an agent writing an identical heading beside the one being edited leaves that block open and untouched", async () => {
  const m = await page("Intro\n\n# Title\n\nBody\n", { 0: 24, 1: 67, 2: 38 });
  await clickAt(m, { x: X + 10, y: topOf(m, 1) + 32 + 10 });
  const key = keyAt(m, 1), field = m.view.field;
  assert.equal(m.view.activeKey, key);
  field.select(5);
  keyUp(m, "end");
  await flush();
  const log = field.log.length;
  state.disk.set(FILE, "Intro\n\n# Title\n\n# Title\n\nBody\n");
  await m.touch([FILE]);
  assert.equal(m.view.doc.blocks.filter(b => b.kind === "heading").length, 2);
  assert.equal(m.view.activeKey, key, "the same block");
  assert.deepEqual(field.log.slice(log), []);
  field.type("!", m.cx);
  assert.equal(m.view.text, "Intro\n\n# Title!\n\n# Title\n\nBody\n", "the next letter lands in it");
});

test("an outside change to the block being edited: its new text goes into the field, the caret on the same text; a block taken away is left", async () => {
  const m = await page("Intro\n\nHello world\n\nEnd\n", { 0: 24, 1: 38, 2: 38 });
  await clickAt(m, { x: X + 10, y: topOf(m, 1) + 14 + 10 });
  const key = keyAt(m, 1), field = m.view.field;
  field.select(6);
  keyUp(m, "right");
  await flush();
  state.disk.set(FILE, "Intro\n\nOh, hello world\n\nEnd\n");
  await m.touch([FILE]);
  assert.equal(m.view.activeKey, key);
  assert.deepEqual([field.value(), field.selection], ["Oh, hello world", { start: 10, end: 10 }], "still before 'world'");
  field.focused = true;
  m.view.handle.focused = false;
  state.disk.set(FILE, "Intro\n\nEnd\n");
  await m.touch([FILE]);
  assert.equal(m.view.activeKey, null, "not 'End', which only took its place");
  assert.equal(m.view.handle.focused, true);
  assert.equal(viewAt(m, 1).markdown, "End");
});

test("Load theirs while typing puts their text in the field and writes nothing of ours", async () => {
  const m = await page("Hello\n", { 0: 24 });
  await clickAt(m, { x: X + 20, y: topOf(m, 0) + 10 });
  const field = m.view.field;
  field.select(5);
  field.type(" world", m.cx);
  state.disk.set(FILE, "Theirs\n");
  await m.touch([FILE]);
  assert.equal(m.status(), "Conflict");
  field.type("!", m.cx);
  assert.equal(m.view.text, "Hello world!\n", "editing goes on while the banner shows");
  await m.click("md-load-theirs");
  assert.deepEqual([m.view.text, field.value(), m.view.disk, m.view.activeKey], ["Theirs\n", "Theirs", "Theirs\n", keyAt(m, 0)]);
  field.handlers.change({}, m.cx); // a change the field reports late
  await m.save();
  await fire_timers(m.cx);
  assert.deepEqual(calls.writeTextFile, []);
  assert.equal(state.disk.get(FILE), "Theirs\n");
  assert.equal(m.status(), "Saved");
});

test("Escape keeps the caret and stops editing; Enter comes back to it, or to the first block on the page when its block is not", async () => {
  const m = await tall(200);
  await clickAt(m, { x: X + 20, y: topOf(m, 1) + 14 + 10 });
  const key = keyAt(m, 1), field = m.view.field;
  field.select(4);
  keyUp(m, "right");
  await flush();
  m.view.handle.focused = false;
  escape(m);
  assert.equal(m.view.activeKey, null);
  assert.equal(m.view.handle.focused, true);
  assert.equal(viewAt(m, 1).markdown, "Paragraph 1", "drawn rendered");
  field.focused = false;
  await m.key("enter");
  assert.equal(m.view.activeKey, key);
  assert.deepEqual([field.selection, field.focused], [{ start: 4, end: 4 }, true]);
  escape(m);
  m.view.scrollTo(1000, m.cx); // the last page: block 9 is the first whose row is on it
  await m.key("enter");
  assert.equal(m.view.activeKey, keyAt(m, 9));
  assert.deepEqual(field.selection, { start: 0, end: 0 });
  assert.equal(m.cx.stopped, 2, "Enter is the page's while nothing is open");
});

test("a one-row field crosses at once on mdb-down, keeping the column; the key-up of that press crosses nothing more", async () => {
  const m = await page("- one\n- two\n- three\n\n```\nx\ny\n```\n", { 0: 24, 1: 30, 2: 30, 3: 14 + 26 + 2 * 19.5 });
  await clickAt(m, { x: X + 24 + 15, y: topOf(m, 0) + 10 });
  assert.equal(must(m.tree(), `md-field-${keyAt(m, 0)}`).style.key_context, `${TEXT} rows=one`);
  m.view.field.select(2);
  keyUp(m, "left");
  await flush();
  act(m, "mdb-up");
  assert.equal(m.view.activeKey, keyAt(m, 0), "nothing above the first block");
  act(m, "mdb-down");
  assert.equal(m.view.activeKey, keyAt(m, 1));
  assert.deepEqual(m.view.field.selection, { start: 2, end: 2 });
  assert.equal(must(m.tree(), `md-field-${keyAt(m, 1)}`).style.key_context, `${TEXT} rows=one`);
  act(m, "mdb-down"); // held: the repeats glide on
  act(m, "mdb-down");
  assert.equal(m.view.activeKey, keyAt(m, 3), "into the code block, a field of many rows");
  assert.deepEqual(m.view.field.selection, { start: 4, end: 4 });
  keyUp(m, "down");
  await flush();
  assert.equal(m.view.activeKey, keyAt(m, 3), "the key-up of a press the table took is no edge signal, though the caret is where we put it");
  keyUp(m, "down"); // a press of its own that left the caret where it was: the edge of the last block, a raw one
  await flush();
  assert.ok(m.view.pending && m.view.activeKey === m.view.pending.key, "an empty paragraph opens below it");
});

test("a multi-row field crosses only when the key-up readout equals a valid known caret, and never right after a click moved it", async () => {
  const code = "```\nalpha\nbeta\n```";
  const m = await page(`${code}\n\nNext\n`, { 0: 26 + 2 * 19.5, 1: 38 });
  await clickAt(m, { x: X + 15 + 2 * 7.8, y: topOf(m, 0) + 13 + 19.5 + 5 });
  const key = keyAt(m, 0), field = m.view.field, beta = code.indexOf("beta");
  assert.deepEqual(field.selection, { start: beta + 2, end: beta + 2 });
  assert.equal(m.view.rows, "many");
  field.select(code.length - 1); // Down moved the caret a row, natively
  keyUp(m, "down");
  await flush();
  assert.equal(m.view.activeKey, key, "the caret moved: no edge");
  assert.deepEqual(m.view.known, { start: code.length - 1, end: code.length - 1, valid: true });
  keyUp(m, "down"); // on the last row, Down leaves the caret where it was
  await flush();
  assert.equal(m.view.activeKey, keyAt(m, 1), "the edge: the next block");
  act(m, "mdb-up");
  assert.equal(m.view.activeKey, key);
  assert.deepEqual(field.selection, { start: beta + 4, end: beta + 4 }, "from below: the end of the last inner line");
  const wrap = () => must(m.tree(), `md-field-${key}`), p = { x: X + 20, y: topOf(m, 0) + 20 };
  fire(wrap(), "on_mouse_down:left", press(p), m.cx);
  field.select(1); // the click put the caret on the fence line
  fire(wrap(), "on_mouse_up:left", press(p), m.cx);
  keyUp(m, "up");
  await flush();
  assert.equal(m.view.activeKey, key, "right after the click the caret was not known: no crossing");
  assert.deepEqual(m.view.known, { start: 1, end: 1, valid: true });
});

test("Left at the start and Right at the end cross blocks, rules skipped; a fenced block is entered inside its fences", async () => {
  const code = "```\nfirst\nsecond\n```";
  const m = await page(`Above\n\n${code}\n\n---\n\nBelow\n`, { 0: 24, 1: 14 + 26 + 2 * 19.5, 2: 38, 3: 38 });
  await clickAt(m, { x: X + 500, y: topOf(m, 0) + 10 });
  assert.deepEqual(m.view.field.selection, { start: 5, end: 5 }, "a press past the text lands at its end");
  act(m, "mdb-right-end");
  assert.equal(m.view.activeKey, keyAt(m, 1));
  assert.deepEqual(m.view.field.selection, { start: 4, end: 4 }, "from above: the start of the first inner line");
  act(m, "mdb-left-start");
  assert.equal(m.view.activeKey, keyAt(m, 0));
  assert.deepEqual(m.view.field.selection, { start: 5, end: 5 }, "back: the end of the block before");
  act(m, "mdb-down");
  assert.equal(m.view.activeKey, keyAt(m, 1));
  act(m, "mdb-right-end");
  assert.equal(m.view.activeKey, keyAt(m, 3), "the rule is passed over");
  assert.deepEqual(m.view.field.selection, { start: 0, end: 0 });
  act(m, "mdb-left-start");
  const end = code.indexOf("second") + 6;
  assert.deepEqual([m.view.activeKey, m.view.field.selection], [keyAt(m, 1), { start: end, end }], "from below: the end of the last inner line");
});

test("the key-up of a held key that crossed blocks reads out the caret its repeats moved, and crosses nothing more", async () => {
  const m = await page("Above words\n\nHello world\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 1, y: topOf(m, 1) + 14 + 10 });
  const field = m.view.field;
  assert.deepEqual([m.view.activeKey, field.selection], [keyAt(m, 1), { start: 0, end: 0 }]);
  act(m, "mdb-left-start");
  assert.deepEqual([m.view.activeKey, field.selection], [keyAt(m, 0), { start: 11, end: 11 }]);
  field.select(6); // still held, Left repeats in the block above
  keyUp(m, "left");
  await flush();
  assert.deepEqual([m.view.activeKey, m.view.known], [keyAt(m, 0), { start: 6, end: 6, valid: true }]);
  await m.key("cmd-e");
  assert.deepEqual(m.view.source.selection, { start: 6, end: 6 }, "the source caret goes to the same character");
  reset();
  const g = await page("- one\n- two\n\n```\nx\ny\nz\n```\n\nAfter\n", { 0: 24, 1: 30, 2: 14 + 26 + 3 * 19.5, 3: 38 });
  await clickAt(g, { x: X + 24 + 15, y: topOf(g, 0) + 10 });
  act(g, "mdb-down");
  act(g, "mdb-down"); // a held Down glides into the code block
  assert.deepEqual([g.view.activeKey, g.view.field.selection], [keyAt(g, 2), { start: 4, end: 4 }]);
  g.view.field.select(6); // and its repeats walk on there natively
  keyUp(g, "down");
  await flush();
  assert.deepEqual([g.view.activeKey, g.view.known], [keyAt(g, 2), { start: 6, end: 6, valid: true }]);
  escape(g);
  await g.key("enter");
  assert.deepEqual(g.view.field.selection, { start: 6, end: 6 }, "Escape kept the caret where the repeats left it");
});

test("a fenced block or front matter with nothing between its fences opens on an empty line there, written only once something is typed on it", async () => {
  const doc = "Above\n\n```js\n```\n\nBelow\n";
  const m = await page(doc, { 0: 24, 1: 14 + 26 + 19.5, 2: 38 });
  await clickAt(m, { x: X + 500, y: topOf(m, 0) + 10 });
  act(m, "mdb-right-end");
  const key = keyAt(m, 1), field = m.view.field;
  assert.equal(m.view.activeKey, key);
  assert.deepEqual([field.value(), field.selection], ["```js\n\n```", { start: 6, end: 6 }], "from above: on the empty line, not in the info string");
  escape(m);
  assert.equal(m.view.text, doc, "opened and left, nothing is written");
  await clickAt(m, { x: X + 1, y: topOf(m, 2) + 14 + 10 });
  act(m, "mdb-left-start");
  assert.deepEqual([m.view.activeKey, field.selection], [key, { start: 6, end: 6 }], "from below: the same line");
  field.type("x", m.cx);
  assert.equal(m.view.text, "Above\n\n```js\nx\n```\n\nBelow\n");
  escape(m);
  assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["paragraph", "code", "paragraph"]);
  await m.save();
  assert.equal(state.disk.get(FILE), "Above\n\n```js\nx\n```\n\nBelow\n");
  reset();
  const fm = await page("---\n---\n\nText\n", { 0: 2 * 14 + 2 + 18, 1: 38 });
  await clickAt(fm, { x: X + 20, y: topOf(fm, 0) + 14 + 5 });
  assert.deepEqual([fm.view.activeKey, fm.view.field.value(), fm.view.field.selection], [keyAt(fm, 0), "---\n\n---", { start: 4, end: 4 }], "a click lands on it too");
  fm.view.field.type("a: 1", fm.cx);
  assert.equal(fm.view.text, "---\na: 1\n---\n\nText\n");
});

test("a click below the last block opens an empty paragraph there; the first letter writes it after the last top-level block, and left empty it writes nothing", async () => {
  const m = await page("- a\n  - b\n", { 0: 24, 1: 30 });
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[2] + 40 });
  const key = m.view.activeKey;
  assert.ok(m.view.pending && m.view.pending.key === key);
  assert.deepEqual(m.view.order, [keyAt(m, 0), keyAt(m, 1), key]);
  assert.equal(must(m.tree(), `md-block-${key}`).style.pt, 14);
  assert.equal(m.view.field.focused, true);
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[3] + 40 });
  assert.equal(m.view.activeKey, key, "the same empty paragraph");
  escape(m);
  assert.deepEqual([m.view.order.length, m.view.text], [2, "- a\n  - b\n"]);
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[2] + 40 });
  m.view.field.type("c", m.cx);
  assert.equal(m.view.text, "- a\n  - b\n\nc\n", "a paragraph of its own, not the list's");
  assert.deepEqual(m.view.doc.blocks.map(b => [b.kind, b.depth]), [["item", 0], ["item", 1], ["paragraph", 0]]);
  assert.equal(m.view.activeKey, keyAt(m, 2));
  reset();
  const c = await page("Intro\n\n```\ncode\n```\n", { 0: 24, 1: 14 + 26 + 19.5 });
  await clickAt(c, { x: X + 15 + 4 * 7.8, y: topOf(c, 1) + 14 + 13 + 5 });
  act(c, "mdb-right-end");
  assert.ok(c.view.pending, "Right at the end of a raw last block opens a paragraph below it");
  act(c, "mdb-left-start");
  assert.equal(c.view.activeKey, keyAt(c, 1));
  assert.deepEqual([c.view.pending, c.view.text], [null, "Intro\n\n```\ncode\n```\n"], "it went, writing nothing");
});

test("a note with no blocks opens its empty paragraph on a click anywhere in the column, or on Enter, also after its text was deleted", async () => {
  const m = await mount({ disk: "" });
  viewportOf(m, 900, 600);
  const opened = () => Boolean(m.view.pending) && m.view.activeKey === m.view.pending.key;
  escape(m);
  assert.equal(find(m.tree(), "md-note-empty"), null, "an empty page, no placeholder");
  m.view.field.focused = false;
  await clickAt(m, { x: X + 200, y: 300 });
  assert.ok(opened(), "a click on the empty page is a click below the last block");
  assert.equal(m.view.field.focused, true);
  await clickAt(m, { x: 20, y: 300 });
  assert.equal(m.view.activeKey, null, "a click in the side margin still stops editing");
  await clickAt(m, { x: X + 200, y: 5 });
  assert.ok(opened(), "the column's top padding too");
  escape(m);
  await m.key("enter");
  assert.ok(opened(), "Enter resumes into it");
  m.view.field.type("Hi", m.cx);
  assert.equal(m.view.text, "Hi");
  m.view.field.select(0, 2);
  m.view.field.type("", m.cx);
  escape(m);
  assert.deepEqual([m.view.text, m.view.blocks.length], ["", 0], "typed, deleted and left: nothing remains");
  await clickAt(m, { x: X + 200, y: 300 });
  assert.ok(opened());
  escape(m);
  await m.key("enter");
  assert.ok(opened());
});

test("a marker typed first into a new paragraph stays its text until its space: '# Title' is a heading of exactly those bytes, '#tag' and '-5 degrees' stay paragraphs", async () => {
  const typeKeys = (m, text) => { for (const ch of text) m.view.field.type(ch, m.cx); };
  const m = await mount({ disk: "" });
  const pending = m.view.activeKey, field = m.view.field;
  typeKeys(m, "#");
  assert.deepEqual([m.view.text, m.view.pending?.key, field.value()], ["", pending, "#"], "alone, the marker would make an empty heading: not written yet");
  assert.equal(m.view.data.get(pending).kind, "paragraph", "still drawn as the paragraph being typed");
  typeKeys(m, " ");
  const head = m.view.doc.blocks[0];
  assert.deepEqual([m.view.text, head.kind, head.level, m.view.activeKey], ["# ", "heading", 1, head.key], "its space makes the heading");
  assert.deepEqual([field.value(), field.selection], ["", { start: 0, end: 0 }]);
  typeKeys(m, "Title");
  await m.save();
  assert.equal(state.disk.get(FILE), "# Title", "no space the user did not type");
  for (const [typed, kind, value] of [["#tag", "paragraph", "#tag"], ["-5 degrees", "paragraph", "-5 degrees"], ["## Two", "heading", "Two"], ["1) one", "item", "one"]]) {
    reset();
    const n = await page("Intro\n", { 0: 24 });
    await clickAt(n, { x: X + 50, y: 28 + n.view.sums[1] + 40 });
    assert.ok(n.view.pending, typed);
    typeKeys(n, typed);
    await n.save();
    assert.equal(state.disk.get(FILE), `Intro\n\n${typed}\n`, typed);
    assert.deepEqual([n.view.blockByKey(n.view.activeKey)?.kind, n.view.field.value()], [kind, value], typed);
  }
  reset();
  const left = await mount({ disk: "" });
  typeKeys(left, "-");
  escape(left);
  await left.save();
  assert.deepEqual([left.view.text, state.disk.get(FILE)], ["-", "-"], "a marker left on its own is written as it was typed");
});

test("typing changes only the typed bytes of the block and parses nothing until it is left; a block emptied there goes", async () => {
  const m = await page("One\n\nTwo words\n\nThree\n", { 0: 24, 1: 38, 2: 38 });
  await clickAt(m, { x: X + 10, y: topOf(m, 1) + 14 + 10 });
  const doc = m.view.doc, field = m.view.field;
  field.select(3);
  field.type(" more", m.cx);
  assert.equal(m.view.text, "One\n\nTwo more words\n\nThree\n");
  assert.equal(m.view.doc, doc, "nothing parsed while typing");
  await m.save();
  assert.equal(state.disk.get(FILE), "One\n\nTwo more words\n\nThree\n", "saved 700 ms after the key");
  field.select(0, field.value().length);
  field.type("", m.cx);
  assert.equal(m.view.text, "One\n\n\n\nThree\n");
  escape(m);
  assert.equal(m.view.text, "One\n\nThree\n", "left empty, it goes with its blank line");
  assert.deepEqual(m.view.doc.blocks.map(b => b.content), ["One", "Three"]);
});

test("a fence typed at the start of a paragraph is closed when the block is committed, so it does not swallow what follows", async () => {
  const m = await page("Run it\n\nNext\n\nLast\n", { 0: 24, 1: 38, 2: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  m.view.field.select(0);
  m.view.field.type("```", m.cx);
  assert.equal(m.view.text, "```Run it\n\nNext\n\nLast\n", "typed as it is");
  escape(m);
  assert.equal(m.view.text, "```Run it\n```\n\nNext\n\nLast\n");
  assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["code", "paragraph", "paragraph"]);
  await m.save();
  assert.equal(state.disk.get(FILE), "```Run it\n```\n\nNext\n\nLast\n");
});

test("a diagram opens as its source while it is being edited, and is drawn again once left", async () => {
  const m = await page(DOC, { 0: 35, 1: 32, 2: 134, 3: 38 });
  const key = keyAt(m, 2);
  await clickAt(m, { x: X + 100, y: topOf(m, 2) + 14 + 50 });
  assert.equal(m.view.activeKey, key);
  assert.equal(m.view.field.value(), "```mermaid\ngraph TD\nA-->B\n```");
  assert.deepEqual(m.view.field.selection, { start: 11, end: 11 }, "at the start of its first line");
  assert.equal(find(m.tree(), `md-diagram-${key}`), null);
  assert.equal(must(m.tree(), `md-field-${key}`).style.key_context, `${RAW} rows=many`);
  escape(m);
  assert.ok(find(m.tree(), `md-diagram-${key}`));
});

test("a space after # at the start of a paragraph makes it a heading with the caret at its start; after [] it makes a task", async () => {
  const m = await page("Title\n\nFix the parser\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  const field = m.view.field;
  field.select(0);
  field.type("#", m.cx);
  field.type(" ", m.cx);
  assert.equal(m.view.text, "# Title\n\nFix the parser\n");
  const head = m.view.doc.blocks[0];
  assert.deepEqual([head.kind, head.level, m.view.activeKey], ["heading", 1, head.key]);
  assert.deepEqual([field.value(), field.selection], ["Title", { start: 0, end: 0 }]);
  field.type("My ", m.cx);
  assert.equal(m.view.text, "# My Title\n\nFix the parser\n");
  await clickAt(m, { x: X + 2, y: topOf(m, 1) + 14 + 10 });
  field.select(0);
  field.type("[]", m.cx);
  field.type(" ", m.cx);
  assert.equal(m.view.text, "# My Title\n\n- [ ] Fix the parser\n");
  const task = m.view.doc.blocks[1];
  assert.deepEqual([task.kind, Boolean(task.task), m.view.activeKey], ["item", true, task.key]);
  assert.deepEqual([field.value(), field.selection], ["Fix the parser", { start: 0, end: 0 }]);
});

test("the pointer resting on a plain one-line block arms it with the spare field; a press there opens it with the caret the field placed", async () => {
  const m = await page("# Title\n\nPlain words here\n\nA **bold** one\n\n- [x] done\n", { 0: 35, 1: 32, 2: 38, 3: 38 });
  const on = i => ({ x: X + 60, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 });
  hover(m, on(1));
  assert.equal(m.view.armedKey, null, "not before the page is calibrated");
  calibrate(m);
  hover(m, on(1));
  const key = keyAt(m, 1), [field, spare] = [m.view.field, m.view.spare];
  assert.equal(m.view.armedKey, key);
  assert.equal(spare.value(), "Plain words here");
  assert.equal(all(must(m.tree(), `md-field-${key}`), n => n.kind === "textarea")[0].state, spare);
  assert.equal(must(m.tree(), `md-field-${key}`).style.key_context, undefined, "armed is not open: no block keys");
  hover(m, on(2));
  assert.equal(m.view.armedKey, null, "inline syntax: a press there is placed by the estimate");
  hover(m, on(3));
  assert.equal(m.view.armedKey, null, "a checked task looks different in a field");
  hover(m, on(0));
  assert.equal(m.view.armedKey, keyAt(m, 0), "a heading");
  fire(must(m.tree(), "md-viewport"), "on_hover", false, m.cx);
  assert.equal(m.view.armedKey, null);
  hover(m, on(1));
  const armedLog = spare.log.length, wrap = must(m.tree(), `md-field-${key}`), vp = () => must(m.tree(), "md-viewport");
  fire(wrap, "on_mouse_down:left", press(on(1)), m.cx);
  fire(vp(), "on_mouse_down:left", press(on(1)), m.cx); // the same press, heard by the viewport too
  spare.select(6);
  spare.handlers.focus({}, m.cx);
  assert.equal(m.view.activeKey, key);
  assert.deepEqual([m.view.field, m.view.spare], [spare, field], "the two fields traded places");
  assert.deepEqual(spare.log.slice(armedLog), [], "nothing set: the press placed its caret");
  assert.equal(m.view.known.valid, false);
  fire(wrap, "on_mouse_up:left", press(on(1)), m.cx);
  fire(vp(), "on_mouse_up:left", press(on(1)), m.cx);
  await flush();
  await fire_timers(m.cx, { ms: 30 });
  assert.deepEqual(m.view.known, { start: 6, end: 6, valid: true }, "read out 30 ms after the mouse-up");
  assert.deepEqual(spare.selection, { start: 6, end: 6 });
  assert.equal(must(m.tree(), `md-field-${key}`).style.key_context, `${TEXT} rows=one`);
  spare.type("all ", m.cx);
  assert.equal(m.view.text, "# Title\n\nPlain all words here\n\nA **bold** one\n\n- [x] done\n");
});

test("a drag that starts in a field arms nothing on its way and selects the blocks it reaches; a mouse-up opens an armed block only when its press began there", async () => {
  const m = await page("Plain words\n\nOther words\n\nThird words\n", { 0: 24, 1: 38, 2: 38 });
  calibrate(m);
  const on = i => ({ x: X + 30, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 });
  const vp = () => must(m.tree(), "md-viewport"), [first, second] = [keyAt(m, 0), keyAt(m, 1)];
  hover(m, on(0));
  const armed = m.view.spare;
  fire(must(m.tree(), `md-field-${first}`), "on_mouse_down:left", press(on(0)), m.cx);
  fire(vp(), "on_mouse_down:left", press(on(0)), m.cx);
  armed.handlers.focus({}, m.cx);
  assert.equal(m.view.activeKey, first);
  const log = m.view.spare.log.length;
  hover(m, on(1)); // selecting, the drag runs on over the blocks below
  hover(m, on(2));
  assert.deepEqual([m.view.armedKey, m.view.spare.log.length], [null, log], "nothing armed, nothing set");
  fire(vp(), "on_mouse_up:left", press(on(2), { click_count: 0 }), m.cx);
  await flush();
  assert.deepEqual([m.view.activeKey, [...m.view.selKeys]], [null, [first, second, keyAt(m, 2)]], "the blocks from the one it began in to the one it ended on");
  hover(m, on(1));
  assert.equal(m.view.armedKey, second, "with the button up, resting on a block arms it again");
  fire(must(m.tree(), `md-field-${second}`), "on_mouse_up:left", press(on(1), { click_count: 0 }), m.cx);
  await flush();
  assert.deepEqual([m.view.activeKey, m.view.armedKey], [null, second], "a mouse-up whose press began elsewhere opens nothing");
  fire(must(m.tree(), `md-field-${second}`), "on_mouse_down:left", press(on(1)), m.cx);
  fire(vp(), "on_hover", false, m.cx); // released outside the page: only the pointer leaving tells
  hover(m, on(2));
  await flush();
  assert.deepEqual([m.view.armedKey, m.view.sel], [keyAt(m, 2), null], "a move after that is no drag, and the press cleared the selection");
});

test("an armed field that measures more than 1 px off its block is given up for that block, which keeps its height", async () => {
  const m = await page("Plain words\n\nOther words\n", { 0: 24, 1: 38 });
  calibrate(m);
  const on = i => ({ x: X + 30, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 });
  hover(m, on(0));
  assert.equal(m.view.armedKey, keyAt(m, 0));
  fire(blockAt(m, 0), "on_size_change", { width: 716, height: 25 }, m.cx);
  await flush();
  assert.equal(m.view.armedKey, keyAt(m, 0), "within a pixel it stays armed");
  fire(blockAt(m, 0), "on_size_change", { width: 716, height: 26.5 }, m.cx);
  await flush();
  assert.equal(m.view.armedKey, null);
  assert.equal(m.view.heights.get(keyAt(m, 0)), 24, "the rendered height is the one laid out");
  hover(m, on(1));
  hover(m, on(0));
  assert.equal(m.view.armedKey, null, "not armed again");
  await clickAt(m, on(0));
  assert.equal(m.view.activeKey, keyAt(m, 0), "a click opens it by the estimate");
  assert.equal(m.view.field.selection.start, 5, "the word boundary nearest the press");
});

test("an agent rewriting the armed block: the spare takes their text, and a press there opens it with the caret the press placed", async () => {
  const LONG = "Plain new words here and a good many more words after them";
  const m = await page("Plain words here\n\nOther words\n", { 0: 24, 1: 38 });
  calibrate(m);
  const on = i => ({ x: X + 60, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 });
  hover(m, on(0));
  const key = keyAt(m, 0), spare = m.view.spare;
  assert.equal(m.view.armedKey, key);
  state.disk.set(FILE, `${LONG}\n\nOther words\n`);
  await m.touch([FILE]);
  assert.deepEqual([m.view.armedKey, spare.value()], [key, LONG], "still armed under the resting pointer, with their words");
  fire(blockAt(m, 0), "on_size_change", { width: 716, height: 48 }, m.cx);
  await flush();
  assert.deepEqual([m.view.armedKey, m.view.heights.get(key)], [key, 48], "their text has no rendered height yet: the field's two rows are the block's");
  fire(blockAt(m, 0), "on_size_change", { width: 716, height: 72 }, m.cx);
  await flush();
  assert.deepEqual([m.view.armedKey, m.view.heights.get(key)], [null, 48], "after that, a field off its block is given up again");
  reset();
  const n = await page("Plain words here\n\nOther words\n", { 0: 24, 1: 38 });
  calibrate(n);
  const onN = i => ({ x: X + 60, y: topOf(n, i) + n.view.data.get(keyAt(n, i)).space + 5 });
  hover(n, onN(0));
  const nKey = keyAt(n, 0), nSpare = n.view.spare;
  state.disk.set(FILE, "Plain new words here\n\nOther words\n");
  await n.touch([FILE]);
  const log = nSpare.log.length, wrap = must(n.tree(), `md-field-${nKey}`);
  fire(wrap, "on_mouse_down:left", press(onN(0)), n.cx);
  nSpare.select(10);
  nSpare.handlers.focus({}, n.cx);
  assert.equal(n.view.activeKey, nKey);
  assert.deepEqual([nSpare.log.slice(log), nSpare.selection], [[], { start: 10, end: 10 }], "nothing set: the caret stays where the press put it");
  fire(wrap, "on_mouse_up:left", press(onN(0)), n.cx);
  await flush();
  await fire_timers(n.cx, { ms: 30 });
  assert.deepEqual(n.view.known, { start: 10, end: 10, valid: true });
  nSpare.type("very ", n.cx);
  assert.equal(n.view.text, "Plain new very words here\n\nOther words\n");
  escape(n);
  await n.save();
  hover(n, onN(1));
  hover(n, onN(0));
  assert.equal(n.view.armedKey, nKey);
  state.disk.set(FILE, "Plain **bold** words\n\nOther words\n");
  await n.touch([FILE]);
  assert.equal(n.view.armedKey, null, "inline syntax: it can no longer be armed");
  assert.equal(viewAt(n, 0).markdown, "Plain **bold** words", "drawn as text again, with their words");
});

test("the Markdown state and back: no block stays armed with the text it had; the next move arms the one under the pointer with its new text", async () => {
  const m = await page("Plain words here\n\nOther words\n", { 0: 24, 1: 38 });
  calibrate(m);
  const on = i => ({ x: X + 60, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 });
  hover(m, on(0));
  const key = keyAt(m, 0);
  assert.equal(m.view.armedKey, key);
  await m.key("cmd-e");
  assert.deepEqual([m.view.mode, m.view.armedKey], ["markdown", null]);
  await m.type("Plain new words here\n\nOther words\n");
  m.view.source.select(25);
  await m.key("cmd-e");
  assert.deepEqual([m.view.mode, m.view.activeKey, m.view.armedKey], ["reading", keyAt(m, 1), null], "the source caret was in the other block");
  assert.equal(viewAt(m, 0).markdown, "Plain new words here", "drawn as text, with the new words");
  hover(m, on(0));
  assert.deepEqual([m.view.armedKey, m.view.spare.value()], [key, "Plain new words here"]);
});

test("the page moving under a resting pointer arms the block now under it: a caret reveal while typing, a block above it growing", async () => {
  const m = await tall(200);
  calibrate(m);
  await clickAt(m, { x: X + 20, y: topOf(m, 1) + 14 + 10 });
  const pointer = { x: X + 30, y: 150 };
  hover(m, pointer);
  assert.equal(m.view.armedKey, keyAt(m, 3));
  for (let i = 0; i < 4; i++) act(m, "mdb-shift-enter");
  assert.equal(m.view.offset, 58, "the caret row, four rows down, was kept in view");
  assert.equal(m.view.hit(pointer).block.key, keyAt(m, 5));
  assert.deepEqual([m.view.armedKey, m.view.spare.value()], [keyAt(m, 5), "Paragraph 5"], "the block that came under the pointer");
  await heights(m, { 4: 76 });
  assert.equal(m.view.offset, 58, "the block being edited holds the page");
  assert.equal(m.view.hit(pointer).block.key, keyAt(m, 4));
  assert.deepEqual([m.view.armedKey, m.view.spare.value()], [keyAt(m, 4), "Paragraph 4"], "block 4 grew under the pointer");
});

test("typing on line 25 of a 40-line code block in a 500 px viewport keeps the caret row inside the reveal window", async () => {
  const code = ["```", ...Array.from({ length: 40 }, (_, i) => `line ${i}`), "```"].join("\n");
  const m = await page(`Intro\n\n${code}\n\nAfter\n`, { 0: 24, 1: 14 + 26 + 40 * 19.5, 2: 38 }, 500);
  const line25 = 28 + 24 + 14 + 13 + 25 * 19.5;
  m.view.scrollTo(line25 + 19.5 - 490, m.cx); // line 25 drawn 10 px above the bottom: inside the 72 px the caret keeps clear of
  const offset = m.view.offset;
  await clickAt(m, { x: X + 300, y: line25 - offset + 5 });
  const field = m.view.field, end = code.indexOf("line 25") + 7;
  assert.deepEqual(field.selection, { start: end, end }, "past the line's end: its end");
  assert.equal(m.view.offset, offset + 19.5, "the click moves the page only by the fence row shown above: the line stays under the pointer");
  const inWindow = () => {
    const row = field.value().slice(0, field.selection.start).split("\n").length - 1, y = 28 + 24 + 14 + 13 + row * 19.5;
    return y >= m.view.offset + 24 && y + 19.5 <= m.view.offset + 500 - 72;
  };
  for (const ch of ["x", "\n", "y", "\n", "\n", "z", "\n", "\n"]) {
    field.type(ch, m.cx);
    assert.ok(inWindow(), `after ${JSON.stringify(ch)}: offset ${m.view.offset}`);
  }
  assert.match(m.view.text, /line 25x\ny\n\nz\n\n\nline 26/);
});

test("a selected_range() that throws leaves the caret unknown: Enter splits nothing, and typing goes on", async () => {
  const m = await page("Hello world\n", { 0: 24 });
  await clickAt(m, { x: X + 20, y: topOf(m, 0) + 10 });
  const field = m.view.field;
  field.selected_range = () => { throw new Error("boom"); };
  field.select(5);
  keyUp(m, "right");
  await flush();
  assert.equal(m.view.known.valid, false, "the caret is not known after a read that failed");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Hello world\n", "no split at a guessed caret");
  field.type("!", m.cx);
  assert.equal(m.view.text, "Hello! world\n");
});

test("change events arrive in the live order, after the handler: typing is taken in once, our own edit's change adds nothing, a key-up writes nothing", async () => {
  const m = await page("Hello\n", { 0: 24 });
  await clickAt(m, { x: X + 20, y: topOf(m, 0) + 10 });
  liveFields(true, m.cx);
  try {
    const field = m.view.field;
    field.select(5);
    field.type("!", m.cx);
    assert.equal(m.view.text, "Hello\n", "not yet: the change comes after this handler");
    await flush();
    assert.equal(m.view.text, "Hello!\n");
    act(m, "mdb-shift-enter");
    assert.equal(m.view.text, "Hello!\\\n\n", "written at once, from the field's value");
    await flush();
    assert.equal(m.view.text, "Hello!\\\n\n", "its change, arriving later, adds nothing");
    const log = field.log.length;
    keyUp(m, "left");
    await flush();
    assert.deepEqual([m.view.text, field.log.slice(log)], ["Hello!\\\n\n", []]);
  } finally {
    liveFields(false);
  }
});

test("a set_value the field refuses while opening a block leaves the file read-only, nothing open", async () => {
  const m = await page("Hello\n", { 0: 24 });
  m.view.field.set_value = () => { throw new Error("invalid utf-8"); };
  await clickAt(m, { x: X + 20, y: topOf(m, 0) + 10 });
  assert.equal(m.view.activeKey, null);
  assert.equal(m.status(), "Read-only: unusual characters");
  await clickAt(m, { x: X + 20, y: topOf(m, 0) + 10 });
  assert.equal(m.view.activeKey, null, "a read-only page opens nothing");
});

test("a remote file opens nothing on a click and arms nothing", async () => {
  state.disk.set(FILE, "Plain words\n");
  const m = await mount({ machine: "devbox" });
  viewportOf(m, 900, 600);
  await heights(m, { 0: 24 });
  calibrate(m);
  hover(m, { x: X + 20, y: topOf(m, 0) + 5 });
  await clickAt(m, { x: X + 20, y: topOf(m, 0) + 5 });
  assert.deepEqual([m.view.armedKey, m.view.activeKey], [null, null]);
  await m.key("enter");
  assert.equal(m.view.activeKey, null);
});

const editing =m => [m.view.activeKey, m.view.field.value(), m.view.field.selection];
// The user moves the caret in the field being edited to `at`, and the key-up reads it out.
async function caretTo(m, at) {
  m.view.field.select(at);
  keyUp(m, "right");
  await flush();
}

test("Cmd+Z right after a typed '# ' gives back #Title, the paragraph open with the caret after the #; Cmd+Shift+Z makes the heading again", async () => {
  const m = await page("Title\n\nBody\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  const field = m.view.field;
  field.select(0);
  field.type("#", m.cx);
  field.type(" ", m.cx);
  assert.equal(m.view.doc.blocks[0].kind, "heading");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "#Title\n\nBody\n");
  assert.equal(m.view.doc.blocks[0].kind, "paragraph");
  assert.deepEqual(editing(m), [keyAt(m, 0), "#Title", { start: 1, end: 1 }]);
  assert.equal(field.focused, true);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Title\n\nBody\n", keyAt(m, 0), "Title", { start: 0, end: 0 }]);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Title\n\nBody\n", "nothing more to undo");
  act(m, "mdb-redo");
  act(m, "mdb-redo");
  assert.equal(m.view.text, "# Title\n\nBody\n");
  assert.deepEqual([m.view.doc.blocks[0].kind, ...editing(m)], ["heading", keyAt(m, 0), "Title", { start: 0, end: 0 }]);
  await m.save();
  assert.equal(state.disk.get(FILE), "# Title\n\nBody\n");
});

test("Cmd+Z after typing in two blocks walks back across both, the caret in each; Cmd+Shift+Z walks forward again", async () => {
  const m = await page("Alpha\n\nBeta\n\nGamma\n", { 0: 24, 1: 38, 2: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  m.view.field.select(5);
  m.view.field.type(" one", m.cx);
  await clickAt(m, { x: X + 2, y: topOf(m, 2) + 14 + 10 });
  m.view.field.select(5);
  m.view.field.type(" two", m.cx);
  assert.equal(m.view.text, "Alpha one\n\nBeta\n\nGamma two\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Alpha one\n\nBeta\n\nGamma\n", keyAt(m, 2), "Gamma", { start: 5, end: 5 }]);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Alpha\n\nBeta\n\nGamma\n", keyAt(m, 0), "Alpha", { start: 5, end: 5 }]);
  act(m, "mdb-redo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Alpha one\n\nBeta\n\nGamma\n", keyAt(m, 0), "Alpha one", { start: 9, end: 9 }]);
  act(m, "mdb-redo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Alpha one\n\nBeta\n\nGamma two\n", keyAt(m, 2), "Gamma two", { start: 9, end: 9 }]);
  m.view.field.type("!", m.cx);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Alpha one\n\nBeta\n\nGamma two\n", "a key typed after a redo is its own entry");
});

test("typing in Markdown, Cmd+E, then Cmd+Z in Reading undoes that typing; with no block open the root takes Cmd+Z and Cmd+Shift+Z", async () => {
  const m = await page("One\n\nTwo\n", { 0: 24, 1: 38 });
  await m.key("cmd-e");
  await m.type("One\n\nTwo more\n");
  await m.key("cmd-e");
  assert.equal(m.view.mode, "reading");
  escape(m);
  const stopped = m.cx.stopped;
  await m.key("cmd-z");
  assert.equal(m.cx.stopped, stopped + 1);
  assert.deepEqual([m.view.text, ...editing(m)], ["One\n\nTwo\n", keyAt(m, 1), "Two", { start: 3, end: 3 }]);
  escape(m);
  await m.key("cmd-shift-z");
  assert.equal(m.view.text, "One\n\nTwo more\n");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "One\n\nTwo\n", "and from the field, by the key table");
  await m.save();
  assert.equal(state.disk.get(FILE), "One\n\nTwo\n");
});

test("Cmd+Z in Markdown takes the change back in the source by set_selected_range and replace, never set_value; the caret goes where it was", async () => {
  const doc = Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n\n") + "\n";
  const m = await mount({ disk: doc });
  await m.click("md-markdown");
  const field = m.view.source, at = doc.indexOf("Line 50") + 7;
  await m.type(`${doc.slice(0, at)} and more${doc.slice(at)}`);
  const log = field.log.length;
  act(m, "mdb-undo");
  assert.equal(m.view.text, doc);
  assert.equal(field.value(), doc);
  assert.deepEqual(field.log.slice(log), [["set_selected_range", { start: at, end: at + 9 }], ["replace", ""], ["set_selected_range", { start: at, end: at }], ["replace", ""]]);
  assert.deepEqual(field.selection, { start: at, end: at });
  await flush();
  assert.equal(m.view.text, doc, "its change events are ours");
  act(m, "mdb-redo");
  assert.equal(field.value(), `${doc.slice(0, at)} and more${doc.slice(at)}`);
  assert.ok(!field.log.slice(log).some(([call]) => call === "set_value"));
  assert.deepEqual(field.selection, { start: at + 9, end: at + 9 });
});

test("in the live event order, the changes that Cmd+Z's edit of the source and of a block cause later are recognised as ours", async () => {
  const m = await page("One\n\nTwo\n", { 0: 24, 1: 38 });
  await m.click("md-markdown");
  await m.type("One!\n\nTwo\n");
  liveFields(true, m.cx);
  try {
    act(m, "mdb-undo");
    await flush();
    assert.deepEqual([m.view.text, m.view.source.value(), m.view.history.canRedo], ["One\n\nTwo\n", "One\n\nTwo\n", true]);
    act(m, "mdb-redo");
    await flush();
    assert.deepEqual([m.view.text, m.view.source.value(), m.view.history.canUndo, m.view.history.canRedo], ["One!\n\nTwo\n", "One!\n\nTwo\n", true, false]);
    await m.click("md-markdown");
    await flush();
    const field = m.view.field;
    field.select(4);
    field.type("?", m.cx);
    await flush();
    act(m, "mdb-undo");
    await flush();
    assert.deepEqual([m.view.text, field.value(), m.view.history.canRedo], ["One!\n\nTwo\n", "One!", true]);
  } finally {
    liveFields(false);
  }
});

test("a CRLF file: Cmd+Z in Markdown puts back the CRLF bytes, and the field keeps showing \\n", async () => {
  const disk = "# Plan\r\n\r\nstep\r\n";
  const m = await mount({ disk });
  await m.click("md-markdown");
  await m.type("# Plan\n\nstep\nnext\n");
  assert.equal(m.view.text, "# Plan\r\n\r\nstep\r\nnext\r\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, m.view.source.value()], [disk, "# Plan\n\nstep\n"]);
  await m.save();
  assert.equal(state.disk.get(FILE), disk);
});

test("pasting '- fix parser / - add test' into an empty task gives two bullet items in its place, one Cmd+Z takes it back", async () => {
  const doc = "Intro\n\n- [ ] \n\nEnd\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 38 });
  await clickAt(m, { x: X + 24 + 20, y: topOf(m, 1) + 14 + 10 });
  assert.deepEqual(editing(m).slice(0, 2), [keyAt(m, 1), ""]);
  m.cx.held = "- fix parser\r\n- add test\r\n";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "Intro\n\n- fix parser\n- add test\n\nEnd\n");
  assert.deepEqual(m.view.doc.blocks.map(b => [b.kind, Boolean(b.task)]), [["paragraph", false], ["item", false], ["item", false], ["paragraph", false]]);
  assert.deepEqual(editing(m), [keyAt(m, 2), "add test", { start: 8, end: 8 }], "the caret at the end of what was pasted");
  act(m, "mdb-undo");
  assert.equal(m.view.text, doc);
  await m.save();
  assert.equal(state.disk.get(FILE), doc);
});

test("a paste into the empty paragraph below the last block writes its lines there; into a paragraph emptied by typing, in its place", async () => {
  const m = await page("Intro\n", { 0: 24 });
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[1] + 40 });
  assert.ok(m.view.pending);
  m.cx.held = "- fix parser\n- add test";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "Intro\n\n- fix parser\n- add test\n");
  assert.deepEqual([m.view.pending, ...editing(m)], [null, keyAt(m, 2), "add test", { start: 8, end: 8 }]);
  reset();
  const e = await page("Intro\n\nOld words\n\nEnd\n", { 0: 24, 1: 38, 2: 38 });
  await clickAt(e, { x: X + 2, y: topOf(e, 1) + 14 + 10 });
  e.view.field.select(0, 9);
  e.view.field.type("", e.cx);
  e.cx.held = "## Notes\nfoo";
  act(e, "mdb-paste");
  assert.equal(e.view.text, "Intro\n\n## Notes\nfoo\n\nEnd\n");
  assert.deepEqual(e.view.doc.blocks.map(b => b.kind), ["paragraph", "heading", "paragraph", "paragraph"]);
  assert.deepEqual(editing(e), [keyAt(e, 2), "foo", { start: 3, end: 3 }]);
  act(e, "mdb-undo");
  assert.equal(e.view.text, "Intro\n\n\n\nEnd\n", "the paste was one entry");
  act(e, "mdb-undo");
  assert.equal(e.view.text, "Intro\n\nOld words\n\nEnd\n");
});

test("pasting '## Notes / foo' at the end of a paragraph gives a heading and a paragraph after it", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  await caretTo(m, 12);
  m.cx.held = "## Notes\nfoo\n";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "Hello world.\n\n## Notes\nfoo\n\nEnd\n");
  assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["paragraph", "heading", "paragraph", "paragraph"]);
  assert.deepEqual(editing(m), [keyAt(m, 2), "foo", { start: 3, end: 3 }]);
});

test("pasting three paragraphs and a list into the middle of a paragraph gives those blocks, the text after the caret at the end", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  await caretTo(m, 6);
  m.cx.held = "First para.\n\nSecond para.\n\nThird para.\n\n- one\n- two\n";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "Hello First para.\n\nSecond para.\n\nThird para.\n\n- one\n- twoworld.\n\nEnd\n");
  assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["paragraph", "paragraph", "paragraph", "item", "item", "paragraph"]);
  assert.deepEqual(editing(m), [keyAt(m, 4), "twoworld.", { start: 3, end: 3 }]);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Hello world.\n\nEnd\n");
});

test("a list pasted into a quote stays in it", async () => {
  const m = await page("> Quoted text here\n\nEnd\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 20, y: topOf(m, 0) + 10 });
  await caretTo(m, 16);
  m.cx.held = "- one\n- two";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "> Quoted text here\n>\n> - one\n> - two\n\nEnd\n");
  assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["quote", "paragraph"]);
  assert.equal(m.view.activeKey, keyAt(m, 0));
});

test("pasting an image (no text on the clipboard) does nothing; text on one line, or into a raw block, is typed as it is", async () => {
  const m = await page("Hello\n\n```\ncode\n```\n", { 0: 24, 1: 14 + 26 + 19.5 });
  await clickAt(m, { x: X + 20, y: topOf(m, 0) + 10 });
  const field = m.view.field, log = field.log.length;
  m.cx.held = undefined;
  act(m, "mdb-paste");
  assert.deepEqual([m.view.text, field.log.length, m.view.history.canUndo], ["Hello\n\n```\ncode\n```\n", log, false]);
  await caretTo(m, 5);
  m.cx.held = " there\n";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "Hello there\n\n```\ncode\n```\n", "a line break ending the clipboard's text is left out");
  await clickAt(m, { x: X + 15 + 4 * 7.8, y: topOf(m, 1) + 14 + 13 + 5 });
  assert.equal(m.view.activeKey, keyAt(m, 1));
  await caretTo(m, 9);
  m.cx.held = "more\n";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "Hello there\n\n```\ncode\nmore\n```\n", "a raw block takes the clipboard's text exactly");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Hello there\n\n```\ncode\n```\n", "a paste is an entry of its own");
});

test("after an agent ticks a box elsewhere, Cmd+Z still undoes the user's typing and leaves the tick", async () => {
  const m = await page("Intro\n\n- [ ] task\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  m.view.field.select(5);
  m.view.field.type(" text", m.cx);
  await m.save();
  state.disk.set(FILE, "Intro text\n\n- [x] task\n");
  await m.touch([FILE]);
  assert.equal(m.view.text, "Intro text\n\n- [x] task\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Intro\n\n- [x] task\n", keyAt(m, 0), "Intro", { start: 5, end: 5 }]);
  await m.save();
  assert.deepEqual(calls.writeTextFile.at(-1), { path: FILE, text: "Intro\n\n- [x] task\n", expected: "Intro text\n\n- [x] task\n" });
  act(m, "mdb-redo");
  assert.equal(m.view.text, "Intro text\n\n- [x] task\n");
});

test("an agent's change that overlaps an entry drops that entry and the older ones: Cmd+Z never takes back their text", async () => {
  const m = await page("Intro\n\nBody\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  m.view.field.select(5);
  m.view.field.type(" text", m.cx);
  await m.save();
  state.disk.set(FILE, "Intro tExt\n\nBody\n");
  await m.touch([FILE]);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Intro tExt\n\nBody\n");
  await m.save();
  assert.equal(state.disk.get(FILE), "Intro tExt\n\nBody\n");
  assert.equal(calls.writeTextFile.length, 1, "only the user's own save");
});

test("a dirty buffer and a disk change elsewhere merge: no banner, the field untouched, saved over their text; Cmd+Z undoes only the user's typing", async () => {
  const m = await page("Intro\n\n- [ ] task\n\nEnd\n", { 0: 24, 1: 38, 2: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  const key = keyAt(m, 0), field = m.view.field;
  field.select(5);
  field.type(" typed", m.cx);
  const log = field.log.length;
  state.disk.set(FILE, "Intro\n\n- [x] task\n\nEnd\nAgent line\n");
  await m.touch([FILE]);
  assert.equal(m.view.text, "Intro typed\n\n- [x] task\n\nEnd\nAgent line\n");
  assert.equal(m.banner(), "");
  assert.deepEqual([m.view.conflict, m.view.disk, m.status()], [null, "Intro\n\n- [x] task\n\nEnd\nAgent line\n", "Unsaved"]);
  assert.deepEqual([m.view.activeKey, field.log.slice(log)], [key, []], "the block being edited is not touched");
  field.type("!", m.cx);
  await m.save();
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "Intro typed!\n\n- [x] task\n\nEnd\nAgent line\n", expected: "Intro\n\n- [x] task\n\nEnd\nAgent line\n" }]);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Intro typed\n\n- [x] task\n\nEnd\nAgent line\n", "a change from outside ends the typing run");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Intro\n\n- [x] task\n\nEnd\nAgent line\n");
});

test("a dirty buffer and a disk change to the same line: the Changed on disk banner, the buffer kept, nothing written", async () => {
  const m = await page("Intro\n\nEnd\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  m.view.field.select(5);
  m.view.field.type(" mine", m.cx);
  state.disk.set(FILE, "Intro theirs\n\nEnd\n");
  await m.touch([FILE]);
  assert.match(m.banner(), /Changed on disk/);
  assert.deepEqual([m.view.text, m.view.conflict, m.view.disk], ["Intro mine\n\nEnd\n", "Intro theirs\n\nEnd\n", "Intro\n\nEnd\n"]);
  await m.save();
  assert.deepEqual(calls.writeTextFile, []);
  state.disk.set(FILE, "Intro\n\nEnd\nAgent line\n");
  await m.touch([FILE]);
  assert.equal(m.banner(), "", "their next change keeps apart from mine: merged, and the banner goes");
  assert.equal(m.view.text, "Intro mine\n\nEnd\nAgent line\n");
  await m.save();
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "Intro mine\n\nEnd\nAgent line\n", expected: "Intro\n\nEnd\nAgent line\n" }]);
});

test("a change elsewhere that the watcher sees while our write is out is merged once the write answers: no banner, the refused write is no error, the buffer is saved over theirs", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "alpha\nbeta\n" });
  await m.click("md-markdown");
  await m.type("alpha!\nbeta\n");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  assert.equal(writes.length, 1);
  state.disk.set(FILE, "alpha\nbeta\ngamma\n"); // an agent wrote before our write landed
  await m.touch([FILE]);
  assert.equal(m.banner(), "");
  assert.deepEqual([m.view.conflict, m.view.text, m.view.disk], [null, "alpha!\nbeta\n", "alpha\nbeta\n"], "their text may be built on ours: it waits");
  writes[0].land(); // refused: the file has their text
  await fired;
  await flush();
  assert.deepEqual([m.banner(), m.view.conflict, m.view.saveError, m.status()], ["", null, null, "Unsaved"]);
  assert.deepEqual([m.view.text, m.view.disk], ["alpha!\nbeta\ngamma\n", "alpha\nbeta\ngamma\n"]);
  await m.save();
  assert.deepEqual([writes.length, writes[1].text, writes[1].expected], [2, "alpha!\nbeta\ngamma\n", "alpha\nbeta\ngamma\n"]);
  writes[1].land();
  await flush();
  assert.equal(state.disk.get(FILE), "alpha!\nbeta\ngamma\n");
});

test("a write refused for a change elsewhere in the file merges that change: no banner, and the next write expects their text", async () => {
  const m = await mount({ disk: "alpha\nbeta\n" });
  await m.click("md-markdown");
  await m.type("alpha!\nbeta\n");
  state.disk.set(FILE, "alpha\nbeta\ngamma\n"); // the watcher has not told us yet
  await m.save();
  assert.deepEqual([m.banner(), m.view.conflict, m.view.saveError, m.view.text], ["", null, null, "alpha!\nbeta\ngamma\n"]);
  await m.save();
  assert.deepEqual(calls.writeTextFile, [
    { path: FILE, text: "alpha!\nbeta\n", expected: "alpha\nbeta\n" },
    { path: FILE, text: "alpha!\nbeta\ngamma\n", expected: "alpha\nbeta\ngamma\n" },
  ]);
  assert.equal(state.disk.get(FILE), "alpha!\nbeta\ngamma\n");
});

test("their change on top of our landed write, seen before the write answered, is looked at again after it: merged, no banner", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "alpha\nbeta\n" });
  await m.click("md-markdown");
  await m.type("alpha!\nbeta\n");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  await m.type("alpha!\nbeta!\n");
  state.disk.set(FILE, "alpha!\nbeta\ngamma\n"); // our write landed and an agent wrote over it; our answer is not back yet
  await m.touch([FILE]);
  writes[0].answer();
  await fired;
  await flush();
  assert.deepEqual([m.banner(), m.view.conflict, m.view.text, m.view.disk], ["", null, "alpha!\nbeta!\ngamma\n", "alpha!\nbeta\ngamma\n"]);
  await m.save();
  assert.deepEqual([writes.length, writes[1].text, writes[1].expected], [2, "alpha!\nbeta!\ngamma\n", "alpha!\nbeta\ngamma\n"]);
});

test("their change on top of our landed write, seen before its answer, is not merged against the text that write replaced: no line twice, no banner", async () => {
  for (const ending of ["answer", "close"]) {
    reset();
    const writes = slowWrites();
    const m = await mount({ disk: "alpha\nbeta\n" });
    await m.click("md-markdown");
    await m.type("alpha\nbeta\ngamma\n");
    const fired = fire_timers(m.cx, { ms: 700 });
    await flush();
    state.disk.set(FILE, "ALPHA\nbeta\ngamma\n"); // our write landed, and an agent changed line 1 on top of it
    await m.touch([FILE]);
    assert.deepEqual([m.view.text, m.banner()], ["alpha\nbeta\ngamma\n", ""], `${ending}: it waits for the write's answer`);
    if (ending === "close") {
      const closed = m.view.close(m.cx);
      for (let i = 1; i <= 2; i++) {
        await flush();
        writes[i]?.land();
      }
      await closed;
      assert.equal(state.disk.get(FILE), "ALPHA\nbeta\ngamma\n", "closing writes nothing over their line");
      continue;
    }
    writes[0].answer();
    await fired;
    await flush();
    assert.deepEqual([m.view.text, m.view.disk, m.banner(), m.status()], ["ALPHA\nbeta\ngamma\n", "ALPHA\nbeta\ngamma\n", "", "Saved"]);
    await m.save();
    assert.equal(writes.length, 1, "nothing left to write");
  }
});

test("an agent that read the file before our landed write and wrote over it: their text is the file, no line twice, nothing of ours written over it", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "alpha\nbeta\n" });
  await m.click("md-markdown");
  await m.type("alpha!\nbeta\n");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  state.disk.set(FILE, "alpha\nbeta\ngamma\n"); // ours landed, then their write from the old text replaced it
  await m.touch([FILE]);
  writes[0].answer();
  await fired;
  await flush();
  assert.deepEqual([m.view.text, m.view.disk, m.view.conflict, m.banner()], ["alpha\nbeta\ngamma\n", "alpha\nbeta\ngamma\n", null, ""]);
  await m.save();
  assert.equal(writes.length, 1, "no write over their text");
});

test("a refused write whose file change merges while the user types in Markdown: the typing whose change event is still on its way is kept", async () => {
  const m = await mount({ disk: "alpha\nbeta\n" });
  await m.click("md-markdown");
  await m.type("alpha!\nbeta\n");
  state.disk.set(FILE, "alpha\nbeta\ngamma\n"); // the watcher has not told us yet
  const reads = [];
  state.readTextFile = () => new Promise(done => reads.push(done));
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  assert.equal(reads.length, 1, "the refused write looks at the file");
  liveFields(true, m.cx);
  try {
    m.view.source.select(11);
    m.view.source.type("?", m.cx);
    reads[0]("alpha\nbeta\ngamma\n");
    await fired;
    await flush();
  } finally {
    liveFields(false);
  }
  assert.deepEqual([m.view.text, m.view.source.value(), m.banner()], ["alpha!\nbeta?\ngamma\n", "alpha!\nbeta?\ngamma\n", ""]);
});

test("the buffer typed back to the file's text while a write is out, and an agent appends a line: refused, their line is taken, no banner", async () => {
  const writes = slowWrites();
  const m = await mount({ disk: "alpha\nbeta\n" });
  await m.click("md-markdown");
  await m.type("alpha!\nbeta\n");
  const fired = fire_timers(m.cx, { ms: 700 });
  await flush();
  await m.type("alpha\nbeta\n");
  state.disk.set(FILE, "alpha\nbeta\ngamma\n"); // the watcher has not told us yet
  writes[0].land(); // refused: the file has their text
  await fired;
  await flush();
  assert.deepEqual([m.view.text, m.view.disk, m.view.conflict, m.banner(), m.status()], ["alpha\nbeta\ngamma\n", "alpha\nbeta\ngamma\n", null, "", "Saved"]);
  await m.save();
  assert.equal(writes.length, 1);
});

test("a merged change inside the block being edited: the field takes the merged text with the caret on its text, and typing goes on in it", async () => {
  const m = await page("Line one\nline two\n\nEnd\n", { 0: 48, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  const field = m.view.field;
  field.select(17);
  field.type(" typed", m.cx);
  assert.equal(m.view.text, "Line one\nline two typed\n\nEnd\n");
  state.disk.set(FILE, "Line ONE\nline two\n\nEnd\n");
  await m.touch([FILE]);
  assert.equal(m.banner(), "");
  assert.equal(m.view.text, "Line ONE\nline two typed\n\nEnd\n");
  assert.deepEqual(editing(m), [keyAt(m, 0), "Line ONE line two typed", { start: 23, end: 23 }]);
  field.type("!", m.cx);
  await m.save();
  assert.deepEqual(calls.writeTextFile, [{ path: FILE, text: "Line ONE\nline two typed!\n\nEnd\n", expected: "Line ONE\nline two\n\nEnd\n" }]);
});

test("a merge in Markdown goes into the source as an edit of the field; its caret stays on its text", async () => {
  const m = await mount({ disk: "alpha\nbeta\n" });
  await m.click("md-markdown");
  const field = m.view.source;
  await m.type("alpha!\nbeta\n");
  assert.deepEqual(field.selection, { start: 6, end: 6 });
  const log = field.log.length;
  state.disk.set(FILE, "intro\nalpha\nbeta\n");
  await m.touch([FILE]);
  assert.equal(m.view.text, "intro\nalpha!\nbeta\n");
  assert.equal(m.banner(), "");
  const applied = field.log.slice(log).map(([call]) => call);
  assert.ok(applied.includes("replace") && !applied.includes("set_value"), "an edit of the field, never set_value, which would scroll it to the top");
  assert.deepEqual(field.selection, { start: 12, end: 12 });
  await m.save();
  assert.deepEqual(calls.writeTextFile.at(-1), { path: FILE, text: "intro\nalpha!\nbeta\n", expected: "intro\nalpha\nbeta\n" });
});

test("typing a new paragraph below the last block is one Cmd+Z: the paragraph goes, and the caret goes back to the block above", async () => {
  const m = await page("Intro\n", { 0: 24 });
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[1] + 40 });
  for (const c of "Hello") m.view.field.type(c, m.cx);
  assert.equal(m.view.text, "Intro\n\nHello\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Intro\n", keyAt(m, 0), "Intro", { start: 5, end: 5 }]);
  act(m, "mdb-redo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Intro\n\nHello\n", keyAt(m, 1), "Hello", { start: 5, end: 5 }]);
});

test("Cmd+Z discards an empty paragraph opened below the last block, with the newest entry; with nothing to undo it stays", async () => {
  const m = await page("Intro\n", { 0: 24 });
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[1] + 40 });
  act(m, "mdb-undo");
  assert.ok(m.view.pending, "nothing to undo: the paragraph stays open");
  escape(m);
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  m.view.field.select(5);
  m.view.field.type("!", m.cx);
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[1] + 40 });
  assert.ok(m.view.pending);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.pending, m.view.text, ...editing(m)], [null, "Intro\n", keyAt(m, 0), "Intro", { start: 5, end: 5 }]);
});

test("a fence typed and closed on leaving is one Cmd+Z with the fence it closed", async () => {
  const m = await page("Run it\n\nNext\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  m.view.field.select(0);
  m.view.field.type("```", m.cx);
  escape(m);
  assert.equal(m.view.text, "```Run it\n```\n\nNext\n");
  await m.key("cmd-z");
  assert.equal(m.view.text, "Run it\n\nNext\n");
  assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["paragraph", "paragraph"]);
});

test("ticking a box is an entry of its own, and the box is ticked back by Cmd+Z", async () => {
  const m = await page("Intro\n\n- [ ] task\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 12, y: topOf(m, 1) + 14 + 12 });
  assert.equal(m.view.text, "Intro\n\n- [x] task\n");
  await m.key("cmd-z");
  assert.equal(m.view.text, "Intro\n\n- [ ] task\n");
  await flush();
  await m.save();
  assert.equal(state.disk.get(FILE), "Intro\n\n- [ ] task\n");
});

test("Cmd+Z changes nothing on a page that cannot be written: a remote file, or a typed note that went read-only", async () => {
  state.disk.set(FILE, "Plain words\n");
  const r = await mount({ machine: "devbox" });
  await r.key("cmd-z");
  act(r, "mdb-undo");
  assert.equal(r.view.text, "Plain words\n");
  assert.equal(calls.writeTextFile.length, 0);

  reset();
  const m = await page("Intro\n\nEnd\n", { 0: 24, 1: 38 });
  await clickAt(m, { x: X + 2, y: topOf(m, 0) + 10 });
  const field = m.view.field, setValue = field.set_value.bind(field);
  field.select(5);
  field.type(" text", m.cx);
  await m.save();
  field.set_value = value => { if (/[\ud800-\udbff](?![\udc00-\udfff])/.test(value)) throw new Error("invalid utf-8"); setValue(value); };
  state.disk.set(FILE, "\ud800Intro text\n\nEnd\n");
  await m.touch([FILE]);
  assert.equal(m.status(), "Read-only: unusual characters");
  assert.ok(m.view.history.canUndo, "the user's typing is still in the history");
  act(m, "mdb-undo");
  await m.key("cmd-z");
  await m.save();
  assert.equal(m.view.text, "\ud800Intro text\n\nEnd\n");
  assert.equal(calls.writeTextFile.length, 1, "only the save before it went read-only");
});

async function openBlock(m, i, caret) {
  const d = m.view.data.get(keyAt(m, i)), boxed = ["code", "mermaid", "table", "html", "frontmatter"].includes(d.kind) ? 13 : 0;
  await clickAt(m, { x: X + d.depth * 24 + (d.kind === "item" ? 24 : 0) + boxed + 4, y: topOf(m, i) + d.space + boxed + 5 });
  assert.equal(m.view.activeKey, keyAt(m, i), `block ${i} opened`);
  if (caret !== undefined) await caretTo(m, caret);
}
const pendingOf = m => (m.view.pending && m.view.activeKey === m.view.pending.key ? m.view.data.get(m.view.pending.key) : null);
// What the field reports for forward Delete at its end: a change that leaves the value as it was.
const forwardDeleteAtEnd = m => m.view.field.handlers.change({}, m.cx);
const rootKey = (m, keystroke, more = {}) => fire(must(m.tree(), "md-root"), "on_key_down", { keystroke, key: keystroke, modifiers: { ...NO_MODS }, ...more }, m.cx);
const replaces = (state, from) => state.log.slice(from).filter(([call]) => call === "replace");

test("reading the caret writes nothing to the field and adds nothing to its undo: a key-up, a mouse-up, a crossing, Enter, Cmd+E and back", async () => {
  const m = await page("Hello world\n\nSecond line\n\nEnd\n", { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 0);
  const field = m.view.field, source = m.view.source, from = field.log.length, undos = field.undos.length;
  field.select(5);
  keyUp(m, "right");
  await flush();
  const wrap = must(m.tree(), `md-field-${keyAt(m, 0)}`), p = { x: X + 20, y: topOf(m, 0) + 10 };
  fire(wrap, "on_mouse_down:left", press(p), m.cx);
  field.select(3);
  fire(wrap, "on_mouse_up:left", press(p), m.cx);
  await flush();
  await fire_timers(m.cx, { ms: 30 });
  assert.deepEqual(m.view.known, { start: 3, end: 3, valid: true }, "read 30 ms after the mouse-up");
  assert.deepEqual([field.log.slice(from), field.undos.length], [[], undos], "a key-up and a mouse-up: nothing written, nothing to undo");
  act(m, "mdb-down");
  assert.deepEqual([m.view.activeKey, field.selection], [keyAt(m, 1), { start: 3, end: 3 }], "crossed at the column read");
  field.select(6);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Hello world\n\nSecond\n\nline\n\nEnd\n");
  const crossed = field.log.length;
  await m.key("cmd-e");
  const back = source.log.length;
  await m.key("cmd-e");
  assert.deepEqual([replaces(field, from), field.log.slice(crossed, crossed + 1), source.log.slice(back)], [[], [["set_value", "line"]], []], "no field is written to read its caret, only to open a block");
});

test("Enter splits at a selection the mod was not told of (no event reached it), read without writing to the field", async () => {
  const m = await page("Hello world\n\nNext\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 2);
  const field = m.view.field, from = field.log.length;
  field.select(5);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Hello\n\nworld\n\nNext\n");
  assert.deepEqual(replaces(field, from), []);
});

test("Up in a one-row field crosses at the column of a caret the mod was not told of", async () => {
  const m = await page("Above words\n\nHello world\n", { 0: 24, 1: 38 });
  await openBlock(m, 1, 0);
  m.view.field.select(4);
  act(m, "mdb-up");
  assert.deepEqual([m.view.activeKey, m.view.field.selection], [keyAt(m, 0), { start: 4, end: 4 }]);
});

test("Cmd+E puts the source caret where the field's caret is though the mod was not told of it, and back; the field is read, not written", async () => {
  const m = await page("Above words\n\nHello world\n", { 0: 24, 1: 38 });
  await openBlock(m, 1, 0);
  const field = m.view.field, from = field.log.length;
  field.select(6);
  await m.key("cmd-e");
  const at = m.view.text.indexOf("world");
  assert.deepEqual([m.view.mode, m.view.source.selection], ["markdown", { start: at, end: at }]);
  assert.deepEqual(field.log.slice(from), []);
  m.view.source.select(2);
  await m.key("cmd-e");
  assert.deepEqual([m.view.mode, m.view.activeKey, field.selection], ["reading", keyAt(m, 0), { start: 2, end: 2 }]);
});

test("offsets after an astral character map to the right place in the file: Cmd+E there and back, then Enter", async () => {
  const doc = "Intro 😀\n\nHi 😀 there\n";
  const m = await page(doc, { 0: 24, 1: 38 });
  await openBlock(m, 1, 0);
  const field = m.view.field, from = field.log.length, after = "Hi 😀 ".length, at = doc.indexOf("there");
  assert.equal(after, 6, "the emoji is two UTF-16 units");
  field.select(after);
  await m.key("cmd-e");
  assert.deepEqual(m.view.source.selection, { start: at, end: at });
  await m.key("cmd-e");
  assert.deepEqual([m.view.activeKey, field.selection], [keyAt(m, 1), { start: after, end: after }]);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro 😀\n\nHi 😀\n\nthere\n");
  assert.deepEqual(replaces(field, from), []);
});

test("Enter at the end of an item continues the list; on the empty item it moves out a level, then out of the list; empty blocks write nothing", async () => {
  const m = await page("- a\n  - b\n\nEnd\n", { 0: 24, 1: 30, 2: 38 });
  await openBlock(m, 1, 1);
  act(m, "mdb-enter");
  const p = m.view.pending, d = pendingOf(m);
  assert.ok(d, "an empty item, not written yet, being edited");
  assert.deepEqual(m.view.order, [keyAt(m, 0), keyAt(m, 1), p.key, keyAt(m, 2)], "drawn under b, before End");
  assert.deepEqual([d.kind, d.depth, d.marker, d.space], ["item", 1, "ring", 6]);
  assert.deepEqual([m.view.text, m.view.field.value(), m.view.field.focused], ["- a\n  - b\n\nEnd\n", "", true]);
  m.view.field.type("c", m.cx);
  assert.equal(m.view.text, "- a\n  - b\n  - c\n\nEnd\n", "the list goes on");
  assert.deepEqual(editing(m), [keyAt(m, 2), "c", { start: 1, end: 1 }]);
  act(m, "mdb-enter");
  act(m, "mdb-enter");
  assert.deepEqual([pendingOf(m).kind, pendingOf(m).depth, pendingOf(m).marker], ["item", 0, "dot"], "the empty item moved out a level");
  act(m, "mdb-enter");
  assert.deepEqual([pendingOf(m).kind, pendingOf(m).depth, pendingOf(m).marker], ["paragraph", 0, null], "and out of the list");
  assert.equal(m.view.text, "- a\n  - b\n  - c\n\nEnd\n", "nothing written for them");
  m.view.field.type("d", m.cx);
  assert.equal(m.view.text, "- a\n  - b\n  - c\n\nd\n\nEnd\n");
  assert.deepEqual(m.view.doc.blocks.map(b => [b.kind, b.depth]), [["item", 0], ["item", 1], ["item", 1], ["paragraph", 0], ["paragraph", 0]]);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["- a\n  - b\n  - c\n\nEnd\n", keyAt(m, 2), "c", { start: 1, end: 1 }], "one Cmd+Z takes the paragraph away");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["- a\n  - b\n\nEnd\n", keyAt(m, 1), "b", { start: 1, end: 1 }], "and one the item");
  act(m, "mdb-enter");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.pending, ...editing(m)], [null, keyAt(m, 1), "b", { start: 1, end: 1 }], "Cmd+Z right after Enter goes back to where it was pressed");
  assert.equal(m.view.history.canRedo, true, "and leaves the history as it was");
});

test("Enter at the end of a 'Phase 2' item with two sub-steps puts the new item first among them", async () => {
  const doc = "- [ ] Phase 2\n  - [ ] write tests\n  - [ ] run tests\n- [ ] Phase 3\n";
  const m = await page(doc, { 0: 24, 1: 30, 2: 30, 3: 30 });
  await openBlock(m, 0, 7);
  act(m, "mdb-enter");
  const d = pendingOf(m);
  assert.deepEqual([d.kind, d.depth, d.marker, d.checked], ["item", 1, "task", false]);
  assert.deepEqual(m.view.order, [keyAt(m, 0), m.view.pending.key, keyAt(m, 1), keyAt(m, 2), keyAt(m, 3)]);
  for (const ch of "plan") m.view.field.type(ch, m.cx);
  assert.equal(m.view.text, "- [ ] Phase 2\n  - [ ] plan\n  - [ ] write tests\n  - [ ] run tests\n- [ ] Phase 3\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], [doc, keyAt(m, 0), "Phase 2", { start: 7, end: 7 }], "one Cmd+Z");
});

test("Enter in the middle of a paragraph splits it with exactly one blank line, the caret at the start of the right part", async () => {
  const m = await page("Intro\n\nHello world\n\nEnd\n", { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1, 5);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro\n\nHello\n\nworld\n\nEnd\n");
  assert.deepEqual(editing(m), [keyAt(m, 2), "world", { start: 0, end: 0 }]);
  m.view.field.type("big ", m.cx);
  assert.equal(m.view.text, "Intro\n\nHello\n\nbig world\n\nEnd\n");
  act(m, "mdb-undo");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Intro\n\nHello world\n\nEnd\n", keyAt(m, 1), "Hello world", { start: 5, end: 5 }], "the split is one Cmd+Z");
});

test("Enter at the start of a block opens an empty one above it, of the same kind (a paragraph above a heading)", async () => {
  const m = await page("# Title\n\n- one\n- two\n", { 0: 35, 1: 38, 2: 30 });
  await openBlock(m, 2, 0);
  act(m, "mdb-enter");
  assert.deepEqual([pendingOf(m).kind, pendingOf(m).marker], ["item", "dot"]);
  assert.deepEqual(m.view.order, [keyAt(m, 0), keyAt(m, 1), m.view.pending.key, keyAt(m, 2)]);
  m.view.field.type("x", m.cx);
  assert.equal(m.view.text, "# Title\n\n- one\n- x\n- two\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["# Title\n\n- one\n- two\n", keyAt(m, 2), "two", { start: 0, end: 0 }]);
  await openBlock(m, 0, 0);
  act(m, "mdb-enter");
  assert.deepEqual([pendingOf(m).kind, m.view.order[0]], ["paragraph", m.view.pending.key]);
  m.view.field.type("Above", m.cx);
  assert.equal(m.view.text, "Above\n\n# Title\n\n- one\n- two\n");
});

test("an empty block not written yet, drawn between blocks, leaves the space above each block after it as it was", async () => {
  const m = await page("Intro\n\n- x\n  - y\n", { 0: 24, 1: 38, 2: 30 });
  const spaces = () => m.view.order.map(k => m.view.data.get(k).space);
  assert.deepEqual(spaces(), [0, 14, 6]);
  await openBlock(m, 0, 5);
  act(m, "mdb-enter");
  assert.deepEqual(spaces(), [0, 14, 14, 6], "y is still in x's list");
});

test("Shift+Enter writes a backslash and the line end, which the page draws as a line break; in a heading it is Enter", async () => {
  const m = await page("Hello world\n\n# Head line\n", { 0: 24, 1: 67 });
  await openBlock(m, 0, 5);
  act(m, "mdb-shift-enter");
  assert.equal(m.view.text, "Hello\\\n world\n\n# Head line\n", "in the middle of a paragraph, the rest of it goes below the break");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Hello world\n\n# Head line\n");
  await openBlock(m, 0, 11);
  act(m, "mdb-shift-enter");
  assert.equal(m.view.text, "Hello world\\\n\n\n# Head line\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Hello world\n\n# Head line\n", keyAt(m, 0), "Hello world", { start: 11, end: 11 }], "one Cmd+Z");
  act(m, "mdb-shift-enter");
  m.view.field.type("again", m.cx);
  assert.equal(m.view.text, "Hello world\\\nagain\n\n# Head line\n");
  assert.equal(m.view.field.value(), "Hello world\\\nagain", "the break shows in the field with its backslash");
  escape(m);
  assert.match(viewAt(m, 0).markdown, /^Hello world\\\n\s*again$/, "the TextView gets a hard break");
  await openBlock(m, 1, 4);
  act(m, "mdb-shift-enter");
  assert.equal(m.view.text, "Hello world\\\nagain\n\n# Head\n\nline\n");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Hello world\\\nagain\n\n# Head line\n");
});

test("Backspace at the start: an item becomes a paragraph, a paragraph joins the one above with the caret at the join, below a code block it lands at the end of its last inner line", async () => {
  const doc = "First\n\n- item\n\nSecond\n\n```\ncode\nmore\n```\n\nAfter\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 38, 3: 14 + 26 + 2 * 19.5, 4: 38 });
  await openBlock(m, 1, 0);
  act(m, "mdb-backspace-start");
  assert.equal(m.view.text, "First\n\nitem\n\nSecond\n\n```\ncode\nmore\n```\n\nAfter\n");
  assert.deepEqual([m.view.doc.blocks[1].kind, ...editing(m)], ["paragraph", keyAt(m, 1), "item", { start: 0, end: 0 }]);
  act(m, "mdb-undo");
  assert.equal(m.view.text, doc, "one Cmd+Z");
  await openBlock(m, 2, 0);
  act(m, "mdb-backspace-start");
  assert.equal(m.view.text, "First\n\n- itemSecond\n\n```\ncode\nmore\n```\n\nAfter\n");
  assert.deepEqual(editing(m), [keyAt(m, 1), "itemSecond", { start: 4, end: 4 }], "the caret at the join");
  act(m, "mdb-undo");
  assert.equal(m.view.text, doc, "one Cmd+Z");
  await openBlock(m, 4, 0);
  act(m, "mdb-backspace-start");
  const end = "```\ncode\nmore".length;
  assert.deepEqual([m.view.text, ...editing(m)], [doc, keyAt(m, 3), "```\ncode\nmore\n```", { start: end, end }], "into the code, nothing changed");
});

test("Backspace at the start of a heading or quote makes it a paragraph; of a nested item, moves it out; of an emptied paragraph, removes it", async () => {
  const m = await page("## Head\n\n> said\n\n- a\n  - b\n\nLast\n", { 0: 31, 1: 38, 2: 38, 3: 30, 4: 38 });
  await openBlock(m, 0, 0);
  act(m, "mdb-backspace-start");
  assert.equal(m.view.text, "Head\n\n> said\n\n- a\n  - b\n\nLast\n");
  await openBlock(m, 1, 0);
  act(m, "mdb-backspace-start");
  assert.equal(m.view.text, "Head\n\nsaid\n\n- a\n  - b\n\nLast\n");
  await openBlock(m, 3, 0);
  act(m, "mdb-backspace-start");
  assert.equal(m.view.text, "Head\n\nsaid\n\n- a\n- b\n\nLast\n");
  assert.deepEqual(editing(m), [keyAt(m, 3), "b", { start: 0, end: 0 }]);
  await openBlock(m, 4, 0);
  m.view.field.select(0, 4);
  m.view.field.type("", m.cx);
  act(m, "mdb-backspace-start");
  assert.deepEqual([m.view.text, ...editing(m)], ["Head\n\nsaid\n\n- a\n- b\n", keyAt(m, 3), "b", { start: 1, end: 1 }], "gone, the caret at the end of the block above");
});

test("Delete at the end merges the next paragraph; our own readouts' changes are no Delete; before a rule it removes the rule", async () => {
  const m = await page("First\n\nSecond\n\n***\n\nThird\n", { 0: 24, 1: 38, 2: 38, 3: 38 });
  liveFields(true, m.cx);
  try {
    await openBlock(m, 0, 5);
    await flush();
    assert.equal(m.view.text, "First\n\nSecond\n\n***\n\nThird\n", "the readout's two changes arrived and merged nothing");
    forwardDeleteAtEnd(m);
    await flush();
    assert.equal(m.view.text, "FirstSecond\n\n***\n\nThird\n");
    assert.deepEqual(editing(m), [keyAt(m, 0), "FirstSecond", { start: 5, end: 5 }]);
    await caretTo(m, 11);
    await flush();
    forwardDeleteAtEnd(m);
    await flush();
    assert.equal(m.view.text, "FirstSecond\n\nThird\n", "the rule goes");
    assert.deepEqual(editing(m), [keyAt(m, 0), "FirstSecond", { start: 11, end: 11 }]);
    act(m, "mdb-undo");
    assert.equal(m.view.text, "FirstSecond\n\n***\n\nThird\n");
    act(m, "mdb-undo");
    assert.equal(m.view.text, "First\n\nSecond\n\n***\n\nThird\n", "each a single Cmd+Z");
    await flush();
    await caretTo(m, 2);
    await flush();
    forwardDeleteAtEnd(m);
    await flush();
    assert.equal(m.view.text, "First\n\nSecond\n\n***\n\nThird\n", "not at the end: nothing to join");
    await caretTo(m, 5);
    await flush();
    act(m, "mdb-shift-enter");
    await flush();
    assert.equal(m.view.text, "First\\\n\n\nSecond\n\n***\n\nThird\n", "the change our own line break causes, the caret at the end, is no Delete");
  } finally {
    liveFields(false);
  }
});

test("Down from a one-row block into a code block lands on its first inner line", async () => {
  const m = await page("Intro\n\n```js\nlet a\n```\n", { 0: 24, 1: 14 + 26 + 19.5 });
  await openBlock(m, 0, 2);
  act(m, "mdb-down");
  assert.deepEqual(editing(m), [keyAt(m, 1), "```js\nlet a\n```", { start: 6, end: 6 }]);
});

test("Tab under a sibling nests the item with its children, Shift+Tab takes it back; each is a single Cmd+Z", async () => {
  const doc = "- a\n- b\n  - b1\n- c\n";
  const m = await page(doc, { 0: 24, 1: 30, 2: 30, 3: 30 });
  await openBlock(m, 1, 1);
  act(m, "mdb-tab");
  assert.equal(m.view.text, "- a\n  - b\n    - b1\n- c\n");
  assert.deepEqual([m.view.doc.blocks[1].depth, m.view.doc.blocks[2].depth, ...editing(m)], [1, 2, keyAt(m, 1), "b", { start: 1, end: 1 }]);
  act(m, "mdb-shift-tab");
  assert.deepEqual([m.view.text, ...editing(m)], [doc, keyAt(m, 1), "b", { start: 1, end: 1 }]);
  act(m, "mdb-tab");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], [doc, keyAt(m, 1), "b", { start: 1, end: 1 }]);
  await openBlock(m, 0, 0);
  act(m, "mdb-tab");
  assert.equal(m.view.text, doc, "the first item has no sibling to go under");
});

test("Tab on a paragraph after an item makes it the item's continuation, Shift+Tab moves it out again; a heading takes no Tab", async () => {
  const doc = "- item\n\npara\n\n# Head\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 67 });
  await openBlock(m, 1, 2);
  act(m, "mdb-tab");
  assert.equal(m.view.text, "- item\n\n  para\n\n# Head\n");
  assert.deepEqual([m.view.doc.blocks[1].depth, ...editing(m)], [1, keyAt(m, 1), "para", { start: 2, end: 2 }]);
  act(m, "mdb-shift-tab");
  assert.equal(m.view.text, doc);
  act(m, "mdb-tab");
  act(m, "mdb-undo");
  assert.equal(m.view.text, doc, "one Cmd+Z");
  await openBlock(m, 2, 0);
  act(m, "mdb-tab");
  assert.equal(m.view.text, doc);
});

test("Tab in a table selects the next cell and Shift+Tab the one before; past the last cell nothing; Tab in code types four spaces", async () => {
  const table = "| name | value |\n|------|-------|\n| a    | 12345 |", code = "```\nx\n```";
  const m = await page(`${table}\n\n${code}\n`, { 0: 26 + 60, 1: 14 + 26 + 19.5 });
  await openBlock(m, 0, 2);
  const sel = (word, from = 0) => ({ start: table.indexOf(word, from), end: table.indexOf(word, from) + word.length });
  const a = sel("a", table.lastIndexOf("|------|"));
  act(m, "mdb-tab");
  assert.deepEqual(m.view.field.selection, sel("value"));
  act(m, "mdb-tab");
  assert.deepEqual(m.view.field.selection, a, "the first cell of the next row, past the delimiter row");
  act(m, "mdb-tab");
  assert.deepEqual(m.view.field.selection, sel("12345"));
  act(m, "mdb-tab");
  assert.deepEqual(m.view.field.selection, sel("12345"), "past the last cell: nothing");
  act(m, "mdb-shift-tab");
  assert.deepEqual([m.view.field.selection, m.view.known], [a, { ...a, valid: true }]);
  assert.equal(m.view.text, `${table}\n\n${code}\n`);
  await openBlock(m, 1, 4);
  act(m, "mdb-tab");
  assert.equal(m.view.text, `${table}\n\n\`\`\`\n    x\n\`\`\`\n`);
});

test("```js then Enter gives a closed code block with the caret inside; one Cmd+Z gives the paragraph back", async () => {
  const m = await page("Intro\n\nx\n\nNext\n", { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1);
  m.view.field.select(0, 1);
  m.view.field.type("```js", m.cx);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro\n\n```js\n```\n\nNext\n");
  assert.deepEqual([m.view.doc.blocks.map(b => b.kind), ...editing(m)], [["paragraph", "code", "paragraph"], keyAt(m, 1), "```js\n\n```", { start: 6, end: 6 }]);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Intro\n\nx\n\nNext\n", "one Cmd+Z");
  act(m, "mdb-redo");
  await openBlock(m, 1, 6);
  m.view.field.type("let a", m.cx);
  assert.equal(m.view.text, "Intro\n\n```js\nlet a\n```\n\nNext\n");
  reset();
  const e = await page("Intro\n", { 0: 24 });
  await clickAt(e, { x: X + 50, y: 28 + e.view.sums[1] + 40 });
  for (const ch of "~~~") e.view.field.type(ch, e.cx);
  act(e, "mdb-enter");
  assert.deepEqual([e.view.text, ...editing(e)], ["Intro\n\n~~~\n~~~\n", keyAt(e, 1), "~~~\n\n~~~", { start: 4, end: 4 }], "at the end of the file too");
});

test("Enter on an empty item at the top of a list leaves an empty paragraph in its place; one Cmd+Z brings the item back", async () => {
  const doc = "- a\n- \n- c\n";
  const m = await page(doc, { 0: 24, 1: 30, 2: 30 });
  await openBlock(m, 1);
  assert.equal(m.view.field.value(), "");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "- a\n- c\n");
  assert.deepEqual([pendingOf(m).kind, m.view.order.indexOf(m.view.pending.key)], ["paragraph", 1]);
  m.view.field.type("x", m.cx);
  assert.equal(m.view.text, "- a\n\nx\n\n- c\n");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "- a\n- c\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], [doc, keyAt(m, 1), "", { start: 0, end: 0 }]);
});

test("Enter in a paragraph emptied by typing leaves an empty paragraph in its place, written once something is typed", async () => {
  const m = await page("One\n\nTwo\n\nThree\n", { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1);
  m.view.field.select(0, 3);
  m.view.field.type("", m.cx);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "One\n\nThree\n");
  assert.deepEqual([pendingOf(m).kind, m.view.order.indexOf(m.view.pending.key)], ["paragraph", 1]);
  m.view.field.type("New", m.cx);
  assert.equal(m.view.text, "One\n\nNew\n\nThree\n");
});

test("a list pasted into the empty task that Enter opened arrives as blocks in its place; one Cmd+Z takes it back", async () => {
  const m = await page("- [ ] first\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 5);
  act(m, "mdb-enter");
  m.cx.held = "- fix parser\n- add test\n";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "- [ ] first\n- fix parser\n- add test\n\nEnd\n");
  assert.deepEqual([m.view.pending, ...editing(m)], [null, keyAt(m, 2), "add test", { start: 8, end: 8 }]);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "- [ ] first\n\nEnd\n");
});

test("--- then Enter gives a rule and an empty paragraph below it", async () => {
  const m = await page("Intro\n\nx\n\nNext\n", { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1);
  m.view.field.select(0, 1);
  m.view.field.type("---", m.cx);
  act(m, "mdb-enter");
  assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["paragraph", "hr", "paragraph"]);
  assert.deepEqual([pendingOf(m).kind, m.view.order.indexOf(m.view.pending.key)], ["paragraph", 2]);
  m.view.field.type("after", m.cx);
  assert.equal(m.view.text, "Intro\n\n---\n\nafter\n\nNext\n");
});

test("Option+Up moves an item with its subtree, the caret staying in it; Option+Down moves it back; each is a single Cmd+Z", async () => {
  const doc = "- a\n- b\n  - b1\n- c\n";
  const m = await page(doc, { 0: 24, 1: 30, 2: 30, 3: 30 });
  await openBlock(m, 1, 1);
  act(m, "mdb-move-up");
  assert.equal(m.view.text, "- b\n  - b1\n- a\n- c\n");
  assert.deepEqual(editing(m), [keyAt(m, 0), "b", { start: 1, end: 1 }]);
  act(m, "mdb-move-up");
  assert.equal(m.view.text, "- b\n  - b1\n- a\n- c\n", "nothing above it at its level");
  act(m, "mdb-move-down");
  assert.deepEqual([m.view.text, ...editing(m)], [doc, keyAt(m, 1), "b", { start: 1, end: 1 }]);
  act(m, "mdb-move-up");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], [doc, keyAt(m, 1), "b", { start: 1, end: 1 }]);
});

test("a drag from block 2 to block 4 selects them whole, with 4's sub-items; Cmd+C copies their source, and Backspace removes them in one splice, one Cmd+Z", async () => {
  const doc = "Zero\n\nOne\n\nTwo\n\nThree\n\n- four\n  - sub\n\nFive\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 38, 3: 38, 4: 38, 5: 30, 6: 38 });
  const on = i => ({ x: X + 60, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 }), vp = () => must(m.tree(), "md-viewport");
  const textViewBefore = viewAt(m, 2).id;
  fire(vp(), "on_mouse_down:left", press(on(2)), m.cx);
  hover(m, on(2));
  assert.equal(m.view.sel, null, "inside one block the TextView selects its own text");
  hover(m, on(3));
  hover(m, on(4));
  fire(vp(), "on_mouse_up:left", press(on(4), { click_count: 0 }), m.cx);
  await flush();
  const t = m.tree(), selected = [0, 1, 2, 3, 4, 5, 6].filter(i => blockAt(m, i, t).style.bg === "selection");
  assert.deepEqual(selected, [2, 3, 4, 5], "block 4's sub-item goes with it");
  assert.deepEqual([blockAt(m, 2, t).style.rounded, m.view.activeKey, m.view.handle.focused], [4, null, true]);
  assert.notEqual(viewAt(m, 2, t).id, textViewBefore, "a fresh TextView, without the selection the drag began in it");
  rootKey(m, "cmd-c");
  assert.equal(m.cx.clipboard.at(-1), "Two\n\nThree\n\n- four\n  - sub");
  const writes = calls.writeTextFile.length;
  rootKey(m, "backspace");
  assert.equal(m.view.text, "Zero\n\nOne\n\nFive\n");
  assert.equal(m.view.history.entries.length, 1, "one splice, one entry");
  assert.equal(m.view.sel, null);
  await m.save();
  assert.equal(calls.writeTextFile.length, writes + 1);
  rootKey(m, "cmd-z");
  assert.deepEqual([m.view.text, ...editing(m)], [doc, keyAt(m, 2), "Two", { start: 0, end: 0 }]);
});

test("Shift+click selects from the block being edited; Escape, a click or a typed character clears it; Cmd+X cuts", async () => {
  const doc = "Zero\n\nOne\n\nTwo\n\nThree\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 38, 3: 38 });
  const on = i => ({ x: X + 60, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 }), vp = () => must(m.tree(), "md-viewport");
  const shiftClick = i => {
    fire(vp(), "on_mouse_down:left", press(on(i), { modifiers: { ...NO_MODS, shift: true } }), m.cx);
    fire(vp(), "on_mouse_up:left", press(on(i), { modifiers: { ...NO_MODS, shift: true } }), m.cx);
  };
  await openBlock(m, 1, 1);
  shiftClick(2);
  assert.deepEqual([m.view.sel, m.view.activeKey], [{ from: keyAt(m, 1), to: keyAt(m, 2) }, null]);
  shiftClick(3);
  assert.deepEqual([...m.view.selKeys], [keyAt(m, 1), keyAt(m, 2), keyAt(m, 3)], "a second Shift+click moves the end");
  rootKey(m, "escape");
  assert.equal(m.view.sel, null);
  assert.equal(m.view.stored, null);
  await openBlock(m, 0, 0);
  escape(m);
  shiftClick(1);
  assert.deepEqual(m.view.sel, { from: keyAt(m, 0), to: keyAt(m, 1) }, "after Escape, from the block it left");
  rootKey(m, "x", { key_char: "x" });
  assert.deepEqual([m.view.sel, m.view.text], [null, doc], "a typed character only clears it");
  shiftClick(2);
  await clickAt(m, on(3));
  assert.deepEqual([m.view.sel, m.view.activeKey], [null, keyAt(m, 3)], "a click clears it and acts as usual");
  await openBlock(m, 0, 0);
  shiftClick(1);
  rootKey(m, "cmd-x");
  assert.deepEqual([m.cx.clipboard.at(-1), m.view.text], ["Zero\n\nOne", "Two\n\nThree\n"]);
  rootKey(m, "cmd-z");
  assert.equal(m.view.text, doc);
  await openBlock(m, 2, 0);
  shiftClick(3);
  rootKey(m, "delete");
  assert.equal(m.view.text, "Zero\n\nOne\n", "Delete removes them too");
  rootKey(m, "cmd-z");
  assert.equal(m.view.text, doc);
});

test("a Shift+press in the spare field of an armed block selects blocks; the field's focus is not taken", async () => {
  const m = await page("Zero words\n\nOne words\n\nTwo words\n", { 0: 24, 1: 38, 2: 38 });
  calibrate(m);
  await openBlock(m, 0, 2);
  const on = i => ({ x: X + 30, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 });
  hover(m, on(2));
  assert.equal(m.view.armedKey, keyAt(m, 2));
  const shifted = press(on(2), { modifiers: { ...NO_MODS, shift: true } });
  fire(must(m.tree(), `md-field-${keyAt(m, 2)}`), "on_mouse_down:left", shifted, m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", shifted, m.cx);
  m.view.spare.handlers.focus({}, m.cx);
  await flush();
  assert.deepEqual([m.view.sel, m.view.activeKey, m.view.handle.focused], [{ from: keyAt(m, 0), to: keyAt(m, 2) }, null, true]);
  const shift = { ...NO_MODS, shift: true };
  hover(m, on(1));
  assert.equal(m.view.armedKey, keyAt(m, 1));
  fire(must(m.tree(), "md-root"), "on_modifiers_changed", { modifiers: shift }, m.cx);
  assert.equal(m.view.armedKey, null, "Shift pressed: nothing stays armed");
  fire(must(m.tree(), "md-viewport"), "on_mouse_move", { position: on(1), local_position: on(1), modifiers: shift }, m.cx);
  assert.equal(m.view.armedKey, null, "nor is armed while it is held");
});

test("an empty block not written yet survives an agent's change elsewhere, and is written where it was opened", async () => {
  const m = await page("One\n\nTwo\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 3);
  act(m, "mdb-enter");
  const key = m.view.pending.key;
  state.disk.set(FILE, "One\n\nTwo\n\nTheirs\n");
  await m.touch([FILE]);
  assert.deepEqual([m.view.activeKey, m.view.order.indexOf(key), m.view.text], [key, 1, "One\n\nTwo\n\nTheirs\n"]);
  m.view.field.type("Mine", m.cx);
  assert.equal(m.view.text, "One\n\nMine\n\nTwo\n\nTheirs\n");
});

test("a remote file selects whole blocks for copying, and never removes them", async () => {
  state.disk.set(FILE, "Zero\n\nOne\n\nTwo\n");
  const m = await mount({ machine: "devbox" });
  viewportOf(m, 900, 600);
  await heights(m, { 0: 24, 1: 38, 2: 38 });
  const on = i => ({ x: X + 60, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).space + 5 }), vp = () => must(m.tree(), "md-viewport");
  fire(vp(), "on_mouse_down:left", press(on(0)), m.cx);
  hover(m, on(1));
  fire(vp(), "on_mouse_up:left", press(on(1), { click_count: 0 }), m.cx);
  rootKey(m, "cmd-x");
  rootKey(m, "backspace");
  assert.deepEqual([m.cx.clipboard.at(-1), m.view.text, calls.writeTextFile.length], ["Zero\n\nOne", "Zero\n\nOne\n\nTwo\n", 0]);
});

test("Page Down while editing moves the page by its height less 40 and keeps a caret on screen; Page Up comes back", async () => {
  const m = await tall(200);
  await openBlock(m, 1, 3);
  const caretOnScreen = () => {
    const i = m.view.at.get(m.view.activeKey), y = 28 + m.view.caretTop(i) - m.view.offset;
    return y >= 0 && y + 24 <= 200;
  };
  act(m, "mdb-pagedown");
  assert.equal(m.view.offset, 160);
  assert.equal(m.view.activeKey, keyAt(m, 5), "the block now where the caret was on the screen");
  assert.deepEqual(m.view.field.selection, { start: 0, end: 0 }, "at the start of that row");
  assert.ok(caretOnScreen());
  act(m, "mdb-pagedown");
  assert.deepEqual([m.view.activeKey, m.view.field.selection], [keyAt(m, 9), { start: 0, end: 0 }]);
  assert.ok(caretOnScreen());
  act(m, "mdb-pagedown");
  assert.deepEqual([m.view.activeKey, m.view.field.selection], [keyAt(m, 9), { start: 11, end: 11 }], "a page past the last block: its end");
  assert.ok(caretOnScreen());
  act(m, "mdb-pageup");
  assert.deepEqual([m.view.activeKey, m.view.field.selection], [keyAt(m, 5), { start: 0, end: 0 }]);
  assert.ok(caretOnScreen());
  assert.equal(m.view.text, TEN);
});

test("Cmd+Enter ticks the box of the task being edited; in a code block it leaves for an empty paragraph below", async () => {
  const m = await page("- [ ] task\n\n```\ncode\n```\n\nEnd\n", { 0: 24, 1: 14 + 26 + 19.5, 2: 38 });
  await openBlock(m, 0, 2);
  act(m, "mdb-cmd-enter");
  assert.deepEqual([m.view.text, ...editing(m)], ["- [x] task\n\n```\ncode\n```\n\nEnd\n", keyAt(m, 0), "task", { start: 2, end: 2 }]);
  await openBlock(m, 1, 6);
  act(m, "mdb-cmd-enter");
  assert.deepEqual([pendingOf(m).kind, m.view.order.indexOf(m.view.pending.key)], ["paragraph", 2]);
  m.view.field.type("x", m.cx);
  assert.equal(m.view.text, "- [x] task\n\n```\ncode\n```\n\nx\n\nEnd\n");
});

test("an empty item not written yet: Tab nests it under the item above and Shift+Tab takes that back; typing writes it there", async () => {
  const m = await page("- a\n- b\n\nEnd\n", { 0: 24, 1: 30, 2: 38 });
  await openBlock(m, 1, 1);
  act(m, "mdb-enter");
  act(m, "mdb-tab");
  assert.deepEqual([pendingOf(m).depth, pendingOf(m).marker], [1, "ring"]);
  act(m, "mdb-shift-tab");
  assert.deepEqual([pendingOf(m).depth, m.view.pending.steps], [0, []]);
  act(m, "mdb-tab");
  m.view.field.type("c", m.cx);
  assert.equal(m.view.text, "- a\n- b\n  - c\n\nEnd\n");
  assert.deepEqual(editing(m), [keyAt(m, 2), "c", { start: 1, end: 1 }]);
});

test("an empty block not written yet in the middle of the page goes when left, writing nothing, and the block clicked stays under the pointer", async () => {
  const m = await tall(200);
  await openBlock(m, 4, 11);
  act(m, "mdb-enter");
  const key = m.view.pending.key, drawn = m.view.order.indexOf(keyAt(m, 7));
  assert.equal(drawn, 8, "the empty paragraph is drawn after block 4");
  m.view.scrollTo(200, m.cx);
  const screenY = () => 28 + m.view.sums[m.view.at.get(keyAt(m, 7))] - m.view.offset, before = screenY();
  await clickAt(m, { x: X + 20, y: before + 14 + 10 });
  assert.deepEqual([m.view.activeKey, m.view.pending, m.view.text, m.view.order.includes(key)], [keyAt(m, 7), null, TEN, false]);
  assert.equal(screenY(), before, "the clicked block did not move");
  assert.equal(m.view.offset, 200 - 38);
});

test("Enter in a quote: a new quoted paragraph at the caret; at the end of an empty last paragraph, out of the quote", async () => {
  const m = await page("> said\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 4);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "> said\n>\n> \n\nEnd\n");
  assert.deepEqual(editing(m), [keyAt(m, 0), "said\n\n", { start: 6, end: 6 }]);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "> said\n\nEnd\n");
  assert.deepEqual([pendingOf(m).kind, m.view.order.indexOf(m.view.pending.key)], ["paragraph", 1]);
  m.view.field.type("out", m.cx);
  assert.equal(m.view.text, "> said\n\nout\n\nEnd\n");
  act(m, "mdb-undo");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "> said\n>\n> \n\nEnd\n");
});

test("a page that grows shorter under a resting pointer, pulling the offset back, arms the block now under it", async () => {
  const m = await tall(200);
  calibrate(m);
  m.view.scrollTo(1000, m.cx);
  const pointer = { x: X + 30, y: 10 }, offset = m.view.offset;
  hover(m, pointer);
  assert.equal(m.view.armedKey, keyAt(m, 9));
  state.disk.set(FILE, TEN.replace("\n\nParagraph 8\n\nParagraph 9", ""));
  await m.touch([FILE]);
  assert.ok(m.view.offset < offset, "the offset was pulled back");
  assert.deepEqual([m.view.hit(pointer).block.key, m.view.armedKey, m.view.spare.value()], [keyAt(m, 7), keyAt(m, 7), "Paragraph 7"]);
});

test("leaving a block (Escape, Cmd+E there and back) leaves no change event owed: the next forward Delete at a block's end merges at once", async () => {
  const m = await page("First\n\nSecond\n\nThird\n\nFourth\n", { 0: 24, 1: 38, 2: 38, 3: 38 });
  liveFields(true, m.cx);
  try {
    await openBlock(m, 0, 5);
    await flush();
    m.view.field.type("!", m.cx);
    await flush();
    keyUp(m, "1", { shift: true });
    await flush();
    escape(m);
    await flush();
    await openBlock(m, 1, 6);
    await flush();
    forwardDeleteAtEnd(m);
    await flush();
    assert.equal(m.view.text, "First!\n\nSecondThird\n\nFourth\n", "the first Delete merges");
    keyUp(m, "left", { shift: true });
    await flush();
    await m.key("cmd-e");
    assert.equal(m.view.mode, "markdown");
    await m.key("cmd-e");
    assert.deepEqual([m.view.mode, m.view.activeKey], ["reading", keyAt(m, 1)]);
    await caretTo(m, 11);
    await flush();
    forwardDeleteAtEnd(m);
    await flush();
    assert.equal(m.view.text, "First!\n\nSecondThirdFourth\n", "and after Cmd+E there and back");
  } finally {
    liveFields(false);
  }
});

test("a press on an armed block below an empty block not written yet: that block goes and the pressed line stays under the pointer", async () => {
  const m = await tall(200);
  calibrate(m);
  await openBlock(m, 4, 11);
  act(m, "mdb-enter");
  const pend = m.view.pending.key, key = keyAt(m, 6);
  m.view.scrollTo(140, m.cx);
  const screenY = () => 28 + m.view.sums[m.view.at.get(key)] - m.view.offset, before = screenY();
  const p = { x: X + 20, y: before + 14 + 10 };
  assert.ok(28 + m.view.sums[m.view.at.get(pend)] - m.view.offset > 0 && p.y < 200, "both on the page");
  hover(m, p);
  assert.equal(m.view.armedKey, key);
  fire(must(m.tree(), `md-field-${key}`), "on_mouse_down:left", press(p), m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", press(p), m.cx);
  m.view.spare.handlers.focus({}, m.cx);
  assert.deepEqual([m.view.activeKey, m.view.pending, m.view.order.includes(pend), m.view.text], [key, null, false, TEN]);
  assert.equal(screenY(), before, "the pressed block did not move");
});

test("'# ' typed into an empty item that Tab nested is written where it is drawn, as a heading in that item, not at the end of the note", async () => {
  const m = await page("Intro\n\n- a\n- b\n\nEnd\n", { 0: 24, 1: 38, 2: 30, 3: 38 });
  await openBlock(m, 2, 1);
  act(m, "mdb-enter");
  act(m, "mdb-tab");
  assert.equal(pendingOf(m).depth, 1);
  m.view.field.type("#", m.cx);
  assert.equal(m.view.text, "Intro\n\n- a\n- b\n\nEnd\n", "a marker alone writes nothing yet");
  m.view.field.type(" ", m.cx);
  assert.equal(m.view.text, "Intro\n\n- a\n- b\n  - # \n\nEnd\n");
  const head = m.view.doc.blocks.find(b => b.kind === "heading");
  assert.deepEqual([head.depth, ...editing(m)], [2, head.key, "", { start: 0, end: 0 }]);
  m.view.field.type("Title", m.cx);
  assert.equal(m.view.text, "Intro\n\n- a\n- b\n  - # Title\n\nEnd\n");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Intro\n\n- a\n- b\n\nEnd\n", "one Cmd+Z");
});

test("Backspace at the start of an empty heading, quote or item leaves an empty paragraph in its place, with the caret in it", async () => {
  const typeKeys = (m, text) => { for (const ch of text) m.view.field.type(ch, m.cx); };
  const m = await page("Intro\n\nEnd\n", { 0: 24, 1: 38 });
  for (const marker of ["- ", "# ", "> "]) {
    await clickAt(m, { x: X + 50, y: 28 + m.view.sums[2] + 40 });
    typeKeys(m, marker);
    assert.equal(m.view.text, `Intro\n\nEnd\n\n${marker}\n`, `${marker}: written`);
    act(m, "mdb-backspace-start");
    assert.equal(m.view.text, "Intro\n\nEnd\n", `${marker}: the marker goes`);
    assert.deepEqual([pendingOf(m)?.kind, m.view.order.indexOf(m.view.pending?.key), m.view.field.value(), m.view.field.selection], ["paragraph", 2, "", { start: 0, end: 0 }], `${marker}: an empty paragraph where it was, being edited`);
    escape(m);
  }
  m.view.field.focused = false;
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[2] + 40 });
  typeKeys(m, "# ");
  typeKeys(m, "x");
  act(m, "mdb-backspace-start");
  assert.equal(m.view.text, "Intro\n\nEnd\n\nx\n", "with text, Backspace at its start makes the heading a paragraph");
  reset();
  const h = await page("Intro\n\n## Head\n\nEnd\n", { 0: 24, 1: 60, 2: 32 });
  await openBlock(h, 1);
  h.view.field.select(0, 4);
  h.view.field.type("", h.cx);
  act(h, "mdb-backspace-start");
  assert.equal(h.view.text, "Intro\n\nEnd\n");
  assert.deepEqual([pendingOf(h)?.kind, h.view.order.indexOf(h.view.pending?.key), h.view.field.value()], ["paragraph", 1, ""], "in its place, between the two");
  h.view.field.type("Body", h.cx);
  assert.equal(h.view.text, "Intro\n\nBody\n\nEnd\n");
});

test("Page Down whose row falls on a rule that ends the note puts the caret in the block before it, with the page moved", async () => {
  const doc = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n\n***\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 38, 3: 38, 4: 38, 5: 38, 6: 38 }, 200);
  await openBlock(m, 2, 3);
  assert.equal(m.view.doc.blocks.at(-1).kind, "hr");
  act(m, "mdb-pagedown");
  assert.deepEqual([m.view.offset, m.view.activeKey, m.view.field.selection], [160, keyAt(m, 5), { start: 0, end: 0 }]);
  const y = 28 + m.view.caretTop(m.view.at.get(m.view.activeKey)) - m.view.offset;
  assert.ok(y >= 0 && y + 24 <= 200, "the caret on the page");
});

test("a press that moves less than a click's slop across a block's edge is no drag: the click or the editing goes on, nothing is selected", async () => {
  const m = await page("Plain words\n\nA **bold** one\n\nThird words\n", { 0: 24, 1: 38, 2: 38 });
  calibrate(m);
  const vp = () => must(m.tree(), "md-viewport"), [first, second, third] = [0, 1, 2].map(i => keyAt(m, i));
  const low = i => ({ x: X + 30, y: topOf(m, i + 1) - 2 }), nudged = p => ({ x: p.x, y: p.y + 3 });
  hover(m, low(0));
  assert.equal(m.view.armedKey, first);
  fire(must(m.tree(), `md-field-${first}`), "on_mouse_down:left", press(low(0)), m.cx);
  fire(vp(), "on_mouse_down:left", press(low(0)), m.cx);
  m.view.spare.handlers.focus({}, m.cx);
  hover(m, nudged(low(0)));
  assert.equal(m.view.hit(nudged(low(0))).block.key, second, "the pointer crossed into the next block");
  assert.deepEqual([m.view.activeKey, m.view.sel], [first, null], "still editing, nothing selected");
  fire(must(m.tree(), `md-field-${first}`), "on_mouse_up:left", press(nudged(low(0))), m.cx);
  fire(vp(), "on_mouse_up:left", press(nudged(low(0))), m.cx);
  await flush();
  fire(vp(), "on_mouse_down:left", press(low(1)), m.cx);
  hover(m, nudged(low(1)));
  assert.equal(m.view.sel, null);
  fire(vp(), "on_mouse_up:left", press(nudged(low(1))), m.cx);
  await flush();
  assert.deepEqual([m.view.activeKey, m.view.sel], [third, null], "the press on the page is a click, where the button came up");
  escape(m);
  fire(vp(), "on_mouse_down:left", press(low(1)), m.cx);
  hover(m, { x: low(1).x, y: low(1).y + 12 });
  assert.deepEqual([...m.view.selKeys], [second, third], "further, it is a drag");
});

test("Page Down after a selection the mod was not told of: the page is measured from the caret's row", async () => {
  const code = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const m = await page(`\`\`\`\n${code.join("\n")}\n\`\`\`\n\n${TEN}`, { 0: 26 + 30 * 19.5, ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 38])) }, 200);
  await openBlock(m, 0);
  const lineStart = k => m.view.field.value().split("\n").slice(0, k).join("\n").length + 1;
  await caretTo(m, lineStart(20));
  m.view.field.select(lineStart(21), lineStart(21) + 4);
  act(m, "mdb-pagedown");
  assert.equal(m.view.activeKey, keyAt(m, 0), "a page below row 21 is still in the code block");
  assert.deepEqual(m.view.field.selection, { start: lineStart(29), end: lineStart(29) }, "160 px below the caret's row, not below the block's first row");
});

test("Backspace at the start of a raw block whose text was all deleted: it goes, the caret at the end of the block above; as the first block, an empty paragraph takes its place", async () => {
  const doc = "Above\n\n```\ncode\n```\n\nBelow\n";
  const m = await page(doc, { 0: 24, 1: 14 + 26 + 19.5, 2: 38 });
  await openBlock(m, 1);
  m.view.field.select(0, m.view.field.value().length);
  m.view.field.type("", m.cx);
  act(m, "mdb-backspace-start");
  assert.deepEqual([m.view.text, ...editing(m)], ["Above\n\nBelow\n", keyAt(m, 0), "Above", { start: 5, end: 5 }]);
  act(m, "mdb-undo");
  act(m, "mdb-undo");
  assert.equal(m.view.text, doc);
  reset();
  const first = await page("```\ncode\n```\n\nBelow\n", { 0: 26 + 19.5, 1: 38 });
  await openBlock(first, 0);
  first.view.field.select(0, first.view.field.value().length);
  first.view.field.type("", first.cx);
  act(first, "mdb-backspace-start");
  assert.equal(first.view.text, "Below\n");
  assert.ok(pendingOf(first), "an empty paragraph not written yet, being edited");
  assert.equal(first.view.blocks[0], first.view.pending.block, "where the code block was");
  first.view.field.type("x", first.cx);
  assert.equal(first.view.text, "x\n\nBelow\n");
  reset();
  const fences = await page("```\n```\n\nBelow\n", { 0: 26 + 19.5, 1: 38 });
  await openBlock(fences, 0);
  act(fences, "mdb-backspace-start");
  assert.deepEqual([fences.view.text, Boolean(pendingOf(fences))], ["Below\n", true], "nothing between its fences: the same");
});

// n one-line paragraphs: block 0 is estimated at 24 px, every other block at 38 (14 above its row).
const paragraphs = n => Array.from({ length: n }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n";
const columnKids = (m, t = m.tree()) => must(t, "md-column").kids;
const mountedEntities =(m, t) => columnKids(m, t).flatMap(k => (k.id === "md-above" ? k.kids[0].kids : [k])).filter(k => k.kind === "entity");
const mountedOf = (m, t) => mountedEntities(m, t).map(k => m.view.at.get(k.entity.props.key));
const blockViews = m => m.cx.entities.filter(e => e.view.constructor.name === "Block");
async function measureMounted(m, h) {
  const t = m.tree();
  for (const i of mountedOf(m, t)) if (!m.view.heights.has(keyAt(m, i))) fire(blockAt(m, i, t), "on_size_change", { width: 716, height: h }, m.cx);
  await flush();
}
const firstVisible = m => {
  const s = m.view.sums, top = m.view.offset - 28;
  let i = 0;
  while (s[i + 1] <= top) i++;
  return keyAt(m, i);
};
const screenTop = (m, key) => 28 + m.view.sums[m.view.at.get(key)] - m.view.offset;
// The Column draws each mounted block where the page's tops put it (spacers stand for the blocks between; blocks drawn
// upward fill a box up from the top of the block below), mounts every block within 750 px of the page, and no other
// beyond its margin: 1500 px when the window was made, grown by blocks that measured taller, plus the 750 px it may lag.
function assertWindow(m) {
  const s = m.view.sums, n = m.view.blocks.length, top = m.view.offset - 28, bottom = top + m.view.viewH(), active = m.view.at.get(m.view.activeKey);
  let y = 0;
  const on = new Set();
  for (const k of columnKids(m)) {
    if (k.id === "md-above") {
      const run = k.kids[0];
      assert.deepEqual([run.style.absolute, run.style.left, run.style.right, run.style.bottom], [true, 0, 0, 0], "drawn from the box's bottom up");
      let b = y + k.style.h;
      for (const e of [...run.kids].reverse()) {
        const i = m.view.at.get(e.entity.props.key);
        assert.equal(b, s[i + 1], `block ${i} drawn up to the top of the next`);
        b -= s[i + 1] - s[i];
        on.add(i);
      }
      assert.equal(b, y, "the box is as tall as its blocks");
      y += k.style.h;
      continue;
    }
    if (k.kind !== "entity") { y += k.style.h; continue; }
    const i = m.view.at.get(k.entity.props.key);
    assert.equal(y, s[i], `block ${i} drawn at its top`);
    y += s[i + 1] - s[i];
    on.add(i);
  }
  assert.equal(y, s[n], "the spacers and blocks are as tall as the page");
  for (let i = 0; i < n; i++) {
    if (s[i + 1] > top - 750 && s[i] < bottom + 750) assert.ok(on.has(i), `block ${i} is near the page`);
    if (on.has(i) && i !== active) assert.ok(s[i + 1] > top - 4000 && s[i] < bottom + 4000, `block ${i} is far from the page`);
  }
  return on;
}

test("a note of 2000 blocks mounts the blocks near the page, with spacers for the rest, and makes a block's view when it first comes near; 400 blocks are all mounted", async () => {
  const few = await mount({ disk: paragraphs(400) });
  viewportOf(few, 900, 600);
  assert.equal(mountedOf(few).length, 400);
  assert.equal(columnKids(few).length, 400, "no spacers");
  const m = await mount({ disk: paragraphs(2000) });
  assert.ok(blockViews(m).length < 120, "before the viewport is measured, a window for a page of 1200 px");
  viewportOf(m, 900, 600);
  assert.equal(m.view.blocks.length, 2000);
  let on = assertWindow(m);
  assert.ok(on.has(0) && on.size < 120);
  assert.equal(blockViews(m).length, mountedOf(m).length, "views only for the blocks that were near");
  const made = blockViews(m).length;
  m.cx.notifiedEntities.length = 0;
  await m.key("end");
  assert.ok(m.cx.notifiedEntities.includes(m.view.column), "the Column draws the new window");
  on = assertWindow(m);
  assert.ok(on.has(1999) && !on.has(0));
  assert.equal(blockViews(m).length, made + on.size, "views for the blocks that came near; the others are kept");
  assert.ok(blockViews(m).every(e => !e.released));
  const key = firstVisible(m), y = screenTop(m, key);
  state.disk.set(FILE, `A new first paragraph\nthat runs over\nthree lines\n\n${paragraphs(2000)}`);
  await m.touch([FILE]);
  assert.equal(screenTop(m, key), y, "a block far above grew: the page keeps its place");
  assertWindow(m);
});

test("scrolling up through blocks not measured yet keeps the first visible block's screen y as they are measured", async () => {
  const m = await mount({ disk: paragraphs(2000) });
  viewportOf(m, 900, 600);
  await m.key("end");
  await measureMounted(m, 62);
  const measured = m.view.heights.size;
  for (let step = 0; step < 30; step++) {
    wheel(m, 400);
    assertWindow(m);
    const key = firstVisible(m), y = screenTop(m, key);
    await measureMounted(m, 62);
    assert.equal(screenTop(m, key), y, `step ${step}`);
    assertWindow(m);
  }
  assert.ok(m.view.heights.size > measured + 100, "blocks were measured on the way up, each two rows where one was estimated");
});

test("the block being edited stays mounted however far the page scrolls, and a Cmd+Z that opens a block far away mounts it in the same handler", async () => {
  const m = await mount({ disk: paragraphs(2000) });
  viewportOf(m, 900, 600);
  await openBlock(m, 3, 0);
  m.view.field.type("New ", m.cx);
  wheel(m, -40000);
  let t = m.tree();
  assert.ok(mountedOf(m, t).includes(3), "mounted, away from the others");
  assert.ok(find(t, `md-field-${keyAt(m, 3)}`), "with its field");
  assertWindow(m);
  escape(m);
  assert.ok(!mountedOf(m).includes(3), "once left, it goes with the blocks far away");
  rootKey(m, "cmd-z");
  t = m.tree();
  assert.ok(mountedOf(m, t).includes(3));
  assert.deepEqual(editing(m), [keyAt(m, 3), "Paragraph 3", { start: 0, end: 0 }]);
  const caret = 28 + m.view.caretTop(3) - m.view.offset;
  assert.ok(caret >= 0 && caret < 600, "on the page");
  assertWindow(m);
});

test("Markdown to Reading in a long note mounts the blocks around the source caret at once: deep in it, at its top, on a blank line", async () => {
  const m = await mount({ disk: paragraphs(2000) });
  viewportOf(m, 900, 600);
  await m.click("md-markdown");
  const at = m.view.text.indexOf("Paragraph 1500") + 3;
  m.view.source.set_selected_range({ start: at, end: at });
  await m.click("md-markdown");
  assert.equal(m.view.activeKey, keyAt(m, 1500));
  const on = assertWindow(m);
  assert.ok(on.has(1500) && !on.has(0));
  escape(m);
  await m.click("md-markdown");
  m.view.source.set_selected_range({ start: 3, end: 3 });
  await m.click("md-markdown");
  assert.ok(assertWindow(m).has(0), "and back at the top");
  escape(m);
  await m.click("md-markdown");
  const blank = m.view.text.indexOf("Paragraph 1700") - 1;
  m.view.source.set_selected_range({ start: blank, end: blank });
  await m.click("md-markdown");
  assert.equal(m.view.activeKey, null, "a blank line opens nothing");
  assert.ok(assertWindow(m).has(1700), "the block after it, put a third of the way down");
});

test("with no nested views the root draws the blocks itself, at any length only those within 800 px of the page", async () => {
  state.disk.set(FILE, paragraphs(200));
  const cx = makeCx();
  cx.settle = flush;
  cx.new = () => { throw new Error("no nested views here"); };
  const view = new Editor();
  view.init({ file: FILE }, cx);
  await flush();
  assert.equal(view.inline, true);
  fire(must(view.render(cx), "md-viewport"), "on_size_change", { width: 900, height: 600 }, cx);
  const drawn = () => all(must(view.render(cx), "md-column"), n => n.id?.startsWith("md-block-")).map(n => view.at.get(n.id.slice(9)));
  let on = drawn();
  assert.ok(on.includes(0) && on.length < 60 && !on.includes(70), `${on.length} blocks`);
  const before = cx.notified;
  fire(must(view.render(cx), "md-viewport"), "on_scroll_wheel", { delta: { x: 0, y: -3000 }, touch_phase: "moved" }, cx);
  assert.ok(cx.notified > before);
  on = drawn();
  assert.ok(!on.includes(0) && on.includes(80), "the window moved with the page");
  const s = view.sums, top = view.offset - 28, gaps = all(must(view.render(cx), "md-column"), n => n.id?.startsWith("md-gap-")).map(n => n.style.h);
  assert.deepEqual(gaps, [s[Math.min(...on)], s[200] - s[Math.max(...on) + 1]]);
  assert.ok(s[Math.min(...on)] <= top - 400 && s[Math.max(...on) + 1] >= top + 600 + 400);
});

test("a block not measured yet is estimated at the rows its lines wrap to in its column, worked out once for what it draws", async () => {
  const long = "word ".repeat(60).trim(); // 299 characters at 7.05 px: 101 to a 716 px row, 98 beside a marker
  const m = await mount({ disk: `Short\n\n${long}\n\n- ${long}\n\n| a |\n|---|\n| ${long} |\n` });
  viewportOf(m, 900, 600);
  const h = i => m.view.sums[i + 1] - m.view.sums[i];
  assert.deepEqual([0, 1, 2, 3].map(h), [24, 14 + 3 * 24, 14 + 4 * 24, 14 + 3 * 19.5 + 26], "a table's source lines count as one row each");
  let worked = 0;
  const real = m.view.estimateOf.bind(m.view);
  m.view.estimateOf = (...args) => { worked++; return real(...args); };
  m.view.layout(null);
  m.view.rebuild(m.cx, null);
  assert.equal(worked, 0, "the same drawing, the same estimates");
  fire(must(m.tree(), "md-root"), "on_size_change", { width: 600, height: 700 }, m.cx);
  assert.equal(worked, 4, "a narrower column: once each");
  assert.equal(h(1), 14 + 4 * 24, "536 px: 76 characters a row");
});

test("an offset the Column was not told about is taken to it right after the next draw, which notifies nothing itself", async () => {
  const m = await mount({ disk: paragraphs(2000) });
  viewportOf(m, 900, 600);
  m.view.offset = 40000;
  m.cx.notifiedEntities.length = 0;
  m.tree();
  m.tree();
  assert.deepEqual(m.cx.notifiedEntities, []);
  assert.equal(m.cx.timers.filter(t => t.ms === 0 && !t.ran).length, 1, "one timer for both draws");
  await fire_timers(m.cx, { ms: 0 });
  assert.deepEqual(m.cx.notifiedEntities, [m.view.column]);
  assertWindow(m);
});

test("a note over 200 KB is parsed in slices of 20 ms with Loading… until it is done, and opens as one parse would", async () => {
  const big = bigDocument(), realNow = Date.now;
  let clock = 0;
  Date.now = () => (clock += 5);
  try {
    const m = await mount({ disk: big });
    assert.equal(m.view.loaded, false);
    assert.match(textOf(m.tree()), /Loading…/);
    let slices = 0;
    while (!m.view.loaded && slices < 5000) {
      await fire_timers(m.cx, { ms: 0 });
      if (++slices === 50) {
        state.disk.set(FILE, `${big}An agent's last line.\n`);
        await m.touch([FILE]);
      }
    }
    assert.ok(m.view.loaded && slices > 100, `${slices} slices`);
    await flush();
    assert.equal(m.view.text, `${big}An agent's last line.\n`, "the change seen while loading is looked at once loaded");
    assert.deepEqual(m.view.doc.blocks.map(b => [b.kind, b.start, b.end]), parse(m.view.text).blocks.map(b => [b.kind, b.start, b.end]));
    assert.ok(find(m.tree(), "md-page"));
    assert.equal(calls.writeTextFile.length, 0);
  } finally { Date.now = realNow; }
  const small = await mount({ disk: paragraphs(10) });
  assert.equal(small.view.loaded, true, "a short note in one parse");
});

test("a theme switch draws every block again, mounted or not, and measures the samples again in it; diagrams keep their pictures and are not asked for again", async () => {
  const version = renderer();
  const m = await mount({ disk: `${DOC}\n${paragraphs(500)}` });
  viewportOf(m, 900, 600);
  await drawn(m);
  calibrate(m);
  const key = keyAt(m, 2), source = "graph TD\nA-->B", first = imageOf(m.tree(), `md-diagram-${key}`).path;
  assert.ok(blockViews(m).length < m.view.blocks.length);
  await m.key("end");
  assert.ok(!mountedOf(m).includes(2), "the diagram is far above the page");
  const views = blockViews(m), runs = calls.exec.length;
  m.cx.notifiedEntities.length = 0;
  state.theme = { ...theme(), foreground: "light", surface: "dark" };
  m.tree();
  assert.deepEqual(m.cx.notifiedEntities, [], "the draw that sees it notifies nothing");
  await fire_timers(m.cx, { ms: 0 });
  for (const e of views) assert.ok(m.cx.notifiedEntities.includes(e), "every block, mounted or not");
  assert.equal(m.view.calibrating, true);
  let t = m.tree();
  assert.equal(find(t, "md-cal"), null);
  assert.ok(find(t, "md-cal1"), "the samples again, as elements of their own");
  const last = m.view.blocks.length - 1;
  assert.equal(all(blockAt(m, last, t), n => n.style.text_color)[0].style.text_color, "light");
  await m.key("home");
  t = m.tree();
  const kept = imageOf(t, `md-diagram-${key}`);
  assert.deepEqual([kept.path, kept.style.opacity], [first, undefined], "the same image, not dimmed: its key does not follow the theme");
  assert.equal(all(find(t, `md-diagram-${key}`), n => n.style.bg === "dark").length, 0);
  await fire_timers(m.cx, { ms: 400 });
  const now = imageOf(m.tree(), `md-diagram-${key}`);
  assert.deepEqual([now.path, now.style.opacity], [`data/herdr-inline-markdown/diagrams/${keyOf(source, version)}.png`, undefined]);
  assert.equal(now.path, first);
  assert.equal(calls.exec.length, runs, "the renderer is not run again");
  t = m.tree();
  for (const [name, st] of Object.entries(STYLES)) {
    if (!find(t, `md-cal1-${name}-tv1`)) continue;
    const row = name === "p" ? 25 : st.size * st.lh;
    for (const [part, h] of [["tv1", row], ["tv3", 3 * row], ["f1", row], ["f3", 3 * row]]) fire(must(t, `md-cal1-${name}-${part}`), "on_size_change", { width: 600, height: h }, m.cx);
    fire(must(t, `md-cal1-${name}-adv`), "on_size_change", { width: 300, height: row }, m.cx);
  }
  assert.equal(m.view.calibrating, false);
  assert.equal(m.view.data.get(keyAt(m, 1)).row, 25, "the page takes the new measurements");
});

test("a font or zoom change runs the same refresh; samples that never report give up and keep the measurements there were", async () => {
  const m = await mount({ disk: "Text\n\n```\ncode\n```\n" });
  viewportOf(m, 900, 600);
  calibrate(m);
  const cal = m.view.cal, views = blockViews(m);
  m.cx.notifiedEntities.length = 0;
  state.settings = { ...state.settings, font_family: "Other Mono" };
  m.tree();
  await fire_timers(m.cx, { ms: 0 });
  assert.ok(views.every(e => m.cx.notifiedEntities.includes(e)));
  assert.equal(all(blockAt(m, 1), n => n.style.font_family === "Other Mono").length > 0, true, "the code in the new font");
  assert.equal(m.view.calibrating, true);
  await fire_timers(m.cx, { ms: 2000 });
  assert.deepEqual([m.view.calibrating, m.view.cal], [false, cal]);
  m.cx.notifiedEntities.length = 0;
  state.settings = { ...state.settings, zoom: 1.25 };
  m.tree();
  await fire_timers(m.cx, { ms: 0 });
  assert.ok(views.every(e => m.cx.notifiedEntities.includes(e)));
  assert.ok(find(m.tree(), "md-cal2"));
  m.cx.notifiedEntities.length = 0;
  m.tree();
  await fire_timers(m.cx, { ms: 0 });
  assert.deepEqual(m.cx.notifiedEntities, [], "nothing changed since: nothing again");
});

// The samples of calibration run `gen` report the default type's sizes, the paragraph's rows `row` px tall.
function calibrateRun(m, gen, row) {
  const t = m.tree(), base = gen ? `md-cal${gen}` : "md-cal";
  for (const [name, st] of Object.entries(STYLES)) {
    if (!find(t, `${base}-${name}-tv1`)) continue;
    const r = name === "p" ? row : st.size * st.lh;
    for (const [part, h] of [["tv1", r], ["tv3", 3 * r], ["f1", r], ["f3", 3 * r]]) fire(must(t, `${base}-${name}-${part}`), "on_size_change", { width: 600, height: h }, m.cx);
    fire(must(t, `${base}-${name}-adv`), "on_size_change", { width: 300, height: r }, m.cx);
  }
}

test("a theme change while the source shows measures the samples once Reading shows, however long after; so does a note that opened as its source", async () => {
  const m = await mount({ disk: "Text\n\nMore\n" });
  viewportOf(m, 900, 600);
  calibrate(m);
  await m.click("md-markdown");
  state.theme = { ...theme(), foreground: "light" };
  m.tree();
  await fire_timers(m.cx, { ms: 0 });
  await fire_timers(m.cx, { ms: 2000 });
  assert.equal(m.view.calibrating, true, "its samples were never drawn: it has not given up");
  await m.click("md-markdown");
  assert.ok(find(m.tree(), "md-cal1"), "Reading draws them");
  calibrateRun(m, 1, 25);
  assert.deepEqual([m.view.calibrating, m.view.data.get(keyAt(m, 0)).row], [false, 25]);
  reset();
  state.shared["herdr-inline-markdown.modes"] = { [fileKey(null, FILE)]: "markdown" };
  const src = await mount({ disk: "Text\n" });
  src.tree();
  state.theme = { ...theme(), foreground: "dark" };
  src.tree();
  await fire_timers(src.cx, { ms: 0 });
  await fire_timers(src.cx, { ms: 2000 });
  await src.key("cmd-e");
  viewportOf(src, 900, 600);
  calibrateRun(src, 1, 25);
  assert.deepEqual([src.view.calibrating, src.view.cal.p?.row], [false, 25], "measured on its first Reading");
});

test("Backspace at the start of an emptied raw block with only rules above it: the block goes and an empty paragraph takes its place; with a block above the rules, the caret goes there", async () => {
  for (const [doc, emptied] of [["***\n\n```\ncode\n```\n", true], ["***\n\n```\n```\n", false]]) {
    reset();
    const m = await page(doc, { 0: 24, 1: 14 + 26 + 19.5 });
    await openBlock(m, 1);
    if (emptied) {
      m.view.field.select(0, m.view.field.value().length);
      m.view.field.type("", m.cx);
    }
    act(m, "mdb-backspace-start");
    assert.deepEqual([m.view.text, Boolean(pendingOf(m)), m.view.blocks.at(-1) === m.view.pending?.block], ["***\n", true, true], doc);
    m.view.field.type("x", m.cx);
    assert.equal(m.view.text, "***\n\nx\n", doc);
  }
  for (const emptied of [true, false]) {
    reset();
    const m = await page(`Para\n\n***\n\n\`\`\`\n${emptied ? "code\n" : ""}\`\`\`\n`, { 0: 24, 1: 38, 2: 14 + 26 + 19.5 });
    await openBlock(m, 2);
    if (emptied) {
      m.view.field.select(0, m.view.field.value().length);
      m.view.field.type("", m.cx);
    }
    act(m, "mdb-backspace-start");
    assert.deepEqual([m.view.text, ...editing(m)], ["Para\n\n***\n", keyAt(m, 0), "Para", { start: 4, end: 4 }], `emptied: ${emptied}`);
  }
});

test("a long note that opens as its source is parsed in the background; Cmd+E before that is done shows Loading… until it is, and a second Cmd+E goes back", async () => {
  const big = bigDocument(), realNow = Date.now;
  let clock = 0;
  Date.now = () => (clock += 5);
  try {
    state.shared["herdr-inline-markdown.modes"] = { [fileKey(null, FILE)]: "markdown" };
    const m = await mount({ disk: big });
    assert.equal(m.view.mode, "markdown");
    assert.ok(find(m.tree(), "md-source"), "the source shows at once");
    assert.equal(m.view.doc, null, "its page is still being parsed");
    await fire_timers(m.cx, { ms: 0 });
    await m.key("cmd-e");
    assert.deepEqual([m.view.mode, find(m.tree(), "md-source")], ["markdown", null]);
    assert.match(textOf(m.tree()), /Loading…/);
    await m.key("cmd-e");
    assert.ok(find(m.tree(), "md-source"), "back to the source");
    await m.key("cmd-e");
    let slices = 0;
    while (m.view.mode !== "reading" && slices < 5000) {
      await fire_timers(m.cx, { ms: 0 });
      slices++;
    }
    assert.ok(m.view.mode === "reading" && slices > 50, `${slices} slices`);
    assert.ok(find(m.tree(), "md-page"));
    assert.deepEqual(m.view.doc.blocks.map(b => [b.kind, b.start, b.end]), parse(big).blocks.map(b => [b.kind, b.start, b.end]));
  } finally { Date.now = realNow; }
});

test("while Loading… hides the source, md-root takes the keyboard from it, so that Cmd+E and Cmd+S reach md-root; the focus command gives it md-root too", async () => {
  const big = bigDocument(), realNow = Date.now;
  let clock = 0;
  Date.now = () => (clock += 5);
  try {
    state.shared["herdr-inline-markdown.modes"] = { [fileKey(null, FILE)]: "markdown" };
    const m = await mount({ disk: big });
    await fire_timers(m.cx, { ms: 0 });
    m.view.handle.focused = false;
    await m.key("cmd-e");
    assert.match(textOf(m.tree()), /Loading…/);
    assert.equal(m.view.handle.focused, true, "the root, which draws Loading…");
    m.view.handle.focused = false;
    await m.send("focus");
    assert.equal(m.view.handle.focused, true);
    m.view.source.focused = false;
    await m.key("cmd-e");
    assert.deepEqual([Boolean(find(m.tree(), "md-source")), m.view.source.focused], [true, true], "back to the source, which takes the keyboard");
  } finally { Date.now = realNow; }
});

test("a parse in the background that ends after Reading made a page of its own leaves that page alone: the text got short meanwhile", async () => {
  const big = bigDocument(), realNow = Date.now;
  let clock = 0;
  Date.now = () => (clock += 5);
  try {
    state.shared["herdr-inline-markdown.modes"] = { [fileKey(null, FILE)]: "markdown" };
    const m = await mount({ disk: big });
    await fire_timers(m.cx, { ms: 0 });
    assert.equal(m.view.parsing, true);
    await m.type("# Short\n\nNow a short note.\n");
    await m.key("cmd-e");
    assert.equal(m.view.mode, "reading", "a short text opens its page at once");
    viewportOf(m, 900, 600);
    await heights(m, { 0: 30, 1: 38 });
    const doc = m.view.doc;
    for (let slices = 0; m.view.parsing && slices < 5000; slices++) await fire_timers(m.cx, { ms: 0 });
    assert.equal(m.view.parsing, false);
    assert.deepEqual([m.view.doc === doc, m.view.doc.text === m.view.text], [true, true]);
    await openBlock(m, 1, 0);
    act(m, "mdb-move-up");
    assert.equal(m.view.text, "Now a short note.\n# Short\n\n", "the block moves within the text there is");
  } finally { Date.now = realNow; }
});

// Where the Column draws each mounted block, by key, in a frame where block k lays out h(k) px tall: the spacers take
// their own heights, and the box of blocks drawn upward fills from its bottom.
function drawnTops(m, h) {
  const tops = new Map();
  let y = 0;
  for (const k of columnKids(m)) {
    if (k.id === "md-above") {
      let b = y + k.style.h;
      for (const e of [...k.kids[0].kids].reverse()) { b -= h(e.entity.props.key); tops.set(e.entity.props.key, b); }
      y += k.style.h;
    } else if (k.kind === "entity") {
      tops.set(k.entity.props.key, y);
      y += h(k.entity.props.key);
    } else y += k.style.h;
  }
  return tops;
}
const boxed = m => columnKids(m).find(k => k.id === "md-above")?.kids[0].kids.map(e => e.entity.props.key) ?? [];
// What a frame draws before the size task has the heights: blocks with heights at them, the others at the 62 px
// they report once drawn, and block `key` `grow` px taller.
const frame = (m, key = null, grow = 0) => drawnTops(m, k => (m.view.heights.get(k) ?? 62) + (k === key ? grow : 0));

test("the blocks a window mounts above the page are drawn upward from the first visible block: their heights, not measured yet, move nothing on the page", async () => {
  const m = await mount({ disk: paragraphs(2000) });
  viewportOf(m, 900, 600);
  await m.key("end");
  await measureMounted(m, 62);
  let moves = 0;
  for (let step = 0; step < 30; step++) {
    const was = m.view.win;
    wheel(m, 400);
    if (m.view.win.from === was.from) continue;
    moves++;
    const key = firstVisible(m);
    assert.ok(mountedOf(m).some(i => i < m.view.at.get(key) && !m.view.heights.has(keyAt(m, i))), "blocks above it never drawn before");
    assert.equal(frame(m).get(key), m.view.sums[m.view.at.get(key)], `step ${step}: drawn where the page has it, before they are measured`);
    await measureMounted(m, 62);
    assert.equal(frame(m).get(key), m.view.sums[m.view.at.get(key)], `step ${step}: and after`);
    assertWindow(m);
  }
  assert.ok(moves >= 3, `${moves} windows`);
});

test("a block that has its height keeps its top as it grows before the size task, and so does everything above it: only blocks drawn for the first time are drawn upward", async () => {
  const m = await mount({ disk: paragraphs(2000) });
  viewportOf(m, 900, 600);
  await m.key("end");
  assert.ok(boxed(m).length > 10 && boxed(m).every(k => !m.view.heights.has(k)), "blocks drawn for the first time, upward");
  await measureMounted(m, 62);
  assert.deepEqual(boxed(m), [], "measured, they are drawn from their tops");
  const win = m.view.win;
  wheel(m, 300);
  assert.equal(m.view.win.from, win.from, "the window holds");
  const key = firstVisible(m), i = m.view.at.get(key);
  assert.ok(i + 1 < m.view.win.held, "the first visible blocks are above the one the window held");
  const still = (before, after, upTo, what) => {
    for (const [k, y] of before) if (m.view.at.get(k) <= upTo) assert.equal(after.get(k), y, `${what}: block ${m.view.at.get(k)}`);
  };
  still(frame(m), frame(m, key, 24), i, "a row wraps on the first visible block");
  await openBlock(m, i + 1);
  assert.ok(!boxed(m).includes(keyAt(m, i + 1)));
  m.view.field.type(" and more", m.cx);
  still(frame(m), frame(m, keyAt(m, i + 1), 24), i + 1, "typing wraps the block being edited");
  escape(m);
  let was;
  do { was = m.view.win; wheel(m, 300); } while (m.view.win.from === was.from);
  assert.ok(boxed(m).length > 0 && boxed(m).every(k => !m.view.heights.has(k)), "a new window: only the blocks never drawn before are in the box");
  const top = firstVisible(m);
  assert.ok(m.view.heights.has(top) && !boxed(m).includes(top), "the first visible block, measured, is drawn from its top");
  still(frame(m), frame(m, top, 24), m.view.at.get(top), "it grows before the size task");
  await measureMounted(m, 62);
  assert.deepEqual(boxed(m), []);
  assertWindow(m);
});

test("a flick that brings blocks drawn upward onto the page before they are measured: they stay where they were drawn as they are measured", async () => {
  const m = await mount({ disk: paragraphs(2000) });
  viewportOf(m, 900, 600);
  await m.key("end");
  await measureMounted(m, 62);
  const measuredFrom = m.view.sums[m.view.win.from], pageTop = () => m.view.offset - 28;
  wheel(m, pageTop() - (measuredFrom + 400));
  const win = m.view.win;
  assert.ok(m.view.sums[win.from] < measuredFrom, "a new window, above the measured blocks");
  wheel(m, pageTop() - (measuredFrom - 40));
  assert.equal(m.view.win.from, win.from, "the window holds");
  const key = firstVisible(m), y = frame(m).get(key) - m.view.offset;
  assert.ok(boxed(m).includes(key), "the first visible block is drawn upward, not measured yet");
  await measureMounted(m, 62);
  assert.equal(frame(m).get(key) - m.view.offset, y);
  assertWindow(m);
});

test("typing that an action takes in before its change event comes is no forward Delete when the event comes, nor is a readout's change that brings later typing: the heading below stays", async () => {
  const m = await page("Some text\n\n## Phase 2\n", { 0: 24, 1: 28 + 28.6 });
  liveFields(true, m.cx);
  try {
    await openBlock(m, 0, 9);
    await flush();
    m.view.field.type("!", m.cx);
    act(m, "mdb-cmd-enter");
    await flush();
    assert.equal(m.view.text, "Some text!\n\n## Phase 2\n", "taken in by the action, its event merges nothing");
    act(m, "mdb-tab");
    m.view.field.type("?", m.cx);
    await flush();
    assert.equal(m.view.text, "Some text!?\n\n## Phase 2\n", "a readout's changes carry the next letter in");
    assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["paragraph", "heading"]);
    forwardDeleteAtEnd(m);
    await flush();
    assert.equal(m.view.doc.blocks.length, 1, "every event owed was paid: a real Delete at the end still merges");
  } finally {
    liveFields(false);
  }
});

test("a press beside the field that leaves the editing where it was gives the field the keyboard back: another block's task box, the toolbar", async () => {
  const m = await page("Note\n\n- [ ] Task\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 4);
  m.view.field.type("s", m.cx);
  const box = { x: X + 12, y: topOf(m, 1) + 14 + 12 };
  fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", press(box), m.cx);
  m.view.field.blur(m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press(box), m.cx);
  assert.deepEqual([m.view.text, m.view.activeKey, m.view.field.focused], ["Notes\n\n- [x] Task\n", keyAt(m, 0), true], "ticked, still typing in Note");
  m.view.field.blur(m.cx);
  fire(must(m.tree(), "md-root"), "on_mouse_up:left", press({ x: 300, y: 10 }), m.cx);
  assert.equal(m.view.field.focused, true, "a press on the toolbar");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Notes\n\n- [ ] Task\n");
});

test("a drag inside another paragraph while one is edited opens that one with the words it crossed selected; the first keeps what was typed", async () => {
  const m = await page("First words\n\nSecond words\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 5);
  m.view.field.type("!", m.cx);
  const from = { x: X + 10, y: topOf(m, 1) + 14 + 10 }, to = { x: X + 60, y: topOf(m, 1) + 14 + 10 };
  fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", press(from), m.cx);
  m.view.field.blur(m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_move", { position: to, local_position: to, modifiers: NO_MODS, pressed_button: "left" }, m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press(to, { click_count: 0 }), m.cx);
  await flush();
  assert.deepEqual([m.view.activeKey, m.view.sel, selectedText(m)], [keyAt(m, 1), null, "Second words"], "nothing selected as blocks");
  assert.equal(m.view.field.focused, true, "the field has the keyboard");
  assert.ok(barOf(m));
  assert.equal(m.view.text, "First! words\n\nSecond words\n");
});

test("Enter, a paste and Cmd+Shift+Down act on the caret the field has now, not on one that a native move left behind before its key-up", async () => {
  const m = await page("Install deps\n\nNext\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 11);
  m.view.field.select(12);
  act(m, "mdb-enter");
  assert.deepEqual([m.view.text, Boolean(pendingOf(m))], ["Install deps\n\nNext\n", true], "the caret at the end: an empty block below, nothing split");
  escape(m);
  await openBlock(m, 0, 11);
  m.view.field.select(12);
  m.cx.held = "a\nb";
  act(m, "mdb-paste");
  assert.equal(m.view.text, "Install depsa\nb\n\nNext\n");
  act(m, "mdb-undo");
  await openBlock(m, 0, 11);
  m.view.field.select(12);
  act(m, "mdb-move-down");
  assert.deepEqual([m.view.text, m.view.field.value(), m.view.field.selection], ["Next\n\nInstall deps\n\n", "Install deps", { start: 12, end: 12 }]);
});

test("a marker typed alone into a block not written yet is written as typed on Enter, an empty paragraph opening below, and on leaving the block by any way", async () => {
  const typeKeys = (m, text) => { for (const ch of text) m.view.field.type(ch, m.cx); };
  const m = await page("Intro\n", { 0: 24 });
  await openBlock(m, 0, 5);
  act(m, "mdb-enter");
  typeKeys(m, "-");
  assert.equal(m.view.text, "Intro\n", "held back");
  act(m, "mdb-enter");
  assert.deepEqual([m.view.text, Boolean(pendingOf(m))], ["Intro\n\n-\n", true]);
  typeKeys(m, "next");
  assert.equal(m.view.text, "Intro\n\n-\n\nnext\n");
  for (const [marker, leave] of [[">", m => escape(m)], ["*", m => clickAt(m, { x: X + 10, y: topOf(m, 0) + 10 })], ["#", m => m.key("cmd-e")], ["+", m => m.view.close(m.cx)]]) {
    reset();
    const n = await page("Intro\n", { 0: 24 });
    await openBlock(n, 0, 5);
    act(n, "mdb-enter");
    typeKeys(n, marker);
    await leave(n);
    await n.save();
    assert.equal(state.disk.get(FILE), `Intro\n\n${marker}\n`, marker);
  }
});

const SLASH_ROWS = ["text", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code", "mermaid", "image", "table", "hr"];
const THREE = "Intro\n\nWords\n\nOutro\n";
const typed =(m, text) => { for (const ch of text) m.view.field.type(ch, m.cx); };
const menuOf = m => find(m.tree(), "md-slash");
const slashRows = (m, t = m.tree()) => all(find(t, "md-slash"), n => /^md-slash-/.test(n.id ?? "")).map(n => n.id.slice("md-slash-".length));
const highlighted = m => all(menuOf(m), n => /^md-slash-/.test(n.id ?? "") && n.style.bg === "hover").map(n => n.id.slice("md-slash-".length));
const contextOf = m => must(m.tree(), `md-field-${m.view.activeKey}`).style.key_context;
async function emptied(m, i) {
  await openBlock(m, i);
  m.view.field.select(0, m.view.field.value().length);
  m.view.field.type("", m.cx);
}
async function slashed(m, i, query, at) {
  await openBlock(m, i, at ?? m.view.openedValue(m.view.doc.blocks[i]).length);
  typed(m, query);
  act(m, "mdb-enter");
}

test(`typing / at the start of a paragraph opens the menu under the caret row with thirteen rows, and the field's wrapper declares '${TEXT} rows=one menu=open'`, async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  assert.equal(menuOf(m), null);
  assert.equal(contextOf(m), `${TEXT} rows=one`);
  typed(m, "/");
  const menu = menuOf(m);
  assert.ok(menu, "the menu");
  assert.deepEqual(slashRows(m), SLASH_ROWS);
  assert.deepEqual(highlighted(m), ["text"], "the first row highlighted");
  assert.deepEqual([menu.style.absolute, menu.style.top, menu.style.left], [true, 28 + 24 + 14 + 24 + 6, 92], "6 px under the caret row, at the field's left");
  const row = must(m.tree(), "md-slash-h2");
  assert.deepEqual([row.style.cursor_pointer, textOf(row).trim()], [true, "Heading 2 ##"]);
  assert.equal(all(row, n => n.kind === "svg")[0].path, "mods/herdr-inline-markdown/heading-2.svg");
  assert.equal(contextOf(m), `${TEXT} rows=one menu=open`);
  assert.deepEqual([m.view.text, m.view.field.value()], ["Intro\n\n/\n\nOutro\n", "/"], "the slash is typed text");
  const t = m.tree(), vp = must(t, "md-viewport");
  assert.deepEqual(vp.kids.map(k => k.id), ["md-scroller", "md-slash", "md-cal"], "over the page, before the calibration strip");
  audit(t);
});

test("/ after a space opens the menu; / mid-word, before a word, inside backticks, in a code block, a table or a mermaid source, and a pasted /, do not", async () => {
  const doc = "Hello\n\nand\n\nword\n\nrun `ls\n\n```\nx\n```\n\n| a |\n|---|\n| b |\n\n```mermaid\ngraph TD\n```\n\nPaste here\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 38, 3: 38, 4: 14 + 26 + 3 * 19.5, 5: 14 + 26 + 60, 6: 134, 7: 38 });
  // The carets: the end of each text block, the end of the code's line, of the table's last cell, of the diagram's line.
  const attempts = [[0, 5, " /", true], [1, 3, "/", false], [2, 0, "/", false], [3, 7, " /", false], [4, 5, " /", false], [5, 15, " /", false], [6, 19, " /", false]];
  for (const [i, at, keys, opens] of attempts) {
    await openBlock(m, i, at);
    typed(m, keys);
    assert.equal(Boolean(menuOf(m)), opens, `block ${i}: ${JSON.stringify(m.view.field.value())}`);
    escape(m);
    escape(m);
  }
  await openBlock(m, 7, 10);
  typed(m, " ");
  m.cx.held = "/";
  act(m, "mdb-paste");
  assert.equal(m.view.field.value(), "Paste here /");
  assert.equal(menuOf(m), null, "pasted");
});

test("letters after the slash filter the rows with the first one highlighted; a query with no match shows a No results row", async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/h");
  assert.deepEqual(slashRows(m).slice(0, 4), ["h1", "h2", "h3", "hr"]);
  assert.deepEqual(highlighted(m), ["h1"]);
  typed(m, "2");
  assert.deepEqual([slashRows(m), highlighted(m)], [["h2"], ["h2"]]);
  typed(m, "z");
  assert.deepEqual(slashRows(m), ["none"]);
  assert.equal(textOf(must(m.tree(), "md-slash-none")).trim(), "No results");
  m.view.field.select(3, 4);
  m.view.field.type("", m.cx);
  assert.deepEqual(slashRows(m), ["h2"], "Backspace widens it again");
});

test("mdb-down and mdb-up move the highlight with wrap in a one-row and in a three-row paragraph; the field's value, caret and block do not change, and their key-ups read nothing out", async () => {
  const long = "word ".repeat(40).trim();
  const m = await page(`Intro\n\n${long}\n`, { 0: 24, 1: 14 + 3 * 24 });
  for (const [i, rows] of [[0, "one"], [1, "many"]]) {
    await openBlock(m, i, m.view.openedValue(m.view.doc.blocks[i]).length);
    typed(m, " /");
    assert.equal(contextOf(m), `${TEXT} rows=${rows} menu=open`);
    const before = editing(m), log = m.view.field.log.length;
    const press = async key => { act(m, `mdb-${key}`); keyUp(m, key); await flush(); };
    await press("down");
    assert.deepEqual(highlighted(m), ["h1"]);
    await press("up");
    await press("up");
    assert.deepEqual(highlighted(m), ["hr"], `${rows}: up from the first row wraps to the last`);
    await press("down");
    assert.deepEqual(highlighted(m), ["text"]);
    assert.deepEqual(editing(m), before, `${rows}: the field, its caret and the block stay`);
    assert.deepEqual(m.view.field.log.slice(log), [], `${rows}: nothing read out`);
    escape(m);
    escape(m);
  }
});

test("Enter and Tab pick the highlighted row; with No results Enter closes the menu and splits the block as Enter does", async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1, 5);
  typed(m, " /");
  act(m, "mdb-down");
  act(m, "mdb-down");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro\n\n## Words \n\nOutro\n");
  assert.equal(menuOf(m), null);
  await openBlock(m, 2, 5);
  typed(m, " /qu");
  act(m, "mdb-tab");
  assert.equal(m.view.text, "Intro\n\n## Words \n\n> Outro \n");
  await openBlock(m, 0, 5);
  typed(m, " /zz");
  act(m, "mdb-enter");
  assert.equal(menuOf(m), null);
  assert.ok(pendingOf(m), "Enter at the end opened an empty paragraph below");
  assert.equal(m.view.text, "Intro /zz\n\n## Words \n\n> Outro \n");
});

test("a press on a row picks it and the pointer moving over a row highlights it; neither reaches md-viewport's handlers or arms the block under the menu", async () => {
  const m = await page("Plain words\n\nIntro\n\nMore plain words\n", { 0: 24, 1: 38, 2: 38 });
  calibrate(m);
  hover(m, { x: X + 20, y: topOf(m, 2) + 14 + 5 });
  assert.equal(m.view.armedKey, keyAt(m, 2), "the block under the pointer is armed");
  await openBlock(m, 1, 5);
  typed(m, " /");
  assert.equal(m.view.armedKey, null, "the menu disarms the spare field");
  const stopped = m.cx.stopped, p = { x: X + 30, y: topOf(m, 2) + 14 + 5 };
  fire(must(m.tree(), "md-slash-h3"), "on_mouse_move", { position: p, local_position: p, modifiers: NO_MODS }, m.cx);
  assert.deepEqual(highlighted(m), ["h3"]);
  fire(must(m.tree(), "md-slash"), "on_mouse_move", { position: p, local_position: p, modifiers: NO_MODS }, m.cx);
  fire(must(m.tree(), "md-slash"), "on_mouse_down:left", press(p), m.cx);
  assert.ok(menuOf(m), "a press on the menu's padding picks nothing");
  assert.equal(m.cx.stopped - stopped, 3, "none of them goes on to the page");
  assert.equal(m.view.armedKey, null);
  fire(must(m.tree(), "md-slash-quote"), "on_mouse_down:left", press(p), m.cx);
  assert.equal(m.cx.stopped - stopped, 4);
  assert.equal(m.view.text, "Plain words\n\n> Intro \n\nMore plain words\n");
  assert.deepEqual([m.view.press, menuOf(m)], [null, null]);
  fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press(p), m.cx);
  await flush();
  assert.equal(m.view.activeKey, keyAt(m, 1), "the mouse-up after the pick lands nowhere");
});

test("'Hello /h2' then Enter makes a heading 2 holding 'Hello ' with the caret where the slash was; one Cmd+Z gives back 'Hello /h2' with the caret after it and no menu; a second removes '/h2'", async () => {
  const m = await page("Hello\n\nNext\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 5);
  typed(m, " /h2");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "## Hello \n\nNext\n");
  assert.deepEqual([m.view.doc.blocks[0].kind, m.view.doc.blocks[0].level], ["heading", 2]);
  assert.deepEqual(editing(m), [keyAt(m, 0), "Hello", { start: 5, end: 5 }], "a heading's trailing space is not its text: the caret where the slash was, at its end");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Hello /h2\n\nNext\n");
  assert.deepEqual(editing(m), [keyAt(m, 0), "Hello /h2", { start: 9, end: 9 }]);
  assert.equal(menuOf(m), null);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Hello \n\nNext\n");
  assert.deepEqual(editing(m), [keyAt(m, 0), "Hello ", { start: 6, end: 6 }]);
  act(m, "mdb-redo");
  act(m, "mdb-redo");
  assert.equal(m.view.text, "## Hello \n\nNext\n", "redo applies the command again");
});

test("/text in a quote opening with '<div>', which as a paragraph would be HTML, is refused by retype: the menu closes and the quote stays as typed with '/text' in it and no entry for the pick", async () => {
  const m = await page("> <div>\n> foo\n\nNext\n", { 0: 60, 1: 38 });
  await openBlock(m, 0, 9);
  typed(m, " /text");
  assert.ok(menuOf(m));
  const entries = m.view.history.entries.length;
  act(m, "mdb-enter");
  assert.equal(m.view.text, "> <div>\n> foo /text\n\nNext\n");
  assert.deepEqual(editing(m), [keyAt(m, 0), "<div>\nfoo /text", { start: 15, end: 15 }]);
  assert.equal(m.view.blockByKey(m.view.activeKey).kind, "quote");
  assert.deepEqual([m.view.history.entries.length, menuOf(m)], [entries, null]);
});

test("after a Shift key-up ('/' is Shift+7 on some keyboard layouts, a capital in the query), a pick by Enter or a row press still has one Cmd+Z put the caret back after the query", async () => {
  const pickH2 = { enter: m => { for (let i = slashRows(m).indexOf("h2"); i > 0; i--) act(m, "mdb-down"); act(m, "mdb-enter"); }, row: m => fire(must(m.tree(), "md-slash-h2"), "on_mouse_down:left", press({ x: X + 30, y: topOf(m, 1) + 5 }), m.cx) };
  for (const [query, shifted, pick] of [[" /", "7", "enter"], [" /", "7", "row"], [" /H", "h", "enter"]]) {
    reset();
    const m = await page("Hello\n\nNext\n", { 0: 24, 1: 38 });
    const where = `${JSON.stringify(query)} ${pick}`, value = `Hello${query}`;
    await openBlock(m, 0, 5);
    typed(m, query);
    keyUp(m, shifted, { shift: true });
    await flush();
    pickH2[pick](m);
    assert.equal(m.view.text, "## Hello \n\nNext\n", where);
    act(m, "mdb-undo");
    assert.deepEqual(editing(m), [keyAt(m, 0), value, { start: value.length, end: value.length }], `${where}: the caret after the query`);
  }
});

test("/todo on a bullet item makes it '- [ ] ', /ol makes it '1. ' with its sub-item still under it, /quote on a heading makes a quote, /text on a heading makes a paragraph; each is one splice and one Cmd+Z", async () => {
  const doc = "- buy milk\n  - sub\n\n# Title\n";
  for (const [i, query, want, kind] of [
    [0, " /todo", "- [ ] buy milk \n  - sub\n\n# Title\n", "item"],
    [0, " /ol", "1. buy milk \n   - sub\n\n# Title\n", "item"],
    [2, " /quote", "- buy milk\n  - sub\n\n> Title \n", "quote"],
    [2, " /text", "- buy milk\n  - sub\n\nTitle \n", "paragraph"],
  ]) {
    reset();
    const m = await page(doc, { 0: 24, 1: 30, 2: 38 });
    await openBlock(m, i, m.view.openedValue(m.view.doc.blocks[i]).length);
    typed(m, query);
    const entries = m.view.history.entries.length, before = m.view.text;
    act(m, "mdb-enter");
    assert.equal(m.view.text, want, query);
    assert.equal(m.view.history.entries.length, entries + 1, `${query}: one entry`);
    assert.equal(m.view.blockByKey(m.view.activeKey).kind, kind, query);
    assert.equal(m.view.field.value(), i ? "Title " : "buy milk ", `${query}: the text stays`);
    assert.deepEqual(m.view.field.selection, { start: m.view.field.value().length, end: m.view.field.value().length }, `${query}: the caret where the slash was`);
    if (query === " /ol") assert.deepEqual(m.view.doc.blocks.map(b => [b.kind, b.depth, b.ordered]), [["item", 0, true], ["item", 1, false], ["heading", 0, false]]);
    act(m, "mdb-undo");
    assert.equal(m.view.text, before, `${query}: one Cmd+Z`);
  }
});

test("/h1 alone in a paragraph leaves an empty heading with the caret in it, which goes when it is left without typing", async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/h1");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro\n\n# \n\nOutro\n");
  assert.deepEqual(editing(m), [keyAt(m, 1), "", { start: 0, end: 0 }]);
  assert.equal(m.view.doc.blocks[1].kind, "heading");
  escape(m);
  assert.equal(m.view.text, "Intro\n\nOutro\n", "left empty, it goes");
});

test("/text alone in a heading leaves an empty paragraph in its place, written once something is typed", async () => {
  const m = await page("Intro\n\n# Title\n\nOutro\n", { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/text");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro\n\nOutro\n");
  const p = pendingOf(m);
  assert.ok(p, "an empty paragraph not written yet");
  assert.deepEqual([p.kind, m.view.blocks.map(b => b.key).indexOf(m.view.activeKey)], ["paragraph", 1], "in the heading's place");
  typed(m, "x");
  assert.equal(m.view.text, "Intro\n\nx\n\nOutro\n");
});

test("/code alone in a paragraph replaces it with a closed empty code block, caret on its empty line; in 'Run this /code' the code block follows the paragraph, which keeps 'Run this'", async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/code");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro\n\n```\n\n```\n\nOutro\n");
  assert.deepEqual(editing(m), [keyAt(m, 1), "```\n\n```", { start: 4, end: 4 }]);
  assert.equal(contextOf(m), `${RAW} rows=many`);
  reset();
  const r = await page("Run this\n\nOutro\n", { 0: 24, 1: 38 });
  await slashed(r, 0, " /code");
  assert.equal(r.view.text, "Run this\n\n```\n\n```\n\nOutro\n");
  assert.deepEqual(editing(r), [keyAt(r, 1), "```\n\n```", { start: 4, end: 4 }]);
  act(r, "mdb-undo");
  assert.equal(r.view.text, "Run this /code\n\nOutro\n", "one Cmd+Z");
});

test("a pick in a paragraph that its commit parses as a fence, HTML or indented code writes nothing: the raw block stays as typed, '/code' in it, with the menu closed", async () => {
  for (const [line, text, value, kind] of [
    ["~~~ /code", "~~~ /code\n~~~", "~~~ /code\n\n~~~", "code"],
    ["<div> /code", "<div> /code", "<div> /code", "html"],
    ["    /code", "    /code", "    /code", "code"],
  ]) {
    reset();
    const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
    await emptied(m, 1);
    typed(m, line);
    assert.ok(menuOf(m), `${line}: open while the block is still a paragraph`);
    const entries = m.view.history.entries.length;
    act(m, "mdb-enter");
    assert.equal(m.view.text, `Intro\n\n${text}\n\nOutro\n`, line);
    assert.deepEqual(editing(m), [keyAt(m, 1), value, { start: line.length, end: line.length }], `${line}: the caret after the query`);
    assert.equal(m.view.blockByKey(m.view.activeKey).kind, kind, line);
    assert.equal(m.view.history.entries.length, entries, `${line}: no entry for the pick`);
    assert.equal(menuOf(m), null, line);
  }
});

test("/mermaid writes the starter flowchart, the block shows its source with the caret at the end of its last line, and Escape asks for the diagram", async () => {
  renderer();
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/mer");
  act(m, "mdb-enter");
  const source = "```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```";
  assert.equal(m.view.text, `Intro\n\n${source}\n\nOutro\n`);
  const key = m.view.activeKey;
  assert.equal(m.view.blockByKey(key).kind, "mermaid");
  assert.deepEqual(editing(m), [key, source, { start: source.length - 4, end: source.length - 4 }]);
  assert.equal(find(m.tree(), `md-diagram-${key}`), null, "its source while it is open");
  escape(m);
  await flush();
  assert.ok(find(m.tree(), `md-diagram-${key}`), "drawn once left");
  assert.ok(m.view.shown.has(key), "the diagram was asked for");
});

const noDialog = () => { state.exec = async () => { throw new Error("spawn osascript ENOENT"); }; };

test("without osascript /img writes an empty image with the caret between the parentheses; the address typed there is drawn once the block is left", async () => {
  noDialog();
  files.set(`${DIR}/a.png`, SHOT);
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/img");
  assert.deepEqual(slashRows(m), ["image"]);
  act(m, "mdb-enter");
  await flush();
  assert.equal(m.view.text, "Intro\n\n![]()\n\nOutro\n");
  const key = m.view.activeKey;
  assert.equal(m.view.blockByKey(key).image, true);
  assert.deepEqual(editing(m), [key, "![]()", { start: 4, end: 4 }]);
  typed(m, "a.png");
  assert.equal(m.view.text, "Intro\n\n![](a.png)\n\nOutro\n");
  escape(m);
  await flush();
  assert.equal(imageOf(m.tree(), `md-pictures-${key}`).path, cached(SHOT));
});

test("an image left without an address is drawn as a box called Picture", async () => {
  noDialog();
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/image");
  act(m, "mdb-enter");
  await flush();
  const key = m.view.activeKey;
  escape(m);
  await flush();
  assert.equal(textOf(must(m.tree(), `md-pictures-${key}`)).trim(), "Picture: No picture address");
});

const DESKTOP = "/home/user/Desktop", PICS = "/Users/me/pics", IMAGE_FOLDER = "herdr-inline-markdown.imageFolder", OTHER = png(41, 31);
const OK = { code: 0, stdout: "", stderr: "" };
const PID = "4242";
// What exec answers while pictures are chosen. `dialog` is how osascript ends ({ code, stdout, stderr }, a promise of that, a
// function of sh's arguments returning either), or an Error that `sh` is refused with. `sh` answers the pid and the answer
// files appear as the detached script leaves them; mkdir does nothing, cp copies in the in-memory files, kill says the
// process lives.
function dialogShows(dialog) {
  state.exec = async (command, args) => {
    if (command === "sh") {
      const answer = typeof dialog === "function" ? dialog(args) : dialog;
      if (answer instanceof Error) throw answer;
      Promise.resolve(answer).then(({ code, stdout, stderr }) => {
        files.set(`${args[3]}.txt`, stdout);
        files.set(`${args[3]}.err`, stderr);
        files.set(`${args[3]}.code`, `${code}\n`);
      });
      return { code: 0, stdout: `${PID}\n`, stderr: "" };
    }
    if (command === "cp") files.set(args[1], files.get(args[0]));
    return OK;
  };
}
const chosen = (...paths) => ({ code: 0, stdout: `${paths.join("\n")}\n`, stderr: "" });
const CANCELLED = { code: 1, stdout: "", stderr: "0:90: execution error: User canceled. (-128)\n" };
const ran = command => calls.exec.filter(c => c.command === command);
// The dialog stays open until `answer(result)` is called.
function dialogHeld() {
  const held = {};
  dialogShows(() => new Promise(done => { held.answer = done; }));
  return held;
}
// One look at the answer files, 300 ms later.
const polled = async m => {
  await fire_timers(m.cx, { ms: 300 });
  await flush();
};
async function pickImage(m, query = "/img") {
  typed(m, query);
  act(m, "mdb-enter");
  await flush();
  await polled(m);
}

test("/img opens the file dialog at the Desktop; the pictures it answers are written where the slash was, the caret goes to a new paragraph below, and one Cmd+Z takes them away", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  files.set(`${DESKTOP}/shot 1.png`, OTHER);
  dialogShows(chosen(`${DIR}/a.png`, `${DESKTOP}/shot 1.png`));
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/img");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro\n\nOutro\n", "the query and the paragraph it was in are gone while the dialog is open");
  await flush();
  await polled(m);
  assert.equal(ran("sh").length, 1);
  assert.equal(ran("sh")[0].args.at(-1), DESKTOP);
  assert.equal(m.view.text, "Intro\n\n![a](a.png)\n![shot 1](images/shot-1.png)\n\nOutro\n");
  assert.deepEqual(ran("mkdir").map(c => c.args), [["-p", `${DIR}/images`]]);
  assert.deepEqual(ran("cp").map(c => c.args), [[`${DESKTOP}/shot 1.png`, `${DIR}/images/shot-1.png`]]);
  assert.deepEqual(m.view.doc.blocks.map(b => b.image === true), [false, true, false]);
  assert.ok(pendingOf(m), "an empty paragraph below the pictures");
  assert.equal(m.view.blocks[2].key, m.view.activeKey);
  assert.equal(m.view.field.value(), "");
  await flush();
  const shown = all(must(m.tree(), picsOf(m)), n => n.kind === "image").map(n => n.path);
  assert.deepEqual(shown, [cached(SHOT), cached(OTHER)], "drawn at once");
  assert.equal(state.shared[IMAGE_FOLDER], DIR, "the next dialog opens where the first picture came from");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Intro\n\nOutro\n");
  assert.equal(ran("cp").length, 1, "the copy stays");
});

test("the dialog opens at the folder the last picture came from; the caret is in the paragraph below, where the next /img goes", async () => {
  files.set(`${PICS}/a.png`, SHOT);
  files.set(`${PICS}/b.png`, OTHER);
  dialogShows(chosen(`${PICS}/a.png`));
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  assert.equal(state.shared[IMAGE_FOLDER], PICS);
  dialogShows(chosen(`${PICS}/b.png`));
  await pickImage(m);
  assert.deepEqual(ran("sh").map(c => c.args.at(-1)), [DESKTOP, PICS]);
  assert.equal(m.view.text, "Intro\n\n![a](images/a.png)\n\n![b](images/b.png)\n\nOutro\n");
});

test("cancelling the dialog writes nothing and says nothing: the emptied paragraph is still there to type in", async () => {
  dialogShows(CANCELLED);
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  assert.equal(m.view.text, "Intro\n\nOutro\n");
  assert.ok(pendingOf(m));
  assert.deepEqual([calls.notify, ran("mkdir"), ran("cp"), state.shared[IMAGE_FOLDER]], [[], [], [], undefined]);
  typed(m, "x");
  assert.equal(m.view.text, "Intro\n\nx\n\nOutro\n", "in its own place");
});

test("cancelling in a block that has other text leaves it as it was before the slash, still being edited", async () => {
  dialogShows(CANCELLED);
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1, 5);
  await pickImage(m, " /img");
  assert.equal(m.view.text, "Intro\n\nWords \n\nOutro\n");
  assert.deepEqual(editing(m), [keyAt(m, 1), "Words ", { start: 6, end: 6 }]);
  assert.deepEqual(calls.notify, []);
});

test("with no osascript Image still writes an empty image, the caret between the parentheses, and says nothing", async () => {
  noDialog();
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  assert.equal(m.view.text, "Intro\n\n![]()\n\nOutro\n");
  assert.deepEqual(editing(m), [keyAt(m, 1), "![]()", { start: 4, end: 4 }]);
  assert.deepEqual(calls.notify, []);
});

test("a dialog that fails gives a notice with the reason and writes nothing", async () => {
  dialogShows({ code: 1, stdout: "", stderr: "execution error: Not allowed to send keystrokes. (-1743)\n" });
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  assert.equal(m.view.text, "Intro\n\nOutro\n");
  assert.deepEqual(calls.notify, [{ title: "Can't choose pictures", body: "execution error: Not allowed to send keystrokes. (-1743)", level: "error" }]);
});

test("a picture whose name images/ holds with other bytes is written as -2, one with the same bytes as the file there, and nothing is copied", async () => {
  for (const [held, address, copies] of [[OTHER, "images/shot-2.png", 1], [SHOT, "images/shot.png", 0]]) {
    reset();
    files.set(`${DESKTOP}/shot.png`, SHOT);
    files.set(`${DIR}/images/shot.png`, held);
    dialogShows(chosen(`${DESKTOP}/shot.png`));
    const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
    await emptied(m, 1);
    await pickImage(m);
    assert.equal(m.view.text, `Intro\n\n![shot](${address})\n\nOutro\n`);
    assert.equal(ran("cp").length, copies, address);
  }
});

test("a picture that cannot be copied is left out with a notice naming it; the others are written", async () => {
  files.set(`${DESKTOP}/a.png`, SHOT);
  files.set(`${DESKTOP}/b.png`, OTHER);
  dialogShows(chosen(`${DESKTOP}/a.png`, `${DESKTOP}/b.png`));
  const run = state.exec;
  state.exec = async (command, args) => (command === "cp" && args[0].endsWith("a.png") ? { code: 1, stdout: "", stderr: "cp: no space left\n" } : run(command, args));
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  assert.equal(m.view.text, "Intro\n\n![b](images/b.png)\n\nOutro\n");
  assert.deepEqual(calls.notify, [{ title: "Couldn't copy a.png", body: "cp: no space left", level: "error" }]);
});

test("every picture failing writes nothing", async () => {
  files.set(`${DESKTOP}/a.png`, SHOT);
  dialogShows(chosen(`${DESKTOP}/a.png`));
  const run = state.exec;
  state.exec = async (command, args) => (command === "cp" ? { code: 1, stdout: "", stderr: "cp: no space left\n" } : run(command, args));
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  assert.equal(m.view.text, "Intro\n\nOutro\n");
  assert.equal(calls.notify.length, 1);
});

test("Image in the empty paragraph Enter opened writes the pictures in its place and moves the caret to a new paragraph below them", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  dialogShows(chosen(`${DIR}/a.png`));
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1, 5);
  act(m, "mdb-enter");
  assert.ok(pendingOf(m));
  await pickImage(m);
  assert.equal(m.view.text, "Intro\n\nWords\n\n![a](a.png)\n\nOutro\n");
  assert.ok(pendingOf(m), "a new empty paragraph");
  assert.equal(m.view.blocks[3].key, m.view.activeKey);
  typed(m, "x");
  assert.equal(m.view.text, "Intro\n\nWords\n\n![a](a.png)\n\nx\n\nOutro\n");
});

test("Image in a block that has other text goes below that block, the query gone and the text kept", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  dialogShows(chosen(`${DIR}/a.png`));
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1, 5);
  await pickImage(m, " /img");
  assert.equal(m.view.text, "Intro\n\nWords \n\n![a](a.png)\n\nOutro\n");
  assert.ok(pendingOf(m));
});

test("Image in the empty item Enter opened writes the pictures as a paragraph after the list item they follow", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  dialogShows(chosen(`${DIR}/a.png`));
  const m = await page("- one\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 3);
  act(m, "mdb-enter");
  assert.equal(pendingOf(m).kind, "item");
  await pickImage(m);
  assert.equal(m.view.text, "- one\n\n![a](a.png)\n\nEnd\n");
  assert.deepEqual(m.view.doc.blocks.map(b => [b.kind, b.image === true]), [["item", false], ["paragraph", true], ["paragraph", false]]);
});

test("a second pick while the dialog is open does nothing; the first still writes its pictures", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  const held = dialogHeld();
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  assert.equal(ran("sh").length, 1);
  typed(m, "/img");
  act(m, "mdb-enter");
  await flush();
  assert.equal(ran("sh").length, 1, "no second dialog");
  assert.equal(m.view.field.value(), "/img", "and nothing happened to the block");
  held.answer(chosen(`${DIR}/a.png`));
  await polled(m);
  assert.match(m.view.text, /^Intro\n\n!\[a\]\(a\.png\)\n\n/);
  typed(m, "/img");
  dialogShows(CANCELLED);
  act(m, "mdb-enter");
  await flush();
  assert.equal(ran("sh").length, 2, "once the dialog has answered, Image asks again");
});

test("a dialog browsed in for minutes writes its pictures when it ends: the answer is waited for every 300 ms, the process looked at on the way, nothing happens meanwhile", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  const held = dialogHeld();
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  for (let i = 0; i < 400; i++) await polled(m);
  assert.equal(m.view.text, "Intro\n\nOutro\n", "two minutes on, nothing is written");
  assert.deepEqual([ran("sh").length, calls.notify.length], [1, 0]);
  assert.ok(ran("kill").length > 50 && ran("kill").every(c => c.args.join(" ") === `-0 ${PID}`), "only looks at the process");
  held.answer(chosen(`${DIR}/a.png`));
  await polled(m);
  assert.equal(m.view.text, "Intro\n\n![a](a.png)\n\nOutro\n");
  assert.equal(m.view.picking, false);
});

test("a dialog whose process is gone with no answer gives the notice 'The picture dialog closed unexpectedly', and Image works again", async () => {
  const held = dialogHeld();
  const run = state.exec;
  state.exec = async (command, args) => (command === "kill" && args[0] === "-0" ? { code: 1, stdout: "", stderr: "" } : run(command, args));
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  for (let i = 0; i < 7; i++) await polled(m);
  assert.deepEqual(calls.notify, [{ title: "Can't choose pictures", body: "The picture dialog closed unexpectedly", level: "error" }]);
  assert.equal(m.view.text, "Intro\n\nOutro\n");
  assert.equal(m.view.picking, false);
  assert.ok(held.answer);
});

test("closing the pane while the dialog is open kills its process and writes and copies nothing, however late an answer comes", async () => {
  files.set(`${DESKTOP}/a.png`, SHOT);
  const held = dialogHeld();
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  assert.deepEqual(ran("kill"), []);
  await m.view.close(m.cx);
  assert.deepEqual(ran("kill").map(c => c.args), [[PID]]);
  held.answer(chosen(`${DESKTOP}/a.png`));
  await polled(m);
  assert.deepEqual([ran("cp"), ran("mkdir"), calls.notify, m.view.text], [[], [], [], "Intro\n\nOutro\n"]);
  assert.equal(m.view.picking, false);
});

test("the pictures go where the slash was even when the page changed while the dialog was open: after the block above, else at the end", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  const held = dialogHeld();
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  await pickImage(m);
  typed(m, "x");
  assert.equal(m.view.text, "Intro\n\nx\n\nOutro\n", "typed into the paragraph that took the slash's place");
  held.answer(chosen(`${DIR}/a.png`));
  await polled(m);
  assert.equal(m.view.text, "Intro\n\n![a](a.png)\n\nx\n\nOutro\n");

  reset();
  files.set(`${DIR}/a.png`, SHOT);
  const slow = dialogHeld();
  const n = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(n, 1);
  await pickImage(n);
  await n.save();
  state.disk.set(FILE, "# Other\n");
  await n.touch([FILE]);
  assert.equal(n.view.text, "# Other\n", "a page with no paragraph: the one the pictures were to follow is gone");
  slow.answer(chosen(`${DIR}/a.png`));
  await polled(n);
  assert.equal(n.view.text, "# Other\n\n![a](a.png)\n");
});

test("a pane switched to Markdown while the dialog is open copies nothing and says why", async () => {
  files.set(`${DESKTOP}/a.png`, SHOT);
  const held = dialogHeld();
  const switched = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(switched, 1);
  await pickImage(switched);
  await switched.click("md-markdown");
  held.answer(chosen(`${DESKTOP}/a.png`));
  await polled(switched);
  assert.equal(switched.view.text, "Intro\n\nOutro\n");
  assert.deepEqual([ran("cp"), calls.notify.map(n => n.title)], [[], ["The pictures weren't added"]]);
});

const drop = (m, paths) => fire(must(m.tree(), "md-viewport"), "on_drop", { paths }, m.cx);

test("a drop of two images and a text file writes the two, one linked and one copied, below the last block when nothing was pointed at", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  files.set(`${DESKTOP}/b 2.png`, OTHER);
  dialogShows(CANCELLED);
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  drop(m, [`${DIR}/a.png`, `${DESKTOP}/notes.txt`, `${DESKTOP}/b 2.png`]);
  await flush();
  assert.equal(m.view.text, "Intro\n\nWords\n\nOutro\n\n![a](a.png)\n![b 2](images/b-2.png)\n");
  assert.deepEqual(ran("cp").map(c => c.args), [[`${DESKTOP}/b 2.png`, `${DIR}/images/b-2.png`]]);
  assert.deepEqual(ran("sh"), []);
  assert.equal(m.view.activeKey, null, "no block is being edited after a drop");
});

test("a drop goes below the block the pointer was last over, else below the block being edited", async () => {
  files.set(`${DIR}/a.png`, SHOT);
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  hover(m, { x: X + 10, y: topOf(m, 0) + 5 });
  drop(m, [`${DIR}/a.png`]);
  await flush();
  assert.equal(m.view.text, "Intro\n\n![a](a.png)\n\nWords\n\nOutro\n");

  reset();
  files.set(`${DIR}/a.png`, SHOT);
  const n = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await openBlock(n, 1, 2);
  fire(must(n.tree(), "md-viewport"), "on_hover", false, n.cx);
  drop(n, [`${DIR}/a.png`]);
  await flush();
  assert.equal(n.view.text, "Intro\n\nWords\n\n![a](a.png)\n\nOutro\n");
  assert.equal(n.view.activeKey, null, "no block is open after a drop");
});

test("a drop with no picture in it gives a notice and changes nothing", async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  drop(m, [`${DESKTOP}/notes.txt`, `${DESKTOP}/photo.heic`]);
  await flush();
  assert.equal(m.view.text, THREE);
  assert.deepEqual(calls.notify, [{ title: "Only pictures can be dropped here (PNG, JPEG, GIF, WebP, BMP, SVG)", level: "info" }]);
  assert.deepEqual(calls.exec, []);
});

test("a drop on a page that cannot be edited does nothing: no notice, no copy", async () => {
  const m = await mount({ file: "/home/dev/n.md", machine: "devbox", disk: THREE });
  viewportOf(m, 900, 600);
  files.set(`${DESKTOP}/a.png`, SHOT);
  drop(m, [`${DESKTOP}/a.png`]);
  await flush();
  assert.deepEqual([m.view.text, calls.notify, calls.exec], [THREE, [], []]);
});

test("/table writes a 3-column table with one empty row and selects 'Column 1'; Tab then selects 'Column 2'", async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/table");
  act(m, "mdb-enter");
  const table = "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |";
  assert.equal(m.view.text, `Intro\n\n${table}\n\nOutro\n`);
  assert.equal(m.view.blockByKey(m.view.activeKey).kind, "table");
  const value = m.view.field.value(), cell = word => ({ start: value.indexOf(word), end: value.indexOf(word) + word.length });
  assert.deepEqual(m.view.field.selection, cell("Column 1"));
  act(m, "mdb-tab");
  assert.deepEqual(m.view.field.selection, cell("Column 2"));
});

test("/divider writes a rule and opens an empty paragraph below it that takes the caret; nothing is written for that paragraph until typing", async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/divider");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Intro\n\n---\n\nOutro\n");
  assert.ok(pendingOf(m), "an empty paragraph below the rule");
  assert.deepEqual(m.view.blocks.map(b => b.kind), ["paragraph", "hr", "paragraph", "paragraph"]);
  assert.equal(m.view.blocks[2].key, m.view.activeKey);
  typed(m, "x");
  assert.equal(m.view.text, "Intro\n\n---\n\nx\n\nOutro\n");
});

test("in the empty paragraph Enter opened, '/h2' writes nothing; picking Heading 2 writes '## ', and one Cmd+Z goes back to the block where Enter was pressed", async () => {
  const m = await page("Alpha\n\nOmega\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 5);
  act(m, "mdb-enter");
  assert.ok(pendingOf(m));
  typed(m, "/h2");
  assert.deepEqual([m.view.text, slashRows(m)], ["Alpha\n\nOmega\n", ["h2"]], "held back while the menu is open");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "Alpha\n\n## \n\nOmega\n");
  assert.deepEqual(editing(m), [keyAt(m, 1), "", { start: 0, end: 0 }]);
  assert.equal(m.view.doc.blocks[1].kind, "heading");
  typed(m, "Plan");
  assert.equal(m.view.text, "Alpha\n\n## Plan\n\nOmega\n");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Alpha\n\nOmega\n", "the heading and its typing in one");
  assert.deepEqual(editing(m), [keyAt(m, 0), "Alpha", { start: 5, end: 5 }]);
});

test("in the empty item Enter opened at the end of a list, /h1 writes the heading after the list, not inside the item", async () => {
  const m = await page("- one\n- two\n\nEnd\n", { 0: 24, 1: 30, 2: 38 });
  await openBlock(m, 1, 3);
  act(m, "mdb-enter");
  assert.equal(pendingOf(m).kind, "item");
  typed(m, "/h1");
  act(m, "mdb-enter");
  assert.equal(m.view.text, "- one\n- two\n\n# \n\nEnd\n");
  assert.deepEqual(m.view.doc.blocks.map(b => [b.kind, b.depth]), [["item", 0], ["item", 0], ["heading", 0], ["paragraph", 0]]);
  assert.equal(m.view.activeKey, keyAt(m, 2));
  reset();
  const n = await page("- one\n- two\n\nEnd\n", { 0: 24, 1: 30, 2: 38 });
  await openBlock(n, 1, 3);
  act(n, "mdb-enter");
  typed(n, "/ul");
  act(n, "mdb-enter");
  assert.deepEqual([n.view.text, pendingOf(n)?.kind, n.view.field.value()], ["- one\n- two\n\nEnd\n", "item", ""], "the same list: the item stays, nothing written");
  typed(n, "/text");
  act(n, "mdb-enter");
  assert.deepEqual([n.view.text, pendingOf(n)?.kind], ["- one\n- two\n\nEnd\n", "paragraph"], "Text: an empty paragraph after the list");
  escape(n);
  await openBlock(n, 1, 3);
  act(n, "mdb-enter");
  act(n, "mdb-enter");
  assert.equal(pendingOf(n)?.kind, "paragraph", "Enter on the empty top-level item it opened leaves the list too");
});

test("Escape closes the menu and keeps '/qu' in the open block; in an Enter-opened paragraph the next letter writes '/qu' and that letter; a second Escape stops editing", async () => {
  const m = await page("Hello\n\nNext\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 5);
  typed(m, " /qu");
  escape(m);
  assert.equal(menuOf(m), null);
  assert.deepEqual(editing(m), [keyAt(m, 0), "Hello /qu", { start: 9, end: 9 }]);
  assert.equal(contextOf(m), `${TEXT} rows=one`);
  escape(m);
  assert.equal(m.view.activeKey, null);
  assert.equal(m.view.text, "Hello /qu\n\nNext\n");
  reset();
  const n = await page("Hello\n\nNext\n", { 0: 24, 1: 38 });
  await openBlock(n, 0, 5);
  act(n, "mdb-enter");
  typed(n, "/qu");
  escape(n);
  assert.deepEqual([menuOf(n), n.view.text, Boolean(pendingOf(n))], [null, "Hello\n\nNext\n", true], "still held back");
  typed(n, "x");
  assert.equal(n.view.text, "Hello\n\n/qux\n\nNext\n");
  assert.equal(menuOf(n), null);
});

test("the menu closes when Backspace deletes the slash, a key-up readout or a mouse-up readout finds the caret outside the query, a space follows a query with no match, the wheel moves, Cmd+E switches state, or the block is left", async () => {
  const m = await page("Hello\n\nNext\n", { 0: 24, 1: 38 }, 200);
  const open = async () => {
    await openBlock(m, 0, 5);
    if (m.view.field.value().length > 5) {
      m.view.field.select(5, m.view.field.value().length);
      m.view.field.type("", m.cx);
    }
    typed(m, " /h");
    assert.ok(menuOf(m), "open");
  };
  const field = m.view.field;
  await open();
  field.select(6, 7);
  field.type("", m.cx);
  assert.equal(menuOf(m), null, "Backspace over the slash");
  await open();
  field.select(7);
  keyUp(m, "left");
  await flush();
  assert.ok(menuOf(m), "the caret moved inside the query");
  field.select(2);
  keyUp(m, "left");
  await flush();
  assert.equal(menuOf(m), null, "a key-up readout outside the query");
  await open();
  keyUp(m, "a", { shift: true });
  await flush();
  assert.ok(menuOf(m), "a capital typed with Shift moves no caret");
  keyUp(m, "left", { shift: true });
  await flush();
  assert.equal(menuOf(m), null, "Shift+Left selects: the caret is not known");
  await open();
  fire(must(m.tree(), `md-field-${m.view.activeKey}`), "on_mouse_up:left", press({ x: X + 2, y: topOf(m, 0) + 5 }), m.cx);
  field.select(1);
  await flush();
  await fire_timers(m.cx, { ms: 30 });
  assert.equal(menuOf(m), null, "a mouse-up readout outside the query");
  await open();
  typed(m, "zz ");
  assert.equal(menuOf(m), null, "a space after a query with no match");
  await open();
  wheel(m, -10);
  assert.equal(menuOf(m), null, "the wheel");
  await open();
  await m.key("cmd-e");
  assert.equal(m.view.mode, "markdown");
  await m.key("cmd-e");
  assert.equal(menuOf(m), null, "Cmd+E and back");
  await open();
  await clickAt(m, { x: X + 2, y: topOf(m, 1) + 14 + 5 });
  assert.equal(m.view.activeKey, keyAt(m, 1));
  assert.equal(menuOf(m), null, "another block opened");
});

test("Cmd+Up and Cmd+Down, which the field keeps, are read out on key-up: a caret moved out of the query closes the menu, so a letter typed there is text and Enter splits the block or opens one below", async () => {
  const START = "x\n\nHello /h world\n\nNext\n", END = "Hello /h worldx\n\nNext\n";
  for (const [key, mods, caret, want] of [["up", { platform: true }, 0, START], ["down", { platform: true }, 14, END]]) {
    reset();
    const m = await page("Hello world\n\nNext\n", { 0: 24, 1: 38 });
    const where = `${key} ${JSON.stringify(mods)}`;
    await openBlock(m, 0, 5);
    typed(m, " /h");
    assert.equal(m.view.field.value(), "Hello /h world");
    assert.ok(menuOf(m), where);
    m.view.field.select(caret);
    keyUp(m, key, mods);
    await flush();
    assert.equal(menuOf(m), null, `${where}: closed`);
    assert.deepEqual(m.view.known, { start: caret, end: caret, valid: true }, `${where}: the caret read out`);
    typed(m, "x");
    act(m, "mdb-enter");
    assert.deepEqual([m.view.text, Boolean(pendingOf(m))], [want, caret > 0], `${where}: Enter as with the menu shut`);
  }
});

test("a disk change elsewhere keeps the menu open on the same query; one that rewrites the block being edited closes it", async () => {
  const m = await page("Hello\n\nOther\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 5);
  typed(m, " /h");
  state.disk.set(FILE, "Hello\n\nOther\nAgent line\n");
  await m.touch([FILE]);
  assert.equal(m.view.text, "Hello /h\n\nOther\nAgent line\n");
  assert.deepEqual([slashRows(m).slice(0, 3), m.view.slash.query], [["h1", "h2", "h3"], "h"], "still open on 'h'");
  state.disk.set(FILE, "Oh Hello\n\nOther\nAgent line\n");
  await m.touch([FILE]);
  assert.equal(m.view.text, "Oh Hello /h\n\nOther\nAgent line\n");
  assert.equal(m.view.field.value(), "Oh Hello /h");
  assert.equal(menuOf(m), null, "their change inside the block closed it");
});

test("with the menu shut, Enter splits, Escape stops editing, Tab nests, mdb-down crosses a one-row field, and a three-row field crosses only on the key-up edge, as before; mdb-down arriving in a three-row field with the menu shut does nothing", async () => {
  const m = await page("- a\n\nab\n", { 0: 30, 1: 38 });
  await openBlock(m, 1, 2);
  typed(m, " /");
  escape(m);
  assert.equal(menuOf(m), null);
  await caretTo(m, 1);
  act(m, "mdb-enter");
  assert.equal(m.view.text, "- a\n\na\n\nb /\n", "Enter splits");
  escape(m);
  assert.equal(m.view.activeKey, null, "Escape stops editing");
  await openBlock(m, 1, 1);
  act(m, "mdb-tab");
  assert.equal(m.view.text, "- a\n\n  a\n\nb /\n", "Tab nests");
  reset();
  const long = "word ".repeat(40).trim();
  const n = await page(`Intro\n\n${long}\n\nEnd\n`, { 0: 24, 1: 14 + 3 * 24, 2: 38 });
  await openBlock(n, 0, 5);
  typed(n, " /");
  escape(n);
  act(n, "mdb-down");
  assert.equal(n.view.activeKey, keyAt(n, 1), "a one-row field crosses on mdb-down");
  assert.equal(n.view.rows, "many");
  act(n, "mdb-down");
  assert.equal(n.view.activeKey, keyAt(n, 1), "a three-row field: mdb-down from a context a frame old does nothing");
  n.view.field.select(long.length);
  keyUp(n, "right");
  await flush();
  keyUp(n, "down");
  await flush();
  assert.equal(n.view.activeKey, keyAt(n, 2), "the key-up edge crosses");
});

test("no menu on a file from another machine, after the file went read-only, in the Markdown state, or when the key table could not be installed", async () => {
  const remote = await mount({ machine: "devbox", disk: "Hello\n" });
  remote.view.field.type("/", remote.cx);
  assert.deepEqual([remote.view.slash, find(remote.tree(), "md-slash")], [null, null], "remote");
  reset();
  const m = await page("Hello\n\nNext\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 5);
  typed(m, " /");
  assert.ok(menuOf(m));
  m.view.locked = "Read-only: unusual characters";
  assert.equal(menuOf(m), null, "read-only: the menu goes at once");
  act(m, "mdb-down");
  m.view.locked = null;
  assert.deepEqual(highlighted(m), ["text"], "and takes no keys");
  escape(m);
  escape(m);
  await m.key("cmd-e");
  m.view.source.type("/", m.cx);
  assert.equal(menuOf(m), null, "Markdown");
  reset();
  delete globalThis[INSTALLED];
  state.disk.set(FILE, "Hello\n\nNext\n");
  const cx = makeCx(), commands = [], watching = [];
  cx.settle = flush;
  cx.bind_keys = () => { throw new Error("unknown context"); };
  state.nextCommand = () => new Promise(done => commands.push(done));
  state.watchFolder = () => new Promise(done => watching.push(done));
  const view = new Editor();
  view.init({ file: FILE }, cx);
  await flush();
  fire(must(view.render(cx), "md-viewport"), "on_size_change", { width: 900, height: 600 }, cx);
  view.activate(view.doc.blocks[0].key, 5, cx);
  view.field.type(" ", cx);
  view.field.type("/", cx);
  assert.equal(view.slash, null, "no key table: Enter would be the field's own");
  delete globalThis[INSTALLED];
});

test("the pane header's Markdown toggle switches this pane's copy at every press, and a press for another pane does not", async () => {
  state.spaces = [space("s1", "docs", { tabs: [tabOf("tb1", "Main")] })];
  state.panes = [shellPane, mdPane("pa", "tb1"), mdPane("pb", "tb1")];
  state.shared[PANES] = { pa: fileKey(null, FILE) };
  farFocus("tb1", "pa");
  const m = await mount({ disk: "# Hi\n\nText.\n" });
  m.tree();
  await flush();
  assert.equal(m.view.claimed, "pa");
  const press = async (pane, n) => {
    state.shared["herdr-inline-markdown.toggle"] = { pane, n };
    m.tree();
    await fire_timers(m.cx, { ms: 0 });
    m.tree();
    await flush();
  };
  await press("pa", 1);
  assert.equal(m.view.mode, "markdown", "first press");
  await press("pa", 2);
  assert.equal(m.view.mode, "reading", "second press");
  await press("pb", 3);
  assert.equal(m.view.mode, "reading", "a press for another pane");
  await press("pa", 4);
  assert.equal(m.view.mode, "markdown", "fourth press");
  assert.deepEqual(state.shared["herdr-inline-markdown.heads"]?.pa, { name: "note.md", mode: "markdown" });
});

const FORMAT_ACTIONS = ["mdb-bold", "mdb-italic", "mdb-strike", "mdb-code", "mdb-link"];

test("Cmd+B, Cmd+I, Cmd+Shift+X and Cmd+Shift+C put marks around the selection the field holds, which stays selected inside them; the key again takes them off", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  const field = m.view.field;
  field.select(6, 11);
  act(m, "mdb-bold");
  assert.equal(m.view.text, "Hello **world**.\n\nEnd\n");
  assert.deepEqual(editing(m), [keyAt(m, 0), "Hello **world**.", { start: 8, end: 13 }]);
  act(m, "mdb-italic");
  assert.deepEqual([m.view.text, field.selection], ["Hello ***world***.\n\nEnd\n", { start: 9, end: 14 }], "italic inside bold adds a star");
  act(m, "mdb-bold");
  assert.deepEqual([m.view.text, field.selection], ["Hello *world*.\n\nEnd\n", { start: 7, end: 12 }]);
  act(m, "mdb-italic");
  assert.deepEqual([m.view.text, field.selection], ["Hello world.\n\nEnd\n", { start: 6, end: 11 }]);
  for (const [action, marked] of [["mdb-strike", "~~world~~"], ["mdb-code", "`world`"]]) {
    act(m, action);
    assert.equal(m.view.text, `Hello ${marked}.\n\nEnd\n`, action);
    act(m, action);
    assert.deepEqual([m.view.text, field.selection], ["Hello world.\n\nEnd\n", { start: 6, end: 11 }], action);
  }
  field.select(5, 11);
  act(m, "mdb-bold");
  assert.deepEqual([m.view.text, field.selection], ["Hello **world**.\n\nEnd\n", { start: 8, end: 13 }], "the space before the word stays outside the marks");
  await m.save();
  assert.equal(state.disk.get(FILE), "Hello **world**.\n\nEnd\n");
});

test("a format key on a caret in a word marks the word, the caret staying in it; on a caret elsewhere it writes the marks around it", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  const field = m.view.field;
  field.select(8);
  act(m, "mdb-bold");
  assert.deepEqual([m.view.text, field.selection], ["Hello **world**.\n\nEnd\n", { start: 10, end: 10 }]);
  act(m, "mdb-bold");
  assert.deepEqual([m.view.text, field.selection], ["Hello world.\n\nEnd\n", { start: 8, end: 8 }]);
  field.select(5);
  act(m, "mdb-italic");
  assert.deepEqual([m.view.text, field.selection], ["Hello** world.\n\nEnd\n", { start: 6, end: 6 }]);
  field.type("x", m.cx);
  assert.equal(m.view.text, "Hello*x* world.\n\nEnd\n", "what is typed next goes between the marks");
});

test("one Cmd+Z takes back one format key and puts back the text and the selection there was; Cmd+Shift+Z formats again with its selection", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  m.view.field.select(6, 11);
  act(m, "mdb-bold");
  act(m, "mdb-strike");
  assert.equal(m.view.text, "Hello **~~world~~**.\n\nEnd\n");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Hello **world**.\n\nEnd\n", keyAt(m, 0), "Hello **world**.", { start: 8, end: 13 }]);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Hello world.\n\nEnd\n", keyAt(m, 0), "Hello world.", { start: 6, end: 11 }]);
  act(m, "mdb-redo");
  assert.deepEqual([m.view.text, ...editing(m)], ["Hello **world**.\n\nEnd\n", keyAt(m, 0), "Hello **world**.", { start: 8, end: 13 }]);
  m.view.field.select(15);
  m.view.field.type("!", m.cx);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Hello **world**.\n\nEnd\n", "typing after a format key is an entry of its own");
  m.view.field.select(9);
  act(m, "mdb-code");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, m.view.field.selection], ["Hello **world**.\n\nEnd\n", { start: 9, end: 9 }], "a caret in a word comes back where it was");
});

test("Cmd+K links the selection with the caret in the parentheses, or with the web address the clipboard holds and the caret after it", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  const field = m.view.field;
  m.cx.held = undefined;
  field.select(6, 11);
  act(m, "mdb-link");
  assert.deepEqual([m.view.text, field.selection], ["Hello [world]().\n\nEnd\n", { start: 14, end: 14 }]);
  field.type("https://a.org", m.cx);
  assert.equal(m.view.text, "Hello [world](https://a.org).\n\nEnd\n");
  act(m, "mdb-undo");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, field.selection], ["Hello world.\n\nEnd\n", { start: 6, end: 11 }]);
  m.cx.held = "  https://example.com/page\n";
  act(m, "mdb-link");
  assert.deepEqual([m.view.text, field.selection], ["Hello [world](https://example.com/page).\n\nEnd\n", { start: 39, end: 39 }]);
  const log = field.log.length;
  field.select(8, 10);
  act(m, "mdb-link");
  assert.equal(m.view.text, "Hello [world](https://example.com/page).\n\nEnd\n", "a link's text is not linked again");
  assert.deepEqual(replaces(field, log), []);
});

test("a heading and a list item keep their hidden # and - when their text is formatted", async () => {
  const m = await page("# Title\n\n- one\n- two\n", { 0: 35, 1: 38, 2: 30 });
  await openBlock(m, 0);
  assert.equal(m.view.field.value(), "Title");
  m.view.field.select(0, 5);
  act(m, "mdb-bold");
  assert.deepEqual([m.view.text, m.view.field.value(), m.view.field.selection], ["# **Title**\n\n- one\n- two\n", "**Title**", { start: 2, end: 7 }]);
  await openBlock(m, 2);
  assert.equal(m.view.field.value(), "two");
  m.view.field.select(1);
  act(m, "mdb-code");
  assert.deepEqual([m.view.text, m.view.field.value(), m.view.field.selection], ["# **Title**\n\n- one\n- `two`\n", "`two`", { start: 2, end: 2 }]);
  assert.deepEqual(m.view.doc.blocks.map(b => b.kind), ["heading", "item", "item"]);
});

test("the paragraph a first letter writes below the last block can be formatted, and so can the empty one before it", async () => {
  const m = await page("Intro\n", { 0: 24 });
  await clickAt(m, { x: X + 50, y: 28 + m.view.sums[1] + 40 });
  assert.ok(pendingOf(m), "not written yet");
  typed(m, "bold");
  assert.equal(m.view.text, "Intro\n\nbold\n");
  m.view.field.select(0, 4);
  act(m, "mdb-bold");
  assert.deepEqual([m.view.text, m.view.field.value(), m.view.field.selection], ["Intro\n\n**bold**\n", "**bold**", { start: 2, end: 6 }]);
  reset();
  const e = await page("Intro\n", { 0: 24 });
  await clickAt(e, { x: X + 50, y: 28 + e.view.sums[1] + 40 });
  assert.ok(pendingOf(e));
  act(e, "mdb-italic");
  assert.deepEqual([e.view.field.value(), e.view.field.selection], ["**", { start: 1, end: 1 }]);
  typed(e, "x");
  assert.equal(e.view.text, "Intro\n\n*x*\n");
  await e.save();
  assert.equal(state.disk.get(FILE), "Intro\n\n*x*\n");
});

test("in a code block or a table the format actions change nothing", async () => {
  const doc = "Hello\n\n```\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const m = await page(doc, { 0: 24, 1: 14 + 26 + 19.5, 2: 14 + 26 + 60 });
  for (const i of [1, 2]) {
    await openBlock(m, i);
    const field = m.view.field, log = field.log.length;
    field.select(0, 3);
    for (const name of FORMAT_ACTIONS) act(m, name);
    assert.deepEqual([m.view.text, replaces(field, log), m.view.history.canUndo], [doc, [], false], m.view.doc.blocks[i].kind);
  }
});

test("a format key closes the slash menu first", async () => {
  const m = await page(THREE, { 0: 24, 1: 38, 2: 38 });
  await emptied(m, 1);
  typed(m, "/");
  assert.ok(menuOf(m));
  act(m, "mdb-bold");
  assert.deepEqual([menuOf(m), m.view.slash, m.view.text], [null, null, "Intro\n\n/****\n\nOutro\n"]);
});

test("offsets after an emoji in the field fall in the right place of the file", async () => {
  const m = await page("Intro\n\n😀 hello world\n", { 0: 24, 1: 38 });
  await openBlock(m, 1);
  m.view.field.select(3, 8);
  act(m, "mdb-bold");
  assert.deepEqual([m.view.text, m.view.field.selection], ["Intro\n\n😀 **hello** world\n", { start: 5, end: 10 }]);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, m.view.field.selection], ["Intro\n\n😀 hello world\n", { start: 3, end: 8 }]);
});

test("bold or strikethrough around nothing in the block below the last one waits for a letter, as alone its marks would make a rule or a code fence", async () => {
  for (const [action, marks, written] of [["mdb-bold", "****", "**x**"], ["mdb-strike", "~~~~", "~~x~~"]]) {
    reset();
    const m = await page("Intro\n", { 0: 24 });
    await clickAt(m, { x: X + 50, y: 28 + m.view.sums[1] + 40 });
    act(m, action);
    assert.deepEqual([m.view.text, m.view.field.value(), m.view.field.selection, Boolean(pendingOf(m))], ["Intro\n", marks, { start: 2, end: 2 }, true], action);
    act(m, action);
    assert.deepEqual([m.view.text, m.view.field.value(), Boolean(pendingOf(m))], ["Intro\n", "", true], `${action} again takes them away`);
    act(m, action);
    typed(m, "x");
    assert.deepEqual([m.view.text, m.view.field.value(), m.view.doc.blocks.map(b => b.kind)], [`Intro\n\n${written}\n`, written, ["paragraph", "paragraph"]], action);
    await m.save();
    assert.equal(state.disk.get(FILE), `Intro\n\n${written}\n`, action);
  }
});

test("marks around a selection across the line breaks of a hard-wrapped paragraph, quote or item leave those breaks in the file", async () => {
  for (const [doc, select, action, marked] of [
    ["Para one\nline two\n\nEnd\n", [5, 13], "mdb-italic", "Para *one\nline* two\n\nEnd\n"],
    ["> one\n> two\n\nEnd\n", [0, 7], "mdb-bold", "> **one\n> two**\n\nEnd\n"],
    ["- item one\n  more\n\nEnd\n", [5, 13], "mdb-strike", "- item ~~one\n  more~~\n\nEnd\n"],
    ["Para one\nline two\n\nEnd\n", [5, 13], "mdb-link", "Para [one\nline]() two\n\nEnd\n"],
  ]) {
    reset();
    const m = await page(doc, { 0: 60, 1: 38 });
    await openBlock(m, 0);
    const shown = m.view.field.value();
    m.view.field.select(...select);
    act(m, action);
    assert.equal(m.view.text, marked, action);
    if (action !== "mdb-link") {
      act(m, action);
      assert.deepEqual([m.view.text, m.view.field.value()], [doc, shown], `${action} again`);
      act(m, action);
    }
    act(m, "mdb-undo");
    assert.deepEqual([m.view.text, m.view.field.selection], [doc, { start: select[0], end: select[1] }], `${action}: one undo`);
  }
});

const FORMAT_MARKS = ["bold", "italic", "strike", "code", "link"];
const barOf = m => find(m.tree(), "md-format");
const barButtons = m => all(must(m.tree(), "md-format"), n => /^md-format-/.test(n.id ?? "")).map(n => n.id.slice("md-format-".length));
const pressedMarks = m => FORMAT_MARKS.filter(mark => must(m.tree(), `md-format-${mark}`).style.bg === "selected");
const barPress = (m, mark) => fire(must(m.tree(), `md-format-${mark}`), "on_mouse_down:left", press({ x: 0, y: 0 }), m.cx);
const fieldKeyUp = (m, keystroke, key, modifiers) => fire(must(m.tree(), `md-field-${m.view.activeKey}`), "on_key_up", { key, keystroke, modifiers: { ...NO_MODS, ...modifiers } }, m.cx);
// A press in the field being edited that leaves [start, end) selected (a drag, or a double-click on a word), read out
// 30 ms after its mouse-up.
async function selectByMouse(m, start, end, clicks = 1) {
  const p = { x: X + 20, y: topOf(m, m.view.at.get(m.view.activeKey)) + 10 }, wrap = () => must(m.tree(), `md-field-${m.view.activeKey}`);
  fire(wrap(), "on_mouse_down:left", press(p, { click_count: clicks }), m.cx);
  m.view.field.select(start, end);
  fire(wrap(), "on_mouse_up:left", press(p, { click_count: clicks }), m.cx);
  await flush();
  await fire_timers(m.cx, { ms: 30 });
}

test("a drag or a double-click that leaves text selected in the paragraph being edited shows the format bar over the page: Bold, Italic, Strikethrough, Code and Link, each naming its key", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  assert.equal(barOf(m), null, "a caret: no bar");
  await selectByMouse(m, 6, 11);
  assert.ok(barOf(m), "after the drag's readout");
  const buttons = [...FORMAT_MARKS, "comment"];
  assert.deepEqual(barButtons(m), buttons);
  const t = m.tree();
  assert.deepEqual(buttons.map(k => must(t, `md-format-${k}`).style.tooltip), ["Bold (Cmd+B)", "Italic (Cmd+I)", "Strikethrough (Cmd+Shift+X)", "Code (Cmd+Shift+C)", "Link (Cmd+K)", "Comment (Cmd+Alt+M)"]);
  assert.deepEqual(buttons.map(k => all(must(t, `md-format-${k}`), n => n.kind === "svg")[0].path), ["bold", "italic", "strikethrough", "code", "link", "message-square-plus"].map(icon => `mods/herdr-inline-markdown/${icon}.svg`));
  assert.deepEqual(must(t, "md-viewport").kids.map(k => k.id), ["md-scroller", "md-format", "md-cal"], "over the page, before the calibration strip");
  audit(t);
  await selectByMouse(m, 3, 3);
  assert.equal(barOf(m), null, "a click: its readout finds a caret");
  await selectByMouse(m, 0, 5, 2);
  assert.ok(barOf(m), "a double-click on a word");
});

test("the key-up readout after Shift+arrows or Cmd+A shows the format bar; one that finds a caret, or only a space selected, takes it away", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0, 6);
  m.view.field.select(6, 8);
  keyUp(m, "right", { shift: true });
  await flush();
  assert.ok(barOf(m), "Shift+Right");
  m.view.field.select(8);
  keyUp(m, "right");
  await flush();
  assert.equal(barOf(m), null, "Right left a caret");
  m.view.field.select(0, 12);
  fieldKeyUp(m, "cmd-a", "a", { platform: true });
  await flush();
  assert.ok(barOf(m), "Cmd+A");
  m.view.field.select(5, 6);
  keyUp(m, "left", { shift: true });
  await flush();
  assert.equal(barOf(m), null, "a space alone");
});

// A drag over the page from column `a` to column `b` of block i's first row, as a press on its rendered text makes it.
async function dragOnPage(m, i, a, b) {
  const advance = STYLES.p.size * 0.47, y = topOf(m, i) + 14 + 10, at = col => ({ x: X + col * advance + 1, y });
  const vp = () => must(m.tree(), "md-viewport");
  fire(vp(), "on_mouse_down:left", press(at(a)), m.cx);
  fire(vp(), "on_mouse_move", { position: at(b), local_position: at(b), modifiers: NO_MODS, pressed_button: "left" }, m.cx);
  fire(vp(), "on_mouse_up:left", press(at(b), { click_count: 0 }), m.cx);
  await flush();
}
const selectedText = m => {
  const r = m.view.field.selected_range();
  return m.view.field.value().slice(r.start, r.end);
};

test("a drag across a paragraph not being edited opens it with the words it crossed selected, whole, and the format bar over them", async () => {
  const doc = "Intro words\n\nThe **quick** brown fox\n\nEnd\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 38 });
  await dragOnPage(m, 1, 11, 17);
  assert.deepEqual([m.view.activeKey, selectedText(m)], [keyAt(m, 1), "brown fox"], "from inside `brown` to inside `fox`");
  assert.ok(barOf(m), "the bar shows at once");
  assert.equal(m.view.text, doc, "nothing written");
  const n = await page(doc, { 0: 24, 1: 38, 2: 38 });
  await dragOnPage(n, 1, 17, 11);
  assert.deepEqual([n.view.activeKey, selectedText(n)], [keyAt(n, 1), "brown fox"], "the same drawn backwards");
  assert.ok(barOf(n));
});

test("a drag in the edited paragraph whose mouse-up lands beside its field still reads the selection and shows the format bar", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  const inside = { x: X + 20, y: topOf(m, 0) + 10 }, beside = { x: 12, y: topOf(m, 0) + 10 };
  fire(must(m.tree(), `md-field-${keyAt(m, 0)}`), "on_mouse_down:left", press(inside), m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", press(inside), m.cx);
  m.view.field.select(6, 11);
  fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press(beside, { click_count: 0 }), m.cx);
  await flush();
  await fire_timers(m.cx, { ms: 30 });
  assert.equal(selectedText(m), "world");
  assert.ok(barOf(m), "read after the mouse-up the page heard");
});

test("a double-click whose second press reaches the page, before the paragraph it opened is drawn as a field, selects the word under it", async () => {
  const m = await page("Intro words\n\nThe **quick** brown fox\n\nEnd\n", { 0: 24, 1: 38, 2: 38 });
  const advance = STYLES.p.size * 0.47, p = { x: X + 12 * advance + 1, y: topOf(m, 1) + 14 + 10 };
  await clickAt(m, p);
  assert.equal(m.view.activeKey, keyAt(m, 1), "the first click opens it");
  fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", press(p, { click_count: 2 }), m.cx);
  fire(must(m.tree(), "md-viewport"), "on_mouse_up:left", press(p, { click_count: 2 }), m.cx);
  await flush();
  assert.equal(selectedText(m), "brown");
  assert.ok(barOf(m));
});

test("a drag inside a code block not being edited leaves its rendered text selected and the editing where it was", async () => {
  const m = await page("First words\n\n```\nlet code = 1\n```\n", { 0: 24, 1: 60 });
  await openBlock(m, 0, 5);
  await dragOnPage(m, 1, 1, 6);
  assert.deepEqual([m.view.activeKey, barOf(m)], [keyAt(m, 0), null]);
});

test("the format bar shows in a heading, an item and a quote; not in a code block or a table, in the Markdown view, or once the file can't be edited", async () => {
  const doc = "# Title words\n\n- item words\n\n> quote words\n\n```\ncode words\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const m = await page(doc, { 0: 35, 1: 30, 2: 38, 3: 14 + 26 + 19.5, 4: 14 + 26 + 60 });
  for (const i of [0, 1, 2]) {
    await openBlock(m, i);
    await selectByMouse(m, 0, 5);
    assert.ok(barOf(m), m.view.doc.blocks[i].kind);
  }
  for (const i of [3, 4]) {
    await openBlock(m, i);
    await selectByMouse(m, 4, 8);
    assert.equal(barOf(m), null, m.view.doc.blocks[i].kind);
  }
  await openBlock(m, 0);
  await selectByMouse(m, 0, 5);
  assert.ok(barOf(m));
  await m.key("cmd-e");
  assert.equal(m.view.mode, "markdown");
  await m.key("cmd-e");
  assert.equal(barOf(m), null, "after Markdown and back");
  await openBlock(m, 0);
  await selectByMouse(m, 0, 5);
  assert.ok(barOf(m));
  m.view.locked = "Read-only: unusual characters";
  assert.equal(barOf(m), null, "read-only: the bar goes at once");
});

test("the format bar and the slash menu never show together: typing a space and / over the selection opens the menu, and a Shift+arrow selection closes it for the bar", async () => {
  const m = await page("Hello world\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 6, 11);
  typed(m, " /");
  assert.deepEqual([m.view.field.value(), Boolean(menuOf(m)), barOf(m)], ["Hello  /", true, null]);
  m.view.field.select(7, 8);
  keyUp(m, "left", { shift: true });
  await flush();
  assert.deepEqual([menuOf(m), Boolean(barOf(m))], [null, true]);
});

test("the format bar goes when the field is typed in, a press lands beside it, another block opens, the block is rewritten from outside or the field loses the keyboard; a change elsewhere in the file keeps it", async () => {
  const opened = async () => {
    reset();
    const m = await page("Hello world.\n\nNext\n", { 0: 24, 1: 38 });
    await openBlock(m, 0);
    await selectByMouse(m, 6, 11);
    assert.ok(barOf(m), "open");
    return m;
  };
  let m = await opened();
  m.view.field.type("x", m.cx);
  assert.deepEqual([barOf(m), m.view.text], [null, "Hello x.\n\nNext\n"], "typing");
  m = await opened();
  fire(must(m.tree(), "md-format"), "on_mouse_down_out", press({ x: 600, y: 300 }), m.cx);
  assert.equal(barOf(m), null, "a press outside it");
  m = await opened();
  fire(must(m.tree(), "md-viewport"), "on_mouse_down:left", press({ x: 600, y: 300 }), m.cx);
  assert.equal(barOf(m), null, "a press on the page");
  m = await opened();
  await clickAt(m, { x: X + 2, y: topOf(m, 1) + 14 + 5 });
  assert.deepEqual([m.view.activeKey, barOf(m)], [keyAt(m, 1), null], "another block opened");
  m = await opened();
  state.disk.set(FILE, "Hello world.\n\nNext\n\nAgent line\n");
  await m.touch([FILE]);
  assert.ok(barOf(m), "a change elsewhere keeps it");
  state.disk.set(FILE, "Oh hello world.\n\nNext\n\nAgent line\n");
  await m.touch([FILE]);
  assert.deepEqual([m.view.field.value(), barOf(m)], ["Oh hello world.", null], "the block rewritten from outside");
  m = await opened();
  m.view.field.blur(m.cx);
  assert.equal(barOf(m), null, "the field lost the keyboard");
});

test("Escape closes the format bar and keeps the selection; a second Escape stops editing", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 6, 11);
  escape(m);
  assert.deepEqual([barOf(m), ...editing(m)], [null, keyAt(m, 0), "Hello world.", { start: 6, end: 11 }]);
  escape(m);
  assert.equal(m.view.activeKey, null);
});

test("the format bar sits over the selection's first row at its start column, under its last row when there is no room above", async () => {
  const { h } = barSize(5), advance = STYLES.p.size * 0.47;
  const m = await page("Intro\n\nHello world.\n\nEnd\n", { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1);
  await selectByMouse(m, 6, 11);
  const row = topOf(m, 1) + 14;
  assert.deepEqual([barOf(m).style.top, barOf(m).style.left], [row - BAR.gap - h, X + 6 * advance], "over the row, its left edge at 'world'");
  await openBlock(m, 0);
  await selectByMouse(m, 0, 5);
  assert.deepEqual([barOf(m).style.top, barOf(m).style.left], [topOf(m, 0) + 24 + BAR.gap, X], "no room over the first block's row: under it");
  reset();
  const n = await page("Para one\nline two\n\nEnd\n", { 0: 48, 1: 38 });
  await openBlock(n, 0);
  await selectByMouse(n, 5, 13);
  assert.deepEqual([barOf(n).style.top, barOf(n).style.left], [topOf(n, 0) + 2 * 24 + BAR.gap, X + 5 * advance], "under the last of two rows, at the start's column");
});

test("the format bar moves with the page as it scrolls, hidden while its row is off the page and back when it returns", async () => {
  const { h } = barSize(5);
  const m = await tall(200);
  await openBlock(m, 3);
  await selectByMouse(m, 0, 9);
  const row = topOf(m, 3) + 14;
  assert.equal(barOf(m).style.top, row - BAR.gap - h);
  wheel(m, -30);
  assert.equal(barOf(m).style.top, row - 30 - BAR.gap - h, "up with the page");
  wheel(m, -150);
  assert.equal(barOf(m), null, "its row is above the page");
  wheel(m, 180);
  assert.equal(barOf(m).style.top, row - BAR.gap - h, "back with its row");
});

test("a press on a bar button does what its key does: the selection stays inside the marks and the bar stays, its button pressed, so marks stack; a second press takes the mark off", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 6, 11);
  assert.deepEqual(pressedMarks(m), []);
  for (const [mark, marked, n] of [["bold", "**world**", 2], ["italic", "*world*", 1], ["strike", "~~world~~", 2], ["code", "`world`", 1]]) {
    const stopped = m.cx.stopped;
    barPress(m, mark);
    assert.equal(m.cx.stopped - stopped, 1, `${mark}: the press goes no further`);
    assert.deepEqual([m.view.text, ...editing(m)], [`Hello ${marked}.\n\nEnd\n`, keyAt(m, 0), `Hello ${marked}.`, { start: 6 + n, end: 11 + n }], mark);
    assert.deepEqual(pressedMarks(m), [mark], `${mark}: the bar stays, its button pressed`);
    barPress(m, mark);
    assert.deepEqual([m.view.text, m.view.field.selection, pressedMarks(m)], ["Hello world.\n\nEnd\n", { start: 6, end: 11 }, []], `${mark} again`);
  }
  barPress(m, "bold");
  barPress(m, "italic");
  assert.deepEqual([m.view.text, m.view.field.selection, pressedMarks(m)], ["Hello ***world***.\n\nEnd\n", { start: 9, end: 14 }, ["bold", "italic"]], "stacked");
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, m.view.field.selection], ["Hello **world**.\n\nEnd\n", { start: 8, end: 13 }], "one Cmd+Z per press");
});

test("a format key with the bar open keeps it open over the marked text, showing the new state", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 6, 11);
  act(m, "mdb-strike");
  assert.deepEqual([m.view.text, pressedMarks(m)], ["Hello ~~world~~.\n\nEnd\n", ["strike"]]);
});

test("a button shows pressed while its mark is on the selection, by the test its key takes the mark off with", async () => {
  const m = await page("Say **bold** and *it* and ~~gone~~ and `code` and [link](https://a.org).\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  const value = m.view.field.value(), span = word => [value.indexOf(word), value.indexOf(word) + word.length];
  for (const [word, marks] of [["bold", ["bold"]], ["it", ["italic"]], ["gone", ["strike"]], ["code", ["code"]], ["link", ["link"]], ["and", []], ["**bold**", ["bold"]]]) {
    await selectByMouse(m, ...span(word));
    assert.deepEqual(pressedMarks(m), marks, word);
  }
});

test("Link on the bar closes it, the caret left in the parentheses or after the clipboard's address; inside a link it shows pressed and changes nothing", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  m.cx.held = undefined;
  await selectByMouse(m, 6, 11);
  barPress(m, "link");
  assert.deepEqual([m.view.text, m.view.field.selection, barOf(m)], ["Hello [world]().\n\nEnd\n", { start: 14, end: 14 }, null]);
  act(m, "mdb-undo");
  assert.equal(m.view.text, "Hello world.\n\nEnd\n");
  m.cx.held = "https://a.org";
  await selectByMouse(m, 6, 11);
  barPress(m, "link");
  assert.deepEqual([m.view.text, m.view.field.selection, barOf(m)], ["Hello [world](https://a.org).\n\nEnd\n", { start: 28, end: 28 }, null]);
  await selectByMouse(m, 7, 12);
  assert.deepEqual(pressedMarks(m), ["link"]);
  const log = m.view.field.log.length;
  barPress(m, "link");
  assert.deepEqual([m.view.text, replaces(m.view.field, log), Boolean(barOf(m))], ["Hello [world](https://a.org).\n\nEnd\n", [], true], "a link is left as it is");
});

test("presses and pointer moves on the format bar go no further than it, so the page and the field under it take nothing", async () => {
  const m = await page("Plain words\n\nHello world.\n\nMore plain words\n", { 0: 24, 1: 38, 2: 38 });
  calibrate(m);
  await openBlock(m, 1);
  await selectByMouse(m, 6, 11);
  const stopped = m.cx.stopped, p = { x: X + 60, y: topOf(m, 1) };
  fire(must(m.tree(), "md-format"), "on_mouse_move", { position: p, local_position: p, modifiers: NO_MODS }, m.cx);
  fire(must(m.tree(), "md-format"), "on_mouse_down:left", press(p), m.cx);
  fire(must(m.tree(), "md-format"), "on_mouse_up:left", press(p), m.cx);
  assert.equal(m.cx.stopped - stopped, 3, "none of them goes on");
  await flush();
  assert.deepEqual([Boolean(barOf(m)), m.view.press, m.view.sel, ...editing(m)], [true, null, null, keyAt(m, 1), "Hello world.", { start: 6, end: 11 }], "a press on its padding changes nothing");
});

const noteBoxOf = m => find(m.tree(), "md-note");
const writeNote = (m, text) => m.view.noteField.set_value(text);
const saveNote = m => m.view.noteField.submit(m.cx);
const cardOf = m => find(m.tree(), "md-notes-card");
const badgeOf = (m, i) => find(m.tree(), `md-notes-${keyAt(m, i)}`);
const cardPress = (m, id) => fire(must(m.tree(), id), "on_mouse_down:left", press({ x: 0, y: 0 }), m.cx);
// A click on block i's comment count, which sits right of the 716 px text column of a 900 px pane.
const clickCount = (m, i) => clickAt(m, { x: X + 716 + NOTES.gap + 5, y: topOf(m, i) + m.view.data.get(keyAt(m, i)).notesY + 5 });

test("Cmd+Alt+M on a selection opens the comment box where the bar was, holding the keyboard; Enter writes {==…==}{>>…<<} as one undo step and the field gets the keyboard back, the caret after it", async () => {
  const advance = STYLES.p.size * 0.47;
  const m = await page("Intro\n\nHello world.\n\nEnd\n", { 0: 24, 1: 38, 2: 38 });
  await openBlock(m, 1);
  await selectByMouse(m, 6, 11);
  assert.ok(barOf(m));
  act(m, "mdb-comment");
  const t = m.tree(), box = must(t, "md-note");
  assert.equal(barOf(m), null, "the bar gives way to the box");
  assert.equal(box.style.key_context, NOTE);
  assert.equal(all(box, n => n.kind === "input")[0].state, m.view.noteField);
  assert.deepEqual([box.style.top, box.style.left, box.style.w], [topOf(m, 1) + 14 - BAR.gap - NOTE_BOX.h, X + 6 * advance, NOTE_BOX.w], "over the selection, as the bar");
  assert.deepEqual([m.view.noteField.focused, m.view.noteField.value()], [true, ""]);
  assert.deepEqual(editing(m), [keyAt(m, 1), "Hello world.", { start: 6, end: 11 }], "the field keeps its selection");
  audit(t);
  m.view.field.focused = false;
  writeNote(m, "too early?");
  saveNote(m);
  const after = "Hello {==world==}{>>too early?<<}".length;
  assert.equal(m.view.text, "Intro\n\nHello {==world==}{>>too early?<<}.\n\nEnd\n");
  assert.deepEqual([noteBoxOf(m), ...editing(m), m.view.field.focused], [null, keyAt(m, 1), "Hello {==world==}{>>too early?<<}.", { start: after, end: after }, true]);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, m.view.field.selection], ["Intro\n\nHello world.\n\nEnd\n", { start: 6, end: 11 }], "one Cmd+Z, the selection back");
});

test("the bar's Comment button opens the same box, and is never shown pressed", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 6, 11);
  assert.notEqual(must(m.tree(), "md-format-comment").style.bg, "selected");
  const stopped = m.cx.stopped;
  barPress(m, "comment");
  assert.equal(m.cx.stopped - stopped, 1, "the press goes no further");
  assert.deepEqual([Boolean(noteBoxOf(m)), barOf(m), m.view.noteField.focused], [true, null, true]);
  writeNote(m, "a\nb");
  saveNote(m);
  assert.equal(m.view.text, "Hello {==world==}{>>a b<<}.\n\nEnd\n", "one line");
});

test("Escape in the comment box writes nothing and gives the field its selection back; so does an empty comment", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 6, 11);
  act(m, "mdb-comment");
  writeNote(m, "never mind");
  m.view.field.focused = false;
  act(m, "mdb-note-cancel");
  assert.deepEqual([noteBoxOf(m), m.view.text, ...editing(m), m.view.field.focused, m.view.history.canUndo], [null, "Hello world.\n\nEnd\n", keyAt(m, 0), "Hello world.", { start: 6, end: 11 }, true, false]);
  act(m, "mdb-comment");
  assert.equal(m.view.noteField.value(), "", "a new box starts empty");
  writeNote(m, "  \n ");
  saveNote(m);
  assert.deepEqual([noteBoxOf(m), m.view.text, ...editing(m), m.view.history.canUndo], [null, "Hello world.\n\nEnd\n", keyAt(m, 0), "Hello world.", { start: 6, end: 11 }, false]);
});

test("Cmd+Alt+M at a plain caret writes a point comment there", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 5, 5);
  act(m, "mdb-comment");
  assert.ok(noteBoxOf(m), "a caret gets the box too");
  writeNote(m, "here");
  saveNote(m);
  const after = "Hello{>>here<<}".length;
  assert.deepEqual([m.view.text, m.view.field.selection], ["Hello{>>here<<} world.\n\nEnd\n", { start: after, end: after }]);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, m.view.field.selection], ["Hello world.\n\nEnd\n", { start: 5, end: 5 }]);
});

test("a selection that would cut through a comment's marks, or reach into code, gets a notice and no box", async () => {
  const m = await page("Hello {==world==}{>>n<<} here, `code` too.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 9, 30);
  act(m, "mdb-comment");
  assert.deepEqual([noteBoxOf(m), calls.notify], [null, [{ title: "A comment can't cut through another one", level: "info" }]]);
  const code = m.view.field.value().indexOf("code");
  await selectByMouse(m, code + 1, code + 3);
  act(m, "mdb-comment");
  assert.deepEqual([noteBoxOf(m), calls.notify.at(-1)], [null, { title: "Comments can't go in code", level: "info" }]);
  assert.equal(m.view.text, "Hello {==world==}{>>n<<} here, `code` too.\n\nEnd\n");
});

test("Reading draws marked text highlighted in the theme's yellow, the marks and the comment left out and a point comment a marker; the field shows them as written", async () => {
  state.theme = { ...theme(), ansi3: "#E5C07B" };
  const m = await page("Hello {==big **world**==}{>>note<<}, again{>>p<<}.\n\nEnd\n", { 0: 24, 1: 38 });
  const lit = inner => `<mark color="#e5c07b55">${inner}</mark>`;
  assert.equal(viewAt(m, 0).markdown, `Hello ${lit("big **world**")}, again${lit(POINT)}.`);
  state.theme = { ...theme(), ansi3: "#c18401" };
  m.tree();
  await fire_timers(m.cx, { ms: 0 });
  assert.equal(viewAt(m, 0).markdown, `Hello <mark color="#c1840155">big **world**</mark>, again<mark color="#c1840155">${POINT}</mark>.`, "a new theme, its yellow");
  await openBlock(m, 0);
  assert.equal(m.view.field.value(), "Hello {==big **world**==}{>>note<<}, again{>>p<<}.");
});

test("a block with comments shows their count right of its first row; a click on it opens a card of its comments: the marked text, the comment, Edit and Resolve", async () => {
  const doc = "A {==b==}{>>first<<} c {>>second<<}.\n\nOnly {==lit==}.\n\n```\n{>>code<<}\n```\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 14 + 26 + 19.5 });
  let t = m.tree();
  const badge = must(t, `md-notes-${keyAt(m, 0)}`);
  assert.deepEqual([textOf(badge).trim(), badge.style.left, badge.style.top], ["2", 716 + NOTES.gap, (24 - NOTES.h) / 2]);
  assert.deepEqual(all(t, n => /^md-notes-/.test(n.id ?? "")).map(n => n.id), [`md-notes-${keyAt(m, 0)}`], "a highlight alone, or code, has none");
  await clickCount(m, 0);
  t = m.tree();
  const card = must(t, "md-notes-card");
  assert.equal(m.view.activeKey, null, "a click on the count opens no block");
  assert.deepEqual([card.style.top, card.style.left, card.style.w], [topOf(m, 0) + (24 - NOTES.h) / 2 + NOTES.h + CARD.gap, X + 716 + NOTES.gap + NOTES.w - CARD.w, CARD.w]);
  assert.match(textOf(must(card, "md-note-0")), /^b first Edit Resolve$/);
  assert.match(textOf(must(card, "md-note-1")), /^second Edit Resolve$/, "a point comment has no marked text");
  assert.ok(find(card, "md-note-edit-1") && find(card, "md-note-resolve-1"));
  assert.ok(typeof card.handlers.on_mouse_down_out === "function");
  audit(t);
  fire(card, "on_mouse_down_out", press({ x: 10, y: 10 }), m.cx);
  assert.equal(cardOf(m), null, "a press outside closes it");
  await clickCount(m, 0);
  await m.key("escape");
  assert.equal(cardOf(m), null, "so does Escape");
});

test("Resolve takes a comment off and keeps its marked text, one undo step each; the card follows what is left", async () => {
  const doc = "A {==b==}{>>first<<} c {>>second<<}.\n\nEnd\n";
  const m = await page(doc, { 0: 24, 1: 38 });
  await clickCount(m, 0);
  cardPress(m, "md-note-resolve-0");
  assert.equal(m.view.text, "A b c {>>second<<}.\n\nEnd\n");
  assert.deepEqual([m.view.activeKey, textOf(must(m.tree(), "md-note-0")), find(m.tree(), "md-note-1")], [null, "second Edit Resolve", null]);
  assert.equal(textOf(badgeOf(m, 0)).trim(), "1");
  cardPress(m, "md-note-resolve-0");
  assert.deepEqual([m.view.text, cardOf(m), badgeOf(m, 0)], ["A b c .\n\nEnd\n", null, null], "the last one: no card, no count");
  act(m, "mdb-undo");
  assert.equal(m.view.text, "A b c {>>second<<}.\n\nEnd\n");
  act(m, "mdb-undo");
  assert.equal(m.view.text, doc);
});

test("Edit opens the block with the marked text selected and the box holding the comment; Enter swaps it as one undo step", async () => {
  const m = await page("A {==b==}{>>first<<} c {>>second<<}.\n\nEnd\n", { 0: 24, 1: 38 });
  await clickCount(m, 0);
  cardPress(m, "md-note-edit-0");
  assert.deepEqual([...editing(m), cardOf(m), Boolean(noteBoxOf(m)), m.view.noteField.value(), m.view.noteField.focused],
    [keyAt(m, 0), "A {==b==}{>>first<<} c {>>second<<}.", { start: 5, end: 6 }, null, true, "first", true]);
  writeNote(m, "changed");
  saveNote(m);
  const after = "A {==b==}{>>changed<<}".length;
  assert.deepEqual([m.view.text, m.view.field.selection, noteBoxOf(m)], ["A {==b==}{>>changed<<} c {>>second<<}.\n\nEnd\n", { start: after, end: after }, null]);
  act(m, "mdb-undo");
  assert.deepEqual([m.view.text, m.view.field.selection], ["A {==b==}{>>first<<} c {>>second<<}.\n\nEnd\n", { start: 5, end: 6 }]);
  await escape(m);
  await clickCount(m, 0);
  cardPress(m, "md-note-edit-1");
  assert.deepEqual([m.view.field.selection, m.view.noteField.value()], [{ start: 23, end: 23 }, "second"], "a point comment: the caret where it is");
  act(m, "mdb-note-cancel");
  assert.deepEqual([noteBoxOf(m), m.view.text, m.view.field.selection], [null, "A {==b==}{>>first<<} c {>>second<<}.\n\nEnd\n", { start: 23, end: 23 }]);
});

test("a file that can't be edited shows the card without Edit and Resolve", async () => {
  const m = await mount({ machine: "devbox", disk: "A {==b==}{>>first<<} c.\n" });
  viewportOf(m);
  await heights(m, { 0: 24 });
  await clickCount(m, 0);
  const card = must(m.tree(), "md-notes-card");
  assert.equal(textOf(must(card, "md-note-0")), "b first");
  assert.deepEqual([find(card, "md-note-edit-0"), find(card, "md-note-resolve-0")], [null, null]);
});

test("the footer counts the file's comments when there are any, the block being edited as typed", async () => {
  const doc = "A {==b==}{>>one<<}.\n\n- item {>>two<<}\n\n```\n{>>not one<<}\n```\n\nPlain {==lit==} words.\n";
  const m = await page(doc, { 0: 24, 1: 38, 2: 14 + 26 + 19.5, 3: 38 });
  assert.equal(textOf(must(m.tree(), "md-comments")), "2 comments");
  await openBlock(m, 3);
  await selectByMouse(m, 0, 5);
  act(m, "mdb-comment");
  writeNote(m, "three");
  saveNote(m);
  assert.equal(textOf(must(m.tree(), "md-comments")), "3 comments", "before the block is left");
  reset();
  const plain = await page("No comments {==here==}.\n", { 0: 24 });
  assert.equal(find(plain.tree(), "md-comments"), null);
});

test("the comment box closes on a press outside it, or when the block stops being edited, writing nothing", async () => {
  const m = await page("Hello world.\n\nEnd\n", { 0: 24, 1: 38 });
  await openBlock(m, 0);
  await selectByMouse(m, 6, 11);
  act(m, "mdb-comment");
  const stopped = m.cx.stopped, box = must(m.tree(), "md-note");
  fire(box, "on_mouse_down:left", press({ x: 0, y: 0 }), m.cx);
  fire(box, "on_mouse_up:left", press({ x: 0, y: 0 }), m.cx);
  assert.equal(m.cx.stopped - stopped, 2, "presses on it go no further");
  writeNote(m, "x");
  fire(box, "on_mouse_down_out", press({ x: 600, y: 300 }), m.cx);
  assert.deepEqual([noteBoxOf(m), m.view.text], [null, "Hello world.\n\nEnd\n"]);
  act(m, "mdb-comment");
  await m.key("cmd-e");
  await m.key("cmd-e");
  assert.deepEqual([noteBoxOf(m), m.view.note, m.view.text], [null, null, "Hello world.\n\nEnd\n"], "after Markdown and back");
});
