import test from "node:test";
import assert from "node:assert/strict";
import { editOf, formatAt, mend } from "../mods/potion/mend.js";
import { MARK_BITS } from "../mods/potion/restyle.js";
import { parseInline } from "../mods/potion/inline.js";
import { richOf, tokensFor } from "../mods/potion/tokens.js";
import { parse } from "../mods/potion/blocks.js";

const DEFS = parse("x\n\n[r]: http://r.org/ref\n").defs;
const BOLD = { bits: MARK_BITS.bold, mark: null, color: null }, PLAIN = { bits: 0, mark: null, color: null };
const segments = new Intl.Segmenter();
const graphemes = s => [...segments.segment(s)].map(g => g.segment);

// Herdr's field over a value: its tokens with the letters at the caret split, as the editor sets them.
const layout = (value, sel, defs = null) => tokensFor(richOf(value, parseInline(value, { defs })), sel);

// The edits Herdr's keys make at field caret `caret` (snapped as the editor snaps it): the range they remove and what
// they type, with the caret the editor knew before the key.
function backspace(value, caret, defs) {
  const { tokens, sel } = layout(value, { start: caret, end: caret }, defs), c = sel.start;
  const t = tokens.find(x => x.range.start < c && c <= x.range.end);
  const from = t ? t.range.start : c - graphemes(value.slice(0, c)).at(-1).length;
  return { edit: { at: from, removed: c - from, inserted: "" }, known: { start: c, end: c } };
}
function del(value, caret, defs) {
  const { tokens, sel } = layout(value, { start: caret, end: caret }, defs), c = sel.start;
  const t = tokens.find(x => x.range.start <= c && c < x.range.end);
  const to = t ? t.range.end : c + graphemes(value.slice(c))[0].length;
  return { edit: { at: c, removed: to - c, inserted: "" }, known: { start: c, end: c } };
}
function typeAt(value, caret, text, defs) {
  const c = layout(value, { start: caret, end: caret }, defs).sel.start;
  return { edit: { at: c, removed: 0, inserted: text }, known: { start: c, end: c } };
}
function overSelection(value, start, end, text, defs) {
  const { sel } = layout(value, { start, end }, defs);
  return { edit: { at: sel.start, removed: sel.end - sel.start, inserted: text }, known: sel };
}
const apply = (value, e) => value.slice(0, e.at) + e.inserted + value.slice(e.at + e.removed);
const run = (value, { edit }, opts = {}) => mend(value, edit, { defs: opts.defs ?? null, style: opts.style ?? null });
const withCaret = out => out.value.slice(0, out.caret) + "|" + out.value.slice(out.caret);

// What each character that shows has: bold, italic, strike, underline, code, its highlight and colour, the link and the
// comment it lies in, and whether it is a line break.
const FLAGS = ["bold", "italic", "strike", "underline", "code"];
const TAG_FLAGS = { strong: "bold", b: "bold", em: "italic", i: "italic", s: "strike", del: "strike", strike: "strike", u: "underline" };
function looks(value, defs = null) {
  const { spans, chars } = parseInline(value, { defs });
  return chars.map(c => {
    const f = { text: c.text, start: c.start, end: c.end, bold: false, italic: false, strike: false, underline: false, code: false, highlight: null, color: null, link: null, note: null, brk: false };
    for (const id of c.spans) {
      const sp = spans[id];
      if (sp.kind === "strong") f.bold = true;
      else if (sp.kind === "em") f.italic = true;
      else if (sp.kind === "strike") f.strike = true;
      else if (sp.kind === "code") f.code = true;
      else if (sp.kind === "link" || sp.kind === "image") f.link = `${sp.kind} ${sp.url} ${sp.title}`;
      else if (sp.kind === "comment" || sp.kind === "highlight") f.note = `${sp.kind} ${sp.note}`;
      else if (sp.kind === "break") f.brk = sp.start === sp.from && /[\n\r]/.test(value[sp.from]) ? "soft" : "hard";
      else if (sp.kind === "html" && sp.tag === "mark") f.highlight = sp.color ?? "default";
      else if (sp.kind === "html" && sp.tag === "span") f.color = sp.color;
      else if (sp.kind === "html" && TAG_FLAGS[sp.tag]) f[TAG_FLAGS[sp.tag]] = true;
    }
    return f;
  });
}
const shownText = (value, defs) => looks(value, defs).map(c => c.text).join("");
const describe = f => `${JSON.stringify(f.text)}:${[...FLAGS.filter(k => f[k]), f.highlight && `h=${f.highlight}`, f.color && `k=${f.color}`, f.link, f.note].filter(Boolean).join("+")}`;
// The characters that show from the `from`-th to before the `to`-th, described.
const shownLooks = (value, from, to, defs) => looks(value, defs).slice(from, to).map(describe).join(" ");

test("Backspace and Delete at a run's edge keep its marks, the caret outside them (A1-A4, A11)", () => {
  const v = "Hello **world** there";
  const a1 = run(v, backspace(v, 15));
  assert.equal(withCaret(a1), "Hello **worl**| there");
  assert.equal(withCaret(run(v, del(v, 6))), "Hello |**orld** there");
  assert.equal(withCaret(run(v, backspace(v, 9))), "Hello |**orld** there");
  assert.equal(withCaret(run(v, del(v, 12))), "Hello **worl**| there");
  assert.equal(withCaret(run("A ***bi***", backspace("A ***bi***", 10))), "A ***b***|");
});

test("a run whose only letter goes loses its marks; one left ending on a space closes on its letter (A5, A6)", () => {
  const once = run("Hello **ab**", backspace("Hello **ab**", 12));
  assert.equal(withCaret(once), "Hello **a**|");
  const twice = run(once.value, backspace(once.value, once.caret));
  assert.equal(withCaret(twice), "Hello |");
  const big = "Hello **big w** there", out = run(big, backspace(big, 15));
  assert.equal(withCaret(out), "Hello **big** | there");
});

test("deletions across runs keep what is left formatted as it was (A7, A9, A10)", () => {
  const v = "Hello **world**";
  assert.equal(withCaret(run(v, overSelection(v, 3, 10, ""))), "Hel|**rld**");
  const w = "Hello **world** there";
  assert.equal(withCaret(run(w, overSelection(w, 10, 18, ""))), "Hello **wo**|ere");
  const two = "A **one** and *two* z", out = run(two, overSelection(two, 5, 16, ""));
  assert.equal(shownText(out.value), "A owo z");
  assert.equal(shownLooks(out.value, 2, 5), '"o":bold "w":italic "o":italic');
});

test("a link, a comment and a picture keep their marks while a letter of theirs shows, and go with the last (A12-A14)", () => {
  const link = "See [docs](https://e.com) now";
  assert.equal(run(link, backspace(link, 25)).value, "See [doc](https://e.com) now");
  const one = "See [d](https://e.com) now";
  assert.equal(withCaret(run(one, backspace(one, 22))), "See | now", "every letter gone: the link goes, address and all");
  const note = "See {==this==}{>>2026-11-16 20:51 | note<<} now";
  assert.equal(run(note, backspace(note, 43)).value, "See {==thi==}{>>2026-11-16 20:51 | note<<} now");
  const gone = "See {==t==}{>>n<<} now";
  assert.equal(run(gone, backspace(gone, 18)).value, "See  now", "a comment whose text all went goes with its note");
  const pic = "See ![ab](p.png) here";
  assert.equal(run(pic, backspace(pic, 7)).value, "See ![b](p.png) here");
});

test("a hard break keeps its backslash while its line break is there (A15)", () => {
  const v = "ab\\\ncd";
  assert.equal(run(v, backspace(v, 2)).value, "a\\\ncd");
});

test("typing over a selection takes the formatting of its first letter; a clicked link keeps its address (A8, A20)", () => {
  const v = "Hello **world**";
  assert.equal(withCaret(run(v, overSelection(v, 3, 10, "X"))), "HelX|**rld**");
  const w = "Hello **world** there";
  const bold = run(w, overSelection(w, 6, 15, "X"));
  assert.equal(bold.value, "Hello **X** there");
  const link = "See [docs](https://e.com) now";
  assert.equal(run(link, overSelection(link, 4, 25, "X")).value, "See [X](https://e.com) now");
  const out = run(w, overSelection(w, 10, 18, "X"));
  assert.equal(shownText(out.value), "Hello woXere");
  assert.equal(shownLooks(out.value, 7, 9), '"o":bold "X":bold');
  const bracket = run("See [docs](u) now", overSelection("See [docs](u) now", 4, 7, "["));
  assert.equal(bracket.value, "See [\\[cs](u) now", "a [ typed over the link's own [ is its text, not its mark");
});

test("typing at a caret reads as markdown where it goes; what would show hidden marks is written so it shows as typed (A16-A18)", () => {
  const link = "See [docs](u)";
  const a16 = run(link, typeAt(link, 7, "]"));
  assert.equal(shownText(a16.value), "See do]cs");
  assert.equal(shownLooks(a16.value, 4, 9), ['"d"', '"o"', '"]"', '"c"', '"s"'].map(t => `${t}:link u null`).join(" "));
  const quoted = 'x **"q"**', a17 = run(quoted, typeAt(quoted, 9, "y"));
  assert.equal(shownText(a17.value), 'x "q"y');
  assert.equal(shownLooks(a17.value, 2, 6), '"\\"":bold "q":bold "\\"":bold "y":');
  const tick = "Hello **wo`rld** ", a18 = run(tick, typeAt(tick, 17, "`"));
  assert.equal(shownText(a18.value), "Hello wo`rld `");
  assert.equal(shownLooks(a18.value, 6, 14), [..."wo`rld"].map(c => `${JSON.stringify(c)}:bold`).join(" ") + ' " ": "`":');
  assert.match(a18.value, /\\`$/, "the typed backtick written escaped");
  const plain = "Hello ", shortcut = run("Hello **bold*", typeAt("Hello **bold*", 13, "*"));
  assert.equal(shortcut.value, "Hello **bold**", "a typed mark that closes a shortcut is kept");
  assert.equal(run(plain, typeAt(plain, 6, "w")).value, "Hello w", "plain typing is the field's own");
});

test("a typing style formats what is typed and keeps it one run (A19); after a deletion it is the first deleted letter's (A5)", () => {
  const w = run("Hello ", typeAt("Hello ", 6, "w"), { style: BOLD });
  assert.equal(w.value, "Hello **w**");
  assert.deepEqual(w.style, BOLD);
  const o = run(w.value, typeAt(w.value, w.caret, "o"), { style: w.style });
  assert.equal(o.value, "Hello **wo**");
  const space = run(o.value, typeAt(o.value, o.caret, " "), { style: o.style });
  const r = run(space.value, typeAt(space.value, space.caret, "r"), { style: space.style });
  assert.equal(r.value, "Hello **wo r**", "a space typed with it stays inside when letters follow");
  const off = run(r.value, typeAt(r.value, r.value.length, "s"), { style: PLAIN });
  assert.equal(off.value, "Hello **wo r**s");
  const bs = run("Hello **world**", backspace("Hello **world**", 15));
  assert.deepEqual(bs.style, BOLD);
  assert.equal(run(bs.value, typeAt(bs.value, bs.caret, "d"), { style: bs.style }).value, "Hello **world**");
  const a5 = run("Hello **a**", backspace("Hello **a**", 11));
  assert.equal(run(a5.value, typeAt(a5.value, a5.caret, "x"), { style: a5.style }).value, "Hello **x**");
});

test("the edit as the key made it: Backspace ends at the caret, Delete starts there, a selection is its range", () => {
  assert.deepEqual(editOf("**ab**b", "**ab", { start: 6, end: 6, valid: true }), { at: 3, removed: 3, inserted: "" });
  assert.deepEqual(editOf("**ab**b", "**ab", { start: 4, end: 4, valid: true }), { at: 4, removed: 3, inserted: "" });
  assert.deepEqual(editOf("Hello world", "Hello orld", { start: 6, end: 6, valid: true }), { at: 6, removed: 1, inserted: "" });
  assert.deepEqual(editOf("aa", "aaa", { start: 1, end: 1, valid: true }), { at: 1, removed: 0, inserted: "a" });
  assert.deepEqual(editOf("abab", "aXb", { start: 1, end: 3, valid: true }), { at: 1, removed: 2, inserted: "X" });
  assert.deepEqual(editOf("abc", "abXc", { start: 0, end: 0, valid: false }), { at: 2, removed: 0, inserted: "X" }, "no caret known: the diff");
  const caret = { start: 3, end: 3, valid: true };
  assert.deepEqual(editOf("Hello", "Helo", caret, 3), { at: 3, removed: 1, inserted: "" }, "between equal letters, a caret that stayed: Delete");
  assert.deepEqual(editOf("Hello", "Helo", caret, 2), { at: 2, removed: 1, inserted: "" }, "a caret that went back: Backspace");
  assert.deepEqual(editOf("Hello", "Helo", caret), { at: 2, removed: 1, inserted: "" }, "the caret after it unknown: Backspace");
});

test("the formatting typed text gets at a caret: the runs around it, never one it stands at the edge of", () => {
  assert.deepEqual(formatAt("**a b**", 3), BOLD);
  assert.deepEqual(formatAt("**ab** c", 6), PLAIN);
  assert.deepEqual(formatAt("x <u>a *b* c</u>", 11), { bits: MARK_BITS.underline, mark: null, color: null });
  assert.deepEqual(formatAt('<mark>a </mark>', 8), { bits: 0, mark: "", color: null });
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
  w => `**${w}**`, w => `*${w}*`, w => `~~${w}~~`, w => `<u>${w}</u>`, w => `<mark>${w}</mark>`, w => `__${w}__`,
  w => `<span style="color: red">${w}</span>`, w => `<span style="color: teal">${w}</span>`, w => `***${w}***`, w => `\`${w}\``,
];
const CODE_WRAP = WRAPS.length - 1;
// A link's text holds no link: markdown has no links in links.
function fragment(rand, depth = 0, linked = false) {
  const pick = list => list[Math.floor(rand() * list.length)];
  const r = rand();
  if (r < 0.3 || depth > 1) return pick(WORDS);
  if (r < 0.6) {
    const wrap = pick(WRAPS);
    return wrap(wrap === WRAPS[CODE_WRAP] ? pick(WORDS) : phrase(rand, depth + 1, 2, linked));
  }
  if (r < 0.66 && !linked) return `[${phrase(rand, depth + 1, 2, true)}](http://x.org/${pick(WORDS)}${rand() < 0.3 ? ' "T"' : ""})`;
  if (r < 0.7 && !linked) return rand() < 0.5 ? `[${phrase(rand, depth + 1, 2, true)}][r]` : "[r]";
  if (r < 0.76) return `{==${phrase(rand, depth + 1, 2, linked)}==}{>>${pick(WORDS)}<<}`;
  if (r < 0.8) return `![${phrase(rand, 2, 2, true)}](p.png)`;
  if (r < 0.87) return pick(["\\*", "\\_", "&amp;", "{>>p<<}"]);
  if (r < 0.92) return `${pick(WORDS)}\\\n${pick(WORDS)}`;
  return pick(WORDS) + pick(WORDS);
}
function phrase(rand, depth, most, linked = false) {
  const n = 1 + Math.floor(rand() * most), parts = [];
  for (let i = 0; i < n; i++) parts.push(fragment(rand, depth, linked));
  return parts.join(rand() < 0.8 ? " " : "");
}

const TYPED = ["y", "y", "y", " ", "*", "_", "`", "[", "]", "<"];
const STYLES = [BOLD, { bits: MARK_BITS.italic, mark: null, color: null }, { bits: MARK_BITS.underline | MARK_BITS.strike, mark: null, color: null },
  { bits: MARK_BITS.code, mark: null, color: null }, { bits: 0, mark: "", color: "red" }, PLAIN];

// Option+Backspace: back over what follows a word, then over the word, by the raw text.
function wordBack(value, caret, defs) {
  const c = layout(value, { start: caret, end: caret }, defs).sel.start;
  const m = /[\p{L}\p{N}_]+[^\p{L}\p{N}_\n]*$/u.exec(value.slice(0, c));
  const from = m ? m.index : Math.max(0, c - graphemes(value.slice(0, c)).at(-1).length);
  return { edit: { at: from, removed: c - from, inserted: "" }, known: { start: c, end: c } };
}

// An edit as one of Herdr's keys makes it on `value`, or null when the key does nothing there.
function randomEdit(rand, value, defs) {
  const pick = list => list[Math.floor(rand() * list.length)], n = value.length, at = Math.floor(rand() * (n + 1)), r = rand();
  if (r < 0.25) return at > 0 && layout(value, { start: at, end: at }, defs).sel.start > 0 ? { key: "backspace", ...backspace(value, at, defs) } : null;
  if (r < 0.4) return layout(value, { start: at, end: at }, defs).sel.start < n ? { key: "delete", ...del(value, at, defs) } : null;
  if (r < 0.48) return at > 0 && layout(value, { start: at, end: at }, defs).sel.start > 0 ? { key: "word", ...wordBack(value, at, defs) } : null;
  if (r < 0.7) {
    const to = Math.floor(rand() * (n + 1)), e = overSelection(value, Math.min(at, to), Math.max(at, to), rand() < 0.5 ? "" : pick(TYPED), defs);
    return e.edit.removed ? { key: e.edit.inserted ? "over" : "cut", ...e } : null;
  }
  return { key: "type", ...typeAt(value, at, pick(TYPED), defs), style: rand() < 0.4 ? pick(STYLES) : null };
}

const isSpace = text => /^\s+$/u.test(text);
const sameLook = (a, b) => {
  const space = isSpace(a.text), flags = space ? ["strike", "underline", "code"] : FLAGS;
  if (a.brk || b.brk) return a.brk === b.brk && a.link === b.link && a.note === b.note;
  return flags.every(k => a[k] === b[k]) && a.highlight === b.highlight && (space || a.color === b.color) && a.link === b.link && a.note === b.note;
};
const BOXES = new Set(["link", "image", "comment", "highlight"]);
const linkOf = sp => `${sp.kind} ${sp.url} ${sp.title}`, noteOf = sp => `${sp.kind} ${sp.note}`;
const isLink = sp => sp.kind === "link" || sp.kind === "image";
// The link and comment of the innermost of `boxes` (spans, outer first) of each kind.
const scopeLook = boxes => ({ link: boxes.filter(isLink).map(linkOf).at(-1) ?? null, note: boxes.filter(sp => !isLink(sp)).map(noteOf).at(-1) ?? null });
const styleLook = st => ({
  bold: Boolean(st.bits & MARK_BITS.bold), italic: Boolean(st.bits & MARK_BITS.italic), strike: Boolean(st.bits & MARK_BITS.strike),
  underline: Boolean(st.bits & MARK_BITS.underline), code: Boolean(st.bits & MARK_BITS.code), highlight: st.mark === null ? null : st.mark || "default", color: st.color,
});

// What the typed text should look like (null: whatever the field made of it), by rules 4 and 5 and the typing style.
function typedLook(value, edit, style, deleted, kept, defs) {
  const { spans } = parseInline(value, { defs }), shown = deleted.filter(c => !c.brk);
  if (shown.length) {
    const first = shown[0], last = shown.at(-1), holders = spans.filter(sp => BOXES.has(sp.kind) && sp.from <= first.start && last.end <= sp.to);
    const holder = holders.at(-1);
    const boxes = holder ? spans.filter(sp => BOXES.has(sp.kind) && sp.start <= holder.start && holder.end <= sp.end) : [];
    return { ...Object.fromEntries(FLAGS.map(k => [k, first[k]])), highlight: first.highlight, color: first.color, ...scopeLook(boxes), brk: false };
  }
  if (!style && kept) return null;
  const end = edit.at + edit.removed, gone = sp => edit.removed > 0 && sp.start < end && sp.end > edit.at
    && !looks(value, defs).some(c => sp.from <= c.start && c.end <= sp.to && (c.end <= edit.at || c.start >= end));
  const around = spans.filter(sp => sp.start < edit.at && edit.at < sp.end && !gone(sp));
  const f = { bits: 0, mark: null, color: null };
  for (const sp of around) {
    if (sp.kind === "strong") f.bits |= MARK_BITS.bold;
    else if (sp.kind === "em") f.bits |= MARK_BITS.italic;
    else if (sp.kind === "strike") f.bits |= MARK_BITS.strike;
    else if (sp.kind === "code") f.bits |= MARK_BITS.code;
    else if (sp.kind === "html" && sp.tag === "mark") f.mark = sp.color ?? "";
    else if (sp.kind === "html" && sp.tag === "span") f.color = sp.color;
    else if (sp.kind === "html" && TAG_FLAGS[sp.tag]) f.bits |= MARK_BITS[TAG_FLAGS[sp.tag]];
  }
  return { ...styleLook(style ?? f), ...scopeLook(around.filter(sp => BOXES.has(sp.kind))), brk: false };
}

// Spaces that come to open a line after a line break can't show: the break's marks take them. A point comment (`point`
// entries, left out of the answer) opening the line shows, and so do the spaces after it.
function showable(list) {
  const out = [];
  for (const c of list) if (!(isSpace(c.text ?? "") && !c.brk && out.at(-1)?.brk)) out.push(c);
  return out.filter(c => !c.point);
}

// Rule 1: every character that shows and was not deleted still shows, in order, with its formatting, link and comment;
// what was typed shows as typed, in the formatting rules 4-6 give it; nothing hidden shows; outside the stretch the key
// had to rewrite, the field's own result byte for byte. A character typed at a caret that closed a shortcut may format
// what it closes over: only nothing hidden showing is asked then.
function assertMended(label, value, edit, style, out, defs) {
  const field = apply(value, edit), at = edit.at, end = at + edit.removed, delta = edit.inserted.length - edit.removed;
  const before = looks(value, defs), cuts = c => edit.removed > 0 && c.start < end && c.end > at;
  const deleted = before.filter(cuts), want = typedLook(value, edit, style, deleted, out.value === field, defs);
  const typed = graphemes(edit.inserted).map(text => ({ text, typed: true }));
  const points0 = parseInline(value, { defs }).spans.filter(sp => sp.kind === "point" && !cuts(sp)).map(sp => ({ point: true, start: sp.start }));
  const kept = [...before.filter(c => !cuts(c)), ...points0].sort((x, y) => x.start - y.start), split = kept.filter(c => c.start < at).length;
  const expected = showable([...kept.slice(0, split), ...typed, ...kept.slice(split)]);
  const got = looks(out.value, defs), text = expected.map(c => c.text).join("");
  if (got.map(c => c.text).join("") !== text) {
    assert.ok(edit.inserted && !edit.removed && out.value === field, `${label}: shows ${JSON.stringify(got.map(c => c.text).join(""))}, wanted ${JSON.stringify(text)}: ${JSON.stringify(out.value)}`);
    const shownBefore = x => before.some(c => c.start <= x && x < c.end);
    for (const c of got) {
      for (let x = c.start; x < c.end; x++) {
        if (x >= at && x < at + edit.inserted.length) continue;
        assert.ok(shownBefore(x < at ? x : x - delta), `${label}: a shortcut showed what was hidden at ${x}: ${JSON.stringify(out.value)}`);
      }
    }
    return;
  }
  expected.forEach((c, i) => {
    if (!c.typed) assert.ok(sameLook(got[i], c), `${label}: ${describe(got[i])}, was ${describe(c)}: ${JSON.stringify(out.value)}`);
    else if (want) assert.ok(sameLook(got[i], { ...want, text: c.text }), `${label}: typed ${describe(got[i])}, wanted ${describe({ ...want, text: c.text })}: ${JSON.stringify(out.value)}`);
  });
  const points = v => parseInline(v, { defs }).spans.filter(sp => sp.kind === "point").map(sp => sp.note);
  const keptPoints = parseInline(value, { defs }).spans.filter(sp => sp.kind === "point" && !(edit.removed > 0 && sp.start < end && sp.end > at)).map(sp => sp.note);
  assert.deepEqual(points(out.value), keptPoints, `${label}: point comments: ${JSON.stringify(out.value)}`);
  const upToCaret = expected.findLastIndex(c => c.typed || c.start < at) + 1;
  assert.equal(got.filter(c => c.end <= out.caret).length, upToCaret, `${label}: the caret ${out.caret} in ${JSON.stringify(out.value)}`);
  if (/[\\`*_~[\]<>&!{}=]/.test(edit.inserted)) return;
  let lo = Math.min(at, ...deleted.map(c => c.start)), hi = Math.max(end, ...deleted.map(c => c.end));
  for (let grew = true; grew;) {
    grew = false;
    for (const sp of parseInline(value, { defs }).spans) {
      if (sp.start > hi || sp.end < lo || (sp.start >= lo && sp.end <= hi)) continue;
      [lo, hi, grew] = [Math.min(lo, sp.start), Math.max(hi, sp.end), true];
    }
    for (; lo > 0 && /[\s*_~`]/.test(value[lo - 1]); lo--) grew = true;
    for (; hi < value.length && /[\s*_~`]/.test(value[hi]); hi++) grew = true;
  }
  assert.ok(out.value.startsWith(field.slice(0, lo)) && out.value.endsWith(field.slice(hi + delta)), `${label}: rewrote outside ${lo}-${hi}: ${JSON.stringify(out.value)}`);
}

// Typing on at the caret a text typed over a link or comment left: the next letter shows right after the typed one, in
// the typing style, in the same link and comment.
function typedOn(label, out, defs) {
  const typedAt = looks(out.value, defs).filter(c => c.end <= out.caret).length - 1, next = typeAt(out.value, out.caret, "q", defs);
  const on = mend(out.value, next.edit, { defs, style: out.style });
  if (on.unwritable) return;
  const got = looks(on.value, defs), was = looks(out.value, defs)[typedAt], want = { ...styleLook(out.style), link: was.link, note: was.note, text: "q", brk: false };
  assert.equal(got[typedAt + 1]?.text, "q", `${label}: typed on: ${JSON.stringify(on.value)}`);
  assert.ok(sameLook(got[typedAt + 1], want), `${label}: typed on ${describe(got[typedAt + 1])}, wanted ${describe(want)}: ${JSON.stringify(on.value)}`);
}

test("random values and keys as Herdr makes them: each leaves every character it did not delete as it was", () => {
  const CASES = 6000, base = 20261117, counts = { edits: 0, changed: 0, unwritable: 0 };
  for (let k = 0; k < CASES; k++) {
    const seed = base + k, rand = random(seed), value = phrase(rand, 0, 6), e = randomEdit(rand, value, DEFS);
    if (!e) continue;
    const label = `seed ${seed}: ${JSON.stringify(value)} ${e.key} ${JSON.stringify(e.edit)}${e.style ? ` style ${JSON.stringify(e.style)}` : ""}`;
    const field = apply(value, e.edit);
    const caretAfter = e.edit.at + e.edit.inserted.length;
    assert.deepEqual(editOf(value, field, { ...e.known, valid: true }, caretAfter), e.edit, `${label}: the edit as the key made it`);
    const out = mend(value, e.edit, { defs: DEFS, style: e.style ?? null });
    counts.edits++;
    if (out.unwritable) {
      counts.unwritable++;
      assert.equal(out.value, field, `${label}: nothing written: the field's own result`);
      continue;
    }
    if (out.value !== field) counts.changed++;
    assert.equal(apply(value, out.edit), out.value, `${label}: the edit given back makes the value`);
    assertMended(label, value, e.edit, e.style ?? null, out, DEFS);
    if (out.style?.stays) typedOn(label, out, DEFS);
  }
  assert.ok(counts.edits > CASES * 0.8, JSON.stringify(counts));
  assert.ok(counts.unwritable <= counts.edits / 200, `few keys leave the field's own result unrepaired: ${JSON.stringify(counts)}`);
});
