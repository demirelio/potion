import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { state, calls, reset } from "./mocks/herdr.mjs";
import { space, pane } from "./helpers.mjs";

const { openMarkdown: original } = await import("../mods/my-markdown/open.js");

// The files integration carries a copy of openMarkdown, because mods cannot import each other. The copy is cut out
// of the lines its patch adds and loaded against the same mocks as the original.
const tmp = mkdtempSync(join(tmpdir(), "integrations-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const added = file => readFileSync(new URL(`../integrations/${file}`, import.meta.url), "utf8")
  .split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1)).join("\n");

async function copyIn(patch, name) {
  const lines = added(patch), start = lines.indexOf("function openMarkdown(");
  assert.ok(start >= 0, `${patch} adds openMarkdown`);
  const source = lines.slice(start, lines.indexOf("\n}\n", start) + 2);
  const file = join(tmp, `${name}.mjs`);
  writeFileSync(file, `import { spaces, panes, focused, shared, setShared, run } from "herdr";\n${source}\nexport { openMarkdown };\n`);
  return (await import(pathToFileURL(file).href)).openMarkdown;
}
const copies = [["files", await copyIn("files/files.patch", "files")]];

const ROOT = "/home/user/notes", REMOTE = "/home/dev/notes", FILE = `${ROOT}/README.md`;

function local() {
  state.spaces = [space("s1", "notes", { folder: ROOT, active: true })];
  state.panes = [pane("p1", "s1-tab", ROOT, { focused: true })];
  state.focused = { space: "s1", tab: "s1-tab", pane: "p1", terminal: "t-p1", shown: null, agent: null, cwd: ROOT };
}
function remote() {
  state.spaces = [space("c1", "devbox", { folder: REMOTE, machine: "devbox", active: true })];
  state.panes = [pane("p9", "c1-tab", REMOTE, { focused: true })];
  state.focused = { space: "c1", tab: "c1-tab", pane: "p9", terminal: "t-p9", shown: null, agent: null, cwd: REMOTE };
}
// Another space with a Markdown tab showing `file`, and the registry that says so.
function openElsewhere(file, machine = null) {
  local();
  state.spaces.push(space("s2", "other", { tabs: [{ id: "s2-t7", name: "README.md", active: true, zoomed: false, status: null }] }));
  state.panes.push(pane("p7", "s2-t7", null, { mod: "my-markdown", terminal: null }));
  state.shared["my-markdown.panes"] = { p7: `${machine ?? ""}:${file}` };
}
// A Markdown pane beside the focused terminal in the same tab, registered as showing `file` (unless `registered` is false).
function openBeside(file, machine = null, registered = true) {
  local();
  state.panes.push(pane("p7", "s1-tab", null, { mod: "my-markdown", terminal: null }));
  if (registered) state.shared["my-markdown.panes"] = { p7: `${machine ?? ""}:${file}` };
}

// What a mod asked of Herdr: the commands and the shared values it set.
const asked = () => JSON.parse(JSON.stringify({ run: calls.run, setShared: calls.setShared, shared: state.shared }));

const recent = { "my-markdown.recent": Array.from({ length: 30 }, (_, i) => ({ machine: i % 2 ? "devbox" : null, path: `/n/${i}.md` })) };
const undrawn = () => { openElsewhere(FILE); delete state.shared["my-markdown.panes"]; };
const CASES = [
  ["nothing open yet", local, FILE, {}],
  ["on another machine", remote, `${REMOTE}/deploy.md`, {}],
  ["the file is shown in another tab", () => openElsewhere(FILE), FILE, {}],
  ["shown elsewhere, on another machine's path", () => openElsewhere(FILE, "devbox"), FILE, {}],
  ["a stale registry entry", () => { openElsewhere(FILE); state.spaces.pop(); }, FILE, {}],
  ["an undrawn tab named after the file", undrawn, FILE, {}],
  ["two undrawn tabs named after the file", () => {
    undrawn();
    state.spaces[0].tabs.push({ id: "s1-t8", name: "README.md", active: false, zoomed: false, status: null });
    state.panes.push(pane("p8", "s1-t8", null, { mod: "my-markdown", terminal: null }));
  }, FILE, {}],
  ["a tab named after the file that shows another file", () => { openElsewhere(FILE); state.shared["my-markdown.panes"] = { p7: ":/elsewhere/README.md" }; }, FILE, {}],
  ["a terminal tab named after the file", () => { undrawn(); state.panes.pop(); state.panes.push(pane("p7", "s2-t7", ROOT)); }, FILE, {}],
  ["a tab named after the file with a terminal pane too", () => { undrawn(); state.panes.push(pane("p8", "s2-t7", ROOT)); }, FILE, {}],
  ["an undrawn tab on the other machine's path", () => { openElsewhere(FILE, "devbox"); delete state.shared["my-markdown.panes"]; }, FILE, {}],
  ["the file is shown in a pane of this tab", () => openBeside(FILE), FILE, {}],
  ["a pane of this tab that shows another file", () => openBeside(`${ROOT}/other.md`), FILE, {}],
  ["a pane of this tab that no one has filed yet", () => openBeside(FILE, null, false), FILE, {}],
  ["a pane of this tab showing the path on another machine", () => openBeside(FILE, "devbox"), FILE, {}],
  ["a registry entry for a pane that is gone", () => { local(); state.shared["my-markdown.panes"] = { p7: `:${FILE}` }; }, FILE, {}],
  ["the focused tab's first pane is the one to open beside", () => { local(); state.focused.pane = null; }, FILE, {}],
  ["no pane to open beside", () => { local(); state.panes = []; state.focused = null; }, FILE, {}],
  ["a full recent list", local, FILE, recent],
  ["the file is already recent", local, FILE, { "my-markdown.recent": [{ machine: null, path: "/x.md" }, { machine: null, path: FILE }] }],
];

for (const [integration, copy] of copies) {
  test(`the copy of openMarkdown in the ${integration} integration does what open.js in my-markdown does, for a pane and for a tab`, () => {
    const commands = new Set();
    for (const place of ["pane", "tab"]) {
      for (const [name, setup, file, shared] of CASES) {
        const args = { file, machine: file.startsWith(REMOTE) ? "devbox" : null, space: file.startsWith(REMOTE) ? "c1" : "s1", place };
        reset({ shared: structuredClone(shared) });
        setup();
        original(args);
        const expected = asked();
        expected.run.forEach(([command]) => commands.add(command));
        reset({ shared: structuredClone(shared) });
        setup();
        copy(args);
        assert.deepEqual(asked(), expected, `${place}: ${name}`);
      }
    }
    assert.deepEqual([...commands].sort(), ["pane.focus", "pane.split", "space.select", "tab.new", "tab.select"], "the cases reach every branch");
  });
}

test("the patches point at files of the Markdown mod, which exist, and at no other mod's", () => {
  let seen = 0;
  for (const file of ["tabs/tabs.patch", "files/files.patch", "pane-header/pane.patch", "new-menu/new-menu.patch"]) {
    for (const [path, mod] of added(file).matchAll(/mods\/([\w-]+)\/[\w.-]+/g)) {
      assert.equal(mod, "my-markdown", `${file} adds ${path}`);
      assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} is missing`);
      seen++;
    }
  }
  assert.ok(seen >= 4, `${seen} paths`);
});
