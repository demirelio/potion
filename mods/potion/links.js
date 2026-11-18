// The links of a text block's field value as the link popover and the address box read and rewrite them: the form a
// link is written in, an address as typed and as written, and the edits that set an address, take a link off or make
// one. Offsets are UTF-16 indices into the value; `defs` are the document's link reference definitions as doc.defs holds
// them. An edit -> { value, start, end }, the value after it and the range of the link (or of its text, once unlinked),
// or null when what it would write does not read back as meant. With `cell` the value is a table cell's text, where a |
// would end the cell: each one written is escaped, \|, which a link's text, address and title read as |. The pictures of
// a text block are rewritten in the same forms.
import { destinationSpan, parseInline } from "./inline.js";
import { escapeAlt } from "./lib.js";
import { cellWritten } from "./tables.js";

const WEB_OR_MAIL = /^(?:https?:\/\/|mailto:)[^\s<>]+$/i;
// A web host typed without its scheme: dotted names, maybe a port, then a path, a query, a fragment or nothing.
const BARE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63})(?::\d+)?(?:[/?#]|$)/i;
const WWW = /^www\./i;
// Endings of the files a note links to: `notes.md` is a file beside the note, not a host in Moldova.
const FILE_ENDINGS = new Set("md markdown mdx txt text html htm pdf png jpg jpeg gif webp svg bmp json yaml yml toml csv js mjs ts css sh py rs".split(" "));
// In a destination a backslash before ASCII punctuation is an escape, and an & may start an entity.
const READ_AS_ESCAPE = /\\(?=[!-/:-@[-`{-~])/g;
const READ_AS_ENTITY = /&(?=#[xX][0-9a-fA-F]{1,6};|#[0-9]{1,7};|[A-Za-z][A-Za-z0-9]{1,31};)/g;
const NOT_PLAIN = /[\s\x00-\x1f\x7f]/;
const TEXT_SPECIAL = /[\\`*_[\]<>~&!]/g;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
const MAIL = /^mailto:([^\s<>@]+@[^\s<>@]+)$/i;
const HOLDS_NO_LINK = new Set(["code", "link", "image"]);
// Escapes that keep GFM from linking an address written bare, tried in turn: the ":" after its scheme, the "." after
// "www", every "@" of a mail address.
const UNLINKING = [
  s => s.replace("://", "\\://"),
  s => s.replace(WWW, m => `${m.slice(0, 3)}\\.`),
  s => s.replace(/(?<!\\)@/g, "\\@"),
];

const balanced = s => {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
};

// -> the one web or mail address the clipboard's text is, spaces around it left out, else "".
export function clipboardAddress(text) {
  const s = typeof text === "string" ? text.trim() : "";
  return WEB_OR_MAIL.test(s) ? s : "";
}

// -> the address a link gets for what was typed into the address box: a web host typed without its scheme gets
// https://; anything else (a scheme, a mail address, an #anchor, a path) stays as typed. Spaces around it go.
export function linkAddress(typed) {
  const s = String(typed ?? "").trim(), host = BARE_HOST.exec(s);
  if (!host || (!WWW.test(s) && FILE_ENDINGS.has(host[1].toLowerCase()))) return s;
  return `https://${s}`;
}

// -> `address` as a link destination is written: as it is, or in <> when it holds a space, a parenthesis out of its
// pair, or starts with <.
export function destinationOf(address) {
  const s = address.replace(READ_AS_ESCAPE, "\\\\").replace(READ_AS_ENTITY, "\\&");
  if (!NOT_PLAIN.test(s) && s[0] !== "<" && balanced(address)) return s;
  return `<${s.replace(/[<>]/g, "\\$&")}>`;
}

const textOf = text => text.replace(TEXT_SPECIAL, "\\$&");

// -> "inline" ([text](address)), "reference" ([text][label], [label][], [label]), "autolink" (<address>) or "literal"
// (a web or mail address written bare), for a link span of parseInline.
export function linkForm(value, span) {
  if (value.startsWith("](", span.to) && value[span.end - 1] === ")" && span.end > span.to + 2) return "inline";
  if (value[span.start] === "[") return "reference";
  return value[span.start] === "<" ? "autolink" : "literal";
}

const linksIn = (value, defs) => parseInline(value, { defs }).spans.filter(sp => sp.kind === "link");

const inCell = (written, cell) => (cell ? cellWritten(written) : written);

// `value` with [start, end) replaced by `written` (its | escaped in a `cell`), when a link to `address` is then exactly
// [start, start + length), showing `text` when that is given. An autolink or a bare address can't hold a \|.
function linked(value, start, end, written, address, defs, text = null, cell = false) {
  const put = inCell(written, cell), next = value.slice(0, start) + put + value.slice(end), stop = start + put.length, inline = parseInline(next, { defs });
  const sp = inline.spans.find(x => x.kind === "link" && x.start === start && x.end === stop && x.url === address);
  if (!sp || (text !== null && inline.chars.filter(c => c.start >= sp.from && c.end <= sp.to).map(c => c.text).join("") !== text)) return null;
  return { value: next, start, end: stop };
}

function autolinkOf(address) {
  const mail = MAIL.exec(address);
  return `<${mail ? mail[1] : address}>`;
}

// An inline link to `address` showing `text` in place of [start, end): the text as it is when it shows so (an address
// as text is read whole, escapes and all: a cell's \| would show its backslash), else escaped, else escaped with the
// address in it broken as unlinked breaks one.
function inlineLink(value, start, end, address, text, defs, cell) {
  const dest = destinationOf(address), escaped = textOf(text);
  const tries = [text, escaped, ...UNLINKING.map(unlinks => unlinks(escaped))].map(shown => `[${shown}](${dest})`);
  for (const shows of [text, null]) {
    for (const written of tries) {
      const out = linked(value, start, end, written, address, defs, shows, cell);
      if (out) return out;
    }
  }
  return null;
}

// -> the link `span` of `value` going to `address`. An inline or reference link keeps its text (a reference link gets
// an inline address of its own, its definition left alone); an autolink or a bare address, whose text is its address,
// is rewritten in its form while the new address can have it, else as an inline link.
export function setAddress(value, span, address, { defs, cell = false } = {}) {
  const form = linkForm(value, span);
  if (form === "inline" || form === "reference") {
    const target = form === "inline" ? destinationSpan(value, span.to + 1) : { start: span.to, end: span.end };
    if (!target) return null;
    const written = inCell(form === "inline" ? destinationOf(address) : `](${destinationOf(address)})`, cell);
    const next = value.slice(0, target.start) + written + value.slice(target.end), end = span.end + next.length - value.length;
    return linksIn(next, defs).some(sp => sp.start === span.start && sp.end === end && sp.url === address) ? { value: next, start: span.start, end } : null;
  }
  const forms = form === "literal" ? [address, autolinkOf(address)] : [autolinkOf(address)];
  for (const written of forms) {
    const out = linked(value, span.start, span.end, written, address, defs, null, cell);
    if (out) return out;
  }
  return inlineLink(value, span.start, span.end, address, address, defs, cell);
}

const linkOver = (value, start, end, defs) => linksIn(value, defs).some(sp => sp.start < end && start < sp.end);

// The text of an autolink or a bare address, written back as text that no link reads over.
function unlinked(value, start, end, text, defs) {
  let written = text;
  for (const escape of [...UNLINKING, () => text.replace(ASCII_PUNCTUATION, "\\$&")]) {
    written = escape(written);
    const next = value.slice(0, start) + written + value.slice(end);
    if (!linkOver(next, start, start + written.length, defs)) return { value: next, start, end: start + written.length };
  }
  return null;
}

// -> `value` without the link `span`: its text stays, as plain text, and comes back as the range.
export function unlink(value, span, { defs } = {}) {
  const form = linkForm(value, span), text = value.slice(span.from, span.to);
  if (form === "autolink" || form === "literal") return unlinked(value, span.start, span.end, text, defs);
  for (const written of [text, text.replace(/[[\]]/g, "\\$&")]) {
    const next = value.slice(0, span.start) + written + value.slice(span.end);
    if (!linkOver(next, span.start, span.start + written.length, defs)) return { value: next, start: span.start, end: span.start + written.length };
  }
  return null;
}

// A range grown to hold whole every span it cuts into, and the code or link it lies in, so that brackets around it
// pair as a link's.
function uncut(spans, start, end) {
  let s = start, e = end, grown = true;
  while (grown) {
    grown = false;
    for (const sp of spans) {
      const holds = sp.start <= s && e <= sp.end && !HOLDS_NO_LINK.has(sp.kind), inside = s <= sp.start && sp.end <= e;
      if (holds || inside || sp.end <= s || e <= sp.start) continue;
      s = Math.min(s, sp.start);
      e = Math.max(e, sp.end);
      grown = true;
    }
  }
  return { start: s, end: e };
}

// -> `value` with `range` a link to `address`; at a caret, a new link whose text is `text` (the address unless given).
// A range that cuts into formatting, code or a comment grows to hold it whole. Null when `address` is empty or a link
// would hold a link.
export function addLink(value, range, address, { defs, text = address, cell = false } = {}) {
  if (!address) return null;
  if (range.start === range.end) return inlineLink(value, range.start, range.end, address, text, defs, cell);
  const { start, end } = uncut(parseInline(value, { defs }).spans, range.start, range.end);
  return linked(value, start, end, `[${value.slice(start, end)}](${destinationOf(address)})`, address, defs, null, cell);
}

// -> "inline" (![alt](address)), "reference" (![alt][label], ![label][], ![label]) or "html" (<img …>), for an image span
// of parseInline.
export function pictureForm(value, span) {
  if (value[span.start] === "<") return "html";
  return linkForm(value, span) === "inline" ? "inline" : "reference";
}

const titled = title => (title === null ? "" : ` "${title.replace(/["\\]/g, "\\$&")}"`);

// The picture `span` of `value` written as `written` in its place, when a picture then stands exactly there showing `alt`
// (when given).
function pictured(value, span, start, end, written, alt, defs) {
  const next = value.slice(0, start) + written + value.slice(end), stop = span.end + next.length - value.length;
  const sp = parseInline(next, { defs }).spans.find(x => x.kind === "image" && x.start === span.start && x.end === stop);
  return sp && (alt === undefined || sp.alt === alt) ? { value: next, start: span.start, end: stop } : null;
}

// The stretch [start, end) of `value` that the picture `span` is written again in to take `alt` or `address`, and
// `write(alt)`, what goes there for the alt text's source `alt`; null for an <img> tag.
function pictureEdit(value, span, { alt, address }) {
  const form = pictureForm(value, span);
  if (form === "html") return null;
  if (form === "inline") {
    const dest = destinationSpan(value, span.to + 1);
    return dest && { start: span.from, end: dest.end, write: text => text + value.slice(span.to, dest.start) + (address ?? value.slice(dest.start, dest.end)) };
  }
  const labelled = !value.startsWith("][", span.to) || value.startsWith("][]", span.to);
  if (address === undefined && (alt === undefined || !labelled)) return { start: span.from, end: span.to, write: text => text };
  return { start: span.start, end: span.end, write: text => `![${text}](${address ?? destinationOf(span.url)}${titled(span.title)})` };
}

const ALT_ESCAPES = [escapeAlt, text => text.replace(ASCII_PUNCTUATION, "\\$&")];

// -> `value` with the picture `span` showing the alt text `alt`, typed (written escaped so that it reads back as typed),
// and going to `address`, written as a picture's address is (writtenAddress, placePictures); what is not given stays. A
// reference picture is written inline for that picture alone, with its definition's address and title, when its address
// changes or when its alt text is its label (`![cat]`, `![cat][]`); its definition stays. Null for an <img> tag.
export function setPicture(value, span, { alt, address }, { defs } = {}) {
  const edit = pictureEdit(value, span, { alt, address });
  if (!edit) return null;
  for (const escape of alt === undefined ? [null] : ALT_ESCAPES) {
    const out = pictured(value, span, edit.start, edit.end, edit.write(escape ? escape(alt) : value.slice(span.from, span.to)), alt, defs);
    if (out) return out;
  }
  return null;
}

const SHOWS_SPACE = /^[ \t]$/;

// -> { start, end }: the source the picture `span` of `value` takes when it goes: its markup, or the link around it when
// that link shows nothing else; with `space`, also the space after it when spaces show on both sides, so that no two are
// left side by side.
export function pictureCut(value, span, { defs, space = true } = {}) {
  const inline = parseInline(value, { defs });
  const link = inline.spans.find(sp => sp.kind === "link" && sp.from === span.start && sp.to === span.end);
  const start = link ? link.start : span.start, end = link ? link.end : span.end;
  if (!space) return { start, end };
  let before = null, after = null;
  for (const c of inline.chars) {
    if (c.end <= start) before = c;
    else if (c.start >= end) { after = c; break; }
  }
  return { start, end: before && after && SHOWS_SPACE.test(before.text) && SHOWS_SPACE.test(after.text) ? after.end : end };
}
