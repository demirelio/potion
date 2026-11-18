import test from "node:test";
import assert from "node:assert/strict";
import * as format from "../mods/potion/format.js";
import { parseInline } from "../mods/potion/inline.js";
import { parse } from "../mods/potion/blocks.js";

const { hasMark, toggleMark, wordAround } = format;

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
const press = (text, mark) => {
  const { value, range } = marked(text);
  return show(toggleMark(value, range, mark));
};
const paint = (text, color) => {
  const { value, range } = marked(text);
  return show(format.setColor(value, range, color));
};

// What each character that shows has, as the editor's formatting names it: the marks a key puts on or takes off, a
// highlight's colour ("default" for the editor's own), a text colour, and the link or comment it lies in.
const FLAGS = ["bold", "italic", "strike", "underline", "code"];
const TAG_FLAGS = { strong: "bold", b: "bold", em: "italic", i: "italic", s: "strike", del: "strike", strike: "strike", u: "underline" };
function looks(value) {
  const { spans, chars } = parseInline(value);
  return chars.map(c => {
    const f = { text: c.text, start: c.start, end: c.end, bold: false, italic: false, strike: false, underline: false, code: false, highlight: null, color: null, link: null, note: null, brk: false };
    for (const id of c.spans) {
      const sp = spans[id];
      if (sp.kind === "strong") f.bold = true;
      else if (sp.kind === "em") f.italic = true;
      else if (sp.kind === "strike") f.strike = true;
      else if (sp.kind === "code") f.code = true;
      else if (sp.kind === "link") f.link = `${sp.url} ${sp.title}`;
      else if (sp.kind === "comment" || sp.kind === "highlight") f.note = `${sp.kind} ${sp.note}`;
      else if (sp.kind === "break") f.brk = true;
      else if (sp.kind === "html" && sp.tag === "mark") f.highlight = sp.color ?? "default";
      else if (sp.kind === "html" && sp.tag === "span") f.color = sp.color;
      else if (sp.kind === "html" && TAG_FLAGS[sp.tag]) f[TAG_FLAGS[sp.tag]] = true;
    }
    return f;
  });
}
// Bold, italic and a text colour draw nothing on a space, so a space has them either way.
const isSpace = text => /^\s+$/u.test(text);
const sameLook = (a, b) => {
  const space = isSpace(a.text), flags = space ? ["strike", "underline", "code"] : FLAGS;
  if (a.brk || b.brk) return a.brk === b.brk && a.link === b.link && a.note === b.note;
  return flags.every(k => a[k] === b[k]) && a.highlight === b.highlight && (space || a.color === b.color) && a.link === b.link && a.note === b.note;
};
const describe = f => `${JSON.stringify(f.text)}:${[...FLAGS.filter(k => f[k]), f.highlight && `h=${f.highlight}`, f.color && `k=${f.color}`, f.link && "link", f.note && "note"].filter(Boolean).join("+")}`;

// The selection the operation acts on, as format.js reads it: spaces at the ends left out, a caret in a word the word.
function acted(value, range) {
  let s = Math.min(range.start, range.end), e = Math.max(range.start, range.end);
  while (s < e && /\s/.test(value[s])) s++;
  while (e > s && /\s/.test(value[e - 1])) e--;
  if (s === e) return wordAround(value, s);
  return { start: s, end: e };
}

// What is kept whole: a picture, and a link whose text is not its own (an autolink, a web address, `[label]`).
function units(value) {
  return parseInline(value).spans.filter(sp => sp.kind === "image" || (sp.kind === "link" && !(value[sp.start] === "[" && value[sp.to] === "]"
    && (value[sp.to + 1] === "(" || (value[sp.to + 1] === "[" && sp.end - sp.to > 3)))));
}

// The formatting the operation should leave on each character of `value`, or null when it changes none. A selection
// that cuts a unit takes all of it; code goes on no unit.
function intended(value, range, op) {
  const before = looks(value), sel = acted(value, range);
  if (!sel) return null;
  let { start, end } = sel;
  for (let grew = true; grew;) {
    grew = false;
    for (const u of units(value)) {
      if (u.end <= start || u.start >= end || (u.start >= start && u.end <= end)) continue;
      start = Math.min(start, u.start);
      end = Math.max(end, u.end);
      grew = true;
    }
  }
  const inUnit = c => units(value).some(u => c.start >= u.start && c.end <= u.end);
  const chosen = before.filter(c => !c.brk && c.start < end && c.end > start);
  while (chosen.length && isSpace(chosen[0].text) && !inUnit(chosen[0])) chosen.shift();
  while (chosen.length && isSpace(chosen.at(-1).text) && !inUnit(chosen.at(-1))) chosen.pop();
  if (!chosen.length) return null;
  const counted = flag => chosen.filter(c => !(isSpace(c.text) && (flag === "bold" || flag === "italic")) && !(flag === "code" && inUnit(c)));
  const after = before.map(c => ({ ...c }));
  const pick = c => after[before.indexOf(c)];
  if (op.color) for (const c of chosen) pick(c).color = op.color === "default" ? null : op.color;
  else if (op.mark === "highlight") {
    const on = !chosen.every(c => c.highlight !== null);
    for (const c of chosen) pick(c).highlight = on ? c.highlight ?? "default" : null;
  } else {
    if (!counted(op.mark).length) return null;
    const on = !counted(op.mark).every(c => c[op.mark]);
    for (const c of chosen) if (!(op.mark === "code" && inUnit(c))) pick(c)[op.mark] = on;
  }
  if (after.every((c, i) => sameLook(c, before[i]))) return null;
  return { after, chosen: chosen.map(c => before.indexOf(c)), sel: { start: Math.min(start, chosen[0].start), end: Math.max(end, chosen.at(-1).end) } };
}

const apply = (value, range, op) => (op.color ? format.setColor(value, range, op.color) : toggleMark(value, range, op.mark));

// The operation's contract: the characters that show are the same, each with exactly its intended formatting; links
// keep their addresses and comments their notes; the selection afterwards covers the same characters; text outside
// the stretch the operation rewrote is as it was.
function assertStyled(value, range, op, label = JSON.stringify({ value, range, op })) {
  const want = intended(value, range, op), out = apply(value, range, op);
  if (!want && acted(value, range)) {
    assert.ok(!out || looks(out.value).every((c, i, list) => sameLook(c, looks(value)[i]) && list.length === looks(value).length), `${label}: nothing to do, yet ${out?.value}`);
    return null;
  }
  if (!want) return out;
  assert.ok(out, `${label}: something to do, nothing done`);
  const got = looks(out.value);
  assert.equal(got.map(c => c.text).join(""), want.after.map(c => c.text).join(""), `${label}: the text that shows (${out.value})`);
  assert.equal(got.length, want.after.length, `${label}: as many characters (${out.value})`);
  got.forEach((c, i) => assert.ok(sameLook(c, want.after[i]), `${label}: character ${i} ${describe(c)}, wanted ${describe(want.after[i])} in ${JSON.stringify(out.value)}`));
  const points = v => parseInline(v).spans.filter(sp => sp.kind === "point").map(sp => sp.note);
  assert.deepEqual(points(out.value), points(value), `${label}: point comments`);
  if (range.start === range.end) {
    const at = (list, x) => list.filter(c => c.end <= x).length;
    assert.equal(at(got, out.start), at(looks(value), range.start), `${label}: the caret ${out.start} of ${JSON.stringify(out.value)} among the same characters`);
    return out;
  }
  const inSel = got.map((c, i) => i).filter(i => !got[i].brk && got[i].start < out.end && got[i].end > out.start);
  assert.deepEqual(inSel, want.chosen, `${label}: the selection ${out.start}-${out.end} of ${JSON.stringify(out.value)}`);
  return out;
}

test("each mark goes around the selection, which stays selected inside the marks", () => {
  assert.equal(press("Hello [world].", "bold"), "Hello **[world]**.");
  assert.equal(press("Hello [world].", "italic"), "Hello *[world]*.");
  assert.equal(press("Hello [world].", "strike"), "Hello ~~[world]~~.");
  assert.equal(press("Hello [world].", "code"), "Hello `[world]`.");
  assert.equal(press("Hello [world].", "underline"), "Hello <u>[world]</u>.");
  assert.equal(press("Hello [world].", "highlight"), "Hello <mark>[world]</mark>.");
});

test("a mark every character has is taken off, written as markdown or as a tag, and the text stays selected", () => {
  assert.equal(press("Hello **[world]**.", "bold"), "Hello [world].");
  assert.equal(press("Hello [**world**].", "bold"), "Hello [world].", "the marks inside the selection");
  assert.equal(press("Hello *[world]*.", "italic"), "Hello [world].");
  assert.equal(press("Hello ~~[world]~~.", "strike"), "Hello [world].");
  assert.equal(press("Hello ~[world]~.", "strike"), "Hello [world].", "one tilde is strikethrough as well");
  assert.equal(press("Hello `[world]`.", "code"), "Hello [world].");
  assert.equal(press("Hello [`world`].", "code"), "Hello [world].");
  assert.equal(press("Hello ``[a`b]``.", "code"), "Hello [a`b].");
  assert.equal(press("Hello <u>[world]</u>.", "underline"), "Hello [world].");
  assert.equal(press("Hello <mark>[world]</mark>.", "highlight"), "Hello [world].");
  assert.equal(press("Hello <b>[world]</b>.", "bold"), "Hello [world].");
  assert.equal(press("Hello <strong>[world]</strong>.", "bold"), "Hello [world].");
  assert.equal(press("Hello <em>[world]</em>.", "italic"), "Hello [world].");
  assert.equal(press("Hello <del>[world]</del>.", "strike"), "Hello [world].");
  assert.equal(press('Hello <mark color="#336699">[world]</mark>.', "highlight"), "Hello [world].", "a highlight of any colour");
});

test("code taken off text that would read as markdown escapes it, so the same characters show", () => {
  assert.equal(press("Hello `` [`x`] ``.", "code"), "Hello [\\`x\\`].");
  assert.equal(press("Hello [`` `x` ``].", "code"), "Hello [\\`x\\`].");
  assertStyled("a `*b*` c", { start: 2, end: 7 }, { mark: "code" });
  assertStyled("a `<u>b</u>` c", { start: 2, end: 12 }, { mark: "code" });
});

test("all or nothing: a selection partly bold is made all bold; all bold, the key takes it off; outside it nothing changes", () => {
  assert.equal(press("[a **b** c]", "bold"), "**[a b c]**");
  assert.equal(press("**[a b c]**", "bold"), "[a b c]");
  assert.equal(press("Hello wo[rld **and mo]re**", "bold"), "Hello wo**[rld and mo]re**", "from plain text into a bold run");
  assert.equal(press("Hello wo**[rld and mo]re**", "bold"), "Hello wo[rld and mo]**re**", "again: all of it off, the rest of the run kept");
  assert.equal(press("**ab[c]de**", "bold"), "**ab**[c]**de**", "a run the selection cuts is split");
  assert.equal(press("[**a** b]", "bold"), "**[a b]**", "runs that touch join");
  assert.equal(press("**a**[b]", "bold"), "**a[b]**");
  assert.equal(press("[b]**c**", "bold"), "**[b]c**");
  assert.equal(press("x [a *b* c] y", "italic"), "x *[a b c]* y");
  assert.equal(press("x [a ~~b~~ c] y", "strike"), "x ~~[a b c]~~ y");
  assert.equal(press("x [a <u>b</u> c] y", "underline"), "x <u>[a b c]</u> y");
  assert.equal(press("x [a <mark>b</mark> c] y", "highlight"), "x <mark>[a b c]</mark> y");
});

test("the owner's case: from inside plain text into a bold run, Cmd+B makes it all bold and again takes all of it off", () => {
  const value = "Herdr draws its text fields, which **Herdr** paints itself.";
  const start = value.indexOf("fields"), end = value.indexOf("Herdr**") + 2;
  const once = toggleMark(value, { start, end }, "bold");
  assert.equal(once.value, "Herdr draws its text **fields, which Herdr** paints itself.");
  assert.equal(once.value.slice(once.start, once.end), "fields, which He");
  const twice = toggleMark(once.value, once, "bold");
  assert.equal(twice.value, "Herdr draws its text fields, which He**rdr** paints itself.");
  assert.equal(twice.value.slice(twice.start, twice.end), "fields, which He");
});

test("every other formatting stays: nested marks, a link's address, a comment's marks and note", () => {
  assertStyled("***abc***", { start: 4, end: 5 }, { mark: "bold" });
  assertStyled("**a *b* c**", { start: 2, end: 10 }, { mark: "bold" });
  assertStyled("**a *b* c**", { start: 5, end: 6 }, { mark: "italic" });
  assertStyled("see the [docs page](http://x.org \"T\") now", { start: 4, end: 13 }, { mark: "bold" });
  assertStyled("see [the **docs**](http://x.org) now", { start: 0, end: 20 }, { mark: "strike" });
  assertStyled("a {==b c==}{>>why<<} d", { start: 8, end: 22 }, { mark: "bold" });
  assertStyled("a {==b c==}{>>why<<} d", { start: 0, end: 7 }, { mark: "underline" });
  assertStyled("a {==b **c**==}{>>why<<} d", { start: 0, end: 26 }, { mark: "bold" });
  assertStyled("a {>>p<<}b c", { start: 0, end: 12 }, { mark: "italic" });
  assertStyled("a\\*b *c* d", { start: 0, end: 7 }, { mark: "bold" }, "an escape");
  assertStyled("a &amp; b *c*", { start: 0, end: 12 }, { mark: "bold" }, "an entity");
  assertStyled("a <!-- x --> b", { start: 0, end: 14 }, { mark: "bold" }, "a tag that draws nothing");
  assertStyled("a ![cat](c.png) b", { start: 0, end: 17 }, { mark: "bold" }, "a picture");
  assertStyled("a <https://x.org> b", { start: 0, end: 19 }, { mark: "bold" }, "an autolink");
  assertStyled("a www.x.org b", { start: 0, end: 13 }, { mark: "italic" }, "a web address");
});

test("a picture, an autolink, an escape, an entity and a tag that draws nothing are written as they were", () => {
  for (const [value, kept] of [
    ["a ![cat](c.png) b", "![cat](c.png)"], ["a <https://x.org> b", "<https://x.org>"], ["a\\*b c", "\\*"],
    ["a &amp; b", "&amp;"], ["a <!-- x --> b", "<!-- x -->"], ["a {>>p<<} b", "{>>p<<}"],
  ]) {
    const out = toggleMark(value, { start: 0, end: value.length }, "bold");
    assert.ok(out.value.includes(kept), `${value} -> ${out.value}`);
  }
  const half = toggleMark("see <https://x.org> now", { start: 8, end: 23 }, "bold");
  assert.ok(half.value.includes("**<https://x.org> now**"), `a selection that cuts an autolink takes all of it: ${half.value}`);
});

test("formatting over code goes around the span; code over formatted text keeps it, splitting the span where it must", () => {
  assert.equal(press("a [`x`] b", "bold"), "a **`[x]`** b");
  assert.equal(press("a `[x]` b", "underline"), "a <u>`[x]`</u> b");
  assert.equal(press("`ab[cd]ef`", "bold"), "`ab`**`[cd]`**`ef`");
  assertStyled("a **b** c", { start: 0, end: 9 }, { mark: "code" });
  assertStyled("x {==a b==}{>>n<<} y", { start: 0, end: 20 }, { mark: "code" }, "code splits at a comment's marks");
  assertStyled("[the *docs*](http://x.org) here", { start: 0, end: 31 }, { mark: "code" }, "code inside a link's text");
  assertStyled("a `b` c", { start: 0, end: 7 }, { mark: "code" });
  assertStyled("one\ntwo", { start: 0, end: 7 }, { mark: "code" }, "a line break stays a line break");
});

test("making text code fences its backticks with a longer run, padded when one is at an end", () => {
  assert.equal(press("[a``b]", "code"), "```[a``b]```");
  assert.equal(press("[`]", "code"), "`` [`] ``");
  assert.equal(press("`a` [and] `b`", "code"), "`a` `[and]` `b`", "the backticks of the spans around it are not its marks");
  assert.equal(press("`a`[ and ]`b`", "code"), "`a` `[and]` `b`");
  assertStyled("use `x` here", { start: 0, end: 12 }, { mark: "code" });
});

test("where a markdown delimiter can't open or close, the tag TextView draws is written instead", () => {
  assert.equal(press('["quote"]word', "bold"), '<strong>["quote"]</strong>word');
  assert.equal(press('["quote"]word', "italic"), '<em>["quote"]</em>word');
  assert.equal(press('["quote"]word', "strike"), '<s>["quote"]</s>word');
  assertStyled('a"b"c', { start: 1, end: 4 }, { mark: "bold" });
  assertStyled("*a*b", { start: 3, end: 4 }, { mark: "bold" }, "beside another run's star");
  assertStyled("**x*", { start: 2, end: 3 }, { mark: "bold" }, "beside a star that is text");
  assertStyled("~x~~", { start: 1, end: 2 }, { mark: "strike" });
  assertStyled("a\\ b", { start: 2, end: 4 }, { mark: "bold" }, "after a backslash that is text");
});

test("underline is written <u>…</u> and the highlight <mark>…</mark>, their tags hidden; a highlight of another colour stays", () => {
  assert.equal(press("a [b c] d", "underline"), "a <u>[b c]</u> d");
  assert.equal(press("a <u>[b c]</u> d", "underline"), "a [b c] d");
  assert.equal(press("a [b c] d", "highlight"), "a <mark>[b c]</mark> d");
  assertStyled('a <mark color="#336699">b</mark> c', { start: 0, end: 34 }, { mark: "highlight" });
  assertStyled("**a b** c", { start: 4, end: 9 }, { mark: "underline" });
});

test("a text colour is written <span style=\"color: NAME\">; a new one replaces the old, default takes it off", () => {
  for (const name of ["red", "yellow", "green", "teal", "purple"]) {
    assert.equal(paint("a [b c] d", name), `a <span style="color: ${name}">[b c]</span> d`, name);
  }
  assert.equal(paint('a <span style="color: red">[b c]</span> d', "green"), 'a <span style="color: green">[b c]</span> d');
  assert.equal(paint('a <span style="color: red">[b c]</span> d', "default"), "a [b c] d");
  assert.equal(paint('a <span style="color: red">b [c]</span> d', "default"), 'a <span style="color: red">b</span> [c] d');
  assert.equal(paint("a [b] c", "default"), null, "nothing coloured: nothing changes");
  assert.equal(paint('<span style="color: red">[b]</span>', "red"), null, "the same colour: nothing changes");
  assert.equal(paint("a [b] c", "blue"), null, "a colour that is not one of the editor's");
  assertStyled('x <span style="color: red">a **b**</span> y', { start: 0, end: 42 }, { color: "teal" });
  assertStyled("[a **b**](http://x.org) c", { start: 1, end: 25 }, { color: "purple" });
  assertStyled('<span style="color: red">a</span> <span style="color: green">b</span>', { start: 0, end: 66 }, { color: "default" });
});

test("setMark puts a mark on, or takes it off, whatever the selection has: the colour menu's Highlight and No highlight", () => {
  const set = (text, mark, on) => { const { value, range } = marked(text); return show(format.setMark(value, range, mark, on)); };
  assert.equal(set("<mark>a</mark> [a b]", "highlight", false), null, "none to take off: nothing changes");
  assert.equal(set("[<mark>a</mark> b]", "highlight", false), "[a b]");
  assert.equal(set("[<mark>a</mark> b]", "highlight", true), "<mark>[a b]</mark>");
  assert.equal(set("<mark>[a b]</mark>", "highlight", true), null, "all of it has it already");
  assert.equal(set("[**a** b]", "bold", true), "**[a b]**");
  assert.equal(set("[**a** b]", "bold", false), "[a b]");
  assert.equal(set("wo|rd", "highlight", true), "<mark>wo|rd</mark>");
  assert.equal(set("a | b", "highlight", false), null, "a caret outside a word: nothing to set");
});

test("a caret in a word acts on the word and keeps its place; a caret elsewhere changes nothing (the editor formats what is typed there next)", () => {
  assert.equal(press("Hello wo|rld.", "bold"), "Hello **wo|rld**.");
  assert.equal(press("Hello **wo|rld**.", "bold"), "Hello wo|rld.");
  assert.equal(press("Hello wo|rld.", "italic"), "Hello *wo|rld*.");
  assert.equal(press("Hello wo|rld.", "strike"), "Hello ~~wo|rld~~.");
  assert.equal(press("Hello wo|rld.", "code"), "Hello `wo|rld`.");
  assert.equal(press("Hello `wo|rld`.", "code"), "Hello wo|rld.");
  assert.equal(press("Hello wo|rld.", "underline"), "Hello <u>wo|rld</u>.");
  assert.equal(press("Hello wo|rld.", "highlight"), "Hello <mark>wo|rld</mark>.");
  assert.equal(paint("Hello wo|rld.", "red"), 'Hello <span style="color: red">wo|rld</span>.');
  assert.equal(press("snake_c|ase 42", "bold"), "**snake_c|ase** 42", "letters, digits and _ make a word");
  assert.equal(press("v1|2 x", "italic"), "*v1|2* x");
  assert.equal(press("naï|ve", "bold"), "**naï|ve**");
  assert.equal(press("Hello| world.", "bold"), null, "at the end of a word");
  assert.equal(press("Hello |world.", "italic"), null, "at the start of a word");
  assert.equal(press("|", "strike"), null);
  for (const mark of ["bold", "italic", "strike", "code", "underline", "highlight"]) assert.equal(press("a | b", mark), null, mark);
  assert.equal(press("a **|** b", "bold"), null, "marks around nothing are text, left as they are");
  assert.equal(paint("a | b", "red"), null, "a colour needs text");
});

test("a second press of the same key puts the text back", () => {
  for (const text of ["Hello [world].", "[a]", "x [a b] y", "**[x]**", "*[x]*", "`[a]`", "<u>[x]</u>"]) {
    for (const mark of ["bold", "italic", "strike", "code", "underline", "highlight"]) {
      const once = press(text, mark);
      assert.equal(press(once, mark), text, `${mark} twice on ${text} (once: ${once})`);
    }
  }
});

test("bold and italic share *: each key adds or takes off its own", () => {
  assert.equal(press("**[x]**", "italic"), "***[x]***", "italic inside bold adds a star, it does not strip one");
  assert.equal(press("*[x]*", "bold"), "***[x]***");
  assert.equal(press("***[x]***", "bold"), "*[x]*");
  assert.equal(press("***[x]***", "italic"), "**[x]**");
  assert.equal(press("[***x***]", "bold"), "*[x]*");
  assert.equal(press("[***x***]", "italic"), "**[x]**");
  assert.equal(press("*[**x**]*", "bold"), "*[x]*");
  assert.equal(press("~~[x]~~", "italic"), "~~*[x]*~~", "marks of another kind stay");
  assertStyled("**x*", { start: 0, end: 4 }, { mark: "bold" }, "runs of different lengths are no pair");
  assertStyled("~x~~", { start: 0, end: 4 }, { mark: "strike" });
});

test("spaces at the ends of the selection stay outside the marks; a selection of spaces only is a caret at its start", () => {
  assert.equal(press("say[ hello ]there", "bold"), "say **[hello]** there");
  assert.equal(press("say[\thello\n]there", "code"), "say\t`[hello]`\nthere");
  assert.equal(press("say ** [hello] ** there", "bold"), "say ** **[hello]** ** there", "marks across a space are not the mark");
  assert.equal(press("a[   ]b", "bold"), null);
});

test("bold, italic and a colour show nothing on a space: a space between bold words does not make the selection mixed", () => {
  assert.equal(press("[**a** **b**]", "bold"), "[a b]");
  const linked = toggleMark("a [b c](http://x.org)", { start: 0, end: 4 }, "bold");
  assert.equal(linked.value, "**a** [**b** c](http://x.org)", "a run never ends on a space");
  assertStyled("a [b c](http://x.org)", { start: 0, end: 4 }, { mark: "bold" });
  assert.equal(press("[**a** b]", "underline"), "<u>**[a** b]</u>");
});

test("toggleMark writes no link: the address box makes links (links.js)", () => {
  for (const text of ["see [docs] here", "see do|cs here", "see | here"]) assert.equal(press(text, "link"), null, text);
});

test("offsets are UTF-16 code units: an emoji before or inside the selection, and letters outside the BMP in a word", () => {
  assert.deepEqual(toggleMark("😀 hello world", { start: 3, end: 8 }, "bold"), { value: "😀 **hello** world", start: 5, end: 10 });
  assert.deepEqual(toggleMark("say 😀 hi", { start: 4, end: 9 }, "italic"), { value: "say *😀 hi*", start: 5, end: 10 });
  assert.deepEqual(toggleMark("😀 **hello** world", { start: 5, end: 10 }, "bold"), { value: "😀 hello world", start: 3, end: 8 });
  assert.deepEqual(toggleMark("𝒜𝒷c d", { start: 2, end: 2 }, "bold"), { value: "**𝒜𝒷c** d", start: 4, end: 4 }, "𝒜 and 𝒷 are letters of two code units each");
  assert.equal(toggleMark("a😀b", { start: 1, end: 1 }, "bold"), null, "an emoji is not a letter: the caret after a is at the end of a word");
  const cut = toggleMark("a 😀😀 b", { start: 3, end: 5 }, "bold");
  assert.equal(cut.value, "a **😀😀** b", "a selection end inside a character takes the whole character");
});

test("a reversed or out-of-range selection is taken in order and clamped to the text", () => {
  assert.deepEqual(toggleMark("Hello world", { start: 11, end: 6 }, "bold"), { value: "Hello **world**", start: 8, end: 13 });
  assert.deepEqual(toggleMark("Hello", { start: -3, end: 99 }, "italic"), { value: "*Hello*", start: 1, end: 6 });
});

test("a selection of hidden marks only, or a mark there is no key for, changes nothing", () => {
  assert.equal(toggleMark("a **b** c", { start: 2, end: 4 }, "bold"), null);
  assert.equal(toggleMark("a b", { start: 0, end: 3 }, "sparkle"), null);
});

test("what can't be written so it reads back changes nothing: code right after a web address would join the address", () => {
  assert.equal(toggleMark("a http://x.org/x) b", { start: 4, end: 20 }, "code"), null);
  assert.equal(toggleMark("a http://x.org/x b", { start: 2, end: 16 }, "code"), null, "an address takes no code");
  assert.equal(toggleMark("a http://x.org/x b", { start: 17, end: 18 }, "code").value, "a http://x.org/x `b`");
});

const has = (text, mark) => {
  const { value, range } = marked(text);
  return hasMark(value, range, mark);
};

test("a mark is on the selection when every character of it has the mark: its key would take it off", () => {
  assert.equal(has("Hello **[world]**.", "bold"), true);
  assert.equal(has("Hello [**world**].", "bold"), true, "the marks inside the selection");
  assert.equal(has("Hello [world].", "bold"), false);
  assert.equal(has("Hello **[wor]ld**.", "bold"), true, "part of a bold run is all bold");
  assert.equal(has("Hello [wo**rld**].", "bold"), false, "partly bold");
  assert.equal(has("Hello ***[world]***.", "bold"), true);
  assert.equal(has("Hello ***[world]***.", "italic"), true, "three stars are bold and italic");
  assert.equal(has("Hello **[world]**.", "italic"), false, "two stars are bold only");
  assert.equal(has("Hello *[world]*.", "bold"), false);
  assert.equal(has("Hello ~~[world]~~.", "strike"), true);
  assert.equal(has("Hello ~[world]~.", "strike"), true);
  assert.equal(has("Hello `[world]`.", "code"), true);
  assert.equal(has("Hello `` [`x`] ``.", "code"), true);
  assert.equal(has("Hello `[wor]ld`.", "code"), true, "part of a code span");
  assert.equal(has("Hello  [world] .", "strike"), false);
  assert.equal(has("Hello <u>[world]</u>.", "underline"), true);
  assert.equal(has("Hello [world].", "underline"), false);
  assert.equal(has("Hello <mark>[world]</mark>.", "highlight"), true);
  assert.equal(has('Hello <mark color="#336699">[world]</mark>.', "highlight"), true);
  assert.equal(has("Hello <b>[world]</b>.", "bold"), true);
  assert.equal(has("[**a** **b**]", "bold"), true, "the space between them shows no bold");
  assert.equal(has("Hello [world].", "sparkle"), false, "a mark there is no key for");
  assert.equal(has("a **|** b", "bold"), false, "marks around nothing are text");
  assert.equal(has("a | b", "bold"), false);
  assert.equal(has("**a | b**", "bold"), true, "a caret outside a word: whether what is typed there has the mark");
  assert.equal(has("**a b**| c", "bold"), false, "typing right after a run is plain");
  for (const text of ["a **[b]** c", "a *[b]* c", "a ***[b]*** c", "a ~~[b]~~ c", "a `[b]` c", "a [**b**] c", "a [b] c", "a [*b] c", "*[a]** b", "[a **b**]"]) {
    for (const mark of ["bold", "italic", "strike", "code", "underline", "highlight"]) {
      const { value, range } = marked(text), out = toggleMark(value, range, mark);
      const after = out && looks(out.value).filter(c => c.start < out.end && c.end > out.start && !/^\s+$/.test(c.text));
      const off = Boolean(after) && after.every(c => (mark === "highlight" ? c.highlight === null : !c[mark]));
      assert.equal(hasMark(value, range, mark), off, `${text} ${mark}: on exactly when its key takes it off every character`);
    }
  }
});

test("a link is on the selection when it lies in one, of any form", () => {
  const link = "see [docs](https://x.org) here";
  for (const [start, end] of [[4, 25], [5, 9], [11, 24], [7, 7]]) assert.equal(hasMark(link, { start, end }, "link"), true, `${start}-${end}`);
  assert.equal(hasMark(link, { start: 0, end: 3 }, "link"), false);
  assert.equal(hasMark(link, { start: 0, end: 9 }, "link"), false, "from outside the link into it");
  assert.equal(hasMark(link, { start: 4, end: 4 }, "link"), false, "a caret at its edge is outside it");
  assert.equal(hasMark("![a](b.png)", { start: 0, end: 11 }, "link"), false, "a picture is no link");
  const defs = parse("x\n\n[ref]: https://r.org\n").defs;
  assert.equal(hasMark("a [docs][ref] b", { start: 3, end: 7 }, "link", { defs }), true, "a reference link");
  assert.equal(hasMark("a <https://x.org> b", { start: 5, end: 9 }, "link"), true, "an autolink");
  assert.equal(hasMark("a www.x.org b", { start: 2, end: 5 }, "link"), true, "a bare address");
});

test("the selection's text colour and highlight: one name, default or none, or mixed", () => {
  const color = text => { const { value, range } = marked(text); return format.colorOf(value, range); };
  const lit = text => { const { value, range } = marked(text); return format.highlightOf(value, range); };
  assert.equal(color("a [b] c"), "default");
  assert.equal(color('a <span style="color: red">[b]</span> c'), "red");
  assert.equal(color('<span style="color: teal">a [b c</span> d]'), "mixed");
  assert.equal(color('<span style="color: teal">[a</span> <span style="color: teal">b]</span>'), "teal", "a space between them shows no colour");
  assert.equal(color('<span style="color: green">w|ord</span>'), "green", "a caret in a word: the word's");
  assert.equal(color('<span style="color: #ff0000">[b]</span>'), "#ff0000", "a colour written in the file");
  assert.equal(lit("a [b] c"), "none");
  assert.equal(lit("<mark>[b c]</mark>"), "default");
  assert.equal(lit('<mark color="#336699">[b]</mark>'), "#336699");
  assert.equal(lit("<mark>a [b</mark> c]"), "mixed");
  assert.equal(lit("{==[b]==}{>>n<<}"), "none", "a comment's highlight is the comment's");
});

// A small random number generator, so a failing case can be run again from its seed.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["alpha", "be", "c", "delta", "e2", "fox", "gé", "x"];
const WRAPS = [
  w => `**${w}**`, w => `*${w}*`, w => `~~${w}~~`, w => `<u>${w}</u>`, w => `<mark>${w}</mark>`,
  w => `<span style="color: red">${w}</span>`, w => `<span style="color: teal">${w}</span>`, w => `***${w}***`, w => `\`${w}\``,
];
// A link's text holds no link: markdown has no links in links.
function fragment(rand, depth = 0, linked = false) {
  const pick = list => list[Math.floor(rand() * list.length)];
  const r = rand();
  if (r < 0.35 || depth > 1) return pick(WORDS);
  if (r < 0.7) {
    const wrap = pick(WRAPS), inner = wrap === WRAPS[8] ? pick(WORDS) : phrase(rand, depth + 1, 2, linked);
    return wrap(inner);
  }
  if (r < 0.8 && !linked) return `[${phrase(rand, depth + 1, 2, true)}](http://x.org/${pick(WORDS)})`;
  if (r < 0.88) return `{==${phrase(rand, depth + 1, 2, linked)}==}{>>${pick(WORDS)}<<}`;
  if (r < 0.94) return pick(["\\*", "\\_", "&amp;", "{>>p<<}"]);
  return pick(WORDS) + pick(WORDS);
}
function phrase(rand, depth, most, linked = false) {
  const n = 1 + Math.floor(rand() * most), parts = [];
  for (let i = 0; i < n; i++) parts.push(fragment(rand, depth, linked));
  return parts.join(rand() < 0.8 ? " " : "");
}
const OPS = [{ mark: "bold" }, { mark: "italic" }, { mark: "strike" }, { mark: "underline" }, { mark: "code" }, { mark: "highlight" }, { color: "red" }, { color: "green" }, { color: "default" }];

test("random values, selections and operations: each leaves exactly the intended formatting and nothing else", () => {
  const CASES = 4000, base = 20261116;
  let done = 0;
  for (let k = 0; k < CASES; k++) {
    const seed = base + k, rand = random(seed), value = phrase(rand, 0, 6), op = OPS[Math.floor(rand() * OPS.length)];
    const a = Math.floor(rand() * (value.length + 1)), b = rand() < 0.15 ? a : Math.floor(rand() * (value.length + 1));
    const range = { start: a, end: b }, label = `seed ${seed}: ${JSON.stringify(value)} ${a}-${b} ${JSON.stringify(op)}`;
    const want = intended(value, range, op);
    const out = assertStyled(value, range, op, label);
    if (!want || !out) continue;
    done++;
    const { sel } = want;
    let lo = sel.start, hi = sel.end;
    for (let grew = true; grew;) {
      grew = false;
      for (const sp of parseInline(value).spans) {
        if (sp.start > hi || sp.end < lo || (sp.start >= lo && sp.end <= hi)) continue;
        [lo, hi, grew] = [Math.min(lo, sp.start), Math.max(hi, sp.end), true];
      }
    }
    while (lo > 0 && "*_~`".includes(value[lo - 1])) lo--;
    while (hi < value.length && "*_~`".includes(value[hi])) hi++;
    assert.ok(out.value.startsWith(value.slice(0, lo)) && out.value.endsWith(value.slice(hi)), `${label}: rewrote outside ${lo}-${hi}: ${out.value}`);
  }
  assert.ok(done > CASES / 2, `${done} of ${CASES} cases had something to change`);
});
