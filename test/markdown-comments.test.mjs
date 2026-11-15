import test from "node:test";
import assert from "node:assert/strict";
import {
  POINT, addComment, commentable, commentsIn, editComment, hideComments, highlight, highlightColor, oneLine, resolveComment, showComments,
} from "../mods/herdr-inline-markdown/comments.js";

const COLOR = "#e5c07b55";
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

test("the highlight is the theme's yellow at a third, so text stays readable on light and dark themes", () => {
  assert.equal(highlightColor({ ansi3: "#E5C07B" }), "#e5c07b55");
  assert.equal(highlightColor({ ansi3: "#c18401ff" }), "#c1840155", "its own alpha gives way");
  assert.equal(highlightColor({ ansi3: "#fc0" }), "#ffcc0055");
  assert.equal(highlightColor({ ansi3: "ansi3" }), "#f5c54255", "not a colour: amber");
  assert.equal(highlightColor({}), "#f5c54255");
});

test("hideComments maps the text a reader sees back to the source, a point comment as its marker", () => {
  const text = "a {==b==}{>>n<<} c{>>p<<}d";
  const { text: seen, at } = hideComments(text);
  assert.equal(seen, `a b c${POINT}d`);
  assert.deepEqual(at.slice(0, 5), [0, 1, 5, 16, 17]);
  assert.equal(at[5], text.indexOf("{>>p"), "the marker sits where the point comment starts");
  assert.equal(at.at(-2), text.length - 1);
  assert.equal(at.at(-1), text.length);
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
