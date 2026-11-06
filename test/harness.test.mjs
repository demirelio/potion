import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { state, calls, reset, readTextFile, writeTextFile } from "./mocks/herdr.mjs";
import { files } from "./mocks/fs.mjs";
import { TextareaState, InputState, TextView, Textarea } from "./mocks/gpui-base.mjs";
import { div } from "./mocks/gpui-kit.mjs";
import { find, textOf, fire } from "./mocks/element.mjs";
import { makeCx, fire_timers } from "./helpers.mjs";

beforeEach(() => reset());

test("fire_timers runs the timers that wait, once, and what they start", async () => {
  const cx = makeCx(), ran = [];
  cx.timer.after(250, cx => { ran.push("a"); cx.spawn(async () => { ran.push("spawned"); }); });
  cx.timer.after(700, () => ran.push("b"));
  cx.timer.every(1000, () => ran.push("every"));
  await fire_timers(cx);
  assert.deepEqual(ran, ["a", "spawned", "b"], "every() is left for the test to call");
  await fire_timers(cx);
  assert.deepEqual(ran, ["a", "spawned", "b"], "a timer that ran does not run again");
});

test("fire_timers can pick a delay, and skips cancelled timers", async () => {
  const cx = makeCx(), ran = [];
  cx.timer.after(250, () => ran.push("preview"));
  const save = cx.timer.after(700, () => ran.push("save"));
  const gone = cx.timer.after(700, () => ran.push("gone"));
  assert.equal(save.is_done(), false);
  gone.cancel();
  assert.equal(gone.is_done(), true);
  await fire_timers(cx, { ms: 700 });
  assert.deepEqual(ran, ["save"]);
  assert.equal(save.is_done(), true);
  await fire_timers(cx);
  assert.deepEqual(ran, ["save", "preview"]);
});

test("a timer set while timers fire waits for the next call", async () => {
  const cx = makeCx(), ran = [];
  cx.timer.after(10, cx => { ran.push("first"); cx.timer.after(10, () => ran.push("second")); });
  await fire_timers(cx);
  assert.deepEqual(ran, ["first"]);
  await fire_timers(cx);
  assert.deepEqual(ran, ["first", "second"]);
});

test("a timer set with `after` is recorded under both names a test may look for", () => {
  const cx = makeCx(), fn = () => {};
  cx.timer.after(250, fn);
  cx.timer.every(1000, fn);
  assert.deepEqual(cx.timers[0], { ms: 250, fn, once: true, after: true });
  assert.deepEqual(cx.timers[1], { ms: 1000, fn }, "`every` is marked neither once nor after");
});

test("the clipboard reads clipboardText, else the last write, else held", () => {
  const cx = makeCx();
  assert.equal(cx.read_from_clipboard(), undefined, "empty");
  cx.held = "held";
  assert.equal(cx.read_from_clipboard(), "held", "held when nothing was written");
  cx.write_to_clipboard("copied");
  assert.equal(cx.clipboardText, "copied", "a write sets clipboardText");
  assert.equal(cx.read_from_clipboard(), "copied");
  cx.clipboardText = "typed in by the test";
  assert.equal(cx.read_from_clipboard(), "typed in by the test", "clipboardText set by a test beats the earlier write");
  assert.deepEqual(cx.clipboard, ["copied"], "the log of writes is not touched by that");
});

test("clipboardText set before any write is what a read returns, even with held set", () => {
  const cx = makeCx();
  cx.held = "held";
  cx.clipboardText = "pasted";
  assert.equal(cx.read_from_clipboard(), "pasted");
  cx.clipboardText = "";
  assert.equal(cx.read_from_clipboard(), "", "an empty string is a clipboard that holds nothing, not an unset one");
});

test("state.disk: readTextFile gives its text or null", async () => {
  assert.equal(await readTextFile("/a.md"), null);
  state.disk.set("/a.md", "hello");
  state.disk.set("/empty.md", "");
  assert.equal(await readTextFile("/a.md", { on: "devbox" }), "hello");
  assert.equal(await readTextFile("/empty.md"), "", "an empty file is not a missing one");
  assert.deepEqual(calls.readTextFile, [{ path: "/a.md", options: undefined }, { path: "/a.md", options: { on: "devbox" } }, { path: "/empty.md", options: undefined }]);
  state.readTextFile = async () => "scripted";
  assert.equal(await readTextFile("/a.md"), "scripted");
});

test("state.disk: writeTextFile stores when `expected` is what is there, else rejects as stale", async () => {
  assert.equal(await writeTextFile("/new.md", "one", null), null, "null expects the file not to exist");
  assert.equal(state.disk.get("/new.md"), "one");
  await assert.rejects(writeTextFile("/new.md", "two", null), /stale/);
  await assert.rejects(writeTextFile("/new.md", "two", "other"), /stale/);
  await assert.rejects(writeTextFile("/missing.md", "x", ""), /stale/, "an empty text is not 'does not exist'");
  assert.equal(state.disk.get("/new.md"), "one", "a stale write changes nothing");
  assert.equal(await writeTextFile("/new.md", "two", "one"), null);
  assert.equal(await readTextFile("/new.md"), "two");
  assert.equal(await writeTextFile("/new.md", "", "two"), null);
  assert.equal(await readTextFile("/new.md"), "");
  assert.deepEqual(calls.writeTextFile.map(c => [c.path, c.text, c.expected]), [
    ["/new.md", "one", null], ["/new.md", "two", null], ["/new.md", "two", "other"], ["/missing.md", "x", ""], ["/new.md", "two", "one"], ["/new.md", "", "two"],
  ]);
});

test("state.writeTextFile can be scripted, and reset() clears the disk", async () => {
  state.disk.set("/a.md", "x");
  state.writeTextFile = async () => { throw new Error("boom"); };
  await assert.rejects(writeTextFile("/a.md", "y", "x"), /boom/);
  reset();
  assert.equal(state.disk.size, 0);
  assert.equal(calls.writeTextFile.length, 0);
  assert.equal(await writeTextFile("/a.md", "y", null), null, "the default store is back");
});

test("the in-memory fs of fs/promises is shared with the mocks and emptied by reset()", async () => {
  const fs = await import("./mocks/fs.mjs");
  await fs.writeFile("/d/x.mmd", "graph");
  assert.equal(await fs.readFile("/d/x.mmd", "utf8"), "graph");
  assert.ok(files.has("/d/x.mmd"));
  reset();
  assert.equal(files.size, 0);
});

test("TextareaState and InputState hold text, record handlers and are typed into with edit() and submit()", async () => {
  const cx = makeCx(), seen = [];
  const area = TextareaState.new({ value: "start", placeholder: "p" });
  area.on("change", (_e, c) => seen.push(["change", area.value(), c === cx]));
  area.on("submit", () => seen.push(["submit", area.value()]));
  assert.equal(area.value(), "start");
  area.edit("typed", cx);
  area.submit(cx);
  assert.deepEqual(seen, [["change", "typed", true], ["submit", "typed"]]);
  area.set_value("by the mod");
  assert.equal(area.value(), "by the mod");
  assert.equal(seen.length, 2, "set_value does not fire change");
  area.replace("replaced");
  assert.equal(area.value(), "replaced");
  assert.equal(area.focused, false);
  area.focus();
  assert.equal(area.focused, true);
  area.set_soft_wrap(true);
  area.set_rows(4);
  assert.equal(area.options.rows, 4);
  const input = InputState.new({ placeholder: "Find" });
  assert.equal(input.value(), "");
  assert.equal(input.edit("x", cx), undefined, "no handler: nothing happens");
  assert.equal(input.value(), "x");
  assert.ok(Textarea.new(area).__node.state === area);
});

test("a TextView mock is an element with the id and the text it was given; only it has selectable and on_link_click", () => {
  const view = TextView.markdown("md-block-0", "# Hello").selectable(true).on_link_click(() => {});
  const node = view.__node;
  assert.equal(node.id, "md-block-0");
  assert.equal(node.markdown, "# Hello");
  assert.equal(node.style.selectable, true);
  assert.equal(typeof node.handlers.on_link_click, "function");
  assert.equal(TextView.html("h", "<b>x</b>").__node.html, "<b>x</b>");
  assert.equal(TextView.markdown("s", "x").scrollable().__node.style.scrollable, true);
  const page = div().child(view);
  assert.equal(find(page, "md-block-0").markdown, "# Hello");
  const seen = [];
  node.handlers.on_link_click = url => seen.push(url);
  fire(view, "on_link_click", "https://example.com");
  assert.deepEqual(seen, ["https://example.com"]);
  assert.throws(() => div().selectable(true), /not a builder method/);
  assert.throws(() => div().on_link_click(() => {}), /not a builder method/);
  assert.equal(textOf(div().child("a").child("b")), "a b");
});

test("builders gpui-kit does not declare are refused", () => {
  assert.throws(() => div().line_clamp(2), /not a builder method/);
  assert.throws(() => div().select_none(), /not a builder method/);
});
