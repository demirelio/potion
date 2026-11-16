// The links of a text block's field value as the link popover and the address box read and rewrite them: the form a
// link is written in, an address as typed and as written, and the edits that set an address, take a link off or make
// one. Offsets are UTF-16 indices into the value; `defs` are the document's link reference definitions as doc.defs holds
// them. An edit -> { value, start, end }, the value after it and the range of the link (or of its text, once unlinked),
// or null when what it would write does not read back as meant.
import { destinationSpan, parseInline } from "./inline.js";

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

// `value` with [start, end) replaced by `written`, when a link to `address` is then exactly [start, start + length),
// showing `text` when that is given.
function linked(value, start, end, written, address, defs, text = null) {
  const next = value.slice(0, start) + written + value.slice(end), stop = start + written.length, inline = parseInline(next, { defs });
  const sp = inline.spans.find(x => x.kind === "link" && x.start === start && x.end === stop && x.url === address);
  if (!sp || (text !== null && inline.chars.filter(c => c.start >= sp.from && c.end <= sp.to).map(c => c.text).join("") !== text)) return null;
  return { value: next, start, end: stop };
}

function autolinkOf(address) {
  const mail = MAIL.exec(address);
  return `<${mail ? mail[1] : address}>`;
}

// An inline link to `address` showing `text` in place of [start, end): the text as it is when it shows so (an address
// as text is read whole, escapes and all), else escaped.
function inlineLink(value, start, end, address, text, defs) {
  const dest = destinationOf(address), tries = [`[${text}](${dest})`, `[${textOf(text)}](${dest})`];
  for (const shows of [text, null]) {
    for (const written of tries) {
      const out = linked(value, start, end, written, address, defs, shows);
      if (out) return out;
    }
  }
  return null;
}

// -> the link `span` of `value` going to `address`. An inline or reference link keeps its text (a reference link gets
// an inline address of its own, its definition left alone); an autolink or a bare address, whose text is its address,
// is rewritten in its form while the new address can have it, else as an inline link.
export function setAddress(value, span, address, { defs } = {}) {
  const form = linkForm(value, span);
  if (form === "inline" || form === "reference") {
    const target = form === "inline" ? destinationSpan(value, span.to + 1) : { start: span.to, end: span.end };
    if (!target) return null;
    const written = form === "inline" ? destinationOf(address) : `](${destinationOf(address)})`;
    const next = value.slice(0, target.start) + written + value.slice(target.end), end = span.end + next.length - value.length;
    return linksIn(next, defs).some(sp => sp.start === span.start && sp.end === end && sp.url === address) ? { value: next, start: span.start, end } : null;
  }
  const forms = form === "literal" ? [address, autolinkOf(address)] : [autolinkOf(address)];
  for (const written of forms) {
    const out = linked(value, span.start, span.end, written, address, defs);
    if (out) return out;
  }
  return inlineLink(value, span.start, span.end, address, address, defs);
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
export function addLink(value, range, address, { defs, text = address } = {}) {
  if (!address) return null;
  if (range.start === range.end) return inlineLink(value, range.start, range.end, address, text, defs);
  const { start, end } = uncut(parseInline(value, { defs }).spans, range.start, range.end);
  return linked(value, start, end, `[${value.slice(start, end)}](${destinationOf(address)})`, address, defs);
}
