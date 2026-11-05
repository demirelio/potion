import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { state, calls, reset, theme } from "./mocks/herdr.mjs";
import { files } from "./mocks/fs.mjs";
import { all, find, textOf } from "./mocks/element.mjs";
import { makeCx, fire_timers } from "./helpers.mjs";

const { Diagrams, diagramBlock, imagePath, mermaidHome, cacheDir } = await import("../mods/my-markdown/diagrams.js");
const { diagramKey, mermaidConfig, DIAGRAM_COLORS, sharpName, hash } = await import("../mods/my-markdown/lib.js");

const MERMAID = "/home/user/.local/share/herdr-markdown/mermaid";
const DIR = "/home/user/.config/herdr-app/data/my-markdown/diagrams";
const NODE = "/usr/local/bin/node";
const VERSION = "mmdc-12.2.0+abcd1234";
const SRC = "graph TD\nA-->B";

beforeEach(() => reset());

// Everything below runs on a cx whose settle() does not wait for tasks that never end (none here, but the editor
// tests need that and the two files do the same).
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(done => setImmediate(done)); };
function mount() {
  const cx = makeCx();
  cx.settle = flush;
  return { cx, d: new Diagrams() };
}
const install = (version = VERSION) => {
  state.disk.set(`${MERMAID}/version`, `${version}\n`);
  state.disk.set(`${MERMAID}/node-path`, `${NODE}\n`);
};
const keyFor = (source, version = VERSION) => diagramKey(source, JSON.stringify(mermaidConfig(theme())), version);
const configName = () => `config-${hash(JSON.stringify(mermaidConfig(theme())))}.json`;
// The inputs of a render.mjs call: the .mmd paths after --outdir <dir>.
const inputs = args => args.slice(5);
const keyOf = path => path.slice(path.lastIndexOf("/") + 1).replace(/\.mmd$/, "");
const renders = () => calls.exec.filter(c => c.args[0]?.endsWith("/render.mjs"));
// A renderer that draws everything 800x400 px at scale 2, as the contract says: one JSON line on stdout.
const drawsAll = async (_command, args) => ({ code: 0, stdout: `${JSON.stringify({ results: inputs(args).map(f => ({ key: keyOf(f), ok: true, width: 800, height: 400, scale: 2 })) })}\n`, stderr: "" });

// Asks for a diagram and lets the 400 ms wait and the work after it happen.
async function draw(cx, d, source = SRC) {
  d.get(source, cx);
  await flush(); // the renderer's version is read
  d.get(source, cx);
  await fire_timers(cx, { ms: 400 });
  return d.get(source, cx);
}

test("paths: the renderer lives under ~/.local/share/herdr-markdown, the cache under the app folder, images are relative to it", () => {
  assert.equal(mermaidHome(), MERMAID);
  assert.equal(cacheDir(), DIR);
  assert.equal(imagePath("abc"), "data/my-markdown/diagrams/abc.png");
  state.home = "/home/user/";
  state.appHome = "/home/user/.config/herdr-app/";
  assert.equal(mermaidHome(), MERMAID, "a trailing slash does not double");
  assert.equal(cacheDir(), DIR);
});

test("the first get answers pending at once and reads the renderer's version and node, once", async () => {
  install();
  const { cx, d } = mount();
  const first = d.get(SRC, cx);
  assert.deepEqual(first, { key: null, state: "pending", width: 0, height: 0, scale: 1, error: null }, "no key before the version is known");
  d.get("other", cx);
  await flush();
  assert.deepEqual(calls.readTextFile.map(c => c.path), [`${MERMAID}/version`, `${MERMAID}/node-path`], "asked once for both files");
  assert.deepEqual(d.renderer, { version: VERSION, node: NODE }, "both are trimmed");
  assert.equal(cx.notified > 0, true, "the view is told to draw again");
  assert.equal(d.get(SRC, cx).key, keyFor(SRC));
});

test("no version file: the renderer is missing, nothing is run or written", async () => {
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  const got = d.get(SRC, cx);
  assert.deepEqual([got.state, got.key], ["missing", hash(SRC)]);
  assert.equal(d.renderer, null);
  assert.deepEqual(cx.timers.map(t => t.ms), [10_000], "no drawing is scheduled, only the reminder to look again");
  assert.equal(calls.exec.length, 0);
  assert.equal(files.size, 0);
});

test("a version file without node-path falls back to plain node", async () => {
  state.disk.set(`${MERMAID}/version`, VERSION);
  state.exec = drawsAll;
  const { cx, d } = mount();
  assert.equal((await draw(cx, d)).state, "ok");
  assert.equal(renders()[0].command, "node");
});

test("a diagram is drawn once: sources written, one run with the contract's arguments, then ok with its size", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  const key = keyFor(SRC);
  const settled = await draw(cx, d);
  assert.deepEqual(settled, { key, state: "ok", width: 800, height: 400, scale: 2, error: null });
  assert.equal(renders().length, 1);
  assert.deepEqual(renders()[0], {
    command: NODE,
    args: [`${MERMAID}/render.mjs`, "--config", `${DIR}/${configName()}`, "--outdir", DIR, `${DIR}/${key}.mmd`],
    options: { cwd: MERMAID },
  });
  assert.equal(files.get(`${DIR}/${key}.mmd`), SRC, "the source is what the renderer reads");
  assert.equal(files.get(`${DIR}/${configName()}`), JSON.stringify(mermaidConfig(theme())), "the theme's config is written beside it");
  d.get(SRC, cx);
  await fire_timers(cx);
  assert.equal(renders().length, 1, "asking again is a lookup");
});

test("the key follows source and renderer version, and stays the same when the theme changes", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  const a = (await draw(cx, d, "graph TD\nA-->B")).key, b = d.get("graph TD\nA-->C", cx).key;
  assert.notEqual(a, b);
  assert.equal(a, keyFor("graph TD\nA-->B"));
  const again = mount();
  install("mmdc-other+1");
  again.d.get(SRC, again.cx);
  await flush();
  assert.equal(again.d.get(SRC, again.cx).key, keyFor(SRC, "mmdc-other+1"), "a new renderer draws everything again");
  const t = theme(), config = d.config;
  d.sync({ ...t, background: "#000000" });
  const dark = d.config;
  assert.deepEqual(dark, config, "the config is mermaid's own theme, whatever the Herdr theme");
  assert.equal(dark.name, configName());
  d.sync({ ...t, background: "#000000" });
  assert.equal(d.config, dark, "the same colors keep the same config object");
  state.theme = { ...t, background: "#000000" };
  assert.equal(d.get("graph TD\nA-->B", cx).key, a, "a theme switch keeps the diagram's key, so its picture is not drawn again");
  assert.equal(renders().length, 1);
});

test("a result the renderer already left in the cache is used without running it", async () => {
  install();
  const key = keyFor(SRC);
  files.set(`${DIR}/${key}.json`, JSON.stringify({ ok: true, width: 600, height: 300, scale: 2 }));
  const { cx, d } = mount();
  assert.deepEqual(await draw(cx, d), { key, state: "ok", width: 600, height: 300, scale: 2, error: null });
  assert.equal(calls.exec.length, 0);
  assert.equal(files.has(`${DIR}/${key}.mmd`), false, "nothing is written for a hit");
});

test("a cached error is shown as is; a cached timeout and a broken cache file are tried again", async () => {
  install();
  const bad = "graph TD\nbad", slow = "graph TD\nslow", junk = "graph TD\njunk";
  files.set(`${DIR}/${keyFor(bad)}.json`, JSON.stringify({ ok: false, error: "Parse error on line 2" }));
  files.set(`${DIR}/${keyFor(slow)}.json`, JSON.stringify({ ok: false, error: "Timed out" }));
  files.set(`${DIR}/${keyFor(junk)}.json`, "{not json");
  state.exec = drawsAll;
  const { cx, d } = mount();
  for (const s of [bad, slow, junk]) d.get(s, cx);
  await flush();
  for (const s of [bad, slow, junk]) d.get(s, cx);
  await fire_timers(cx, { ms: 400 });
  assert.deepEqual([bad, slow, junk].map(s => d.get(s, cx).state), ["error", "ok", "ok"]);
  assert.equal(d.get(bad, cx).error, "Parse error on line 2");
  assert.deepEqual(inputs(renders()[0].args).map(keyOf), [keyFor(slow), keyFor(junk)], "only the two without a usable answer were drawn");
});

test("a diagram the renderer cannot draw shows its message; one missing from the answer says so", async () => {
  install();
  const good = "graph TD\nA-->B", bad = "graph TD\n???", lost = "graph TD\nlost";
  state.exec = async (_c, args) => ({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: [
    { key: keyFor(good), ok: true, width: 100, height: 50, scale: 2 },
    { key: keyFor(bad), ok: false, error: "Parse error on line 2:\n???" },
  ] })}\n` });
  const { cx, d } = mount();
  for (const s of [good, bad, lost]) d.get(s, cx);
  await flush();
  for (const s of [good, bad, lost]) d.get(s, cx);
  await fire_timers(cx, { ms: 400 });
  assert.equal(d.get(good, cx).state, "ok");
  assert.deepEqual([d.get(bad, cx).state, d.get(bad, cx).error], ["error", "Parse error on line 2:\n???"]);
  assert.deepEqual([d.get(lost, cx).state, d.get(lost, cx).error], ["error", "The renderer gave no answer for this diagram"]);
});

test("the result line is the last line of stdout; garbage there fails the batch's diagrams", async () => {
  install();
  state.exec = async (_c, args) => ({ code: 0, stderr: "", stdout: `warning: something\n${JSON.stringify({ results: [{ key: keyOf(inputs(args)[0]), ok: true, width: 10, height: 10, scale: 1 }] })}\n` });
  const first = mount();
  assert.equal((await draw(first.cx, first.d)).state, "ok");
  reset();
  install();
  state.exec = async () => ({ code: 0, stdout: "not json\n", stderr: "" });
  const second = mount();
  const got = await draw(second.cx, second.d);
  assert.deepEqual([got.state, got.error], ["error", "The renderer gave no answer for this diagram"]);
});

test("a nonzero exit fails the batch with stderr, or with the exit code when stderr is empty", async () => {
  install();
  state.exec = async () => ({ code: 2, stdout: "", stderr: "render.mjs: no browser\n" });
  const first = mount();
  const a = await draw(first.cx, first.d);
  assert.deepEqual([a.state, a.error], ["error", "render.mjs: no browser"]);
  assert.equal(first.d.nodeMissing, false, "node ran: it is the renderer that failed");
  reset();
  install();
  state.exec = async () => ({ code: 1, stdout: "", stderr: "" });
  const second = mount();
  assert.equal((await draw(second.cx, second.d)).error, "The renderer stopped (exit 1)");
});

test("node missing (exec rejects): every queued diagram says Diagrams need Node.js, and nothing else is tried this round", async () => {
  install();
  state.exec = async () => { throw new Error("spawn node ENOENT"); };
  const { cx, d } = mount();
  const sources = Array.from({ length: 20 }, (_, i) => `graph TD\nA-->N${i}`);
  for (const s of sources) d.get(s, cx);
  await flush();
  for (const s of sources) d.get(s, cx);
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 1, "one try, not one per batch of 8");
  assert.ok(sources.every(s => d.get(s, cx).state === "error" && d.get(s, cx).error === "Diagrams need Node.js"));
  assert.equal(d.nodeMissing, true);
});

test("a later run that works clears the node-missing flag", async () => {
  install();
  let broken = true;
  state.exec = async (c, a, o) => { if (broken) throw new Error("ENOENT"); return drawsAll(c, a, o); };
  const { cx, d } = mount();
  await draw(cx, d, "graph TD\nA-->B");
  assert.equal(d.nodeMissing, true);
  broken = false;
  assert.equal((await draw(cx, d, "graph TD\nA-->C")).state, "ok");
  assert.equal(d.nodeMissing, false);
});

test("at most 8 inputs per run, one run at a time, in order", async () => {
  install();
  const gates = [];
  state.exec = (_c, args) => new Promise(done => gates.push(() => done({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: inputs(args).map(f => ({ key: keyOf(f), ok: true, width: 10, height: 10, scale: 1 })) })}\n` })));
  const { cx, d } = mount();
  const sources = Array.from({ length: 20 }, (_, i) => `graph TD\nA-->N${i}`);
  for (const s of sources) d.get(s, cx);
  await flush();
  for (const s of sources) d.get(s, cx);
  const fired = fire_timers(cx, { ms: 400 });
  await flush();
  assert.equal(gates.length, 1, "the second batch waits for the first");
  assert.equal(renders()[0].args.length, 5 + 8);
  gates.shift()();
  await flush();
  assert.equal(gates.length, 1);
  assert.equal(renders()[1].args.length, 5 + 8);
  gates.shift()();
  await flush();
  assert.equal(renders()[2].args.length, 5 + 4);
  gates.shift()();
  await fired;
  assert.deepEqual(renders().map(c => inputs(c.args).length), [8, 8, 4]);
  assert.deepEqual(renders().flatMap(c => inputs(c.args).map(keyOf)), sources.map(s => keyFor(s)), "in the order they were asked for");
  assert.ok(sources.every(s => d.get(s, cx).state === "ok"));
});

test("a diagram asked for while a run is going waits for the next one, and no second run starts beside it", async () => {
  install();
  const gates = [];
  state.exec = (_c, args) => new Promise(done => gates.push(() => done({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: inputs(args).map(f => ({ key: keyOf(f), ok: true, width: 10, height: 10, scale: 1 })) })}\n` })));
  const { cx, d } = mount();
  d.get("graph TD\nA-->B", cx);
  await flush();
  d.get("graph TD\nA-->B", cx);
  const first = fire_timers(cx, { ms: 400 });
  await flush();
  assert.equal(gates.length, 1);
  assert.equal(d.get("graph TD\nA-->LATE", cx).state, "pending");
  const second = fire_timers(cx, { ms: 400 }); // its timer fires while the first run is still going
  await flush();
  assert.equal(gates.length, 1, "still one run at a time");
  gates.shift()();
  await flush();
  assert.equal(gates.length, 1, "the late one goes in the next run of the same loop");
  assert.deepEqual(inputs(renders()[1].args).map(keyOf), [keyFor("graph TD\nA-->LATE")]);
  gates.shift()();
  await Promise.all([first, second]);
  assert.equal(d.get("graph TD\nA-->LATE", cx).state, "ok");
});

test("asking again within 400 ms moves the wait: one timer is left, and it runs everything together", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  d.get("graph TD\nA-->B", cx);
  await flush();
  d.get("graph TD\nA-->B", cx);
  d.get("graph TD\nA-->C", cx);
  d.get("graph TD\nA-->D", cx);
  const waits = cx.timers.filter(t => t.ms === 400);
  assert.equal(waits.length, 3);
  assert.deepEqual(waits.map(t => Boolean(t.cancelled)), [true, true, false], "each ask cancels the one before");
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 1);
  assert.equal(inputs(renders()[0].args).length, 3);
});

test("the config file is written once per config, not once per batch", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  await draw(cx, d, "graph TD\nA-->B");
  const path = `${DIR}/${configName()}`;
  assert.ok(files.has(path));
  files.delete(path);
  await draw(cx, d, "graph TD\nA-->C");
  assert.equal(files.has(path), false, "known to be there");
  assert.equal(renders().length, 2);
});

// The fs mock's writeFile stores into `files`, so a Map that refuses a path is a disk that does.
function refuse(match) {
  files.set = (path, contents) => {
    if (match.test(path)) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    return Map.prototype.set.call(files, path, contents);
  };
}

test("a folder that cannot be written fails the diagram with the reason, and the renderer is not run", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  refuse(/\.mmd$/);
  try {
    const got = await draw(cx, d);
    assert.deepEqual([got.state, got.error], ["error", "Can't write the diagram file: EACCES: permission denied"]);
    assert.equal(calls.exec.length, 0);
  } finally { delete files.set; }
});

test("a config that cannot be written fails the batch the same way", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  refuse(/config-/);
  try {
    const got = await draw(cx, d);
    assert.deepEqual([got.state, got.error], ["error", "Can't write the diagram settings: EACCES: permission denied"]);
    assert.equal(calls.exec.length, 0);
  } finally { delete files.set; }
});

test("close() cancels the wait and stops a loop that is going", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  d.get(SRC, cx);
  d.close();
  await fire_timers(cx, { ms: 400 });
  assert.equal(calls.exec.length, 0);
});

// --- After close(), nothing tells the view to draw again ------------------------------------------------------------

test("close() while the renderer's version is being read: the answer does not redraw the closed view", async () => {
  const answers = [];
  state.readTextFile = () => new Promise(done => { answers.push(done); });
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  assert.equal(answers.length, 2, "the version and node are being read");
  d.close();
  for (const answer of answers) answer("mmdc-1");
  await flush();
  assert.equal(cx.notified, 0);
  assert.equal(calls.exec.length, 0);
});

test("close() while the cache folder is being made: no redraw either", async () => {
  install();
  const { cx, d } = mount();
  // The folder's path is worked out as the mkdir starts: that is where the view closes.
  const home = state.appHome;
  Object.defineProperty(state, "appHome", { configurable: true, get() { d.close(); return home; } });
  try {
    d.get(SRC, cx);
    await flush();
    assert.equal(d.closed, true);
    assert.equal(cx.notified, 0);
  } finally { Object.defineProperty(state, "appHome", { configurable: true, writable: true, value: home }); }
});

test("an open view is told once the renderer's version is known, and again only when a later look changes it", async () => {
  install();
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  assert.equal(cx.notified, 1);
});

test("onChange(cx) is called wherever the view is redrawn, with the task's cx, so the view can ask again", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  const told = [];
  d.onChange = c => told.push([c, cx.notified, d.get(SRC, c).state]);
  await draw(cx, d);
  assert.ok(told.length >= 3);
  assert.ok(told.every(([c]) => c === cx));
  assert.deepEqual(told.map(([, n]) => n), told.map((_, i) => i + 1), "right after each redraw it asks for");
  assert.equal(told[0][2], "pending");
  assert.equal(told.at(-1)[2], "ok", "the last one finds the image");
});

test("close() while a run is out: when it answers nothing redraws, and nothing more is started", async () => {
  install();
  let finish;
  state.exec = (_c, args) => new Promise(done => { finish = () => done({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: inputs(args).map(f => ({ key: keyOf(f), ok: true, width: 10, height: 10, scale: 1 })) })}\n` }); });
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  d.get(SRC, cx);
  const fired = fire_timers(cx, { ms: 400 });
  await flush();
  const before = cx.notified;
  d.get("graph TD\nA-->LATE", cx);
  d.close();
  finish();
  await fired;
  assert.equal(cx.notified, before);
  assert.equal(calls.exec.length, 1, "the late one is not run");
});

test("close() while a diagram's source is being written or looked up: no redraw", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  d.get(SRC, cx);
  const before = cx.notified;
  // The disk is where the view closes: the write of the diagram's source is the first await of the round.
  files.set = (path, contents) => {
    if (/\.mmd$/.test(path)) d.close();
    return Map.prototype.set.call(files, path, contents);
  };
  try {
    await fire_timers(cx, { ms: 400 });
    assert.equal(cx.notified, before);
    assert.equal(calls.exec.length, 0, "no run after the close");
  } finally { delete files.set; }
});

test("close() while the config is being written: no redraw, no run", async () => {
  install();
  state.exec = drawsAll;
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  d.get(SRC, cx);
  const before = cx.notified;
  files.set = (path, contents) => {
    if (/config-/.test(path)) d.close();
    return Map.prototype.set.call(files, path, contents);
  };
  try {
    await fire_timers(cx, { ms: 400 });
    assert.equal(cx.notified - before, 1, "the redraw after the lookups (before the config was written), none after the close");
    assert.equal(calls.exec.length, 0, "no run after the close");
  } finally { delete files.set; }
});

// --- A renderer that is not installed is looked for again; a failed run is tried again -----------------------------

// The clock the retries read, held by the test: now() moves only when a test says so.
function clock(t, start = 1_000_000) {
  const time = { now: start };
  t.mock.method(Date, "now", () => time.now);
  return time;
}
const reads = () => calls.readTextFile.filter(c => c.path === `${MERMAID}/version`).length;

test("a renderer that is not installed is looked for again once get() runs more than 10 s after the last look", async t => {
  const time = clock(t);
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  assert.equal(d.get(SRC, cx).state, "missing");
  assert.equal(reads(), 1);
  time.now += 9_999;
  d.get(SRC, cx);
  await flush();
  assert.equal(reads(), 1, "not yet");
  time.now += 2; // 10 001 ms after the look
  install();
  const during = d.get(SRC, cx);
  assert.equal(during.state, "missing", "until the look is done it is still missing");
  d.get(SRC, cx);
  await flush();
  assert.equal(reads(), 2, "once, however often get() is called meanwhile");
  assert.deepEqual(d.renderer, { version: VERSION, node: NODE });
  assert.equal(cx.notified > 0, true, "the view is told to draw again");
  state.exec = drawsAll;
  d.get(SRC, cx);
  await fire_timers(cx, { ms: 400 });
  assert.equal(d.get(SRC, cx).state, "ok", "drawn without reopening the tab");
  time.now += 60_000;
  d.get(SRC, cx);
  await flush();
  assert.equal(reads(), 2, "an installed renderer is not looked for again");
});

test("a look that still finds nothing waits another 10 s and draws nothing", async t => {
  const time = clock(t);
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  const notified = cx.notified;
  time.now += 10_001;
  d.get(SRC, cx);
  await flush();
  assert.equal(reads(), 2);
  assert.equal(cx.notified, notified, "nothing new to show");
  assert.equal(d.get(SRC, cx).state, "missing");
  time.now += 5_000;
  d.get(SRC, cx);
  await flush();
  assert.equal(reads(), 2, "10 s from the second look, not the first");
  time.now += 5_002;
  d.get(SRC, cx);
  await flush();
  assert.equal(reads(), 3);
});

test("a renderer whose version file cannot be read counts as missing and is looked for again", async t => {
  const time = clock(t);
  let broken = true;
  state.readTextFile = async path => { if (broken) throw new Error("EIO"); return state.disk.get(path) ?? null; };
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  assert.equal(d.get(SRC, cx).state, "missing");
  broken = false;
  install();
  time.now += 10_001;
  d.get(SRC, cx);
  await flush();
  assert.equal(d.renderer?.version, VERSION);
});

const RETRY_MS = 15_000, RECHECK_MS = 10_000;

test("node missing is tried again after 15 s: the error shows meanwhile, and a run that works clears the flag", async t => {
  const time = clock(t);
  install();
  let broken = true;
  state.exec = async (c, a, o) => { if (broken) throw new Error("ENOENT"); return drawsAll(c, a, o); };
  const { cx, d } = mount();
  const first = await draw(cx, d);
  assert.deepEqual([first.state, first.error, first.retryAt], ["error", "Diagrams need Node.js", time.now + RETRY_MS]);
  assert.equal(d.nodeMissing, true);
  time.now += RETRY_MS - 1;
  assert.equal(d.get(SRC, cx).state, "error");
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 1, "not before the time is up");
  broken = false;
  time.now += 1;
  const during = d.get(SRC, cx);
  assert.deepEqual([during.state, during.error], ["error", "Diagrams need Node.js"], "the error stays until the new answer");
  assert.equal(d.get(SRC, cx).state, "error");
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 2);
  assert.equal(d.get(SRC, cx).state, "ok");
  assert.equal(d.nodeMissing, false);
});

test("a nonzero exit is tried again after 15 s, and so is a timeout; each comes back as ok when the run works", async t => {
  const time = clock(t);
  install();
  let mode = "exit";
  state.exec = async (c, a, o) => {
    if (mode === "exit") return { code: 2, stdout: "", stderr: "render.mjs: no browser\n" };
    if (mode === "timeout") return { code: 0, stderr: "", stdout: `${JSON.stringify({ results: inputs(a).map(f => ({ key: keyOf(f), ok: false, error: "Timed out" })) })}\n` };
    return drawsAll(c, a, o);
  };
  const { cx, d } = mount();
  const failed = await draw(cx, d);
  assert.deepEqual([failed.error, failed.retryAt], ["render.mjs: no browser", time.now + RETRY_MS]);
  time.now += RETRY_MS;
  mode = "timeout";
  d.get(SRC, cx);
  await fire_timers(cx, { ms: 400 });
  const slow = d.get(SRC, cx);
  assert.deepEqual([slow.state, slow.error, slow.retryAt], ["error", "Timed out", time.now + RETRY_MS]);
  assert.equal(renders().length, 2);
  time.now += RETRY_MS - 1;
  d.get(SRC, cx);
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 2, "15 s from the second failure");
  time.now += 1;
  mode = "works";
  d.get(SRC, cx);
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 3);
  assert.deepEqual(d.get(SRC, cx), { key: keyFor(SRC), state: "ok", width: 800, height: 400, scale: 2, error: null });
  time.now += 10 * RETRY_MS;
  d.get(SRC, cx);
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 3, "an answer is never asked for again");
});

test("what mermaid says about one diagram is final: its error is not tried again, however long it waits", async t => {
  const time = clock(t);
  install();
  const bad = "graph TD\n???", lost = "graph TD\nlost";
  state.exec = async (_c, args) => ({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: [{ key: keyFor(bad), ok: false, error: "Parse error on line 2" }] })}\n` });
  const { cx, d } = mount();
  d.get(bad, cx);
  d.get(lost, cx);
  await flush();
  d.get(bad, cx);
  d.get(lost, cx);
  await fire_timers(cx, { ms: 400 });
  const a = d.get(bad, cx), b = d.get(lost, cx);
  assert.deepEqual([a.error, a.retryAt, b.error, b.retryAt], ["Parse error on line 2", undefined, "The renderer gave no answer for this diagram", undefined]);
  time.now += 10 * RETRY_MS;
  d.get(bad, cx);
  d.get(lost, cx);
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 1);
  assert.deepEqual([d.get(bad, cx).error, d.get(lost, cx).error], ["Parse error on line 2", "The renderer gave no answer for this diagram"]);
});

test("a diagram of a failed batch alone is asked for again; the ones that were drawn in the same run are not", async t => {
  const time = clock(t);
  install();
  const good = "graph TD\nA-->B", slow = "graph TD\nslow";
  let round = 0;
  state.exec = async (_c, args) => ({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: inputs(args).map(f => (round === 0 && keyOf(f) === keyFor(slow)
    ? { key: keyOf(f), ok: false, error: "Timed out" } : { key: keyOf(f), ok: true, width: 10, height: 10, scale: 1 })) })}\n` });
  const { cx, d } = mount();
  d.get(good, cx); d.get(slow, cx);
  await flush();
  d.get(good, cx); d.get(slow, cx);
  await fire_timers(cx, { ms: 400 });
  assert.deepEqual([d.get(good, cx).state, d.get(slow, cx).state], ["ok", "error"]);
  time.now += RETRY_MS;
  round = 1;
  d.get(good, cx); d.get(slow, cx);
  await fire_timers(cx, { ms: 400 });
  assert.deepEqual(inputs(renders()[1].args).map(keyOf), [keyFor(slow)], "only the one that timed out");
  assert.deepEqual([d.get(good, cx).state, d.get(slow, cx).state], ["ok", "ok"]);
});

test("a retry that is due is asked for once, and a draw during the run does not start it again", async t => {
  const time = clock(t);
  install();
  let broken = true;
  const gates = [];
  state.exec = (c, a, o) => {
    if (broken) return Promise.reject(new Error("ENOENT"));
    return new Promise(done => gates.push(() => done(drawsAll(c, a, o))));
  };
  const { cx, d } = mount();
  await draw(cx, d);
  broken = false;
  time.now += RETRY_MS;
  d.get(SRC, cx);
  const fired = fire_timers(cx, { ms: 400 });
  await flush();
  assert.equal(gates.length, 1);
  d.get(SRC, cx); d.get(SRC, cx); // the view draws while the run is out
  await flush();
  gates.shift()();
  await fired;
  await flush();
  assert.equal(renders().length, 2, "no third run");
  assert.equal(d.get(SRC, cx).state, "ok");
});

test("a run that fails again during the retry does not loop: the next try is another 15 s away", async t => {
  const time = clock(t);
  install();
  state.exec = async () => { throw new Error("ENOENT"); };
  const { cx, d } = mount();
  await draw(cx, d);
  time.now += RETRY_MS;
  d.get(SRC, cx);
  d.get(SRC, cx);
  await fire_timers(cx, { ms: 400 });
  await flush();
  assert.equal(renders().length, 2);
  assert.equal(d.get(SRC, cx).retryAt, time.now + RETRY_MS);
  await fire_timers(cx);
  assert.equal(renders().length, 2);
});

// A view that asks for SRC whenever it is told something changed, and at no other time.
function asking(d) {
  const answers = [];
  d.onChange = c => answers.push(d.get(SRC, c).state);
  return answers;
}
// The reminders still to come (the 400 ms waits before a run are not reminders).
const reminders = cx => cx.timers.filter(x => !x.ran && !x.cancelled && x.ms > 400).map(x => x.ms);

test("with nothing else drawing, the view is reminded 10 s after a look that found no renderer, so an install shows up", async t => {
  const time = clock(t);
  const { cx, d } = mount();
  const answers = asking(d);
  d.get(SRC, cx);
  await flush();
  assert.equal(d.get(SRC, cx).state, "missing");
  assert.deepEqual(reminders(cx), [RECHECK_MS]);
  time.now += RECHECK_MS;
  await fire_timers(cx, { ms: RECHECK_MS });
  assert.equal(reads(), 2, "the reminder made the view ask, and the look was due");
  assert.equal(d.get(SRC, cx).state, "missing");
  assert.deepEqual(reminders(cx), [RECHECK_MS], "still nothing: reminded again");
  install();
  state.exec = drawsAll;
  time.now += RECHECK_MS;
  await fire_timers(cx, { ms: RECHECK_MS });
  await fire_timers(cx, { ms: 400 });
  assert.equal(answers.at(-1), "ok", "drawn without the view drawing for any other reason");
  assert.deepEqual(reminders(cx), [], "an installed renderer needs no reminder");
});

test("with nothing else drawing, a failed run reminds the view 15 s later, so the retry happens", async t => {
  const time = clock(t);
  install();
  let broken = true;
  state.exec = async (c, a, o) => { if (broken) return { code: 1, stdout: "", stderr: "no browser" }; return drawsAll(c, a, o); };
  const { cx, d } = mount();
  const answers = asking(d);
  assert.equal((await draw(cx, d)).state, "error");
  assert.deepEqual(reminders(cx), [RETRY_MS]);
  broken = false;
  time.now += RETRY_MS;
  await fire_timers(cx, { ms: RETRY_MS });
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 2);
  assert.equal(answers.at(-1), "ok");
  assert.deepEqual(reminders(cx), [], "an answer needs no reminder");
});

test("a diagram's own error sets no reminder, and close() cancels the ones that are waiting", async () => {
  const { cx, d } = mount();
  d.get(SRC, cx);
  await flush();
  assert.deepEqual(reminders(cx), [RECHECK_MS]);
  d.close();
  assert.deepEqual(reminders(cx), []);
  reset();
  install();
  state.exec = async (_c, args) => ({ code: 0, stderr: "", stdout: `${JSON.stringify({ results: inputs(args).map(f => ({ key: keyOf(f), ok: false, error: "Parse error on line 2" })) })}\n` });
  const other = mount();
  assert.equal((await draw(other.cx, other.d)).error, "Parse error on line 2");
  assert.deepEqual(reminders(other.cx), []);
});

// What a frame draws, as the editor hands it over: 800x400 natural px in a 1000x300 frame 60 px left of the column.
const frameOf = (more = {}, view = {}) => ({
  key: "b7", w: 1000, h: 300, ml: -60, natW: 800, natH: 400, image: "k1", dim: false, selected: false,
  ...more, view: { z: 1.25, x: -40.4, y: -120.6, sharp: "", tools: null, cursor: "grab", ...view },
});

const dotTiles = el => all(el, n => n.kind === "svg" && n.path === "mods/my-markdown/dots.svg");

test("diagramBlock, ok: a frame on the diagram canvas with its dot grid first, that clips the picture, which is moved and scaled inside it; the edge goes over it", () => {
  const t = { ...theme(), background: "#122738", foreground: "#ffffff" };
  const d = { key: "k1", state: "ok", width: 1600, height: 800, scale: 2, error: null };
  const el = diagramBlock({ id: "md-diagram-b7", source: SRC, d, frame: frameOf(), t, mono: "Mono" });
  assert.ok(find(el, "md-diagram-b7"), "the element carries the block's id");
  const frame = find(el, "md-frame-b7");
  assert.deepEqual([frame.style.ml, frame.style.w, frame.style.h, frame.style.relative, frame.style.overflow_hidden, frame.style.rounded, frame.style.flex_none],
    [-60, 1000, 300, true, true, 8, true]);
  assert.equal(frame.style.bg, DIAGRAM_COLORS.canvas, "the Live Editor's canvas, whatever the Herdr theme");
  const img = all(el, n => n.kind === "image");
  assert.equal(img.length, 1);
  assert.equal(img[0].path, "data/my-markdown/diagrams/k1.png");
  assert.deepEqual([img[0].style.absolute, img[0].style.left, img[0].style.top, img[0].style.w, img[0].style.h, img[0].style.opacity], [true, -40, -121, 1000, 500, undefined]);
  const edge = find(el, "md-frame-edge-b7");
  assert.deepEqual([edge.style.inset_0, edge.style.border_1, edge.style.border_color, edge.style.rounded], [true, true, DIAGRAM_COLORS.edge, 8]);
  assert.deepEqual(frame.kids.map(k => k.kind === "image" ? "image" : k.id), ["md-frame-dots-b7", "image", "md-frame-edge-b7"], "the dots first, the edge last");
  assert.equal(frame.style.cursor_grab, true);
  const panning = find(diagramBlock({ id: "x", source: SRC, d, frame: frameOf({}, { cursor: "grabbing" }), t, mono: "Mono" }), "md-frame-b7");
  assert.equal(panning.style.cursor_grabbing, true);
  assert.equal(panning.style.cursor_grab, undefined);
  const plain = find(diagramBlock({ id: "x", source: SRC, d, frame: frameOf({}, { cursor: "default" }), t, mono: "Mono" }), "md-frame-b7");
  assert.deepEqual([plain.style.cursor_default, plain.style.cursor_grab, plain.style.cursor_grabbing], [true, undefined, undefined], "a view that says default draws it");
});

test("diagramBlock: the dot grid is 240 px tiles of dots.svg in the dot colour, covering the frame and shifted with the picture modulo 30 px", () => {
  const t = theme();
  const d = { key: "k1", state: "ok", width: 1600, height: 800, scale: 2, error: null };
  const dots = find(diagramBlock({ id: "x", source: SRC, d, frame: frameOf(), t, mono: "Mono" }), "md-frame-dots-b7");
  assert.deepEqual([dots.style.absolute, dots.style.inset_0], [true, true]);
  const tiles = dotTiles(dots);
  assert.equal(tiles.length, 10, "5 columns by 2 rows cover 1000 x 300");
  for (const tile of tiles) {
    assert.deepEqual([tile.path, tile.style.absolute, tile.style.size, tile.style.text_color], ["mods/my-markdown/dots.svg", true, 240, DIAGRAM_COLORS.dot]);
  }
  assert.deepEqual([...new Set(tiles.map(n => n.style.left))], [-10, 230, 470, 710, 950], "x -40.4 is 20 px past a grid line, less one 30 px cell");
  assert.deepEqual([...new Set(tiles.map(n => n.style.top))], [-1, 239], "y -120.6 is 29 px past a grid line, less one 30 px cell");
  const moved = dotTiles(diagramBlock({ id: "x", source: SRC, d, frame: frameOf({}, { x: 5, y: 30 }), t, mono: "Mono" }));
  assert.deepEqual([...new Set(moved.map(n => n.style.left))], [-25, 215, 455, 695, 935], "x 5: 5 px past a grid line, less one cell");
  assert.deepEqual([...new Set(moved.map(n => n.style.top))], [-30, 210], "y 30 is a whole cell: no shift past the one cell");
});

test("diagramBlock: the sharp picture lies over the base in the same box; a selected frame draws its tint over both, under the edge", () => {
  const t = theme();
  const d = { key: "k1", state: "ok", width: 1600, height: 800, scale: 2, error: null };
  const sharp = sharpName("k1", "transparent", 4);
  const el = diagramBlock({ id: "x", source: SRC, d, frame: frameOf({ selected: true }, { sharp }), t, mono: "Mono" });
  const frame = find(el, "md-frame-b7"), img = all(el, n => n.kind === "image");
  assert.deepEqual(img.map(i => i.path), ["data/my-markdown/diagrams/k1.png", `data/my-markdown/diagrams/${sharp}.png`]);
  assert.deepEqual([img[1].style.left, img[1].style.top, img[1].style.w, img[1].style.h], [img[0].style.left, img[0].style.top, img[0].style.w, img[0].style.h]);
  const tint = find(el, "md-frame-tint-b7");
  assert.deepEqual([tint.style.inset_0, tint.style.bg, tint.style.opacity], [true, "selection", 0.5]);
  assert.deepEqual(frame.kids.map(k => k.kind === "image" ? "image" : k.id), ["md-frame-dots-b7", "image", "image", "md-frame-tint-b7", "md-frame-edge-b7"]);
});

test("diagramBlock: the − % + group at the top right while the view says so; a cell at its limit is dim", () => {
  const t = theme();
  const d = { key: "k1", state: "ok", width: 1600, height: 800, scale: 2, error: null };
  assert.equal(find(diagramBlock({ id: "x", source: SRC, d, frame: frameOf(), t, mono: "Mono" }), "md-frame-tools-b7"), null, "none without the pointer");
  const el = diagramBlock({ id: "x", source: SRC, d, frame: frameOf({}, { tools: { top: 40, pct: 125, out: true, in: false } }), t, mono: "Mono" });
  const tools = find(el, "md-frame-tools-b7");
  assert.deepEqual([tools.style.absolute, tools.style.top, tools.style.right, tools.style.h, tools.style.rounded, tools.style.border_1, tools.style.text_size],
    [true, 40, 8, 26, 7, true, 12]);
  assert.deepEqual([tools.style.bg, tools.style.border_color, tools.style.text_color], [DIAGRAM_COLORS.node, DIAGRAM_COLORS.edge, DIAGRAM_COLORS.text], "slate on the canvas, whatever the Herdr theme");
  assert.deepEqual(tools.kids.map(k => [k.id, k.style.w]), [["md-frame-out-b7", 26], ["md-frame-pct-b7", 48], ["md-frame-in-b7", 26]]);
  assert.equal(all(find(el, "md-frame-out-b7"), n => n.kind === "svg")[0].path, "mods/my-markdown/minus.svg");
  assert.equal(all(find(el, "md-frame-in-b7"), n => n.kind === "svg")[0].path, "mods/my-markdown/plus.svg");
  assert.equal(textOf(find(el, "md-frame-pct-b7")), "125%");
  const out = find(el, "md-frame-out-b7"), plus = find(el, "md-frame-in-b7");
  assert.deepEqual([out.style.cursor_pointer, out.hover, out.style.text_color], [true, true, undefined]);
  assert.deepEqual([plus.style.cursor_pointer, plus.hover, plus.style.text_color], [undefined, false, "dim"], "200 %: + does nothing");
  assert.equal(all(el, n => n.kind === "image").length, 1, "the group adds no picture");
});

test("diagramBlock, pending: a 120 px box with the spinner; with a last image the frame shows it dimmed instead", () => {
  const t = theme();
  const pending = { key: "k2", state: "pending", width: 0, height: 0, scale: 1, error: null };
  const box = diagramBlock({ id: "md-diagram-0", source: SRC, d: pending, frame: null, t, mono: "Mono" });
  assert.match(textOf(box), /Drawing diagram…/);
  assert.equal(all(box, n => n.kind === "image").length, 0);
  const spinner = all(box, n => n.kind === "svg");
  assert.deepEqual([spinner.length, spinner[0].path, spinner[0].style.spin, spinner[0].style.size], [1, "mods/my-markdown/spinner.svg", 900, 14]);
  assert.equal(all(box, n => n.style.h === 120).length, 1);
  const pendingBox = all(box, n => n.style.h === 120)[0];
  assert.deepEqual([pendingBox.style.bg, pendingBox.style.border_color, pendingBox.style.text_color], [DIAGRAM_COLORS.canvas, DIAGRAM_COLORS.edge, DIAGRAM_COLORS.line], "the diagram canvas with its edge and line colours");
  const dim = diagramBlock({ id: "md-diagram-0", source: SRC, d: pending, frame: frameOf({ image: "old", dim: true }), t, mono: "Mono" });
  assert.doesNotMatch(textOf(dim), /Drawing diagram/);
  const img = all(dim, n => n.kind === "image");
  assert.deepEqual([img.length, img[0].path, img[0].style.opacity], [1, "data/my-markdown/diagrams/old.png", 0.5]);
});

test("diagramBlock, error: the title in the blocked color, the message in the terminal font, then the last image dimmed in its frame", () => {
  const t = theme();
  const d = { key: "k3", state: "error", width: 0, height: 0, scale: 1, error: "Parse error on line 2" };
  const bare = diagramBlock({ id: "md-diagram-0", source: SRC, d, frame: null, t, mono: "Mono" });
  const title = all(bare, n => n.kind === "text" && n.text === "Mermaid error");
  assert.equal(title.length, 1);
  assert.equal(all(bare, n => n.kids.some(k => k.text === "Mermaid error") && n.style.text_color === "blocked").length, 1);
  const message = all(bare, n => n.kids.some(k => k.text === "Parse error on line 2"))[0];
  assert.deepEqual([message.style.font_family, message.style.text_size], ["Mono", 12]);
  assert.equal(all(bare, n => n.kind === "image").length, 0);
  const both = diagramBlock({ id: "md-diagram-0", source: SRC, d, frame: frameOf({ image: "old", dim: true }), t, mono: "Mono" });
  assert.equal(all(both, n => n.kind === "image")[0].style.opacity, 0.5);
  assert.match(textOf(both), /Mermaid error/);
  assert.equal(find(both, "md-diagram-0").kids.at(-1).id, "md-frame-b7", "the frame below the message");
  const empty = diagramBlock({ id: "md-diagram-0", source: SRC, d: { ...d, error: null }, frame: null, t, mono: "Mono" });
  assert.match(textOf(empty), /Mermaid could not draw this diagram/);
});

const sharpRuns = () => renders().filter(c => c.args.includes("--background"));
// A renderer that draws the base pictures 800x400 at 2x and a sharp one at the scale it is asked for.
const drawsSharp = async (command, args, options) => {
  const at = args.indexOf("--scale");
  if (at < 0) return drawsAll(command, args, options);
  const scale = Number(args[at + 1]);
  return { code: 0, stderr: "", stdout: `${JSON.stringify({ results: inputs(args).slice(4).map(f => ({ key: keyOf(f), ok: true, width: 400 * scale, height: 200 * scale, scale })) })}\n` };
};

test("sharp(): one run with one input, <key>-<colour>-x<scale·100>.mmd, at its scale on a transparent background; then ok with its size", async () => {
  install();
  state.exec = drawsSharp;
  const { cx, d } = mount();
  const key = (await draw(cx, d)).key, name = sharpName(key, "transparent", 4);
  const changes = [];
  d.onChange = () => changes.push(d.sharpOf(key)?.state);
  assert.deepEqual(d.sharp(key, SRC, 4, cx), { key: name, state: "pending", width: 0, height: 0, scale: 4, error: null });
  await flush();
  assert.equal(sharpRuns().length, 1);
  assert.deepEqual(sharpRuns()[0], {
    command: NODE,
    args: [`${MERMAID}/render.mjs`, "--config", `${DIR}/${configName()}`, "--outdir", DIR, "--scale", "4", "--background", "transparent", `${DIR}/${name}.mmd`],
    options: { cwd: MERMAID },
  });
  assert.equal(files.get(`${DIR}/${name}.mmd`), SRC);
  assert.deepEqual(d.sharpOf(key), { key: name, state: "ok", width: 1600, height: 800, scale: 4, error: null });
  assert.deepEqual(changes, ["ok"], "the view is told once it is there");
  d.sharp(key, SRC, 4, cx);
  d.sharp(key, SRC, 2.5, cx);
  await flush();
  assert.equal(sharpRuns().length, 1, "one sharp picture per diagram");
});

test("sharp(): a picture the renderer left in the cache is used without a run; one asked for during a base round waits for it", async () => {
  install();
  state.exec = drawsSharp;
  const { cx, d } = mount();
  const key = (await draw(cx, d)).key;
  const name = sharpName(key, "transparent", 2.5);
  files.set(`${DIR}/${name}.json`, JSON.stringify({ ok: true, width: 1000, height: 500, scale: 2.5 }));
  d.sharp(key, SRC, 2.5, cx);
  await flush();
  assert.deepEqual([sharpRuns().length, d.sharpOf(key).state, d.sharpOf(key).key], [0, "ok", name]);
  const other = "graph TD\nX-->Y";
  d.get(other, cx);
  await fire_timers(cx, { ms: 400 });
  assert.equal(renders().length, 2);
  const otherKey = keyFor(other);
  d.want.set("waiting", "graph TD\nQ-->R");
  d.sharp(otherKey, other, 4, cx);
  await flush();
  assert.deepEqual(renders().slice(2).map(c => c.args.includes("--scale") ? "sharp" : "base"), ["base", "sharp"], "the base round goes first");
});

test("sharp(): an error keeps the base and is not asked for again; nothing before the renderer is known", async () => {
  install();
  const { cx, d } = mount();
  assert.equal(d.sharp("k", SRC, 4, cx), null, "the renderer is not known yet");
  state.exec = async (command, args, options) => (args.includes("--scale")
    ? { code: 0, stderr: "", stdout: `${JSON.stringify({ results: [{ key: keyOf(args.at(-1)), ok: false, error: "Timed out" }] })}\n` }
    : drawsAll(command, args, options));
  const base = await draw(cx, d);
  d.sharp(base.key, SRC, 4, cx);
  await flush();
  assert.deepEqual([d.sharpOf(base.key).state, d.sharpOf(base.key).error], ["error", "Timed out"]);
  assert.equal(d.get(SRC, cx).state, "ok", "the base stays");
  d.sharp(base.key, SRC, 4, cx);
  await flush();
  assert.equal(sharpRuns().length, 1, "not tried again");
});

test("diagramBlock, missing renderer: how to install it, and the source as a code block that cannot be closed early", () => {
  const t = theme();
  const d = { key: "k4", state: "missing", width: 0, height: 0, scale: 1, error: null };
  const el = diagramBlock({ id: "md-diagram-6", source: SRC, d, last: undefined, width: 700, t, mono: "Mono" });
  assert.match(textOf(el), /Diagrams need the mermaid renderer/);
  assert.equal(all(el, n => n.kids.some(k => k.text === "Diagrams need the mermaid renderer") && n.style.text_color === "foreground").length, 1, "an instruction, not an error: the normal text color");
  assert.match(textOf(el), /Run install\.sh in the herdr-markdown folder/);
  const code = find(el, "md-diagram-6-source");
  assert.equal(code.kind, "textview");
  assert.equal(code.markdown, "```mermaid\ngraph TD\nA-->B\n```");
  assert.equal(code.style.selectable, true);
  const tricky = diagramBlock({ id: "md-diagram-6", source: "A[\"```\"]", d, last: undefined, width: 700, t, mono: "Mono" });
  assert.equal(find(tricky, "md-diagram-6-source").markdown, "````mermaid\nA[\"```\"]\n````");
});
