import test from "node:test";
import assert from "node:assert/strict";
import { parseInline } from "../mods/herdr-inline-markdown/inline.js";
import { POINT } from "../mods/herdr-inline-markdown/comments.js";
import { parse } from "../mods/herdr-inline-markdown/blocks.js";
import { drawnOffset, piecesOf, pressedAt, richOf, sameTokens, tokensFor } from "../mods/herdr-inline-markdown/tokens.js";

const rich = (value, opts) => richOf(value, parseInline(value, opts));
const caret = at => ({ start: at, end: at });
const FAR = caret(Infinity);
// Each token as [its source text, what it shows, its drawing id].
const tokens = (value, sel = FAR, opts) => tokensFor(rich(value, opts), sel).tokens.map(t => [t.token.text, t.token.label, t.token.id]);
const texts = (value, sel = FAR) => tokensFor(rich(value), sel).tokens.map(t => t.token.text);
const CONTROL = /[\p{Cc}\u{2028}\u{2029}]/u;

test("words of plain characters stay plain text: no tokens", () => {
  assert.deepEqual(tokens("plain words, nothing more"), []);
  assert.deepEqual(tokens(""), []);
  assert.deepEqual(tokens("a lone * and _ stay text"), []);
});

test("a formatted word is one token that shows its characters and draws them in its formatting", () => {
  assert.deepEqual(tokens("a **bold** b"), [["**bold**", "bold", "b:4"]]);
  assert.deepEqual(tokens("*it* ~~gone~~ `code`"), [["*it*", "it", "i:2"], ["~~gone~~", "gone", "s:4"], ["`code`", "code", "c:4"]]);
  assert.deepEqual(tokens("***both***"), [["***both***", "both", "bi:4"]]);
  assert.deepEqual(tokens("<u>under</u> <mark>m</mark>"), [["<u>under</u>", "under", "u:5"], ["<mark>m</mark>", "m", "m#fef08a:1"]]);
});

test("a word that mixes formatting is one token drawn in pieces", () => {
  assert.deepEqual(tokens("**bo**ld"), [["**bo**ld", "bold", "b:2,:2"]]);
  assert.deepEqual(tokens("x*y*z"), [["x*y*z", "xyz", ":1,i:1,:1"]]);
});

test("a run's opening marks go with its first letter and its closing marks with its last; spaces inside it stay plain", () => {
  const value = "x *one two* y";
  assert.deepEqual(tokens(value), [["*one", "one", "i:3"], ["two*", "two", "i:3"]]);
  assert.equal(value.slice(6, 7), " ", "the space between them is no token");
});

test("a link's address and a comment's note go with the last token of their run", () => {
  assert.deepEqual(tokens("[the docs](https://e.com/x) z"), [["[the", "the", "l:3"], ["docs](https://e.com/x)", "docs", "l:4"]]);
  assert.deepEqual(tokens("{==hi there==}{>>a note<<}."), [["{==hi", "hi", "h:2"], ["there==}{>>a note<<}.", "there.", "h:5,:1"]]);
  assert.deepEqual(tokens("{==marked==} only"), [["{==marked==}", "marked", "h:6"]]);
});

test("a point comment, an empty link and a tag that draws nothing are tokens of their own", () => {
  assert.deepEqual(tokens("a {>>note<<} b"), [["{>>note<<}", POINT, `N:${POINT.length}`]]);
  assert.deepEqual(tokens("a [](u) b"), [["[](u)", "\u{200b}", "E:0"]]);
  assert.deepEqual(tokens("a<span>b</span>"), [["<span>", "\u{200b}", "E:0"], ["</span>", "\u{200b}", "E:0"]]);
  assert.deepEqual(tokens("word{>>n<<}"), [["{>>n<<}", POINT, `N:${POINT.length}`]], "the word before it stays plain");
});

test("escapes and entities show their character, so their words are tokens", () => {
  assert.deepEqual(tokens("a \\* b"), [["\\*", "*", ":1"]]);
  assert.deepEqual(tokens("Tom &amp; Jerry &copy;2026"), [["&amp;", "&", ":1"], ["&copy;2026", "©2026", ":5"]]);
});

test("a hard break's marks are hidden with the word before it; the line break itself is never in a token", () => {
  assert.deepEqual(tokens("foo\\\nbar"), [["foo\\", "foo", ":3"]]);
  assert.deepEqual(tokens("foo  \n  bar"), [["foo  ", "foo", ":3"], ["  bar", "bar", ":3"]]);
  assert.deepEqual(tokens("a <br> b"), [["<br>", "\u{200b}", "E:0"]], "a tag break shows no line break in the field");
  for (const t of tokensFor(rich("one **two**\nthree\\\n**four**"), caret(9)).tokens) assert.ok(!t.token.text.includes("\n"), t.token.text);
});

test("an image shows a picture icon before its alt text; one with no alt text is the icon alone", () => {
  assert.deepEqual(tokens("![a cat](c.png) x"), [["![a", "a", "P:0,p:1"], ["cat](c.png)", "cat", "p:3"]]);
  assert.deepEqual(tokens("x ![](c.png)"), [["![](c.png)", "\u{200b}", "P:0"]]);
});

test("the word holding the caret is split into a token per letter, each keeping the marks next to it", () => {
  const value = "a **bold** b";
  assert.deepEqual(texts(value, caret(6)), ["**b", "o", "l", "d**"]);
  assert.deepEqual(tokens(value, caret(6)).map(t => t[1]), ["b", "o", "l", "d"]);
  assert.deepEqual(texts(value, caret(12)), ["**bold**"], "a caret on another word leaves it whole");
});

test("a word touching the caret at either edge is split too, and a caret one space away is not", () => {
  const value = "a **bold** b";
  assert.deepEqual(texts(value, caret(2)), ["**b", "o", "l", "d**"]);
  assert.deepEqual(texts(value, caret(10)), ["**b", "o", "l", "d**"]);
  assert.deepEqual(texts(value, caret(11)), ["**bold**"]);
  assert.deepEqual(texts(value, caret(1)), ["**bold**"]);
});

test("the words at both ends of a selection are split; a word inside it stays whole", () => {
  const value = "**ab** **cd** **ef**";
  assert.deepEqual(texts(value, { start: 3, end: 17 }), ["**a", "b**", "**cd**", "**e", "f**"]);
});

test("a caret or a selection end inside hidden marks moves to a letter's edge, never inside a token", () => {
  const value = "a **bold** b", r = rich(value);
  assert.deepEqual(tokensFor(r, caret(3)).sel, caret(2), "inside the opening marks: before the word");
  assert.deepEqual(tokensFor(r, caret(4)).sel, caret(2), "after the marks, before the first letter: still outside the run");
  assert.deepEqual(tokensFor(r, caret(9)).sel, caret(10), "inside the closing marks: after the word");
  assert.deepEqual(tokensFor(r, { start: 4, end: 8 }).sel, { start: 2, end: 10 }, "a selection of the letters takes their marks");
  assert.deepEqual(tokensFor(r, caret(6)).sel, caret(6), "between two letters it stays");
  assert.deepEqual(tokensFor(rich("x \\* y"), caret(3)).sel, caret(2), "inside an escape: before its character");
});

test("a link whose address holds the caret stays as typed, so the address can be typed; elsewhere its address is hidden", () => {
  const value = "Hello [world]() and **b**", r = rich(value), at = value.indexOf(")");
  assert.deepEqual(tokensFor(r, caret(at)), { tokens: tokensFor(r, FAR).tokens.slice(1), sel: caret(at) }, "the caret in ()");
  assert.deepEqual(texts(value, FAR), ["[world]()", "**b**"]);
  assert.deepEqual(texts("[w](https://a.org) x", caret(10)), [], "anywhere inside the parentheses");
  assert.deepEqual(texts("[w](https://a.org) x", caret(4)), [], "right after the (");
  assert.deepEqual(texts("[w](u) x", caret(6)), ["[w](u)"], "after the ) it is a token again");
});

test("letters are whole characters: combining marks, emoji with modifiers and joiners, flags", () => {
  const value = "**e\u{301}👍🏽👨\u{200d}👩\u{200d}👧🇫🇷x**";
  assert.deepEqual(tokens(value, caret(2)).map(t => t[1]), ["e\u{301}", "👍🏽", "👨\u{200d}👩\u{200d}👧", "🇫🇷", "x"]);
});

test("a token never holds a control character: a line break hidden in a link title stays plain text", () => {
  const value = "[a](u \"t\nt\") b";
  for (const sel of [FAR, caret(0), caret(1)]) {
    for (const t of tokensFor(rich(value), sel).tokens) assert.doesNotMatch(t.token.text + t.token.label, CONTROL, t.token.text);
  }
});

test("every token's range holds exactly its text, tokens never overlap, and every label is something to draw", () => {
  const values = [
    "a **bold** b", "**bo**ld *x* ~~s~~ `c d` [l k](u) ![i j](p) {==h i==}{>>n<<} {>>p<<} \\* &amp; <u>u</u>",
    "foo\\\nbar  \n  baz", "***a*** __b__ _c_ <https://e.com> www.e.com x@y.com", "e\u{301} **👍🏽🇫🇷** [](u) ![](i)",
    "[ref][r] and [r]", "`a\nb` <!-- c --> <span>s</span>", "*a **b** c*", "[*a*](u) **[b](u)**",
  ];
  for (const value of values) {
    const r = rich(value, { defs: parse("[r]: /url\n").defs });
    for (let at = 0; at <= value.length; at++) {
      for (const sel of [caret(at), { start: 0, end: at }, { start: at, end: value.length }]) {
        const { tokens: list, sel: snapped } = tokensFor(r, sel);
        let end = 0;
        for (const t of list) {
          assert.equal(value.slice(t.range.start, t.range.end), t.token.text, `${value} @${at}`);
          assert.ok(t.range.start >= end && t.range.start < t.range.end, `${value}: ordered, not overlapping`);
          assert.ok(t.token.label && t.token.id.trim(), "a label and an id");
          assert.doesNotMatch(t.token.text + t.token.label, CONTROL);
          for (const x of [snapped.start, snapped.end]) assert.ok(!(x > t.range.start && x < t.range.end), `${value} @${at}: selection inside ${t.token.text}`);
          end = t.range.end;
        }
      }
    }
  }
});

test("the drawn text is what the field shows: shown characters, a mark for a point comment and a picture", () => {
  const r = rich("a **bold** [l](u) {>>n<<} ![i](p)\nnext");
  assert.equal(r.drawn, "a bold l \u{2022} \u{2022}i\nnext");
  assert.equal(drawnOffset(r, 0), 0);
  assert.equal(drawnOffset(r, 2), 2, "before the word");
  assert.equal(drawnOffset(r, 6), 4, "between o and l");
  assert.equal(drawnOffset(r, 10), 6, "after the word and its marks");
  assert.equal(drawnOffset(r, r.value.length), r.drawn.length);
  assert.equal(rich("plain text").drawn, "plain text");
});

test("a press across a token's width picks the letter edge under it, shared out by the letters' widths", () => {
  const value = "a **bold** b", r = rich(value), range = { start: 2, end: 10 };
  assert.equal(pressedAt(r, range, 0), 2, "before the first letter: before its marks");
  assert.equal(pressedAt(r, range, 1), 10, "after the last letter: after its marks");
  assert.equal(pressedAt(r, range, 0.5), 6, "the middle, between o and l");
  assert.equal(pressedAt(r, range, 0.3), 5);
  const wide = rich("**mmmi**"), all = { start: 0, end: 8 };
  assert.equal(pressedAt(wide, all, 0.9), 5, "a narrow last letter takes a small share");
  assert.equal(pressedAt(r, { start: 5, end: 6 }, 0.2), 5, "one letter: its nearer edge");
  assert.equal(pressedAt(rich("a {>>n<<} b"), { start: 2, end: 9 }, 0.7), 9);
});

test("the drawing pieces come back from a token's id and label", () => {
  assert.deepEqual(piecesOf("b:2,:2", "bold"), [{ text: "bo", bold: true }, { text: "ld" }]);
  assert.deepEqual(piecesOf("P:0,p:3", "cat"), [{ icon: true }, { text: "cat", picture: true }]);
  assert.deepEqual(piecesOf(`N:${POINT.length}`, POINT), [{ text: POINT, point: true }]);
  assert.deepEqual(piecesOf("E:0", "\u{200b}"), []);
  assert.deepEqual(piecesOf("bisuclh:1", "x"), [{ text: "x", bold: true, italic: true, strike: true, underline: true, code: true, link: true, highlight: true }]);
  assert.deepEqual(piecesOf("im#fef08a:2", "ab"), [{ text: "ab", italic: true, mark: "#fef08a" }]);
});

test("tokens compare by range, text, id and label", () => {
  const a = tokensFor(rich("a **b** c"), FAR).tokens;
  assert.ok(sameTokens(a, tokensFor(rich("a **b** c"), FAR).tokens));
  assert.ok(!sameTokens(a, tokensFor(rich("aa **b** c"), FAR).tokens));
  assert.ok(!sameTokens(a, []));
  assert.ok(sameTokens([], []));
});
