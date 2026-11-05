import test from "node:test";
import assert from "node:assert/strict";
import { makeCx } from "./helpers.mjs";

// The fake cx answers to both names a test may use for the clipboard (`clipboardText`, `held`) and for a waiting
// timer (`once`, `after`).

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
