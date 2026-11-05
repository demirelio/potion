// The markdown corpus of the block-model tests: the CommonMark 0.31.2 and GFM spec examples, this repo's own
// documents, and generated variants of each.
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("./fixtures/markdown/", import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

export const commonmark = json("commonmark-0.31.2.json");
export const gfm = json("gfm-0.29.json");
export const docs = readdirSync(new URL("docs/", dir)).sort().map(name => ({ name, text: readFileSync(new URL(`docs/${name}`, dir), "utf8") }));

export const VARIANTS = {
  crlf: t => t.replace(/\r?\n/g, "\r\n"),
  noFinalNewline: t => t.replace(/\r?\n$/, ""),
  bom: t => `﻿${t}`,
  tabs: t => t.replace(/^((?: {4})+)/gm, m => "\t".repeat(m.length / 4)),
  emptyMarkersTrimmed: t => t.replace(/^([ \t]*(?:[-*+]|\d{1,9}[.)]))[ \t]+$/gm, "$1"),
  crcrlf: t => t.replace(/\r?\n/g, "\r\r\n"),
};

// Every original as { name, text, example? }.
export function originals() {
  return [
    ...commonmark.map(e => ({ name: `commonmark #${e.example} (${e.section})`, text: e.markdown, example: e, spec: "commonmark" })),
    ...gfm.map(e => ({ name: `gfm #${e.example} (${e.section})`, text: e.markdown, example: e, spec: "gfm" })),
    ...docs.map(d => ({ name: d.name, text: d.text })),
  ];
}

// Every original and every variant of it that differs from it.
export function corpus() {
  const out = [];
  for (const o of originals()) {
    out.push(o);
    for (const [v, make] of Object.entries(VARIANTS)) {
      const text = make(o.text);
      if (text !== o.text) out.push({ name: `${o.name} [${v}]`, text, variant: v, of: o });
    }
  }
  return out;
}

// A deterministic random source (mulberry32).
export function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = n => Math.floor(next() * n);
  next.pick = list => list[next.int(list.length)];
  return next;
}

// About 1 MiB of agent-plan markdown: the repo documents, repeated.
export function bigDocument(size = 1024 * 1024) {
  const parts = [];
  let n = 0;
  while (n < size) {
    for (const d of docs) {
      parts.push(d.text.endsWith("\n") ? d.text : `${d.text}\n`, "\n");
      n += d.text.length + 2;
    }
  }
  return parts.join("");
}

// The top-level block kinds the expected HTML of a spec example shows: runs of lists and of raw HTML collapse into one.
export function htmlKinds(html) {
  const kinds = [];
  let p = 0;
  const known = [
    [/^<p>/, "p", "paragraph"],
    [/^<h([1-6])>/, null, "heading"],
    [/^<blockquote>\n/, "blockquote", "quote"],
    [/^<pre><code[ >]/, "pre", "code"],
    [/^<table>\n<thead>/, "table", "table"],
    [/^<hr \/>/, null, "hr"],
    [/^<ul>\n/, "ul", "list"],
    [/^<ol(?: start="\d+")?>\n/, "ol", "list"],
  ];
  while (p < html.length) {
    if (/\s/.test(html[p])) { p++; continue; }
    const rest = html.slice(p);
    const hit = known.find(([re]) => re.test(rest));
    if (!hit) {
      const nl = html.indexOf("\n", p);
      kinds.push("html");
      p = nl < 0 ? html.length : nl + 1;
      continue;
    }
    const [re, tag0, kind] = hit;
    const m = re.exec(rest);
    const tag = tag0 ?? (kind === "heading" ? `h${m[1]}` : null);
    kinds.push(kind);
    if (!tag) { p += m[0].length; continue; }
    let depth = 0, q = p;
    const open = new RegExp(`<${tag}[ >]`, "g"), close = `</${tag}>`;
    for (;;) {
      open.lastIndex = q;
      const o = open.exec(html), c = html.indexOf(close, q);
      if (c < 0) { q = html.length; break; }
      if (o && o.index < c) { depth++; q = o.index + 1; continue; }
      depth--;
      q = c + close.length;
      if (depth <= 0) break;
    }
    p = q;
  }
  return collapse(kinds);
}

export const collapse = kinds => kinds.filter((k, i) => !((k === "list" || k === "html") && kinds[i - 1] === k));

// The same for a parsed Doc: top-level blocks, items as lists, definitions dropped.
export function docKinds(doc) {
  const names = { item: "list", mermaid: "code", definition: null };
  return collapse(doc.blocks.filter(b => b.depth === 0).map(b => (b.kind in names ? names[b.kind] : b.kind)).filter(Boolean));
}
