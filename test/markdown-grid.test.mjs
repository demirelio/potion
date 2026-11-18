import test from "node:test";
import assert from "node:assert/strict";
import { parse, reparse } from "../mods/potion/blocks.js";
import { POINT } from "../mods/potion/comments.js";
import { GRID, columnWidths, dashWidth } from "../mods/potion/geometry.js";
import { cellMarkdown, drawsGrid, gridOf } from "../mods/potion/grid.js";
import { tableOf } from "../mods/potion/tables.js";

const LIGHT = "#aa000055", DEEP = "#bb0000";
const head = { row: 21, advance: 7 }, body = { row: 21, advance: 6.5 };
const tableIn = text => {
  const doc = parse(text);
  return { doc, b: doc.blocks.find(x => x.kind === "table") };
};
const optsOf = (doc, more = {}) => ({ room: 716, head, body, color: LIGHT, deep: null, defs: { map: doc.defs }, ...more });

test("a cell's markdown for its TextView: formatting and links as written, \\| shown as | (in code too), a block start kept as text", () => {
  assert.equal(cellMarkdown("**b** and [a](https://e.com)", LIGHT, null, new Map()), "**b** and [a](https://e.com)");
  assert.equal(cellMarkdown("a \\| b", LIGHT, null, new Map()), "a | b");
  assert.equal(cellMarkdown("`x\\|y`", LIGHT, null, new Map()), "`x|y`");
  assert.equal(cellMarkdown("# not a heading", LIGHT, null, new Map()), "\\# not a heading");
  assert.equal(cellMarkdown("1. one", LIGHT, null, new Map()), "1\\. one");
  assert.equal(cellMarkdown("- x", LIGHT, null, new Map()), "\\- x");
  assert.equal(cellMarkdown("> q", LIGHT, null, new Map()), "\\> q");
});

test("a cell's markdown that would read as a link reference definition reads as text, a reference link in it still a link", () => {
  assert.equal(cellMarkdown("[a]: https://x", LIGHT, null, new Map()), "[a]\\: https://x");
  assert.equal(cellMarkdown("[a \\] b]: x", LIGHT, null, new Map()), "[a \\] b]\\: x");
  const defs = parse("[ref]: https://example.com\n").defs;
  assert.equal(cellMarkdown("[ref]: more", LIGHT, null, defs), "[ref]\\: more\n\n[ref]: https://example.com");
  assert.deepEqual(parse(cellMarkdown("[ref]: more", LIGHT, null, defs)).blocks.map(x => x.kind), ["paragraph", "definition"], "the cell is a paragraph");
  assert.equal(cellMarkdown("see [a]: x", LIGHT, null, new Map()), "see [a]: x", "only at the start");
});

test("a cell's markdown: comments highlighted with their notes gone, the deep one deeper, a <mark> in the highlight colour, the definitions its reference links use", () => {
  const cell = "{==12==}{>>2026-11-16 20:51 \\| too big?<<} and {>>a point<<}";
  assert.equal(cellMarkdown(cell, LIGHT, null, new Map()), `<mark color="${LIGHT}">12</mark> and <mark color="${LIGHT}">${POINT}</mark>`);
  assert.equal(cellMarkdown(cell, LIGHT, { at: 0, color: DEEP }, new Map()), `<mark color="${DEEP}">12</mark> and <mark color="${LIGHT}">${POINT}</mark>`);
  assert.equal(cellMarkdown("a <mark>b</mark>", LIGHT, null, new Map()), `a <mark color="${LIGHT}">b</mark>`);
  const defs = parse("[ref]: https://example.com\n").defs;
  assert.equal(cellMarkdown("see [x][ref]", LIGHT, null, defs), "see [x][ref]\n\n[ref]: https://example.com");
});

test("the grid of a table: each cell's markdown (\"\" for one its row lacks), the columns' widths from their widest shown text, alignment boxes and estimated rows", () => {
  const { doc, b } = tableIn("| Name | Size | Note |\n|---|:-:|--:|\n| **apple** | 12 | a long note here |\n| pear |\n");
  const g = gridOf({}, doc, b, optsOf(doc));
  assert.deepEqual(g.texts, [["Name", "Size", "Note"], ["**apple**", "12", "a long note here"], ["pear", "", ""]]);
  assert.deepEqual(g.aligns, [null, "center", "right"]);
  assert.deepEqual(g.widths, columnWidths([5 * 6.5, 4 * 7, 16 * 6.5], 716 - 4), "apple shows 5 characters; the header at its own advance");
  assert.equal(g.w, g.widths.reduce((a, x) => a + x) + 4 * GRID.line);
  assert.deepEqual(g.boxes[0], [0, Math.min(g.widths[1] - 2 * GRID.padX, 5 * 7), Math.min(g.widths[2] - 2 * GRID.padX, 5 * 7)], "centred and right cells in a box as wide as their text and one advance more");
  assert.deepEqual(g.boxes[1], [0, 3 * 6.5, Math.min(g.widths[2] - 2 * GRID.padX, 17 * 6.5)]);
  const one = 2 * GRID.padY + 21;
  assert.deepEqual(g.heights, [one + 1, one + 1, one]);
  assert.equal(g.h, 3 * one + 2 + 2 * GRID.line);
  assert.deepEqual(g.rowPx, [21, 21]);
});

test("the grid is the same object while its table's text, the definitions, the room, the calibration and the comments' colours stay; its widths while what they come from stays", () => {
  const text = `Intro\n\n| a | b |\n|---|---|\n| {==c==}{>>n<<} | ${"d".repeat(30)} |\n`;
  const { doc, b } = tableIn(text), kept = {}, opts = optsOf(doc);
  const g = gridOf(kept, doc, b, opts);
  const moved = parse(`More ${text}`), mb = moved.blocks.find(x => x.kind === "table");
  assert.equal(gridOf(kept, moved, mb, { ...opts, defs: opts.defs }), g, "a change before the table");
  const deep = gridOf(kept, moved, mb, { ...opts, deep: { row: 1, column: 0, at: 0, color: DEEP } });
  assert.notEqual(deep, g);
  assert.equal(deep.widths, g.widths, "an active comment changes what a cell draws, not the widths");
  assert.ok(deep.texts[1][0].includes(DEEP));
  const narrow = gridOf(kept, moved, mb, { ...opts, room: 200 });
  assert.notEqual(narrow.widths, g.widths);
  assert.notEqual(gridOf(kept, moved, mb, { ...opts, room: 200, body: { row: 22, advance: 6.5 } }), narrow, "a calibration");
});

test("typing above a table moves none of its cells for the grid: the grid stays what it kept", () => {
  const text = "Intro\n\n| a | b |\n|---|---|\n| c | d |\n";
  const { doc, b } = tableIn(text), t = tableOf(doc, b), kept = {}, opts = optsOf(doc);
  const g = gridOf(kept, doc, b, opts);
  const moved = reparse(doc, { start: 0, end: 0, insert: "More " }), mb = moved.blocks.find(x => x.kind === "table");
  assert.equal(mb.lines, b.lines, "the re-parse left the table alone");
  assert.equal(gridOf(kept, moved, mb, opts), g);
  assert.equal(tableOf(doc, b), t, "its cells still at the offsets they were asked for");
});

test("a sized table's columns are its dashes at the cell style's advance and the padding, whatever the room, the text or the widths held; a table of three dashes or fewer a column keeps its widths from the text", () => {
  const { doc, b } = tableIn(`| Name | Note |\n|${"-".repeat(62)}|:---:|\n| a | b |\n`);
  const held = [100, 100], g = gridOf({}, doc, b, optsOf(doc, { room: 300, widths: held }));
  assert.deepEqual(g.widths, [dashWidth(62, 6.5), GRID.minW], "62 dashes; three draw 64 px");
  assert.equal(g.sized, true);
  assert.ok(g.w > 300, `${g.w} px: wider than the room`);
  assert.ok(g.widths[0] > GRID.maxW, "no 360 px cap");
  assert.deepEqual(g.boxes[1], [0, Math.min(GRID.minW - 2 * GRID.padX, 2 * 6.5)], "a centred cell's box in its set width");
  const padded = tableIn("| Name   | Value |\n|--------|-------|\n| apple  | 1     |\n");
  assert.deepEqual(gridOf({}, padded.doc, padded.b, optsOf(padded.doc)).widths, [dashWidth(8, 6.5), dashWidth(7, 6.5)], "a source padded to line up reads at its dashes");
  const auto = tableIn("| Name | Value |\n|---|:-:|\n| apple | 1 |\n"), ga = gridOf({}, auto.doc, auto.b, optsOf(auto.doc));
  assert.deepEqual([ga.sized, ga.widths], [false, columnWidths([5 * 6.5, 5 * 7], 716 - 3)], "three dashes or fewer: from the text");
});

test("an automatic table whose columns can't all get 64 px keeps them at 64 px and grows wider than the room", () => {
  const { doc, b } = tableIn(`${"| x ".repeat(8)}|\n${"|---".repeat(8)}|\n`), g = gridOf({}, doc, b, optsOf(doc, { room: 400 }));
  assert.deepEqual(g.widths, Array(8).fill(GRID.minW));
  assert.equal(g.w, 8 * GRID.minW + 9 * GRID.line);
});

test("a table kept as source: irregular, or more than 1,000 cells", () => {
  assert.equal(drawsGrid(...Object.values(tableIn("| a |\n|---|\n| b | c |\n"))), false);
  const wide = `${"| x ".repeat(7)}|\n${"|---".repeat(7)}|\n`, rows = n => `${wide}${`${"| y ".repeat(7)}|\n`.repeat(n)}`;
  assert.equal(drawsGrid(...Object.values(tableIn(rows(141)))), true, "142 rows of 7: 994 cells");
  assert.equal(drawsGrid(...Object.values(tableIn(rows(142)))), false, "143 rows of 7: 1,001 cells");
  assert.equal(drawsGrid(...Object.values(tableIn(`${"| x ".repeat(7)}|\n${"|---".repeat(7)}|\n${"| y |\n".repeat(142)}`))), false, "the cells its short rows lack count");
  const { doc, b } = tableIn(rows(142));
  assert.equal(gridOf({}, doc, b, optsOf(doc)), null);
});
