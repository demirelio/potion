// panes() does not say what a mod pane shows, so each pane's editor files its file in shared state (PANES: pane id ->
// fileKey) the first time it is drawn. Mods cannot import each other: the files integration carries a copy of
// openMarkdown (test/integrations.test.mjs checks that the copy acts alike).
import { spaces, panes, focused, machines, shared, setShared, run } from "herdr";
import { basename, fileKey, remember } from "./lib.js";

export const MOD = "potion", PANES = "potion.panes", RECENT = "potion.recent";
const RECENT_MAX = 30;

// place "pane" focuses the pane already showing the file in that tab, else splits right of `pane` (default: the focused
// one, else the tab's first); with no pane to open beside it falls through to a tab. place "tab" selects the file's own
// tab in any space, else opens one in `space`.
// A tab restored in the background is not in the registry yet: it is found by its name when all its panes are unknown
// and it is the only such tab.
export function openMarkdown({ file, machine = null, place = "tab", space, pane }) {
  const key = fileKey(machine, file), known = shared(PANES) ?? {}, all = panes();
  const mine = all.filter(p => p.mod === MOD);
  const spaceOf = tab => spaces().find(s => s.tabs.some(c => c.id === tab));
  if (place === "pane") {
    const f = focused();
    const anchor = all.find(p => p.pane === pane) ?? all.find(p => p.pane === f?.pane) ?? all.find(p => p.tab === f?.tab);
    if (anchor) {
      const hit = mine.find(p => p.tab === anchor.tab && known[p.pane] === key);
      if (hit) run("pane.focus", { pane: hit.pane });
      else run("pane.split", { direction: "right", pane: anchor.pane, mod: MOD, props: { file, machine } });
      rememberRecent(file, machine);
      return;
    }
  }
  const inTab = tab => all.filter(p => p.tab === tab);
  const ownTab = tab => { const list = inTab(tab); return list.length > 0 && list.every(p => p.mod === MOD); };
  let hit = mine.find(p => known[p.pane] === key && ownTab(p.tab) && spaceOf(p.tab))?.tab;
  if (!hit) {
    const name = basename(file);
    const open = spaces().flatMap(s => s.tabs).filter(c => c.name === name && ownTab(c.id) && inTab(c.id).every(p => !(p.pane in known)));
    if (open.length === 1) hit = open[0].id;
  }
  if (hit) {
    run("space.select", { id: spaceOf(hit).id });
    run("tab.select", { id: hit });
  } else {
    run("tab.new", { name: basename(file), ...(space == null ? {} : { space }), mod: MOD, props: { file, machine } });
  }
  rememberRecent(file, machine);
}

// Entries of closed panes are dropped only while every machine's layout is loaded: an offline machine's panes are not
// in panes(), but they are not gone.
export function registerPane(pane, file, machine = null) {
  if (!pane) return;
  const before = shared(PANES) ?? {}, list = { ...before, [pane]: fileKey(machine, file) };
  if (machines().every(m => m.layout === "ready")) {
    const live = new Set(panes().map(p => p.pane));
    for (const id of Object.keys(list)) if (!live.has(id)) delete list[id];
  }
  if (JSON.stringify(list) !== JSON.stringify(before)) setShared(PANES, list);
}

// A pane the registry does not know yet counts only when it is the tab's one unknown Markdown pane; else null.
export function paneOf(tab, file, machine = null) {
  const key = fileKey(machine, file), known = shared(PANES) ?? {};
  const mine = panes().filter(p => p.tab === tab && p.mod === MOD);
  const filed = mine.find(p => known[p.pane] === key);
  if (filed) return { pane: filed.pane, filed: true };
  const fresh = mine.filter(p => !(p.pane in known));
  return fresh.length === 1 ? { pane: fresh[0].pane, filed: false } : null;
}

export function rememberRecent(file, machine = null) {
  const list = shared(RECENT), same = (a, b) => a.path === b.path && (a.machine ?? null) === (b.machine ?? null);
  setShared(RECENT, remember(Array.isArray(list) ? list : [], { machine: machine ?? null, path: file }, same, RECENT_MAX));
}
