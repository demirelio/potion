import test from "node:test";
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { applySplice, cellCount, parse, reparse } from "../mods/herdr-inline-markdown/blocks.js";
import { parseInline } from "../mods/herdr-inline-markdown/inline.js";
import { cellEdit, cellText, tableOf } from "../mods/herdr-inline-markdown/tables.js";
import { originals } from "./markdown-corpus.mjs";

const tableIn = text => {
  const doc = parse(text), b = doc.blocks.find(x => x.kind === "table");
  return { doc, b, t: b ? tableOf(doc, b) : null };
};
// Node exposes `gc` only to a context made after the flag is set.
setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc");
// Each row's cells as source text, null for a cell the row lacks.
const texts = (doc, t) => t.rows.map((row, r) => row.cells.map((cell, c) => (cell ? cellText(doc, t, r, c) : null)));

test("tableOf: a plain table's rows (the header first, no delimiter row), their lines and cells as document offsets", () => {
  const text = "Intro\n\n| name | value |\n|------|-------|\n| a    | 12345 |\n| bb | |\n";
  const { doc, b, t } = tableIn(text);
  assert.deepEqual([t.columns, t.aligns, t.irregular], [2, [null, null], false]);
  assert.deepEqual(t.rows.map(r => r.line), [0, 2, 3]);
  assert.deepEqual(texts(doc, t), [["name", "value"], ["a", "12345"], ["bb", ""]]);
  const first = t.rows[0].cells[0];
  assert.deepEqual(first, { start: text.indexOf("name"), end: text.indexOf("name") + 4 });
  assert.equal(doc.text.slice(b.start + b.lines[t.rows[1].line].body, b.start + b.lines[t.rows[1].line].eol), "| a    | 12345 |");
  const empty = t.rows[2].cells[1], line = text.lastIndexOf("| bb | |");
  assert.deepEqual([empty.start, empty.end], [line + 7, line + 7], "an empty cell sits inside its slot, as tableCells places it");
  assert.equal(tableOf(doc, b), t, "the same answer for the same table");
});

test("tableOf: rows without outer pipes, escaped pipes and a code span holding \\|, missing cells, extra cells", () => {
  let { doc, t } = tableIn("abc | def\n--- | ---\nxyz | ghi\nlone\n");
  assert.deepEqual(texts(doc, t), [["abc", "def"], ["xyz", "ghi"], ["lone", null]], "a row with fewer cells has null for each it lacks");
  ({ doc, t } = tableIn("| a \\| b | `x\\|y` |\n|---|---|\n| \\| | c \\|\n"));
  assert.deepEqual(texts(doc, t), [["a \\| b", "`x\\|y`"], ["\\|", "c \\|"]], "a backslash takes the next character with it");
  ({ doc, t } = tableIn("| a | b |\n|---|---|\n| 1 | 2 | 3 |\n"));
  assert.deepEqual([t.irregular, texts(doc, t)[1]], [true, ["1", "2", "3"]], "more cells than the header: irregular");
  ({ doc, t } = tableIn("| a | b | c |\n|---|---|---|\n| d || e |\n|  |   | x |\n"));
  assert.deepEqual(texts(doc, t), [["a", "b", "c"], ["d", "", "e"], ["", "", "x"]]);
});

test("tableOf: a pipe ending a row closes it unless a backslash takes it, a pair of backslashes taking each other, as cellCount counts", () => {
  const { doc, t } = tableIn("| a | b |\n|---|---|\n| x | y \\\\|\n| x | y \\|\n");
  assert.deepEqual(texts(doc, t).slice(1), [["x", "y \\\\"], ["x", "y \\|"]]);
  assert.deepEqual([t.rows[1].trail, t.rows[2].trail, t.irregular], [true, false, false]);
  assert.deepEqual(["| x | y \\\\|", "| x | y \\|", "| a \\\\\\|", "||", "|"].map(cellCount), [2, 2, 1, 1, 1]);
  assert.equal(parse("| a \\\\|\n|---|\n").blocks[0].kind, "table", "a header ending in an escaped backslash and its closing pipe");
});

test("tableOf: every delimiter form gives its alignment, spaces allowed around each", () => {
  const { t } = tableIn("| a | b | c | d |\n| :-- | :-: |  --: | --- |\n");
  assert.deepEqual(t.aligns, ["left", "center", "right", null]);
  const { t: bare } = tableIn("a|b|c\n:---|:---:|---:\n");
  assert.deepEqual(bare.aligns, ["left", "center", "right"]);
});

test("tableOf: aligned when every line, the delimiter row too, has its pipes at the same columns, counted in code points", () => {
  assert.equal(tableIn("| a | b |\n|---|---|\n| c | d |\n").t.aligned, true);
  assert.equal(tableIn("| a | b |\n|---|---|\n| cc | d |\n").t.aligned, false);
  assert.equal(tableIn("| 😀 | b |\n|---|---|\n| x | d |\n").t.aligned, true, "an emoji is one code point");
  assert.equal(tableIn("| a \\| b | c |\n|--------|---|\n").t.aligned, true, "an escaped pipe is no pipe");
});

test("tableOf: a table in a list item leaves each line's container prefix out of its cells; a quote holds no table block", () => {
  const text = "- item\n\n  | a | b |\n  |---|---|\n  | c | d |\n";
  const { doc, b, t } = tableIn(text);
  assert.equal(b.depth, 1);
  assert.deepEqual(texts(doc, t), [["a", "b"], ["c", "d"]]);
  assert.equal(t.rows[1].cells[0].start, text.indexOf("| c") + 2);
  assert.equal(t.aligned, true, "pipes counted from each line's body");
  const quoted = parse("> | a | b |\n> |---|---|\n");
  assert.deepEqual(quoted.blocks.map(x => x.kind), ["quote"], "what a quote holds is not cut into blocks");
});

test("tableOf: CRLF lines end before their CR", () => {
  const { doc, t } = tableIn("| a | b |\r\n|---|---|\r\n| c | d |\r\n");
  assert.deepEqual(texts(doc, t), [["a", "b"], ["c", "d"]]);
  assert.equal(t.aligned, true);
});

test("tableOf: a table moved by a change before it is read from its kept parting, at its new offsets", () => {
  const { doc, b, t } = tableIn("x\n\n| a | b |\n|---|---|\n"), start = t.rows[0].cells[0].start;
  const moved = reparse(doc, { start: 0, end: 0, insert: "xyz" }), mb = moved.blocks.find(x => x.kind === "table"), mt = tableOf(moved, mb);
  assert.equal(mb.lines, b.lines, "the re-parse left the table alone");
  assert.deepEqual(texts(moved, mt), texts(doc, t));
  assert.equal(mt.rows[0].cells[0].start, start + 3);
  assert.equal(t.rows[0].cells[0].start, start, "an answer given keeps its offsets");
  const full = parse(moved.text), fb = full.blocks.find(x => x.kind === "table");
  assert.deepEqual(texts(full, tableOf(full, fb)), texts(doc, t), "a table parsed anew");
});

test("tableOf keeps a table's parting no longer than its block lives", async () => {
  let doc = parse("x\n\n| a | b |\n|---|---|\n| c | d |\n");
  const ref = new WeakRef(tableOf(doc, doc.blocks.find(x => x.kind === "table")));
  doc = null;
  await new Promise(resolve => setImmediate(resolve));
  collectGarbage();
  assert.equal(ref.deref(), undefined);
});

// The text of each cell of an HTML table row as the spec renders it: tags left out, a few entities read.
const htmlRows = html => [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<t[hd](?: align="(\w+)")?>([\s\S]*?)<\/t[hd]>/g)]
  .map(c => ({ align: c[1] ?? null, text: c[2].replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") })));
// What a cell shows: GFM drops the backslash of every \| first, in code spans too, then reads the inlines. A <br> is
// left out, as the spec's HTML shows it as a tag.
const shown = (text, defs = null) => parseInline(text, { defs }).chars.map(c => c.text).join("").replaceAll("\n", "");
const shownCell = (text, defs = null) => shown(text.replaceAll("\\|", "|"), defs);

test("tableOf on the GFM spec's table examples: rows, the text of each cell and the alignments as its HTML says; its cell count per row is cellCount's", () => {
  let tables = 0;
  for (const o of originals().filter(x => x.spec === "gfm" && /^Tables/.test(x.example.section))) {
    const doc = parse(o.text), html = [...o.example.html.matchAll(/<table>[\s\S]*?<\/table>/g)].map(m => m[0]);
    const found = doc.blocks.filter(b => b.kind === "table");
    assert.equal(found.length, html.length, `gfm #${o.example.example}: one table block per table`);
    found.forEach((b, k) => {
      const t = tableOf(doc, b), want = htmlRows(html[k]), id = `gfm #${o.example.example}, table ${k}`;
      assert.equal(t.rows.length, want.length, `${id}: rows`);
      assert.deepEqual(t.aligns, want[0].map(c => c.align), `${id}: alignments`);
      t.rows.forEach((row, r) => {
        const line = doc.text.slice(b.start + b.lines[row.line].body, b.start + b.lines[row.line].eol);
        assert.equal(row.cells.filter(Boolean).length, cellCount(line), `${id}, row ${r}: cellCount's count`);
        want[r].forEach((cell, c) => assert.equal(row.cells[c] ? shownCell(cellText(doc, t, r, c), doc.defs) : "", cell.text, `${id}, row ${r}, cell ${c}`));
      });
      tables++;
    });
  }
  assert.ok(tables >= 15, `${tables} tables`);
});

// What cellEdit writes for `next`, before the cases that need more: line breaks as spaces, every | not escaped yet
// given one more backslash.
const written = next => next.replace(/\r\n|\r|\n/g, " ").replace(/(\\*)\|/g, (m, run) => (run.length % 2 ? m : `${run}\\|`));
const edit = (text, r, c, next) => {
  const { doc, b, t } = tableIn(text);
  return applySplice(text, cellEdit(doc, b, t, r, c, next));
};

test("cellEdit writes a cell's text and nothing else: line breaks become spaces, a bare | is escaped, one already escaped is kept", () => {
  const text = "Intro\n\n| a | b |\n|---|---|\n| c | d |\n\nEnd\n";
  assert.equal(edit(text, 1, 1, "x"), text.replace("| d |", "| x |"));
  assert.equal(edit(text, 0, 0, "one\ntwo\r\nthree\rfour"), text.replace("| a |", "| one two three four |"));
  assert.equal(edit(text, 1, 0, "a|b"), text.replace("| c |", "| a\\|b |"));
  assert.equal(edit(text, 1, 0, "a\\|b \\\\|c"), text.replace("| c |", "| a\\|b \\\\\\|c |"), "an odd run before | is an escape already; an even one gets one more");
  assert.equal(edit(text, 1, 1, ""), text.replace("| d |", "|  |"));
});

test("cellEdit: a text ending in an odd run of backslashes gets a space before a pipe right after it", () => {
  assert.equal(edit("|a|b|\n|-|-|\n", 0, 0, "x\\"), "|x\\ |b|\n|-|-|\n");
  assert.equal(edit("|a|b|\n|-|-|\n", 0, 1, "x\\\\\\"), "|a|x\\\\\\ |\n|-|-|\n", "three before the closing pipe");
  assert.equal(edit("|a|b|\n|-|-|\n", 0, 1, "x\\\\"), "|a|x\\\\|\n|-|-|\n", "a pair takes nothing with it");
  assert.equal(edit("| a | b |\n|-|-|\n", 0, 1, "x\\"), "| a | x\\ |\n|-|-|\n", "a space there already");
});

test("cellEdit: an empty cell's text goes between its pipes with one space each side", () => {
  assert.equal(edit("| a | b |\n|---|---|\n| c ||\n", 1, 1, "x"), "| a | b |\n|---|---|\n| c | x |\n");
  assert.equal(edit("| a | b |\n|---|---|\n|    | d |\n", 1, 0, "x"), "| a | b |\n|---|---|\n| x | d |\n");
});

test("cellEdit: a cell the row lacks is added with the empty cells before it, the row keeping or lacking its closing pipe", () => {
  const head = "| a | b | c |\n|---|---|---|\n";
  assert.equal(edit(`${head}| x |\n`, 1, 2, "z"), `${head}| x | | z |\n`);
  assert.equal(edit(`${head}| x |\n`, 1, 1, "y"), `${head}| x | y |\n`);
  assert.equal(edit(`${head}| x\n`, 1, 2, "z"), `${head}| x | | z\n`);
  assert.equal(edit(`${head}x\n`, 1, 1, "y"), `${head}x | y\n`);
  assert.equal(edit(`${head}| x |\n`, 1, 2, ""), `${head}| x |\n`, "nothing to write: nothing added");
});

test("cellEdit: a row's first or last cell emptied where the row has no pipe there gets one, or the row would lose the cell", () => {
  assert.equal(edit("a | b\n--|--\nc | d\n", 1, 0, ""), "a | b\n--|--\n| | d\n");
  assert.equal(edit("a | b\n--|--\nc | d\n", 1, 1, ""), "a | b\n--|--\nc | |\n");
  assert.equal(edit("| a |\n|---|\nc\n", 1, 0, ""), "| a |\n|---|\n| |\n");
});

test("cellEdit: the first cell of a row with no leading pipe is never written to open a block", () => {
  assert.equal(edit("a | b\n--|--\nc | d\n", 1, 0, "```x"), "a | b\n--|--\n\\```x | d\n");
  assert.equal(edit("a | b\n--|--\nc | d\n", 1, 0, "# h"), "a | b\n--|--\n\\# h | d\n");
  assert.equal(edit("a | b\n--|--\nc | d\n", 1, 0, "1. one"), "a | b\n--|--\n1\\. one | d\n");
  assert.equal(edit("a | b\n--|--\nc | d\n", 1, 0, "   x"), "a | b\n--|--\nx | d\n", "nor indented");
  assert.equal(edit("| a | b |\n|--|--|\n| c | d |\n", 1, 0, "# h"), "| a | b |\n|--|--|\n| # h | d |\n", "behind a pipe it is text");
});

test("cellEdit keeps a table in a list item in its item, and CRLF lines", () => {
  const listed = "- item\n\n  | a | b |\n  |---|---|\n  | c |\n";
  assert.equal(edit(listed, 1, 1, "x\ny"), "- item\n\n  | a | b |\n  |---|---|\n  | c | x y |\n");
  assert.equal(edit("| a | b |\r\n|---|---|\r\n| c\r\n", 1, 1, "d"), "| a | b |\r\n|---|---|\r\n| c | d\r\n");
});

// A small seeded generator (mulberry32): the seed is in every failure's message.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const CELL_WORDS = ["a", "bc", "x y", "a \\| b", "`x\\|y`", "\\\\", "**b**", "`c`", "z\\"];
const NEXT_PARTS = ["a", "b", "q", " ", "  ", "|", "\\", "`", "```", "\n", "\r\n", "\r"];

function randomTable(next) {
  const columns = 1 + Math.floor(next() * 4), rows = Math.floor(next() * 4), lead = next() < 0.75, trail = next() < 0.75;
  const pick = list => list[Math.floor(next() * list.length)];
  const pad = () => pick(["", " ", "  "]);
  const flip = flag => (next() < 0.85 ? flag : !flag);
  const line = cells => `${flip(lead) ? "|" : ""}${cells.map(c => `${pad()}${c}${pad()}`).join("|")}${flip(trail) ? "|" : ""}`;
  const header = Array.from({ length: columns }, () => pick(["h", "head", "H 2", "`h`"]));
  const delim = Array.from({ length: columns }, () => pick(["---", ":--", ":-:", "--:", " --- "]));
  const body = Array.from({ length: rows }, () => {
    const n = next() < 0.2 ? 1 + Math.floor(next() * columns) : columns + (next() < 0.05 ? 1 : 0);
    return Array.from({ length: n }, () => (next() < 0.2 ? "" : pick(CELL_WORDS)));
  });
  const lines = [line(header), `${lead ? "|" : ""}${delim.join("|")}${trail ? "|" : ""}`, ...body.map(line)];
  const listed = next() < 0.2, eol = next() < 0.2 ? "\r\n" : "\n", indent = listed ? "  " : "";
  return `Intro${eol}${eol}${listed ? `- item${eol}${eol}` : ""}${lines.map(l => indent + l).join(eol)}${eol}${eol}End${eol}`;
}

test("cellEdit on random tables and texts: still one table of the same rows and columns, the cell holding the text as written, every other cell and all text outside the table unchanged", () => {
  const seed = Number(process.env.TABLE_SEED ?? 20261117), next = rng(seed);
  let cases = 0;
  for (let n = 0; n < 3000; n++) {
    const text = randomTable(next), { doc, b, t } = tableIn(text);
    if (!t) continue;
    const r = Math.floor(next() * t.rows.length), c = Math.floor(next() * t.columns);
    const value = Array.from({ length: Math.floor(next() * 6) }, () => NEXT_PARTS[Math.floor(next() * NEXT_PARTS.length)]).join("");
    const why = `seed ${seed}, case ${n}: ${JSON.stringify(text)} row ${r} cell ${c} <- ${JSON.stringify(value)}`;
    const s = cellEdit(doc, b, t, r, c, value), after = applySplice(text, s);
    assert.ok(s.start >= b.start && s.end <= b.end, `${why}: the splice stays in the table`);
    const doc2 = parse(after), b2 = doc2.blocks[b.index];
    assert.equal(b2?.kind, "table", `${why}: still a table`);
    assert.equal(doc2.blocks.length, doc.blocks.length, `${why}: the same blocks`);
    assert.equal(after.slice(0, b.start), text.slice(0, b.start), `${why}: the text before the table`);
    assert.equal(after.slice(b2.end), text.slice(b.end), `${why}: the text after the table`);
    const t2 = tableOf(doc2, b2);
    assert.deepEqual([t2.rows.length, t2.columns, t2.irregular], [t.rows.length, t.columns, t.irregular], `${why}: the same rows and columns`);
    const was = texts(doc, t), now = texts(doc2, t2);
    const plain = written(value).trim();
    for (let rr = 0; rr < was.length; rr++) {
      for (let cc = 0; cc < Math.max(was[rr].length, now[rr].length); cc++) {
        if (rr === r && cc === c) continue;
        const grown = rr === r && cc < c && was[rr][cc] === null && plain !== "";
        assert.equal(now[rr][cc] ?? null, grown ? "" : was[rr][cc] ?? null, `${why}: cell ${rr}, ${cc} unchanged`);
      }
    }
    const got = now[r][c] ?? "";
    const firstBare = c === 0 && !/^[ \t]*\|/.test(doc2.text.slice(b2.start + b2.lines[t2.rows[r].line].body));
    assert.ok(got === plain || (firstBare && got === `\\${plain}`), `${why}: the cell holds ${JSON.stringify(got)}`);
    if (!value.includes("\\")) assert.equal(shownCell(got).trim(), shown(value.replace(/\r\n|\r|\n/g, " ")).trim(), `${why}: shown as typed`);
    cases++;
  }
  assert.ok(cases > 2500, `${cases} cases`);
});
