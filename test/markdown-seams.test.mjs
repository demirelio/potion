import test from "node:test";
import assert from "node:assert/strict";
import { copyOf, joinRuns, pasteInto, pasteParagraphs, splitRuns } from "../mods/herdr-inline-markdown/seams.js";
import { parseInline } from "../mods/herdr-inline-markdown/inline.js";
import { parse } from "../mods/herdr-inline-markdown/blocks.js";
import { mend } from "../mods/herdr-inline-markdown/mend.js";
import { MARK_BITS, UNIT, modelOf } from "../mods/herdr-inline-markdown/restyle.js";

const DEFS = parse("x\n\n[d]: https://e.com \"Docs\"\n").defs;
const halves = out => [out.value.slice(0, out.start), out.value.slice(out.end)];

// What each character that shows has: its marks, highlight, colour, link and comment.
const FLAGS = ["bold", "italic", "strike", "underline", "code"];
const TAG_FLAGS = { strong: "bold", b: "bold", em: "italic", i: "italic", s: "strike", del: "strike", strike: "strike", u: "underline" };
function looks(value, defs = null) {
  const { spans, chars } = parseInline(value, { defs });
  return chars.map(c => {
    const f = { text: c.text, start: c.start, end: c.end, bold: false, italic: false, strike: false, underline: false, code: false, highlight: null, color: null, link: null, note: null, brk: false };
    for (const id of c.spans) {
      const sp = spans[id];
      if (sp.kind === "break") f.brk = sp.start === sp.from && /[\n\r]/.test(value[sp.from]) ? "soft" : "hard";
      else if (sp.kind === "strong") f.bold = true;
      else if (sp.kind === "em") f.italic = true;
      else if (sp.kind === "strike") f.strike = true;
      else if (sp.kind === "code") f.code = true;
      else if (sp.kind === "link" || sp.kind === "image") f.link = `${sp.kind} ${sp.url} ${sp.title}`;
      else if (sp.kind === "comment" || sp.kind === "highlight") f.note = `${sp.kind} ${sp.note}`;
      else if (sp.kind === "html" && sp.tag === "mark") f.highlight = sp.color ?? "default";
      else if (sp.kind === "html" && sp.tag === "span") f.color = sp.color;
      else if (sp.kind === "html" && TAG_FLAGS[sp.tag]) f[TAG_FLAGS[sp.tag]] = true;
    }
    return f;
  });
}
const describe = f => `${f.text}:${[...FLAGS.filter(k => f[k]), f.highlight && `h=${f.highlight}`, f.color && `k=${f.color}`, f.link, f.note].filter(Boolean).join("+")}`;
const shows = (value, defs) => looks(value, defs).map(describe).join(" ");

test("Enter inside a run closes it at the end of the first half and opens it again at the start of the second (B1, B2)", () => {
  assert.deepEqual(halves(splitRuns("Hello **big world** there", 11, 12)), ["Hello **big**", "**world** there"]);
  assert.deepEqual(halves(splitRuns("Hello **world** there", 10, 10)), ["Hello **wo**", "**rld** there"]);
  assert.deepEqual(halves(splitRuns("Big **bold title** here", 10, 11)), ["Big **bold**", "**title** here"]);
  assert.deepEqual(halves(splitRuns("an **item text** z", 9, 10)), ["an **item**", "**text** z"]);
  assert.deepEqual(halves(splitRuns("***a b***", 4, 5)), ["***a***", "***b***"], "nested runs each");
});

test("a colour, a highlight and an underline go on in both halves (B3)", () => {
  for (const [open, close] of [['<span style="color: red">', "</span>"], ["<mark>", "</mark>"], ["<u>", "</u>"]]) {
    const value = `Hello ${open}big world${close} there`, at = value.indexOf(" world");
    assert.deepEqual(halves(splitRuns(value, at, at + 1)), [`Hello ${open}big${close}`, `${open}world${close} there`], open);
  }
});

test("a link split in two: both halves link to the same address and title; a full reference to the same label (B4)", () => {
  assert.deepEqual(halves(splitRuns('See [the docs](https://e.com "T") now', 8, 9)), ['See [the](https://e.com "T")', '[docs](https://e.com "T") now']);
  assert.deepEqual(halves(splitRuns("See [the docs][d] now", 8, 9, { defs: DEFS })), ["See [the][d]", "[docs][d] now"]);
});

test("commented text: the first half keeps the comment, the second leaves it and keeps its other formatting (B5)", () => {
  const value = "See {==this **big text**==}{>>2026-11-16 20:51 | note<<} now", at = value.indexOf(" text");
  const [left, right] = halves(splitRuns(value, at, at + 1));
  assert.equal(left, "See {==this **big**==}{>>2026-11-16 20:51 | note<<}");
  assert.equal(shows(right), "t:bold e:bold x:bold t:bold  : n: o: w:");
});

test("inline code split in two: two code spans (B6)", () => {
  assert.deepEqual(halves(splitRuns("Run `npm test` now", 8, 9)), ["Run `npm`", "`test` now"]);
});

test("in a unit the split moves to its end, the unit whole in the first half (B7)", () => {
  const value = "Go https://example.com/path now", out = splitRuns(value, 13, 13);
  assert.deepEqual([out.value, out.start, out.end], [value, 27, 27]);
  const pic = "A ![big picture](p.png) b", inPic = splitRuns(pic, 7, 7);
  assert.deepEqual([inPic.start, inPic.end], [23, 23]);
  const bold = "**go https://e.com now**", inBold = splitRuns(bold, 9, 9);
  assert.deepEqual(halves(inBold).map(h => h.trim()), ["**go https://e.com**", "**now**"]);
});

test("nothing crosses the split: null", () => {
  assert.equal(splitRuns("Hello **world**", 6, 6), null);
  assert.equal(splitRuns("Hello world", 5, 6), null);
});

test("a join reads each half as it read alone; runs of the same formatting that meet are one (B10, B11)", () => {
  const b10 = joinRuns("Hello **big****world** there", 13);
  assert.deepEqual([b10.value, b10.at], ["Hello **bigworld** there", 11]);
  assert.equal(joinRuns("Hello *big**world* there", 11).value, "Hello *bigworld* there");
  assert.equal(joinRuns("Run `a``b` now", 7).value, "Run `ab` now");
  assert.equal(joinRuns("Big **title****more** text", 13).value, "Big **titlemore** text");
});

test("a delimiter that showed as a character still shows after a join (B12)", () => {
  const out = joinRuns("Use a *star* here", 7);
  assert.equal(shows(out.value), [..."Use a *star* here"].map(c => `${c}:`).join(" "));
  assert.equal(out.value.slice(0, out.at), "Use a \\*", "the join after the star, escaped");
});

test("a join that already reads as its halves did writes nothing; links that meet stay two", () => {
  assert.equal(joinRuns("**big**world", 7), null);
  assert.equal(joinRuns("[a](u)[b](u)", 6), null);
  assert.equal(joinRuns("Hello world", 6), null);
});

test("a copy is markdown that stands alone: every mark it holds opened and closed in it (B13)", () => {
  assert.equal(copyOf("Hello **world** there", { start: 0, end: 10 }), "Hello **wo**");
  assert.equal(copyOf("**world**", { start: 3, end: 6 }), "**orl**");
  assert.equal(copyOf("Run `npm test` now", { start: 7, end: 10 }), "`m t`");
  assert.equal(copyOf("Hello", { start: 2, end: 2 }), "", "a caret copies nothing");
});

test("a copy keeps soft and hard line breaks", () => {
  assert.equal(copyOf("Hello **wor\nld** there", { start: 9, end: 13 }), "**or\nl**");
  assert.equal(copyOf("Hello **wor\\\nld** there", { start: 9, end: 14 }), "**or\\\nl**");
  assert.equal(shows(copyOf("a *b\nc* d", { start: 0, end: 9 })), shows("a *b\nc* d"));
});

test("a copy of part of a link links to its address and title; a reference link is written inline", () => {
  assert.equal(copyOf('See [the docs](https://e.com "T") now', { start: 9, end: 12 }), '[doc](https://e.com "T")');
  assert.equal(copyOf("See [the docs][d] now", { start: 9, end: 12 }, { defs: DEFS }), '[doc](https://e.com "Docs")');
  assert.equal(copyOf("See [d] now", { start: 4, end: 7 }, { defs: DEFS }), '[d](https://e.com "Docs")');
});

test("a copy leaves comments out, keeps their text, and takes a picture whole", () => {
  assert.equal(copyOf("See {==this **text**==}{>>n<<} now", { start: 7, end: 16 }), "this **te**");
  assert.equal(copyOf("a{>>note<<} b", { start: 0, end: 13 }), "a b");
  assert.equal(copyOf("A ![big picture](p.png) b", { start: 5, end: 9 }), "![big picture](p.png)");
});

test("pasted text takes the formatting of where it lands, and keeps its own (B15)", () => {
  assert.equal(pasteInto("Hello **world** there", { start: 10, end: 10 }, "**b**").value, "Hello **wobrld** there");
  assert.equal(pasteInto("Hello **world** there", { start: 10, end: 10 }, "XY").value, "Hello **woXYrld** there");
  const it = pasteInto("Hello **world** there", { start: 10, end: 10 }, "*it*");
  assert.deepEqual(looks(it.value).slice(6, 11).map(describe), ["w:bold", "o:bold", "i:bold+italic", "t:bold+italic", "r:bold"]);
  const edge = pasteInto("Hello **world** there", { start: 15, end: 15 }, "XY");
  assert.equal(edge.value, "Hello **world**XY there", "plain at a run's edge");
});

test("a mark the clipboard does not pair is pasted as the character it shows, and pairs with nothing in the block (B16)", () => {
  const out = pasteInto("Hello  there 2**3 is 8", { start: 6, end: 6 }, "**wo");
  assert.equal(looks(out.value).map(c => c.text).join(""), "Hello **wo there 2**3 is 8");
  assert.ok(looks(out.value).every(c => !c.bold && !c.italic), out.value);
  assert.equal(out.value.slice(0, out.caret), "Hello \\*\\*wo");
});

test("over a selection pasted text takes the first selected character's formatting; a link pasted in a link gives way", () => {
  assert.equal(pasteInto("Hello **world** there", { start: 6, end: 15 }, "abc").value, "Hello **abc** there");
  assert.equal(pasteInto("See [docs](u) now", { start: 7, end: 7 }, "[x](v)").value, "See [doxcs](u) now");
  assert.equal(pasteInto("See {==this==}{>>n<<} now", { start: 9, end: 9 }, "{==x==}{>>m<<}").value, "See {==thxis==}{>>n<<} now");
});

test("paragraphs pasted in a bold word: the first ends the first half, the last starts the second, each half keeping its bold (B17)", () => {
  const out = pasteParagraphs("Hello **big world** there", { start: 12, end: 12 }, "one\n\ntwo");
  assert.equal(out.value, "Hello **big one**\n\n**twoworld** there");
  assert.equal(out.value.slice(out.caret), "world** there", "the caret after the last pasted paragraph");
  assert.equal(pasteParagraphs("ab", { start: 1, end: 1 }, "x\n\n**y\n\nz").value, "ax\n\n**y\n\nzb", "the paragraphs between as the clipboard writes them");
  assert.equal(pasteParagraphs("ab", { start: 1, end: 1 }, "x\ny"), null, "one paragraph: nothing to split");
});

test("pasted lines that make blocks go between the halves as the clipboard writes them; the second half goes on after text, else stands apart", () => {
  const value = "Hello **big world** there", at = { start: 12, end: 12 };
  const list = pasteParagraphs(value, at, "Intro\n\n* a\n* b");
  assert.equal(list.value, "Hello **big Intro**\n\n* a\n* b**world** there");
  assert.equal(list.value.slice(0, list.caret), "Hello **big Intro**\n\n* a\n* b", "the caret after the last pasted line");
  assert.equal(pasteParagraphs(value, at, "Intro\n* a\n* b").value, "Hello **big Intro**\n* a\n* b**world** there", "with no blank line before them");
  assert.equal(pasteParagraphs(value, at, "Intro\n\n***").value, "Hello **big Intro**\n\n***\n\n**world** there");
  assert.equal(pasteParagraphs(value, at, "Intro\n\n~~~\na*b*c\n~~~").value, "Hello **big Intro**\n\n~~~\na*b*c\n~~~\n\n**world** there");
  const fence = "Intro\n\n```\na*b\n\nc\n```";
  assert.equal(pasteParagraphs("Hello ", { start: 6, end: 6 }, fence).value, `Hello ${fence}`, "a fence with a blank line in it closes");
  assert.equal(pasteParagraphs(value, at, `${fence}\nOutro`).value, "Hello **big Intro**\n\n```\na*b\n\nc\n```\n**Outroworld** there", "a last paragraph joins the second half");
});

test("paragraphs pasted inside a web address: the first goes where typed text goes, the split moves after the address", () => {
  const bare = pasteParagraphs("Go https://example.com/path now", { start: 14, end: 14 }, "one\n\ntwo");
  assert.doesNotMatch(bare.value, STAND_INS);
  assert.equal(bare.value, "Go https://exaonemple.com/path\n\ntwo now");
  const auto = pasteParagraphs("Go <https://example.com> now", { start: 14, end: 14 }, "* a\n* b");
  assert.doesNotMatch(auto.value, STAND_INS);
  assert.equal(auto.value, "Go <https://example.com>\n\n* a\n* b now");
});

test("the typing style formats what is pasted at its caret", () => {
  const bold = { bits: 1, mark: null, color: null };
  assert.equal(pasteInto("Hello ", { start: 6, end: 6 }, "word", { style: bold }).value, "Hello **word**");
});

test("text copied from the editor and pasted shows exactly as it did where it was copied", () => {
  const from = 'A **bold [link](https://e.com "T")** and `code` here', copy = copyOf(from, { start: 4, end: 47 });
  const out = pasteInto("Plain  text", { start: 6, end: 6 }, copy), pasted = looks(copy).map(describe);
  assert.deepEqual(looks(from).slice(2, 2 + pasted.length).map(describe), pasted, "the copy shows what was selected");
  assert.deepEqual(looks(out.value).slice(6, 6 + pasted.length).map(describe), pasted);
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
const pickFrom = rand => list => list[Math.floor(rand() * list.length)];

const WORDS = ["alpha", "be", "c", "delta", "e2", "fox", "gé", "x"];
const WRAPS = [
  w => `**${w}**`, w => `*${w}*`, w => `~~${w}~~`, w => `<u>${w}</u>`, w => `<mark>${w}</mark>`, w => `__${w}__`,
  w => `<span style="color: red">${w}</span>`, w => `<span style="color: teal">${w}</span>`, w => `***${w}***`, w => `\`${w}\``,
];
const CODE_WRAP = WRAPS.length - 1;
// A link's text holds no link: markdown has no links in links.
function fragment(rand, depth = 0, linked = false) {
  const pick = pickFrom(rand), r = rand();
  if (r < 0.3 || depth > 1) return pick(WORDS);
  if (r < 0.6) {
    const wrap = pick(WRAPS);
    return wrap(wrap === WRAPS[CODE_WRAP] ? `${pick(WORDS)} ${pick(WORDS)}` : phrase(rand, depth + 1, 2, linked));
  }
  if (r < 0.66 && !linked) return `[${phrase(rand, depth + 1, 2, true)}](http://x.org/${pick(WORDS)}${rand() < 0.3 ? ' "T"' : ""})`;
  if (r < 0.7 && !linked) return rand() < 0.5 ? `[${phrase(rand, depth + 1, 2, true)}][d]` : "[d]";
  if (r < 0.76) return `{==${phrase(rand, depth + 1, 2, linked)}==}{>>${pick(WORDS)}<<}`;
  if (r < 0.79) return `![${phrase(rand, 2, 2, true)}](p.png)`;
  if (r < 0.81 && !linked) return pick(["https://e.org/a", "<https://e.org/b>"]);
  if (r < 0.87) return pick(["\\*", "\\_", "&amp;", "{>>p<<}", "*", "_"]);
  if (r < 0.92) return `${pick(WORDS)}${pick(["\\\n", "\n"])}${pick(WORDS)}`;
  return pick(WORDS) + pick(WORDS);
}
function phrase(rand, depth, most, linked = false) {
  const n = 1 + Math.floor(rand() * most), parts = [];
  for (let i = 0; i < n; i++) parts.push(fragment(rand, depth, linked));
  return parts.join(rand() < 0.8 ? " " : "");
}

const isSpace = text => /^\s+$/u.test(text);
// Bold, italic and a colour draw nothing on a space.
const sameLook = (a, b) => {
  if (!a || !b) return false;
  const space = isSpace(a.text), flags = space ? ["strike", "underline", "code"] : FLAGS;
  if (a.brk || b.brk) return a.brk === b.brk && a.link === b.link && a.note === b.note;
  return a.text === b.text && flags.every(k => a[k] === b[k]) && a.highlight === b.highlight && (space || a.color === b.color) && a.link === b.link && a.note === b.note;
};
// Spaces that open a line after a line break can't show.
const showable = list => list.filter((c, i) => !(isSpace(c.text) && !c.brk && list.slice(0, i).findLast(x => !isSpace(x.text) || x.brk)?.brk));
function assertLooks(label, got, want) {
  const g = showable(got), w = showable(want);
  assert.equal(g.map(c => c.text).join(""), w.map(c => c.text).join(""), `${label}: what shows`);
  g.forEach((c, i) => assert.ok(sameLook(c, w[i]), `${label}: ${describe(c)}, wanted ${describe(w[i])}`));
}
const pointsOf = (value, defs) => parseInline(value, { defs }).spans.filter(sp => sp.kind === "point").map(sp => sp.note);
const spansOf = (value, defs) => parseInline(value, { defs }).spans;

function unitAround(value, x) {
  const m = modelOf(value, DEFS);
  return m.spans.find(sp => m.roles[sp.id] === UNIT && sp.start < x && x < sp.end) ?? null;
}

test("random values split at random carets: each half alone shows what it showed", () => {
  const CASES = 2500, counts = { splits: 0, crossed: 0, unwritable: 0 };
  for (let k = 0; k < CASES; k++) {
    const seed = 70_000 + k, rand = random(seed), v = phrase(rand, 0, 6), before = looks(v, DEFS);
    const edges = [...new Set(before.flatMap(c => [c.start, c.end]))], c = edges[Math.floor(rand() * edges.length)] ?? 0;
    let a = c, b = c;
    while (a > 0 && " \t".includes(v[a - 1])) a--;
    while (b < v.length && " \t".includes(v[b])) b++;
    const label = `seed ${seed}: ${JSON.stringify(v)} split [${a}, ${b})`, out = splitRuns(v, a, b, { defs: DEFS });
    counts.splits++;
    const ua = unitAround(v, a), am = ua ? ua.end : a, bm = Math.max(am, unitAround(v, b)?.end ?? b);
    const crossing = spansOf(v, DEFS).filter(sp => sp.start < am && bm < sp.end && sp.kind !== "break" && sp.kind !== "point");
    if (!out) {
      if (crossing.length) counts.unwritable++;
      continue;
    }
    if (crossing.length) counts.crossed++;
    const left = out.value.slice(0, out.start), right = out.value.slice(out.end);
    if (!crossing.length) assert.deepEqual([out.value, out.start, out.end], [v, am, bm], `${label}: the split moved past the unit`);
    const leftOf = sp => before.some(x => x.start >= sp.from && x.end <= Math.min(sp.to, am));
    const leaves = crossing.filter(sp => sp.kind === "comment" && leftOf(sp)), leaving = x => leaves.some(sp => x.start >= sp.from && x.end <= sp.to);
    assertLooks(`${label} left ${JSON.stringify(left)}`, looks(left, DEFS), before.filter(x => x.end <= am));
    assertLooks(`${label} right ${JSON.stringify(right)}`, looks(right, DEFS), before.filter(x => x.start >= bm).map(x => (leaving(x) ? { ...x, note: null } : x)));
    const points = parseInline(v, { defs: DEFS }).spans.filter(sp => sp.kind === "point");
    assert.deepEqual([pointsOf(left, DEFS), pointsOf(right, DEFS)], [points.filter(sp => sp.end <= am).map(sp => sp.note), points.filter(sp => sp.start >= bm).map(sp => sp.note)], `${label}: point comments`);
  }
  assert.ok(counts.crossed > CASES / 5, JSON.stringify(counts));
  assert.ok(counts.unwritable <= counts.crossed / 100, `few splits are left as they were: ${JSON.stringify(counts)}`);
});

// The kinds of span that give each formatting, for runs that must be one after a join.
const RUN_KINDS = {
  bold: sp => sp.kind === "strong" || (sp.kind === "html" && (sp.tag === "strong" || sp.tag === "b")),
  italic: sp => sp.kind === "em" || (sp.kind === "html" && (sp.tag === "em" || sp.tag === "i")),
  strike: sp => sp.kind === "strike" || (sp.kind === "html" && ["s", "del", "strike"].includes(sp.tag)),
  code: sp => sp.kind === "code",
  underline: sp => sp.kind === "html" && sp.tag === "u",
};

test("random pairs of values joined: every character of each shows as it did, and runs of one formatting that meet are one", () => {
  const CASES = 2500, counts = { joins: 0, written: 0, unwritable: 0 };
  for (let k = 0; k < CASES; k++) {
    const seed = 80_000 + k, rand = random(seed), x = phrase(rand, 0, 4), y = phrase(rand, 0, 4), joined = x + y;
    const label = `seed ${seed}: ${JSON.stringify(x)} + ${JSON.stringify(y)}`, out = joinRuns(joined, x.length, { defs: DEFS });
    const want = [...looks(x, DEFS), ...looks(y, DEFS)], value = out?.value ?? joined;
    counts.joins++;
    if (out) counts.written++;
    const got = looks(value, DEFS);
    if (!out && !(got.length === want.length && got.every((c, i) => sameLook(c, want[i])))) {
      counts.unwritable++;
      continue;
    }
    assertLooks(`${label} -> ${JSON.stringify(value)}`, got, want);
    assert.deepEqual(pointsOf(value, DEFS), [...pointsOf(x, DEFS), ...pointsOf(y, DEFS)], `${label}: point comments`);
    const n = looks(x, DEFS).length;
    if (out) assert.equal(got.filter(c => c.end <= out.at).length, n, `${label}: the join at ${out.at} of ${JSON.stringify(value)}`);
    const l = got[n - 1], r = got[n];
    if (!l || !r || l.brk || r.brk || isSpace(l.text) || isSpace(r.text) || l.link || r.link || l.note || r.note || !sameLook(l, { ...r, text: l.text })) continue;
    const spans = spansOf(value, DEFS);
    for (const [flag, kind] of Object.entries(RUN_KINDS)) {
      if (!l[flag]) continue;
      assert.ok(spans.some(sp => kind(sp) && sp.from <= l.start && r.end <= sp.to), `${label}: one ${flag} run over the join: ${JSON.stringify(value)}`);
    }
  }
  assert.ok(counts.written > CASES / 10, JSON.stringify(counts));
  assert.ok(counts.unwritable <= counts.joins / 100, `few joins are left unwritten: ${JSON.stringify(counts)}`);
});

test("random selections copied: the copy alone shows exactly the selected characters with their formatting, comments left out", () => {
  const CASES = 2500, counts = { copies: 0, plain: 0, softBreaks: 0 };
  for (let k = 0; k < CASES; k++) {
    const seed = 90_000 + k, rand = random(seed), v = phrase(rand, 0, 6), p = Math.floor(rand() * (v.length + 1)), q = Math.floor(rand() * (v.length + 1));
    const range = { start: Math.min(p, q), end: Math.max(p, q) }, copy = copyOf(v, range, { defs: DEFS });
    const label = `seed ${seed}: ${JSON.stringify(v)} [${range.start}, ${range.end}) -> ${JSON.stringify(copy)}`;
    if (range.start === range.end) { assert.equal(copy, "", label); continue; }
    counts.copies++;
    const { a, b } = modelOf(v, DEFS).select(range.start, range.end);
    const want = looks(v, DEFS).filter(c => c.start >= a && c.end <= b).map(c => (c.note?.startsWith("comment") ? { ...c, note: null } : c));
    const got = looks(copy);
    if (want.some(c => c.brk === "soft")) counts.softBreaks++;
    if (got.length !== want.length || !got.every((c, i) => sameLook(c, want[i]))) {
      counts.plain++;
      assert.equal(got.map(c => c.text).join(""), want.map(c => c.text).join(""), `${label}: what can't be written with its formatting is copied as the text that shows`);
      continue;
    }
    assert.deepEqual(pointsOf(copy), [], `${label}: no point comments`);
  }
  assert.ok(counts.plain <= counts.copies / 100, `few copies lose their formatting: ${JSON.stringify(counts)}`);
  assert.ok(counts.softBreaks > counts.copies / 40, `copies across soft line breaks: ${JSON.stringify(counts)}`);
});

const STYLES = [{ bits: MARK_BITS.bold, mark: null, color: null }, { bits: MARK_BITS.italic, mark: null, color: null }, { bits: MARK_BITS.code, mark: null, color: null }, { bits: 0, mark: "", color: "red" }];
const UNPAIRED = ["**wo", "*x", "`y", "[z", "a_b", "~~s", "x**", "<u>t"];
const STAND_IN = String.fromCharCode(0xe000), STAND_INS = /[]/u;
// What a paste over `edit` of `value` should show: what typed text there gets (mend.js, through a stand-in typed in its
// place), with the clipboard's own formatting over it; a clipboard link inside a link, or comment inside a comment,
// giving way to the one around it.
function pastedLooks(value, edit, clip, style) {
  const placed = mend(value, { ...edit, inserted: STAND_IN }, { defs: DEFS, style }).value, around = looks(placed, DEFS), i = around.findIndex(c => c.text === STAND_IN), at = around[i];
  const merged = looks(clip, DEFS).map(c => ({
    ...c, bold: at.bold || c.bold, italic: at.italic || c.italic, strike: at.strike || c.strike, underline: at.underline || c.underline, code: at.code || c.code,
    highlight: c.highlight ?? at.highlight, color: c.color ?? at.color,
    link: at.link && !(c.link?.startsWith("image") && !at.link.startsWith("image")) ? at.link : c.link, note: at.note ?? c.note,
  }));
  return { want: [...around.slice(0, i), ...merged, ...around.slice(i + 1)], placed, inComment: Boolean(at.note), inAddress: Boolean(at.link?.includes(STAND_IN)) };
}

test("random clipboards pasted at random carets and over random selections: read alone, with what typed text gets there", () => {
  const CASES = 2500, counts = { pastes: 0, unwritable: 0 };
  for (let k = 0; k < CASES; k++) {
    const seed = 100_000 + k, rand = random(seed), pick = pickFrom(rand), v = phrase(rand, 0, 5), r = rand();
    const clip = r < 0.25 ? pick(UNPAIRED) : r < 0.45 ? copyOf(phrase(rand, 0, 4), { start: 0, end: 12 }, { defs: DEFS }) : r < 0.5 ? `${pick(WORDS)}\n${pick(WORDS)}` : phrase(rand, 0, 3);
    if (!clip) continue;
    const edges = [...new Set(looks(v, DEFS).flatMap(c => [c.start, c.end]))], at = edges[Math.floor(rand() * edges.length)] ?? 0;
    const to = rand() < 0.3 ? edges[Math.floor(rand() * edges.length)] ?? at : at, range = { start: Math.min(at, to), end: Math.max(at, to) };
    const style = range.start === range.end && rand() < 0.25 ? pick(STYLES) : null;
    const label = `seed ${seed}: ${JSON.stringify(v)} [${range.start}, ${range.end}) + ${JSON.stringify(clip)}${style ? ` style ${JSON.stringify(style)}` : ""}`;
    const { want, placed, inComment, inAddress } = pastedLooks(v, { at: range.start, removed: range.end - range.start }, clip, style);
    // Pasted into an autolink or a bare address, the text is its address, which the paste changes.
    if (inAddress) continue;
    const blocks = pasteParagraphs(v, range, `${clip}\n\n${clip}`, { defs: DEFS, style });
    if (blocks) assert.doesNotMatch(blocks.value, STAND_INS, `${label} in paragraphs: no stand-in left`);
    const out = pasteInto(v, range, clip, { defs: DEFS, style });
    counts.pastes++;
    if (!out) { counts.unwritable++; continue; }
    assertLooks(`${label} -> ${JSON.stringify(out.value)}`, looks(out.value, DEFS), want);
    const p = placed.indexOf(STAND_IN), around = spansOf(placed, DEFS).filter(sp => sp.kind === "point");
    const points = [...around.filter(sp => sp.start < p).map(sp => sp.note), ...(inComment ? [] : pointsOf(clip, DEFS)), ...around.filter(sp => sp.start > p).map(sp => sp.note)];
    assert.deepEqual(pointsOf(out.value, DEFS), points, `${label}: point comments in ${JSON.stringify(out.value)}`);
  }
  // Left unwritten: a bare address at the clipboard's end that the block's text would run on, code over a picture or an
  // address, a line break in code.
  assert.ok(counts.unwritable <= counts.pastes / 50, `few pastes are left unwritten: ${JSON.stringify(counts)}`);
});
