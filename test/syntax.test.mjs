import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCx } from "./helpers.mjs";

const { BINDINGS, INSTALLED, LANG, NOTE, RAW, SOURCE, TEXT, installKeys } = await import("../mods/herdr-inline-markdown/keys.js");

const root = fileURLToPath(new URL("..", import.meta.url));

const MAIN = "herdr-inline-markdown", BESIDE = "herdr-inline-markdown-beside";
const jsIn = mod => readdirSync(join(root, "mods", mod)).filter(f => f.endsWith(".js"));
const modFiles = jsIn(MAIN);
const code = (name, mod = MAIN) => readFileSync(join(root, "mods", mod, name), "utf8");
// Every module Herdr loads, from both mods: the main mod's by file name, the companion's with its folder.
const modules = [...modFiles.map(file => ({ mod: MAIN, file, label: file })), ...jsIn(BESIDE).map(file => ({ mod: BESIDE, file, label: `${BESIDE}/${file}` }))];

// No test imports the renderer (it runs as its installed copy), so a syntax error in it would not fail the suite.
test("node --check tools/mermaid/render.mjs", () => {
  const r = spawnSync(process.execPath, ["--check", join(root, "tools/mermaid/render.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

// The mod guide's rules that a test can see in the source. The mod reads and watches the folder of the file it shows,
// so watchFolder is allowed.
for (const { mod, file, label } of modules) {
  test(`${label} follows the guide: no timers but cx.timer, no top-level await, no kept cx`, () => {
    const source = code(file, mod).replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /\bsetTimeout\b|\bsetInterval\b/, "use cx.timer");
    assert.doesNotMatch(source, /^await\b/m, "no top-level await");
    // The exceptions outlive a module on purpose: the key table's flag and when it was last put back, and the companion's
    // memory of its picker.
    const allowed = file === "keys.js" ? /\bglobalThis\[(?:INSTALLED|REBOUND)\]/g : mod === "herdr-inline-markdown-beside" ? /\bglobalThis\[MEMORY\]/g : null;
    const own = allowed ? source.replace(allowed, "") : source;
    assert.doesNotMatch(own, /this\.\w*cx\b|\bglobalThis\b/, "a cx is never kept, nothing hangs on globalThis");
  });
}

// Key bindings cannot be removed and a reload runs the module again: only a flag on globalThis tells that the table is in.
test("installKeys binds the table once per run, under a flag that carries the version of the contexts", () => {
  assert.equal(INSTALLED in globalThis, false, "importing keys.js installs nothing");
  const cx = makeCx(), version = name => /\d+$/.exec(name)?.[0];
  try {
    assert.equal(installKeys(cx), true);
    assert.deepEqual(cx.bound, [BINDINGS]);
    assert.equal(installKeys(cx), false, "a reload does not add the table again");
    assert.equal(cx.bound.length, 1);
  } finally { delete globalThis[INSTALLED]; }
  assert.ok(version(TEXT), "the contexts end in a version");
  for (const name of [RAW, SOURCE, INSTALLED]) assert.equal(version(name), version(TEXT), name);
  for (const name of [NOTE, LANG]) assert.equal(version(name), version(TEXT), name);
  for (const { context } of BINDINGS) assert.equal(/^Md(?:Text|Raw|Source|Note|Lang)(\d+)/.exec(context)?.[1], version(TEXT), context);
});

test("herdr-inline-markdown names its key contexts only through keys.js, so raising VERSION renames every one", () => {
  for (const file of modFiles.filter(f => f !== "keys.js")) {
    assert.doesNotMatch(code(file).replace(/\/\/.*$/gm, ""), /\bMd(?:Text|Raw|Source|Note|Lang)\d/, file);
  }
});

test("lib.js imports only blocks.js, which imports nothing, so node can load both as they are", () => {
  const imports = code("lib.js").match(/^\s*import\b.*$/gm) ?? [];
  assert.ok(imports.every(l => /\bfrom "\.\/blocks\.js";$/.test(l.trim())), imports.join("\n"));
  assert.doesNotMatch(code("blocks.js"), /^\s*import\b/m);
});

// Lines at column 0 that are not a declaration, an export, an import or the end of a block.
const topLevelCalls = source => source.split("\n").filter(l => /^\S/.test(l) && !/^(\/\/|\}|\]|\)|import |export |class |const |let |async function |function )/.test(l));

// Every file the host loads as a mod module (everything but lib.js, which only node tests and the mod import): a call
// at the top level would run while the mod loads, before there is a cx.
for (const { mod, file, label } of modules.filter(m => !(m.mod === MAIN && m.file === "lib.js"))) {
  test(`${label} has no side effects at the top level: only declarations, exports and the class`, () => {
    assert.deepEqual(topLevelCalls(code(file, mod)), []);
  });
}
