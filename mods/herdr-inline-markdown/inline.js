// What Reading shows of a text block's field value: the characters that show, the formatting around each, and the
// marks it hides. CommonMark 0.31 inlines with GFM strikethrough and autolink literals as markdown-rs reads them, the
// CriticMarkup of comments.js, and the inline HTML TextView draws. Offsets are UTF-16 indices into the value.
//
// Herdr's runtime has no JIT and allocates slowly: an object costs microseconds. The reader keeps the text in leaves
// held in typed arrays, which never move, and the formatting as spans over them, rather than a tree it rearranges.
import { normalizeLabel } from "./blocks.js";
import { commentsIn } from "./comments.js";
import { ENTITIES } from "./entities.js";

const TAB = 9, NL = 10, FF = 12, CR = 13, SP = 32, BANG = 33, DQUOTE = 34, AMP = 38, SQUOTE = 39, LPAREN = 40;
const RPAREN = 41, STAR = 42, DASH = 45, DOT = 46, SLASH = 47, COLON = 58, SEMI = 59, LT = 60, EQUALS = 61, GT = 62;
const LBR = 91, BSL = 92, RBR = 93, UNDER = 95, BT = 96, TILDE = 126, DEL = 127;

const SPECIAL = /[\n\r`[\]\\!<&*_~]/g;
const ESCAPABLE = /^[!-/:-@[-`{-~]$/;
const WHITESPACE = /[\t\n\f\r\p{Zs}]/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WORD_PUNCTUATION = /[\s\p{P}]/u;
const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/y;
const ENTITY_OR_ESCAPE = /\\([!-/:-@[-`{-~])|&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g;
const URI_AUTOLINK = /<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*)>/y;
const EMAIL_AUTOLINK = /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
const ATTRIBUTE = `(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)`;
// An open or closing tag, a comment, a processing instruction, a declaration or CDATA. No capture groups: the
// details are read from the offsets, which costs no strings.
const HTML_TAG = new RegExp(`<[A-Za-z][A-Za-z0-9-]*${ATTRIBUTE}*\\s*/?>|</[A-Za-z][A-Za-z0-9-]*\\s*>|<!---?>|<!--[\\s\\S]*?-->|<\\?[\\s\\S]*?\\?>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`, "y");
const LABEL = /\[(?:[^\\[\]]|\\[\s\S]){0,999}\]/y;
const BRACED_DESTINATION = /<((?:[^<>\n\r\\]|\\[\s\S])*)>/y;
const TITLE = /"((?:\\[\s\S]|[^\\"\x00])*)"|'((?:\\[\s\S]|[^\\'\x00])*)'|\(((?:\\[\s\S]|[^\\()\x00])*)\)/y;
const WEB_START = /www\.|https?:\/\//gi;
const ATEXT = /[A-Za-z0-9+._-]/;
const ALNUM = /[A-Za-z0-9]/;
const LETTER = /[A-Za-z]/;

// The tags TextView pairs with their closing tag and draws with a style, as markdown.rs `inline_html_mark` lists them.
const STYLED_TAGS = new Set(["strong", "b", "em", "i", "u", "s", "del", "strike", "mark"]);
const DEFAULT_MARK = "#fef08a";
const MARK_COLORS = new Map([["black", "#000000"], ["white", "#ffffff"], ["blue", "#3b82f6"], ["yellow", "#facc15"]]);
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const WWW_AFTER = "\t\n (*_[]~";
const LINK_TRAIL = "!\"'*,.:?_~";
// The spans inline tags pair inside, as the nodes holding them in markdown-rs's tree.
const TAG_CONTAINERS = new Set(["em", "strong", "strike", "link", "image"]);
// markdown-rs's limit on the parentheses a link destination may open; it also keeps the scan for one short.
const DESTINATION_DEPTH = 32;

// Leaf kinds. TEXT shows its source as it is, DELIM what is left of a delimiter run, LITERAL a web address (its url in
// `texts` until a link around it makes it TEXT), CHAR one character showing its `texts` entry, CODE a code span's
// content, ALT an <img>'s alt attribute, HTML a tag (its details in `texts`).
const TEXT = 0, DELIM = 1, LITERAL = 2, CHAR = 3, CODE = 4, ALT = 5, HTML = 6;
// Delimiter flags, and the mark for a delimiter list without one.
const OPENS = 1, CLOSES = 2, NONE = -1, UNSET = -2;
// Leaves and delimiters live in typed arrays that start this small and double: arrays sized to the whole value
// allocate memory the runtime then has to collect.
const FIRST_CAPACITY = 32;

function doubled(array) {
  const bigger = new array.constructor(array.length * 2);
  bigger.set(array);
  return bigger;
}

const sticky = (re, s, at) => {
  re.lastIndex = at;
  return re.exec(s);
};

// Past the spaces, tabs and at most one line ending at `at`.
function spnl(s, at) {
  let p = at;
  while (s.charCodeAt(p) === SP || s.charCodeAt(p) === TAB) p++;
  if (s.charCodeAt(p) === CR) p += s.charCodeAt(p + 1) === NL ? 2 : 1;
  else if (s.charCodeAt(p) === NL) p++;
  else return p;
  while (s.charCodeAt(p) === SP || s.charCodeAt(p) === TAB) p++;
  return p;
}

const NON_ASCII = 0x80;
const isHighSurrogate = c => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = c => c >= 0xdc00 && c <= 0xdfff;
const isAsciiLetter = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAsciiAlnum = c => isAsciiLetter(c) || (c >= 48 && c <= 57);
const charAt = (s, p) => String.fromCodePoint(s.codePointAt(p));
const charBefore = (s, p) => (isLowSurrogate(s.charCodeAt(p - 1)) && p >= 2 ? s.slice(p - 2, p) : s[p - 1]);
const isSpaceCode = c => c === SP || c === TAB || c === NL || c === CR || c === FF;

// How a delimiter run's neighbour counts for flanking. The ends of the value count as whitespace.
const SPACE_CLASS = 1, PUNCTUATION_CLASS = 2;
const classOf = ch => (WHITESPACE.test(ch) ? SPACE_CLASS : PUNCTUATION.test(ch) ? PUNCTUATION_CLASS : 0);
const ASCII_CLASS = Uint8Array.from({ length: NON_ASCII }, (_, c) => classOf(String.fromCharCode(c)));
const SPECIAL_ASCII = Uint8Array.from({ length: NON_ASCII }, (_, c) => (sticky(SPECIAL, String.fromCharCode(c), 0) ? 1 : 0));
// Text runs between marks are short: scanning a few dozen characters by hand costs less than a regex call in Herdr's
// runtime, which builds a match object.
const HAND_SCAN = 32;

function classBefore(s, p) {
  if (p === 0) return SPACE_CLASS;
  const c = s.charCodeAt(p - 1);
  return c < NON_ASCII ? ASCII_CLASS[c] : classOf(charBefore(s, p));
}

function classAt(s, p) {
  if (p >= s.length) return SPACE_CLASS;
  const c = s.charCodeAt(p);
  return c < NON_ASCII ? ASCII_CLASS[c] : classOf(charAt(s, p));
}

function entityText(hex, dec, name) {
  if (name !== undefined) return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? String.fromCodePoint(ENTITIES[name]) : null;
  const cp = Number.parseInt(hex ?? dec, hex !== undefined ? 16 : 10);
  return String.fromCodePoint(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp);
}

const unescaped = str => (str.includes("\\") || str.includes("&") ? str.replace(ENTITY_OR_ESCAPE, (m, escaped, hex, dec, name) => escaped ?? entityText(hex, dec, name) ?? m) : str);

// A link destination at `p`, plain or in <>: { url, end }, or null.
function destination(s, p, limit) {
  if (s.charCodeAt(p) === LT) {
    const m = sticky(BRACED_DESTINATION, s, p);
    return m && BRACED_DESTINATION.lastIndex <= limit ? { url: unescaped(m[1]), end: BRACED_DESTINATION.lastIndex } : null;
  }
  let q = p, depth = 0;
  while (q < limit) {
    const c = s.charCodeAt(q);
    if (c === BSL && q + 1 < limit && ESCAPABLE.test(s[q + 1])) q += 2;
    else if (c === LPAREN) {
      if (++depth > DESTINATION_DEPTH) return null;
      q++;
    } else if (c === RPAREN) {
      if (depth < 1) break;
      depth--;
      q++;
    } else if (c <= SP || c === DEL) break;
    else q++;
  }
  if ((q === p && s.charCodeAt(q) !== RPAREN) || depth !== 0) return null;
  return { url: unescaped(s.slice(p, q)), end: q };
}

function title(s, p, limit) {
  const m = sticky(TITLE, s, p);
  return m && TITLE.lastIndex <= limit ? { text: unescaped(m[1] ?? m[2] ?? m[3]), end: TITLE.lastIndex } : null;
}

// A definition's source as `doc.defs` holds it ("[label]: destination 'title'") -> { url, title }.
function readDefinition(source) {
  if (!sticky(LABEL, source, 0) || source.charCodeAt(LABEL.lastIndex) !== COLON) return null;
  const dest = destination(source, spnl(source, LABEL.lastIndex + 1), source.length);
  if (!dest) return null;
  const spaced = spnl(source, dest.end), t = spaced > dest.end ? title(source, spaced, source.length) : null;
  return { url: dest.url, title: t ? t.text : null };
}

// The end of a www. or http(s):// literal whose domain starts at `at`, or -1: markdown-rs's domain, path and trailing
// punctuation rules.
function webEnd(s, at, limit) {
  let domainEnd = at;
  while (domainEnd < limit) {
    const c = s.charCodeAt(domainEnd);
    if (c === DOT || c === UNDER || c === DASH || ALNUM.test(s[domainEnd])) domainEnd++;
    else if (c >= NON_ASCII && !WORD_PUNCTUATION.test(charAt(s, domainEnd))) domainEnd += isHighSurrogate(c) ? 2 : 1;
    else break;
  }
  let end = domainEnd, open = 0, close = 0;
  while (end < limit) {
    const c = s.charCodeAt(end);
    if (c === LT || isSpaceCode(c) || (c >= NON_ASCII && WHITESPACE.test(s[end]))) break;
    if (c === RBR && (end + 1 >= limit || isSpaceCode(s.charCodeAt(end + 1)) || s.charCodeAt(end + 1) === LPAREN || s.charCodeAt(end + 1) === LBR)) break;
    if (c === LPAREN) open++;
    else if (c === RPAREN) close++;
    end++;
  }
  while (end > at) {
    const c = s.charCodeAt(end - 1);
    if (LINK_TRAIL.includes(s[end - 1])) end--;
    else if (c === RPAREN && close > open) { close--; end--; }
    else if (c === SEMI) {
      let k = end - 1;
      while (k > at && LETTER.test(s[k - 1])) k--;
      end = k > at && k < end - 1 && s.charCodeAt(k - 1) === AMP ? k - 1 : end - 1;
    } else break;
  }
  const segments = s.slice(at, Math.min(domainEnd, end)).split(".");
  if (!segments.some(seg => seg.replace(/_/g, "")) || segments.slice(-2).some(seg => seg.includes("_"))) return -1;
  return end > at ? end : -1;
}

// The e-mail literals in s[from, to), as markdown-rs finds them in text: [{ start, end, url }].
function emailsIn(s, from, to) {
  const out = [];
  let lastEnd = from;
  for (let at = s.indexOf("@", from); at >= 0 && at < to; at = s.indexOf("@", at + 1)) {
    let local = at;
    while (local > lastEnd && ATEXT.test(s[local - 1])) local--;
    if (local === at || (local > 0 && s.charCodeAt(local - 1) === SLASH)) continue;
    let end = at + 1, dots = 0;
    while (end < to) {
      const c = s[end];
      if (ALNUM.test(c) || c === "-" || c === "_") end++;
      else if (c === "." && end + 1 < to && ALNUM.test(s[end + 1])) { dots++; end++; }
      else break;
    }
    if (!dots || !LETTER.test(s[end - 1])) continue;
    let start = local, protocol = "";
    for (const p of ["mailto:", "xmpp:"]) {
      const q = local - p.length;
      if (q >= lastEnd && s.slice(q, local).toLowerCase() === p && !(q > 0 && LETTER.test(s[q - 1]))) {
        start = q;
        protocol = p;
      }
    }
    if (protocol === "xmpp:" && s[end] === "/" && end + 1 < to && ALNUM.test(s[end + 1])) {
      end++;
      while (end < to && (ALNUM.test(s[end]) || s[end] === "-" || s[end] === "_" || (s[end] === "." && end + 1 < to && ALNUM.test(s[end + 1])))) end++;
    }
    out.push({ start, end, url: protocol ? s.slice(start, end) : `mailto:${s.slice(start, end)}` });
    lastEnd = end;
    at = end - 1;
  }
  return out;
}

const isJsSpace = c => (c < NON_ASCII ? c === SP || (c >= TAB && c <= CR) : /\s/.test(String.fromCharCode(c)));
const endsName = c => isJsSpace(c) || c === EQUALS || c === SLASH || c === GT;
const endsUnquoted = c => isJsSpace(c) || c === DQUOTE || c === SQUOTE || c === GT;

// Whether attrs[from, to) is the lowercase ASCII `name` in any case.
function namedAs(attrs, from, to, name) {
  if (to - from !== name.length) return false;
  for (let i = 0; i < name.length; i++) if ((attrs.charCodeAt(from + i) | 0x20) !== name.charCodeAt(i)) return false;
  return true;
}

// The value of attribute `name` in a tag's attribute text, and where it starts there ({ value, at }), or null:
// names are runs without spaces, =, / or >; a value is quoted, or runs to a space, a quote or >.
function attribute(attrs, name) {
  const n = attrs.length;
  for (let p = 0; p < n;) {
    if (endsName(attrs.charCodeAt(p))) {
      p++;
      continue;
    }
    let q = p;
    while (q < n && !endsName(attrs.charCodeAt(q))) q++;
    let r = q, from = -1, to = -1, next = q;
    while (r < n && isJsSpace(attrs.charCodeAt(r))) r++;
    if (attrs.charCodeAt(r) === EQUALS) {
      r++;
      while (r < n && isJsSpace(attrs.charCodeAt(r))) r++;
      const quote = attrs.charCodeAt(r), close = quote === DQUOTE || quote === SQUOTE ? attrs.indexOf(attrs[r], r + 1) : -1;
      from = close >= 0 ? r + 1 : r;
      to = close;
      if (close < 0) {
        to = r;
        while (to < n && !endsUnquoted(attrs.charCodeAt(to))) to++;
      }
      next = close >= 0 ? close + 1 : to;
    }
    if (namedAs(attrs, p, q, name)) return from < 0 ? { value: "", at: q } : { value: attrs.slice(from, to), at: from };
    p = next;
  }
  return null;
}

function styleValue(style, key) {
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon > 0 && part.slice(0, colon).trim().toLowerCase() === key) return part.slice(colon + 1).trim();
  }
  return null;
}

function colorOf(value) {
  if (!value) return null;
  const v = value.trim();
  if (v.startsWith("#")) return HEX_COLOR.test(v) ? v : null;
  return MARK_COLORS.get(v.toLowerCase()) ?? null;
}

// A <mark>'s highlight as TextView picks it: the color attribute, else the style's background-color, else its default.
function markColor(attrs) {
  const style = attribute(attrs, "style");
  return colorOf(attribute(attrs, "color")?.value) ?? colorOf(style && styleValue(style.value, "background-color")) ?? DEFAULT_MARK;
}

// The tag s[p, end) as TextView reads it (markdown.rs `inline_html_tag`): its name is its leading letters and digits,
// lowercased; a tag ending in "/>" pairs with nothing. A comment, declaration or the like has no name.
function tagOf(s, p, end) {
  const closing = s.charCodeAt(p + 1) === SLASH, from = p + (closing ? 2 : 1);
  if (!isAsciiLetter(s.charCodeAt(from))) return { tag: "", closing: false, selfClosing: false, attrsAt: p, attrsEnd: p, paired: false };
  let alnum = from, name = from;
  while (isAsciiAlnum(s.charCodeAt(alnum))) alnum++;
  while (isAsciiAlnum(s.charCodeAt(name)) || s.charCodeAt(name) === DASH) name++;
  const selfClosing = !closing && s.charCodeAt(end - 2) === SLASH;
  return { tag: s.slice(from, alnum).toLowerCase(), closing, selfClosing, attrsAt: name, attrsEnd: end - (selfClosing ? 2 : 1), paired: false };
}

// The index in infos[open + 1, to) of the tag that closes infos[open], counting the tags of its name it holds, or -1.
function closingTag(infos, open, to) {
  const tag = infos[open].tag;
  let depth = 0;
  for (let k = open + 1; k < to; k++) {
    const info = infos[k];
    if (info.selfClosing || info.tag !== tag) continue;
    if (!info.closing) depth++;
    else if (depth === 0) return k;
    else depth--;
  }
  return -1;
}

// The delimiter runs that may open or close emphasis, as linked lists in typed arrays.
class Delimiters {
  constructor() {
    this.char = new Uint8Array(FIRST_CAPACITY);
    this.count = new Int32Array(FIRST_CAPACITY);
    this.orig = new Int32Array(FIRST_CAPACITY);
    this.leaf = new Int32Array(FIRST_CAPACITY);
    this.flags = new Uint8Array(FIRST_CAPACITY);
    this.prev = new Int32Array(FIRST_CAPACITY);
    this.next = new Int32Array(FIRST_CAPACITY);
    this.length = 0;
    this.floors = new Int32Array(15);
  }

  add() {
    if (this.length === this.char.length) {
      for (const key of ["char", "count", "orig", "leaf", "flags", "prev", "next"]) this[key] = doubled(this[key]);
    }
    return this.length++;
  }

  // Whether `opener` and `closer` (of the same character) make emphasis: tildes of the same length, and CommonMark's
  // rule of three for * and _.
  pairs(opener, closer) {
    if (this.char[closer] === TILDE) return this.count[opener] === this.count[closer];
    const either = (this.flags[closer] & OPENS) || (this.flags[opener] & CLOSES), o = this.orig[opener], c = this.orig[closer];
    return !(either && c % 3 !== 0 && (o + c) % 3 === 0);
  }

  // Where a closer's lower bound for openers is kept (commonmark.js `openers_bottom`): by its character, whether it can
  // open, and its length (modulo 3 for * and _).
  floor(d) {
    if (this.char[d] === TILDE) return 12 + this.count[d];
    return (this.char[d] === STAR ? 0 : 6) + (this.flags[d] & OPENS ? 3 : 0) + (this.orig[d] % 3);
  }
}

class Reader {
  constructor(value, defs) {
    this.s = value;
    this.n = value.length;
    this.defs = defs;
    this.definitions = null;
    this.comments = commentsIn(value);
    // Each CriticMarkup mark as its start and end, in order.
    this.markers = [];
    for (const c of this.comments) {
      if (c.kind === "point") this.markers.push(c.start, c.end);
      else this.markers.push(c.start, c.from, c.to, c.end);
    }
    this.next = 0;
    this.limit = this.markers.length ? this.markers[0] : this.n;
    this.pos = 0;
    this.kinds = new Uint8Array(FIRST_CAPACITY);
    this.starts = new Int32Array(FIRST_CAPACITY);
    this.ends = new Int32Array(FIRST_CAPACITY);
    this.linked = new Uint8Array(FIRST_CAPACITY);
    this.texts = [];
    this.count = 0;
    this.plain = NONE;
    this.spans = [];
    this.tags = [];
    this.d = null;
    this.delims = NONE;
    this.brackets = null;
    this.noCloser = null;
    this.webStarts = [...value.matchAll(WEB_START)].map(m => ({ at: m.index, length: m[0].length }));
    this.nextWeb = 0;
  }

  read() {
    const s = this.s, n = this.n;
    while (this.pos < n) {
      const c = s.charCodeAt(this.pos);
      if (this.pos === this.limit) this.marker();
      else if (c < NON_ASCII && !SPECIAL_ASCII[c]) this.string();
      else this.inline();
    }
    this.processEmphasis(NONE);
    if (this.tags.length) this.drawTags();
    return this;
  }

  // CriticMarkup is found before the markdown, the way Reading turns it into <mark> tags first: a marker is a
  // boundary no other construct crosses.
  marker() {
    this.pos = this.markers[this.next + 1];
    this.next += 2;
    this.limit = this.next < this.markers.length ? this.markers[this.next] : this.n;
  }

  inline() {
    const c = this.s.charCodeAt(this.pos);
    switch (c) {
      case NL: case CR: return this.lineBreak(this.pos, this.pos);
      case BSL: return this.backslash();
      case BT: return this.backticks();
      case STAR: case UNDER: case TILDE: return this.delimiterRun(c);
      case LBR: return this.openBracket(this.pos, false);
      case BANG: return this.pos + 1 < this.limit && this.s.charCodeAt(this.pos + 1) === LBR ? this.openBracket(this.pos, true) : this.text(this.pos + 1);
      case RBR: return this.closeBracket();
      case LT: return this.autolink(EMAIL_AUTOLINK, "mailto:") || this.autolink(URI_AUTOLINK, "") || this.htmlTag() || this.text(this.pos + 1);
      case AMP: return this.entity() || this.text(this.pos + 1);
      default: return this.string();
    }
  }

  leaf(kind, start, end, text) {
    if (this.count === this.kinds.length) {
      for (const key of ["kinds", "starts", "ends", "linked"]) this[key] = doubled(this[key]);
    }
    const i = this.count++;
    this.kinds[i] = kind;
    this.starts[i] = start;
    this.ends[i] = end;
    this.texts.push(text);
    return i;
  }

  text(end) {
    this.plainText(this.pos, end);
    this.pos = end;
    return true;
  }

  // Plain text runs on in the last leaf when that leaf is plain text that ends where it starts.
  plainText(from, to) {
    const last = this.count - 1;
    if (last >= 0 && last === this.plain && this.ends[last] === from) this.ends[last] = to;
    else this.plain = this.leaf(TEXT, from, to, null);
  }

  // A line break at `nl`, its marks from `marks` (a backslash), or from two or more spaces before it. The spaces
  // after it are not drawn either.
  lineBreak(marks, nl) {
    const s = this.s, last = this.count - 1;
    let start = marks;
    if (marks === nl && last >= 0 && this.kinds[last] === TEXT && this.ends[last] === nl) {
      let k = nl;
      while (k > this.starts[last] && s.charCodeAt(k - 1) === SP) k--;
      if (nl - k >= 2) {
        start = k;
        this.ends[last] = k;
      }
    }
    const to = nl + (s.charCodeAt(nl) === CR && s.charCodeAt(nl + 1) === NL ? 2 : 1);
    let end = to;
    while (end < this.limit && (s.charCodeAt(end) === SP || s.charCodeAt(end) === TAB)) end++;
    this.spans.push({ id: 0, kind: "break", start, end, from: nl, to });
    this.leaf(CHAR, nl, to, "\n");
    this.pos = end;
    return true;
  }

  backslash() {
    const p = this.pos, next = this.s.charCodeAt(p + 1);
    if (p + 1 >= this.limit) return this.text(p + 1);
    if (next === NL || next === CR) return this.lineBreak(p, p + 1);
    if (!ESCAPABLE.test(this.s[p + 1])) return this.text(p + 1);
    this.leaf(CHAR, p, p + 2, ASCII[this.s.charCodeAt(p + 1)]);
    this.pos = p + 2;
    return true;
  }

  backticks() {
    const s = this.s, p = this.pos;
    let open = p;
    while (open < this.limit && s.charCodeAt(open) === BT) open++;
    const run = open - p;
    this.noCloser ??= new Map();
    if (this.noCloser.get(run) !== this.limit) {
      for (let j = s.indexOf("`", open); j >= 0 && j < this.limit; j = s.indexOf("`", j)) {
        let k = j;
        while (k < this.limit && s.charCodeAt(k) === BT) k++;
        if (k - j === run) return this.codeSpan(p, open, j, k);
        j = k;
      }
      this.noCloser.set(run, this.limit);
    }
    return this.text(open);
  }

  codeSpan(start, open, close, end) {
    const s = this.s, isSpace = k => s.charCodeAt(k) === SP || s.charCodeAt(k) === NL || s.charCodeAt(k) === CR;
    let from = open, to = close;
    if (isSpace(from) && isSpace(to - 1)) {
      let k = from;
      while (k < to && isSpace(k)) k++;
      if (k < to) {
        from += s.charCodeAt(from) === CR && s.charCodeAt(from + 1) === NL ? 2 : 1;
        to -= s.charCodeAt(to - 1) === NL && s.charCodeAt(to - 2) === CR ? 2 : 1;
      }
    }
    this.spans.push({ id: 0, kind: "code", start, end, from, to });
    this.leaf(CODE, from, to, null);
    this.pos = end;
    return true;
  }

  delimiterRun(c) {
    const s = this.s, p = this.pos;
    let e = p;
    while (e < this.limit && s.charCodeAt(e) === c) e++;
    const count = e - p, leaf = this.leaf(DELIM, p, e, null);
    this.pos = e;
    if (c === TILDE && count > 2) return true;
    const before = classBefore(s, p), after = classAt(s, e);
    const afterSpace = after === SPACE_CLASS, afterPunct = after === PUNCTUATION_CLASS;
    const beforeSpace = before === SPACE_CLASS, beforePunct = before === PUNCTUATION_CLASS;
    const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
    const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
    const canOpen = c === UNDER ? left && (!right || beforePunct) : left;
    const canClose = c === UNDER ? right && (!left || afterPunct) : right;
    if (!canOpen && !canClose) return true;
    const d = (this.d ??= new Delimiters()), i = d.add();
    d.char[i] = c;
    d.count[i] = count;
    d.orig[i] = count;
    d.leaf[i] = leaf;
    d.flags[i] = (canOpen ? OPENS : 0) | (canClose ? CLOSES : 0);
    d.prev[i] = this.delims;
    d.next[i] = NONE;
    if (this.delims !== NONE) d.next[this.delims] = i;
    this.delims = i;
    return true;
  }

  openBracket(p, image) {
    const end = p + (image ? 2 : 1), leaf = this.leaf(TEXT, p, end, null);
    if (this.brackets) this.brackets.bracketAfter = true;
    this.brackets = { leaf, prev: this.brackets, prevDelim: this.delims, at: end - 1, image, active: true, bracketAfter: false };
    this.pos = end;
    return true;
  }

  closeBracket() {
    const close = this.pos, opener = this.brackets;
    if (!opener) return this.text(close + 1);
    const target = opener.active ? this.inlineTarget(close + 1) ?? this.referenceTarget(opener, close + 1) : null;
    this.brackets = opener.prev;
    if (!target) return this.text(close + 1);
    this.processEmphasis(opener.prevDelim);
    const start = this.starts[opener.leaf], from = opener.at + 1;
    this.spans.push(opener.image
      ? { id: 0, kind: "image", start, end: target.end, from, to: close, url: target.url, title: target.title, alt: "" }
      : { id: 0, kind: "link", start, end: target.end, from, to: close, url: target.url, title: target.title });
    this.ends[opener.leaf] = start;
    for (let k = opener.leaf + 1; k < this.count; k++) {
      this.linked[k] = 1;
      if (!opener.image && this.kinds[k] === LITERAL) this.kinds[k] = TEXT;
    }
    if (!opener.image) for (let b = this.brackets; b; b = b.prev) if (!b.image) b.active = false;
    this.pos = target.end;
    return true;
  }

  inlineTarget(at) {
    const s = this.s;
    if (s.charCodeAt(at) !== LPAREN) return null;
    const dest = destination(s, spnl(s, at + 1), this.limit);
    if (!dest) return null;
    let p = spnl(s, dest.end), t = null;
    if (p > dest.end) {
      t = title(s, p, this.limit);
      if (t) p = spnl(s, t.end);
    }
    if (p >= this.limit || s.charCodeAt(p) !== RPAREN) return null;
    return { url: dest.url, title: t ? t.text : null, end: p + 1 };
  }

  referenceTarget(opener, at) {
    const s = this.s, m = s.charCodeAt(at) === LBR ? sticky(LABEL, s, at) : null;
    const n = m && LABEL.lastIndex <= this.limit ? m[0].length : 0;
    const label = n > 2 ? m[0] : !opener.bracketAfter ? s.slice(opener.at, at) : null;
    const def = label === null ? null : this.definition(normalizeLabel(label));
    return def && { url: def.url, title: def.title, end: at + n };
  }

  definition(key) {
    if (!key || !this.defs) return null;
    this.definitions ??= new Map();
    if (!this.definitions.has(key)) {
      const source = this.defs.get(key);
      this.definitions.set(key, source === undefined ? null : readDefinition(source));
    }
    return this.definitions.get(key);
  }

  autolink(re, scheme) {
    const p = this.pos, m = sticky(re, this.s, p);
    if (!m || re.lastIndex > this.limit) return false;
    this.spans.push({ id: 0, kind: "link", start: p, end: re.lastIndex, from: p + 1, to: re.lastIndex - 1, url: scheme + m[1], title: null });
    this.linked[this.leaf(TEXT, p + 1, re.lastIndex - 1, null)] = 1;
    this.pos = re.lastIndex;
    return true;
  }

  htmlTag() {
    const p = this.pos;
    HTML_TAG.lastIndex = p;
    if (!HTML_TAG.test(this.s) || HTML_TAG.lastIndex > this.limit) return false;
    const end = HTML_TAG.lastIndex;
    this.tags.push(this.leaf(HTML, p, end, tagOf(this.s, p, end)));
    this.pos = end;
    return true;
  }

  entity() {
    const m = sticky(ENTITY, this.s, this.pos);
    if (!m || ENTITY.lastIndex > this.limit) return false;
    const text = entityText(m[1], m[2], m[3]);
    if (text === null) return false;
    // TextView draws a line ending inside text as a space.
    this.leaf(CHAR, this.pos, ENTITY.lastIndex, text === "\n" || text === "\r" ? " " : text);
    this.pos = ENTITY.lastIndex;
    return true;
  }

  // Where the plain text from `p` ends: the next character that may start markup, or the limit.
  plainEnd(p) {
    const s = this.s, near = Math.min(p + HAND_SCAN, this.limit);
    for (let i = p; i < near; i++) {
      const c = s.charCodeAt(i);
      if (c < NON_ASCII && SPECIAL_ASCII[c]) return i;
    }
    if (near === this.limit) return near;
    SPECIAL.lastIndex = near;
    const found = SPECIAL.exec(s);
    return Math.min(found ? found.index : this.n, this.limit);
  }

  string() {
    const p = this.pos, end = this.plainEnd(p);
    if (this.nextWeb < this.webStarts.length && this.webLiteral(p, end)) return true;
    return this.text(end);
  }

  // The first www. or http(s):// literal starting in s[from, to), with the text before it. It may run on past `to`,
  // over characters that would otherwise be marks: in markdown-rs it is a construct of its own.
  webLiteral(from, to) {
    const s = this.s, starts = this.webStarts;
    while (this.nextWeb < starts.length && starts[this.nextWeb].at < from) this.nextWeb++;
    for (let w = this.nextWeb; w < starts.length && starts[w].at < to; w++) {
      const { at: k, length } = starts[w], www = length === 4, before = s[k - 1] ?? "";
      if (!(www ? !before || WWW_AFTER.includes(before) : !LETTER.test(before))) continue;
      const end = webEnd(s, k + length, this.limit);
      if (end < 0) continue;
      if (k > from) this.plainText(from, k);
      this.leaf(LITERAL, k, end, www ? `http://${s.slice(k, end)}` : s.slice(k, end));
      this.pos = end;
      return true;
    }
    return false;
  }

  processEmphasis(bottom) {
    const d = this.d;
    if (!d) return;
    const floors = d.floors.fill(UNSET);
    let closer = this.delims;
    while (closer !== NONE && d.prev[closer] !== bottom) closer = d.prev[closer];
    while (closer !== NONE) {
      if (!(d.flags[closer] & CLOSES)) {
        closer = d.next[closer];
        continue;
      }
      const key = d.floor(closer), floor = floors[key] === UNSET ? bottom : floors[key];
      let opener = d.prev[closer];
      while (opener !== NONE && opener !== bottom && opener !== floor && !(d.char[opener] === d.char[closer] && (d.flags[opener] & OPENS) && d.pairs(opener, closer))) opener = d.prev[opener];
      if (opener !== NONE && opener !== bottom && opener !== floor) {
        closer = this.emphasis(opener, closer);
        continue;
      }
      floors[key] = d.prev[closer];
      const next = d.next[closer];
      if (!(d.flags[closer] & OPENS)) this.removeDelim(closer);
      closer = next;
    }
    while (this.delims !== NONE && this.delims !== bottom) this.removeDelim(this.delims);
  }

  // The emphasis `opener` and `closer` make: its marks come off their leaves. -> the closer to look at next.
  emphasis(opener, closer) {
    const d = this.d, tilde = d.char[closer] === TILDE;
    const use = tilde ? d.count[closer] : d.count[closer] >= 2 && d.count[opener] >= 2 ? 2 : 1;
    const ol = d.leaf[opener], cl = d.leaf[closer];
    d.count[opener] -= use;
    d.count[closer] -= use;
    const start = (this.ends[ol] -= use), to = this.starts[cl];
    this.spans.push({ id: 0, kind: tilde ? "strike" : use === 1 ? "em" : "strong", start, end: to + use, from: start + use, to });
    this.starts[cl] = to + use;
    d.next[opener] = closer;
    d.prev[closer] = opener;
    let next = closer;
    if (d.count[opener] === 0) this.removeDelim(opener);
    if (d.count[closer] === 0) {
      next = d.next[closer];
      this.removeDelim(closer);
    }
    return next;
  }

  removeDelim(i) {
    const d = this.d, prev = d.prev[i], next = d.next[i];
    if (prev !== NONE) d.next[prev] = next;
    if (next !== NONE) d.prev[next] = prev;
    else this.delims = prev;
  }

  // TextView pairs a styled tag with the first closing tag of its name among the nodes beside it (markdown.rs
  // `inline_groups`), so tags pair within the innermost emphasis or link holding them. Then <br> is a line break,
  // <img> a picture showing its alt text, and any other tag draws nothing.
  drawTags() {
    const size = this.n + 1, groups = new Map(), open = [];
    const containers = sortedBy(this.spans.filter(sp => TAG_CONTAINERS.has(sp.kind)), sp => sp.from * size + (size - 1 - sp.to), size * size);
    let c = 0;
    for (const t of this.tags) {
      const start = this.starts[t], end = this.ends[t];
      while (c < containers.length && containers[c].from <= start) {
        const next = containers[c++];
        while (open.length && open[open.length - 1].to <= next.from) open.pop();
        open.push(next);
      }
      while (open.length && open[open.length - 1].to < end) open.pop();
      const parent = open.length ? open[open.length - 1] : null, group = groups.get(parent);
      if (group) group.push(t);
      else groups.set(parent, [t]);
    }
    for (const group of groups.values()) this.pairTags(group, group.map(t => this.texts[t]), 0, group.length);
    for (const t of this.tags) if (!this.texts[t].paired) this.drawTag(t);
  }

  // Pairs the tags of group[first, last) (leaf indices; `infos` their details), then those inside each pair.
  pairTags(group, infos, first, last) {
    for (let i = first; i < last; i++) {
      const open = infos[i];
      if (open.closing || open.selfClosing || !STYLED_TAGS.has(open.tag)) continue;
      const close = closingTag(infos, i, last);
      if (close < 0) continue;
      const a = group[i], b = group[close], start = this.starts[a], end = this.ends[b], from = this.ends[a], to = this.starts[b];
      this.spans.push(open.tag === "mark"
        ? { id: 0, kind: "html", start, end, from, to, tag: open.tag, color: markColor(this.s.slice(open.attrsAt, open.attrsEnd)) }
        : { id: 0, kind: "html", start, end, from, to, tag: open.tag });
      open.paired = infos[close].paired = true;
      this.pairTags(group, infos, i + 1, close);
      i = close;
    }
  }

  drawTag(t) {
    const info = this.texts[t], start = this.starts[t], end = this.ends[t];
    if (info.tag === "br") {
      this.spans.push({ id: 0, kind: "break", start, end, from: start, to: end });
      this.kinds[t] = CHAR;
      this.texts[t] = "\n";
      return;
    }
    const attrs = this.s.slice(info.attrsAt, info.attrsEnd), src = info.tag === "img" && !info.closing ? attribute(attrs, "src") : null;
    if (!src) {
      this.spans.push({ id: 0, kind: "html", start, end, from: start, to: start, tag: info.tag });
      return;
    }
    const alt = attribute(attrs, "alt"), from = alt ? info.attrsAt + alt.at : start, to = alt ? from + alt.value.length : start;
    this.spans.push({ id: 0, kind: "image", start, end, from, to, url: src.value, title: attribute(attrs, "title")?.value ?? null, alt: "" });
    this.kinds[t] = ALT;
    this.starts[t] = from;
    this.ends[t] = to;
  }
}

const K_OTHER = 0, K_CR = 1, K_LF = 2, K_CONTROL = 3, K_EXTEND = 4, K_ZWJ = 5, K_SPACING = 6, K_RI = 7;
const K_L = 8, K_V = 9, K_T = 10, K_LV = 11, K_LVT = 12;
// Where a cluster stands in an emoji ZWJ sequence: after a pictograph and its extenders, or after the joiner too.
// E_UNCHECKED: only extenders followed its first code point, which is tested for a pictograph once a joiner comes.
const E_NONE = 0, E_PICTOGRAPH = 1, E_JOINER = 2, E_UNCHECKED = 3;
// The kind of each code point above U+02FF met so far: a \p{...} test per character would cost more than the rest of
// the read in Herdr's runtime.
const KINDS = new Map();
const FIRST_MARK = 0x300, SOFT_HYPHEN = 0xad, ZWJ_CP = 0x200d, C1_FROM = 0x7f, C1_TO = 0x9f;
const EXTEND_AT = /[\p{Mn}\p{Me}\u200C\uFF9E\uFF9F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/uy;
const SPACING_AT = /[\p{Mc}\u0E33\u0EB3]/uy;
const CONTROL_AT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/uy;
// Extended_Pictographic as code point ranges: Herdr's runtime is only known to have the general categories.
const PICTOGRAPHIC = [
  [0xa9, 0xa9], [0xae, 0xae], [0x203c, 0x203c], [0x2049, 0x2049], [0x2122, 0x2122], [0x2139, 0x2139], [0x2194, 0x21aa],
  [0x231a, 0x23ff], [0x24c2, 0x24c2], [0x25aa, 0x25fe], [0x2600, 0x27bf], [0x2934, 0x2935], [0x2b05, 0x2b55],
  [0x3030, 0x3030], [0x303d, 0x303d], [0x3297, 0x3299], [0x1f000, 0x1faff], [0x1fc00, 0x1fffd],
];
const isPictographic = cp => cp >= 0xa9 && PICTOGRAPHIC.some(([lo, hi]) => cp >= lo && cp <= hi);
const matchesAt = (re, s, i) => {
  re.lastIndex = i;
  return re.test(s);
};

function hangul(cp) {
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)) return K_L;
  if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)) return K_V;
  if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) return K_T;
  if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 === 0 ? K_LV : K_LVT;
  return -1;
}

function kindOf(s, i, cp) {
  if (cp === ZWJ_CP) return K_ZWJ;
  if (matchesAt(EXTEND_AT, s, i)) return K_EXTEND;
  if (matchesAt(SPACING_AT, s, i)) return K_SPACING;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return K_RI;
  const h = hangul(cp);
  if (h >= 0) return h;
  return matchesAt(CONTROL_AT, s, i) ? K_CONTROL : K_OTHER;
}

function graphemeKind(s, i, cp) {
  if (cp < FIRST_MARK) {
    if (cp === CR) return K_CR;
    if (cp === NL) return K_LF;
    return cp < SP || (cp >= C1_FROM && cp <= C1_TO) || cp === SOFT_HYPHEN ? K_CONTROL : K_OTHER;
  }
  let kind = KINDS.get(cp);
  if (kind === undefined) {
    kind = kindOf(s, i, cp);
    KINDS.set(cp, kind);
  }
  return kind;
}

// Whether no grapheme boundary falls between a character of kind `a` and one of kind `b` (code point `cp`).
// `regional` counts the regional indicators so far.
function joins(a, b, emoji, regional, cp) {
  if (a === K_CR) return b === K_LF;
  if (a === K_LF || a === K_CONTROL || b === K_CR || b === K_LF || b === K_CONTROL) return false;
  if (a === K_L && (b === K_L || b === K_V || b === K_LV || b === K_LVT)) return true;
  if ((a === K_LV || a === K_V) && (b === K_V || b === K_T)) return true;
  if ((a === K_LVT || a === K_T) && b === K_T) return true;
  if (b === K_EXTEND || b === K_ZWJ || b === K_SPACING) return true;
  if (a === K_ZWJ && emoji === E_JOINER) return isPictographic(cp);
  return a === K_RI && b === K_RI && regional % 2 === 1;
}

// The end of the grapheme cluster that starts at `i`, no further than `end`: UAX #29's extended grapheme clusters
// without its Prepend and Indic conjunct rules.
function clusterEnd(s, i, end) {
  let cp = s.codePointAt(i), kind = graphemeKind(s, i, cp), j = i + (cp > 0xffff ? 2 : 1);
  let emoji = E_UNCHECKED, regional = kind === K_RI ? 1 : 0;
  const first = cp;
  while (j < end) {
    cp = s.codePointAt(j);
    const next = graphemeKind(s, j, cp);
    if (next === K_ZWJ && emoji === E_UNCHECKED) emoji = isPictographic(first) ? E_PICTOGRAPH : E_NONE;
    if (!joins(kind, next, emoji, regional, cp)) break;
    if (next === K_EXTEND) emoji = emoji === E_PICTOGRAPH || emoji === E_UNCHECKED ? emoji : E_NONE;
    else if (next === K_ZWJ) emoji = emoji === E_PICTOGRAPH ? E_JOINER : E_NONE;
    else emoji = kind === K_ZWJ && emoji === E_JOINER ? E_PICTOGRAPH : E_NONE;
    regional = next === K_RI ? regional + 1 : 0;
    kind = next;
    j += cp > 0xffff ? 2 : 1;
  }
  return j;
}

// Runs and characters with the same spans around them share one ids array. Freezing them all would cost more than
// the read in Herdr's runtime (it rebuilds an array as a plain object), so only the shared empty one is frozen.
const NO_SPANS = Object.freeze([]);
const ASCII = Array.from({ length: NON_ASCII }, (_, c) => String.fromCharCode(c));

// The end of the character (grapheme cluster) that starts at offset `i` of `value`, no further than `end`.
export function graphemeEnd(value, i, end = value.length) {
  const c = value.charCodeAt(i);
  return c < FIRST_MARK && c !== CR && (i + 1 >= end || value.charCodeAt(i + 1) < FIRST_MARK) ? i + 1 : clusterEnd(value, i, end);
}

function charsOf(s, runs) {
  const chars = [];
  for (const r of runs) {
    if (!r.verbatim) {
      chars.push({ start: r.start, end: r.end, text: r.text, spans: r.spans });
      continue;
    }
    for (let i = r.start; i < r.end;) {
      const j = graphemeEnd(s, i, r.end), c = s.charCodeAt(i);
      chars.push({ start: i, end: j, text: j === i + 1 && c < NON_ASCII ? ASCII[c] : s.slice(i, j), spans: r.spans });
      i = j;
    }
  }
  return chars;
}

// An object costs microseconds in Herdr's runtime, so the run and character objects are built the first time `runs`
// or `chars` is read; reading `spans` alone builds none.
function inlineOf(s, spans, runsOf) {
  return {
    spans,
    get runs() {
      const runs = runsOf();
      Object.defineProperty(this, "runs", { value: runs, enumerable: true, writable: true, configurable: true });
      return runs;
    },
    get chars() {
      const chars = charsOf(s, this.runs);
      Object.defineProperty(this, "chars", { value: chars, enumerable: true, writable: true, configurable: true });
      return chars;
    },
  };
}

// `items` ordered by `key(item)`, ties in their order. A typed array sorts its numbers natively, without the
// comparator calls Herdr's runtime makes slow; `bound` is above every key.
function sortedBy(items, key, bound) {
  const count = items.length;
  if (bound * count > Number.MAX_SAFE_INTEGER) return items.map((item, i) => [key(item), i, item]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(e => e[2]);
  const keys = new Float64Array(count);
  for (let i = 0; i < count; i++) keys[i] = key(items[i]) * count + i;
  keys.sort();
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = items[keys[i] % count];
  return out;
}

// Turns the reader's leaves into runs, kept in typed arrays until they are read, and adds the spans the text itself
// makes: web and e-mail literals.
class Writer {
  constructor(reader) {
    this.s = reader.s;
    this.starts = new Int32Array(FIRST_CAPACITY);
    this.ends = new Int32Array(FIRST_CAPACITY);
    this.texts = [];
    this.count = 0;
    this.spans = [];
    this.nextAt = this.s.indexOf("@");
    for (const c of reader.comments) this.spans.push({ id: 0, kind: c.kind, start: c.start, end: c.end, from: c.from, to: c.to, note: c.note, noteAt: c.noteAt });
    for (const sp of reader.spans) this.spans.push(sp);
  }

  // A run: `text` is what it shows when that is not its source (one character), else null.
  run(start, end, text) {
    if (this.count === this.starts.length) {
      this.starts = doubled(this.starts);
      this.ends = doubled(this.ends);
    }
    const i = this.count++;
    this.starts[i] = start;
    this.ends[i] = end;
    this.texts.push(text);
  }

  verbatim(from, to) {
    if (from < to) this.run(from, to, null);
  }

  char(start, end, text) {
    this.run(start, end, text);
  }

  // What the runs inside [from, to) show.
  shown(from, to) {
    const { starts, ends, texts, count } = this;
    let lo = 0, hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    let text = "";
    for (let k = lo; k < count && ends[k] <= to; k++) text += texts[k] ?? this.s.slice(starts[k], ends[k]);
    return text;
  }

  // Text outside links, with the e-mail literals markdown-rs finds in it once everything else is read.
  text(from, to, linked) {
    while (this.nextAt >= 0 && this.nextAt < from) this.nextAt = this.s.indexOf("@", this.nextAt + 1);
    if (linked || this.nextAt < 0 || this.nextAt >= to) return this.verbatim(from, to);
    let plain = from;
    for (const mail of emailsIn(this.s, from, to)) {
      this.verbatim(plain, mail.start);
      this.spans.push({ id: 0, kind: "link", start: mail.start, end: mail.end, from: mail.start, to: mail.end, url: mail.url, title: null });
      this.verbatim(mail.start, mail.end);
      plain = mail.end;
    }
    this.verbatim(plain, to);
  }

  // A code span's content: a line ending in it shows as a space.
  code(from, to) {
    const s = this.s;
    let plain = from;
    for (let i = from; i < to; i++) {
      const c = s.charCodeAt(i);
      if (c !== NL && c !== CR) continue;
      this.verbatim(plain, i);
      plain = c === CR && i + 1 < to && s.charCodeAt(i + 1) === NL ? i + 2 : i + 1;
      this.char(i, plain, " ");
      i = plain - 1;
    }
    this.verbatim(plain, to);
  }

  // An attribute's text: an entity in it is one character.
  attributeText(from, to) {
    const s = this.s;
    let plain = from;
    for (let i = from; i < to; i++) {
      if (s.charCodeAt(i) !== AMP) continue;
      const m = sticky(ENTITY, s, i), text = m && ENTITY.lastIndex <= to ? entityText(m[1], m[2], m[3]) : null;
      if (text === null) continue;
      this.verbatim(plain, i);
      this.char(i, ENTITY.lastIndex, text);
      plain = ENTITY.lastIndex;
      i = plain - 1;
    }
    this.verbatim(plain, to);
  }

  // The runs of the reader's leaves: contiguous text leaves make one run.
  write(reader) {
    const { kinds, starts, ends, texts, linked, count } = reader;
    for (let k = 0; k < count; k++) {
      const start = starts[k];
      if (start >= ends[k]) continue;
      switch (kinds[k]) {
        case TEXT: case DELIM: {
          let end = ends[k], j = k;
          while (j + 1 < count) {
            const n = j + 1;
            if (starts[n] < ends[n]) {
              if ((kinds[n] !== TEXT && kinds[n] !== DELIM) || starts[n] !== end) break;
              end = ends[n];
            }
            j = n;
          }
          this.text(start, end, linked[k] === 1);
          k = j;
          break;
        }
        case LITERAL:
          this.spans.push({ id: 0, kind: "link", start, end: ends[k], from: start, to: ends[k], url: texts[k], title: null });
          this.verbatim(start, ends[k]);
          break;
        case CHAR: this.char(start, ends[k], texts[k]); break;
        case CODE: this.code(start, ends[k]); break;
        case ALT: this.attributeText(start, ends[k]); break;
        default: break;
      }
    }
  }

  // Spans in source order, outer first, with their ids.
  finish() {
    const s = this.s, size = s.length + 1;
    const spans = sortedBy(this.spans, sp => sp.start * size + (size - 1 - sp.end), size * size);
    for (let i = 0; i < spans.length; i++) spans[i].id = i;
    for (const sp of spans) if (sp.kind === "image") sp.alt = this.shown(sp.from, sp.to);
    return inlineOf(s, spans, () => this.runObjects(spans));
  }

  // The runs, each with the ids of the spans around it.
  runObjects(spans) {
    const { s, starts, ends, texts, count } = this, runs = new Array(count), active = [];
    const holding = sortedBy(spans.filter(sp => sp.from < sp.to), sp => sp.from, s.length + 1);
    let next = 0, ids = NO_SPANS, change = holding.length ? holding[0].from : Infinity;
    for (let k = 0; k < count; k++) {
      const start = starts[k];
      if (start >= change) {
        for (let a = active.length - 1; a >= 0; a--) if (active[a].to <= start) active.splice(a, 1);
        while (next < holding.length && holding[next].from <= start) {
          const sp = holding[next++];
          if (sp.to <= start) continue;
          let at = active.length;
          while (at > 0 && active[at - 1].id > sp.id) at--;
          active.splice(at, 0, sp);
        }
        if (active.length) {
          ids = new Array(active.length);
          for (let a = 0; a < active.length; a++) ids[a] = active[a].id;
        } else ids = NO_SPANS;
        change = next < holding.length ? holding[next].from : Infinity;
        for (let a = 0; a < active.length; a++) if (active[a].to < change) change = active[a].to;
      }
      const verbatim = texts[k] === null;
      runs[k] = { start, end: ends[k], text: verbatim ? s.slice(start, ends[k]) : texts[k], verbatim, spans: ids };
    }
    return runs;
  }
}

// -> { spans, runs, chars } for a text block's field value (`field(doc, b).value`), `defs` the document's link
// reference definitions as `doc.defs` holds them.
// spans: [{ id, kind, start, end, from, to, ...data }] in source order, outer first: [start, end) the whole markup,
// [from, to) the part that shows. Kinds and data: strong, em, strike, code, break; link { url, title }; image { url,
// title, alt }; comment and point { note, noteAt }, highlight; html { tag, color for a mark }. A point comment and a
// tag that draws nothing show nothing: their from and to are equal.
// chars: [{ start, end, text, spans }], each character that shows, a grapheme: its source range, what it shows, and
// the ids of the spans around it, outermost first. An offset no character holds is in a span's marks.
// runs: the same characters in stretches [{ start, end, text, verbatim, spans }]: a verbatim run shows its source
// value.slice(start, end), one or more characters (graphemeEnd splits them); any other run is one character whose
// text differs from its source (an escape, an entity, a line break, a line ending in code).
// `runs` and `chars` are built when first read (`chars` is one object per character); `spans` costs neither.
// Runs and characters with the same spans share one `spans` array: read it, never change it.
export function parseInline(value, { defs } = {}) {
  const s = String(value ?? "");
  const reader = new Reader(s, defs ?? null).read(), writer = new Writer(reader);
  writer.write(reader);
  return writer.finish();
}

// -> map: map[v] is the value offset of the v-th character Reading draws (a point comment draws one), and the last
// entry, map[count], is value.length. An escape's character is where it stands, after its backslash.
export function visibleMap(value) {
  const s = String(value ?? ""), { spans, chars } = parseInline(s), map = [];
  const points = spans.filter(sp => sp.kind === "point");
  let p = 0;
  for (const c of chars) {
    while (p < points.length && points[p].start <= c.start) map.push(points[p++].start);
    const escape = c.end - c.start === 2 && s.charCodeAt(c.start) === BSL && ESCAPABLE.test(c.text);
    map.push(escape ? c.start + 1 : c.start);
  }
  while (p < points.length) map.push(points[p++].start);
  map.push(s.length);
  return map;
}
