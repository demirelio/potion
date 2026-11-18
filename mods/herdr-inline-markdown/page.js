// A nested view gets only {owner, key} as props and reads the rest from its editor through `owners`.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextView } from "gpui-base";
import { theme } from "herdr";
import { diagramBlock } from "./diagrams.js";
import { pictureBlock } from "./images.js";
import { RAW, TEXT } from "./keys.js";
import { showComments } from "./comments.js";
import { deepHighlightColor, highlightColor, textColor } from "./colors.js";
import { asText, coloredMarks } from "./inline.js";
import { CHIP, CODE_HEAD, GRID, NOTES, RESIZE, lineX } from "./geometry.js";
import { clipOf, piecesOf } from "./tokens.js";

export const owners = new Map();
let owned = 0;
export const newOwnerId = () => `md-owner-${++owned}`;

export const INDENT = 24;
export const MARKER_W = 24;
export const QUOTE_BAR = 3;
export const QUOTE_PAD = 14;
export const BOX = { px: 14, py: 12 };
export const FRONT_BOX = { px: 12, py: 10 };
const RULE_H = 24;
const CHECK = "mods/herdr-inline-markdown/check.svg";
const COMMENTS_ICON = "mods/herdr-inline-markdown/message-square.svg";
const PICTURE_ICON = "mods/herdr-inline-markdown/image.svg";
const CHEVRON = "mods/herdr-inline-markdown/chevron-down.svg";
const COMMENT_ADD_ICON = "mods/herdr-inline-markdown/message-square-plus.svg";
const COMMENT_TIP = "Comment (Cmd+Alt+M)";
const BOLD = 700;
const CODE_SCALE = 0.87;
const ICON_SCALE = 0.9;

// `size` is in px and `lh` a multiple of it; the same rendered and in the field.
export const STYLES = {
  p: { size: 15, weight: 400, lh: 1.6 },
  h1: { size: 28, weight: 700, lh: 1.25 },
  h2: { size: 22, weight: 700, lh: 1.3 },
  h3: { size: 18, weight: 600, lh: 1.4 },
  h4: { size: 16, weight: 600, lh: 1.5 },
  h5: { size: 15, weight: 600, lh: 1.6 },
  h6: { size: 14, weight: 600, lh: 1.6 },
  mono: { size: 13, weight: 400, lh: 1.5, mono: true },
  small: { size: 12, weight: 400, lh: 1.5, mono: true },
  cell: { size: 14, weight: 400, lh: 1.5 },
  head: { size: 14, weight: 600, lh: 1.5 },
};
export const CALIBRATED = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "mono", "small", "cell", "head"];

// A code block's, diagram's or table's frame: while one of its comments is active, or while one is written on it.
export const FRAMED = { active: "active", adding: "adding" };
// A picture's frame in a paragraph of pictures, one letter a picture: none, in the highlight colour, or in the deeper
// one of an active comment.
export const PICTURE_FRAME = { none: "-", light: "h", deep: "d" };
const frameColors = (letters, t) => [...letters].map(l => (l === PICTURE_FRAME.deep ? deepHighlightColor(t) : l === PICTURE_FRAME.light ? highlightColor(t) : null));

const RAW_KINDS = new Set(["code", "mermaid", "table", "html", "frontmatter", "hr", "definition"]);
export const isRaw = kind => RAW_KINDS.has(kind);
// A block key holds no colon, so a cell's field id never names a block.
export const cellId = (key, r, c) => `${key}:${r}:${c}`;

export function lookOf(b, grid = false) {
  if (grid) return { style: "cell", color: "foreground", look: "grid" };
  if (b.kind === "heading") return { style: `h${b.level}`, color: "foreground", look: "text" };
  if (b.kind === "paragraph" && b.image) return { style: "small", color: "dim", look: "picture" };
  if (b.kind === "paragraph" || b.kind === "item" || b.kind === "quote") return { style: "p", color: "foreground", look: "text" };
  if (b.kind === "code") return { style: "mono", color: "foreground", look: "code" };
  if (b.kind === "mermaid") return { style: "mono", color: "foreground", look: "diagram" };
  if (b.kind === "table") return { style: "mono", color: "foreground", look: "boxed" };
  if (b.kind === "html") return b.htmlType === 2 ? { style: "small", color: "dim", look: "lines" } : { style: "mono", color: "foreground", look: "boxed" };
  if (b.kind === "frontmatter") return { style: "small", color: "muted", look: "front" };
  if (b.kind === "definition") return { style: "small", color: "dim", look: "lines" };
  return { style: "p", color: "muted", look: "rule" };
}

// Padding-top, so the block's measured height includes it. Parent indices point into `tree`, the document's blocks;
// the page's own list may hold a block not written yet.
export function spaceBefore(blocks, i, tree = blocks) {
  const b = blocks[i], prev = blocks[i - 1];
  if (!prev) return 0;
  if (b.kind === "heading") return [0, 32, 28, 24, 20, 20, 20][b.level];
  if (prev.kind === "heading") return 8;
  if (b.parent >= 0 && tree[b.parent].kind === "item" && b.kind !== "item") return 6;
  if (b.kind === "item" && sameList(tree, prev, b)) return 6;
  return 14;
}

const topOf = (tree, b) => {
  let x = b;
  while (x.parent >= 0) x = tree[x.parent];
  return x;
};
const sameList = (tree, a, b) => {
  const ta = topOf(tree, a), tb = topOf(tree, b);
  return ta.kind === "item" && tb.kind === "item" && ta.list === tb.list;
};

// A heading's text that would start a block of its own is escaped, and continuation lines are indented past anything
// that could interrupt a paragraph: the source said they continue it. Comments and highlights show in `color`.
export function displayText(b, color) {
  const content = showComments(coloredMarks(b.content, color), color), defs = b.render.slice(b.content.length);
  if (b.kind === "quote") return content + defs;
  const lines = content.split("\n");
  if (b.kind === "heading") lines[0] = asText(lines[0]);
  for (let k = 1; k < lines.length; k++) lines[k] = `    ${lines[k]}`;
  return lines.join("\n") + defs;
}

export function markerOf(b) {
  if (b.kind !== "item") return null;
  if (b.task) return "task";
  if (b.ordered) return "number";
  return ["dot", "ring", "square"][b.depth % 3];
}

export class Column extends View {
  init(props) { this.owner = props?.owner; }
  render() {
    const o = owners.get(this.owner);
    return o ? o.columnElement() : v_flex().id("md-column-gone");
  }
}

export class Block extends View {
  init(props) {
    this.owner = props?.owner;
    this.key = String(props?.key ?? "");
  }
  render() {
    const o = owners.get(this.owner), d = o?.blockData(this.key);
    return d ? renderBlock(o, d) : div().id(`md-gone-${this.key}`);
  }
}

const type = (el, st, color, font) => el.font_family(font).text_size(st.size).font_weight(st.weight).line_height(st.lh).text_color(color);

const markdownView = (owner, id, text) => TextView.markdown(id, text).selectable(true).on_link_click((url, cx) => owner.link(url, cx));

const monoLines = (text, st, color, font) => type(v_flex().w_full(), st, color, font).children(text.split("\n").map(l => div().child(l || " ")));

const codeBox = (t, inner) => div().w_full().relative().bg(t.surface).border_1().border_color(t.border).rounded(8).px(BOX.px).py(BOX.py).child(inner);
// A code block's box starts with a strip holding its language chip at the right, the code under it: drawn the same in
// Reading and while edited.
const strippedCodeBox = (d, t, inner) => codeBox(t, v_flex().w_full()
  .child(h_flex().id(`md-code-head-${d.key}`).w_full().h(CODE_HEAD).flex_none().items_center().justify_end()
    .when(Boolean(d.chip), el => el.child(languageChip(d, t))))
  .child(inner));

// The editor takes a press on it from the page, as it does a task box's. On a file that can't be edited it only names
// the language.
function languageChip(d, t) {
  return h_flex().id(`md-chip-${d.key}`).w(d.chipW).h(CHIP.h).flex_none().px(CHIP.padX).gap(CHIP.gap).items_center().justify_center().rounded(6)
    .text_size(11.5).text_color(t.dim)
    .when(d.chipLive, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
    .when(d.chipOpen, el => el.bg(t.hover))
    .child(div().min_w(0).truncate().child(d.chip))
    .when(d.chipLive, el => el.child(svg(CHEVRON).size(CHIP.chevron).flex_none().text_color(t.dim)));
}

function rendered(owner, d, t) {
  const st = STYLES[d.style], color = t[d.color], { sans, mono } = owner.fonts;
  if (d.look === "text") {
    return type(div().w_full().min_h(d.row).pb(d.padRendered), st, color, sans)
      .when(d.checked, el => el.line_through())
      .child(markdownView(owner, `md-tv-${d.key}-${d.gen}`, d.text));
  }
  if (d.look === "lines") return monoLines(d.text, st, color, mono);
  if (d.look === "code") return strippedCodeBox(d, t, monoLines(d.text, st, color, mono));
  if (d.look === "boxed") {
    return codeBox(t, type(div().w_full().min_h(d.row), STYLES.cell, color, sans).child(markdownView(owner, `md-tv-${d.key}-${d.gen}`, d.text)));
  }
  if (d.look === "front") return frontBox(t, monoLines(d.text, st, color, mono));
  if (d.look === "grid") return tableGrid(owner, d, t);
  if (d.look === "diagram") {
    const view = d.frameW ? owner.frameView(d.key) : null;
    const comment = view?.tools?.comment ? { tip: COMMENT_TIP, press: cx => owner.commentPress(d.key, cx) } : null;
    const frame = view && { key: d.key, w: d.frameW, h: d.frameH, ml: d.frameMl, natW: d.natW, natH: d.natH, image: d.imgKey, dim: d.imgDim, selected: d.selected, view, comment };
    return diagramBlock({ id: `md-diagram-${d.key}`, source: d.text, d: owner.shown.get(d.key) ?? { state: "pending" }, frame, t, mono });
  }
  if (d.look === "picture") {
    const frames = frameColors(d.pictureFrames, t);
    return pictureBlock({ id: `md-pictures-${d.key}`, ...owner.pictureOf(d.key, d.pictureW), selected: d.selected, picked: d.picked, frames, t });
  }
  return div().w_full().h(RULE_H).flex().items_center().child(div().w_full().h(1).bg(t.border));
}

const frontBox = (t, inner) => div().w_full().rounded(8).bg(t.surface).border_1().border_color(t.border).px(FRONT_BOX.px).py(FRONT_BOX.py).child(inner);

// Gpui clips to the box, not to its rounded corners, so the header rounds its own top corners inside the 1 px line. The
// resize line's strip lies outside the clip, so that the grid's right edge can be grabbed from beyond it.
function tableGrid(owner, d, t) {
  const g = d.grid, last = g.texts.length - 1, looks = [{ ...d, style: "head" }, d];
  const pan = owner.panOf(d), line = owner.lineOf(d), shown = owner.gridShownW(d), more = g.w - owner.gridRoom(d) - pan;
  const grid = v_flex().id(`md-table-${d.key}`).w(g.w).flex_none().border_1().border_color(t.border).rounded(GRID.radius).overflow_hidden()
    .when(pan > 0, el => el.ml(-pan))
    .children(g.texts.map((cells, r) => h_flex().id(`md-row-${d.key}-${r}`).w_full().items_stretch()
      .when(r === 0, el => el.bg(t.surface).rounded_t(GRID.radius - GRID.line))
      .when(r < last, el => el.border_b(GRID.line).border_color(t.border))
      .on_size_change(size => owner.rowSized(d.key, r, size))
      .children(cells.map((text, c) => gridCell(owner, d, t, r, c, text, looks[r === 0 ? 0 : 1])))));
  return div().id(`md-table-box-${d.key}`).w(shown).flex_none().relative()
    .child(div().id(`md-table-clip-${d.key}`).w_full().overflow_hidden().child(grid))
    .when(pan > 0, el => el.child(edgeShade(d.key, "left")))
    .when(more > 0, el => el.child(edgeShade(d.key, "right")))
    .when(line >= 0, el => el.child(resizeLine(d.key, lineX(g.widths, line) - pan, t)));
}

const SHADE = ["#00000026", "#00000018", "#0000000e", "#00000006"], SHADE_STEP = 3;

function edgeShade(key, side) {
  const strips = SHADE.map(color => div().w(SHADE_STEP).flex_none().bg(color));
  const shade = h_flex().id(`md-table-shade-${side}-${key}`).absolute().top(0).bottom(0).items_stretch();
  return side === "left" ? shade.left(0).children(strips) : shade.right(0).children(strips.reverse());
}

// The strip the pointer grabs around the line at x, wider than the line, carries the resize cursor.
function resizeLine(key, x, t) {
  return div().id(`md-resize-${key}`).absolute().top(0).bottom(0).left(x - RESIZE.grab).w(2 * RESIZE.grab + GRID.line).cursor_col_resize()
    .child(div().absolute().top(0).bottom(0).left(RESIZE.grab + (GRID.line - RESIZE.line) / 2).w(RESIZE.line).bg(textColor(t, "yellow")));
}

// A centred or right-aligned column's text sits in its box (`boxes`), left-aligned inside it: a field, which edits a
// cell, can't align its own text.
function gridCell(owner, d, t, r, c, text, look) {
  const g = d.grid, lined = c < g.widths.length - 1, align = g.aligns[c], box = g.boxes[r][c], st = r === 0 ? STYLES.head : STYLES.cell;
  const state = owner.cellField(d.key, r, c);
  const view = state ? cellField(owner, d, t, r, c, state, st, look) : markdownView(owner, `md-tv-${d.key}-${r}-${c}-${d.gen}`, text);
  const inner = type(div(), st, t[d.color], owner.fonts.sans).min_h(g.rowPx[r === 0 ? 0 : 1]).child(view);
  return h_flex().id(`md-cell-${d.key}-${r}-${c}`).w(g.widths[c] + (lined ? GRID.line : 0)).flex_none().items_start().px(GRID.padX).py(GRID.padY)
    .when(lined, el => el.border_r(GRID.line).border_color(t.border))
    .when(align === "center", el => el.justify_center())
    .when(align === "right", el => el.justify_end())
    .child(box ? inner.w(box).flex_none() : inner.w_full());
}

// A cell's text drawn by its field, as a text block's field draws: only the edited cell's wrapper has the text keys and
// its row count. The wrapper hands its key-ups and presses to the editor under the cell's id.
function cellField(owner, d, t, r, c, state, st, look) {
  const id = cellId(d.key, r, c), name = `${d.key}-${r}-${c}`;
  const input = Textarea.new(state).id(`md-input-${name}`).w_full()
    .font_family(owner.fonts.sans).text_size(st.size).font_weight(st.weight).line_height(d.ratio).text_color(t[d.color])
    .token(ctx => tokenView(owner, look, t, ctx)).on_token_click((ev, cx) => owner.tokenClick(id, ev, cx));
  return div().id(`md-field-${name}`).w_full().pb(d.padActive)
    .when(d.cell === `${r}:${c}`, el => el.key_context(`${TEXT} rows=${d.rows}`))
    .on_key_up((e, cx) => owner.fieldKeyUp(id, e, cx))
    .on_mouse_down("left", (e, cx) => owner.fieldDown(id, e, cx))
    .on_mouse_up("left", (e, cx) => owner.fieldUp(id, e, cx))
    .on_mouse_up("right", () => owner.fieldRightUp(id))
    .child(input);
}

function piece(owner, d, t, p) {
  const st = STYLES[d.style], { sans, mono } = owner.fonts;
  if (p.icon) return svg(PICTURE_ICON).size(st.size * ICON_SCALE).flex_none().text_color(t.muted);
  const size = p.code ? st.size * CODE_SCALE : st.size;
  const color = p.link ? t.accent : p.picture ? t.muted : (p.color && textColor(t, p.color)) || t[d.color];
  return type(div().flex_none(), { ...st, size, weight: p.bold ? Math.max(st.weight, BOLD) : st.weight, lh: d.ratio }, color, p.code ? mono : sans)
    .when(Boolean(p.italic), el => el.italic())
    .when(Boolean(p.strike) || d.checked, el => el.line_through())
    .when(Boolean(p.underline || p.link), el => el.underline())
    .when(Boolean(p.code), el => el.bg(t.surface).rounded(3))
    .when(Boolean(p.highlight || p.point), el => el.bg(owner.highlight))
    .when(Boolean(p.mark), el => el.bg(p.mark))
    .when(Boolean(p.deep), el => el.bg(owner.deep))
    .child(p.text);
}

function tokenView(owner, d, t, ctx) {
  const drawn = h_flex().flex_none().h(ctx.line_height).items_center().children(owner.tokenPieces(ctx.token).map(p => piece(owner, d, t, p)));
  const clip = clipOf(ctx.token.id);
  if (!clip) return drawn.when(ctx.selected, el => el.bg(t.selection));
  return div().w(clip.width).h(ctx.line_height).flex_none().relative().overflow_hidden()
    .when(ctx.selected, el => el.bg(t.selection))
    .child(drawn.absolute().top(0).left(-clip.x));
}

// The prefixes of words split at the caret, drawn out of sight as a token draws them, for the editor to measure:
// [{ n, key, style, id, label }].
export function prefixStrip(owner, prefixes, t) {
  return v_flex().id("md-prefixes").absolute().top(-10000).left(0).items_start()
    .children(prefixes.map(m => h_flex().id(`md-prefix-${m.n}`).flex_none()
      .on_size_change((size, cx) => owner.prefixSized(m.key, size, cx))
      .children(piecesOf(m.id, m.label).map(p => piece(owner, { style: m.style, color: "foreground", ratio: STYLES[m.style].lh }, t, p)))));
}

// A text block is drawn by the same field whether it is edited or not; only the edited one has the block keys. The
// wrapper hands the field's key-ups and presses to the editor itself, whether or not they would reach the editor's own
// elements, and declares the key context: the field's row count, and whether the slash menu takes Up and Down.
function field(owner, d, t, state) {
  const st = STYLES[d.style], { sans, mono } = owner.fonts, raw = isRaw(d.kind);
  const input = Textarea.new(state).id(`md-input-${d.key}`).w_full()
    .font_family(st.mono || raw ? mono : sans).text_size(st.size).font_weight(st.weight)
    .line_height(d.ratio).text_color(t[d.color])
    .when(Boolean(d.tokens), el => el.token(ctx => tokenView(owner, d, t, ctx)).on_token_click((ev, cx) => owner.tokenClick(d.key, ev, cx)));
  const wrap = div().id(`md-field-${d.key}`).w_full().pb(d.padActive)
    .when(d.mode === "active", el => el.key_context(`${raw ? RAW : TEXT} rows=${d.rows}${d.menu ? " menu=open" : ""}`))
    .on_key_up((e, cx) => owner.fieldKeyUp(d.key, e, cx))
    .on_mouse_down("left", (e, cx) => owner.fieldDown(d.key, e, cx))
    .on_mouse_up("left", (e, cx) => owner.fieldUp(d.key, e, cx))
    .on_mouse_up("right", () => owner.fieldRightUp(d.key))
    .child(input);
  if (d.kind === "frontmatter") return frontBox(t, wrap);
  if (d.strip) return strippedCodeBox(d, t, wrap);
  return raw ? codeBox(t, wrap) : wrap;
}

function marker(owner, d, t) {
  const box = div().w(MARKER_W).h(d.row).flex_none().flex().items_center();
  if (d.marker === "number") return box.justify_end().pr(5).text_size(15).text_color(t.foreground).child(d.label);
  if (d.marker === "task") {
    const tick = div().id(`md-task-${d.key}`).size(16).rounded(4).flex().items_center().justify_center().border(1.5)
      .when(!d.checked, el => el.border_color(t.input))
      .when(d.checked, el => el.bg(t.accent).border_color(t.accent).child(svg(CHECK).size(12).text_color(t.accent_foreground)))
      .when(owner.remote, el => el.cursor_default())
      .when(!owner.remote, el => el.cursor_pointer());
    return box.justify_center().child(tick);
  }
  const dot = d.marker === "square" ? div().size(5).bg(t.foreground)
    : d.marker === "ring" ? div().size(6).rounded(3).border(1.5).border_color(t.foreground)
      : div().size(6).rounded(3).bg(t.foreground);
  return box.justify_center().child(dot);
}

// A grid draws its cells' fields itself, the edited one's among them.
export function renderBlock(owner, d) {
  const t = theme(), state = d.look === "grid" ? null : d.mode === "active" ? owner.field : d.mode === "field" ? owner.blockField(d.key) : null;
  let body = state ? field(owner, d, t, state) : rendered(owner, d, t);
  if (d.kind === "item") {
    body = h_flex().w_full().items_start().child(marker(owner, d, t)).child(div().flex_1().min_w(0).child(body));
  } else if (d.kind === "quote") {
    body = h_flex().w_full().items_stretch()
      .child(div().w(QUOTE_BAR).flex_none().rounded(2).bg(t.input))
      .child(div().flex_1().min_w(0).pl(QUOTE_PAD).child(body));
  }
  // A diagram's frame and each picture draw their own selection tint: a picture can be opaque. A table's block reaches
  // as far as its grid shows on either side of the text column, so that its tint covers it. What lies over the block is
  // placed in the column's x; the block's left edge is at `edge`, never right of the column's.
  const shown = d.mode === "rendered", diagram = shown && d.look === "diagram", picture = shown && d.look === "picture";
  const button = owner.blockButtonIn(d), left = d.grid ? d.gridLeft : d.depth * INDENT, edge = Math.min(0, left);
  return div().id(`md-block-${d.key}`).w_full().pt(d.space).pl(left - edge)
    .when(edge < 0, el => el.ml(edge))
    .when(Boolean(d.grid), el => el.min_w(left - edge + owner.gridShownW(d)))
    .when(diagram, el => el.cursor_pointer())
    .when(picture, el => el.cursor_default())
    .when(!diagram && !picture, el => el.cursor_text())
    .when(d.selected && !d.frameW && !picture, el => el.bg(t.selection).rounded(4))
    .on_size_change((size, cx) => owner.blockSized(d.key, size, cx))
    .child(body)
    .when(Boolean(d.framed), el => el.relative().child(commentFrame(owner, d, t, edge)))
    .when(Boolean(button), el => el.relative().child(blockButton(owner, d, button, t, edge)))
    .when(d.notes > 0, el => el.relative().child(commentCount(d, t, edge)));
}

// The frame of a code block, diagram or table whose comment is active (the deeper ochre) or being written (the
// highlight colour): an overlay on its box, its diagram's frame or its grid's shown part, so that nothing under it moves.
function commentFrame(owner, d, t, edge) {
  const color = d.framed === FRAMED.adding ? highlightColor(t) : deepHighlightColor(t);
  const frame = div().id(`md-comment-frame-${d.key}`).absolute().border_2().border_color(color);
  if (d.frameW) return frame.rounded(8).left(d.depth * INDENT + d.frameMl).bottom(0).w(d.frameW).h(d.frameH);
  if (d.grid) return frame.rounded(GRID.radius).left(d.gridLeft - edge).top(d.space).w(owner.gridShownW(d)).bottom(0);
  return frame.rounded(8).left(d.depth * INDENT).right(0).top(d.space).bottom(0);
}

// A code block's or table's Comment button at `box` (the editor's blockButtonIn). It takes its own press, which goes
// no further: a table's lies over its source's field while that is edited.
function blockButton(owner, d, box, t, edge) {
  return h_flex().id(`md-block-comment-${d.key}`).absolute().left(box.x - edge).top(box.y).w(box.w).h(box.h).items_center().justify_center()
    .rounded(6).cursor_pointer().tooltip(COMMENT_TIP).hover(s => s.bg(t.hover))
    .when(d.kind === "table", el => el.bg(t.popover).border_1().border_color(t.border).shadow_sm())
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); owner.commentPress(d.key, cx); })
    .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .child(svg(COMMENT_ADD_ICON).size(14).flex_none().text_color(t.dim));
}

// The editor takes a press on it from the page, as it does a task box's.
function commentCount(d, t, edge) {
  return h_flex().id(`md-notes-${d.key}`).absolute().left(d.notesX - edge).top(d.notesY).w(NOTES.w).h(NOTES.h).gap(3).items_center().justify_center()
    .rounded(6).cursor_pointer().text_size(11.5).text_color(t.muted).hover(s => s.bg(t.hover))
    .tooltip(d.notes === 1 ? "1 comment" : `${d.notes} comments`)
    .child(svg(COMMENTS_ICON).size(14).flex_none())
    .child(String(d.notes));
}
