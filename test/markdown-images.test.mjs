import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { state, calls, reset, theme } from "./mocks/herdr.mjs";
import { files, log, failing, hold } from "./mocks/fs.mjs";
import { all, find, textOf } from "./mocks/element.mjs";
import { makeCx } from "./helpers.mjs";
import { png, svg, bytes } from "./pictures.mjs";

const { Images, pictureBlock, imagesDir, pictureImagePath } = await import("../mods/herdr-inline-markdown/images.js");
const { PICTURE } = await import("../mods/herdr-inline-markdown/geometry.js");
const { hash } = await import("../mods/herdr-inline-markdown/lib.js");

const IMAGES = "/home/user/.config/herdr-app/data/herdr-inline-markdown/images";
const DOC = "/n/docs/a.md", DIR = "/n/docs";
const LOCAL = { remote: null };
const PENDING = { state: "pending", path: null, width: 0, height: 0, error: null };
const DONE = { code: 0, stdout: "", stderr: "" };
const CURL = ["-sSfL", "--proto", "=https", "--proto-redir", "=https", "--max-time", "20", "--max-filesize", "10485760", "-o"];
const SHIELD = "https://img.shields.io/badge/a-b.svg";
const NOT_A_PICTURE = "Not a picture Herdr can show (PNG, JPEG, GIF, WebP, BMP, SVG)";

beforeEach(() => reset());

const sha = picture => createHash("sha256").update(picture).digest("hex").slice(0, 16);
const okAt = (picture, ext, width, height) => ({ state: "ok", path: `data/herdr-inline-markdown/images/${sha(picture)}.${ext}`, width, height, error: null });
const failed = error => ({ state: "error", path: null, width: 0, height: 0, error });
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(done => setImmediate(done)); };
function mount() {
  const cx = makeCx(), images = new Images(), changes = [];
  images.onChange = c => changes.push(c);
  return { cx, images, changes };
}
const curls = () => calls.exec.filter(c => c.command === "curl");
const downloadedTo = args => args[args.indexOf("-o") + 1];
const serve = body => {
  state.exec = async (command, args) => {
    if (command === "curl") files.set(downloadedTo(args), body);
    return DONE;
  };
};
const exits = (code, stderr = "") => { state.exec = async () => ({ code, stdout: "", stderr }); };
const parts = () => [...files.keys()].filter(path => path.endsWith(".part"));

test("the cache folder is the app folder's data/herdr-inline-markdown/images, and an image path is relative to the app folder", () => {
  assert.equal(imagesDir(), IMAGES);
  assert.equal(pictureImagePath("abc.png"), "data/herdr-inline-markdown/images/abc.png");
  state.appHome = "/home/user/.config/herdr-app/";
  assert.equal(imagesDir(), IMAGES, "a trailing slash does not double");
});

test("a local picture is copied into the cache folder under the hash of its bytes; asking again reads nothing", async () => {
  const picture = png(40, 30);
  files.set(`${DIR}/pic.png`, picture);
  const { cx, images, changes } = mount();
  assert.deepEqual(images.get("pic.png", DOC, LOCAL, cx), PENDING);
  assert.deepEqual(images.get("pic.png", DOC, LOCAL, cx), PENDING, "asking while it loads starts nothing more");
  await flush();
  assert.deepEqual(log.readFile, [`${DIR}/pic.png`]);
  assert.deepEqual(images.get("pic.png", DOC, LOCAL, cx), okAt(picture, "png", 40, 30));
  assert.deepEqual(images.get("./sub/../pic.png", DOC, LOCAL, cx), okAt(picture, "png", 40, 30), "another spelling of the same file");
  assert.deepEqual(log.readFile, [`${DIR}/pic.png`], "nothing is read again");
  assert.deepEqual(log.writeFile, [`${IMAGES}/${sha(picture)}.png`]);
  assert.equal(files.get(`${IMAGES}/${sha(picture)}.png`), picture);
  assert.deepEqual(log.mkdir, [[IMAGES, { recursive: true }]]);
  assert.deepEqual(changes, [cx.taskCx], "the view is told once, with the cx of the task");
  assert.equal(cx.notified, 1);
});

test("the cache file takes the extension of what the bytes are, not of the name they came with", async () => {
  const picture = svg(10, 20);
  files.set(`${DIR}/looks-like.png`, picture);
  const { cx, images } = mount();
  images.get("looks-like.png", DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get("looks-like.png", DOC, LOCAL, cx), okAt(picture, "svg", 10, 20));
});

test("the same bytes from two paths share one cache file, and different bytes do not", async () => {
  const picture = png(8, 8);
  files.set(`${DIR}/a.png`, picture);
  files.set(`${DIR}/sub/b.png`, new Uint8Array(picture));
  files.set(`${DIR}/c.png`, png(8, 9));
  const { cx, images } = mount();
  for (const src of ["a.png", "sub/b.png", "c.png"]) {
    images.get(src, DOC, LOCAL, cx);
    await flush();
  }
  const [a, b, c] = ["a.png", "sub/b.png", "c.png"].map(src => images.get(src, DOC, LOCAL, cx));
  assert.equal(a.path, b.path);
  assert.notEqual(a.path, c.path);
  assert.equal(log.writeFile.length, 2, "the second path found its file there");
  assert.deepEqual([...files.keys()].filter(path => path.startsWith(`${IMAGES}/`)).sort(), [`${IMAGES}/${sha(picture)}.png`, `${IMAGES}/${sha(png(8, 9))}.png`].sort());
});

test("the cache folder is made once per service, before the first write", async () => {
  files.set(`${DIR}/a.png`, png(1, 1));
  files.set(`${DIR}/b.png`, png(2, 2));
  const { cx, images } = mount();
  images.get("a.png", DOC, LOCAL, cx);
  images.get("b.png", DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(log.mkdir, [[IMAGES, { recursive: true }]]);
  const other = mount();
  files.set(`${DIR}/c.png`, png(3, 3));
  other.images.get("c.png", DOC, LOCAL, other.cx);
  await flush();
  assert.equal(log.mkdir.length, 2);
});

test("a picture that is not there says so, once", async () => {
  const { cx, images, changes } = mount();
  assert.deepEqual(images.get("gone.png", DOC, LOCAL, cx), PENDING);
  await flush();
  assert.deepEqual(images.get("gone.png", DOC, LOCAL, cx), failed("Not found"));
  assert.deepEqual(images.get("gone.png", DOC, LOCAL, cx), failed("Not found"));
  assert.deepEqual(log.readFile, [`${DIR}/gone.png`], "a failure is kept until forget() drops it");
  assert.equal(changes.length, 1);
});

test("a read that fails says why, and Not found is told by the words of the error", async () => {
  failing.readFile.set(`${DIR}/locked.png`, new Error("EACCES: permission denied"));
  failing.readFile.set(`${DIR}/rust.png`, new Error("No such file or directory (os error 2)"));
  failing.readFile.set(`${DIR}/code.png`, Object.assign(new Error("open failed"), { code: "ENOENT" }));
  const { cx, images } = mount();
  for (const src of ["locked.png", "rust.png", "code.png"]) images.get(src, DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get("locked.png", DOC, LOCAL, cx), failed("Can't read it: EACCES: permission denied"));
  assert.deepEqual(images.get("rust.png", DOC, LOCAL, cx), failed("Not found"));
  assert.deepEqual(images.get("code.png", DOC, LOCAL, cx), failed("Not found"));
});

test("bytes that are not a picture, or not one Herdr shows, say so", async () => {
  files.set(`${DIR}/notes.png`, bytes("just words"));
  files.set(`${DIR}/empty.png`, new Uint8Array(0));
  files.set(`${DIR}/zero.png`, png(0, 5));
  const { cx, images } = mount();
  for (const src of ["notes.png", "empty.png", "zero.png"]) images.get(src, DOC, LOCAL, cx);
  await flush();
  for (const src of ["notes.png", "empty.png", "zero.png"]) assert.deepEqual(images.get(src, DOC, LOCAL, cx), failed(NOT_A_PICTURE), src);
  assert.equal(log.writeFile.length, 0, "nothing of it is written to the cache");
});

test("a file over 25 MB is not shown; one of exactly 25 MB is", async () => {
  const limit = 26214400, over = new Uint8Array(limit + 1), exact = new Uint8Array(limit);
  over.set(png(10, 10));
  exact.set(png(10, 10));
  files.set(`${DIR}/over.png`, over);
  files.set(`${DIR}/exact.png`, exact);
  const { cx, images } = mount();
  images.get("over.png", DOC, LOCAL, cx);
  images.get("exact.png", DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get("over.png", DOC, LOCAL, cx), failed("Over 25 MB: too big to show"));
  assert.deepEqual(images.get("exact.png", DOC, LOCAL, cx), okAt(exact, "png", 10, 10));
});

test("a picture over 50 megapixels is not shown, whatever its bytes; one of exactly 50 is", async () => {
  files.set(`${DIR}/huge.png`, png(10000, 5001));
  files.set(`${DIR}/edge.png`, png(10000, 5000));
  const { cx, images } = mount();
  images.get("huge.png", DOC, LOCAL, cx);
  images.get("edge.png", DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get("huge.png", DOC, LOCAL, cx), failed("Too big to show (10000 × 5001 px)"));
  assert.equal(images.get("edge.png", DOC, LOCAL, cx).state, "ok");
});

test("a cache that cannot be written says so", async () => {
  files.set(`${DIR}/a.png`, png(4, 4));
  failing.writeFile.set("*", new Error("No space left on device"));
  const { cx, images } = mount();
  images.get("a.png", DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get("a.png", DOC, LOCAL, cx), failed("Can't write the picture cache: No space left on device"));
});

test("an address that is no picture address is an error at once, with no work and no callback", () => {
  const { cx, images, changes } = mount();
  assert.deepEqual(images.get("", DOC, LOCAL, cx), failed("No picture address"));
  assert.deepEqual(images.get("http://x.io/a.png", DOC, LOCAL, cx), failed("Pictures load over https only"));
  assert.deepEqual(images.get("#top", DOC, LOCAL, cx), failed("Not a picture address"));
  assert.deepEqual(images.get("ftp://x.io/a.png", DOC, LOCAL, cx), failed("Can't show a picture from ftp:"));
  assert.deepEqual([calls.exec.length, log.readFile.length, log.writeFile.length, log.mkdir.length, changes.length, cx.notified, cx.timers.length], [0, 0, 0, 0, 0, 0, 0]);
});

test("a picture on another machine is an error at once and is not read; its https pictures load", async () => {
  files.set(`${DIR}/pic.png`, png(4, 4));
  serve(svg(5, 5));
  const { cx, images, changes } = mount();
  assert.deepEqual(images.get("pic.png", DOC, { remote: "devbox" }, cx), failed("Pictures on another machine aren't shown yet"));
  assert.deepEqual(images.get("/abs/pic.png", DOC, { remote: "devbox" }, cx), failed("Pictures on another machine aren't shown yet"));
  assert.deepEqual([calls.exec.length, log.readFile.length, changes.length], [0, 0, 0]);
  images.get(SHIELD, DOC, { remote: "devbox" }, cx);
  await flush();
  assert.equal(images.get(SHIELD, DOC, { remote: "devbox" }, cx).state, "ok");
  images.get("pic.png", DOC, LOCAL, cx);
  await flush();
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).state, "ok", "the same file on this machine is not held back by the remote answer");
});

test("an https picture is downloaded with curl into the cache folder, read, and its .part removed", async () => {
  const picture = svg(88, 20);
  serve(picture);
  const { cx, images, changes } = mount();
  assert.deepEqual(images.get(SHIELD, DOC, LOCAL, cx), PENDING);
  await flush();
  const [call, ...more] = curls();
  assert.equal(more.length, 0);
  const tmp = downloadedTo(call.args);
  assert.ok(tmp.startsWith(`${IMAGES}/web-${hash(SHIELD)}-`) && tmp.endsWith(".part"), tmp);
  assert.deepEqual(call.args, [...CURL, tmp, SHIELD]);
  assert.deepEqual(parts(), []);
  assert.deepEqual(images.get(SHIELD, DOC, LOCAL, cx), okAt(picture, "svg", 88, 20));
  assert.equal(files.get(`${IMAGES}/${sha(picture)}.svg`), picture);
  assert.equal(changes.length, 1);
  images.get(SHIELD, "/other/doc.md", { remote: "devbox" }, cx);
  await flush();
  assert.equal(curls().length, 1, "the same address is downloaded once, whoever asks");
  assert.equal(log.mkdir.length, 1, "the folder was made before curl wrote into it");
});

test("two downloads at once write to two .part files", async () => {
  const seen = [];
  state.exec = async (command, args) => {
    if (command === "curl") { seen.push(downloadedTo(args)); files.set(downloadedTo(args), svg(1, 1)); }
    return DONE;
  };
  const { cx, images } = mount();
  images.get("https://x.io/a.svg", DOC, LOCAL, cx);
  images.get("https://x.io/b.svg", DOC, LOCAL, cx);
  await flush();
  assert.equal(new Set(seen).size, 2);
});

test("a web picture that is not a picture, or is too big, says so and leaves no .part", async () => {
  serve(bytes("<html>404</html>"));
  const { cx, images } = mount();
  images.get(SHIELD, DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get(SHIELD, DOC, LOCAL, cx), failed(NOT_A_PICTURE));
  assert.deepEqual(parts(), []);
  serve(png(10000, 6000));
  images.get("https://x.io/big.png", DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get("https://x.io/big.png", DOC, LOCAL, cx), failed("Too big to show (10000 × 6000 px)"));
  assert.deepEqual(parts(), []);
});

test("a download whose file cannot be read says why and leaves no .part", async () => {
  serve(png(2, 2));
  failing.readFile.set("*", new Error("EIO: input/output error"));
  const { cx, images } = mount();
  images.get(SHIELD, DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get(SHIELD, DOC, LOCAL, cx), failed("Can't read it: EIO: input/output error"));
  assert.deepEqual(parts(), []);
});

test("without curl a web picture says so", async () => {
  state.exec = async () => { throw new Error("spawn curl ENOENT"); };
  const { cx, images } = mount();
  images.get(SHIELD, DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get(SHIELD, DOC, LOCAL, cx), failed("Web pictures need curl"));
});

test("curl's exit says what went wrong: 28 timed out, 63 too big, the rest in curl's own words", async () => {
  const cases = [
    [28, "curl: (28) Operation timed out after 20001 milliseconds", "Timed out"],
    [63, "curl: (63) Maximum file size exceeded", "Over 10 MB"],
    [22, "curl: (22) The requested URL returned error: 404\n", "The requested URL returned error: 404"],
    [6, "  curl: (6) Could not resolve host: nowhere.invalid  \n", "Could not resolve host: nowhere.invalid"],
    [7, "", "The download failed (curl exit 7)"],
    [35, "\n", "The download failed (curl exit 35)"],
  ];
  for (const [code, stderr, error] of cases) {
    reset();
    state.exec = async (command, args) => {
      if (command === "curl") files.set(downloadedTo(args), bytes("partial"));
      return { code, stdout: "", stderr };
    };
    const { cx, images } = mount();
    images.get(SHIELD, DOC, LOCAL, cx);
    await flush();
    assert.deepEqual(images.get(SHIELD, DOC, LOCAL, cx), failed(error), `exit ${code}`);
    assert.deepEqual(parts(), [], `exit ${code}: what curl left is removed`);
  }
});

test("a data: picture is made of its base64 payload", async () => {
  const picture = png(5, 6), url = `data:image/png;base64,${Buffer.from(picture).toString("base64")}`;
  const { cx, images, changes } = mount();
  assert.deepEqual(images.get(url, DOC, LOCAL, cx), PENDING);
  await flush();
  assert.deepEqual(images.get(url, DOC, LOCAL, cx), okAt(picture, "png", 5, 6));
  assert.deepEqual([...files.get(`${IMAGES}/${sha(picture)}.png`)], [...picture]);
  assert.equal(curls().length, 0);
  images.get(url, "/other/doc.md", LOCAL, cx);
  await flush();
  assert.equal(changes.length, 1, "the same data is one picture");
  const escaped = url.replace(/A/g, "%41");
  assert.equal(images.get(escaped, DOC, LOCAL, cx).state, "pending", "another spelling is another source");
  await flush();
  assert.deepEqual(images.get(escaped, DOC, LOCAL, cx), okAt(picture, "png", 5, 6), "with the same bytes in the end, so the same file");
  assert.equal(log.writeFile.length, 1);
});

test("a data: picture that is not base64 is its percent-decoded text, as UTF-8", async () => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><title>café</title></svg>';
  const url = `data:image/svg+xml,${encodeURIComponent(text)}`;
  const { cx, images } = mount();
  images.get(url, DOC, LOCAL, cx);
  await flush();
  const picture = new Uint8Array(Buffer.from(text, "utf8"));
  assert.deepEqual(images.get(url, DOC, LOCAL, cx), okAt(picture, "svg", 10, 20));
  assert.deepEqual([...files.get(`${IMAGES}/${sha(picture)}.svg`)], [...picture]);
});

test("a data: picture written out as it is, with a % that is no escape, still reads", async () => {
  const { cx, images } = mount();
  const url = "data:image/svg+xml;utf8,<svg width='100%' viewBox='0 0 8 6'/>";
  images.get(url, DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get(url, DOC, LOCAL, cx), okAt(bytes("<svg width='100%' viewBox='0 0 8 6'/>"), "svg", 8, 6));
});

test("a data: address with no payload is not a picture", async () => {
  const { cx, images } = mount();
  images.get("data:image/png", DOC, LOCAL, cx);
  images.get("data:image/png;base64,", DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(images.get("data:image/png", DOC, LOCAL, cx), failed(NOT_A_PICTURE));
  assert.deepEqual(images.get("data:image/png;base64,", DOC, LOCAL, cx), failed(NOT_A_PICTURE));
});

test("at most four pictures load at once; each one that ends lets the next start", async () => {
  const waiting = [];
  let running = 0, most = 0;
  state.exec = (command, args) => {
    if (command !== "curl") return Promise.resolve(DONE);
    running++;
    most = Math.max(most, running);
    return new Promise(done => waiting.push(() => { running--; files.set(downloadedTo(args), svg(2, 2)); done(DONE); }));
  };
  const { cx, images, changes } = mount();
  const urls = Array.from({ length: 7 }, (_, i) => `https://x.io/${i}.svg`);
  for (const url of urls) assert.deepEqual(images.get(url, DOC, LOCAL, cx), PENDING);
  await flush();
  assert.equal(curls().length, 4);
  waiting.shift()();
  await flush();
  assert.equal(curls().length, 5, "one ended, one began");
  waiting.shift()(); waiting.shift()();
  await flush();
  assert.equal(curls().length, 7);
  while (waiting.length) waiting.shift()();
  await flush();
  assert.equal(most, 4);
  assert.deepEqual(urls.map(url => images.get(url, DOC, LOCAL, cx).state), Array(7).fill("ok"));
  assert.equal(changes.length, 7, "told as each one ends");
});

test("forget drops a file's answer by its path; the next get reads the file again", async () => {
  files.set(`${DIR}/pic.png`, png(10, 10));
  const { cx, images } = mount();
  images.get("pic.png", DOC, LOCAL, cx);
  images.get("late.png", DOC, LOCAL, cx);
  await flush();
  assert.equal(images.get("late.png", DOC, LOCAL, cx).error, "Not found");
  files.set(`${DIR}/pic.png`, png(20, 20));
  files.set(`${DIR}/late.png`, png(30, 30));
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).width, 10, "what was loaded is kept until told");
  assert.equal(images.forget([`${DIR}/pic.png`]), true);
  assert.deepEqual(images.get("pic.png", DOC, LOCAL, cx), PENDING);
  assert.equal(images.get("late.png", DOC, LOCAL, cx).error, "Not found", "another path is not touched");
  await flush();
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).width, 20);
  assert.equal(images.forget([`${DIR}/late.png`]), true, "a path that was missing is read again");
  images.get("late.png", DOC, LOCAL, cx);
  await flush();
  assert.equal(images.get("late.png", DOC, LOCAL, cx).width, 30);
});

test("forget drops what lies under a folder it is told of, with or without the slash, and not a folder that only starts alike", async () => {
  const { cx, images } = mount();
  files.set(`${DIR}/pic.png`, png(10, 10));
  files.set(`${DIR}/deep/er/pic2.png`, png(11, 11));
  images.get("pic.png", DOC, LOCAL, cx);
  images.get("deep/er/pic2.png", DOC, LOCAL, cx);
  await flush();
  assert.equal(images.forget(["/n/doc", "/n/docs2", "/n/docs/pi", "/n/other"]), false, "a name that is only the start of another");
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).state, "ok");
  assert.equal(images.forget([DIR]), true);
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).state, "pending");
  assert.equal(images.get("deep/er/pic2.png", DOC, LOCAL, cx).state, "pending");
  await flush();
  assert.equal(images.forget([`${DIR}/`]), true, "with a trailing slash");
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).state, "pending");
  await flush();
  assert.equal(images.forget(["/"]), true, "the root means everything");
  assert.equal(images.get("deep/er/pic2.png", DOC, LOCAL, cx).state, "pending");
});

test("forget drops by file name too, as the watcher may spell the folder differently", async () => {
  files.set(`${DIR}/pic.png`, png(10, 10));
  files.set(`${DIR}/other.png`, png(12, 12));
  const { cx, images } = mount();
  images.get("pic.png", DOC, LOCAL, cx);
  images.get("other.png", DOC, LOCAL, cx);
  await flush();
  assert.equal(images.forget(["/private/n/docs/pic.png"]), true);
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).state, "pending");
  assert.equal(images.get("other.png", DOC, LOCAL, cx).state, "ok");
  assert.equal(images.forget([]), false);
});

test("forget leaves web and data pictures be, and says so when there is nothing to drop", async () => {
  serve(svg(3, 3));
  const { cx, images } = mount();
  const data = `data:image/png;base64,${Buffer.from(png(2, 2)).toString("base64")}`;
  images.get(SHIELD, DOC, LOCAL, cx);
  images.get(data, DOC, LOCAL, cx);
  await flush();
  assert.equal(images.forget(["/", DIR, "badge", "a-b.svg", "https://img.shields.io/badge/a-b.svg"]), false);
  assert.equal(images.get(SHIELD, DOC, LOCAL, cx).state, "ok");
  assert.equal(images.get(data, DOC, LOCAL, cx).state, "ok");
  assert.equal(curls().length, 1);
});

test("a load still running for a picture that was forgotten does not store what it read", async () => {
  const path = `${DIR}/pic.png`;
  files.set(path, png(10, 10));
  const release = hold(path);
  const { cx, images, changes } = mount();
  assert.deepEqual(images.get("pic.png", DOC, LOCAL, cx), PENDING);
  assert.equal(images.forget([path]), true, "dropped while it loads");
  release();
  await flush();
  assert.deepEqual(changes, [], "its answer went nowhere");
  assert.deepEqual(log.writeFile, [], "and nothing of it was written");
  assert.deepEqual(images.get("pic.png", DOC, LOCAL, cx), PENDING, "so the next ask loads it afresh");
  await flush();
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).state, "ok");
});

test("a forgotten picture asked for again while the old load runs is answered by the new load", async () => {
  const path = `${DIR}/pic.png`;
  files.set(path, png(10, 10));
  const release = hold(path);
  const { cx, images } = mount();
  images.get("pic.png", DOC, LOCAL, cx);
  files.set(path, png(20, 20));
  images.forget([path]);
  images.get("pic.png", DOC, LOCAL, cx);
  release();
  await flush();
  assert.equal(images.get("pic.png", DOC, LOCAL, cx).width, 20);
});

test("a forgotten picture that had not started loading never does", async () => {
  const waiting = [];
  state.exec = (command, args) => {
    if (command !== "curl") return Promise.resolve(DONE);
    return new Promise(done => waiting.push(() => { files.set(downloadedTo(args), svg(2, 2)); done(DONE); }));
  };
  files.set(`${DIR}/queued.png`, png(7, 7));
  const { cx, images } = mount();
  for (let i = 0; i < 4; i++) images.get(`https://x.io/${i}.svg`, DOC, LOCAL, cx);
  images.get("queued.png", DOC, LOCAL, cx);
  await flush();
  assert.equal(images.forget([`${DIR}/queued.png`]), true);
  while (waiting.length) waiting.shift()();
  await flush();
  assert.equal(log.readFile.includes(`${DIR}/queued.png`), false, "the queued file was never read");
  assert.equal(curls().length, 4);
});

test("close: loads that end after it make no callback and write nothing, and the ones waiting never start", async () => {
  const waiting = [];
  state.exec = (command, args) => {
    if (command !== "curl") return Promise.resolve(DONE);
    return new Promise(done => waiting.push(() => { files.set(downloadedTo(args), svg(2, 2)); done(DONE); }));
  };
  const path = `${DIR}/pic.png`, release = hold(path);
  files.set(path, png(10, 10));
  const { cx, images, changes } = mount();
  images.get("pic.png", DOC, LOCAL, cx);
  for (let i = 0; i < 5; i++) images.get(`https://x.io/${i}.svg`, DOC, LOCAL, cx);
  await flush();
  assert.equal(curls().length, 3, "the file and three downloads fill the four places");
  images.close();
  release();
  while (waiting.length) waiting.shift()();
  await flush();
  assert.equal(curls().length, 3, "the ones waiting did not start");
  assert.deepEqual(changes, []);
  assert.equal(cx.notified, 0);
  assert.deepEqual(log.writeFile, []);
  assert.deepEqual(parts(), [], "the downloads' .part files are removed all the same");
  assert.equal(images.get("https://x.io/9.svg", DOC, LOCAL, cx).state, "pending", "asking after close is answered, not started");
  await flush();
  assert.equal(curls().length, 3);
});

// Each import with its own query is a copy of the module with its own once-per-run flag.
test("the cache folder is pruned once per app run, before the first load, with find, and a failing find is no matter", async () => {
  const fresh = await import("../mods/herdr-inline-markdown/images.js?prune-once");
  files.set(`${DIR}/a.png`, png(4, 4));
  files.set(`${DIR}/b.png`, png(5, 5));
  state.exec = async () => { throw new Error("find: not found"); };
  const { cx } = mount(), a = new fresh.Images(), b = new fresh.Images();
  assert.deepEqual(calls.exec, [], "nothing is run until a picture is asked for");
  a.get("a.png", DOC, LOCAL, cx);
  assert.deepEqual(calls.exec.map(c => [c.command, c.args]), [["find", [IMAGES, "-type", "f", "-mtime", "+45", "-delete"]]], "already asked for when get() returns");
  await flush();
  assert.equal(a.get("a.png", DOC, LOCAL, cx).state, "ok", "a find that fails does not matter");
  b.get("b.png", DOC, LOCAL, cx);
  a.get("b.png", DOC, LOCAL, cx);
  await flush();
  assert.equal(calls.exec.filter(c => c.command === "find").length, 1, "once, whichever service asks");
});

test("find is not run for addresses that need no load", async () => {
  const fresh = await import("../mods/herdr-inline-markdown/images.js?prune-none");
  const { cx } = mount(), images = new fresh.Images();
  state.exec = async () => DONE;
  images.get("", DOC, LOCAL, cx);
  images.get("http://x.io/a.png", DOC, LOCAL, cx);
  images.get("a.png", DOC, { remote: "devbox" }, cx);
  assert.deepEqual(calls.exec, []);
  images.get("missing.png", DOC, LOCAL, cx);
  await flush();
  assert.deepEqual(calls.exec.map(c => c.command), ["find"]);
});

const t = theme();
const READY = { state: "ok", path: "data/herdr-inline-markdown/images/0123456789abcdef.png", alt: "logo", src: "logo.png", error: null, href: null };
const PENDING_ITEM = { state: "pending", path: null, alt: "wait", src: "wait.png", error: null, href: null };
const ERROR_ITEM = { state: "error", path: null, alt: "gone", src: "img/gone.png", error: "Not found", href: null };
const block = (items, boxes, more = {}) => pictureBlock({ id: "pic-1", items, boxes, height: 120, selected: false, t, ...more });

test("pictureBlock: a box of the given height that its pictures are laid in by position", () => {
  const el = block([READY], [{ x: 0, y: 0, w: 100, h: 50 }]);
  assert.equal(el.__node.id, "pic-1");
  assert.equal(el.__node.style.relative, true);
  assert.equal(el.__node.style.h, 120);
  assert.equal(el.__node.style.w_full, true);
  const empty = block([], [], { height: 0 });
  assert.equal(empty.__node.kids.length, 0);
  assert.equal(empty.__node.style.h, 0);
});

test("pictureBlock: a ready picture is its image at its box, with ids from the block's id", () => {
  const el = block([READY, { ...READY, path: "data/herdr-inline-markdown/images/fedcba9876543210.jpg" }], [{ x: 0, y: 0, w: 100, h: 50 }, { x: 108, y: 4, w: 60, h: 30 }]);
  const [a, b] = all(el, n => n.kind === "image");
  assert.deepEqual([a.id, a.path, a.style.absolute, a.style.left, a.style.top, a.style.w, a.style.h], ["pic-1-0", READY.path, true, 0, 0, 100, 50]);
  assert.deepEqual([b.id, b.path, b.style.left, b.style.top, b.style.w, b.style.h], ["pic-1-1", "data/herdr-inline-markdown/images/fedcba9876543210.jpg", 108, 4, 60, 30]);
  assert.equal(a.style.cursor_pointer, undefined, "no hand without a link");
  assert.deepEqual(all(el, n => n.id !== null).map(n => n.id), ["pic-1", "pic-1-0", "pic-1-1"]);
});

test("pictureBlock: a linked picture shows the hand in every state, as does the tint over it; one without a link never does", () => {
  const linked = { href: "https://x.io" };
  const items = [{ ...READY, ...linked }, { ...PENDING_ITEM, ...linked }, { ...ERROR_ITEM, ...linked }, READY, PENDING_ITEM, ERROR_ITEM];
  const boxes = items.map((_, i) => ({ x: 0, y: i * 48, w: 100, h: 40 }));
  const el = block(items, boxes, { selected: true });
  assert.deepEqual(items.map((_, i) => find(el, `pic-1-${i}`).style.cursor_pointer), [true, true, true, undefined, undefined, undefined]);
  assert.equal(find(el, "pic-1-0-tint").style.cursor_pointer, true, "the hand stays over a selected linked picture");
  assert.equal(find(el, "pic-1-3-tint").style.cursor_pointer, undefined);
});

test("pictureBlock: the selection tint goes over a ready picture, and only while the block is selected", () => {
  const items = [READY, PENDING_ITEM, ERROR_ITEM], boxes = [{ x: 4, y: 6, w: 100, h: 50 }, { x: 0, y: 64, w: 300, h: 40 }, { x: 0, y: 112, w: 300, h: 40 }];
  assert.equal(find(block(items, boxes), "pic-1-0-tint"), null);
  const el = block(items, boxes, { selected: true });
  const tint = find(el, "pic-1-0-tint");
  assert.deepEqual([tint.style.absolute, tint.style.left, tint.style.top, tint.style.w, tint.style.h, tint.style.bg, tint.style.opacity], [true, 4, 6, 100, 50, "selection", 0.5]);
  assert.deepEqual(all(el, n => n.id?.endsWith("-tint")).map(n => n.id), ["pic-1-0-tint"], "the boxes of the others are not tinted");
  const order = all(el, n => n.id !== null).map(n => n.id);
  assert.ok(order.indexOf("pic-1-0-tint") > order.indexOf("pic-1-0"), "over the picture");
});

test("pictureBlock: a picture on its way is a box with the spinner and 'Loading picture…', boxH high", () => {
  const el = block([PENDING_ITEM], [{ x: 0, y: 0, w: 300, h: PICTURE.boxH }]);
  const box = find(el, "pic-1-0");
  assert.deepEqual([box.style.absolute, box.style.left, box.style.top, box.style.w, box.style.h], [true, 0, 0, 300, PICTURE.boxH]);
  assert.equal(textOf(box), "Loading picture…");
  const [spinner] = all(box, n => n.kind === "svg");
  assert.equal(spinner.path, "mods/herdr-inline-markdown/spinner.svg");
  assert.equal(spinner.style.spin, 900);
  assert.equal(all(el, n => n.kind === "image").length, 0);
});

test("pictureBlock: a picture that failed is a box with one line: its alt text, then why", () => {
  const el = block([ERROR_ITEM, { ...ERROR_ITEM, alt: "", error: "Over 25 MB: too big to show" }], [{ x: 0, y: 0, w: 300, h: 40 }, { x: 0, y: 48, w: 300, h: 40 }]);
  const [a, b] = ["pic-1-0", "pic-1-1"].map(id => find(el, id));
  assert.equal(textOf(a), "gone: Not found");
  assert.equal(textOf(b), "gone.png: Over 25 MB: too big to show", "no alt text: the file name");
  assert.deepEqual([a.style.absolute, a.style.top, a.style.w, a.style.h, a.style.bg, a.style.border_color, a.style.text_size, a.style.text_color], [true, 0, 300, 40, "surface", "border", 12.5, "muted"]);
  assert.equal(b.style.top, 48);
  assert.equal(all(a, n => n.kind === "text").length, 1, "one piece of text, one line");
  assert.equal(all(a, n => n.style.truncate === true).length, 1, "cut with an ellipsis, not wrapped");
});

test("pictureBlock: a picture with neither alt text nor an address is called Picture", () => {
  const el = block([{ ...ERROR_ITEM, alt: "", src: "", error: "No picture address" }], [{ x: 0, y: 0, w: 300, h: 40 }]);
  assert.equal(textOf(find(el, "pic-1-0")), "Picture: No picture address");
});

test("pictureBlock: a web address with no alt text is named by the last part of its path", () => {
  const el = block([{ ...ERROR_ITEM, alt: "", src: "https://img.shields.io/badge/a-b.svg?style=flat", error: "Timed out" }], [{ x: 0, y: 0, w: 300, h: 40 }]);
  assert.equal(textOf(find(el, "pic-1-0")), "a-b.svg?style=flat: Timed out");
});

test("pictureBlock: the picked picture has a 2 px accent ring a few px outside its box, over it; a loading or failed one too", () => {
  const items = [READY, PENDING_ITEM, ERROR_ITEM], boxes = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 108, y: 0, w: 300, h: 40 }, { x: 0, y: 58, w: 300, h: 40 }];
  assert.deepEqual(all(block(items, boxes), n => n.id?.endsWith("-picked")), [], "none picked");
  for (const i of [0, 1, 2]) {
    const el = block(items, boxes, { picked: i }), rings = all(el, n => n.id?.endsWith("-picked")), [ring] = rings, b = boxes[i];
    assert.deepEqual(rings.map(n => n.id), [`pic-1-${i}-picked`]);
    const out = b.x - ring.style.left;
    assert.ok(out >= 3 && out <= 6, `${out} px outside`);
    assert.deepEqual([ring.style.absolute, ring.style.top, ring.style.w, ring.style.h, ring.style.border, ring.style.border_color],
      [true, b.y - out, b.w + 2 * out, b.h + 2 * out, 2, "accent"]);
    const order = all(el, n => n.id !== null).map(n => n.id);
    assert.ok(order.indexOf(`pic-1-${i}-picked`) > order.indexOf(`pic-1-${i}`), "drawn over the picture");
  }
});

test("pictureBlock: a picture given a frame colour has a 2 px border of it on its box's edge, over the picture and taking no press; a loading or failed box's is rounded as the box is; the pick ring stays outside it", () => {
  const items = [READY, PENDING_ITEM, ERROR_ITEM, READY], boxes = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 108, y: 0, w: 300, h: 40 }, { x: 0, y: 58, w: 300, h: 40 }, { x: 0, y: 106, w: 60, h: 30 }];
  assert.deepEqual(all(block(items, boxes), n => n.id?.endsWith("-comment")), [], "no frames given");
  const el = block(items, boxes, { frames: ["#aa0000", "#bb0000", "#cc0000", null], picked: 0 });
  const frames = all(el, n => n.id?.endsWith("-comment"));
  assert.deepEqual(frames.map(n => n.id), ["pic-1-0-comment", "pic-1-1-comment", "pic-1-2-comment"]);
  frames.forEach((frame, i) => {
    const b = boxes[i];
    assert.deepEqual([frame.style.absolute, frame.style.left, frame.style.top, frame.style.w, frame.style.h, frame.style.border_2, frame.style.border_color],
      [true, b.x, b.y, b.w, b.h, true, ["#aa0000", "#bb0000", "#cc0000"][i]], `frame ${i}`);
    assert.deepEqual(Object.keys(frame.handlers ?? {}), [], "no handlers: a press goes to the page");
  });
  assert.deepEqual(frames.map(n => n.style.rounded), [undefined, 8, 8], "a picture's corners are square, a box's rounded 8");
  const order = all(el, n => n.id !== null).map(n => n.id);
  assert.ok(order.indexOf("pic-1-0-comment") > order.indexOf("pic-1-0") && order.indexOf("pic-1-0-picked") > order.indexOf("pic-1-0-comment"), "over the picture, the ring over both");
  assert.ok(find(el, "pic-1-0-picked").style.left < 0, "the ring outside the box, the frame inside it");
});

test("pictureBlock: ready, waiting and failed pictures mix, each in its own box", () => {
  const boxes = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 58, w: 300, h: 40 }, { x: 0, y: 106, w: 300, h: 40 }];
  const el = block([READY, PENDING_ITEM, ERROR_ITEM], boxes, { height: 146 });
  assert.deepEqual(all(el, n => n.id !== null).map(n => n.id), ["pic-1", "pic-1-0", "pic-1-1", "pic-1-2"]);
  assert.deepEqual(["pic-1-0", "pic-1-1", "pic-1-2"].map(id => find(el, id).style.top), [0, 58, 106]);
  assert.deepEqual(["pic-1-0", "pic-1-1", "pic-1-2"].map(id => textOf(find(el, id))), ["", "Loading picture…", "gone: Not found"]);
});
