// CriticMarkup comments in the text of one block: `{==marked text==}{>>comment<<}`, a comment at a point
// `{>>comment<<}`, and a highlight with no comment `{==text==}`. Code spans and code blocks hold none. A comment's
// note may start with the local time it was written: `{>>2026-11-16 20:51 | the comment<<}`. Offsets are UTF-16
// indices. No imports.

const OPEN = "{==", CLOSE = "==}", NOTE_OPEN = "{>>", NOTE_CLOSE = "<<}";
const BACKSLASH = 92, BACKTICK = 96, BRACE = 123, EQUALS = 61, LESS = 60, PIPE = 124, NEWLINE = 10, BLANK_CHAR = 32, TAB = 9;
const MAY_HOLD = /\{(?:==|>>)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLANK = /^[ \t]*$/;
const INDENTED = /^(?: {0,3}\t| {4})/;
const LINE_BREAK = /\s*(?:\r\n|\r|\n)\s*/g;
const SPACE = /\s/;
const STAMP = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d) \|(?: |$)/;
const STAMP_SEP = " | ";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = n => String(n).padStart(2, "0");

// What a point comment shows in Reading, highlighted.
export const POINT = "💬";

export const highlight = (inner, color) => `<mark color="${color}">${inner}</mark>`;

const closesFence = (line, mark) => {
  const m = FENCE_CLOSE.exec(line);
  return Boolean(m) && m[1][0] === mark[0] && m[1].length >= mark.length;
};

// Each line of `text` as { start, end, kind }: "text", "blank", or "code" (a line of a fenced or indented code block,
// which a quote can hold).
function linesOf(text) {
  const out = [];
  let at = 0, fence = null, inParagraph = false;
  for (const line of text.split("\n")) {
    const blank = BLANK.test(line);
    let code = false;
    if (fence) {
      code = true;
      if (closesFence(line, fence)) fence = null;
    } else if (FENCE_OPEN.test(line)) {
      fence = FENCE_OPEN.exec(line)[1];
      code = true;
    } else code = !blank && !inParagraph && INDENTED.test(line);
    inParagraph = !blank && !code;
    out.push({ start: at, end: at + line.length, kind: code ? "code" : blank ? "blank" : "text" });
    at += line.length + 1;
  }
  return out;
}

// Past the code span whose backtick run starts at `i`, or past the run alone when no run as long closes it before `to`.
function pastCode(text, i, to, spans) {
  let n = 0;
  while (text.charCodeAt(i + n) === BACKTICK) n++;
  for (let j = text.indexOf("`", i + n); j >= 0 && j < to; j = text.indexOf("`", j)) {
    let m = 0;
    while (text.charCodeAt(j + m) === BACKTICK) m++;
    if (m === n) {
      spans?.push({ start: i, end: j + m, block: false });
      return j + m;
    }
    j += m;
  }
  return i + n;
}

function noteAt(text, at, to) {
  const from = at + NOTE_OPEN.length, close = text.indexOf(NOTE_CLOSE, from);
  return close < 0 || close + NOTE_CLOSE.length > to ? null : { noteAt: from, note: text.slice(from, close), end: close + NOTE_CLOSE.length };
}

const pointAt = (text, i, to) => {
  const n = noteAt(text, i, to);
  return n && { kind: "point", start: i, end: n.end, from: i, to: i, note: n.note, noteAt: n.noteAt };
};

// Marked text holds no other comment's marks, and code spans in it are skipped while looking for its close.
function highlightAt(text, i, to) {
  const from = i + OPEN.length;
  let j = from;
  while (j < to) {
    const ch = text.charCodeAt(j);
    if (ch === EQUALS && text.startsWith(CLOSE, j)) break;
    if (ch === BRACE && (text.startsWith(OPEN, j) || text.startsWith(NOTE_OPEN, j))) return null;
    if (ch === LESS && text.startsWith(NOTE_CLOSE, j)) return null;
    if (ch === BACKSLASH) j += 2;
    else if (ch === BACKTICK) j = pastCode(text, j, to);
    else j++;
  }
  if (j >= to || j === from) return null;
  const closed = j + CLOSE.length, n = text.startsWith(NOTE_OPEN, closed) ? noteAt(text, closed, to) : null;
  return n ? { kind: "comment", start: i, end: n.end, from, to: j, note: n.note, noteAt: n.noteAt }
    : { kind: "highlight", start: i, end: closed, from, to: j, note: null, noteAt: -1 };
}

const nextOf = (text, ch, from, to) => {
  const k = text.indexOf(ch, from);
  return k < 0 || k >= to ? to : k;
};

// Only a backslash, a backtick or a brace can start something here, so the scan jumps between them.
function scan(text, from, to, comments, code) {
  let backslash = -1, backtick = -1, brace = -1;
  for (let i = from; i < to;) {
    if (backslash < i) backslash = nextOf(text, "\\", i, to);
    if (backtick < i) backtick = nextOf(text, "`", i, to);
    if (brace < i) brace = nextOf(text, "{", i, to);
    i = Math.min(backslash, backtick, brace);
    if (i >= to) return;
    const ch = text.charCodeAt(i);
    if (ch === BACKSLASH) { i += 2; continue; }
    if (ch === BACKTICK) { i = pastCode(text, i, to, code); continue; }
    const c = ch !== BRACE ? null : text.startsWith(OPEN, i) ? highlightAt(text, i, to) : text.startsWith(NOTE_OPEN, i) ? pointAt(text, i, to) : null;
    i = c ? c.end : i + 1;
    if (c) comments.push(c);
  }
}

// `stretches`: the runs of text lines (a paragraph each), which is where comments can be; `code`: code block lines and
// the code spans found in the stretches.
function layout(text) {
  const comments = [], code = [], stretches = [];
  let run = null;
  for (const line of linesOf(text)) {
    if (line.kind === "text") {
      if (run) run.end = line.end;
      else run = { start: line.start, end: line.end };
      continue;
    }
    if (run) stretches.push(run);
    run = null;
    if (line.kind === "code") code.push({ start: line.start, end: line.end, block: true });
  }
  if (run) stretches.push(run);
  for (const s of stretches) scan(text, s.start, s.end, comments, code);
  return { comments, code, stretches };
}

// -> [{ kind: "comment" | "point" | "highlight", start, end (the whole markup), from, to (the marked text; at `start`
// for a point), note (the comment's text, null for a highlight), noteAt (where that text starts) }], in text order.
export const commentsIn = text => (MAY_HOLD.test(text) ? layout(text).comments : []);

function replaced(text, fill) {
  let out = "", at = 0;
  for (const c of commentsIn(text)) {
    out += text.slice(at, c.start) + fill(c);
    at = c.end;
  }
  return out + text.slice(at);
}

// The markdown Reading draws: marked text highlighted (its formatting still renders), the marks and the comment gone.
// `deep` ({ at, color }): the comment starting at `at` is highlighted in `color` instead.
export const showComments = (text, color, deep = null) =>
  replaced(text, c => highlight(c.kind === "point" ? POINT : text.slice(c.from, c.to), c.start === deep?.at ? deep.color : color));

// A comment is one line, and `<<}` in it would end it early.
export const oneLine = note => String(note ?? "").replace(LINE_BREAK, " ").replaceAll(NOTE_CLOSE, "<< }").trim();

export const stampOf = when =>
  `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())} ${pad2(when.getHours())}:${pad2(when.getMinutes())}`;

// -> { when, text }: the time a note's stamp names (a Date, local time) and the text after it; a note without a valid
// stamp has `when` null and is all text.
export function readNote(note) {
  const s = String(note ?? ""), m = STAMP.exec(s);
  if (!m) return { when: null, text: s };
  const [y, mo, d, h, mi] = m.slice(1).map(Number), when = new Date(y, mo - 1, d, h, mi);
  const real = when.getFullYear() === y && when.getMonth() === mo - 1 && when.getDate() === d && when.getHours() === h && when.getMinutes() === mi;
  return real ? { when, text: s.slice(m[0].length) } : { when: null, text: s };
}

export const noteText = note => readNote(note).text;

// A comment's time as a card shows it: the hour on the day of `now`, the day in its year, else the day and the year.
export function timeLabel(when, now) {
  if (!when) return "";
  const day = `${MONTHS[when.getMonth()]} ${when.getDate()}`;
  if (when.getFullYear() !== now.getFullYear()) return `${day}, ${when.getFullYear()}`;
  if (when.getMonth() !== now.getMonth() || when.getDate() !== now.getDate()) return day;
  const h = when.getHours();
  return `${h % 12 || 12}:${pad2(when.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

const stamped = (text, when) => (when ? `${stampOf(when)}${STAMP_SEP}${text}` : text);

// A point comment's whole markup for `note` (one line) stamped with `when`; "" for an empty note.
export function pointComment(note, when = null) {
  const text = oneLine(note);
  return text ? `${NOTE_OPEN}${stamped(text, when)}${NOTE_CLOSE}` : "";
}

// Spaces at the ends of a selection stay outside the marks; a selection of spaces only is a caret at its start.
function trimmed(value, range) {
  const clampTo = x => Math.max(0, Math.min(value.length, Number(x) || 0));
  const a = clampTo(range?.start), b = clampTo(range?.end);
  let s = Math.min(a, b), e = Math.max(a, b);
  while (s < e && SPACE.test(value[s])) s++;
  while (e > s && SPACE.test(value[e - 1])) e--;
  return s === e ? { start: Math.min(a, b), end: Math.min(a, b) } : { start: s, end: e };
}

function refusal(value, { start: s, end: e }) {
  const { comments, code, stretches } = layout(value);
  const caret = s === e;
  if (comments.some(c => (caret ? c.start < s && s < c.end : s < c.end && e > c.start))) return "overlap";
  const insideBlock = r => r.block && r.start <= s && e <= r.end;
  const cuts = r => s < r.end && e > r.start && !(s <= r.start && e >= r.end);
  if (code.some(r => insideBlock(r) || cuts(r))) return "code";
  if (!stretches.some(r => r.start <= s && e <= r.end)) return "paragraphs";
  return null;
}

// Why a comment can't go on the selection `range` of `value`: "overlap" (it would cut through or hold another one),
// "code" or "paragraphs" (it would cross a blank line); null when it can.
export const commentable = (value, range) => refusal(value, trimmed(value, range));

// -> { value, start, end }: the selection marked with `note` (a point comment at a caret), stamped with `when` when
// given, the caret after it; null for an empty note; { refused } with commentable's reason.
export function addComment(value, range, note, when = null) {
  const text = oneLine(note), sel = trimmed(value, range);
  if (!text) return null;
  const why = refusal(value, sel);
  if (why) return { refused: why };
  const marks = sel.start === sel.end ? "" : `${OPEN}${value.slice(sel.start, sel.end)}${CLOSE}`;
  const written = `${marks}${NOTE_OPEN}${stamped(text, when)}${NOTE_CLOSE}`, caret = sel.start + written.length;
  return { value: value.slice(0, sel.start) + written + value.slice(sel.end), start: caret, end: caret };
}

function noteSwapped(value, c, next) {
  if (next === c.note) return null;
  const caret = c.end + next.length - c.note.length;
  return { value: value.slice(0, c.noteAt) + next + value.slice(c.noteAt + c.note.length), start: caret, end: caret };
}

// Comment `c` of `value` (commentsIn) with its text swapped for `note`, its time kept, the caret after it; null when
// nothing changes.
export function editComment(value, c, note) {
  const text = oneLine(note);
  return !text || c.note === null ? null : noteSwapped(value, c, stamped(text, readNote(c.note).when));
}

// Comment `c` taken off `value`, its marked text kept and selected.
export function resolveComment(value, c) {
  const kept = value.slice(c.from, c.to);
  return { value: value.slice(0, c.start) + kept + value.slice(c.end), start: c.start, end: c.start + kept.length };
}

// An unescaped `|` ends a table cell, wherever it is, and Herdr's parser (micromark's rules) reads `\\` as one escape
// before it: a note's `|` is written `\|`, the backslashes right before it doubled.
const PIPE_RUN = /(\\*)\|/g, ESCAPED_PIPE_RUN = /(\\*)\\\|/g;
const cellEscaped = note => note.replace(PIPE_RUN, (_, run) => `${run}${run}\\|`);
const cellUnescaped = note => note.replace(ESCAPED_PIPE_RUN, (_, run) => `${run.slice(0, run.length >> 1)}|`);
const escapes = (text, i) => text.charCodeAt(i) === BACKSLASH && (text.charCodeAt(i + 1) === BACKSLASH || text.charCodeAt(i + 1) === PIPE);

function startsWithPipe(text, i) {
  while (text.charCodeAt(i) === BLANK_CHAR || text.charCodeAt(i) === TAB) i++;
  return text.charCodeAt(i) === PIPE;
}

// The end of the cell that offset `from` is in: its next unescaped pipe, else its line's end.
function cellEnd(text, from) {
  for (let i = from; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === NEWLINE || ch === PIPE) return i;
    if (escapes(text, i)) i++;
  }
  return text.length;
}

function trimmedRange(text, start, end) {
  while (start < end && SPACE.test(text[start])) start++;
  while (end > start && SPACE.test(text[end - 1])) end--;
  return { start, end };
}

// -> the comments of a table's text that have a note (commentsIn's `comment`), in text order, each with the cell its start
// is in: `row` its drawn row (0 the header; the delimiter row is not drawn), `column` from 0, `cell` the cell's text
// range without the spaces at its ends, and `note` unescaped, so readNote finds its time. One pass over the text, as
// tableCells per comment costs milliseconds in a long table.
export function cellComments(value) {
  const out = [];
  let i = 0, line = 0, lineStart = 0, pipes = 0, lastPipe = -1;
  for (const c of commentsIn(value)) {
    if (c.note === null) continue;
    for (; i < c.start; i++) {
      const ch = value.charCodeAt(i);
      if (ch === NEWLINE) { line++; lineStart = i + 1; pipes = 0; lastPipe = -1; }
      else if (escapes(value, i)) i++;
      else if (ch === PIPE) { pipes++; lastPipe = i; }
    }
    const column = pipes - (startsWithPipe(value, lineStart) ? 1 : 0);
    const cell = trimmedRange(value, lastPipe < 0 ? lineStart : lastPipe + 1, cellEnd(value, c.end));
    out.push({ comment: c, row: Math.max(0, line - 1), column, cell, note: cellUnescaped(c.note) });
  }
  return out;
}

// -> { value, start, end }: table cell `cell` (trimmed, as tableCells gives it) commented with `note`, stamped with `when`
// when given, the note's pipes escaped, the caret after the comment: all of the cell's text marked, or an empty cell
// given a point comment with a space each side. Null for an empty note; { refused: "overlap" } for a cell that holds a
// comment or a highlight already.
export function addCellComment(value, cell, note, when = null) {
  const text = oneLine(note), { start, end } = cell;
  if (!text) return null;
  if (commentsIn(value).some(c => c.start < end && c.end > start)) return { refused: "overlap" };
  const comment = `${NOTE_OPEN}${cellEscaped(stamped(text, when))}${NOTE_CLOSE}`;
  if (start === end) {
    const before = start > 0 && !SPACE.test(value[start - 1]) ? " " : "", after = value.charCodeAt(start) === PIPE ? " " : "";
    const caret = start + before.length + comment.length;
    return { value: value.slice(0, start) + before + comment + after + value.slice(start), start: caret, end: caret };
  }
  const written = `${OPEN}${value.slice(start, end)}${CLOSE}${comment}`, caret = start + written.length;
  return { value: value.slice(0, start) + written + value.slice(end), start: caret, end: caret };
}

// editComment for a comment in a table cell (cellComments' `comment`): its note read and written as a cell holds it.
export function editCellComment(value, c, note) {
  const text = oneLine(note);
  return !text || c.note === null ? null : noteSwapped(value, c, cellEscaped(stamped(text, readNote(cellUnescaped(c.note)).when)));
}
