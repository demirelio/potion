// get() never waits: it answers "pending" and queues the load, which stores its answer and then redraws the view and
// calls `onChange(cx)`, where the view asks again. Every picture is copied into the cache folder under the hash of its
// bytes, as image() draws only what is under the app folder.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, exec } from "herdr";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { createHash } from "crypto";
import { basename, hash, pictureSource, touches } from "./lib.js";
import { sniffImage } from "./imagesize.js";

const MAX_LOADS = 4;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 50000000;
const DOWNLOAD_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_SECONDS = 20;
const PRUNE_DAYS = 45;
const MEMO = 1000;
const NOT_A_PICTURE = "Not a picture Herdr can show (PNG, JPEG, GIF, WebP, BMP, SVG)";
const ON_ANOTHER_MACHINE = "Pictures on another machine aren't shown yet";
const SPINNER = "mods/herdr-inline-markdown/spinner.svg";

const why = e => String(e?.message ?? e);
export const imagesDir = () => `${appHome().replace(/\/+$/, "")}/data/herdr-inline-markdown/images`;
// Where an image() finds a cached picture: relative to the app folder.
export const pictureImagePath = name => `data/herdr-inline-markdown/images/${name}`;

const result = (state, more) => ({ state, path: null, width: 0, height: 0, error: null, ...more });
const pending = () => result("pending");
const failure = error => result("error", { error });

const identityOf = source => (source.kind === "file" ? `file:${source.path}` : source.kind === "web" ? `web:${source.url}` : `data:${hash(source.url)}`);
const notFound = e => e?.code === "ENOENT" || /ENOENT|no such file/i.test(why(e));
const unescape = text => {
  try { return decodeURIComponent(text); } catch { return text; }
};

function dataBytes(url) {
  const comma = url.indexOf(",");
  if (comma < 0) return new Uint8Array(0);
  const payload = unescape(url.slice(comma + 1));
  return Buffer.from(payload, /;base64$/i.test(url.slice(0, comma)) ? "base64" : "utf8");
}

const curlArguments = (tmp, url) => ["-sSfL", "--proto", "=https", "--proto-redir", "=https", "--max-time", String(DOWNLOAD_SECONDS),
  "--max-filesize", String(DOWNLOAD_BYTES), "-o", tmp, url];

function curlFailure({ code, stderr }) {
  if (code === 28) return "Timed out";
  if (code === 63) return "Over 10 MB";
  return String(stderr ?? "").trim().replace(/^curl: \(\d+\) /, "").trim() || `The download failed (curl exit ${code})`;
}

// Once per app run, whichever service asks first.
let pruned = false;
// Makes the names of the files curl writes differ, across services too.
let downloads = 0;

async function prune() {
  try { await exec("find", [imagesDir(), "-type", "f", "-mtime", `+${PRUNE_DAYS}`, "-delete"]); } catch { /* the cache just is not pruned */ }
}

export class Images {
  constructor() {
    this.sources = new Map(); // `${file}\0${src}` -> { source, id }, as pictureSource and identityOf tell
    this.entries = new Map(); // id -> { id, source, result }: what get() answers, settled or not
    this.queue = []; // entries waiting for one of the MAX_LOADS places
    this.running = 0;
    this.folder = null;
    this.closed = false;
    this.onChange = null;
  }

  changed(cx) {
    cx.notify();
    this.onChange?.(cx);
  }

  sourceOf(src, file) {
    const key = `${file}\0${src}`;
    let known = this.sources.get(key);
    if (!known) {
      if (this.sources.size >= MEMO) this.sources.clear();
      const source = pictureSource(src, file);
      known = { source, id: source.kind === "none" ? null : identityOf(source) };
      this.sources.set(key, known);
    }
    return known;
  }

  // -> { state: "pending" | "ok" | "error", path, width, height, error }: `path` is the picture in the cache, relative to
  // the app folder, for image(). Cheap: the view calls it for every picture whenever its blocks change.
  get(src, file, { remote } = {}, cx) {
    const { source, id } = this.sourceOf(src, file);
    if (source.kind === "none") return failure(source.why);
    if (source.kind === "file" && remote) return failure(ON_ANOTHER_MACHINE);
    const known = this.entries.get(id);
    if (known) return known.result;
    if (this.closed) return pending();
    const entry = { id, source, result: pending() };
    this.entries.set(id, entry);
    this.queue.push(entry);
    this.pump(cx);
    return entry.result;
  }

  // Drops what was loaded for a file that a watcher reports as changed, or lies under a folder it reports, or has its
  // name, even a load still going; the next get() loads it again. -> whether it dropped anything.
  forget(paths) {
    let dropped = false;
    for (const [id, entry] of this.entries) {
      if (entry.source.kind !== "file" || !paths.some(path => touches(path, entry.source.path))) continue;
      this.entries.delete(id);
      dropped = true;
    }
    return dropped;
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
  }

  current(entry) {
    return !this.closed && this.entries.get(entry.id) === entry;
  }

  pump(cx) {
    while (!this.closed && this.running < MAX_LOADS && this.queue.length) {
      const entry = this.queue.shift();
      if (this.entries.get(entry.id) !== entry) continue;
      if (!pruned) {
        pruned = true;
        prune();
      }
      this.running++;
      cx.spawn(cx => this.load(entry, cx));
    }
  }

  async load(entry, cx) {
    let answer = null;
    try {
      const got = await this.fetchBytes(entry.source);
      if (this.current(entry)) answer = got.error ? failure(got.error) : await this.keep(got.bytes);
    } catch (e) {
      answer = failure(why(e));
    }
    this.running--;
    if (answer && this.current(entry)) {
      entry.result = answer;
      this.changed(cx);
    }
    this.pump(cx);
  }

  // -> { bytes } | { error }
  fetchBytes({ kind, path, url }) {
    if (kind === "file") return this.read(path);
    if (kind === "web") return this.download(url);
    return { bytes: dataBytes(url) };
  }

  async read(path) {
    try { return { bytes: await fs.readFile(path) }; } catch (e) { return { error: notFound(e) ? "Not found" : `Can't read it: ${why(e)}` }; }
  }

  // curl writes into the cache folder, as fetch() gives no body bytes; the file is read and removed.
  async download(url) {
    await this.ensureFolder();
    const tmp = `${imagesDir()}/web-${hash(url)}-${++downloads}.part`;
    let ran;
    try { ran = await exec("curl", curlArguments(tmp, url)); } catch { return { error: "Web pictures need curl" }; }
    try {
      return ran.code === 0 ? await this.read(tmp) : { error: curlFailure(ran) };
    } finally {
      try { await fs.unlink(tmp); } catch { /* curl left nothing */ }
    }
  }

  ensureFolder() {
    this.folder ??= fs.mkdir(imagesDir(), { recursive: true }).catch(() => {}); // the write that follows says why it failed
    return this.folder;
  }

  async keep(bytes) {
    if (bytes.length > MAX_BYTES) return failure("Over 25 MB: too big to show");
    const size = sniffImage(bytes);
    if (!size) return failure(NOT_A_PICTURE);
    if (size.width * size.height > MAX_PIXELS) return failure(`Too big to show (${size.width} × ${size.height} px)`);
    const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${size.ext}`;
    try {
      await this.ensureFolder();
      const path = `${imagesDir()}/${name}`;
      if (!(await fs.exists(path))) await fs.writeFile(path, bytes);
    } catch (e) { return failure(`Can't write the picture cache: ${why(e)}`); }
    return result("ok", { path: pictureImagePath(name), width: size.width, height: size.height });
  }
}

// `items[i]` is { state, path, alt, src, error, href } as get() answered with the paragraph's own alt, src and href, and
// `boxes[i]` its place from pictureLayout; they sit in a box `height` high. A linked item has the hand in every state.
export function pictureBlock({ id, items, boxes, height, selected, t }) {
  const parts = items.flatMap((item, i) => pictureParts(item, boxes[i], `${id}-${i}`, selected, t));
  return div().id(id).relative().w_full().h(height).children(parts);
}

function pictureParts(item, box, key, selected, t) {
  const place = el => el.absolute().left(box.x).top(box.y).w(box.w).h(box.h).when(Boolean(item.href), el => el.cursor_pointer());
  if (item.state === "ok") {
    const picture = place(image(item.path).id(key));
    return selected ? [picture, place(div().id(`${key}-tint`)).bg(t.selection).opacity(0.5)] : [picture];
  }
  const framed = el => place(el.id(key)).rounded(8).bg(t.surface).border_1().border_color(t.border).text_size(12.5).text_color(t.muted);
  if (item.state === "pending") {
    return [framed(h_flex()).gap(8).items_center().justify_center()
      .child(svg(SPINNER).size(14).flex_none().spin(900))
      .child("Loading picture…")];
  }
  return [framed(div()).flex().items_center().px(10)
    .child(div().flex_1().min_w(0).truncate().child(`${item.alt || basename(item.src) || "Picture"}: ${item.error}`))];
}
