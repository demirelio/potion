import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// install.sh does nothing when it is sourced, so these call its functions against scratch folders
// (HERDR_APP_HOME, HERDR_MERMAID_HOME, XDG_STATE_HOME): nothing here touches a real install.
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SCRIPT = join(REPO, "install.sh");
const MOD = join(REPO, "mods/herdr-inline-markdown");
const MODS = ["herdr-inline-markdown", "herdr-inline-markdown-beside"];

const tmp = mkdtempSync(join(tmpdir(), "install-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const has = command => spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
const nodeOk = (([a, b]) => a > 22 || (a === 22 && b >= 12))(process.versions.node.split(".").map(Number));
const NEEDS_NODE = "the renderer install needs npm and Node.js 22.12+";
const tools = has("node") && has("npm") && nodeOk;

const sha = file => createHash("sha256").update(readFileSync(join(REPO, "tools/mermaid", file))).digest("hex");

// `app` exists as Herdr leaves it after its first start.
function scratch(name) {
  const dir = join(tmp, name), where = { app: join(dir, "app"), mermaid: join(dir, "mermaid"), state: join(dir, "state") };
  mkdirSync(join(where.app, "mods"), { recursive: true });
  return where;
}
const env = where => ({ ...process.env, HERDR_APP_HOME: where.app, HERDR_MERMAID_HOME: where.mermaid, XDG_STATE_HOME: where.state });
const bash = (where, body) => spawnSync("bash", ["-c", `source "${SCRIPT}"; ${body}`], { env: env(where), encoding: "utf8" });
const installed = (where, name = "herdr-inline-markdown") => join(where.app, "mods", name);
const list = dir => readdirSync(dir).sort();
const backups = where => join(where.state, "herdr-inline-markdown/backups");

function loggingMv(name) {
  const bin = join(tmp, name, "bin"), log = join(tmp, name, "mv.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "mv"), `#!/bin/sh\nprintf '%s -> %s\\n' "$1" "$2" >> "${log}"\nexec /bin/mv "$@"\n`);
  chmodSync(join(bin, "mv"), 0o755);
  return { bin, moves: () => readFileSync(log, "utf8").trim().split("\n") };
}

test("a first install_mods puts each mod folder in place whole: staged outside mods/, mod.json included, then renamed", () => {
  const where = scratch("staged"), mv = loggingMv("staged");
  const run = bash(where, `PATH="${mv.bin}:$PATH"; install_mods`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(list(where.app), ["mods"], "no staging folder is left beside mods/");
  const moves = mv.moves();
  assert.equal(moves.length, MODS.length, moves.join("\n"));
  MODS.forEach((name, i) => {
    assert.ok(moves[i].startsWith(`${where.app}/.${name}.`) && moves[i].endsWith(` -> ${installed(where, name)}`), moves[i]);
    assert.equal(JSON.parse(readFileSync(join(installed(where, name), "mod.json"), "utf8")).place, "none", name);
  });
});

test("install_mod removes files the mod no longer has, keeps what Herdr writes, and saves the replaced copy", () => {
  const where = scratch("replace");
  mkdirSync(installed(where), { recursive: true });
  for (const name of ["old.js", "gpui-kit.d.ts", "jsconfig.json", "main.js.error"]) writeFileSync(join(installed(where), name), "x");
  const run = bash(where, "install_mod herdr-inline-markdown");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(list(installed(where)), [...list(MOD), "gpui-kit.d.ts", "jsconfig.json", "main.js.error"].sort());
  const [stamp, ...more] = readdirSync(backups(where));
  assert.equal(more.length, 0);
  assert.ok(existsSync(join(backups(where), stamp, "herdr-inline-markdown/old.js")), "the old copy is kept");
  assert.match(run.stdout, /^mod: the installed copy of herdr-inline-markdown differed; saved it under .*\/herdr-inline-markdown$/m);
});

test("install_mods saves every replaced copy in one backup folder, each under its name", () => {
  const where = scratch("replace-both");
  for (const name of MODS) {
    mkdirSync(installed(where, name), { recursive: true });
    writeFileSync(join(installed(where, name), "old.js"), "x");
  }
  const run = bash(where, "install_mods");
  assert.equal(run.status, 0, run.stderr);
  const [stamp, ...more] = readdirSync(backups(where));
  assert.equal(more.length, 0, "one run, one folder");
  assert.deepEqual(list(join(backups(where), stamp)), MODS);
  for (const name of MODS) assert.equal(existsSync(join(installed(where, name), "old.js")), false, name);
});

test("install_mods run again over identical copies saves nothing, whatever Herdr added to the folders", () => {
  const where = scratch("again");
  bash(where, "install_mods");
  for (const name of MODS) writeFileSync(join(installed(where, name), "gpui-kit.d.ts"), "x");
  const run = bash(where, "install_mods");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(where.state), false);
  assert.doesNotMatch(run.stdout, /differed/);
});

test("install.sh without a Herdr app home stops and says what to do", () => {
  const where = scratch("none");
  rmSync(where.app, { recursive: true });
  const run = spawnSync("bash", [SCRIPT, "--no-mermaid"], { env: env(where), encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no Herdr app home at .*start Herdr once.*HERDR_APP_HOME/);
  assert.equal(existsSync(where.app), false, "nothing was made");
});

const install = (where, ...options) => spawnSync("bash", [SCRIPT, "--no-mermaid", ...options], { env: env(where), encoding: "utf8" });

test("install.sh --no-mermaid installs a copy of each mod's folder and nothing else, no renderer, backs up nothing, and exits 0", () => {
  const where = scratch("no-mermaid");
  const run = install(where);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(list(join(where.app, "mods")), MODS);
  for (const name of MODS) assert.deepEqual(list(installed(where, name)), list(join(REPO, "mods", name)), name);
  assert.equal(readFileSync(join(installed(where), "main.js"), "utf8"), readFileSync(join(MOD, "main.js"), "utf8"));
  assert.equal(existsSync(where.state), false, "nothing was there to back up");
  assert.match(run.stdout, /^mod: herdr-inline-markdown installed in .*\nmod: herdr-inline-markdown-beside installed in /m);
  assert.match(run.stdout, /mermaid: skipped \(--no-mermaid\)/);
  assert.equal(existsSync(where.mermaid), false);
});

test("install.sh --help prints its header and exits 0; an unknown option exits 1 with the same text", () => {
  const where = scratch("help");
  const help = spawnSync("bash", [SCRIPT, "--help"], { env: env(where), encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^install\.sh: /);
  assert.match(help.stdout, /--no-mermaid +no diagram renderer/);
  assert.match(help.stdout, /--no-keys +leave keys\.json alone/);
  assert.match(help.stdout, /--replace-keys +/);
  assert.match(help.stdout, /HERDR_APP_HOME/);
  assert.doesNotMatch(help.stdout, /set -euo|^#/m, "only the header, without its comment marks");
  const bad = spawnSync("bash", [SCRIPT, "--bogus"], { env: env(where), encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--no-mermaid/);
  assert.match(bad.stderr, /unknown option: --bogus/);
  assert.equal(existsSync(installed(where)), false, "an unknown option installs nothing");
});

// The person's keys.json as Herdr writes it, with a key of theirs in "terminal" and two in "global".
const KEYS = `{
  "global": {
    "cmd-q": "app.quit",
    "cmd-p": "mod.open:picker"
  },
  "terminal": {
    "alt-left": "send:\\u001bb"
  }
}
`;
const M = "mod.open:herdr-inline-markdown", BESIDE = "mod.open:herdr-inline-markdown-beside";
const keysOf = where => join(where.app, "keys.json");
function withKeys(name, text = KEYS) {
  const where = scratch(name);
  writeFileSync(keysOf(where), text);
  return where;
}
const savedKeys = where => readdirSync(backups(where)).map(stamp => join(backups(where), stamp, "keys.json")).filter(f => existsSync(f));
// The line a run ends its keys with: both keys open the picker now, or they don't and how to get there.
const KEYS_READY = /^Keys: cmd-m opens the Markdown file picker for a new tab, cmd-shift-m for a pane beside the focused one\.$/m;
const KEYS_NOT_READY = /^Keys: cmd-m and cmd-shift-m don't both open the picker yet \(see the keys lines above\): \.\/install\.sh --replace-keys takes over a key bound to something else, or add the keys in .*\/keys\.json by hand\.$/m;
const keysSay = run => run.stdout.split("\n").filter(line => line.startsWith("Keys:"));

test("install.sh adds the keys keys.json is missing at the end of global, leaves every other byte, and saves the old file", () => {
  const where = withKeys("keys-add"), run = install(where);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(keysOf(where), "utf8"),
    KEYS.replace(`"cmd-p": "mod.open:picker"\n`, `"cmd-p": "mod.open:picker",\n    "cmd-m": "${M}",\n    "cmd-shift-m": "${BESIDE}"\n`));
  assert.match(run.stdout, new RegExp(`^keys: added cmd-m: ${M}\nkeys: added cmd-shift-m: ${BESIDE}\nkeys: saved the previous keys\\.json as .*/keys\\.json$`, "m"));
  const saved = savedKeys(where);
  assert.equal(saved.length, 1);
  assert.equal(readFileSync(saved[0], "utf8"), KEYS);
  assert.deepEqual(list(where.app), ["keys.json", "mods"], "no temporary file is left");
  assert.match(run.stdout, KEYS_READY);
  assert.equal(keysSay(run).length, 1);
});

test("install.sh run again finds the keys there: keys.json is not written and nothing more is saved", () => {
  const where = withKeys("keys-same");
  install(where);
  const before = readFileSync(keysOf(where), "utf8"), mtime = statSync(keysOf(where)).mtimeMs;
  const run = install(where);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(keysOf(where), "utf8"), before);
  assert.equal(statSync(keysOf(where)).mtimeMs, mtime);
  assert.match(run.stdout, new RegExp(`^keys: cmd-m is already ${M}\nkeys: cmd-shift-m is already ${BESIDE}$`, "m"));
  assert.doesNotMatch(run.stdout, /saved the previous keys/);
  assert.equal(savedKeys(where).length, 1, "only the first run's copy");
  assert.match(run.stdout, KEYS_READY, "keys that were there already count");
});

test("install.sh keeps a key that does something else, says so and how to take it over, and still adds the other", () => {
  const theirs = KEYS.replace(`"cmd-q": "app.quit",`, `"cmd-m": "my-tabs.markdown:tab",\n    "cmd-q": "app.quit",`);
  const where = withKeys("keys-kept", theirs), run = install(where);
  assert.equal(run.status, 0, run.stderr);
  const global = JSON.parse(readFileSync(keysOf(where), "utf8")).global;
  assert.equal(global["cmd-m"], "my-tabs.markdown:tab");
  assert.equal(global["cmd-shift-m"], BESIDE);
  assert.match(run.stdout, new RegExp(`^keys: kept your cmd-m: my-tabs\\.markdown:tab \\(\\./install\\.sh --replace-keys makes it ${M}\\)$`, "m"));
  assert.deepEqual(keysSay(run).map(line => KEYS_NOT_READY.test(line)), [true], "it does not claim cmd-m opens the picker");
});

test("install.sh --replace-keys gives a key that does something else our action, where it was", () => {
  const theirs = KEYS.replace(`"cmd-q": "app.quit",`, `"cmd-m": "my-tabs.markdown:tab",\n    "cmd-q": "app.quit",\n    "cmd-shift-m": "my-tabs.markdown:pane",`);
  const where = withKeys("keys-replace", theirs), run = install(where, "--replace-keys");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(keysOf(where), "utf8"), theirs.replace("my-tabs.markdown:tab", M).replace("my-tabs.markdown:pane", BESIDE));
  assert.match(run.stdout, new RegExp(`^keys: replaced cmd-m: my-tabs\\.markdown:tab with ${M}$`, "m"));
  assert.match(run.stdout, new RegExp(`^keys: replaced cmd-shift-m: my-tabs\\.markdown:pane with ${BESIDE}$`, "m"));
  assert.equal(readFileSync(savedKeys(where)[0], "utf8"), theirs);
  assert.match(run.stdout, KEYS_READY);
});

test("install.sh --no-keys leaves keys.json alone, even with --replace-keys", () => {
  const where = withKeys("keys-none", KEYS.replace(`"cmd-q": "app.quit",`, `"cmd-m": "other.thing",`));
  const before = readFileSync(keysOf(where), "utf8"), run = install(where, "--replace-keys", "--no-keys");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(keysOf(where), "utf8"), before);
  assert.match(run.stdout, /^keys: skipped \(--no-keys\)/m);
  assert.equal(existsSync(where.state), false);
  assert.deepEqual(keysSay(run), [], "nothing said about keys it did not look at");
});

test("install.sh without a keys.json makes none: the keys wait for the one Herdr writes", () => {
  const where = scratch("keys-missing"), run = install(where);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(keysOf(where)), false);
  assert.match(run.stdout, /^keys: .*app has no keys\.json, so none was made: run \.\/install\.sh again once Herdr has written one, or add the keys in .*\/keys\.json by hand$/m);
  assert.deepEqual(keysSay(run).map(line => KEYS_NOT_READY.test(line)), [true]);
});

test("install.sh leaves a keys.json that is not valid JSON as it is, says why, and still exits 0", () => {
  const where = withKeys("keys-invalid", `{ "global": { "cmd-q": "app.quit", } }`), run = install(where);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(keysOf(where), "utf8"), `{ "global": { "cmd-q": "app.quit", } }`);
  assert.match(run.stdout, /^keys: left .*keys\.json alone: it is not valid JSON/m);
  assert.equal(existsSync(where.state), false);
  assert.deepEqual(keysSay(run).map(line => KEYS_NOT_READY.test(line)), [true]);
});

test("merge_keys without node leaves keys.json alone, says what to do, and returns KEYS_NOT_BOUND", () => {
  const where = withKeys("keys-no-node"), bin = join(tmp, "keys-no-node/bin");
  mkdirSync(bin, { recursive: true });
  const run = bash(where, `PATH="${bin}"; merge_keys ""`);
  assert.equal(run.status, 2, run.stderr);
  assert.equal(readFileSync(keysOf(where), "utf8"), KEYS);
  assert.match(run.stdout, /^keys: node not found, so .*keys\.json was left alone: add the keys in .*\/keys\.json to it by hand, or install Node\.js and run \.\/install\.sh again$/m);
});

test("install.sh writes through a keys.json that is a link: the file it points at changes, the link stays, its mode is kept", () => {
  const where = scratch("keys-link"), real = join(tmp, "keys-link/dotfiles/keys.json");
  mkdirSync(join(tmp, "keys-link/dotfiles"), { recursive: true });
  writeFileSync(real, KEYS);
  chmodSync(real, 0o600);
  symlinkSync(real, keysOf(where));
  const run = install(where);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(lstatSync(keysOf(where)).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(real, "utf8")).global["cmd-m"], M);
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(list(join(tmp, "keys-link/dotfiles")), ["keys.json"], "no temporary file is left");
});

test("install.sh says so and exits 1 when keys.json cannot be written", () => {
  const where = withKeys("keys-locked");
  bash(where, "install_mods");
  chmodSync(where.app, 0o555);
  try {
    const run = install(where);
    assert.equal(run.status, 1, run.stdout);
    assert.equal(readFileSync(keysOf(where), "utf8"), KEYS);
    assert.match(run.stdout, /^keys\.json was not changed: fix the problem above and run \.\/install\.sh again\.$/m);
    assert.deepEqual(keysSay(run), []);
  } finally {
    chmodSync(where.app, 0o755);
  }
});

function fakeTools(name, nodeScript) {
  const bin = join(tmp, name, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [tool, script] of Object.entries({ node: nodeScript, npm: "#!/bin/sh\nexit 0\n" })) {
    writeFileSync(join(bin, tool), script);
    chmodSync(join(bin, tool), 0o755);
  }
  return bin;
}

test("install_mermaid without node or npm says so, installs nothing and returns 0", () => {
  const where = scratch("no-node"), bin = join(tmp, "no-node/bin");
  mkdirSync(bin, { recursive: true });
  const run = bash(where, `PATH="${bin}"; install_mermaid`);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /mermaid: Node\.js \(node and npm\) not found, so no diagrams yet: install Node\.js 22\.12 or newer, then run \.\/install\.sh again/);
  assert.equal(existsSync(where.mermaid), false);
});

test("install_mermaid with a Node.js older than 22.12 says so, installs nothing and returns 0", () => {
  const where = scratch("old-node");
  const bin = fakeTools("old-node", '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v20.11.0; exit 0; fi\nexit 1\n');
  const run = bash(where, `PATH="${bin}:$PATH"; install_mermaid`);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /mermaid: Node\.js v20\.11\.0 is too old for the renderer \(22\.12 or newer\), so no diagrams yet/);
  assert.equal(existsSync(where.mermaid), false);
});

test("install_mermaid takes version away first: an install that stops half way reads as not installed", t => {
  if (!tools) return t.skip(NEEDS_NODE);
  const where = scratch("half");
  mkdirSync(join(where.mermaid, "node_modules"), { recursive: true });
  writeFileSync(join(where.mermaid, "lock.sha256"), sha("package-lock.json"));
  writeFileSync(join(where.mermaid, "version"), "mmdc-old");
  // The lock matches and node_modules exists, so npm ci is skipped; the browser step then fails (no puppeteer here).
  const run = bash(where, "install_mermaid");
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /mermaid: could not fetch chrome-headless-shell; retry with \.\/install\.sh/);
  assert.equal(existsSync(join(where.mermaid, "version")), false, "the old version is not left over the new files");
  assert.equal(existsSync(join(where.mermaid, "node-path")), false);
  for (const f of ["package.json", "package-lock.json", "render.mjs"]) {
    assert.equal(readFileSync(join(where.mermaid, f), "utf8"), readFileSync(join(REPO, "tools/mermaid", f), "utf8"), f);
  }
});

test("install_mermaid writes node-path and version without a newline once everything is in place", t => {
  if (!tools) return t.skip(NEEDS_NODE);
  const where = scratch("whole");
  mkdirSync(join(where.mermaid, "node_modules/puppeteer"), { recursive: true });
  writeFileSync(join(where.mermaid, "lock.sha256"), sha("package-lock.json"));
  writeFileSync(join(where.mermaid, "node_modules/puppeteer/install.mjs"), "console.log('ready');\n");
  const run = bash(where, "install_mermaid");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const version = bash(where, "mermaid_version").stdout;
  assert.equal(readFileSync(join(where.mermaid, "version"), "utf8"), version);
  assert.equal(readFileSync(join(where.mermaid, "node-path"), "utf8"), spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim());
  assert.ok(run.stdout.includes(`mermaid: renderer ${version} installed in `), run.stdout);
});
