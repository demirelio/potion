// What Enter, a join and the clipboard do to the runs of a text block's field value. Enter closes the runs open across
// the split at the end of the first half and opens them again at the start of the second; a join keeps each half
// showing as it did alone; a copy is markdown that stands alone; a paste reads the clipboard alone and gives it what
// typed text gets where it lands. Every answer is written as restyle.js writes a stretch and parsed back before it is
// given. Offsets are UTF-16 indices into the value.
import { parse } from "./blocks.js";
import { parsedInline } from "./inline.js";
import { destinationOf } from "./links.js";
import { mend } from "./mend.js";
import { BOX, FORMAT, KEPT, UNIT, modelFrom, modelOf, pointsIn, readsBack, rewrite } from "./restyle.js";

const COMMENT = "comment", POINT = "point";
const NOTED = new Set([COMMENT, POINT]);
const COMMENTS = new Set([COMMENT, POINT, "highlight"]);
// Stand-ins for pasted text while typing's rules (mend.js) decide where it goes and with what formatting: characters of
// the private use area, which no markup reads and no one types.
const STAND_INS = ["\uE000", "\uE001", "\uF8FF"];
const TITLE_SPECIALS = /["\\]/g;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;

function piecesOf(m, lo, hi, cuts = []) {
  const out = m.piecesIn(lo, hi, cuts, true);
  for (const p of out) p.source = m.s.slice(p.start, p.end);
  return out;
}

// [L, R) grown until no span crosses an end of it, and over delimiter characters that show right beside it, which
// marks written there could pair with.
function closedOver(m, L0, R0) {
  let L = L0, R = R0;
  for (let grew = true; grew;) {
    grew = false;
    for (const sp of m.spans) {
      if (sp.start >= R) break;
      if (sp.start < L && sp.end > L) { L = sp.start; grew = true; }
      if (sp.start < R && sp.end > R) { R = sp.end; grew = true; }
    }
    while (L > 0 && m.shownDelimiter(L - 1)) { L--; grew = true; }
    while (R < m.s.length && m.shownDelimiter(R)) { R++; grew = true; }
  }
  return { L, R };
}

// The pieces inside the spans `gone`, which are left out, as they show without them: their links and comments no longer
// around them.
function leaving(m, pieces, gone) {
  const made = new Map();
  for (const p of pieces) {
    const outside = gone.filter(sp => p.start >= sp.from && p.end <= sp.to);
    if (!outside.length) continue;
    const key = outside.map(sp => sp.id).join(","), kept = made.get(p.st) ?? new Map();
    made.set(p.st, kept);
    if (!kept.has(key)) {
      const own = p.st.own, scope = outside.reduce((left, sp) => left.replace(m.scopeOf(sp), ""), p.st.scope);
      kept.set(key, { ...p.st, own: { bits: own.bits, mark: own.mark, color: own.color }, scope });
    }
    p.st = kept.get(key);
    p.own = p.st.own;
  }
}

const idsWhere = (m, test) => new Set(m.spans.filter(test).map(sp => sp.id));

// -> { value, start, end }: `value` with the runs open across [start, end) closed at `start` and opened again at `end`,
// so that value.slice(0, start) and value.slice(end) each read alone as they did; what lies between is kept. Bold,
// italic, strikethrough, underline, colours, highlights and code go on in both halves, and so does a link, to the same
// address; commented text after the split leaves its comment. A split inside a picture, an autolink, a bare address or
// a link whose text is its label moves to its end. Null when no run crosses the split; the value as it was, with the
// split moved, when only that changes. `defs`: the document's link reference definitions.
export function splitRuns(value, start, end = start, { defs = null } = {}) {
  const s = String(value ?? ""), known = defs ?? null, m = modelOf(s, known);
  let a = start, b = Math.max(start, end);
  for (const sp of m.spans) {
    if (sp.start >= b) break;
    if (m.roles[sp.id] !== UNIT) continue;
    if (sp.start < a && a < sp.end) a = sp.end;
    if (sp.start < b && b < sp.end) b = sp.end;
  }
  b = Math.max(a, b);
  const crossing = m.spans.filter(sp => sp.start < a && b < sp.end && m.roles[sp.id] !== KEPT);
  if (!crossing.length) return a === start && b === end ? null : { value: s, start: a, end: b };
  const L = closedOver(m, Math.min(...crossing.map(sp => sp.start)), a).L, R = closedOver(m, b, Math.max(...crossing.map(sp => sp.end))).R;
  const leftPieces = piecesOf(m, L, a), rightPieces = piecesOf(m, b, R);
  // A link or comment goes on in a half only where some of its text is; a comment stays with its first half.
  const shows = (pieces, sp) => m.roles[sp.id] !== BOX || pieces.some(p => p.start >= sp.from && p.end <= sp.to);
  const toLeft = crossing.filter(sp => shows(leftPieces, sp)), leaves = toLeft.filter(sp => sp.kind === COMMENT);
  const toRight = crossing.filter(sp => shows(rightPieces, sp) && !leaves.includes(sp));
  const leftDead = idsWhere(m, sp => sp.start >= a || (crossing.includes(sp) && !toLeft.includes(sp)));
  const left = rewrite(m, L, s.length, leftPieces, { defs: known, dead: leftDead, points: pointsIn(m, L, a) });
  leaving(m, rightPieces, leaves);
  const rightDead = idsWhere(m, sp => sp.start < b && !toRight.includes(sp));
  const right = left && rewrite(m, 0, R, rightPieces, { defs: known, dead: rightDead, points: pointsIn(m, b, R) });
  if (!right) return null;
  return { value: left.value + s.slice(a, b) + right.value, start: left.value.length, end: left.value.length + b - a };
}

const movedSpan = (sp, id, at) => {
  const out = { ...sp, id, start: at(sp.start), end: at(sp.end), from: at(sp.from), to: at(sp.to) };
  if (typeof sp.noteAt === "number") out.noteAt = at(sp.noteAt);
  return out;
};

// A model of `values` side by side, each read alone.
function besideModel(values, defs) {
  const spans = [], runs = [];
  let at = 0;
  for (const v of values) {
    const inline = parsedInline(v, defs), base = spans.length, by = at, lists = new Map();
    for (const sp of inline.spans) spans.push(movedSpan(sp, sp.id + base, x => x + by));
    for (const r of inline.runs) {
      if (!lists.has(r.spans)) lists.set(r.spans, r.spans.map(id => id + base));
      runs.push({ start: r.start + by, end: r.end + by, text: r.text, verbatim: r.verbatim, spans: lists.get(r.spans) });
    }
    at += v.length;
  }
  return modelFrom(values.join(""), { spans, runs });
}

// -> { value, at }: the field value `value`, two blocks' texts joined at `at`, written so that every character of each
// shows as it did in its own block, runs of the same formatting that meet at the join made one; `at` the join in it,
// where the caret goes. Links and comments that meet stay two. Null when the value already shows that.
export function joinRuns(value, at, { defs = null } = {}) {
  const s = String(value ?? ""), known = defs ?? null;
  if (at <= 0 || at >= s.length) return null;
  const m = besideModel([s.slice(0, at), s.slice(at)], known);
  let L = at, R = at;
  for (const sp of m.spans) {
    if (sp.end === at) L = Math.min(L, sp.start);
    if (sp.start === at) R = Math.max(R, sp.end);
  }
  const touching = L < R;
  if (!touching) ({ a: L, b: R } = m.select(at - 1, at + 1));
  const near = closedOver(m, L, R);
  if (!touching && readsBack(m, s, near.L, near.R, near.R - near.L, piecesOf(m, near.L, near.R), known, pointsIn(m, near.L, near.R))) return null;
  for (const { L: lo, R: hi } of [near, delimited(m, near), { L: 0, R: s.length }]) {
    const pieces = piecesOf(m, lo, hi), last = pieces.filter(p => p.end <= at).pop() ?? null;
    const out = rewrite(m, lo, hi, pieces, { defs: known, last, points: pointsIn(m, lo, hi) });
    if (!out) continue;
    return out.value === s ? null : { value: out.value, at: last ? lo + out.at.end : lo };
  }
  return null;
}

// [L, R) grown out to every delimiter character that shows in the value: one far from a seam can pair across it.
function delimited(m, { L, R }) {
  let lo = L, hi = R;
  for (const r of m.runs) {
    if (!r.verbatim) continue;
    for (let x = r.start; x < r.end; x++) {
      if (!m.shownDelimiter(x)) continue;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x + 1);
    }
  }
  return closedOver(m, lo, hi);
}

// The closing marks of a link or picture found through a reference definition, written inline: its address and title.
function inlineClose(s, sp) {
  if ((sp.kind !== "link" && sp.kind !== "image") || !"[!".includes(s[sp.start]) || s.startsWith("](", sp.to)) return null;
  const title = sp.title ? ` "${sp.title.replace(TITLE_SPECIALS, "\\$&")}"` : "";
  return `](${destinationOf(sp.url)}${title})`;
}

// -> the markdown of the characters of `range` that show, standing alone: each with its formatting, every mark opened
// and closed in it; a link with its address and title, written inline; a picture whole; comments left out, their text
// kept. "" for a caret.
export function copyOf(value, { start, end }, { defs = null } = {}) {
  const s = String(value ?? ""), known = defs ?? null;
  if (start >= end) return "";
  const { a, b } = modelOf(s, known).select(start, end), m = modelOf(s, known, true), pieces = piecesOf(m, a, b, [a, b]);
  const holds = sp => (sp.start >= a && sp.end <= b) || pieces.some(p => p.start >= sp.from && p.end <= sp.to);
  const dead = idsWhere(m, sp => m.roles[sp.id] !== FORMAT && (NOTED.has(sp.kind) || !holds(sp))), closes = new Map();
  for (const sp of m.spans) {
    const close = dead.has(sp.id) ? null : inlineClose(s, sp);
    if (close) closes.set(sp.id, close);
  }
  leaving(m, pieces, m.spans.filter(sp => sp.kind === COMMENT));
  const out = rewrite(m, 0, s.length, pieces, { dead, closes, points: 0 });
  return out ? out.value : pieces.map(p => p.text).join("").replace(ASCII_PUNCTUATION, "\\$&");
}

// The model of `v` with its stand-in character at `p` read as `c` reads alone, and the formatting the stand-in had,
// which the pieces of `c` take on beside their own (formattedAs). The spans around the stand-in hold all of `c`, and
// those of `c` that `gives` names are left out. The pieces keep the formatting of their own source: code written as
// code, an escape as an escape.
function pastedModel(mv, p, mc, gives) {
  const d = mc.s.length - 1, value = mv.s.slice(0, p) + mc.s + mv.s.slice(p + 1), past = x => (x <= p ? x : x + d);
  const entries = [];
  for (const sp of mv.spans) entries.push({ sp, from: mv, at: past });
  for (const sp of mc.spans) if (!gives(sp)) entries.push({ sp, from: mc, at: x => x + p });
  entries.sort((x, y) => x.at(x.sp.start) - y.at(y.sp.start) || y.at(y.sp.end) - x.at(x.sp.end) || (x.from === mv ? -1 : 1));
  const ids = new Map([[mv, new Map()], [mc, new Map()]]), spans = entries.map((e, id) => {
    ids.get(e.from).set(e.sp.id, id);
    return movedSpan(e.sp, id, e.at);
  });
  const remap = (list, from) => list.map(id => ids.get(from).get(id)).filter(id => id !== undefined).sort((x, y) => x - y);
  const runs = [];
  let place = null;
  for (const r of mv.runs) {
    const own = remap(r.spans, mv);
    if (r.end <= p || r.start > p) {
      runs.push({ start: past(r.start), end: past(r.end), text: r.text, verbatim: r.verbatim, spans: own });
      continue;
    }
    if (!r.verbatim) return null;
    place = mv.styleOf(r.spans).own;
    const boxes = own.filter(id => mv.roles[entries[id].sp.id] !== FORMAT);
    if (r.start < p) runs.push({ start: r.start, end: p, text: mv.s.slice(r.start, p), verbatim: true, spans: own });
    for (const q of mc.runs) {
      const held = [...boxes, ...remap(q.spans, mc)].sort((x, y) => x - y);
      runs.push({ start: q.start + p, end: q.end + p, text: q.text, verbatim: q.verbatim, spans: held });
    }
    if (r.end > p + 1) runs.push({ start: p + 1 + d, end: r.end + d, text: mv.s.slice(p + 1, r.end), verbatim: true, spans: own });
  }
  return place && { m: modelFrom(value, { spans, runs }, true), place };
}

// Pasted pieces with the formatting of where they land beside their own.
function formattedAs(pieces, lo, hi, place) {
  for (const p of pieces) {
    if (p.start < lo || p.end > hi || p.st.line) continue;
    const own = p.own;
    p.next = { bits: own.bits | place.bits, mark: own.mark ?? place.mark, color: own.color ?? place.color };
  }
  return pieces;
}

// The stretches a paste of [lo, hi) is written in, nearest first: grown over the formatting runs that meet it, so that
// they join, the runs around it whose marks stand at its edge, and code around it, which is written whole.
function pasteStretches(m, lo, hi) {
  let L = lo, R = hi;
  for (const sp of m.spans) {
    if (sp.start > R) break;
    if (m.roles[sp.id] !== FORMAT) continue;
    const around = sp.from <= L && sp.to >= R;
    if (sp.end === L || sp.start === R || (around && (sp.from === L || sp.to === R || sp.kind === "code"))) {
      L = Math.min(L, sp.start);
      R = Math.max(R, sp.end);
    }
  }
  const near = closedOver(m, L, R);
  return [near, delimited(m, near)];
}

// -> { value, caret }: the field value with the clipboard's text `clip` pasted over `range`, the caret after it. The
// clipboard is read as markdown on its own: what shows there is pasted, each character with its formatting, and a mark
// that pairs with nothing there is pasted as the character it shows, escaped. The pasted text also gets what text typed
// there gets (mend.js): the formatting of the run it lands in, of the first character of a selection, or `style`, the
// typing style. A link pasted into a link, or a comment into a comment, gives way to the one around it. Null when no
// way of writing it reads back.
export function pasteInto(value, { start, end }, clip, { defs = null, style = null } = {}) {
  const s = String(value ?? ""), known = defs ?? null, c = clip ? escapedDelimiters(String(clip), known) : "";
  const standIn = STAND_INS.find(x => !s.includes(x) && !c.includes(x));
  if (!c || !standIn) return null;
  const placed = mend(s, { at: start, removed: end - start, inserted: standIn }, { defs: known, style }), v = placed.value, p = v.indexOf(standIn);
  const mv = modelOf(v, known, true), holders = mv.spans.filter(sp => mv.roles[sp.id] === BOX && sp.from <= p && p < sp.to);
  const inLink = holders.some(sp => sp.kind === "link"), inPicture = holders.some(sp => sp.kind === "image");
  const inComment = holders.some(sp => COMMENTS.has(sp.kind));
  const gives = sp => ((inLink || inPicture) && sp.kind === "link") || (inPicture && sp.kind === "image") || (inComment && COMMENTS.has(sp.kind));
  const pasted = pastedModel(mv, p, modelOf(c, known, true), gives);
  if (!pasted) return null;
  const { m, place } = pasted, lo = p, hi = p + c.length;
  if (readsBack(m, m.s, lo, hi, hi - lo, formattedAs(piecesOf(m, lo, hi), lo, hi, place), known, pointsIn(m, lo, hi))) return { value: m.s, caret: hi };
  for (const { L, R } of pasteStretches(m, lo, hi)) {
    const pieces = formattedAs(piecesOf(m, L, R, [lo, hi]), lo, hi, place), last = pieces.filter(q => q.start >= lo && q.end <= hi).pop() ?? null;
    const out = rewrite(m, L, R, pieces, { defs: known, last, points: pointsIn(m, L, R) });
    if (out) return { value: out.value, caret: last ? L + out.at.end : out.value.length - (m.s.length - R) };
  }
  return null;
}

const isBlank = line => !line.trim();
const lineAt = (text, at) => text.slice(0, at).split("\n").length - 1;

// Whether more text can go on at the end of block b's last line: its text ends there.
const endsInText = b => b.kind === "paragraph" || b.kind === "quote" || (b.kind === "item" && !b.emptyLine) || (b.kind === "heading" && !b.setext && !b.suffix);

// Clipboard text that makes more than one block, in three: `first`, the lines of its first paragraph, which join the
// text before the paste; `between`, every line that makes another block, as the clipboard writes them; `last`, the lines
// of its last paragraph, which join the text after the paste. A paragraph not there is "". With no last paragraph,
// `joins` says whether the text after the paste goes on at the end of the last line, as it does after a list item, or
// stands apart, as after code or a rule. Null for one paragraph.
function clipParts(clip) {
  if (!clip.includes("\n")) return null;
  const lines = clip.split("\n"), all = parse(clip).blocks, blocks = all.filter(b => b.depth === 0), one = blocks[0], end = blocks.at(-1);
  if (!one) return null;
  const firstJoins = one.kind === "paragraph" && lineAt(clip, one.start) === 0;
  if (blocks.length === 1 && firstJoins) return null;
  const f = firstJoins ? lineAt(clip, one.end - 1) + 1 : 0;
  const l = end.kind === "paragraph" ? lineAt(clip, end.start) : lines.length;
  const lastEnd = l < lines.length ? lineAt(clip, end.end - 1) + 1 : l;
  const last = lines.slice(l, lastEnd).join("\n");
  return { first: lines.slice(0, f).join("\n"), between: lines.slice(f, l), last, joins: !last && endsInText(all.at(-1)) };
}

// Whether clipboard text makes more than one block where it is pasted: paragraphs, or lines that make other blocks. A
// single line never does.
export const holdsBlocks = clip => clipParts(String(clip ?? "")) !== null;

// `lines` without the blank lines at its start (`start`) and its end (`end`).
function withoutBlank(lines, start, end) {
  let a = 0, z = lines.length;
  while (start && a < z && isBlank(lines[a])) a++;
  while (end && z > a && isBlank(lines[z - 1])) z--;
  return lines.slice(a, z);
}

// The first half of a block split where clipboard paragraphs are pasted, with their first, `first`, pasted where typed
// text goes: at its end, or in place of the stand-in `standIn` the split moved past (in an address or a picture).
function firstHalf(left, standIn, first, opts) {
  const at = left.indexOf(standIn);
  if (first) return pasteInto(left, at < 0 ? { start: left.length, end: left.length } : { start: at, end: at + 1 }, first, opts);
  return { value: at < 0 ? left.replace(/[ \t]+$/, "") : mend(left, { at, removed: 1, inserted: "" }, { defs: opts.defs }).value };
}

// The clipboard's text with every delimiter character that shows there escaped, outside code and addresses: it shows
// as it did wherever it lands, and pairs with nothing in the block, then or later.
function escapedDelimiters(c, defs) {
  const m = modelOf(c, defs, true), literal = id => m.spans[id].kind === "code" || (m.spans[id].kind === "link" && c[m.spans[id].start] !== "[");
  let out = "", at = 0;
  for (const r of m.runs) {
    if (!r.verbatim || r.spans.some(literal)) continue;
    for (let x = r.start; x < r.end; x++) {
      if (!m.shownDelimiter(x)) continue;
      out += `${c.slice(at, x)}\\`;
      at = x;
    }
  }
  return out + c.slice(at);
}

// -> { value, caret } for clipboard text that makes more than one block (holdsBlocks) pasted over `range`: the value
// split where the paste lands as Enter splits it, the clipboard's first paragraph pasted where typed text goes in the
// first half and its last paragraph at the start of the second, each with the formatting text typed there gets; every
// other line as the clipboard writes it, between them. With no first paragraph the first half stands a blank line apart
// from those lines; with no last one the second half goes on at the end of the last line when it ends in text (an item,
// a quote, a heading), else it too stands apart. `caret` after the last pasted line. Null when the clipboard is one
// paragraph, or no way of writing it reads back.
export function pasteParagraphs(value, { start, end }, clip, { defs = null, style = null } = {}) {
  const s = String(value ?? ""), known = defs ?? null, parts = clipParts(String(clip ?? ""));
  const standIn = STAND_INS.find(x => !s.includes(x));
  if (!parts || !standIn) return null;
  const placed = mend(s, { at: start, removed: end - start, inserted: standIn }, { defs: known, style }), v = placed.value, p = v.indexOf(standIn);
  const mv = modelOf(v, known, true), own = mv.styleOf(mv.runs[mv.runAfter(p)].spans).own, format = { bits: own.bits, mark: own.mark, color: own.color };
  const split = splitRuns(v, p, p + 1, { defs: known }) ?? { value: v, start: p, end: p + 1 };
  const left = split.value.slice(0, split.start), right = split.value.slice(split.end);
  const head = firstHalf(left, standIn, parts.first, { defs: known, style: format });
  const tail = parts.last ? pasteInto(right, { start: 0, end: 0 }, parts.last, { defs: known, style: format })
    : { value: parts.joins ? right : right.replace(/^[ \t]+/, ""), caret: 0 };
  if (!head || !tail) return null;
  const between = withoutBlank(parts.between, !parts.first, !parts.last).join("\n");
  const before = between ? head.value + (head.value ? (parts.first ? "\n" : "\n\n") : "") + between : head.value;
  const gap = !before || !tail.value || (parts.joins && between) ? "" : parts.last && between ? "\n" : "\n\n";
  return { value: before + gap + tail.value, caret: parts.last ? before.length + gap.length + tail.caret : before.length };
}
