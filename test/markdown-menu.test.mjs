import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { state, calls, reset } from "./mocks/herdr.mjs";
import { all, ids, textOf, fire } from "./mocks/element.mjs";
import { makeCx, space, pane, must } from "./helpers.mjs";

const { Menu } = await import("../mods/herdr-inline-markdown/menu.js");
const { default: MenuDefault } = await import("../mods/herdr-inline-markdown/menu.js");
const { default: Markdown } = await import("../mods/herdr-inline-markdown/main.js");

const FILE = "/home/user/notes/plan.md";

beforeEach(() => reset({ spaces: [space("s1", "herdr", { active: true })] }));

function mount(extra = {}) {
  state.props = { action: "menu", file: FILE, machine: null, space: "s1", overlay: "ov-1", ...extra };
  const cx = makeCx(), view = new Menu();
  view.init(state.props, cx);
  return { view, cx, tree: () => view.render(cx) };
}
const press = (tree, key) => fire(must(tree, "md-menu"), "on_key_down", { key, keystroke: key, modifiers: {} }, makeCx());
const TAB = ["tab.new", { name: "plan.md", space: "s1", mod: "herdr-inline-markdown", props: { file: FILE, machine: null } }];

test("it is both the named and the default export, and a plain class", () => {
  assert.equal(MenuDefault, Menu);
  assert.equal(Object.getPrototypeOf(Menu.prototype), Object.prototype);
});

test("one row: the plus icon and 'Open as new tab', highlighted", () => {
  const { tree } = mount();
  const rows = all(tree(), n => n.id?.startsWith("md-menu-"));
  assert.deepEqual(rows.map(n => n.id), ["md-menu-tab"]);
  const row = rows[0];
  assert.equal(textOf(row).trim(), "Open as new tab");
  assert.deepEqual(all(tree(), n => n.kind === "svg").map(n => n.path), ["mods/herdr-inline-markdown/plus.svg"]);
  assert.deepEqual([row.style.h, row.style.px, row.style.gap, row.style.rounded, row.style.bg], [31, 8, 9, 7, "selected"]);
});

test("the popup is styled like Home's menu: popover background, 5 px padding, 12.8 px text", () => {
  const root = must(mount().tree(), "md-menu");
  assert.deepEqual([root.style.bg, root.style.p, root.style.text_size, root.style.w_full, root.style.min_h], ["popover", 5, 12.8, true, 0]);
  assert.ok(root.focus, "it tracks its focus handle");
});

test("init takes the focus on its own handle", () => {
  const { cx, view } = mount();
  assert.equal(cx.handles.length, 1);
  assert.equal(cx.handles[0].focused, true);
  assert.equal(must(view.render(cx), "md-menu").focus, cx.handles[0]);
});

test("a click closes the popup first, then opens the file in a tab of its own", () => {
  const { tree } = mount();
  fire(must(tree(), "md-menu-tab"), "on_click", {}, makeCx());
  assert.deepEqual(calls.closeOverlay, ["ov-1"]);
  assert.deepEqual(calls.run, [TAB]);
  assert.deepEqual(calls.order, ["closeOverlay", "run", "setShared"]);
  assert.deepEqual(calls.setShared[0], ["herdr-inline-markdown.recent", [{ machine: null, path: FILE }]]);
});

test("Enter does what the click does", () => {
  const { tree } = mount();
  press(tree(), "enter");
  assert.deepEqual(calls.closeOverlay, ["ov-1"]);
  assert.deepEqual(calls.run, [TAB]);
  assert.deepEqual(calls.order.slice(0, 2), ["closeOverlay", "run"]);
});

test("Escape closes the popup and opens nothing; other keys do nothing", () => {
  const { tree } = mount();
  press(tree(), "escape");
  assert.deepEqual(calls.closeOverlay, ["ov-1"]);
  for (const key of ["down", "up", "a", "tab", "space"]) press(tree(), key);
  assert.deepEqual([calls.closeOverlay.length, calls.run, calls.setShared], [1, [], []]);
});

test("a file on another machine opens there; the tab goes into the space in the props", () => {
  const { tree } = mount({ file: "/home/dev/Work/a.md", machine: "devbox", space: "s2" });
  fire(must(tree(), "md-menu-tab"), "on_click", {}, makeCx());
  assert.deepEqual(calls.run, [["tab.new", { name: "a.md", space: "s2", mod: "herdr-inline-markdown", props: { file: "/home/dev/Work/a.md", machine: "devbox" } }]]);
  assert.deepEqual(calls.setShared[0][1], [{ machine: "devbox", path: "/home/dev/Work/a.md" }]);
});

test("no machine in the props means this computer; no space means a tab without one", () => {
  const { tree } = mount({ machine: undefined, space: undefined });
  fire(must(tree(), "md-menu-tab"), "on_click", {}, makeCx());
  assert.deepEqual(calls.run, [["tab.new", { name: "plan.md", mod: "herdr-inline-markdown", props: { file: FILE, machine: null } }]]);
});

test("a file that has a tab of its own gets that tab, not another", () => {
  state.spaces = [space("s1", "herdr", { active: true }), space("s2", "other", { tabs: [{ id: "tb9", name: "plan.md", active: true, zoomed: false, status: null }] })];
  state.panes = [pane("p9", "tb9", null, { terminal: null, mod: "herdr-inline-markdown" })];
  state.shared["herdr-inline-markdown.panes"] = { p9: `:${FILE}` };
  const { tree } = mount();
  fire(must(tree(), "md-menu-tab"), "on_click", {}, makeCx());
  assert.deepEqual(calls.run, [["space.select", { id: "s2" }], ["tab.select", { id: "tb9" }]]);
});

test("it never splits a pane, even with one focused and the file shown beside it", () => {
  state.panes = [pane("p1", "s1-tab", "/home/user"), pane("p2", "s1-tab", null, { terminal: null, mod: "herdr-inline-markdown" })];
  state.shared["herdr-inline-markdown.panes"] = { p2: `:${FILE}` };
  state.focused = { space: "s1", tab: "s1-tab", pane: "p1", terminal: "t-p1", shown: null, agent: null, cwd: null };
  const { tree } = mount();
  fire(must(tree(), "md-menu-tab"), "on_click", {}, makeCx());
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("props() wins over the argument init gets, and the argument is the fallback", () => {
  state.props = { action: "menu", file: "/tmp/y.md", machine: null, space: "s1", overlay: "ov-y" };
  let view = new Menu();
  view.init({ action: "menu", file: "/tmp/x.md", machine: null, space: "s1", overlay: "ov-x" }, makeCx());
  fire(must(view.render(), "md-menu-tab"), "on_click", {}, makeCx());
  assert.deepEqual([calls.closeOverlay, calls.run[0][1].props.file], [["ov-y"], "/tmp/y.md"]);

  state.props = undefined;
  calls.run.length = 0;
  view = new Menu();
  view.init({ action: "menu", file: "/tmp/x.md", machine: null, space: "s1", overlay: "ov-x" }, makeCx());
  fire(must(view.render(), "md-menu-tab"), "on_click", {}, makeCx());
  assert.deepEqual([calls.closeOverlay.at(-1), calls.run[0][1].props.file], ["ov-x", "/tmp/x.md"]);
});

test("every element with a handler has an id, and ids are unique", () => {
  const t = mount().tree();
  for (const n of all(t, n => Object.keys(n.handlers).length > 0 || n.focus)) assert.ok(n.id, `a ${n.kind} has no id`);
  const list = ids(t);
  assert.equal(new Set(list).size, list.length);
});

test("main.js starts the menu for action menu: init and render are forwarded, and closing it needs nothing of the menu", async () => {
  state.props = { action: "menu", file: FILE, machine: null, space: "s1", overlay: "ov-1" };
  const cx = makeCx(), view = new Markdown();
  view.init(undefined, cx);
  assert.equal(view.role.constructor.name, "Menu");
  assert.equal(cx.handles[0].focused, true, "init reached the menu");
  assert.ok(must(view.render(cx), "md-menu-tab"));
  await view.close(cx);
});

test("main.js: a dialog with action open is still the picker, anything else the editor", async () => {
  state.exec = async () => ({ code: 0, stdout: "", stderr: "" });
  state.props = { action: "open", space: "s1", folder: "/n", machine: null, overlay: "ov-1" };
  const cx = makeCx(), picker = new Markdown();
  picker.init(undefined, cx);
  await cx.settle();
  assert.equal(picker.role.constructor.name, "Picker");
  await picker.close(cx);
  for (const action of [undefined, "", "menu ", "constructor", "toString"]) {
    state.props = { action, file: FILE };
    const editor = new Markdown(), ecx = makeCx();
    editor.init(undefined, ecx);
    assert.equal(editor.role.constructor.name, "Editor", String(action));
  }
});
