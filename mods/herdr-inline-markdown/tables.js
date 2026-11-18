// A GFM table block as rows of cells: where each cell's text is in the file, how its columns align, and how a cell's
// text is written back so that the table keeps its shape. Imports blocks.js only, so node tests load it as it is.
//
// Cells part where blocks.js cellCount parts them: the row trimmed, a pipe at either end dropped, then every pipe a
// backslash does not take with it (a backslash takes the next character, a backslash too).
import { cellCount, parse } from "./blocks.js";

const PIPE = 124, BSL = 92, SPACE = 32, TAB = 9, DASH = 45, LOW_SURROGATE = 0xdc00, AFTER_SURROGATES = 0xe000;
const DASH_RUN = /-+/;
const WHITE = /\s/;
const DELIM_CELL = /^[ \t]*(:?)-+(:?)[ \t]*$/;
const LINE_BREAK = /\r\n|\r|\n/g;
// A pipe after an even run of backslashes (none is even) parts cells; one more backslash makes it text.
const BARE_PIPE = /(\\*)\|/g;
// An ordered list marker is escaped after its digits; any other block start before its first character.
const ORDERED_MARKER = /^\d{1,9}(?=[.)])/;
const ROW_TEST = "|x|\n|-|\n";

const isBlank = c => c === SPACE || c === TAB;

// [start, end) without the spaces and tabs at its ends; an empty cell sits one past its opening pipe when it can.
function trimmedCell(text, start, end) {
  let s = start, e = end;
  while (s < e && isBlank(text.charCodeAt(s))) s++;
  while (e > s && isBlank(text.charCodeAt(e - 1))) e--;
  if (s === e) s = e = Math.min(start + 1, end);
  return { start: s, end: e };
}

export function codePoints(text, from = 0, to = text.length) {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c < LOW_SURROGATE || c >= AFTER_SURROGATES) n++;
  }
  return n;
}

// The row on text[body, eol): its cells, whether it has a pipe at each end, and the column of each pipe that counts,
// in code points from `body`.
function partRow(text, body, eol) {
  let a = body, z = eol;
  while (a < z && WHITE.test(text[a])) a++;
  while (z > a && WHITE.test(text[z - 1])) z--;
  const lead = a < z && text.charCodeAt(a) === PIPE, from = lead ? a + 1 : a, cells = [], pipes = [];
  let col = codePoints(text, body, from), at = from, cellStart = from, trail = false;
  if (lead) pipes.push(col - 1);
  for (let i = from; i < z; i++) {
    const c = text.charCodeAt(i);
    if (c === BSL) i++;
    else if (c === PIPE) {
      col += codePoints(text, at, i);
      at = i;
      pipes.push(col);
      cells.push(trimmedCell(text, cellStart, i));
      cellStart = i + 1;
      trail = i === z - 1;
    }
  }
  if (!trail) cells.push(trimmedCell(text, cellStart, z));
  return { cells, pipes, lead, trail };
}

const alignOf = (text, cell) => {
  const m = DELIM_CELL.exec(text.slice(cell.start, cell.end));
  if (!m) return null;
  return m[1] && m[2] ? "center" : m[1] ? "left" : m[2] ? "right" : null;
};

const dashCount = (text, cell) => {
  let n = 0;
  for (let i = cell.start; i < cell.end; i++) if (text.charCodeAt(i) === DASH) n++;
  return n;
};

function parted(text, b) {
  const rows = [], s0 = b.start;
  let columns = 0, aligns = [], dashes = [], aligned = true, irregular = false, firstPipes = null;
  for (let k = 0; k < b.lines.length; k++) {
    const L = b.lines[k], row = partRow(text, s0 + L.body, s0 + L.eol);
    if (firstPipes === null) firstPipes = row.pipes;
    else if (aligned && (row.pipes.length !== firstPipes.length || row.pipes.some((p, i) => p !== firstPipes[i]))) aligned = false;
    if (k === 0) columns = row.cells.length;
    if (k === 1) {
      aligns = row.cells.map(cell => alignOf(text, cell));
      dashes = row.cells.map(cell => dashCount(text, cell));
      continue;
    }
    if (row.cells.length > columns) irregular = true;
    const cells = row.cells;
    while (cells.length < columns) cells.push(null);
    rows.push({ line: k, cells, lead: row.lead, trail: row.trail });
  }
  return { rows, columns, aligns, dashes, aligned, irregular };
}

const shifted = (t, by) => ({
  ...t,
  rows: t.rows.map(row => ({ ...row, cells: row.cells.map(cell => (cell ? { start: cell.start + by, end: cell.end + by } : null)) })),
});

// Per table block's `lines`, which a re-parse that leaves the table alone keeps and which go with the block: the
// answer last given and the start it was given at.
const kept = new WeakMap();

function keptOf(doc, b) {
  let k = kept.get(b.lines);
  if (!k || k.content !== b.content) {
    k = { content: b.content, at: b.start, table: parted(doc.text, b) };
    kept.set(b.lines, k);
  }
  return k;
}

// -> { rows, columns, aligns, dashes, aligned, irregular } for table block b of `doc`.
// rows: the header first, the delimiter row left out; each { line (an index into b.lines), cells, lead, trail (a pipe at
// either end) }. A cell is { start, end }, the document offsets of its text without the spaces around it (an empty
// one has start === end inside its slot); a row with fewer cells than the header has null for each it lacks.
// aligned: every line has its pipes at the same columns (code points from the line's body); irregular: a row holds
// more cells than the header, which GFM drops.
export function tableOf(doc, b) {
  const k = keptOf(doc, b);
  if (k.at !== b.start) {
    k.table = shifted(k.table, b.start - k.at);
    k.at = b.start;
  }
  return k.table;
}

// The header's cell count, read without parting the table.
export function columnsOf(doc, b) {
  const L = b.lines[0];
  return cellCount(doc.text.slice(b.start + L.body, b.start + L.eol));
}

export const isIrregular = (doc, b) => keptOf(doc, b).table.irregular;

export function cellText(doc, t, r, c) {
  const cell = t.rows[r]?.cells[c];
  return cell ? doc.text.slice(cell.start, cell.end) : "";
}

const ownCells = row => {
  const n = row.cells.indexOf(null);
  return n < 0 ? row.cells.length : n;
};

const escapedPipes = text => text.replace(BARE_PIPE, (m, run) => (run.length % 2 ? m : `${run}\\|`));

// `text` as a cell holds it: its line breaks spaces, every pipe that would part cells escaped.
export const cellWritten = text => escapedPipes(String(text ?? "").replace(LINE_BREAK, " "));

function endsInOddBackslashes(text) {
  let n = 0;
  while (n < text.length && text.charCodeAt(text.length - 1 - n) === BSL) n++;
  return n % 2 === 1;
}

// The parser's own answer to whether `line` goes on a table as its next row: a heading, a list, a fence, HTML or
// indented code there would end the table.
function goesOnTable(line) {
  const d = parse(ROW_TEST + line);
  return d.blocks.length === 1 && d.blocks[0].lines.length === 3;
}

// A row's first cell where the row has no leading pipe starts its line, before `rest`: a text that would open a block
// there is escaped.
function asRowStart(text, rest) {
  const t = text.trimStart();
  if (goesOnTable(t + rest)) return t;
  const digits = ORDERED_MARKER.exec(t)?.[0].length ?? 0;
  return `${t.slice(0, digits)}\\${t.slice(digits)}`;
}

// The row on text[body, eol) of a table whose header has `columns` cells, parted as tableOf parts it: { cells (null
// for each the row lacks), lead, trail }. Edits keep a row on its line, so it can be parted again without a parse.
export function rowAt(text, body, eol, columns) {
  const { cells, lead, trail } = partRow(text, body, eol);
  while (cells.length < columns) cells.push(null);
  return { cells, lead, trail };
}

// A pipe at either end, without which an empty first or last cell would be no cell; the pipes at `pipes` (code
// points from the line's body) when that has one for each.
function emptyRow(columns, pipes) {
  if (pipes?.length !== columns + 1) return `|${"  |".repeat(columns)}`;
  let row = "";
  for (const at of pipes) row += `${" ".repeat(at - row.length)}|`;
  return row;
}

// -> the splice that writes an empty row of the header's cells under row `after` of table t (tableOf(doc, b)), padded
// to the pipes of an aligned table, else compact, with the block's container prefix and the file's line end, and
// `cells`: where its cells' text sits once applied. Null for a table block the parser left without a delimiter row.
export function insertRow(doc, b, t, after = t.rows.length - 1) {
  if (b.lines.length < 2) return null;
  const header = b.lines[0], line = b.lines[after === 0 ? 1 : t.rows[after].line], at = b.start + line.eol;
  const pipes = t.aligned ? partRow(doc.text, b.start + header.body, b.start + header.eol).pipes : null;
  const row = emptyRow(t.columns, pipes), insert = `${doc.eol}${b.contPrefix}${row}`, from = at + insert.length - row.length;
  return { start: at, end: at, insert, cells: partRow(row, 0, row.length).cells.map(cell => from + cell.start) };
}

// -> the splice that gives each delimiter cell of table block b `dashes[c]` dashes, its colons, the row's pipes and its
// spaces kept; null when the row has them already. Nothing but the delimiter row changes.
export function writeDashes(doc, b, dashes) {
  const L = b.lines[1], body = b.start + L.body, eol = b.start + L.eol, text = doc.text, { cells } = partRow(text, body, eol);
  let line = "", at = body;
  cells.forEach((cell, c) => {
    line += text.slice(at, cell.start) + text.slice(cell.start, cell.end).replace(DASH_RUN, "-".repeat(dashes[c]));
    at = cell.end;
  });
  line += text.slice(at, eol);
  return line === text.slice(body, eol) ? null : { start: body, end: eol, insert: line };
}

// -> the splice { start, end, insert } that writes `next` as cell c of `row` (rowAt's or a tableOf row) on a line ending
// at `eol`, only the cell's slot changing, with `value`, the cell's text as a field editing it holds it, and `from`,
// where that starts after the splice. The first cell of a row with no leading pipe never opens a block; a first or last
// cell emptied where the row has no pipe at that end gets one, or the row would lose the cell.
export function writeCell(text, row, eol, c, next) {
  const own = ownCells(row), w = cellWritten(next), blank = !w.trim();
  const at = (start, end, insert, from, value = w) => ({ start, end, insert, value, from });
  if (c >= own) {
    if (blank) return at(eol, eol, "", eol);
    if (!row.trail) {
      const insert = `${" |".repeat(c - own + 1)} ${w}`;
      return at(eol, eol, insert, eol + insert.length - w.length);
    }
    const close = text.lastIndexOf("|", eol - 1) + 1;
    return at(close, close, `${" |".repeat(c - own)} ${w} |`, close + 2 * (c - own) + 1);
  }
  const cell = row.cells[c], firstBare = c === 0 && !row.lead, lastBare = c === own - 1 && !row.trail;
  if (cell.start === cell.end) {
    if (blank) return at(cell.start, cell.end, "", cell.start);
    let s = cell.start, e = cell.end;
    while (isBlank(text.charCodeAt(s - 1))) s--;
    while (e < eol && isBlank(text.charCodeAt(e))) e++;
    return at(s, e, ` ${w} `, s + 1);
  }
  if (blank) {
    const insert = firstBare && lastBare ? "| |" : firstBare || lastBare ? "|" : w;
    return at(cell.start, cell.end, insert, cell.start + (insert === w ? 0 : 1));
  }
  const shown = firstBare ? asRowStart(w, text.slice(cell.end, eol)) : w;
  const gap = endsInOddBackslashes(shown) && text.charCodeAt(cell.end) === PIPE ? " " : "";
  return at(cell.start, cell.end, shown + gap, cell.start, shown);
}
