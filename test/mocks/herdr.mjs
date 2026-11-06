// The `herdr` module for tests: reads one mutable `state` and logs what a mod asks Herdr to do in `calls`.
import { resetFs } from "./fs.mjs";

const COLORS = `background surface canvas chrome popover raised hover selected border input foreground muted dim accent accent_foreground solid solid_foreground
  selection working blocked done idle unknown ${Array.from({ length: 16 }, (_, i) => `ansi${i}`).join(" ")}`.split(/\s+/);

export const state = {};
// `order`: run / openOverlay / closeOverlay / setShared in the order they happened, for "closes first, then acts".
export const calls = { run: [], openOverlay: [], closeOverlay: [], setShared: [], exec: [], hc: [], readTextFile: [], writeTextFile: [], watchFolder: [], knownAgents: [], notify: [], order: [] };

function makeStorage() {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => void data.set(k, String(v)), removeItem: k => void data.delete(k), clear: () => data.clear() };
}

// state.disk maps path -> text. writeTextFile compares `expected` with what is there (null: must not exist) and
// rejects with "stale" when they differ.
export function reset(overrides = {}) {
  Object.assign(state, {
    spaces: [], machines: [{ name: null, layout: "ready" }], focused: null, panes: [], terminals: [], layout: null,
    shared: {}, props: undefined, home: "/home/user", appHome: "/home/user/.config/herdr-app",
    exec: async () => { throw new Error("exec: nothing set up for this call"); },
    disk: new Map(),
    readTextFile: async path => (state.disk.has(path) ? state.disk.get(path) : null),
    writeTextFile: async (path, text, expected) => {
      const current = state.disk.has(path) ? state.disk.get(path) : null;
      if (expected !== current) throw new Error("stale");
      state.disk.set(path, text);
      return null;
    },
    closeOverlay: () => null, // a test that wants an overlay Herdr doesn't know has this throw
    watchFolder: () => new Promise(() => {}),
    nextCommand: () => new Promise(() => {}),
    knownAgents: async () => [],
    agents: [],
    keys: [], // [{ section: "global", keys: "cmd-t", action: "tab.new" }]
    hc: async () => { throw new Error("hc: nothing set up for this call"); },
    window: { platform: "macos", titlebar: "none", buttons: false, maximized: false, fullscreen: false, active: true },
    settings: { zoom: 1, font_family: "Mono" },
    theme: null, // what theme() answers when a test switches the theme; null: every colour named after itself
  }, overrides);
  for (const list of Object.values(calls)) list.length = 0;
  resetFs();
  globalThis.localStorage = makeStorage();
}
reset();

export const theme = () => state.theme ?? Object.fromEntries(COLORS.map(c => [c, c]));
export const spaces = () => state.spaces;
export const panes = () => state.panes;
export const terminals = () => state.terminals;
export const machines = () => state.machines;
export const focused = () => state.focused;
export const layout = () => state.layout;
export const window = () => state.window;
export const settings = () => state.settings;
export const home = () => state.home;
export const appHome = () => state.appHome;
export const props = () => state.props;
export const shared = key => state.shared[key];
export const setShared = (key, value) => { calls.order.push("setShared"); calls.setShared.push([key, value]); state.shared[key] = value; return null; };
export const run = (name, args) => { calls.order.push("run"); calls.run.push([name, args]); return null; };
export const openOverlay = spec => { calls.order.push("openOverlay"); calls.openOverlay.push(spec); return `overlay-${calls.openOverlay.length}`; };
export const closeOverlay = id => { calls.order.push("closeOverlay"); calls.closeOverlay.push(id); return state.closeOverlay(id); };
export const exec = (command, args, options) => { calls.exec.push({ command, args, options }); return state.exec(command, args, options); };
export const readTextFile = (path, options) => { calls.readTextFile.push({ path, options }); return state.readTextFile(path, options); };
export const writeTextFile = (path, text, expected) => { calls.writeTextFile.push({ path, text, expected }); return state.writeTextFile(path, text, expected); };
export const watchFolder = dir => { calls.watchFolder.push(dir); return state.watchFolder(dir); };
export const nextCommand = () => state.nextCommand();
export const knownAgents = options => { calls.knownAgents.push(options); return state.knownAgents(options); };
export const agents = () => state.agents;
export const keys = () => state.keys ?? [];
// herdr-core: what a mod passes is an argv list.
export const hc = args => { calls.hc.push(args); return state.hc(args); };
export const notify = n => { calls.notify.push(n); return `toast-${calls.notify.length}`; };
