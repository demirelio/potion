import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { chord, mergeKeys } = await import("../tools/merge-keys.mjs");

const OURS_FILE = fileURLToPath(new URL("../keys.json", import.meta.url));
const OURS = JSON.parse(readFileSync(OURS_FILE, "utf8"));
const M = "mod.open:potion", BESIDE = "mod.open:potion-beside";

// A keys.json as Herdr writes it: two spaces, one key a line, escapes kept as \u escapes.
const HERDR = `{
  "global": {
    "cmd-q": "app.quit",
    "cmd-p": "mod.open:picker"
  },
  "terminal": {
    "alt-left": "send:\\u001bb"
  }
}
`;
const outcomes = result => result.notes.map(n => [n.key, n.outcome]);

test("chord: one key however its modifiers are ordered or cased; '-' can be the key itself", () => {
  assert.equal(chord("shift-cmd-m"), chord("cmd-shift-m"));
  assert.equal(chord("Cmd-SHIFT-m"), chord("cmd-shift-m"));
  assert.equal(chord(" cmd-m "), chord("cmd-m"));
  assert.notEqual(chord("cmd-m"), chord("cmd-shift-m"));
  assert.notEqual(chord("cmd--"), chord("cmd-="));
  assert.equal(chord("shift-cmd--"), chord("cmd-shift--"));
  assert.equal(chord("ctrl-a shift-alt-b"), chord("ctrl-a alt-shift-b"), "a sequence, stroke by stroke");
});

test("a key that already has the action is left as it is; with both there, the text is the same string", () => {
  const theirs = mergeKeys(HERDR, OURS).text, again = mergeKeys(theirs, OURS);
  assert.equal(again.text, theirs);
  assert.deepEqual(outcomes(again), [["cmd-m", "same"], ["cmd-shift-m", "same"]]);
  assert.equal(again.bound, true);
  assert.equal(mergeKeys(theirs, OURS, { replace: true }).text, theirs, "nothing to replace either");
});

test("the same key spelled another way is that key: kept, or replaced under the person's spelling, never added twice", () => {
  const theirs = `{ "global": { "shift-cmd-m": "x.y", "cmd-m": "${M}" } }`;
  const kept = mergeKeys(theirs, OURS);
  assert.equal(kept.text, theirs);
  assert.deepEqual(kept.notes.map(n => [n.key, n.outcome, n.as]), [["cmd-m", "same", "cmd-m"], ["cmd-shift-m", "kept", "shift-cmd-m"]]);
  assert.equal(kept.bound, false);
  assert.equal(mergeKeys(theirs, OURS, { replace: true }).text, `{ "global": { "shift-cmd-m": "${BESIDE}", "cmd-m": "${M}" } }`);
});

test("a section the file lacks is added at the end, an empty section or file object is filled, indented like the others", () => {
  const theirs = `{\n  "terminal": {\n    "cmd-c": "terminal.copy"\n  }\n}\n`;
  assert.equal(mergeKeys(theirs, OURS).text,
    `{\n  "terminal": {\n    "cmd-c": "terminal.copy"\n  },\n  "global": {\n    "cmd-m": "${M}",\n    "cmd-shift-m": "${BESIDE}"\n  }\n}\n`);
  assert.equal(mergeKeys(`{\n  "global": {}\n}\n`, OURS).text, `{\n  "global": {\n    "cmd-m": "${M}",\n    "cmd-shift-m": "${BESIDE}"\n  }\n}\n`);
  assert.equal(mergeKeys("{}\n", OURS).text, `{\n  "global": {\n    "cmd-m": "${M}",\n    "cmd-shift-m": "${BESIDE}"\n  }\n}\n`);
});

test("a file written on one line stays on one line", () => {
  assert.equal(mergeKeys(`{ "global": { "cmd-q": "app.quit" } }`, OURS).text,
    `{ "global": { "cmd-q": "app.quit", "cmd-m": "${M}", "cmd-shift-m": "${BESIDE}" } }`);
  assert.equal(mergeKeys(`{ "terminal": {} }`, OURS).text.replace(/\s+/g, " "),
    `{ "terminal": {}, "global": { "cmd-m": "${M}", "cmd-shift-m": "${BESIDE}" } }`);
});

test("the person's order, spacing, escapes, line endings and other values stay byte for byte, even keys JSON.parse would reorder", () => {
  const theirs = '{\r\n\t"mod:x": {"2": "x.two", "1": "x.one"},\r\n\t"global": {\r\n\t\t"f2": "tab.rename" ,\r\n\t\t"alt-\\"": "send:\\"\\\\"\r\n\t}\r\n}';
  const merged = mergeKeys(theirs, OURS).text;
  assert.equal(merged, theirs.replace('"send:\\"\\\\"', `"send:\\"\\\\",\r\n\t\t"cmd-m": "${M}",\r\n\t\t"cmd-shift-m": "${BESIDE}"`));
  assert.ok(merged.startsWith('{\r\n\t"mod:x": {"2": "x.two", "1": "x.one"}'));
});

test("a key written twice counts as its last value, as JSON.parse reads it", () => {
  const theirs = `{ "global": { "cmd-m": "${M}", "cmd-m": "other.thing" } }`;
  assert.deepEqual(outcomes(mergeKeys(theirs, OURS)), [["cmd-m", "kept"], ["cmd-shift-m", "added"]]);
  assert.equal(JSON.parse(mergeKeys(theirs, OURS, { replace: true }).text).global["cmd-m"], M);
});

test("a file that is not JSON, not an object, or has a section that is not an object is refused with the reason", () => {
  assert.throws(() => mergeKeys(`{ "global": { "cmd-q": "app.quit", } }`, OURS), /not valid JSON/);
  assert.throws(() => mergeKeys(`[]`, OURS), /not an object/);
  assert.throws(() => mergeKeys(`{ "global": ["cmd-q"] }`, OURS), /"global" is not an object/);
  assert.throws(() => mergeKeys(`{ "global": null }`, OURS), /"global" is not an object/);
});
