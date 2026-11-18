import test from "node:test";
import assert from "node:assert/strict";
import { parseInline } from "../mods/potion/inline.js";
import { parse } from "../mods/potion/blocks.js";
import { addLink, clipboardAddress, destinationOf, linkAddress, linkForm, pictureCut, pictureForm, setAddress, setPicture, unlink } from "../mods/potion/links.js";
import { cellText, tableOf } from "../mods/potion/tables.js";

const DEFS = parse("x\n\n[ref]: https://r.org \"T\"\n[cat]: <my cat.png> \"A cat\"\n").defs;
const linksOf = value => parseInline(value, { defs: DEFS }).spans.filter(sp => sp.kind === "link");
const linkIn = value => linksOf(value)[0];
const read = (out, value = out.value) => value.slice(out.start, out.end);
// What shows of `value`, every character Reading draws.
const shown = value => parseInline(value, { defs: DEFS }).chars.map(c => c.text).join("");

test("an address typed without its scheme gets https:// when it names a web host; anchors, paths, mail and other schemes stay as typed", () => {
  for (const [typed, address] of [
    ["google.com", "https://google.com"], ["www.x.org/a", "https://www.x.org/a"], ["  docs.example.co.uk/a?b=c#d ", "https://docs.example.co.uk/a?b=c#d"],
    ["example.com:8080/x", "https://example.com:8080/x"], ["www.notes.md", "https://www.notes.md"],
    ["https://a.org", "https://a.org"], ["HTTP://A.ORG", "HTTP://A.ORG"], ["mailto:me@x.org", "mailto:me@x.org"], ["ftp://f.org/x", "ftp://f.org/x"],
    ["#anchor", "#anchor"], ["other.md", "other.md"], ["a.md", "a.md"], ["notes/plan.markdown", "notes/plan.markdown"], ["./a.md", "./a.md"],
    ["../up.md", "../up.md"], ["/abs/path.txt", "/abs/path.txt"], ["picture.png", "picture.png"], ["me@x.org", "me@x.org"], ["localhost:3000", "localhost:3000"],
    ["", ""], ["   ", ""],
  ]) assert.equal(linkAddress(typed), address, JSON.stringify(typed));
});

test("an address is written as it is, or in <> when it holds a space, a parenthesis out of its pair or starts with <; what it holds reads back", () => {
  for (const [address, written] of [
    ["https://a.org/x", "https://a.org/x"], ["https://en.wikipedia.org/wiki/Fish_(food)", "https://en.wikipedia.org/wiki/Fish_(food)"],
    ["https://a.org/a(b", "<https://a.org/a(b>"], ["my notes.md", "<my notes.md>"], ["a b<c>", "<a b\\<c\\>>"], ["<x>", "<\\<x\\>>"],
    ["a\\*b", "a\\\\*b"], ["https://a.org/?x=1&amp;y", "https://a.org/?x=1\\&amp;y"], ["", ""],
  ]) {
    assert.equal(destinationOf(address), written, address);
    assert.equal(linkIn(`[t](${written})`)?.url, address, `${address} reads back`);
  }
});

test("the clipboard holds an address when it is one web or mail address, spaces around it left out", () => {
  assert.equal(clipboardAddress("  https://example.com/a?b=c#d\n"), "https://example.com/a?b=c#d");
  assert.equal(clipboardAddress("mailto:me@example.com"), "mailto:me@example.com");
  for (const clip of ["https://a.com https://b.com", "ftp://example.com", "example.com", "https://", "javascript:alert(1)", "https://a.com\nmore", undefined, ""]) {
    assert.equal(clipboardAddress(clip), "", String(clip));
  }
});

test("a link's form: inline, reference, autolink or a web or mail address written bare", () => {
  for (const [value, form] of [
    ["[a](u)", "inline"], ["[a]()", "inline"], ["[a][ref]", "reference"], ["[ref][]", "reference"], ["[ref]", "reference"],
    ["<https://a.org>", "autolink"], ["<a@b.co>", "autolink"], ["https://a.org", "literal"], ["www.a.org", "literal"], ["a@b.co", "literal"],
  ]) assert.equal(linkForm(value, linkIn(value)), form, value);
});

test("setAddress writes the new address into an inline link, keeping its text and title; the whole link comes back as the range", () => {
  const value = 'see [the *docs*](https://x.org "Title") here';
  const out = setAddress(value, linkIn(value), "https://y.org/a b", { defs: DEFS });
  assert.equal(out.value, 'see [the *docs*](<https://y.org/a b> "Title") here');
  assert.equal(read(out), '[the *docs*](<https://y.org/a b> "Title")');
  assert.deepEqual([linkIn(out.value).url, linkIn(out.value).title], ["https://y.org/a b", "Title"]);
  assert.equal(setAddress("[a]() z", linkIn("[a]() z"), "#top", { defs: DEFS }).value, "[a](#top) z", "an empty address gets one");
  assert.equal(setAddress("[a](<b c>) z", linkIn("[a](<b c>) z"), "d.md", { defs: DEFS }).value, "[a](d.md) z");
});

test("setAddress on a reference link writes an inline address for that one link; the definition stays where it is", () => {
  for (const [value, edited] of [["[t][ref] x", "[t](https://n.org) x"], ["[ref][] x", "[ref](https://n.org) x"], ["[ref] x", "[ref](https://n.org) x"]]) {
    const out = setAddress(value, linkIn(value), "https://n.org", { defs: DEFS });
    assert.equal(out.value, edited, value);
    assert.equal(read(out), edited.slice(0, -2));
  }
});

test("setAddress on an autolink or a bare address changes its text too, keeping its form while the new address can have it", () => {
  const edit = (value, address) => setAddress(value, linkIn(value), address, { defs: DEFS });
  assert.deepEqual(edit("go <https://a.org> now", "https://b.org/x"), { value: "go <https://b.org/x> now", start: 3, end: 20 });
  assert.equal(edit("go <a@b.co> now", "mailto:c@d.co").value, "go <c@d.co> now", "a mail autolink");
  assert.equal(edit("go https://a.org now", "https://b.org").value, "go https://b.org now");
  assert.equal(edit("go www.a.org now", "https://www.b.org").value, "go https://www.b.org now");
  assert.equal(edit("go <https://a.org> now", "other.md").value, "go [other.md](other.md) now", "no autolink holds a path: an inline link");
  const spaced = edit("go https://a.org now", "my notes.md");
  assert.equal(spaced.value, "go [my notes.md](<my notes.md>) now");
  assert.equal(read(spaced), "[my notes.md](<my notes.md>)");
});

test("unlink keeps a link's text, without its marks and address, and gives back the text's range", () => {
  const value = 'see [the *docs*](https://x.org "T") here';
  const out = unlink(value, linkIn(value), { defs: DEFS });
  assert.deepEqual(out, { value: "see the *docs* here", start: 4, end: 14 });
  assert.equal(linksOf(out.value).length, 0);
  assert.deepEqual(unlink("[t][ref] x", linkIn("[t][ref] x"), { defs: DEFS }), { value: "t x", start: 0, end: 1 }, "a reference link; its definition stays");
  assert.deepEqual(unlink("[ref] x", linkIn("[ref] x"), { defs: DEFS }), { value: "ref x", start: 0, end: 3 });
});

test("unlink leaves an autolink's or a bare address's text as plain text that does not link again, an escape keeping GFM from linking it", () => {
  for (const [value, text] of [
    ["go <https://a.org/x> now", "https://a.org/x"], ["go https://a.org now", "https://a.org"], ["go www.a.org now", "www.a.org"],
    ["go a@b.co now", "a@b.co"], ["go <a@b.co> now", "a@b.co"], ["go mailto:c@d.co now", "mailto:c@d.co"],
  ]) {
    const out = unlink(value, linkIn(value), { defs: DEFS });
    assert.equal(linksOf(out.value).length, 0, `${value} -> ${out.value}`);
    assert.equal(shown(out.value), `go ${text} now`, value);
    assert.equal(shown(read(out)), text, `${value}: the text selected`);
  }
});

test("addLink makes the selection a link to the address, the whole link coming back as the range", () => {
  const value = "see the docs here";
  assert.deepEqual(addLink(value, { start: 4, end: 12 }, "https://a.org", { defs: DEFS }), { value: "see [the docs](https://a.org) here", start: 4, end: 29 });
  assert.equal(addLink(value, { start: 8, end: 12 }, "my file.md", { defs: DEFS }).value, "see the [docs](<my file.md>) here");
  assert.equal(addLink("say **bold** x", { start: 4, end: 12 }, "u", { defs: DEFS }).value, "say [**bold**](u) x");
  assert.equal(addLink("a **bold** b", { start: 4, end: 12 }, "u", { defs: DEFS }).value, "a [**bold** b](u)", "a selection that cuts a run takes all of it");
  assert.equal(addLink("x `code` y", { start: 3, end: 6 }, "u", { defs: DEFS }).value, "x [`code`](u) y", "nor can it cut code");
  assert.equal(addLink("see [a](u) and", { start: 0, end: 14 }, "v", { defs: DEFS }), null, "a link can't hold a link");
  assert.equal(addLink(value, { start: 4, end: 12 }, "", { defs: DEFS }), null, "no address: no link");
});

test("addLink at a caret writes the address as a link whose text is the address, showing every character of it", () => {
  assert.deepEqual(addLink("see  here", { start: 4, end: 4 }, "https://a.org", { defs: DEFS }), { value: "see [https://a.org](https://a.org) here", start: 4, end: 34 });
  for (const address of ["https://a.org/*x*_[y]", "notes/*draft*.md", "a`b`.md"]) {
    const odd = addLink("x ", { start: 2, end: 2 }, address, { defs: DEFS });
    assert.equal(shown(odd.value), `x ${address}`, address);
    assert.equal(linkIn(odd.value).url, address);
  }
  assert.equal(addLink("x ", { start: 2, end: 2 }, "https://a.org", { defs: DEFS, text: "a.org" }).value, "x [a.org](https://a.org)", "a text of its own");
});

// The cells of a one-row table whose second cell holds `value` as written there.
function cellsOf(value) {
  const doc = parse(`| x | ${value} |\n|---|---|\n`), b = doc.blocks[0], t = tableOf(doc, b);
  return b.kind === "table" ? t.rows[0].cells.map((_, c) => cellText(doc, t, 0, c)) : null;
}

test("in a table cell what a link writes has each | as \\|, so the cell keeps its shape, and the link reads back with | in its text, address and title; outside a cell nothing is escaped", () => {
  const cell = { defs: DEFS, cell: true }, pipe = "https://e.com/x|y";
  const cases = [
    [addLink("see a b now", { start: 4, end: 7 }, pipe, cell), "see [a b](https://e.com/x\\|y) now", "a b"],
    [addLink("see  now", { start: 4, end: 4 }, pipe, cell), "see [https\\://e.com/x\\|y](https://e.com/x\\|y) now", pipe],
    [addLink("a\\|b", { start: 0, end: 4 }, pipe, cell), "[a\\|b](https://e.com/x\\|y)", "a|b"],
    [setAddress('[t](u "a\\|b") z', linkIn('[t](u "a\\|b") z'), pipe, cell), '[t](https://e.com/x\\|y "a\\|b") z', "t"],
    [setAddress("[ref] z", linkIn("[ref] z"), pipe, cell), "[ref](https://e.com/x\\|y) z", "ref"],
    [setAddress("<https://a.org> z", linkIn("<https://a.org> z"), pipe, cell), "[https\\://e.com/x\\|y](https://e.com/x\\|y) z", pipe],
    [setAddress("go https://a.org z", linkIn("go https://a.org z"), pipe, cell), "go [https\\://e.com/x\\|y](https://e.com/x\\|y) z", pipe],
    [setAddress("[t](u) z", linkIn("[t](u) z"), "a\\|b", cell), "[t](a\\\\\\|b) z", "t"],
  ];
  for (const [out, value, text] of cases) {
    assert.equal(out?.value, value);
    assert.deepEqual(cellsOf(out.value), ["x", out.value], `${out.value}: one cell`);
    const link = linkIn(out.value);
    assert.deepEqual([link.start, link.end, shown(out.value.slice(link.start, link.end))], [out.start, out.end, text], out.value);
  }
  assert.deepEqual(cases.map(([out]) => linkIn(out.value).url), [pipe, pipe, pipe, pipe, pipe, pipe, pipe, "a\\|b"], "the addresses as typed");
  assert.equal(linkIn(cases[3][0].value).title, "a|b", "the title kept");
  assert.equal(addLink("see a b now", { start: 4, end: 7 }, pipe, { defs: DEFS }).value, "see [a b](https://e.com/x|y) now", "in a paragraph");
  assert.equal(setAddress("[t](u) z", linkIn("[t](u) z"), pipe, { defs: DEFS }).value, "[t](https://e.com/x|y) z");
});

const picturesIn = value => parseInline(value, { defs: DEFS }).spans.filter(sp => sp.kind === "image");
const pictureIn = value => picturesIn(value)[0];
const pictureEdit = (value, change) => setPicture(value, pictureIn(value), change, { defs: DEFS });

test("a picture's form in text: inline, reference (full, collapsed or its label alone) or an HTML <img> tag", () => {
  for (const [value, form] of [
    ["![a](u)", "inline"], ["![a]()", "inline"], ['![a](u "t")', "inline"], ["[![a](u)](v)", "inline"],
    ["![a][cat]", "reference"], ["![cat][]", "reference"], ["![cat]", "reference"],
    ['<img src="u" alt="a">', "html"], ["<img src=u>", "html"],
  ]) assert.equal(pictureForm(value, pictureIn(value)), form, value);
});

test("setPicture writes a new address into an inline picture, keeping its alt text, its title and the link around it; the whole picture comes back as the range", () => {
  const value = 'see ![a *cat*](cat.png "Title") here';
  const out = pictureEdit(value, { address: "<dog 1.png>" });
  assert.deepEqual(out, { value: 'see ![a *cat*](<dog 1.png> "Title") here', start: 4, end: 35 });
  assert.deepEqual([pictureIn(out.value).url, pictureIn(out.value).title, pictureIn(out.value).alt], ["dog 1.png", "Title", "a cat"]);
  assert.equal(pictureEdit("[![a](a.png)](https://e.com) b", { address: "b.png" }).value, "[![a](b.png)](https://e.com) b");
  assert.equal(pictureEdit("x ![a]() y", { address: "a.png" }).value, "x ![a](a.png) y", "an empty address gets one");
});

test("setPicture on a reference picture writes it inline for that picture alone, with its definition's title, when its address changes", () => {
  for (const [value, edited] of [
    ["x ![a cat][cat] y", 'x ![a cat](dog.png "A cat") y'], ["x ![cat][] y", 'x ![cat](dog.png "A cat") y'], ["x ![cat] y", 'x ![cat](dog.png "A cat") y'],
  ]) {
    const out = pictureEdit(value, { address: "dog.png" });
    assert.equal(out.value, edited, value);
    assert.equal(read(out), edited.slice(2, -2));
  }
});

test("setPicture writes an alt text so that parseInline reads back exactly what was typed; an empty one leaves ![](…)", () => {
  for (const alt of ["a *b* [c]", "x\\y", "u_v_ `w` ~x~ <y> &amp;", ""]) {
    const out = pictureEdit("see ![old](a.png) here", { alt });
    assert.equal(pictureIn(out.value).alt, alt, out.value);
    assert.equal(pictureIn(out.value).url, "a.png");
  }
  assert.equal(pictureEdit("see ![old](a.png) here", { alt: "" }).value, "see ![](a.png) here");
});

test("setPicture on a picture whose alt text is its label writes it inline first, with the definition's address and title; a full reference keeps its label", () => {
  assert.equal(pictureEdit("x ![cat] y", { alt: "kitty" }).value, 'x ![kitty](<my cat.png> "A cat") y');
  assert.equal(pictureEdit("x ![cat][] y", { alt: "kitty" }).value, 'x ![kitty](<my cat.png> "A cat") y');
  assert.equal(pictureEdit("x ![a cat][cat] y", { alt: "kitty" }).value, "x ![kitty][cat] y");
  assert.equal(pictureIn(pictureEdit("x ![cat] y", { alt: "kitty" }).value).url, "my cat.png");
});

test("setPicture changes the address and the alt text together, and writes nothing for an HTML <img> tag", () => {
  assert.equal(pictureEdit("![shot 1](shot-1.png) z", { alt: "shot 2", address: "images/shot-2.png" }).value, "![shot 2](images/shot-2.png) z");
  assert.equal(pictureEdit('see <img src="a.png" alt="a"> z', { alt: "b" }), null);
  assert.equal(pictureEdit('see <img src="a.png" alt="a"> z', { address: "b.png" }), null);
});

test("pictureCut: the picture's source, with its link when the link shows nothing else, and the space after it when spaces show on both sides", () => {
  const cut = (value, options) => pictureCut(value, pictureIn(value), { defs: DEFS, ...options });
  assert.deepEqual(cut("see ![a](a.png) here"), { start: 4, end: 16 });
  assert.deepEqual(cut("see ![a](a.png) here", { space: false }), { start: 4, end: 15 }, "the picture alone");
  assert.deepEqual(cut("see [![a](a.png)](https://e.com) here"), { start: 4, end: 33 }, "its link with it");
  assert.deepEqual(cut("see [![a](a.png) more](https://e.com) here"), { start: 5, end: 17 }, "a link that shows more stays");
  assert.deepEqual(cut("![a](a.png) here"), { start: 0, end: 11 }, "nothing before it: no space goes");
  assert.deepEqual(cut("see ![a](a.png)"), { start: 4, end: 15 }, "nothing after it");
  assert.deepEqual(cut("see ![a](a.png), here"), { start: 4, end: 15 });
  assert.deepEqual(cut("**see ![a](a.png)** here"), { start: 6, end: 20 }, "a space shown after the marks that close round it");
  assert.deepEqual(cut('see <img src="a.png" alt="a"> here'), { start: 4, end: 30 });
  assert.deepEqual(cut("see ![a][cat] here"), { start: 4, end: 14 });
});
