import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// These run tools/mermaid/render.mjs the way the herdr-inline-markdown mod does: the installed copy, started with the node
// from node-path. Without install.sh having installed the renderer there is nothing to run, so they skip.
const HOME = process.env.HERDR_MERMAID_HOME ?? join(homedir(), ".local/share/herdr-inline-markdown/mermaid");
const REPO_RENDER = new URL("../tools/mermaid/render.mjs", import.meta.url);
const installed = ["version", "node-path", "render.mjs", "node_modules"].every(f => existsSync(join(HOME, f)));
const NEED = "the mermaid renderer is not installed: ./install.sh";

const tmp = mkdtempSync(join(tmpdir(), "mermaid-render-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const CONFIG = {
  theme: "base",
  themeVariables: { darkMode: true, primaryColor: "#193549", primaryTextColor: "#ffffff", lineColor: "#aaaaaa" },
  flowchart: { useMaxWidth: false },
};
const GOOD = "flowchart TD\n  A[Open the note] --> B{Has a diagram?}\n  B -->|yes| C[Draw it]\n  B -->|no| D[Done]\n";
const BAD = "flowchart TD\n  A[Start] --> B{Broken\n  B -->| C[\n  ??? --> -->\n";
// 15 steps in a row: far wider than the 1200 px viewport the page starts with.
const WIDE = "flowchart LR\n" + Array.from({ length: 14 }, (_, i) => `  N${i}[Step number ${i}] --> N${i + 1}[Step number ${i + 1}]`).join("\n") + "\n";

// A scratch folder with the config and one <key>.mmd per entry; returns what a run needs.
function workdir(name, sources) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(CONFIG));
  const files = Object.entries(sources).map(([key, text]) => {
    writeFileSync(join(dir, `${key}.mmd`), text);
    return join(dir, `${key}.mmd`);
  });
  return { dir, out: join(dir, "out"), config: join(dir, "config.json"), files };
}

async function render(work, extra = []) {
  const node = readFileSync(join(HOME, "node-path"), "utf8").trim();
  const { stdout } = await promisify(execFile)(node, [join(HOME, "render.mjs"), "--config", work.config, "--outdir", work.out, ...extra, ...work.files], { cwd: HOME });
  assert.equal(stdout.trim().split("\n").length, 1, "stdout is one JSON line");
  return JSON.parse(stdout).results;
}

// width and height from the PNG's IHDR chunk
function pngSize(file) {
  const png = readFileSync(file);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is a PNG`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
const readJson = file => JSON.parse(readFileSync(file, "utf8"));

test("the installed copy is the one in tools/mermaid", t => {
  if (!installed) return t.skip(NEED);
  assert.equal(readFileSync(join(HOME, "render.mjs"), "utf8"), readFileSync(REPO_RENDER, "utf8"), "render.mjs changed: run ./install.sh");
  assert.match(readFileSync(join(HOME, "version"), "utf8"), /^mmdc-\d+\.\d+\.\d+\+[0-9a-f]{8}\+[0-9a-f]{8}$/, "version is one line, no newline");
});

test("a good diagram gets a PNG and a json beside it, a broken one a json with the message", async t => {
  if (!installed) return t.skip(NEED);
  const work = workdir("pair", { good: GOOD, bad: BAD });
  const [good, bad] = await render(work);

  assert.equal(good.key, "good");
  assert.equal(good.ok, true);
  assert.equal(good.scale, 2, "default scale");
  assert.ok(good.width > 0 && good.height > 0);
  assert.deepEqual(pngSize(join(work.out, "good.png")), { width: good.width, height: good.height }, "the numbers are the PNG's pixels");
  assert.deepEqual(readJson(join(work.out, "good.json")), { ok: true, width: good.width, height: good.height, scale: 2 });

  assert.equal(bad.key, "bad");
  assert.equal(bad.ok, false, "a broken diagram is a result, not a failed run");
  assert.match(bad.error, /Parse error on line/);
  assert.ok(bad.error.split("\n").length <= 12 && bad.error.length <= 1500, "short");
  assert.doesNotMatch(bad.error, /https?:|file:|^\s+at /m, "no stack frames");
  assert.deepEqual(readJson(join(work.out, "bad.json")), { ok: false, error: bad.error });
  assert.equal(existsSync(join(work.out, "bad.png")), false);

  assert.deepEqual(readdirSync(work.out).sort(), ["bad.json", "good.json", "good.png"], "no half-written files left");
});

test("a diagram wider than the page is not clipped", async t => {
  if (!installed) return t.skip(NEED);
  const work = workdir("wide", { wide: WIDE });
  const [wide] = await render(work, ["--scale", "1"]);
  assert.equal(wide.ok, true);
  assert.equal(wide.scale, 1, "--scale is passed through");
  assert.ok(wide.width > 1200, `${wide.width} px is wider than the 1200 px viewport`);
  assert.equal(pngSize(join(work.out, "wide.png")).width, wide.width);
});

// 60 steps in a row: about 23000 px at 2x, 11700 px at 1x.
const HUGE = "flowchart LR\n" + Array.from({ length: 60 }, (_, i) => `  N${i}[Step number ${i} of the chain] --> N${i + 1}[Step number ${i + 1} of the chain]`).join("\n") + "\n";

test("a diagram over 16000 px at 2x is drawn again at the largest quarter scale that fits, and says so", async t => {
  if (!installed) return t.skip(NEED);
  const work = workdir("huge", { huge: HUGE });
  const [huge] = await render(work); // default scale 2
  assert.equal(huge.ok, true);
  assert.ok(huge.scale < 2 && huge.scale >= 0.25 && Number.isInteger(huge.scale * 4), `${huge.scale} is a quarter below 2`);
  const longest = Math.max(huge.width, huge.height);
  assert.ok(longest <= 16000, `${longest} px fits`);
  assert.ok((longest / huge.scale) * (huge.scale + 0.25) > 16000 - 2, "a quarter more would not fit");
  assert.deepEqual(pngSize(join(work.out, "huge.png")), { width: huge.width, height: huge.height });
  assert.deepEqual(readJson(join(work.out, "huge.json")), { ok: true, width: huge.width, height: huge.height, scale: huge.scale });
});

// The alpha of the PNG's first pixel: the first row is not predicted from anything, whatever its filter.
function cornerAlpha(file) {
  const png = readFileSync(file), idat = [];
  let colourType = null;
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8), data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") colourType = data[9];
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  if (colourType === 2) return 255;
  assert.equal(colourType, 6, "8-bit RGBA");
  return inflateSync(Buffer.concat(idat))[1 + 3];
}

test("--background paints under the diagram, so its corners are opaque; without it they are transparent", async t => {
  if (!installed) return t.skip(NEED);
  const work = workdir("background", { plain: GOOD });
  await render(work);
  assert.equal(cornerAlpha(join(work.out, "plain.png")), 0);
  const [shaded] = await render(work, ["--background", "#123456", "--scale", "3"]);
  assert.deepEqual([shaded.ok, shaded.scale], [true, 3]);
  assert.equal(cornerAlpha(join(work.out, "plain.png")), 255);
});

// The budget and the launch timeout are the renderer's own clock, so these runs shorten it with HERDR_MERMAID_LIMIT_MS
// and then make the start slow (a preloaded module that waits) or the browser hang (a Chrome that is a sleeping script).
const nodePath = () => readFileSync(join(HOME, "node-path"), "utf8").trim();
const run = (work, env, { preload } = {}) => promisify(execFile)(nodePath(), [...(preload ? ["--import", preload] : []), join(HOME, "render.mjs"), "--config", work.config, "--outdir", work.out, ...work.files],
  { cwd: HOME, env: { ...process.env, ...env }, timeout: 12000 });

test("the budget counts from the start of the process: a slow start leaves nothing to draw with", async t => {
  if (!installed) return t.skip(NEED);
  const work = workdir("late", { late: GOOD });
  const preload = join(tmp, "late.mjs");
  writeFileSync(preload, "await new Promise(done => setTimeout(done, 2500));\n"); // stands for a slow import and launch
  const { stdout } = await run(work, { HERDR_MERMAID_LIMIT_MS: "2000" }, { preload });
  const [late] = JSON.parse(stdout).results;
  assert.deepEqual([late.ok, late.error], [false, "Timed out"], "2.5 s into a 2 s budget");
  assert.deepEqual(readdirSync(work.out), [], "nothing was drawn or cached");
});

test("a browser that never starts fails the run at the launch timeout, with exit 2", async t => {
  if (!installed) return t.skip(NEED);
  const work = workdir("hung", { hung: GOOD });
  const chrome = join(tmp, "hung-chrome.sh");
  writeFileSync(chrome, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const began = Date.now();
  await assert.rejects(run(work, { HERDR_MERMAID_LIMIT_MS: "1500", PUPPETEER_EXECUTABLE_PATH: chrome }), e => e.code === 2 && /can't start the browser/.test(e.stderr));
  assert.ok(Date.now() - began < 8000, "puppeteer's own wait is 30 s");
});

test("an empty diagram is an error of its own", async t => {
  if (!installed) return t.skip(NEED);
  const [empty] = await render(workdir("empty", { empty: " \n" }));
  assert.deepEqual([empty.ok, empty.error], [false, "This diagram is empty"]);
});

test("a run without inputs or without a config exits 2 with a usage line", async t => {
  if (!installed) return t.skip(NEED);
  const node = readFileSync(join(HOME, "node-path"), "utf8").trim();
  for (const args of [[], ["--outdir", tmp, join(tmp, "x.mmd")]]) {
    await assert.rejects(promisify(execFile)(node, [join(HOME, "render.mjs"), ...args], { cwd: HOME }), e => e.code === 2 && /usage:/.test(e.stderr));
  }
});
