import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMANDS, matches, opensAt, track, step, follow } from "../mods/herdr-inline-markdown/slash.js";

const MOD = fileURLToPath(new URL("../mods/herdr-inline-markdown/", import.meta.url));
const ids = list => list.map(c => c.id);
const opened = { act: 1, at: 0, end: 1, query: "", items: COMMANDS, index: 0, first: 0, side: null };
// The menu after typing `typed` (one change per character) at the end of "/" in the field "<before>/".
function typing(before, typed) {
  let value = `${before}/`, menu = { ...opened, at: before.length, end: before.length + 1 };
  for (const ch of typed) {
    const a = value.length;
    value += ch;
    menu = menu && track(menu, { a, r: 0, ins: ch }, value);
  }
  return { menu, value };
}

test("the menu lists twelve commands in order, each with a name, aliases, a hint and an icon file that exists", () => {
  assert.deepEqual(ids(COMMANDS), ["text", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code", "mermaid", "table", "hr"]);
  assert.deepEqual(COMMANDS.map(c => c.name), ["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "To-do list", "Quote", "Code block", "Mermaid diagram", "Table", "Divider"]);
  assert.deepEqual(COMMANDS.map(c => c.hint), ["", "#", "##", "###", "-", "1.", "[ ]", ">", "```", "mermaid", "|", "---"]);
  for (const c of COMMANDS) {
    assert.ok(c.aliases.length > 0, c.id);
    assert.ok(existsSync(`${MOD}${c.icon}.svg`), `${c.icon}.svg`);
    assert.ok(Boolean(c.to) !== Boolean(c.lines), `${c.id} changes the block or adds lines`);
  }
  assert.deepEqual(COMMANDS.filter(c => c.to).map(c => [c.id, c.to, c.marker ?? ""]), [
    ["text", { kind: "paragraph" }, ""],
    ["h1", { kind: "heading", level: 1 }, "# "], ["h2", { kind: "heading", level: 2 }, "## "], ["h3", { kind: "heading", level: 3 }, "### "],
    ["ul", { kind: "item", list: "bullet" }, "- "], ["ol", { kind: "item", list: "ordered" }, "1. "], ["todo", { kind: "item", list: "task" }, "- [ ] "],
    ["quote", { kind: "quote" }, "> "],
  ]);
  const value = id => COMMANDS.find(c => c.id === id).lines.join("\n");
  const caretOf = id => COMMANDS.find(c => c.id === id).caret;
  assert.equal(value("code"), "```\n\n```");
  assert.equal(caretOf("code"), 4, "on the empty line");
  assert.equal(value("mermaid"), "```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```");
  assert.equal(caretOf("mermaid"), value("mermaid").length - 4, "at the end of the sample's last line");
  assert.equal(value("table"), "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |");
  assert.deepEqual(caretOf("table"), { start: 2, end: 10 });
  assert.equal(value("table").slice(2, 10), "Column 1");
  assert.deepEqual(COMMANDS.find(c => c.id === "hr").lines, ["---"]);
});

test("an empty query lists all twelve; a name, an alias, a word of the name, then anything containing the query", () => {
  assert.deepEqual(matches(""), COMMANDS);
  assert.deepEqual(ids(matches("h")).slice(0, 3), ["h1", "h2", "h3"], "the three headings first");
  assert.deepEqual(ids(matches("H2")), ["h2"], "any case");
  assert.deepEqual(ids(matches("list")), ["ul", "ol", "todo"]);
  assert.deepEqual(ids(matches("mer")), ["mermaid"]);
  assert.deepEqual(ids(matches("chart")), ["mermaid"]);
  assert.deepEqual(ids(matches("-")).slice(0, 2), ["ul", "hr"], "Bulleted then Divider");
  assert.deepEqual(ids(matches("1.")), ["ol"]);
  assert.deepEqual(ids(matches("#")), ["h1", "h2", "h3"], "a tie keeps the table order");
  assert.deepEqual(ids(matches("todo")), ["todo"]);
  assert.deepEqual(ids(matches("divider")), ["hr"]);
  assert.deepEqual(ids(matches("do")), ["todo"], "'do' starts a word of To-do list");
  assert.deepEqual(ids(matches("graph")), ["text"], "contained in an alias: paragraph");
  assert.deepEqual(ids(matches("gram")), ["mermaid"], "contained in an alias: diagram");
  assert.deepEqual(matches("zz"), []);
});

test("a query that starts with a space matches nothing", () => {
  assert.deepEqual(matches(" "), []);
  assert.deepEqual(matches(" h1"), []);
});

test("a slash opens the menu at the start of the field or after whitespace, followed by nothing or whitespace; not mid-word, not before a word, not inside a code span", () => {
  assert.equal(opensAt("/", 0), true);
  assert.equal(opensAt("Hello /", 6), true);
  assert.equal(opensAt("Hello / world", 6), true, "a space after it");
  assert.equal(opensAt("line one\n/", 9), true, "the start of a line");
  assert.equal(opensAt("a\t/", 2), true);
  assert.equal(opensAt("and/", 3), false, "mid-word");
  assert.equal(opensAt("/usr", 0), false, "before a word");
  assert.equal(opensAt("and /or", 4), false);
  assert.equal(opensAt("run `ls /", 8), false, "inside a code span");
  assert.equal(opensAt("run `ls` /", 9), true, "after a closed code span");
  assert.equal(opensAt("a `b`\nc `d /", 11), false, "the backticks of its own line count");
  assert.equal(opensAt("a `b\nc /", 7), true, "not those of the line above");
  assert.equal(opensAt("Hello x", 6), false, "no slash there");
});

test("typing at the query's end or middle grows it, Backspace shrinks it; an edit before the slash shifts it", () => {
  const { menu, value } = typing("Hello ", "h2");
  assert.deepEqual([menu.at, menu.end, menu.query, ids(menu.items)], [6, 9, "h2", ["h2"]]);
  const mid = track(menu, { a: 8, r: 0, ins: "x" }, "Hello /hx2");
  assert.deepEqual([mid.end, mid.query], [10, "hx2"]);
  const back = track(menu, { a: 8, r: 1, ins: "" }, "Hello /h");
  assert.deepEqual([back.end, back.query, ids(back.items).slice(0, 3)], [8, "h", ["h1", "h2", "h3"]]);
  const before = track(menu, { a: 0, r: 0, ins: "Oh " }, `Oh ${value}`);
  assert.deepEqual([before.at, before.end, before.query], [9, 12, "h2"]);
  const cut = track(menu, { a: 0, r: 2, ins: "" }, value.slice(2));
  assert.deepEqual([cut.at, cut.end, cut.query], [4, 7, "h2"]);
});

test("deleting the slash, an edit after the query, a newline, a leading space or a space with no match closes it", () => {
  const { menu, value } = typing("Hello ", "h2");
  assert.equal(track(menu, { a: 6, r: 1, ins: "" }, "Hello h2"), null, "the slash deleted");
  assert.equal(track(menu, { a: 5, r: 2, ins: "" }, "Hellh2"), null, "a range over the slash");
  assert.equal(track({ ...menu, end: 9 }, { a: 10, r: 0, ins: "x" }, `${value} x`), null, "after the query");
  assert.equal(track(menu, { a: 9, r: 0, ins: "\n" }, `${value}\n`), null, "a newline");
  assert.equal(typing("", " ").menu, null, "/ and a space");
  assert.equal(typing("", "zz ").menu, null, "a space after a query with no match");
  assert.deepEqual(ids(typing("", "zz").menu.items), [], "no match, no space: open on No results");
  assert.deepEqual(ids(typing("", "heading 2").menu.items), ["h2"], "a space inside a query that matches");
});

test("the highlight wraps on Up and Down, returns to the first row whenever the list changes, and the drawn window follows it", () => {
  let menu = opened;
  menu = step(menu, -1);
  assert.equal(menu.index, 11, "up from the first row: the last");
  menu = step(menu, 1);
  assert.equal(menu.index, 0, "down from the last row: the first");
  menu = step(step(menu, 1), 1);
  assert.equal(menu.index, 2);
  const same = track({ ...menu, query: "", end: 1 }, { a: 0, r: 0, ins: "" }, "/");
  assert.equal(same.index, 2, "the same list keeps the highlight");
  const h = track(menu, { a: 1, r: 0, ins: "h" }, "/h");
  assert.deepEqual([h.index, h.first], [0, 0], "a new list: back to the first row");
  let win = { ...opened, index: 0, first: 0 };
  for (let k = 0; k < 6; k++) win = step(win, 1, 4);
  assert.deepEqual([win.index, win.first], [6, 3], "four rows drawn: the window ends at the highlight");
  for (let k = 0; k < 5; k++) win = step(win, -1, 4);
  assert.deepEqual([win.index, win.first], [1, 1], "and starts at it going up");
  win = step({ ...win, index: 0, first: 0 }, -1, 4);
  assert.deepEqual([win.index, win.first], [11, 8], "wrapping up shows the last four");
  assert.equal(follow(5, 2, 4, 12), 2);
  assert.equal(follow(0, 3, 4, 12), 0);
  assert.equal(follow(9, 11, 4, 5), 1, "never past the end of a short list");
  assert.equal(step({ ...opened, items: [] }, 1).index, 0, "no rows: nothing moves");
});
