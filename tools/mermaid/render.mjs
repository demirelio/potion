#!/usr/bin/env node
// Draws mermaid sources to PNG with one headless Chrome for the whole batch (the herdr-inline-markdown mod runs this).
//
//   node render.mjs --config <config.json> --outdir <dir> [--scale 2] [--background transparent] [--jobs 4] <dir>/<key>.mmd ...
//
// For every input it writes <outdir>/<key>.png and <outdir>/<key>.json: {"ok":true,"width","height","scale"} (pixels of
// the PNG) or {"ok":false,"error"} with mermaid's own message. stdout gets one JSON line, {"results":[{key,ok,...}]}.
// A diagram that fails still exits 0: the mod shows each error by its diagram. Exit 2 means a usage error or no browser.
// --background is a CSS colour painted under the diagram (the mod's sharp pictures lie over another picture).
import { renderMermaid } from "@mermaid-js/mermaid-cli";
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

// The run is over after LIMIT_MS counted from the start of the process (loading mermaid-cli and launching Chrome are
// part of it) and exits at most CLOSE_MS later: 27 s at the outside. The variable is for the tests. A browser that
// doesn't start in time is a failed run (exit 2) rather than one that eats the whole budget.
const LIMIT_MS = Number(process.env.HERDR_MERMAID_LIMIT_MS) || 25000;
const CLOSE_MS = 2000;
const LAUNCH_MS = Math.min(10000, LIMIT_MS);
// A PNG wider or taller than this at --scale is drawn again at the largest quarter scale that fits, down to MIN_SCALE:
// a texture that big may not load.
const MAX_PX = 16000;
const MIN_SCALE = 0.25;
const KEEP_DAYS = 45;
const started = Date.now() - process.uptime() * 1000;

// mermaid-cli forwards the page's console to console.warn; stdout stays ours alone.
for (const level of ["log", "info", "warn", "debug"]) console[level] = () => {};
const out = text => new Promise(done => process.stdout.write(text, done));
const usage = message => { console.error(`render.mjs: ${message}\nusage: node render.mjs --config <config.json> --outdir <dir> [--scale 2] [--background transparent] [--jobs 4] <key>.mmd ...`); process.exit(2); };

const opt = { config: null, outdir: null, scale: 2, background: "transparent", jobs: 4, files: [] };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--config") opt.config = args[++i];
  else if (a === "--outdir") opt.outdir = args[++i];
  else if (a === "--scale") opt.scale = Number(args[++i]);
  else if (a === "--background") opt.background = args[++i];
  else if (a === "--jobs") opt.jobs = Number(args[++i]);
  else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else opt.files.push(a);
}
if (!opt.config || !opt.outdir || !opt.files.length) usage("--config, --outdir and at least one input are required");
if (!(opt.scale > 0) || !(opt.jobs >= 1)) usage("--scale and --jobs must be positive numbers");
if (!opt.background) usage("--background needs a colour");

let mermaidConfig;
try { mermaidConfig = JSON.parse(readFileSync(opt.config, "utf8")); } catch (e) { usage(`can't read the config: ${e.message}`); }

// Atomic, so the mod never reads half a PNG; the PNG lands before the JSON, which is what marks a key done.
function put(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// A stack frame as the page prints it ("    at f (url:1:2)", or "Parser.parse (https://…:1708:16)" without the "at").
const FRAME = /^\s+at |\((?:https?|file):[^)]*:\d+:\d+\)\s*$|^\s*(?:https?|file):\S+:\d+:\d+\s*$/;

// The part of an error a person can use: mermaid's message without the browser's stack frames.
function human(e) {
  let lines = String(e?.message ?? e).replace(/^Evaluation failed: /, "").split("\n");
  const frame = lines.findIndex(l => FRAME.test(l));
  if (frame >= 0) lines = lines.slice(0, frame);
  return lines.join("\n").trim().split("\n").slice(0, 12).join("\n").slice(0, 1500) || "Mermaid could not draw this diagram";
}

const keyOf = file => basename(file).replace(/\.[^.]*$/, "");
let over = false; // set once the run is answered; a draw still in flight then writes nothing more

async function draw(browser, file) {
  const key = keyOf(file);
  let source;
  try { source = readFileSync(file, "utf8"); } catch { return { key, ok: false, error: `Can't read ${file}` }; }
  let result;
  try {
    if (!source.trim()) throw new Error("This diagram is empty");
    // renderMermaid widens the viewport to the diagram before the screenshot, so a wide one isn't clipped.
    const shoot = async scale => Buffer.from((await renderMermaid(browser, source, "png", {
      backgroundColor: opt.background,
      mermaidConfig,
      viewport: { width: 1200, height: 800, deviceScaleFactor: scale },
    })).data);
    let scale = opt.scale, png = await shoot(scale);
    // IHDR: width at byte 16, height at 20. The size goes with the scale, so one more shot usually fits.
    const longest = () => Math.max(png.readUInt32BE(16), png.readUInt32BE(20));
    while (longest() > MAX_PX && scale > MIN_SCALE) png = await shoot(scale = Math.max(MIN_SCALE, Math.floor((scale * MAX_PX / longest()) * 4) / 4));
    result = { key, ok: true, width: png.readUInt32BE(16), height: png.readUInt32BE(20), scale };
    put(join(opt.outdir, `${key}.png`), png);
  } catch (e) {
    result = { key, ok: false, error: human(e) };
    // A browser that died takes every later diagram down with it: that says nothing about the diagram, so don't keep it.
    if (over || !browser.connected) return result;
  }
  const { key: _, ...saved } = result;
  put(join(opt.outdir, `${key}.json`), JSON.stringify(saved));
  return result;
}

// Cached files of a key (<key>.png/.json/.mmd) go together once the newest is old; .json first, so one never outlives its .png.
function prune(dir) {
  const cutoff = Date.now() - KEEP_DAYS * 864e5, newest = new Map(), names = readdirSync(dir).filter(n => /\.(png|json|mmd|tmp)$/.test(n));
  for (const n of names) {
    const key = n.replace(/\.(png|json|mmd)$/, "");
    newest.set(key, Math.max(newest.get(key) ?? 0, statSync(join(dir, n)).mtimeMs));
  }
  for (const n of names.sort((a, b) => Number(b.endsWith(".json")) - Number(a.endsWith(".json")))) {
    if (newest.get(n.replace(/\.(png|json|mmd)$/, "")) < cutoff) rmSync(join(dir, n), { force: true });
  }
}

let browser;
try {
  mkdirSync(opt.outdir, { recursive: true });
  browser = await puppeteer.launch({ headless: "shell", timeout: LAUNCH_MS });
} catch (e) {
  console.error(`render.mjs: can't start the browser: ${e.message}`);
  process.exit(2);
}

const results = new Array(opt.files.length);
let next = 0, timer;
async function worker() {
  while (next < opt.files.length && Date.now() - started < LIMIT_MS) {
    const i = next++;
    results[i] = await draw(browser, opt.files[i]).catch(e => ({ key: keyOf(opt.files[i]), ok: false, error: human(e) }));
  }
}
const workers = Promise.all(Array.from({ length: Math.min(opt.jobs, opt.files.length) }, worker));
await Promise.race([workers, new Promise(done => { timer = setTimeout(done, Math.max(0, started + LIMIT_MS - Date.now())); })]);
clearTimeout(timer);
over = true;
// Not cached: a timeout is no verdict on the diagram, the next run may manage it.
opt.files.forEach((f, i) => { results[i] ??= { key: keyOf(f), ok: false, error: "Timed out" }; });

await out(JSON.stringify({ results }) + "\n");
// A hung page can make close() hang with it; the output is out, so don't wait long.
await Promise.race([browser.close().catch(() => {}), new Promise(done => setTimeout(done, CLOSE_MS))]);
browser.process()?.kill("SIGKILL");
try { prune(opt.outdir); } catch { /* housekeeping never fails a run */ }
process.exit(0);
