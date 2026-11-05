import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// install.sh does nothing when it is sourced, so these call its functions against scratch folders
// (HERDR_APP_HOME, HERDR_MERMAID_HOME, XDG_STATE_HOME): nothing here touches a real install.
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SCRIPT = join(REPO, "install.sh");
const MOD = join(REPO, "mods/my-markdown");

const tmp = mkdtempSync(join(tmpdir(), "install-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const has = command => spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
const nodeOk = (([a, b]) => a > 22 || (a === 22 && b >= 12))(process.versions.node.split(".").map(Number));
const NEEDS_NODE = "the renderer install needs npm and Node.js 22.12+";
const tools = has("node") && has("npm") && nodeOk;

const sha = file => createHash("sha256").update(readFileSync(join(REPO, "tools/mermaid", file))).digest("hex");
const pin = JSON.parse(readFileSync(join(REPO, "tools/mermaid/package.json"), "utf8")).dependencies["@mermaid-js/mermaid-cli"];
const VERSION = `mmdc-${pin}+${sha("render.mjs").slice(0, 8)}+${sha("package-lock.json").slice(0, 8)}`;

// A scratch app home, renderer home and state folder; `app` exists as Herdr leaves it after its first start.
function scratch(name) {
  const dir = join(tmp, name), where = { app: join(dir, "app"), mermaid: join(dir, "mermaid"), state: join(dir, "state") };
  mkdirSync(join(where.app, "mods"), { recursive: true });
  return where;
}
const env = where => ({ ...process.env, HERDR_APP_HOME: where.app, HERDR_MERMAID_HOME: where.mermaid, XDG_STATE_HOME: where.state });
const bash = (where, body) => spawnSync("bash", ["-c", `source "${SCRIPT}"; ${body}`], { env: env(where), encoding: "utf8" });
const installed = where => join(where.app, "mods/my-markdown");
const list = dir => readdirSync(dir).sort();

test("install_mod copies every file of the mod and nothing else into the app home", () => {
  const where = scratch("copy"), run = bash(where, "install_mod");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(list(installed(where)), list(MOD));
  assert.equal(readFileSync(join(installed(where), "main.js"), "utf8"), readFileSync(join(MOD, "main.js"), "utf8"));
  assert.equal(existsSync(where.state), false, "nothing was there to back up");
  assert.match(run.stdout, /my-markdown installed in /);
});

test("install_mod removes files the mod no longer has, keeps what Herdr writes, and saves the replaced copy", () => {
  const where = scratch("replace");
  mkdirSync(installed(where), { recursive: true });
  for (const name of ["old.js", "gpui-kit.d.ts", "jsconfig.json", "main.js.error"]) writeFileSync(join(installed(where), name), "x");
  const run = bash(where, "install_mod");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(list(installed(where)), [...list(MOD), "gpui-kit.d.ts", "jsconfig.json", "main.js.error"].sort());
  const [stamp, ...more] = readdirSync(join(where.state, "herdr-markdown/backups"));
  assert.equal(more.length, 0);
  assert.ok(existsSync(join(where.state, "herdr-markdown/backups", stamp, "my-markdown/old.js")), "the old copy is kept");
  assert.match(run.stdout, /the installed copy differed; saved it under /);
});

test("install_mod run again over an identical copy saves nothing, whatever Herdr added to the folder", () => {
  const where = scratch("again");
  bash(where, "install_mod");
  writeFileSync(join(installed(where), "gpui-kit.d.ts"), "x");
  const run = bash(where, "install_mod");
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

test("install.sh --no-mermaid installs the mod only and exits 0", () => {
  const where = scratch("no-mermaid");
  const run = spawnSync("bash", [SCRIPT, "--no-mermaid"], { env: env(where), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(list(installed(where)), list(MOD));
  assert.match(run.stdout, /mermaid: skipped \(--no-mermaid\)/);
  assert.equal(existsSync(where.mermaid), false);
});

test("install.sh --help prints its header and exits 0; an unknown option exits 1 with the same text", () => {
  const where = scratch("help");
  const help = spawnSync("bash", [SCRIPT, "--help"], { env: env(where), encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--no-mermaid +only the mod/);
  assert.match(help.stdout, /HERDR_APP_HOME/);
  const bad = spawnSync("bash", [SCRIPT, "--bogus"], { env: env(where), encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--no-mermaid/);
  assert.match(bad.stderr, /unknown option: --bogus/);
  assert.equal(existsSync(installed(where)), false, "an unknown option installs nothing");
});

test("mermaid_version names mermaid-cli, render.mjs and the lock file", t => {
  if (!tools) return t.skip(NEEDS_NODE);
  assert.equal(bash(scratch("version"), "mermaid_version").stdout, VERSION);
  assert.match(VERSION, /^mmdc-\d+\.\d+\.\d+\+[0-9a-f]{8}\+[0-9a-f]{8}$/);
});

// A folder that tests run install_mermaid in: a bin folder with fake node and npm, first on PATH.
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
  assert.equal(readFileSync(join(where.mermaid, "version"), "utf8"), VERSION);
  assert.equal(readFileSync(join(where.mermaid, "node-path"), "utf8"), spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim());
  assert.match(run.stdout, new RegExp(`mermaid: renderer ${VERSION.replace(/[+.]/g, "\\$&")} installed in `));
});
