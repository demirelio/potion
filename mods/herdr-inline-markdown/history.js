// Splices in document offsets, shared by Reading and Markdown. No imports from herdr or gpui-*.
import { applySplice, diff } from "./blocks.js";

export const MAX_ENTRIES = 200;
export const MAX_BYTES = 2 * 1024 * 1024;
export const GROUP_MS = 1000;

// Drops the common ends of the removed and inserted text.
export function trim(text, s) {
  const removed = text.slice(s.start, s.end), d = diff(removed, s.insert);
  return { start: s.start + d.at, end: s.start + d.at + d.removed, insert: d.inserted };
}

const bytes = e => 2 * (e.removed.length + e.inserted.length);
const MAX_SLIDE = 64;

// Inside a run of equal characters an insert or delete can sit at several places with the same result, and the
// common-prefix diff picks the last one, which need not be where the key was typed. Slides the edit `e` (on `text`,
// the text before it) or the open group `g` (already in `text`) within such a run so that e continues g, if it can.
function align(text, g, e) {
  if (!e.removed && !g.removed) {
    let gs = g.start, ge = g.start + g.inserted.length, p = e.start, ins = e.inserted;
    for (let n = 0; p < ge && n < MAX_SLIDE && text[gs - 1] === text[ge - 1] && gs > 0; n++) { gs--; ge--; }
    for (let n = 0; p < ge && n < MAX_SLIDE && text[p] === ins[0]; n++) { ins = ins.slice(1) + text[p]; p++; }
    for (let n = 0; p > ge && n < MAX_SLIDE && text[p - 1] === ins.at(-1); n++) { ins = text[p - 1] + ins.slice(0, -1); p--; }
    for (let n = 0; p > ge && n < MAX_SLIDE && text[ge] === text[gs]; n++) { gs++; ge++; }
    if (p !== ge) return;
    g.start = gs;
    g.inserted = text.slice(gs, ge);
    e.start = p;
    e.inserted = ins;
  } else if (!e.inserted && !g.inserted) {
    let p = e.start, rm = e.removed;
    for (let n = 0; p + rm.length > g.start && n < MAX_SLIDE && p > 0 && text[p - 1] === rm.at(-1); n++) { rm = text[p - 1] + rm.slice(0, -1); p--; }
    if (p + rm.length !== g.start) return;
    e.start = p;
    e.removed = rm;
  }
}
const hasNewline = s => s.includes("\n") || s.includes("\r");
// A group that wrote more than was typed (a new block written with its first letter) continues at its `join`, before
// the line end that follows the caret; else at the end of what it inserted.
const joinOf = g => g.join ?? g.start + g.inserted.length;

// -> a history. record(text, splice, meta) takes the text before the splice and
// meta { caretBefore, caretAfter, typing, key, time, join }; undo(text) and redo(text) hand back the splice to apply
// to `text`, with the caret and, for an entry given them by select(), the `select` range, or null when there is none or
// the entry does not match `text`.
export function createHistory({ maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, groupMs = GROUP_MS } = {}) {
  let done = [], undone = [], open = null, size = 0;

  const push = e => {
    done.push(e);
    size += bytes(e);
    while (done.length > 1 && (done.length > maxEntries || size > maxBytes)) size -= bytes(done.shift());
  };
  // A typing edit that continues the open group: an insert at its join, or a backward delete ending at its start.
  const continues = (g, e) => {
    if (!g || e.key !== g.key || e.time - g.time >= groupMs || hasNewline(e.inserted) || (hasNewline(g.inserted) && g.join === undefined)) return false;
    if (!e.removed) return e.start === joinOf(g);
    return !e.inserted && !g.inserted && e.start + e.removed.length === g.start;
  };
  const clear = () => {
    done = [];
    undone = [];
    open = null;
    size = 0;
  };
  // An entry's offsets are only good for the text it left: one that finds other text there clears the history, so an
  // undo never writes into text it does not know.
  const matches = (text, start, s) => typeof text !== "string" || (start <= text.length && text.slice(start, start + s.length) === s);

  const record = (text, splice, meta = {}) => {
    const t = trim(text, splice);
    if (t.start === t.end && !t.insert) return null;
    const e = {
      start: t.start, removed: text.slice(t.start, t.end), inserted: t.insert,
      caretBefore: meta.caretBefore ?? t.start, caretAfter: meta.caretAfter ?? t.start + t.insert.length,
      key: meta.key ?? null, time: meta.time ?? 0,
    };
    if (meta.join !== undefined && t.start === t.end) e.join = meta.join;
    undone = [];
    const g = done.at(-1);
    if (meta.typing && open === g && g && g.join === undefined) align(text, g, e);
    if (meta.typing && open === g && continues(g, e)) {
      const before = { ...g, before: null, last: null };
      size -= bytes(g);
      if (!e.removed) {
        const k = joinOf(g) - g.start;
        g.inserted = g.inserted.slice(0, k) + e.inserted + g.inserted.slice(k);
        if (g.join !== undefined) g.join += e.inserted.length;
      } else { g.start = e.start; g.removed = e.removed + g.removed; }
      g.caretAfter = e.caretAfter;
      g.time = e.time;
      g.before = before;
      g.last = e;
      size += bytes(g);
      return g;
    }
    push(e);
    open = meta.typing ? e : null;
    return e;
  };

  // Folds `s`, made on `text` right after the newest entry, into that entry: a fix-up of the same edit (the fence a
  // commit closes, a shortcut's rewrite of the marker), so that one undo takes back both.
  const amend = (text, s, meta = {}) => {
    const e = done.at(-1);
    if (!e || !matches(text, e.start, e.inserted)) return record(text, s, meta);
    const before = text.slice(0, e.start) + e.removed + text.slice(e.start + e.inserted.length);
    const d = diff(before, applySplice(text, s));
    size -= bytes(e);
    undone = [];
    open = null;
    if (!d.removed && !d.inserted) {
      done.pop();
      return null;
    }
    e.start = d.at;
    e.removed = before.slice(d.at, d.at + d.removed);
    e.inserted = d.inserted;
    e.caretAfter = meta.caretAfter ?? s.caret ?? e.caretAfter;
    e.before = null;
    e.last = null;
    delete e.join;
    delete e.selectAfter;
    size += bytes(e);
    return e;
  };

  return {
    record,
    amend,
    // Folds the newest entry, which left `text`, into the one before it: two edits of one key, one undo.
    joinLast(text) {
      const e = done.at(-1);
      if (done.length < 2 || !matches(text, e.start, e.inserted)) return;
      done.pop();
      size -= bytes(e);
      const before = text.slice(0, e.start) + e.removed + text.slice(e.start + e.inserted.length);
      amend(before, { start: e.start, end: e.start + e.removed.length, insert: e.inserted }, { caretBefore: e.caretBefore, caretAfter: e.caretAfter });
    },
    close() { open = null; },
    // The newest entry, which left `text`, puts back the document range `before` on undo and `after` on redo.
    select(text, before, after) {
      const e = done.at(-1);
      if (!e || !matches(text, e.start, e.inserted)) return;
      e.selectBefore = before;
      e.selectAfter = after;
    },
    // Splits the newest edit off its group into an entry of its own (the space that completed a shortcut).
    isolateLast() {
      const g = done.at(-1);
      if (!g || !g.before || open !== g) { open = null; return; }
      size -= bytes(g);
      done[done.length - 1] = g.before;
      size += bytes(g.before);
      push(g.last);
      open = null;
    },
    undo(text) {
      const e = done.at(-1);
      if (!e) return null;
      if (!matches(text, e.start, e.inserted)) { clear(); return null; }
      done.pop();
      size -= bytes(e);
      undone.push(e);
      open = null;
      return { start: e.start, end: e.start + e.inserted.length, insert: e.removed, caret: e.caretBefore, ...(e.selectBefore && { select: e.selectBefore }) };
    },
    redo(text) {
      const e = undone.at(-1);
      if (!e) return null;
      if (!matches(text, e.start, e.removed)) { clear(); return null; }
      undone.pop();
      done.push(e);
      size += bytes(e);
      open = null;
      return { start: e.start, end: e.start + e.removed.length, insert: e.inserted, caret: e.caretAfter, ...(e.selectAfter && { select: e.selectAfter }) };
    },
    // An outside change E (a reload, a merged disk change), as a splice of the current text: entries before and after it
    // are kept with their offsets moved, an entry it overlaps is dropped with every older one, and redo is cleared.
    rebase(E) {
      let start = E.start, end = E.end;
      const len = E.insert.length;
      undone = [];
      open = null;
      for (let i = done.length - 1; i >= 0; i--) {
        const x = done[i], grow = len - (end - start), insEnd = x.start + x.inserted.length;
        const past = (p, at) => (p >= at ? p + grow : p);
        const moveBefore = at => {
          x.caretBefore = past(x.caretBefore, at);
          if (x.selectBefore) x.selectBefore = { start: past(x.selectBefore.start, at), end: past(x.selectBefore.end, at) };
        };
        const moveAfter = at => {
          x.caretAfter = past(x.caretAfter, at);
          if (x.selectAfter) x.selectAfter = { start: past(x.selectAfter.start, at), end: past(x.selectAfter.end, at) };
        };
        if (start >= insEnd) {
          moveAfter(end);
          const back = x.inserted.length - x.removed.length;
          start -= back;
          end -= back;
          moveBefore(end);
        } else if (end <= x.start) {
          x.start += grow;
          moveBefore(end);
          moveAfter(end);
        } else {
          for (const gone of done.splice(0, i + 1)) size -= bytes(gone);
          break;
        }
      }
    },
    clear,
    get canUndo() { return done.length > 0; },
    get canRedo() { return undone.length > 0; },
    get entries() { return done.map(({ start, removed, inserted, caretBefore, caretAfter }) => ({ start, removed, inserted, caretBefore, caretAfter })); },
    get size() { return size; },
  };
}

// Mine and theirs both changed `base`. -> the splice that puts their change into mine, or null when the two changes
// overlap or touch. Each change is one range, from the first character where its text leaves base to the last, so
// their edits above and below mine count as overlapping it. The result is checked both ways.
export function mergeChange(base, mine, theirs) {
  const o = diff(base, mine), t = diff(base, theirs), oEnd = o.at + o.removed, tEnd = t.at + t.removed;
  // No change of ours is an empty range at the end of the text, which an append of theirs would touch.
  if (mine === base) return { start: t.at, end: tEnd, insert: t.inserted };
  const growO = o.inserted.length - o.removed, growT = t.inserted.length - t.removed;
  let E, O;
  if (tEnd < o.at) {
    E = { start: t.at, end: tEnd, insert: t.inserted };
    O = { start: o.at + growT, end: oEnd + growT, insert: o.inserted };
  } else if (t.at > oEnd) {
    E = { start: t.at + growO, end: tEnd + growO, insert: t.inserted };
    O = { start: o.at, end: oEnd, insert: o.inserted };
  } else return null;
  if (mine.slice(E.start, E.end) !== base.slice(t.at, tEnd) || theirs.slice(O.start, O.end) !== base.slice(o.at, oEnd)) return null;
  return applySplice(mine, E) === applySplice(theirs, O) ? E : null;
}
