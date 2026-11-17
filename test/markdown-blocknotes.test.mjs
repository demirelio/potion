import test from "node:test";
import assert from "node:assert/strict";
import { parse, reparse, applySplice } from "../mods/herdr-inline-markdown/blocks.js";
import {
  addBlockNote, blockUnit, counters, editBlockNote, notesAfter, ownerOf, pairNotes, removeWithNotes, resolveBlockNote,
} from "../mods/herdr-inline-markdown/blocknotes.js";

const run = (text, s) => applySplice(text, s);
const WHEN = new Date(2026, 10, 17, 9, 0);
const note = text => `{>>2026-11-17 09:00 | ${text}<<}`;
// Which block owns which paragraph, by kind, with the notes in it.
const pairs = text => {
  const d = parse(text), p = pairNotes(d);
  return [...p.owners.values()].map(({ owner, para, points }) => [owner.kind, d.blocks.indexOf(para), points.map(c => c.note)]);
};
const ownerAt = (d, kind, n = 0) => d.blocks.filter(b => b.kind === kind)[n];

test("a code block, a diagram or a table owns the paragraph right after it when it holds nothing but point comments", () => {
  assert.deepEqual(pairs("```js\nx\n```\n{>>a<<}\n"), [["code", 1, ["a"]]], "no blank line after a closing fence");
  assert.deepEqual(pairs("```js\nx\n```\n\n{>>a<<}\n{>>b<<}\n"), [["code", 1, ["a", "b"]]], "one blank line, one comment a line");
  assert.deepEqual(pairs("```\nx\n```\n\n\n{>>a<<} {>>b<<}\n\nEnd\n"), [["code", 1, ["a", "b"]]], "two blank lines, two on a line");
  assert.deepEqual(pairs("    indented\n\n{>>a<<}\n"), [["code", 1, ["a"]]]);
  assert.deepEqual(pairs("```mermaid\ngraph TD\n```\n\n{>>a<<}\n"), [["mermaid", 1, ["a"]]]);
  assert.deepEqual(pairs("| a | b |\n|---|---|\n| 1 | 2 |\n\n{>>2026-11-17 09:00 | why?<<}\n"), [["table", 1, ["2026-11-17 09:00 | why?"]]]);
  assert.deepEqual(pairs("- item\n\n  ```\n  x\n  ```\n\n  {>>a<<}\n  {>>b<<}\n"), [["code", 2, ["a", "b"]]], "in a list item, indented with it");
});

test("a paragraph with anything besides point comments, one after a paragraph, a picture paragraph, or a later one is no block's", () => {
  for (const text of [
    "```\nx\n```\n\n{==lit==}{>>a<<}\n",
    "```\nx\n```\n\n{>>a<<} and words\n",
    "```\nx\n```\n\nwords {>>a<<}\n",
    "```\nx\n```\n\n{>>a<<}\nwords\n",
    "```\nx\n```\n\n\\{>>a<<}\n",
    "```\nx\n```\n\n{>>a\n<<}\n",
    "Words\n\n{>>a<<}\n",
    "```\nx\n```\n\n![a](a.png)\n",
    "```\nx\n```\n\nWords\n\n{>>a<<}\n",
    "- ```\n  x\n  ```\n\n{>>a<<}\n",
  ]) assert.deepEqual(pairs(text), [], JSON.stringify(text));
  assert.deepEqual(pairs("```\nx\n```\n\n{>>a<<}\n\n{>>b<<}\n"), [["code", 1, ["a"]]], "only the next sibling");
});

test("the pairing is kept per paragraph content: a re-parsed document reads no paragraph again, a changed one only that one", () => {
  const text = "```\nx\n```\n\n{>>a<<}\n\nWords\n\n| t |\n|---|\n| 1 |\n\n{>>b<<}\n";
  const d = parse(text), first = pairNotes(d);
  assert.deepEqual([first.owners.size, [...first.hidden]], [2, [d.blocks[1].key, d.blocks[4].key]]);
  const at = text.indexOf("Words"), next = reparse(d, { start: at, end: at, insert: "More " });
  const read = counters.reads, again = pairNotes(next, first);
  assert.deepEqual([counters.reads - read, again.owners.size], [0, 2], "unchanged contents are not read again");
  const b = next.text.indexOf("{>>b") + 4, changed = reparse(next, { start: b, end: b, insert: "c" });
  pairNotes(changed, again);
  assert.equal(counters.reads - read, 1);
});

test("notesAfter, ownerOf and blockUnit: an owner and its comments paragraph go as one", () => {
  const d = parse("Intro\n\n```\nx\n```\n\n{>>a<<}\n\nEnd\n"), [intro, code, para, end] = d.blocks;
  assert.deepEqual([notesAfter(d, code), notesAfter(d, intro), notesAfter(d, para)], [para, null, null]);
  assert.deepEqual([ownerOf(d, para), ownerOf(d, end), ownerOf(d, code)], [code, null, null]);
  assert.deepEqual([blockUnit(d, code), blockUnit(d, para), blockUnit(d, end)], [[code, para], [code, para], [end, end]]);
  assert.equal(run(d.text, removeWithNotes(d, code)), "Intro\n\nEnd\n", "removing the block takes its comments");
  assert.equal(run(d.text, removeWithNotes(d, end)), "Intro\n\n```\nx\n```\n\n{>>a<<}\n");
});

test("adding a comment under a block writes a comments paragraph after it, or a new last line of the one it has; resolving it gives the text back byte for byte", () => {
  const cases = [
    ["top level", "```js\nx\n```\n\nNext\n", "```js\nx\n```\n\n{>>2026-11-17 09:00 | why?<<}\n\nNext\n"],
    ["last, with a final line break", "```\nx\n```\n", "```\nx\n```\n\n{>>2026-11-17 09:00 | why?<<}\n"],
    ["in a list item", "- item\n\n  ```\n  x\n  ```\n", "- item\n\n  ```\n  x\n  ```\n\n  {>>2026-11-17 09:00 | why?<<}\n"],
    ["a table", "| a |\n|---|\n| 1 |\n\nEnd\n", "| a |\n|---|\n| 1 |\n\n{>>2026-11-17 09:00 | why?<<}\n\nEnd\n"],
    ["a diagram", "```mermaid\ngraph TD\n```\n\nEnd\n", "```mermaid\ngraph TD\n```\n\n{>>2026-11-17 09:00 | why?<<}\n\nEnd\n"],
    ["the last block, no final line break", "```\nx\n```", "```\nx\n```\n\n{>>2026-11-17 09:00 | why?<<}"],
    ["CRLF", "```\r\nx\r\n```\r\n\r\nEnd\r\n", "```\r\nx\r\n```\r\n\r\n{>>2026-11-17 09:00 | why?<<}\r\n\r\nEnd\r\n"],
    ["CRLF, no final line break", "```\r\nx\r\n```", "```\r\nx\r\n```\r\n\r\n{>>2026-11-17 09:00 | why?<<}"],
    ["a paragraph there", `\`\`\`\nx\n\`\`\`\n\n${note("a")}\n\nEnd\n`, `\`\`\`\nx\n\`\`\`\n\n${note("a")}\n${note("why?")}\n\nEnd\n`],
    ["a paragraph there, no final line break", `\`\`\`\nx\n\`\`\`\n\n${note("a")}`, `\`\`\`\nx\n\`\`\`\n\n${note("a")}\n${note("why?")}`],
    ["a paragraph in an item", `- i\n\n  \`\`\`\n  x\n  \`\`\`\n\n  ${note("a")}\n`, `- i\n\n  \`\`\`\n  x\n  \`\`\`\n\n  ${note("a")}\n  ${note("why?")}\n`],
    ["a CRLF paragraph", `\`\`\`\r\nx\r\n\`\`\`\r\n\r\n${note("a")}\r\n`, `\`\`\`\r\nx\r\n\`\`\`\r\n\r\n${note("a")}\r\n${note("why?")}\r\n`],
  ];
  for (const [name, text, want] of cases) {
    const d = parse(text), owner = d.blocks.find(b => ["code", "mermaid", "table"].includes(b.kind));
    const added = run(text, addBlockNote(d, owner, "why?", WHEN)), nd = parse(added), pair = pairNotes(nd).owners.get(nd.blocks[owner.index].key);
    assert.equal(added, want, name);
    assert.deepEqual(pair.points.map(c => c.note).at(-1), "2026-11-17 09:00 | why?", `${name}: read back as the block's`);
    assert.equal(run(added, resolveBlockNote(nd, nd.blocks[owner.index], pair.points.length - 1)), text, `${name}: resolved`);
  }
  const d = parse("```\nx\n```\n");
  assert.equal(addBlockNote(d, d.blocks[0], " \n ", WHEN), null, "nothing to say");
  assert.equal(run(d.text, addBlockNote(d, d.blocks[0], "a\nb <<} c", WHEN)), `\`\`\`\nx\n\`\`\`\n\n${note("a b << } c")}\n`, "one line, never closed early");
});

test("editing a block's comment swaps its text and keeps its time; resolving one takes its line, or the paragraph with the last", () => {
  const text = `\`\`\`\nx\n\`\`\`\n\n{>>2026-11-15 08:05 | first<<}\n{>>plain<<} ${note("third")}\n${note("last")}\n\nEnd\n`;
  const d = parse(text), code = ownerAt(d, "code");
  assert.equal(run(text, editBlockNote(d, code, 0, "changed")), text.replace("08:05 | first", "08:05 | changed"));
  assert.equal(run(text, editBlockNote(d, code, 1, "no time")), text.replace("{>>plain<<}", "{>>no time<<}"));
  assert.deepEqual([editBlockNote(d, code, 0, "first"), editBlockNote(d, code, 0, "  "), editBlockNote(d, code, 9, "x")], [null, null, null]);
  assert.equal(run(text, resolveBlockNote(d, code, 0)), text.replace("{>>2026-11-15 08:05 | first<<}\n", ""), "the first line");
  assert.equal(run(text, resolveBlockNote(d, code, 1)), text.replace("{>>plain<<} ", ""), "one of two on a line");
  assert.equal(run(text, resolveBlockNote(d, code, 2)), text.replace(` ${note("third")}`, ""), "the last on its line");
  assert.equal(run(text, resolveBlockNote(d, code, 3)), text.replace(`\n${note("last")}`, ""), "the last line");
  const one = `\`\`\`\nx\n\`\`\`\n\n${note("only")}\n\nEnd\n`, od = parse(one);
  assert.equal(run(one, resolveBlockNote(od, od.blocks[0], 0)), "```\nx\n```\n\nEnd\n", "the only one: the paragraph goes");
  assert.equal(resolveBlockNote(od, od.blocks[0], 1), null);
  assert.equal(resolveBlockNote(od, od.blocks[2], 0), null, "a block with no comments");
});
