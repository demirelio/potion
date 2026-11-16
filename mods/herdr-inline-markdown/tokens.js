// The inline tokens of the edited text block's field: the field keeps the raw markdown, and each formatted word is
// one atomic token that holds its hidden marks and draws only what Reading shows, in Reading's formatting. Offsets are
// UTF-16 indices into the field's value.
import { graphemeEnd } from "./inline.js";
import { POINT } from "./comments.js";

const LETTER = 0, GAP = 1, SOLO = 2, LONE = 3;
const BACK = 0, FORWARD = 1, MIDDLE = 2, CONTROL = 3;
const ICON = 1, POINTED = 2;
const CARET = 0, START = 1, END = 2;
// A label must not be empty: tokens that draw nothing carry an invisible one.
const EMPTY = "\u{200b}";
// What the field's text estimates count for a drawn point comment or picture icon: one character.
const MARKER = "\u{2022}";
const FIRST_CAPACITY = 64;
const SPACE = /\s/;
// What the field shows as typed between words: spaces, and the control characters no token may hold.
const SEPARATORS = /[\s\p{Cc}]+/gu;
const LOOKS = { strong: "b", em: "i", strike: "s", code: "c", link: "l", comment: "h", highlight: "h", image: "p" };
const TAG_LOOKS = { strong: "b", b: "b", em: "i", i: "i", u: "u", s: "s", del: "s", strike: "s" };
const LOOK_ORDER = "bisuclhp";
const LOOK_LETTERS = /^[bisuclhp]*/;
const LOOK_NAMES = { b: "bold", i: "italic", s: "strike", u: "underline", c: "code", l: "link", h: "highlight", p: "picture" };
const NARROW = new Set("fijlrtI.,:;'!|` ");
const WIDE = new Set("mwMW");
const CODE_WIDTH = 1.25;

// Herdr refuses a token whose text or label holds one (Rust's char::is_control, and the two Unicode line separators).
const isControl = c => c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
const isSpace = c => c === 0x20 || (c >= 0x80 && SPACE.test(String.fromCharCode(c)));

function hasControl(s, from, to) {
  for (let i = from; i < to; i++) if (isControl(s.charCodeAt(i))) return true;
  return false;
}

// Whether offset b of s falls inside a character, where Herdr's field refuses a token edge.
function cuts(s, b) {
  if (b <= 0 || b >= s.length) return false;
  let p = b - 1;
  const c = s.charCodeAt(p);
  if (c >= 0xdc00 && c <= 0xdfff && p > 0) p--;
  return graphemeEnd(s, p) > b;
}

function grown(array) {
  const next = new array.constructor(array.length * 2);
  next.set(array);
  return next;
}

// The value tiled into atoms: shown letters of one run with the hidden marks that go with them (LETTER), a stretch the
// field shows as typed (GAP: spaces, control characters), a shown line break the field cannot draw (SOLO), or hidden
// marks that go with no character (LONE). A letter atom is split into its characters only where the caret needs them.
// Kept in typed arrays: an object costs microseconds in Herdr's runtime.
class Atoms {
  constructor(value) {
    this.value = value;
    this.count = 0;
    this.start = new Int32Array(FIRST_CAPACITY);
    this.end = new Int32Array(FIRST_CAPACITY);
    this.from = new Int32Array(FIRST_CAPACITY);
    this.to = new Int32Array(FIRST_CAPACITY);
    this.kind = new Uint8Array(FIRST_CAPACITY);
    this.flags = new Uint8Array(FIRST_CAPACITY);
    this.look = new Int32Array(FIRST_CAPACITY);
    this.texts = [];
  }

  // [start, end) is the atom's source, [from, to) its shown character's; `text` what it shows when not its source.
  add(start, end, from, to, kind, look, text, flags) {
    if (this.count === this.start.length) {
      for (const name of ["start", "end", "from", "to", "kind", "flags", "look"]) this[name] = grown(this[name]);
    }
    const k = this.count++;
    this.start[k] = start; this.end[k] = end; this.from[k] = from; this.to[k] = to;
    this.kind[k] = kind; this.look[k] = look; this.flags[k] = flags;
    if (text !== null) this.texts[k] = text;
    return k;
  }

  shown(k) {
    return this.texts[k] ?? this.value.slice(this.from[k], this.to[k]);
  }

  // The atom holding offset x, or -1 before the first.
  at(x) {
    let lo = 0, hi = this.count - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.start[mid] <= x) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }
}

// A look is a name of letters in LOOK_ORDER, then a mark tag's colour after an "m" and a text colour after an "@":
// "bi", "l", "hm#fef08a", "b@red". The characters of a run share one ids array, so its look is worked out once.
const lookLetters = name => LOOK_LETTERS.exec(name)[0];

class Looks {
  constructor(spans) {
    this.spans = spans;
    this.names = [""];
    this.index = new Map([["", 0]]);
    this.byIds = new Map();
  }

  of(ids) {
    let k = this.byIds.get(ids);
    if (k !== undefined) return k;
    const name = this.nameOf(ids);
    k = this.index.get(name);
    if (k === undefined) {
      k = this.names.length;
      this.names.push(name);
      this.index.set(name, k);
    }
    this.byIds.set(ids, k);
    return k;
  }

  // The innermost highlight and text colour win; a mark with no colour of its own is the highlight.
  nameOf(ids) {
    const on = new Set();
    let mark = "", bare = false, color = "";
    for (const id of ids) {
      const sp = this.spans[id];
      if (sp.kind === "html") {
        if (sp.tag === "mark") {
          bare = !sp.color;
          mark = sp.color ? `m${sp.color}` : "";
        } else if (sp.tag === "span") color = `@${sp.color}`;
        else if (TAG_LOOKS[sp.tag]) on.add(TAG_LOOKS[sp.tag]);
      } else if (LOOKS[sp.kind]) on.add(LOOKS[sp.kind]);
    }
    if (bare) on.add("h");
    let name = "";
    for (const letter of LOOK_ORDER) if (on.has(letter)) name += letter;
    return name + mark + color;
  }

  hasPicture(k) {
    return lookLetters(this.names[k]).includes("p");
  }
}

// The id of the innermost span whose marks hold each hidden offset, -1 for none. Spans come outer first.
function markOwners(n, spans) {
  const owner = new Int32Array(n).fill(-1);
  for (const sp of spans) {
    if (sp.from === sp.to) owner.fill(sp.id, sp.start, sp.end);
    else {
      owner.fill(sp.id, sp.start, sp.from);
      owner.fill(sp.id, sp.to, sp.end);
    }
  }
  return owner;
}

// A span's opening marks go with the character after them and its closing marks with the one before; a hard break's
// are the other way round, as the break itself is never in a token.
function sideOf(s, owner, spans, i) {
  if (isControl(s.charCodeAt(i))) return CONTROL;
  const o = owner[i], sp = o < 0 ? null : spans[o];
  if (!sp || sp.from === sp.to) return MIDDLE;
  const opening = i < sp.from;
  if (sp.kind === "break") return opening ? BACK : FORWARD;
  return opening ? FORWARD : BACK;
}

function loneFlags(spans, o) {
  const kind = o < 0 ? null : spans[o].kind;
  return kind === "point" ? POINTED : kind === "image" ? ICON : 0;
}

class Builder {
  constructor(value, inline, everyWord) {
    this.s = value;
    this.inline = inline;
    this.everyWord = everyWord;
    this.spans = inline.spans;
    this.owner = markOwners(value.length, this.spans);
    this.atoms = new Atoms(value);
    this.looks = new Looks(this.spans);
    this.pictured = new Set();
  }

  // The hidden stretch [h0, h1) between two shown characters: its leading closing marks join the letter before, its
  // trailing opening marks the letter after (returned: where that letter's atom starts), the rest are atoms of their own.
  gap(h0, h1, letterNext) {
    if (h0 >= h1) return h1;
    const { s, owner, spans, atoms } = this, last = atoms.count - 1;
    let k1 = h0, k2 = h1;
    if (last >= 0 && atoms.kind[last] === LETTER && atoms.end[last] === h0) {
      while (k1 < h1 && sideOf(s, owner, spans, k1) === BACK) k1++;
      atoms.end[last] = k1;
    }
    if (letterNext) while (k2 > k1 && sideOf(s, owner, spans, k2 - 1) === FORWARD) k2--;
    for (let i = k1; i < k2;) {
      const control = isControl(s.charCodeAt(i)), o = owner[i];
      let j = i + 1;
      while (j < k2 && isControl(s.charCodeAt(j)) === control && (control || owner[j] === o)) j++;
      atoms.add(i, j, i, j, control ? GAP : LONE, 0, null, control ? 0 : loneFlags(spans, o));
      i = j;
    }
    return k2;
  }

  firstIsLetter(r) {
    if (!r.verbatim) return !hasControl(this.s, r.start, r.end) && r.text !== "\n";
    const c = this.s.charCodeAt(r.start);
    return !isControl(c) && !isSpace(c);
  }

  iconFor(ids, look) {
    if (!this.looks.hasPicture(look)) return 0;
    for (const id of ids) {
      if (this.spans[id].kind !== "image" || this.pictured.has(id)) continue;
      this.pictured.add(id);
      return ICON;
    }
    return 0;
  }

  // Run r as stretches of letters and of spaces; the first letter's atom starts at `lead`, where the opening marks
  // before it begin.
  run(r, lead) {
    const { s, atoms } = this, look = this.looks.of(r.spans);
    if (!r.verbatim) {
      if (hasControl(s, r.start, r.end)) return atoms.add(r.start, r.end, r.start, r.end, GAP, look, null, 0);
      if (r.text === "\n") return atoms.add(r.start, r.end, r.start, r.end, SOLO, look, null, 0);
      const text = hasControl(r.text, 0, r.text.length) ? " " : r.text;
      return atoms.add(lead, r.end, r.start, r.end, LETTER, look, text, this.iconFor(r.spans, look));
    }
    for (let i = r.start; i < r.end;) {
      SEPARATORS.lastIndex = i;
      const m = SEPARATORS.exec(s), from = m && m.index < r.end ? m.index : r.end;
      if (from > i) atoms.add(i === r.start ? lead : i, from, i, from, LETTER, look, null, this.iconFor(r.spans, look));
      if (from === r.end) break;
      i = Math.min(SEPARATORS.lastIndex, r.end);
      atoms.add(from, i, from, i, GAP, look, null, 0);
    }
    return atoms.count - 1;
  }

  build() {
    let pos = 0;
    for (const r of this.inline.runs) {
      const lead = this.gap(pos, r.start, this.firstIsLetter(r));
      this.run(r, lead);
      pos = r.end;
    }
    this.gap(pos, this.s.length, false);
    return this.finish();
  }

  // Words: runs of letters next to each other, with the spaces after them that joins() takes. One holding a formatted
  // character, one shown from other source text, or one carrying marks is a token, unless its edges would cut a
  // character. `tokenized` marks the atoms in tokens.
  finish() {
    const { s, atoms } = this, n = atoms.count, tokenized = new Uint8Array(n), wordStart = new Int32Array(n), wordEnd = new Int32Array(n);
    for (let k = 0; k < n;) {
      if (atoms.kind[k] !== LETTER) {
        tokenized[k] = atoms.kind[k] !== GAP && !cuts(s, atoms.start[k]) && !cuts(s, atoms.end[k]) ? 1 : 0;
        wordStart[k] = k;
        wordEnd[k] = k;
        k++;
        continue;
      }
      let j = k, rich = this.everyWord;
      for (; j < n && atoms.kind[j] === LETTER; j++) {
        rich ||= atoms.look[j] !== 0 || atoms.texts[j] !== undefined || atoms.start[j] < atoms.from[j] || atoms.end[j] > atoms.to[j];
      }
      const token = rich && !cuts(s, atoms.start[k]) && !cuts(s, atoms.end[j - 1]) ? 1 : 0;
      const last = token && j < n && this.joins(j) ? j : j - 1;
      for (let m = k; m <= last; m++) { tokenized[m] = token; wordStart[m] = k; wordEnd[m] = last; }
      k = last + 1;
    }
    return { value: s, atoms, looks: this.looks.names, tokenized, wordStart, wordEnd, addresses: this.addresses(), ...drawnOf(atoms, tokenized) };
  }

  // Spaces inside a formatted run (any spaces between a checked task's words) go with the word before them, so its
  // highlight, underline or line runs on across them.
  joins(k) {
    const { s, atoms } = this;
    return atoms.kind[k] === GAP && (atoms.look[k] !== 0 || this.everyWord) && !hasControl(s, atoms.start[k], atoms.end[k]) && !cuts(s, atoms.end[k]);
  }

  // Where an inline link's address can be typed: from just after its "(" to just before its ")".
  addresses() {
    const s = this.s, out = [];
    for (const sp of this.spans) {
      if (sp.kind === "link" && s.startsWith("](", sp.to) && s[sp.end - 1] === ")") out.push(sp.to + 2, sp.end - 1);
    }
    return out;
  }
}

function drawnAtom(atoms, k) {
  if (atoms.kind[k] === GAP) return atoms.shown(k);
  if (atoms.kind[k] !== LETTER) return atoms.flags[k] & (ICON | POINTED) ? MARKER : "";
  return (atoms.flags[k] & ICON ? MARKER : "") + atoms.shown(k);
}

// The text the field draws, and where each atom's drawing starts in it.
function drawnOf(atoms, tokenized) {
  const s = atoms.value, n = atoms.count, starts = new Int32Array(n + 1);
  let drawn = "", raw = 0, length = 0;
  for (let k = 0; k < n; k++) {
    starts[k] = length;
    if (!tokenized[k]) { length += atoms.end[k] - atoms.start[k]; continue; }
    const text = drawnAtom(atoms, k);
    drawn += s.slice(raw, atoms.start[k]) + text;
    raw = atoms.end[k];
    length += text.length;
  }
  starts[n] = length;
  return { drawn: drawn + s.slice(raw), drawnStarts: starts };
}

// -> the layout tokensFor and the estimates read: { value, drawn (the text the field draws), ... }. `inline` is
// parseInline's answer for `value`. `everyWord` makes every word a token, as a checked task needs: the field draws no
// line through plain text.
export function richOf(value, inline, { everyWord = false } = {}) {
  return new Builder(String(value ?? ""), inline, everyWord).build();
}

// Where a selection end at x may stand: never inside a token. Inside a letter's marks it goes to the side the marks
// face (a caret before a word's opening marks stays outside its run); inside an escape or entity, before it (after it
// for a selection's end); inside a character, to its edge. Between two spaces of a word it stays: that word is split.
function snapped(r, x, side) {
  const { atoms, tokenized } = r, k = atoms.at(x);
  if (k < 0 || atoms.start[k] === x || x >= atoms.end[k] || !tokenized[k] || atoms.kind[k] === GAP) return x;
  if (atoms.kind[k] !== LETTER) return side === START ? atoms.start[k] : atoms.end[k];
  const from = atoms.from[k], to = atoms.to[k];
  if (x <= from) return atoms.start[k];
  if (x >= to) return atoms.end[k];
  if (atoms.texts[k] !== undefined) return side === END ? atoms.end[k] : atoms.start[k];
  let edge = x;
  for (let i = from; i < to;) {
    const j = graphemeEnd(r.value, i, to);
    if (x < j) {
      if (x !== i) edge = side === END ? j : i;
      break;
    }
    i = j;
  }
  return edge <= from ? atoms.start[k] : edge >= to ? atoms.end[k] : edge;
}

function made(s, start, end, id, label) {
  return { range: { start, end }, token: { id, text: s.slice(start, end), label } };
}

// A token's id names the look and length of each piece it draws, a picture's icon "P:0"; its label is what it shows.
class Drawing {
  constructor(looks) {
    this.looks = looks;
    this.parts = [];
    this.label = "";
    this.look = -1;
    this.count = 0;
  }

  add(text, look, icon) {
    if (icon || look !== this.look) this.close();
    if (icon) this.parts.push("P:0");
    this.look = look;
    this.count += text.length;
    this.label += text;
  }

  close() {
    if (this.look >= 0) this.parts.push(`${this.looks[this.look]}:${this.count}`);
    this.look = -1;
    this.count = 0;
  }

  id() {
    this.close();
    return this.parts.join(",");
  }
}

// One token of atoms a..b.
function tokenOf(r, a, b) {
  const { atoms } = r, s = r.value;
  if (atoms.kind[a] !== LETTER) {
    const f = atoms.flags[a];
    if (f & POINTED) return made(s, atoms.start[a], atoms.end[a], `N:${POINT.length}`, POINT);
    return made(s, atoms.start[a], atoms.end[a], f & ICON ? "P:0" : "E:0", EMPTY);
  }
  const d = new Drawing(r.looks);
  for (let k = a; k <= b; k++) d.add(atoms.shown(k), atoms.look[k], (atoms.flags[k] & ICON) !== 0);
  return made(s, atoms.start[a], atoms.end[b], d.id(), d.label);
}

// The characters of the letter and space atoms among a..b, the first and last of each letter atom with its marks:
// [{ start, end, text, look, icon }].
function lettersOf(r, a, b) {
  const { atoms } = r, s = r.value, out = [];
  for (let k = a; k <= b; k++) {
    if (atoms.kind[k] === GAP && r.tokenized[k]) {
      for (let i = atoms.start[k]; i < atoms.end[k];) {
        const j = graphemeEnd(s, i, atoms.end[k]);
        out.push({ start: i, end: j, text: s.slice(i, j), look: atoms.look[k], icon: false });
        i = j;
      }
      continue;
    }
    if (atoms.kind[k] !== LETTER) continue;
    const look = atoms.look[k], icon = (atoms.flags[k] & ICON) !== 0, from = atoms.from[k], to = atoms.to[k];
    if (atoms.texts[k] !== undefined) {
      out.push({ start: atoms.start[k], end: atoms.end[k], text: atoms.texts[k], look, icon });
      continue;
    }
    for (let i = from; i < to;) {
      const j = graphemeEnd(s, i, to);
      out.push({ start: i === from ? atoms.start[k] : i, end: j === to ? atoms.end[k] : j, text: s.slice(i, j), look, icon: icon && i === from });
      i = j;
    }
  }
  return out;
}

function letterToken(r, letters, i, j) {
  const d = new Drawing(r.looks);
  for (let m = i; m <= j; m++) d.add(letters[m].text, letters[m].look, letters[m].icon);
  return made(r.value, letters[i].start, letters[j].end, d.id(), d.label);
}

const touches = (start, end, x) => x >= start && x <= end;

// The first atom of the word that stays as typed because caret x is in a link's address (Cmd+K leaves it there), or -1.
function typedAt(r, x) {
  const { addresses, atoms, wordStart } = r;
  for (let i = 0; i < addresses.length; i += 2) {
    if (x >= addresses[i] && x <= addresses[i + 1]) return wordStart[atoms.at(x)];
  }
  return -1;
}

// -> { tokens, sel }: the field's tokens for selection `sel` (null: none known), each as set_value takes it ({ range,
// token: { id, text, label } }), and the selection moved off any token's inside. A word holding or touching an end of
// the selection is a token per letter, so the caret can stop between them; every other word is one token.
export function tokensFor(r, sel) {
  const { atoms, tokenized, wordEnd } = r, s = r.value, n = atoms.count, tokens = [];
  const caret = sel && sel.start === sel.end, typed = caret ? typedAt(r, sel.start) : -1;
  const a = sel ? (typed >= 0 ? sel.start : snapped(r, sel.start, caret ? CARET : START)) : -1;
  const b = sel ? (caret ? a : snapped(r, sel.end, END)) : -1;
  for (let k = 0; k < n; k++) {
    if (!tokenized[k] || k === typed) { k = wordEnd[k]; continue; }
    const last = wordEnd[k];
    if (atoms.kind[k] !== LETTER) { tokens.push(tokenOf(r, k, k)); continue; }
    const start = atoms.start[k], end = atoms.end[last];
    if (!sel || !(touches(start, end, a) || touches(start, end, b))) tokens.push(tokenOf(r, k, last));
    else {
      const letters = lettersOf(r, k, last);
      let unit = 0;
      for (let m = 0; m < letters.length; m++) {
        if (m < letters.length - 1 && cuts(s, letters[m].end)) continue;
        tokens.push(letterToken(r, letters, unit, m));
        unit = m + 1;
      }
    }
    k = last;
  }
  return { tokens, sel: sel ? { start: a, end: b } : null };
}

// Value offset x as an offset of the drawn text.
export function drawnOffset(r, x) {
  const { atoms, tokenized, drawnStarts } = r;
  if (x >= r.value.length) return drawnStarts[atoms.count];
  const k = atoms.at(x);
  if (k < 0) return 0;
  if (!tokenized[k] || atoms.kind[k] === GAP) return drawnStarts[k] + x - atoms.start[k];
  if (atoms.kind[k] !== LETTER || x <= atoms.from[k]) return drawnStarts[k];
  if (x >= atoms.to[k]) return drawnStarts[k + 1];
  if (atoms.texts[k] !== undefined) return drawnStarts[k];
  return drawnStarts[k] + (atoms.flags[k] & ICON ? MARKER.length : 0) + x - atoms.from[k];
}

// A rough width for a character, in average advances.
function widthOf(text) {
  const c = text.codePointAt(0);
  const ch = String.fromCodePoint(c);
  if (NARROW.has(ch)) return 0.55;
  if (WIDE.has(ch)) return 1.45;
  if (c >= 65 && c <= 90) return 1.25;
  if (c >= 48 && c <= 57) return 1.1;
  return c >= 0x1100 ? 2 : 1;
}

// The value offset a press at `share` (0 the left edge, 1 the right) across the token at `range` puts the caret at:
// the letter edge nearest to it, the letters taking their estimated widths.
export function pressedAt(r, range, share) {
  const { atoms, looks } = r, first = Math.max(0, atoms.at(range.start)), edges = [range.start], widths = [];
  let last = first;
  while (last + 1 < atoms.count && atoms.start[last + 1] < range.end) last++;
  for (const letter of lettersOf(r, first, last)) {
    if (letter.start < range.start || letter.end > range.end) continue;
    const code = lookLetters(looks[letter.look]).includes("c") ? CODE_WIDTH : 1;
    widths.push(widthOf(letter.text) * code + (letter.icon ? 1 : 0));
    edges.push(letter.end);
  }
  if (!widths.length) return share < 0.5 ? range.start : range.end;
  edges[edges.length - 1] = range.end;
  const total = widths.reduce((sum, w) => sum + w, 0), target = Math.max(0, Math.min(1, share)) * total;
  let best = 0, gap = target, at = 0;
  for (let i = 0; i < widths.length; i++) {
    at += widths[i];
    if (Math.abs(at - target) < gap) { gap = Math.abs(at - target); best = i + 1; }
  }
  return edges[best];
}

function lookOf(name) {
  const out = {}, letters = lookLetters(name), at = name.indexOf("@"), head = at >= 0 ? name.slice(0, at) : name;
  for (const letter of letters) out[LOOK_NAMES[letter]] = true;
  if (head.length > letters.length) out.mark = head.slice(letters.length + 1);
  if (at >= 0) out.color = name.slice(at + 1);
  return out;
}

// What a token draws, from its id and label: pieces { text, ...look } in order (`mark` a highlight's colour, `color` a
// text colour), { icon } for a picture's icon, and { text, point } for a point comment's marker.
export function piecesOf(id, label) {
  const out = [];
  let at = 0;
  for (const part of id.split(",")) {
    const colon = part.lastIndexOf(":"), name = part.slice(0, colon), n = Number(part.slice(colon + 1));
    if (name === "E") continue;
    if (name === "P") { out.push({ icon: true }); continue; }
    const text = label.slice(at, at + n);
    at += n;
    out.push(name === "N" ? { text, point: true } : { text, ...lookOf(name) });
  }
  return out;
}

export function sameTokens(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.range.start !== y.range.start || x.range.end !== y.range.end || x.token.id !== y.token.id || x.token.text !== y.token.text || x.token.label !== y.token.label) return false;
  }
  return true;
}
