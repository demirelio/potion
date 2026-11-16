import test from "node:test";
import assert from "node:assert/strict";
import { parseInline } from "../mods/herdr-inline-markdown/inline.js";
import { parse } from "../mods/herdr-inline-markdown/blocks.js";
import { addLink, clipboardAddress, destinationOf, linkAddress, linkForm, setAddress, unlink } from "../mods/herdr-inline-markdown/links.js";

const DEFS = parse("x\n\n[ref]: https://r.org \"T\"\n").defs;
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
