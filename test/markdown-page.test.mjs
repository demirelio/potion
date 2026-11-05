import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { reset } from "./mocks/herdr.mjs";
import { all, find, textOf } from "./mocks/element.mjs";
import { makeCx } from "./helpers.mjs";

const { parse } = await import("../mods/herdr-inline-markdown/blocks.js");
const { Block, Column, STYLES, displayText, lookOf, markerOf, newOwnerId, owners, renderBlock, spaceBefore } = await import("../mods/herdr-inline-markdown/page.js");
const { TextareaState } = await import("./mocks/gpui-base.mjs");
const { TEXT, RAW } = await import("../mods/herdr-inline-markdown/keys.js");

beforeEach(() => reset());

const blocksOf = text => parse(text, { armHeadings: true }).blocks;

// What the editor hands renderBlock for block i of `text`: its data and an owner with the fields and fonts.
function drawn(text, i, more = {}) {
  const blocks = blocksOf(text), b = blocks[i], look = lookOf(b), st = STYLES[look.style];
  const d = {
    key: b.key, kind: b.kind, look: look.look, style: look.style, color: look.color, space: spaceBefore(blocks, i), depth: b.depth,
    text: look.look === "text" ? displayText(b) : look.look === "boxed" ? b.render : b.content, info: b.info, marker: markerOf(b),
    label: b.number ? `${b.number}${b.delim}` : "", checked: Boolean(b.task?.checked), width: 600, diagram: "", mode: "rendered", rows: "many",
    gen: 0, selected: false, row: st.size * st.lh, ratio: st.lh, padRendered: 0, padActive: 0, ...more,
  };
  const owner = {
    fonts: { sans: ".SystemUIFont", mono: "Mono" }, field: TextareaState.new({ value: "" }), spare: TextareaState.new({ value: "" }),
    remote: false, shown: new Map(), good: new Map(), links: [], sizes: [],
    link(url) { this.links.push(url); }, blockSized(key, size) { this.sizes.push([key, size]); },
  };
  return { d, owner, el: renderBlock(owner, d), b };
}

test("how Reading draws each kind, in which type and colour", () => {
  const doc = "---\na: 1\n---\n# H\n\np\n\n![x](y.png)\n\n- i\n\n> q\n\n```js\nc\n```\n\n```mermaid\ngraph TD\n```\n\n| a |\n|---|\n| b |\n\n<div>h</div>\n\n<!-- c -->\n\n[r]: /u\n\n***\n";
  assert.deepEqual(blocksOf(doc).map(b => [b.kind, ...Object.values(lookOf(b))]), [
    ["frontmatter", "small", "muted", "front"], ["heading", "h1", "foreground", "text"], ["paragraph", "p", "foreground", "text"],
    ["paragraph", "small", "dim", "lines"], ["item", "p", "foreground", "text"], ["quote", "p", "foreground", "text"],
    ["code", "mono", "foreground", "code"], ["mermaid", "mono", "foreground", "diagram"], ["table", "mono", "foreground", "boxed"],
    ["html", "mono", "foreground", "boxed"], ["html", "small", "dim", "lines"], ["definition", "small", "dim", "lines"], ["hr", "p", "muted", "rule"],
  ]);
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

test("the nested views read their editor through `owners`; once it is gone they draw a placeholder", () => {
  const cx = makeCx(), id = newOwnerId();
  assert.notEqual(newOwnerId(), id, "ids are unique");
  const column = new Column(), block = new Block();
  column.init({ owner: id });
  block.init({ owner: id, key: "k1" });
  owners.set(id, { columnElement: () => find(drawn("x\n", 0).el, null) ?? drawn("x\n", 0).el, blockData: key => (key === "k1" ? drawn("hello\n", 0).d : null), ...drawn("hello\n", 0).owner });
  assert.ok(column.render(cx));
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
  assert.deepEqual([input.style.font_family, input.style.text_size, input.style.font_weight, input.style.line_height, input.style.text_color], [".SystemUIFont", 22, 700, 1.2954, "foreground"]);
  assert.deepEqual([wrap.style.key_context, wrap.style.pb], [`${TEXT} rows=one`, 0.5]);
  const menu = drawn("## Title\n", 0, { mode: "active", rows: "many", menu: true });
  assert.equal(find(menu.el, `md-field-${menu.d.key}`).style.key_context, `${TEXT} rows=many menu=open`, "the slash menu open: Up and Down are the menu's");
  assert.equal(input.style.line_through, undefined, "a Textarea draws no line-through");
  const item = drawn("- [x] done\n", 0, { mode: "active" });
  assert.ok(find(item.el, `md-task-${item.d.key}`), "the item keeps its box while editing");
  const heard = [];
  Object.assign(owner, { fieldKeyUp: (...a) => heard.push(["up", ...a]), fieldDown: (...a) => heard.push(["down", ...a]), fieldUp: (...a) => heard.push(["press-up", ...a]) });
  const cx = makeCx();
  wrap.handlers.on_key_up({ key: "down" }, cx);
  wrap.handlers["on_mouse_down:left"]({ click_count: 1 }, cx);
  wrap.handlers["on_mouse_up:left"]({ click_count: 1 }, cx);
  assert.deepEqual(heard.map(([what, key, e]) => [what, key, e.key ?? e.click_count]), [["up", d.key, "down"], ["down", d.key, 1], ["press-up", d.key, 1]], "the wrapper hands the field's key-ups and presses to the editor, with the block's key");
});

test("the armed field: the spare state, drawn the same, without the block keys", () => {
  const { el, owner, d } = drawn("plain words\n", 0, { mode: "armed" });
  const wrap = find(el, `md-field-${d.key}`);
  assert.equal(all(wrap, n => n.kind === "textarea")[0].state, owner.spare);
  assert.equal(wrap.style.key_context, undefined);
});

test("raw blocks edit in a monospace field on the code background; front matter keeps its own box", () => {
  const code = drawn("```js\nx\n```\n", 0, { mode: "active" });
  const box = code.el.__node.kids[0];
  assert.deepEqual([box.style.bg, box.style.border_1, box.style.rounded, box.style.px, box.style.py], ["surface", true, 8, 14, 12]);
  const wrap = find(code.el, `md-field-${code.d.key}`), input = all(wrap, n => n.kind === "textarea")[0];
  assert.deepEqual([wrap.style.key_context, input.style.font_family, input.style.text_size], [`${RAW} rows=many`, "Mono", 13]);
  assert.equal(all(code.el, n => n.style.absolute).length, 0, "no language label while editing");
  const front = drawn("---\na: 1\n---\n", 0, { mode: "active" });
  const fbox = front.el.__node.kids[0];
  assert.deepEqual([fbox.style.px, fbox.style.py, fbox.style.bg], [12, 10, "surface"]);
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
