// The slash menu: the commands it offers, which of them a query matches, where a typed `/` opens it, and how it
// follows the changes typed after it. Pure: no imports. Offsets are field offsets of the block being edited.

const MERMAID = ["```mermaid", "flowchart TD", "  A[Start] --> B[End]", "```"];
const TABLE = ["| Column 1 | Column 2 | Column 3 |", "| --- | --- | --- |", "|  |  |  |"];

// `to` turns the block being edited into another text block (`marker` is what typing it in an empty block writes);
// `lines` are a new block written where the slash was, with the field caret (or range) `caret` in it.
export const COMMANDS = [
  { id: "text", name: "Text", aliases: ["p", "paragraph", "text"], hint: "", icon: "type", to: { kind: "paragraph" } },
  { id: "h1", name: "Heading 1", aliases: ["h1", "heading", "#"], hint: "#", icon: "heading-1", to: { kind: "heading", level: 1 }, marker: "# " },
  { id: "h2", name: "Heading 2", aliases: ["h2", "heading", "##"], hint: "##", icon: "heading-2", to: { kind: "heading", level: 2 }, marker: "## " },
  { id: "h3", name: "Heading 3", aliases: ["h3", "heading", "###"], hint: "###", icon: "heading-3", to: { kind: "heading", level: 3 }, marker: "### " },
  { id: "ul", name: "Bulleted list", aliases: ["ul", "bullet", "list", "-"], hint: "-", icon: "list", to: { kind: "item", list: "bullet" }, marker: "- " },
  { id: "ol", name: "Numbered list", aliases: ["ol", "numbered", "1."], hint: "1.", icon: "list-ordered", to: { kind: "item", list: "ordered" }, marker: "1. " },
  { id: "todo", name: "To-do list", aliases: ["todo", "task", "checkbox", "[]"], hint: "[ ]", icon: "list-todo", to: { kind: "item", list: "task" }, marker: "- [ ] " },
  { id: "quote", name: "Quote", aliases: ["quote", ">"], hint: ">", icon: "text-quote", to: { kind: "quote" }, marker: "> " },
  { id: "code", name: "Code block", aliases: ["code", "fence", "```"], hint: "```", icon: "code", lines: ["```", "", "```"], caret: 4 },
  { id: "mermaid", name: "Mermaid diagram", aliases: ["mermaid", "diagram", "chart", "flowchart"], hint: "mermaid", icon: "workflow", lines: MERMAID, caret: MERMAID.slice(0, -1).join("\n").length },
  { id: "table", name: "Table", aliases: ["table"], hint: "|", icon: "table", lines: TABLE, caret: { start: 2, end: 10 } },
  { id: "hr", name: "Divider", aliases: ["hr", "divider", "---", "line"], hint: "---", icon: "minus", lines: ["---"] },
];

const words = name => name.split(/[\s-]+/);

const SPACE = /\s/;

// The commands for `query`, in tiers: a name or alias that starts with it, a word of the name that does, then a name
// or alias that holds it; the table's order within a tier. Any case; an empty query lists them all, and one that
// starts with a space none.
export function matches(query) {
  if (!query) return COMMANDS;
  if (SPACE.test(query[0])) return [];
  const q = query.toLowerCase(), tiers = [[], [], []];
  for (const c of COMMANDS) {
    const names = [c.name.toLowerCase(), ...c.aliases];
    if (names.some(n => n.startsWith(q))) tiers[0].push(c);
    else if (words(c.name.toLowerCase()).some(w => w.startsWith(q))) tiers[1].push(c);
    else if (names.some(n => n.includes(q))) tiers[2].push(c);
  }
  return tiers.flat();
}

// A `/` at field offset `at` opens the menu when it stands alone: at the start or after whitespace, before the end or
// whitespace, and outside a code span (an even number of backticks before it on its line).
export function opensAt(value, at) {
  if (value[at] !== "/") return false;
  if (at > 0 && !SPACE.test(value[at - 1])) return false;
  if (at + 1 < value.length && !SPACE.test(value[at + 1])) return false;
  const line = value.slice(value.lastIndexOf("\n", at - 1) + 1, at);
  return (line.split("`").length - 1) % 2 === 0;
}

const sameItems = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

// The menu after the field range [a, a + r) became `ins` and the field holds `value`, or null when that closes it.
// The menu is { at, end, query, items, index, first, ... }: [at, end) holds "/" + query.
export function track(menu, { a, r, ins }, value) {
  const grow = ins.length - r;
  let { at, end } = menu;
  if (a + r <= at) { at += grow; end += grow; }
  else if (a >= at + 1 && a + r <= end) end += grow;
  else return null;
  const query = value.slice(at + 1, end);
  if (value[at] !== "/" || query.includes("\n") || SPACE.test(query[0] ?? "")) return null;
  const items = matches(query);
  if (SPACE.test(ins) && !items.length) return null;
  const same = sameItems(items, menu.items);
  return { ...menu, at, end, query, items, index: same ? menu.index : 0, first: same ? menu.first : 0 };
}

// The first row drawn of n when `visible` of them fit, moved as little as it takes to show row `index`.
export function follow(first, index, visible, n) {
  const v = Math.max(1, Math.min(visible, n));
  const f = index < first ? index : index >= first + v ? index - v + 1 : first;
  return Math.max(0, Math.min(f, n - v));
}

// The highlight one row up (dir < 0) or down, wrapping, with the drawn window following it.
export function step(menu, dir, visible = menu.items.length) {
  const n = menu.items.length;
  if (!n) return menu;
  const index = (((menu.index + dir) % n) + n) % n;
  return { ...menu, index, first: follow(menu.first, index, visible, n) };
}
