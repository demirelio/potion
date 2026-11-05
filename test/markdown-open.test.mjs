import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { state, calls, reset } from "./mocks/herdr.mjs";
import { space, pane } from "./helpers.mjs";

const { openMarkdown, registerPane, paneOf, rememberRecent } = await import("../mods/my-markdown/open.js");

const PANES = "my-markdown.panes", RECENT = "my-markdown.recent", OLD_TABS = "my-markdown.tabs";
const tab = (id, more = {}) => ({ id, name: id, active: false, zoomed: false, status: null, ...more });
const inSpace = (id, ...tabs) => space(id, id, { tabs: tabs.map(t => tab(t)) });
const mdPane = (id, tabId) => pane(id, tabId, null, { terminal: null, mod: "my-markdown" });
const otherMod = (id, tabId) => pane(id, tabId, null, { terminal: null, mod: "my-files" });
const shell = (id, tabId) => pane(id, tabId, "/home/user");
const focus = (tabId, paneId = null) => { state.focused = { space: "s1", tab: tabId, pane: paneId, terminal: null, shown: null, agent: null, cwd: null }; };
const stored = key => state.shared[key];
const split = (anchor, file, machine = null) => ["pane.split", { direction: "right", pane: anchor, mod: "my-markdown", props: { file, machine } }];

beforeEach(() => reset());

test("place pane: the file opens to the right of the given pane, with the mod and its props, nothing else", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), shell("p2", "tb1")];
  openMarkdown({ file: "/home/user/notes/plan.md", machine: null, place: "pane", space: "s1", pane: "p2" });
  assert.deepEqual(calls.run, [split("p2", "/home/user/notes/plan.md")]);
});

test("place pane: without a pane argument it opens beside the focused pane", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), shell("p2", "tb1")];
  focus("tb1", "p2");
  openMarkdown({ file: "/a/b.md", place: "pane" });
  assert.deepEqual(calls.run, [split("p2", "/a/b.md")]);
});

test("place pane: a pane argument that is not listed falls back to the focused pane", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), shell("p2", "tb1")];
  focus("tb1", "p1");
  openMarkdown({ file: "/a/b.md", place: "pane", pane: "p-gone" });
  assert.deepEqual(calls.run, [split("p1", "/a/b.md")]);
});

test("place pane: when no pane has the focus (a layout block does), the focused tab's first pane is the anchor", () => {
  state.spaces = [inSpace("s1", "tb1", "tb2")];
  state.panes = [shell("p1", "tb1"), shell("p2", "tb2"), shell("p3", "tb2")];
  focus("tb2", null);
  openMarkdown({ file: "/a/b.md", place: "pane" });
  assert.deepEqual(calls.run, [split("p2", "/a/b.md")]);
});

test("place pane: the machine travels in the props", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1")];
  openMarkdown({ file: "/home/dev/a.md", machine: "devbox", place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [split("p1", "/home/dev/a.md", "devbox")]);
});

test("place pane: the file already shown in the anchor's tab gets the focus instead of another split", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb1"), mdPane("p3", "tb1")];
  state.shared[PANES] = { p2: ":/other.md", p3: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", machine: null, place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [["pane.focus", { pane: "p3" }]]);
});

test("place pane: the anchor itself may be the pane that shows the file", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [mdPane("p2", "tb1")];
  state.shared[PANES] = { p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "pane", pane: "p2" });
  assert.deepEqual(calls.run, [["pane.focus", { pane: "p2" }]]);
});

test("place pane: the file shown in another tab does not count: this tab gets its own pane", () => {
  state.spaces = [inSpace("s1", "tb1", "tb2")];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb2")];
  state.shared[PANES] = { p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [split("p1", "/a/b.md")]);
});

test("place pane: the same path on another machine is another file, in either direction", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb1")];
  state.shared[PANES] = { p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", machine: "devbox", place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [split("p1", "/a/b.md", "devbox")]);
  calls.run.length = 0;
  state.shared[PANES] = { p2: "devbox:/a/b.md" };
  openMarkdown({ file: "/a/b.md", machine: "devbox", place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [["pane.focus", { pane: "p2" }]]);
  calls.run.length = 0;
  openMarkdown({ file: "/a/b.md", machine: null, place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [split("p1", "/a/b.md")]);
});

test("place pane: registry entries of panes that are gone, or are not Markdown panes any more, are ignored", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), shell("p3", "tb1"), otherMod("p4", "tb1")];
  state.shared[PANES] = { p9: ":/a/b.md", p3: ":/a/b.md", p4: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [split("p1", "/a/b.md")], "p9 is gone, p3 is a terminal, p4 belongs to another mod");
});

test("place pane: a stale entry does not hide a live one for the same file", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb1")];
  state.shared[PANES] = { p9: ":/a/b.md", p1: ":/a/b.md", p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "pane", pane: "p1" });
  assert.deepEqual(calls.run, [["pane.focus", { pane: "p2" }]]);
});

test("place pane: with nothing to open beside it falls through to a tab", () => {
  openMarkdown({ file: "/a/b.md", place: "pane", space: "s2" });
  assert.deepEqual(calls.run, [["tab.new", { name: "b.md", space: "s2", mod: "my-markdown", props: { file: "/a/b.md", machine: null } }]], "no focus, no panes");
  calls.run.length = 0;
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1")];
  focus("tb-empty");
  openMarkdown({ file: "/a/b.md", place: "pane", space: "s1", pane: "p-gone" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"], "the focused tab has no panes and the given one is not listed");
});

test("place pane: the fall-through still goes to the file's own tab when there is one", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [mdPane("p1", "tb1")];
  state.shared[PANES] = { p1: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "pane", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "tb1" }]], "no focus to anchor on");
});

test("place pane remembers the file as recent, after the pane command; focusing counts too", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb1")];
  openMarkdown({ file: "/a/b.md", machine: "devbox", place: "pane", pane: "p1" });
  assert.deepEqual(stored(RECENT), [{ machine: "devbox", path: "/a/b.md" }]);
  assert.deepEqual(calls.order, ["run", "setShared"]);
  state.shared[PANES] = { p2: ":/c.md" };
  calls.order.length = 0;
  openMarkdown({ file: "/c.md", place: "pane", pane: "p1" });
  assert.deepEqual(stored(RECENT).map(r => r.path), ["/c.md", "/a/b.md"]);
  assert.deepEqual(calls.order, ["run", "setShared"]);
});

test("place pane never writes the pane registry", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1")];
  openMarkdown({ file: "/a/b.md", place: "pane", pane: "p1" });
  assert.deepEqual(calls.setShared.map(c => c[0]), [RECENT]);
});

test("place tab is the default: a file that is not open yet gets a new tab with its name, space, mod and props, nothing else", () => {
  openMarkdown({ file: "/home/user/notes/plan.md", machine: null, space: "s2" });
  assert.deepEqual(calls.run, [["tab.new", { name: "plan.md", space: "s2", mod: "my-markdown", props: { file: "/home/user/notes/plan.md", machine: null } }]]);
  calls.run.length = 0;
  openMarkdown({ file: "/home/user/notes/plan.md", machine: null, place: "tab", space: "s2" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("place tab ignores the focus and the pane argument: it never splits", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1")];
  focus("tb1", "p1");
  openMarkdown({ file: "/a/b.md", place: "tab", space: "s1", pane: "p1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("tab.new leaves out the space when there is none, and carries the machine", () => {
  openMarkdown({ file: "/home/dev/a.md" });
  assert.deepEqual(calls.run, [["tab.new", { name: "a.md", mod: "my-markdown", props: { file: "/home/dev/a.md", machine: null } }]]);
  assert.equal("space" in calls.run[0][1], false);
  calls.run.length = 0;
  openMarkdown({ file: "/home/dev/a.md", machine: "devbox", space: null });
  assert.deepEqual(calls.run, [["tab.new", { name: "a.md", mod: "my-markdown", props: { file: "/home/dev/a.md", machine: "devbox" } }]]);
});

test("a file shown by a tab of Markdown panes: select its space, then the tab, and open no new one", () => {
  state.spaces = [inSpace("s1", "tb1"), inSpace("s2", "tb2", "tb5")];
  state.panes = [shell("p1", "tb1"), shell("p2", "tb2"), mdPane("p5", "tb5")];
  state.shared[PANES] = { p5: ":/a/b.md", p2: ":/other.md" };
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s2" }], ["tab.select", { id: "tb5" }]]);
  assert.deepEqual(calls.order.slice(0, 2), ["run", "run"]);
});

test("a tab of several Markdown panes is the file's own tab when one of them shows the file", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [mdPane("p1", "tb1"), mdPane("p2", "tb1")];
  state.shared[PANES] = { p1: ":/one.md", p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "tb1" }]]);
});

test("a tab that has a terminal pane too is not the file's own tab: the file gets a tab of its own", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb1")];
  state.shared[PANES] = { p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("a tab with a pane of another mod is not the file's own tab", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [mdPane("p1", "tb1"), otherMod("p2", "tb1")];
  state.shared[PANES] = { p1: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("a pane whose tab is in no space is not a tab to go to", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [mdPane("p9", "tb9")];
  state.shared[PANES] = { p9: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("the same path on another machine is another file", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [mdPane("p1", "tb1")];
  state.shared[PANES] = { p1: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", machine: "devbox", place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
  calls.run.length = 0;
  state.shared[PANES] = { p1: "devbox:/a/b.md" };
  openMarkdown({ file: "/a/b.md", machine: "devbox", place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "tb1" }]]);
});

test("a registry entry whose pane is gone, or is no longer a Markdown pane, is ignored", () => {
  state.spaces = [inSpace("s1", "tb1", "tb3")];
  state.panes = [shell("p1", "tb1"), shell("p3", "tb3")];
  state.shared[PANES] = { p9: ":/a/b.md", p1: ":/a/b.md", p3: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"], "p9 is gone, p1 and p3 are terminals now");
});

test("a stale entry does not hide a live one for the same file", () => {
  state.spaces = [inSpace("s1", "tb1", "tb2")];
  state.panes = [mdPane("p2", "tb2")];
  state.shared[PANES] = { p9: ":/a/b.md", p1: ":/a/b.md", p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "tb2" }]]);
});

test("the old tab registry is not read", () => {
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [mdPane("p1", "tb1")];
  state.shared[OLD_TABS] = { tb1: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
  assert.deepEqual(calls.setShared.map(c => c[0]), [RECENT], "nor written");
});

test("place tab remembers the file as recent, after the tab command; going to an open tab counts too", () => {
  openMarkdown({ file: "/a/b.md", machine: "devbox", space: "s1" });
  assert.deepEqual(stored(RECENT), [{ machine: "devbox", path: "/a/b.md" }]);
  assert.deepEqual(calls.order, ["run", "setShared"]);
  state.spaces = [inSpace("s1", "tb1")];
  state.panes = [mdPane("p1", "tb1")];
  state.shared[PANES] = { p1: ":/c.md" };
  calls.order.length = 0;
  openMarkdown({ file: "/c.md", space: "s1" });
  assert.deepEqual(stored(RECENT).map(r => r.path), ["/c.md", "/a/b.md"]);
  assert.deepEqual(calls.order, ["run", "run", "setShared"]);
});

const named = (id, name) => tab(id, { name });
const nameSpace = (id, ...tabs) => space(id, id, { tabs });

test("no registry entry yet: the one Markdown tab named after the file is taken for it, in any space", () => {
  state.spaces = [nameSpace("s1", named("tb1", "Main")), nameSpace("s2", named("tb2", "Main"), named("tb5", "b.md"))];
  state.panes = [shell("p1", "tb1"), shell("p2", "tb2"), mdPane("p5", "tb5")];
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s2" }], ["tab.select", { id: "tb5" }]]);
  assert.deepEqual(stored(RECENT), [{ machine: null, path: "/a/b.md" }], "it counts as opened");
});

test("the tab named after the file is not taken when it has a terminal pane, or another name", () => {
  state.spaces = [nameSpace("s1", named("tb1", "b.md"), named("tb2", "c.md"), named("tb3", "b.md.txt"), named("tb4", "b.md"))];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb2"), mdPane("p3", "tb3"), mdPane("p4a", "tb4"), shell("p4b", "tb4")];
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"], "two terminal-bearing tabs named b.md; two tabs with other names");
});

test("two tabs named after the file (not yet drawn): which one it is cannot be told, so a new tab opens", () => {
  state.spaces = [nameSpace("s1", named("tb1", "b.md"), named("tb2", "b.md"))];
  state.panes = [mdPane("p1", "tb1"), mdPane("p2", "tb2")];
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"]);
});

test("a tab known to show another file is not the one, even with the file's name; one known to show this file still is", () => {
  state.spaces = [nameSpace("s1", named("tb1", "b.md"), named("tb2", "b.md"))];
  state.panes = [mdPane("p1", "tb1"), mdPane("p2", "tb2")];
  state.shared[PANES] = { p1: ":/other/b.md" };
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "tb2" }]], "p1 is /other/b.md; p2 has not been drawn");
  calls.run.length = 0;
  state.shared[PANES] = { p1: ":/other/b.md", p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "tb2" }]], "now by the registry");
  calls.run.length = 0;
  state.shared[PANES] = { p1: ":/other/b.md", p2: ":/another/b.md" };
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run.map(c => c[0]), ["tab.new"], "both are known, neither shows this file");
});

test("the registry wins over a tab that only has the file's name", () => {
  state.spaces = [nameSpace("s1", named("tb1", "b.md"), named("tb2", "Notes"))];
  state.panes = [mdPane("p1", "tb1"), mdPane("p2", "tb2")];
  state.shared[PANES] = { p2: ":/a/b.md" };
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s1" }], ["tab.select", { id: "tb2" }]]);
});

test("recent files: newest first, each once, at most 30", () => {
  for (let i = 0; i < 35; i++) rememberRecent(`/f${i}.md`, null);
  assert.equal(stored(RECENT).length, 30);
  assert.deepEqual(stored(RECENT)[0], { machine: null, path: "/f34.md" });
  assert.deepEqual(stored(RECENT).at(-1), { machine: null, path: "/f5.md" });
  rememberRecent("/f20.md", null);
  assert.equal(stored(RECENT).length, 30);
  assert.deepEqual(stored(RECENT).slice(0, 2).map(r => r.path), ["/f20.md", "/f34.md"]);
  assert.equal(stored(RECENT).filter(r => r.path === "/f20.md").length, 1);
});

test("recent files: the machine is part of the identity, and a damaged list starts over", () => {
  rememberRecent("/a.md", null);
  rememberRecent("/a.md", "devbox");
  rememberRecent("/a.md");
  assert.deepEqual(stored(RECENT), [{ machine: null, path: "/a.md" }, { machine: "devbox", path: "/a.md" }]);
  state.shared[RECENT] = "garbage";
  rememberRecent("/b.md", null);
  assert.deepEqual(stored(RECENT), [{ machine: null, path: "/b.md" }]);
});

test("registerPane files the pane it is given under the file's key; a pane shows one file at a time", () => {
  state.spaces = [inSpace("s1", "tb1", "tb2")];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb2")];
  registerPane("p2", "/a/b.md", null);
  assert.deepEqual(stored(PANES), { p2: ":/a/b.md" });
  state.shared[PANES] = { p2: ":/old.md" };
  registerPane("p2", "/a/b.md", "devbox");
  assert.deepEqual(stored(PANES), { p2: "devbox:/a/b.md" });
});

test("registerPane keeps the entries of the other panes", () => {
  state.panes = [mdPane("p1", "tb1"), mdPane("p2", "tb1")];
  state.shared[PANES] = { p1: ":/one.md" };
  registerPane("p2", "/two.md");
  assert.deepEqual(stored(PANES), { p1: ":/one.md", p2: ":/two.md" });
});

test("registerPane does not look at which pane is focused: the focused one may be another pane", () => {
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb2")];
  focus("tb1", "p1");
  registerPane("p2", "/a/b.md", null);
  assert.deepEqual(stored(PANES), { p2: ":/a/b.md" });
});

test("registerPane without a pane does nothing", () => {
  registerPane(undefined, "/a/b.md", null);
  registerPane(null, "/a/b.md", null);
  registerPane("", "/a/b.md", null);
  assert.deepEqual(calls.setShared, []);
  assert.equal(stored(PANES), undefined);
});

test("registerPane does not write when nothing would change", () => {
  state.panes = [mdPane("p2", "tb2")];
  state.shared[PANES] = { p2: ":/a/b.md" };
  registerPane("p2", "/a/b.md", null);
  assert.deepEqual(calls.setShared, []);
});

test("registerPane never touches the old tab registry", () => {
  state.panes = [mdPane("p2", "tb2")];
  registerPane("p2", "/a/b.md", null);
  assert.deepEqual(calls.setShared.map(c => c[0]), [PANES]);
});

test("registerPane drops the entries of closed panes while every machine is ready", () => {
  state.panes = [mdPane("p2", "tb2"), mdPane("devbox/p4", "devbox/tb4")];
  state.shared[PANES] = { p2: ":/two.md", p7: ":/gone.md", "devbox/p4": "devbox:/there.md", "devbox/p8": "devbox:/gone.md" };
  registerPane("p2", "/a/b.md", null);
  assert.deepEqual(stored(PANES), { p2: ":/a/b.md", "devbox/p4": "devbox:/there.md" });
});

test("registerPane keeps every entry while a machine is loading or offline: its panes are not in panes() yet", () => {
  for (const layout of ["loading", "unavailable"]) {
    reset({
      machines: [{ name: null, layout: "ready" }, { name: "devbox", layout }],
      panes: [mdPane("p2", "tb2")],
      shared: { [PANES]: { p2: ":/two.md", p7: ":/gone.md", "devbox/p4": "devbox:/there.md" } },
    });
    registerPane("p2", "/a/b.md", null);
    assert.deepEqual(stored(PANES), { p2: ":/a/b.md", p7: ":/gone.md", "devbox/p4": "devbox:/there.md" }, layout);
  }
});

test("a registered pane is found again by openMarkdown, as a pane and as a tab", () => {
  state.spaces = [inSpace("s1", "tb1"), inSpace("s2", "tb2")];
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb2")];
  registerPane("p2", "/a/b.md", null);
  calls.run.length = 0;
  openMarkdown({ file: "/a/b.md", machine: null, place: "tab", space: "s1" });
  assert.deepEqual(calls.run, [["space.select", { id: "s2" }], ["tab.select", { id: "tb2" }]]);
  calls.run.length = 0;
  state.panes = [shell("p1", "tb1"), shell("p3", "tb2"), mdPane("p2", "tb2")];
  openMarkdown({ file: "/a/b.md", machine: null, place: "pane", pane: "p3" });
  assert.deepEqual(calls.run, [["pane.focus", { pane: "p2" }]]);
});

test("paneOf: the pane the registry files under the file in that tab", () => {
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb1"), mdPane("p3", "tb1")];
  state.shared[PANES] = { p2: ":/one.md", p3: ":/a/b.md" };
  assert.deepEqual(paneOf("tb1", "/a/b.md", null), { pane: "p3", filed: true });
});

test("paneOf: the only Markdown pane the registry does not know yet is the one, unfiled", () => {
  state.panes = [shell("p1", "tb1"), mdPane("p2", "tb1"), mdPane("p3", "tb1")];
  state.shared[PANES] = { p2: ":/one.md" };
  assert.deepEqual(paneOf("tb1", "/a/b.md", null), { pane: "p3", filed: false });
  state.shared[PANES] = undefined;
  state.panes = [mdPane("p2", "tb1")];
  assert.deepEqual(paneOf("tb1", "/a/b.md", null), { pane: "p2", filed: false }, "an empty registry");
});

test("paneOf: two unknown Markdown panes cannot be told apart", () => {
  state.panes = [mdPane("p2", "tb1"), mdPane("p3", "tb1")];
  assert.equal(paneOf("tb1", "/a/b.md", null), null);
});

test("paneOf: a filed pane wins over unknown ones", () => {
  state.panes = [mdPane("p2", "tb1"), mdPane("p3", "tb1"), mdPane("p4", "tb1")];
  state.shared[PANES] = { p4: ":/a/b.md" };
  assert.deepEqual(paneOf("tb1", "/a/b.md", null), { pane: "p4", filed: true });
});

test("paneOf: other tabs, other mods and terminals do not count", () => {
  state.panes = [mdPane("p2", "tb2"), otherMod("p3", "tb1"), shell("p4", "tb1")];
  state.shared[PANES] = { p2: ":/a/b.md" };
  assert.equal(paneOf("tb1", "/a/b.md", null), null);
  assert.equal(paneOf(undefined, "/a/b.md", null), null);
});

test("paneOf: a pane known to show another file is neither filed nor unknown", () => {
  state.panes = [mdPane("p2", "tb1")];
  state.shared[PANES] = { p2: ":/other.md" };
  assert.equal(paneOf("tb1", "/a/b.md", null), null);
});

test("paneOf: the machine is part of the key", () => {
  state.panes = [mdPane("p2", "tb1"), mdPane("p3", "tb1")];
  state.shared[PANES] = { p2: ":/a/b.md", p3: "devbox:/a/b.md" };
  assert.deepEqual(paneOf("tb1", "/a/b.md", null), { pane: "p2", filed: true });
  assert.deepEqual(paneOf("tb1", "/a/b.md", "devbox"), { pane: "p3", filed: true });
  assert.equal(paneOf("tb1", "/a/b.md", "other"), null, "both panes are known to show something else");
});
