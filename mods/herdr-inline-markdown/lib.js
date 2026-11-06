// Pure helpers for the Markdown reader/editor and its picker. No imports from herdr or gpui-*: node tests load this file as it is.

export const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
export const isMarkdown = name => MARKDOWN_EXT.test(String(name ?? ""));

// 16 lowercase hex chars from two 32-bit lanes (cyrb53's mixing, both lanes kept). Stable across runs and engines.
export function hash(text) {
  const s = String(text);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// POSIX paths, as node's path.posix has them (dirname("a") is ".", basename("/") is "").

const trimEnd = path => path.replace(/\/+$/, "") || (path.startsWith("/") ? "/" : "");

export function dirname(path) {
  const p = trimEnd(String(path ?? "")), i = p.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : trimEnd(p.slice(0, i));
}
export function basename(path) {
  const p = trimEnd(String(path ?? ""));
  return p === "/" ? "" : p.slice(p.lastIndexOf("/") + 1);
}
// ".." above the root of an absolute path goes, above a relative one it stays. No trailing slash except for "/"; ""
// becomes ".".
export function normalizePath(path) {
  const p = String(path ?? ""), abs = p.startsWith("/"), out = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.length && out[out.length - 1] !== "..") out.pop();
    else if (!abs) out.push("..");
  }
  const joined = out.join("/");
  return abs ? `/${joined}` : joined || ".";
}
// `b` wins when it is absolute. The result is normalized.
export function joinPath(a, b) {
  const rest = String(b ?? "");
  return normalizePath(rest.startsWith("/") || !a ? rest : `${a}/${rest}`);
}
// "~" for the home folder and what is under it ("/home/us" is not under "/home/user").
export function tildePath(path, home) {
  const h = trimEnd(String(home ?? "")), p = trimEnd(String(path ?? ""));
  if (!h || h === "/") return path;
  if (p === h) return "~";
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : path;
}

const decode = s => {
  try { return decodeURIComponent(s); } catch { return s; }
};
const UNKNOWN = { kind: "unknown" };

// `file` is the document the link is in.
// -> { kind: "web", url } | { kind: "markdown" | "file", path } | { kind: "anchor", id } | { kind: "unknown" }
export function resolveLink(url, file) {
  let u = String(url ?? "").trim();
  if (u.startsWith("<") && u.endsWith(">")) u = u.slice(1, -1).trim();
  if (!u) return UNKNOWN;
  if (u[0] === "#") return { kind: "anchor", id: decode(u.slice(1)) };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u)?.[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return { kind: "web", url: u };
  let path;
  if (scheme === "file") {
    const m = /^file:\/\/([^/?#]*)(\/[^?#]*)?/i.exec(u);
    if (!m?.[2] || (m[1] && m[1].toLowerCase() !== "localhost")) return UNKNOWN;
    path = decode(m[2]);
  } else if (scheme || u.startsWith("//")) {
    return UNKNOWN;
  } else {
    // The ?query and #fragment are not part of the file name (a name with those characters comes as %3F, %23).
    const bare = u.replace(/[?#].*$/, "");
    if (!bare) return UNKNOWN;
    path = joinPath(dirname(file), decode(bare));
  }
  path = normalizePath(path);
  return { kind: isMarkdown(path) ? "markdown" : "file", path };
}

// Order: a match in the file name beats one only in the path, a run of the query beats scattered letters, an earlier
// match beats a later one, a shorter path breaks ties.
export function filterFiles(entries, query, limit = 200) {
  const q = String(query ?? "").toLowerCase().replace(/\s+/g, "");
  if (!q) return entries.slice(0, limit);
  const scored = [];
  entries.forEach((entry, index) => {
    const rank = matchRank(entry.path.toLowerCase(), q);
    if (rank) scored.push({ entry, index, rank, size: entry.path.length });
  });
  scored.sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || a.rank[2] - b.rank[2] || a.size - b.size || a.index - b.index);
  return scored.slice(0, limit).map(s => s.entry);
}

// [in the file name (1/0), a run (1/0), where it starts] or null.
function matchRank(path, q) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  for (const [text, inName] of [[name, 1], [path, 0]]) {
    const at = text.indexOf(q);
    if (at >= 0) return [inName, 1, at];
    if (isSubsequence(text, q)) return [inName, 0, text.indexOf(q[0])];
  }
  return null;
}
function isSubsequence(text, q) {
  let at = 0;
  for (let i = 0; i < text.length && at < q.length; i++) if (text[i] === q[at]) at++;
  return at === q.length;
}

// -> { name } (relative to the folder, ending in a markdown extension) or { error }.
export function newFileName(query) {
  const typed = String(query ?? "").trim();
  if (!typed) return { error: "Type a name" };
  if (typed.startsWith("/")) return { error: "Use a name inside this folder" };
  if (typed.endsWith("/")) return { error: "Add a file name after the folder" };
  if (typed.includes("\0")) return { error: "That name can't be used" };
  const parts = typed.split("/").filter(p => p && p !== ".");
  if (parts.includes("..")) return { error: "A name can't go up with .." };
  if (!parts.length) return { error: "Type a name" };
  const name = parts.join("/");
  return { name: isMarkdown(name) ? name : `${name}.md` };
}

export function uniqueName(taken, base = "untitled.md") {
  const dot = base.lastIndexOf("."), stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : "";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`;
  return name;
}

export const fileKey = (machine, path) => `${machine ?? ""}:${path}`;

// `git ls-files -z` output and FIND_SCRIPT's output (both NUL-separated) -> markdown paths, no repeats.
function pathsFrom(stdout, cap) {
  const seen = new Set();
  for (const raw of String(stdout ?? "").split("\0")) {
    const path = raw.replace(/^\.\//, "");
    if (!path || !isMarkdown(path)) continue;
    seen.add(path);
    if (seen.size >= cap) break;
  }
  return [...seen];
}
export const markdownPathsFromGit = stdout => pathsFrom(stdout, 2000);
export const markdownPathsFromFind = stdout => pathsFrom(stdout, 1000);

// For a folder that is not in git; skips node_modules, .git, hidden folders, Library and .cache. Run as
// exec("sh", ["-c", FIND_SCRIPT], { cwd }). The pipeline's exit status is tr's, so unreadable folders do not fail it.
export const FIND_SCRIPT = "find . -maxdepth 5 \\( -name node_modules -o -name .git -o -name Library -o -name .cache -o -name '.?*' \\) -prune -o -type f \\( "
  + ["md", "markdown", "mdown", "mkd", "mkdn", "mdx"].map(e => `-iname '*.${e}'`).join(" -o ")
  + " \\) -print 2>/dev/null | head -n 1000 | sed 's|^\\./||' | tr '\\n' '\\0'";

export const stats = text => {
  const s = String(text ?? "");
  if (!s) return { words: 0, lines: 0 };
  const body = s.endsWith("\n") ? s.slice(0, -1) : s;
  return { words: (s.match(/\S+/g) ?? []).length, lines: body.split("\n").length };
};

export const MODES = ["reading", "markdown"];
const OLD_MODES = { read: "reading", edit: "markdown", split: "markdown" };
// Remembered state may hold the Read / Edit / Split names.
export const modeOf = stored => (MODES.includes(stored) ? stored : OLD_MODES[stored] ?? null);
export const toggleMode = mode => (mode === "reading" ? "markdown" : "reading");

export const eolOf = text => {
  const t = String(text ?? ""), nl = t.indexOf("\n");
  return nl > 0 && t.charCodeAt(nl - 1) === 13 ? "\r\n" : "\n";
};

// -> { value, bom, crlf }: `crlf` is the sorted field offsets of the "\n"s that are "\r\n" in the document.
export function toSource(text) {
  const t = String(text ?? ""), bom = t.charCodeAt(0) === 0xfeff ? 1 : 0, crlf = [];
  if (!t.includes("\r\n")) return { value: bom ? t.slice(1) : t, bom, crlf };
  let value = "", from = bom;
  for (let at = t.indexOf("\r\n", bom); at >= 0; at = t.indexOf("\r\n", from)) {
    value += t.slice(from, at);
    crlf.push(value.length);
    value += "\n";
    from = at + 2;
  }
  return { value: value + t.slice(from), bom, crlf };
}

const below = (list, x) => {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
};

export const sourceToDoc = (map, f) => f + map.bom + below(map.crlf, f);

// Inside a BOM or a CRLF the field offset is the one before it.
export function docToSource(map, d) {
  let lo = 0, hi = Math.max(0, d - map.bom);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sourceToDoc(map, mid) <= d) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// `prev` is the field character before `at`. -> the document splice { start, end, insert }, with each "\n" that has no
// "\r" before it written as `eol`; `map` is updated in place. A "\r\n" the field keeps whole, as a paste leaves it, is
// one document line end, mapped 1:1.
export function sourceSplice(map, { at, removed, inserted }, eol, prev = "") {
  const start = sourceToDoc(map, at), end = sourceToDoc(map, at + removed);
  const lo = below(map.crlf, at), hi = below(map.crlf, at + removed), delta = inserted.length - removed;
  const added = [];
  let insert = inserted;
  if (eol === "\r\n") {
    insert = "";
    let from = 0;
    for (let i = inserted.indexOf("\n"); i >= 0; i = inserted.indexOf("\n", i + 1)) {
      if ((i ? inserted[i - 1] : prev) === "\r") continue;
      added.push(at + i);
      insert += `${inserted.slice(from, i)}\r`;
      from = i;
    }
    insert += inserted.slice(from);
  }
  const after = map.crlf.slice(hi);
  map.crlf.length = lo;
  for (const c of added) map.crlf.push(c);
  for (const c of after) map.crlf.push(c + delta);
  return { start, end, insert };
}

export const remember = (list, item, same, max) => [item, ...(list ?? []).filter(x => !same(x, item))].slice(0, max);

// The last `max` keys, in insertion order, as a new object.
export function trimMap(obj, max) {
  const entries = Object.entries(obj ?? {});
  return Object.fromEntries(entries.length > max ? entries.slice(entries.length - max) : entries);
}

// [r, g, b] from "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" (the alpha is dropped), else null.
function channels(color) {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(typeof color === "string" ? color.trim() : "");
  if (!m) return null;
  const h = m[1].length <= 4 ? m[1].replace(/./g, "$&$&") : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
// Perceived brightness of 128 or more (of 255); a color that is not hex counts as dark.
export function isLight(color) {
  const c = channels(color);
  return c ? (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 >= 128 : false;
}
// `t` is 0..1. Either color not hex: `a` as it is.
export function mix(a, b, t) {
  const x = channels(a), y = channels(b);
  if (!x || !y) return a;
  const w = Math.min(1, Math.max(0, Number(t) || 0));
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * w).toString(16).padStart(2, "0")).join("")}`;
}

const DIAGRAMS = ["flowchart", "sequence", "class", "state", "er", "gantt", "pie", "journey", "timeline", "mindmap", "gitGraph", "xyChart"];
// Mermaid's "redux-dark-color" theme, as the Mermaid Live Editor draws it. useMaxWidth is off so a PNG comes out at its
// natural size.
export const mermaidConfig = () => ({
  theme: "redux-dark-color", htmlLabels: false,
  ...Object.fromEntries(DIAGRAMS.map(d => [d, { useMaxWidth: false }])),
});

// The Live Editor's dark canvas; `dot` is its grid dot, rgba(70, 70, 70, 0.275), laid over the canvas.
export const DIAGRAM_COLORS = { canvas: "#020817", dot: "#151924", edge: "#1e293b", node: "#0f172a", line: "#94a3b8", text: "#f8fafc" };
export const diagramCanvas = () => DIAGRAM_COLORS.canvas;

export const diagramKey = (source, configJson, version) => hash(`${version}\0${configJson}\0${source}`);
export const sharpName = (key, background, scale) => `${key}-${hash(background).slice(0, 6)}-x${Math.round(scale * 100)}`;
