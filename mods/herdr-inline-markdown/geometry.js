// No imports from herdr or gpui-*. Lengths are logical pixels.
import { visibleMap } from "./inline.js";

export const COLUMN = { maxWidth: 780, padX: 32, padTop: 28, padBottom: 160 };
export const REVEAL = { top: 24, bottom: 72 };
export const PAGE_KEEP = 40;

const MONO = new Set(["code", "mermaid", "table", "frontmatter", "html", "definition", "hr"]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const WORD = /[\p{L}\p{N}_]/u;
const NEWLINE = 10, SPACE = 32;

// (x, y) is relative to the block's content box. `target` is { kind, value, fenced, rows, width, height }:
// `fenced` when the field's first and last lines are front matter dashes that Reading does not draw, `rows` the
// measured row count when known. `cal` is { rowPx, advance, monoAdvance }: the row height and the average prose and
// mono character advances. In prose a press lands on the nearest word edge; `side` "start" or "end" takes the start
// or the end of the word it falls in instead, for the ends of a selection.
export function pressToField(target, x, y, cal, side = null) {
  if (MONO.has(target.kind)) return monoPress(target, x, y, cal);
  return textPress(target, x, y, cal, side);
}

function lineStarts(lines) {
  const starts = [0];
  for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + 1);
  return starts;
}

function monoPress(t, x, y, cal) {
  const lines = t.value.split("\n"), starts = lineStarts(lines);
  const first = t.fenced ? Math.min(1, lines.length - 1) : 0;
  const last = Math.max(first, t.fenced && lines.length > 2 ? lines.length - 2 : lines.length - 1);
  const perRow = Math.max(1, Math.floor(t.width / cal.monoAdvance));
  const wrapped = t.rows > last - first + 1;
  let row = Math.max(0, Math.floor(y / cal.rowPx));
  for (let i = first; i <= last; i++) {
    const drawn = lines[i].length, rows = wrapped ? Math.max(1, Math.ceil(drawn / perRow)) : 1;
    if (row < rows || i === last) {
      const r = Math.min(row, rows - 1), col = r * (wrapped ? perRow : 0) + Math.round(Math.max(0, x) / cal.monoAdvance);
      return starts[i] + clamp(col, 0, drawn);
    }
    row -= rows;
  }
  return 0;
}

export function snapToWord(line, at) {
  let best = 0, gap = Infinity;
  for (let i = 0; i <= line.length; i++) {
    const before = i > 0 && WORD.test(line[i - 1]), after = i < line.length && WORD.test(line[i]);
    if (i !== 0 && i !== line.length && before === after) continue;
    if (Math.abs(i - at) < gap) { gap = Math.abs(i - at); best = i; }
  }
  return best;
}

// `map[v]` is the line offset of visible character v. A start is where visible character v is; an end is just past
// the one before it, so the marks Reading hides between them stay outside either.
function wordEdge(line, map, v, side) {
  let i;
  if (side === "start") {
    i = map[v];
    if (WORD.test(line[i] ?? "")) while (i > 0 && WORD.test(line[i - 1])) i--;
  } else {
    i = v > 0 ? map[v - 1] + 1 : map[0];
    if (i > 0 && WORD.test(line[i - 1])) while (i < line.length && WORD.test(line[i])) i++;
  }
  return i;
}

function textPress(t, x, y, cal, side) {
  const lines = t.value.split("\n"), starts = lineStarts(lines);
  const perRow = Math.max(1, Math.floor(t.width / cal.advance));
  let row = Math.max(0, Math.floor(y / cal.rowPx));
  for (let i = 0; i < lines.length; i++) {
    const map = visibleMap(lines[i]), visible = map.length - 1;
    const rows = Math.max(1, Math.ceil((visible * cal.advance) / t.width));
    if (row < rows || i === lines.length - 1) {
      const v = clamp(Math.min(row, rows - 1) * perRow + Math.round(Math.max(0, x) / cal.advance), 0, visible);
      return starts[i] + (side ? wordEdge(lines[i], map, v, side) : snapToWord(lines[i], map[v]));
    }
    row -= rows;
  }
  return 0;
}

// The cells of a table field: for each line, the trimmed text range of each cell in field offsets, and whether the
// line is the delimiter row.
export function tableCells(value) {
  const lines = value.split("\n"), starts = lineStarts(lines);
  return lines.map((line, li) => {
    const bounds = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") i++;
      else if (line[i] === "|") bounds.push(i);
    }
    const lead = line.trimStart().startsWith("|"), trail = bounds.length > 0 && bounds.at(-1) === line.trimEnd().length - 1;
    const edges = [lead ? bounds[0] : -1, ...bounds.slice(lead ? 1 : 0, trail ? -1 : undefined), trail ? bounds.at(-1) : line.length];
    const cells = [];
    for (let k = 0; k + 1 < edges.length; k++) {
      let s = edges[k] + 1, e = edges[k + 1];
      const empty = !line.slice(s, e).trim();
      if (empty) {
        s = e = Math.min(s + 1, e);
      } else {
        while (s < e && /[ \t]/.test(line[s])) s++;
        while (e > s && /[ \t]/.test(line[e - 1])) e--;
      }
      cells.push({ start: starts[li] + s, end: starts[li] + e });
    }
    return { start: starts[li], cells, delimiter: li === 1 && /^[\s|:-]+$/.test(line) };
  });
}

// The cell start under a press on a table Reading's TextView draws from its source (`t` as for pressToField): its
// drawn rows share the height equally, its columns the width by their longest cells.
export function tablePress(t, x, y) {
  const rows = tableCells(t.value), drawn = rows.filter(r => !r.delimiter);
  if (!drawn.length) return 0;
  const r = clamp(Math.floor(y / (t.height / drawn.length)), 0, drawn.length - 1);
  const columns = Math.max(...drawn.map(d => d.cells.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(1, ...drawn.map(d => (d.cells[c] ? d.cells[c].end - d.cells[c].start : 0))));
  const total = widths.reduce((a, b) => a + b, 0);
  let c = 0, edge = (widths[0] / total) * t.width;
  while (c < columns - 1 && x >= edge) edge += (widths[++c] / total) * t.width;
  const cells = drawn[r].cells;
  return cells.length ? cells[Math.min(c, cells.length - 1)].start : drawn[r].start;
}

// A table drawn as a grid of cells: `padX` and `padY` inside each cell, `line` px between rows, between columns and
// round the grid, its corners rounded `radius`; a column at least `minW` px wide, at most `maxW` unless dashes set it.
export const GRID = { padX: 10, padY: 6, line: 1, minW: 64, maxW: 360, radius: 6 };

export const naturalWidth = widest => clamp(Math.ceil(widest) + 2 * GRID.padX, GRID.minW, GRID.maxW);

// -> the width of each column, its padding in and its lines out: `widest[c]` is the px width of column c's widest text.
// The natural widths when they fit `room`. Else a column whose natural width fits an equal share of what is left keeps
// it, again until no more do, and the others share the rest equally; when not even minW each fits, every column gets
// minW and the grid is wider than the room.
export function columnWidths(widest, room) {
  const n = widest.length, natural = widest.map(naturalWidth);
  if (natural.reduce((a, b) => a + b, 0) <= room) return natural;
  if (n * GRID.minW > room) return natural.map(() => GRID.minW);
  const widths = new Array(n).fill(0);
  let left = room, free = n, kept = true;
  while (kept && free > 0) {
    kept = false;
    const share = left / free;
    for (let c = 0; c < n; c++) {
      if (widths[c] || natural[c] > share) continue;
      widths[c] = natural[c];
      left -= natural[c];
      free--;
      kept = true;
    }
  }
  return widths.map(w => w || Math.floor(left / free));
}

// The estimated height of each row of a grid whose cells show `shown` (rows of texts) in columns `widths` wide: the
// cell whose text wraps to the most rows at its style's advance, those rows at its style's row height, the padding,
// and the line under each row but the last. The first row is the header, in `head`'s style; `body` = { row, advance }.
export function gridRowHeights(shown, widths, head, body) {
  return shown.map((cells, r) => {
    const st = r === 0 ? head : body;
    let rows = 1;
    for (let c = 0; c < cells.length; c++) rows = Math.max(rows, wrapRows(cells[c], Math.max(1, (widths[c] ?? GRID.minW) - 2 * GRID.padX), st.advance).length);
    return rows * st.row + 2 * GRID.padY + (r < shown.length - 1 ? GRID.line : 0);
  });
}

// The top of row `r` of a grid whose rows are `heights` tall, from the grid's top edge.
export const gridRowTop = (heights, r) => {
  let y = GRID.line;
  for (let k = 0; k < r && k < heights.length; k++) y += heights[k];
  return y;
};

// The row and column of a grid at (x, y) from its top-left corner, the rows `heights` tall and the columns `widths`
// wide, each with the line after it; a point past an edge takes the cell nearest it.
export function gridAt(heights, widths, x, y) {
  let row = 0, column = 0;
  for (let top = GRID.line; row < heights.length - 1 && y >= top + heights[row]; row++) top += heights[row];
  for (let left = GRID.line; column < widths.length - 1 && x > left + widths[column]; column++) left += widths[column] + GRID.line;
  return { row, column };
}

// Column widths are saved as the delimiter row's dashes; a table with a column of more than `min` dashes is sized by them.
export const DASHES = { min: 3 };
export const isSized = dashes => dashes.some(n => n > DASHES.min);
export const dashWidth = (dashes, advance) => Math.max(GRID.minW, Math.ceil(Math.max(DASHES.min, dashes) * advance) + 2 * GRID.padX);

const fewestDashes = advance => Math.max(DASHES.min + 1, Math.ceil((GRID.minW - 2 * GRID.padX) / advance));

// The dashes nearest a column `width` px wide, for a width the pointer sets.
export function dashesFor(width, advance) {
  return Math.max(fewestDashes(advance), Math.round((width - 2 * GRID.padX) / advance));
}

// The fewest dashes whose column is at least `width` px wide, for a width a column has or its text needs.
export function dashesAtLeast(width, advance) {
  const n = Math.max(fewestDashes(advance), Math.floor((width - 2 * GRID.padX) / advance));
  return dashWidth(n, advance) >= width ? n : n + 1;
}

// A column's line is grabbed `grab` px either side of it and drawn `line` px wide while it can be dragged.
export const RESIZE = { grab: 4, line: 2 };

// From the grid's left edge; the last column's line is the grid's right edge.
export function lineX(widths, c) {
  let x = GRID.line;
  for (let k = 0; k <= c; k++) x += widths[k] + (k < c ? GRID.line : 0);
  return x;
}

// The column whose right line is within RESIZE.grab px of x (from the grid's left edge), the nearest; -1 for none.
export function lineNear(widths, x) {
  let best = -1, far = Infinity;
  for (let c = 0, at = GRID.line; c < widths.length; c++) {
    at += widths[c];
    const off = x < at ? at - x : x - at - GRID.line;
    if (off <= RESIZE.grab && off < far) { best = c; far = off; }
    at += GRID.line;
  }
  return best;
}

// The least move from `pan` that shows [from, to] in a strip `room` px wide; a span wider than the room shows its start.
export function revealSpan(pan, room, from, to) {
  if (to - from > room || from < pan) return from;
  return to > pan + room ? to - room : pan;
}

// How Herdr's TextView draws a table (gpui-kit text/node.rs render_table, render_table_rows): a 1 px frame round its
// rows; each row its line of text with `py` px above and below, and a 1 px rule under it but the last.
export const TABLE_VIEW = { frame: 1, py: 7, rule: 1 };

// The top of drawn row `row` (0 the header) of a table whose rows hold one line `lineH` px tall each, from the top of
// what holds it, `inset` px above its frame. A cell that wraps makes its row taller and puts the rows after it lower.
export const tableRowTop = (row, lineH, inset = 0) => inset + TABLE_VIEW.frame + row * (2 * TABLE_VIEW.py + lineH + TABLE_VIEW.rule);

// -> { start, end } of the neighbouring cell's trimmed text, or null past the first or last cell.
export function nextCell(value, caret, dir) {
  const all = tableCells(value).filter(r => !r.delimiter).flatMap(r => r.cells);
  let at = 0;
  for (let i = 0; i < all.length; i++) if (all[i].start <= caret) at = i;
  const next = all[at + (dir > 0 ? 1 : -1)];
  return next ? { start: next.start, end: next.end } : null;
}

// The offset each row of `text` starts at in a field `width` px wide, every character `advance` px, wrapped as the field
// wraps (gpui's LineWrapper): a row breaks before the word that would pass its edge, the spaces after a word counting,
// or inside a word too wide for a row where it overflows; a line break always starts one. A word that fits is taken
// whole with the space after it: a call per letter costs too much in Herdr's runtime. Counts are in characters, and
// `room` is how many fit.
export function wrapRows(text, width, advance) {
  const rows = [0], room = Math.max(1, width / advance);
  let used = 0, wordAt = -1, usedBefore = 0, rowAt = 0, prev = NEWLINE, seen = false, lineEnd = lineEndFrom(text, 0);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === NEWLINE) {
      rows.push(i + 1);
      used = 0; wordAt = -1; rowAt = i + 1; prev = c; seen = false; lineEnd = lineEndFrom(text, i + 1);
      continue;
    }
    if (c !== SPACE && prev === SPACE && seen) { wordAt = i; usedBefore = used; }
    if (c !== SPACE) {
      seen = true;
      const space = text.indexOf(" ", i), end = space < 0 || space > lineEnd ? lineEnd : space, word = end - i;
      if (used + word <= room) {
        const spaced = end === space && used + word + 1 <= room;
        used += spaced ? word + 1 : word;
        prev = spaced ? SPACE : c;
        i = spaced ? end : end - 1;
        continue;
      }
    }
    prev = c;
    used++;
    if (used <= room || i <= rowAt) continue;
    if (wordAt > rowAt && used - usedBefore <= room) { rowAt = wordAt; used -= usedBefore; }
    else { rowAt = i; used = 1; }
    wordAt = -1;
    rows.push(rowAt);
  }
  return rows;
}

function lineEndFrom(text, from) {
  const end = text.indexOf("\n", from);
  return end < 0 ? text.length : end;
}

// The offset each line of `text` starts at.
export function lineOffsets(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

// The row of `rows` (wrapRows) holding offset `at` and its x from the row's left. `end` takes an offset where a row
// starts as the end of the row before, as the end of a range is.
export function wrapPlace(rows, at, advance, end = false) {
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid] <= at) lo = mid; else hi = mid - 1;
  }
  if (end && lo > 0 && rows[lo] === at) lo--;
  return { row: lo, x: (at - rows[lo]) * advance };
}

// The `rows=one` key context. The width estimate drops it as a line is about to wrap, before on_size_change reports
// the new row 13-24 ms later.
export const isOneRow = ({ value, height, rowPx, width, advance }) =>
  !value.includes("\n") && height < 1.5 * rowPx && value.length * advance < 0.9 * width;

// Comments as cards in a column right of the page: the page column (its padding included, as COLUMN.maxWidth) at least
// `minPage` wide, `edge` kept from the pane's sides.
export const MARGIN = { minPage: 520, gap: 24, card: 260, edge: 16 };

// -> { pageW, pageLeft, cardLeft, cardW } in pane x, the page column and the card column centered together; null when
// the pane is too narrow for both.
export function marginLayout(viewW) {
  const room = viewW - 2 * MARGIN.edge - MARGIN.gap - MARGIN.card;
  if (room < MARGIN.minPage) return null;
  const pageW = Math.min(COLUMN.maxWidth, room), pageLeft = Math.floor((viewW - pageW - MARGIN.gap - MARGIN.card) / 2);
  return { pageW, pageLeft, cardLeft: pageLeft + pageW + MARGIN.gap, cardW: MARGIN.card };
}

export const columnLeft =(viewportW, margin = null) => (margin ? margin.pageLeft : Math.max(0, (viewportW - COLUMN.maxWidth) / 2)) + COLUMN.padX;
// `localX` is a pointer x in md-viewport coordinates.
export const columnX = (localX, viewportW, margin = null) => localX - columnLeft(viewportW, margin);
export const maxOffset = (contentH, viewportH) => Math.max(0, contentH - viewportH);
export const clampOffset = (offset, contentH, viewportH) => clamp(offset, 0, maxOffset(contentH, viewportH));

// Block tops from their heights: sums[i] is block i's top, sums[n] the column's height (padding not included).
export function prefixSums(heights) {
  const sums = new Array(heights.length + 1);
  sums[0] = 0;
  for (let i = 0; i < heights.length; i++) sums[i + 1] = sums[i] + heights[i];
  return sums;
}

// The block whose span holds content y, clamped to the first and last block; -1 when there are none.
export function blockAt(sums, y) {
  const n = sums.length - 1;
  if (n <= 0) return -1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sums[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export const estimateHeight = (lineCount, rowPx, spaceBefore = 0) => spaceBefore + Math.max(1, lineCount) * rowPx;

export const caretY = ({ blockTop, padTop = 0, chromeTop = 0, rowPx, row }) => blockTop + padTop + chromeTop + rowPx * row;

// Keeps [y, y + rowPx] inside the REVEAL margins, moving the least.
export function revealOffset({ offset, viewportH, y, rowPx, contentH = Infinity }) {
  let o = offset;
  if (y < offset + REVEAL.top) o = y - REVEAL.top;
  else if (y + rowPx > offset + viewportH - REVEAL.bottom) o = y + rowPx - viewportH + REVEAL.bottom;
  return clamp(o, 0, maxOffset(contentH, viewportH));
}

// The offset that keeps an anchor at the screen y it had: its content top moved from `before` to `after`.
export const anchorOffset = ({ offset, before, after, contentH = Infinity, viewportH = 0 }) =>
  clamp(offset + after - before, 0, maxOffset(contentH, viewportH));

// The anchor before a height change: the active block when its caret row is on screen, else the first block whose
// bottom is below the offset. -> its index.
export function anchorBlock({ sums, offset, viewportH, active = -1, caretY: y = null }) {
  if (active >= 0 && y !== null && y >= offset && y < offset + viewportH) return active;
  const n = sums.length - 1;
  for (let i = blockAt(sums, offset); i >= 0 && i < n; i++) if (sums[i + 1] > offset) return i;
  return n - 1;
}

// A pending reveal: the offset that puts content y `rowY` of a block at `fraction` of the viewport height.
export const revealAt = ({ top, rowY = 0, fraction, viewportH, contentH = Infinity }) =>
  clamp(top + rowY - fraction * viewportH, 0, maxOffset(contentH, viewportH));

export const pageStep = viewportH => Math.max(0, viewportH - PAGE_KEEP);

// `dpr` is the backing scale the sharp picture is made for: the API gives none, and 2 is this machine's sharpest
// screen (a 1x screen only spends memory on it). `sharpBudget` is the most pixels a sharp picture may have.
export const FRAME = {
  margin: 32, pad: 12, minH: 120, maxShare: 0.7, edgeV: 24, readable: 0.75, zMax: 2, zoomPerPx: 0.005, settleMs: 300,
  dpr: 2, sharpBudget: 40e6, maxPx: 16000,
  tools: { top: 8, right: 8, h: 26, out: 26, pct: 48, in: 26, comment: 26, gap: 6 },
};
export const WHEEL = { gapMs: 150, decidePx: 8, sideways: 2 };
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];
const SAME_ZOOM = 0.005;
// Half a pixel: frame sizes are rounded, so content that fits exactly may measure a fraction over.
const SLACK = 0.5;

// natW x natH are the picture's layout px; the block's column part starts at blockLeft (viewport x). -> { w, h, left,
// ml, z0, zMin }: `left` in viewport x, `ml` the margin that moves the frame there from the block's left edge (never
// positive), `z0` the starting zoom and `zMin` the one that shows the whole picture.
export function frameBox({ viewW, viewH, blockLeft, blockW, natW, natH }) {
  const F = FRAME, pageW = Math.max(blockW, viewW - 2 * F.margin), maxH = Math.max(F.minH, Math.floor(viewH * F.maxShare));
  const fitW = (pageW - 2 * F.pad) / natW, fitAll = Math.min(fitW, (maxH - 2 * F.pad) / natH);
  const z0 = fitAll >= F.readable ? Math.min(1, fitAll) : Math.min(1, Math.max(F.readable, fitW));
  const w = Math.round(clamp(natW * z0 + 2 * F.pad, blockW, pageW)), h = Math.round(clamp(natH * z0 + 2 * F.pad, F.minH, maxH));
  const left = w > blockW ? (viewW - w) / 2 : blockLeft;
  const whole = Math.min((w - 2 * F.pad) / natW, (h - 2 * F.pad) / natH);
  return { w, h, left, ml: left - blockLeft, z0, zMin: Math.min(z0, Math.max(0.1, whole)) };
}

// A flowchart drawn top-down starts at its top centre; other diagrams at their left. The first line that is not a
// `%%` comment or directive, after any front matter, says which.
export function topDown(source) {
  const lines = String(source ?? "").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() === "---") {
    i++;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    const m = /^(?:flowchart|graph)(?:\s+(\w+))?/i.exec(line);
    return Boolean(m) && (!m[1] || /^(TB|TD|BT)$/i.test(m[1]));
  }
  return false;
}

const fits = (frame, content) => content <= frame - 2 * FRAME.pad + SLACK;
const roamAxis = (frame, content, at) => clamp(at, Math.min(frame / 2 - content, FRAME.pad), Math.max(frame / 2, frame - FRAME.pad - content));

// The picture's place in a frame `box` ({ w, h }) for the view { z, x, y }: the canvas pans on past the picture's
// edges until any point of it reaches the frame's centre, and a picture smaller than the frame goes anywhere in it.
export const clampView = (box, nat, v) => ({ z: v.z, x: roamAxis(box.w, nat.w * v.z, v.x), y: roamAxis(box.h, nat.h * v.z, v.y) });

export const overflows = (box, nat, z) => ({ x: !fits(box.w, nat.w * z), y: !fits(box.h, nat.h * z) });

// The view a frame opens with: zoom z, the top of the picture (centred when it fits), and its left edge or (fitting,
// or a top-down flowchart) its centre.
export function startView(box, nat, z, fromTop) {
  const wide = nat.w * z, tall = nat.h * z;
  const x = fits(box.w, wide) || fromTop ? (box.w - wide) / 2 : FRAME.pad, y = fits(box.h, tall) ? (box.h - tall) / 2 : FRAME.pad;
  return clampView(box, nat, { z, x, y });
}

// Zoom to z1 with the picture's point under frame point (fx, fy) kept there, unless the clamp moves it.
export function zoomAround(box, nat, v, z1, fx, fy) {
  const k = z1 / v.z;
  return clampView(box, nat, { z: z1, x: fx - (fx - v.x) * k, y: fy - (fy - v.y) * k });
}

// dir < 0 zooms out. The steps include the frame's own z0 and zMin, within [zMin, zMax]; at an end it stays z.
export function zoomStep(z, dir, z0, zMin) {
  const steps = [...new Set([...ZOOM_STEPS, z0, zMin])].filter(s => s >= zMin - 1e-9 && s <= FRAME.zMax + 1e-9).sort((a, b) => a - b);
  if (dir < 0) return steps.filter(s => s < z - SAME_ZOOM).at(-1) ?? z;
  return steps.find(s => s > z + SAME_ZOOM) ?? z;
}

export const canZoom = (z, dir, zMin) => (dir < 0 ? z > zMin + SAME_ZOOM : z < FRAME.zMax - SAME_ZOOM);

// Where the − % + group sits in a frame of height h whose top is at screenTop in the viewport: at the frame's top
// right, kept below the top of the page while the frame's top is above it.
export const toolsTop = (h, screenTop) => clamp(Math.max(FRAME.tools.top, FRAME.edgeV - screenTop), FRAME.tools.top, h - FRAME.tools.h - FRAME.tools.top);

// The − % + group's width, its 1 px border included.
export const TOOLS_W = FRAME.tools.out + FRAME.tools.pct + FRAME.tools.in + 2;

// -> "out", "pct", "in", "comment" (the Comment button `gap` left of the group, while `comment` says it is drawn) or
// null. The group's 1 px border counts with the cell beside it.
export function frameTool(fx, fy, w, top, comment = false) {
  const T = FRAME.tools, x = fx - (w - T.right - TOOLS_W);
  if (fy < top || fy >= top + T.h) return null;
  if (comment && x >= -T.gap - T.comment && x < -T.gap) return "comment";
  if (x < 0 || x >= TOOLS_W) return null;
  return x < T.out + 1 ? "out" : x < T.out + 1 + T.pct ? "pct" : "in";
}

// The scale a sharp picture of a natW x natH diagram is drawn at for app zoom `appZoom`: enough for zMax, under maxPx
// a side and inside the pixel budget, in quarters.
export function sharpScale({ w, h }, appZoom) {
  const F = FRAME, s = Math.min(F.dpr * appZoom * F.zMax, F.maxPx / Math.max(w, h), Math.sqrt(F.sharpBudget / (w * h)));
  return Math.floor(s * 4) / 4;
}

// The slash menu: `pad` inside its 1 px border, `gap` from the caret row, `margin` kept from the pane's edges.
export const MENU = { w: 264, rowH: 31, pad: 5, gap: 6, margin: 8, fullRows: 12 };
export const menuH = rows => 2 * MENU.pad + 2 + rows * MENU.rowH;

// Below the caret row when the whole list fits there, else above when it does, else on the roomier side. A `side`
// given is kept, so filtering never flips the menu; above, its bottom edge stays by the row.
export function menuPlace({ rowTop, rowH, viewH, n, side = null }) {
  const room = { below: viewH - (rowTop + rowH) - MENU.gap - MENU.margin, above: rowTop - MENU.gap - MENU.margin };
  const full = menuH(MENU.fullRows);
  const s = side ?? (room.below >= full ? "below" : room.above >= full ? "above" : room.below >= room.above ? "below" : "above");
  const rows = Math.max(1, n), visible = clamp(Math.floor((room[s] - 2 * MENU.pad - 2) / MENU.rowH), 1, rows);
  const h = menuH(Math.min(rows, visible));
  return { side: s, top: s === "below" ? rowTop + rowH + MENU.gap : rowTop - MENU.gap - h, h, visible };
}

// The menu's left edge for a slash at pane x `x`. The pane wins over the column when it is too narrow for both.
export function slashX({ x, viewW, margin = null }) {
  return Math.max(0, Math.min(viewW - MENU.w - MENU.margin, Math.max(columnLeft(viewW, margin), x)));
}

// The format bar: square buttons, a menu's button wider by its chevron, groups parted by a rule `sep` wide, rows
// `rowGap` apart, in `pad` and a 1 px border; `gap` from the selected rows, `margin` from the pane's edges.
export const BAR = { button: 28, chevron: 12, sep: 9, rowGap: 2, pad: 4, gap: 6, margin: 8 };

// Rows no wider than `maxW`, breaking between groups unless a group is wider than a row. -> `rows` of items ({ name })
// and rules ({ sep: true }), `at[name]` an item's box in the bar, its border included.
export function barLayout(groups, maxW = Infinity) {
  const edge = BAR.pad + 1, room = maxW - 2 * edge, rows = [[]], at = {};
  let x = 0, widest = 0;
  const nextRow = () => { rows.push([]); x = 0; };
  for (const group of groups) {
    const width = group.reduce((sum, item) => sum + item.w, 0);
    if (x > 0 && x + BAR.sep + width <= room) { rows.at(-1).push({ sep: true }); x += BAR.sep; }
    else if (x > 0) nextRow();
    for (const item of group) {
      if (x > 0 && x + item.w > room) nextRow();
      rows.at(-1).push({ name: item.name });
      at[item.name] = { x: edge + x, y: edge + (rows.length - 1) * (BAR.button + BAR.rowGap), w: item.w, h: BAR.button };
      x += item.w;
      widest = Math.max(widest, x);
    }
  }
  return { w: widest + 2 * edge, h: rows.length * BAR.button + (rows.length - 1) * BAR.rowGap + 2 * edge, rows, at };
}

export const NOTE_BOX = { w: 320, h: 44, pad: 6 };

// Over the first selected row with its left edge at pane x `x`, else under the last when there is no room above (row
// tops in pane y), for a float of `size` { w, h }. -> { side, top, left, w, h }, or null while that row is out of the
// pane.
export function barPlace({ firstTop, lastTop, rowH, size, viewW, viewH, x }) {
  const { w, h } = size, above = firstTop - BAR.gap - h;
  let side, top;
  if (above >= BAR.margin && firstTop < viewH) [side, top] = ["above", above];
  else if (lastTop + rowH > 0 && lastTop < viewH) [side, top] = ["below", Math.min(lastTop + rowH + BAR.gap, viewH - BAR.margin - h)];
  else return null;
  return { side, top, left: clamp(x, BAR.margin, viewW - BAR.margin - w), w, h };
}

// A link's popover: its address, at most `addressChars` long and about `charW` px a character, in `addressPad` each
// side, then a rule and four buttons in the bar's padding and border. The address box is `LINK_BOX`, `pad` inside it.
export const LINK_POP = { addressChars: 40, charW: 6.6, addressPad: 8, buttons: 4 };
export const LINK_BOX = { w: 340, h: 40, pad: 6 };

// A float in the link popover's look: an address `chars` long, then `buttons` buttons with `rules` rules among them.
export function popoverSize(chars, buttons, rules) {
  const edge = BAR.pad + 1, address = Math.max(1, chars) * LINK_POP.charW + 2 * LINK_POP.addressPad;
  return { w: Math.ceil(address + rules * BAR.sep + buttons * BAR.button + 2 * edge), h: BAR.button + 2 * edge };
}

export const linkPopoverSize = chars => popoverSize(chars, LINK_POP.buttons, 1);

// Over the first row of a range (row tops in pane y) with its left edge at pane x `x`, else under its last row when
// there is no room above, as low as the pane keeps it, for a float of `size` { w, h } narrowed to the pane. -> { side,
// top, left, w, h }, or null while the range is out of the pane.
export function popoverPlace({ firstTop, lastTop, rowH, size, viewW, viewH, x }) {
  const w = Math.min(size.w, viewW - 2 * BAR.margin), h = size.h, over = firstTop - BAR.gap - h;
  if (lastTop + rowH <= 0 || firstTop >= viewH) return null;
  const [side, top] = over >= BAR.margin ? ["above", over] : ["below", Math.min(lastTop + rowH + BAR.gap, viewH - BAR.margin - h)];
  return { side, top, left: clamp(x, BAR.margin, viewW - BAR.margin - w), w, h };
}

// The bar's menus: rows `rowH` tall and section titles `titleH`, in `pad` and a 1 px border, `gap` under their button.
export const BAR_MENU = { w: 220, rowH: 28, titleH: 26, pad: 4, gap: 4 };
export const barMenuH = (rows, titles = 0) => rows * BAR_MENU.rowH + titles * BAR_MENU.titleH + 2 * BAR_MENU.pad + 2;

// Under `button` (barLayout's `at`), else over the bar, else as low as the pane keeps it; at the button's left edge.
export function barMenuPlace({ bar, button, h, viewW, viewH }) {
  const w = Math.min(BAR_MENU.w, viewW - 2 * BAR.margin);
  const below = bar.top + button.y + button.h + BAR_MENU.gap, above = bar.top - BAR_MENU.gap - h;
  const fits = top => top >= BAR.margin && top + h <= viewH - BAR.margin;
  const top = fits(below) ? below : fits(above) ? above : clamp(below, BAR.margin, viewH - BAR.margin - h);
  return { left: clamp(bar.left + button.x, BAR.margin, viewW - BAR.margin - w), top, w, h };
}

// A code block's box starts with a strip CODE_HEAD tall, its language chip at the right: the name about `charW` px a
// character in `padX` each side, then `gap` and the chevron of a chip that opens the menu.
export const CODE_HEAD = 28;
export const CHIP = { h: 22, padX: 7, charW: 6.4, gap: 3, chevron: 12 };
export const chipW = (name, chevron) => Math.ceil(2 * CHIP.padX + [...name].length * CHIP.charW + (chevron ? CHIP.gap + CHIP.chevron : 0));

// A code block's or table's Comment button: a square as tall as the chip, `gap` left of the chip (or of the comment
// count beside it), `inset` from a table box's top right corner.
export const BLOCK_BUTTON = { size: CHIP.h, gap: 4, inset: 6 };

// The language menu: a search box `searchH` tall over rows in the bar menus' look, `gap` from its chip.
export const LANG_MENU = { searchH: 32, gap: 4 };
export const languageMenuH = rows => barMenuH(rows) + LANG_MENU.searchH;

// Under the chip (a box in pane coordinates) with their right edges aligned, else over it when only that side has
// room for the menu at its tallest (`full`), so filtering never flips it; kept inside the pane. -> { side, left, top, w, h }
export function languageMenuPlace({ chip, h, full = h, viewW, viewH }) {
  const w = Math.min(BAR_MENU.w, viewW - 2 * BAR.margin), below = chip.y + chip.h + LANG_MENU.gap, above = chip.y - LANG_MENU.gap;
  const side = below + full > viewH - BAR.margin && above - full >= BAR.margin ? "above" : "below";
  const top = clamp(side === "below" ? below : above - h, BAR.margin, viewH - BAR.margin - h);
  return { side, left: clamp(chip.x + chip.w - w, BAR.margin, viewW - BAR.margin - w), top, w, h };
}

export const NOTES = { w: 40, h: 22, gap: 10, margin: 12 };

// A block's comment count: at its first row, `gap` right of the text column when that leaves `margin` before the pane's
// edge, else inside the column at its right edge. -> { x, y } from the block's top-left.
export function notesPlace({ viewW, textW, space, rowH }) {
  const outside = columnLeft(viewW) + textW + NOTES.gap + NOTES.w + NOTES.margin <= viewW;
  return { x: outside ? textW + NOTES.gap : textW - NOTES.w, y: space + (rowH - NOTES.h) / 2 };
}

// `entryH` estimates the height of one comment on the card.
export const CARD = { w: 300, pad: 10, entryH: 76, gap: 6, margin: 8 };

// Under the count icon, right edges aligned, else over it when only that has room. -> { side, top | bottom, left, w }
export function cardPlace({ iconTop, iconLeft, n, viewW, viewH }) {
  const h = 2 * CARD.pad + n * CARD.entryH, below = iconTop + NOTES.h + CARD.gap;
  const left = clamp(iconLeft + NOTES.w - CARD.w, CARD.margin, viewW - CARD.margin - CARD.w);
  const roomAbove = iconTop - CARD.gap - h >= CARD.margin;
  if (below + h <= viewH - CARD.margin || !roomAbove) return { side: "below", top: below, left, w: CARD.w };
  return { side: "above", bottom: viewH - iconTop + CARD.gap, left, w: CARD.w };
}

// A comment card: its time (and the active card's Resolve) on a row `headH` tall over its text, whose lines hold about
// `w / charW` characters; `lines` of them unless it shows in full.
export const CARDS ={ w: MARGIN.card, pad: 10, rowGap: 4, headH: 20, textSize: 13, lineH: 19, charW: 6.8, lines: 3, gap: 8 };
const CARD_EDGE = 2 + 2 * CARDS.pad;
const perCardLine = () => Math.max(1, Math.floor((CARDS.w - CARD_EDGE) / CARDS.charW));

// What a card with comment `text` shows and how tall it is: clipped to CARDS.lines with an ellipsis unless `full`,
// `header` when it has a row for its time, `extra` px for what else it holds. -> { text, h }
export function cardLook({ text, header, full = false, extra = 0 }) {
  const perLine = perCardLine(), chars = [...String(text ?? "")], fits = CARDS.lines * perLine;
  const clipped = !full && chars.length > fits, shown = clipped ? `${chars.slice(0, fits - 1).join("").trimEnd()}…` : chars.join("");
  const lines = clipped ? CARDS.lines : Math.max(1, Math.ceil(chars.length / perLine));
  return { text: shown, h: CARD_EDGE + (header ? CARDS.headH + CARDS.rowGap : 0) + lines * CARDS.lineH + extra };
}

// -> the tops of cards { want, h } in document order, a card that would overlap the one before just under it.
export function stackCards(items) {
  const tops = new Array(items.length);
  let free = -Infinity;
  for (let i = 0; i < items.length; i++) {
    tops[i] = Math.max(items[i].want, free);
    free = tops[i] + items[i].h + CARDS.gap;
  }
  return tops;
}

export const startsGesture = (last, phase, now) => !last || phase === "started" || now - last.at > WHEEL.gapMs;

// The axis of a gesture over a frame that pans sideways, once it has moved far enough to tell: sideways only when
// clearly more sideways than down, so that a vertical swipe whose first event is (1, 0) still scrolls the page.
export function decideAxis(sx, sy) {
  if (Math.abs(sx) + Math.abs(sy) < WHEEL.decidePx) return null;
  return Math.abs(sx) > WHEEL.sideways * Math.abs(sy) ? "x" : "y";
}

// A vertical wheel step `down` px down the page (negative: up) with the pointer over a frame whose picture is
// taller than the frame: as if the picture were laid out at its full height in the page. The page brings the frame
// fully into view, the picture pans by what is left, and what its clamp refuses goes back to the page. A frame
// already passed (partly out on the side the page moves away from) is left to the page, and its picture takes only
// what the page, at its end, cannot. `top` and `h` are the frame's in the viewport, `y` its picture's offset, kept
// in [minY, maxY]. -> { offset, y }.
export function passThrough({ down, offset, maxOffset, top, h, viewH, y, minY, maxY }) {
  const E = FRAME.edgeV, dir = Math.sign(down), step = Math.abs(down);
  const room = Math.max(0, dir > 0 ? maxOffset - offset : offset);
  const passed = dir > 0 ? top < -SLACK : top + h > viewH + SLACK;
  const toView = passed ? Infinity : Math.max(0, dir > 0 ? top + h - (viewH - E) : E - top);
  const page = Math.min(step, toView, room);
  const y1 = clamp(y - dir * (step - page), minY, maxY), back = step - page - dir * (y - y1);
  return { offset: offset + dir * (page + Math.min(back, room - page)), y: y1 };
}

// The pictures of an image paragraph: `gap` between them, and a box `boxH` high where a picture is not ready.
export const PICTURE = { gap: 8, boxH: 40 };
// A scaled width can come out a hair under the whole number it was scaled to.
const SCALE_SLACK = 1e-9;

function pictureSize(item, width) {
  if (item.state !== "ok" || !(item.natW > 0 && item.natH > 0)) return { w: width, h: PICTURE.boxH };
  const scale = Math.min(1, width / item.natW);
  return { w: Math.max(1, Math.floor(item.natW * scale + SCALE_SLACK)), h: Math.max(1, Math.round(item.natH * scale)) };
}

// `items` are { state, natW, natH }. A picture keeps its size, shrunk to `width` and never enlarged; they flow left to
// right and wrap, rows `gap` apart, each as tall as its tallest and each picture at its top. -> { boxes: [{ x, y, w, h }],
// height }.
export function pictureLayout(items, width) {
  const boxes = [];
  let x = 0, y = 0, rowH = 0;
  for (const item of items) {
    const { w, h } = pictureSize(item, width);
    if (rowH > 0) {
      if (x + PICTURE.gap + w > width) { y += rowH + PICTURE.gap; x = 0; rowH = 0; } else x += PICTURE.gap;
    }
    boxes.push({ x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
  }
  return { boxes, height: y + rowH };
}
