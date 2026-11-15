import test from "node:test";
import assert from "node:assert/strict";
import { createHistory, mergeChange, trim, MAX_ENTRIES } from "../mods/herdr-inline-markdown/history.js";
import { parse, field, type, applySplice, diff } from "../mods/herdr-inline-markdown/blocks.js";

const run = (text, s) => applySplice(text, s);

// Types `chars` one by one at field offset `at` of block `index`, recording each splice; -> the text after.
function typeInto(h, text, index, at, chars, { time = 0, step = 50, key = `k${index}` } = {}) {
  const d = parse(text), f = field(d, d.blocks[index]);
  let t = text, value = f.value, pos = at;
  for (const c of chars) {
    value = value.slice(0, pos) + c + value.slice(pos);
    const s = type(f, value);
    h.record(t, s, { typing: true, key, time, caretBefore: s.start, caretAfter: s.caret });
    t = run(t, s);
    pos += c.length;
    time += step;
  }
  return t;
}

test("trim keeps only the changed part of a splice", () => {
  assert.deepEqual(trim("abcdef", { start: 0, end: 6, insert: "abXdef" }), { start: 2, end: 3, insert: "X" });
  assert.deepEqual(trim("abc", { start: 1, end: 1, insert: "" }), { start: 1, end: 1, insert: "" });
});

test("a typing run undoes in one step and stores only the typed characters", () => {
  const lines = [];
  for (let i = 0, n = 0; n < 40 * 1024; i++) n += lines[lines.push(`let v${i} = ${i};`) - 1].length + 1;
  const text = `\`\`\`js\n${lines.join("\n")}\n\`\`\`\n`, h = createHistory();
  const at = field(parse(text), parse(text).blocks[0]).value.length >> 1;
  const typed = "thirty characters typed here!!";
  const after = typeInto(h, text, 0, at, [...typed]);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].inserted, typed);
  assert.equal(h.entries[0].removed, "");
  assert.equal(h.size, 2 * typed.length, "the 40 KB block is not stored");
  const u = h.undo();
  assert.equal(run(after, u), text);
  assert.equal(u.caret, u.start, "the caret goes back to where the run began");
});

test("typing the character that follows the caret stays in the run", () => {
  const h = createHistory(), text = "see tt\n";
  const after = typeInto(h, text, 0, 4, ["t", "t", "x"]);
  assert.equal(after, "see ttxtt\n");
  assert.equal(h.entries.length, 1);
  assert.equal(run(after, h.undo()), text);
});

test("random typing and backspace runs, repeats and all, each undo in one step", () => {
  let seed = 7;
  const rnd = n => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let n = 0; n < 300; n++) {
    const text = ["aab abba\n", "tt tt\n", "x\n", "- [ ] aaaa bbbb\n", "> aa\n> aa\n"][n % 5];
    const d = parse(text), f = field(d, d.blocks[0]), h = createHistory();
    let t = text, value = f.value, pos = rnd(value.length + 1);
    const backspace = n % 2 === 1 && pos > 2;
    for (let k = 0, time = 0; k < (backspace ? Math.min(pos, 3) : 4); k++, time += 30) {
      value = backspace ? value.slice(0, pos - 1) + value.slice(pos) : value.slice(0, pos) + "ab "[rnd(3)] + value.slice(pos);
      const s = type(f, value, pos);
      pos += backspace ? -1 : 1;
      if (!s) continue;
      h.record(t, s, { typing: true, key: "k", time });
      t = run(t, s);
    }
    assert.ok(h.entries.length <= 1, `${JSON.stringify(text)}: ${JSON.stringify(h.entries)}`);
    if (h.entries.length) assert.equal(run(t, h.undo()), text);
  }
});

test("a splice that rewrites a whole block is stored as its trimmed change", () => {
  const h = createHistory(), text = "alpha beta gamma\n";
  h.record(text, { start: 0, end: 16, insert: "alpha BETA gamma" }, { typing: true, key: "k1" });
  assert.deepEqual(h.entries.map(e => [e.start, e.removed, e.inserted]), [[6, "beta", "BETA"]]);
});

test("backward deletes coalesce", () => {
  const h = createHistory(), text = "abcdef\n";
  let t = text, time = 0;
  for (let i = 0; i < 3; i++) {
    const s = { start: 5 - i, end: 6 - i, insert: "" };
    h.record(t, s, { typing: true, key: "k1", time: (time += 100) });
    t = run(t, s);
  }
  assert.equal(t, "abc\n");
  assert.deepEqual(h.entries.map(e => [e.start, e.removed]), [[3, "def"]]);
  assert.equal(run(t, h.undo()), text);
});

test("the shortcut space is its own entry: undo takes the space away and leaves #Title", () => {
  const h = createHistory(), text = "Title\n";
  let t = text;
  for (const [s, time] of [[{ start: 0, end: 0, insert: "#" }, 0], [{ start: 1, end: 1, insert: " " }, 120]]) {
    h.record(t, s, { typing: true, key: "k1", time });
    t = run(t, s);
  }
  assert.equal(h.entries.length, 1, "typed together, # and the space coalesce");
  h.isolateLast();
  assert.deepEqual(h.entries.map(e => e.inserted), ["#", " "]);
  t = run(t, h.undo());
  assert.equal(t, "#Title\n");
  assert.equal(run(t, h.undo()), text);
});

test("a typing group ends at a newline, a block switch, a pause, a jump or close()", () => {
  const ins = (h, t, at0, s, meta) => {
    h.record(t, { start: at0, end: at0, insert: s }, { typing: true, key: "k1", time: 0, ...meta });
    return run(t, { start: at0, end: at0, insert: s });
  };
  let h = createHistory(), t = ins(h, "", 0, "a");
  t = ins(h, t, 1, "\n", { time: 10 });
  ins(h, t, 2, "b", { time: 20 });
  assert.equal(h.entries.length, 3, "a newline");
  h = createHistory();
  t = ins(h, "", 0, "a");
  ins(h, t, 1, "b", { key: "k2", time: 10 });
  assert.equal(h.entries.length, 2, "another block");
  h = createHistory();
  t = ins(h, "", 0, "a");
  ins(h, t, 1, "b", { time: 1000 });
  assert.equal(h.entries.length, 2, "a pause of a second");
  h = createHistory();
  t = ins(h, "xyz", 0, "a");
  ins(h, t, 3, "b", { time: 10 });
  assert.equal(h.entries.length, 2, "not at the end of the run");
  h = createHistory();
  t = ins(h, "", 0, "a");
  h.close();
  ins(h, t, 1, "b", { time: 10 });
  assert.equal(h.entries.length, 2, "close()");
  h = createHistory();
  t = ins(h, "", 0, "a");
  h.record(t, { start: 1, end: 1, insert: "b" }, { key: "k1", time: 10 });
  assert.equal(h.entries.length, 2, "an edit that is not typing");
});

test("undo and redo walk the entries with their carets; a new edit clears redo", () => {
  const h = createHistory();
  let t = "one\n";
  h.record(t, { start: 3, end: 3, insert: " two" }, { caretBefore: 3, caretAfter: 7 });
  t = run(t, { start: 3, end: 3, insert: " two" });
  const u = h.undo();
  assert.deepEqual(u, { start: 3, end: 7, insert: "", caret: 3 });
  t = run(t, u);
  assert.equal(h.canRedo, true);
  const r = h.redo();
  assert.deepEqual(r, { start: 3, end: 3, insert: " two", caret: 7 });
  t = run(t, r);
  assert.equal(t, "one two\n");
  h.undo();
  h.record("one\n", { start: 0, end: 0, insert: "x" });
  assert.equal(h.redo(), null);
  assert.equal(createHistory().undo(), null);
});

test("limits: 200 entries or 2 MB of stored text, the oldest dropping first", () => {
  const h = createHistory();
  let t = "";
  for (let i = 0; i < MAX_ENTRIES + 20; i++) {
    h.record(t, { start: t.length, end: t.length, insert: `${i};` });
    t += `${i};`;
  }
  assert.equal(h.entries.length, MAX_ENTRIES);
  assert.equal(h.entries[0].inserted, "20;");
  const big = createHistory(), chunk = "x".repeat(300 * 1024);
  let b = "";
  for (let i = 0; i < 6; i++) {
    big.record(b, { start: b.length, end: b.length, insert: chunk });
    b += chunk;
  }
  assert.ok(big.size <= 2 * 1024 * 1024 && big.entries.length === 3, `${big.entries.length} entries, ${big.size} bytes`);
});

test("rebase keeps entries before and after an external splice and drops overlapping ones", () => {
  const h = createHistory();
  let t = "- [ ] one\n- [ ] two\n- [ ] three\n";
  const typing = (s, key) => {
    h.record(t, s, { key, caretBefore: s.start, caretAfter: s.start + s.insert.length });
    t = run(t, s);
  };
  typing({ start: t.indexOf("two") + 3, end: t.indexOf("two") + 3, insert: " more" }, "a");
  typing({ start: t.indexOf("three") + 5, end: t.indexOf("three") + 5, insert: "!" }, "b");
  const tickFirst = { start: 3, end: 4, insert: "x" };
  h.rebase(tickFirst);
  t = run(t, tickFirst);
  const longer = { start: 0, end: 0, insert: "# Plan\n\n" };
  h.rebase(longer);
  t = run(t, longer);
  assert.equal(h.entries.length, 2);
  t = run(t, h.undo());
  t = run(t, h.undo());
  assert.equal(t, "# Plan\n\n- [x] one\n- [ ] two\n- [ ] three\n", "the user's typing is undone, the agent's edits stay");
  const g = createHistory();
  let u = "abc def\n";
  g.record(u, { start: 3, end: 3, insert: "X" });
  u = run(u, { start: 3, end: 3, insert: "X" });
  g.record(u, { start: 8, end: 8, insert: "Y" });
  u = run(u, { start: 8, end: 8, insert: "Y" });
  g.undo();
  g.rebase({ start: 2, end: 5, insert: "" });
  assert.equal(g.entries.length, 0, "an entry the outside change overlaps goes, with every older one");
  assert.equal(g.canRedo, false, "redo is cleared");
});

// Records `entries` ([splice, caretBefore, caretAfter]) on `text`, then rebases on the outside splice E and applies it.
function rebased(text, entries, E) {
  const h = createHistory();
  let t = text;
  for (const [s, caretBefore, caretAfter] of entries) {
    h.record(t, s, { caretBefore, caretAfter });
    t = run(t, s);
  }
  h.rebase(E);
  return { h, t: run(t, E) };
}

test("rebase keeps an entry before the outside splice and one after it; undo takes back both and leaves the splice", () => {
  const { h, t } = rebased("- [ ] one\n- [ ] two\n- [ ] three\n", [[{ start: 9, end: 9, insert: " more" }, 9, 14], [{ start: 36, end: 36, insert: "!" }, 36, 37]], { start: 18, end: 19, insert: "x" });
  assert.deepEqual(h.entries.map(e => [e.start, e.inserted, e.caretBefore, e.caretAfter]), [[9, " more", 9, 14], [36, "!", 36, 37]]);
  const u1 = h.undo(), once = run(t, u1);
  assert.equal(once, "- [ ] one more\n- [x] two\n- [ ] three\n");
  const u2 = h.undo();
  assert.equal(run(once, u2), "- [ ] one\n- [x] two\n- [ ] three\n");
  assert.deepEqual([u1.caret, u2.caret], [36, 9]);
});

test("rebase: an outside splice after an entry leaves its offsets and moves a caret that lies past the splice", () => {
  const { h, t } = rebased("alpha\nbeta\ngamma\n", [[{ start: 6, end: 10, insert: "BETA!" }, 6, 17]], { start: 13, end: 13, insert: "zz" });
  assert.deepEqual(h.entries, [{ start: 6, removed: "beta", inserted: "BETA!", caretBefore: 6, caretAfter: 19 }]);
  const u = h.undo(), back = run(t, u);
  assert.equal(back, "alpha\nbeta\ngzzamma\n");
  assert.equal(u.caret, 6);
  const r = h.redo();
  assert.equal(run(back, r), "alpha\nBETA!\ngzzamma\n");
  assert.equal(r.caret, 19, "the caret at the end of gamma is still at its end");
});

test("rebase: an outside insert right at an entry's inserted end stays after the typing, and a caret there goes past it", () => {
  const { h, t } = rebased("ab\n", [[{ start: 1, end: 1, insert: "XY" }, 1, 3]], { start: 3, end: 3, insert: "!" });
  assert.deepEqual(h.entries, [{ start: 1, removed: "", inserted: "XY", caretBefore: 2, caretAfter: 4 }]);
  const u = h.undo(), back = run(t, u);
  assert.equal(back, "a!b\n");
  assert.equal(u.caret, 2);
  assert.equal(run(back, h.redo()), "aXY!b\n");
});

test("rebase: an outside insert where a deletion was keeps the deleted text before it on undo", () => {
  const { h, t } = rebased("abcdef\n", [[{ start: 2, end: 4, insert: "" }, 4, 2]], { start: 2, end: 2, insert: "ZZ" });
  assert.deepEqual(h.entries, [{ start: 2, removed: "cd", inserted: "", caretBefore: 6, caretAfter: 4 }]);
  const u = h.undo(), back = run(t, u);
  assert.equal(back, "abcdZZef\n");
  assert.equal(u.caret, 6);
  const r = h.redo();
  assert.equal(run(back, r), "abZZef\n");
  assert.equal(r.caret, 4);
});

test("rebase moves an entry's carets with its offsets", () => {
  const h = createHistory();
  h.record("ab\n", { start: 2, end: 2, insert: "c" }, { caretBefore: 2, caretAfter: 3 });
  h.rebase({ start: 0, end: 0, insert: "zz" });
  assert.deepEqual(h.entries[0], { start: 4, removed: "", inserted: "c", caretBefore: 4, caretAfter: 5 });
  assert.equal(run("zzabc\n", h.undo()), "zzab\n");
});

// "Hello world." made bold as one entry, the word selected before and after it.
function bolded() {
  const h = createHistory(), before = "Hello world.\n", s = { start: 6, end: 11, insert: "**world**" };
  h.record(before, s, { caretBefore: 11, caretAfter: 15 });
  return { h, t: run(before, s) };
}

test("the newest entry given selections puts back the one before it on undo and the one after it on redo", () => {
  const { h, t } = bolded();
  h.select(t, { start: 6, end: 11 }, { start: 8, end: 13 });
  const u = h.undo();
  assert.deepEqual(u, { start: 6, end: 15, insert: "world", caret: 11, select: { start: 6, end: 11 } });
  assert.deepEqual(h.redo(), { start: 6, end: 11, insert: "**world**", caret: 15, select: { start: 8, end: 13 } });
  const plain = createHistory();
  plain.record("ab\n", { start: 2, end: 2, insert: "c" }, { caretBefore: 2, caretAfter: 3 });
  assert.deepEqual(plain.undo(), { start: 2, end: 3, insert: "", caret: 2 }, "an entry without them gives its caret only");
});

test("select on a text the newest entry did not leave changes nothing", () => {
  const { h } = bolded();
  h.select("Hello world.\n", { start: 6, end: 11 }, { start: 8, end: 13 });
  assert.equal("select" in h.undo(), false);
});

test("rebase moves an entry's selections with its carets", () => {
  const { h } = bolded();
  h.select("Hello **world**.\n", { start: 6, end: 11 }, { start: 8, end: 13 });
  h.rebase({ start: 0, end: 0, insert: "zz" });
  assert.deepEqual(h.undo().select, { start: 8, end: 13 });
  assert.deepEqual(h.redo().select, { start: 10, end: 15 });
  const after = bolded();
  after.h.select("Hello **world**.\n", { start: 6, end: 11 }, { start: 8, end: 13 });
  after.h.rebase({ start: 16, end: 16, insert: "!" });
  assert.deepEqual(after.h.undo().select, { start: 6, end: 11 }, "a splice after the entry leaves them");
});

test("joinLast folds the newest entry into the one before it: one undo takes back both, with the caret from before the first", () => {
  const h = createHistory(), base = "a\nb\nc\n";
  let t = base;
  for (const [s, caretBefore, caretAfter] of [[{ start: 3, end: 3, insert: "**" }, 3, 5], [{ start: 2, end: 2, insert: "**" }, 2, 4]]) {
    h.record(t, s, { caretBefore, caretAfter });
    t = run(t, s);
  }
  h.joinLast(t);
  assert.deepEqual(h.entries, [{ start: 2, removed: "b", inserted: "**b**", caretBefore: 3, caretAfter: 4 }]);
  const u = h.undo();
  assert.deepEqual([run(t, u), u.caret], [base, 3]);
  const r = h.redo();
  assert.deepEqual([run(base, r), r.caret], [t, 4]);
  const one = createHistory();
  one.record(base, { start: 0, end: 0, insert: "x" });
  one.joinLast(`x${base}`);
  assert.equal(one.entries.length, 1, "a lone entry stays");
  const other = createHistory();
  other.record(base, { start: 0, end: 0, insert: "x" });
  other.record(`x${base}`, { start: 1, end: 1, insert: "y" });
  other.joinLast(base);
  assert.equal(other.entries.length, 2, "on a text the newest entry did not leave, nothing changes");
});

test("amend keeps the selection an undo puts back and drops the one a redo would, which the fix-up changed", () => {
  const { h, t } = bolded();
  h.select(t, { start: 6, end: 11 }, { start: 8, end: 13 });
  h.amend(t, { start: 15, end: 16, insert: "!" });
  const u = h.undo();
  assert.deepEqual(u.select, { start: 6, end: 11 });
  assert.equal("select" in h.redo(), false);
});

test("clear empties both stacks", () => {
  const h = createHistory();
  h.record("", { start: 0, end: 0, insert: "a" });
  h.record("a", { start: 1, end: 1, insert: "b" });
  h.undo();
  assert.deepEqual([h.canUndo, h.canRedo], [true, true]);
  h.clear();
  assert.deepEqual([h.canUndo, h.canRedo], [false, false]);
  assert.equal(h.redo(), null);
  assert.equal(h.size, 0);
});

test("undo and redo check that the text still holds what the entry left; on other text they clear the history and give nothing", () => {
  const h = createHistory();
  h.record("one\n", { start: 3, end: 3, insert: " two" });
  assert.equal(h.undo("one three\n"), null, "the text there is not ' two'");
  assert.deepEqual([h.canUndo, h.canRedo], [false, false]);
  h.record("ab\n", { start: 1, end: 2, insert: "" });
  assert.deepEqual(h.undo("a\n"), { start: 1, end: 1, insert: "b", caret: 1 });
  assert.equal(h.redo("ax\n"), null, "redo finds other text where it would take 'b' out");
  assert.deepEqual([h.canUndo, h.canRedo], [false, false]);
  h.record("one\n", { start: 3, end: 3, insert: " two" });
  h.undo("one two\n");
  assert.equal(h.redo("on"), null, "an insert past the end of the text");
  h.record("ab\n", { start: 1, end: 2, insert: "" });
  h.undo("a\n");
  assert.deepEqual(h.redo("ab\n"), { start: 1, end: 2, insert: "", caret: 1 });
});

test("amend folds a fix-up into the newest entry: one undo takes back the typing and the fence it closed", () => {
  const h = createHistory();
  let t = "Run it\n\nNext\n";
  h.record(t, { start: 0, end: 0, insert: "```" }, { typing: true, key: "a", caretBefore: 0, caretAfter: 3 });
  t = run(t, { start: 0, end: 0, insert: "```" });
  const fence = { start: 10, end: 10, insert: "```\n", caret: 10 };
  h.amend(t, fence);
  t = run(t, fence);
  assert.equal(t, "```Run it\n```\n\nNext\n");
  assert.equal(h.entries.length, 1);
  const u = h.undo(t);
  assert.equal(run(t, u), "Run it\n\nNext\n");
  assert.equal(u.caret, 0);
  assert.equal(run(run(t, u), h.redo(run(t, u))), t);
});

test("amend on a text the newest entry did not leave records the fix-up as an entry of its own", () => {
  const h = createHistory();
  h.record("abc\n", { start: 3, end: 3, insert: "d" });
  h.amend("xyz\n", { start: 0, end: 1, insert: "X" });
  assert.deepEqual(h.entries.map(e => [e.start, e.removed, e.inserted]), [[3, "", "d"], [0, "x", "X"]]);
});

test("a fix-up that takes back the whole edit leaves no entry", () => {
  const h = createHistory();
  h.record("ab\n", { start: 0, end: 0, insert: "x" });
  h.record("xab\n", { start: 3, end: 3, insert: "!" });
  assert.equal(h.amend("xab!\n", { start: 3, end: 4, insert: "" }), null);
  assert.deepEqual([h.entries.map(e => e.inserted), h.size], [["x"], 2]);
});

test("a shortcut's rewrite amends its space: one undo gives back '[]Fix', the next takes away '[]'", () => {
  const h = createHistory();
  let t = "Fix\n";
  for (const [at, c] of [[0, "["], [1, "]"], [2, " "]]) {
    h.record(t, { start: at, end: at, insert: c }, { typing: true, key: "a", time: at * 10, caretBefore: at, caretAfter: at + 1 });
    t = run(t, { start: at, end: at, insert: c });
  }
  h.isolateLast();
  const rewrite = { start: 0, end: 3, insert: "- [ ] ", caret: 6 };
  h.amend(t, rewrite);
  t = run(t, rewrite);
  assert.equal(t, "- [ ] Fix\n");
  t = run(t, h.undo(t));
  assert.equal(t, "[]Fix\n");
  t = run(t, h.undo(t));
  assert.equal(t, "Fix\n");
});

test("isolateLast splits only the open group: after an undo, a redo or a rebase it leaves the entries as they are", () => {
  const h = createHistory();
  let t = "";
  for (const [at, c] of [[0, "a"], [1, "b"]]) {
    h.record(t, { start: at, end: at, insert: c }, { typing: true, key: "k", time: at });
    t = run(t, { start: at, end: at, insert: c });
  }
  h.undo(t);
  h.redo("");
  h.isolateLast();
  assert.deepEqual(h.entries.map(e => e.inserted), ["ab"]);
});

test("a new block written with its first letter takes the letters typed after it into the same entry, at its join", () => {
  const h = createHistory();
  let t = "Intro\n";
  const write = { start: 6, end: 6, insert: "\nH\n" };
  h.record(t, write, { typing: true, key: 7, time: 0, caretBefore: 6, caretAfter: 8, join: 8 });
  t = run(t, write);
  for (const [i, c] of [..."ello"].entries()) {
    h.record(t, { start: 8 + i, end: 8 + i, insert: c }, { typing: true, key: 7, time: 10 * (i + 1), caretBefore: 8 + i, caretAfter: 9 + i });
    t = run(t, { start: 8 + i, end: 8 + i, insert: c });
  }
  assert.equal(t, "Intro\n\nHello\n");
  assert.deepEqual(h.entries.map(e => e.inserted), ["\nHello\n"]);
  const u = h.undo(t);
  assert.equal(run(t, u), "Intro\n");
  assert.equal(u.caret, 6);
  h.redo("Intro\n");
  h.record(t, { start: 13, end: 13, insert: "!" }, { typing: true, key: 7, time: 60 });
  assert.equal(h.entries.length, 2, "typing that does not continue at the join starts an entry");
  h.record(run(t, { start: 13, end: 13, insert: "!" }), { start: 7, end: 7, insert: "\n" }, { typing: true, key: 7, time: 70 });
  assert.equal(h.entries.length, 3, "a typed newline is never joined");
});

test("mergeChange: their change before or after mine, apart from it, comes back as a splice of mine that keeps both", () => {
  const base = "# Plan\n\n- [ ] one\n- [ ] two\n\nNotes here.\n";
  const mine = base.replace("Notes here.", "Notes here, and more.");
  const before = base.replace("- [ ] one", "- [x] one"), E = mergeChange(base, mine, before);
  assert.deepEqual(E, { start: 11, end: 12, insert: "x" });
  assert.equal(run(mine, E), "# Plan\n\n- [x] one\n- [ ] two\n\nNotes here, and more.\n");
  const mine2 = base.replace("# Plan", "# The plan"), after = base.replace("Notes here.", "Notes here.\n\nAgent line.");
  const E2 = mergeChange(base, mine2, after);
  assert.equal(run(mine2, E2), "# The plan\n\n- [ ] one\n- [ ] two\n\nNotes here.\n\nAgent line.\n");
  assert.equal(E2.start, base.length + "The ".length, "their insert at the end of the base, moved by my change's length");
});

test("mergeChange: changes that overlap or touch are not merged", () => {
  const base = "alpha beta gamma\n";
  assert.equal(mergeChange(base, "alpha BETA gamma\n", "alpha beta! gamma\n"), null, "the same word");
  assert.equal(mergeChange(base, "alpha beta gamma!\n", "alpha beta gamma?\n"), null, "inserts at the same place");
  assert.equal(mergeChange(base, "alphabeta gamma\n", "alpha  beta gamma\n"), null, "one ends where the other begins");
  assert.equal(mergeChange(base, "Xalpha beta gammaX\n", "alpha bet gamma\n"), null, "mine spans theirs");
  assert.equal(mergeChange(base, "theirs\n", "theirs!\n"), null, "a rewrite of everything");
  assert.deepEqual(mergeChange(base, "alpha beta gamma!\n", "Alpha beta gamma\n"), { start: 0, end: 1, insert: "A" });
});

test("mergeChange: with no change of mine, theirs is taken whole, an append at the end of the text included", () => {
  const base = "alpha\nbeta\n";
  for (const theirs of ["alpha\nbeta\ngamma\n", "ALPHA\nbeta\n", "", base]) assert.equal(run(base, mergeChange(base, base, theirs)), theirs, JSON.stringify(theirs));
  assert.deepEqual(mergeChange(base, base, "alpha\nbeta\ngamma\n"), { start: 11, end: 11, insert: "gamma\n" });
});

const lcg = seed => n => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
// Random edits of `base` at [a0, a1) and [b0, b1).
function edits(rnd, base) {
  const a0 = rnd(base.length), a1 = a0 + rnd(Math.min(5, base.length - a0) + 1);
  const b0 = rnd(base.length), b1 = b0 + rnd(Math.min(5, base.length - b0) + 1);
  const insA = ["", "X", "XY\n"][rnd(3)], insB = ["", "Z", "Q\nQ"][rnd(3)];
  return { a0, a1, b0, b1, insA, insB, mine: base.slice(0, a0) + insA + base.slice(a1), theirs: base.slice(0, b0) + insB + base.slice(b1) };
}

test("mergeChange on random edits of text whose characters all differ: edits apart merge into exactly both, edits that overlap or touch never merge", () => {
  const rnd = lcg(11);
  let merged = 0;
  for (let n = 0; n < 2000; n++) {
    const base = Array.from({ length: 4 + rnd(40) }, (_, i) => String.fromCharCode(0x100 + i)).join("");
    const { a0, a1, b0, b1, insA, insB, mine, theirs } = edits(rnd, base);
    if (mine === base || theirs === base) continue;
    const E = mergeChange(base, mine, theirs), why = JSON.stringify({ a0, a1, b0, b1, insA, insB });
    if (!(a1 < b0 || b1 < a0)) { assert.equal(E, null, why); continue; }
    merged++;
    const both = a1 < b0 ? base.slice(0, a0) + insA + base.slice(a1, b0) + insB + base.slice(b1) : base.slice(0, b0) + insB + base.slice(b1, a0) + insA + base.slice(a1);
    assert.ok(E, why);
    assert.equal(run(mine, E), both, why);
  }
  assert.ok(merged > 500, `${merged} merged`);
});

test("mergeChange on random edits of repetitive text: whatever it merges takes out to mine without theirs and to theirs without mine", () => {
  const rnd = lcg(5);
  for (let n = 0; n < 3000; n++) {
    const base = Array.from({ length: 4 + rnd(30) }, () => "ab \n"[rnd(4)]).join("");
    const { mine, theirs } = edits(rnd, base);
    if (mine === base || theirs === base) continue;
    const E = mergeChange(base, mine, theirs);
    if (!E) continue;
    const out = run(mine, E), t = diff(base, theirs), o = diff(base, mine);
    assert.equal(out.length, mine.length + theirs.length - base.length);
    assert.equal(run(out, { start: E.start, end: E.start + t.inserted.length, insert: base.slice(t.at, t.at + t.removed) }), mine);
    const at = o.at < E.start ? o.at : o.at + t.inserted.length - t.removed;
    assert.equal(run(out, { start: at, end: at + o.inserted.length, insert: base.slice(o.at, o.at + o.removed) }), theirs);
  }
});
