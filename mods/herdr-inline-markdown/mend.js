// What a key leaves in the field of a paragraph, heading, item or quote, kept so that everything it did not delete
// shows as it did. The field edits the raw markdown, so a key can take a run's hidden marks along with a letter, or type
// something that makes hidden marks show. The field's own result is kept when it shows what it should; else the hidden
// marks the key took are put back where they still belong, and failing that the stretch around the key is written
// afresh as restyle.js writes one. Offsets are UTF-16 indices into the field's value.
import { diff } from "./blocks.js";
import { BOX, FORMAT, clusterEnd, clusterStart, formatInto, loses, modelOf, ownText, pointsIn, readsBack, rewrite, shown, spacedPieces } from "./restyle.js";

const LBR = 91, CR = 13, LF = 10, ASCII = 0x80;
const SPECIAL = /[\\`*_~[\]<>&!{}=]/;
const SPACES = " \t";

const formatOnly = f => ({ bits: f.bits, mark: f.mark, color: f.color });
const plain = () => ({ bits: 0, mark: null, color: null });

// The edit a key made: the range [at, at + removed) of `before` that `inserted` replaced, from the field's value before
// and after it and the caret or selection `known` before it ({ start, end, valid }). Backspace removes a range ending at
// the caret, Delete one starting there, typing goes in at it, typing over a selection replaces it; next to repeated
// characters the diff alone can't tell these apart. Between equal characters a deletion is a Backspace, unless `caret`,
// the field's caret after the key, stayed where it was: a Delete. Without a known caret, the diff.
export function editOf(before, after, known, caret) {
  const d = diff(before, after), grow = after.length - before.length;
  const fits = (at, removed) => {
    const end = at + removed, length = removed + grow;
    if (at < 0 || length < 0 || end > before.length || at > d.at) return false;
    return end >= d.at + d.removed || before.slice(end, d.at + d.removed) === after.slice(at + length, d.at + d.inserted.length);
  };
  if (known?.valid) {
    const { start, end } = known, back = [start + grow, -grow], on = [start, -grow];
    const tries = start < end ? [[start, end - start]] : grow > 0 ? [[start, 0]] : grow < 0 ? (caret === start ? [on, back] : [back, on]) : [];
    for (const [at, removed] of tries) if (fits(at, removed)) return { at, removed, inserted: after.slice(at, at + removed + grow) };
  }
  return d;
}

// The formatting and the links, comments and pictures of the spans whose source holds caret `at` inside it, not at an
// edge: what text typed there becomes part of. `kept`: a line break whose marks hold the caret (the field puts it
// after a hard break's backslash, at the end of the line), before which typed text goes.
function aroundAt(m, at, dead = null) {
  const format = plain(), boxes = [];
  let kept = null;
  for (const sp of m.spans) {
    if (sp.start >= at) break;
    if (sp.end <= at || dead?.has(sp.id)) continue;
    const role = m.roles[sp.id];
    if (role === FORMAT) formatInto(format, sp);
    else if (role === BOX) boxes.push(sp);
    else kept ??= sp;
  }
  return { format, boxes, kept };
}

// { bits, mark, color }: the formatting text typed at caret `at` of a field's `value` gets there. Typing right after a
// formatted word, or right before it, is plain.
export function formatAt(value, at, { defs } = {}) {
  return formatOnly(aroundAt(modelOf(String(value ?? ""), defs ?? null, true), at).format);
}

const scopeOf = (m, boxes) => boxes.map(sp => m.scopeOf(sp)).join("");

function showsIn(m, lo, hi) {
  if (lo >= hi) return false;
  const r = m.runs[m.runAfter(lo)];
  return Boolean(r) && r.start < hi;
}

// Two ASCII characters other than CR LF are never one character.
const asciiEdge = (s, x) => {
  const p = s.charCodeAt(x - 1), n = s.charCodeAt(x);
  return p < ASCII && n < ASCII && !(p === CR && n === LF);
};

function charStart(m, x) {
  const r = m.runs[m.runAfter(x)];
  if (!r || r.start >= x) return x;
  if (!r.verbatim) return r.start;
  return asciiEdge(m.s, x) ? x : clusterStart(m.s, r.start, x);
}

function charEnd(m, x) {
  const r = x > 0 ? m.runs[m.runAfter(x - 1)] : null;
  if (!r || r.start >= x || r.end <= x) return x;
  if (!r.verbatim) return r.end;
  return asciiEdge(m.s, x) ? x : clusterEnd(m.s, r.start, r.end, x);
}

// What removing [at, end) takes: whole characters, and whole spans that show nothing of their own (a point comment, a
// tag that draws nothing). -> { a, b } that range, `first` the style of the first character in it that shows (a line
// break not counted), and [from, to) where those characters begin and end.
function cutOf(m, at, end) {
  if (at >= end) return { a: at, b: at, first: null, from: -1, to: -1 };
  let a = charStart(m, at), b = charEnd(m, end), first = null, from = -1, to = -1;
  for (const sp of m.spans) {
    if (sp.start >= b) break;
    if (sp.from === sp.to && sp.end > a) {
      a = Math.min(a, sp.start);
      b = Math.max(b, sp.end);
    }
  }
  for (let k = m.runAfter(a); k < m.runs.length && m.runs[k].start < b; k++) {
    const r = m.runs[k], st = m.styleOf(r.spans);
    if (st.line) continue;
    first ??= st;
    if (from < 0) from = Math.max(r.start, a);
    to = Math.min(r.end, b);
  }
  return { a, b, first, from, to };
}

// The link, comment or picture that held every character typed over: the typed text stays in it.
function holderOf(m, cut) {
  let holder = null;
  for (const sp of m.spans) {
    if (sp.start > cut.from) break;
    if (m.roles[sp.id] === BOX && sp.from <= cut.from && cut.to <= sp.to) holder = sp;
  }
  return holder;
}

// The ids of the spans the cut leaves no character of: their marks go with them. The span holding the typed text, and
// those around it, stay.
function deadIn(m, cut, holder) {
  const dead = new Set(), { a, b } = cut;
  if (a >= b) return dead;
  for (const sp of m.spans) {
    if (sp.start >= b) break;
    if (sp.end <= a || (holder && sp.start <= holder.start && holder.end <= sp.end)) continue;
    if (!showsIn(m, sp.from, Math.min(a, sp.to)) && !showsIn(m, Math.max(b, sp.from), sp.to)) dead.add(sp.id);
  }
  return dead;
}

// The link, comment or picture holding the last character that shows before caret `at`, which a typing style that
// `stays` types into: a name typed over a clicked link goes on in it, although the caret stands after its marks.
function stayingIn(m, at) {
  const before = shownBefore(m, at);
  let holder = null;
  for (const sp of before ? m.spans : []) {
    if (sp.start > before.run.start) break;
    if (m.roles[sp.id] === BOX && sp.from <= before.run.start && before.run.end <= sp.to) holder = sp;
  }
  return holder;
}

const chainOf = (m, holder) => m.spans.filter(sp => m.roles[sp.id] === BOX && sp.start <= holder.start && holder.end <= sp.end);

// How typed text should show and where it goes: { format, scope (of the links and comments around it), slot (the offset
// of the value before the key it goes in at), lead (before a span starting there), holder }. Typed over a selection it
// takes the formatting of the first character that showed there, and stays in the link or comment that held all of
// them (its `holder`); typed at a caret it takes the typing style, else what is around it.
function typedOf(m, cut, at, style) {
  if (!cut.first) {
    const staying = style?.stays ? stayingIn(m, at) : null;
    if (staying) return { format: formatOnly(style), scope: scopeOf(m, chainOf(m, staying)), slot: Math.min(at, staying.to), lead: true, holder: staying };
    const { format, boxes, kept } = aroundAt(m, at, deadIn(m, cut, null));
    return { format: style ? formatOnly(style) : format, scope: scopeOf(m, boxes), slot: kept ? kept.start : at, lead: true, holder: null };
  }
  const holder = holderOf(m, cut), holds = sp => holder !== null && sp.start <= holder.start && holder.end <= sp.end;
  let slot = cut.a, lead = true;
  for (const sp of m.spans) {
    if (sp.start >= cut.a) break;
    if (sp.end <= cut.a || m.roles[sp.id] !== BOX || holds(sp)) continue;
    slot = sp.end;
    break;
  }
  if (holder && slot < holder.from) {
    slot = holder.from;
    lead = false;
  }
  return { format: formatOnly(shown(cut.first, cut.first.own)), scope: scopeOf(m, holder ? chainOf(m, holder) : []), slot, lead, holder };
}

// The typed text as pieces for the writer, at its slot. `free`: whatever formatting it gets will do.
function typedPieces(text, typed, free) {
  if (!text) return [];
  const st = { own: { ...typed.format }, inner: null, unit: -1, scope: typed.scope, line: false }, out = [];
  spacedPieces(text, 0, text.length, st, out);
  for (const p of out) {
    p.source = p.text;
    p.start = p.end = typed.slot;
    p.lead = typed.lead;
    p.free = free;
  }
  return out;
}

// The characters of [L, R) that the cut leaves, as pieces, with the typed ones among them. Spaces left opening a line
// after a line break are `unseen`: the break's marks take them, and they can't show. A point comment opening the line
// shows there, and the spaces after it with it.
function piecesOf(m, L, R, cut, typed) {
  const kept = m.piecesIn(L, R, [cut.a, cut.b], true).filter(p => p.end <= cut.a || p.start >= cut.b);
  for (const p of kept) p.source = m.s.slice(p.start, p.end);
  const i = typed.length ? kept.findIndex(p => p.start >= typed[0].start) : -1;
  const pieces = !typed.length ? kept : i < 0 ? [...kept, ...typed] : [...kept.slice(0, i), ...typed, ...kept.slice(i)];
  const pointBefore = (from, p) => m.spans.some(sp => sp.kind === "point" && sp.start >= from && sp.start < p.start + (p.lead ? 0 : 1)
    && !(sp.start >= cut.a && sp.end <= cut.b));
  let opening = shownBefore(m, L)?.line === true, lineEnd = L;
  for (const p of pieces) {
    if (p.space && opening && !pointBefore(lineEnd, p)) p.unseen = true;
    else {
      opening = Boolean(p.st.line);
      lineEnd = p.end;
    }
  }
  return pieces;
}

// The last character that shows before offset x: { run, line (whether it is a line break) }, or null.
function shownBefore(m, x) {
  const k = m.runAfter(x), now = m.runs[k], run = now && now.start < x ? now : m.runs[k - 1];
  return run ? { run, line: Boolean(m.styleOf(run.spans).line) } : null;
}

// [L, R) grown over the spans that cross it, and when the last character left showing before its end is a line break,
// over that break and the spaces after the end: spaces that come to open a line join the break's marks.
function regionOf(m, L0, R0, cut) {
  const near = spanned(m, L0, R0), before = shownBefore(m, near.R > cut.a && near.R <= cut.b ? cut.a : near.R);
  if (!before?.line) return near;
  let R = near.R;
  while (R < m.s.length && SPACES.includes(m.s[R])) R++;
  return spanned(m, Math.min(near.L, before.run.start), R);
}

// [L, R) grown until no span crosses an end of it: each lies inside it, outside it, or around it with its marks
// outside it. At an insertion point (L === R) a span that only touches it does not cross it.
function spanned(m, L0, R0) {
  let L = L0, R = R0;
  for (let grew = true; grew;) {
    grew = false;
    for (const sp of m.spans) {
      if (sp.start >= Math.max(R, L + 1)) break;
      const overlaps = L < R ? sp.end > L : sp.start < L && sp.end > L;
      if (!overlaps || (sp.start >= L && sp.end <= R) || (sp.start < L && sp.from <= L && sp.to >= R && sp.end > R)) continue;
      L = Math.min(L, sp.start);
      R = Math.max(R, sp.end);
      grew = true;
    }
  }
  return { L, R };
}

const deadPoints = (m, dead, L, R) => m.spans.reduce((n, sp) => n + (sp.kind === "point" && dead.has(sp.id) && sp.start >= L && sp.end <= R ? 1 : 0), 0);

// Whether the field's own result shows what it should: the characters the key left as they were, what it typed as it
// typed it, in the formatting asked of it.
function holds(m, value, cut, edit, typedIn, defs) {
  const { L, R } = regionOf(m, cut.a, cut.b, cut), delta = edit.inserted.length - edit.removed;
  const points = pointsIn(m, L, R) - pointsIn(m, cut.a, cut.b);
  return readsBack(m, value, L, R, R - L + delta, piecesOf(m, L, R, cut, typedIn), defs, points);
}

// Whether a character typed at a caret became markup, showing nowhere (it closed a shortcut such as `**bold**`), and
// nothing that was hidden before the key shows after it. Typed over a selection, it is the selection's text instead.
function closesShortcut(m, value, edit, defs) {
  const f = modelOf(value, defs, true), end = edit.at + edit.inserted.length, delta = edit.inserted.length - edit.removed;
  let hidden = false;
  for (let x = edit.at, k = f.runAfter(x); x < end && !hidden; k++) {
    const r = f.runs[k];
    if (!r || r.start > x) hidden = true;
    else x = r.end;
  }
  if (!hidden) return false;
  let k = 0;
  const showedAt = (lo, hi) => {
    while (k < m.runs.length && m.runs[k].end <= lo) k++;
    for (let x = lo; x < hi;) {
      const r = m.runs[k];
      if (!r || r.start > x) return false;
      x = r.end;
      if (x < hi) k++;
    }
    return true;
  };
  for (const r of f.runs) {
    if (r.start < edit.at && !showedAt(r.start, Math.min(r.end, edit.at))) return false;
    if (r.end > end && !showedAt(Math.max(r.start, end) - delta, r.end - delta)) return false;
  }
  return true;
}

// A link found by its text (`[label]`, `[label][]`) whose text the key changes keeps its address as a full reference
// to the same label: the closing marks to write for each.
function relabeled(m, cut, typed) {
  let closes = null;
  const reach = Math.max(cut.b, typed ? typed.slot : 0);
  for (const sp of m.spans) {
    if (sp.start > reach) break;
    if (sp.kind !== "link" || m.s.charCodeAt(sp.start) !== LBR || ownText(m.s, sp)) continue;
    const cutIn = cut.a < sp.to && cut.b > sp.from, typedIn = typed !== null && (typed.holder === sp || (typed.slot > sp.from && typed.slot < sp.to));
    if (cutIn || typedIn) (closes ??= new Map()).set(sp.id, `][${m.s.slice(sp.from, sp.to)}]`);
  }
  return closes;
}

// The stretch the writer rewrites: [lo, hi) and the typed text's slot, grown as restyle.js grows a selection's, and over
// every span the cut leaves nothing of or whose label the key changes. A run only spaces away is taken in too, so that
// typed text can join it (bold `**wo** ` and a bold `r` typed after the space make `**wo r**`).
function stretchOf(m, cut, typed, dead, closes, lo = cut.a, hi = cut.b) {
  const s = m.s, slot = typed ? typed.slot : cut.a;
  let L = Math.min(lo, slot), R = Math.max(hi, slot);
  for (let grew = true; grew;) {
    grew = false;
    let reachL = L, reachR = R;
    while (typed && reachL > 0 && SPACES.includes(s[reachL - 1])) reachL--;
    while (typed && reachR < s.length && SPACES.includes(s[reachR])) reachR++;
    for (const sp of m.spans) {
      if (sp.start > reachR) break;
      if (sp.end < reachL || (sp.start >= L && sp.end <= R)) continue;
      const role = m.roles[sp.id], overlaps = sp.end > L && sp.start < R;
      let take;
      if (dead.has(sp.id) || closes?.has(sp.id)) take = true;
      else if (role === FORMAT) {
        const around = sp.from <= L && sp.to >= R, takenOff = typed !== null && sp.from <= slot && slot <= sp.to && loses(sp, typed.format);
        take = !around || sp.kind === "code" || sp.from === L || sp.to === R || takenOff;
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
  return regionOf(m, L, R, cut);
}

const editIn = (value, L, R, len) => ({ at: L, removed: R - L, inserted: value.slice(L, L + len) });

// The value before the key with what it took put back where it still belongs: the characters it took go, and so do the
// marks of the spans it left nothing of, while the hidden marks of every other span stay; the typed text goes between
// the closing marks kept and the opening ones. A key that took only marks still needed leaves the value as it was.
// -> { value, caret, edit } or null when that does not read back.
function restored(m, cut, typed, inserted, dead, defs) {
  const { a, b } = cut, s = m.s, owner = new Int32Array(b - a).fill(-1);
  for (const sp of m.spans) {
    if (sp.start >= b) break;
    if (sp.end <= a) continue;
    for (const [f, t] of [[sp.start, sp.from], [sp.to, sp.end]]) owner.fill(sp.id, Math.max(f, a) - a, Math.max(Math.min(t, b) - a, 0));
  }
  const kept = x => owner[x - a] >= 0 && !dead.has(owner[x - a]);
  const drops = [];
  for (let x = a; x < b;) {
    let y = x + 1;
    while (y < b && kept(y) === kept(x)) y++;
    if (!kept(x)) drops.push([x, y]);
    x = y;
  }
  for (const id of dead) {
    const sp = m.spans[id];
    for (const [f, t] of [[sp.start, sp.from], [sp.to, sp.end]]) {
      if (f < Math.min(t, a)) drops.push([f, Math.min(t, a)]);
      if (Math.max(f, b) < t) drops.push([Math.max(f, b), t]);
    }
  }
  drops.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const d of drops) {
    const last = merged[merged.length - 1];
    if (last && d[0] <= last[1]) last[1] = Math.max(last[1], d[1]);
    else merged.push([d[0], d[1]]);
  }
  let slot = b;
  if (typed?.holder && typed.holder.from >= a) slot = typed.holder.from;
  else for (let x = a; x < b; x++) if (kept(x) && x < m.spans[owner[x - a]].from) { slot = x; break; }
  for (const [f, t] of merged) if (f < slot && slot < t) slot = t;
  if (!merged.length && !inserted) return { value: s, caret: slot, edit: { at: slot, removed: 0, inserted: "" } };
  let value = "", pos = 0, caret = -1, gone = 0;
  const copy = to => {
    if (caret < 0 && slot >= pos && slot <= to) {
      value += s.slice(pos, slot) + inserted;
      caret = value.length;
      value += s.slice(slot, to);
    } else value += s.slice(pos, to);
  };
  for (const [f, t] of merged) {
    copy(f);
    pos = t;
    gone += t - f;
  }
  copy(s.length);
  const L0 = Math.min(slot, merged.length ? merged[0][0] : slot), R0 = Math.max(slot, merged.length ? merged[merged.length - 1][1] : slot);
  const { L, R } = regionOf(m, L0, R0, cut), len = R - L - gone + inserted.length;
  const typedIn = typed ? typedPieces(inserted, { ...typed, slot }, false) : [];
  const points = pointsIn(m, L, R) - deadPoints(m, dead, L, R);
  if (!readsBack(m, value, L, R, len, piecesOf(m, L, R, cut, typedIn), defs, points)) return null;
  return { value, caret, edit: editIn(value, L, R, len) };
}

// The stretch around the key written afresh: what the cut left and what was typed, each in its formatting. Typed markup
// can pair with a character of its kind that shows far from it: a backtick shown earlier opens a code span that a typed
// one closes, escaped or not (a backslash escapes nothing in code). Failing a near stretch, one out to every such
// character is tried, so that it is escaped too. -> { value, caret, edit } or null when no way of writing it reads back.
function written(m, cut, typed, inserted, dead, defs) {
  const closes = relabeled(m, cut, typed), near = stretchOf(m, cut, typed, dead, closes);
  const out = writtenIn(m, near, cut, typed, inserted, dead, defs, closes);
  if (out || !typed) return out;
  let lo = near.L, hi = near.R;
  for (const r of m.runs) {
    if (!r.verbatim) continue;
    for (let x = r.start; x < r.end; x++) {
      if (!inserted.includes(m.s[x]) || !SPECIAL.test(m.s[x])) continue;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x + 1);
    }
  }
  return lo < near.L || hi > near.R ? writtenIn(m, stretchOf(m, cut, typed, dead, closes, lo, hi), cut, typed, inserted, dead, defs, closes) : null;
}

function writtenIn(m, { L, R }, cut, typed, inserted, dead, defs, closes) {
  const typedIn = typed ? typedPieces(inserted, typed, false) : [], pieces = piecesOf(m, L, R, cut, typedIn);
  const head = typedIn[typedIn.length - 1] ?? pieces.filter(p => p.end <= cut.a).pop() ?? null;
  const tail = head ? null : pieces.find(p => p.start >= cut.b) ?? null;
  const points = pointsIn(m, L, R) - deadPoints(m, dead, L, R);
  const out = rewrite(m, L, R, pieces, { last: head, caret: tail, defs, points, dead, closes });
  if (!out) return null;
  const at = head ? out.at.end : tail ? out.at.caret : -1, len = R - L + out.delta;
  return { value: out.value, caret: L + Math.max(at, 0), edit: editIn(out.value, L, R, len) };
}

// -> { value, caret, style, edit, unwritable } for the field value `before` and the edit a key made in it
// ({ at, removed, inserted }, as editOf gives it). `value` is what the field should hold: its own result when that
// already shows every character the key did not delete as it was, else a repair of it; `caret` a field offset in it,
// before the editor snaps it; `edit` the change from `before` to `value` in the same form; `style` the typing style for
// what is typed next at the caret ({ bits, mark, color }, with `stays` while typed text goes on in the link or comment
// it was typed over), or null for what is around it. `style` given: the typing style the key was made at.
// `unwritable`: no repair read back, so the field's own result is kept. `defs`: the document's link reference
// definitions.
export function mend(before, edit, { defs = null, style = null } = {}) {
  const s = String(before ?? ""), { at, removed, inserted } = edit, known = defs ?? null;
  const value = s.slice(0, at) + inserted + s.slice(at + removed), m = modelOf(s, known, true);
  const cut = cutOf(m, at, at + removed), free = Boolean(inserted) && !cut.first && !style;
  let typed = !inserted ? null : free ? { format: plain(), scope: "", slot: at, lead: true, holder: null } : typedOf(m, cut, at, style);
  const stays = typed ? Boolean(typed.holder) : Boolean(style?.stays);
  const format = cut.first ? (typed ? typed.format : shown(cut.first, cut.first.own)) : style && inserted ? style : null;
  const after = format && (stays ? { ...formatOnly(format), stays } : formatOnly(format));
  const own = { value, caret: at + inserted.length, style: after, edit, unwritable: false };
  if (holds(m, value, cut, edit, typed ? typedPieces(inserted, typed, free) : [], known)) return own;
  if (inserted && !removed && closesShortcut(m, value, edit, known)) return own;
  if (free) typed = typedOf(m, cut, at, null);
  const dead = deadIn(m, cut, typed?.holder ?? null);
  const fixed = (cut.a < cut.b ? restored(m, cut, typed, inserted, dead, known) : null) ?? written(m, cut, typed, inserted, dead, known);
  return fixed ? { ...fixed, style: after, unwritable: false } : { ...own, unwritable: true };
}
