// Where a press lands in a block's field, and the page arithmetic of the Reading viewport. Pure: no imports from
// herdr or gpui-*. Lengths are logical pixels.
import { codeIndent, visibleMap } from "./blocks.js";

export const COLUMN = { maxWidth: 780, padX: 32, padTop: 28, padBottom: 160 };
export const REVEAL = { top: 24, bottom: 72 };
export const PAGE_KEEP = 40;

const MONO = new Set(["code", "mermaid", "frontmatter", "html", "definition", "hr"]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const WORD = /[\p{L}\p{N}_]/u;

// The field offset a press at (x, y), relative to the block's content box, lands on. `target` is
// { kind, value, fenced, closed, rows, width, height }: `fenced` when the field's first line is a fence or front
// matter dashes that Reading does not draw, `rows` the measured row count when known. The code indent Reading does
// not draw is read off the value. `cal` is { rowPx, advance, monoAdvance }: the row height and the average prose and
// mono character advances.
export function pressToField(target, x, y, cal) {
  if (target.kind === "table") return tablePress(target, x, y);
  if (MONO.has(target.kind)) return monoPress(target, x, y, cal);
  return textPress(target, x, y, cal);
}

function lineStarts(lines) {
  const starts = [0];
  for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + 1);
  return starts;
}

function monoPress(t, x, y, cal) {
  const lines = t.value.split("\n"), starts = lineStarts(lines);
  const first = t.fenced ? Math.min(1, lines.length - 1) : 0;
  const last = Math.max(first, t.fenced && t.closed !== false && lines.length > 2 ? lines.length - 2 : lines.length - 1);
  const perRow = Math.max(1, Math.floor(t.width / cal.monoAdvance));
  const wrapped = t.rows > last - first + 1;
  const code = t.kind === "code" || t.kind === "mermaid";
  const fenceIndent = !code ? 0 : t.fenced ? /^ */.exec(lines[0])[0].length : null;
  let row = Math.max(0, Math.floor(y / cal.rowPx));
  for (let i = first; i <= last; i++) {
    const indent = codeIndent(lines[i], fenceIndent), drawn = lines[i].length - indent;
    const rows = wrapped ? Math.max(1, Math.ceil(drawn / perRow)) : 1;
    if (row < rows || i === last) {
      const r = Math.min(row, rows - 1), col = r * (wrapped ? perRow : 0) + Math.round(Math.max(0, x) / cal.monoAdvance);
      return starts[i] + indent + clamp(col, 0, drawn);
    }
    row -= rows;
  }
  return 0;
}

// The nearest offset in `line` where a word starts or ends (or the line's ends).
export function snapToWord(line, at) {
  let best = 0, gap = Infinity;
  for (let i = 0; i <= line.length; i++) {
    const before = i > 0 && WORD.test(line[i - 1]), after = i < line.length && WORD.test(line[i]);
    if (i !== 0 && i !== line.length && before === after) continue;
    if (Math.abs(i - at) < gap) { gap = Math.abs(i - at); best = i; }
  }
  return best;
}

function textPress(t, x, y, cal) {
  const lines = t.value.split("\n"), starts = lineStarts(lines);
  const perRow = Math.max(1, Math.floor(t.width / cal.advance));
  let row = Math.max(0, Math.floor(y / cal.rowPx));
  for (let i = 0; i < lines.length; i++) {
    const map = visibleMap(lines[i]), visible = map.length - 1;
    const rows = Math.max(1, Math.ceil((visible * cal.advance) / t.width));
    if (row < rows || i === lines.length - 1) {
      const v = clamp(Math.min(row, rows - 1) * perRow + Math.round(Math.max(0, x) / cal.advance), 0, visible);
      return starts[i] + snapToWord(lines[i], map[v]);
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
    const lead = line.trimStart().startsWith("|"), trail = /\|[ \t]*$/.test(line) && !/\\\|[ \t]*$/.test(line);
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

function tablePress(t, x, y) {
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

// The cell after (dir > 0) or before (dir < 0) the one holding `caret`, as { start, end } of its trimmed text, or null
// past the first or last cell.
export function nextCell(value, caret, dir) {
  const all = tableCells(value).filter(r => !r.delimiter).flatMap(r => r.cells);
  let at = 0;
  for (let i = 0; i < all.length; i++) if (all[i].start <= caret) at = i;
  const next = all[at + (dir > 0 ? 1 : -1)];
  return next ? { start: next.start, end: next.end } : null;
}

// The visual row of `caret` in a field value: its line index when no line wraps (`rows`, the measured row count, at
// most the line count); otherwise the measured extra rows shared out over the lines by length.
export function caretRow(value, caret, rows) {
  const lines = value.split("\n");
  let line = 0, col = clamp(caret, 0, value.length);
  while (line < lines.length - 1 && col > lines[line].length) col -= lines[line++].length + 1;
  if (!(rows > lines.length)) return line;
  const extra = rows - lines.length, total = lines.reduce((n, l) => n + l.length, 0) || 1;
  const share = lines.map(l => (extra * l.length) / total), whole = share.map(Math.floor);
  const left = extra - whole.reduce((a, b) => a + b, 0);
  for (const k of share.map((_, i) => i).sort((a, b) => share[b] - whole[b] - (share[a] - whole[a])).slice(0, left)) whole[k]++;
  let before = 0;
  for (let k = 0; k < line; k++) before += 1 + whole[k];
  const own = 1 + whole[line], len = lines[line].length;
  return before + Math.min(own - 1, len ? Math.floor((col / len) * own) : 0);
}

// The `rows=one` key context. The width estimate drops it as a line is about to wrap, before on_size_change reports
// the new row 13-24 ms later.
export const isOneRow = ({ value, height, rowPx, width, advance }) =>
  !value.includes("\n") && height < 1.5 * rowPx && value.length * advance < 0.9 * width;

// The column's left edge in md-viewport, and the column's x for a pointer x there.
export const columnLeft = viewportW => Math.max(0, (viewportW - COLUMN.maxWidth) / 2) + COLUMN.padX;
export const columnX = (localX, viewportW) => localX - columnLeft(viewportW);
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

// The offset that keeps [y, y + rowPx] inside [offset + 24, offset + viewportH - 72], moving the least.
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

// A drawn diagram is a frame that can break out of the column, as wide as the pane and at most `maxShare` of the
// viewport tall, so the whole frame fits on screen with page above and below it; inside it the picture pans and zooms. `dpr` is the backing scale the sharp picture is made
// for: the API gives none, and 2 is this machine's sharpest screen (a 1x screen only spends memory on it).
// `sharpBudget` is the most pixels a sharp picture may have.
export const FRAME = {
  margin: 32, pad: 12, minH: 120, maxShare: 0.7, edgeV: 24, readable: 0.75, zMax: 2, zoomPerPx: 0.005, settleMs: 300,
  dpr: 2, sharpBudget: 40e6, maxPx: 16000,
  tools: { top: 8, right: 8, h: 26, out: 26, pct: 48, in: 26 },
};
export const WHEEL = { gapMs: 150, decidePx: 8, sideways: 2 };
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];
const SAME_ZOOM = 0.005;
// Half a pixel: frame sizes are rounded, so content that fits exactly may measure a fraction over.
const SLACK = 0.5;

// The frame of a diagram whose picture is natW x natH layout px, in a viewport viewW x viewH, for a block whose
// column part starts at blockLeft (viewport x) and is blockW wide. -> { w, h, left, ml, z0, zMin }: `left` in
// viewport x, `ml` the margin that moves the frame there from the block's left edge (never positive), `z0` the
// starting zoom and `zMin` the one that shows the whole picture.
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

// The next zoom of the − and + buttons from z (dir < 0 out, > 0 in): the steps and the frame's own z0 and zMin,
// inside [zMin, zMax]. At an end it stays z.
export function zoomStep(z, dir, z0, zMin) {
  const steps = [...new Set([...ZOOM_STEPS, z0, zMin])].filter(s => s >= zMin - 1e-9 && s <= FRAME.zMax + 1e-9).sort((a, b) => a - b);
  if (dir < 0) return steps.filter(s => s < z - SAME_ZOOM).at(-1) ?? z;
  return steps.find(s => s > z + SAME_ZOOM) ?? z;
}

export const canZoom = (z, dir, zMin) => (dir < 0 ? z > zMin + SAME_ZOOM : z < FRAME.zMax - SAME_ZOOM);

// Where the − % + group sits in a frame of height h whose top is at screenTop in the viewport: at the frame's top
// right, kept below the top of the page while the frame's top is above it.
export const toolsTop = (h, screenTop) => clamp(Math.max(FRAME.tools.top, FRAME.edgeV - screenTop), FRAME.tools.top, h - FRAME.tools.h - FRAME.tools.top);

// The cell of the group at frame point (fx, fy) in a frame `w` wide with the group at `top`: "out", "pct", "in" or
// null. The group's 1 px border counts with the cell beside it.
export function frameTool(fx, fy, w, top) {
  const T = FRAME.tools, wide = T.out + T.pct + T.in + 2, x = fx - (w - T.right - wide);
  if (fy < top || fy >= top + T.h || x < 0 || x >= wide) return null;
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

// The slash's x is estimated from the average advance, inside the row a wrapped line put it on. The pane wins over the
// column when it is too narrow for both.
export function slashX({ col, advance, fieldW, fieldX, viewW }) {
  const left = columnLeft(viewW), x = (col * advance) % Math.max(1, fieldW);
  return Math.max(0, Math.min(viewW - MENU.w - MENU.margin, Math.max(left, left + fieldX + x)));
}

// A new wheel gesture: a trackpad's "started", or the first event after a pause.
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
