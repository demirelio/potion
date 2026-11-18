// CommonMark 0.31 blocks plus GFM tables, task items and footnote definitions. Every edit is one splice of the
// source, so the bytes outside it never change. No imports, so node tests load it as it is.
//
// Offsets are UTF-16 indices into the text. A block's `lines`, `suffix` and `tail` are relative to its `start`;
// every other offset is absolute.

// CommonMark fences: up to 3 spaces of indent (4 is an indented code block), then 3+ backticks or tildes.
export const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
export const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
export const closes = (line, mark) => {
  const m = CLOSE.exec(line);
  return Boolean(m) && m[1][0] === mark[0] && m[1].length >= mark.length;
};

// Work counters for the budget tests: characters the parser read one by one, separator entries the typing splice moved.
export const counters = { chars: 0, seps: 0 };

const SP = 32, TAB = 9, NL = 10, CR = 13, GT = 62, LT = 60, HASH = 35, BT = 96, TILDE = 126, STAR = 42, DASH = 45;
const PLUS = 43, UNDER = 95, EQ = 61, DOT = 46, RPAREN = 41, LPAREN = 40, D0 = 48, D9 = 57, COLON = 58, BSL = 92;
const LBR = 91, PIPE = 124;
const isSpace = c => c === SP || c === TAB;

const PARA = 1, FENCED = 2, ICODE = 3, HTMLB = 4, TABLE = 5;
const STOP = { stop: true };

const ATX = /^#{1,6}(?:[ \t]+|$)/;
const SETEXT = /^(?:=+|-+)[ \t]*$/;
const HR = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const DELIM_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const FRONT_OPEN = /^---[ \t]*\r?$/;
const FRONT_CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;
const TASK = /^\[([ xX])\][ \t]/;
// An image, or a linked image: groups 1-3 are the linked form's alt, address and link, 4-5 the plain form's alt and address.
export const IMAGE_ITEM = /\[!\[((?:\\.|[^\]\\\n])*)\]\(([^)\n]*)\)\]\(([^)\n]*)\)|!\[((?:\\.|[^\]\\\n])*)\]\(([^)\n]*)\)/g;
// A comment's note on one line, unrolled so that one never closed is given up on in one pass.
const PICTURE_NOTE = String.raw`\{>>[^<\n]*(?:<(?!<\})[^<\n]*)*<<\}`;
// A picture of a paragraph of pictures: an image alone, or wrapped in a highlight with at most one comment after it.
const PICTURE = `(?:\\{==(?:${IMAGE_ITEM.source})==\\}(?:${PICTURE_NOTE})?|${IMAGE_ITEM.source})`;
// A gap is either a line break or spaces, never both parts at once, so a paragraph that fails is not tried split by split.
export const IMAGE_ONLY = new RegExp(`^[ \\t]*${PICTURE}(?:(?:[ \\t]*\\n[ \\t]*|[ \\t]*)${PICTURE})*[ \\t]*\\n?$`);
// One picture of a paragraph IMAGE_ONLY took: group 1 opens its highlight, IMAGE_ITEM's groups follow, then group 7
// closes the highlight with the comment after it, group 8.
const PICTURE_ITEM = new RegExp(`(\\{==)?(?:${IMAGE_ITEM.source})(==\\}(${PICTURE_NOTE})?)?`, "g");
const NOTE_MARK = 3;
const BLANK = /^[ \t]*$/;

const BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const ATTRIBUTE = "(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^\"'=<>`\\x00-\\x20]+|'[^']*'|\"[^\"]*\"))?)";
const OPEN_TAG = `<[A-Za-z][A-Za-z0-9-]*${ATTRIBUTE}*\\s*/?>`;
const CLOSE_TAG = "</[A-Za-z][A-Za-z0-9-]*\\s*>";
const HTML_OPEN = [
  null,
  /^<(?:script|pre|textarea|style)(?:\s|>|$)/i,
  /^<!--/,
  /^<[?]/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  new RegExp(`^</?(?:${BLOCK_TAGS})(?:\\s|/?>|$)`, "i"),
  new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})\\s*$`, "i"),
];
const HTML_CLOSE = [null, /<\/(?:script|pre|textarea|style)>/i, /-->/, /\?>/, />/, /\]\]>/];
const HTML_END_MARK = [null, null, "-->", "?>", ">", "]]>"];

const TEXT_KINDS = new Set(["paragraph", "heading", "item", "quote"]);
export const isText = b => TEXT_KINDS.has(b.kind);
export const isCode = b => b.kind === "code" || b.kind === "mermaid";

export const applySplice = (text, s) => text.slice(0, s.start) + s.insert + text.slice(s.end);

const CHUNK = 4096;
// `a.slice(at, at + removed)` became `inserted`. Compared in chunks first, so a 1 MiB text costs a few hundred native
// compares and one short character loop.
export function diff(a, b) {
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p + CHUNK <= n && a.substr(p, CHUNK) === b.substr(p, CHUNK)) p += CHUNK;
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  const m = n - p;
  let s = 0;
  while (s + CHUNK <= m && a.substr(a.length - s - CHUNK, CHUNK) === b.substr(b.length - s - CHUNK, CHUNK)) s += CHUNK;
  while (s < m && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { at: p, removed: a.length - p - s, inserted: b.slice(p, b.length - s) };
}

const columnsOf = s => {
  let c = 0;
  for (let i = 0; i < s.length; i++) c = s.charCodeAt(i) === TAB ? c + 4 - (c % 4) : c + 1;
  return c;
};
const lineStartAt = (text, p) => p === 0 || text.charCodeAt(p - 1) === NL || (p === 1 && text.charCodeAt(0) === 0xfeff);

const RE_LABEL = /\[(?:[^\\[\]]|\\[\s\S]){0,999}\]/y;
const RE_SPNL = /[ \t]*(?:\n[ \t]*)?/y;
const RE_DEST_BRACES = /<(?:[^<>\n\\\x00]|\\[\s\S])*>/y;
const RE_TITLE = /"(?:\\[\s\S]|[^\\"\x00])*"|'(?:\\[\s\S]|[^\\'\x00])*'|\((?:\\[\s\S]|[^\\()\x00])*\)/y;
const RE_LINE_END = /[ \t]*(?:\n|$)/y;
const RE_FOOTNOTE = /\[\^[^\]\s]+\]:/y;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

export const normalizeLabel = raw => raw.slice(1, -1).trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();

const sticky = (re, s, at) => {
  re.lastIndex = at;
  return re.exec(s) ? re.lastIndex : -1;
};

function destination(s, at) {
  if (s.charCodeAt(at) === LT) return sticky(RE_DEST_BRACES, s, at);
  let p = at, depth = 0, c = -1;
  while (p < s.length) {
    c = s.charCodeAt(p);
    if (c === BSL && ESCAPABLE.test(s.charAt(p + 1))) p += 2;
    else if (c === LPAREN) { depth++; p++; }
    else if (c === RPAREN) {
      if (depth < 1) break;
      depth--;
      p++;
    } else if (c <= SP || c === 127) break;
    else p++;
  }
  if (p === at && c !== RPAREN) return -1;
  return depth === 0 ? p : -1;
}

// -> { end, label } for a link reference definition (CommonMark 4.7) at `at` of a paragraph's text, its lines joined
// without their indent; `end` is after its line end. Else null.
function reference(s, at) {
  const afterLabel = sticky(RE_LABEL, s, at);
  if (afterLabel < 0 || s.charCodeAt(afterLabel) !== COLON) return null;
  const label = normalizeLabel(s.slice(at, afterLabel));
  if (!label) return null;
  const dest = destination(s, sticky(RE_SPNL, s, afterLabel + 1));
  if (dest < 0) return null;
  const spaced = sticky(RE_SPNL, s, dest);
  const title = spaced > dest ? sticky(RE_TITLE, s, spaced) : -1;
  let end = sticky(RE_LINE_END, s, title > 0 ? title : dest);
  if (end < 0 && title > 0) end = sticky(RE_LINE_END, s, dest);
  return end < 0 ? null : { end, label };
}

// A pipe that ends the row closes it unless a backslash takes it, as micromark pairs them: `\\|` closes, `\|` does not.
export function cellCount(row) {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === BSL) i++;
    else if (c === PIPE && i < s.length - 1) n++;
  }
  return n;
}

// One shape for every block, so copies are cheap: a re-parse copies the blocks after its window.
class Block {
  constructor(kind, start, depth, parentRec) {
    this.key = "";
    this.kind = kind;
    this.start = start;
    this.end = start;
    this.gapEnd = start;
    this.lines = [];
    this.suffix = null;
    this.tail = null;
    this.level = 0;
    this.setext = false;
    this.depth = depth;
    this.parent = -1;
    this.parentRec = parentRec;
    this.subtreeEnd = start;
    this.list = -1;
    this.number = null;
    this.task = null;
    this.info = "";
    this.fence = "";
    this.fenceIndent = 0;
    this.closed = true;
    this.contPrefix = "";
    this.containerPrefix = "";
    this.render = "";
    this.content = "";
    this.source = "";
    this.index = -1;
    this.fresh = false;
    this.image = false;
    this.markAt = 0;
    this.marker = "";
    this.markerCol = 0;
    this.contentCol = 0;
    this.ordered = false;
    this.bullet = "";
    this.delim = "";
    this.startNumber = 0;
    this.markerOnly = false;
    this.emptyLine = false;
    this.htmlType = 0;
    this.label = null;
    this.footnote = false;
  }
  copy() {
    const c = new Block(this.kind, this.start, this.depth, null);
    c.key = this.key; c.end = this.end; c.gapEnd = this.gapEnd; c.lines = this.lines; c.suffix = this.suffix;
    c.tail = this.tail; c.level = this.level; c.setext = this.setext; c.parent = this.parent;
    c.subtreeEnd = this.subtreeEnd; c.list = this.list; c.number = this.number; c.task = this.task; c.info = this.info;
    c.fence = this.fence; c.fenceIndent = this.fenceIndent; c.closed = this.closed; c.contPrefix = this.contPrefix;
    c.containerPrefix = this.containerPrefix; c.render = this.render; c.content = this.content; c.source = this.source;
    c.index = this.index; c.fresh = this.fresh; c.image = this.image; c.markAt = this.markAt;
    c.marker = this.marker; c.markerCol = this.markerCol; c.contentCol = this.contentCol; c.ordered = this.ordered;
    c.bullet = this.bullet; c.delim = this.delim; c.startNumber = this.startNumber; c.markerOnly = this.markerOnly;
    c.emptyLine = this.emptyLine; c.htmlType = this.htmlType; c.label = this.label; c.footnote = this.footnote;
    return c;
  }
}

// The parser: one pass over the lines with CommonMark's container rule, in the shape of commonmark.js's
// incorporateLine. What a quote holds is not cut into blocks: the quote is one block.
function scan(text, from, opts) {
  const len = text.length, out = [], stack = [], stop = opts.stop;
  let leaf = null, quotes = 0, ls = from, le = 0, ln = 0, off = 0, col = 0, partial = false;
  let nns = 0, nnsCol = 0, indent = 0, blank = true, first = -1, nnsFrom = -1, nnsFromCol = -1;
  let pipe = -1, lineItem = null, outerBody = -1, contOff = 0;

  const at = i => (counters.chars++, text.charCodeAt(i));
  const findNNS = () => {
    if (nnsFrom === off && nnsFromCol === col) return;
    nnsFrom = off;
    nnsFromCol = col;
    let i = off, c = col;
    first = -1;
    for (; i < le; i++) {
      const k = at(i);
      if (k === SP) c++;
      else if (k === TAB) c += 4 - (c % 4);
      else { first = k; break; }
    }
    nns = i;
    nnsCol = c;
    indent = c - col;
    blank = i >= le;
  };
  const toNNS = () => { off = nns; col = nnsCol; partial = false; };
  const advance = (count, columns) => {
    while (count > 0 && off < le) {
      if (text.charCodeAt(off) === TAB) {
        const toTab = 4 - (col % 4);
        if (columns) {
          partial = toTab > count;
          const take = partial ? count : toTab;
          col += take;
          if (!partial) off++;
          count -= take;
        } else { partial = false; col += toTab; off++; count--; }
      } else { partial = false; off++; col++; count--; }
    }
  };
  const rest = i => text.slice(i, le);
  const top = () => stack[stack.length - 1];

  // A block that begins at `start` (its line's start, or mid-line after the marker of an item opened on this line).
  // `prefixEnd` is where its container prefix ends when it begins at the line start. Null inside a quote.
  function record(kind, start, prefixEnd) {
    const parent = top();
    if (parent) parent.hasChild = true;
    if (quotes) return null;
    if (start === ls && !stack.length && stop && stop(ls)) throw STOP;
    if (lineItem) endMarker(lineItem, start);
    const r = new Block(kind, start, stack.length, parent ? parent.rec : null);
    r.fresh = true;
    r.containerPrefix = start !== ls ? parent.rec.contPrefix : text.slice(ls, prefixEnd);
    r.contPrefix = r.containerPrefix;
    out.push(r);
    return r;
  }
  function endMarker(item, at0) {
    const r = item.rec;
    r.lines = [{ start: r.start, body: at0, end: at0, eol: at0, next: at0 }];
    r.end = at0;
    r.markerOnly = true;
    lineItem = null;
  }
  function pushLine(r, body) {
    const start = r.lines.length ? ls : r.start;
    r.lines.push({ start, body: Math.max(body, start), end: le, eol: le, next: ln });
    r.end = ln;
  }

  function closeLeaf() {
    const l = leaf;
    leaf = null;
    if (l.t === PARA) { finishPara(l, null); return; }
    const r = l.rec;
    if (!r) return;
    if (l.t === ICODE) while (r.lines.length > 1 && BLANK.test(text.slice(r.lines.at(-1).start, r.lines.at(-1).eol))) r.lines.pop();
    if (l.t === FENCED) r.closed = l.closed;
    r.end = r.lines.at(-1).next;
  }
  function closeTo(depth) {
    if (leaf) closeLeaf();
    while (stack.length > depth) if (stack.pop().quote) quotes--;
  }

  // Definitions at the start of a paragraph: [{ from, to, footnote, label }] in its line indices.
  function definitions(l) {
    if (l.partsFor === l.lines.length) return l.parts;
    const parts = [];
    if (text.charCodeAt(l.lines[0].body) === LBR) {
      const starts = [];
      let s = "";
      for (const L of l.lines) {
        if (s || starts.length) s += "\n";
        starts.push(s.length);
        s += text.slice(L.body, L.eol);
      }
      const lineAt = p => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= p) lo = mid; else hi = mid - 1;
        }
        return lo;
      };
      let p = 0, k = 0;
      while (k < l.lines.length && s.charCodeAt(p) === LBR) {
        if (sticky(RE_FOOTNOTE, s, p) > 0) {
          let e = k + 1;
          while (e < l.lines.length && sticky(RE_FOOTNOTE, s, starts[e]) < 0) e++;
          parts.push({ from: k, to: e, footnote: true, label: null });
          k = e;
          p = e < starts.length ? starts[e] : s.length;
          continue;
        }
        const ref = reference(s, p);
        if (!ref) break;
        const e = ref.end >= s.length ? l.lines.length : lineAt(ref.end);
        parts.push({ from: k, to: e, footnote: false, label: ref.label });
        k = e;
        p = ref.end;
      }
    }
    l.parts = parts;
    l.partsFor = l.lines.length;
    return parts;
  }

  function finishPara(l, tail) {
    if (l.inQuote) return;
    const lines = l.lines, item = l.item, parts = definitions(l);
    const restFrom = parts.length ? parts.at(-1).to : 0;
    if (item && !parts.length && !tail) {
      textLines(item.rec, lines, 0, item.rec.start);
      task(item.rec);
      return;
    }
    const head = item ? lines[0].body : lines[0].ls;
    if (item) endMarker(item, head);
    const make = (kind, from) => {
      const mid = from === 0 && item;
      const r = new Block(kind, mid ? head : lines[from].ls, l.depth, l.parent);
      r.fresh = from === 0;
      r.containerPrefix = mid ? l.parent.contPrefix : text.slice(lines[from].ls, lines[from].cont);
      r.contPrefix = r.containerPrefix;
      out.push(r);
      return r;
    };
    for (const p of parts) {
      const r = make("definition", p.from);
      r.label = p.label;
      r.footnote = p.footnote;
      for (let k = p.from; k < p.to; k++) {
        const L = lines[k], mid = k === p.from && item;
        r.lines.push({ start: k === p.from ? r.start : L.ls, body: mid ? r.start : L.cont, end: L.eol, eol: L.eol, next: L.next });
      }
      r.end = r.lines.at(-1).next;
    }
    if (restFrom < lines.length) {
      const r = make(tail ? "heading" : "paragraph", restFrom);
      textLines(r, lines, restFrom, r.start);
      if (tail) {
        r.setext = true;
        r.level = tail.level;
        r.tail = { start: tail.start, end: tail.end };
        r.end = tail.end;
      }
    }
  }
  function textLines(r, lines, from, start0) {
    r.lines = [];
    for (let k = from; k < lines.length; k++) {
      const L = lines[k];
      r.lines.push({ start: k === from ? start0 : L.ls, body: L.body, end: L.eol, eol: L.eol, next: L.next });
    }
    r.end = r.lines.at(-1).next;
  }
  function task(r) {
    const L = r.lines[0], m = TASK.exec(text.slice(L.body, Math.min(L.eol, L.body + 4)));
    if (!m) return;
    r.task = { checked: m[1] !== " ", offset: L.body + 1 };
    let b = L.body + 3;
    while (b < L.eol && isSpace(text.charCodeAt(b))) b++;
    L.body = b;
    L.end = Math.max(L.end, b);
  }

  function openPara() {
    const parent = top();
    if (parent) parent.hasChild = true;
    const item = !quotes && lineItem && parent && parent.rec === lineItem.rec ? lineItem : null;
    if (!quotes && !item && !stack.length && stop && stop(ls)) throw STOP;
    leaf = { t: PARA, lines: [], item, inQuote: quotes > 0, depth: stack.length, parent: parent ? parent.rec : null, partsFor: -1, parts: null };
    if (item) lineItem = null;
    paraLine();
  }
  const paraLine = () => leaf.lines.push({ ls, cont: contOff, body: nns, eol: le, next: ln });

  // The next line's content start inside the first `depth` containers (for a table's delimiter row), or -1.
  function peekContent(s, e, depth) {
    let o = s, c = 0;
    const nonspace = () => {
      let i = o, cc = c;
      for (; i < e; i++) {
        const k = text.charCodeAt(i);
        if (k === SP) cc++;
        else if (k === TAB) cc += 4 - (cc % 4);
        else break;
      }
      return [i, cc];
    };
    for (const k of stack.slice(0, depth)) {
      const [i, cc] = nonspace();
      if (k.quote) {
        if (cc - c > 3 || i >= e || text.charCodeAt(i) !== GT) return -1;
        o = i + 1;
        c = cc + 1;
        if (o < e && isSpace(text.charCodeAt(o))) { o++; c++; }
      } else {
        if (i >= e || cc - c < k.need) return -1;
        for (let need = k.need; need > 0;) {
          const w = text.charCodeAt(o) === TAB ? 4 - (c % 4) : 1;
          o++;
          c += w;
          need -= w;
        }
      }
    }
    const [i, cc] = nonspace();
    return cc - c > 3 || i >= e ? -1 : i;
  }
  function tableStart(depth) {
    if (pipe < nns) {
      pipe = text.indexOf("|", nns);
      if (pipe < 0) pipe = len;
    }
    if (pipe >= le || ln >= len) return false;
    const nl = text.indexOf("\n", ln), e2 = nl < 0 ? len : nl > ln && text.charCodeAt(nl - 1) === CR ? nl - 1 : nl;
    const c = peekContent(ln, e2, depth);
    if (c < 0) return false;
    const delim = text.slice(c, e2);
    return DELIM_ROW.test(delim) && cellCount(delim) === cellCount(rest(nns));
  }

  function listItem(inPara, depth) {
    let mlen = 0, ordered = false, num = 0, ch = first;
    if (first === DASH || first === STAR || first === PLUS) mlen = 1;
    else if (first >= D0 && first <= D9) {
      let i = nns;
      while (i < le && i - nns < 10 && (ch = at(i)) >= D0 && ch <= D9) i++;
      if (i - nns > 9 || i >= le || (ch !== DOT && ch !== RPAREN)) return false;
      ordered = true;
      num = Number(text.slice(nns, i));
      mlen = i - nns + 1;
    } else return false;
    const after = nns + mlen;
    if (after < le && !isSpace(at(after))) return false;
    if (inPara) {
      if (ordered && num !== 1) return false;
      let i = after;
      while (i < le && isSpace(at(i))) i++;
      if (i >= le) return false;
    }
    closeTo(depth);
    // A tab the container only partly took stays whole in the prefix.
    const baseOff = partial ? off + 1 : off, baseCol = partial ? col + 4 - (col % 4) : col;
    const markerOffset = indent, parent = top(), mid = Boolean(lineItem) && !quotes;
    toNNS();
    const markerOff = off, markerCol = col;
    const r = record("item", mid ? markerOff : ls, markerOff);
    advance(mlen, true);
    const sCol = col, sOff = off, sPartial = partial;
    do advance(1, true); while (col - sCol < 5 && off < le && isSpace(text.charCodeAt(off)));
    let padding;
    if (col - sCol >= 5 || col - sCol < 1 || off >= le) {
      padding = mlen + 1;
      col = sCol;
      off = sOff;
      partial = sPartial;
      if (off < le && isSpace(text.charCodeAt(off))) advance(1, true);
    } else padding = mlen + col - sCol;
    const item = { quote: false, need: markerOffset + padding, hasChild: false, rec: r };
    if (r) {
      const base = mid ? parent.rec.contPrefix : text.slice(ls, baseOff);
      r.markAt = markerOff;
      r.marker = text.slice(markerOff, markerOff + mlen);
      r.markerCol = markerCol;
      r.contentCol = markerCol + padding;
      r.contPrefix = base + " ".repeat(Math.max(0, r.contentCol - baseCol));
      r.ordered = ordered;
      r.bullet = ordered ? "" : r.marker;
      r.delim = ordered ? r.marker.slice(-1) : "";
      r.startNumber = ordered ? num : 0;
      lineItem = item;
    }
    stack.push(item);
    return true;
  }

  function processLine() {
    off = ls;
    col = 0;
    partial = false;
    lineItem = null;
    outerBody = -1;
    nnsFrom = -1;
    let matched = 0;
    for (; matched < stack.length; matched++) {
      const c = stack[matched];
      findNNS();
      if (c.quote) {
        if (indent > 3 || first !== GT) break;
        toNNS();
        advance(1, false);
        if (off < le && isSpace(text.charCodeAt(off))) advance(1, true);
        if (c.rec) outerBody = partial ? off + 1 : off;
      } else if (blank) {
        if (!c.hasChild) break;
        toNNS();
      } else if (indent >= c.need) advance(c.need, true);
      else break;
    }
    contOff = partial ? off + 1 : off;
    const allContainers = matched === stack.length;
    let leafOk = false;
    if (leaf && allContainers) {
      findNNS();
      if (leaf.t === PARA || leaf.t === TABLE) leafOk = !blank;
      else if (leaf.t === FENCED) {
        if (indent <= 3 && first === leaf.fch && closes(rest(nns), leaf.fence)) {
          if (leaf.rec) pushLine(leaf.rec, contOff);
          leaf.closed = true;
          closeLeaf();
          quoteLine(-1);
          return;
        }
        leafOk = true;
      } else if (leaf.t === ICODE) {
        if (indent >= 4) { advance(4, true); leafOk = true; } else if (blank) { toNNS(); leafOk = true; }
      } else leafOk = !(blank && leaf.ht >= 6);
    }
    const allClosed = allContainers && (!leaf || leafOk);
    let depth = matched, started = false, done = false;
    if (!leafOk || leaf.t === PARA || leaf.t === TABLE) {
      for (;;) {
        findNNS();
        if (blank) break;
        const paraOpen = !started && leaf !== null && leaf.t === PARA, inPara = paraOpen && leafOk;
        const mid = Boolean(lineItem) && !quotes, begin = partial ? off + 1 : off;
        if (indent >= 4) {
          if (!paraOpen) {
            const codeStart = off;
            advance(4, true);
            closeTo(depth);
            const r = record("code", mid ? codeStart : ls, begin);
            leaf = { t: ICODE, rec: r };
            if (r) pushLine(r, mid ? r.start : begin);
            done = true;
          }
          break;
        }
        if (first === GT) {
          closeTo(depth);
          toNNS();
          const markerOff = off, outer = !quotes;
          const r = outer ? record("quote", mid ? markerOff : ls, begin) : null;
          advance(1, false);
          if (off < le && isSpace(text.charCodeAt(off))) advance(1, true);
          if (r) {
            outerBody = partial ? off + 1 : off;
            r.markAt = markerOff;
            r.contPrefix = r.containerPrefix + text.slice(markerOff, outerBody);
          }
          stack.push({ quote: true, rec: r, hasChild: false });
          quotes++;
          started = true;
          depth = stack.length;
          continue;
        }
        if (first === HASH) {
          const m = ATX.exec(rest(nns));
          if (m) {
            closeTo(depth);
            const r = record("heading", mid ? nns : ls, begin);
            if (r) {
              const body = nns + m[0].length, content = text.slice(body, le);
              const whole = /^[ \t]*#+[ \t]*$/.exec(content), closing = whole ? null : /[ \t]+#+[ \t]*$/.exec(content);
              let cut = whole ? 0 : closing ? closing.index : content.length;
              while (cut > 0 && isSpace(content.charCodeAt(cut - 1))) cut--;
              r.level = m[0].trim().length;
              r.markAt = nns;
              r.lines.push({ start: r.start, body, end: body + cut, eol: le, next: ln });
              r.end = ln;
              if (body + cut < le) r.suffix = { start: body + cut, end: le };
            }
            done = true;
            break;
          }
        }
        if (first === BT || first === TILDE) {
          const m = FENCE.exec(rest(nns));
          if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
            closeTo(depth);
            const info = m[2].trim();
            const r = record(/^mermaid$/i.test(info.split(/\s+/)[0]) ? "mermaid" : "code", mid ? nns : ls, begin);
            leaf = { t: FENCED, rec: r, fch: first, fence: m[1], closed: false };
            if (r) {
              r.info = info;
              r.fence = m[1];
              r.fenceIndent = indent;
              pushLine(r, mid ? r.start : begin);
            }
            done = true;
            break;
          }
        }
        if (first === LT) {
          const s = rest(nns), lazy = !allClosed && leaf !== null && leaf.t === PARA;
          let ht = 0;
          for (let t = 1; t <= 7 && !ht; t++) if (HTML_OPEN[t].test(s) && (t < 7 || (!inPara && !lazy))) ht = t;
          if (ht) {
            closeTo(depth);
            const r = record("html", mid ? nns : ls, begin);
            leaf = { t: HTMLB, rec: r, ht };
            if (r) {
              r.htmlType = ht;
              pushLine(r, mid ? r.start : begin);
            }
            if (ht <= 5 && HTML_CLOSE[ht].test(text.slice(begin, le))) closeLeaf();
            done = true;
            break;
          }
        }
        if (inPara && (first === EQ || first === DASH) && SETEXT.test(rest(nns))) {
          const l = leaf, parts = definitions(l);
          if (!parts.length || parts.at(-1).to < l.lines.length) {
            leaf = null;
            finishPara(l, { start: ls, end: ln, level: first === EQ ? 1 : 2 });
            done = true;
            break;
          }
        }
        if ((first === STAR || first === DASH || first === UNDER) && HR.test(rest(nns))) {
          closeTo(depth);
          const r = record("hr", mid ? nns : ls, begin);
          if (r) {
            r.lines.push({ start: r.start, body: mid ? r.start : begin, end: le, eol: le, next: ln });
            r.end = ln;
          }
          done = true;
          break;
        }
        if (listItem(inPara, depth)) {
          started = true;
          depth = stack.length;
          continue;
        }
        if (tableStart(depth)) {
          closeTo(depth);
          const r = record("table", mid ? nns : ls, begin);
          leaf = { t: TABLE, rec: r };
          if (r) pushLine(r, mid ? r.start : begin);
          done = true;
        }
        break;
      }
    }
    if (done) {
      pendingItem();
      quoteLine(-1);
      return;
    }
    if (!started && !allClosed && !blank && leaf && leaf.t === PARA) {
      paraLine();
      quoteLine(nns);
      return;
    }
    if (!allClosed) closeTo(depth);
    if (leaf && leafOk && !started) {
      if (leaf.t === PARA) paraLine();
      else if (leaf.rec) pushLine(leaf.rec, contOff);
      if (leaf.t === HTMLB && leaf.ht <= 5 && HTML_CLOSE[leaf.ht].test(text.slice(contOff, le))) closeLeaf();
    } else if (!blank) {
      if (leaf) closeLeaf();
      openPara();
    }
    pendingItem();
    quoteLine(-1);
  }
  function pendingItem() {
    if (!lineItem) return;
    const r = lineItem.rec;
    r.lines = [{ start: r.start, body: le, end: le, eol: le, next: ln }];
    r.end = ln;
    r.markerOnly = true;
    r.emptyLine = true;
    lineItem = null;
  }
  function quoteLine(lazyBody) {
    if (!quotes) return;
    const outer = stack.find(c => c.quote);
    if (!outer.rec) return;
    const body = outerBody >= 0 ? outerBody : lazyBody;
    if (body >= 0) pushLine(outer.rec, body);
  }

  if (from === 0 && text.charCodeAt(0) === 0xfeff) ls = 1;
  if (from === 0 && opts.frontMatter !== false) frontMatter();
  function frontMatter() {
    const nl = text.indexOf("\n", ls);
    if (!FRONT_OPEN.test(text.slice(ls, nl < 0 ? len : nl))) return;
    for (let p = nl < 0 ? len : nl + 1; p < len;) {
      const n2 = text.indexOf("\n", p);
      if (FRONT_CLOSE.test(text.slice(p, n2 < 0 ? len : n2))) {
        const r = new Block("frontmatter", ls, 0, null);
        r.fresh = true;
        r.containerPrefix = r.contPrefix = "";
        for (let q = ls; q <= p;) {
          const nq = text.indexOf("\n", q), next = nq < 0 ? len : nq + 1;
          const eol = nq < 0 ? len : nq > q && text.charCodeAt(nq - 1) === CR ? nq - 1 : nq;
          r.lines.push({ start: q, body: q, end: eol, eol, next });
          q = next;
          if (nq < 0) break;
        }
        r.end = r.lines.at(-1).next;
        out.push(r);
        ls = r.end;
        return;
      }
      p = n2 < 0 ? len : n2 + 1;
    }
  }

  try {
    while (ls < len) {
      const nl = text.indexOf("\n", ls);
      if (nl < 0) { le = len; ln = len; } else { ln = nl + 1; le = nl > ls && at(nl - 1) === CR ? nl - 1 : nl; }
      processLine();
      ls = ln;
    }
    closeTo(0);
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return out;
}

function relLines(text, r) {
  const s0 = r.start, raw = !isText(r);
  for (let k = 0; k < r.lines.length; k++) {
    const L = r.lines[k];
    let end = L.end;
    if (!raw && k < r.lines.length - 1) while (end > L.body && isSpace(text.charCodeAt(end - 1))) end--;
    r.lines[k] = { start: L.start - s0, body: L.body - s0, end: end - s0, eol: L.eol - s0, next: L.next - s0 };
  }
  if (r.suffix) r.suffix = { start: r.suffix.start - s0, end: r.suffix.end - s0 };
  if (r.tail) r.tail = { start: r.tail.start - s0, end: r.tail.end - s0 };
  r.markAt = Math.max(0, r.markAt - s0);
}

const lineText = (text, b, L) => text.slice(b.start + L.body, b.start + L.eol);

// Spaces before a tab are part of the same indent: the tab alternative is tried first.
const CODE_INDENT = /^(?: {0,3}\t| {1,4})/;
// The length of the indent Reading does not draw at the start of a code line: an indented block's own indent, or in
// a fence (`fenceIndent` a number) up to that many spaces.
export function codeIndent(line, fenceIndent = null) {
  if (fenceIndent === null) return CODE_INDENT.exec(line)?.[0].length ?? 0;
  let n = 0;
  while (n < fenceIndent && line.charCodeAt(n) === SP) n++;
  return n;
}

// The lines of code block `b` that Reading draws: those between its fences, or all of an indented block's.
const codeLines = b => (b.fence ? b.lines.slice(1, b.closed ? -1 : undefined) : b.lines);
const fenceIndentOf = b => (b.fence ? b.fenceIndent || 0 : null);
const INDENTED_CODE = "    ";

function baseRender(text, b) {
  const L = b.lines, s0 = b.start;
  if (isCode(b)) {
    const fenceIndent = fenceIndentOf(b);
    return codeLines(b).map(l => {
      const line = lineText(text, b, l);
      return line.slice(codeIndent(line, fenceIndent));
    }).join("\n");
  }
  if (b.kind === "frontmatter") return L.slice(1, -1).map(l => lineText(text, b, l)).join("\n");
  if (!isText(b)) return L.map(l => lineText(text, b, l)).join("\n");
  return L.map((l, k) => text.slice(s0 + l.body, s0 + (k === L.length - 1 ? l.end : l.eol))).join("\n");
}

function finishRecord(text, r) {
  relLines(text, r);
  r.content = baseRender(text, r);
  if (r.kind === "mermaid") r.source = r.content;
  if (r.kind === "paragraph" && IMAGE_ONLY.test(r.content)) r.image = true;
}

function hardBreak(text, b, L) {
  const s = lineText(text, b, L);
  if (/ {2,}$/.test(s)) return true;
  const m = /\\+$/.exec(s);
  return Boolean(m) && m[0].length % 2 === 1;
}

const DEF_LABELS = /\[((?:[^\\[\]]|\\[\s\S]){1,999})\]/g;

// The definitions (`defs`, a doc's) that the reference links of `text` may use, a line each; "" for none.
export function defsFor(text, defs) {
  if (!defs.size || !text.includes("[")) return "";
  const found = [];
  for (const m of text.matchAll(DEF_LABELS)) {
    const d = defs.get(normalizeLabel(`[${m[1]}]`));
    if (d !== undefined && !found.includes(d)) found.push(d);
  }
  return found.join("\n");
}

function withDefs(b, defs) {
  if (!isText(b) && b.kind !== "table") return b.content;
  const used = defsFor(b.content, defs);
  return used ? `${b.content}\n\n${used}` : b.content;
}

function linkTree(text, blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    b.index = i;
    b.gapEnd = i + 1 < blocks.length ? blocks[i + 1].start : text.length;
    b.subtreeEnd = b.end;
  }
  for (const b of blocks) for (let p = b.parent; p >= 0; p = blocks[p].parent) if (blocks[p].subtreeEnd < b.end) blocks[p].subtreeEnd = b.end;
  const lists = [];
  for (const b of blocks) {
    if (b.kind !== "item") {
      lists.length = Math.min(lists.length, b.depth);
      b.list = -1;
      b.number = null;
      continue;
    }
    lists.length = Math.min(lists.length, b.depth + 1);
    const run = lists[b.depth];
    if (run && run.ordered === b.ordered && run.bullet === b.bullet && run.delim === b.delim && run.parent === b.parent) run.count++;
    else lists[b.depth] = { first: b.index, ordered: b.ordered, bullet: b.bullet, delim: b.delim, parent: b.parent, start: b.startNumber, count: 0 };
    const r = lists[b.depth];
    b.list = r.first;
    b.number = b.ordered ? r.start + r.count : null;
  }
}

function defsOf(text, blocks) {
  const defs = new Map();
  for (const b of blocks) {
    if (b.kind !== "definition" || b.footnote || !b.label || defs.has(b.label)) continue;
    defs.set(b.label, text.slice(b.start + b.lines[0].body, b.start + b.lines.at(-1).eol).replace(/\r\n/g, "\n"));
  }
  return defs;
}
export const sameDefs = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

const firstEol = text => {
  const nl = text.indexOf("\n");
  return nl > 0 && text.charCodeAt(nl - 1) === CR ? "\r\n" : "\n";
};

function resolveParents(head, fresh) {
  fresh.forEach((r, i) => { r.index = head + i; });
  for (const r of fresh) {
    r.parent = r.parentRec ? r.parentRec.index : -1;
    r.parentRec = null;
  }
}

// -> Doc { text, eol, lead: [0, a], blocks, defs }.
export function parse(text, opts = {}) {
  const t = String(text ?? "");
  const blocks = scan(t, 0, { ...opts, stop: null });
  for (const r of blocks) finishRecord(t, r);
  return docOf(t, blocks, opts);
}

// A generator for a text too long to parse in one call: it yields whenever `pause()` is true at the start of a
// top-level block (nothing open there, so the parser starts afresh) and returns the Doc parse returns.
export function* parseInSteps(text, opts = {}, pause = () => false) {
  const t = String(text ?? ""), blocks = [];
  for (let from = 0; ;) {
    let at = -1;
    const stop = pos => {
      if (pos === from || !pause()) return false;
      at = pos;
      return true;
    };
    for (const r of scan(t, from, { ...opts, stop, frontMatter: from === 0 ? opts.frontMatter : false })) {
      finishRecord(t, r);
      blocks.push(r);
    }
    if (at < 0) return docOf(t, blocks, opts);
    from = at;
    yield;
  }
}

function docOf(t, blocks, opts) {
  resolveParents(0, blocks);
  linkTree(t, blocks);
  const defs = defsOf(t, blocks);
  let key = 0;
  for (const b of blocks) {
    b.key = `k${++key}`;
    b.render = withDefs(b, defs);
  }
  return { text: t, eol: firstEol(t), lead: [0, blocks.length ? blocks[0].start : t.length], blocks, defs, nextKey: key + 1, opts };
}

// The block a re-parse may start at: top level, a fresh start at a line start, after a blank line or the lead, its
// first line untouched by the splice. The parser state there is the same in the old and the new text.
function windowStart(doc, p) {
  const bl = doc.blocks, text = doc.text;
  for (let i = bl.length - 1; i >= 0; i--) {
    const b = bl[i];
    if (!b.fresh || b.depth !== 0 || b.start + b.lines[0].next > p || !lineStartAt(text, b.start)) continue;
    if (i === 0) return b.kind === "frontmatter" || b.start === 1 ? -1 : 0;
    if (bl[i - 1].gapEnd > bl[i - 1].end) return i;
  }
  return -1;
}

// A `---` on line 0 opens front matter only when a closing line follows it somewhere: a splice that writes one turns
// the top of the file into front matter. Only the lines the splice touched can be new closing lines.
function closesFrontMatter(doc, text, splice) {
  if (doc.opts?.frontMatter === false || doc.blocks[0]?.kind === "frontmatter") return false;
  const ls = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (text.charCodeAt(ls) !== DASH) return false;
  const nl0 = text.indexOf("\n", ls);
  if (nl0 < 0 || !FRONT_OPEN.test(text.slice(ls, nl0))) return false;
  const insEnd = splice.start + splice.insert.length;
  for (let p = Math.max(nl0 + 1, text.lastIndexOf("\n", splice.start - 1) + 1); p <= insEnd && p < text.length;) {
    const nl = text.indexOf("\n", p);
    if (FRONT_CLOSE.test(text.slice(p, nl < 0 ? text.length : nl))) return true;
    if (nl < 0) break;
    p = nl + 1;
  }
  return false;
}

// `splice` turns doc.text into the new text. -> the new Doc: equal to parse(newText) except for keys. Unchanged blocks
// at either end of the re-parsed window keep theirs, the blocks between reuse old keys of their kind in order.
// `released` lists the keys that went away, `window` the re-parsed block indices.
export function reparse(doc, splice) {
  const text = applySplice(doc.text, splice), delta = splice.insert.length - (splice.end - splice.start);
  const old = doc.blocks, opts = doc.opts ?? {};
  const j = closesFrontMatter(doc, text, splice) ? -1 : windowStart(doc, splice.start), from = j < 0 ? 0 : old[j].start;
  const resyncAt = new Map();
  for (let k = old.length - 1; k >= 0 && old[k].start >= splice.end; k--) {
    const o = old[k];
    if (o.depth === 0 && o.fresh && lineStartAt(doc.text, o.start)) resyncAt.set(o.start + delta, k);
  }
  let resync = -1;
  const stop = pos => {
    if (pos < splice.start + splice.insert.length || pos === from) return false;
    const k = resyncAt.get(pos);
    if (k === undefined) return false;
    resync = k;
    return true;
  };
  const fresh = scan(text, from, { ...opts, stop, frontMatter: from === 0 ? opts.frontMatter : false });
  for (const r of fresh) finishRecord(text, r);
  // The blocks before the window are the old objects: every value linkTree writes into them stays the same, but for
  // the gap of the last one when nothing follows it any more.
  const head = j < 0 ? [] : old.slice(0, j);
  if (head.length) head[head.length - 1] = head[head.length - 1].copy();
  const countDelta = head.length + fresh.length - resync;
  const tail = resync < 0 ? [] : old.slice(resync).map(b => shift(b, delta, countDelta));
  const blocks = [...head, ...fresh, ...tail];
  resolveParents(head.length, fresh);
  linkTree(text, blocks);
  const defs = defsOf(text, blocks);
  for (const b of fresh) b.render = withDefs(b, defs);
  if (!sameDefs(defs, doc.defs)) {
    for (let i = 0; i < blocks.length; i++) {
      const r = withDefs(blocks[i], defs);
      if (r === blocks[i].render) continue;
      if (i < head.length) blocks[i] = blocks[i].copy();
      blocks[i].render = r;
    }
  }
  const { nextKey, released } = reconcile(doc, text, old.slice(head.length, resync < 0 ? old.length : resync), fresh);
  return {
    text, eol: firstEol(text), lead: [0, blocks.length ? blocks[0].start : text.length], blocks, defs, nextKey, opts,
    released, window: [head.length, head.length + fresh.length],
  };
}

function shift(b, delta, countDelta) {
  const c = b.copy();
  c.start += delta;
  c.end += delta;
  if (b.task) c.task = { checked: b.task.checked, offset: b.task.offset + delta };
  if (b.parent >= 0) c.parent = b.parent + countDelta;
  return c;
}

function reconcile(doc, text, olds, news) {
  let nextKey = doc.nextKey;
  const same = (o, n) => o.kind === n.kind && doc.text.slice(o.start, o.end) === text.slice(n.start, n.end);
  let a = 0, z = 0;
  while (a < olds.length && a < news.length && same(olds[a], news[a])) { news[a].key = olds[a].key; a++; }
  while (z < olds.length - a && z < news.length - a && same(olds[olds.length - 1 - z], news[news.length - 1 - z])) {
    news[news.length - 1 - z].key = olds[olds.length - 1 - z].key;
    z++;
  }
  const pool = new Map();
  for (const o of olds.slice(a, olds.length - z)) {
    if (!pool.has(o.kind)) pool.set(o.kind, []);
    pool.get(o.kind).push(o.key);
  }
  for (const n of news.slice(a, news.length - z)) {
    const q = pool.get(n.kind);
    n.key = q && q.length ? q.shift() : `k${nextKey++}`;
  }
  return { nextKey, released: [...pool.values()].flat() };
}

// The splice that closes an unclosed fence the re-parse after `splice` found beginning inside the inserted text and
// running past it, else null. The closing fence goes at the end of the edited line, so what follows stays out.
// A fence begins where its marker is, past its container prefix and indent: a fence typed into an indented line or
// an item's continuation starts its block before the splice.
export function fenceGuard(doc, splice) {
  const text = doc.text, insEnd = splice.start + splice.insert.length;
  for (const b of doc.blocks) {
    if ((b.kind !== "code" && b.kind !== "mermaid") || b.closed || !b.fence) continue;
    const content = b.start + b.lines[0].body;
    let marker = content;
    while (isSpace(text.charCodeAt(marker))) marker++;
    if (marker < splice.start || content > insEnd || b.end <= insEnd) continue;
    const nl = text.indexOf("\n", insEnd);
    const close = b.containerPrefix + b.fence;
    if (nl < 0) return { start: text.length, end: text.length, insert: doc.eol + close, caret: insEnd };
    return { start: nl + 1, end: nl + 1, insert: close + doc.eol, caret: insEnd };
  }
  return null;
}

// The length of the fence run of a line of code field `f` that would close its fence as the parser reads it, else 0.
// `ws` is the indent its file line has before what the field shows.
function closingRun(f, line, ws) {
  const m = CLOSE.exec(" ".repeat(ws) + line);
  return m && m[1][0] === f.fence[0] && m[1].length >= f.fence.length ? m[1].length : 0;
}

// After field range [from, to) of code field `f` was typed, the splice that makes both its fences longer than the
// longest line of that range that would close them, or null when none would. `f` follows the splice.
export function lengthenFence(f, from, to) {
  if (!f.code || !f.fence) return null;
  const v = f.value, a = from > 0 ? v.lastIndexOf("\n", from - 1) + 1 : 0, nl = v.indexOf("\n", to);
  let longest = 0, k = firstSepFrom(f, a);
  for (const line of v.slice(a, nl < 0 ? v.length : nl).split("\n")) {
    longest = Math.max(longest, closingRun(f, line, k === 0 ? f.ws0 : f.seps[k - 1].ws));
    k++;
  }
  if (!longest) return null;
  const mark = f.fence[0], n = longest + 1, more = n - f.fence.length, closed = f.closeTail >= 0;
  const closeEnd = closed ? f.end - f.closeTail : f.openAt, moreClose = closed ? Math.max(0, n - f.closeLen) : 0;
  const between = f.text.slice(f.openAt, closeEnd);
  const s = { start: f.openAt, end: closeEnd, insert: mark.repeat(more) + between + mark.repeat(moreClose) };
  if (f.seps.length) {
    moveGap(f, 0);
    f.gd += more;
  }
  f.start0 += more;
  f.line0 += more;
  f.openAt += more;
  f.end += more + moreClose;
  f.closeLen = Math.max(f.closeLen, n);
  f.fence = mark.repeat(n);
  f.text = applySplice(f.text, s);
  return s;
}

// For each line break of quote `b`: whether it is a soft break inside a paragraph the quote holds (`soft`), and the
// column that paragraph's text starts at in the quote's inner lines (`need`), or -1 inside a nested quote.
function quoteSoft(text, b) {
  // A lazy line only ever continues a paragraph (it is never a setext underline): indented, it does in the inner parse.
  const L = b.lines, lazy = (l, k) => k > 0 && !text.slice(b.start + l.start, b.start + l.body).includes(">");
  const lines = L.map((l, k) => (lazy(l, k) ? "    " : "") + lineText(text, b, l)), inner = lines.join("\n");
  const d = parse(inner, { frontMatter: false });
  const starts = [0];
  for (let k = 0; k < L.length - 1; k++) starts.push(starts[k] + lines[k].length + 1);
  const lineOf = o => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= o) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const soft = new Array(Math.max(0, L.length - 1)).fill(false), need = soft.map(() => -1);
  for (const ib of d.blocks) {
    if (!isText(ib) || ib.lines.length < 2) continue;
    const f = fieldOf(inner, ib, "\n"), cols = ib.kind === "quote" ? -1 : ib.kind === "item" ? ib.contentCol : columnsOf(ib.containerPrefix);
    for (let k = 0; k < ib.lines.length - 1; k++) {
      if (f.seps[k].shown !== " ") continue;
      const line = lineOf(ib.start + ib.lines[k].start);
      soft[line] = true;
      need[line] = cols;
    }
  }
  return { soft, need };
}

// The fence run of the line whose content begins at `p`, past the spaces before it: { start, end }.
function fenceRun(text, p) {
  let start = p;
  while (isSpace(text.charCodeAt(start))) start++;
  const ch = text.charCodeAt(start);
  let end = start;
  while (text.charCodeAt(end) === ch) end++;
  return { start, end };
}

// The parse leaves blank lines at the end of an indented code block out of it, but one carrying the block's whole
// prefix, as Enter at the end of the code writes it, belongs to its field. -> { eol, next } of that line, or null.
function blankCodeLine(text, p, prefix) {
  const nl = text.indexOf("\n", p), eol = nl < 0 ? text.length : nl > p && text.charCodeAt(nl - 1) === CR ? nl - 1 : nl;
  const line = text.slice(p, eol);
  return line.startsWith(prefix) && BLANK.test(line) ? { eol, next: nl < 0 ? text.length : nl + 1 } : null;
}

// The field of a code block or a diagram's source: the code Reading draws, so its fences never show. `contPrefix` is
// what a new line starts with: the container's prefix, then the fence's indent or an indented block's four spaces.
// With no line between its fences the field is empty, and the first text typed writes a line there (`opensLine`).
// `openAt` is where the opening fence's run ends; `closeTail` is how far the block's end lies past the closing fence's
// run, -1 for a fence left open. A line's `ws` (`ws0` for the first) is the indent past its container's prefix that
// the field leaves out: Reading's for a line of the file, `writtenIndent` for a line the field writes.
function codeFieldOf(text, b, eol) {
  const L = b.lines, s0 = b.start, fenced = Boolean(b.fence), fenceIndent = fenceIndentOf(b), lines = codeLines(b);
  const writtenIndent = fenced ? fenceIndent : INDENTED_CODE.length;
  const f = {
    block: b, kind: b.kind, raw: true, code: true, text, eol, contPrefix: b.contPrefix + " ".repeat(writtenIndent),
    value: "", seps: [], g: 0, gf: 0, gd: 0, start0: 0, line0: 0, ws0: writtenIndent, writtenIndent, end: b.end, containerCols: 0,
    emptyMarker: false, tightSuffix: false, childOnMarker: false, opensLine: false,
    fence: b.fence, fenceIndent: fenceIndent ?? 0, openAt: -1, closeLen: 0, closeTail: -1,
  };
  if (fenced) {
    f.openAt = fenceRun(text, s0 + L[0].body).end;
    if (b.closed) {
      const close = fenceRun(text, s0 + L.at(-1).body);
      f.closeLen = close.end - close.start;
      f.closeTail = b.end - close.end;
    }
  }
  if (!lines.length) {
    f.start0 = f.line0 = s0 + L[0].eol;
    f.opensLine = true;
    return f;
  }
  const parts = [];
  let at = 0, prevEol = -1;
  const addLine = (lineStart, from, lineEol, ws) => {
    if (prevEol < 0) {
      f.start0 = from;
      f.line0 = lineStart;
      f.ws0 = ws;
    } else {
      f.seps.push({ at, start: prevEol, eol: prevEol, next: lineStart, end: from, shown: "\n", ws, need: -1 });
      parts.push("\n");
      at++;
    }
    parts.push(text.slice(from, lineEol));
    at += lineEol - from;
    prevEol = lineEol;
  };
  for (const l of lines) {
    const body = s0 + l.body, lineEol = s0 + l.eol, ws = codeIndent(text.slice(body, lineEol), fenceIndent);
    addLine(s0 + l.start, body + ws, lineEol, ws);
  }
  for (let p = b.end, line; !fenced && p < b.gapEnd && (line = blankCodeLine(text, p, f.contPrefix)); p = line.next) {
    addLine(p, p + f.contPrefix.length, line.eol, writtenIndent);
  }
  f.value = parts.join("");
  f.g = f.seps.length;
  return f;
}

function fieldOf(text, b, eol) {
  if (isCode(b)) return codeFieldOf(text, b, eol);
  const raw = !isText(b), L = b.lines, s0 = b.start, q = b.kind === "quote" ? quoteSoft(text, b) : null;
  const p0 = text.slice(s0 + L[0].start, s0 + L[0].body);
  const f = {
    block: b, kind: b.kind, raw, text, eol, contPrefix: b.contPrefix, value: "", seps: [], g: 0, gf: 0, gd: 0,
    start0: s0 + L[0].body, end: b.end,
    containerCols: b.kind === "item" ? b.contentCol : columnsOf(b.containerPrefix),
    emptyMarker: (b.kind === "item" || (b.kind === "heading" && !b.setext)) && L[0].body === L[0].end && p0.length > 0 && !/[ \t]$/.test(p0),
    tightSuffix: Boolean(b.suffix) && L[0].body === L[0].end && text.charCodeAt(s0 + b.suffix.start) === HASH,
    childOnMarker: b.kind === "item" && Boolean(b.markerOnly) && !b.emptyLine,
  };
  const parts = [];
  let at = 0, from = s0 + L[0].body;
  for (let k = 0; k < L.length; k++) {
    const l = L[k], bodyEnd = s0 + (raw ? l.eol : l.end), body = text.slice(from, bodyEnd);
    parts.push(body);
    at += body.length;
    if (k < L.length - 1) {
      const soft = q ? q.soft[k] : !raw && !hardBreak(text, b, l), shown = soft ? " " : "\n";
      // In a quote, the indent of a paragraph's continuation line is not text, as in a paragraph: the soft break takes it.
      let next = s0 + L[k + 1].body;
      if (q && soft) while (next < s0 + L[k + 1].end && isSpace(text.charCodeAt(next))) next++;
      f.seps.push({ at, start: bodyEnd, eol: s0 + l.eol, next: s0 + l.next, end: next, shown, ws: next - s0 - L[k + 1].body, need: q ? q.need[k] : -1 });
      parts.push(shown);
      at++;
      from = next;
    }
  }
  f.value = parts.join("");
  f.g = f.seps.length;
  return f;
}

// -> Field { value, seps: [{ at, start, eol, next, end, shown }], ... } for block `b`: the field value and, for each
// separator, its field offset, its document range (with where its EOL begins and ends) and the character it shows as.
// The typing splice keeps the field and its `text` up to date.
export function field(doc, b) {
  const f = fieldOf(doc.text, b, doc.eol), n = doc.blocks[b.index + 1];
  const firstLine = n ? doc.text.slice(n.start, n.start + n.lines[0].eol) : "";
  // Text typed into an empty item's marker line would take in a next line that cannot interrupt a paragraph.
  if (b.kind === "item" && b.emptyLine && n && n.start === b.end) {
    const rel = columnsOf(/^[ \t]*/.exec(firstLine)[0]) - b.contentCol;
    f.absorbsNext = !interrupts(firstLine, rel, rel < 0);
  } else f.absorbsNext = false;
  if (f.childOnMarker && n) f.childJoins = !interrupts(firstLine, 0, false);
  return f;
}

const sepAt = (f, i) => f.seps[i].at + (i >= f.g ? f.gf : 0);
const sepDoc = (f, i, key) => f.seps[i][key] + (i >= f.g ? f.gd : 0);
const sepView = (f, i) => ({ at: sepAt(f, i), start: sepDoc(f, i, "start"), eol: sepDoc(f, i, "eol"), next: sepDoc(f, i, "next"), end: sepDoc(f, i, "end"), shown: f.seps[i].shown });
export const separators = f => f.seps.map((_, i) => sepView(f, i));

// Separators at index `g` and above carry a pending shift (gf, gd); moving the gap costs one step per separator passed.
function moveGap(f, j) {
  if (f.gf === 0 && f.gd === 0) { f.g = j; return; }
  const move = (s, df, dd) => {
    s.at += df; s.start += dd; s.eol += dd; s.next += dd; s.end += dd;
    counters.seps++;
  };
  while (f.g < j) move(f.seps[f.g++], f.gf, f.gd);
  while (f.g > j) move(f.seps[--f.g], -f.gf, -f.gd);
  if (f.g >= f.seps.length) { f.gf = 0; f.gd = 0; }
}
function firstSepFrom(f, x) {
  let lo = 0, hi = f.seps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sepAt(f, mid) < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function fieldToDoc(f, i) {
  const x = Math.max(0, Math.min(i, f.value.length)), k = firstSepFrom(f, x);
  return k === 0 ? f.start0 + x : sepDoc(f, k - 1, "end") + (x - sepAt(f, k - 1) - 1);
}

export function docToField(f, d) {
  let lo = 0, hi = f.seps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sepDoc(f, mid, "start") <= d) lo = mid + 1; else hi = mid;
  }
  const bodyEnd = j => (j < f.seps.length ? sepAt(f, j) : f.value.length);
  if (lo === 0) return d <= f.start0 ? 0 : Math.min(d - f.start0, bodyEnd(0));
  const s = sepView(f, lo - 1);
  if (d < s.end) return d <= s.eol ? s.at : s.at + 1;
  return Math.min(s.at + 1 + (d - s.end), bodyEnd(lo));
}

// A line of a paragraph, as the source would have it, would not continue the paragraph. `rel` is its indent past the
// block's content column; a lazy line (indented less) can also start any list.
function interrupts(body, rel, lazy) {
  if (rel >= 4) return false;
  const lead = /^[ \t]*/.exec(body)[0].length, s = body.slice(lead, lead + 24);
  const rule = "*-_=".includes(s[0]) ? body.slice(lead) : "";
  if (/^#{1,6}(?:[ \t]|$)/.test(s) || /^(?:`{3,}|~{3,})/.test(s) || HR.test(rule) || s[0] === ">") return true;
  for (let t = 1; t <= 6; t++) if (HTML_OPEN[t].test(s)) return true;
  if (lazy) return /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(s);
  return /^(?:[-+*]|1[.)])[ \t]+\S/.test(s) || SETEXT.test(rule);
}

// Where code field `f`'s line `i0`, starting at field offset `lineStart`, begins in the document, when that line is
// blank, lacks the block's whole prefix and is about to hold `typed`; else -1. A blank line inside a container often
// has no prefix, and text typed on it as it is would leave the block. `start` is where the field line begins.
function bareLineStart(f, i0, lineStart, start, typed) {
  const lineEnd = i0 < f.seps.length ? sepAt(f, i0) : f.value.length;
  if (lineEnd !== lineStart || !typed) return -1;
  const at = i0 > 0 ? f.seps[i0 - 1].next : f.line0, have = f.text.slice(at, start);
  return have !== f.contPrefix && BLANK.test(have) ? at : -1;
}

// The typing splice: field `f` now holds `next`. -> { start, end, insert, caret, fieldCaret } (caret: a document
// offset, fieldCaret: the same place in the field), with `f` updated in place, or null when nothing changed. `caret`,
// the field caret before the change when known, says where an insert or a backspace happened inside a run of equal
// characters, which the diff alone cannot tell; the change itself ({ at, removed, inserted } of the field value) may be
// given instead.
// `linePrefix`, when given, starts every new line as it is (paste), where typing keeps a new line the block's text.
export function type(f, next, caret, linePrefix) {
  const old = f.value;
  if (next === old) return null;
  const given = typeof caret === "object" && caret !== null && old.slice(0, caret.at) + caret.inserted + old.slice(caret.at + caret.removed) === next;
  let { at: a, removed: r, inserted: ins } = given ? caret : diff(old, next);
  if (typeof caret === "number" && !r && caret < a && next.slice(caret + ins.length, a + ins.length) === old.slice(caret, a)) {
    ins = next.slice(caret, caret + ins.length);
    a = caret;
  } else if (typeof caret === "number" && !ins && caret - r >= 0 && caret - r < a && old.slice(caret, a + r) === old.slice(caret - r, a)) a = caret - r;
  const i0 = firstSepFrom(f, a), i1 = firstSepFrom(f, a + r);
  moveGap(f, i1);
  let start = fieldToDoc(f, a), end = fieldToDoc(f, a + r);
  const text = f.text, eol = f.eol, paraLike = f.kind === "paragraph" || f.kind === "item" || f.kind === "heading";
  const lineStart = i0 === 0 ? 0 : f.seps[i0 - 1].at + 1;
  const nextSepAt = i1 < f.seps.length ? sepAt(f, i1) : old.length;
  const tail = old.slice(a + r, nextSepAt);
  const pieces = ins.split("\n");
  const newLinePrefix = body => (!f.raw && paraLike && interrupts(body, 0, false) ? f.contPrefix + "    " : f.contPrefix);
  let middle = pieces[0];
  const made = [];
  for (let p = 1, fieldAt = a + pieces[0].length; p < pieces.length; p++) {
    const line = pieces[p] + (p === pieces.length - 1 ? tail : "");
    const prefix = f.raw ? f.contPrefix : linePrefix === undefined ? newLinePrefix(line) : line.trim() ? linePrefix : linePrefix.replace(/[ \t]+$/, "");
    made.push({ fieldAt, docAt: middle.length, prefix });
    middle += eol + prefix + pieces[p];
    fieldAt += 1 + pieces[p].length;
  }
  let lead = "", trail = "", dropBefore = false, dropAfter = false;
  const markerSpace = a === 0 && f.emptyMarker && ins !== "";
  if (markerSpace) {
    lead = " ";
    f.emptyMarker = false;
  }
  if (f.childOnMarker && old === "" && next !== "") {
    trail = eol + (f.childJoins ? eol : "") + f.contPrefix;
    f.childOnMarker = false;
  }
  if (f.absorbsNext && old === "" && next !== "") {
    trail = eol;
    f.absorbsNext = false;
  }
  if (f.tightSuffix && old === "" && next !== "") {
    trail = " ";
    f.tightSuffix = false;
  }
  const opensLine = f.opensLine && old === "";
  if (opensLine) {
    lead = eol + f.contPrefix;
    f.opensLine = false;
  }
  const bare = f.code && !opensLine ? bareLineStart(f, i0, lineStart, start, pieces[0] + (pieces.length === 1 ? tail : "")) : -1;
  if (bare >= 0) {
    lead = f.contPrefix;
    start = bare;
    if (i0 > 0) {
      f.seps[i0 - 1].end = bare + lead.length;
      f.seps[i0 - 1].ws = f.writtenIndent;
    } else {
      f.start0 = bare + lead.length;
      f.ws0 = f.writtenIndent;
    }
  }
  if (!f.raw) {
    const body = old.slice(lineStart, a) + pieces[0] + (pieces.length === 1 ? tail : "");
    if (pieces.length === 1 && BLANK.test(body) && (i0 > 0 || f.kind === "item" || f.kind === "quote")) {
      // An emptied source line would end the paragraph: the soft break next to it becomes a space and the lines join.
      const after = i1 < f.seps.length && f.seps[i1].shown === " ";
      const before = i0 > 0 && f.seps[i0 - 1].shown === " ";
      if (after) {
        const s = sepView(f, i1);
        trail += text.slice(end, s.start) + " ";
        end = s.end;
        dropAfter = true;
      } else if (before) {
        const s = sepView(f, i0 - 1);
        lead = " " + text.slice(s.end, start) + lead;
        start = s.start;
        dropBefore = true;
      }
    } else if (i0 > 0 && body) {
      const s = sepView(f, i0 - 1), prefix = text.slice(s.next, s.end), sep = f.seps[i0 - 1];
      const rel = columnsOf(prefix) - f.containerCols;
      let wanted = null, ws = 0;
      if (f.kind === "quote") {
        // A lazy line indented 4 past the quote's column cannot start a block, so it stays the paragraph's text.
        if (!prefix.includes(">")) {
          if (interrupts(body, rel, true)) wanted = f.block.containerPrefix + "    ";
        } else if (s.shown === " " && sep.need >= 0) {
          // A line of a paragraph inside the quote: indented past that paragraph's column, it stays its text.
          const marks = prefix.slice(0, prefix.length - sep.ws), inner = columnsOf(prefix.slice(marks.length)) - sep.need;
          ws = sep.need + 4;
          if (interrupts(body, inner, inner < 0)) wanted = marks + " ".repeat(ws);
        }
      } else if (paraLike && interrupts(body, rel, rel < 0)) wanted = f.contPrefix + "    ";
      if (wanted !== null && wanted !== prefix) {
        lead = wanted + text.slice(s.end, start) + lead;
        start = s.next;
        sep.end = s.next + wanted.length;
        sep.ws = ws;
      }
    }
  }
  if (markerSpace) f.start0 += 1;
  if (opensLine) {
    f.line0 = start + eol.length;
    f.start0 = start + lead.length;
  }
  const insert = lead + middle + trail;
  const docDelta = insert.length - (end - start), fieldDelta = ins.length - r;
  const base = start + lead.length;
  const newSeps = made.map(m => {
    const e = base + m.docAt;
    return { at: m.fieldAt, start: e, eol: e, next: e + eol.length, end: e + eol.length + m.prefix.length, shown: "\n", ws: f.code ? f.writtenIndent : 0, need: -1 };
  });
  if (dropAfter) moveGap(f, i1 + 1);
  const from = dropBefore ? i0 - 1 : i0, count = i1 + (dropAfter ? 1 : 0) - from;
  f.seps.splice(from, count, ...newSeps);
  f.g = from + newSeps.length;
  f.gf += fieldDelta;
  f.gd += docDelta;
  if (f.g >= f.seps.length) { f.gf = 0; f.gd = 0; }
  f.value = next;
  f.end += docDelta;
  f.text = text.slice(0, start) + insert + text.slice(end);
  return { start, end, insert, caret: fieldToDoc(f, a + ins.length), fieldCaret: a + ins.length };
}

// On a line of its own, a block marker with nothing after it is an empty heading, item or quote, not a paragraph.
const LONE_MARKER = /^ {0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]|>)$/;
export const loneMarker = value => LONE_MARKER.test(value);

// The markdown shortcut that the space typed at field offset `k` completes, or null. A task shortcut comes with
// the splice that rewrites the source to `- [ ] `; the others are what the source already says.
export function shortcut(f, k) {
  const v = f.value, b = f.block;
  if (v[k] !== " ") return null;
  const head = v.slice(0, k + 1);
  if (b.kind === "paragraph") {
    if (/^#{1,6} $/.test(head)) return { kind: "heading", level: k };
    if (/^(?:[-*+]|\d{1,9}[.)]) $/.test(head)) return { kind: "item" };
    if (head === "> ") return { kind: "quote" };
    if (/^\[ ?\] $/.test(head)) return { kind: "task", splice: { start: fieldToDoc(f, 0), end: fieldToDoc(f, k + 1), insert: "- [ ] " } };
  }
  if (b.kind === "item" && !b.ordered && !b.task && /^\[ ?\] $/.test(head)) {
    return { kind: "task", splice: { start: b.start + b.markAt, end: fieldToDoc(f, k + 1), insert: `${b.bullet} [ ] ` } };
  }
  return null;
}

// The edit operations (split, insertAfter … closeFence) each return one splice { start, end, insert, caret }, the
// caret a document offset after it, or null when they do not apply.

const absLine = (b, k) => {
  const L = b.lines[k];
  return { start: b.start + L.start, body: b.start + L.body, end: b.start + L.end, eol: b.start + L.eol, next: b.start + L.next };
};
const lastLine = b => absLine(b, b.lines.length - 1);
const midLine = (doc, b) => !lineStartAt(doc.text, b.start);
const isDescendant = (bl, j, i) => {
  for (let p = bl[j].parent; p >= 0; p = bl[p].parent) if (p === i) return true;
  return false;
};
const lastOfSubtree = (bl, i) => {
  let j = i;
  while (j + 1 < bl.length && isDescendant(bl, j + 1, i)) j++;
  return j;
};
function prevSibling(doc, b) {
  const bl = doc.blocks;
  for (let j = b.index - 1; j >= 0 && j !== b.parent; j--) if (bl[j].parent === b.parent) return bl[j];
  return null;
}
function nextSibling(doc, b) {
  const bl = doc.blocks, j = lastOfSubtree(bl, b.index) + 1;
  return j < bl.length && bl[j].parent === b.parent ? bl[j] : null;
}
const childrenOf = (doc, b) => doc.blocks.filter(x => x.parent === b.index);
const sourceNumber = b => (b.ordered ? Number.parseInt(b.marker, 10) : 0);

// A new item's marker in the style of item `n`, padded to n's content column so the lines under it keep their meaning.
function itemMarker(n, number, task) {
  const head = n && n.ordered ? `${number}${n.delim}` : (n && n.bullet) || "-";
  const width = n && n.contentCol ? n.contentCol - n.markerCol : head.length + 1;
  return `${head}${" ".repeat(Math.max(1, width - head.length))}${task ? "[ ] " : ""}`;
}

function contentLines(eol, prefix, cont, content) {
  return content.split("\n").map((l, i) => (i ? eol + (l.trim() ? cont : cont.replace(/[ \t]+$/, "")) : prefix) + l).join("");
}

// The source of a new block: "item" gets a marker copied from item `n`; any other kind ("paragraph", or "lines" of
// markdown as it is) is its lines behind the container prefix.
function newBlock(eol, n, kind, content, number, task, prefix) {
  if (kind === "item") {
    const m = itemMarker(n && n.kind === "item" ? n : null, number, task);
    return contentLines(eol, prefix + m, prefix + " ".repeat(m.length), content);
  }
  return contentLines(eol, prefix, prefix, content);
}

// The text that closes an unclosed fence or an HTML block that runs to the end of the file, else "".
function closing(doc, b) {
  if ((b.kind === "code" || b.kind === "mermaid") && !b.closed && b.fence) return b.containerPrefix + b.fence;
  if (b.kind !== "html" || b.htmlType > 5 || b.end < doc.text.length) return "";
  const last = lastLine(b), text = doc.text;
  if (HTML_CLOSE[b.htmlType].test(text.slice(last.body, last.eol))) return "";
  const open = /^\s*<([a-z]+)/i.exec(text.slice(b.start, b.start + b.lines[0].eol));
  return b.containerPrefix + (b.htmlType === 1 ? `</${open[1].toLowerCase()}>` : HTML_END_MARK[b.htmlType]);
}

// A new block's source `t` at P, after `prev` (whose end is P) and before `next`: a blank line between them unless
// `tight`, and none lost when the file has no final newline.
function placeAt(doc, P, prev, next, t, tight, close) {
  const text = doc.text, eol = doc.eol;
  const noFinal = P === text.length && P > 0 && text.charCodeAt(P - 1) !== NL;
  let insert = "", open = noFinal;
  if (close) {
    insert += (open ? eol : "") + close;
    open = true;
  }
  if (open) insert += eol;
  if (prev && !tight) insert += eol;
  const caret = P + insert.length + t.length;
  insert += t;
  if (!noFinal) insert += eol;
  if (!tight && next && text.slice(P, next.start) === "") insert += eol;
  return { start: P, end: P, insert, caret };
}

export function insertAfter(doc, b, kind = "paragraph", content = "") {
  const bl = doc.blocks, kids = childrenOf(doc, b);
  if (b.kind === "item" && kind === "item" && kids.length && kids[0].kind === "item" && !midLine(doc, kids[0])) {
    const c = kids[0], t = newBlock(doc.eol, c, "item", content, sourceNumber(c), Boolean(c.task), c.containerPrefix);
    return { start: c.start, end: c.start, insert: t + doc.eol, caret: c.start + t.length };
  }
  const lastIdx = lastOfSubtree(bl, b.index), last = bl[lastIdx], next = bl[lastIdx + 1] ?? null;
  const t = newBlock(doc.eol, b, kind, content, sourceNumber(b) + 1, Boolean(b.task), b.containerPrefix);
  return placeAt(doc, kids.length ? b.subtreeEnd : b.end, last, next, t, kind === "item" && b.kind === "item", closing(doc, last));
}

export function insertBefore(doc, b, kind = "paragraph", content = "") {
  const bl = doc.blocks;
  if (midLine(doc, b) && b.parent >= 0) return insertBefore(doc, bl[b.parent], kind, content);
  const prev = b.index > 0 ? bl[b.index - 1] : null, eol = doc.eol;
  const t = newBlock(eol, b, kind, content, sourceNumber(b), Boolean(b.task), b.containerPrefix);
  const tightNext = kind === "item" && b.kind === "item";
  if (!prev || prev.index === b.parent || tightNext) {
    const s = { start: b.start, end: b.start, insert: t + eol + (tightNext ? "" : eol), caret: b.start + t.length };
    // A first child right below its parent's text line would continue that text.
    return prev ? guard(doc, s, [{ at: b.start, depth: b.depth }, { at: b.start + s.insert.length, depth: b.depth }]) : s;
  }
  const sib = prevSibling(doc, b);
  return placeAt(doc, prev.end, prev, b, t, kind === "item" && sib?.kind === "item", closing(doc, prev));
}

export function insertAt(doc, kind = "paragraph", content = "") {
  if (doc.blocks.length) return insertAfter(doc, doc.blocks.at(-1), kind, content);
  const text = doc.text, P = text.length;
  const t = newBlock(doc.eol, null, kind, content, 1, false, "");
  const pre = P > 0 && !(P === 1 && text.charCodeAt(0) === 0xfeff) && text.charCodeAt(P - 1) !== NL ? doc.eol : "";
  return { start: P, end: P, insert: pre + t, caret: P + pre.length + t.length };
}

// The last re-parse of an op's splice, by identity: the fusion guard checks each seam of one splice, and paste then
// checks its neighbours, on the same re-parse.
let lastReparse = { doc: null, splice: null, result: null };
function reparsed(doc, sp) {
  if (lastReparse.doc !== doc || lastReparse.splice !== sp) lastReparse = { doc, splice: sp, result: reparse(doc, sp) };
  return lastReparse.result;
}

// The fusion guard: where a seam (a new-text offset at a line start) ended up inside a block, or the block
// after it moved into a list above it (it lost its `depth`), one EOL goes in there. Null when a blank line cannot
// part them (indented code next to indented code or under a list item).
function guard(doc, s, seams) {
  if (!s) return null;
  let out = s;
  const shift = s.insert.length - (s.end - s.start);
  const fused = (sp, at, depth) => {
    const blocks = reparsed(doc, sp).blocks;
    if (blocks.some(b => b.start < at && b.end > at)) return true;
    const n = depth === undefined ? null : blocks.find(b => b.start >= at);
    return Boolean(n) && n.depth !== depth;
  };
  const withDepth = x => {
    if (typeof x !== "number") return x;
    const old = x >= s.start + s.insert.length ? doc.blocks.find(b => b.start >= x - shift) : null;
    return { at: x, depth: old ? old.depth : undefined };
  };
  const list = seams.map(withDepth), eol = doc.eol;
  // Parting two blocks can fuse the next pair, so every seam is checked again until none changes.
  for (let changed = true, pass = 0; changed && pass < 2 * list.length + 1; pass++) {
    changed = false;
    for (const sm of [...list].sort((x, y) => y.at - x.at)) {
      const seam = sm.at;
      if (!fused(out, seam, sm.depth)) continue;
      const delta = out.insert.length - (out.end - out.start);
      if (seam >= out.start && seam <= out.start + out.insert.length) {
        const k = seam - out.start;
        out = { ...out, insert: out.insert.slice(0, k) + eol + out.insert.slice(k), caret: out.caret >= seam ? out.caret + eol.length : out.caret };
      } else if (seam > out.start + out.insert.length) {
        const oldSeam = seam - delta;
        out = { ...out, insert: out.insert + doc.text.slice(out.end, oldSeam) + eol, end: oldSeam };
      } else {
        out = { ...out, start: seam, insert: eol + doc.text.slice(seam, out.start) + out.insert, caret: out.caret + eol.length };
      }
      for (const o of list) if (o.at >= seam) o.at += eol.length;
      if (fused(out, sm.at, sm.depth)) return null;
      changed = true;
    }
  }
  return out;
}
const firstNonBlank = (text, p) => {
  while (isSpace(text.charCodeAt(p))) p++;
  return p;
};
// Whether the block right before splice `sp` (when it is b's previous block) and the block right after it keep their
// kinds and fields. The block after is found where its first character went: a child that sat on its parent's marker
// line starts a line of its own after the splice.
function neighboursKept(doc, sp, b) {
  const bl = doc.blocks, prev = bl[b.index - 1], next = bl.find(x => x.start >= sp.end && x.index > b.index);
  const nd = reparsed(doc, sp), delta = sp.insert.length - (sp.end - sp.start);
  const same = (x, y) => Boolean(y) && y.kind === x.kind && field(nd, y).value === field(doc, x).value;
  if (prev && prev.end <= sp.start && !same(prev, nd.blocks[prev.index])) return false;
  if (!next) return true;
  const at = firstNonBlank(doc.text, next.start) + delta;
  return same(next, nd.blocks.find(y => y.start === next.start + delta) ?? nd.blocks.find(y => firstNonBlank(nd.text, y.start) === at));
}

// The seam before the block that follows block index i's subtree, with the depth that block must keep.
const seamBefore = (doc, i, at) => {
  const n = doc.blocks[lastOfSubtree(doc.blocks, i) + 1];
  return n ? { at, depth: n.depth } : at;
};

// remove(b) and removeRange(first, last) take the blocks with their sub-blocks, which would otherwise change meaning
// at their old indent (a paragraph under a wide marker becomes code).
export const remove = (doc, b) => removeRange(doc, b, b);

// The pictures of `text`, a paragraph of pictures' content or field value: { start, end } all of one, its highlight
// and comment with it, { from, to } its image (a linked one's with its link), `note` its comment's text and `noteAt`
// where that starts (null and -1 for none).
export function pictureSpans(text) {
  const out = [];
  for (const m of text.matchAll(PICTURE_ITEM)) {
    const start = m.index, end = start + m[0].length, from = start + (m[1]?.length ?? 0), to = end - (m[7]?.length ?? 0);
    const note = m[8] === undefined ? null : m[8].slice(NOTE_MARK, -NOTE_MARK);
    out.push({ start, end, from, to, note, noteAt: note === null ? -1 : end - NOTE_MARK - note.length });
  }
  return out;
}

// Each picture of image paragraph b as pictureSpans gives it, in document offsets.
export function picturesIn(doc, b) {
  const f = fieldOf(doc.text, b, doc.eol), at = x => (x < 0 ? x : fieldToDoc(f, x));
  return pictureSpans(f.value).map(p => ({ start: at(p.start), end: at(p.end), from: at(p.from), to: at(p.to), note: p.note, noteAt: at(p.noteAt) }));
}

// Item i of `items` (document ranges { start, end } in order, inside block b) goes: with the
// spaces after it when another follows on its line, else the spaces before it; with its whole line when it stands
// alone on one.
export function cutItem(b, items, i) {
  const lines = b.lines.map((_, k) => absLine(b, k)), lineOf = x => lines.findIndex(l => x < l.next || l === lines.at(-1));
  const item = items[i], k = lineOf(item.start), row = items.filter(q => lineOf(q.start) === k), j = row.indexOf(item);
  let s;
  if (row.length > 1) s = j < row.length - 1 ? { start: item.start, end: row[j + 1].start } : { start: row[j - 1].end, end: item.end };
  // The first line keeps its own start, which a lazy next line may lack.
  else if (k === 0) s = { start: lines[0].body, end: lines[1].body };
  else if (k < lines.length - 1) s = { start: lines[k].start, end: lines[k + 1].start };
  else s = { start: lines[k - 1].eol, end: lines[k].eol };
  return { ...s, insert: "", caret: s.start };
}

// Picture i of image paragraph b goes as cutItem takes it, or with the paragraph when it is the only one.
export function removePicture(doc, b, i) {
  const all = picturesIn(doc, b);
  if (!all[i]) return null;
  return all.length === 1 ? remove(doc, b) : cutItem(b, all, i);
}

export function removeRange(doc, first, last0) {
  const bl = doc.blocks;
  let k = last0.index;
  for (let i = first.index; i <= k; i++) k = Math.max(k, lastOfSubtree(bl, i));
  const last = bl[k];
  let s;
  if (midLine(doc, first)) {
    // The item's marker line ends up blank; a blank line after it would end the item before its other children.
    const L = lastLine(last), parent = bl[first.parent], more = Boolean(parent) && parent.subtreeEnd > last.end;
    s = { start: first.start, end: more ? last.gapEnd : L.next, insert: doc.text.slice(L.eol, L.next) };
  } else if (last.index === bl.length - 1 && first.index > 0) s = { start: bl[first.index - 1].end, end: last.gapEnd, insert: "" };
  else s = { start: first.start, end: last.gapEnd, insert: "" };
  s.caret = s.start;
  return guard(doc, s, [seamBefore(doc, k, s.start + s.insert.length)]);
}

// The caret is the paragraph's start, or where `at` (a document offset in b's field) went.
export function toParagraph(doc, b, at) {
  const text = doc.text, eol = doc.eol, l0 = absLine(b, 0), mapped = at !== undefined;
  let s, seams;
  if (b.kind === "heading" && b.setext) {
    const t0 = b.start + b.tail.start, t1 = b.start + b.tail.end;
    s = t1 === text.length && text.charCodeAt(t1 - 1) !== NL ? { start: lastLine(b).eol, end: t1, insert: "" } : { start: t0, end: t1, insert: "" };
    s.caret = mapped ? at : l0.body;
    seams = [b.start, s.start];
  } else if (b.kind === "heading") {
    const m = b.start + b.markAt;
    s = { start: m, end: l0.eol, insert: text.slice(l0.body, l0.end), caret: m + (mapped ? Math.max(0, Math.min(at, l0.end) - l0.body) : 0) };
    seams = [b.start, b.end + (s.insert.length - (s.end - s.start))];
  } else if (b.kind === "item") {
    // The sub-blocks move left by the marker's width, so they keep their meaning under the paragraph.
    const m = b.start + b.markAt, sib = prevSibling(doc, b), nextSib = nextSibling(doc, b), kids = b.subtreeEnd > b.end;
    const before = b.depth === 0 && sib && sib.kind === "item" && text.slice(sib.subtreeEnd, b.start) === "" ? eol : "";
    const after = b.depth === 0 && !kids && nextSib && nextSib.kind === "item" && b.gapEnd === b.end ? eol : "";
    const head = before + text.slice(b.start, m), body = b.start + head.length, w = b.contentCol - b.markerCol;
    const left = line => removeColumns(line, w);
    if (!kids && !after) s = { start: b.start, end: l0.body, insert: head };
    else {
      const end = kids ? b.subtreeEnd : b.end;
      s = { start: b.start, end, insert: head + text.slice(l0.body, l0.next) + rewriteLines(text, l0.next, end, left) + after };
    }
    if (!mapped || at < l0.next) s.caret = body + (mapped ? Math.max(0, at - l0.body) : 0);
    else s.caret = s.end === l0.body ? at + body - l0.body : body + (l0.next - l0.body) + rewrittenAt(text, l0.next, left, at);
    const delta = s.insert.length - (s.end - s.start);
    seams = [b.start + before.length, (kids ? b.subtreeEnd : b.end) + delta - after.length];
  } else if (b.kind === "quote") {
    let insert = "", caret = -1;
    for (const L of b.lines) {
      const prefix = text.slice(b.start + L.start, b.start + L.body), mark = prefix.indexOf(">");
      const kept = mark < 0 ? prefix : prefix.slice(0, mark);
      if (mapped && caret < 0 && at < b.start + L.next) caret = b.start + insert.length + kept.length + Math.max(0, at - (b.start + L.body));
      insert += kept + text.slice(b.start + L.body, b.start + L.next);
    }
    const p0 = text.slice(l0.start, l0.body), at0 = p0.indexOf(">");
    s = { start: b.start, end: b.end, insert, caret: caret >= 0 ? caret : mapped ? b.start + insert.length : l0.start + (at0 < 0 ? p0.length : at0) };
    seams = [b.start, b.start + insert.length];
  } else return null;
  return guard(doc, s, seams.filter(p => lineStartAt(applySplice(text, s), p)));
}

// Where offset `at` of `text` (past the leading whitespace of its line, on or after line start `from`) is once
// rewriteLines(text, from, …, fn) rewrote the lines from `from`: an offset from `from`.
function rewrittenAt(text, from, fn, at) {
  const ls = Math.max(from, text.lastIndexOf("\n", at - 1) + 1), nl = text.indexOf("\n", at), le = nl < 0 ? text.length : nl + 1;
  return rewriteLines(text, from, ls, fn).length + (at - ls) + rewriteLines(text, ls, le, fn).length - (le - ls);
}

const listOf = b => (b.task ? "task" : b.ordered ? "ordered" : "bullet");
const isVariant = (b, to) => b.kind === to.kind && (b.kind !== "heading" || b.level === to.level) && (b.kind !== "item" || listOf(b) === to.list);
const MARKERS = { quote: "> ", bullet: "- ", ordered: "1. ", task: "- [ ] " };

function holdingBlock(doc, at) {
  const bl = doc.blocks;
  let lo = 0, hi = bl.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bl[mid].start <= at) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : bl[found];
}

function guardBlock(doc, b, s) {
  const after = b.subtreeEnd + s.insert.length - (s.end - s.start), seams = [seamBefore(doc, b.index, after)];
  if (lineStartAt(doc.text, b.start)) seams.push(b.start);
  return guard(doc, s, seams);
}

function composed(text, p, q) {
  const x = diff(text, applySplice(applySplice(text, p), q));
  return { start: x.at, end: x.at + x.removed, insert: x.inserted, caret: q.caret };
}

// `to` is { kind: "paragraph" | "heading" | "item" | "quote", level, list: "bullet" | "ordered" | "task" }; `at` (a
// document offset in b's field) is mapped to the caret. A paragraph gets the marker before its text, and a heading's
// text on one line; a heading or an item gets another marker; anything else becomes a paragraph first. Null when what
// it makes is not a `to` block, or the blocks beside it change (an item with nothing on its marker line would take in
// the block below it).
export function retype(doc, b, to, at) {
  if (!isText(b)) return null;
  const s = retypeIn(doc, b, to, at, 0);
  if (!s || (s.start === s.end && !s.insert)) return s;
  const nb = holdingBlock(reparsed(doc, s), s.caret);
  return nb && nb.kind === to.kind && neighboursKept(doc, s, b) ? s : null;
}

function retypeIn(doc, b, to, at, depth) {
  if (isVariant(b, to)) return { start: at, end: at, insert: "", caret: at };
  if (b.kind === "paragraph") return fromParagraph(doc, b, to, at);
  if (b.kind === "heading" && !b.setext && to.kind === "heading") return reheading(doc, b, to.level, at);
  if (b.kind === "item" && to.kind === "item") return relist(doc, b, to.list, at);
  const p = toParagraph(doc, b, at);
  if (!p || depth > 1) return null;
  const d = reparse(doc, p), pb = holdingBlock(d, p.caret);
  if (!pb || !isText(pb)) return null;
  if (isVariant(pb, to)) return p;
  const q = retypeIn(d, pb, to, p.caret, depth + 1);
  return q && composed(doc.text, p, q);
}

// A paragraph's marker goes before its first line, whose lazy lines stay its text. A heading has one line: each line
// break of the paragraph becomes a space, a hard break's backslash going with it.
function fromParagraph(doc, b, to, at) {
  const f = field(doc, b), lead = fieldToDoc(f, 0);
  if (to.kind !== "heading") {
    const marker = MARKERS[to.kind === "quote" ? "quote" : to.list];
    return guardBlock(doc, b, { start: lead, end: lead, insert: marker, caret: at + marker.length });
  }
  const text = doc.text, k = docToField(f, at), marker = `${"#".repeat(to.level)} `;
  let insert = marker, from = lead, dropped = 0;
  for (const sep of separators(f)) {
    const slash = sep.shown === "\n" && sep.start === sep.eol && /(?:^|[^\\])(?:\\\\)*\\$/.test(text.slice(Math.max(from, sep.start - 64), sep.start)) ? 1 : 0;
    if (slash && k >= sep.at) dropped++;
    insert += `${text.slice(from, sep.start - slash)} `;
    from = sep.end;
  }
  return guardBlock(doc, b, { start: lead, end: from, insert, caret: lead + marker.length + k - dropped });
}

function reheading(doc, b, level, at) {
  const m = b.start + b.markAt, body = b.start + b.lines[0].body, marker = `${"#".repeat(level)} `;
  return guardBlock(doc, b, { start: m, end: body, insert: marker, caret: at + marker.length - (body - m) });
}

// An item's marker (and task box) becomes another, one space after it. The item's other lines and sub-blocks move by
// the columns its content moves, so they keep their place in it. A number follows a numbered item before it.
function relist(doc, b, list, at) {
  const text = doc.text, l0 = absLine(b, 0), m = b.start + b.markAt, sib = prevSibling(doc, b);
  const head = list === "ordered" ? `${sib?.kind === "item" && sib.ordered && sib.delim === "." ? sib.number + 1 : 1}.` : b.bullet || "-";
  const shift = head.length + 1 - (b.contentCol - b.markerCol);
  const marker = `${head} ${list === "task" ? "[ ] " : ""}`, body = m + marker.length;
  if (!shift || l0.next >= b.subtreeEnd) return guardBlock(doc, b, { start: m, end: l0.body, insert: marker, caret: at + marker.length - (l0.body - m) });
  const moved = shift > 0 ? line => " ".repeat(shift) + line : line => removeColumns(line, -shift);
  const insert = marker + text.slice(l0.body, l0.next) + rewriteLines(text, l0.next, b.subtreeEnd, moved);
  const caret = at < l0.next ? body + (at - l0.body) : body + (l0.next - l0.body) + rewrittenAt(text, l0.next, moved, at);
  return guardBlock(doc, b, { start: m, end: b.subtreeEnd, insert, caret });
}

// b's text joined to the end of a's last text line, the caret at the join. A setext a keeps its tail after the
// joined text; a setext b loses its tail.
function join(doc, a, b) {
  const text = doc.text, eol = doc.eol, la = lastLine(a), at = la.end;
  const fa = fieldOf(text, a, eol);
  let bt;
  if (b.kind === "quote" || (a.kind === "heading" && !a.setext)) {
    const fb = fieldOf(text, b, eol);
    bt = a.kind === "heading" && !a.setext ? fb.value.replace(/\n/g, " ") : fb.value.split("\n").join(eol + a.contPrefix);
  } else bt = text.slice(b.start + b.lines[0].body, b.start + b.lines.at(-1).end);
  const lastOfB = b.tail ? { eol: b.start + b.tail.end - (/\r?\n$/.exec(text.slice(b.start + b.tail.start, b.start + b.tail.end))?.[0].length ?? 0), next: b.start + b.tail.end } : lastLine(b);
  let insert = (fa.emptyMarker && bt ? " " : "") + bt;
  if (a.suffix) insert += text.slice(la.end, la.eol);
  if (a.setext) {
    const t0 = a.start + a.tail.start, t1 = a.start + a.tail.end, tailLine = text.slice(t0, t1).replace(/\r?\n$/, "");
    insert += text.slice(la.eol, la.next) + tailLine;
  }
  insert += text.slice(lastOfB.eol, lastOfB.next);
  return { start: at, end: b.end, insert, caret: at + (fa.emptyMarker && bt ? 1 : 0) };
}
export function mergeIntoPrevious(doc, a, b) {
  const s = join(doc, a, b);
  return guard(doc, s, [s.start + s.insert.length]);
}
// Delete at the end of a makes the same splice as Backspace at the start of b.
export const mergeNext = mergeIntoPrevious;

export function split(doc, b, s, e = s) {
  if (!isText(b)) return null;
  const f = field(doc, b), v = f.value, text = doc.text, eol = doc.eol;
  while (s > 0 && (v[s - 1] === " " || v[s - 1] === "\t")) s--;
  while (e < v.length && (v[e] === " " || v[e] === "\t")) e++;
  const start = fieldToDoc(f, s), end = fieldToDoc(f, e), last = lastLine(b), bodyEnd = last.end;
  // The block after the split may now end in text that takes in the line below it: the fusion guard at its end.
  const done = sp => {
    const delta = sp.insert.length - (sp.end - sp.start);
    return guard(doc, sp, [b.end >= sp.end ? b.end + delta : sp.start + sp.insert.length]);
  };
  if (b.kind === "heading" && !b.setext) {
    const right = text.slice(end, bodyEnd), insert = text.slice(bodyEnd, last.eol) + eol + eol + b.containerPrefix + right;
    return done({ start, end: last.eol, insert, caret: start + insert.length - right.length });
  }
  if (b.setext) {
    const t0 = b.start + b.tail.start, t1 = b.start + b.tail.end, tailLine = text.slice(t0, t1).replace(/\r?\n$/, "");
    const right = text.slice(end, last.eol), tailEol = text.slice(t0 + tailLine.length, t1);
    const insert = eol + tailLine + eol + eol + b.containerPrefix + right + tailEol;
    return done({ start, end: t1, insert, caret: start + insert.length - tailEol.length - right.length });
  }
  if (b.kind === "item") {
    const kids = childrenOf(doc, b);
    if (kids.length && kids[0].kind === "item" && !midLine(doc, kids[0])) {
      const c = kids[0], right = text.slice(end, bodyEnd), between = text.slice(bodyEnd, c.start);
      const head = c.containerPrefix + itemMarker(c, sourceNumber(c), Boolean(c.task));
      return done({ start, end: c.start, insert: between + head + right + eol, caret: start + between.length + head.length });
    }
    const insert = eol + b.containerPrefix + itemMarker(b, sourceNumber(b) + 1, Boolean(b.task));
    return done({ start, end, insert, caret: start + insert.length });
  }
  const insert = b.kind === "quote" ? eol + b.contPrefix.replace(/[ \t]+$/, "") + eol + b.contPrefix : eol + eol + b.containerPrefix;
  return done({ start, end, insert, caret: start + insert.length });
}

const BLOCK_MARKER = /^(?: {0,3})(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|>|`{3,}|~{3,}|\||(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$)/;

const LIST_LINE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/;

// What lines put into block b start with: in an item its container prefix, so they become siblings; in a quote or a
// continuation block its own prefix, so they stay inside; at the top level nothing.
const linesPrefix = b => (b.kind === "item" ? b.containerPrefix : b.kind === "quote" || b.depth > 0 ? b.contPrefix : "");

// The fusion guard where lines put into block b meet their neighbours: the first new block, at the line start
// `begin`, keeps b's depth, and the block after them, at `end`, keeps its own. Null when a neighbour still changes
// (a pasted list item that took in an item's sub-blocks), which no blank line undoes.
function guardedLines(doc, b, sp, begin, end) {
  if (!sp) return null;
  const seams = begin >= 0 && b.index > 0 ? [{ at: begin, depth: b.depth }] : [];
  if (end) seams.push(end);
  const out = seams.length ? guard(doc, sp, seams) : sp;
  return out && neighboursKept(doc, out, b) ? out : null;
}
const seamAt = (doc, sp, n) => (n && lineStartAt(doc.text, n.start) ? { at: n.start + (n.start >= sp.end ? sp.insert.length - (sp.end - sp.start) : 0), depth: n.depth } : null);

// Clipboard text goes into the field range [s, e) of b. Lines whose first one starts a block arrive as blocks
// (insertLines); other lines join the text at the caret.
export function paste(doc, b, s, e, clip) {
  const t = String(clip ?? "").replace(/\r\n/g, "\n"), f = field(doc, b);
  if (!isText(b) || !t.includes("\n")) return type(f, f.value.slice(0, s) + t + f.value.slice(e), s);
  const lines = t.split("\n");
  if (opensBlock(lines[0])) return insertLines(doc, b, s, e, lines);
  return pasteLines(doc, b, f.value.slice(0, s) + t + f.value.slice(e), s);
}

export const opensBlock = line => BLOCK_MARKER.test(line);

// Text block b's field set to `value`, its line breaks written as pasted lines are (after a blank line they make
// blocks). `at`: the field offset the paste went in at; `caret`, when given, the field offset the caret goes to.
export function pasteLines(doc, b, value, at, caret) {
  const f = field(doc, b), sp = type(f, value, at, linesPrefix(b));
  if (sp && caret !== undefined) sp.caret = fieldToDoc(f, caret);
  return guardedLines(doc, b, sp, -1, sp && seamAt(doc, sp, doc.blocks[b.index + 1]));
}

// The lines become blocks of their own in place of the field range [s, e) of text block b. With nothing left beside
// the range they replace b, marker included; else b is split there like Enter splits it, the lines between the halves,
// a blank line apart. They never take an item's sub-blocks: with no text after the range they go after them, and they
// do not replace an item that has some (null).
export function insertLines(doc, b, s, e, lines) {
  const f = field(doc, b), text = doc.text, eol = doc.eol, bl = doc.blocks, pp = linesPrefix(b), n = bl[b.index + 1];
  const guarded = (sp, begin, end) => guardedLines(doc, b, sp, begin, end), after = (sp, x) => seamAt(doc, sp, x);
  // An item whose field is empty because its first child sits on the marker line keeps that child: the lines go
  // in as the item's own, and the child moves to its own line below them.
  if (f.childOnMarker) {
    const sp = type(f, lines.join("\n"), 0, b.contPrefix);
    return guarded(sp, -1, n && { at: sp.start + sp.insert.length - b.contPrefix.length, depth: n.depth });
  }
  const joined = lines.map((l, i) => (i ? eol + (l.trim() ? pp : pp.replace(/[ \t]+$/, "")) : "") + l).join("");
  const lineHead = lineStartAt(text, b.start) ? b.start : -1, kids = b.subtreeEnd > b.end;
  // Where b's own source begins: past its container prefix, so a block that keeps its marker keeps its indent too.
  const last = lastLine(b), markerStart = lineHead >= 0 ? b.start + b.containerPrefix.length : b.start + b.markAt;
  const v = f.value;
  while (s > 0 && (v[s - 1] === " " || v[s - 1] === "\t")) s--;
  while (e < v.length && (v[e] === " " || v[e] === "\t")) e++;
  const left = v.slice(0, s).trim(), right = v.slice(e).trim(), first = b.kind === "item" ? b.containerPrefix : pp;
  if (!left && !right && kids) return null;
  if (v === "") {
    const sp = { start: markerStart, end: last.eol, insert: joined, caret: markerStart + joined.length };
    return guarded(sp, lineHead, after(sp, n));
  }
  const pastedItem = LIST_LINE.test(lines[0]), lastItem = LIST_LINE.test(lines.at(-1));
  if (!right && kids) {
    const lastIdx = lastOfSubtree(bl, b.index), P = b.subtreeEnd, cut = fieldToDoc(f, s), next = bl[lastIdx + 1] ?? null;
    const placed = placeAt(doc, P, bl[lastIdx], next, first + joined, b.kind === "item" && pastedItem, closing(doc, bl[lastIdx]));
    const kept = text.slice(last.end, P), offset = cut + kept.length - P;
    const sp = { start: cut, end: P, insert: kept + placed.insert, caret: placed.caret + offset };
    return guarded(sp, sp.caret - first.length - joined.length, after(sp, next));
  }
  const quote = b.kind === "quote", blank = (quote ? b.contPrefix.replace(/[ \t]+$/, "") : "") + eol;
  const sepA = b.kind === "item" && pastedItem ? "" : blank, sepB = b.kind === "item" && lastItem ? "" : blank;
  const at = fieldToDoc(f, s), to = fieldToDoc(f, e);
  if (quote) {
    const head = left ? eol + sepA + first : "", insert = head + joined + (right ? eol + sepB + first : "");
    const sp = { start: at, end: right ? to : last.end, insert, caret: at + head.length + joined.length };
    return guarded(sp, -1, after(sp, n));
  }
  // A heading's closing run or setext underline stays with its left half, so the splice runs to the end of it.
  const tailLine = b.setext ? text.slice(b.start + b.tail.start, b.start + b.tail.end).replace(/\r?\n$/, "") : "";
  const close = b.setext ? eol + tailLine : b.suffix ? text.slice(last.end, last.eol) : "";
  const cut = b.setext ? b.start + b.tail.start + tailLine.length : b.suffix ? last.eol : last.end;
  if (!left) {
    // b keeps its marker and the text after the range; with none left, the lines replace all of b.
    const own = text.slice(markerStart, fieldToDoc(f, 0));
    const insert = joined + (right ? eol + sepB + b.containerPrefix + own : "");
    const sp = { start: markerStart, end: right ? to : cut, insert, caret: markerStart + joined.length };
    return guarded(sp, lineHead, after(sp, n));
  }
  const rightHead = b.kind === "item" ? b.containerPrefix + itemMarker(b, sourceNumber(b) + 1, Boolean(b.task)) : b.containerPrefix;
  const head = close + eol + sepA + first, rest = right ? eol + sepB + rightHead + text.slice(to, last.end) : "";
  const sp = { start: at, end: cut, insert: head + joined + rest, caret: at + head.length + joined.length };
  return guarded(sp, at + head.length - first.length, after(sp, n));
}

function rewriteLines(text, from, to, fn) {
  let out = "";
  for (let p = from; p < to;) {
    const nl = text.indexOf("\n", p), next = nl < 0 || nl >= to ? to : nl + 1, line = text.slice(p, next);
    out += BLANK.test(line.replace(/\r?\n$/, "")) ? line : fn(line, p);
    p = next;
  }
  return out;
}
function removeColumns(line, w) {
  let c = 0, i = 0;
  while (i < line.length && c < w) {
    const k = line.charCodeAt(i);
    if (k === SP) { c++; i++; } else if (k === TAB) {
      const n = c + 4 - (c % 4);
      if (n > w) return " ".repeat(n - w) + line.slice(i + 1);
      c = n;
      i++;
    } else break;
  }
  return line.slice(i);
}
const usesTabs = (text, b) => /(?:^|\n)[ ]*\t/.test(text.slice(b.start, b.subtreeEnd));
// A rewritten run of lines may now continue the block above it or below it: the fusion guard at both ends.
const rewritten = (doc, s, lead = 0) => guard(doc, s, [s.start + lead, s.start + s.insert.length]);

export function indent(doc, b) {
  if (b.kind !== "item" || midLine(doc, b)) return null;
  const sib = prevSibling(doc, b);
  if (!sib || sib.kind !== "item") return null;
  const text = doc.text, w = sib.contentCol - sib.markerCol, unit = usesTabs(text, sib) ? "\t" : " ".repeat(w);
  const lastKid = childrenOf(doc, sib).at(-1), joins = lastKid && lastKid.kind === "item" ? lastKid : null;
  const marker = joins ? (joins.ordered ? `${sourceNumber(joins) + 1}${joins.delim}` : joins.bullet) : b.ordered ? `1${b.delim}` : b.marker;
  let out = rewriteLines(text, b.start, b.subtreeEnd, line => unit + line);
  const m = unit.length + b.markAt;
  out = out.slice(0, m) + marker + out.slice(m + b.marker.length);
  return rewritten(doc, { start: b.start, end: b.subtreeEnd, insert: out, caret: b.start + b.lines[0].body + unit.length + marker.length - b.marker.length });
}

export function outdent(doc, b) {
  if (b.kind !== "item" || b.parent < 0 || midLine(doc, b)) return null;
  const p = doc.blocks[b.parent];
  if (p.kind !== "item") return null;
  const text = doc.text, w = b.markerCol - p.markerCol;
  const out = rewriteLines(text, b.start, b.subtreeEnd, line => removeColumns(line, w));
  const first = text.slice(b.start, b.start + b.lines[0].body), firstOut = removeColumns(first, w);
  return rewritten(doc, { start: b.start, end: b.subtreeEnd, insert: out, caret: b.start + firstOut.length });
}

export function nest(doc, b) {
  if (!["paragraph", "code", "mermaid"].includes(b.kind) || midLine(doc, b)) return null;
  const sib = prevSibling(doc, b);
  if (!sib || sib.kind !== "item") return null;
  const text = doc.text, w = sib.contentCol - columnsOf(b.containerPrefix);
  const blankBefore = b.start === 0 || BLANK.test(text.slice(text.lastIndexOf("\n", b.start - 2) + 1, b.start - 1).replace(/\r$/, ""));
  const pre = blankBefore ? "" : doc.eol;
  const out = pre + rewriteLines(text, b.start, b.end, line => " ".repeat(w) + line);
  return rewritten(doc, { start: b.start, end: b.end, insert: out, caret: b.start + pre.length + w + b.lines[0].body }, pre.length);
}

// Only the item's last child moves out: blocks after it would end the item at their old indent and change meaning.
export function unnest(doc, b) {
  if (b.kind === "item" || b.parent < 0 || midLine(doc, b)) return null;
  const p = doc.blocks[b.parent];
  if (p.kind !== "item" || nextSibling(doc, b)) return null;
  const text = doc.text, w = p.contentCol - (p.parent >= 0 ? doc.blocks[p.parent].contentCol : 0);
  const out = rewriteLines(text, b.start, b.end, line => removeColumns(line, w));
  const first = text.slice(b.start, b.start + b.lines[0].body);
  return rewritten(doc, { start: b.start, end: b.end, insert: out, caret: b.start + removeColumns(first, w).length });
}

// b's subtree swaps with the previous (dir < 0) or next sibling's subtree, each with its gap. `unitOf(x)` gives the run
// of siblings [first, last] that moves as one with x.
export function move(doc, b, dir, unitOf = x => [x, x]) {
  const [b0, b1] = unitOf(b);
  if (midLine(doc, b0)) return null;
  const near = dir < 0 ? prevSibling(doc, b0) : nextSibling(doc, b1), [o0, o1] = near ? unitOf(near) : [null, null];
  if (!near || midLine(doc, o0) || (o0.index <= b1.index && o1.index >= b0.index)) return null;
  const bl = doc.blocks, text = doc.text, eol = doc.eol;
  const [A, A1, B, B1] = dir < 0 ? [o0, o1, b0, b1] : [b0, b1, o0, o1];
  const gapEndOf = x => bl[lastOfSubtree(bl, x.index)].gapEnd;
  const a = text.slice(A.start, A1.subtreeEnd), ag = text.slice(A1.subtreeEnd, gapEndOf(A1));
  const bb = text.slice(B.start, B1.subtreeEnd), bg = text.slice(B1.subtreeEnd, gapEndOf(B1)), end = gapEndOf(B1);
  let lead, rest;
  if (!bb.endsWith("\n")) {
    // B ends the file without an EOL of its own: B takes the EOL it lacked, A gives its own up, A's gap stays between.
    lead = bb + eol + ag;
    rest = a.replace(/\r?\n$/, "");
  } else if (end === text.length && bg && !bg.endsWith("\n")) {
    // A blank line without an EOL ends the file: it stays last, after A.
    lead = bb + ag;
    rest = a + bg;
  } else {
    lead = bb + bg;
    rest = a + ag;
  }
  const insert = lead + rest;
  const moved = b0 === A ? A.start + lead.length : A.start;
  const s = { start: A.start, end, insert, caret: moved + b.start - b0.start + b.lines[0].body };
  const seams = [{ at: A.start, depth: B.depth }, { at: A.start + lead.length, depth: A.depth }];
  return guard(doc, s, [...seams, seamBefore(doc, B1.index, A.start + insert.length)]);
}

export function toggleTask(doc, b) {
  if (!b.task) return null;
  const text = doc.text, o = b.task.offset, c = text[o];
  if (text[o - 1] !== "[" || text[o + 1] !== "]" || (c !== " " && c !== "x" && c !== "X")) return null;
  return { start: o, end: o + 1, insert: c === " " ? "x" : " ", caret: o + 1 };
}

export function closeFence(doc, b) {
  const last = lastLine(b), hasEol = last.next > last.eol;
  const insert = hasEol ? b.containerPrefix + b.fence + doc.eol : doc.eol + b.containerPrefix + b.fence;
  return { start: b.end, end: b.end, insert, caret: b.end };
}

// Code block or diagram b tagged with language `id`: it takes the place of the info string's first word, the rest
// kept, and "" (Plain text) removes the whole info string. An indented block gets fences (fencedCode). Null when
// nothing would change.
export function setLanguage(doc, b, id) {
  if (!b.fence) return id ? fencedCode(doc, b, id) : null;
  const line = absLine(b, 0), open = fenceRun(doc.text, line.body).end, info = doc.text.slice(open, line.eol);
  if (!id) return b.info ? { start: open, end: line.eol, insert: "", caret: open } : null;
  const lead = /^[ \t]*/.exec(info)[0].length, word = /^\S*/.exec(info.slice(lead))[0];
  if (word === id) return null;
  const start = word ? open + lead : open;
  return { start, end: start + word.length, insert: id, caret: start };
}

// Indented code block b fenced and tagged `id`: the lines its field shows, each under its container prefix, between
// fences of backticks longer than any line of backticks in the code.
function fencedCode(doc, b, id) {
  const f = codeFieldOf(doc.text, b, doc.eol), lines = f.value.split("\n"), prefix = b.containerPrefix;
  const longest = Math.max(0, ...lines.map(l => (closes(l, "```") ? CLOSE.exec(l)[1].length : 0)));
  const fence = "`".repeat(Math.max(3, longest + 1)), blankLine = prefix.replace(/[ \t]+$/, "");
  const start = b.start + b.lines[0].body, end = fieldToDoc(f, f.value.length);
  const insert = [fence + id, ...lines.map(l => (l ? prefix + l : blankLine)), prefix + fence].join(doc.eol);
  return { start, end, insert, caret: start };
}
