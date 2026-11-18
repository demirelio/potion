import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { reset, state } from "./mocks/herdr.mjs";
import { all, find, fire, nodeOf, textOf } from "./mocks/element.mjs";
import { div } from "./mocks/gpui-kit.mjs";
import { makeCx, must } from "./helpers.mjs";

const { parse } = await import("../mods/herdr-inline-markdown/blocks.js");
const { POINT } = await import("../mods/herdr-inline-markdown/comments.js");
const { CODE_HEAD, NOTES } = await import("../mods/herdr-inline-markdown/geometry.js");
const { BOX, CALIBRATED, FRONT_BOX, Block, Column, STYLES, displayText, lookOf, markerOf, newOwnerId, owners, renderBlock, spaceBefore } = await import("../mods/herdr-inline-markdown/page.js");
const { gridOf } = await import("../mods/herdr-inline-markdown/grid.js");
const { TextareaState } = await import("./mocks/gpui-base.mjs");
const { TEXT, RAW } = await import("../mods/herdr-inline-markdown/keys.js");
const { piecesOf } = await import("../mods/herdr-inline-markdown/tokens.js");
const { deepHighlightColor, highlightColor } = await import("../mods/herdr-inline-markdown/colors.js");
const { theme } = await import("./mocks/herdr.mjs");

beforeEach(() => reset());

const blocksOf = text => parse(text).blocks;

// What the editor hands renderBlock for block i of `text`: its data and an owner with the fields and fonts, plus `also`.
function drawn(text, i, more = {}, also = {}) {
  const blocks = blocksOf(text), b = blocks[i], look = lookOf(b), st = STYLES[look.style];
  const d = {
    key: b.key, kind: b.kind, look: look.look, style: look.style, color: look.color, space: spaceBefore(blocks, i), depth: b.depth,
    text: look.look === "text" ? displayText(b) : look.look === "boxed" ? b.render : b.content, marker: markerOf(b),
    strip: b.kind === "code" || (b.kind === "mermaid" && more.mode === "active"), chip: "", chipW: 0, chipLive: false, chipOpen: false,
    label: b.number ? `${b.number}${b.delim}` : "", checked: Boolean(b.task?.checked), width: 600, diagram: "", mode: "rendered", rows: "many",
    gen: 0, selected: false, row: st.size * st.lh, ratio: st.lh, padRendered: 0, padActive: 0, ...more,
  };
  const owner = {
    fonts: { sans: ".SystemUIFont", mono: "Mono" }, field: TextareaState.new({ value: "" }), own: TextareaState.new({ value: "" }),
    blockField() { return this.own; },
    remote: false, shown: new Map(), good: new Map(), links: [], sizes: [], layouts: new Map(),
    link(url) { this.links.push(url); }, blockSized(key, size) { this.sizes.push([key, size]); },
    pictureOf(key, width) { this.asked = [key, width]; return this.layouts.get(key) ?? { items: [], boxes: [], height: 0 }; },
    blockButtonIn: () => null, cellField: () => null, panOf: () => 0, lineOf: () => -1, gridRoom: () => 600, gridShownW: d => Math.min(d.grid.w, 600),
    ...also,
  };
  return { d, owner, el: renderBlock(owner, d), b };
}

const HIGHLIGHT = "#f5c54255";
// An owner that draws tokens as the editor does, and keeps the clicks on them.
const tokenOwner = () => ({ highlight: HIGHLIGHT, clicks: [], tokenPieces: t => piecesOf(t.id, t.label), tokenClick(key, ev) { this.clicks.push([key, ev]); } });
const tokenCtx = (id, label, selected = false) => ({ range: { start: 0, end: 1 }, token: { id, text: "x", label }, selected, disabled: false, readonly: false, line_height: 24, available_width: 600 });
// Each piece a token draws: its text (or "icon") and its style.
function piecesDrawn(text, i, id, label, { more = {}, selected = false } = {}) {
  const { el } = drawn(text, i, { mode: "active", tokens: true, ...more }, tokenOwner()), input = all(el, n => n.kind === "textarea")[0];
  const box = nodeOf(input.token(tokenCtx(id, label, selected), makeCx()));
  const pieces = all(box, n => n.kind === "svg" || (n.kind === "div" && n.kids.some(k => k.kind === "text")));
  return { box, pieces: pieces.map(n => ({ text: n.kind === "svg" ? "icon" : textOf(n), ...n.style })) };
}

test("how Reading draws each kind, in which type and colour", () => {
  const doc = "---\na: 1\n---\n# H\n\np\n\n![x](y.png)\n\n- i\n\n> q\n\n```js\nc\n```\n\n```mermaid\ngraph TD\n```\n\n| a |\n|---|\n| b |\n\n<div>h</div>\n\n<!-- c -->\n\n[r]: /u\n\n***\n";
  assert.deepEqual(blocksOf(doc).map(b => [b.kind, ...Object.values(lookOf(b))]), [
    ["frontmatter", "small", "muted", "front"], ["heading", "h1", "foreground", "text"], ["paragraph", "p", "foreground", "text"],
    ["paragraph", "small", "dim", "picture"], ["item", "p", "foreground", "text"], ["quote", "p", "foreground", "text"],
    ["code", "mono", "foreground", "code"], ["mermaid", "mono", "foreground", "diagram"], ["table", "mono", "foreground", "boxed"],
    ["html", "mono", "foreground", "boxed"], ["html", "small", "dim", "lines"], ["definition", "small", "dim", "lines"], ["hr", "p", "muted", "rule"],
  ]);
});

test("a table the grid draws is drawn in the cell style; the header's style is the cell's at 600; both are calibrated", () => {
  const b = blocksOf("| a |\n|---|\n| b |\n")[0];
  assert.deepEqual(lookOf(b, true), { style: "cell", color: "foreground", look: "grid" });
  assert.deepEqual(lookOf(b).look, "boxed", "kept as source");
  assert.deepEqual([STYLES.cell, STYLES.head], [{ size: 14, weight: 400, lh: 1.5 }, { size: 14, weight: 600, lh: 1.5 }]);
  assert.ok(CALIBRATED.includes("cell") && CALIBRATED.includes("head"));
});

const GRID_TABLE = "| Name | Size | Note |\n|---|:-:|--:|\n| **apple** | 12 | [a](https://e.com) |\n| pear | 3 | {==ripe==}{>>2026-11-16 20:51 \\| why?<<} |\n";
// A table drawn as its grid, from the grid's data as the editor makes it.
function drawnGrid(more = {}, also = {}) {
  const doc = parse(GRID_TABLE), b = doc.blocks[0], cal = { row: 21, advance: 6.6 };
  const grid = gridOf({}, doc, b, { room: 700, head: cal, body: cal, color: HIGHLIGHT, deep: null, defs: { map: doc.defs } });
  return drawn(GRID_TABLE, 0, { look: "grid", style: "cell", text: "", grid, ...more }, { rowSized(key, r, size) { (this.rows ??= []).push([key, r, size]); }, ...also });
}

test("a table drawn as a grid: its rows and cells, each cell's text by a TextView of its own, no pipe and no delimiter row", () => {
  const { el, d, owner } = drawnGrid(), table = must(el, `md-table-${d.key}`);
  assert.deepEqual(table.kids.map(k => k.id), [0, 1, 2].map(r => `md-row-${d.key}-${r}`), "the header first, no delimiter row");
  const views = all(table, n => n.kind === "textview");
  assert.equal(views.length, 9);
  assert.deepEqual(views.map(v => v.markdown), ["Name", "Size", "Note", "**apple**", "12", "[a](https://e.com)", "pear", "3", `<mark color="${HIGHLIGHT}">ripe</mark>`]);
  assert.ok(views.every(v => !v.markdown.includes("|") && !v.markdown.includes("---")));
  assert.deepEqual(views.map(v => v.id).slice(0, 2), [`md-tv-${d.key}-0-0-0`, `md-tv-${d.key}-0-1-0`]);
  assert.ok(find(table, `md-cell-${d.key}-2-1`));
  fire(views[5], "on_link_click", "https://e.com", makeCx());
  assert.deepEqual(owner.links, ["https://e.com"], "a link clicked in a cell goes to the editor");
  fire(must(table, `md-row-${d.key}-1`), "on_size_change", { width: 300, height: 34 }, makeCx());
  assert.deepEqual(owner.rows, [[d.key, 1, { width: 300, height: 34 }]], "each row reports its height");
  const named = all(el, n => n.id !== null).map(n => n.id);
  assert.equal(new Set(named).size, named.length, "ids unique");
  assert.ok(all(el, n => Object.keys(n.handlers).length > 0).every(n => n.id), "every element with a handler has an id");
});

test("the grid's look: 1 px lines round it and between rows and columns, rounded 6 and clipped; the header on the surface at 600; cells padded 10 by 6 in the page font", () => {
  const { el, d } = drawnGrid(), table = must(el, `md-table-${d.key}`), g = d.grid;
  assert.deepEqual([table.style.w, table.style.border_1, table.style.border_color, table.style.rounded, table.style.overflow_hidden], [g.w, true, "border", 6, true]);
  const [header, middle, last] = table.kids;
  assert.deepEqual([header.style.bg, header.style.rounded_t, header.style.border_b, middle.style.bg, middle.style.border_b, last.style.border_b], ["surface", 5, 1, undefined, 1, undefined]);
  const cells = middle.kids;
  assert.deepEqual(cells.map(c => [c.style.w, c.style.px, c.style.py, c.style.border_r]), [[g.widths[0] + 1, 10, 6, 1], [g.widths[1] + 1, 10, 6, 1], [g.widths[2], 10, 6, undefined]]);
  const typeOf = (r, c) => {
    const view = all(must(table, `md-cell-${d.key}-${r}-${c}`), n => n.kind === "textview")[0], parent = all(table, n => n.kids.includes(view))[0];
    return [parent.style.font_family, parent.style.text_size, parent.style.font_weight, parent.style.line_height, parent.style.text_color];
  };
  assert.deepEqual(typeOf(0, 0), [".SystemUIFont", 14, 600, 1.5, "foreground"], "the header at 600");
  assert.deepEqual(typeOf(1, 0), [".SystemUIFont", 14, 400, 1.5, "foreground"]);
});

test("a centred column's text sits in a box as wide as the text, in the middle of its cell; a right one's at the right; left and none fill the cell", () => {
  const { el, d } = drawnGrid(), g = d.grid;
  const boxOf = (r, c) => all(must(el, `md-cell-${d.key}-${r}-${c}`), n => n.kids.some(k => k.kind === "textview"))[0];
  const centred = must(el, `md-cell-${d.key}-1-1`), right = must(el, `md-cell-${d.key}-1-2`), left = must(el, `md-cell-${d.key}-1-0`);
  assert.deepEqual([centred.style.justify_center, boxOf(1, 1).style.w], [true, g.boxes[1][1]]);
  assert.ok(g.boxes[1][1] < g.widths[1] - 20, "narrower than its cell");
  assert.deepEqual([right.style.justify_end, boxOf(1, 2).style.w], [true, g.boxes[1][2]]);
  assert.deepEqual([left.style.justify_center, left.style.justify_end, boxOf(1, 0).style.w_full], [undefined, undefined, true]);
  assert.deepEqual([must(el, `md-cell-${d.key}-0-1`).style.justify_center, boxOf(0, 1).style.w], [true, g.boxes[0][1]], "the header follows its column");
});

test("the frame of a table's active comment lies over its grid", () => {
  const { el, d } = drawnGrid({ framed: "active" }), frame = must(el, `md-comment-frame-${d.key}`);
  assert.deepEqual([frame.style.absolute, frame.style.left, frame.style.top, frame.style.w, frame.style.bottom, frame.style.rounded], [true, 0, d.space, d.grid.w, 0, 6]);
  assert.equal(frame.style.right, undefined, "as wide as the grid, not the column");
});

test("space above a block: 0 first, 32 / 28 / 24 / 20 above headings, 8 after one, 6 inside a list, 14 otherwise", () => {
  const spaces = text => blocksOf(text).map((_, i, all) => spaceBefore(all, i));
  assert.deepEqual(spaces("# a\n## b\n### c\n#### d\n##### e\n###### f\n"), [0, 28, 24, 20, 20, 20]);
  assert.deepEqual(spaces("p\n\n# a\n\nq\n\n```\nx\n```\n"), [0, 32, 8, 14]);
  assert.deepEqual(spaces("- a\n  - b\n- c\n\n  more\n- d\n"), [0, 6, 6, 6, 6], "items of one list at any depth, and an item's continuation");
  assert.deepEqual(spaces("- a\n\n1. b\n\npara\n"), [0, 14, 14], "another list, and a paragraph after a list");
});

test("markers: dot, ring, square by depth; numbers; task boxes", () => {
  assert.deepEqual(blocksOf("- a\n  - b\n    - c\n      - d\n1. n\n- [ ] t\n\np\n").map(markerOf), ["dot", "ring", "square", "dot", "number", "task", null]);
});

test("TextView text: a heading's text that would start a block is escaped; inline marks are left alone", () => {
  const head = text => displayText(blocksOf(`# ${text}\n`)[0]);
  assert.equal(head("1. Intro"), "1\\. Intro");
  assert.equal(head("12) Twelve"), "12\\) Twelve");
  assert.equal(head("- a"), "\\- a");
  assert.equal(head("+ a"), "\\+ a");
  assert.equal(head("> a"), "\\> a");
  assert.equal(head("```"), "\\```");
  assert.equal(head("***"), "\\***");
  assert.equal(head("*emphasis* stays"), "*emphasis* stays");
  assert.equal(head("-dash"), "-dash");
  assert.equal(head("2024 was a year"), "2024 was a year");
  assert.equal(head("[a]: https://x"), "[a]\\: https://x", "a link reference definition's colon");
});

test("TextView text: continuation lines are indented past anything that could interrupt, line breaks kept, definitions kept apart", () => {
  assert.deepEqual(blocksOf("foo\n- bar\n").map(b => b.kind), ["paragraph", "item"], "a bullet at the margin interrupts a paragraph");
  const [lazy] = blocksOf("foo\n    - bar\nbaz  \nqux\n");
  assert.equal(displayText(lazy), "foo\n    - bar\n    baz  \n    qux");
  const [item] = blocksOf("- first\n  second line\n");
  assert.equal(displayText(item), "first\n    second line");
  const [quote] = blocksOf("> - a\n> - b\n");
  assert.equal(displayText(quote), "- a\n- b", "a quote's inside is left to TextView");
  const [linked] = blocksOf("see [x]\nnext\n\n[x]: https://e.com\n");
  assert.equal(displayText(linked), "see [x]\n    next\n\n[x]: https://e.com");
});

test("TextView text: comments are drawn as highlights, their marks and text left out, outside code only", () => {
  const color = "#e5c07b55", lit = inner => `<mark color="${color}">${inner}</mark>`;
  const [para] = blocksOf("a {==b **c**==}{>>n<<} d\ne{>>p<<} `{==f==}`\n");
  assert.equal(displayText(para, color), `a ${lit("b **c**")} d\n    e${lit(POINT)} \`{==f==}\``);
  assert.equal(displayText(blocksOf("# {==Title==}{>>n<<}\n")[0], color), lit("Title"));
  const [quote] = blocksOf("> q {==x==}{>>n<<}\n> ```\n> {==y==}\n> ```\n");
  assert.equal(displayText(quote, color), `q ${lit("x")}\n\`\`\`\n{==y==}\n\`\`\``, "a code block inside a quote is left as it is");
  const [linked] = blocksOf("see [x] {==y==}\n\n[x]: https://e.com\n");
  assert.equal(displayText(linked, color), `see [x] ${lit("y")}\n\n[x]: https://e.com`, "the definitions after it untouched");
  assert.equal(displayText(blocksOf("plain\n")[0], color), "plain");
});

test("TextView text: a highlight with no colour of its own gets the editor's; one with a colour, code and a coloured span are left alone", () => {
  const color = "#4a3b20", lit = inner => `<mark color="${color}">${inner}</mark>`;
  const [para] = blocksOf("a <mark>b **c**</mark> d <MARK >e</mark> `<mark>f</mark>`\n");
  assert.equal(displayText(para, color), `a ${lit("b **c**")} d ${lit("e")} \`<mark>f</mark>\``);
  const kept = 'a <mark color="#336699">b</mark> <mark style="background-color: yellow">c</mark> <span style="color: red">d</span>';
  assert.equal(displayText(blocksOf(`${kept}\n`)[0], color), kept);
  assert.equal(displayText(blocksOf("a <mark>b\n")[0], color), "a <mark>b", "a tag with no closing tag draws nothing either way");
  assert.equal(displayText(blocksOf("{==a==}{>>n<<} <mark>b</mark>\n")[0], color), `${lit("a")} ${lit("b")}`);
});

test("a rendered block with comments shows their count right of its first row, in a box the editor places and hit-tests", () => {
  const { el, d } = drawn("A {==b==}{>>n<<} c {>>p<<}\n", 0, { notes: 2, notesX: 726, notesY: 1 });
  const badge = must(el, `md-notes-${d.key}`);
  assert.deepEqual([badge.style.absolute, badge.style.left, badge.style.top, badge.style.w, badge.style.h], [true, 726, 1, NOTES.w, NOTES.h]);
  assert.equal(badge.style.tooltip, "2 comments");
  assert.deepEqual(all(badge, n => n.kind === "svg").map(n => n.path), ["mods/herdr-inline-markdown/message-square.svg"]);
  assert.equal(textOf(badge).trim(), "2");
  assert.ok(el.__node.style.relative, "the block places it");
  const plain = drawn("A plain one\n", 0, { notes: 0, notesX: 0, notesY: 0 });
  assert.equal(all(plain.el, n => /^md-notes-/.test(n.id ?? "")).length, 0, "no comments, no count");
});

test("a block's Comment button is drawn where the editor places it, a table's raised; its press is the editor's and goes no further", () => {
  const presses = [], box = { x: 500, y: 19, w: 22, h: 22 };
  const also = { blockButtonIn: () => box, commentPress(key) { presses.push(key); } };
  for (const [text, raised] of [["```js\nx\n```\n", false], ["| a |\n|---|\n| 1 |\n", true]]) {
    const { el, d } = drawn(text, 0, {}, also), button = must(el, `md-block-comment-${d.key}`);
    assert.deepEqual([button.style.absolute, button.style.left, button.style.top, button.style.w, button.style.h, el.__node.style.relative], [true, 500, 19, 22, 22, true]);
    assert.deepEqual([button.style.tooltip, all(button, n => n.kind === "svg").map(n => n.path)], ["Comment (Cmd+Alt+M)", ["mods/herdr-inline-markdown/message-square-plus.svg"]]);
    assert.deepEqual([button.style.bg, button.style.shadow_sm], raised ? ["popover", true] : [undefined, undefined]);
    const cx = makeCx();
    fire(button, "on_mouse_down:left", {}, cx);
    fire(button, "on_mouse_up:left", {}, cx);
    assert.deepEqual([presses.at(-1), cx.stopped], [d.key, 2]);
  }
  const { el, d } = drawn("```js\nx\n```\n", 0, { framed: "adding" });
  assert.equal(must(el, `md-comment-frame-${d.key}`).style.border_color, highlightColor(theme()), "the frame of a comment being written");
  assert.equal(find(el, `md-block-comment-${d.key}`), null, "no button where the editor places none");
});

test("the nested views read their editor through `owners`; once it is gone they draw a placeholder", () => {
  const cx = makeCx(), id = newOwnerId();
  assert.notEqual(newOwnerId(), id, "ids are unique");
  const column = new Column(), block = new Block();
  column.init({ owner: id });
  block.init({ owner: id, key: "k1" });
  const live = div().id("col-live");
  owners.set(id, { columnElement: () => live, blockData: key => (key === "k1" ? drawn("hello\n", 0).d : null), ...drawn("hello\n", 0).owner });
  assert.equal(column.render(cx).__node.id, "col-live", "the editor's column");
  assert.equal(all(block.render(cx), n => n.kind === "textview")[0].markdown, "hello");
  const other = new Block();
  other.init({ owner: id, key: "k9" });
  assert.equal(other.render(cx).__node.id, "md-gone-k9");
  owners.delete(id);
  assert.equal(column.render(cx).__node.id, "md-column-gone");
  assert.equal(block.render(cx).__node.id, "md-gone-k1");
});

test("a rendered text block: its space and indent on the root, which reports its size; the TextView selectable, its links to the editor", () => {
  const { el, owner, d } = drawn("- a\n  - nested [link](x.md)\n", 1);
  const root = el.__node;
  assert.deepEqual([root.id, root.style.pt, root.style.pl, root.style.cursor_text], [`md-block-${d.key}`, 6, 24, true]);
  root.handlers.on_size_change({ width: 300, height: 30 });
  assert.deepEqual(owner.sizes, [[d.key, { width: 300, height: 30 }]]);
  const view = all(root, n => n.kind === "textview")[0];
  assert.equal(view.id, `md-tv-${d.key}-0`);
  view.handlers.on_link_click("x.md", makeCx());
  assert.deepEqual(owner.links, ["x.md"]);
});

test("the active field: the shared field state in the block's own type and calibrated line height, inside the same chrome, with the block keys", () => {
  const { el, owner, d } = drawn("## Title\n", 0, { mode: "active", ratio: 1.2954, padActive: 0.5, rows: "one" });
  const wrap = find(el, `md-field-${d.key}`), input = all(wrap, n => n.kind === "textarea")[0];
  assert.equal(input.state, owner.field);
  assert.deepEqual([input.style.font_family, input.style.text_size, input.style.font_weight, input.style.line_height, input.style.text_color], [".SystemUIFont", STYLES.h2.size, STYLES.h2.weight, 1.2954, "foreground"]);
  assert.deepEqual([wrap.style.key_context, wrap.style.pb], [`${TEXT} rows=one`, 0.5]);
  const menu = drawn("## Title\n", 0, { mode: "active", rows: "many", menu: true });
  assert.equal(find(menu.el, `md-field-${menu.d.key}`).style.key_context, `${TEXT} rows=many menu=open`, "the slash menu open: Up and Down are the menu's");
  const item = drawn("- [x] done\n", 0, { mode: "active" });
  assert.ok(find(item.el, `md-task-${item.d.key}`), "the item keeps its box while editing");
  assert.equal(all(item.el, n => n.style.line_through).length, 0, "a ticked task's field is not struck through");
  const heard = [];
  Object.assign(owner, { fieldKeyUp: (...a) => heard.push(["up", ...a]), fieldDown: (...a) => heard.push(["down", ...a]), fieldUp: (...a) => heard.push(["press-up", ...a]) });
  const cx = makeCx();
  wrap.handlers.on_key_up({ key: "down" }, cx);
  wrap.handlers["on_mouse_down:left"]({ click_count: 1 }, cx);
  wrap.handlers["on_mouse_up:left"]({ click_count: 1 }, cx);
  assert.deepEqual(heard.map(([what, key, e]) => [what, key, e.key ?? e.click_count]), [["up", d.key, "down"], ["down", d.key, 1], ["press-up", d.key, 1]], "the wrapper hands the field's key-ups and presses to the editor, with the block's key");
});

test("a text block not being edited is drawn by its own field exactly as the edited one is, without the block keys; one whose field went is drawn as text", () => {
  const { el, owner, d } = drawn("plain **words**\n", 0, { mode: "field", tokens: true }, tokenOwner());
  const wrap = find(el, `md-field-${d.key}`), input = all(wrap, n => n.kind === "textarea")[0];
  assert.deepEqual([input.state, wrap.style.key_context, typeof input.token, typeof input.handlers.on_token_click], [owner.own, undefined, "function", "function"]);
  const edited = drawn("plain **words**\n", 0, { mode: "active", tokens: true }, tokenOwner());
  const look = tree => {
    const field = all(tree, n => n.kind === "textarea")[0];
    return [field.id, field.style.font_family, field.style.text_size, field.style.font_weight, field.style.line_height, field.style.text_color, find(tree, `md-field-${d.key}`).style.pb];
  };
  assert.deepEqual(look(el), look(edited.el), "drawn the same");
  const gone = drawn("plain words\n", 0, { mode: "field" }, { blockField: () => null });
  assert.deepEqual([all(gone.el, n => n.kind === "textarea").length, all(gone.el, n => n.kind === "textview").length], [0, 1]);
});

test("raw blocks edit in a monospace field on the code background, code under its language strip; front matter keeps its own box", () => {
  const code = drawn("```js\nx\n```\n", 0, { mode: "active", chip: "JavaScript", chipW: 90, chipLive: true });
  const box = code.el.__node.kids[0];
  assert.deepEqual([box.style.bg, box.style.border_1, box.style.px, box.style.py], ["surface", true, BOX.px, BOX.py]);
  const wrap = find(code.el, `md-field-${code.d.key}`), input = all(wrap, n => n.kind === "textarea")[0];
  assert.deepEqual([wrap.style.key_context, input.style.font_family, input.style.text_size], [`${RAW} rows=many`, "Mono", 13]);
  const head = must(code.el, `md-code-head-${code.d.key}`), chip = must(head, `md-chip-${code.d.key}`);
  assert.deepEqual([box.kids[0].kids.map(k => k.id), head.style.h, textOf(chip).trim(), chip.style.w], [[head.id, wrap.id], CODE_HEAD, "JavaScript", 90], "the strip as Reading draws it, the field under it");
  const html = drawn("<div>\nx\n</div>\n", 0, { mode: "active" });
  assert.deepEqual([find(html.el, `md-code-head-${html.d.key}`), all(html.el, n => n.style.absolute).length], [null, 0], "none on HTML");
  const front = drawn("---\na: 1\n---\n", 0, { mode: "active" });
  const fbox = front.el.__node.kids[0];
  assert.deepEqual([fbox.style.px, fbox.style.py, fbox.style.bg], [FRONT_BOX.px, FRONT_BOX.py, "surface"]);
  const rule = drawn("***\n", 0, { mode: "active" });
  assert.equal(all(rule.el, n => n.kind === "textarea")[0].style.text_color, "muted");
});

test("a diagram block has the pointer, a mermaid block being edited shows its source", () => {
  const doc = "```mermaid\ngraph TD\nA-->B\n```\n";
  const shown = drawn(doc, 0);
  assert.deepEqual([shown.el.__node.style.cursor_pointer, shown.el.__node.style.cursor_text], [true, undefined]);
  assert.match(textOf(shown.el), /Drawing diagram/);
  const editing = drawn(doc, 0, { mode: "active" });
  assert.equal(editing.el.__node.style.cursor_text, true);
  assert.ok(find(editing.el, `md-field-${editing.d.key}`));
});

test("a drawn diagram is a frame from its block's data and the editor's view: the picture placed absolutely, the edge after it", () => {
  const doc = "```mermaid\ngraph TD\nA-->B\n```\n";
  const frame = { frameW: 1230, frameH: 208, frameMl: -257, natW: 1206, natH: 184, imgKey: "k1", imgDim: false };
  const views = [];
  const { el, d: plain, owner } = drawn(doc, 0);
  assert.equal(find(el, `md-frame-${plain.key}`), null, "no frame data: the pending box");
  const d = { ...plain, ...frame };
  owner.shown.set(d.key, { key: "k1", state: "ok", width: 2412, height: 368, scale: 2, error: null });
  owner.frameView = key => { views.push(key); return { z: 1, x: 12, y: 12, sharp: "", tools: null, cursor: "default" }; };
  const shown = renderBlock(owner, d), box = find(shown, `md-frame-${d.key}`);
  assert.deepEqual(views, [d.key]);
  assert.deepEqual([box.style.ml, box.style.w, box.style.h], [-257, 1230, 208]);
  const img = all(box, n => n.kind === "image")[0];
  assert.deepEqual([img.path, img.style.absolute, img.style.left, img.style.top, img.style.w, img.style.h], ["data/herdr-inline-markdown/diagrams/k1.png", true, 12, 12, 1206, 184]);
  assert.equal(box.kids.at(-1).id, `md-frame-edge-${d.key}`);
  assert.equal(shown.__node.style.cursor_pointer, true, "the block's own part keeps the pointer: a click on the space above it opens the source");
  const selected = renderBlock(owner, { ...d, selected: true });
  assert.equal(selected.__node.style.bg, undefined, "the frame draws the selection tint, not the block");
  assert.ok(find(selected, `md-frame-tint-${d.key}`));
});

const SHOT = { alt: "shot", src: "shot.png", href: null, state: "ok", path: "data/herdr-inline-markdown/images/aa.png", width: 300, height: 100, error: null };
const BADGE = { alt: "badge", src: "b.svg", href: "https://e.com", state: "ok", path: "data/herdr-inline-markdown/images/bb.svg", width: 80, height: 20, error: null };

const BOXES = [{ x: 0, y: 0, w: 300, h: 100 }, { x: 308, y: 0, w: 80, h: 20 }];

function pictured(items, more = {}) {
  const shown = drawn("![shot](shot.png)\n\nafter\n", 0, { pictureW: 600, pictureFrames: "", ...more });
  shown.owner.layouts.set(shown.d.key, { items, boxes: BOXES.slice(0, items.length), height: 100 });
  return { ...shown, el: renderBlock(shown.owner, shown.d) };
}

test("a picture block draws what the owner has for its key and width, in a box as tall as the layout", () => {
  const { el, owner, d } = pictured([SHOT, BADGE]);
  assert.deepEqual(owner.asked, [d.key, 600]);
  assert.equal(el.__node.id, `md-block-${d.key}`);
  const box = find(el, `md-pictures-${d.key}`);
  assert.deepEqual([box.style.relative, box.style.w_full, box.style.h], [true, true, 100]);
  const images = all(box, n => n.kind === "image");
  assert.deepEqual(images.map(n => [n.path, n.style.left, n.style.top, n.style.w, n.style.h]), [
    [SHOT.path, 0, 0, 300, 100], [BADGE.path, 308, 0, 80, 20]]);
  assert.deepEqual(images.map(n => n.style.cursor_pointer), [undefined, true], "only the linked picture has the hand");
});

test("a picture block frames each picture in the colour its letter names: none, the highlight's, or the active comment's deeper ochre", () => {
  const { el, d } = pictured([SHOT, BADGE], { pictureFrames: "hd" });
  assert.deepEqual(all(el, n => n.id?.endsWith("-comment")).map(n => [n.id, n.style.border_color]), [
    [`md-pictures-${d.key}-0-comment`, highlightColor(theme())], [`md-pictures-${d.key}-1-comment`, deepHighlightColor(theme())]]);
  assert.deepEqual(all(pictured([SHOT, BADGE], { pictureFrames: "--" }).el, n => n.id?.endsWith("-comment")), [], "none");
});

test("a rendered picture block has the default pointer, and the selection tint is on each picture, not on the root", () => {
  const { el } = pictured([SHOT]);
  assert.deepEqual([el.__node.style.cursor_default, el.__node.style.cursor_text, el.__node.style.cursor_pointer], [true, undefined, undefined]);
  assert.equal(el.__node.style.bg, undefined);
  assert.equal(all(el, n => n.id?.endsWith("-tint")).length, 0);
  const { el: chosen, d } = pictured([SHOT, BADGE], { selected: true });
  assert.equal(chosen.__node.style.bg, undefined, "no tint on the root");
  assert.deepEqual(all(chosen, n => n.id?.endsWith("-tint")).map(n => n.id), [`md-pictures-${d.key}-0-tint`, `md-pictures-${d.key}-1-tint`]);
});

test("a picture block being edited shows its source in the small field, with the text cursor and the root's selection tint", () => {
  const { el, owner, d } = pictured([SHOT], { mode: "active", selected: true });
  const wrap = find(el, `md-field-${d.key}`), input = all(wrap, n => n.kind === "textarea")[0];
  assert.equal(input.state, owner.field);
  assert.deepEqual([input.style.font_family, input.style.text_size, input.style.text_color], ["Mono", STYLES.small.size, "dim"]);
  assert.equal(el.__node.style.cursor_text, true);
  assert.equal(el.__node.style.bg, "selection");
  assert.equal(all(el, n => n.kind === "image").length, 0);
});

test("the edited text block's field draws each token in the block's type, a row as tall as the field's", () => {
  const { box, pieces } = piecesDrawn("Some **bold** text\n", 0, "b:2,:2", "bold");
  assert.equal(box.style.h, 24, "the field's line height");
  assert.deepEqual(pieces.map(p => [p.text, p.font_weight, p.font_family, p.text_size, p.line_height, p.text_color]), [
    ["bo", 700, ".SystemUIFont", 15, 1.6, "foreground"], ["ld", 400, ".SystemUIFont", 15, 1.6, "foreground"],
  ]);
  const heading = piecesDrawn("# A **b**\n", 0, ":1", "A").pieces[0];
  assert.deepEqual([heading.text_size, heading.font_weight], [28, 700]);
  const task = piecesDrawn("- [x] done **b**\n", 0, "b:1", "b", { more: { checked: true } }).pieces[0];
  assert.equal(task.line_through, true, "a ticked task's words are struck through");
  assert.equal(piecesDrawn("Some **bold**\n", 0, "b:4", "bold", { selected: true }).box.style.bg, "selection");
});

test("each piece of a token is formatted as Reading draws it", () => {
  const one = (id, label) => piecesDrawn("Some **bold** text\n", 0, id, label).pieces;
  assert.equal(one("i:1", "x")[0].italic, true);
  assert.equal(one("s:1", "x")[0].line_through, true);
  assert.equal(one("u:1", "x")[0].underline, true);
  assert.deepEqual(pick(one("l:1", "x")[0], "text_color", "underline"), { text_color: "accent", underline: true });
  assert.deepEqual(pick(one("c:1", "x")[0], "font_family", "bg"), { font_family: "Mono", bg: "surface" });
  assert.equal(one("h:1", "x")[0].bg, HIGHLIGHT, "a comment's text in the comment highlight");
  assert.equal(one("m#fef08a:1", "x")[0].bg, "#fef08a", "a mark tag in its colour");
  assert.equal(one("u:1", "x")[0].underline, true, "underline");
  const themed = { ...Object.fromEntries(["foreground", "accent", "muted"].map(c => [c, c])), ansi1: "#e06c75", ansi2: "#98c379", ansi3: "#e5c07b", ansi5: "#c678dd", ansi6: "#56b6c2" };
  state.theme = themed;
  for (const [name, color] of [["red", "#e06c75"], ["green", "#98c379"], ["yellow", "#e5c07b"], ["purple", "#c678dd"], ["teal", "#56b6c2"]]) {
    assert.equal(one(`@${name}:1`, "x")[0].text_color, color, `a ${name} text colour from the theme`);
  }
  assert.equal(one("b@#123456:1", "x")[0].text_color, "#123456", "a colour written in the file");
  assert.equal(one("l@red:1", "x")[0].text_color, "accent", "a link keeps the link colour");
  state.theme = null;
  assert.deepEqual(pick(one(`N:${POINT.length}`, POINT)[0], "text", "bg"), { text: POINT, bg: HIGHLIGHT }, "a point comment's marker");
  assert.deepEqual(one("P:0,p:3", "cat").map(p => p.text), ["icon", "cat"], "a picture's icon before its alt text");
  assert.deepEqual(one("E:0", "\u{200b}"), [], "hidden marks alone draw nothing");
});

test("a click on a token goes to the editor with the block's key; a raw block's field draws no tokens", () => {
  const { el, d, owner } = drawn("Some **bold** text\n", 0, { mode: "active", tokens: true }, tokenOwner());
  const ev = { ...tokenCtx("b:4", "bold"), bounds: { x: 0, y: 0, width: 40, height: 24 } };
  fire(all(el, n => n.kind === "textarea")[0], "on_token_click", ev, makeCx());
  assert.deepEqual(owner.clicks, [[d.key, ev]]);
  const code = drawn("```\nx\n```\n", 0, { mode: "active" }, tokenOwner());
  assert.equal(all(code.el, n => n.kind === "textarea")[0].token, undefined);
});

const pick = (o, ...keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
