import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.m?js$/.test(name)) out.push(path);
  }
  return out;
}
const all = [...sources(join(root, "mods")), ...sources(join(root, "tools")), ...sources(join(root, "test"))];
const MAIN = "herdr-inline-markdown", BESIDE = "herdr-inline-markdown-beside";
const jsIn = mod => readdirSync(join(root, "mods", mod)).filter(f => f.endsWith(".js"));
const modFiles = jsIn(MAIN);
const code = (name, mod = MAIN) => readFileSync(join(root, "mods", mod, name), "utf8");
// Every module Herdr loads, from both mods: the main mod's by file name, the companion's with its folder.
const modules = [...modFiles.map(file => ({ mod: MAIN, file, label: file })), ...jsIn(BESIDE).map(file => ({ mod: BESIDE, file, label: `${BESIDE}/${file}` }))];

test("there are sources to check", () => {
  assert.ok(modFiles.length >= 10 && all.length > modFiles.length);
  assert.deepEqual(modules.filter(m => m.mod === BESIDE).map(m => m.file), ["main.js"]);
});

for (const file of all) {
  test(`node --check ${file.slice(root.length)}`, () => {
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
}

// The mod guide's rules that a test can see in the source. The mod reads and watches the folder of the file it shows,
// so watchFolder is allowed.
for (const { mod, file, label } of modules) {
  test(`${label} follows the guide: no timers but cx.timer, no top-level await, no kept cx`, () => {
    const source = code(file, mod).replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /\bsetTimeout\b|\bsetInterval\b/, "use cx.timer");
    assert.doesNotMatch(source, /^await\b/m, "no top-level await");
    const own = file === "keys.js" ? source.replace(/\bglobalThis\[INSTALLED\]/g, "") : source;
    assert.doesNotMatch(own, /this\.\w*cx\b|\bglobalThis\b/, "a cx is never kept, nothing hangs on globalThis");
  });
}

// Key bindings cannot be removed and every reload of a module would add the table again: the one flag on globalThis
// is the key table's, set inside the function that installs it, never at the top level. It carries the version the
// contexts carry, so a table whose contexts were renamed is installed on the next reload.
test("herdr-inline-markdown hangs one flag on globalThis, the key table's, only inside installKeys and named by the contexts' version", () => {
  const source = code("keys.js").replace(/\/\/.*$/gm, "");
  const body = source.slice(source.indexOf("export function installKeys"));
  assert.equal((source.match(/\bglobalThis\b/g) ?? []).length, 2);
  assert.equal((body.match(/\bglobalThis\[INSTALLED\]/g) ?? []).length, 2, "read and set in installKeys");
  assert.match(source, /^const VERSION = \d+;$/m);
  assert.match(source, /^const INSTALLED = `herdr-inline-markdown\.keys\.\$\{VERSION\}`;$/m);
  assert.match(source, /^export const TEXT = `MdText\$\{VERSION\}`, RAW = `MdRaw\$\{VERSION\}`, SOURCE = `MdSource\$\{VERSION\}`;$/m);
});

test("herdr-inline-markdown names its key contexts only through keys.js, so raising VERSION renames every one", () => {
  for (const file of modFiles.filter(f => f !== "keys.js")) {
    assert.doesNotMatch(code(file).replace(/\/\/.*$/gm, ""), /\bMd(?:Text|Raw|Source)\d/, file);
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

test("the top-level check finds a call that would run while the mod loads", () => {
  assert.deepEqual(topLevelCalls('import { shared } from "herdr";\nexport class Picker {\n}\nregisterTab(file);\nstate.loaded = true;\n'), ["registerTab(file);", "state.loaded = true;"]);
});
