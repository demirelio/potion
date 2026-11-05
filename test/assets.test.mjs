import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Asset paths in the mod ("mods/my-markdown/plus.svg") start at Herdr's app home, which this folder mirrors.
const root = fileURLToPath(new URL("..", import.meta.url));
const modDir = join(root, "mods/my-markdown");

// dots.svg is the diagram canvas's pattern tile; file-markdown.svg is a full-colour file icon.
const PATTERN_TILES = ["dots.svg"];
const FULL_COLOUR = ["file-markdown.svg"];

const sources = readdirSync(modDir).filter(f => f.endsWith(".js")).map(f => [f, readFileSync(join(modDir, f), "utf8")]);
const svgs = readdirSync(modDir).filter(f => f.endsWith(".svg"));

// Every icon file a source names: a full path, an ICON("name") call or an `icon: "name"` entry.
function named() {
  const out = new Set();
  for (const [, source] of sources) {
    for (const [, name] of source.matchAll(/mods\/my-markdown\/([\w.-]+\.svg)/g)) out.add(name);
    for (const [, name] of source.matchAll(/\bICON\("([\w-]+)"\)/g)) out.add(`${name}.svg`);
    for (const [, name] of source.matchAll(/\bicon: "([\w-]+)"/g)) out.add(`${name}.svg`);
  }
  return out;
}

test("every icon a source of the mod names is in the mod folder", () => {
  const icons = named();
  assert.ok(icons.has("markdown.svg") && icons.has("file-markdown.svg") && icons.has("spinner.svg") && icons.has("heading-1.svg"), `found ${[...icons]}`);
  for (const name of icons) assert.ok(existsSync(join(modDir, name)), `${name} is named in a source but missing`);
});

test("every icon in the mod folder is named by a source", () => {
  const icons = named();
  for (const name of svgs) assert.ok(icons.has(name), `${name} is not used`);
});

test("the mod draws nothing from another mod's folder, so it works without Herdr's shipped mods", () => {
  for (const [file, source] of sources) {
    const foreign = [...source.matchAll(/mods\/([\w-]+)\//g)].map(m => m[1]).filter(name => name !== "my-markdown");
    assert.deepEqual(foreign, [], `${file} names another mod's files`);
  }
});

test("our icons are lucide-style: 24x24, stroke currentColor, no fixed colors", () => {
  const icons = svgs.filter(f => !PATTERN_TILES.includes(f) && !FULL_COLOUR.includes(f));
  assert.ok(icons.length >= 15, `${icons.length} icons`);
  for (const name of icons) {
    const svg = readFileSync(join(modDir, name), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"/, name);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,6}|rgb\(/i, `${name} has a fixed color`);
    assert.match(svg, /<\/svg>\s*$/, name);
  }
});

test("the full-colour file icon is a 32x32 picture that is not tinted by the text colour", () => {
  for (const name of FULL_COLOUR) {
    const svg = readFileSync(join(modDir, name), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 32 32">/, name);
    assert.match(svg, /fill="#[0-9a-f]{6}"/i, `${name} has its own colour`);
    assert.match(svg, /<\/svg>\s*$/, name);
  }
});

test("the diagram canvas's dot tile is a filled 240x240 pattern, tinted by the frame's text colour", () => {
  for (const name of PATTERN_TILES) {
    const svg = readFileSync(join(modDir, name), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="240" height="240" viewBox="0 0 240 240"><path fill="#ffffff" d="/, name);
    assert.doesNotMatch(svg, /stroke/, `${name} is filled, not stroked`);
    assert.match(svg, /<\/svg>\s*$/, name);
  }
});

test("mod.json places the mod nowhere by itself and lets it take the keyboard", () => {
  assert.deepEqual(JSON.parse(readFileSync(join(modDir, "mod.json"), "utf8")), { place: "none", title: "Markdown", focusable: true });
});
