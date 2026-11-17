// A nested view gets only {owner, key} as props and reads the rest from its editor through `owners`.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextView } from "gpui-base";
import { theme } from "herdr";
import { diagramBlock } from "./diagrams.js";
import { pictureBlock } from "./images.js";
import { RAW, TEXT } from "./keys.js";
import { showComments } from "./comments.js";
import { textColor } from "./colors.js";
import { parseInline } from "./inline.js";
import { NOTES } from "./geometry.js";

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
};
export const CALIBRATED = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "mono", "small"];

const RAW_KINDS = new Set(["code", "mermaid", "table", "html", "frontmatter", "hr", "definition"]);
export const isRaw = kind => RAW_KINDS.has(kind);

export function lookOf(b) {
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

const BLOCK_START = /^(?:#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|>|`{3}|~{3}|\d{1,9}[.)](?:[ \t]|$)|(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$)/;
const MAY_MARK = /<mark/i;

// TextView draws a <mark> with no colour of its own in a bright yellow: it gets the highlight colour instead.
function coloredMarks(text, color) {
  if (!color || !MAY_MARK.test(text)) return text;
  let out = "", at = 0;
  for (const sp of parseInline(text).spans) {
    if (sp.kind !== "html" || sp.tag !== "mark" || sp.color !== null) continue;
    out += `${text.slice(at, sp.start)}<mark color="${color}">`;
    at = sp.from;
  }
  return out + text.slice(at);
}

// A heading's text that would start a block of its own is escaped, and continuation lines are indented past anything
// that could interrupt a paragraph: the source said they continue it. Comments and highlights show in `color`.
export function displayText(b, color) {
  const content = showComments(coloredMarks(b.content, color), color), defs = b.render.slice(b.content.length);
  if (b.kind === "quote") return content + defs;
  const lines = content.split("\n");
  if (b.kind === "heading" && BLOCK_START.test(lines[0])) lines[0] = lines[0].replace(/^(\d*)(.)/, "$1\\$2");
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

const monoLines = (text, st, color, font) => type(v_flex().w_full(), st, color, font).children(text.split("\n").map(l => div().child(l || " ")));

const codeBox = (t, inner) => div().w_full().relative().bg(t.surface).border_1().border_color(t.border).rounded(8).px(BOX.px).py(BOX.py).child(inner);

function rendered(owner, d, t) {
  const st = STYLES[d.style], color = t[d.color], { sans, mono } = owner.fonts;
  if (d.look === "text") {
    return type(div().w_full().min_h(d.row).pb(d.padRendered), st, color, sans)
      .when(d.checked, el => el.line_through())
      .child(TextView.markdown(`md-tv-${d.key}-${d.gen}`, d.text).selectable(true).on_link_click((url, cx) => owner.link(url, cx)));
  }
  if (d.look === "lines") return monoLines(d.text, st, color, mono);
  if (d.look === "code") {
    return codeBox(t, monoLines(d.text, st, color, mono))
      .when(Boolean(d.info), el => el.child(div().absolute().top(6).right(10).text_size(11).text_color(t.dim).child(d.info)));
  }
  if (d.look === "boxed") {
    return codeBox(t, type(div().w_full().min_h(d.row), STYLES.cell, color, sans)
      .child(TextView.markdown(`md-tv-${d.key}-${d.gen}`, d.text).selectable(true).on_link_click((url, cx) => owner.link(url, cx))));
  }
  if (d.look === "front") return frontBox(t, monoLines(d.text, st, color, mono));
  if (d.look === "diagram") {
    const view = d.frameW ? owner.frameView(d.key) : null;
    const frame = view && { key: d.key, w: d.frameW, h: d.frameH, ml: d.frameMl, natW: d.natW, natH: d.natH, image: d.imgKey, dim: d.imgDim, selected: d.selected, view };
    return diagramBlock({ id: `md-diagram-${d.key}`, source: d.text, d: owner.shown.get(d.key) ?? { state: "pending" }, frame, t, mono });
  }
  if (d.look === "picture") return pictureBlock({ id: `md-pictures-${d.key}`, ...owner.pictureOf(d.key, d.pictureW), selected: d.selected, picked: d.picked, t });
  return div().w_full().h(RULE_H).flex().items_center().child(div().w_full().h(1).bg(t.border));
}

const frontBox = (t, inner) => div().w_full().rounded(8).bg(t.surface).border_1().border_color(t.border).px(FRONT_BOX.px).py(FRONT_BOX.py).child(inner);

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

// One inline token of a field: its pieces in a row as tall as the field's.
function tokenView(owner, d, t, ctx) {
  return h_flex().flex_none().h(ctx.line_height).items_center()
    .when(ctx.selected, el => el.bg(t.selection))
    .children(owner.tokenPieces(ctx.token).map(p => piece(owner, d, t, p)));
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

export function renderBlock(owner, d) {
  const t = theme(), state = d.mode === "active" ? owner.field : d.mode === "field" ? owner.blockField(d.key) : null;
  let body = state ? field(owner, d, t, state) : rendered(owner, d, t);
  if (d.kind === "item") {
    body = h_flex().w_full().items_start().child(marker(owner, d, t)).child(div().flex_1().min_w(0).child(body));
  } else if (d.kind === "quote") {
    body = h_flex().w_full().items_stretch()
      .child(div().w(QUOTE_BAR).flex_none().rounded(2).bg(t.input))
      .child(div().flex_1().min_w(0).pl(QUOTE_PAD).child(body));
  }
  // A diagram's frame and each picture draw their own selection tint: a picture can be opaque.
  const shown = d.mode === "rendered", diagram = shown && d.look === "diagram", picture = shown && d.look === "picture";
  return div().id(`md-block-${d.key}`).w_full().pt(d.space).pl(d.depth * INDENT)
    .when(diagram, el => el.cursor_pointer())
    .when(picture, el => el.cursor_default())
    .when(!diagram && !picture, el => el.cursor_text())
    .when(d.selected && !d.frameW && !picture, el => el.bg(t.selection).rounded(4))
    .on_size_change((size, cx) => owner.blockSized(d.key, size, cx))
    .child(body)
    .when(d.notes > 0, el => el.relative().child(commentCount(d, t)));
}

// The editor takes a press on it from the page, as it does a task box's.
function commentCount(d, t) {
  return h_flex().id(`md-notes-${d.key}`).absolute().left(d.notesX).top(d.notesY).w(NOTES.w).h(NOTES.h).gap(3).items_center().justify_center()
    .rounded(6).cursor_pointer().text_size(11.5).text_color(t.muted).hover(s => s.bg(t.hover))
    .tooltip(d.notes === 1 ? "1 comment" : `${d.notes} comments`)
    .child(svg(COMMENTS_ICON).size(14).flex_none())
    .child(String(d.notes));
}
