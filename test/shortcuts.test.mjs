import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { state, calls, reset, openOverlay } from "./mocks/herdr.mjs";
import { all, textOf } from "./mocks/element.mjs";
import { makeCx, fire_timers, space, pane } from "./helpers.mjs";

const { default: Markdown } = await import("../mods/herdr-inline-markdown/main.js");
const { default: Beside, MEMORY } = await import("../mods/herdr-inline-markdown-beside/main.js");

const json = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const DIALOG = { kind: "dialog", width: 560, height: 460 };
const FOLDER = "/home/user/notes";

const fresh = (more = {}) => reset({
  spaces: [space("s2", "other"), space("s1", "notes", { folder: FOLDER, active: true })],
  panes: [pane("p1", "s1-tab", FOLDER, { focused: true })],
  focused: { space: "s1", tab: "s1-tab", pane: "p1", terminal: "t-p1", shown: null, agent: null, cwd: FOLDER },
  exec: async () => ({ code: 0, stdout: "plan.md\0", stderr: "" }),
  ...more,
});
// The companion's memory of the picker it opened lasts as long as Herdr runs; each test is a new run.
const newRun = () => { delete globalThis[MEMORY]; };
beforeEach(() => { fresh(); newRun(); });

function start(View, props, first) {
  state.props = props;
  const cx = makeCx(), view = new View();
  view.init(first, cx);
  return { view, cx };
}

test("keys.json binds cmd-m to the Markdown mod and cmd-shift-m to its companion, both through mod.open, and nothing else", () => {
  assert.deepEqual(json("keys.json"), {
    global: { "cmd-m": "mod.open:herdr-inline-markdown", "cmd-shift-m": "mod.open:herdr-inline-markdown-beside" },
  });
});

test("mod.json: mod.open shows the Markdown mod as a dialog the size the + menu opens the picker at; the rest is as before", () => {
  const { overlay, ...rest } = json("mods/herdr-inline-markdown/mod.json");
  assert.deepEqual(overlay, DIALOG);
  assert.deepEqual(rest, { place: "none", title: "Markdown", focusable: true });
});

test("mod.json: the companion is placed nowhere, and mod.open shows it as a frameless popup of 2 px (1 would be the whole window)", () => {
  assert.deepEqual(json("mods/herdr-inline-markdown-beside/mod.json"), {
    place: "none", title: "Markdown beside", overlay: { kind: "popup", frame: "none", width: 2, height: 2 },
  });
});

test("main.js: opened by mod.open, with only its overlay in the props, the mod is the picker for a new tab in the active space", async () => {
  const { view, cx } = start(Markdown, { overlay: "ov-7" });
  await cx.settle();
  assert.equal(view.role.constructor.name, "Picker");
  assert.equal(view.role.place, "tab");
  assert.equal(view.role.space, "s1");
  assert.equal(view.role.folder, FOLDER, "it looks in the focused pane's folder");
  view.role.dismiss();
  assert.deepEqual(calls.closeOverlay, ["ov-7"], "Escape closes the overlay mod.open made");
  await view.close(cx);
});

test("main.js: the bare overlay may come as init's argument when props() has none", async () => {
  const { view, cx } = start(Markdown, undefined, { overlay: "ov-8" });
  await cx.settle();
  assert.equal(view.role.constructor.name, "Picker");
  assert.equal(view.role.place, "tab");
});

test("main.js: an overlay that names a file is still the editor, and one with action menu the menu", () => {
  assert.equal(start(Markdown, { overlay: "ov-1", file: `${FOLDER}/plan.md` }).view.role.constructor.name, "Editor");
  assert.equal(start(Markdown, { overlay: "ov-1", action: "menu", file: `${FOLDER}/plan.md` }).view.role.constructor.name, "Menu");
  assert.equal(start(Markdown, { overlay: "ov-1", action: "" }).view.role.constructor.name, "Editor", "an action it does not know");
  assert.equal(start(Markdown, {}).view.role.constructor.name, "Editor", "no overlay: a pane without a file");
});

test("the companion does nothing while init runs, then in its first callback closes its own overlay and opens the picker for a pane beside", async () => {
  const { view, cx } = start(Beside, { overlay: "ov-3" });
  assert.deepEqual(calls.order, [], "nothing while Herdr is still making the copy");
  assert.deepEqual(cx.timers.map(t => [t.ms, t.after]), [[0, true]]);
  await fire_timers(cx);
  assert.deepEqual(calls.order, ["closeOverlay", "openOverlay"], "it goes first, as Herdr's own menus do before they open a dialog");
  assert.deepEqual(calls.closeOverlay, ["ov-3"]);
  assert.deepEqual(calls.openOverlay, [{ mod: "herdr-inline-markdown", ...DIALOG, props: { action: "open", place: "pane" } }]);
  const drawn = view.render(cx);
  assert.equal(textOf(drawn), "");
  assert.equal(all(drawn, n => n.kind !== "div" || Object.keys(n.handlers).length > 0).length, 0, "one empty div, nothing to see or click");
});

test("the companion reads its overlay from init's argument when props() has none", async () => {
  const { cx } = start(Beside, undefined, { overlay: "ov-4" });
  await fire_timers(cx);
  assert.deepEqual(calls.closeOverlay, ["ov-4"]);
  assert.equal(calls.openOverlay.length, 1);
});

test("the companion outside an overlay (a layout block) opens nothing", async () => {
  for (const props of [{}, undefined]) {
    reset();
    const { view, cx } = start(Beside, props);
    await fire_timers(cx);
    assert.deepEqual([cx.timers, calls.order], [[], []]);
    assert.equal(textOf(view.render(cx)), "");
  }
});

test("the dialog the companion opens is the picker, for a pane beside the focused one in the active space", async () => {
  const { cx } = start(Beside, { overlay: "ov-3" });
  await fire_timers(cx);
  const { view, cx: dcx } = start(Markdown, { ...calls.openOverlay[0].props, overlay: "overlay-1" });
  await dcx.settle();
  assert.equal(view.role.constructor.name, "Picker");
  assert.deepEqual([view.role.place, view.role.space, view.role.anchor], ["pane", "s1", "p1"]);
  calls.run.length = 0;
  view.role.open(`${FOLDER}/plan.md`);
  assert.deepEqual(calls.closeOverlay.at(-1), "overlay-1");
  assert.deepEqual(calls.run[0], ["pane.split", { direction: "right", pane: "p1", mod: "herdr-inline-markdown", props: { file: `${FOLDER}/plan.md`, machine: null } }]);
});

test("the picker mod.open makes opens a chosen file in a new tab of the active space", async () => {
  const { view, cx } = start(Markdown, { overlay: "ov-7" });
  await cx.settle();
  view.role.open(`${FOLDER}/plan.md`);
  assert.deepEqual(calls.run[0], ["tab.new", { name: "plan.md", space: "s1", mod: "herdr-inline-markdown", props: { file: `${FOLDER}/plan.md`, machine: null } }]);
});

const MODS = { "herdr-inline-markdown": Markdown, "herdr-inline-markdown-beside": Beside };
const KEYS = { "cmd-m": "herdr-inline-markdown", "cmd-shift-m": "herdr-inline-markdown-beside" };
const OPEN_PICKER = "herdr-inline-markdown.picker";

// Herdr's side of the overlays. A key is mod.open: it shows the mod as its mod.json overlay ("key-N"), or closes the
// one it showed for that mod if that is still open. An overlay a mod opens ("overlay-N", as the mock numbers them)
// starts that mod with its props. An overlay that closes goes, and its view gets close() after the call returned.
function herdr() {
  const open = new Map();
  let keyed = 0, opened = 0, closed = 0;
  const show = (id, mod, props, byKey) => open.set(id, { mod, byKey, ...start(MODS[mod], { ...props, overlay: id }) });
  const shut = async id => {
    const it = open.get(id);
    open.delete(id);
    await it?.view.close?.(it.cx);
  };
  async function settle() {
    for (;;) {
      if (opened < calls.openOverlay.length) {
        const { mod, props } = calls.openOverlay[opened++];
        show(`overlay-${opened}`, mod, props, false);
      } else if (closed < calls.closeOverlay.length) await shut(calls.closeOverlay[closed++]);
      else {
        const due = [...open.values()].filter(({ cx }) => cx.timers.some(t => t.ms === 0 && !t.ran));
        if (!due.length) return;
        for (const { cx } of due) await fire_timers(cx, { ms: 0 });
      }
    }
  }
  return {
    async press(key) {
      const mine = [...open].find(([, it]) => it.byKey && it.mod === KEYS[key]);
      if (mine) await shut(mine[0]);
      else show(`key-${++keyed}`, KEYS[key], {}, true);
      await settle();
    },
    // The + menu row of the new-menu integration.
    async menu() {
      openOverlay({ mod: "herdr-inline-markdown", ...DIALOG, props: { action: "open", place: "tab", space: "s1" } });
      await settle();
    },
    pickers: () => [...open].filter(([, it]) => it.view.role?.constructor.name === "Picker").map(([id, it]) => [id, it.view.role.place]),
  };
}

test("cmd-shift-m twice: the second press closes the pane picker the first opened, and a third opens one again", async () => {
  const h = herdr();
  await h.press("cmd-shift-m");
  assert.deepEqual(h.pickers(), [["overlay-1", "pane"]]);
  assert.equal(state.shared[OPEN_PICKER], "overlay-1");
  await h.press("cmd-shift-m");
  assert.deepEqual(h.pickers(), []);
  assert.equal(calls.openOverlay.length, 1, "no second pane picker");
  assert.equal(state.shared[OPEN_PICKER], null);
  await h.press("cmd-shift-m");
  assert.deepEqual(h.pickers(), [["overlay-2", "pane"]]);
});

test("cmd-shift-m twice closes the picker even when the second press runs in a module of its own, as each copy does in Herdr", async () => {
  const h = herdr();
  await h.press("cmd-shift-m");
  assert.deepEqual(h.pickers(), [["overlay-1", "pane"]]);
  MODS["herdr-inline-markdown-beside"] = (await import("../mods/herdr-inline-markdown-beside/main.js?copy=2")).default;
  try {
    await h.press("cmd-shift-m");
    assert.deepEqual(h.pickers(), []);
    assert.equal(calls.openOverlay.length, 1, "no second pane picker");
  } finally {
    MODS["herdr-inline-markdown-beside"] = Beside;
  }
});

test("cmd-m then cmd-shift-m: the pane picker takes the tab picker's place, one picker open", async () => {
  const h = herdr();
  await h.press("cmd-m");
  assert.deepEqual(h.pickers(), [["key-1", "tab"]]);
  await h.press("cmd-shift-m");
  assert.deepEqual(h.pickers(), [["overlay-1", "pane"]]);
  assert.equal(state.shared[OPEN_PICKER], "overlay-1");
});

test("cmd-m twice: Herdr closes the picker it showed, the name goes with it, and cmd-shift-m then opens one", async () => {
  const h = herdr();
  await h.press("cmd-m");
  await h.press("cmd-m");
  assert.deepEqual(h.pickers(), []);
  assert.equal(state.shared[OPEN_PICKER], null);
  await h.press("cmd-shift-m");
  assert.deepEqual(h.pickers(), [["overlay-1", "pane"]]);
});

test("cmd-shift-m then cmd-m: the tab picker takes the pane picker's place, and the closed one leaves its name alone", async () => {
  const h = herdr();
  await h.press("cmd-shift-m");
  await h.press("cmd-m");
  assert.deepEqual(h.pickers(), [["key-2", "tab"]]);
  assert.equal(state.shared[OPEN_PICKER], "key-2");
});

test("the + menu row then cmd-shift-m: the key's pane picker takes the menu's place", async () => {
  const h = herdr();
  await h.menu();
  assert.deepEqual(h.pickers(), [["overlay-1", "tab"]]);
  await h.press("cmd-shift-m");
  assert.deepEqual(h.pickers(), [["overlay-2", "pane"]]);
  assert.equal(state.shared[OPEN_PICKER], "overlay-2");
});

test("the + menu row then cmd-m: the key's picker takes the menu's place", async () => {
  const h = herdr();
  await h.menu();
  await h.press("cmd-m");
  assert.deepEqual(h.pickers(), [["key-1", "tab"]]);
  assert.equal(state.shared[OPEN_PICKER], "key-1");
});

test("a name left by a quit doesn't stop cmd-shift-m: the first press opens the pane picker, and the next closes it", async () => {
  for (const unknown of [() => null, () => { throw new Error("no overlay overlay-gone"); }]) {
    fresh({ shared: { [OPEN_PICKER]: "overlay-gone" }, closeOverlay: id => (id === "overlay-gone" ? unknown() : null) });
    newRun();
    const h = herdr();
    await h.press("cmd-shift-m");
    assert.deepEqual(h.pickers(), [["overlay-1", "pane"]]);
    assert.equal(state.shared[OPEN_PICKER], "overlay-1");
    await h.press("cmd-shift-m");
    assert.deepEqual(h.pickers(), []);
  }
});

test("a name left by a quit doesn't stop cmd-m: its picker opens and is named", async () => {
  state.shared[OPEN_PICKER] = "overlay-gone";
  state.closeOverlay = id => { if (id === "overlay-gone") throw new Error("no overlay overlay-gone"); return null; };
  const h = herdr();
  await h.press("cmd-m");
  assert.deepEqual(h.pickers(), [["key-1", "tab"]]);
  assert.equal(state.shared[OPEN_PICKER], "key-1");
});
