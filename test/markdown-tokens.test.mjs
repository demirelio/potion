import test from "node:test";
import assert from "node:assert/strict";
import { parseInline } from "../mods/potion/inline.js";
import { POINT } from "../mods/potion/comments.js";
import { parse } from "../mods/potion/blocks.js";
import { clipOf, drawnOffset, extentOf, piecesOf, pressedAt, richOf, sameTokens, tokensFor } from "../mods/potion/tokens.js";

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
  assert.deepEqual(tokens("<u>under</u> <mark>m</mark>"), [["<u>under</u>", "under", "u:5"], ["<mark>m</mark>", "m", "h:1"]], "a mark with no colour of its own: the highlight");
  assert.deepEqual(tokens('<mark color="#336699">m</mark>'), [['<mark color="#336699">m</mark>', "m", "m#336699:1"]]);
  assert.deepEqual(tokens('<span style="color: red">re</span><span style="color: teal">**d**</span>'), [['<span style="color: red">re</span><span style="color: teal">**d**</span>', "red", "@red:2,b@teal:1"]]);
  assert.deepEqual(tokens('<mark color="#336699"><span style="color: #ff0000">x</span></mark>'), [['<mark color="#336699"><span style="color: #ff0000">x</span></mark>', "x", "m#336699@#ff0000:1"]]);
});

test("a word that mixes formatting is one token drawn in pieces", () => {
  assert.deepEqual(tokens("**bo**ld"), [["**bo**ld", "bold", "b:2,:2"]]);
  assert.deepEqual(tokens("x*y*z"), [["x*y*z", "xyz", ":1,i:1,:1"]]);
});

test("a run's opening marks go with its first letter and its closing marks with its last; the spaces inside it go with the word before them", () => {
  assert.deepEqual(tokens("x *one two* y"), [["*one ", "one ", "i:4"], ["two*", "two", "i:3"]]);
});

test("spaces inside a formatted run draw in its formatting, so a highlight or an underline runs on across them; lines still break between words", () => {
  const value = "say {==the agent  appear==}{>>n<<} now";
  assert.deepEqual(tokens(value), [["{==the ", "the ", "h:4"], ["agent  ", "agent  ", "h:7"], ["appear==}{>>n<<}", "appear", "h:6"]], "one token per word");
  assert.deepEqual(tokens("**a** **b** `c d`"), [["**a**", "a", "b:1"], ["**b**", "b", "b:1"], ["`c ", "c ", "c:2"], ["d`", "d", "c:1"]], "a space between two runs stays plain");
  assert.deepEqual(tokens("*a\\\nb*"), [["*a\\", "a", "i:1"], ["b*", "b", "i:1"]], "a line break is never in a token");
  const r = rich(value);
  assert.equal(r.drawn, "say the agent  appear now");
  assert.equal(drawnOffset(r, value.indexOf("agent") + 6), "say the agent ".length, "between the two spaces");
  assert.deepEqual(tokens(value, caret(value.indexOf("agent") + 2)).slice(1, 9).map(t => [t[1], t[2]]),
    [["a", "h:1"], ["g", "h:1"], ["e", "h:1"], ["n", "h:1"], ["t", "h:1"], [" ", "h:1"], [" ", "h:1"], ["appear", "h:6"]], "split at the caret, its spaces too");
  assert.deepEqual(tokensFor(r, caret(value.indexOf("agent") + 6)).sel, caret(value.indexOf("agent") + 6), "a caret between the spaces stays");
});

test("every word of a checked task is a token with the spaces after it, so the line through it is drawn", () => {
  const checked = value => tokensFor(richOf(value, parseInline(value), { everyWord: true }), FAR).tokens.map(t => [t.token.text, t.token.label, t.token.id]);
  assert.deepEqual(checked("buy  milk"), [["buy  ", "buy  ", ":5"], ["milk", "milk", ":4"]]);
  assert.deepEqual(checked("a **b** c"), [["a ", "a ", ":2"], ["**b** ", "b ", "b:1,:1"], ["c", "c", ":1"]]);
  assert.equal(richOf("buy milk", parseInline("buy milk"), { everyWord: true }).drawn, "buy milk");
});

test("a link's address and a comment's note go with the last token of their run", () => {
  assert.deepEqual(tokens("[the docs](https://e.com/x) z"), [["[the ", "the ", "l:4"], ["docs](https://e.com/x)", "docs", "l:4"]]);
  assert.deepEqual(tokens("{==hi there==}{>>a note<<}."), [["{==hi ", "hi ", "h:3"], ["there==}{>>a note<<}.", "there.", "h:5,:1"]]);
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
  assert.deepEqual(tokens("![a cat](c.png) x"), [["![a ", "a ", "P:0,p:2"], ["cat](c.png)", "cat", "p:3"]]);
  assert.deepEqual(tokens("x ![](c.png)"), [["![](c.png)", "\u{200b}", "P:0"]]);
});

test("the word holding or touching the caret is split into a token per letter, each keeping the marks next to it; a caret one space away leaves it whole", () => {
  const value = "a **bold** b";
  assert.deepEqual(texts(value, caret(6)), ["**b", "o", "l", "d**"]);
  assert.deepEqual(tokens(value, caret(6)).map(t => t[1]), ["b", "o", "l", "d"]);
  assert.deepEqual(texts(value, caret(12)), ["**bold**"], "a caret on another word leaves it whole");
  assert.deepEqual(texts(value, caret(2)), ["**b", "o", "l", "d**"]);
  assert.deepEqual(texts(value, caret(10)), ["**b", "o", "l", "d**"]);
  assert.deepEqual(texts(value, caret(11)), ["**bold**"]);
  assert.deepEqual(texts(value, caret(1)), ["**bold**"]);
});

test("the words at both ends of a selection are split; a word inside it stays whole", () => {
  const value = "**ab** **cd** **ef**";
  assert.deepEqual(texts(value, { start: 3, end: 17 }), ["**a", "b**", "**cd**", "**e", "f**"]);
});

test("with its prefixes' widths, a word split at the caret draws the whole word in each letter's box, so its letters stay where they were", () => {
  const value = "a **bo**ld b", asked = [];
  const measure = prefixes => { asked.push(...prefixes); return [7, 15, 19, 27]; };
  const list = tokensFor(rich(value), caret(5), measure).tokens;
  assert.deepEqual(asked, [{ id: "b:1", label: "b" }, { id: "b:2", label: "bo" }, { id: "b:2,:1", label: "bol" }, { id: "b:2,:2", label: "bold" }]);
  assert.deepEqual(list.map(t => t.token.text), ["**b", "o**", "l", "d"], "the ranges a token per letter has");
  assert.deepEqual(list.map(t => t.token.label), ["b", "o", "l", "d"]);
  assert.deepEqual(list.map(t => clipOf(t.token.id)), [[0, 7], [7, 8], [15, 4], [19, 8]].map(([x, width]) => ({ x, width, id: "b:2,:2", label: "bold" })));
  assert.deepEqual(piecesOf(list[2].token.id, list[2].token.label), [{ text: "bo", bold: true }, { text: "ld" }], "each draws the whole word");
  assert.equal(clipOf("b:2,:2"), null);
});

test("until the widths are known, or when a letter would get none, the split word is a token per letter drawn alone", () => {
  const value = "a **bold** b", alone = texts(value, caret(6));
  for (const measure of [() => null, () => [7, 7, 12, 20]]) {
    const list = tokensFor(rich(value), caret(6), measure).tokens;
    assert.deepEqual(list.map(t => t.token.text), alone);
    assert.ok(list.every(t => clipOf(t.token.id) === null));
  }
  const emoji = "**e\u{301}👍🏽x**", prefixes = [];
  tokensFor(rich(emoji), caret(2), p => { prefixes.push(...p.map(x => x.label)); return null; });
  assert.deepEqual(prefixes, ["e\u{301}", "e\u{301}👍🏽", "e\u{301}👍🏽x"], "a prefix per whole character");
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

test("a range's extent reaches out to the hidden marks that go with the letters at its ends", () => {
  const value = "say **[a b](u)** now", link = parseInline(value).spans.find(sp => sp.kind === "link");
  assert.deepEqual(extentOf(rich(value), link), { start: 4, end: 16 }, "the bold's marks around the link");
  assert.deepEqual(extentOf(rich("[a](u) x"), { start: 0, end: 6 }), { start: 0, end: 6 });
  assert.deepEqual(extentOf(rich("x *word* y"), { start: 3, end: 7 }), { start: 2, end: 8 });
  assert.deepEqual(extentOf(rich("plain words"), { start: 2, end: 7 }), { start: 2, end: 7 });
});

test("a link's address never shows: a caret in it moves after the link, as in any hidden marks", () => {
  const value = "Hello [world]() and **b**", r = rich(value), at = value.indexOf(")");
  assert.deepEqual(tokensFor(r, caret(at)).sel, caret(at + 1), "the caret in ()");
  assert.deepEqual(tokens(value, caret(at)).map(t => t[1]), ["w", "o", "r", "l", "d", "b"]);
  for (const x of [4, 10, 17]) {
    const link = "[w](https://a.org) x";
    assert.deepEqual(tokensFor(rich(link), caret(x)).sel, caret(18), `at ${x}`);
    assert.deepEqual(tokens(link, caret(x)).map(t => t[1]), ["w"], `at ${x}`);
  }
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

const byLength = prefixes => prefixes.map(p => 7 * p.label.length + 1);

test("every token's range holds exactly its text, tokens never overlap, and every label is something to draw", () => {
  const values = [
    "a **bold** b", "**bo**ld *x* ~~s~~ `c d` [l k](u) ![i j](p) {==h i==}{>>n<<} {>>p<<} \\* &amp; <u>u</u>",
    "foo\\\nbar  \n  baz", "***a*** __b__ _c_ <https://e.com> www.e.com x@y.com", "e\u{301} **👍🏽🇫🇷** [](u) ![](i)",
    "[ref][r] and [r]", "`a\nb` <!-- c --> <span>s</span>", "*a **b** c*", "[*a*](u) **[b](u)**",
  ];
  for (const value of values) {
    const r = rich(value, { defs: parse("[r]: /url\n").defs });
    for (let at = 0; at <= value.length; at++) {
      for (const [sel, measure] of [[caret(at), null], [caret(at), byLength], [{ start: 0, end: at }, null], [{ start: at, end: value.length }, byLength]]) {
        const { tokens: list, sel: snapped } = tokensFor(r, sel, measure);
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
  assert.deepEqual(piecesOf("u@red:1,m#336699@#ff0000:1", "ab"), [{ text: "a", underline: true, color: "red" }, { text: "b", mark: "#336699", color: "#ff0000" }]);
});

const tinted = (value, tint, sel = FAR) => tokensFor(richOf(value, parseInline(value), { tint }), sel).tokens.map(t => [t.token.text, t.token.label, t.token.id]);

test("a tint over the active comment's text draws it deeper: its letters, the spaces between them and a point comment's marker", () => {
  const value = "a {==hi there==}{>>n<<} b", from = value.indexOf("hi"), to = value.indexOf("==}");
  assert.deepEqual(tinted(value, { start: from, end: to, letter: "d" }), [["{==hi ", "hi ", "hd:3"], ["there==}{>>n<<}", "there", "hd:5"]]);
  assert.deepEqual(tinted(value, null), tokens(value), "no tint: as before");
  const point = "a {>>note<<} b", at = point.indexOf("{>>");
  assert.deepEqual(tinted(point, { start: at, end: point.indexOf(" b"), letter: "d" }), [["{>>note<<}", POINT, `Nd:${POINT.length}`]]);
  assert.deepEqual(piecesOf(`Nd:${POINT.length}`, POINT), [{ text: POINT, point: true, deep: true }]);
  assert.deepEqual(piecesOf("bhd:1", "x"), [{ text: "x", bold: true, highlight: true, deep: true }]);
});

test("a tint over plain text makes its words tokens drawn highlighted, a word it cuts split where it begins and ends", () => {
  const value = "say hello world now", start = value.indexOf("llo"), end = value.indexOf(" now");
  assert.deepEqual(tinted(value, { start, end, letter: "h" }), [["hello ", "hello ", ":2,h:4"], ["world", "world", "h:5"]]);
  const r = richOf(value, parseInline(value), { tint: { start, end, letter: "h" } });
  assert.equal(r.drawn, value, "it draws the same characters");
  assert.deepEqual(extentOf(r, { start, end }), { start, end });
  assert.deepEqual(tinted(value, { start, end, letter: "h" }, { start, end }).map(t => t[0]), ["h", "e", "l", "l", "o", " ", "w", "o", "r", "l", "d"], "the words at the selection's ends split into letters");
});

test("a cell's code span holding \\| draws | in its token, the backslash hidden; a paragraph's draws it as written", () => {
  assert.deepEqual(tokens("`x\\|y`", FAR, { cell: true }), [["`x\\|y`", "x|y", "c:3"]]);
  assert.deepEqual(tokens("`x\\|y`"), [["`x\\|y`", "x\\|y", "c:4"]]);
  assert.equal(rich("a \\| b `x\\|y`", { cell: true }).drawn, "a | b x|y");
});

test("tokens compare by range, text, id and label", () => {
  const a = tokensFor(rich("a **b** c"), FAR).tokens;
  assert.ok(sameTokens(a, tokensFor(rich("a **b** c"), FAR).tokens));
  assert.ok(!sameTokens(a, tokensFor(rich("aa **b** c"), FAR).tokens));
  assert.ok(!sameTokens(a, []));
  assert.ok(sameTokens([], []));
});
