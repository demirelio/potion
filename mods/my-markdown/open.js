// Opening a markdown file: beside the focused pane in the current tab (place "pane"), or in a tab of its own (place
// "tab"). Which pane shows which file lives in shared state ("my-markdown.panes": pane id -> fileKey), filed by each
// pane's editor the first time it is drawn: panes() does not say what a mod pane shows. Mods cannot import each
// other, so the files integration carries a copy of openMarkdown (test/integrations.test.mjs checks that the copy
// acts alike).
import { spaces, panes, focused, machines, shared, setShared, run } from "herdr";
import { basename, fileKey, remember } from "./lib.js";

const MOD = "my-markdown", PANES = "my-markdown.panes", RECENT = "my-markdown.recent", RECENT_MAX = 30;

// place "pane": the pane already showing the file in that tab gets the focus, else the file opens to the right of
// `pane` (default: the focused one, else the tab's first). With no pane to open beside, it opens as a tab.
// place "tab": goes to the file's own tab (every pane in it a Markdown pane, one of them this file's) in any space,
// else opens one in `space`. A tab drawn before the registry knew it (restored in the background) is found by its
// name when all its panes are still unknown and it is the only one.
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

// Files `pane` under the file's key. Forgets the entries of panes that are gone, but only while every machine's
// layout is loaded (an offline machine's panes are not in panes(), and are not gone). Writes only on a change.
export function registerPane(pane, file, machine = null) {
  if (!pane) return;
  const before = shared(PANES) ?? {}, list = { ...before, [pane]: fileKey(machine, file) };
  if (machines().every(m => m.layout === "ready")) {
    const live = new Set(panes().map(p => p.pane));
    for (const id of Object.keys(list)) if (!live.has(id)) delete list[id];
  }
  if (JSON.stringify(list) !== JSON.stringify(before)) setShared(PANES, list);
}

// The pane in `tab` that a copy showing `file` is drawn in: the one the registry already files under the file, else
// the only Markdown pane of the tab the registry does not know yet. null while that is not certain (two unknown ones).
export function paneOf(tab, file, machine = null) {
  const key = fileKey(machine, file), known = shared(PANES) ?? {};
  const mine = panes().filter(p => p.tab === tab && p.mod === MOD);
  const filed = mine.find(p => known[p.pane] === key);
  if (filed) return { pane: filed.pane, filed: true };
  const fresh = mine.filter(p => !(p.pane in known));
  return fresh.length === 1 ? { pane: fresh[0].pane, filed: false } : null;
}

// The last 30 files opened, newest first, each once ({ machine, path }; the same path on another machine is another file).
export function rememberRecent(file, machine = null) {
  const list = shared(RECENT), same = (a, b) => a.path === b.path && (a.machine ?? null) === (b.machine ?? null);
  setShared(RECENT, remember(Array.isArray(list) ? list : [], { machine: machine ?? null, path: file }, same, RECENT_MAX));
}
