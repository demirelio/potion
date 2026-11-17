// Choosing pictures with the macOS file dialog (osascript), and putting what was chosen beside the note: a picture under
// the note's folder is linked where it is, any other is copied into images/ next to the note.
import { exec, home, notify, setShared, shared } from "herdr";
import * as fs from "fs/promises";
import { basename, copyName, dirname, joinPath, pictureLink, uniqueName } from "./lib.js";
import { imagesDir } from "./images.js";

export const IMAGE_FOLDER_KEY = "herdr-inline-markdown.imageFolder";

const TYPES = ["public.png", "public.jpeg", "com.compuserve.gif", "org.webmproject.webp", "com.microsoft.bmp", "public.svg-image"];
const CANCELLED = /-128\b|User canceled/i;

// The folder arrives as argv: a path is never part of the script. An unknown folder opens the dialog at home.
const START = [
  "on run argv",
  "set fallback to path to home folder",
  "try",
  "set startAt to (POSIX file (item 1 of argv)) as alias",
  "on error",
  "set startAt to fallback",
  "end try",
  "activate",
];
const choose = prompt => `set picked to choose file with prompt "${prompt}" of type {${TYPES.map(t => `"${t}"`).join(", ")}} default location startAt`;
const SCRIPT = [
  ...START,
  `${choose("Insert an image")} with multiple selections allowed`,
  "set paths to {}",
  "repeat with item_ in picked",
  "set end of paths to POSIX path of item_",
  "end repeat",
  "set AppleScript's text item delimiters to linefeed",
  "return paths as text",
  "end run",
];
const ONE_SCRIPT = [...START, choose("Change the picture"), "return POSIX path of picked", "end run"];

const why = e => String(e?.message ?? e);

export class DialogUnavailable extends Error {}

// Where the dialog opens: the folder the last picture came from, else the Desktop, where macOS saves screenshots.
export function imageStart() {
  const kept = shared(IMAGE_FOLDER_KEY);
  return typeof kept === "string" && kept ? kept : `${home()}/Desktop`;
}

// exec stops a command after 30 s, which is too short for a dialog someone browses in. So sh only starts osascript in the
// background and prints the pid of that subshell; osascript's stdout and stderr go to files beside `base`, and its exit
// status goes to base.code, renamed into place last so that its existence means the others are complete. A TERM to the
// pid ends osascript too.
const DETACH = [
  "base=$1; shift",
  "(",
  '  osascript "$@" >"$base.txt" 2>"$base.err" &',
  "  child=$!",
  `  trap 'kill $child; rm -f "$base.txt" "$base.err"; exit 143' TERM`,
  "  wait $child",
  '  echo $? >"$base.code.tmp"',
  '  mv "$base.code.tmp" "$base.code"',
  ") </dev/null >/dev/null 2>&1 &",
  "echo $!",
].join("\n");

const POLL_MS = 300;
// The process is looked at on every 7th poll, about every 2 s.
const LOOK_EVERY = 7;
const ANSWER_FILES = ["code", "txt", "err"];
let started = 0;

const readOrEmpty = async path => {
  try { return await fs.readFile(path, "utf8"); } catch { return ""; }
};

const discard = base => Promise.all(ANSWER_FILES.map(ext => fs.unlink(`${base}.${ext}`).catch(() => {})));

// -> the paths chosen, or null when the dialog was cancelled. Throws what osascript said when it failed, and a
// DialogUnavailable when it is not there.
async function answerOf(base) {
  const [code, stdout, stderr] = await Promise.all(ANSWER_FILES.map(ext => readOrEmpty(`${base}.${ext}`)));
  await discard(base);
  const status = code.trim();
  if (status === "0") return stdout.split("\n").filter(path => path !== "");
  if (CANCELLED.test(stderr)) return null;
  if (status === "127") throw new DialogUnavailable(stderr.trim() || "osascript was not found");
  throw new Error(stderr.trim() || `osascript exited with ${status}`);
}

// One dialog, for pictures to insert or, with `one`, for the one that replaces a picture. `wait(ms)` resolves after ms
// milliseconds; it is what a test replaces to have minutes pass at once.
export class PictureDialog {
  constructor(wait, { one = false } = {}) {
    this.wait = wait;
    this.script = one ? ONE_SCRIPT : SCRIPT;
    this.pid = null;
    this.stopped = false;
    this.stopping = new Promise(done => { this.stopNow = done; });
  }

  // Ends the dialog, and the wait for it, when the pane that asked is closed.
  stop() {
    this.stopped = true;
    this.stopNow();
    if (this.pid) this.kill();
  }

  async kill() {
    try { await exec("kill", [this.pid]); } catch { /* it is gone, or kill is */ }
  }

  async running() {
    try { return (await exec("kill", ["-0", this.pid])).code === 0; } catch { return true; }
  }

  async start(base, startFolder) {
    let ran;
    try {
      ran = await exec("sh", ["-c", DETACH, "sh", base, ...this.script.flatMap(line => ["-e", line]), startFolder]);
    } catch (e) {
      throw new DialogUnavailable(why(e));
    }
    const pid = Number.parseInt(ran.stdout, 10);
    if (ran.code !== 0 || !(pid > 0)) throw new Error(String(ran.stderr).trim() || "The picture dialog did not start");
    return String(pid);
  }

  // -> the paths chosen, null when cancelled or stopped. Throws what the dialog said when it failed.
  async pick(startFolder) {
    const base = `${imagesDir()}/pick-${Date.now().toString(36)}-${++started}`;
    await fs.mkdir(imagesDir(), { recursive: true });
    this.pid = await this.start(base, startFolder);
    try {
      if (this.stopped) {
        this.kill();
        return null;
      }
      for (let polls = 1; ; polls++) {
        await Promise.race([this.wait(POLL_MS), this.stopping]);
        if (this.stopped) return null;
        if (await fs.exists(`${base}.code`)) return await answerOf(base);
        if (polls % LOOK_EVERY === 0 && !(await this.running())) {
          if (await fs.exists(`${base}.code`)) return await answerOf(base);
          await discard(base);
          throw new Error("The picture dialog closed unexpectedly");
        }
      }
    } finally {
      this.pid = null;
    }
  }
}

export const altOf = path => {
  const name = basename(path), dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).replace(/\s+/g, " ").trim();
};

// Whether `alt` is the alt text Image wrote for the file at `path`: its name, or the name it was copied from, whose
// spaces the copy's name has as dashes.
export const altNames = (alt, path) => copyName(alt) === copyName(altOf(path));

const failed = (ran, command) => new Error(String(ran.stderr).trim() || `${command} exited with ${ran.code}`);

// images/ beside the note: made and listed once for all the pictures of one call; a failure is every picture's.
class ImagesFolder {
  constructor(path) {
    this.path = path;
    this.names = null;
  }

  taken() {
    this.names ??= this.prepare();
    return this.names;
  }

  async prepare() {
    const made = await exec("mkdir", ["-p", this.path]);
    if (made.code !== 0) throw failed(made, "mkdir");
    try {
      return new Set(await fs.readdir(this.path));
    } catch (e) {
      if (e?.code === "ENOENT") return new Set();
      throw e;
    }
  }
}

async function sameBytes(a, b) {
  try {
    const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return x.length === y.length && x.every((byte, i) => byte === y[i]);
  } catch {
    return false;
  }
}

// The first name from `clean`, `clean-2`, … that is free, or that holds the same bytes as `source`.
async function nameFor(source, folder, taken, clean) {
  const tried = new Set();
  for (let name = clean; ; name = uniqueName(tried, clean)) {
    tried.add(name);
    if (!taken.has(name)) return { name, copy: true };
    if (await sameBytes(source, `${folder}/${name}`)) return { name, copy: false };
  }
}

async function copyBeside(source, images) {
  const taken = await images.taken();
  const { name, copy } = await nameFor(source, images.path, taken, copyName(basename(source)));
  if (copy) {
    const ran = await exec("cp", [source, `${images.path}/${name}`]);
    if (ran.code !== 0) throw failed(ran, "cp");
    taken.add(name);
  }
  return `${images.path}/${name}`;
}

// -> [{ alt, address }] for the pictures that could be placed beside `note`, in order; one that could not be copied is
// left out with a notice of its own. The folder of the first is where the next dialog opens.
export async function placePictures(paths, note) {
  if (!paths.length) return [];
  const from = dirname(paths[0]);
  if (shared(IMAGE_FOLDER_KEY) !== from) setShared(IMAGE_FOLDER_KEY, from);
  const images = new ImagesFolder(joinPath(dirname(note), "images")), items = [];
  for (const path of paths) {
    const linked = pictureLink(path, note);
    try {
      items.push({ alt: altOf(path), address: linked ?? pictureLink(await copyBeside(path, images), note) });
    } catch (e) {
      notify({ title: `Couldn't copy ${basename(path)}`, body: why(e), level: "error" });
    }
  }
  return items;
}
