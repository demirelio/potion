import test from "node:test";
import assert from "node:assert/strict";
import {
  parse, reparse, field, fieldToDoc, docToField, type, separators, applySplice, diff, counters, isText, split, insertAfter,
  insertBefore, insertAt, mergeIntoPrevious, mergeNext, remove, removeRange, toParagraph, indent, outdent, nest, unnest,
  move, toggleTask, paste, closeFence, fenceGuard, shortcut, codeIndent, FENCE, CLOSE, closes, parseInSteps,
  retype, insertLines, picturesIn, removePicture, lengthenFence, setLanguage,
} from "../mods/potion/blocks.js";
import { visibleMap } from "../mods/potion/inline.js";
import { originals, corpus, docs, htmlKinds, docKinds, random, bigDocument, VARIANTS } from "./markdown-corpus.mjs";

const kinds = d => d.blocks.map(b => b.kind);
const raw = (d, b) => d.text.slice(b.start, b.end);
const values = d => d.blocks.map(b => field(d, b).value);
const at = (d, kind, n = 0) => d.blocks.filter(b => b.kind === kind)[n];
const run = (text, s) => applySplice(text, s);
const lineStart = (text, p) => p === 0 || text[p - 1] === "\n" || (p === 1 && text[0] === "﻿");
const shape = d => d.blocks.map(({ key, ...b }) => b);

// Docs cut at their "## " headings, so the per-block properties run on small documents.
const sections = docs.flatMap(d => d.text.split(/^(?=## )/m).map((text, i) => ({ name: `${d.name} §${i}`, text })));
const everyText = () => [
  ...corpus().filter(c => c.example),
  ...sections.flatMap(s => [s, ...Object.entries(VARIANTS).map(([v, make]) => ({ name: `${s.name} [${v}]`, text: make(s.text) })).filter(x => x.text !== s.text)]),
];

test("every corpus file and variant parses into blocks that join back into the exact text", () => {
  const all = corpus();
  assert.ok(all.length > 3500, `${all.length} texts`);
  for (const c of all) {
    const d = parse(c.text);
    let joined = c.text.slice(0, d.lead[1]), prev = d.lead[1];
    assert.match(c.text.slice(0, d.lead[1]), /^﻿?[ \t\r\n]*$/, `${c.name}: the lead is a BOM and blank lines`);
    for (const b of d.blocks) {
      assert.equal(b.start, prev, `${c.name}: ${b.kind} starts where the one before ends`);
      assert.ok(b.start <= b.end && b.end <= b.gapEnd, `${c.name}: ${b.kind} span`);
      assert.match(c.text.slice(b.end, b.gapEnd), /^[ \t\r\n]*$/, `${c.name}: a gap holds blank lines only`);
      joined += c.text.slice(b.start, b.gapEnd);
      prev = b.gapEnd;
    }
    assert.equal(prev, c.text.length, `${c.name}: the last gap ends the text`);
    assert.equal(joined, c.text, c.name);
  }
});

test("each block's lines cover its span: prefix, body, separator, EOL, in order", () => {
  for (const c of corpus().filter((_, i) => i % 3 === 0)) {
    const d = parse(c.text);
    for (const b of d.blocks) {
      let p = 0;
      for (const L of b.lines) {
        assert.equal(L.start, p, `${c.name}: ${b.kind} line starts where the last one ended`);
        assert.ok(L.start <= L.body && L.body <= L.end && L.end <= L.eol && L.eol <= L.next, `${c.name}: ${b.kind} line order`);
        p = L.next;
      }
      assert.equal(b.start + p, b.tail ? b.start + b.tail.start : b.end, `${c.name}: ${b.kind} lines end at its end (or its tail)`);
    }
  }
});

// Examples whose expected HTML cannot be read for block kinds: #44's is a placeholder, #24 and #46 hold raw <blockquote>
// and <p> blocks that look like rendered ones. Their kinds were checked by hand against CommonMark 4.6.
const HAND_CHECKED = new Map([
  ["gfm 24", "paragraph,html"],
  ["gfm 44", "paragraph"],
  ["gfm 46", "paragraph,html,paragraph,html,paragraph,html,paragraph,html"],
]);

test("the CommonMark 0.31.2 and GFM spec examples have the top-level kinds their expected HTML shows", () => {
  let checked = 0, frontMatter = 0;
  for (const o of originals().filter(x => x.example)) {
    if (o.spec === "gfm" && o.example.extension === "footnotes") continue;
    const d = parse(o.text), id = `${o.spec} ${o.example.example}`;
    if (d.blocks[0]?.kind === "frontmatter") {
      assert.match(o.text, /^---[ \t]*\n/, `${id}: only a leading --- line reads as front matter`);
      frontMatter++;
      continue;
    }
    const want = HAND_CHECKED.get(id) ?? htmlKinds(o.example.html).join();
    assert.equal(docKinds(d).join(), want, `${id}: ${JSON.stringify(o.text)}`);
    checked++;
  }
  assert.ok(checked >= 690, `${checked} examples`);
  assert.equal(frontMatter, 2, "front matter, an extension of ours, shadows two thematic-break examples");
});

test("the CRLF, BOM and no-final-newline variants keep the kinds of their originals", () => {
  for (const o of originals()) {
    const want = kinds(parse(o.text)).join();
    for (const v of ["crlf", "bom", "noFinalNewline"]) {
      const text = VARIANTS[v](o.text);
      assert.equal(kinds(parse(text)).join(), want, `${o.name} [${v}]`);
    }
  }
});

const KIND_CASES = [
  ["paragraph", "one\ntwo\n", ["paragraph"], ["one two"]],
  ["ATX heading with a closing run", "## Title ##\n", ["heading"], ["Title"]],
  ["setext heading", "Hello\nWorld\n===\n", ["heading"], ["Hello World"]],
  ["bullet, ordered and task items", "- a\n1. b\n- [x] c\n", ["item", "item", "item"], ["a", "b", "c"]],
  ["a quote with a lazy line", "> a\nb\n> c\n", ["quote"], ["a b c"]],
  ["fenced code, only its code in the field", "```js\nx\n```\n", ["code"], ["x"]],
  ["indented code, without its indent", "    a\n    b\n", ["code"], ["a\nb"]],
  ["mermaid, only its source", "```mermaid\ngraph TD\n```\n", ["mermaid"], ["graph TD"]],
  ["table", "| a | b |\n|---|---|\n| 1 | 2 |\n", ["table"], ["| a | b |\n|---|---|\n| 1 | 2 |"]],
  ["table after a list item and a blank line", "- item\n\n| a |\n|---|\n", ["item", "table"], ["item", "| a |\n|---|"]],
  ["table inside an item", "- | a |\n  |---|\n", ["item", "table"], ["", "| a |\n|---|"]],
  ["html", "<div>\nx\n</div>\n", ["html"], ["<div>\nx\n</div>"]],
  ["front matter, dashes kept", "---\na: 1\n---\nx\n", ["frontmatter", "paragraph"], ["---\na: 1\n---", "x"]],
  ["rule", "***\n", ["hr"], ["***"]],
  ["definitions", "[a]: /u\n[^1]: note\n", ["definition", "definition"], ["[a]: /u", "[^1]: note"]],
  ["image-only paragraph", "![x](a.png)\n", ["paragraph"], ["![x](a.png)"]],
];
for (const [name, text, want, fields] of KIND_CASES) {
  test(`kind: ${name}`, () => {
    const d = parse(text);
    assert.deepEqual(kinds(d), want);
    assert.deepEqual(values(d), fields);
  });
}

test("the image-only paragraph, task, setext and mermaid facts are recorded on the block", () => {
  const d = parse("![x](a.png)\n\n- [ ] open\n- [X] done\n\nT\n---\n\n```mermaid\ngraph TD\n  A-->B\n```\n");
  assert.equal(d.blocks[0].image, true);
  assert.deepEqual(d.blocks[1].task, { checked: false, offset: d.text.indexOf("[ ]") + 1 });
  assert.equal(d.blocks[2].task.checked, true);
  assert.deepEqual([d.blocks[3].setext, d.blocks[3].level], [true, 2]);
  assert.equal(d.blocks[4].source, "graph TD\n  A-->B");
});

const imageFlags = text => parse(text).blocks.map(b => b.image);

test("a linked image is an image-only paragraph", () => {
  assert.deepEqual(imageFlags("[![build](https://x.io/b.svg)](https://x.io/ci)\n"), [true]);
  assert.deepEqual(imageFlags("[![](a.png)](b)\n"), [true]);
});

test("a badge row of images and linked images, on one line or several, is an image-only paragraph", () => {
  assert.deepEqual(imageFlags("[![a](x.svg)](y) [![b](x2.svg)](y2)\t![c](z.svg)\n"), [true]);
  assert.deepEqual(imageFlags("![a](x.svg)\n[![b](y.svg)](z)  \n ![c](w.svg)\n"), [true]);
  assert.deepEqual(imageFlags("[![a](x)](y)![b](z)\n"), [true], "no space is needed between two");
});

test("text around an image, an unfinished link and a destination holding ) keep the paragraph text", () => {
  for (const text of ["see ![a](x)\n", "![a](x) caption\n", "[![a](x)](y) tail\n", "[text](y)\n", "[![a](x)]\n", "[![a](x)](y\n", "![a](x(1).png)\n", "[![a](x)](y(1))\n"]) {
    assert.deepEqual(imageFlags(text).filter(Boolean), [], JSON.stringify(text));
  }
});

const sourcesIn = (d, b) => picturesIn(d, b).map(r => d.text.slice(r.start, r.end));

test("picturesIn: each picture's markdown in a paragraph of pictures as document offsets, a linked one with its link, also in a list item", () => {
  const d = parse("# T\n\n![a](a.png) [![b](b.png)](https://e.com)\n ![c](c.png)\n");
  assert.deepEqual(sourcesIn(d, d.blocks[1]), ["![a](a.png)", "[![b](b.png)](https://e.com)", "![c](c.png)"]);
  const nested = parse("- item\n\n  ![a](a.png)\n  ![b](b.png)\n");
  assert.deepEqual([nested.blocks[1].image, sourcesIn(nested, nested.blocks[1])], [true, ["![a](a.png)", "![b](b.png)"]]);
  const crlf = parse("![a](a.png)\r\n![b](b.png)\r\n");
  assert.deepEqual(sourcesIn(crlf, crlf.blocks[0]), ["![a](a.png)", "![b](b.png)"]);
});

const withoutPicture = (text, i, n = 0) => {
  const d = parse(text), b = d.blocks.filter(x => x.image)[n];
  return run(text, removePicture(d, b, i));
};

test("removePicture: one of several on a line goes with the spaces after it, or before it when it is the line's last", () => {
  const row = "![a](a.png) ![b](b.png)\t![c](c.png)\n";
  assert.deepEqual([0, 1, 2].map(i => withoutPicture(row, i)), ["![b](b.png)\t![c](c.png)\n", "![a](a.png) ![c](c.png)\n", "![a](a.png) ![b](b.png)\n"]);
  assert.equal(withoutPicture("[![a](a.png)](https://e.com) ![b](b.png)\n", 0), "![b](b.png)\n", "a linked picture goes with its link");
});

test("removePicture: a picture alone on its line goes with its line, line break and indent included", () => {
  const stack = "![a](a.png)\n![b](b.png)\n![c](c.png)\n\nEnd\n";
  assert.deepEqual([0, 1, 2].map(i => withoutPicture(stack, i)), ["![b](b.png)\n![c](c.png)\n\nEnd\n", "![a](a.png)\n![c](c.png)\n\nEnd\n", "![a](a.png)\n![b](b.png)\n\nEnd\n"]);
  const item = "- item\n\n  ![a](a.png)\n  ![b](b.png)\n";
  assert.deepEqual([0, 1].map(i => withoutPicture(item, i)), ["- item\n\n  ![b](b.png)\n", "- item\n\n  ![a](a.png)\n"]);
  assert.equal(withoutPicture("- item\n\n  ![a](a.png)\n![b](b.png)\n", 0), "- item\n\n  ![b](b.png)\n", "a lazy line stays in the item");
  assert.equal(withoutPicture("![a](a.png) ![b](b.png)\n![c](c.png)\n", 2), "![a](a.png) ![b](b.png)\n");
});

test("removePicture: the only picture takes its paragraph as remove does", () => {
  for (const text of ["# T\n\n![a](a.png)\n\nEnd\n", "# T\n\n![a](a.png)\n", "- item\n\n  [![a](a.png)](x)\n- next\n"]) {
    const d = parse(text), b = d.blocks.find(x => x.image);
    assert.equal(withoutPicture(text, 0), run(text, remove(d, b)), JSON.stringify(text));
  }
});

test("a long row followed by text is told apart at once, not after trying every split of the spaces between", () => {
  assert.deepEqual(imageFlags(`${"[![a](x)](y)   ".repeat(60)}x\n`), [false]);
  assert.deepEqual(imageFlags(`${"![a](x)   ".repeat(60)}x\n`), [false]);
  assert.deepEqual(imageFlags(`${"![a](x) \t ".repeat(60)}\n`), [true]);
});

const PICTURE_NOTE = "{>>2026-11-17 09:00 | why this one?<<}";

test("a picture wrapped in a highlight, with at most one comment after it, leaves a paragraph of pictures one", () => {
  assert.deepEqual(imageFlags(`{==![a](x.png)==}${PICTURE_NOTE}\n`), [true], "one commented picture");
  assert.deepEqual(imageFlags(`![a](x.png) {==![b](y.png)==}${PICTURE_NOTE}\t{==![c](z.png)==}\n`), [true], "a row: bare, commented, highlighted");
  assert.deepEqual(imageFlags(`{==[![a](x.svg)](y)==}${PICTURE_NOTE}\n{==![b](z.png)==}{>>n<<}\n ![c](w.png)\n`), [true], "a linked one whole, stacked");
  assert.deepEqual(imageFlags("{==![a](x.png)==}{>>a < b and <<c<<}![b](y.png)\n"), [true], "a < in the note; no space before the next");
});

test("a word beside a commented picture, a second comment, a comment after a bare picture, an unclosed or broken note, or a highlight around two pictures keep the paragraph text", () => {
  for (const text of [
    `{==![a](x.png)==}${PICTURE_NOTE} word\n`,
    `{==![a](x.png)==}${PICTURE_NOTE}{>>again<<}\n`,
    `![a](x.png)${PICTURE_NOTE}\n`,
    "{==![a](x.png)==}{>>never closed\n",
    "{==![a](x.png)==}{>>almost<<\n",
    "{==![a](x.png)==}{>>two\nlines<<}\n",
    "{==![a](x.png)\n",
    "{==![a](x.png) ![b](y.png)==}{>>both<<}\n",
  ]) assert.deepEqual(imageFlags(text).filter(Boolean), [], JSON.stringify(text));
});

test("a long row of commented pictures followed by text, and a long unclosed note, are told apart at once", () => {
  assert.deepEqual(imageFlags(`${"{==![a](x)==}{>>n<<}   ".repeat(60)}x\n`), [false]);
  assert.deepEqual(imageFlags(`{==![a](x)==}{>>${"a<".repeat(2500)}\n`), [false]);
  assert.deepEqual(imageFlags(`${"{==![a](x)==}{>>n<<} \t ".repeat(60)}\n`), [true]);
});

test("picturesIn: a commented picture's whole markdown, its own picture inside the highlight, and its comment's text and place; a picture written in a comment is none", () => {
  const text = "# T\n\n{==![a](a.png)==}{>>n<<} ![b](b.png)\n{==[![c](c.png)](u)==}\n", d = parse(text), at = s => text.indexOf(s);
  assert.deepEqual(picturesIn(d, d.blocks[1]), [
    { start: at("{==![a]"), end: at(" ![b]"), from: at("![a]"), to: at("==}{>>n"), note: "n", noteAt: at("n<<}") },
    { start: at("![b]"), end: at("![b]") + 11, from: at("![b]"), to: at("![b]") + 11, note: null, noteAt: -1 },
    { start: at("{==[![c]"), end: text.length - 1, from: at("[![c]"), to: text.length - 4, note: null, noteAt: -1 },
  ]);
  const inNote = parse("{==![a](a.png)==}{>>see ![b](b.png)<<}\n");
  assert.deepEqual(sourcesIn(inNote, inNote.blocks[0]), ["{==![a](a.png)==}{>>see ![b](b.png)<<}"]);
  const item = parse("- item\n\n  {==![a](a.png)==}{>>n<<}\n  ![b](b.png)\n");
  assert.deepEqual(sourcesIn(item, item.blocks[1]), ["{==![a](a.png)==}{>>n<<}", "![b](b.png)"]);
});

test("removePicture: a commented picture goes with its highlight and its comment, as a bare one goes", () => {
  const row = `![a](a.png) {==![b](b.png)==}${PICTURE_NOTE} ![c](c.png)\n`;
  assert.deepEqual([1, 2].map(i => withoutPicture(row, i)), ["![a](a.png) ![c](c.png)\n", `![a](a.png) {==![b](b.png)==}${PICTURE_NOTE}\n`]);
  assert.equal(withoutPicture(`![a](a.png)\n{==![b](b.png)==}${PICTURE_NOTE}\n![c](c.png)\n`, 1), "![a](a.png)\n![c](c.png)\n", "alone on its line");
  assert.equal(withoutPicture(`# T\n\n{==[![b](b.png)](u)==}${PICTURE_NOTE}\n\nEnd\n`, 0), "# T\n\nEnd\n", "the only one, linked");
});

test("nesting follows the container rule: a fence right after an item's first line is its child", () => {
  const d = parse("1. Install:\n   ```bash\n   npm i\n   ```\n2. Run\n");
  assert.deepEqual(d.blocks.map(b => [b.kind, b.depth, b.parent]), [["item", 0, -1], ["code", 1, 0], ["item", 0, -1]]);
  assert.equal(field(d, d.blocks[0]).value, "Install:");
  assert.equal(field(d, d.blocks[1]).value, "npm i");
  assert.equal(d.blocks[0].subtreeEnd, d.blocks[1].end);
});

test("Enter inside the item's child fence is a raw newline: the fence is a raw block, its newline keeps the indent", () => {
  const d = parse("1. Install:\n   ```bash\n   npm i\n   ```\n2. Run\n"), code = d.blocks[1];
  assert.equal(isText(code), false);
  const f = field(d, code), caret = f.value.indexOf("npm i") + "npm i".length;
  const s = type(f, `${f.value.slice(0, caret)}\n${f.value.slice(caret)}`);
  const next = run(d.text, s);
  assert.equal(next, "1. Install:\n   ```bash\n   npm i\n   \n   ```\n2. Run\n");
  assert.deepEqual(kinds(parse(next)), ["item", "code", "item"]);
});

test("content on the marker line that is not a paragraph is the item's first child, starting mid-line", () => {
  const d = parse("- ```bash\n  x\n  ```\n1. # Title\n");
  assert.deepEqual(d.blocks.map(b => [b.kind, b.depth]), [["item", 0], ["code", 1], ["item", 0], ["heading", 1]]);
  assert.equal(raw(d, d.blocks[0]), "- ");
  assert.equal(field(d, d.blocks[0]).value, "");
  assert.equal(d.blocks[1].start, 2);
});

test("numbering: a list numbers from its start; blank lines and children do not break it; the source is not read again", () => {
  const n = t => parse(t).blocks.filter(b => b.kind === "item" && b.depth === 0).map(b => b.number);
  assert.deepEqual(n("1. a\n1. b\n1. c\n"), [1, 2, 3]);
  assert.deepEqual(n("3. a\n\n9. b\n   - x\n7. c\n"), [3, 4, 5]);
  assert.deepEqual(n("1. a\n\npara\n\n1. b\n"), [1, 1]);
  assert.deepEqual(n("1. a\n2) b\n"), [1, 2], "another delimiter starts another list");
  assert.deepEqual(n("- a\n- b\n").map(String), ["null", "null"]);
});

test("a BOM and blank lines before the first block are the lead", () => {
  const d = parse("﻿\n\n# Title\n");
  assert.deepEqual(d.lead, [0, 3]);
  assert.equal(d.blocks[0].kind, "heading");
  assert.deepEqual(parse("﻿---\na: 1\n---\n").blocks.map(b => b.kind), ["frontmatter"]);
});

test("eol is the file's first line ending, else \\n", () => {
  assert.equal(parse("a\r\nb\n").eol, "\r\n");
  assert.equal(parse("a\nb\r\n").eol, "\n");
  assert.equal(parse("a").eol, "\n");
  assert.equal(parse("a\r\rb").blocks.length, 1, "a lone CR is a character");
});

test("render: bodies joined with \\n, trailing spaces kept; definitions whose labels occur are appended", () => {
  const d = parse("see [the docs][d] and [x]  \nnext\n\n[d]: https://e.com\n[^x]: a note\n\nno links\n");
  assert.equal(d.blocks[0].render, "see [the docs][d] and [x]  \nnext\n\n[d]: https://e.com");
  assert.equal(d.blocks.at(-1).render, "no links");
  assert.deepEqual([...d.defs.keys()], ["D"]);
  assert.equal(parse("- [ ] task text\n").blocks[0].render, "task text");
  assert.equal(parse("```js\na\nb\n```\n").blocks[0].render, "a\nb");
  assert.equal(parse("---\nx: 1\n---\n").blocks[0].render, "x: 1");
});

test("a hard-wrapped README paragraph has a field with spaces at its soft breaks; editing one word changes only that word", () => {
  const readme = docs.find(x => x.name === "README.md").text, d = parse(readme);
  const b = d.blocks.find(x => x.kind === "paragraph" && x.lines.length >= 3 && !separators(field(d, x)).some(s => s.shown === "\n"));
  assert.ok(b, "a hard-wrapped paragraph");
  const f = field(d, b);
  assert.ok(!f.value.includes("\n"));
  for (const s of f.seps) {
    assert.equal(f.value[s.at], " ");
    assert.match(d.text.slice(s.start, s.end), /^[ \t]*\r?\n[ \t]*$/);
  }
  const word = /\b[a-z]{5,}\b/.exec(f.value);
  const next = f.value.slice(0, word.index) + "EDITED" + f.value.slice(word.index + word[0].length);
  const s = type(f, next), after = run(d.text, s);
  const changed = diff(d.text, after);
  assert.equal(d.text.slice(changed.at, changed.at + changed.removed), word[0]);
  assert.equal(changed.inserted, "EDITED");
  assert.equal(field(parse(after), parse(after).blocks[b.index]).value, next);
});

test("fieldToDoc and docToField: prefix maps to 0, a separator to its side of the EOL, suffix and tail to the end", () => {
  const d = parse("  ## Title ##\n\n- item one\n  two\n\nSet\next\n===\n"), [h, item, se] = d.blocks;
  const fh = field(d, h);
  assert.equal(fieldToDoc(fh, 0), d.text.indexOf("Title"));
  assert.equal(docToField(fh, 0), 0);
  assert.equal(docToField(fh, d.text.indexOf(" ##\n")), 5);
  assert.equal(docToField(fh, d.text.indexOf("##\n") + 1), 5);
  const fi = field(d, item), s = fi.seps[0];
  assert.equal(fi.value, "item one two");
  assert.equal(docToField(fi, s.start), s.at);
  assert.equal(docToField(fi, s.next), s.at + 1);
  assert.equal(fieldToDoc(fi, s.at + 1), d.text.indexOf("two"));
  const fs = field(d, se);
  assert.equal(docToField(fs, d.text.indexOf("===") + 1), fs.value.length);
  for (const b of d.blocks) {
    const f = field(d, b);
    for (let i = 0; i <= f.value.length; i++) assert.equal(docToField(f, fieldToDoc(f, i)), i, `${b.kind} ${i}`);
  }
});

test("an edit that changes nothing changes no byte", () => {
  const d = parse("- a\n  b\n"), f = field(d, d.blocks[0]);
  assert.equal(type(f, f.value), null);
});

// One of each kind of code block: its text, the block's index and the code Reading draws.
const CODE_BLOCKS = [
  ["a closed ``` block", "Intro\n\n```js\nconst a = 1;\n  return a;\n```\n\nAfter\n", 1, "const a = 1;\n  return a;"],
  ["a ~~~ block", "~~~\nx\n\ny\n~~~\n", 0, "x\n\ny"],
  ["an unclosed fence at the end of the file", "Intro\n\n```\nlast\nline", 1, "last\nline"],
  ["an empty block", "```py\n```\n", 0, ""],
  ["a fence indented two spaces", "  ```\n  two\n   three\n four\n  ```\n", 0, "two\n three\nfour"],
  ["an indented block, spaces and a tab", "    a\n\tb\n\n      c\n\nNext\n", 0, "a\nb\n\n  c"],
  ["a fenced block inside a list item", "- item\n\n  ```sh\n  npm i\n\n    --save\n  ```\n- next\n", 1, "npm i\n\n  --save"],
  ["a mermaid block", "```mermaid\ngraph TD\nA-->B\n```\n", 0, "graph TD\nA-->B"],
];

test("the field of a code block holds only what Reading draws: no fences, no indent Reading leaves out, no container prefix", () => {
  for (const [name, text, i, want] of CODE_BLOCKS) {
    const d = parse(text), b = d.blocks[i], f = field(d, b);
    assert.ok(b.kind === "code" || b.kind === "mermaid", name);
    assert.deepEqual([f.value, b.content], [want, want], name);
    for (let k = 0; k <= f.value.length; k++) {
      assert.equal(docToField(f, fieldToDoc(f, k)), k, `${name}: offset ${k}`);
      if (k < f.value.length && f.value[k] !== "\n") assert.equal(d.text[fieldToDoc(f, k)], f.value[k], `${name}: character ${k}`);
    }
  }
});

test("typing in a code field writes between the fences: each new line typed or pasted gets the container prefix and the code indent", () => {
  const typed = (text, i, edit) => {
    const d = parse(text), f = field(d, d.blocks[i]), next = edit(f.value), after = run(d.text, type(f, next)), nd = parse(after);
    assert.equal(field(nd, nd.blocks[i]).value, next, `${JSON.stringify(text)} re-parses to what was typed`);
    assert.equal(f.text, after, "the field keeps up");
    return after;
  };
  const item = "- item\n\n  ```sh\n  npm i\n  ```\n";
  assert.equal(typed(item, 1, v => `${v}x`), "- item\n\n  ```sh\n  npm ix\n  ```\n", "a character");
  assert.equal(typed(item, 1, v => `${v}\nnext`), "- item\n\n  ```sh\n  npm i\n  next\n  ```\n", "a line break");
  assert.equal(typed(item, 1, v => `${v}\none\n  two`), "- item\n\n  ```sh\n  npm i\n  one\n    two\n  ```\n", "a paste");
  assert.equal(typed("  ```\n  two\n  ```\n", 0, v => `${v}\nthree`), "  ```\n  two\n  three\n  ```\n", "the fence's indent");
  assert.equal(typed("    a\n", 0, v => `${v}\nb`), "    a\n    b\n", "an indented block's four spaces");
  assert.equal(typed("- item\n\n      code\n", 1, v => `${v}\nmore`), "- item\n\n      code\n      more\n", "inside an item");
  assert.equal(typed("- item\n\n  ```sh\n  npm i\n\n  ```\n", 1, v => `${v}z`), "- item\n\n  ```sh\n  npm i\n  z\n  ```\n",
    "typed on a blank line that has no prefix, the line gets it");
  assert.equal(typed("    a\n\n    b\n", 0, v => v.replace("\n\n", "\nz\n")), "    a\n    z\n    b\n", "so it stays in an indented block");
});

test("the first character typed in an empty code block writes its line between the fences, closed or not, in an item, with CRLF", () => {
  for (const [text, i, next, want, more] of [
    ["```\n```\n", 0, "x", "```\nx\n```\n", "```\nx!\n```\n"],
    ["```py\n```", 0, "x\ny", "```py\nx\ny\n```", "```py\nx\ny!\n```"],
    ["```", 0, "x\ny", "```\nx\ny", "```\nx\ny!"],
    ["Intro\n\n```\n", 1, "x", "Intro\n\n```\nx\n", "Intro\n\n```\nx!\n"],
    ["- a\n\n  ```\n  ```\n", 1, "x\n", "- a\n\n  ```\n  x\n  \n  ```\n", "- a\n\n  ```\n  x\n  !\n  ```\n"],
    ["```\r\n```\r\n", 0, "x\ny", "```\r\nx\r\ny\r\n```\r\n", "```\r\nx\r\ny!\r\n```\r\n"],
  ]) {
    const d = parse(text), f = field(d, d.blocks[i]);
    assert.equal(f.value, "", JSON.stringify(text));
    const s = type(f, next), after = run(d.text, s);
    assert.equal(after, want, JSON.stringify(text));
    assert.equal(s.caret, fieldToDoc(f, next.length));
    assert.equal(run(after, type(f, `${next}!`)), more, `${JSON.stringify(text)}: then typing goes on`);
  }
});

test("blank lines typed at the end of an indented block stay in its field, though the block does not hold them", () => {
  let d = parse("Code:\n\n    a\n\nNext\n");
  for (const next of ["a\n", "a\n\n", "a\n\n  "]) {
    const f = field(d, d.blocks[1]);
    d = parse(run(d.text, type(f, next)));
    assert.deepEqual([d.blocks[1].content, field(d, d.blocks[1]).value], ["a", next]);
  }
  assert.equal(d.text, "Code:\n\n    a\n    \n      \n\nNext\n");
  assert.equal(field(parse("    a\n\n    \nNext\n"), parse("    a\n\n    \nNext\n").blocks[0]).value, "a", "past a line without the indent, none");
});

test("lengthenFence: a line typed in a fenced block that would close it makes both fences longer than it, the field kept in step", () => {
  const typedLine = (text, i, edit) => {
    const d = parse(text), f = field(d, d.blocks[i]), next = edit(f.value), dd = diff(f.value, next);
    const after = run(d.text, type(f, next)), g = lengthenFence(f, dd.at, dd.at + dd.inserted.length);
    return { f, after: g ? run(after, g) : after, g };
  };
  const plain = typedLine("```js\na\n```\n\nNext\n", 0, v => `${v}\n\`\`\``);
  assert.equal(plain.after, "````js\na\n```\n````\n\nNext\n");
  assert.deepEqual(parse(plain.after).blocks.map(b => [b.kind, field(parse(plain.after), b).value]), [["code", "a\n```"], ["paragraph", "Next"]]);
  assert.equal(plain.f.text, plain.after, "the field keeps up");
  for (let k = 0; k <= plain.f.value.length; k++) assert.equal(docToField(plain.f, fieldToDoc(plain.f, k)), k);
  assert.equal(run(plain.after, type(plain.f, "a\n```\nb")), "````js\na\n```\nb\n````\n\nNext\n", "typing goes on");
  assert.equal(typedLine("```\na\n```\n", 0, v => `${v}\n\`\`\`\`\``).after, "``````\na\n`````\n``````\n", "longer than the longest");
  assert.equal(typedLine("```\na\n``````\n", 0, v => `${v}\n\`\`\``).after, "````\na\n```\n``````\n", "a closing fence long enough stays");
  assert.equal(typedLine("```\na", 0, v => `${v}\n\`\`\``).after, "````\na\n```", "an unclosed fence: the opening one");
  assert.equal(typedLine("```\n```x\n```\n", 0, v => v.slice(0, -1)).after, "````\n```\n````\n", "a deletion that leaves a closing line");
  assert.equal(typedLine("  ```\n  a\n  ```\n", 0, v => `${v}\n\`\`\``).after, "  ````\n  a\n  ```\n  ````\n", "under an indented fence");
  assert.equal(typedLine("  ```\n x\n  ```\n", 0, () => "  ```").after, "  ````\n   ```\n  ````\n",
    "on a line indented less than its fence, spaces typed at its start count from the file's indent");
  assert.equal(typedLine("```mermaid\ngraph\n```\n", 0, v => `${v}\n\`\`\``).after, "````mermaid\ngraph\n```\n````\n");
  const empty = typedLine("```\n```\n", 0, () => "```");
  assert.equal(empty.after, "````\n```\n````\n", "the first line of an empty block");
  assert.equal(run(empty.after, type(empty.f, "```\nx")), "````\n```\nx\n````\n");
  for (const [text, edit] of [
    ["~~~\na\n~~~\n", v => `${v}\n\`\`\``],
    ["```\na\n```\n", v => `${v}\n\`\`\`x`],
    ["```\na\n```\n", v => `${v}\n\`\``],
    ["```\na\n```\n", v => `${v}\n\t\`\`\``],
    ["  ```\n  a\n  ```\n", v => `${v}\n  \`\`\``],
    ["    a\n", v => `${v}\n\`\`\``],
  ]) assert.equal(typedLine(text, 0, edit).g, null, `${JSON.stringify(text)}: nothing would close it`);
});

test("new lines use contPrefix and the document EOL; tabs are never converted", () => {
  const d = parse("- one\r\n\t- two\r\n"), b = d.blocks[1], f = field(d, b);
  assert.equal(b.depth, 1);
  const s = type(f, "two\\\nthree");
  assert.equal(run(d.text, s), "- one\r\n\t- two\\\r\n\t  three\r\n");
  const q = parse("> a\n"), fq = field(q, q.blocks[0]);
  assert.equal(run(q.text, type(fq, "a\\\nb")), "> a\\\n> b\n");
});

test("typing keeps the field in step: separators shift, the caret is where the text went", () => {
  let d = parse("aaa bbb\nccc ddd\neee\n");
  const f = field(d, d.blocks[0]);
  let text = d.text, value = f.value;
  for (const [pos, str] of [[3, "X"], [12, "YY"], [0, "Z"], [f.value.length + 4, "!"]]) {
    value = value.slice(0, pos) + str + value.slice(pos);
    const s = type(f, value);
    text = run(text, s);
    assert.equal(s.caret, fieldToDoc(f, pos + str.length));
    assert.equal(f.text, text);
  }
  d = parse(text);
  assert.equal(field(d, d.blocks[0]).value, value);
  assert.deepEqual(separators(f).map(s => [s.at, s.start, s.end]), field(d, d.blocks[0]).seps.map(s => [s.at, s.start, s.end]));
});

test("the caret before a key says which side of a soft break a typed space goes, and which twin a backspace takes", () => {
  const d = parse("> aa\n> aa\n"), f = field(d, d.blocks[0]);
  assert.equal(f.value, "aa aa");
  const s = type(f, "aa  aa", 2);
  assert.equal(run(d.text, s), "> aa \n> aa\n", "at the end of line one, where the caret was");
  const p = parse("tt tt\n"), fp = field(p, p.blocks[0]);
  const b = type(fp, "tt t", 4);
  assert.deepEqual([b.start, b.end], [3, 4], "the t before the caret, not the last one");
  const q = parse("tt tt\n"), fq = field(q, q.blocks[0]);
  assert.deepEqual([type(fq, "tt t").start], [4], "without a caret, the diff's choice");
  const e = parse("**ab**b\n"), fe = field(e, e.blocks[0]);
  const forward = type(fe, "**ab", { at: 4, removed: 3, inserted: "" });
  assert.deepEqual([forward.start, forward.end, forward.fieldCaret], [4, 7, 4], "the change itself: a Delete of `**b`");
  const g = parse("**ab**b\n"), fg = field(g, g.blocks[0]);
  const back = type(fg, "**ab", { at: 3, removed: 3, inserted: "" });
  assert.deepEqual([back.start, back.end, back.fieldCaret], [3, 6, 3], "a Backspace of `b**`");
  const h = parse("ab\n"), fh = field(h, h.blocks[0]);
  assert.deepEqual([type(fh, "axb", { at: 0, removed: 0, inserted: "x" }).start], [1], "a change that does not make the value: the diff's");
});

test("fix-up, empty marker: typing into `-` or `#` puts one space after the marker first", () => {
  for (const [text, typed, want] of [["-\n", "a", "- a\n"], ["1.\n", "x", "1. x\n"], ["#\n", "Title", "# Title\n"]]) {
    const d = parse(text), f = field(d, d.blocks[0]);
    assert.equal(f.value, "");
    const s = type(f, typed), next = run(d.text, s);
    assert.equal(next, want, text);
    assert.equal(field(parse(next), parse(next).blocks[0]).value, typed);
    assert.equal(s.caret, next.indexOf(typed) + typed.length);
  }
});

test("fix-up, lazy line: a lazy quote line that would start a block is indented so it stays the quote's text", () => {
  const d = parse("> a\nb\n> c\n"), f = field(d, d.blocks[0]);
  assert.equal(f.value, "a b c");
  const next = run(d.text, type(f, "a - x c"));
  assert.equal(next, "> a\n    - x\n> c\n");
  assert.deepEqual(kinds(parse(next)), ["quote"]);
  assert.equal(field(parse(next), parse(next).blocks[0]).value, "a - x c");
});

test("fix-up in a quote: a line that would start a block inside it stays the quote's paragraph text, field unchanged", () => {
  const cases = [
    ["> Run it\n> now - carefully\n", v => v.replace("now ", ""), "> Run it\n>     - carefully\n"],
    ["> a\n> b\n", v => v.replace("b", "# b"), "> a\n>     # b\n"],
    ["> - a\n> b more\n", v => v.replace("b more", "- more"), "> - a\n>       - more\n"],
    ["> foo\nbar\n", v => v.replace("bar", "- bar"), "> foo\n    - bar\n"],
    ["> foo\n    - bar\n", v => v.replace("bar", "b"), "> foo\n    - b\n"],
  ];
  for (const [text, edit, want] of cases) {
    const d = parse(text), f = field(d, d.blocks[0]), edited = edit(f.value), next = run(text, type(f, edited));
    assert.equal(next, want, JSON.stringify(text));
    const nd = parse(next);
    assert.deepEqual(kinds(nd), ["quote"]);
    assert.equal(field(nd, nd.blocks[0]).value, edited, JSON.stringify(text));
  }
  const nested = parse("> > a\n> > b\n"), fn = field(nested, nested.blocks[0]);
  assert.equal(run(nested.text, type(fn, `${fn.value}x`)), "> > a\n> > bx\n", "a nested quote's own lines are not re-indented");
});

test("in a quote, a paragraph continuation line's indent belongs to the soft break, as in a paragraph", () => {
  for (const [text, value] of [["> a\n>   b\n", "a b"], ["> - a\n>   b\n", "- a b"], ["> a\n>     b\n", "a b"]]) {
    const d = parse(text), f = field(d, d.blocks[0]);
    assert.equal(f.value, value);
    assert.equal(run(text, type(f, `${value}!`)), text.replace(/\n$/, "!\n"));
  }
  const lazy = parse("> foo\nbar\n===\n");
  assert.equal(field(lazy, lazy.blocks[0]).value, "foo bar ===", "a lazy line is never a setext underline (CommonMark #93)");
});

test("fix-up, lazy line: a paragraph line that would start a block is indented so it stays text", () => {
  const d = parse("- item\nlazy word\n\npara one\nx # two\n");
  const fi = field(d, d.blocks[0]), item = run(d.text, type(fi, "item # word"));
  assert.deepEqual(values(parse(item)).slice(0, 1), ["item # word"]);
  const fp = field(d, d.blocks[1]), para = run(d.text, type(fp, "para one # two"));
  assert.equal(para, "- item\nlazy word\n\npara one\n    # two\n");
  assert.deepEqual(values(parse(para)), ["item lazy word", "para one # two"]);
});

test("fix-up, child on the marker line: typing into the empty item moves the child to its own line", () => {
  const d = parse("- ```bash\n  npm i\n  ```\n"), f = field(d, d.blocks[0]);
  assert.equal(f.value, "");
  const next = run(d.text, type(f, "Install:"));
  assert.equal(next, "- Install:\n  ```bash\n  npm i\n  ```\n");
  assert.deepEqual(parse(next).blocks.map(b => [b.kind, b.depth]), [["item", 0], ["code", 1]]);
});

test("fix-up, empty item above a block it would take in: typing into it adds the blank line that keeps that block out", () => {
  for (const [text, want, fields] of [
    ["-\nfoo\n", "- x\n\nfoo\n", ["x", "foo"]],
    ["-\n  foo\n", "- x\n\n  foo\n", ["x", "foo"]],
    ["-\n      baz\n", "- x\n\n      baz\n", ["x", "baz"]],
    ["-\n- b\n", "- x\n- b\n", ["x", "b"]],
    ["-\n2. b\n", "- x\n2. b\n", ["x", "b"]],
  ]) {
    const d = parse(text), f = field(d, d.blocks[0]), next = run(d.text, type(f, "x"));
    assert.equal(next, want, JSON.stringify(text));
    assert.deepEqual(values(parse(next)), fields, JSON.stringify(text));
  }
});

test("fix-up, emptied line: deleting the words of a source line joins its neighbours instead of splitting the paragraph", () => {
  const d = parse("aaa\nbbb\nccc\n"), f = field(d, d.blocks[0]);
  const next = run(d.text, type(f, "aaa  ccc"));
  assert.deepEqual(kinds(parse(next)), ["paragraph"]);
  assert.equal(field(parse(next), parse(next).blocks[0]).value.replace(/ +/g, " "), "aaa ccc");
});

// A hard line break: two spaces or a backslash before the EOL, where the source had no break of its own. Typing can
// make or unmake one, so the property shows those as spaces on both sides; every other line break must survive.
const hardAt = (text, s) => / {2,}$|(?:^|[^\\])(?:\\\\)*\\$/.test(text.slice(Math.max(0, s.eol - 64), s.eol));
const softened = (value, ats) => {
  const chars = value.split("");
  for (const a of ats) if (chars[a] === "\n") chars[a] = " ";
  return chars.join("");
};
// What the source can hold of a field value: whitespace runs are one space, and none at either end.
const norm = v => v.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
// Typing a block's marker at the start of a field is a shortcut that makes that block; fences and rules are made by
// Enter.
const SHORTCUT = /^(?:#{1,6}(?:[ \t]|$)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|\[[ xX]?\](?:[ \t]|$)|`{3}|~{3})/;
const HR_LINE = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
// Out of scope: a field that starts with whitespace. Markdown has no leading whitespace in a block's text: what is left
// is indent, and four columns of it make code. The typing splice writes it as it is.
const LEADING_WHITESPACE = /^\s/;
const lineHead = s => (BLANK_LINE.test(s) ? "blank" : (QUOTED_START.exec(s)?.[0].trim() ?? "text"));
const BLANK_LINE = /^[ \t]*$/;
const QUOTED_START = /^ {0,3}(?:#{1,6}(?=[ \t]|$)|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)|>|`{3,}|~{3,}|<[!?/]?[A-Za-z]*|[=-]+[ \t]*$|\|)/;
const lineAround = (v, i) => {
  const end = v.indexOf("\n", i);
  return v.slice(v.lastIndexOf("\n", i - 1) + 1, end < 0 ? v.length : end);
};

test("random field edits on every corpus text block touch only their splice range and re-parse to the edited value", () => {
  const rnd = random(20261105);
  let edits = 0, markdown = 0;
  const texts = everyText();
  for (const c of texts) {
    const d = parse(c.text);
    for (const b of d.blocks) {
      if (!isText(b)) continue;
      for (let n = 0; n < 3; n++) {
        const f = field(d, b), v = f.value, i = rnd.int(v.length + 1);
        let next, j = i, typed = "";
        if (rnd() < 0.5) {
          const len = 1 + rnd.int(6);
          for (let k = 0; k < len; k++) typed += rnd() < 0.25 ? " " : "abcdefghij"[rnd.int(10)];
          next = v.slice(0, i) + typed + v.slice(i);
        } else {
          j = Math.min(v.length, i + 1 + rnd.int(rnd() < 0.2 ? v.length : 12));
          next = v.slice(0, i) + v.slice(j);
        }
        const line0 = next.split("\n")[0], where = `${c.name}: ${JSON.stringify(v)} -> ${JSON.stringify(next)}`;
        if (!next.trim() || next === v || SHORTCUT.test(line0) || HR_LINE.test(line0) || LEADING_WHITESPACE.test(next)) continue;
        // A closing # run is the heading's suffix, not its text.
        if (b.kind === "heading" && /#\s*$/.test(next)) continue;
        // A quote that ends in a fence or heading, with text right below it, takes that text in once its last line
        // becomes text. The typing splice cannot see the next block; that merge is the commit's to catch.
        if (b.kind === "quote" && d.blocks[b.index + 1]?.start === b.end) continue;
        // A definition right above takes a paragraph's first line in as its title once that line is one.
        if (d.blocks[b.index - 1]?.kind === "definition" && d.blocks[b.index - 1].end === b.start) continue;
        const before = separators(f), structural = x => x.shown === "\n" && !hardAt(d.text, x);
        // In a quote, editing the marker of a block it holds, typing on its blank line or deleting a line break between
        // its blocks changes those blocks (and the line breaks around them) as the markdown says, as a shortcut does.
        if (b.kind === "quote" && lineHead(lineAround(v, i)) !== lineHead(lineAround(next, i))) continue;
        if (b.kind === "quote" && before.some(x => structural(x) && x.at >= i && x.at < j)) continue;
        const keptHard = before.filter(x => x.shown === "\n" && !structural(x) && (x.at < i || x.at >= j)).map(x => (x.at < i ? x.at : x.at + typed.length - (j - i)));
        const s = type(f, next);
        assert.ok(s.start >= b.start && s.end <= b.end, `${c.name}: the splice stays in its ${b.kind}`);
        const after = run(d.text, s);
        assert.equal(after.slice(0, s.start), d.text.slice(0, s.start));
        assert.equal(after.slice(s.start + s.insert.length), d.text.slice(s.end));
        const nd = reparse(d, s), nb = nd.blocks[b.index];
        // After the edit, a paragraph that starts with an HTML tag or a `[label]:`, or whose first line matches the
        // delimiter row below it, is that HTML block, definition or table, as the source says.
        const html = nb?.kind === "html" && next.startsWith("<"), definition = nb?.kind === "definition" && next.startsWith("[");
        if (b.kind === "paragraph" && (html || definition || (nb?.kind === "table" && line0.includes("|")))) {
          markdown++;
          continue;
        }
        assert.equal(nb?.kind, b.kind, where);
        const fn = field(nd, nb), delta = s.insert.length - (s.end - s.start);
        const moved = p => (p <= s.start ? p : p >= s.end ? p + delta : -1);
        const ownBreaks = new Set(before.filter(structural).map(x => moved(x.next)));
        const madeHard = fn.seps.filter(x => x.shown === "\n" && hardAt(nd.text, x) && !ownBreaks.has(x.next)).map(x => x.at);
        assert.equal(norm(softened(fn.value, madeHard)), norm(softened(next, keptHard)), where);
        edits++;
      }
    }
  }
  assert.ok(edits > 3000, `${edits} edits`);
  assert.ok(markdown < edits / 1000, `${markdown} edits turned a paragraph into an HTML block, a definition or a table`);
});

test("setext: Enter after Hello in `Hello World / ===` keeps Hello as the heading", () => {
  const d = parse("Hello World\n===\n"), s = split(d, d.blocks[0], 5), next = run(d.text, s);
  assert.equal(next, "Hello\n===\n\nWorld\n");
  const nd = parse(next);
  assert.deepEqual(nd.blocks.map(b => [b.kind, field(nd, b).value]), [["heading", "Hello"], ["paragraph", "World"]]);
  assert.equal(s.caret, next.indexOf("World"));
});

test("setext: Delete at the end of a paragraph before a setext heading leaves a paragraph", () => {
  const d = parse("Intro\n\nTitle\n=====\n"), next = run(d.text, mergeNext(d, d.blocks[0], d.blocks[1]));
  assert.equal(next, "IntroTitle\n");
  assert.deepEqual(kinds(parse(next)), ["paragraph"]);
});

test("removing the code block from `Run: / ```bash … ``` / Then check.` leaves two paragraphs (fusion guard)", () => {
  const d = parse("Run:\n```bash\nnpm test\n```\nThen check.\n"), s = remove(d, d.blocks[1]), next = run(d.text, s);
  assert.equal(next, "Run:\n\nThen check.\n");
  assert.deepEqual(values(parse(next)), ["Run:", "Then check."]);
});

test("the fusion guard runs after toParagraph, mergeNext, move and removeRange too", () => {
  const cases = [
    [d => toParagraph(d, d.blocks[1]), "Intro text\n## Setup\nInstall node.\n", ["Intro text", "Setup", "Install node."]],
    [d => remove(d, d.blocks[1]), "a\n***\nb\n", ["a", "b"]],
    [d => mergeNext(d, d.blocks[0], d.blocks[1]), "foo\n# h\nbar\n", ["fooh", "bar"]],
    [d => move(d, d.blocks[1], -1), "para1\n\n# H\npara2\n", ["H", "para1", "para2"]],
    [d => removeRange(d, d.blocks[1], d.blocks[2]), "a\n# h\n***\nb\n", ["a", "b"]],
  ];
  for (const [op, text, want] of cases) {
    const d = parse(text), next = run(text, op(d));
    assert.deepEqual(values(parse(next)), want, JSON.stringify(text));
  }
});

test("indent then outdent of a tab-indented item restores the exact bytes", () => {
  for (const [text, i, indented] of [
    ["- a\n\t- b\n\t- c\n\t  more\n", 2, "- a\n\t- b\n\t\t- c\n\t\t  more\n"],
    ["- a\n- b\n  - b1\n- c\n", 1, "- a\n  - b\n    - b1\n- c\n"],
  ]) {
    const d = parse(text), once = run(text, indent(d, d.blocks[i]));
    assert.equal(once, indented);
    const nd = parse(once), moved = nd.blocks[i];
    assert.equal(moved.depth, d.blocks[i].depth + 1);
    assert.equal(run(once, outdent(nd, moved)), text);
  }
  const o = parse("1. a\n2. b\n"), sub = run(o.text, indent(o, o.blocks[1]));
  assert.equal(sub, "1. a\n   1. b\n", "a new ordered sublist starts at 1");
});

test("indent joins the sibling's sub-list with its marker; it needs a previous sibling", () => {
  const d = parse("- a\n  * a1\n- b\n  - b1\n");
  const next = run(d.text, indent(d, d.blocks[2]));
  assert.equal(next, "- a\n  * a1\n  * b\n    - b1\n");
  assert.equal(indent(d, d.blocks[0]), null);
  const o = parse("1. a\n   1. a1\n   2. a2\n2. b\n");
  assert.equal(run(o.text, indent(o, o.blocks[3])), "1. a\n   1. a1\n   2. a2\n   3. b\n");
});

test("outdent: later siblings become the outdented item's children", () => {
  const d = parse("- a\n  - b\n  - c\n"), next = run(d.text, outdent(d, d.blocks[1]));
  assert.equal(next, "- a\n- b\n  - c\n");
  assert.deepEqual(parse(next).blocks.map(b => [field(parse(next), b).value, b.depth, b.parent]), [["a", 0, -1], ["b", 0, -1], ["c", 1, 1]]);
});

test("insertAfter an item with item children gives a first child; with other children, a sibling after them", () => {
  const d = parse("- [ ] Phase 2\n  - [ ] write tests\n  - [ ] run tests\n- [ ] Phase 3\n");
  const s = insertAfter(d, d.blocks[0], "item", "new"), next = run(d.text, s);
  assert.equal(next, "- [ ] Phase 2\n  - [ ] new\n  - [ ] write tests\n  - [ ] run tests\n- [ ] Phase 3\n");
  assert.equal(s.caret, next.indexOf("new") + 3);
  const p = parse("- a\n\n  note\n- b\n"), sib = run(p.text, insertAfter(p, p.blocks[0], "item", "x"));
  assert.equal(sib, "- a\n\n  note\n- x\n- b\n");
});

test("insertAfter before an unclosed fence closes it first", () => {
  for (const [text, want] of [["```js\nx\n", "```js\nx\n```\n\nnew\n"], ["```js\nx", "```js\nx\n```\n\nnew"]]) {
    const d = parse(text), next = run(text, insertAfter(d, d.blocks[0], "paragraph", "new"));
    assert.equal(next, want);
    assert.deepEqual(kinds(parse(next)), ["code", "paragraph"]);
  }
  const h = parse("<!-- open\nstill comment\n"), next = run(h.text, insertAfter(h, h.blocks[0], "paragraph", "after"));
  assert.deepEqual(kinds(parse(next)), ["html", "paragraph"]);
});

test("insertAt on an empty file and after front matter", () => {
  for (const [text, want] of [["", "Hello"], ["﻿", "﻿Hello"], ["\n\n", "\n\nHello"], ["---\na: 1\n---\n", "---\na: 1\n---\n\nHello\n"]]) {
    const d = parse(text), s = insertAt(d, "paragraph", "Hello"), next = run(text, s);
    assert.equal(next, want, JSON.stringify(text));
    assert.equal(s.caret, next.indexOf("Hello") + 5);
    assert.equal(parse(next).blocks.at(-1).kind, "paragraph");
  }
});

test("insertAfter and insertBefore: separators tight between items of a list, loose otherwise", () => {
  const cases = [
    [d => insertAfter(d, d.blocks[0], "item", "x"), "- a\n- b\n", "- a\n- x\n- b\n"],
    [d => insertAfter(d, d.blocks[0], "item", "x"), "1. a\n2. b\n", "1. a\n2. x\n2. b\n"],
    [d => insertAfter(d, d.blocks[0], "paragraph", "x"), "# h\nb\n", "# h\n\nx\n\nb\n"],
    [d => insertAfter(d, d.blocks[0], "paragraph", "x"), "a\n\nb\n", "a\n\nx\n\nb\n"],
    [d => insertAfter(d, d.blocks[0], "paragraph", "x"), "a", "a\n\nx"],
    [d => insertBefore(d, d.blocks[0], "paragraph", "x"), "# h\n", "x\n\n# h\n"],
    [d => insertBefore(d, d.blocks[1], "paragraph", "x"), "a\n\n# h\n", "a\n\nx\n\n# h\n"],
    [d => insertBefore(d, d.blocks[1], "item", "x"), "- a\n- b\n", "- a\n- x\n- b\n"],
    [d => insertBefore(d, d.blocks[1], "paragraph", "x"), "- ```\n  y\n  ```\n", "x\n\n- ```\n  y\n  ```\n"],
  ];
  for (const [op, text, want] of cases) assert.equal(run(text, op(parse(text))), want, JSON.stringify(text));
});

test("insertBefore a first child right below its parent's text makes a new block and leaves the parent's text", () => {
  for (const [text, want] of [
    ["- a\n  # h\n", "- a\n\n  new\n\n  # h\n"],
    ["- a\n  > b\n", "- a\n\n  new\n\n  > b\n"],
    ["1. a\n   ```\n   x\n   ```\n", "1. a\n\n   new\n\n   ```\n   x\n   ```\n"],
    ["-\n  # h\n", "-\n  new\n\n  # h\n"],
  ]) {
    const d = parse(text), s = insertBefore(d, d.blocks[1], "paragraph", "new"), next = run(text, s), nd = parse(next);
    assert.equal(next, want, JSON.stringify(text));
    assert.equal(s.caret, next.indexOf("new") + 3);
    assert.deepEqual(values(nd).slice(0, 2), [values(d)[0], "new"]);
    assert.deepEqual(nd.blocks.map(b => b.depth), [0, 1, 1]);
  }
});

test("split: a paragraph gets one blank line, an item a sibling, a quote a new quoted paragraph", () => {
  const cases = [
    ["one two", 3, "one\n\ntwo\n"],
    ["- one two", 3, "- one\n- two\n"],
    ["3) one two", 3, "3) one\n4) two\n"],
    ["- [x] one two", 3, "- [x] one\n- [ ] two\n"],
    ["> one two", 3, "> one\n>\n> two\n"],
    ["# one two #", 3, "# one #\n\ntwo\n"],
    ["- a b\n  - c", 1, "- a\n  - b\n  - c\n"],
  ];
  for (const [text, at0, want] of cases) {
    const d = parse(`${text}\n`), s = split(d, d.blocks[0], at0);
    assert.equal(run(d.text, s), want, text);
  }
});

test("mergeIntoPrevious joins b's text to a's last line with the caret at the join; a setext tail stays after it", () => {
  const d = parse("Para a\n\nPara b\n"), s = mergeIntoPrevious(d, d.blocks[0], d.blocks[1]);
  assert.equal(run(d.text, s), "Para aPara b\n");
  assert.equal(s.caret, 6);
  const t = parse("Title\n===\n\nbody\n");
  assert.equal(run(t.text, mergeIntoPrevious(t, t.blocks[0], t.blocks[1])), "Titlebody\n===\n");
  const a = parse("# Head ##\n\nx\ny\n");
  assert.equal(run(a.text, mergeIntoPrevious(a, a.blocks[0], a.blocks[1])), "# Headx y ##\n");
});

test("remove takes the block and its gap; the last block takes the gap before it", () => {
  assert.equal(run("a\n\nb\n\nc\n", remove(parse("a\n\nb\n\nc\n"), parse("a\n\nb\n\nc\n").blocks[1])), "a\n\nc\n");
  const d = parse("a\n\nb\n\n");
  assert.equal(run(d.text, remove(d, d.blocks[1])), "a\n");
  const n = parse("a\n\nb");
  assert.equal(run(n.text, remove(n, n.blocks[1])), "a\n");
});

test("toParagraph: markers go; a quote loses one `>` per line; a setext heading its tail; a list item between items gets blank lines", () => {
  const cases = [
    ["## Title ##\n", 0, "Title\n"],
    ["Title\n---\nnext\n", 0, "Title\n\nnext\n"],
    ["> a\n> > b\nlazy\n", 0, "a\n> b\nlazy\n"],
    ["- a\n- b\n- c\n", 1, "- a\n\nb\n\n- c\n"],
    ["1. a\n2. b\n3. c\n", 1, "1. a\n\nb\n\n3. c\n"],
    ["- [ ] task\n", 0, "task\n"],
  ];
  for (const [text, i, want] of cases) {
    const d = parse(text);
    assert.equal(run(text, toParagraph(d, d.blocks[i])), want, JSON.stringify(text));
  }
  assert.equal(toParagraph(parse("plain\n"), parse("plain\n").blocks[0]), null);
});

test("nest and unnest: a paragraph after an item becomes its continuation block, and back", () => {
  const d = parse("- item\n\npara\n"), next = run(d.text, nest(d, d.blocks[1]));
  assert.equal(next, "- item\n\n  para\n");
  const nd = parse(next);
  assert.deepEqual(nd.blocks.map(b => [b.kind, b.depth]), [["item", 0], ["paragraph", 1]]);
  assert.equal(run(next, unnest(nd, nd.blocks[1])), d.text);
  const c = parse("1. step\n```\nx\n```\n");
  assert.equal(run(c.text, nest(c, c.blocks[1])), "1. step\n\n   ```\n   x\n   ```\n");
  assert.equal(nest(parse("para\n"), parse("para\n").blocks[0]), null);
});

test("move swaps a block's subtree with its sibling's; a file without a final newline keeps that", () => {
  const d = parse("- a\n- b\n  - b1\n- c\n"), up = move(d, d.blocks[1], -1), next = run(d.text, up);
  assert.equal(next, "- b\n  - b1\n- a\n- c\n");
  assert.equal(up.caret, next.indexOf("b"));
  assert.equal(run(d.text, move(d, d.blocks[1], 1)), "- a\n- c\n- b\n  - b1\n");
  assert.equal(move(d, d.blocks[0], -1), null);
  const n = parse("a\n\nb");
  assert.equal(run(n.text, move(n, n.blocks[1], -1)), "b\n\na");
  // The moved block's field starts where the caret goes, in the moved text: found by its field value.
  const fieldStart = (text, value) => {
    const p = parse(text), x = p.blocks.find(y => field(p, y).value === value);
    return x.start + x.lines[0].body;
  };
  for (const [text, want] of [["- a\n\n- b", "- b\n\n- a"], ["# H\n\npara", "para\n\n# H"], ["- a\r\n\r\n- b", "- b\r\n\r\n- a"], ["- a\n- b", "- b\n- a"]]) {
    const t = parse(text), s = move(t, t.blocks[1], -1), next = run(text, s);
    assert.equal(next, want, `${JSON.stringify(text)}: the gap stays between them`);
    assert.equal(s.caret, t.blocks[1].lines[0].body, "the caret at the start of the moved block's field");
    const down = move(t, t.blocks[0], 1);
    assert.equal(run(text, down), want);
    assert.equal(down.caret, fieldStart(want, field(t, t.blocks[0]).value), `${JSON.stringify(text)}: moving down, the caret goes with the block`);
  }
  for (const [text, want] of [["- a\n\n- b\n  ", "- b\n\n- a\n  "], ["a\n\nb\n \t", "b\n\na\n \t"]]) {
    const t = parse(text), up = move(t, t.blocks[1], -1);
    assert.equal(run(text, up), want, `${JSON.stringify(text)}: what ends the file stays at the end, no byte lost or added`);
    assert.equal(up.caret, fieldStart(want, field(t, t.blocks[1]).value));
  }
  const loose = parse(run("- a\n\n- b", move(parse("- a\n\n- b"), parse("- a\n\n- b").blocks[1], -1)));
  assert.deepEqual(loose.blocks.map(b => [b.kind, b.gapEnd > b.end]), [["item", true], ["item", false]], "the list stays loose");
  const o = parse("1. one\n2. two\n");
  assert.equal(run(o.text, move(o, o.blocks[1], -1)), "2. two\n1. one\n", "numbers in the source stay");
});

test("move takes the runs of siblings unitOf gives, a block with the paragraph that goes with it, as one", () => {
  const text = "Intro\n\n```\nx\n```\n\n{>>a<<}\n\nEnd\n\nTail\n", d = parse(text), [intro, code, para, end, tail] = d.blocks;
  const unitOf = b => (b === code || b === para ? [code, para] : [b, b]);
  const down = move(d, code, 1, unitOf), up = move(d, code, -1, unitOf);
  assert.equal(run(text, down), "Intro\n\nEnd\n\n```\nx\n```\n\n{>>a<<}\n\nTail\n");
  assert.equal(down.caret, run(text, down).indexOf("```"), "the caret goes with the block");
  assert.equal(run(text, up), "```\nx\n```\n\n{>>a<<}\n\nIntro\n\nEnd\n\nTail\n");
  assert.equal(run(text, move(d, end, -1, unitOf)), "Intro\n\nEnd\n\n```\nx\n```\n\n{>>a<<}\n\nTail\n", "a block passes the two together, up");
  assert.equal(run(text, move(d, intro, 1, unitOf)), "```\nx\n```\n\n{>>a<<}\n\nIntro\n\nEnd\n\nTail\n", "and down");
  assert.equal(move(d, tail, 1, unitOf), null);
  const last = parse("End\n\n```\nx\n```\n\n{>>a<<}"), [e, c, p] = last.blocks, units = b => (b === c || b === p ? [c, p] : [b, b]);
  assert.equal(run(last.text, move(last, c, -1, units)), "```\nx\n```\n\n{>>a<<}\n\nEnd", "no final line break stays so");
});

test("toggleTask flips one character; on a wrong offset it changes nothing", () => {
  const d = parse("- [ ] a\n- [x] b\n- [X] c\n");
  assert.deepEqual(d.blocks.map(b => run(d.text, toggleTask(d, b))), ["- [x] a\n- [x] b\n- [X] c\n", "- [ ] a\n- [ ] b\n- [X] c\n", "- [ ] a\n- [x] b\n- [ ] c\n"]);
  const wrong = { ...d.blocks[0], task: { checked: false, offset: d.blocks[0].task.offset + 1 } };
  assert.equal(toggleTask(d, wrong), null);
  const moved = { ...d, text: `x${d.text}` };
  assert.equal(toggleTask(moved, d.blocks[1]), null);
  assert.equal(toggleTask(parse("- plain\n"), parse("- plain\n").blocks[0]), null);
});

test("closeFence appends the fence; the fence guard closes a fence typed into a block", () => {
  const d = parse("- ```\n  x\n"), s = closeFence(d, d.blocks[1]);
  assert.equal(run(d.text, s), "- ```\n  x\n  ```\n");
  const e = parse("```js\nx");
  assert.equal(run(e.text, closeFence(e, e.blocks[0])), "```js\nx\n```");
  const before = parse("a\n\nb\n\nc\n"), typed = { start: 3, end: 4, insert: "```" };
  const after = reparse(before, typed), g = fenceGuard(after, typed);
  assert.ok(g);
  assert.deepEqual(kinds(parse(run(after.text, g))), ["paragraph", "code", "paragraph"]);
  assert.equal(fenceGuard(parse("a\n"), { start: 0, end: 0, insert: "" }), null);
});

// The text after setLanguage on the first code block or diagram of `text`; null when it writes nothing.
const withLanguage = (text, id) => {
  const d = parse(text), b = d.blocks.find(x => x.kind === "code" || x.kind === "mermaid"), s = setLanguage(d, b, id);
  if (s && !(s.start <= s.caret && s.caret <= s.start + s.insert.length)) throw new Error("the caret is not in the splice");
  return s && run(d.text, s);
};

test("setLanguage replaces the info string's first word and keeps what follows; Plain text removes the whole info string", () => {
  assert.equal(withLanguage("```js title=\"a.js\"\nx\n```\n", "ts"), "```ts title=\"a.js\"\nx\n```\n");
  assert.equal(withLanguage("```   py   \nx\n```\n", "rust"), "```   rust   \nx\n```\n", "the spaces around it stay");
  assert.equal(withLanguage("```\nx\n```\n", "js"), "```js\nx\n```\n", "no info string: the id after the fence");
  assert.equal(withLanguage("```js title=\"a.js\"\nx\n```\n", ""), "```\nx\n```\n", "Plain text");
  assert.equal(withLanguage("```\nx\n```\n", ""), null, "Plain text on a block with none writes nothing");
  assert.equal(withLanguage("```js\nx\n```\n", "js"), null, "the same word writes nothing");
  assert.equal(withLanguage("~~~py\nx\n~~~\n", "go"), "~~~go\nx\n~~~\n", "a tilde fence");
  assert.equal(withLanguage("```js\nx\ny", "ts"), "```ts\nx\ny", "an unclosed fence");
  assert.equal(withLanguage("```js\r\nx\r\n```\r\n", ""), "```\r\nx\r\n```\r\n", "CRLF: the line break stays");
  assert.equal(withLanguage("- item\n\n  ```js\n  x\n  ```\n", "ts"), "- item\n\n  ```ts\n  x\n  ```\n", "a fence inside a list item");
  assert.equal(withLanguage("- ```js\n  x\n  ```\n", "py"), "- ```py\n  x\n  ```\n", "a fence on the item's marker line");
  assert.equal(withLanguage("  ```js\n  x\n  ```\n", "c"), "  ```c\n  x\n  ```\n", "an indented fence");
});

test("setLanguage turns a code block into a diagram with mermaid, and a diagram's source into code with another language or Plain text", () => {
  const diagram = withLanguage("```js\ngraph TD\n```\n", "mermaid");
  assert.equal(diagram, "```mermaid\ngraph TD\n```\n");
  assert.deepEqual(kinds(parse(diagram)), ["mermaid"]);
  for (const id of ["js", ""]) {
    const code = withLanguage("```mermaid\ngraph TD\n```\n", id);
    assert.deepEqual(kinds(parse(code)), ["code"], id);
    assert.equal(field(parse(code), parse(code).blocks[0]).value, "graph TD", `${id}: the same code`);
  }
});

test("setLanguage fences an indented block: its lines without their indent under its container prefix, the fence longer than a line of backticks in it", () => {
  const cases = [
    ["Intro\n\n    a\n      b\n\n    c\n", "py", "Intro\n\n```py\na\n  b\n\nc\n```\n"],
    ["- item\n\n      code\n      more\n", "js", "- item\n\n  ```js\n  code\n  more\n  ```\n"],
    ["    ```\n    x\n    ````\n", "md", "`````md\n```\nx\n````\n`````\n"],
    ["    \tx\n    y", "c", "```c\n\tx\ny\n```"],
    ["    a\r\n    b\r\n", "go", "```go\r\na\r\nb\r\n```\r\n"],
  ];
  for (const [text, id, want] of cases) {
    const next = withLanguage(text, id), before = parse(text), after = parse(next);
    assert.equal(next, want, JSON.stringify(text));
    const code = d => d.blocks.find(b => b.kind === "code");
    assert.equal(code(after).fence.length >= 3 && code(after).info, id, "one fenced block");
    assert.equal(field(after, code(after)).value, field(before, code(before)).value, "the code field shows the same text");
  }
  assert.equal(withLanguage("    a\n", ""), null, "Plain text leaves an indented block as it is");
});

test("the fence guard closes a fence typed into an item's continuation or an indented line, not a fence already open", () => {
  for (const [text, at, want, rest] of [
    ["1. Step\n\n   Details here.\n\n   More.\n", 12, "1. Step\n\n   ```Details here.\n   ```\n\n   More.\n", "More."],
    ["  Note\n\n# Next\n", 2, "  ```Note\n```\n\n# Next\n", "Next"],
  ]) {
    const typed = { start: at, end: at, insert: "```" }, after = reparse(parse(text), typed), g = fenceGuard(after, typed);
    assert.ok(g, JSON.stringify(text));
    const next = run(after.text, g), nd = parse(next);
    assert.equal(next, want);
    assert.ok(nd.blocks.every(b => b.closed), "the fence is closed");
    assert.equal(values(nd).at(-1), rest, "what follows stays out of it");
  }
  const open = parse("```js\nx\ny\n"), info = { start: 3, end: 5, insert: "ts" };
  assert.equal(fenceGuard(reparse(open, info), info), null, "the info string of a fence that was open already");
});

test("paste: block lines replace an empty block, split a paragraph, or join inline; lines in a quote stay in it", () => {
  const empty = parse("- [ ] \n"), e = run(empty.text, paste(empty, empty.blocks[0], 0, 0, "- fix parser\n- add test"));
  assert.equal(e, "- fix parser\n- add test\n");
  const end = parse("text here\n"), p = run(end.text, paste(end, end.blocks[0], 9, 9, "## Notes\nfoo"));
  assert.deepEqual(kinds(parse(p)), ["paragraph", "heading", "paragraph"]);
  const mid = parse("left right\n"), m = run(mid.text, paste(mid, mid.blocks[0], 5, 5, "p1\n\np2\n\n- l1\n- l2 "));
  assert.deepEqual(values(parse(m)), ["left p1", "p2", "l1", "l2 right"], "a plain first line joins the text before the caret");
  const blockMid = parse("left right\n"), bm = run(blockMid.text, paste(blockMid, blockMid.blocks[0], 5, 5, "# H\n\np2"));
  assert.deepEqual(values(parse(bm)), ["left", "H", "p2", "right"], "a marker first line splits the paragraph");
  const inline = parse("ab\n"), i = run(inline.text, paste(inline, inline.blocks[0], 1, 1, "x\r\ny"));
  assert.equal(i, "ax\nyb\n");
  const q = parse("> a\n"), qs = run(q.text, paste(q, q.blocks[0], 1, 1, "x\n- y"));
  assert.deepEqual(kinds(parse(qs)), ["quote"]);
  const raw1 = parse("```\nx\n```\n"), r = run(raw1.text, paste(raw1, raw1.blocks[0], 0, 0, "a\nb"));
  assert.equal(r, "```\na\nbx\n```\n");
});

test("paste keeps the blocks around it: marker fix-ups, the fusion guard at both ends, an item's sub-blocks", () => {
  const pasted = (text, i, where, clip) => {
    const d = parse(text), n = field(d, d.blocks[i]).value.length;
    const [s, e] = where === "end" ? [n, n] : where === "whole" ? [0, n] : [where, where];
    const sp = paste(d, d.blocks[i], s, e, clip);
    return sp && { next: run(text, sp), caret: sp.caret };
  };
  const cases = [
    ["- ```bash\n  npm i\n  ```\n", 0, 0, "x\ny", "- x\ny\n  ```bash\n  npm i\n  ```\n", "an empty item's marker-line child moves below the pasted lines"],
    ["-\nfoo\n", 0, 0, "x\ny", "- x\ny\n\nfoo\n", "a bare marker gets its space, the paragraph below stays out"],
    ["# Title\nnext para\n", 0, 2, "x\ny", "# Tix\nytle\n\nnext para\n", "the line after a heading does not take in the paragraph below"],
    ["> # h\npara\n", 1, "whole", "> q\nmore", "> # h\n\n> q\nmore\n", "a pasted quote does not join the quote above"],
    ["- Phase 2\n  - write tests\n- Phase 4\n", 0, "end", "- Phase 3\n- Phase 3b", "- Phase 2\n  - write tests\n- Phase 3\n- Phase 3b\n- Phase 4\n", "after an item's sub-items"],
    ["1.  foo\n\n    ```\n    bar\n    ```\n", 0, "end", "- a\n- b", "1.  foo\n\n    ```\n    bar\n    ```\n- a\n- b\n", "after an item's code"],
  ];
  for (const [text, i, where, clip, want, why] of cases) {
    const r = pasted(text, i, where, clip);
    assert.equal(r?.next, want, why);
    assert.equal(r.caret, want.indexOf(clip.split("\n").at(-1)) + clip.split("\n").at(-1).length, `${why}: the caret ends the paste`);
  }
  for (const [text, i, where, clip, why] of [
    ["- Phase 2\n  - write tests\n", 0, "whole", "- a\n- b", "the whole text of an item with sub-items"],
    ["-\n  child\n", 0, 0, "- a\n- b", "an empty item with a child"],
    ["1.     indented code\n", 0, 0, "- a\n- b", "an item whose marker-line code would go under the pasted list"],
    ["1.  foo\n\n        code\n", 0, "end", "p1\n\n- l1", "lines that end in a list item over an item's code"],
  ]) assert.equal(pasted(text, i, where, clip), null, why);
});

// The document after pasting `clip` over field range `where` (an offset, "end" or "whole") of block i, as
// [kind, field value] pairs, with the splice and the new text.
const pasteInto = (text, i, where, clip) => {
  const d = parse(text), n = field(d, d.blocks[i]).value.length;
  const [s, e] = where === "end" ? [n, n] : where === "whole" ? [0, n] : [where, where];
  const sp = paste(d, d.blocks[i], s, e, clip), next = run(text, sp), nd = parse(next);
  return { sp, next, blocks: nd.blocks.map(b => [b.kind, field(nd, b).value]) };
};

test("a list pasted into a quote stays in it: in the middle, at the start, at the end and over all its text", () => {
  for (const [text, i, where, want, blocks] of [
    ["> left right\n", 0, 5, "> left\n>\n> - a\n> - b\n>\n> right\n", [["quote", "left\n\n- a\n- b\n\nright"]]],
    ["> left right\n", 0, 0, "> - a\n> - b\n>\n> left right\n", [["quote", "- a\n- b\n\nleft right"]]],
    ["> left right\n", 0, "end", "> left right\n>\n> - a\n> - b\n", [["quote", "left right\n\n- a\n- b"]]],
    ["> left right\n", 0, "whole", "> - a\n> - b\n", [["quote", "- a\n- b"]]],
    ["> left\nright\n", 0, 5, "> left\n>\n> - a\n> - b\n>\n> right\n", [["quote", "left\n\n- a\n- b\n\nright"]]],
    ["- item\n\n  > left right\n", 1, 5, "- item\n\n  > left\n  >\n  > - a\n  > - b\n  >\n  > right\n", [["item", "item"], ["quote", "left\n\n- a\n- b\n\nright"]]],
  ]) {
    const r = pasteInto(text, i, where, "- a\n- b");
    assert.equal(r.next, want, `${JSON.stringify(text)} at ${where}`);
    assert.deepEqual(r.blocks, blocks, `${JSON.stringify(text)} at ${where}`);
    assert.equal(r.sp.caret, want.indexOf("- b") + 3, "the caret ends the paste");
  }
});

test("block paste into a heading: the left half keeps the heading, its closing run and its underline; the right half is a paragraph", () => {
  const clip = "## Notes\nfoo";
  for (const [text, i, where, want, blocks] of [
    ["Title\n===\n", 0, "end", "Title\n===\n\n## Notes\nfoo\n", [["heading", "Title"], ["heading", "Notes"], ["paragraph", "foo"]]],
    ["Title\n===", 0, "end", "Title\n===\n\n## Notes\nfoo", [["heading", "Title"], ["heading", "Notes"], ["paragraph", "foo"]]],
    ["Hello World\n===\n", 0, 5, "Hello\n===\n\n## Notes\nfoo\n\nWorld\n", [["heading", "Hello"], ["heading", "Notes"], ["paragraph", "foo"], ["paragraph", "World"]]],
    ["Hello\nWorld\n---\n", 0, 5, "Hello\n---\n\n## Notes\nfoo\n\nWorld\n", [["heading", "Hello"], ["heading", "Notes"], ["paragraph", "foo"], ["paragraph", "World"]]],
    ["- x\n\n  Title\n  ---\n", 1, "end", "- x\n\n  Title\n  ---\n\n  ## Notes\n  foo\n", [["item", "x"], ["heading", "Title"], ["heading", "Notes"], ["paragraph", "foo"]]],
    ["# Title #\n", 0, "end", "# Title #\n\n## Notes\nfoo\n", [["heading", "Title"], ["heading", "Notes"], ["paragraph", "foo"]]],
    ["# Title #\n", 0, 2, "# Ti #\n\n## Notes\nfoo\n\ntle\n", [["heading", "Ti"], ["heading", "Notes"], ["paragraph", "foo"], ["paragraph", "tle"]]],
  ]) {
    const r = pasteInto(text, i, where, clip);
    assert.equal(r.next, want, `${JSON.stringify(text)} at ${where}`);
    assert.deepEqual(r.blocks, blocks, `${JSON.stringify(text)} at ${where}`);
    assert.equal(r.sp.caret, want.indexOf("foo") + 3, "the caret ends the paste");
  }
  const headings = parse(pasteInto("Hello World\n===\n", 0, 5, clip).next).blocks.filter(b => b.kind === "heading");
  assert.deepEqual(headings.map(b => [b.level, b.setext]), [[1, true], [2, false]]);
});

test("block paste at the start of a block puts the lines before it, which keeps its marker; over all its text it replaces it", () => {
  const clip = "## Notes\nfoo";
  for (const [text, where, want, blocks] of [
    ["Title\n===\n", 0, "## Notes\nfoo\n\nTitle\n===\n", [["heading", "Notes"], ["paragraph", "foo"], ["heading", "Title"]]],
    ["# Title #\n", 0, "## Notes\nfoo\n\n# Title #\n", [["heading", "Notes"], ["paragraph", "foo"], ["heading", "Title"]]],
    ["- [x] done\n", 0, "## Notes\nfoo\n\n- [x] done\n", [["heading", "Notes"], ["paragraph", "foo"], ["item", "done"]]],
    ["Title\n===\n", "whole", "## Notes\nfoo\n", [["heading", "Notes"], ["paragraph", "foo"]]],
    ["# Title #\n", "whole", "## Notes\nfoo\n", [["heading", "Notes"], ["paragraph", "foo"]]],
    ["   Title\n   ===\n", 0, "## Notes\nfoo\n\n   Title\n   ===\n", [["heading", "Notes"], ["paragraph", "foo"], ["heading", "Title"]]],
    ["  # Title #\n", 0, "## Notes\nfoo\n\n  # Title #\n", [["heading", "Notes"], ["paragraph", "foo"], ["heading", "Title"]]],
    ["   Title\n   ===\n", "whole", "## Notes\nfoo\n", [["heading", "Notes"], ["paragraph", "foo"]]],
    ["  # Title #\n", "whole", "## Notes\nfoo\n", [["heading", "Notes"], ["paragraph", "foo"]]],
  ]) {
    const r = pasteInto(text, 0, where, clip);
    assert.equal(r.next, want, `${JSON.stringify(text)} at ${where}`);
    assert.deepEqual(r.blocks, blocks, `${JSON.stringify(text)} at ${where}`);
  }
  assert.equal(pasteInto("- [x] done\n", 0, 0, "- a\n- b").next, "- a\n- b\n- [x] done\n", "a pasted list before a task leaves its box ticked");
  const nested = pasteInto("- a\n\n   Title\n   ===\n", 1, 0, clip);
  assert.equal(nested.next, "- a\n\n  ## Notes\n  foo\n\n   Title\n   ===\n", "inside an item the lines take its prefix, the heading keeps its own indent");
  assert.deepEqual(nested.blocks, [["item", "a"], ["heading", "Notes"], ["paragraph", "foo"], ["heading", "Title"]]);
});

const H1 = { kind: "heading", level: 1 }, H2 = { kind: "heading", level: 2 }, H3 = { kind: "heading", level: 3 };
const BULLET = { kind: "item", list: "bullet" }, ORDERED = { kind: "item", list: "ordered" }, TASK = { kind: "item", list: "task" };
const PARAGRAPH = { kind: "paragraph" }, QUOTE = { kind: "quote" };
const TARGETS = [PARAGRAPH, H1, H2, H3, BULLET, ORDERED, TASK, QUOTE];
const listOf = b => (b.task ? "task" : b.ordered ? "ordered" : "bullet");
const variant = b => (b.kind === "heading" ? { kind: "heading", level: b.level } : b.kind === "item" ? { kind: "item", list: listOf(b) } : { kind: b.kind });
const holdingAt = (d, at) => d.blocks.findLast(x => x.start <= at);

test("retype turns a paragraph into a bullet, numbered, task or quote by writing only the marker, and into heading 1-3 with its lines joined by spaces; the caret's field offset is unchanged", () => {
  for (const [text, i] of [["Intro\n\nSome words here\nand more\n\nOutro\n", 1], ["- item\n\n  Some words here\n  and more\n", 1]]) {
    const d = parse(text), b = d.blocks[i], f = field(d, b), lead = fieldToDoc(f, 0);
    for (const [to, marker] of [[H1, "# "], [H2, "## "], [H3, "### "], [BULLET, "- "], [ORDERED, "1. "], [TASK, "- [ ] "], [QUOTE, "> "]]) {
      for (const k of [0, 5, f.value.length]) {
        const s = retype(d, b, to, fieldToDoc(f, k)), where = `${JSON.stringify(text)} to ${JSON.stringify(to)} at ${k}`;
        if (to.kind !== "heading") assert.deepEqual([s.start, s.end, s.insert], [lead, lead, marker], where);
        const nd = reparse(d, s), nb = nd.blocks[i];
        assert.deepEqual(variant(nb), to, where);
        assert.equal(field(nd, nb).value, to.kind === "heading" ? f.value.replace(/\n/g, " ") : f.value, `${where}: the field`);
        assert.equal(docToField(field(nd, nb), s.caret), k, `${where}: the caret's field offset`);
        assert.equal(nd.blocks.length, d.blocks.length, where);
      }
    }
  }
  const d = parse("One line\n"), b = d.blocks[0];
  assert.equal(run(d.text, retype(d, b, H2, 3)), "## One line\n", "one line: the marker alone");
  assert.deepEqual(retype(d, b, PARAGRAPH, 4), { start: 4, end: 4, insert: "", caret: 4 }, "the same kind: nothing to write");
});

test("retype to a heading joins a multi-line paragraph into one heading line, soft and hard breaks becoming one space", () => {
  const text = "Intro\n\none\ntwo  \nthree\\\nfour\n\nOutro\n", d = parse(text), b = d.blocks[1], f = field(d, b);
  assert.equal(f.value, "one two\nthree\\\nfour");
  const k = f.value.indexOf("four") + 2, s = retype(d, b, H2, fieldToDoc(f, k)), next = run(text, s);
  assert.equal(next, "Intro\n\n## one two three four\n\nOutro\n");
  const nd = parse(next), nb = nd.blocks[1];
  assert.deepEqual([nb.kind, nb.level, field(nd, nb).value], ["heading", 2, "one two three four"]);
  assert.equal(docToField(field(nd, nb), s.caret), "one two three fo".length, "the caret stays on its character");
  const crlf = parse("a\r\nb\\\r\nc\r\n"), cs = retype(crlf, crlf.blocks[0], H1, 0);
  assert.equal(run(crlf.text, cs), "# a b c\r\n");
  const nested = parse("- item\n\n  para\n  more\n"), ns = retype(nested, nested.blocks[1], H3, fieldToDoc(field(nested, nested.blocks[1]), 0));
  assert.equal(run(nested.text, ns), "- item\n\n  ### para more\n", "inside an item it keeps the item's indent");
});

test("retype between bullet, numbered and task rewrites only the marker; '- ' to '1. ' moves continuation lines and sub-items right with it so they stay in the item", () => {
  const text = "- a\n- b\n  more b\n  - sub\n- c\n", d = parse(text), b = d.blocks[1], f = field(d, b), k = f.value.indexOf("more") + 2;
  const to = (target, at = k) => {
    const s = retype(d, b, target, fieldToDoc(f, at)), next = run(text, s), nd = parse(next), nb = holdingAt(nd, s.caret);
    return { s, next, nd, nb, caret: docToField(field(nd, nb), s.caret) };
  };
  const task = to(TASK);
  assert.equal(task.next, "- a\n- [ ] b\n  more b\n  - sub\n- c\n");
  assert.deepEqual([task.s.start, task.s.end, task.s.insert], [b.start, b.start + 2, "- [ ] "], "only the marker");
  assert.deepEqual([variant(task.nb), field(task.nd, task.nb).value, task.caret], [TASK, f.value, k]);
  const ordered = to(ORDERED);
  assert.equal(ordered.next, "- a\n1. b\n   more b\n   - sub\n- c\n");
  assert.deepEqual([variant(ordered.nb), field(ordered.nd, ordered.nb).value, ordered.caret], [ORDERED, f.value, k]);
  assert.deepEqual(ordered.nd.blocks.map(x => [x.kind, x.depth, field(ordered.nd, x).value]), [["item", 0, "a"], ["item", 0, "b more b"], ["item", 1, "sub"], ["item", 0, "c"]], "the sub-item stays under it");
  assert.equal(to(ORDERED, 0).caret, 0, "a caret on the first line");
  const after = parse("1. one\n- two\n"), as = retype(after, after.blocks[1], ORDERED, after.text.indexOf("two"));
  assert.equal(run(after.text, as), "1. one\n2. two\n", "numbered after a numbered item: its number + 1");
  const back = parse("1. one\n2. two\n3. three\n"), bs = retype(back, back.blocks[1], BULLET, back.text.indexOf("two")), bn = run(back.text, bs);
  assert.equal(bn, "1. one\n- two\n3. three\n", "one space after the marker");
  assert.deepEqual(parse(bn).blocks.map(x => [x.kind, field(parse(bn), x).value]), [["item", "one"], ["item", "two"], ["item", "three"]]);
  const done = parse("- [x] done\n"), ds = retype(done, done.blocks[0], BULLET, done.text.length - 1);
  assert.equal(run(done.text, ds), "- done\n", "a task to a bullet loses its box");
  assert.deepEqual(retype(done, done.blocks[0], TASK, 6), { start: 6, end: 6, insert: "", caret: 6 }, "a task to a task: nothing");
});

test("a numbered item retyped as a to-do or a bullet gets one space after its marker; its other lines and sub-blocks move left with it (B18, B19)", () => {
  const to = (text, target) => {
    const d = parse(text), b = d.blocks[0], f = field(d, b), s = retype(d, b, target, fieldToDoc(f, 2)), next = run(text, s), nd = parse(next);
    return { next, blocks: nd.blocks.map(x => [x.kind, x.depth, field(nd, x).value]), caret: docToField(field(nd, holdingAt(nd, s.caret)), s.caret) };
  };
  assert.equal(to("1. first\n", TASK).next, "- [ ] first\n");
  assert.equal(to("1. first\n", BULLET).next, "- first\n");
  assert.equal(to("10. ten\n", TASK).next, "- [ ] ten\n");
  assert.equal(to("10. ten\n", BULLET).next, "- ten\n");
  const nested = to("1. first\n   more\n   - sub\n", TASK);
  assert.equal(nested.next, "- [ ] first\n  more\n  - sub\n");
  assert.deepEqual(nested.blocks, [["item", 0, "first more"], ["item", 1, "sub"]], "the line and the sub-item stay in the item");
  assert.equal(nested.caret, 2, "the caret where it was in the text");
  const loose = to("1. first\n\n   para\n", BULLET);
  assert.deepEqual([loose.next, loose.blocks], ["- first\n\n  para\n", [["item", 0, "first"], ["paragraph", 1, "para"]]]);
  assert.equal(to("- [ ] a\n  - sub\n", ORDERED).next, "1. a\n   - sub\n", "a wider marker moves them right, as before");
});

test("retype from a paragraph, heading, setext heading, item or quote to every other kind refuses none of the documents' text blocks and fewer than 5% of all, which are skipped; on every other one the result has the target kind and the neighbours keep their kinds and fields", () => {
  let checked = 0, refused = 0, refusedInDocs = 0;
  const from = new Set();
  for (const c of everyText()) {
    const d = parse(c.text), vals = values(d);
    for (const b of d.blocks) {
      if (!isText(b)) continue;
      const f = field(d, b), at = fieldToDoc(f, f.value.length), own = variant(b);
      for (const to of TARGETS) {
        if (to.kind === own.kind && to.level === own.level && to.list === own.list) continue;
        const s = retype(d, b, to, at), where = `${c.name}: ${b.kind} #${b.index} ${JSON.stringify(raw(d, b).slice(0, 60))} to ${JSON.stringify(to)}`;
        if (!s) { refused++; if (!c.example) refusedInDocs++; continue; }
        checked++;
        from.add(b.kind === "heading" && b.setext ? "setext" : b.kind);
        const nd = reparse(d, s), nb = holdingAt(nd, s.caret);
        assert.equal(nb?.kind, to.kind, `${where}: the target kind`);
        const delta = s.insert.length - (s.end - s.start), byStart = new Map(nd.blocks.map(z => [z.start, z]));
        for (const x of d.blocks) {
          let y;
          if (x.end <= s.start && x.index < b.index && x.index !== b.parent) y = nd.blocks[x.index];
          else if (x.start >= s.end && x.index > b.index && lineStart(d.text, x.start)) {
            // A line whose indent the splice rewrote starts where its first character went.
            y = byStart.get(x.start + delta) ?? nd.blocks.find(z => firstNonBlank(nd.text, z.start) === firstNonBlank(d.text, x.start) + delta);
          } else continue;
          assert.ok(y, `${where}: block #${x.index} ${x.kind} is still there`);
          assert.equal(y.kind, x.kind, `${where}: block #${x.index} keeps its kind`);
          assert.equal(field(nd, y).value, vals[x.index], `${where}: block #${x.index} keeps its field`);
        }
      }
    }
  }
  assert.deepEqual([...from].sort(), ["heading", "item", "paragraph", "quote", "setext"]);
  assert.ok(checked > 8000, `${checked} retypes`);
  assert.equal(refusedInDocs, 0, "no text block of a document is refused");
  assert.ok(refused * 20 < checked, `${refused} refused of ${checked}`);
});

test("insertLines replaces a block holding only the range, follows the text before it with a blank line, splits around a range with text after it, and takes a single '---' line as a rule, never a setext underline", () => {
  const CODE = ["```", "", "```"], at = (text, i, query) => {
    const d = parse(text), b = d.blocks[i], v = field(d, b).value, s = v.indexOf(query);
    return { d, b, s, e: s + query.length };
  };
  const lines = (text, i, query, list) => {
    const x = at(text, i, query), sp = insertLines(x.d, x.b, x.s, x.e, list), next = run(text, sp), nd = parse(next);
    return { next, kinds: kinds(nd), caretIn: holdingAt(nd, sp.caret)?.kind };
  };
  assert.deepEqual(lines("Intro\n\n/code\n\nOutro\n", 1, "/code", CODE), { next: "Intro\n\n```\n\n```\n\nOutro\n", kinds: ["paragraph", "code", "paragraph"], caretIn: "code" });
  assert.deepEqual(lines("Run this /code\n\nOutro\n", 0, "/code", CODE), { next: "Run this\n\n```\n\n```\n\nOutro\n", kinds: ["paragraph", "code", "paragraph"], caretIn: "code" });
  assert.deepEqual(lines("a /code b\n", 0, "/code", CODE), { next: "a\n\n```\n\n```\n\nb\n", kinds: ["paragraph", "code", "paragraph"], caretIn: "code" });
  assert.deepEqual(lines("- item /code\n", 0, "/code", CODE).kinds, ["item", "code"]);
  assert.deepEqual(lines("Intro\n\n/hr\n", 1, "/hr", ["---"]), { next: "Intro\n\n---\n", kinds: ["paragraph", "hr"], caretIn: "hr" });
  assert.deepEqual(lines("Para\n/hr\n", 0, "/hr", ["---"]), { next: "Para\n\n---\n", kinds: ["paragraph", "hr"], caretIn: "hr" }, "after the text before it: a rule, not its underline");
  assert.deepEqual(lines("# Title /hr\n", 0, "/hr", ["---"]).kinds, ["heading", "hr"]);
  const kids = at("- /code\n  - sub\n", 0, "/code");
  assert.equal(insertLines(kids.d, kids.b, kids.s, kids.e, CODE), null, "an item with sub-items and nothing else");
});

const OPS = {
  remove: (d, b) => remove(d, b),
  removeRange: (d, b) => (d.blocks[b.index + 1] ? removeRange(d, b, d.blocks[b.index + 1]) : null),
  toParagraph: (d, b) => toParagraph(d, b),
  split: (d, b) => (isText(b) && field(d, b).value.length > 2 ? split(d, b, field(d, b).value.length >> 1) : null),
  insertAfter: (d, b) => insertAfter(d, b, b.kind === "item" ? "item" : "paragraph", "new text"),
  insertBefore: (d, b) => insertBefore(d, b, b.kind === "item" ? "item" : "paragraph", "new text"),
  mergeNext: (d, b) => {
    const n = d.blocks[b.index + 1];
    return isText(b) && n && isText(n) && n.parent === b.parent && !n.markerOnly ? mergeNext(d, b, n) : null;
  },
  mergeIntoPrevious: (d, b) => {
    const p = d.blocks[b.index - 1];
    return b.kind === "paragraph" && p && isText(p) && p.depth === b.depth ? mergeIntoPrevious(d, p, b) : null;
  },
  indent: (d, b) => indent(d, b),
  outdent: (d, b) => outdent(d, b),
  nest: (d, b) => nest(d, b),
  unnest: (d, b) => unnest(d, b),
  moveUp: (d, b) => move(d, b, -1),
  moveDown: (d, b) => move(d, b, 1),
  toggleTask: (d, b) => toggleTask(d, b),
};
// Several lines only: a one-line paste is typing.
const CLIPS = ["x\ny", "## Notes\nfoo", "- a\n- b", "p1\n\np2\n\n- l1\n- l2", "> q\nmore"];
for (const clip of CLIPS) {
  const at = {
    middle: v => [v.length >> 1, v.length >> 1],
    end: v => [v.length, v.length],
    whole: v => [0, v.length],
  };
  for (const [where, range] of Object.entries(at)) {
    OPS[`paste ${JSON.stringify(clip)} ${where}`] = (d, b) => (isText(b) ? paste(d, b, ...range(field(d, b).value), clip) : null);
  }
}
const firstNonBlank = (text, p) => {
  while (text[p] === " " || text[p] === "\t") p++;
  return p;
};

test("the neighbours-unchanged property holds for every op on every corpus block", () => {
  let ops = 0;
  for (const c of everyText()) {
    const d = parse(c.text), vals = values(d);
    for (const b of d.blocks) {
      for (const [name, op] of Object.entries(OPS)) {
        const s = op(d, b);
        if (!s) continue;
        ops++;
        const nd = reparse(d, s), delta = s.insert.length - (s.end - s.start), byStart = new Map(nd.blocks.map(z => [z.start, z]));
        const where = `${c.name}: ${name} on ${b.kind} #${b.index} ${JSON.stringify(raw(d, b).slice(0, 60))}`;
        for (const x of d.blocks) {
          let y = null;
          if (x.end <= s.start && x.index < b.index) y = nd.blocks[x.index];
          else if (x.start >= s.end && x.index > b.index) y = byStart.get(x.start + delta) ?? null;
          else continue;
          // A child that sat on its parent's marker line may get a line of its own: it is where its first character went.
          if (!y && x.start >= s.end && !lineStart(d.text, x.start)) {
            y = nd.blocks.find(z => firstNonBlank(nd.text, z.start) === firstNonBlank(d.text, x.start) + delta) ?? null;
          }
          // A block on its parent's marker line shares that line: a parent left without a marker-line child takes its text.
          if (x.index === b.parent && b.start === x.end && !lineStart(d.text, b.start)) continue;
          assert.ok(y, `${where}: block #${x.index} ${x.kind} is still there`);
          assert.equal(y.kind, x.kind, `${where}: block #${x.index} keeps its kind`);
          // The same lines over the same source make the same field: only blocks the re-parse made anew are read again.
          if (y === x || (y.lines === x.lines && nd.text.slice(y.start, y.end) === raw(d, x))) continue;
          assert.equal(field(nd, y).value, vals[x.index], `${where}: block #${x.index} keeps its field`);
        }
      }
    }
  }
  assert.ok(ops > 20000, `${ops} ops`);
});

test("a block paste inside a line of every corpus text block leaves the halves split() leaves, the pasted blocks between", () => {
  const kindField = (d, y) => (y ? [y.kind, field(d, y).value] : null);
  let checked = 0;
  for (const [clip, pastedKinds] of [["## Notes\nfoo", ["heading", "paragraph"]], ["- a\n- b", ["item", "item"]]]) {
    for (const c of everyText()) {
      const d = parse(c.text);
      for (const b of d.blocks) {
        if (!isText(b) || b.subtreeEnd > b.end) continue;
        const v = field(d, b).value;
        let s = v.length >> 1;
        while (s < v.length && (v[s] === "\n" || v[s - 1] === "\n")) s++;
        if (!v.slice(0, s).trim() || !v.slice(s).trim()) continue;
        const sp = paste(d, b, s, s, clip), ss = split(d, b, s);
        if (!sp || !ss) continue;
        checked++;
        const nd = reparse(d, sp), sd = reparse(d, ss), where = `${c.name}: ${b.kind} #${b.index} ${JSON.stringify(raw(d, b).slice(0, 60))} at ${s}`;
        if (b.kind === "quote") {
          const pf = field(nd, nd.blocks[b.index]).value, sf = field(sd, sd.blocks[b.index]).value;
          assert.equal(nd.blocks[b.index].kind, "quote", where);
          assert.ok(pf.includes(`\n\n${clip}\n\n`), `${where}: the pasted lines are in the quote`);
          assert.equal(pf.replace(`\n\n${clip}`, ""), sf, `${where}: the quote's own text is split as Enter splits it`);
          continue;
        }
        // A left half that opens a fence takes in what follows until the commit's fence guard closes it.
        if (sd.blocks[b.index].kind === "code") continue;
        assert.deepEqual(kindField(nd, nd.blocks[b.index]), kindField(sd, sd.blocks[b.index]), `${where}: the left half`);
        assert.deepEqual(nd.blocks.slice(b.index + 1, b.index + 3).map(y => y.kind), pastedKinds, `${where}: the pasted blocks`);
        assert.deepEqual(kindField(nd, nd.blocks[b.index + 3]), kindField(sd, sd.blocks[b.index + 1]), `${where}: the right half`);
      }
    }
  }
  assert.ok(checked > 2000, `${checked} pastes`);
});

test("incremental re-parse equals a full parse for 1000 random splices", () => {
  const rnd = random(5), examples = originals().filter(o => o.example).map(o => o.text);
  // Line 0 opens front matter that nothing closes yet, so a closing line written anywhere below turns the top into it.
  const openTop = examples.filter(t => !/^(?:---|\.\.\.)[ \t]*$/m.test(t)).map(t => `---\n\n${t}`);
  const pools = [[examples, 350], [sections.map(s => s.text), 400], [docs.map(d => d.text), 150], [openTop, 100, true]];
  const bits = ["\n", "\n\n", "# ", "- ", "1. ", "> ", "```", "~~~", "    ", "\t", "|", " | ", "---", "===", "[a]: /u", "<div>", "-->", "x", "word ", "  ", "\r\n", "*"];
  let late = 0, early = 0, closers = 0;
  for (const [pool, count, closer] of pools) {
    for (let n = 0; n < count; n++) {
      const text = rnd.pick(pool), d = parse(text);
      let start = rnd.int(text.length + 1), end = Math.min(text.length, start + (rnd() < 0.5 ? 0 : rnd.int(30))), insert = "";
      if (closer) {
        const lineStarts = [...text.matchAll(/\n/g)].map(m => m.index + 1).filter(p => p > 4);
        start = end = rnd.pick(lineStarts);
        insert = rnd.pick(["---\n", "...\n", "---  \n", "---"]);
      } else for (let k = rnd.int(4); k > 0; k--) insert += rnd.pick(bits);
      const s = { start, end, insert }, next = run(text, s), r = reparse(d, s);
      if (closer && parse(next).blocks[0]?.kind === "frontmatter") closers++;
      assert.deepEqual(shape(r), shape(parse(next)), `${JSON.stringify(text.slice(Math.max(0, start - 40), end + 40))} ${JSON.stringify(s)}`);
      if (r.window[0] > 0) late++;
      if (r.window[1] < r.blocks.length) early++;
    }
  }
  assert.ok(late > 400 && early > 400, `windows that start late: ${late}, that resync before the end: ${early}`);
  assert.ok(closers > 50, `${closers} splices closed the front matter line 0 opened`);
});

test("a closing line written far below an unclosed `---` on line 0 makes the top front matter in the re-parse too", () => {
  const d = parse("---\n\nfoo\n\nbar\n"), s = { start: 10, end: 10, insert: "---\n" };
  assert.deepEqual(kinds(d), ["hr", "paragraph", "paragraph"]);
  const r = reparse(d, s);
  assert.deepEqual(kinds(r), ["frontmatter", "paragraph"]);
  assert.deepEqual(shape(r), shape(parse(run(d.text, s))));
  const bom = parse("﻿---\nfoo\n\nbar\n"), t = { start: 10, end: 11, insert: "...\nb" };
  assert.deepEqual(shape(reparse(bom, t)), shape(parse(run(bom.text, t))));
});

test("re-parse keeps the keys of unchanged blocks and reuses keys in order for blocks of the same kind", () => {
  const d = parse("# A\n\none\n\ntwo\n\n# B\n"), keys = d.blocks.map(b => b.key);
  const s = { start: d.text.indexOf("one"), end: d.text.indexOf("one") + 3, insert: "uno" }, nd = reparse(d, s);
  assert.deepEqual(nd.blocks.map(b => b.key), keys);
  const split2 = reparse(d, { start: d.text.indexOf("two"), end: d.text.indexOf("two"), insert: "new\n\n" });
  assert.equal(split2.blocks.length, 5);
  assert.deepEqual(split2.blocks.map(b => b.key).filter(k => keys.includes(k)).length, 4);
  const gone = reparse(d, { start: d.text.indexOf("one"), end: d.text.indexOf("two"), insert: "" });
  assert.deepEqual(gone.released.length, 1);
});

test("shortcut: the space typed after `#`, `-`, `1.`, `>` or `[]` at the start of a paragraph", () => {
  const typed = (text, ...steps) => {
    const d = parse(text), f = field(d, d.blocks[0]);
    for (const v of steps) type(f, v);
    return f;
  };
  assert.deepEqual(shortcut(typed("Title\n", "#Title", "##Title", "## Title"), 2), { kind: "heading", level: 2 });
  assert.deepEqual(shortcut(typed("x\n", "-x", "- x"), 1), { kind: "item" });
  assert.deepEqual(shortcut(typed("x\n", "1.x", "1. x"), 2), { kind: "item" });
  assert.deepEqual(shortcut(typed("x\n", ">x", "> x"), 1), { kind: "quote" });
  assert.equal(shortcut(typed("x\n", "x y"), 1), null);
  assert.equal(shortcut(typed("- a\n", "- a"), 1), null, "not in an item");
  const task = parse("[] buy milk\n"), f = field(task, task.blocks[0]), t = shortcut(f, 2);
  assert.equal(t.kind, "task");
  assert.equal(run(task.text, t.splice), "- [ ] buy milk\n");
  const item = parse("* [] x\n"), fi = field(item, item.blocks[0]);
  assert.equal(run(item.text, shortcut(fi, 2).splice), "* [ ] x\n");
});

test("visibleMap maps visible characters through inline syntax to field offsets", () => {
  const v = "a **b** `c` [d](u) \\* &amp; <http://x>";
  const map = visibleMap(v), visible = map.slice(0, -1).map(i => v[i]).join("");
  assert.equal(visible, "a b c d * & http://x");
  assert.equal(map.at(-1), v.length);
  assert.deepEqual(visibleMap("plain"), [0, 1, 2, 3, 4, 5]);
});

test("FENCE, CLOSE and closes: what opens a fence, what closes one, and which closes which", () => {
  assert.ok(FENCE.test("   ```js") && !FENCE.test("    ```"));
  assert.ok(CLOSE.test("```  ") && !CLOSE.test("``` x"));
  assert.ok(closes("````", "```") && !closes("```", "````") && !closes("~~~", "```"));
});

test("an indented code line's own indent is its longest: up to three spaces and a tab are one indent, as are four spaces", () => {
  assert.deepEqual(["    x", "\tx", " \tx", "   \tx", "  \t\tx", "     x", "  x"].map(l => codeIndent(l)), [4, 1, 2, 4, 3, 4, 2]);
  assert.deepEqual(["  \tnpm test\n", " \t\tdeep\n", "   \tx\n    y\n"].map(t => parse(t).blocks[0].content), ["npm test", "\tdeep", "x\ny"]);
  assert.equal(codeIndent("  \tx", 2), 2, "in a fence only the fence's own spaces count");
});

test("the parse budget: the 1 MiB fixture costs at most 3 character tests per character", () => {
  const big = bigDocument();
  assert.ok(big.length >= 1024 * 1024);
  counters.chars = 0;
  const d = parse(big);
  assert.ok(d.blocks.length > 2000);
  assert.ok(counters.chars <= 3 * big.length, `${counters.chars} tests for ${big.length} characters`);
});

test("a parse in steps, pausing at every block where it can, gives what one parse gives, for every corpus text and the 1 MiB fixture", () => {
  const stepped = (text, opts) => {
    const steps = parseInSteps(text, opts, () => true);
    let r = steps.next(), pauses = 0;
    for (; !r.done; r = steps.next()) pauses++;
    return { doc: r.value, pauses };
  };
  let pauses = 0;
  for (const c of corpus()) {
    const s = stepped(c.text, {});
    assert.deepEqual(s.doc, parse(c.text), c.name);
    pauses += s.pauses;
  }
  assert.ok(pauses > 2500, `${pauses} pauses`);
  const big = bigDocument(), s = stepped(big, {});
  assert.deepEqual(s.doc, parse(big));
  assert.ok(s.pauses > 2000);
  const never = parseInSteps(big, {}, () => false).next();
  assert.equal(never.done, true, "no pause: one step");
});

test("the typing splice on a 300 KB block does constant work outside the diff", () => {
  const lines = [];
  for (let i = 0, n = 0; n < 300 * 1024; i++) n += lines[lines.push(`const value${i} = compute(${i}, "some text");`) - 1].length + 1;
  const text = `\`\`\`js\n${lines.join("\n")}\n\`\`\`\n`, d = parse(text), f = field(d, d.blocks[0]);
  let value = f.value, pos = value.length >> 1;
  const work = [];
  for (let k = 0; k < 50; k++) {
    counters.seps = 0;
    value = value.slice(0, pos) + "x" + value.slice(pos);
    type(f, value);
    pos++;
    work.push(counters.seps);
  }
  assert.ok(Math.max(...work) <= 2, `separator steps per key: ${work}`);
  const para = parse(`${lines.map(l => l.replace(/[`*_]/g, "")).join("\n")}\n`), fp = field(para, para.blocks[0]);
  value = fp.value;
  pos = value.length >> 1;
  counters.seps = 0;
  for (let k = 0; k < 50; k++) {
    value = value.slice(0, pos) + "y" + value.slice(pos);
    type(fp, value);
    pos++;
  }
  assert.ok(counters.seps <= 50, `${counters.seps} separator steps for 50 keys in a paragraph`);
});
