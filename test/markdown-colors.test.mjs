import test from "node:test";
import assert from "node:assert/strict";
import * as colors from "../mods/potion/colors.js";

const rgb = hex => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
const near = (a, b, units, label) => {
  const [x, y] = [rgb(a), rgb(b)];
  assert.ok(/^#[0-9a-f]{6}$/.test(a), `${label}: ${a} is #rrggbb`);
  assert.ok(x.every((v, i) => Math.abs(v - y[i]) <= units), `${label}: ${a} is within ${units} of ${b}`);
};
const brown = (hex, label) => {
  const [r, g, b] = rgb(hex);
  assert.ok(r - b >= 30 && g > b + 15 && r > g + 8, `${label}: ${hex} is a brown (red over green over blue)`);
};

test("the highlight is a quarter of a warm ochre over a grey as light as the page, so it is brown on any page", () => {
  const dark = colors.highlightColor({ background: "#191919" }), light = colors.highlightColor({ background: "#ffffff" });
  near(dark, "#4a3b20", 3, "a dark page: the owner's reference");
  near(light, "#f6e8cd", 3, "a light page: a soft beige");
  const cobalt = colors.highlightColor({ background: "#122738" });
  brown(cobalt, "the owner's cobalt2, a blue page");
  near(cobalt, "#524328", 3, "the owner's cobalt2");
  brown(colors.highlightColor({ background: "#21252b" }), "a blue-grey page");
  near(colors.highlightColor({ background: "#FFF" }), light, 1, "#rgb");
  near(colors.highlightColor({ background: "#ffffff80" }), light, 1, "an alpha of its own is left out");
  near(colors.highlightColor({ background: "background" }), dark, 1, "not a colour: a dark page");
  near(colors.highlightColor(undefined), dark, 1);
  for (const page of ["#191919", "#ffffff", "#122738"]) {
    const h = rgb(colors.highlightColor({ background: page })), p = rgb(page);
    assert.ok(h[0] - h[2] > p[0] - p[2] + 10, `${page}: warmer than the page`);
  }
});

test("text colours come from the theme's ANSI colours, each with a fallback; a colour written in the file is drawn as it is", () => {
  assert.deepEqual(colors.TEXT_COLORS, ["red", "yellow", "green", "teal", "purple"]);
  const t = { ansi1: "#ff628c", ansi2: "#3ad900", ansi3: "#ffc600", ansi5: "#fb94ff", ansi6: "#80fcff" };
  assert.deepEqual(colors.TEXT_COLORS.map(name => colors.textColor(t, name)), ["#ff628c", "#ffc600", "#3ad900", "#80fcff", "#fb94ff"]);
  for (const name of colors.TEXT_COLORS) assert.match(colors.textColor({}, name), /^#[0-9a-f]{6}$/, `${name} without a theme`);
  assert.match(colors.textColor({ ansi1: "ansi1" }, "red"), /^#[0-9a-f]{6}$/, "a theme entry that is not a colour");
  assert.equal(colors.textColor(t, "#123456"), "#123456");
  assert.equal(colors.textColor(t, "blue"), null, "not one of the editor's");
});

test("the active comment's highlight is the same ochre, deeper: further from the page on a dark page and on a light one", () => {
  const distance = (a, b) => rgb(a).reduce((sum, v, i) => sum + Math.abs(v - rgb(b)[i]), 0);
  for (const page of ["#191919", "#ffffff", "#122738"]) {
    const t = { background: page }, deep = colors.deepHighlightColor(t);
    assert.ok(/^#[0-9a-f]{6}$/.test(deep), `${page}: ${deep} is #rrggbb`);
    brown(deep, `${page}: still brown`);
    assert.ok(distance(deep, page) > distance(colors.highlightColor(t), page) + 40, `${page}: ${deep} stands out more than the highlight`);
  }
});
