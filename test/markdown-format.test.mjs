import test from "node:test";
import assert from "node:assert/strict";
import { hasMark, toggleMark } from "../mods/herdr-inline-markdown/format.js";

// `text` with the selection written in it: [ and ] around a selection, | for a caret. Neither may be in the text itself.
const marked = text => {
  const caret = text.indexOf("|");
  if (caret >= 0) return { value: text.slice(0, caret) + text.slice(caret + 1), range: { start: caret, end: caret } };
  const start = text.indexOf("["), end = text.indexOf("]") - 1;
  return { value: text.slice(0, start) + text.slice(start + 1, end + 1) + text.slice(end + 2), range: { start, end } };
};
const show = out => (out === null ? null : out.start === out.end
  ? out.value.slice(0, out.start) + "|" + out.value.slice(out.start)
  : out.value.slice(0, out.start) + "[" + out.value.slice(out.start, out.end) + "]" + out.value.slice(out.end));
const press = (text, mark, clipboard) => {
  const { value, range } = marked(text);
  return show(toggleMark(value, range, mark, clipboard));
};

test("each mark goes around the selection, which stays selected inside the marks", () => {
  assert.equal(press("Hello [world].", "bold"), "Hello **[world]**.");
  assert.equal(press("Hello [world].", "italic"), "Hello *[world]*.");
  assert.equal(press("Hello [world].", "strike"), "Hello ~~[world]~~.");
  assert.equal(press("Hello [world].", "code"), "Hello `[world]`.");
});

test("a mark right outside the selection is taken off, and the text stays selected", () => {
  assert.equal(press("Hello **[world]**.", "bold"), "Hello [world].");
  assert.equal(press("Hello *[world]*.", "italic"), "Hello [world].");
  assert.equal(press("Hello ~~[world]~~.", "strike"), "Hello [world].");
  assert.equal(press("Hello ~[world]~.", "strike"), "Hello [world].", "one tilde is strikethrough as well");
  assert.equal(press("Hello `[world]`.", "code"), "Hello [world].");
  assert.equal(press("Hello ``[a`b]``.", "code"), "Hello [a`b].");
  assert.equal(press("Hello `` [`x`] ``.", "code"), "Hello [`x`].", "with the space that pads a backtick at an end");
});

test("a selection that starts and ends with the mark has it taken off, and what is left stays selected", () => {
  assert.equal(press("Hello [**world**].", "bold"), "Hello [world].");
  assert.equal(press("Hello [*world*].", "italic"), "Hello [world].");
  assert.equal(press("Hello [~~world~~].", "strike"), "Hello [world].");
  assert.equal(press("Hello [`world`].", "code"), "Hello [world].");
  assert.equal(press("Hello [`` `x` ``].", "code"), "Hello [`x`].");
});

test("a second press of the same key puts the text and the selection back", () => {
  for (const text of ["Hello [world].", "[a]", "x [a b] y", "**[x]**", "*[x]*", "`[a]`", "|", "a | b"]) {
    for (const mark of ["bold", "italic", "strike", "code"]) {
      const once = press(text, mark);
      assert.equal(press(once, mark), text, `${mark} twice on ${text} (once: ${once})`);
    }
  }
});

test("bold and italic share *: a run of one or three is italic, two or three is bold", () => {
  assert.equal(press("**[x]**", "italic"), "***[x]***", "italic inside bold adds a star, it does not strip one");
  assert.equal(press("*[x]*", "bold"), "***[x]***");
  assert.equal(press("***[x]***", "bold"), "*[x]*");
  assert.equal(press("***[x]***", "italic"), "**[x]**");
  assert.equal(press("[***x***]", "bold"), "[*x*]", "the selected stars go first");
  assert.equal(press("[***x***]", "italic"), "[**x**]");
  assert.equal(press("*[**x**]*", "bold"), "*[x]*");
  assert.equal(press("[**x**]", "italic"), "*[**x**]*");
  assert.equal(press("[*x*]", "bold"), "**[*x*]**");
  assert.equal(press("~~[x]~~", "italic"), "~~*[x]*~~", "marks of another kind stay");
  assert.equal(press("**[x]*", "bold"), "****[x]***", "runs of different lengths are no pair");
  assert.equal(press("~[x]~~", "strike"), "~~~[x]~~~~");
});

test("spaces at the ends of the selection stay outside the marks; a selection of spaces only is a caret at its start", () => {
  assert.equal(press("say[ hello ]there", "bold"), "say **[hello]** there");
  assert.equal(press("say[\thello\n]there", "code"), "say\t`[hello]`\nthere");
  assert.equal(press("say ** [hello] ** there", "bold"), "say ** **[hello]** ** there", "marks across a space are not the mark");
  assert.equal(press("a[   ]b", "bold"), "a**|**   b");
  assert.equal(press("a[ ]b", "link"), "a[|]() b");
});

test("a caret inside a word acts on the word and stays where it was in it", () => {
  assert.equal(press("Hello wo|rld.", "bold"), "Hello **wo|rld**.");
  assert.equal(press("Hello **wo|rld**.", "bold"), "Hello wo|rld.");
  assert.equal(press("Hello wo|rld.", "italic"), "Hello *wo|rld*.");
  assert.equal(press("Hello wo|rld.", "strike"), "Hello ~~wo|rld~~.");
  assert.equal(press("Hello wo|rld.", "code"), "Hello `wo|rld`.");
  assert.equal(press("Hello `wo|rld`.", "code"), "Hello wo|rld.");
  assert.equal(press("snake_c|ase 42", "bold"), "**snake_c|ase** 42", "letters, digits and _ make a word");
  assert.equal(press("v1|2 x", "italic"), "*v1|2* x");
  assert.equal(press("naï|ve", "bold"), "**naï|ve**");
});

test("a caret anywhere else writes the two marks with the caret between them, and a second press takes them away", () => {
  assert.equal(press("Hello| world.", "bold"), "Hello**|** world.", "at the end of a word");
  assert.equal(press("Hello |world.", "italic"), "Hello *|*world.", "at the start of a word");
  assert.equal(press("|", "strike"), "~~|~~");
  assert.equal(press("a | b", "code"), "a `|` b");
  assert.equal(press("a **|** b", "bold"), "a | b");
  assert.equal(press("a `|` b", "code"), "a | b");
  assert.equal(press("a ``|`` b", "code"), "a | b");
});

test("inline code fences backticks in the text with a run one longer than their longest, padded when a backtick is at an end", () => {
  assert.equal(press("[use `x` here]", "code"), "``[use `x` here]``");
  assert.equal(press("[a``b]", "code"), "```[a``b]```");
  assert.equal(press("[`x` y]", "code"), "`` [`x` y] ``");
  assert.equal(press("[y `x`]", "code"), "`` [y `x`] ``");
  assert.equal(press("[`]", "code"), "`` [`] ``");
  assert.equal(press("`a` [and] `b`", "code"), "`a` `[and]` `b`", "the backticks of the spans around it are not its marks");
  assert.equal(press("`a`[ and ]`b`", "code"), "`a` `[and]` `b`");
});

test("a link wraps the selection as [text](); the caret waits in the parentheses for the address", () => {
  assert.equal(press("see [docs] here", "link"), "see [docs](|) here");
  assert.equal(press("see [docs] here", "link", "two words"), "see [docs](|) here");
  assert.equal(press("see do|cs here", "link"), "see [docs](|) here", "a caret in a word links the word");
  assert.equal(press("see | here", "link"), "see [|]() here", "elsewhere the caret goes inside the brackets");
});

test("a link takes one web or mail address from the clipboard, and the caret goes after it", () => {
  const url = "https://example.com/a?b=c#d";
  assert.equal(press("see [docs] here", "link", url), `see [docs](${url})| here`);
  assert.equal(press("see [docs] here", "link", `  ${url}\n`), `see [docs](${url})| here`, "spaces and line breaks around it are left out");
  assert.equal(press("see [docs] here", "link", "HTTP://EXAMPLE.COM"), "see [docs](HTTP://EXAMPLE.COM)| here");
  assert.equal(press("write [me]", "link", "mailto:me@example.com"), "write [me](mailto:me@example.com)|");
  assert.equal(press("see | here", "link", url), `see [|](${url}) here`, "an empty link gets the address, the caret goes in the brackets");
  assert.equal(press("see do|cs here", "link", url), `see [docs](${url})| here`);
  assert.equal(press("a [b]", "link", "https://en.wikipedia.org/wiki/Fish_(food)"), "a [b](https://en.wikipedia.org/wiki/Fish_(food))|");
  assert.equal(press("a [b]", "link", "https://example.com/a(b"), "a [b](<https://example.com/a(b>)|", "unbalanced parentheses go in <>");
  for (const clip of ["https://a.com https://b.com", "ftp://example.com", "example.com", "https://", "javascript:alert(1)", "https://a.com\nmore", "https://a<b>.com"]) {
    assert.equal(press("see [docs] here", "link", clip), "see [docs](|) here", clip);
  }
});

test("a link that is already there is not changed: the whole link selected, its text, its address, or a caret in it", () => {
  const link = "see [docs](https://x.org) here";
  for (const [start, end] of [[4, 25], [3, 26], [5, 9], [7, 7], [11, 24], [20, 20]]) {
    assert.equal(toggleMark(link, { start, end }, "link", "https://y.org"), null, `${start}-${end}`);
  }
  assert.deepEqual(toggleMark(link, { start: 4, end: 4 }, "link"), { value: "see []()[docs](https://x.org) here", start: 5, end: 5 }, "a caret just before a link is outside it");
  assert.equal(toggleMark("a []() b", { start: 3, end: 3 }, "link"), null);
  assert.equal(toggleMark("a []() b", { start: 5, end: 5 }, "link"), null);
  assert.deepEqual(toggleMark("![a](b.png)", { start: 0, end: 11 }, "link"), { value: "[![a](b.png)]()", start: 14, end: 14 }, "a picture is no link: it can be linked");
});

test("offsets are UTF-16 code units: an emoji before or inside the selection, and letters outside the BMP in a word", () => {
  assert.deepEqual(toggleMark("😀 hello world", { start: 3, end: 8 }, "bold"), { value: "😀 **hello** world", start: 5, end: 10 });
  assert.deepEqual(toggleMark("say 😀 hi", { start: 4, end: 9 }, "italic"), { value: "say *😀 hi*", start: 5, end: 10 });
  assert.deepEqual(toggleMark("😀 **hello** world", { start: 5, end: 10 }, "bold"), { value: "😀 hello world", start: 3, end: 8 });
  assert.deepEqual(toggleMark("𝒜𝒷c d", { start: 2, end: 2 }, "bold"), { value: "**𝒜𝒷c** d", start: 4, end: 4 }, "𝒜 and 𝒷 are letters of two code units each");
  assert.deepEqual(toggleMark("a😀b", { start: 1, end: 1 }, "bold"), { value: "a****😀b", start: 3, end: 3 }, "an emoji is not a letter: the caret after a is at the end of a word");
});

test("a reversed or out-of-range selection is taken in order and clamped to the text", () => {
  assert.deepEqual(toggleMark("Hello world", { start: 11, end: 6 }, "bold"), { value: "Hello **world**", start: 8, end: 13 });
  assert.deepEqual(toggleMark("Hello", { start: -3, end: 99 }, "italic"), { value: "*Hello*", start: 1, end: 6 });
});

const has = (text, mark) => {
  const { value, range } = marked(text);
  return hasMark(value, range, mark);
};

test("a mark is on the selection exactly where its key would take it off", () => {
  assert.equal(has("Hello **[world]**.", "bold"), true);
  assert.equal(has("Hello [**world**].", "bold"), true, "the marks inside the selection");
  assert.equal(has("Hello [world].", "bold"), false);
  assert.equal(has("Hello **[wor]ld**.", "bold"), false, "part of the bold text");
  assert.equal(has("Hello ***[world]***.", "bold"), true);
  assert.equal(has("Hello ***[world]***.", "italic"), true, "three stars are bold and italic");
  assert.equal(has("Hello **[world]**.", "italic"), false, "two stars are bold only");
  assert.equal(has("Hello *[world]*.", "bold"), false);
  assert.equal(has("Hello ~~[world]~~.", "strike"), true);
  assert.equal(has("Hello ~[world]~.", "strike"), true);
  assert.equal(has("Hello `[world]`.", "code"), true);
  assert.equal(has("Hello `` [`x`] ``.", "code"), true);
  assert.equal(has("Hello `[wor]ld`.", "code"), false, "part of a code span");
  assert.equal(has("Hello  [world] .", "strike"), false);
  assert.equal(has("Hello [world].", "underline"), false, "a mark there is no key for");
  const samples = ["a **[b]** c", "a *[b]* c", "a ***[b]*** c", "a ~~[b]~~ c", "a `[b]` c", "a [**b**] c", "a [b] c", "a [*b] c", "*[a]** b"];
  for (const text of samples) {
    for (const mark of ["bold", "italic", "strike", "code"]) {
      const { value, range } = marked(text);
      assert.equal(hasMark(value, range, mark), toggleMark(value, range, mark).value.length < value.length, `${text} ${mark}`);
    }
  }
});

test("a link is on the selection when it lies in one, where the key changes nothing", () => {
  const link = "see [docs](https://x.org) here";
  for (const [start, end] of [[4, 25], [5, 9], [11, 24]]) assert.equal(hasMark(link, { start, end }, "link"), true, `${start}-${end}`);
  assert.equal(hasMark(link, { start: 0, end: 3 }, "link"), false);
  assert.equal(hasMark(link, { start: 0, end: 9 }, "link"), false, "from outside the link into it");
  assert.equal(hasMark("![a](b.png)", { start: 0, end: 11 }, "link"), false, "a picture is no link");
});
