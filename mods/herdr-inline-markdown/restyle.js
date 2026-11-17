// A change of formatting over a selection of a text block's field value: the stretch it touches is written afresh, so
// each character that shows gets exactly the formatting asked of it, and everything else stays as written. The answer
// is parsed back and checked before it is given. Offsets are UTF-16 indices into the value.
import { graphemeEnd, parsedInline } from "./inline.js";

const BOLD = 1, ITALIC = 2, STRIKE = 4, UNDERLINE = 8, CODE = 16;
export const MARK_BITS = { bold: BOLD, italic: ITALIC, strike: STRIKE, underline: UNDERLINE, code: CODE };
const KIND_BITS = { strong: BOLD, em: ITALIC, strike: STRIKE, code: CODE };
const TAG_BITS = { strong: BOLD, b: BOLD, em: ITALIC, i: ITALIC, s: STRIKE, del: STRIKE, strike: STRIKE, u: UNDERLINE };
// Bold, italic and a text colour draw nothing on a space, so a space may have them or not, as the markdown needs.
const LOOSE_BITS = BOLD | ITALIC;
const isLoose = key => key === "b" || key === "i" || key[0] === "k";

// What a span is to a rewrite. FORMAT is written afresh. BOX keeps its marks and has its text written inside them (a
// link with text of its own, a comment). UNIT is kept whole, formatting only around it (a picture, an autolink, a link
// whose text is its label). KEPT shows no formatting and stays where it is (a line break, a point comment, a tag that
// draws nothing). A model of typed text (`boxes`) has no UNIT: typing changes the text of those too.
export const FORMAT = 0, BOX = 1, UNIT = 2, KEPT = 3;
const LBR = 91, RBR = 93, LPAREN = 40;

// Mark keys, outermost first when several open together and run as far: a text colour, a highlight, then the rest.
const RANK = { k: 0, h: 1, u: 2, s: 3, b: 4, i: 5 };
const DELIMS = { b: "**", i: "*", s: "~~" };
const TAGS = { b: "strong", i: "em", s: "s", u: "u" };
const SPAN_KEYS = { strong: "b", b: "b", em: "i", i: "i", strike: "s", s: "s", del: "s", u: "u" };
// What can start markup in text: escaped when text is written out of code or beside new marks fails to read back.
const SPECIALS = /[\\`*_~[\]<&!{]/g;
const DELIMITER_CHARS = "*_~`";
const WHITESPACE = /[\t\n\f\r\p{Zs}]/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE_CHAR = /\s/;
const ALL_SPACE = /^\s+$/u;
const BACKTICKS = /`+/g;

const TEXT = 0, OPEN = 1, CLOSE = 2, CODE_RUN = 3, POINT = 4;
const HARD = "hard", SOFT = "soft", LINE_ENDS = "\n\r";
const ITEM_CHAR = 0, ITEM_BOX = 1, ITEM_UNIT = 2, ITEM_KEPT = 3;
// How marks are written: markdown where it reads back as written, also never a delimiter run that could both open and
// close, or tags only. The ways are tried in turn, the later ones with the text's markup characters escaped.
const AS_MARKDOWN = 0, NO_TWO_SIDED = 1, AS_TAGS = 2;
const ATTEMPTS = [[AS_MARKDOWN, false], [AS_MARKDOWN, true], [NO_TWO_SIDED, true], [AS_TAGS, true]];

function roleOf(s, sp) {
  if (KIND_BITS[sp.kind]) return FORMAT;
  if (sp.kind === "html") return sp.from < sp.to ? FORMAT : KEPT;
  if (sp.kind === "comment" || sp.kind === "highlight") return BOX;
  if (sp.kind === "link") return ownText(s, sp) ? BOX : UNIT;
  return sp.kind === "image" ? UNIT : KEPT;
}

// An inline link `[text](…)` or a full reference `[text][label]`: its text is not what finds its address.
export function ownText(s, sp) {
  if (s.charCodeAt(sp.start) !== LBR || s.charCodeAt(sp.to) !== RBR) return false;
  const next = s.charCodeAt(sp.to + 1);
  return next === LPAREN || (next === LBR && sp.end - sp.to > 3);
}

// A link whose address is its own text: an autolink, a web or mail address.
const addressed = (s, sp) => sp.kind === "link" && s.charCodeAt(sp.start) !== LBR;

// What a span adds to the scope of the text inside it. In a model of typed text an addressed link is named without
// its address, which typing in it changes.
function scopeOf(s, sp, boxes) {
  if (boxes && addressed(s, sp)) return "link\u0001\u0002";
  return sp.kind === "link" || sp.kind === "image" ? `${sp.kind}\u0001${sp.url}\u0001${sp.title}\u0002` : `${sp.kind}\u0001${sp.note}\u0002`;
}

export function formatInto(f, sp) {
  if (sp.kind !== "html") f.bits |= KIND_BITS[sp.kind];
  else if (sp.tag === "mark") f.mark = sp.color ?? "";
  else if (sp.tag === "span") f.color = sp.color;
  else f.bits |= TAG_BITS[sp.tag] ?? 0;
}

const sameFormat = (a, b) => a.bits === b.bits && a.mark === b.mark && a.color === b.color;

// Keys of the marks a format writes, outermost first; kept on the format, which is never changed.
function keysOf(f) {
  return (f.keys ??= markKeys(f));
}

function markKeys(f) {
  const keys = [];
  if (f.color !== null) keys.push(`k${f.color}`);
  if (f.mark !== null) keys.push(`h${f.mark}`);
  if (f.bits & UNDERLINE) keys.push("u");
  if (f.bits & STRIKE) keys.push("s");
  if (f.bits & BOLD) keys.push("b");
  if (f.bits & ITALIC) keys.push("i");
  return keys;
}

function keyOfSpan(sp) {
  if (sp.kind !== "html") return SPAN_KEYS[sp.kind];
  if (sp.tag === "mark") return `h${sp.color ?? ""}`;
  if (sp.tag === "span") return `k${sp.color}`;
  return SPAN_KEYS[sp.tag];
}

function openOf(key, md) {
  if (md) return DELIMS[key];
  if (key[0] === "h") return key.length > 1 ? `<mark color="${key.slice(1)}">` : "<mark>";
  if (key[0] === "k") return `<span style="color: ${key.slice(1)}">`;
  return `<${TAGS[key]}>`;
}

function closeOf(key, md) {
  if (md) return DELIMS[key];
  if (key[0] === "h") return "</mark>";
  if (key[0] === "k") return "</span>";
  return `</${TAGS[key]}>`;
}

const isCodeSpace = c => c === " " || c === "\n" || c === "\r";

// A code span showing `content`: backticks one longer than its longest run, padded with a space where a backtick or a
// space at both ends would otherwise be read away. `lead` is where the content starts in `text`.
function fenced(content) {
  const longest = (content.match(BACKTICKS) ?? []).reduce((n, run) => Math.max(n, run.length), 0), ticks = "`".repeat(longest + 1);
  const first = content[0], last = content[content.length - 1];
  const pad = first === "`" || last === "`" || (isCodeSpace(first) && isCodeSpace(last) && content.trim() !== "") ? " " : "";
  return { text: ticks + pad + content + pad + ticks, lead: ticks.length + pad.length };
}

// What stands beside a delimiter run, for CommonMark's flanking rules; the ends of the value count as space.
const BY_SPACE = 0, BY_PUNCTUATION = 1, BY_WORD = 2;
const sideOf = ch => (!ch || WHITESPACE.test(ch) ? BY_SPACE : PUNCTUATION.test(ch) ? BY_PUNCTUATION : BY_WORD);
const lastChar = s => (s.length > 1 && s.charCodeAt(s.length - 1) >= 0xdc00 && s.charCodeAt(s.length - 1) <= 0xdfff ? s.slice(-2) : s.slice(-1));
const firstChar = s => String.fromCodePoint(s.codePointAt(0));

export function clusterStart(s, from, x) {
  for (let i = from; i < x;) {
    const j = graphemeEnd(s, i);
    if (j > x) return i;
    i = j;
  }
  return x;
}

export function clusterEnd(s, from, to, x) {
  let i = from;
  while (i < x) i = graphemeEnd(s, i, to);
  return i;
}

class Model {
  constructor(s, inline, boxes) {
    this.s = s;
    this.boxes = boxes;
    this.spans = inline.spans;
    this.runs = inline.runs;
    this.roles = new Uint8Array(this.spans.length);
    for (const sp of this.spans) {
      const role = roleOf(s, sp);
      this.roles[sp.id] = boxes && role === UNIT ? BOX : role;
    }
    this.styles = new Map();
  }

  scopeOf(sp) {
    return scopeOf(this.s, sp, this.boxes);
  }

  // { own, inner, unit, scope, line } for the spans around a run: `own` the formatting a rewrite may change, `inner`
  // what lies inside the unit holding it, `scope` the links and comments around it, `line` HARD or SOFT for a line
  // break (the field shows both; the file keeps only a hard one).
  styleOf(ids) {
    let st = this.styles.get(ids);
    if (st) return st;
    const own = { bits: 0, mark: null, color: null };
    let inner = null, unit = -1, scope = "", line = "";
    for (const id of ids) {
      const sp = this.spans[id], role = this.roles[id];
      if (role === FORMAT) formatInto(inner ?? own, sp);
      else if (role === BOX || role === UNIT) {
        scope += this.scopeOf(sp);
        if (role === UNIT && unit < 0) {
          unit = id;
          inner = { bits: 0, mark: null, color: null };
        }
      } else if (sp.kind === "break") line = sp.start === sp.from && LINE_ENDS.includes(this.s[sp.from]) ? SOFT : HARD;
    }
    st = { own, inner, unit, scope, line };
    this.styles.set(ids, st);
    return st;
  }

  // The index of the first run that ends after x.
  runAfter(x) {
    let lo = 0, hi = this.runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.runs[mid].end <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Whether offset x holds a delimiter character that shows as text: marks written beside it could pair with it, so a
  // rewrite takes it in, to escape it if need be.
  shownDelimiter(x) {
    if (!DELIMITER_CHARS.includes(this.s[x])) return false;
    const r = this.runs[this.runAfter(x)];
    return Boolean(r) && r.verbatim && r.start <= x;
  }

  // The selection out to whole characters and whole units.
  select(start, end) {
    let a = start, b = end;
    const ra = this.runs[this.runAfter(a)];
    if (ra && ra.start < a) a = ra.verbatim ? clusterStart(this.s, ra.start, a) : ra.start;
    const rb = b > 0 ? this.runs[this.runAfter(b - 1)] : null;
    if (rb && rb.start < b && rb.end > b) b = rb.verbatim ? clusterEnd(this.s, rb.start, rb.end, b) : rb.end;
    for (let grew = true; grew;) {
      grew = false;
      for (const sp of this.spans) {
        if (sp.start >= b) break;
        if (this.roles[sp.id] !== UNIT || sp.end <= a || (sp.start >= a && sp.end <= b)) continue;
        a = Math.min(a, sp.start);
        b = Math.max(b, sp.end);
        grew = true;
      }
    }
    return { a, b };
  }

  // The runs in [lo, hi) as pieces, cut at `cuts` and, with `spaced`, where spaces start and end.
  piecesIn(lo, hi, cuts, spaced) {
    const s = this.s, out = [];
    for (let k = this.runAfter(lo); k < this.runs.length && this.runs[k].start < hi; k++) {
      const r = this.runs[k], st = this.styleOf(r.spans);
      if (!r.verbatim) {
        out.push(pieceOf(r.start, r.end, r.text, false, st));
        continue;
      }
      let at = Math.max(r.start, lo);
      const to = Math.min(r.end, hi);
      for (const c of [...cuts.filter(x => x > at && x < to).sort((x, y) => x - y), to]) {
        if (c <= at) continue;
        if (spaced) spacedPieces(s, at, c, st, out);
        else out.push(pieceOf(at, c, s.slice(at, c), true, st));
        at = c;
      }
    }
    return out;
  }
}

function pieceOf(start, end, text, verbatim, st, space = ALL_SPACE.test(text)) {
  return { start, end, text, verbatim, st, own: st.own, next: null, space };
}

const isSpaceAt = (s, i) => {
  const c = s.charCodeAt(i);
  return c === 32 || (c >= 9 && c <= 13) || (c >= 0x80 && SPACE_CHAR.test(s[i]));
};

// s[from, to) as its leading spaces, what lies between, and its trailing spaces: where a run may end before a space.
export function spacedPieces(s, from, to, st, out) {
  let lead = from, trail = to;
  while (lead < to && isSpaceAt(s, lead)) lead++;
  if (lead === to) return out.push(pieceOf(from, to, s.slice(from, to), true, st, true));
  while (trail > lead && isSpaceAt(s, trail - 1)) trail--;
  if (lead > from) out.push(pieceOf(from, lead, s.slice(from, lead), true, st, true));
  out.push(pieceOf(lead, trail, s.slice(lead, trail), true, st, false));
  if (trail < to) out.push(pieceOf(trail, to, s.slice(trail, to), true, st, true));
}

// The formatting that shows: the unit's own over what is around it.
export function shown(st, own) {
  const inner = st.inner;
  if (!inner) return own;
  return { bits: own.bits | inner.bits, mark: inner.mark ?? own.mark, color: inner.color ?? own.color };
}

// The models of the last reads: the format bar asks after each key whether its marks are on, of the value the key just
// wrote and read to check it; typing reads the value before a key and the one after it.
const MODELS_KEPT = 4;
const models = [];
export function modelOf(value, defs, boxes = false) {
  const inline = parsedInline(value, defs);
  for (const kept of models) if (kept.inline === inline && kept.boxes === boxes) return kept.model;
  const model = new Model(value, inline, boxes);
  models.unshift({ inline, boxes, model });
  if (models.length > MODELS_KEPT) models.pop();
  return model;
}

// A model of `value` read as `inline` ({ spans, runs } as parseInline gives them) says, which need not be how the value
// reads: the parts of a value as each read alone.
export const modelFrom = (value, inline, boxes = false) => new Model(value, inline, boxes);

// The characters of the selection [start, end) of `value` that take formatting (not line breaks), as pieces, with the
// selection [a, b) taken out to whole characters and units and in from the spaces that show at its ends; null when it
// holds none.
// `pieces`: every piece of [a, b), line breaks too.
function chosenIn(m, start, end, caret) {
  const out = m.select(start, end), around = caret > out.a && caret < out.b ? [out.a, out.b, caret] : [out.a, out.b];
  const pieces = m.piecesIn(out.a, out.b, around, true), takes = p => !p.st.line && !(p.space && p.st.unit < 0);
  let first = 0, last = pieces.length - 1;
  while (first <= last && !takes(pieces[first])) first++;
  while (last >= first && !takes(pieces[last])) last--;
  if (first > last) return null;
  const a = pieces[first].start, b = pieces[last].end, held = pieces.slice(first, last + 1);
  return { a, b, cuts: caret > a && caret < b ? [a, b, caret] : [a, b], pieces: held, chosen: held.filter(p => !p.st.line) };
}

// What every chosen character shows: { bits, mark, color, space (a space only), unit (in a unit) } each. The bar asks
// this for each of its buttons in one draw, so the last answer is kept.
let lastLooks = null;
export function looksIn(value, range, { defs } = {}) {
  const m = modelOf(String(value ?? ""), defs ?? null), { start, end } = range;
  if (lastLooks?.model === m && lastLooks.start === start && lastLooks.end === end) return lastLooks.looks;
  const found = chosenIn(m, start, end, -1);
  const looks = !found ? [] : found.chosen.map(p => {
    const f = shown(p.st, p.own);
    return { bits: f.bits, mark: f.mark, color: f.color, space: p.space, unit: p.st.unit >= 0 };
  });
  lastLooks = { model: m, start, end, looks };
  return looks;
}

// The new own formatting of a chosen piece for `op`, or null when it keeps its own; pieces of one style share one. A
// mark is put on every character unless every one has it already, when it comes off them all.
function changeFor(op, chosen) {
  const of = changeOf(op, chosen);
  if (!of) return null;
  const made = new Map();
  return p => {
    if (!made.has(p.st)) made.set(p.st, of(p.st));
    return made.get(p.st);
  };
}

// A new format object: formats carry the keys worked out for them, so none is copied.
const formatWith = (f, { bits = f.bits, mark = f.mark, color = f.color }) => ({ bits, mark, color });

function changeOf(op, chosen) {
  if (op.color !== undefined) {
    const color = op.color === "default" ? null : op.color;
    return st => (st.own.color === color ? null : formatWith(st.own, { color }));
  }
  if (op.mark === "highlight") {
    const on = op.on ?? !chosen.every(p => shown(p.st, p.own).mark !== null);
    return st => {
      if (on) return shown(st, st.own).mark !== null ? null : formatWith(st.own, { mark: "" });
      return st.own.mark === null ? null : formatWith(st.own, { mark: null });
    };
  }
  const bit = MARK_BITS[op.mark];
  if (!bit) return null;
  const counted = chosen.filter(p => (bit === CODE ? p.st.unit < 0 : !(p.space && bit & LOOSE_BITS)));
  if (!counted.length) return null;
  const on = op.on ?? !counted.every(p => shown(p.st, p.own).bits & bit);
  return st => {
    if (bit === CODE && st.unit >= 0) return null;
    const bits = on ? st.own.bits | bit : st.own.bits & ~bit;
    return bits === st.own.bits ? null : formatWith(st.own, { bits });
  };
}

// Whether a chosen piece's new formatting loses the mark of span `sp` around it.
export function loses(sp, own) {
  if (sp.kind !== "html") return !(own.bits & KIND_BITS[sp.kind]);
  if (sp.tag === "mark") return own.mark === null;
  if (sp.tag === "span") return own.color === null;
  return !(own.bits & TAG_BITS[sp.tag]);
}

// [L, R) grown until every span that crosses it, every formatting run that touches it (so runs join), every formatting
// span around it that a changed piece leaves and every code span it reaches lie wholly inside or wholly around it.
function stretchOf(m, changed) {
  let L = Infinity, R = -Infinity;
  for (const p of changed) {
    const unit = p.st.unit >= 0 ? m.spans[p.st.unit] : null;
    L = Math.min(L, unit ? unit.start : p.start);
    R = Math.max(R, unit ? unit.end : p.end);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const sp of m.spans) {
      if (sp.start > R) break;
      if (sp.end < L || (sp.start >= L && sp.end <= R)) continue;
      const role = m.roles[sp.id], overlaps = sp.end > L && sp.start < R;
      let take;
      if (role === FORMAT) {
        const around = sp.from <= L && sp.to >= R;
        take = !around || sp.kind === "code" || sp.from === L || sp.to === R || changed.some(p => p.start >= sp.from && p.end <= sp.to && loses(sp, p.next));
      } else if (role === BOX) take = overlaps && !(sp.from <= L && R <= sp.to);
      else take = overlaps;
      if (!take) continue;
      L = Math.min(L, sp.start);
      R = Math.max(R, sp.end);
      grew = true;
    }
  }
  while (L > 0 && m.shownDelimiter(L - 1)) L--;
  while (R < m.s.length && m.shownDelimiter(R)) R++;
  return { L, R };
}

// The pieces and spans of [L, R) as a tree of items: ITEM_CHAR { p }, ITEM_BOX { open, close, src, children },
// ITEM_UNIT and ITEM_KEPT { src, at (where it starts), pieces (inside it) }. Spans in `dead` are left out, a box's
// children staying; `closes` gives boxes other closing marks. A piece marked `lead` goes before a span starting where it
// does.
function itemsOf(m, L, R, pieces, { dead = null, closes = null } = {}) {
  const s = m.s, parts = m.spans.filter(sp => m.roles[sp.id] !== FORMAT && sp.start >= L && sp.end <= R);
  let pi = 0, si = 0;
  const past = end => {
    const first = pi;
    while (pi < pieces.length && pieces[pi].start < end) pi++;
    while (si < parts.length && parts[si].start < end) si++;
    return pieces.slice(first, pi);
  };
  const before = until => pi < pieces.length && (pieces[pi].start < until || (pieces[pi].lead && pieces[pi].start === until));
  const level = hi => {
    const items = [];
    for (;;) {
      const sp = si < parts.length && parts[si].start < hi ? parts[si] : null, until = sp ? sp.start : hi;
      while (before(until)) items.push({ type: ITEM_CHAR, p: pieces[pi++] });
      if (!sp) return items;
      si++;
      const role = m.roles[sp.id], src = s.slice(sp.start, sp.end), gone = dead?.has(sp.id);
      if (role === BOX) {
        const children = level(sp.to);
        past(sp.end);
        if (gone) items.push(...children);
        else items.push({ type: ITEM_BOX, open: s.slice(sp.start, sp.from), close: closes?.get(sp.id) ?? s.slice(sp.to, sp.end), src, children });
        continue;
      }
      if (gone) {
        past(sp.end);
        continue;
      }
      const held = past(sp.end);
      items.push({ type: role === UNIT && held.length ? ITEM_UNIT : ITEM_KEPT, src, at: sp.start, pieces: held });
    }
  };
  return level(R);
}

const formatOf = p => p.next ?? p.own;
const ranked = keys => keys.sort((x, y) => RANK[x[0]] - RANK[y[0]]);
const beyond = (keys, outer) => (outer.size ? keys.filter(k => !outer.has(k)) : keys);

// The keys of the marks every character and unit among `items` (inside boxes too) has beyond `outer`, a space's loose
// keys left out; null when they hold none.
function sharedKeys(items, outer) {
  let strict = null, loose = null;
  const visit = list => {
    for (const it of list) {
      if (it.type === ITEM_BOX) visit(it.children);
      if (it.type !== ITEM_CHAR && it.type !== ITEM_UNIT) continue;
      const p = it.type === ITEM_CHAR ? it.p : it.pieces[0], keys = beyond(keysOf(formatOf(p)), outer);
      const hard = keys.filter(k => !isLoose(k));
      strict = strict === null ? hard : strict.filter(k => hard.includes(k));
      if (it.type === ITEM_CHAR && p.space) continue;
      const soft = keys.filter(isLoose);
      loose = loose === null ? soft : loose.filter(k => soft.includes(k));
    }
  };
  visit(items);
  return strict === null ? null : ranked([...strict, ...(loose ?? [])]);
}

// Writes the items as events: text, marks opened and closed (each pair markdown or tags), code runs, and the points
// where the selection and the caret go.
class Writer {
  // `escape`: the markup characters of the text are escaped. `first` and `last`: the pieces the selection starts and
  // ends on; `caret` the piece the caret stands before.
  constructor(marks, escape, first, last, caret) {
    this.events = [];
    this.code = null;
    this.marks = marks;
    this.escape = escape;
    this.first = first;
    this.last = last;
    this.caret = caret;
  }

  flushCode() {
    if (!this.code) return;
    this.events.push({ t: CODE_RUN, content: this.code.content, points: this.code.points });
    this.code = null;
  }

  text(s) {
    if (!s) return;
    this.flushCode();
    const lastEvent = this.events[this.events.length - 1];
    if (lastEvent?.t === TEXT) lastEvent.s += s;
    else this.events.push({ t: TEXT, s });
  }

  point(which) {
    if (this.code) this.code.points.push([this.code.content.length, which]);
    else this.events.push({ t: POINT, which });
  }

  open(key, stack) {
    this.flushCode();
    const pair = { key, md: this.marks !== AS_TAGS && Boolean(DELIMS[key]) };
    stack.push(pair);
    this.events.push({ t: OPEN, key, pair });
  }

  close(stack) {
    this.flushCode();
    const pair = stack.pop();
    this.events.push({ t: CLOSE, key: pair.key, pair });
  }

  // The keys each item asks for beyond `outer`, null for one that asks for none (shown as it is wherever the marks
  // around it stand). A space takes a loose key only when the solid items on both sides of it have it, so a run never
  // starts or ends on a space.
  wantsOf(items, outer) {
    const space = it => it.type === ITEM_CHAR && it.p.space;
    const wants = items.map(it => {
      if (it.type === ITEM_BOX) return sharedKeys(it.children, outer);
      if (it.type === ITEM_KEPT) return null;
      const keys = beyond(keysOf(formatOf(it.type === ITEM_CHAR ? it.p : it.pieces[0])), outer);
      return space(it) && keys.some(isLoose) ? keys.filter(k => !isLoose(k)) : keys;
    });
    const solid = i => wants[i] !== null && !space(items[i]);
    for (let i = 0; i < items.length; i++) {
      if (!space(items[i])) continue;
      let before = i - 1, after = i + 1;
      while (before >= 0 && !solid(before)) before--;
      while (after < items.length && !solid(after)) after++;
      if (before < 0 || after >= items.length) continue;
      const both = wants[before].filter(k => isLoose(k) && wants[after].includes(k));
      if (both.length) wants[i] = ranked([...wants[i], ...both]);
    }
    return wants;
  }

  // Marks open in order and close in reverse: before an item, the marks it does not have close (with those opened
  // after them), and the ones it lacks open, those that run on furthest first.
  level(items, outer) {
    const wants = this.wantsOf(items, outer), stack = [], held = [];
    const reach = (i, key) => {
      let n = 0;
      for (let j = i; j < items.length && (wants[j] === null || wants[j].includes(key)); j++) if (wants[j] !== null) n++;
      return n;
    };
    for (let i = 0; i < items.length; i++) {
      const want = wants[i];
      if (want === null) {
        held.push(items[i]);
        continue;
      }
      let k = 0;
      while (k < stack.length && want.includes(stack[k].key)) k++;
      while (stack.length > k) this.close(stack);
      if (held.length) {
        for (const h of held) this.kept(h, outer, stack);
        held.length = 0;
      }
      if (stack.length < want.length) {
        const missing = want.filter(key => !stack.some(pair => pair.key === key));
        if (missing.length > 1) missing.sort((x, y) => reach(i, y) - reach(i, x) || RANK[x[0]] - RANK[y[0]]);
        for (const key of missing) this.open(key, stack);
      }
      this.emit(items[i], outer, stack);
    }
    while (stack.length) this.close(stack);
    for (const h of held) this.kept(h, outer, stack);
  }

  // A line break, a point comment or a tag that draws nothing, as written; the caret may stand before or after it. A
  // link or comment showing no character of its own is written as it is.
  kept(it, outer, stack) {
    if (it.type === ITEM_BOX) return this.emit(it, outer, stack);
    if (it.pieces.includes(this.caret)) this.point("caret");
    this.text(it.src);
    if (it.pieces.includes(this.last)) this.point("end");
  }

  emit(it, outer, stack) {
    if (it.type === ITEM_BOX) {
      this.text(it.open);
      this.level(it.children, stack.length ? new Set([...outer, ...stack.map(pair => pair.key)]) : outer);
      return this.text(it.close);
    }
    if (it.type === ITEM_UNIT) {
      if (it.pieces.includes(this.first)) this.point("start");
      const inside = it.pieces.includes(this.caret) ? this.caret.start - it.at : -1;
      if (inside < 0) this.text(it.src);
      else {
        this.text(it.src.slice(0, inside));
        this.point("caret");
        this.text(it.src.slice(inside));
      }
      if (it.pieces.includes(this.last)) this.point("end");
      return;
    }
    const p = it.p, now = formatOf(p), was = p.own.bits & CODE;
    if (now.bits & CODE) {
      this.code ??= { content: "", points: [] };
      if (p === this.caret) this.point("caret");
      if (p === this.first) this.point("start");
      this.code.content += was ? p.source : p.text;
      if (p === this.last) this.point("end");
      return;
    }
    this.flushCode();
    if (p === this.caret) this.point("caret");
    if (p === this.first) this.point("start");
    const plain = was ? p.text : p.source;
    this.text(this.escape && (p.verbatim || was) ? plain.replace(SPECIALS, "\\$&") : plain);
    if (p === this.last) this.point("end");
  }

  finish() {
    this.flushCode();
    return this.events;
  }
}

function rendered(e) {
  if (e.t === TEXT) return e.s;
  if (e.t === OPEN) return openOf(e.key, e.pair.md);
  if (e.t === CLOSE) return closeOf(e.key, e.pair.md);
  if (e.t === CODE_RUN) return fenced(e.content).text;
  return "";
}

// Markdown delimiters stay only where CommonMark reads them as written: a run of them opens or closes on the side it
// should, never runs into another delimiter of its character, and (NO_TWO_SIDED) never could do both. The rest become
// tags.
function settle(events, before, after, marks) {
  for (let again = true; again;) {
    again = false;
    const strs = events.map(rendered);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if ((e.t !== OPEN && e.t !== CLOSE) || !e.pair.md) continue;
      const ch = DELIMS[e.key][0], same = j => (events[j].t === OPEN || events[j].t === CLOSE) && events[j].pair.md && DELIMS[events[j].key][0] === ch;
      let lo = i, hi = i;
      while (lo > 0 && (strs[lo - 1] === "" || same(lo - 1))) lo--;
      while (hi < events.length - 1 && (strs[hi + 1] === "" || same(hi + 1))) hi++;
      let opens = 0, closes = 0;
      for (let j = lo; j <= hi; j++) if (same(j)) events[j].t === OPEN ? opens++ : closes++;
      let prev = before, next = after;
      for (let j = lo - 1; j >= 0; j--) if (strs[j]) { prev = lastChar(strs[j]); break; }
      for (let j = hi + 1; j < events.length; j++) if (strs[j]) { next = firstChar(strs[j]); break; }
      const p = sideOf(prev), n = sideOf(next);
      const left = n !== BY_SPACE && (n !== BY_PUNCTUATION || p !== BY_WORD), right = p !== BY_SPACE && (p !== BY_PUNCTUATION || n !== BY_WORD);
      const clash = (ch === "~" && opens + closes > 1) || (opens > 0 && closes > 0 && e.t === OPEN) || prev === ch || next === ch || prev === "\\";
      const fits = e.t === OPEN ? left : right;
      if (clash || !fits || (marks === NO_TWO_SIDED && left && right)) {
        e.pair.md = false;
        again = true;
      }
    }
  }
}

function render(events) {
  let out = "";
  const at = { start: -1, end: -1, caret: -1 };
  for (const e of events) {
    if (e.t === POINT) at[e.which] = out.length;
    else if (e.t === CODE_RUN) {
      const f = fenced(e.content);
      for (const [x, which] of e.points) at[which] = out.length + f.lead + x;
      out += f.text;
    } else out += rendered(e);
  }
  return { out, at };
}

// What a piece of style `st` with own formatting `own` shows, as a string to compare, and the same with what a space
// shows either way left out. Kept on `own`, which belongs to one style: st.own, or changeFor's answer for st.
function keyOf(st, own) {
  if (own.key === undefined) {
    const f = shown(st, own);
    own.key = st.line ? `${st.line}\n${st.scope}` : `${f.bits}|${f.mark ?? "-"}|${f.color ?? "-"}|${st.scope}`;
    own.looseKey = st.line ? own.key : `${f.bits & ~LOOSE_BITS}|${f.mark ?? "-"}|${st.scope}`;
  }
  return own.key;
}

const within = (sp, lo, hi) => sp.start >= lo && sp.end <= hi;
const SPAN_DATA = ["kind", "url", "title", "note", "tag", "color", "alt"];
// Typing in a picture's text changes its alt, and in an addressed link its address: in a model of typed text those
// are the text, which is compared as text.
const TYPED_DATA = ["kind", "title", "note", "tag", "color"];
const sameData = (m, x, y) => (m.boxes
  ? TYPED_DATA.every(k => x[k] === y[k]) && (addressed(m.s, x) || x.url === y.url)
  : SPAN_DATA.every(k => x[k] === y[k]));

// Whether the spans of `after` outside its stretch [L, L + len) are those of `m` outside [L, R), moved by the change
// of length: nothing outside the stretch reads differently, and nothing reaches into it but the spans around it.
function sameOutside(m, after, L, R, len) {
  // At an insertion point (L === R) a span that ends there stays before the new text, one that starts there goes after
  // it; text that shows from a span's start or up to its end (a point comment, an address) goes with that edge.
  const delta = len - (R - L), right = x => (x < R ? x : x + delta), left = x => (x <= L ? x : x + delta);
  const fromOf = sp => (sp.from === sp.start ? right(sp.from) : left(sp.from)), toOf = sp => (sp.to === sp.end ? left(sp.to) : right(sp.to));
  const old = m.spans, now = after.spans;
  let i = 0, j = 0;
  for (;;) {
    while (i < old.length && within(old[i], L, R)) i++;
    while (j < now.length && within(now[j], L, L + len)) j++;
    if (i >= old.length || j >= now.length) return i >= old.length && j >= now.length;
    const x = old[i++], y = now[j++];
    if (y.start < L + len && y.end > L && !(y.start < L && y.end > L + len)) return false;
    if (right(x.start) !== y.start || left(x.end) !== y.end || fromOf(x) !== y.from || toOf(x) !== y.to) return false;
    if (!sameData(m, x, y) || (x.noteAt !== undefined && right(x.noteAt) !== y.noteAt)) return false;
  }
}

// The point comments that lie in [lo, hi).
export function pointsIn(model, lo, hi) {
  const spans = model.spans;
  let first = 0, last = spans.length, n = 0;
  while (first < last) {
    const mid = (first + last) >> 1;
    if (spans[mid].start < lo) first = mid + 1;
    else last = mid;
  }
  for (let i = first; i < spans.length && spans[i].start < hi; i++) if (spans[i].kind === "point" && spans[i].end <= hi) n++;
  return n;
}

// Whether `next`, the value with [L, R) rewritten as `len` characters, shows what was asked: outside the stretch the
// same; inside it the same text and `points` point comments, each character with the formatting its piece asks for (any,
// for a piece marked `free`; none showing, for one marked `unseen`).
export function readsBack(m, next, L, R, len, written, defs, points = pointsIn(m, L, R)) {
  const after = modelOf(next, defs, m.boxes), end = L + len, pieces = written.some(p => p.unseen) ? written.filter(p => !p.unseen) : written;
  if (!sameOutside(m, after, L, R, len) || pointsIn(after, L, end) !== points) return false;
  const runs = after.runs, first = after.runAfter(L), shownOf = r => (r.verbatim ? next.slice(Math.max(r.start, L), Math.min(r.end, end)) : r.text);
  let text = "", got = "";
  for (const p of pieces) text += p.text;
  for (let k = first; k < runs.length && runs[k].start < end; k++) got += shownOf(runs[k]);
  if (text !== got) return false;
  let i = 0, k = first, x = 0, wantEnd = pieces.length ? pieces[0].text.length : 0, gotEnd = k < runs.length ? shownOf(runs[k]).length : 0;
  while (i < pieces.length && k < runs.length && runs[k].start < end) {
    const y = Math.min(wantEnd, gotEnd), w = pieces[i], wf = formatOf(w), g = after.styleOf(runs[k].spans);
    if (y > x && !w.free && keyOf(w.st, wf) !== keyOf(g, g.own)) {
      if (!ALL_SPACE.test(text.slice(x, y)) || wf.looseKey !== g.own.looseKey) return false;
    }
    x = y;
    if (wantEnd === y && ++i < pieces.length) wantEnd += pieces[i].text.length;
    if (gotEnd === y && ++k < runs.length && runs[k].start < end) gotEnd += shownOf(runs[k]).length;
  }
  return true;
}

// -> { value, start, end, caret } with `op` applied over `range` of `value`, the selection on the same characters and
// `caret` (an offset inside it) where it was among them; null when nothing changes, or when no way of writing it reads
// back as asked. `op`: { mark: "bold" | "italic" | "strike" | "underline" | "code" | "highlight", on? } (without `on`, on
// unless every character has it) or { color: a name, a hex colour, or "default" for none }. `defs`: the document's link
// reference definitions.
export function restyle(value, range, op, { defs, caret = -1 } = {}) {
  const s = String(value ?? ""), known = defs ?? null, m = modelOf(s, known), found = chosenIn(m, range.start, range.end, caret);
  if (!found) return null;
  const { a, b, cuts, chosen } = found, change = changeFor(op, chosen), next = p => {
    const f = change(p);
    return f && !sameFormat(f, p.own) ? f : null;
  };
  if (!change) return null;
  const changed = [];
  for (const p of chosen) if ((p.next = next(p))) changed.push(p);
  if (!changed.length) return null;
  const { L, R } = stretchOf(m, changed);
  // The pieces of [L, R): those of the selection as they are, when the stretch holds all of it.
  const whole = L <= a && R >= b, pieces = whole ? [...m.piecesIn(L, a, [], true), ...found.pieces, ...m.piecesIn(b, R, [], true)] : m.piecesIn(L, R, cuts, true);
  let first = null, last = null, caretPiece = null;
  for (const p of pieces) {
    p.source = s.slice(p.start, p.end);
    if (p.st.line || p.start < a || p.end > b) continue;
    if (!whole) p.next = next(p);
    first ??= p;
    last = p;
    if (p.start === caret) caretPiece = p;
  }
  const out = rewrite(m, L, R, pieces, { first, last, caret: caretPiece, defs: known });
  if (!out) return null;
  const { at, delta } = out, head = chosen[0], tail = chosen[chosen.length - 1];
  const start = head.start < L ? head.start : L + at.start, end = tail.end > R ? tail.end + delta : L + at.end;
  const moved = caret < 0 ? -1 : caret < L ? caret : caret >= R ? caret + delta : at.caret >= 0 ? L + at.caret : start;
  return { value: out.value, start, end, caret: moved };
}

// [L, R) of the model's value written afresh from `pieces` (every piece of it that shows, each with the formatting it
// asks for), tried in the ways of ATTEMPTS until one reads back. `first`, `last` and `caret` are pieces whose places
// come back in `at` ({ start, end, caret }, offsets from L, -1 for none); `points`, `dead` and `closes` as readsBack
// and itemsOf take them. -> { value, at, delta (the change of length) }, or null when no way reads back.
export function rewrite(m, L, R, pieces, { first = null, last = null, caret = null, defs = null, points, dead, closes } = {}) {
  const s = m.s, items = itemsOf(m, L, R, pieces, { dead, closes }), outer = new Set();
  for (const sp of m.spans) {
    if (sp.start >= L) break;
    if (m.roles[sp.id] === FORMAT && sp.from <= L && sp.to >= R && !dead?.has(sp.id)) outer.add(keyOfSpan(sp));
  }
  const before = lastChar(s.slice(Math.max(0, L - 2), L)), after = R < s.length ? firstChar(s.slice(R)) : "";
  for (const [marks, escape] of ATTEMPTS) {
    const w = new Writer(marks, escape, first, last, caret);
    w.level(items, outer);
    const events = w.finish();
    if (marks !== AS_TAGS) settle(events, before, after, marks);
    const { out, at } = render(events), next = s.slice(0, L) + out + s.slice(R);
    if (readsBack(m, next, L, R, out.length, pieces, defs, points)) return { value: next, at, delta: out.length - (R - L) };
  }
  return null;
}
