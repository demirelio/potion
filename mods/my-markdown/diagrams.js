// Mermaid diagrams for the Markdown view. A fence is turned into a PNG by the renderer that install.sh installs
// (a node script that opens one headless Chrome per batch); the PNGs and what they said are kept in the app folder, so
// a diagram is drawn once for its source, the renderer's version and the theme. get() never waits: it answers
// "pending" and a timer does the work, then redraws the view and calls `onChange(cx)`, where the view asks again.
// A diagram zoomed in past its picture's scale can have one sharper picture as well (sharp()).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { home, appHome, readTextFile, exec, theme } from "herdr";
import * as fs from "fs/promises";
import { mermaidConfig, diagramKey, sharpName, hash, DIAGRAM_COLORS as Z } from "./lib.js";
import { FRAME } from "./geometry.js";

const WAIT = 400; // ms: diagrams that show up together go out together
const SHARP_BACKGROUND = "transparent";
const MAX_BATCH = 8; // inputs per renderer run
const NODE_MISSING = "Diagrams need Node.js";
const RECHECK = 10000; // ms: a renderer that was not installed is looked for again after this long
const RETRY = 15000; // ms: a run that failed as a whole (not one diagram's own error) is tried again after this long

const why = e => String(e?.message ?? e);
export const mermaidHome = () => `${home().replace(/\/+$/, "")}/.local/share/herdr-markdown/mermaid`;
export const cacheDir = () => `${appHome().replace(/\/+$/, "")}/data/my-markdown/diagrams`;
// Where an image() finds the PNG: relative to the app folder.
export const imagePath = key => `data/my-markdown/diagrams/${key}.png`;

const result = (key, state, more) => ({ key, state, width: 0, height: 0, scale: 1, error: null, ...more });
// An error that came from the run, not from the diagram, carries the time (ms) after which get() asks for it again.
const stale = known => known.retryAt !== undefined && Date.now() >= known.retryAt;

export class Diagrams {
  constructor() {
    this.renderer = undefined; // undefined: not asked yet, null: not installed, else { version, node }
    this.checked = 0; // when the renderer was last looked for
    this.nodeMissing = false; // the last run could not start node
    this.known = new Map(); // key -> what get() answers once it is settled
    this.want = new Map(); // key -> source, waiting for the next batch
    this.keys = new Map(); // source -> key, for the current config and renderer
    this.written = new Set(); // config files already put in the cache folder
    this.sig = null; this.config = null; // the theme's colors, and { json, name } made from them
    this.timer = null; this.starting = false; this.running = false; this.closed = false;
    this.reminders = new Set();
    this.onChange = null;
    // The sharp pictures: base key -> its result (one per diagram, never asked for again, as an image once loaded
    // stays loaded), and the ones waiting to be drawn, one per run after the base rounds.
    this.sharps = new Map(); this.sharpWant = [];
  }

  changed(cx) {
    cx.notify();
    this.onChange?.(cx);
  }

  // The view asks again only when it is told something changed, so it is told when a look or a retry comes due.
  remind(ms, cx) {
    const task = cx.timer.after(ms, cx => {
      this.reminders.delete(task);
      if (!this.closed) this.changed(cx);
    });
    this.reminders.add(task);
  }

  // The renderer's version and node, read once: a missing version file means it was never installed. Not installed is
  // looked at again 10 s later, so install.sh takes effect without reopening the tab.
  start(cx) {
    if (this.starting || (this.renderer !== undefined && !(this.renderer === null && Date.now() - this.checked >= RECHECK))) return;
    this.starting = true;
    const was = this.renderer;
    cx.spawn(async cx => {
      const base = mermaidHome();
      try {
        const [version, node] = await Promise.all([readTextFile(`${base}/version`), readTextFile(`${base}/node-path`)]);
        this.renderer = version?.trim() ? { version: version.trim(), node: node?.trim() || "node" } : null;
      } catch { this.renderer = null; }
      this.checked = Date.now();
      if (this.closed) return;
      // A folder that cannot be made shows up as an error on each diagram, with the reason.
      if (this.renderer) {
        try { await fs.mkdir(cacheDir(), { recursive: true }); } catch { /* the writes say so */ }
        if (this.closed) return;
      } else this.remind(RECHECK, cx);
      this.starting = false;
      if (was === undefined || was?.version !== this.renderer?.version) this.changed(cx); // a look that found nothing new draws nothing
    });
  }

  // A new theme means new colors in every diagram, so new keys; the old results stay valid for the old theme.
  sync(t) {
    const sig = Object.values(t).join();
    if (sig === this.sig) return;
    this.sig = sig;
    const json = JSON.stringify(mermaidConfig(t));
    this.config = { json, name: `config-${hash(json)}.json` };
    this.keys = new Map();
    this.want = new Map();
  }

  // -> { key, state: "pending" | "ok" | "error" | "missing", width, height, scale, error }. Cheap: the view calls it
  // for every diagram whenever its blocks change and whenever it is told something changed here.
  get(source, cx) {
    this.start(cx);
    this.sync(theme());
    const r = this.renderer;
    if (r === undefined) return result(null, "pending");
    if (r === null) return result(hash(source), "missing");
    let key = this.keys.get(source);
    if (!key) {
      if (this.keys.size >= 500) this.keys.clear();
      key = diagramKey(source, this.config.json, r.version);
      this.keys.set(source, key);
    }
    // A failed run's error is shown while the diagram is asked for again, once its retry time has come.
    const known = this.known.get(key);
    if (known && !stale(known)) return known;
    if (!this.want.has(key)) {
      this.want.set(key, source);
      this.timer?.cancel();
      this.timer = cx.timer.after(WAIT, cx => { this.timer = null; cx.spawn(cx => this.run(cx)); });
    }
    return known ?? result(key, "pending");
  }

  // A picture of the diagram `key` (drawn from `source`) at `scale`, laid over the base one: transparent like it, so the
  // canvas's dots show through, and the shapes' solid fills hide the base under them. <key>-<background's hash>-x<scale·100>.
  // -> what sharpOf answers.
  sharp(key, source, scale, cx) {
    if (!this.renderer || !this.config || this.sharps.has(key)) return this.sharpOf(key);
    const name = sharpName(key, SHARP_BACKGROUND, scale);
    this.sharps.set(key, result(name, "pending", { scale }));
    this.sharpWant.push({ key, name, source, scale, config: this.config, background: SHARP_BACKGROUND });
    cx.spawn(cx => this.run(cx));
    return this.sharpOf(key);
  }

  sharpOf(key) {
    return this.sharps.get(key) ?? null;
  }

  close() {
    this.closed = true;
    this.timer?.cancel();
    for (const task of this.reminders) task.cancel();
    this.reminders.clear();
  }

  // One run at a time; what is wanted while it works goes in its next round.
  async run(cx) {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while ((this.want.size || this.sharpWant.length) && !this.closed) {
        if (this.want.size) await this.round(cx);
        else await this.sharpRound(this.sharpWant.shift(), cx);
      }
    } finally { this.running = false; }
  }

  // A failed sharp picture is not asked for again: the base one stays.
  async sharpRound({ key, name, source, scale, config, background }, cx) {
    const dir = cacheDir(), done = r => { this.sharps.set(key, r); if (!this.closed) this.changed(cx); };
    const hit = await this.cached(name, dir);
    if (this.closed) return;
    if (hit) return done(hit);
    try {
      await fs.writeFile(`${dir}/${name}.mmd`, source);
      if (!this.written.has(config.name)) {
        await fs.writeFile(`${dir}/${config.name}`, config.json);
        this.written.add(config.name);
      }
    } catch (e) { return done(result(name, "error", { error: why(e) })); }
    if (this.closed) return;
    let r;
    try {
      r = await exec(this.renderer.node, [`${mermaidHome()}/render.mjs`, "--config", `${dir}/${config.name}`, "--outdir", dir, "--scale", String(scale), "--background", background, `${dir}/${name}.mmd`], { cwd: mermaidHome() });
    } catch (e) { return done(result(name, "error", { error: why(e) })); }
    if (this.closed) return;
    let x = null;
    try { x = JSON.parse(r.stdout.trim().split("\n").pop()).results.find(y => y?.key === name); } catch { /* an error below */ }
    if (r.code === 0 && x?.ok && x.width > 0 && x.height > 0) done(result(name, "ok", { width: x.width, height: x.height, scale: x.scale > 0 ? x.scale : scale }));
    else if (r.code === 0) done(result(name, "error", { error: x?.error || "The renderer gave no answer for this diagram" }));
    else done(result(name, "error", { error: r.stderr?.trim() || `The renderer stopped (exit ${r.code})` }));
  }

  async round(cx) {
    const config = this.config, dir = cacheDir(), todo = [...this.want], misses = [];
    this.want.clear();
    for (const [key, source] of todo) {
      const old = this.known.get(key);
      if (old && !stale(old)) continue;
      const hit = await this.cached(key, dir);
      if (this.closed) return;
      if (hit) { this.known.set(key, hit); continue; }
      try {
        await fs.writeFile(`${dir}/${key}.mmd`, source);
        misses.push(key);
      } catch (e) { this.fail([key], `Can't write the diagram file: ${why(e)}`); }
      if (this.closed) return;
    }
    this.changed(cx);
    if (!misses.length) return;
    try {
      if (!this.written.has(config.name)) {
        await fs.writeFile(`${dir}/${config.name}`, config.json);
        this.written.add(config.name);
      }
    } catch (e) {
      this.fail(misses, `Can't write the diagram settings: ${why(e)}`);
      if (!this.closed) this.changed(cx);
      return;
    }
    if (this.closed) return;
    // Node missing fails every input of this round at once instead of trying it once per batch.
    let stopped = false;
    for (let i = 0; i < misses.length; i += MAX_BATCH) {
      const chunk = misses.slice(i, i + MAX_BATCH);
      if (stopped) this.fail(chunk, NODE_MISSING, true);
      else stopped = !(await this.draw(chunk, config, dir));
      if (this.closed) return;
      this.changed(cx);
    }
    if (misses.some(key => this.known.get(key)?.retryAt !== undefined)) this.remind(RETRY, cx);
  }

  // What the renderer left for this key earlier. A run that ran out of time is worth another try; the rest is final.
  async cached(key, dir) {
    let json;
    try { json = JSON.parse(await fs.readFile(`${dir}/${key}.json`, "utf8")); } catch { return null; }
    if (json?.ok === true && json.width > 0 && json.height > 0) return result(key, "ok", { width: json.width, height: json.height, scale: json.scale > 0 ? json.scale : 2 });
    if (json?.ok === false && typeof json.error === "string" && json.error !== "Timed out") return result(key, "error", { error: json.error });
    return null;
  }

  // One renderer run. false when node could not start (every key of the chunk is failed then), else true.
  // Nothing about the run is final: node missing, a nonzero exit and "Timed out" are asked for again after a while.
  // What mermaid says about one diagram is final for that diagram.
  async draw(keys, config, dir) {
    const base = mermaidHome();
    let r;
    try {
      r = await exec(this.renderer.node, [`${base}/render.mjs`, "--config", `${dir}/${config.name}`, "--outdir", dir, ...keys.map(k => `${dir}/${k}.mmd`)], { cwd: base });
    } catch {
      this.nodeMissing = true;
      this.fail(keys, NODE_MISSING, true);
      return false;
    }
    this.nodeMissing = false;
    if (r.code !== 0) {
      this.fail(keys, r.stderr.trim() || `The renderer stopped (exit ${r.code})`, true);
      return true;
    }
    let results = [];
    try { results = JSON.parse(r.stdout.trim().split("\n").pop()).results; } catch { /* every key is answered below */ }
    const answers = new Map((Array.isArray(results) ? results : []).map(x => [x?.key, x]));
    for (const key of keys) {
      const x = answers.get(key);
      if (x?.ok && x.width > 0 && x.height > 0) this.known.set(key, result(key, "ok", { width: x.width, height: x.height, scale: x.scale > 0 ? x.scale : 2 }));
      else this.fail([key], x?.error || "The renderer gave no answer for this diagram", x?.error === "Timed out");
    }
    return true;
  }

  // `again`: the failure is the run's, not the diagram's, so get() asks for the diagram again after RETRY ms.
  fail(keys, error, again = false) {
    for (const key of keys) this.known.set(key, result(key, "error", { error, ...(again ? { retryAt: Date.now() + RETRY } : {}) }));
  }
}

// A fence longer than any run of backticks in the text, so the text cannot close it.
const fence = text => "`".repeat((text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length + 1), 3));

const ICON = name => `mods/my-markdown/${name}.svg`;

// The element for one diagram in the page: `d` is what get() answered, `frame` what its frame draws, or null when
// it draws none: { key, w, h, ml, natW, natH, image, dim, selected, view: { z, x, y, sharp, tools, cursor } }.
// `image` is the picture that is ready, or the last one (`dim`) while a changed diagram is drawn again or when it
// cannot be drawn.
export function diagramBlock({ id, source, d, frame, t, mono }) {
  const box = () => v_flex().w_full().gap(6).p(12).rounded(8).bg(t.surface).border_1().border_color(t.border);
  const title = (text, color) => div().text_size(12.5).font_medium().text_color(color).child(text);
  const out = v_flex().id(id).w_full().gap(8);
  if (d.state === "missing") {
    return out.child(box().child(title("Diagrams need the mermaid renderer", t.foreground))
      .child(div().text_size(12).text_color(t.muted).child("Run install.sh in the herdr-markdown folder"))
      .child(TextView.markdown(`${id}-source`, `${fence(source)}mermaid\n${source}\n${fence(source)}`).selectable(true)));
  }
  if (d.state === "error") {
    out.child(box().child(title("Mermaid error", t.blocked)).child(div().font_family(mono).text_size(12).text_color(t.muted).child(d.error || "Mermaid could not draw this diagram")));
    return frame ? out.child(frameElement(frame, t)) : out;
  }
  if (frame) return out.child(frameElement(frame, t));
  return out.child(h_flex().w_full().h(120).gap(8).items_center().justify_center().rounded(8).bg(Z.canvas).border_1().border_color(Z.edge).text_size(12.5).text_color(Z.line)
    .child(svg(ICON("spinner")).size(14).flex_none().spin(900))
    .child("Drawing diagram…"));
}

// The canvas's dot grid: tiles of DOTS.gap-spaced dots, shifted with the picture so that a pan always shows.
const DOTS = { gap: 30, tile: 240 };
const wrap = (n, m) => ((n % m) + m) % m;
function dotGrid(f) {
  const ox = Math.round(wrap(f.view.x, DOTS.gap)) - DOTS.gap, oy = Math.round(wrap(f.view.y, DOTS.gap)) - DOTS.gap;
  const tiles = [];
  for (let top = oy; top < f.h; top += DOTS.tile) {
    for (let left = ox; left < f.w; left += DOTS.tile) tiles.push(svg(ICON("dots")).absolute().left(left).top(top).size(DOTS.tile).text_color(Z.dot));
  }
  return div().id(`md-frame-dots-${f.key}`).absolute().inset_0().children(tiles);
}

// The frame clips the picture, which the editor moves and scales inside it, over the dotted canvas. The sharp picture
// is opaque and lies over the base, so the base shows until it has loaded; the selection tint and the edge go over both.
function frameElement(f, t) {
  const v = f.view, key = f.key, T = FRAME.tools;
  const picture = (path, dim) => image(path).absolute().left(Math.round(v.x)).top(Math.round(v.y)).w(f.natW * v.z).h(f.natH * v.z)
    .when(dim, el => el.opacity(0.5));
  const cell = (name, w, on, child) => div().id(`md-frame-${name}-${key}`).w(w).h_full().flex().items_center().justify_center()
    .when(on, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
    .when(!on, el => el.cursor_default().text_color(t.dim))
    .child(child);
  return div().id(`md-frame-${key}`).flex_none().ml(f.ml).w(f.w).h(f.h).relative().overflow_hidden().rounded(8).bg(Z.canvas)
    .when(v.cursor === "grab", el => el.cursor_grab())
    .when(v.cursor === "grabbing", el => el.cursor_grabbing())
    .when(v.cursor === "default", el => el.cursor_default())
    .child(dotGrid(f))
    .child(picture(imagePath(f.image), f.dim))
    .when(Boolean(v.sharp), el => el.child(picture(imagePath(v.sharp), false)))
    .when(f.selected, el => el.child(div().id(`md-frame-tint-${key}`).absolute().inset_0().bg(t.selection).opacity(0.5)))
    .child(div().id(`md-frame-edge-${key}`).absolute().inset_0().rounded(8).border_1().border_color(Z.edge))
    .when(Boolean(v.tools), el => el.child(h_flex().id(`md-frame-tools-${key}`).absolute().top(v.tools.top).right(T.right).h(T.h)
      .overflow_hidden().rounded(7).border_1().border_color(Z.edge).bg(Z.node).text_size(12).text_color(Z.text)
      .child(cell("out", T.out, v.tools.out, svg(ICON("minus")).size(13)))
      .child(cell("pct", T.pct, true, `${v.tools.pct}%`))
      .child(cell("in", T.in, v.tools.in, svg(ICON("plus")).size(13)))));
}
