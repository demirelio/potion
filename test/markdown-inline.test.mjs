import test from "node:test";
import assert from "node:assert/strict";
import { graphemeEnd, parseInline, visibleMap } from "../mods/herdr-inline-markdown/inline.js";
import { parse, field, isText } from "../mods/herdr-inline-markdown/blocks.js";
import { commentsIn } from "../mods/herdr-inline-markdown/comments.js";
import { commonmark, gfm, docs, originals } from "./markdown-corpus.mjs";

const label = (spans, s) => {
  if (s.kind === "link" || s.kind === "image") return `${s.kind}:${s.url}`;
  return s.kind === "html" ? `<${s.tag}>` : s.kind;
};

// The value as it shows: plain text as it is, each run of characters with the same formatting as {kinds|text}, the
// kinds outermost first and a link's or an image's address after a colon.
function look(value, opts) {
  const { spans, chars } = parseInline(value, opts);
  let out = "", kinds = "", text = "";
  const flush = () => { out += kinds ? `{${kinds}|${text}}` : text; text = ""; };
  for (const c of chars) {
    const k = c.spans.map(id => label(spans, spans[id])).join(">");
    if (k !== kinds) { flush(); kinds = k; }
    text += c.text;
  }
  flush();
  return out;
}

// The runs of the value that no character shows.
function hidden(value, opts) {
  const shown = new Array(value.length).fill(false);
  for (const c of parseInline(value, opts).chars) for (let k = c.start; k < c.end; k++) shown[k] = true;
  const out = [];
  for (let k = 0; k < value.length; k++) {
    if (shown[k]) continue;
    if (k > 0 && !shown[k - 1] && out.length) out[out.length - 1] += value[k];
    else out.push(value[k]);
  }
  return out;
}

const spanOf = (value, kind, opts) => parseInline(value, opts).spans.find(s => s.kind === kind);

// The contract's invariants: characters in order; every offset in exactly one character or in exactly one span's marks
// ([start, from) and [to, end)); each character lists exactly the spans around it, outermost first; ids in order.
function assertModel(value, r, name = value) {
  const owners = new Array(value.length).fill(0);
  let last = 0;
  for (const c of r.chars) {
    assert.ok(c.start >= last && c.end > c.start, `${name}: character ${JSON.stringify(c)} out of order`);
    assert.ok(c.text.length > 0, `${name}: empty character`);
    for (let k = c.start; k < c.end; k++) owners[k]++;
    last = c.end;
  }
  r.spans.forEach((s, i) => {
    assert.equal(s.id, i, `${name}: ids are positions`);
    assert.ok(s.start <= s.from && s.from <= s.to && s.to <= s.end, `${name}: span ${JSON.stringify(s)}`);
    if (i > 0) assert.ok(r.spans[i - 1].start <= s.start, `${name}: spans in source order`);
    for (let k = s.start; k < s.from; k++) owners[k]++;
    for (let k = s.to; k < s.end; k++) owners[k]++;
  });
  const wrong = owners.findIndex(n => n !== 1);
  assert.equal(wrong, -1, `${name}: offset ${wrong} (${JSON.stringify(value[wrong])}) is in ${owners[wrong]} characters or marks`);
  for (const c of r.chars) {
    const around = r.spans.filter(s => s.from <= c.start && c.end <= s.to && s.from < s.to).map(s => s.id);
    assert.deepEqual(c.spans, around, `${name}: the spans around ${JSON.stringify(c)}`);
  }
  const fromRuns = r.runs.flatMap(run => {
    if (!run.verbatim) return [{ start: run.start, end: run.end, text: run.text, spans: run.spans }];
    assert.equal(run.text, value.slice(run.start, run.end), `${name}: a verbatim run shows its source`);
    const out = [];
    for (let i = run.start; i < run.end; i = graphemeEnd(value, i, run.end)) out.push({ start: i, end: graphemeEnd(value, i, run.end), text: value.slice(i, graphemeEnd(value, i, run.end)), spans: run.spans });
    return out;
  });
  assert.deepEqual(fromRuns, r.chars, `${name}: the runs hold exactly the characters`);
}

test("an empty value shows nothing", () => {
  for (const v of ["", undefined]) {
    const r = parseInline(v);
    assert.deepEqual([r.spans, r.runs, r.chars], [[], [], []]);
  }
});

test("runs: verbatim stretches with the same spans, and single characters that differ from their source", () => {
  const v = "a **b** \\* &amp; `c\nd` é";
  const runs = parseInline(v).runs.map(({ start, end, text, verbatim, spans }) => [v.slice(start, end), text, verbatim, spans.length]);
  assert.deepEqual(runs, [
    ["a ", "a ", true, 0], ["b", "b", true, 1], [" ", " ", true, 0], ["\\*", "*", false, 0], [" ", " ", true, 0],
    ["&amp;", "&", false, 0], [" ", " ", true, 0], ["c", "c", true, 1], ["\n", " ", false, 1], ["d", "d", true, 1],
    [" é", " é", true, 0],
  ]);
  assert.equal(graphemeEnd(v, v.indexOf("é")), v.length, "a letter with its combining mark is one character");
  assert.equal(graphemeEnd("ab", 0), 1);
  const r = parseInline("x *y*");
  assert.equal(r.chars, r.chars, "the characters are built once");
  assert.equal(r.chars[2].spans, r.runs[1].spans, "a run and its characters share one spans array");
});

test("strong, emphasis and strikethrough show their text, their marks hidden", () => {
  const v = "a **b** _c_ ~~d~~ ~e~ *f* __g__";
  assert.equal(look(v), "a {strong|b} {em|c} {strike|d} {strike|e} {em|f} {strong|g}");
  assert.deepEqual(hidden(v), ["**", "**", "_", "_", "~~", "~~", "~", "~", "*", "*", "__", "__"]);
  const s = spanOf("a **b** c", "strong");
  assert.deepEqual([s.start, s.from, s.to, s.end], [2, 4, 5, 7]);
  assert.equal(look("a * b * c ~~~d~~~ ~~e~"), "a * b * c ~~~d~~~ ~~e~", "no flanking, three tildes, unequal tildes");
  assert.equal(look("snake_case_name and 2*3*4"), "snake_case_name and 2{em|3}4", "an underscore inside a word is no mark");
});

test("nesting: strong in emphasis, emphasis in a link, a code span in emphasis", () => {
  assert.equal(look("***a***"), "{em>strong|a}");
  assert.deepEqual(hidden("***a***"), ["***", "***"]);
  assert.equal(look("[a *b*](u)"), "{link:u|a }{link:u>em|b}");
  assert.equal(look("*a `b` c*"), "{em|a }{em>code|b}{em| c}");
  assert.equal(look("**a *b* c**"), "{strong|a }{strong>em|b}{strong| c}");
  assert.equal(look("~~a **b**~~"), "{strike|a }{strike>strong|b}");
  assert.equal(look("*a **b***"), "{em|a }{em>strong|b}");
});

test("a code span shows its content, the backticks and one space of padding on each side hidden", () => {
  assert.equal(look("`` a`b ``"), "{code|a`b}");
  assert.deepEqual(hidden("`` a`b ``"), ["`` ", " ``"]);
  assert.equal(look("` `"), "{code| }", "only spaces: nothing taken off");
  assert.equal(look("`a"), "`a", "no closing run: the backtick shows");
  assert.equal(look("`*a*`"), "{code|*a*}", "no emphasis inside");
  const s = spanOf("x `y` z", "code");
  assert.deepEqual([s.start, s.from, s.to, s.end], [2, 3, 4, 5]);
});

test("an escape is one character over its backslash and the character it shows", () => {
  const v = "\\*a\\* \\q \\\\";
  assert.equal(look(v), "*a* \\q \\");
  const { chars } = parseInline(v);
  assert.deepEqual(chars[0], { start: 0, end: 2, text: "*", spans: [] });
  assert.deepEqual(chars.at(-1), { start: v.length - 2, end: v.length, text: "\\", spans: [] });
  assert.deepEqual(hidden(v), []);
});

test("an entity is one character over its whole reference", () => {
  const v = "&amp; &copy; &#35; &#x22; &#0; &bogus; &amp &nbsp;";
  assert.equal(look(v), "& © # \" � &bogus; &amp  ");
  assert.deepEqual(parseInline(v).chars[0], { start: 0, end: 5, text: "&", spans: [] });
});

test("an inline link: its text shows, the brackets and the destination hidden; address and title decoded", () => {
  const v = '[a](/u\\*v "t &amp; x") and [b](<c d>) [e]() [f](g';
  assert.equal(look(v), "{link:/u*v|a} and {link:c d|b} {link:|e} [f](g");
  assert.deepEqual(hidden(v).slice(0, 2), ["[", '](/u\\*v "t &amp; x")']);
  const s = spanOf(v, "link");
  assert.deepEqual([s.start, s.from, s.to, s.end, s.title], [0, 1, 2, v.indexOf(" and"), "t & x"]);
  assert.equal(spanOf("[a](u)", "link").title, null, "no title");
  assert.equal(look(`[a](${"(".repeat(32)}${")".repeat(32)})`), `{link:${"(".repeat(32)}${")".repeat(32)}|a}`);
  assert.equal(look(`[a](${"(".repeat(33)}${")".repeat(33)})`), `[a](${"(".repeat(33)}${")".repeat(33)})`, "markdown-rs's limit: 32 open parentheses");
});

test("reference links take their address from the document's definitions", () => {
  const doc = parse("[a][x], [x], [x][] and [y]\n\n[x]: /url 'T'\n");
  const value = field(doc, doc.blocks[0]).value;
  assert.equal(look(value, { defs: doc.defs }), "{link:/url|a}, {link:/url|x}, {link:/url|x} and [y]");
  assert.equal(spanOf(value, "link", { defs: doc.defs }).title, "T");
  assert.deepEqual(hidden(value, { defs: doc.defs }), ["[", "][x]", "[", "]", "[", "][]"]);
  assert.equal(look(value), "[a][x], [x], [x][] and [y]", "without definitions: as typed");
  const folded = parse("[ẞ]\n\n[SS]: /s\n");
  assert.equal(look(field(folded, folded.blocks[0]).value, { defs: folded.defs }), "{link:/s|ẞ}", "labels match case-folded");
});

test("autolinks: the brackets hidden, an e-mail address as a mailto link", () => {
  const v = "<http://a.b/c> and <me@x.org>";
  assert.equal(look(v), "{link:http://a.b/c|http://a.b/c} and {link:mailto:me@x.org|me@x.org}");
  assert.deepEqual(hidden(v), ["<", ">", "<", ">"]);
});

test("bare web and e-mail addresses are links, trailing punctuation outside them", () => {
  const v = "see www.x.org. and https://y.io/p?q=(1), mail me@x.org.";
  assert.equal(look(v), "see {link:http://www.x.org|www.x.org}. and {link:https://y.io/p?q=(1)|https://y.io/p?q=(1)}, mail {link:mailto:me@x.org|me@x.org}.");
  assert.deepEqual(hidden(v), []);
  assert.equal(look("*www.a.com*"), "{em>link:http://www.a.com|www.a.com}");
  assert.equal(look("www.a.com/x_y_z"), "{link:http://www.a.com/x_y_z|www.a.com/x_y_z}", "underscores in the path stay in it");
  assert.equal(look("[www.a.com](u)"), "{link:u|www.a.com}", "no link inside a link");
  assert.equal(look("xhttp://a.com and awww.b.com"), "xhttp://a.com and awww.b.com");
});

test("an image shows its alt text, its marks hidden", () => {
  const v = '![a *b*](/i.png "t") x';
  const s = spanOf(v, "image");
  assert.deepEqual([s.url, s.title, s.alt], ["/i.png", "t", "a b"]);
  assert.equal(look(v), "{image:/i.png|a }{image:/i.png>em|b} x");
  assert.deepEqual(hidden(v), ["![", "*", '*](/i.png "t")']);
});

test("CriticMarkup: a comment, a point comment and a highlight, as comments.js finds them", () => {
  const v = "a {==b==}{>>n1<<} c{>>n2<<}d {==e==}";
  assert.equal(look(v), "a {comment|b} cd {highlight|e}");
  assert.deepEqual(hidden(v), ["{==", "==}{>>n1<<}", "{>>n2<<}", "{==", "==}"]);
  const ours = parseInline(v).spans.map(({ kind, start, end, from, to, note }) => ({ kind, start, end, from, to, note }));
  assert.deepEqual(ours, commentsIn(v).map(({ kind, start, end, from, to, note }) => ({ kind, start, end, from, to, note })));
  const point = spanOf(v, "point");
  assert.equal(point.from, point.to, "a point comment shows nothing");
  assert.equal(look("{==**a**==}{>>n<<}"), "{comment>strong|a}");
  assert.equal(look("`{==x==}` y"), "{code|{==x==}} y", "a code span holds no comment");
  assert.deepEqual(parseInline("`{==x==}`").spans.map(s => s.kind), ["code"]);
});

test("hard line breaks: the backslash or the spaces hidden, the line break shows", () => {
  assert.equal(look("a\\\nb"), "a{break|\n}b");
  assert.deepEqual(hidden("a\\\nb"), ["\\"]);
  const s = spanOf("a\\\nb", "break");
  assert.deepEqual([s.start, s.from, s.to, s.end], [1, 2, 3, 3]);
  assert.deepEqual(hidden("a  \nb"), ["  "]);
  assert.deepEqual(hidden("a\nb"), [], "the field's form of a hard break: the line break alone");
  assert.deepEqual(hidden("a\\\n  b"), ["\\", "  "], "spaces opening the next line are not drawn");
  assert.equal(look("a\\"), "a\\", "a backslash at the end shows");
  const crlf = parseInline("a\r\nb").chars;
  assert.deepEqual(crlf[1], { start: 1, end: 3, text: "\n", spans: [0] }, "CRLF is one character");
  assert.equal(look("*a\\\nb*"), "{em|a}{em>break|\n}{em|b}");
});

test("inline tags: the styled ones drawn with their style, every tag hidden", () => {
  const v = '<u>a</u> <mark color="#f5c54255">b</mark> <span>c</span> <b>d</b> <!-- x --> <s>e';
  assert.equal(look(v), "{<u>|a} {<mark>|b} c {<b>|d}  e");
  assert.deepEqual(hidden(v), ["<u>", "</u>", '<mark color="#f5c54255">', "</mark>", "<span>", "</span>", "<b>", "</b>", "<!-- x -->", "<s>"]);
  assert.equal(spanOf(v, "html").tag, "u");
  assert.equal(parseInline(v).spans.find(s => s.tag === "mark").color, "#f5c54255");
  assert.equal(spanOf("<mark>x</mark>", "html").color, "#fef08a", "Reading's default");
  assert.equal(spanOf('<mark style="background-color: yellow">x</mark>', "html").color, "#facc15");
  for (const tag of ["strong", "em", "i", "del", "strike"]) assert.equal(look(`<${tag}>x</${tag}>`), `{<${tag}>|x}`);
  assert.equal(look("<b>a <i>b</i></b>"), "{<b>|a }{<b>><i>|b}");
  assert.equal(look("<u>*a</u>*"), "{em|a}", "a tag closing inside emphasis it did not open in pairs with nothing");
  assert.equal(look("<b a=x/>y</b> <B>z</b>"), "y {<b>|z}", "a tag ending in /> pairs with nothing; names in any case");
  assert.equal(look("a<br>b<br/>c"), "a{break|\n}b{break|\n}c");
  assert.deepEqual(parseInline("a<br>b").chars[1], { start: 1, end: 5, text: "\n", spans: [0] });
  const img = '<img src="p.png" alt="x &amp; y"> z';
  assert.equal(look(img), "{image:p.png|x & y} z");
  assert.equal(spanOf(img, "image").alt, "x & y");
  assert.equal(look("<img alt=a> b"), " b", "no source: no picture");
});

test("characters are graphemes: combining marks, emoji with modifiers and joiners, flags, keycaps, Hangul", () => {
  const parts = ["é", "x", "👍🏽", "x", "👨‍👩‍👧", "x", "🇹🇷", "🇺🇸", "x", "❤️", "x", "1️⃣", "x", "한", "x", "가", "x", "🏳️‍🌈", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"];
  assert.deepEqual(parseInline(parts.join("")).chars.map(c => c.text), parts);
  assert.deepEqual(parseInline("**é**").chars.map(c => c.text), ["é"]);
});

test("the grapheme splitting agrees with Intl.Segmenter on the common cases", () => {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const samples = [
    "Café crème", "é̂a", "مَرْحَبًا", "กำลัง", "한국어 각", "👩🏽‍💻 🧑‍🤝‍🧑 👨‍❤️‍👨", "🇯🇵🇩🇪🇫", "#️⃣*️⃣",
    "a‍b", "­​", "Ω≈ç√∫", "🏴󠁧󠁢󠁥󠁮󠁧󠁿 ☺️ ✌🏿", "日本語のテキスト", "Zalgo z̶̵a̷",
  ];
  for (const s of samples) assert.deepEqual(parseInline(s).chars.map(c => c.text), [...segmenter.segment(s)].map(x => x.segment), s);
});

// A spec example's expected HTML paragraph content, as the text that shows and each character's formatting.
const TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[^"'=<>`\x00-\x20]+|'[^']*'|"[^"]*"))?)*)\s*\/?>|<!---?>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const HTML_ENTITY = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot));/y;
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"' };
const decodeHtml = s => s.replace(new RegExp(HTML_ENTITY.source, "g"), (_, hex, dec, name) => (name ? NAMED[name] : String.fromCodePoint(Number.parseInt(hex ?? dec, hex ? 16 : 10))));
const attr = (attrs, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(attrs);
  return m ? decodeHtml(m[1] ?? m[2] ?? m[3]) : null;
};
const STYLE = { strong: "strong", b: "strong", em: "em", i: "em", del: "del", s: "del", strike: "del", code: "code" };

function expected(html) {
  const out = [], stack = [];
  let i = 0, afterBreak = false;
  const push = (text, extra) => { for (const ch of text) out.push([ch, [...stack, ...(extra ?? [])].join(">")]); };
  while (i < html.length) {
    if (html[i] === "<") {
      TAG.lastIndex = i;
      const m = TAG.exec(html);
      if (m) {
        i = TAG.lastIndex;
        const name = m[1]?.toLowerCase(), closing = m[0][1] === "/";
        if (name === "br") { push("\n"); afterBreak = true; continue; }
        if (name === "img" && !closing) push(attr(m[2], "alt") ?? "", [`img(${attr(m[2], "src")})`]);
        const style = name === "a" ? (closing || attr(m[2], "href") !== null ? "a" : null) : STYLE[name];
        if (!style) continue;
        if (!closing) stack.push(style === "a" ? `a(${attr(m[2], "href")})` : style);
        else {
          const at = stack.findLastIndex(s => s === style || s.startsWith(`${style}(`));
          if (at >= 0) stack.splice(at, 1);
        }
        continue;
      }
    }
    if (html[i] === "&") {
      HTML_ENTITY.lastIndex = i;
      const m = HTML_ENTITY.exec(html);
      if (m) { push(decodeHtml(m[0])); i = HTML_ENTITY.lastIndex; afterBreak = false; continue; }
    }
    const ch = String.fromCodePoint(html.codePointAt(i));
    if (ch === "\n" && afterBreak) afterBreak = false;
    else { push(ch === "\n" ? " " : ch); afterBreak = false; }
    i += ch.length;
  }
  return out;
}

// CommonMark's percent-encoding of an address, as the spec's HTML writes it.
const KEEP = /[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/;
function normalizeUri(uri) {
  let out = "";
  for (let i = 0; i < uri.length;) {
    if (uri[i] === "%" && /^[0-9a-fA-F]{2}$/.test(uri.slice(i + 1, i + 3))) { out += uri.slice(i, i + 3); i += 3; continue; }
    const ch = String.fromCodePoint(uri.codePointAt(i));
    out += KEEP.test(ch) ? ch : encodeURIComponent(ch);
    i += ch.length;
  }
  return out;
}

const SPEC_STYLE = { strong: "strong", em: "em", strike: "del", code: "code" };
// The field keeps the spaces that end a paragraph, which CommonMark strips.
function ours(value, r) {
  const out = [], kept = value.replace(/[ \t]+$/, "").length;
  for (const c of r.chars.filter(ch => ch.start < kept)) {
    const fmt = [];
    for (const id of c.spans) {
      const s = r.spans[id];
      if (s.kind === "image") { fmt.push(`img(${normalizeUri(s.url)})`); break; }
      if (s.kind === "link") fmt.push(`a(${normalizeUri(s.url)})`);
      else if (s.kind === "html" && STYLE[s.tag] && STYLE[s.tag] !== "code") fmt.push(STYLE[s.tag]);
      else if (SPEC_STYLE[s.kind]) fmt.push(SPEC_STYLE[s.kind]);
    }
    for (const ch of c.text) out.push([ch, fmt.join(">")]);
  }
  return out;
}

const picture = runs => runs.map(([ch, fmt], i) => (i === 0 || runs[i - 1][1] !== fmt ? `⟦${fmt}⟧` : "") + ch).join("");

const INLINE_SECTIONS = new Set([
  "Backslash escapes", "Entity and numeric character references", "Code spans", "Emphasis and strong emphasis", "Links",
  "Images", "Autolinks", "Raw HTML", "Hard line breaks", "Soft line breaks", "Textual content",
  "Strikethrough (extension)", "Autolinks (extension)", "Strikethroughs",
]);

// Inline examples left out of the oracle, each with why.
const FIELD_SPACES = "the field drops the spaces that end a source line (blocks.js), which a code span over that line keeps";
const NO_GFM = "Reading reads GFM, whose autolink literals the CommonMark spec does not have";
const LEFT_OUT = new Map([
  ["commonmark #25", "entities outside HTML 4 (&Dcaron;, &HilbertSpace; ...): the mod's table is HTML 4's"],
  ["commonmark #335", FIELD_SPACES],
  ["commonmark #336", FIELD_SPACES],
  ["commonmark #337", FIELD_SPACES],
  ["commonmark #640", FIELD_SPACES],
  ["commonmark #344", "a raw <a href> tag: Reading draws a lone tag as nothing, so no link"],
  ["commonmark #491", "the field shows a soft line break as a space, which a <destination> may hold"],
  ["commonmark #494", "a raw <b> with no </b>: the spec's HTML leaves it open, Reading draws nothing"],
  ["commonmark #602", NO_GFM],
  ["commonmark #608", NO_GFM],
  ["commonmark #611", NO_GFM],
  ["commonmark #612", NO_GFM],
  ["gfm #20", "markdown-rs links http(s):// and www. literals, not ftp://"],
  ["gfm #43", "markdown-rs starts no e-mail literal right after a slash (scyther@pokemon.com/beedrill@pokemon.com)"],
]);

// Every example of the inline sections whose blocks are all paragraphs (definitions aside): its paragraphs, each with
// the field value the editor holds and the expected <p> content.
function oracleCases() {
  const cases = [];
  const examples = [
    ...commonmark.map(e => ({ ...e, name: `commonmark #${e.example}` })),
    ...gfm.map(e => ({ ...e, name: `gfm #${e.example}` })),
  ].filter(e => INLINE_SECTIONS.has(e.section));
  for (const e of examples) {
    const doc = parse(e.markdown), blocks = doc.blocks.filter(b => b.kind !== "definition");
    const paras = [...e.html.matchAll(/<p>([\s\S]*?)<\/p>\n/g)];
    if (!blocks.length || !blocks.every(b => b.kind === "paragraph" && b.depth === 0) || paras.length !== blocks.length) continue;
    if (paras.map(m => m[0]).join("") !== e.html) continue;
    cases.push({ name: e.name, paragraphs: blocks.map((b, i) => ({ value: field(doc, b).value, html: paras[i][1], defs: doc.defs })) });
  }
  return cases;
}

test("the spec oracle: every inline example made of paragraphs shows the text and formatting of its HTML", t => {
  const cases = oracleCases(), failed = [];
  let passed = 0;
  for (const c of cases) {
    let ok = true, why = "";
    for (const p of c.paragraphs) {
      const r = parseInline(p.value, { defs: p.defs });
      assertModel(p.value, r, c.name);
      const got = picture(ours(p.value, r)), want = picture(expected(p.html));
      if (got !== want) { ok = false; why = `${JSON.stringify(p.value)}\n  got  ${got}\n  want ${want}`; }
    }
    if (LEFT_OUT.has(c.name)) {
      assert.ok(!ok, `${c.name} passes now: take it off the left-out list`);
      continue;
    }
    if (ok) passed++;
    else failed.push(`${c.name}: ${why}`);
  }
  const single = cases.filter(c => c.paragraphs.length === 1 && !LEFT_OUT.has(c.name)).length;
  t.diagnostic(`${cases.length} examples (${single} of one paragraph pass), ${passed} pass, ${LEFT_OUT.size} left out`);
  assert.deepEqual(failed, []);
  for (const name of LEFT_OUT.keys()) assert.ok(cases.some(c => c.name === name), `${name} is not an oracle example`);
});

test("every text block of the spec examples and the corpus documents reads to a model that covers each offset once", () => {
  for (const o of originals()) {
    const doc = parse(o.text);
    for (const b of doc.blocks.filter(isText)) {
      const value = field(doc, b).value;
      assertModel(value, parseInline(value, { defs: doc.defs }), `${o.name} block ${b.index}`);
    }
  }
  assert.ok(docs.length > 0);
});

test("comment spans are the comments comments.js finds, wherever they sit", () => {
  const values = [
    "{==a **b==}{>>n<<} c**", "*a {==b* c==}{>>n<<}", "[a {==b](u)==}{>>n<<}", "x{>>p<<}`y` {==z==}",
    "{==a==}{>>one<<}{==b==}{>>two<<}", "<span title=\"{==x==}\">", "a\\{==b==}", "{==`a`==}{>>n<<}",
  ];
  for (const v of values) {
    const r = parseInline(v);
    assertModel(v, r);
    const mine = r.spans.filter(s => ["comment", "point", "highlight"].includes(s.kind)).map(({ kind, start, end, from, to, note }) => ({ kind, start, end, from, to, note }));
    assert.deepEqual(mine, commentsIn(v).map(({ kind, start, end, from, to, note }) => ({ kind, start, end, from, to, note })), v);
  }
});

test("visibleMap maps what Reading shows to value offsets: an escape at its character, a point comment as its marker", () => {
  const v = "a **b** \\* {==c==}{>>n<<} d{>>p<<}e 👍🏽";
  const map = visibleMap(v);
  assert.equal(map.length, 13 + 1, "a b * c d, the point comment, e, the emoji: 13 characters");
  assert.equal(v[map[4]], "*");
  assert.equal(map[9], v.indexOf("{>>p"));
  assert.equal(map[12], v.indexOf("👍"));
  assert.equal(map.at(-1), v.length);
});
