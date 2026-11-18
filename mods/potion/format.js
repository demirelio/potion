// The marks the format keys put on the selection of a text block's field, or take off it, and the selection's text
// colour. A selection's formatting is rewritten by restyle.js; at a caret outside a word a key writes nothing (the
// editor keeps the formatting for what is typed there next, mend.js). Links are made and changed by links.js.
import { MARK_BITS, looksIn, restyle } from "./restyle.js";
import { formatAt } from "./mend.js";
import { parsedInline } from "./inline.js";
import { TEXT_COLORS } from "./colors.js";

const SPACE = /\s/;
const LOOSE_ON_SPACE = new Set(["bold", "italic"]);
const MARKS = new Set(["bold", "italic", "strike", "code", "underline", "highlight"]);
const WORD_BEFORE = /[\p{L}\p{M}\p{N}\p{Pc}]+$/u, WORD_AFTER = /^[\p{L}\p{M}\p{N}\p{Pc}]+/u;

const clampTo = (value, x) => Math.max(0, Math.min(value.length, Number(x) || 0));
const caretAt = (value, at) => ({ value, start: at, end: at });

// A mark next to a space is no mark (`** text**` is not bold), so the spaces at the ends stay outside.
function trimmed(value, start, end) {
  let s = start, e = end;
  while (s < e && SPACE.test(value[s])) s++;
  while (e > s && SPACE.test(value[e - 1])) e--;
  return s === e ? { start, end: start } : { start: s, end: e };
}

export function wordAround(value, at) {
  const before = WORD_BEFORE.exec(value.slice(0, at))?.[0].length ?? 0, after = WORD_AFTER.exec(value.slice(at))?.[0].length ?? 0;
  return before && after ? { start: at - before, end: at + after } : null;
}

// The selection a key acts on: spaces at its ends left out, a caret in a word the word ({ start, end, caret }), or
// { caret } alone for a caret anywhere else.
export function actedOn(value, range) {
  const a = clampTo(value, range?.start), b = clampTo(value, range?.end);
  const sel = trimmed(value, Math.min(a, b), Math.max(a, b));
  if (sel.start !== sel.end) return { ...sel, caret: -1 };
  const word = wordAround(value, sel.start);
  return word ? { ...word, caret: sel.start } : { caret: sel.start };
}

function restyled(value, range, op, defs) {
  const sel = actedOn(value, range);
  if (sel.start === undefined) return null;
  const out = restyle(value, sel, op, { defs, caret: sel.caret });
  if (!out) return null;
  return sel.caret >= 0 ? caretAt(out.value, out.caret) : { value: out.value, start: out.start, end: out.end };
}

// `mark`: one of MARKS. `range`: the field's selection. `defs`: the document's link reference definitions.
// -> { value, start, end }, the field's value and selection after the key, or null when nothing changes. Every
// character of the selection gets the mark, unless every one has it, when it comes off them all. A caret in a word acts
// on the word and keeps its place in it.
export function toggleMark(value, range, mark, { defs } = {}) {
  return MARKS.has(mark) ? restyled(value, range, { mark }, defs) : null;
}

// toggleMark's answer with the mark put on when `on`, else taken off.
export function setMark(value, range, mark, on, { defs } = {}) {
  return MARKS.has(mark) ? restyled(value, range, { mark, on: Boolean(on) }, defs) : null;
}

// toggleMark's answer for text colour `name`, one of TEXT_COLORS, or "default" for none.
export function setColor(value, range, name, { defs } = {}) {
  if (name !== "default" && !TEXT_COLORS.includes(name)) return null;
  return restyled(value, range, { color: name }, defs);
}

function looksOf(value, range, defs) {
  const sel = actedOn(value, range);
  return sel.start === undefined ? [] : looksIn(value, sel, { defs });
}

// Whether the selection (the word holding the caret) lies in a link; a caret at a link's edge is outside it.
function inLink(value, range, defs) {
  const sel = actedOn(value, range), { start, end } = sel.start === undefined ? { start: sel.caret, end: sel.caret } : sel;
  return parsedInline(value, defs ?? null).spans.some(sp => sp.kind === "link"
    && (start === end ? sp.start < start && start < sp.end : sp.start <= start && end <= sp.end));
}

// Whether `mark` is on the selection already: every character of it has the mark, so its key would take it off; at a
// caret outside a word, whether text typed there would have it; for a link, whether the selection lies in one.
export function hasMark(value, range, mark, { defs } = {}) {
  if (mark === "link") return inLink(value, range, defs);
  if (!MARKS.has(mark)) return false;
  const sel = actedOn(value, range);
  if (sel.start === undefined) {
    const typed = formatAt(value, sel.caret, { defs });
    return mark === "highlight" ? typed.mark !== null : (typed.bits & MARK_BITS[mark]) !== 0;
  }
  const bit = MARK_BITS[mark], looks = looksOf(value, range, defs).filter(l => !(l.space && LOOSE_ON_SPACE.has(mark)) && !(mark === "code" && l.unit));
  return looks.length > 0 && looks.every(l => (mark === "highlight" ? l.mark !== null : (l.bits & bit) !== 0));
}

// The selection's text colour: one name (or a colour written in the file), "default" when it has none, or "mixed".
// Spaces show no colour and are left out.
export function colorOf(value, range, { defs } = {}) {
  const colors = new Set(looksOf(value, range, defs).filter(l => !l.space).map(l => l.color ?? "default"));
  return colors.size === 1 ? [...colors][0] : colors.size ? "mixed" : "default";
}

// The selection's highlight: "none", "default" (the editor's own colour), a colour written in the file, or "mixed".
export function highlightOf(value, range, { defs } = {}) {
  const marks = new Set(looksOf(value, range, defs).map(l => (l.mark === null ? "none" : l.mark || "default")));
  return marks.size === 1 ? [...marks][0] : marks.size ? "mixed" : "none";
}
