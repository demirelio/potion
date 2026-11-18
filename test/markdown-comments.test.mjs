import test from "node:test";
import assert from "node:assert/strict";
import {
  POINT, addComment, cellComments, commentable, commentsIn, editCellComment, editComment, highlight, noteText, oneLine,
  pointComment, readNote, resolveComment, showComments, stampOf, timeLabel,
} from "../mods/herdr-inline-markdown/comments.js";
import { tableCells } from "../mods/herdr-inline-markdown/geometry.js";

const COLOR = "#4a3b20";
const shown = text => showComments(text, COLOR);
const mark = inner => highlight(inner, COLOR);
// `text` with the selection written in it: [ and ] around a selection, | for a caret.
const marked = text => {
  const caret = text.indexOf("|");
  if (caret >= 0) return { value: text.slice(0, caret) + text.slice(caret + 1), range: { start: caret, end: caret } };
  const start = text.indexOf("["), end = text.indexOf("]") - 1;
  return { value: text.slice(0, start) + text.slice(start + 1, end + 1) + text.slice(end + 2), range: { start, end } };
};
const caretShown = out => (out && out.start === out.end ? out.value.slice(0, out.start) + "|" + out.value.slice(out.start) : out);
const add = (text, note) => {
  const { value, range } = marked(text), out = addComment(value, range, note);
  return out?.refused ?? caretShown(out);
};
const parts = text => commentsIn(text).map(c => ({ kind: c.kind, marked: text.slice(c.from, c.to), note: c.note, whole: text.slice(c.start, c.end) }));

test("a comment on text, a point comment and a highlight are found with their marked text and comment", () => {
  const text = "The release {==ships on Friday==}{>>too early? QA needs a day<<} and {>>check the date<<} the {==docs==} follow.";
  assert.deepEqual(parts(text), [
    { kind: "comment", marked: "ships on Friday", note: "too early? QA needs a day", whole: "{==ships on Friday==}{>>too early? QA needs a day<<}" },
    { kind: "point", marked: "", note: "check the date", whole: "{>>check the date<<}" },
    { kind: "highlight", marked: "docs", note: null, whole: "{==docs==}" },
  ]);
  const [c] = commentsIn(text);
  assert.equal(text.slice(c.noteAt, c.noteAt + c.note.length), c.note, "noteAt: where the comment's text starts");
});

test("comments at the start and the end of a block, and two in one block", () => {
  assert.deepEqual(parts("{==a==}{>>one<<} middle {==b==}{>>two<<}").map(p => [p.marked, p.note]), [["a", "one"], ["b", "two"]]);
  assert.deepEqual(parts("{>>first<<}").map(p => p.kind), ["point"]);
});

test("nothing in a code span or a code block is a comment, and a code span inside the marked text is kept", () => {
  assert.deepEqual(parts("a `{==x==}{>>no<<}` b"), []);
  assert.deepEqual(parts("a ``{==x `y` ==}`` b"), []);
  assert.deepEqual(parts("{==see `x` here==}{>>yes<<}").map(p => p.marked), ["see `x` here"]);
  assert.deepEqual(parts("{==a `b==}` c==}{>>n<<}").map(p => p.marked), ["a `b==}` c"], "the close inside the code span does not count");
  assert.deepEqual(parts("quote {==a==}{>>n<<}\n```\n{==b==}{>>code<<}\n```\n\n    {==c==}{>>indented<<}\n- {==d==}{>>item<<}").map(p => p.marked), ["a", "d"]);
  assert.deepEqual(parts("a \\{==x==}{>>n<<}").map(p => p.kind), ["point"], "an escaped brace opens nothing");
});

test("broken or unclosed marks are left as text", () => {
  for (const text of ["{==open", "{>>open", "{====}", "a ==} b <<}", "{==a {==b==} c", "x {==a\n\nb==}{>>n<<}", "{>>a\n\nb<<}"]) {
    const found = commentsIn(text).map(c => text.slice(c.start, c.end));
    assert.ok(found.every(w => !w.includes("\n\n")), `${JSON.stringify(text)}: nothing across a blank line`);
  }
  assert.deepEqual(parts("{==open"), []);
  assert.deepEqual(parts("{>>open"), []);
  assert.deepEqual(parts("{====}"), [], "nothing marked");
  assert.deepEqual(parts("{==a {==b==} c").map(p => p.whole), ["{==b==}"], "comments don't nest: the outer one is text");
  assert.deepEqual(parts("{==a==}{>>no close").map(p => [p.kind, p.whole]), [["highlight", "{==a==}"]]);
  assert.deepEqual(parts("{==a\nb==}{>>soft\nbreak<<}").map(p => [p.marked, p.note]), [["a\nb", "soft\nbreak"]], "a line break inside a paragraph is fine");
});

test("astral characters keep their UTF-16 offsets", () => {
  const text = "😀 {==👍 ok==}{>>🎉<<} end";
  assert.deepEqual(parts(text).map(p => [p.marked, p.note]), [["👍 ok", "🎉"]]);
  assert.equal(add("😀 [👍 ok] end", "🎉"), "😀 {==👍 ok==}{>>🎉<<}| end");
});

test("the display transform draws marked text highlighted and drops the marks and the comment; a point comment is a marker", () => {
  assert.equal(shown("The {==ships **soon**==}{>>sure?<<} end."), `The ${mark("ships **soon**")} end.`);
  assert.equal(shown("Only {==this==} is lit."), `Only ${mark("this")} is lit.`);
  assert.equal(shown("Here{>>note<<} it is."), `Here${mark(POINT)} it is.`);
  assert.equal(shown("`{==code==}` and {==a==}"), `\`{==code==}\` and ${mark("a")}`);
  assert.equal(shown("plain text"), "plain text");
  assert.equal(mark("x"), `<mark color="${COLOR}">x</mark>`, "the highlight's markup");
});

test("add wraps the selection, spaces at its ends left outside, and leaves the caret after the comment", () => {
  assert.equal(add("Hello [world].", "nice"), "Hello {==world==}{>>nice<<}|.");
  assert.equal(add("Hello[ world ]end", "x"), "Hello {==world==}{>>x<<}| end");
  assert.equal(add("Hello |world", "here"), "Hello {>>here<<}|world", "a caret: a point comment");
  assert.equal(add("Hello[   ]world", "x"), "Hello{>>x<<}|   world", "only spaces: a caret at their start");
  assert.equal(add("[Hello] world", "x"), "{==Hello==}{>>x<<}| world");
  assert.equal(add("Hello [world]", "x"), "Hello {==world==}{>>x<<}|");
  assert.equal(add("Hello [world]", "  "), null, "an empty comment adds nothing");
});

test("the comment is one line, and <<} in it gets a space so it can't end the comment early", () => {
  assert.equal(oneLine("one\ntwo\r\nthree"), "one two three");
  assert.equal(oneLine("a <<} b"), "a << } b");
  assert.equal(oneLine("  x  "), "x");
  assert.equal(add("Hello [world]", "a\nb <<} c"), "Hello {==world==}{>>a b << } c<<}|");
  const out = addComment("Hello world", { start: 6, end: 11 }, "<<}<<}");
  assert.deepEqual(parts(out.value).map(p => p.note), ["<< }<< }"]);
});

test("a selection that would cut through or hold a comment, reach into code or cross a paragraph is refused", () => {
  assert.equal(add("Hello {==wo[rld==}{>>n<<} and] more", "x"), "overlap");
  assert.equal(add("Hello [{==world==}{>>n<<}] more", "x"), "overlap");
  assert.equal(add("Hello {==w[orl]d==}{>>n<<}", "x"), "overlap");
  assert.equal(add("Hello {==wo|rld==}", "x"), "overlap", "a caret inside a comment");
  assert.equal(add("Hello {>>n<<}[more]", "x"), "Hello {>>n<<}{==more==}{>>x<<}|", "right beside one is fine");
  assert.equal(add("Hello `co[de` and] more", "x"), "code");
  assert.equal(add("Hello `c|ode`", "x"), "code");
  assert.equal(add("Say [`code` here]", "x"), "Say {==`code` here==}{>>x<<}|", "a whole code span inside is fine");
  assert.equal(add("one [two\n\nthree] four", "x"), "paragraphs");
  assert.equal(add("quote\n```\nco[de]\n```", "x"), "code");
  assert.equal(commentable("Hello world", { start: 0, end: 5 }), null);
  assert.equal(commentable("Hello {==world==}", { start: 8, end: 10 }), "overlap");
});

test("edit swaps the comment's text and leaves the caret after it; resolve keeps the marked text, selected", () => {
  const text = "A {==b==}{>>old<<} c {>>p<<}.", [c, p] = commentsIn(text);
  assert.equal(caretShown(editComment(text, c, "new\ntext")), "A {==b==}{>>new text<<}| c {>>p<<}.");
  assert.equal(caretShown(editComment(text, p, "q")), "A {==b==}{>>old<<} c {>>q<<}|.");
  assert.equal(editComment(text, c, " "), null, "empty: nothing changes");
  assert.equal(editComment(text, c, "old"), null, "the same text: nothing changes");
  assert.deepEqual(resolveComment(text, c), { value: "A b c {>>p<<}.", start: 2, end: 3 });
  assert.deepEqual(resolveComment(text, p), { value: "A {==b==}{>>old<<} c .", start: 21, end: 21 });
});

const AT = new Date(2026, 10, 16, 20, 51, 37);

test("a new comment is written with the local time it was written, 24-hour, before its text", () => {
  assert.equal(stampOf(AT), "2026-11-16 20:51");
  assert.equal(stampOf(new Date(2026, 0, 2, 3, 4)), "2026-01-02 03:04", "zero-padded");
  const { value, range } = marked("Hello [world].");
  assert.equal(addComment(value, range, "nice", AT).value, "Hello {==world==}{>>2026-11-16 20:51 | nice<<}.");
  const point = marked("Hello |world");
  assert.equal(addComment(point.value, point.range, " here ", AT).value, "Hello {>>2026-11-16 20:51 | here<<}world", "a point comment too");
  assert.equal(addComment(value, range, "  ", AT), null, "an empty comment is still nothing");
});

test("a note that starts with a stamp has that time and the text after it; any other note has no time and is all text", () => {
  assert.deepEqual(readNote("2026-11-16 20:51 | the comment"), { when: new Date(2026, 10, 16, 20, 51), text: "the comment" });
  assert.deepEqual(readNote("the comment"), { when: null, text: "the comment" });
  assert.deepEqual(readNote("2026-11-16 20:51 |"), { when: new Date(2026, 10, 16, 20, 51), text: "" });
  for (const note of ["2026-11-16 20:51 the comment", "2026-13-16 20:51 | month 13", "2026-02-30 10:00 | no such day", "2026-11-16 24:00 | x", "26-11-16 20:51 | x", " 2026-11-16 20:51 | x"]) {
    assert.deepEqual(readNote(note), { when: null, text: note }, note);
  }
  assert.equal(noteText("2026-11-16 20:51 | shown"), "shown", "the stamp is never shown");
  assert.equal(noteText("no stamp | here"), "no stamp | here");
  const [c] = commentsIn("A {==b==}{>>2026-11-16 20:51 | why<<} c");
  assert.equal(c.note, "2026-11-16 20:51 | why", "commentsIn gives the note as written");
});

test("editing a comment keeps its time; a note without one gets none", () => {
  const text = "A {==b==}{>>2026-11-15 08:05 | old<<} c {>>plain<<}.", [c, p] = commentsIn(text);
  const edited = editComment(text, c, "new\ntext");
  assert.equal(edited.value, "A {==b==}{>>2026-11-15 08:05 | new text<<} c {>>plain<<}.");
  assert.equal(edited.start, "A {==b==}{>>2026-11-15 08:05 | new text<<}".length, "the caret after it");
  assert.equal(editComment(text, c, "old"), null, "the same text: nothing changes");
  assert.equal(editComment(text, c, "  "), null, "empty: nothing changes");
  assert.equal(editComment(text, p, "still plain").value, "A {==b==}{>>2026-11-15 08:05 | old<<} c {>>still plain<<}.");
});

test("a comment's time: today the hour, this year the day, another year the day and year; none without a stamp", () => {
  const now = new Date(2026, 10, 16, 22, 0);
  assert.equal(timeLabel(new Date(2026, 10, 16, 20, 51), now), "8:51 PM");
  assert.equal(timeLabel(new Date(2026, 10, 16, 0, 5), now), "12:05 AM");
  assert.equal(timeLabel(new Date(2026, 10, 16, 12, 30), now), "12:30 PM");
  assert.equal(timeLabel(new Date(2026, 10, 15, 23, 59), now), "Nov 15");
  assert.equal(timeLabel(new Date(2026, 0, 3, 9, 0), now), "Jan 3");
  assert.equal(timeLabel(new Date(2025, 10, 15, 20, 51), now), "Nov 15, 2025");
  assert.equal(timeLabel(new Date(2027, 1, 1, 9, 0), now), "Feb 1, 2027", "a clock set back: another year");
  assert.equal(timeLabel(null, now), "");
});

test("a point comment on its own: one line, stamped with its time, never closed early; nothing for an empty note", () => {
  const when = new Date(2026, 10, 17, 9, 5);
  assert.equal(pointComment("why\nthis <<} loop?", when), "{>>2026-11-17 09:05 | why this << } loop?<<}");
  assert.equal(pointComment(" \n ", when), "");
  assert.deepEqual(readNote(commentsIn(pointComment("why?", when))[0].note), { when, text: "why?" });
});

test("the display transform can draw one comment, found by its start, in a deeper colour", () => {
  const text = "{==a==}{>>one<<} {==b==}{>>two<<} {>>three<<}", [, b, p] = commentsIn(text), DEEP = "#8a6a2e";
  assert.equal(showComments(text, COLOR, { at: b.start, color: DEEP }), `${mark("a")} ${highlight("b", DEEP)} ${mark(POINT)}`);
  assert.equal(showComments(text, COLOR, { at: p.start, color: DEEP }), `${mark("a")} ${mark("b")} ${highlight(POINT, DEEP)}`);
  assert.equal(showComments(text, COLOR, null), shown(text));
});

// A table's text as its field holds it: every comment in it belongs to the cell its start is in.
const WHEN = new Date(2026, 10, 17, 9, 0);
const CELLS = [
  "| {==Name==}{>>2026-11-17 09:00 \\| why?<<} | Size | {>>last<<} |",
  "|---|---|---|",
  "| a \\| b | {==x==}{>>one<<} {>>two<<} | {==lit==} |",
  "{==first==}{>>no pipe at the start<<} | some {==y==}{>>on part of it<<} more | {==z==}{>>nor at the end<<}",
  "| | {>>alone<<} | |",
].join("\n");
const inCells = value => cellComments(value).map(x => [x.row, x.column, x.note, value.slice(x.comment.start, x.comment.end), value.slice(x.cell.start, x.cell.end)]);

test("a comment in a table is in the cell holding its start: its row by the lines before it (the delimiter row not drawn), its column by the unescaped pipes before it on its line", () => {
  assert.deepEqual(inCells(CELLS), [
    [0, 0, "2026-11-17 09:00 | why?", "{==Name==}{>>2026-11-17 09:00 \\| why?<<}", "{==Name==}{>>2026-11-17 09:00 \\| why?<<}"],
    [0, 2, "last", "{>>last<<}", "{>>last<<}"],
    [1, 1, "one", "{==x==}{>>one<<}", "{==x==}{>>one<<} {>>two<<}"],
    [1, 1, "two", "{>>two<<}", "{==x==}{>>one<<} {>>two<<}"],
    [2, 0, "no pipe at the start", "{==first==}{>>no pipe at the start<<}", "{==first==}{>>no pipe at the start<<}"],
    [2, 1, "on part of it", "{==y==}{>>on part of it<<}", "some {==y==}{>>on part of it<<} more"],
    [2, 2, "nor at the end", "{==z==}{>>nor at the end<<}", "{==z==}{>>nor at the end<<}"],
    [3, 1, "alone", "{>>alone<<}", "{>>alone<<}"],
  ], "first and last cells, an escaped pipe before one, several in a cell, one on part of a cell, a point comment alone; a highlight with no comment is no cell's comment");
  assert.deepEqual(readNote(cellComments(CELLS)[0].note), { when: WHEN, text: "why?" }, "the stamp read through its escaped pipe");
  assert.deepEqual(cellComments("| a | b |\n|---|---|"), []);
});

test("a | in a cell's note is written \\|, the backslashes right before it doubled, and read back as typed", () => {
  const value = "| {==a==}{>>2026-11-17 09:00 \\| old<<} |\n|---|", [{ comment }] = cellComments(value);
  for (const typed of ["x | y", "a \\| b", "ends with \\\\|", "C:\\dir \\ not before a pipe"]) {
    const out = editCellComment(value, comment, typed), [x] = cellComments(out.value);
    assert.equal(readNote(x.note).text, typed, typed);
    assert.equal(tableCells(out.value)[0].cells.length, 1, `${typed}: still one cell`);
  }
  assert.equal(editCellComment(value, comment, "a \\| b").value, "| {==a==}{>>2026-11-17 09:00 \\| a \\\\\\| b<<} |\n|---|");
});

test("editCellComment swaps a cell comment's text, keeping its time and escaping its pipes; resolveComment leaves the cell's text", () => {
  const value = "| {==a==}{>>2026-11-17 09:00 \\| old<<} | {>>plain<<} |\n|---|---|", [x, y] = cellComments(value);
  const edited = editCellComment(value, x.comment, "new | text");
  assert.equal(edited.value, "| {==a==}{>>2026-11-17 09:00 \\| new \\| text<<} | {>>plain<<} |\n|---|---|");
  assert.equal(edited.start, "| {==a==}{>>2026-11-17 09:00 \\| new \\| text<<}".length, "the caret after it");
  assert.equal(editCellComment(value, x.comment, "old"), null, "the same text: nothing changes");
  assert.equal(editCellComment(value, x.comment, " "), null, "empty: nothing changes");
  assert.equal(editCellComment(value, y.comment, "still | plain").value, "| {==a==}{>>2026-11-17 09:00 \\| old<<} | {>>still \\| plain<<} |\n|---|---|");
  assert.equal(resolveComment(value, x.comment).value, "| a | {>>plain<<} |\n|---|---|");
  assert.equal(resolveComment(value, y.comment).value, "| {==a==}{>>2026-11-17 09:00 \\| old<<} |  |\n|---|---|", "a point comment alone: the cell empty");
});
