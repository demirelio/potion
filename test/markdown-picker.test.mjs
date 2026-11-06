import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { state, calls, reset } from "./mocks/herdr.mjs";
import { find, all, ids, textOf, fire } from "./mocks/element.mjs";
import { makeCx, fire_timers, space, must } from "./helpers.mjs";

const { Picker } = await import("../mods/herdr-inline-markdown/picker.js");
const { fileKey } = await import("../mods/herdr-inline-markdown/lib.js");
const { FIND_SCRIPT } = await import("../mods/herdr-inline-markdown/lib.js");

const FOLDER = "/home/user/Projects/herdr";
const NUL = list => list.map(p => `${p}\0`).join("");
const FILES = ["README.md", "docs/plan.md", "docs/notes/ideas.markdown", "src/app.js", "CHANGELOG.md", "package.json"];

// exec() for a folder: `git` is the files git lists, 128 for "not a repository", null for git not installed;
// `find` is what the plain search lists. Every call is also in calls.exec.
function fakeExec({ git = [], find: found = [], home = "/home/dev", mkdir = 0 } = {}) {
  return async (command, args, options) => {
    if (command === "git") {
      if (git === null) throw new Error("spawn git ENOENT");
      if (typeof git === "number") return { code: git, stdout: "", stderr: "fatal: not a git repository" };
      return { code: 0, stdout: NUL(git), stderr: "" };
    }
    if (command === "sh" && args[1] === FIND_SCRIPT) {
      if (found === null) return { code: 1, stdout: "", stderr: "find: permission denied" };
      return { code: 0, stdout: NUL(found), stderr: "" };
    }
    if (command === "sh" && args[1].includes("$HOME")) {
      if (home === null) throw new Error(`machine ${options.on} is unreachable`);
      return { code: 0, stdout: home, stderr: "" };
    }
    if (command === "mkdir") return { code: mkdir, stdout: "", stderr: mkdir ? "mkdir: Permission denied" : "" };
    throw new Error(`unexpected command ${command}`);
  };
}

beforeEach(() => reset({ spaces: [space("s1", "herdr", { folder: FOLDER, active: true })], exec: fakeExec({ git: FILES }) }));

// calls.order and calls.setShared are cleared after init, which names the dialog the open picker.
async function mount({ folder = FOLDER, machine = null, settle = true, props: extra = {} } = {}) {
  state.props = { action: "open", space: "s1", folder, machine, overlay: "ov-1", ...extra };
  const cx = makeCx(), view = new Picker();
  view.init(state.props, cx);
  calls.order.length = 0;
  calls.setShared.length = 0;
  if (settle) await cx.settle();
  return { view, cx, tree: () => view.render(cx) };
}
const rowIds = tree => ids(tree).filter(id => id.startsWith("mdp-") && /^mdp-(new|file-\d+|create)$/.test(id));
const row = (tree, id) => textOf(must(tree, id)).replace(/\s+/g, " ").trim();
const highlighted = tree => rowIds(tree).filter(id => must(tree, id).style.bg === "selected");
const press = (tree, key, cx = makeCx()) => { fire(must(tree, "mdp-root"), "on_key_down", { key, keystroke: key, modifiers: {} }, cx); return cx; };
const type = (view, text, cx = makeCx()) => view.input.edit(text, cx);

test("init: the input is focused now and again after 600 ms, and Up/Down/Escape come from the root's focus handle", async () => {
  const { view, cx, tree } = await mount();
  assert.equal(view.input.options.placeholder, "Find or create a markdown file…");
  assert.equal(view.input.focused, true);
  view.input.focused = false;
  assert.deepEqual(cx.timers.map(t => t.ms), [600]);
  await fire_timers(cx);
  assert.equal(view.input.focused, true, "the dialog opens while the old focus still settles");
  assert.equal(cx.handles.length, 1);
  assert.equal(must(tree(), "mdp-root").focus, cx.handles[0]);
  assert.ok(all(tree(), n => n.kind === "input").some(n => n.state === view.input), "the Input draws the state");
});

test("a closed dialog does not grab the focus when the timer fires", async () => {
  const { view, cx } = await mount();
  view.input.focused = false;
  view.close(cx);
  await fire_timers(cx);
  assert.equal(view.input.focused, false);
  assert.equal(cx.timers[0].cancelled, true);
});

const OPEN_PICKER = "herdr-inline-markdown.picker";

test("one picker at a time: a dialog names its overlay the open picker, and closes the one named before it", async () => {
  state.shared[OPEN_PICKER] = "ov-0";
  await mount();
  assert.equal(state.shared[OPEN_PICKER], "ov-1");
  assert.deepEqual(calls.closeOverlay, ["ov-0"]);
});

test("one picker at a time: a dialog that closes clears the name, unless a newer picker holds it by then", async () => {
  const first = await mount();
  first.view.close(first.cx);
  assert.equal(state.shared[OPEN_PICKER], null);
  const older = await mount();
  state.shared[OPEN_PICKER] = "ov-2";
  older.view.close(older.cx);
  assert.equal(state.shared[OPEN_PICKER], "ov-2", "Herdr calls close() after the newer picker has started");
});

test("one picker at a time: a dialog that is already the named one, or has no overlay, closes nothing", async () => {
  state.shared[OPEN_PICKER] = "ov-1";
  await mount();
  assert.deepEqual(calls.closeOverlay, []);
  state.props = undefined;
  const cx = makeCx(), view = new Picker();
  view.init({ action: "open", space: "s1", folder: FOLDER }, cx);
  view.close(cx);
  assert.deepEqual(calls.closeOverlay, []);
  assert.equal(state.shared[OPEN_PICKER], "ov-1", "a picker outside an overlay is not the open one");
});

test("one picker at a time: a name Herdr no longer has (left by a quit) is passed over, even when closing it throws", async () => {
  state.shared[OPEN_PICKER] = "ov-gone";
  state.closeOverlay = id => { if (id === "ov-gone") throw new Error("no overlay ov-gone"); return null; };
  const { view } = await mount();
  assert.equal(state.shared[OPEN_PICKER], "ov-1");
  assert.equal(view.loading, false, "the dialog started all the same");
});

test("a repository is listed by git, markdown files only, the folder as cwd, this computer without a machine", async () => {
  const { tree } = await mount();
  const git = calls.exec.filter(c => c.command === "git");
  assert.equal(git.length, 1);
  assert.deepEqual(git[0].args, ["ls-files", "-co", "--exclude-standard", "-z"]);
  assert.deepEqual(git[0].options, { cwd: FOLDER, on: null });
  assert.equal(calls.exec.some(c => c.command === "sh"), false, "git answered, no search");
  assert.deepEqual(rowIds(tree()), ["mdp-new", "mdp-file-0", "mdp-file-1", "mdp-file-2", "mdp-file-3"]);
  assert.equal(row(tree(), "mdp-file-0"), "README.md");
  assert.equal(row(tree(), "mdp-file-1"), "plan.md docs");
  assert.equal(row(tree(), "mdp-file-2"), "ideas.markdown docs/notes");
  assert.equal(row(tree(), "mdp-new"), "New note untitled.md");
  assert.equal(find(tree(), "mdp-status"), null, "nothing to say once listed");
});

test("outside a repository the plain search lists, in the same folder", async () => {
  state.exec = fakeExec({ git: 128, find: ["a.md", "deep/b.mdx"] });
  const { tree } = await mount();
  const search = calls.exec.filter(c => c.command === "sh");
  assert.equal(search.length, 1);
  assert.deepEqual(search[0].args, ["-c", FIND_SCRIPT]);
  assert.deepEqual(search[0].options, { cwd: FOLDER, on: null });
  assert.deepEqual(rowIds(tree()), ["mdp-new", "mdp-file-0", "mdp-file-1"]);
  assert.equal(row(tree(), "mdp-file-1"), "b.mdx deep");
});

test("git that cannot start falls back to the search too", async () => {
  state.exec = fakeExec({ git: null, find: ["a.md"] });
  const { tree } = await mount();
  assert.deepEqual(rowIds(tree()), ["mdp-new", "mdp-file-0"]);
});

test("while listing the dialog says so, then says when there is nothing", async () => {
  let finish;
  state.exec = () => new Promise(resolve => { finish = resolve; });
  const { view, cx, tree } = await mount({ settle: false });
  assert.equal(textOf(must(tree(), "mdp-status")).trim(), "Looking for markdown files…");
  assert.deepEqual(rowIds(tree()), ["mdp-new"], "New note is there from the start");
  finish({ code: 0, stdout: "", stderr: "" });
  await cx.settle();
  assert.equal(textOf(must(tree(), "mdp-status")).trim(), "No markdown files here");
  assert.equal(view.loading, false);
  type(view, "x");
  assert.equal(find(tree(), "mdp-status"), null, "a query with no matches is not 'no files here'");
});

test("a folder that cannot be listed shows why, with New note still offered", async () => {
  state.exec = fakeExec({ git: 128, find: null });
  const { tree } = await mount();
  assert.equal(textOf(must(tree(), "mdp-status")).trim(), "Can't list this folder: find: permission denied");
  assert.equal(must(tree(), "mdp-status").style.text_color, "blocked");
  assert.deepEqual(rowIds(tree()), ["mdp-new"]);
});

test("no folder, no focused pane and a space with no folder means this computer's home folder", async () => {
  reset({ spaces: [space("s1", "herdr", { folder: "", active: true })], exec: fakeExec({ git: FILES }) });
  const { tree } = await mount({ folder: null });
  assert.equal(calls.exec[0].options.cwd, "/home/user");
  assert.match(textOf(must(tree(), "mdp-footer")), /~$/);
  await mount({ folder: "" });
  assert.equal(calls.exec.at(-1).options.cwd, "/home/user");
});

test("the footer has the key hints and the folder with ~", async () => {
  const { tree } = await mount({ folder: `${FOLDER}/` });
  const footer = textOf(must(tree(), "mdp-footer"));
  assert.ok(footer.includes("↑↓ to move · ↵ to open in a new tab · esc to close"));
  assert.ok(footer.endsWith("~/Projects/herdr"), footer);
  assert.equal(calls.exec[0].options.cwd, FOLDER, "a trailing slash is dropped");
});

test("the footer's key hint says where Enter opens the file: beside for a pane, in a new tab for a tab, a tab for anything else", async () => {
  const hint = async place => textOf(must((await mount({ props: { place } })).tree(), "mdp-footer"));
  assert.ok((await hint("pane")).includes("↑↓ to move · ↵ to open beside · esc to close"));
  assert.ok((await hint("tab")).includes("↑↓ to move · ↵ to open in a new tab · esc to close"));
  for (const odd of [undefined, "", "split", 3, "PANE"]) assert.ok((await hint(odd)).includes("↵ to open in a new tab"), String(odd));
});

const FOCUS = { space: "s1", tab: "s1-tab", terminal: null, shown: null, agent: null };
const focusPane = (pane, cwd = null) => { state.focused = { ...FOCUS, pane, cwd }; };
const termPane = (pane, cwd) => ({ pane, terminal: `t-${pane}`, tab: "s1-tab", cwd, focused: true });
const mdPaneIn = pane => ({ pane, terminal: null, tab: "s1-tab", cwd: null, focused: true, mod: "herdr-inline-markdown" });
const lookedIn = () => calls.exec.find(c => c.command === "git").options;

test("no folder: the folder of the Markdown file the focused pane shows, on that file's machine", async () => {
  state.panes = [termPane("p1", "/home/user/elsewhere"), mdPaneIn("p2")];
  state.shared["herdr-inline-markdown.panes"] = { p2: ":/home/user/notes/deep/plan.md" };
  focusPane("p2");
  const { tree } = await mount({ folder: null });
  assert.deepEqual([lookedIn().cwd, lookedIn().on], ["/home/user/notes/deep", null]);
  assert.ok(textOf(must(tree(), "mdp-footer")).endsWith("~/notes/deep"));

  state.shared["herdr-inline-markdown.panes"] = { p2: "devbox:/home/dev/Work/plan.md" };
  state.exec = fakeExec({ git: ["a.md"], home: "/home/dev" });
  calls.exec.length = 0;
  const remote = await mount({ folder: null });
  assert.deepEqual([lookedIn().cwd, lookedIn().on], ["/home/dev/Work", "devbox"]);
  assert.ok(textOf(must(remote.tree(), "mdp-footer")).endsWith("devbox: ~/Work"));
});

test("no folder: a file at the top of the file system is looked at in /", async () => {
  state.panes = [mdPaneIn("p2")];
  state.shared["herdr-inline-markdown.panes"] = { p2: ":/README.md" };
  focusPane("p2");
  await mount({ folder: null });
  assert.equal(lookedIn().cwd, "/");
});

test("no folder: a registry entry that is not an absolute path is no file; the pane's folder, then the focus's, then the space's are used", async () => {
  state.panes = [mdPaneIn("p2")];
  focusPane("p2", "/home/user/from-focus");
  for (const key of ["devbox:relative/a.md", "garbage", ":", "", 7]) {
    state.shared["herdr-inline-markdown.panes"] = { p2: key };
    calls.exec.length = 0;
    await mount({ folder: null });
    assert.equal(lookedIn().cwd, "/home/user/from-focus", JSON.stringify(key));
  }
  state.shared["herdr-inline-markdown.panes"] = {};
  focusPane("p2", null);
  calls.exec.length = 0;
  await mount({ folder: null });
  assert.equal(lookedIn().cwd, FOLDER, "nothing about the pane: the space's folder");
});

test("no folder: a Markdown pane the registry does not know yet is not a file; a terminal pane gives its own folder", async () => {
  state.panes = [mdPaneIn("p2"), termPane("p1", "/home/user/pane-cwd")];
  focusPane("p2", "/home/user/focus-cwd");
  await mount({ folder: null });
  assert.equal(lookedIn().cwd, "/home/user/focus-cwd", "the mod pane has no folder of its own");
  focusPane("p1", "/home/user/focus-cwd");
  calls.exec.length = 0;
  await mount({ folder: null });
  assert.equal(lookedIn().cwd, "/home/user/pane-cwd", "the pane's folder is the live one");
});

test("no folder: a registry entry on a pane that is not a Markdown pane is not read", async () => {
  state.panes = [termPane("p1", "/home/user/pane-cwd")];
  state.shared["herdr-inline-markdown.panes"] = { p1: ":/home/user/notes/plan.md" };
  focusPane("p1");
  await mount({ folder: null });
  assert.equal(lookedIn().cwd, "/home/user/pane-cwd");
});

test("no folder: the space's machine is the machine, and its folder (or its home) the folder", async () => {
  state.exec = fakeExec({ git: ["a.md"], home: "/home/dev" });
  state.spaces = [space("s1", "remote", { folder: "/home/dev/Work", machine: "devbox", active: true })];
  await mount({ folder: null });
  assert.deepEqual([lookedIn().cwd, lookedIn().on], ["/home/dev/Work", "devbox"]);
  state.spaces = [space("s1", "remote", { folder: "", machine: "devbox", active: true })];
  calls.exec.length = 0;
  await mount({ folder: null });
  assert.deepEqual([lookedIn().cwd, lookedIn().on], ["/home/dev", "devbox"], "empty: that machine's home");
});

test("no folder and no space at all: this computer's home folder", async () => {
  reset({ exec: fakeExec({ git: FILES }) });
  await mount({ folder: null, props: { space: undefined } });
  assert.deepEqual([lookedIn().cwd, lookedIn().on], ["/home/user", null]);
});

test("a folder in the props wins over the focused Markdown pane, with the machine the props give", async () => {
  state.panes = [mdPaneIn("p2")];
  state.shared["herdr-inline-markdown.panes"] = { p2: "devbox:/home/dev/Work/plan.md" };
  focusPane("p2", "/home/user/focus-cwd");
  await mount({ folder: "/home/user/given" });
  assert.deepEqual([lookedIn().cwd, lookedIn().on], ["/home/user/given", null], "no machine in the props: this computer");
  state.exec = fakeExec({ git: ["a.md"], home: "/home/dev" });
  calls.exec.length = 0;
  await mount({ folder: "/srv/docs", machine: "devbox" });
  assert.deepEqual([lookedIn().cwd, lookedIn().on], ["/srv/docs", "devbox"]);
});

test("recent files of this machine come first, inside the folder relative to it, outside with ~, once each", async () => {
  state.shared["herdr-inline-markdown.recent"] = [
    { machine: null, path: "/home/user/notes/todo.md" },
    { machine: "devbox", path: `${FOLDER}/other-machine.md` },
    { machine: null, path: `${FOLDER}/docs/plan.md` },
    { machine: null, path: "/etc/motd.md" },
    { machine: null, path: `${FOLDER}/gone.md` },
  ];
  const { tree } = await mount();
  const names = rowIds(tree()).slice(1).map(id => row(tree(), id));
  assert.deepEqual(names, [
    "todo.md ~/notes recent", "plan.md docs recent", "motd.md /etc recent", "gone.md recent",
    "README.md", "ideas.markdown docs/notes", "CHANGELOG.md",
  ], "plan.md is in the list too, but only once; the other machine's file is not here");
});

test("recent files show while the folder is still being listed", async () => {
  state.shared["herdr-inline-markdown.recent"] = [{ machine: null, path: `${FOLDER}/docs/plan.md` }];
  state.exec = () => new Promise(() => {});
  const { tree } = await mount({ settle: false });
  assert.deepEqual(rowIds(tree()), ["mdp-new", "mdp-file-0"]);
  assert.equal(row(tree(), "mdp-file-0"), "plan.md docs recent");
});

test("a file already open in a pane of the focused tab says open, and the highlight starts on the first file that is not", async () => {
  state.shared["herdr-inline-markdown.recent"] = [{ machine: null, path: `${FOLDER}/docs/plan.md` }, { machine: null, path: "/home/user/notes/todo.md" }];
  state.shared["herdr-inline-markdown.panes"] = { pm: fileKey(null, `${FOLDER}/docs/plan.md`), elsewhere: fileKey(null, "/home/user/notes/todo.md") };
  state.panes = [
    { pane: "p1", terminal: "t-p1", tab: "tb1", cwd: FOLDER, focused: false },
    { pane: "pm", terminal: null, tab: "tb1", cwd: null, focused: true, mod: "herdr-inline-markdown" },
    { pane: "elsewhere", terminal: null, tab: "tb2", cwd: null, focused: false, mod: "herdr-inline-markdown" },
  ];
  state.focused = { space: "s1", tab: "tb1", pane: "pm", terminal: null, shown: null, agent: null, cwd: null };
  const { tree } = await mount({ props: { place: "pane" } });
  assert.equal(row(tree(), "mdp-file-0"), "plan.md docs open", "open beside already: choosing it goes to that pane");
  assert.equal(row(tree(), "mdp-file-1"), "todo.md ~/notes recent", "open in another tab only: still a recent file here");
  assert.deepEqual(highlighted(tree()), ["mdp-file-1"], "Enter opens a file that is not on screen yet");
});

test("with every listed file already open in the tab, the highlight stays on the first file", async () => {
  state.shared["herdr-inline-markdown.recent"] = [{ machine: null, path: `${FOLDER}/docs/plan.md` }];
  state.shared["herdr-inline-markdown.panes"] = { pm: fileKey(null, `${FOLDER}/docs/plan.md`) };
  state.panes = [{ pane: "pm", terminal: null, tab: "tb1", cwd: null, focused: true, mod: "herdr-inline-markdown" }];
  state.focused = { space: "s1", tab: "tb1", pane: "pm", terminal: null, shown: null, agent: null, cwd: null };
  state.exec = async () => ({ code: 0, stdout: "", stderr: "" });
  const { tree } = await mount();
  assert.deepEqual(highlighted(tree()), ["mdp-file-0"]);
});

test("the highlight starts on the first file so Enter opens it; New note is above it", async () => {
  const { tree } = await mount();
  assert.deepEqual(highlighted(tree()), ["mdp-file-0"]);
});

test("typing filters by the path, best match first, and Create appears for a name that is not listed", async () => {
  const { view, tree } = await mount();
  type(view, "plan");
  assert.deepEqual(rowIds(tree()), ["mdp-new", "mdp-file-0", "mdp-create"]);
  assert.equal(row(tree(), "mdp-file-0"), "plan.md docs");
  assert.equal(row(tree(), "mdp-create"), "Create plan.md");
  assert.deepEqual(highlighted(tree()), ["mdp-file-0"]);

  type(view, "docs/notes/ideas");
  assert.equal(row(tree(), "mdp-file-0"), "ideas.markdown docs/notes");

  type(view, "readme");
  assert.equal(row(tree(), "mdp-file-0"), "README.md");

  type(view, "zzz");
  assert.deepEqual(rowIds(tree()), ["mdp-new", "mdp-create"]);
  assert.deepEqual(highlighted(tree()), ["mdp-create"], "with no file to open the highlight is on Create");
});

test("no Create row when the query names a listed file (any case), or has no usable name", async () => {
  const { view, tree } = await mount();
  type(view, "readme.md");
  assert.equal(find(tree(), "mdp-create"), null);
  type(view, "DOCS/PLAN");
  assert.equal(find(tree(), "mdp-create"), null, "docs/plan.md is the name this query makes");
  type(view, "docs/plan.mdx");
  assert.equal(row(tree(), "mdp-create"), "Create docs/plan.mdx");
  type(view, "   ");
  assert.equal(find(tree(), "mdp-create"), null);
  assert.equal(find(tree(), "mdp-note"), null);

  type(view, "../x");
  assert.equal(find(tree(), "mdp-create"), null);
  assert.equal(textOf(must(tree(), "mdp-note")).trim(), "A name can't go up with ..");
  type(view, "docs/");
  assert.equal(find(tree(), "mdp-create"), null);
  assert.equal(find(tree(), "mdp-note"), null, "files match 'docs/', so the hint stays quiet");
});

test("a recent file outside the folder does not count as the listed file a Create name would clash with", async () => {
  state.shared["herdr-inline-markdown.recent"] = [{ machine: null, path: "/home/user/x.md" }];
  const { view, tree } = await mount();
  type(view, "~/x.md");
  assert.equal(row(tree(), "mdp-file-0"), "x.md ~ recent");
  assert.equal(row(tree(), "mdp-create"), "Create ~/x.md");
});

test("Down and Up move the highlight and wrap around, stopping the key", async () => {
  const { view, tree } = await mount();
  type(view, "md"); // four files match, and "md" is not a listed name, so Create is last
  const rows = rowIds(tree());
  assert.deepEqual(rows, ["mdp-new", "mdp-file-0", "mdp-file-1", "mdp-file-2", "mdp-file-3", "mdp-create"]);
  const start = rows.indexOf(highlighted(tree())[0]);
  const cx = press(tree(), "down");
  assert.equal(cx.stopped, 1);
  assert.deepEqual(highlighted(tree()), [rows[start + 1]]);
  for (let i = start + 1; i < rows.length - 1; i++) press(tree(), "down");
  assert.deepEqual(highlighted(tree()), [rows.at(-1)]);
  press(tree(), "down");
  assert.deepEqual(highlighted(tree()), [rows[0]], "past the last row it wraps to New note");
  press(tree(), "up");
  assert.deepEqual(highlighted(tree()), [rows.at(-1)], "and back");
  press(tree(), "up");
  assert.deepEqual(highlighted(tree()), [rows.at(-2)]);
});

test("typing puts the highlight back on the first match", async () => {
  const { view, tree } = await mount();
  press(tree(), "down");
  press(tree(), "down");
  assert.deepEqual(highlighted(tree()), ["mdp-file-2"]);
  type(view, "c");
  assert.equal(highlighted(tree())[0], rowIds(tree()).find(id => id.startsWith("mdp-file-")));
});

test("the mouse moving over a row highlights it; a row that only appears under a still mouse does not", async () => {
  const { tree } = await mount();
  const cx = makeCx();
  fire(must(tree(), "mdp-file-2"), "on_mouse_move", {}, cx);
  assert.deepEqual(highlighted(tree()), ["mdp-file-2"]);
  assert.equal(cx.notified, 1);
  fire(must(tree(), "mdp-file-2"), "on_mouse_move", {}, cx);
  assert.equal(cx.notified, 1, "no repaint when nothing changed");
  assert.equal(find(tree(), "mdp-new").handlers.on_hover, undefined, "on_hover would fire when a list scrolls under the mouse");
});

test("Enter opens the highlighted file: the dialog closes first, then a Markdown tab opens in the space", async () => {
  const { view, cx } = await mount();
  view.input.submit(cx);
  assert.deepEqual(calls.closeOverlay, ["ov-1"]);
  assert.deepEqual(calls.run, [["tab.new", { name: "README.md", space: "s1", mod: "herdr-inline-markdown", props: { file: `${FOLDER}/README.md`, machine: null } }]]);
  assert.deepEqual(calls.order, ["closeOverlay", "run", "setShared"]);
  assert.equal(calls.setShared[0][0], "herdr-inline-markdown.recent");
  assert.deepEqual(calls.setShared[0][1], [{ machine: null, path: `${FOLDER}/README.md` }]);
  assert.equal(calls.writeTextFile.length, 0, "opening writes nothing");
});

test("Enter after moving down opens that row; a click opens the row clicked", async () => {
  const { view, cx, tree } = await mount();
  press(tree(), "down");
  view.input.submit(cx);
  assert.equal(calls.run[0][1].name, "plan.md");
  assert.equal(calls.run[0][1].props.file, `${FOLDER}/docs/plan.md`);

  reset({ spaces: [space("s1", "herdr", { folder: FOLDER, active: true })], exec: fakeExec({ git: FILES }) });
  const second = await mount();
  fire(must(second.tree(), "mdp-file-2"), "on_click", {}, makeCx());
  assert.equal(calls.run[0][1].props.file, `${FOLDER}/docs/notes/ideas.markdown`);
  assert.deepEqual(calls.order.slice(0, 2), ["closeOverlay", "run"]);
});

test("a file already open in a tab of its own is switched to, not opened twice", async () => {
  state.shared["herdr-inline-markdown.panes"] = { p1: `:${FOLDER}/README.md` };
  state.panes = [{ pane: "p1", terminal: null, tab: "s1-tab", cwd: null, focused: false, mod: "herdr-inline-markdown" }];
  const { view, cx } = await mount({ props: { place: "tab" } });
  view.input.submit(cx);
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "s1-tab" }]]);
  assert.deepEqual(calls.order.slice(0, 3), ["closeOverlay", "run", "run"]);
});

test("with no space in the props the tab opens in the active space, and without one when there is none", async () => {
  const first = await mount({ props: { space: undefined } });
  first.view.input.submit(first.cx);
  assert.equal(calls.run[0][1].space, "s1");

  reset({ exec: fakeExec({ git: FILES }) });
  const none = await mount({ props: { space: undefined } });
  none.view.input.submit(none.cx);
  assert.equal("space" in calls.run[0][1], false);
});

test("the space in the props is the space the file opens in, whichever space is active", async () => {
  state.spaces = [space("s1", "herdr", { folder: FOLDER, active: true }), space("s2", "other", { folder: "/tmp" })];
  const { view, cx } = await mount({ props: { space: "s2" } });
  view.input.submit(cx);
  assert.equal(calls.run[0][1].space, "s2");
});

test("place pane: Enter closes the dialog, then opens the file in a pane to the right of the pane that was focused", async () => {
  state.spaces = [space("s1", "herdr", { folder: FOLDER, active: true })];
  state.panes = [termPane("p1", FOLDER), termPane("p2", FOLDER)];
  focusPane("p2", FOLDER);
  const { view, cx } = await mount({ props: { place: "pane" } });
  view.input.submit(cx);
  assert.deepEqual(calls.closeOverlay, ["ov-1"]);
  assert.deepEqual(calls.run, [["pane.split", { direction: "right", pane: "p2", mod: "herdr-inline-markdown", props: { file: `${FOLDER}/README.md`, machine: null } }]]);
  assert.deepEqual(calls.order, ["closeOverlay", "run", "setShared"]);
  assert.deepEqual(calls.setShared[0], ["herdr-inline-markdown.recent", [{ machine: null, path: `${FOLDER}/README.md` }]]);
});

test("place pane: the anchor is the pane focused when the dialog opened, not the one focused when a file is chosen", async () => {
  state.panes = [termPane("p1", FOLDER), termPane("p2", FOLDER)];
  focusPane("p1", FOLDER);
  const { view, cx } = await mount({ props: { place: "pane" } });
  focusPane("p2", FOLDER);
  view.input.submit(cx);
  assert.equal(calls.run[0][1].pane, "p1");
});

test("place pane: a click on a row opens that file beside the pane too, and a file the tab shows already gets the focus", async () => {
  state.panes = [termPane("p1", FOLDER), mdPaneIn("p2")];
  state.shared["herdr-inline-markdown.panes"] = { p2: `:${FOLDER}/docs/plan.md` };
  focusPane("p1", FOLDER);
  const { tree } = await mount({ props: { place: "pane" } });
  fire(must(tree(), "mdp-file-1"), "on_click", {}, makeCx());
  assert.deepEqual(calls.run, [["pane.focus", { pane: "p2" }]]);
  assert.deepEqual(calls.order.slice(0, 2), ["closeOverlay", "run"]);
  calls.run.length = 0;
  fire(must(tree(), "mdp-file-2"), "on_click", {}, makeCx());
  assert.equal(calls.run[0][0], "pane.split");
  assert.equal(calls.run[0][1].props.file, `${FOLDER}/docs/notes/ideas.markdown`);
});

test("place pane: with no focused pane to open beside, the file opens as a tab", async () => {
  const { view, cx } = await mount({ props: { place: "pane" } });
  view.input.submit(cx);
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("place pane: a note made here opens beside the pane, and so does a listed file on another machine", async () => {
  state.panes = [termPane("p1", FOLDER)];
  focusPane("p1", FOLDER);
  const { tree } = await mount({ props: { place: "pane" } });
  fire(must(tree(), "mdp-new"), "on_click", {}, makeCx());
  await new Promise(done => setImmediate(done));
  assert.deepEqual(calls.run, [["pane.split", { direction: "right", pane: "p1", mod: "herdr-inline-markdown", props: { file: `${FOLDER}/untitled.md`, machine: null } }]]);

  reset({ spaces: [space("s1", "herdr", { folder: FOLDER, active: true })], exec: fakeExec({ git: ["a.md"], home: "/home/dev" }) });
  state.panes = [termPane("p1", "/home/dev/Work")];
  focusPane("p1");
  const remote = await mount({ folder: "/home/dev/Work", machine: "devbox", props: { place: "pane" } });
  remote.view.input.submit(remote.cx);
  assert.deepEqual(calls.run, [["pane.split", { direction: "right", pane: "p1", mod: "herdr-inline-markdown", props: { file: "/home/dev/Work/a.md", machine: "devbox" } }]]);
});

test("place tab never splits, whatever pane is focused", async () => {
  state.panes = [termPane("p1", FOLDER)];
  focusPane("p1", FOLDER);
  const { view, cx } = await mount({ props: { place: "tab" } });
  view.input.submit(cx);
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("Escape closes the dialog and nothing else", async () => {
  const { tree } = await mount();
  const cx = press(tree(), "escape");
  assert.deepEqual(calls.closeOverlay, ["ov-1"]);
  assert.deepEqual(calls.run, []);
  assert.equal(cx.stopped, 1);
});

test("other keys are left to the input", async () => {
  const { tree } = await mount();
  const cx = press(tree(), "a");
  assert.equal(cx.stopped, 0);
  assert.deepEqual(calls.closeOverlay, []);
});

test("close() while the folder is being listed: the answer does not redraw the closed dialog, and a waiting creation still goes on", async () => {
  let answer;
  state.exec = (command, args, options) => (command === "git" ? new Promise(done => { answer = done; }) : fakeExec({ git: FILES })(command, args, options));
  const { view, cx } = await mount({ settle: false });
  await new Promise(done => setImmediate(done));
  view.close(cx);
  const before = cx.notified;
  answer({ code: 0, stdout: NUL(FILES), stderr: "" });
  await cx.settle();
  assert.equal(view.loading, false, "the listing is kept");
  assert.equal(cx.notified, before);
  await view.ready; // resolved: a creation that was waiting for the listing is not stuck
});

test("close() while a note is being made: it is still opened, and the closed dialog is not redrawn", async () => {
  let land;
  state.writeTextFile = (path, text) => new Promise(done => { land = () => { state.disk.set(path, text); done(null); }; });
  const { view, tree } = await mount();
  const cx = makeCx();
  fire(must(tree(), "mdp-new"), "on_click", {}, cx);
  await new Promise(done => setImmediate(done));
  view.close(cx);
  const before = cx.notified;
  land();
  await cx.settle();
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"], "what was started is finished");
  assert.equal(view.busy, false);
  assert.equal(cx.notified, before);
});

test("a failed creation after close() does not redraw either", async () => {
  state.writeTextFile = async () => { throw new Error("EACCES"); };
  const { view, tree } = await mount();
  const cx = makeCx();
  fire(must(tree(), "mdp-new"), "on_click", {}, cx);
  view.close(cx);
  const before = cx.notified;
  await cx.settle();
  assert.match(view.problem, /Can't create/);
  assert.equal(cx.notified, before);
});

test("an open dialog still redraws when the listing or a creation answers", async () => {
  const { view, cx: listing, tree } = await mount();
  assert.ok(listing.notified > 0, "the listing redrew the dialog");
  const cx = makeCx();
  state.writeTextFile = async () => { throw new Error("EACCES"); };
  fire(must(tree(), "mdp-new"), "on_click", {}, cx);
  await cx.settle();
  assert.ok(cx.notified > 0, "the failed creation redrew the dialog");
  assert.match(textOf(must(view.render(cx), "mdp-note")), /Can't create/);
});

test("New note makes the first free untitled name in the folder's top level, closes, then opens it", async () => {
  state.exec = fakeExec({ git: ["untitled.md", "untitled-2.md", "docs/untitled-3.md", "README.md"] });
  state.writeTextFile = async (path, text, expected) => { calls.order.push("write"); state.disk.set(path, text); return null; };
  const { tree } = await mount();
  assert.equal(row(tree(), "mdp-new"), "New note untitled-3.md", "docs/untitled-3.md is another folder's");
  const cx = makeCx();
  fire(must(tree(), "mdp-new"), "on_click", {}, cx);
  await cx.settle();
  assert.deepEqual(calls.writeTextFile, [{ path: `${FOLDER}/untitled-3.md`, text: "", expected: null }]);
  assert.deepEqual(calls.order, ["write", "closeOverlay", "run", "setShared"]);
  assert.deepEqual(calls.run[0][1], { name: "untitled-3.md", space: "s1", mod: "herdr-inline-markdown", props: { file: `${FOLDER}/untitled-3.md`, machine: null } });
  assert.equal(calls.exec.some(c => c.command === "mkdir"), false, "a name without folders needs no mkdir");
});

test("Create <name> with folders makes them first (mkdir -p), then the empty file, then opens it", async () => {
  state.exec = async (command, args, options) => { calls.order.push(command); return fakeExec({ git: FILES })(command, args, options); };
  const { view, cx, tree } = await mount();
  type(view, "ideas/2026/plan");
  assert.equal(row(tree(), "mdp-create"), "Create ideas/2026/plan.md");
  calls.order.length = 0;
  fire(must(tree(), "mdp-create"), "on_click", {}, cx);
  await cx.settle();
  const mkdir = calls.exec.find(c => c.command === "mkdir");
  assert.deepEqual(mkdir.args, ["-p", `${FOLDER}/ideas/2026`]);
  assert.deepEqual(calls.writeTextFile, [{ path: `${FOLDER}/ideas/2026/plan.md`, text: "", expected: null }]);
  assert.equal(state.disk.get(`${FOLDER}/ideas/2026/plan.md`), "");
  assert.deepEqual(calls.order, ["mkdir", "closeOverlay", "run", "setShared"]);
  assert.equal(calls.run[0][1].name, "plan.md");
  assert.equal(calls.run[0][1].props.file, `${FOLDER}/ideas/2026/plan.md`);
});

test("Enter on the Create row creates; a name with an extension keeps it", async () => {
  const { view, cx, tree } = await mount();
  type(view, "todo.mdx");
  assert.deepEqual(highlighted(tree()), ["mdp-create"]);
  view.input.submit(cx);
  await cx.settle();
  assert.deepEqual(calls.writeTextFile.map(c => c.path), [`${FOLDER}/todo.mdx`]);
  assert.equal(calls.run[0][1].props.file, `${FOLDER}/todo.mdx`);
});

test("creating a file that exists (not in the list: ignored by git, say) just opens it, writes nothing new", async () => {
  state.disk.set(`${FOLDER}/hidden.md`, "# keep me");
  const { view, cx, tree } = await mount();
  type(view, "hidden");
  fire(must(tree(), "mdp-create"), "on_click", {}, cx);
  await cx.settle();
  assert.equal(state.disk.get(`${FOLDER}/hidden.md`), "# keep me", "the stale write was refused and not retried");
  assert.deepEqual(calls.closeOverlay, ["ov-1"]);
  assert.equal(calls.run[0][1].props.file, `${FOLDER}/hidden.md`);
  assert.equal(find(tree(), "mdp-note"), null);
});

test("another error is shown under the input and the dialog stays; the next try works", async () => {
  let broken = true;
  state.writeTextFile = async (path, text) => {
    if (broken) throw new Error("Permission denied");
    state.disk.set(path, text);
    return null;
  };
  const { view, cx, tree } = await mount();
  type(view, "notes");
  fire(must(tree(), "mdp-create"), "on_click", {}, cx);
  await cx.settle();
  assert.equal(textOf(must(tree(), "mdp-note")).trim(), "Can't create notes.md: Permission denied");
  assert.equal(must(tree(), "mdp-note").style.text_color, "blocked");
  assert.deepEqual(calls.closeOverlay, []);
  assert.deepEqual(calls.run, []);
  assert.equal(view.busy, false);

  type(view, "notes2");
  assert.equal(find(tree(), "mdp-note"), null, "typing clears it");
  broken = false;
  fire(must(tree(), "mdp-create"), "on_click", {}, cx);
  await cx.settle();
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0][1].props.file, `${FOLDER}/notes2.md`);
});

test("a folder that cannot be made is shown, and no file is written", async () => {
  state.exec = fakeExec({ git: FILES, mkdir: 1 });
  const { view, cx, tree } = await mount();
  type(view, "locked/a");
  fire(must(tree(), "mdp-create"), "on_click", {}, cx);
  await cx.settle();
  assert.equal(textOf(must(tree(), "mdp-note")).trim(), "Can't create locked/a.md: mkdir: Permission denied");
  assert.equal(calls.writeTextFile.length, 0);
  assert.deepEqual(calls.closeOverlay, []);
});

test("a second Enter while the file is being made does nothing", async () => {
  let release;
  state.writeTextFile = () => new Promise(resolve => { release = resolve; });
  const { view, cx } = await mount();
  type(view, "slow");
  view.input.submit(cx);
  view.input.submit(cx);
  await Promise.resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(calls.writeTextFile.length, 1);
  release(null);
  await cx.settle();
  assert.equal(calls.run.length, 1);
});

test("New note pressed while still listing waits for the listing, so the name is free", async () => {
  let finish;
  state.exec = () => new Promise(resolve => { finish = resolve; });
  const { view, cx } = await mount({ settle: false });
  view.input.submit(cx); // nothing listed yet: the highlight is on New note
  await new Promise(r => setImmediate(r));
  assert.equal(calls.writeTextFile.length, 0, "not before the list is in");
  finish({ code: 0, stdout: NUL(["untitled.md"]), stderr: "" });
  await cx.settle();
  assert.deepEqual(calls.writeTextFile.map(c => c.path), [`${FOLDER}/untitled-2.md`]);
});

test("a folder on another machine: asked there, files open with the machine, creating is off with a reason", async () => {
  state.exec = fakeExec({ git: ["notes/plan.md", "README.md"], home: "/home/dev" });
  const { view, cx, tree } = await mount({ folder: "/home/dev/Work", machine: "devbox" });
  assert.deepEqual(calls.exec.map(c => [c.command, c.options.on]), [["sh", "devbox"], ["git", "devbox"]]);
  assert.equal(calls.exec[1].options.cwd, "/home/dev/Work");
  assert.ok(textOf(must(tree(), "mdp-footer")).endsWith("devbox: ~/Work"));
  assert.equal(row(tree(), "mdp-new"), "New note Creating files on devbox isn't supported yet");
  assert.equal(must(tree(), "mdp-new").handlers.on_click, undefined);
  type(view, "fresh");
  assert.equal(row(tree(), "mdp-create"), "Create fresh.md Creating files on devbox isn't supported yet");
  assert.equal(must(tree(), "mdp-create").handlers.on_click, undefined);

  view.input.submit(cx);
  await cx.settle();
  assert.deepEqual([calls.writeTextFile, calls.run, calls.closeOverlay, calls.exec.filter(c => c.command === "mkdir")], [[], [], [], []]);

  type(view, "readme");
  view.input.submit(cx);
  assert.deepEqual(calls.run, [["tab.new", { name: "README.md", space: "s1", mod: "herdr-inline-markdown", props: { file: "/home/dev/Work/README.md", machine: "devbox" } }]]);
  assert.deepEqual(calls.setShared.at(-1), ["herdr-inline-markdown.recent", [{ machine: "devbox", path: "/home/dev/Work/README.md" }]]);
});

test("another machine with no folder given: its home is the folder, and recent files there come first", async () => {
  state.shared["herdr-inline-markdown.recent"] = [{ machine: null, path: "/home/user/mine.md" }, { machine: "devbox", path: "/home/dev/Work/old.md" }];
  state.exec = fakeExec({ git: ["a.md"], home: "/home/dev" });
  const { tree } = await mount({ folder: null, machine: "devbox" });
  assert.equal(calls.exec[0].args[1], 'printf %s "$HOME"');
  assert.equal(calls.exec[1].options.cwd, "/home/dev");
  assert.ok(textOf(must(tree(), "mdp-footer")).endsWith("devbox: ~"));
  assert.deepEqual(rowIds(tree()).slice(1).map(id => row(tree(), id)), ["old.md Work recent", "a.md"], "the home folder is the folder, so Work is inside it");
});

test("another machine that does not answer and no folder to go by: the list says so", async () => {
  state.exec = fakeExec({ home: null });
  const { tree } = await mount({ folder: null, machine: "devbox" });
  assert.equal(textOf(must(tree(), "mdp-status")).trim(), "Can't list this folder: Can't reach devbox");
  assert.deepEqual(rowIds(tree()), ["mdp-new"]);
});

test("another machine whose home cannot be asked still lists a folder it was given", async () => {
  state.exec = fakeExec({ git: ["a.md"], home: null });
  const { tree } = await mount({ folder: "/srv/docs", machine: "devbox" });
  assert.deepEqual(rowIds(tree()), ["mdp-new", "mdp-file-0"]);
  assert.ok(textOf(must(tree(), "mdp-footer")).endsWith("devbox: /srv/docs"));
});

test("only the rows that fit are drawn; the keys and the wheel move the window", async () => {
  state.exec = fakeExec({ git: Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, "0")}.md`) });
  const { cx, tree } = await mount();
  assert.equal(rowIds(tree()).length, 8, "eight rows before the list has measured itself");
  fire(must(tree(), "mdp-list"), "on_size_change", { width: 500, height: 32 * 5 }, cx);
  assert.deepEqual(rowIds(tree()), ["mdp-new", "mdp-file-0", "mdp-file-1", "mdp-file-2", "mdp-file-3"], "five rows of 32");
  const again = makeCx();
  fire(must(tree(), "mdp-list"), "on_size_change", { width: 500, height: 32 * 5 }, again);
  assert.equal(again.notified, 0, "the same size is not a change");

  for (let i = 0; i < 4; i++) press(tree(), "down");
  assert.deepEqual(rowIds(tree()), ["mdp-file-0", "mdp-file-1", "mdp-file-2", "mdp-file-3", "mdp-file-4"], "the window follows the highlight");
  assert.deepEqual(highlighted(tree()), ["mdp-file-4"]);

  press(tree(), "up");
  press(tree(), "up");
  press(tree(), "up");
  press(tree(), "up");
  press(tree(), "up");
  assert.deepEqual(highlighted(tree()), ["mdp-new"]);
  press(tree(), "up");
  assert.deepEqual(highlighted(tree()), ["mdp-file-29"], "Up from the first row wraps to the last");
  assert.deepEqual(rowIds(tree()), ["mdp-file-25", "mdp-file-26", "mdp-file-27", "mdp-file-28", "mdp-file-29"]);

  // delta.y is negative when the content moves up.
  fire(must(tree(), "mdp-list"), "on_scroll_wheel", { delta: { x: 0, y: 32 * 10 } }, cx);
  assert.deepEqual(rowIds(tree()).slice(0, 1), ["mdp-file-15"]);
  assert.deepEqual(highlighted(tree()), [], "the highlighted row is out of the window now");
  fire(must(tree(), "mdp-list"), "on_scroll_wheel", { delta: { x: 0, y: -32 * 1000 } }, cx);
  assert.equal(rowIds(tree()).at(-1), "mdp-file-29", "it stops at the end");
  fire(must(tree(), "mdp-list"), "on_scroll_wheel", { delta: { x: 0, y: 32 * 1000 } }, cx);
  assert.equal(rowIds(tree())[0], "mdp-new", "and at the start");
});

test("the status line takes one of the rows", async () => {
  let finish;
  state.exec = () => new Promise(resolve => { finish = resolve; });
  state.shared["herdr-inline-markdown.recent"] = Array.from({ length: 6 }, (_, i) => ({ machine: null, path: `${FOLDER}/r${i}.md` }));
  const { cx, tree } = await mount({ settle: false });
  fire(must(tree(), "mdp-list"), "on_size_change", { width: 500, height: 32 * 4 }, cx);
  assert.equal(rowIds(tree()).length, 3, "four rows of height, one of them is 'Looking for markdown files…'");
  assert.ok(find(tree(), "mdp-status"));
  finish({ code: 0, stdout: NUL(["a.md"]), stderr: "" });
  await cx.settle();
  assert.equal(rowIds(tree()).length, 4);
  assert.equal(find(tree(), "mdp-status"), null);
});

test("every element with a handler has an id, and ids are unique", async () => {
  state.shared["herdr-inline-markdown.recent"] = [{ machine: null, path: `${FOLDER}/docs/plan.md` }];
  const { view, tree } = await mount();
  for (const q of ["", "plan", "zzz", "../x"]) {
    type(view, q);
    const t = tree();
    const handlers = all(t, n => Object.keys(n.handlers).length > 0);
    assert.ok(handlers.length > 2);
    for (const n of handlers) assert.ok(n.id, `a ${n.kind} with ${Object.keys(n.handlers)} has no id`);
    const list = ids(t);
    assert.equal(new Set(list).size, list.length, `duplicate ids for "${q}": ${list}`);
  }
});

test("the dialog draws only icons that ship with the mod", async () => {
  const { view, tree } = await mount();
  type(view, "plan");
  const paths = new Set(all(tree(), n => n.kind === "svg").map(n => n.path));
  assert.ok(paths.size > 0, "the dialog draws icons");
  for (const path of paths) assert.ok(existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url))), path);
});

test("props() wins over the argument init gets, and the argument is the fallback", async () => {
  state.props = { action: "open", folder: "/tmp/y", machine: null, overlay: "ov-1" };
  let cx = makeCx();
  new Picker().init({ action: "open", folder: "/tmp/x", machine: null }, cx);
  await cx.settle();
  assert.equal(calls.exec[0].options.cwd, "/tmp/y");

  state.props = undefined;
  cx = makeCx();
  new Picker().init({ action: "open", folder: "/tmp/x", machine: null }, cx);
  await cx.settle();
  assert.equal(calls.exec[1].options.cwd, "/tmp/x");
});
