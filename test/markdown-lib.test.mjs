import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinFs } from "node:path";
import { promisify } from "node:util";
import {
  MARKDOWN_EXT, isMarkdown, hash, dirname, basename, joinPath, normalizePath, tildePath, resolveLink,
  filterFiles, newFileName, uniqueName, fileKey, stats, modeOf, toggleMode, remember, trimMap,
  markdownPathsFromGit, markdownPathsFromFind, FIND_SCRIPT, isLight, mix, mermaidConfig, diagramKey, DIAGRAM_COLORS, sharpName,
  toSource, sourceToDoc, docToSource, sourceSplice, eolOf, picturesOf, pictureSource, touches,
  isPictureName, copyName, pictureLink, pictureMarkdown, escapeAlt, writtenAddress, pictureWithAlt, pictureWithAddress,
} from "../mods/herdr-inline-markdown/lib.js";
import { diff, parse } from "../mods/herdr-inline-markdown/blocks.js";
import { parseInline } from "../mods/herdr-inline-markdown/inline.js";
import { corpus } from "./markdown-corpus.mjs";

const sh = promisify(execFile);

test("markdown files are told by their extension, in any case", () => {
  for (const name of ["a.md", "A.MD", "x.markdown", "x.mdown", "x.mkd", "x.mkdn", "x.mdx", "dir/notes.Md", ".md"]) assert.ok(isMarkdown(name), name);
  for (const name of ["a.txt", "md", "a.md.bak", "a.mdd", "amd", "a.md/", "", undefined, null]) assert.ok(!isMarkdown(name), String(name));
  assert.ok(MARKDOWN_EXT.test("x.md"));
});

// The field `value` after the document splice `s`, with the map following it: what the Markdown field does.
const edited = (text, ...values) => {
  const map = toSource(text), eol = eolOf(text);
  let field = map.value;
  for (const value of values) {
    const d = diff(field, value);
    const s = sourceSplice(map, { at: d.at, removed: d.removed, inserted: d.inserted }, eol, field.charAt(d.at - 1));
    text = text.slice(0, s.start) + s.insert + text.slice(s.end);
    field = value;
  }
  return { text, map };
};
const BOM = String.fromCharCode(0xfeff);

test("new lines take the file's first line end, else \\n", () => {
  assert.deepEqual(["a\r\nb\n", "a\nb\r\n", "\r\n", "a", "", "\ra\n", "\n\r\n"].map(eolOf), ["\r\n", "\n", "\r\n", "\n", "\n", "\n", "\n"]);
});

test("the field shows the document without its BOM and with every CRLF as one newline; a lone CR stays", () => {
  assert.deepEqual(toSource("a\nb"), { value: "a\nb", bom: 0, crlf: [] });
  assert.deepEqual(toSource("a\r\nb\r\n"), { value: "a\nb\n", bom: 0, crlf: [1, 3] });
  assert.deepEqual(toSource(`${BOM}a\r\nb\nc\rd\r\r\n`), { value: "a\nb\nc\rd\r\n", bom: 1, crlf: [1, 8] });
  assert.deepEqual(toSource(""), { value: "", bom: 0, crlf: [] });
});

test("field and document offsets map both ways; inside a CRLF or the BOM the field offset is the one before it", () => {
  const text = `${BOM}ab\r\ncd\r\n\r\ne`, map = toSource(text);
  assert.equal(map.value, "ab\ncd\n\ne");
  for (let f = 0; f <= map.value.length; f++) {
    const d = sourceToDoc(map, f);
    assert.equal(docToSource(map, d), f, `field ${f}`);
    assert.equal(text.slice(d).replace(/\r\n/g, "\n"), map.value.slice(f), `field ${f} is document ${d}`);
  }
  assert.equal(docToSource(map, 0), 0, "the BOM");
  assert.equal(docToSource(map, 4), 2, "between CR and LF");
  assert.equal(docToSource(map, text.length), map.value.length);
});

test("Enter typed in the field of a CRLF file writes CRLF and leaves every other byte", () => {
  const text = "# Title\r\n\r\nfirst line\r\nsecond\r\n";
  const r = edited(text, "# Title\n\nfirst\n line\nsecond\n");
  assert.equal(r.text, "# Title\r\n\r\nfirst\r\n line\r\nsecond\r\n");
  assert.deepEqual(r.map.crlf, toSource(r.text).crlf, "the map follows the edit");
  assert.equal(edited("a\nb\n", "a\n\nb\n").text, "a\n\nb\n", "an LF file stays LF");
});

test("deleting a line break in the field takes its whole CRLF; edits after a BOM keep it", () => {
  assert.equal(edited("a\r\nb\r\n", "ab\n").text, "ab\r\n");
  assert.equal(edited(`${BOM}a\r\nb`, "xa\nb").text, `${BOM}xa\r\nb`);
  assert.equal(edited(`${BOM}a\r\nb`, "a\nb!").text, `${BOM}a\r\nb!`);
  const r = edited("1\r\n2\r\n3\r\n4\r\n", "1\n3\n4\n");
  assert.equal(r.text, "1\r\n3\r\n4\r\n");
  assert.deepEqual(r.map.crlf, [1, 3, 5]);
});

test("a \\r\\n pasted into the field of a CRLF file is one CRLF in the document, kept 1:1, and later edits beside it stay exact", () => {
  const text = "a\r\nb\r\n";
  const pasted = edited(text, "ax\r\ny\nb\n");
  assert.equal(pasted.text, "ax\r\ny\r\nb\r\n", "no \\r\\r\\n");
  assert.deepEqual(pasted.map.crlf, [5, 7], "the pasted \\n maps 1:1; the file's own two still stand for CRLF");
  assert.equal(sourceToDoc(pasted.map, "ax\r\ny\nb\n".length), pasted.text.length);
  assert.equal(edited("a\r\n", "one\ntwo\r\nthree\na\n").text, "one\r\ntwo\r\nthree\r\na\r\n", "a mixed paste ends every line with CRLF");
  assert.equal(edited(text, "ax\r\ny\nb\n", "ax\r\nzy\nb\n", "ax\r\nzy\nb\nend").text, "ax\r\nzy\r\nb\r\nend");
  assert.equal(edited(text, "ax\r\ny\nb\n", "ax\nb\n").text, "ax\r\nb\r\n", "taking the pasted line back takes its CRLF and no more");
  assert.equal(edited(text, "ax\r\ny\nb\n", "a\nb\n").text, text, "the paste undone is the file as it was");
  assert.equal(edited("a\rb\r\n", "a\r\n\rb\n").text, "a\r\n\rb\r\n", "a \\r\\n pasted before a lone CR, whose \\r the diff counts as kept");
  assert.equal(edited("a\nb\n", "a\r\nb\n").text, "a\r\nb\n", "an LF file takes the pasted bytes as they are");
});

test("hash is 16 lowercase hex characters, with the same values as when the cache files were named", () => {
  for (const s of ["", "a", "hello", "graph TD\n  A --> B", "日本語 ✓", "x".repeat(10000)]) assert.match(hash(s), /^[0-9a-f]{16}$/, s.slice(0, 20));
  // Pinned: cached diagrams are found by these names.
  assert.equal(hash(""), "488bdcb81aee8d83");
  assert.equal(hash("hello"), "bfb06f3a63cd7226");
});

test("hash spreads: similar inputs give different values and every hex digit shows up", () => {
  const seen = new Set(), first = new Set(), last = new Set();
  for (let i = 0; i < 5000; i++) {
    const h = hash(`diagram-${i}`);
    seen.add(h); first.add(h[0]); last.add(h[15]);
  }
  assert.equal(seen.size, 5000);
  assert.equal(first.size, 16);
  assert.equal(last.size, 16);
  assert.notEqual(hash("graph TD\nA-->B"), hash("graph TD\nA-->C"));
  assert.notEqual(hash("ab"), hash("ba"));
  assert.notEqual(hash("a"), hash("a\0"));
});

test("dirname and basename follow POSIX", () => {
  assert.equal(dirname("/a/b/c.md"), "/a/b");
  assert.equal(dirname("/a/b/"), "/a");
  assert.equal(dirname("/a"), "/");
  assert.equal(dirname("/"), "/");
  assert.equal(dirname("a/b"), "a");
  assert.equal(dirname("a"), ".");
  assert.equal(dirname(""), ".");
  assert.equal(dirname("/a//b"), "/a");
  assert.equal(basename("/a/b/c.md"), "c.md");
  assert.equal(basename("/a/b/"), "b");
  assert.equal(basename("c.md"), "c.md");
  assert.equal(basename("/"), "");
  assert.equal(basename(""), "");
});

test("normalizePath settles ., .. and doubled slashes", () => {
  assert.equal(normalizePath("/a/./b//c/../d"), "/a/b/d");
  assert.equal(normalizePath("/a/b/.."), "/a");
  assert.equal(normalizePath("/.."), "/");
  assert.equal(normalizePath("/../../x"), "/x");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("a/b/../../.."), "..");
  assert.equal(normalizePath("../a"), "../a");
  assert.equal(normalizePath("a/.."), ".");
  assert.equal(normalizePath(""), ".");
  assert.equal(normalizePath("/a/b/"), "/a/b");
});

test("joinPath: an absolute second part wins, the rest is joined and normalized", () => {
  assert.equal(joinPath("/a/b", "c.md"), "/a/b/c.md");
  assert.equal(joinPath("/a/b/", "c.md"), "/a/b/c.md");
  assert.equal(joinPath("/a/b", "../c.md"), "/a/c.md");
  assert.equal(joinPath("/a/b", "/x/y.md"), "/x/y.md");
  assert.equal(joinPath("/", "x"), "/x");
  assert.equal(joinPath("", "x"), "x");
  assert.equal(joinPath("rel", "x"), "rel/x");
  assert.equal(joinPath("/a", "./b//c"), "/a/b/c");
});

test("tildePath shows the home folder as ~, but not a folder that only starts the same", () => {
  assert.equal(tildePath("/home/user", "/home/user"), "~");
  assert.equal(tildePath("/home/user/", "/home/user/"), "~");
  assert.equal(tildePath("/home/user/notes/a.md", "/home/user"), "~/notes/a.md");
  assert.equal(tildePath("/home/user/notes", "/home/user/"), "~/notes");
  assert.equal(tildePath("/home/userx/a", "/home/user"), "/home/userx/a");
  assert.equal(tildePath("/etc/hosts", "/home/user"), "/etc/hosts");
  assert.equal(tildePath("/home/user/a", ""), "/home/user/a");
  assert.equal(tildePath("/home/user/a", null), "/home/user/a");
  assert.equal(tildePath("/a", "/"), "/a");
});

test("web links: http, https and mailto, any case, left as they are", () => {
  assert.deepEqual(resolveLink("https://example.com/a?b=1#c", "/n/a.md"), { kind: "web", url: "https://example.com/a?b=1#c" });
  assert.deepEqual(resolveLink("HTTP://EXAMPLE.COM", "/n/a.md"), { kind: "web", url: "HTTP://EXAMPLE.COM" });
  assert.deepEqual(resolveLink("mailto:me@example.com", "/n/a.md"), { kind: "web", url: "mailto:me@example.com" });
  assert.deepEqual(resolveLink("  https://example.com  ", "/n/a.md"), { kind: "web", url: "https://example.com" });
  assert.deepEqual(resolveLink("<https://example.com/x y>", "/n/a.md"), { kind: "web", url: "https://example.com/x y" });
});

test("relative links resolve against the document's folder, absolute ones stand", () => {
  assert.deepEqual(resolveLink("other.md", "/n/a.md"), { kind: "markdown", path: "/n/other.md" });
  assert.deepEqual(resolveLink("./sub/other.md", "/n/a.md"), { kind: "markdown", path: "/n/sub/other.md" });
  assert.deepEqual(resolveLink("../up.markdown", "/n/deep/a.md"), { kind: "markdown", path: "/n/up.markdown" });
  assert.deepEqual(resolveLink("/abs/x.md", "/n/a.md"), { kind: "markdown", path: "/abs/x.md" });
  assert.deepEqual(resolveLink("image.png", "/n/a.md"), { kind: "file", path: "/n/image.png" });
  assert.deepEqual(resolveLink("src/main.js", "/n/a.md"), { kind: "file", path: "/n/src/main.js" });
  assert.deepEqual(resolveLink("../../../../x.md", "/n/a.md"), { kind: "markdown", path: "/x.md" });
});

test("file links drop ?query and #fragment, decode %xx, and take file:// and <angle brackets>", () => {
  assert.deepEqual(resolveLink("other.md#section", "/n/a.md"), { kind: "markdown", path: "/n/other.md" });
  assert.deepEqual(resolveLink("other.md?x=1", "/n/a.md"), { kind: "markdown", path: "/n/other.md" });
  assert.deepEqual(resolveLink("other.md?x=1#y", "/n/a.md"), { kind: "markdown", path: "/n/other.md" });
  assert.deepEqual(resolveLink("my%20notes/a%2Fb.md", "/n/a.md"), { kind: "markdown", path: "/n/my notes/a/b.md" });
  assert.deepEqual(resolveLink("100%.md", "/n/a.md"), { kind: "markdown", path: "/n/100%.md" }, "a bad %-sequence stays as typed");
  assert.deepEqual(resolveLink("a%3Fb.md", "/n/a.md"), { kind: "markdown", path: "/n/a?b.md" }, "an encoded ? is part of the name");
  assert.deepEqual(resolveLink("<my notes.md>", "/n/a.md"), { kind: "markdown", path: "/n/my notes.md" });
  assert.deepEqual(resolveLink("file:///abs/dir/x.md", "/n/a.md"), { kind: "markdown", path: "/abs/dir/x.md" });
  assert.deepEqual(resolveLink("file://localhost/abs/x.md#h", "/n/a.md"), { kind: "markdown", path: "/abs/x.md" });
  assert.deepEqual(resolveLink("file:///abs/My%20Doc.txt", "/n/a.md"), { kind: "file", path: "/abs/My Doc.txt" });
  assert.deepEqual(resolveLink("file://otherhost/abs/x.md", "/n/a.md"), { kind: "unknown" });
  assert.deepEqual(resolveLink("file://", "/n/a.md"), { kind: "unknown" });
  assert.deepEqual(resolveLink("docs/", "/n/a.md"), { kind: "file", path: "/n/docs" });
});

test("anchors and things that are nothing we open", () => {
  assert.deepEqual(resolveLink("#intro", "/n/a.md"), { kind: "anchor", id: "intro" });
  assert.deepEqual(resolveLink("#a%20b", "/n/a.md"), { kind: "anchor", id: "a b" });
  assert.deepEqual(resolveLink("#", "/n/a.md"), { kind: "anchor", id: "" });
  for (const url of ["", "   ", undefined, null, "?x=1", "javascript:alert(1)", "tel:+123", "ftp://x/y.md", "data:text/plain,hi", "//cdn.example.com/x.md", "<>"]) {
    assert.deepEqual(resolveLink(url, "/n/a.md"), { kind: "unknown" }, String(url));
  }
});

const paths = list => list.map(p => ({ path: p }));
const names = entries => entries.map(e => e.path);

test("an empty query keeps the order and the limit", () => {
  const entries = paths(["b.md", "a.md", "c.md"]);
  assert.deepEqual(names(filterFiles(entries, "")), ["b.md", "a.md", "c.md"]);
  assert.deepEqual(names(filterFiles(entries, "   ")), ["b.md", "a.md", "c.md"]);
  assert.deepEqual(names(filterFiles(entries, undefined)), ["b.md", "a.md", "c.md"]);
  assert.deepEqual(names(filterFiles(entries, "", 2)), ["b.md", "a.md"]);
  assert.equal(filterFiles(paths(Array.from({ length: 300 }, (_, i) => `f${i}.md`)), "").length, 200);
});

test("filter: the query must be a subsequence of the path, in any case; others are dropped", () => {
  const entries = paths(["docs/Guide.md", "notes/todo.md", "README.md"]);
  assert.deepEqual(names(filterFiles(entries, "gde")), ["docs/Guide.md"]);
  assert.deepEqual(names(filterFiles(entries, "TODO")), ["notes/todo.md"]);
  assert.deepEqual(names(filterFiles(entries, "zzz")), []);
  assert.deepEqual(names(filterFiles(entries, "dg")), ["docs/Guide.md"], "letters may span the folder and the name");
  assert.deepEqual(names(filterFiles(entries, "emda")), [], "letters out of order do not match");
  assert.deepEqual(names(filterFiles(entries, "read me")), ["README.md"], "blanks in the query are ignored");
});

test("filter ranking: file name before folder, a run before scattered letters, earlier before later, shorter before longer", () => {
  const rank = (list, query) => names(filterFiles(paths(list), query));
  assert.deepEqual(rank(["docs/a.md", "x/docs.md"], "docs"), ["x/docs.md", "docs/a.md"], "name beats path-only");
  assert.deepEqual(rank(["r-e-a-d-m-e.md", "readme.md"], "readme"), ["readme.md", "r-e-a-d-m-e.md"], "contiguous beats scattered, both in the name");
  assert.deepEqual(rank(["readme/x.md", "r-e-a-d-m-e.md"], "readme"), ["r-e-a-d-m-e.md", "readme/x.md"], "a scattered name match beats a contiguous match only in the path");
  assert.deepEqual(rank(["xxread.md", "readxx.md"], "read"), ["readxx.md", "xxread.md"], "earlier beats later");
  assert.deepEqual(rank(["x-r-e-a-d.md", "r-e-a-d.md"], "ra"), ["r-e-a-d.md", "x-r-e-a-d.md"], "earlier beats later, scattered");
  assert.deepEqual(rank(["long/folder/readme.md", "docs/readme.md", "readme.md"], "readme"), ["readme.md", "docs/readme.md", "long/folder/readme.md"], "a shorter path breaks ties");
  assert.deepEqual(rank(["b/n.md", "a/n.md"], "n"), ["b/n.md", "a/n.md"], "equal in everything: input order");
  assert.deepEqual(
    rank(["a/b/c/d/readme-extra.md", "src/notes/read-me-later.md", "docs/readme.md", "README.md", "other/rd.md"], "readme"),
    ["README.md", "docs/readme.md", "a/b/c/d/readme-extra.md", "src/notes/read-me-later.md"],
    "the whole mix",
  );
});

test("filter keeps the entries it was given and honours the limit after ranking", () => {
  const entries = [{ path: "a/x.md", id: 1 }, { path: "x.md", id: 2 }, { path: "b/x.md", id: 3 }];
  const out = filterFiles(entries, "x", 2);
  assert.deepEqual(out.map(e => e.id), [2, 1]);
  assert.equal(out[0], entries[1]);
});

test("newFileName makes a markdown name from what was typed, or says why not", () => {
  assert.deepEqual(newFileName("notes"), { name: "notes.md" });
  assert.deepEqual(newFileName("  notes  "), { name: "notes.md" });
  assert.deepEqual(newFileName("My Notes"), { name: "My Notes.md" });
  assert.deepEqual(newFileName("notes.md"), { name: "notes.md" });
  assert.deepEqual(newFileName("NOTES.MD"), { name: "NOTES.MD" });
  assert.deepEqual(newFileName("a/b.markdown"), { name: "a/b.markdown" });
  assert.deepEqual(newFileName("notes.txt"), { name: "notes.txt.md" });
  assert.deepEqual(newFileName("docs/new idea"), { name: "docs/new idea.md" });
  assert.deepEqual(newFileName("./x"), { name: "x.md" });
  assert.deepEqual(newFileName("a//b"), { name: "a/b.md" });
  for (const bad of ["", "   ", undefined, "/etc/x", "../x", "a/../b", "a/..", "docs/", ".", "a\0b"]) {
    const r = newFileName(bad);
    assert.equal(typeof r.error, "string", String(bad));
    assert.ok(r.error && !("name" in r), String(bad));
  }
});

test("uniqueName counts up from untitled.md", () => {
  assert.equal(uniqueName(new Set()), "untitled.md");
  assert.equal(uniqueName(new Set(["other.md"])), "untitled.md");
  assert.equal(uniqueName(new Set(["untitled.md"])), "untitled-2.md");
  assert.equal(uniqueName(new Set(["untitled.md", "untitled-2.md"])), "untitled-3.md");
  assert.equal(uniqueName(new Set(["untitled.md", "untitled-3.md"])), "untitled-2.md", "the first free number");
  assert.equal(uniqueName(new Set(["note.md"]), "note.md"), "note-2.md");
  assert.equal(uniqueName(new Set(["readme"]), "readme"), "readme-2");
  assert.equal(uniqueName(new Set(["a.b.md"]), "a.b.md"), "a.b-2.md");
});

test("fileKey joins the machine (empty for this computer) and the path", () => {
  assert.equal(fileKey(null, "/a/b.md"), ":/a/b.md");
  assert.equal(fileKey(undefined, "/a/b.md"), ":/a/b.md");
  assert.equal(fileKey("devbox", "/a/b.md"), "devbox:/a/b.md");
});

test("markdownPathsFromGit keeps markdown paths once each, in order, up to 2000", () => {
  const out = markdownPathsFromGit("README.md\0src/a.js\0docs/b.MD\0README.md\0notes/x.markdown\0weird name.mdx\0\0Makefile\0");
  assert.deepEqual(out, ["README.md", "docs/b.MD", "notes/x.markdown", "weird name.mdx"]);
  assert.deepEqual(markdownPathsFromGit(""), []);
  assert.deepEqual(markdownPathsFromGit(undefined), []);
  assert.equal(markdownPathsFromGit(Array.from({ length: 2500 }, (_, i) => `f${i}.md`).join("\0")).length, 2000);
});

test("markdownPathsFromFind does the same for find's output, dropping a leading ./", () => {
  assert.deepEqual(markdownPathsFromFind("a.md\0./b.md\0sub/c.txt\0sub/d.markdown\0a.md\0"), ["a.md", "b.md", "sub/d.markdown"]);
  assert.equal(markdownPathsFromFind(Array.from({ length: 1500 }, (_, i) => `f${i}.md`).join("\0")).length, 1000);
});

test("FIND_SCRIPT lists markdown files up to 5 levels down and skips the noisy places", async () => {
  const dir = await mkdtemp(joinFs(tmpdir(), "md-find-"));
  try {
    const files = [
      "a.md", "UPPER.MD", "with space.md", "notes/b.markdown", "notes/c.txt", "notes/deep/page.mdx",
      "d1/d2/d3/d4/five.md", "d1/d2/d3/d4/d5/six.md",
      "node_modules/pkg/readme.md", "a/node_modules/readme.md", ".git/doc.md", ".hidden/h.md", "sub/.secret.md",
      "Library/l.md", "x/Library/l.md", ".cache/c.md",
    ];
    for (const f of files) {
      await mkdir(joinFs(dir, f, ".."), { recursive: true });
      await writeFile(joinFs(dir, f), "x");
    }
    const r = await sh("sh", ["-c", FIND_SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.ok(r.stdout.endsWith("\0") && !r.stdout.includes("\n") && !r.stdout.includes("./"), "NUL-separated, no ./");
    assert.deepEqual(markdownPathsFromFind(r.stdout).sort(), ["UPPER.MD", "a.md", "d1/d2/d3/d4/five.md", "notes/b.markdown", "notes/deep/page.mdx", "with space.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FIND_SCRIPT stops at 1000 files and succeeds in an empty folder", async () => {
  const dir = await mkdtemp(joinFs(tmpdir(), "md-find-"));
  try {
    const empty = await sh("sh", ["-c", FIND_SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(empty.stdout, "");
    await Promise.all(Array.from({ length: 1020 }, (_, i) => writeFile(joinFs(dir, `n${i}.md`), "")));
    const r = await sh("sh", ["-c", FIND_SCRIPT], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 24 });
    assert.equal(r.stdout.split("\0").filter(Boolean).length, 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stats counts words and lines, ignoring the newline that ends the file", () => {
  assert.deepEqual(stats(""), { words: 0, lines: 0 });
  assert.deepEqual(stats(undefined), { words: 0, lines: 0 });
  assert.deepEqual(stats("hello"), { words: 1, lines: 1 });
  assert.deepEqual(stats("hello\n"), { words: 1, lines: 1 });
  assert.deepEqual(stats("hello\n\n"), { words: 1, lines: 2 });
  assert.deepEqual(stats("one two  three\nfour\tfive\n"), { words: 5, lines: 2 });
  assert.deepEqual(stats("\n"), { words: 0, lines: 1 });
  assert.deepEqual(stats("a\r\nb\r\n"), { words: 2, lines: 2 });
  assert.deepEqual(stats("  \n  "), { words: 0, lines: 2 });
  assert.deepEqual(stats("# Title\n\n- a\n- b"), { words: 6, lines: 4 });
});

test("modes: Reading and Markdown; the old Read / Edit / Split names map onto them; the toggle goes back and forth", () => {
  assert.deepEqual(["reading", "markdown", "read", "edit", "split"].map(modeOf), ["reading", "markdown", "reading", "markdown", "markdown"]);
  for (const bad of ["sideways", "", undefined, null, 3]) assert.equal(modeOf(bad), null, String(bad));
  assert.equal(toggleMode("reading"), "markdown");
  assert.equal(toggleMode("markdown"), "reading");
});

test("remember puts the item first, drops its earlier twin and cuts the list", () => {
  const same = (a, b) => a.path === b.path && a.machine === b.machine;
  const a = { machine: null, path: "/a" }, b = { machine: null, path: "/b" }, c = { machine: "devbox", path: "/a" };
  assert.deepEqual(remember([], a, same, 30), [a]);
  assert.deepEqual(remember(undefined, a, same, 30), [a]);
  assert.deepEqual(remember([a, b], b, same, 30), [b, a]);
  assert.deepEqual(remember([a, b], { ...a }, same, 30), [{ ...a }, b]);
  assert.deepEqual(remember([a, b], c, same, 30), [c, a, b], "another machine's file is another file");
  assert.deepEqual(remember([a, b], c, same, 2), [c, a]);
  const list = Array.from({ length: 30 }, (_, i) => ({ machine: null, path: `/f${i}` }));
  const next = remember(list, a, same, 30);
  assert.equal(next.length, 30);
  assert.deepEqual(next[0], a);
  assert.equal(next[29].path, "/f28");
  assert.equal(list.length, 30, "the old list is not changed");
});

test("trimMap keeps the last keys in insertion order and returns a new object", () => {
  const map = { a: 1, b: 2, c: 3, d: 4 };
  assert.deepEqual(Object.entries(trimMap(map, 2)), [["c", 3], ["d", 4]]);
  assert.deepEqual(trimMap(map, 4), map);
  assert.notEqual(trimMap(map, 4), map);
  assert.deepEqual(trimMap(map, 10), map);
  assert.deepEqual(trimMap(map, 0), {});
  assert.deepEqual(trimMap(undefined, 3), {});
  assert.deepEqual(Object.keys(map), ["a", "b", "c", "d"], "the old map is not changed");
});

test("isLight reads #rgb, #rrggbb and #rrggbbaa; anything else is dark", () => {
  assert.ok(isLight("#fff"));
  assert.ok(isLight("#FFFFFF"));
  assert.ok(isLight("#ffffff00"), "the alpha is ignored");
  assert.ok(isLight("#f5f5f5"));
  assert.ok(isLight("#ffc600"), "yellow is light");
  assert.ok(!isLight("#000"));
  assert.ok(!isLight("#122738"));
  assert.ok(!isLight("#0050a4"));
  assert.ok(!isLight("transparent"));
  assert.ok(!isLight("white"));
  assert.ok(!isLight("rgb(255,255,255)"));
  assert.ok(!isLight("#ggg"));
  assert.ok(!isLight("#12345"));
  assert.ok(!isLight(undefined));
});

test("mix moves the first color toward the second and gives #rrggbb", () => {
  assert.equal(mix("#000000", "#ffffff", 0), "#000000");
  assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#ff0000", "#0000ff", 0.25), "#bf0040");
  assert.equal(mix("#fff", "#000", 0.5), "#808080", "short hex");
  assert.equal(mix("#ffffff80", "#000000ff", 0), "#ffffff", "the alpha is dropped");
  assert.equal(mix("#000000", "#ffffff", -3), "#000000", "t is held between 0 and 1");
  assert.equal(mix("#000000", "#ffffff", 7), "#ffffff");
  assert.equal(mix("red", "#ffffff", 0.5), "red", "not hex: the first as it is");
  assert.equal(mix("#112233", "blue", 0.5), "#112233");
});

test("DIAGRAM_COLORS are all #rrggbb", () => {
  for (const color of Object.values(DIAGRAM_COLORS)) assert.match(color, /^#[0-9a-f]{6}$/, color);
});

test("sharpName: the diagram's key, a hash of the colour it is painted on, its scale; another colour is another file", () => {
  assert.match(sharpName("4e6646f2ef48d31a", "#2a3d4c", 2.5), /^4e6646f2ef48d31a-[0-9a-f]{6}-x250$/);
  assert.notEqual(sharpName("k", "#2a3d4c", 4), sharpName("k", "#122738", 4));
  assert.equal(sharpName("k", "#2a3d4c", 4.004), sharpName("k", "#2a3d4c", 4));
});

test("mermaidConfig: mermaid's redux-dark-color theme with svg text labels and no max width, and no theme variables", () => {
  const cfg = mermaidConfig();
  assert.equal(cfg.theme, "redux-dark-color");
  assert.equal(cfg.htmlLabels, false);
  assert.equal(cfg.themeVariables, undefined, "the colours are mermaid's own");
  const diagrams = Object.entries(cfg).filter(([, value]) => typeof value === "object");
  for (const type of ["flowchart", "sequence"]) assert.ok(diagrams.some(([key]) => key === type), `${type} is configured`);
  for (const [key, value] of diagrams) assert.deepEqual(value, { useMaxWidth: false }, key);
  assert.deepEqual(JSON.parse(JSON.stringify(cfg)), cfg, "plain JSON: it is written to the renderer's config file");
});

test("diagramKey changes with the source, the config and the renderer version", () => {
  const base = diagramKey("graph TD\nA-->B", '{"a":1}', "mmdc-12.2.0+abcd1234");
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(base, diagramKey("graph TD\nA-->B", '{"a":1}', "mmdc-12.2.0+abcd1234"));
  assert.notEqual(base, diagramKey("graph TD\nA-->C", '{"a":1}', "mmdc-12.2.0+abcd1234"));
  assert.notEqual(base, diagramKey("graph TD\nA-->B", '{"a":2}', "mmdc-12.2.0+abcd1234"));
  assert.notEqual(base, diagramKey("graph TD\nA-->B", '{"a":1}', "mmdc-12.2.0+abcd1235"));
  assert.notEqual(diagramKey("b", "a", "v"), diagramKey("ab", "", "v"), "the parts cannot slide into each other");
  assert.notEqual(diagramKey("x", "", "v1"), diagramKey("1x", "", "v"), "the parts cannot slide into each other");
});

test("picturesOf: one entry per image, with its alt, its address, and the link it sits in", () => {
  assert.deepEqual(picturesOf("![logo](img/logo.png)"), [{ alt: "logo", src: "img/logo.png", href: null }]);
  assert.deepEqual(picturesOf("[![build](https://x.io/b.svg)](https://x.io/ci)"), [{ alt: "build", src: "https://x.io/b.svg", href: "https://x.io/ci" }]);
  assert.deepEqual(picturesOf("[![a](x.svg)](y) ![b](z.png)\t[![](w.png)](v)\n![c](u.png)"), [
    { alt: "a", src: "x.svg", href: "y" }, { alt: "b", src: "z.png", href: null }, { alt: "", src: "w.png", href: "v" }, { alt: "c", src: "u.png", href: null },
  ]);
});

test("picturesOf: a title and the <…> around an address are dropped, and the spaces around it", () => {
  const src = text => picturesOf(text)[0].src;
  assert.equal(src('![a](x.png "A title")'), "x.png");
  assert.equal(src("![a](x.png 'A title')"), "x.png");
  assert.equal(src("![a](  x.png  )"), "x.png");
  assert.equal(src("![a](<my pics/x y.png>)"), "my pics/x y.png");
  assert.equal(src('![a](<x y.png> "t")'), "x y.png");
  assert.equal(src("![a](<  x.png  >)"), "x.png");
  assert.equal(src("![a]()"), "");
  assert.equal(src("![a](<>)"), "");
  const linked = picturesOf('[![a](x.png "t")](<https://x.io/a b> "t2")')[0];
  assert.deepEqual(linked, { alt: "a", src: "x.png", href: "https://x.io/a b" });
});

test("picturesOf: an empty link address is no link", () => {
  assert.equal(picturesOf("[![a](x.png)]()")[0].href, null);
  assert.equal(picturesOf("[![a](x.png)](<>)")[0].href, null);
});

test("picturesOf: a backslash escapes a bracket or a backslash in the alt, and an escaped ] does not end it", () => {
  assert.equal(picturesOf("![a \\[1\\]](x.png)")[0].alt, "a [1]");
  assert.equal(picturesOf("![a\\\\](x.png)")[0].alt, "a\\");
  assert.equal(picturesOf("[![a \\]](x.png)](y)")[0].alt, "a ]");
  assert.deepEqual(picturesOf("![a\\](x.png)"), [], "the only ] is escaped, so the image is never closed");
});

test("picturesOf: anything that is not only images is []", () => {
  for (const text of ["", "plain text", "![a](x.png) and text", "text ![a](x.png)", "[![a](x.png)]", "![a](x(1).png)", "[a](b)", "![a][ref]", "<img src=\"a.png\">", "![a](x.png)\n\n![b](y.png)"]) {
    assert.deepEqual(picturesOf(text), [], JSON.stringify(text));
  }
  assert.deepEqual(picturesOf(undefined), []);
});

test("picturesOf: finds an image in every image-only paragraph of the CommonMark and GFM examples and the documents", () => {
  let images = 0, others = 0;
  for (const c of corpus()) {
    for (const b of parse(c.text).blocks) {
      if (b.image) {
        images++;
        assert.ok(picturesOf(b.content).length > 0, `${c.name}: ${JSON.stringify(b.content)}`);
      } else if (b.kind === "paragraph") {
        others++;
        assert.deepEqual(picturesOf(b.content), [], `${c.name}: ${JSON.stringify(b.content)}`);
      }
    }
  }
  assert.ok(images > 20 && others > 500, `${images} image paragraphs, ${others} other paragraphs`);
});

test("pictureSource: a path is relative to the document, absolute, or a file:// address, and loses its ?query and #fragment", () => {
  const file = "/n/docs/a.md";
  assert.deepEqual(pictureSource("img/x.png", file), { kind: "file", path: "/n/docs/img/x.png" });
  assert.deepEqual(pictureSource("./x.png", file), { kind: "file", path: "/n/docs/x.png" });
  assert.deepEqual(pictureSource("../x.png", file), { kind: "file", path: "/n/x.png" });
  assert.deepEqual(pictureSource("/abs/x.png", file), { kind: "file", path: "/abs/x.png" });
  assert.deepEqual(pictureSource("img/my%20pic.png?raw=true#top", file), { kind: "file", path: "/n/docs/img/my pic.png" });
  assert.deepEqual(pictureSource("file:///abs/my%20pic.png", file), { kind: "file", path: "/abs/my pic.png" });
  assert.deepEqual(pictureSource("file://localhost/abs/x.png", file), { kind: "file", path: "/abs/x.png" });
});

test("pictureSource: a path that ends like a Markdown file is still a file", () => {
  assert.deepEqual(pictureSource("notes.md", "/n/a.md"), { kind: "file", path: "/n/notes.md" });
});

test("pictureSource: https is a web picture and keeps its query; a data: address is a data picture", () => {
  assert.deepEqual(pictureSource("https://img.shields.io/badge/a-b.svg?style=flat#x", "/n/a.md"), { kind: "web", url: "https://img.shields.io/badge/a-b.svg?style=flat#x" });
  assert.deepEqual(pictureSource("HTTPS://X.IO/a.png", "/n/a.md"), { kind: "web", url: "HTTPS://X.IO/a.png" });
  assert.deepEqual(pictureSource("data:image/png;base64,AAAA", "/n/a.md"), { kind: "data", url: "data:image/png;base64,AAAA" });
  assert.deepEqual(pictureSource("DATA:image/svg+xml,%3Csvg/%3E", "/n/a.md"), { kind: "data", url: "DATA:image/svg+xml,%3Csvg/%3E" });
});

test("pictureSource: no address, http, an anchor and other schemes say why there is no picture", () => {
  const why = src => pictureSource(src, "/n/a.md");
  assert.deepEqual(why(""), { kind: "none", why: "No picture address" });
  assert.deepEqual(why("   "), { kind: "none", why: "No picture address" });
  assert.deepEqual(why("http://x.io/a.png"), { kind: "none", why: "Pictures load over https only" });
  assert.deepEqual(why("HTTP://x.io/a.png"), { kind: "none", why: "Pictures load over https only" });
  assert.deepEqual(why("#top"), { kind: "none", why: "Not a picture address" });
  assert.deepEqual(why("mailto:me@x.io"), { kind: "none", why: "Can't show a picture from mailto:" });
  assert.deepEqual(why("ftp://x.io/a.png"), { kind: "none", why: "Can't show a picture from ftp:" });
  assert.deepEqual(why("FTP://x.io/a.png"), { kind: "none", why: "Can't show a picture from ftp:" });
});

test("touches: a reported path is the file, a folder above it (the root is all of them), or a path with the file's name", () => {
  const file = "/n/docs/pic.png";
  for (const path of [file, "/n/docs", "/n/docs/", "/n", "/", "/private/n/docs/pic.png"]) assert.ok(touches(path, file), path);
  for (const path of ["/n/doc", "/n/docs2", "/n/docs/pi", "/n/docs/pic.png2", "/other/place.png"]) assert.ok(!touches(path, file), path);
});

test("pictureSource: an address that is not a place on this machine is not a picture address", () => {
  for (const src of ["//cdn.x.io/a.png", "file://other-host/a.png", "file:", "?v=2"]) assert.deepEqual(pictureSource(src, "/n/a.md"), { kind: "none", why: "Not a picture address" }, src);
});

const NOTE = "/n/docs/note.md";

test("isPictureName: png, jpg, jpeg, gif, webp, bmp and svg in any case; heic, a bare extension and a longer one are not", () => {
  for (const name of ["a.png", "A.PNG", "x.jpg", "x.JPEG", "x.jpeg", "x.gif", "x.webp", "x.Bmp", "x.svg", "/Users/me/Desktop/Screenshot 1.png", "a.b.png"]) assert.ok(isPictureName(name), name);
  for (const name of ["a.heic", "a.tiff", "png", "a.png.txt", "a.pngx", "a.txt", "", undefined, null]) assert.ok(!isPictureName(name), String(name));
});

test("copyName: every run of whitespace in a name becomes one hyphen, a narrow no-break space (macOS screenshots) too", () => {
  assert.equal(copyName("Screenshot 2026-11-06 at 10.15.30 AM.png"), "Screenshot-2026-11-06-at-10.15.30-AM.png");
  assert.equal(copyName("a   b\t\nc.png"), "a-b-c.png");
  assert.equal(copyName("tidy.png"), "tidy.png");
  assert.equal(copyName(""), "");
});

test("pictureLink: the address relative to the note's folder for a picture in or under it, else null (the picture has to be copied)", () => {
  assert.equal(pictureLink("/n/docs/a.png", NOTE), "a.png");
  assert.equal(pictureLink("/n/docs/img/a.png", NOTE), "img/a.png");
  assert.equal(pictureLink("/n/docs/img/deep/a.png", NOTE), "img/deep/a.png");
  assert.equal(pictureLink("/n/docs/./img/../a.png", NOTE), "a.png", "the path is normalised first");
  assert.equal(pictureLink("/a.png", "/note.md"), "a.png", "a note at the root");
  for (const path of ["/Users/me/Desktop/shot.png", "/n/a.png", "/n/docs2/a.png", "/n/doc/a.png", "/n/docs", "/n/docs/", "/n/docs/../a.png"]) assert.equal(pictureLink(path, NOTE), null, path);
});

test("pictureLink: a space puts the address in <…>; the characters an address cannot hold are written as %XX", () => {
  assert.equal(pictureLink("/n/docs/my shot.png", NOTE), "<my shot.png>");
  assert.equal(pictureLink("/n/docs/my pics/a b.png", NOTE), "<my pics/a b.png>");
  assert.equal(pictureLink("/n/docs/a(1).png", NOTE), "a%281%29.png");
  assert.equal(pictureLink("/n/docs/a (1).png", NOTE), "<a %281%29.png>");
  assert.equal(pictureLink("/n/docs/100%.png", NOTE), "100%25.png");
  assert.equal(pictureLink("/n/docs/a#1?.png", NOTE), "a%231%3F.png");
  assert.equal(pictureLink("/n/docs/a<b>.png", NOTE), "a%3Cb%3E.png");
  assert.equal(pictureLink("/n/docs/a:b.png", NOTE), "./a:b.png", "the colon would be taken for a scheme");
  assert.equal(pictureLink("/n/docs/ok/a:b.png", NOTE), "ok/a:b.png");
});

test("pictureMarkdown: one image per line, `![alt](address)`, the brackets and backslashes of the alt escaped", () => {
  assert.equal(pictureMarkdown([{ alt: "a", address: "a.png" }]), "![a](a.png)");
  assert.equal(pictureMarkdown([{ alt: "a", address: "a.png" }, { alt: "shot 1", address: "images/shot-1.png" }]), "![a](a.png)\n![shot 1](images/shot-1.png)");
  assert.equal(pictureMarkdown([{ alt: "Shot [1]", address: "<my shot.png>" }]), "![Shot \\[1\\]](<my shot.png>)");
  assert.equal(pictureMarkdown([{ alt: "a\\", address: "a.png" }]), "![a\\\\](a.png)");
  assert.equal(pictureMarkdown([{ alt: "", address: "a.png" }]), "![](a.png)");
  assert.equal(pictureMarkdown([]), "");
});

test("what pictureLink and pictureMarkdown write is read back as the same picture: one image-only paragraph, the same path, the same alt", () => {
  for (const name of ["a.png", "my shot.png", "a (1).png", "100%.png", "50%25.png", "a#1?.png", "a<b>.png", "a:b.png", "[x].png", "tab\tname.png", "ünï cødé.png", "a\\b.png", "[![x]](y).png"]) {
    const path = `/n/docs/sub/${name}`, alt = name.replace(/\.png$/, "");
    const markdown = pictureMarkdown([{ alt, address: pictureLink(path, NOTE) }]);
    assert.ok(parse(`${markdown}\n`).blocks[0].image, `${name}: ${markdown}`);
    const [picture] = picturesOf(markdown);
    assert.equal(picture.alt, alt, name);
    assert.deepEqual(pictureSource(picture.src, NOTE), { kind: "file", path }, name);
  }
});

const altRead = markdown => [picturesOf(markdown)[0]?.alt, parseInline(markdown).spans.find(sp => sp.kind === "image")?.alt];

test("escapeAlt: what it writes reads back as typed in picturesOf and in parseInline, marks, backticks, tags and entities too", () => {
  for (const alt of ["plain", "", "[b]", "c\\d", "*e*", "f_g_", "a `tick`", "~~s~~", "<b>x</b>", "&amp; & &#38;", "my_shot [1]", "a\\*b", "!x"]) {
    const markdown = `![${escapeAlt(alt)}](x.png)`;
    assert.ok(parse(`${markdown}\n`).blocks[0].image, markdown);
    assert.deepEqual(altRead(markdown), [alt, alt], markdown);
  }
  assert.equal(escapeAlt("plain words & more"), "plain words & more", "nothing that reads as itself is escaped");
});

test("picturesOf: every backslash escape of ASCII punctuation in the alt is undone, as CommonMark reads it; one before a letter stays", () => {
  assert.equal(picturesOf("![a\\*b\\_c\\`d\\~e\\<f\\&g\\!h\\#](x.png)")[0].alt, "a*b_c`d~e<f&g!h#");
  assert.equal(picturesOf("![a\\qb](x.png)")[0].alt, "a\\qb");
});

test("writtenAddress: trimmed, ( and ) as %28 and %29, in <…> when it holds a space; picturesOf and pictureSource read it back", () => {
  assert.equal(writtenAddress("  my pic.png "), "<my pic.png>");
  assert.equal(writtenAddress("a(1).png"), "a%281%29.png");
  assert.equal(writtenAddress("https://e.com/a b(2).png"), "<https://e.com/a b%282%29.png>");
  assert.equal(writtenAddress("images/a.png"), "images/a.png");
  for (const typed of ["my pic.png", "a(1).png", "sub/a (2) b.png"]) {
    const [picture] = picturesOf(`![x](${writtenAddress(typed)})`);
    assert.deepEqual(pictureSource(picture.src, NOTE), { kind: "file", path: `/n/docs/${typed}` }, typed);
  }
});

test("writtenAddress: a path's ?, # and a lone % are escaped so pictureSource finds the file typed; an escape it holds and a web address stay as typed", () => {
  for (const typed of ["shot #2.png", "what?.png", "100%.png", "50%off (1).png", "#top.png", "a<b>.png"]) {
    const [picture] = picturesOf(`![x](${writtenAddress(typed)})`);
    assert.deepEqual(pictureSource(picture.src, NOTE), { kind: "file", path: `/n/docs/${typed}` }, typed);
  }
  assert.equal(writtenAddress("shot #2.png"), "<shot %232.png>");
  assert.equal(writtenAddress("a%281%29.png"), "a%281%29.png", "an address as the box shows it");
  assert.equal(writtenAddress("https://e.com/a.png?w=2#top"), "https://e.com/a.png?w=2#top");
});

test("pictureWithAlt and pictureWithAddress: only the alt or the address changes; the title, the <…> form and the link stay", () => {
  assert.equal(pictureWithAlt("![a](x.png)", "b *c*"), "![b \\*c\\*](x.png)");
  assert.equal(pictureWithAlt('[![a \\[1\\]](x.png "t")](https://e.com)', ""), '[![](x.png "t")](https://e.com)');
  assert.equal(pictureWithAddress("![a](x.png)", "images/y.png"), "![a](images/y.png)");
  assert.equal(pictureWithAddress('![a](<my x.png> "A title")', "y.png"), '![a](y.png "A title")');
  assert.equal(pictureWithAddress('[![a](  x.png  "t")](https://e.com)', "<b c.png>"), '[![a](  <b c.png>  "t")](https://e.com)');
  assert.equal(pictureWithAddress("![]()", "a.png"), "![](a.png)");
  assert.equal(pictureWithAddress("![a](x.png)", ""), "![a]()");
});
