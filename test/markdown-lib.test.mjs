import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinFs } from "node:path";
import { promisify } from "node:util";
import {
  MARKDOWN_EXT, isMarkdown, hash, dirname, basename, joinPath, normalizePath, tildePath, resolveLink,
  filterFiles, newFileName, uniqueName, fileKey, stats, MODES, modeOf, toggleMode, remember, trimMap,
  markdownPathsFromGit, markdownPathsFromFind, FIND_SCRIPT, isLight, mix, mermaidConfig, diagramKey, DIAGRAM_COLORS, diagramCanvas, sharpName,
  toSource, sourceToDoc, docToSource, sourceSplice, eolOf,
} from "../mods/herdr-inline-markdown/lib.js";
import { diff } from "../mods/herdr-inline-markdown/blocks.js";

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

// --- hash

test("hash is 16 lowercase hex characters and does not change between runs", () => {
  for (const s of ["", "a", "hello", "graph TD\n  A --> B", "日本語 ✓", "x".repeat(10000)]) assert.match(hash(s), /^[0-9a-f]{16}$/, s.slice(0, 20));
  // Pinned: cache file names depend on these staying the same.
  assert.equal(hash(""), "488bdcb81aee8d83");
  assert.equal(hash("hello"), "bfb06f3a63cd7226");
  assert.equal(hash("hello"), hash("hello"));
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

// --- paths

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

// --- links

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

// --- picker helpers

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
  // name beats path-only
  assert.deepEqual(rank(["docs/a.md", "x/docs.md"], "docs"), ["x/docs.md", "docs/a.md"]);
  // contiguous beats scattered (both in the name)
  assert.deepEqual(rank(["r-e-a-d-m-e.md", "readme.md"], "readme"), ["readme.md", "r-e-a-d-m-e.md"]);
  // a name match, even scattered, beats a contiguous match only found in the path
  assert.deepEqual(rank(["readme/x.md", "r-e-a-d-m-e.md"], "readme"), ["r-e-a-d-m-e.md", "readme/x.md"]);
  // earlier beats later
  assert.deepEqual(rank(["xxread.md", "readxx.md"], "read"), ["readxx.md", "xxread.md"]);
  assert.deepEqual(rank(["x-r-e-a-d.md", "r-e-a-d.md"], "ra"), ["r-e-a-d.md", "x-r-e-a-d.md"]);
  // shorter path breaks ties
  assert.deepEqual(rank(["long/folder/readme.md", "docs/readme.md", "readme.md"], "readme"), ["readme.md", "docs/readme.md", "long/folder/readme.md"]);
  // equal in everything: input order
  assert.deepEqual(rank(["b/n.md", "a/n.md"], "n"), ["b/n.md", "a/n.md"]);
  // the whole mix
  assert.deepEqual(
    rank(["a/b/c/d/readme-extra.md", "src/notes/read-me-later.md", "docs/readme.md", "README.md", "other/rd.md"], "readme"),
    ["README.md", "docs/readme.md", "a/b/c/d/readme-extra.md", "src/notes/read-me-later.md"],
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

// --- editor state

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
  assert.deepEqual(MODES, ["reading", "markdown"]);
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

// --- colors

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

// --- diagrams

const DIAGRAM_KEYS = ["flowchart", "sequence", "class", "state", "er", "gantt", "pie", "journey", "timeline", "mindmap", "gitGraph", "xyChart"];

test("DIAGRAM_COLORS: the frame's canvas, grid dot, edge, node, line and text, all #rrggbb; diagramCanvas is the canvas", () => {
  assert.deepEqual(DIAGRAM_COLORS, { canvas: "#020817", dot: "#151924", edge: "#1e293b", node: "#0f172a", line: "#94a3b8", text: "#f8fafc" });
  for (const color of Object.values(DIAGRAM_COLORS)) assert.match(color, /^#[0-9a-f]{6}$/, color);
  assert.equal(diagramCanvas(), DIAGRAM_COLORS.canvas);
  assert.equal(diagramCanvas({ background: "#ffffff", foreground: "#1f2328" }), DIAGRAM_COLORS.canvas, "a light page does not change it");
});

test("sharpName: the diagram's key, a hash of the colour it is painted on, its scale; another colour is another file", () => {
  assert.match(sharpName("4e6646f2ef48d31a", "#2a3d4c", 2.5), /^4e6646f2ef48d31a-[0-9a-f]{6}-x250$/);
  assert.equal(sharpName("k", "transparent", 4), `k-${hash("transparent").slice(0, 6)}-x400`);
  assert.notEqual(sharpName("k", "#2a3d4c", 4), sharpName("k", "#122738", 4));
  assert.equal(sharpName("k", "#2a3d4c", 4.004), sharpName("k", "#2a3d4c", 4));
});

test("mermaidConfig: mermaid's redux-dark-color theme with svg text labels and no max width, and no theme variables", () => {
  const cfg = mermaidConfig();
  assert.equal(cfg.theme, "redux-dark-color");
  assert.equal(cfg.htmlLabels, false);
  assert.equal(cfg.themeVariables, undefined, "the colours are mermaid's own");
  for (const key of DIAGRAM_KEYS) assert.deepEqual(cfg[key], { useMaxWidth: false }, key);
  assert.deepEqual(Object.keys(cfg), ["theme", "htmlLabels", ...DIAGRAM_KEYS]);
});

test("mermaidConfig is plain JSON and the same every time, whatever the Herdr theme", () => {
  const a = JSON.stringify(mermaidConfig());
  assert.equal(a, JSON.stringify(mermaidConfig()));
  assert.deepEqual(JSON.parse(a), mermaidConfig());
  assert.equal(a, JSON.stringify(mermaidConfig({ background: "#ffffff", foreground: "#1f2328", accent: "#0969da" })), "so a theme switch keeps every diagram key");
});

test("diagramKey changes with the source, the config and the renderer version", () => {
  const base = diagramKey("graph TD\nA-->B", '{"a":1}', "mmdc-12.2.0+abcd1234");
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(base, diagramKey("graph TD\nA-->B", '{"a":1}', "mmdc-12.2.0+abcd1234"));
  assert.notEqual(base, diagramKey("graph TD\nA-->C", '{"a":1}', "mmdc-12.2.0+abcd1234"));
  assert.notEqual(base, diagramKey("graph TD\nA-->B", '{"a":2}', "mmdc-12.2.0+abcd1234"));
  assert.notEqual(base, diagramKey("graph TD\nA-->B", '{"a":1}', "mmdc-12.2.0+abcd1235"));
  assert.equal(base, hash('mmdc-12.2.0+abcd1234\0{"a":1}\0graph TD\nA-->B'));
  // the parts cannot slide into each other
  assert.notEqual(diagramKey("b", "a", "v"), diagramKey("ab", "", "v"));
  assert.notEqual(diagramKey("x", "", "v1"), diagramKey("1x", "", "v"));
});
