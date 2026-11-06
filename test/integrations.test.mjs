import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { state, calls, reset } from "./mocks/herdr.mjs";
import { space, pane } from "./helpers.mjs";

const { openMarkdown: original } = await import("../mods/herdr-inline-markdown/open.js");

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
  state.panes.push(pane("p7", "s2-t7", null, { mod: "herdr-inline-markdown", terminal: null }));
  state.shared["herdr-inline-markdown.panes"] = { p7: `${machine ?? ""}:${file}` };
}
// A Markdown pane beside the focused terminal in the same tab, registered as showing `file` (unless `registered` is false).
function openBeside(file, machine = null, registered = true) {
  local();
  state.panes.push(pane("p7", "s1-tab", null, { mod: "herdr-inline-markdown", terminal: null }));
  if (registered) state.shared["herdr-inline-markdown.panes"] = { p7: `${machine ?? ""}:${file}` };
}

const asked = () => JSON.parse(JSON.stringify({ run: calls.run, setShared: calls.setShared, shared: state.shared }));

const recent = { "herdr-inline-markdown.recent": Array.from({ length: 30 }, (_, i) => ({ machine: i % 2 ? "devbox" : null, path: `/n/${i}.md` })) };
const undrawn = () => { openElsewhere(FILE); delete state.shared["herdr-inline-markdown.panes"]; };
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
    state.panes.push(pane("p8", "s1-t8", null, { mod: "herdr-inline-markdown", terminal: null }));
  }, FILE, {}],
  ["a tab named after the file that shows another file", () => { openElsewhere(FILE); state.shared["herdr-inline-markdown.panes"] = { p7: ":/elsewhere/README.md" }; }, FILE, {}],
  ["a terminal tab named after the file", () => { undrawn(); state.panes.pop(); state.panes.push(pane("p7", "s2-t7", ROOT)); }, FILE, {}],
  ["a tab named after the file with a terminal pane too", () => { undrawn(); state.panes.push(pane("p8", "s2-t7", ROOT)); }, FILE, {}],
  ["an undrawn tab on the other machine's path", () => { openElsewhere(FILE, "devbox"); delete state.shared["herdr-inline-markdown.panes"]; }, FILE, {}],
  ["the file is shown in a pane of this tab", () => openBeside(FILE), FILE, {}],
  ["a pane of this tab that shows another file", () => openBeside(`${ROOT}/other.md`), FILE, {}],
  ["a pane of this tab that no one has filed yet", () => openBeside(FILE, null, false), FILE, {}],
  ["a pane of this tab showing the path on another machine", () => openBeside(FILE, "devbox"), FILE, {}],
  ["a registry entry for a pane that is gone", () => { local(); state.shared["herdr-inline-markdown.panes"] = { p7: `:${FILE}` }; }, FILE, {}],
  ["the focused tab's first pane is the one to open beside", () => { local(); state.focused.pane = null; }, FILE, {}],
  ["no pane to open beside", () => { local(); state.panes = []; state.focused = null; }, FILE, {}],
  ["a full recent list", local, FILE, recent],
  ["the file is already recent", local, FILE, { "herdr-inline-markdown.recent": [{ machine: null, path: "/x.md" }, { machine: null, path: FILE }] }],
];

for (const [integration, copy] of copies) {
  test(`the copy of openMarkdown in the ${integration} integration does what open.js in herdr-inline-markdown does, for a pane and for a tab`, () => {
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
      assert.equal(mod, "herdr-inline-markdown", `${file} adds ${path}`);
      assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} is missing`);
      seen++;
    }
  }
  assert.ok(seen >= 4, `${seen} paths`);
});

const lines = (file, mark) => readFileSync(new URL(`../integrations/${file}`, import.meta.url), "utf8")
  .split("\n").filter(l => l.startsWith(mark) && !l.startsWith(mark.repeat(3))).map(l => l.slice(1));

test("the tab-bar patch only marks Markdown tabs: it reads no key commands and opens no picker", () => {
  const plus = added("tabs/tabs.patch");
  assert.doesNotMatch(plus, /nextCommand|openOverlay|closeOverlay|markdownCommand|openPicker|markdown:(?:tab|pane)/);
  assert.match(plus, /\.every\(p => p\.mod === "herdr-inline-markdown"\)/, "a tab is a Markdown tab only when all its panes are");
  assert.match(plus, /\.when\(markdown, [^\n]*file-markdown\.svg/, "and only a Markdown tab gets the icon");
  assert.deepEqual(lines("tabs/tabs.patch", "-").map(l => l.trim().split(" = ")[0]), ["const name"], "the tab's name is the one line it changes");
});

test("the + menu row shows the key bound to mod.open of the mod, and opens the picker at the size mod.open does", () => {
  const plus = added("new-menu/new-menu.patch");
  assert.match(plus, /shortcut\("mod\.open:herdr-inline-markdown"\) \|\| "M"/);
  const [, kind, width, height] = /openOverlay\(\{ mod: "herdr-inline-markdown", kind: "(\w+)", width: (\d+), height: (\d+),/.exec(plus);
  const { overlay } = JSON.parse(readFileSync(new URL("../mods/herdr-inline-markdown/mod.json", import.meta.url), "utf8"));
  assert.deepEqual({ kind, width: Number(width), height: Number(height) }, overlay);
});

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else out.push(path);
  }
  return out;
}

test("the README and the integrations name no removed tab-bar commands", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const file of [...filesUnder(join(root, "integrations")), join(root, "README.md")]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /markdown:(?:tab|pane)|my-tabs\.markdown/, file);
  }
});

// The sha256 of Herdr 0.1.12's shipped main.js of each mod a patch changes. Herdr rewrites its shipped mods on every
// start, so the app home has them; the checks below skip any other version.
const SHIPPED = {
  tabs: "12d4ecc89dbf864d5a889f240adaea25590812e0be1835bbdb3e636fe14f51d3",
  files: "2fe03eaaaa494f2e42753097617ab6ac20c964ae671c7548cee67557cff08fe1",
  pane: "30df4c9b774414ca184b16f76c97c84f3cebd2ee411bea45c5c25b9d0ac65899",
  "new-menu": "394ec4218f24263735083b90dc7a7c5f607ab58f9a7a74b823707509e806cb1a",
};
const APP = process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app");
function shipped(mod) {
  const file = join(APP, "mods", mod, "main.js");
  const text = existsSync(file) ? readFileSync(file, "utf8") : null;
  return text !== null && createHash("sha256").update(text).digest("hex") === SHIPPED[mod] ? text : null;
}

// `text` as main.js in a scratch folder with `patches` applied in turn; fuzz 0 unless `fuzzy`.
function applied(text, patches, fuzzy = false) {
  const dir = mkdtempSync(join(tmp, "apply-"));
  writeFileSync(join(dir, "main.js"), text);
  const out = patches.map(patch => {
    const input = readFileSync(new URL(`../integrations/${patch}`, import.meta.url));
    const r = spawnSync("patch", ["-p1", "-d", dir, ...(fuzzy ? [] : ["-F", "0"])], { input, encoding: "utf8" });
    return { status: r.status, output: `${r.stdout}${r.stderr}`.trim() };
  });
  return { out, text: readFileSync(join(dir, "main.js"), "utf8") };
}

const PATCHES = [
  ["tabs", "tabs/tabs.patch", "my-tabs"],
  ["tabs", "new-menu/tabs-plus-button.patch", "my-tabs"],
  ["files", "files/files.patch", "my-files"],
  ["pane", "pane-header/pane.patch", "my-pane"],
  ["new-menu", "new-menu/new-menu.patch", "my-new-menu"],
];

for (const [mod, patch, clone] of PATCHES) {
  test(`${patch} applies to Herdr 0.1.12's ${mod} byte for byte, and to a clone named ${clone}`, t => {
    const text = shipped(mod);
    if (!text) return t.skip(`no Herdr 0.1.12 ${mod} in ${APP}`);
    assert.deepEqual(applied(text, [patch]).out, [{ status: 0, output: "patching file main.js" }], "no offset, no fuzz");
    // A clone rewrites its own mods/<name>/ asset paths, which a context line may hold.
    const [cloned] = applied(text.replaceAll(`mods/${mod}/`, `mods/${clone}/`), [patch], true).out;
    assert.equal(cloned.status, 0, cloned.output);
  });
}

test("the two tab-bar patches apply to one clone in either order, to the same file", t => {
  const text = shipped("tabs");
  if (!text) return t.skip(`no Herdr 0.1.12 tabs in ${APP}`);
  const one = applied(text, ["tabs/tabs.patch", "new-menu/tabs-plus-button.patch"], true);
  const other = applied(text, ["new-menu/tabs-plus-button.patch", "tabs/tabs.patch"], true);
  for (const r of [...one.out, ...other.out]) assert.equal(r.status, 0, r.output);
  assert.equal(one.text, other.text);
  assert.ok(one.text.includes("mods/herdr-inline-markdown/file-markdown.svg") && one.text.includes('mod: "my-new-menu"'));
});
