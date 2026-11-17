// What a table's grid draws and how big it is: each cell's text as its TextView shows it, the columns' widths and the
// rows' estimated heights. Worked out when the table's text, the definitions, the room, the calibration or the
// comments' colours change, never in a draw. No herdr or gpui imports.
import { defsFor } from "./blocks.js";
import { showComments } from "./comments.js";
import { GRID, columnWidths, gridRowHeights } from "./geometry.js";
import { asText, coloredMarks, parseInline } from "./inline.js";
import { cellText, columnsOf, isIrregular, tableOf } from "./tables.js";

// A table of more cells keeps its source look: drawing its grid would take much of a draw's budget.
export const MAX_GRID_CELLS = 1000;
// What a cell's text may hold that shows differently from how it is written.
const MAY_FORMAT = /[`[\]\\!<&*_~]/;
// What a comment shows does not depend on its colour.
const ANY_COLOR = "#000";
const LOW_SURROGATE = 0xdc00, AFTER_SURROGATES = 0xe000;

// Whether the grid draws table b: not past MAX_GRID_CELLS cells (counted from its lines and header, unparted), nor
// when a row holds more cells than the header (the grid would hide their text).
export const drawsGrid = (doc, b) => (b.lines.length - 1) * columnsOf(doc, b) <= MAX_GRID_CELLS && !isIrregular(doc, b);

// TextView's markdown for cell text `source`: its comments highlighted in `color` (the one starting at `deep.at` in
// `deep.color`) with their notes left out, a <mark> in `color`, every \| as | (GFM reads a cell so, in code spans
// too), a block start or a link definition escaped as text, and the definitions (`defs`, a doc's) its links use.
export function cellMarkdown(source, color, deep, defs) {
  const text = asText(coloredMarks(showComments(source, color, deep), color).replaceAll("\\|", "|"));
  const used = defsFor(text, defs);
  return used ? `${text}\n\n${used}` : text;
}

// What a cell shows: its comments' marked text and a point comment's marker, its links' text, no marks.
function shownText(source, defs) {
  const text = showComments(source, ANY_COLOR).replaceAll("\\|", "|");
  if (!MAY_FORMAT.test(text)) return text;
  let out = "";
  for (const run of parseInline(text, { defs }).runs) out += run.text;
  return out;
}

function codePoints(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < LOW_SURROGATE || c >= AFTER_SURROGATES) n++;
  }
  return n;
}

const sum = list => list.reduce((a, x) => a + x, 0);
const deepKeyOf = deep => (deep ? `${deep.row}:${deep.column}:${deep.at}:${deep.color}` : "");
const isDeep = (deep, r, c) => Boolean(deep) && deep.row === r && deep.column === c;

// The cells' source and shown texts while the table's text and the definitions stay; none for a table kept as source.
function readCells(kept, doc, b, defs) {
  Object.assign(kept, { content: b.content, defs, sources: null, sized: "", texts: null, grid: null });
  if (!drawsGrid(doc, b)) return;
  const t = tableOf(doc, b), sources = t.rows.map((row, r) => row.cells.map((_, c) => cellText(doc, t, r, c)));
  const shown = sources.map(row => row.map(s => shownText(s, defs.map)));
  Object.assign(kept, { aligns: t.aligns, sources, shown, chars: shown.map(row => row.map(codePoints)) });
}

const sameWidths = (a, b) => Boolean(a) && Boolean(b) && a.length === b.length && a.every((w, i) => w === b[i]);

// The header's text is measured at its own style's advance. `held`: the widths to keep instead.
function sizeCells(kept, room, head, body, held) {
  const columns = kept.aligns.length, advance = r => (r === 0 ? head : body).advance;
  const widest = kept.aligns.map((_, c) => Math.max(0, ...kept.chars.map((row, r) => row[c] * advance(r))));
  const natural = held ?? columnWidths(widest, room - (columns + 1) * GRID.line), widths = sameWidths(natural, kept.widths) ? kept.widths : natural;
  const boxes = kept.chars.map((row, r) => row.map((n, c) => (kept.aligns[c] === "center" || kept.aligns[c] === "right"
    ? Math.max(1, Math.min(widths[c] - 2 * GRID.padX, (n + 1) * advance(r))) : 0)));
  const heights = gridRowHeights(kept.shown, widths, head, body);
  Object.assign(kept, { widths, boxes, heights, rowPx: [head.row, body.row], grid: null });
}

// Each cell's markdown in `color`, the deep comment's cell in its own; only cells whose look changed are read again.
function drawCells(kept, color, deep) {
  const was = kept.texts, deepKey = deepKeyOf(deep), keep = was && kept.color === color;
  kept.texts = kept.sources.map((row, r) => row.map((s, c) => (keep && !isDeep(kept.deep, r, c) && !isDeep(deep, r, c)
    ? was[r][c] : cellMarkdown(s, color, isDeep(deep, r, c) ? deep : null, kept.defs.map))));
  Object.assign(kept, { color, deep, deepKey, grid: null });
}

// -> what table b's grid draws, the same object while nothing it comes from changed; null for a table kept as source.
// `kept`: the caller's memo for the table; `room`: the px the grid may take; `head`, `body`: the calibrated { row,
// advance } of the header's and the cells' styles; `deep`: a cell's active comment ({ row, column, at (in the cell's
// text), color }) or null; `defs`: the doc's definitions as { map }, one object while they read the same; `widths`:
// column widths to keep whatever the text holds (null: worked out from it), taken while they have a column each.
// The answer: { texts (each cell's markdown), aligns, widths (padding in, lines out), boxes (a centred or right cell's
// box width, 0 for the whole cell), heights (estimated; a row's line under it but the last's), rowPx, w, h }.
export function gridOf(kept, doc, b, { room, head, body, color, deep, defs, widths = null }) {
  if (kept.content !== b.content || kept.defs !== defs) readCells(kept, doc, b, defs);
  if (!kept.sources) return null;
  const sized = `${room}:${head.row}:${head.advance}:${body.row}:${body.advance}`, held = widths?.length === kept.aligns.length ? widths : null;
  if (kept.sized !== sized || (kept.held !== held && !(held === kept.widths && kept.held === null))) {
    sizeCells(kept, room, head, body, held);
    kept.sized = sized;
  }
  kept.held = held;
  if (!kept.texts || kept.color !== color || kept.deepKey !== deepKeyOf(deep)) drawCells(kept, color, deep);
  kept.grid ??= {
    texts: kept.texts, aligns: kept.aligns, widths: kept.widths, boxes: kept.boxes, heights: kept.heights, rowPx: kept.rowPx,
    w: sum(kept.widths) + (kept.widths.length + 1) * GRID.line, h: sum(kept.heights) + 2 * GRID.line,
  };
  return kept.grid;
}
