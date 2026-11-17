import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { state, calls, reset } from "./mocks/herdr.mjs";
import { files, failing, log } from "./mocks/fs.mjs";
import { png } from "./pictures.mjs";

const { DialogUnavailable, IMAGE_FOLDER_KEY, PictureDialog, altNames, altOf, imageStart, placePictures } = await import("../mods/herdr-inline-markdown/pick.js");

beforeEach(() => reset());

const NOTE = "/n/docs/note.md", DESKTOP = "/home/user/Desktop";
const SHOT = png(40, 30), OTHER = png(41, 31);

const SCRIPT = [
  "on run argv",
  "set fallback to path to home folder",
  "try",
  "set startAt to (POSIX file (item 1 of argv)) as alias",
  "on error",
  "set startAt to fallback",
  "end try",
  "activate",
  'set picked to choose file with prompt "Insert an image" of type {"public.png", "public.jpeg", "com.compuserve.gif", "org.webmproject.webp", "com.microsoft.bmp", "public.svg-image"} default location startAt with multiple selections allowed',
  "set paths to {}",
  "repeat with item_ in picked",
  "set end of paths to POSIX path of item_",
  "end repeat",
  "set AppleScript's text item delimiters to linefeed",
  "return paths as text",
  "end run",
];

const asked = command => calls.exec.filter(c => c.command === command);

// What starts the dialog: exec("sh", ["-c", DETACH, "sh", base, ...osascript's arguments]). The script returns at once,
// so exec's 30 s limit does not reach the dialog; osascript's answer is read from files beside `base`.
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
const PID = 4242, IMAGES = "/home/user/.config/herdr-app/data/herdr-inline-markdown/images";

// What the detached script leaves when osascript ends: stdout, stderr, and the exit status last.
const finish = (base, { code = 0, stdout = "", stderr = "" } = {}) => {
  files.set(`${base}.txt`, stdout);
  files.set(`${base}.err`, stderr);
  files.set(`${base}.code`, `${code}\n`);
};

// `sh` answers with the pid; `kill` says whether the process lives. Nothing runs: `run.base` is the name the dialog chose.
function detached({ alive = true } = {}) {
  const run = { base: null, alive };
  state.exec = async (command, args) => {
    if (command === "sh") {
      run.base = args[3];
      return { code: 0, stdout: `${PID}\n`, stderr: "" };
    }
    if (command === "kill") return { code: args[0] === "-0" && !run.alive ? 1 : 0, stdout: "", stderr: "" };
    throw new Error(`unexpected ${command}`);
  };
  return run;
}

// A dialog whose answer comes after `polls` waits of 300 ms, as `result`.
async function answeredAfter(polls, result, options) {
  const run = detached(options);
  let waited = 0;
  const waits = [];
  const dialog = new PictureDialog(async ms => {
    waits.push(ms);
    if (++waited === polls) finish(run.base, result);
  });
  const outcome = await dialog.pick(DESKTOP).then(paths => ({ paths }), error => ({ error }));
  return { ...outcome, run, waits };
}

test("the dialog starts detached: sh -c with the script, a base name in the picture cache folder, osascript's arguments, the start folder last and never inside the script", async () => {
  const run = detached();
  const folder = `${DESKTOP}/it's "mine" $HOME`;
  await new PictureDialog(async () => finish(run.base, { stdout: `${DESKTOP}/a.png\n` })).pick(folder);
  const [started] = calls.exec;
  assert.equal(started.command, "sh");
  const [flag, script, name, base, ...osascript] = started.args;
  assert.deepEqual([flag, script, name], ["-c", DETACH, "sh"]);
  assert.match(base, new RegExp(`^${IMAGES}/pick-[0-9a-z]+-\\d+$`));
  assert.deepEqual(osascript, [...SCRIPT.flatMap(line => ["-e", line]), folder]);
  assert.ok(!script.includes("mine") && osascript.slice(0, -1).every(line => !line.includes("mine")), "the folder is an argument, not part of any script");
  assert.ok(SCRIPT.indexOf("activate") < SCRIPT.findIndex(line => line.includes("choose file")), "it comes to the front before the dialog is shown");
  assert.deepEqual(log.mkdir.at(-1), [IMAGES, { recursive: true }], "the folder the answer is written in is there");
  assert.deepEqual(calls.exec.map(c => c.command), ["sh"], "an answer that is there at the first look needs no look at the process");
});

test("a dialog for one picture asks 'Change the picture', allows no multiple selection and answers the one path it chose", async () => {
  const run = detached();
  const one = SCRIPT.slice(0, 8).concat([
    'set picked to choose file with prompt "Change the picture" of type {"public.png", "public.jpeg", "com.compuserve.gif", "org.webmproject.webp", "com.microsoft.bmp", "public.svg-image"} default location startAt',
    "return POSIX path of picked",
    "end run",
  ]);
  const paths = await new PictureDialog(async () => finish(run.base, { stdout: "/Users/me/pics/b c.png\n" }), { one: true }).pick("/Users/me/pics");
  assert.deepEqual(paths, ["/Users/me/pics/b c.png"]);
  assert.deepEqual(calls.exec[0].args.slice(4), [...one.flatMap(line => ["-e", line]), "/Users/me/pics"]);
});

test("altNames: whether an alt text is the name Image gave a file, as written or with the copy's dashes for its spaces", () => {
  assert.equal(altOf("/Users/me/Desktop/shot 1.png"), "shot 1");
  for (const [alt, path, names] of [
    ["shot 1", "/n/docs/images/shot-1.png", true], ["shot-1", "/n/docs/images/shot-1.png", true], ["a", "/n/docs/a.png", true],
    ["a b", "/n/docs/a b.png", true], ["", "", true], ["", "/n/docs/a.png", false], ["My chart", "/n/docs/a.png", false],
    ["w", "https://e.com/w.png", true],
  ]) assert.equal(altNames(alt, path), names, `${alt} / ${path}`);
});

test("each dialog has a base name of its own", async () => {
  const bases = [];
  for (let i = 0; i < 2; i++) {
    const run = detached();
    await new PictureDialog(async () => finish(run.base)).pick(DESKTOP);
    bases.push(run.base);
  }
  assert.notEqual(bases[0], bases[1]);
});

test("the answer is read when its .code file is there: the paths one per line, spaces kept, a trailing newline or none, none chosen as []", async () => {
  for (const [stdout, paths] of [
    ["/Users/me/Desktop/Screenshot 1.png\n/Users/me/pics/b.jpg\n/x/c.svg\n", ["/Users/me/Desktop/Screenshot 1.png", "/Users/me/pics/b.jpg", "/x/c.svg"]],
    ["/Users/me/a b.png", ["/Users/me/a b.png"]],
    ["\n", []],
  ]) assert.deepEqual((await answeredAfter(1, { stdout })).paths, paths, JSON.stringify(stdout));
});

test("a dialog open for minutes is waited for: 300 ms polls, the process looked at about every 2 s, and the answer is read when it comes", async () => {
  const { paths, waits, run } = await answeredAfter(1000, { stdout: "/Users/me/late.png\n" });
  assert.deepEqual(paths, ["/Users/me/late.png"]);
  assert.equal(waits.length, 1000);
  assert.ok(waits.every(ms => ms === 300));
  const looks = asked("kill");
  assert.equal(looks.length, Math.floor(999 / 7), "every 7th poll, 2.1 s, while no answer is there");
  assert.ok(looks.every(c => c.args.join(" ") === `-0 ${PID}`));
  assert.equal(asked("sh").length, 1);
  assert.ok(run.base);
});

test("an answer is cancelled by -128 or 'User canceled' on stderr, which gives null", async () => {
  for (const stderr of ["0:90: execution error: User canceled. (-128)\n", "execution error: User canceled.", "error -128"]) {
    assert.equal((await answeredAfter(1, { code: 1, stderr })).paths, null, stderr);
  }
});

test("any other failure throws osascript's reason, or its exit status when it said nothing", async () => {
  const a = await answeredAfter(1, { code: 1, stderr: "execution error: Can't get alias. (-43)\n" });
  assert.ok(!(a.error instanceof DialogUnavailable) && a.error.message === "execution error: Can't get alias. (-43)");
  assert.equal((await answeredAfter(1, { code: 2 })).error.message, "osascript exited with 2");
  assert.equal((await answeredAfter(1, { code: "x\n" })).error.message, "osascript exited with x");
});

test("exit status 127 (osascript not found) is a DialogUnavailable, as is an sh that cannot start", async () => {
  const missing = await answeredAfter(1, { code: 127, stderr: "sh: osascript: command not found\n" });
  assert.ok(missing.error instanceof DialogUnavailable);
  assert.match(missing.error.message, /command not found/);
  state.exec = async () => { throw new Error("spawn sh ENOENT"); };
  await assert.rejects(new PictureDialog(async () => {}).pick(DESKTOP), e => e instanceof DialogUnavailable && /ENOENT/.test(e.message));
});

test("an sh that answers something that is no pid, or fails, is an error with its reason", async () => {
  state.exec = async () => ({ code: 0, stdout: "oops\n", stderr: "" });
  await assert.rejects(new PictureDialog(async () => {}).pick(DESKTOP), e => !(e instanceof DialogUnavailable) && /did not start/.test(e.message));
  state.exec = async () => ({ code: 1, stdout: "", stderr: "sh: cannot create\n" });
  await assert.rejects(new PictureDialog(async () => {}).pick(DESKTOP), { message: "sh: cannot create" });
});

test("a process that is gone with no .code file is the error 'The picture dialog closed unexpectedly', found by the first look after it died", async () => {
  const outcome = await answeredAfter(Infinity, {}, { alive: false });
  assert.equal(outcome.error.message, "The picture dialog closed unexpectedly");
  assert.ok(!(outcome.error instanceof DialogUnavailable));
  assert.equal(outcome.waits.length, 7, "looked at on the 7th poll");
  assert.deepEqual(asked("kill").map(c => c.args), [["-0", String(PID)]]);
});

test("a .code file that lands between the last look and the process check is still the answer", async () => {
  const run = detached();
  const dialog = new PictureDialog(async () => {});
  const base = state.exec;
  state.exec = async (command, args) => {
    if (command === "kill") {
      finish(run.base, { stdout: "/Users/me/last.png\n" });
      return { code: 1, stdout: "", stderr: "" };
    }
    return base(command, args);
  };
  assert.deepEqual(await dialog.pick(DESKTOP), ["/Users/me/last.png"]);
});

test("the three files are removed once read, however the dialog ended; a dialog that died leaves none either", async () => {
  for (const result of [{ stdout: "/a.png\n" }, { code: 1, stderr: "User canceled. (-128)" }, { code: 1, stderr: "boom" }, { code: 127 }]) {
    const { run } = await answeredAfter(2, result);
    for (const ext of ["txt", "err", "code"]) assert.ok(!files.has(`${run.base}.${ext}`), `${JSON.stringify(result)}: .${ext}`);
    assert.deepEqual(log.readFile.filter(path => path.startsWith(run.base)).sort(), [`${run.base}.code`, `${run.base}.err`, `${run.base}.txt`], "all read");
    log.readFile.length = 0;
  }
  const run = detached({ alive: false });
  const dialog = new PictureDialog(async () => {
    files.set(`${run.base}.txt`, "x");
    files.set(`${run.base}.err`, "y");
  });
  await assert.rejects(dialog.pick(DESKTOP), { message: "The picture dialog closed unexpectedly" });
  assert.deepEqual([files.has(`${run.base}.txt`), files.has(`${run.base}.err`)], [false, false]);
});

test("stop kills the dialog's process and ends the wait with null; nothing is read", async () => {
  detached();
  const dialog = new PictureDialog(() => new Promise(() => {}));
  const pending = dialog.pick(DESKTOP);
  await new Promise(done => setImmediate(done));
  dialog.stop();
  assert.equal(await pending, null);
  assert.deepEqual(asked("kill").map(c => c.args), [[String(PID)]]);
  assert.equal(asked("sh").length, 1);
  assert.deepEqual(log.readFile, []);
});

test("stop before sh has answered kills the process as soon as its pid is known", async () => {
  let answer;
  state.exec = async command => {
    if (command === "sh") return new Promise(done => { answer = done; });
    return { code: 0, stdout: "", stderr: "" };
  };
  const dialog = new PictureDialog(async () => {});
  const pending = dialog.pick(DESKTOP);
  await new Promise(done => setImmediate(done));
  dialog.stop();
  assert.deepEqual(asked("kill"), [], "no pid yet");
  answer({ code: 0, stdout: `${PID}\n`, stderr: "" });
  assert.equal(await pending, null);
  assert.deepEqual(asked("kill").map(c => c.args), [[String(PID)]]);
});

test("a kill that cannot run does not fail the stop, nor a process check that cannot run the dialog", async () => {
  const run = detached();
  const base = state.exec;
  state.exec = async (command, args) => {
    if (command === "kill") throw new Error("spawn kill ENOENT");
    return base(command, args);
  };
  const dialog = new PictureDialog(async () => {
    if (!files.has(`${run.base}.code`) && asked("kill").length >= 1) finish(run.base, { stdout: "/Users/me/ok.png\n" });
  });
  assert.deepEqual(await dialog.pick(DESKTOP), ["/Users/me/ok.png"]);
  const stopped = new PictureDialog(() => new Promise(() => {}));
  const pending = stopped.pick(DESKTOP);
  await new Promise(done => setImmediate(done));
  stopped.stop();
  assert.equal(await pending, null);
});

test("imageStart is the folder the last picture came from, else the Desktop", () => {
  assert.equal(imageStart(), DESKTOP);
  state.shared[IMAGE_FOLDER_KEY] = "/Users/me/pics";
  assert.equal(imageStart(), "/Users/me/pics");
  state.shared[IMAGE_FOLDER_KEY] = "";
  assert.equal(imageStart(), DESKTOP, "an empty value is no folder");
  state.shared[IMAGE_FOLDER_KEY] = 7;
  assert.equal(imageStart(), DESKTOP, "nor is a value that is not text");
  assert.equal(IMAGE_FOLDER_KEY, "herdr-inline-markdown.imageFolder");
});

// cp copies in the in-memory file system, unless `cp` has an answer (or an error to reject with) for its source, or is a
// function of the arguments; mkdir answers `mkdir`.
function shell({ mkdir = { code: 0, stdout: "", stderr: "" }, cp = {} } = {}) {
  state.exec = async (command, args) => {
    if (command === "mkdir") return mkdir;
    if (command !== "cp") throw new Error(`unexpected ${command}`);
    const answer = typeof cp === "function" ? cp(args) : cp[args[0]];
    if (answer instanceof Error) throw answer;
    if (answer) return answer;
    files.set(args[1], files.get(args[0]));
    return { code: 0, stdout: "", stderr: "" };
  };
}
const execs = () => calls.exec.map(c => [c.command, ...c.args]);

test("a picture in or under the note's folder is linked where it is: nothing runs, nothing is copied", async () => {
  const items = await placePictures(["/n/docs/a.png", "/n/docs/img/my shot.png"], NOTE);
  assert.deepEqual(items, [{ alt: "a", address: "a.png" }, { alt: "my shot", address: "<img/my shot.png>" }]);
  assert.deepEqual(calls.exec, []);
});

test("a picture from outside is copied into images/ beside the note: mkdir -p, then cp, and linked as images/<name>", async () => {
  shell();
  files.set(`${DESKTOP}/shot 1.png`, SHOT);
  const items = await placePictures([`${DESKTOP}/shot 1.png`], NOTE);
  assert.deepEqual(execs(), [["mkdir", "-p", "/n/docs/images"], ["cp", `${DESKTOP}/shot 1.png`, "/n/docs/images/shot-1.png"]]);
  assert.deepEqual(items, [{ alt: "shot 1", address: "images/shot-1.png" }]);
});

test("the copy's name has no whitespace, U+202F included; the alt is the original's name without its extension, spaces plain", async () => {
  shell();
  const name = "Screenshot 2026-11-06 at 10.15.30 AM.png";
  files.set(`${DESKTOP}/${name}`, SHOT);
  const items = await placePictures([`${DESKTOP}/${name}`], NOTE);
  assert.deepEqual(asked("cp")[0].args, [`${DESKTOP}/${name}`, "/n/docs/images/Screenshot-2026-11-06-at-10.15.30-AM.png"]);
  assert.deepEqual(items, [{ alt: "Screenshot 2026-11-06 at 10.15.30 AM", address: "images/Screenshot-2026-11-06-at-10.15.30-AM.png" }]);
});

test("a name that images/ holds already with other bytes is numbered: -2, -3; with the same bytes the file there is used and nothing is copied", async () => {
  shell();
  files.set("/n/docs/images/shot.png", OTHER);
  files.set(`${DESKTOP}/shot.png`, SHOT);
  assert.deepEqual(await placePictures([`${DESKTOP}/shot.png`], NOTE), [{ alt: "shot", address: "images/shot-2.png" }]);
  assert.deepEqual(asked("cp")[0].args, [`${DESKTOP}/shot.png`, "/n/docs/images/shot-2.png"]);
  calls.exec.length = 0;
  files.set("/n/docs/images/shot-2.png", OTHER);
  assert.deepEqual(await placePictures([`${DESKTOP}/shot.png`], NOTE), [{ alt: "shot", address: "images/shot-3.png" }]);
  calls.exec.length = 0;
  files.set("/n/docs/images/shot-3.png", SHOT);
  assert.deepEqual(await placePictures([`${DESKTOP}/shot.png`], NOTE), [{ alt: "shot", address: "images/shot-3.png" }], "a copy of it is there under a later number");
  assert.deepEqual(asked("cp"), []);
  files.set("/n/docs/images/shot.png", SHOT);
  assert.deepEqual(await placePictures([`${DESKTOP}/shot.png`], NOTE), [{ alt: "shot", address: "images/shot.png" }], "the first name that has the same bytes");
  assert.deepEqual(asked("cp"), []);
});

test("pictures picked together that would get one name: other bytes are numbered, the same bytes are copied once", async () => {
  shell();
  files.set(`${DESKTOP}/shot.png`, SHOT);
  files.set("/Users/me/pics/shot.png", OTHER);
  files.set("/Users/me/more/shot.png", SHOT);
  const items = await placePictures([`${DESKTOP}/shot.png`, "/Users/me/pics/shot.png", "/Users/me/more/shot.png"], NOTE);
  assert.deepEqual(items.map(i => i.address), ["images/shot.png", "images/shot-2.png", "images/shot.png"]);
  assert.deepEqual(asked("cp").map(c => c.args[1]), ["/n/docs/images/shot.png", "/n/docs/images/shot-2.png"]);
  assert.equal(asked("mkdir").length, 1, "the folder is made once");
});

test("a picture that cannot be read to be compared is copied under a new name, never over the one there", async () => {
  shell();
  files.set("/n/docs/images/shot.png", OTHER);
  files.set(`${DESKTOP}/shot.png`, SHOT);
  failing.readFile.set(`${DESKTOP}/shot.png`, new Error("EPERM"));
  assert.deepEqual((await placePictures([`${DESKTOP}/shot.png`], NOTE)).map(i => i.address), ["images/shot-2.png"]);
});

test("a copy that fails is left out and one notice names it with the reason; the others still go in", async () => {
  shell({ cp: { [`${DESKTOP}/b.png`]: { code: 1, stdout: "", stderr: "cp: /Users/me/Desktop/b.png: Permission denied\n" } } });
  for (const name of ["a", "b", "c"]) files.set(`${DESKTOP}/${name}.png`, SHOT);
  const items = await placePictures([`${DESKTOP}/a.png`, `${DESKTOP}/b.png`, `${DESKTOP}/c.png`, "/n/docs/d.png"], NOTE);
  assert.deepEqual(items.map(i => i.address), ["images/a.png", "images/c.png", "d.png"]);
  assert.deepEqual(calls.notify, [{ title: "Couldn't copy b.png", body: "cp: /Users/me/Desktop/b.png: Permission denied", level: "error" }]);
});

test("a cp that cannot start fails the same way, with its message", async () => {
  shell({ cp: () => new Error("spawn cp ENOENT") });
  files.set(`${DESKTOP}/a.png`, SHOT);
  assert.deepEqual(await placePictures([`${DESKTOP}/a.png`], NOTE), []);
  assert.deepEqual(calls.notify, [{ title: "Couldn't copy a.png", body: "spawn cp ENOENT", level: "error" }]);
});

test("when images/ cannot be made, every picture that needs a copy gets its notice and the linked ones stay", async () => {
  shell({ mkdir: { code: 1, stdout: "", stderr: "mkdir: /n/docs/images: Permission denied\n" } });
  files.set(`${DESKTOP}/a.png`, SHOT);
  files.set(`${DESKTOP}/b.png`, SHOT);
  const items = await placePictures([`${DESKTOP}/a.png`, "/n/docs/x.png", `${DESKTOP}/b.png`], NOTE);
  assert.deepEqual(items, [{ alt: "x", address: "x.png" }]);
  assert.deepEqual(calls.notify.map(n => [n.title, n.body]), [["Couldn't copy a.png", "mkdir: /n/docs/images: Permission denied"], ["Couldn't copy b.png", "mkdir: /n/docs/images: Permission denied"]]);
  assert.deepEqual(asked("cp"), []);
});

test("an images/ folder that cannot be listed fails the copy instead of risking a name that is taken", async () => {
  shell();
  files.set(`${DESKTOP}/a.png`, SHOT);
  failing.readdir.set("/n/docs/images", Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
  assert.deepEqual(await placePictures([`${DESKTOP}/a.png`], NOTE), []);
  assert.deepEqual(calls.notify.map(n => [n.title, n.body]), [["Couldn't copy a.png", "EACCES: permission denied"]]);
  assert.deepEqual(asked("cp"), []);
});

test("the folder of the first picture is remembered for the next dialog, once", async () => {
  shell();
  files.set(`${DESKTOP}/a.png`, SHOT);
  await placePictures([`${DESKTOP}/a.png`, "/n/docs/b.png"], NOTE);
  assert.deepEqual(calls.setShared, [[IMAGE_FOLDER_KEY, DESKTOP]]);
  await placePictures([`${DESKTOP}/a.png`], NOTE);
  assert.equal(calls.setShared.length, 1, "the same folder again sets nothing");
  await placePictures(["/n/docs/img/b.png", `${DESKTOP}/a.png`], NOTE);
  assert.deepEqual(calls.setShared.at(-1), [IMAGE_FOLDER_KEY, "/n/docs/img"]);
});

test("no pictures: nothing runs and nothing is remembered", async () => {
  assert.deepEqual(await placePictures([], NOTE), []);
  assert.deepEqual([calls.exec, calls.setShared, calls.notify], [[], [], []]);
});
