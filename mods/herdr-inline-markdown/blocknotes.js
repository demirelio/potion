// Comments on a code block, a diagram or a table: point comments, one per line, in a paragraph of their own right
// after the block (its next sibling), which then reads as the block's comments and not as text. Which block owns which
// paragraph, and the splices that add, edit and resolve those comments; those of a comment on a picture of a paragraph
// of pictures, written around the picture; and those that edit and resolve a comment in a table's cell. No imports
// from herdr or gpui-*.
import { cutItem, field, fieldToDoc, insertAfter, picturesIn, remove, removeRange } from "./blocks.js";
import { addComment, cellComments, commentsIn, editCellComment, editComment, pointComment } from "./comments.js";

const OWNER_KINDS = new Set(["code", "mermaid", "table"]);
const BRACE = 123;
// Point comments on one line each or side by side, nothing else: the note can't hold a line break or close early.
const POINTS_ONLY = /^\s*(?:\{>>[^<\n]*(?:<(?!<\})[^<\n]*)*<<\}\s*)+$/;

// `pairings` counts the documents paired, `reads` the paragraph contents read for it (the rest come from the memo).
export const counters = { pairings: 0, reads: 0 };

export const ownsNotes = b => OWNER_KINDS.has(b.kind);

// The point comments of a paragraph's content when it holds nothing else, else null.
function pointsOnly(content) {
  if (content.charCodeAt(0) !== BRACE || !POINTS_ONLY.test(content)) return null;
  const list = commentsIn(content);
  let at = 0;
  for (const c of list) {
    if (c.kind !== "point" || content.slice(at, c.start).trim()) return null;
    at = c.end;
  }
  return list.length && !content.slice(at).trim() ? list : null;
}

// Whether p, the block after b, can be owner b's comments paragraph: a paragraph under b's parent, not one of pictures.
// Whether it holds nothing but point comments is for the caller to read.
const holdsNotesOf = (b, p) => Boolean(p) && ownsNotes(b) && p.kind === "paragraph" && p.parent === b.parent && !p.image;

// -> the paragraph of owner b's comments, or null.
export function notesAfter(doc, b) {
  const p = doc.blocks[b.index + 1];
  return holdsNotesOf(b, p) && pointsOnly(p.content) ? p : null;
}

// -> the block whose comments paragraph p is, or null.
export function ownerOf(doc, p) {
  const b = doc.blocks[p.index - 1];
  return b && holdsNotesOf(b, p) && pointsOnly(p.content) ? b : null;
}

// -> [first, last]: the blocks that move and go as one with b, a block and its comments paragraph.
export const blockUnit = (doc, b) => [ownerOf(doc, b) ?? b, notesAfter(doc, b) ?? b];

// The paragraph contents the memo may hold beyond those of the document being paired, before it is pruned to those.
const MEMO_SLACK = 64;
const candidates = (bl, each) => {
  for (let i = 0; i + 1 < bl.length; i++) {
    const b = bl[i], p = bl[i + 1];
    if (holdsNotesOf(b, p) && p.content.charCodeAt(0) === BRACE) each(b, p);
  }
};

// -> { doc, owners: Map(owner key -> { owner, para, points }), hidden: Set of paragraph keys, memo }. `prev`, the pairing
// of an earlier document, lends its answers per paragraph content (its memo goes on): a re-parse keeps unchanged
// blocks' contents.
export function pairNotes(doc, prev = null) {
  counters.pairings++;
  const owners = new Map(), hidden = new Set(), memo = prev?.memo ?? new Map(), bl = doc.blocks;
  let read = 0;
  candidates(bl, (b, p) => {
    read++;
    let points = memo.get(p.content);
    if (points === undefined) {
      counters.reads++;
      points = pointsOnly(p.content);
      memo.set(p.content, points);
    }
    if (!points) return;
    owners.set(b.key, { owner: b, para: p, points });
    hidden.add(p.key);
  });
  if (memo.size <= read + MEMO_SLACK) return { doc, owners, hidden, memo };
  const kept = new Map();
  candidates(bl, (_b, p) => kept.set(p.content, memo.get(p.content)));
  return { doc, owners, hidden, memo: kept };
}

export const removeWithNotes = (doc, b) => removeRange(doc, b, notesAfter(doc, b) ?? b);

// The comments of paragraph p as its field shows them, with field offsets.
function notesField(doc, p) {
  const f = field(doc, p);
  return { f, points: commentsIn(f.value) };
}

// Comment `note`, stamped with `when`, under owner b: a comments paragraph after it, else a last line of the one it has,
// behind that paragraph's continuation prefix. Null for an empty note.
export function addBlockNote(doc, b, note, when) {
  const written = pointComment(note, when);
  if (!written) return null;
  const p = notesAfter(doc, b);
  if (!p) return insertAfter(doc, b, "paragraph", written);
  const eol = p.start + p.lines.at(-1).eol;
  return { start: eol, end: eol, insert: doc.eol + p.contPrefix + written, caret: eol };
}

// The document splice that writes comment c's new note, from `next`, field f's value once the note was swapped.
function noteSplice(f, c, next) {
  const start = fieldToDoc(f, c.noteAt), end = fieldToDoc(f, c.noteAt + c.note.length);
  return { start, end, insert: next.value.slice(c.noteAt, c.noteAt + c.note.length + next.value.length - f.value.length), caret: start };
}

// Owner b's comment `index` with its text swapped for `note`, its time kept; null when nothing would change.
export function editBlockNote(doc, b, index, note) {
  const p = notesAfter(doc, b), found = p && notesField(doc, p), c = found?.points[index];
  const next = c ? editComment(found.f.value, c, note) : null;
  return next ? noteSplice(found.f, c, next) : null;
}

// The last comment goes with its paragraph and the blank line before it; a file that ended without a line break after
// the paragraph ends so after the block again.
function removeNotes(doc, b, p) {
  const text = doc.text, last = p.index === doc.blocks.length - 1;
  if (!last || p.end < text.length || text.endsWith("\n")) return remove(doc, p);
  const start = b.start + b.lines.at(-1).eol;
  return { start, end: p.end, insert: "", caret: start };
}

// Owner b's comment `index` taken out as cutItem takes it, or with the paragraph when it is the last. Null when there
// is none.
export function resolveBlockNote(doc, b, index) {
  const p = notesAfter(doc, b), found = p && notesField(doc, p);
  if (!found?.points[index]) return null;
  if (found.points.length === 1) return removeNotes(doc, b, p);
  const at = x => fieldToDoc(found.f, x);
  return cutItem(p, found.points.map(c => ({ start: at(c.start), end: at(c.end) })), index);
}

// Picture i of paragraph of pictures b given comment `note`, stamped with `when`: its image, a linked one's whole,
// wrapped in a highlight with the comment after it, or the comment after the highlight it has. Null for an empty
// note, a picture that has a comment (one a picture) or none at i. The picture splices' caret is the picture's start.
export function addPictureNote(doc, b, i, note, when) {
  const p = picturesIn(doc, b)[i];
  if (!p || p.note !== null) return null;
  if (p.start !== p.from) {
    const written = pointComment(note, when);
    return written ? { start: p.end, end: p.end, insert: written, caret: p.start } : null;
  }
  const image = doc.text.slice(p.from, p.to), next = addComment(image, { start: 0, end: image.length }, note, when);
  return next?.value ? { start: p.from, end: p.to, insert: next.value, caret: p.start } : null;
}

// Picture i's comment with its text swapped for `note`, its time kept; null when nothing would change.
export function editPictureNote(doc, b, i, note) {
  const p = picturesIn(doc, b)[i];
  if (!p || p.note === null) return null;
  const next = editComment(doc.text.slice(p.start, p.end), { note: p.note, noteAt: p.noteAt - p.start, end: p.end - p.start }, note);
  return next && { start: p.start, end: p.end, insert: next.value, caret: p.start };
}

// Picture i's highlight and comment taken off, the picture left; null when it has neither.
export function resolvePictureNote(doc, b, i) {
  const p = picturesIn(doc, b)[i];
  return p && p.start !== p.from ? { start: p.start, end: p.end, insert: doc.text.slice(p.from, p.to), caret: p.start } : null;
}

function cellNoteOf(doc, b, index) {
  const f = field(doc, b), found = cellComments(f.value)[index];
  return found ? { f, c: found.comment } : null;
}

// Table b's cell comment `index` with its text swapped for `note`, its time kept, its pipes escaped; null when nothing
// would change.
export function editCellNote(doc, b, index, note) {
  const found = cellNoteOf(doc, b, index), next = found && editCellComment(found.f.value, found.c, note);
  return next ? noteSplice(found.f, found.c, next) : null;
}

// Table b's cell comment `index` taken off: its marks and note go, the cell's text stays (a point comment alone leaves
// the cell empty). Null when there is none.
export function resolveCellNote(doc, b, index) {
  const found = cellNoteOf(doc, b, index);
  if (!found) return null;
  const { f, c } = found, at = x => fieldToDoc(f, x), start = at(c.start);
  return { start, end: at(c.end), insert: doc.text.slice(at(c.from), at(c.to)), caret: start };
}
