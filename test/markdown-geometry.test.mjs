import test from "node:test";
import assert from "node:assert/strict";
import {
  pressToField, snapToWord, tableCells, nextCell, caretRow, isOneRow, columnX, maxOffset, clampOffset, prefixSums, blockAt,
  estimateHeight, caretY, revealOffset, anchorOffset, anchorBlock, revealAt, pageStep, COLUMN,
  FRAME, columnLeft, frameBox, topDown, clampView, overflows, startView, zoomAround, zoomStep, canZoom, toolsTop, frameTool,
  sharpScale, startsGesture, decideAxis, passThrough, MENU, menuH, menuPlace, slashX, BAR, barSize, barPlace, PICTURE, pictureLayout,
} from "../mods/herdr-inline-markdown/geometry.js";
import { parse, field } from "../mods/herdr-inline-markdown/blocks.js";

const cal = { rowPx: 20, advance: 8, monoAdvance: 7.8 };

test("pressToField is exact for unwrapped monospace; a fence line above the drawn code counts", () => {
  const code = ["```js", "const a = 1;", "", "  return a;", "```"];
  const value = code.join("\n"), starts = [0, 6, 19, 20, 32];
  for (let line = 1; line <= 3; line++) {
    for (let col = 0; col <= code[line].length; col++) {
      const at = pressToField({ kind: "code", value, fenced: true, width: 700 }, col * cal.monoAdvance + 1, (line - 1) * cal.rowPx + 7, cal);
      assert.equal(at, starts[line] + col, `line ${line} col ${col}`);
    }
  }
  assert.equal(pressToField({ kind: "frontmatter", value: "---\ntitle: x\n---", fenced: true, width: 700 }, 999, 0, cal), 12, "clamped to the line");
  assert.equal(pressToField({ kind: "code", value, fenced: true, width: 700 }, 0, 999, cal), starts[3], "below the last line: the last inner line");
});

test("pressToField lands on the character drawn under the press when Reading strips a code indent", () => {
  const drawnAt = (text, kind = "code") => {
    const d = parse(text), b = d.blocks[0], value = field(d, b).value, drawn = b.content.split("\n");
    const lines = value.split("\n"), first = b.fence ? 1 : 0, starts = [0];
    for (const l of lines) starts.push(starts.at(-1) + l.length + 1);
    drawn.forEach((line, row) => {
      const at0 = starts[first + row] + lines[first + row].length - line.length;
      for (let col = 0; col <= line.length; col++) {
        const at = pressToField({ kind, value, fenced: Boolean(b.fence), width: 700 }, col * cal.monoAdvance + 1, row * cal.rowPx + 7, cal);
        assert.equal(at, at0 + col, `${JSON.stringify(text)} row ${row} col ${col}`);
        if (col < line.length) assert.equal(value[at], line[col]);
      }
    });
    return pressToField({ kind, value, fenced: Boolean(b.fence), width: 700 }, 999, (drawn.length - 1) * cal.rowPx + 7, cal);
  };
  const plain = "    npm test\n      --watch\n";
  assert.equal(drawnAt(plain), plain.length - 1, "past the drawn end: the end of the line");
  assert.equal(pressToField({ kind: "code", value: "    npm test", width: 700 }, 0, 5, cal), 4, "the first drawn character, after the indent");
  drawnAt("\tnpm test\n");
  drawnAt("  \tnpm test\n   \tnext\n");
  drawnAt("  ```sh\n  npm test\n   indented\n x\n  ```\n");
  drawnAt("   ```mermaid\n   graph TD\n   ```\n", "mermaid");
});

test("pressToField on wrapped monospace walks the lines by their rows", () => {
  const long = "x".repeat(150), value = `\`\`\`\n${long}\nshort\n\`\`\``;
  const t = { kind: "code", value, fenced: true, width: 78 * 7.8 + 1, rows: 3 };
  assert.equal(pressToField(t, 10 * 7.8, 1 * 20 + 5, cal), 4 + 78 + 10, "second row of the long line");
  assert.equal(pressToField(t, 2 * 7.8, 2 * 20 + 5, cal), 4 + 151 + 2, "the next line after the wrapped one");
});

test("pressToField on wrapped indented code counts the rows of what is drawn, without the indent", () => {
  // 156 drawn characters fill exactly two rows of 78; with the indent counted they would take three.
  const value = `    ${"x".repeat(156)}\n    short`, second = value.indexOf("short");
  const t = { kind: "code", value, fenced: false, width: 78 * 7.8 + 1, rows: 3 };
  assert.equal(pressToField(t, 10 * 7.8, 1 * 20 + 5, cal), 4 + 78 + 10, "the second row of the long line");
  assert.equal(pressToField(t, 2 * 7.8, 2 * 20 + 5, cal), second + 2, "the third row is the next line");
  const tabbed = { ...t, value: value.replace(/^ {4}/gm, "  \t") };
  assert.equal(pressToField(tabbed, 2 * 7.8, 2 * 20 + 5, cal), tabbed.value.indexOf("short") + 2, "spaces and a tab are one indent");
});

test("tables give the cell start, the delimiter row skipped", () => {
  const value = "| name | value |\n|------|-------|\n| a    | 12345 |\n| bb   | 6     |";
  const t = { kind: "table", value, width: 400, height: 90 };
  const cells = tableCells(value);
  assert.equal(cells[1].delimiter, true);
  assert.equal(value.slice(cells[2].cells[1].start, cells[2].cells[1].end), "12345");
  assert.equal(pressToField(t, 10, 5, cal), value.indexOf("name"));
  assert.equal(pressToField(t, 390, 5, cal), value.indexOf("value"));
  assert.equal(pressToField(t, 10, 35, cal), value.indexOf("a    |"));
  assert.equal(pressToField(t, 350, 80, cal), value.indexOf("6"));
  assert.deepEqual(tableCells("a | b\n--|--\nx | y | z\n | x").map(r => r.cells.length), [2, 2, 3, 1]);
});

test("Tab in a table selects the next cell's trimmed text; past the last cell, nothing", () => {
  const value = "| a | b |\n|---|---|\n| c |   |";
  const sel = c => (c ? value.slice(c.start, c.end) : null);
  assert.equal(sel(nextCell(value, value.indexOf("a"), 1)), "b");
  assert.equal(sel(nextCell(value, value.indexOf("b"), 1)), "c");
  assert.deepEqual(nextCell(value, value.indexOf("c"), 1), { start: value.length - 3, end: value.length - 3 }, "an empty cell: a caret inside it");
  assert.equal(nextCell(value, value.length - 1, 1), null);
  assert.equal(sel(nextCell(value, value.indexOf("c"), -1)), "b");
  assert.equal(nextCell(value, 1, -1), null);
});

test("prose lands on a word boundary, through the inline syntax", () => {
  const t = { kind: "paragraph", value: "hello brave new world", width: 700 };
  for (let col = 0; col <= t.value.length; col++) {
    const at = pressToField(t, col * cal.advance, 5, cal);
    assert.ok(at === 0 || at === t.value.length || /\W/.test(t.value[at]) !== /\W/.test(t.value[at - 1]), `col ${col} -> ${at}`);
    assert.ok(Math.abs(at - col) <= 3, `col ${col} -> ${at}`);
  }
  const marked = { kind: "paragraph", value: "a **bold** word", width: 700 };
  assert.equal(pressToField(marked, 3 * cal.advance, 5, cal), marked.value.indexOf("bold"), "visible column 3 is in `bold`, after the **");
  const two = { kind: "item", value: "first line\\\nsecond line", width: 700 };
  assert.equal(pressToField(two, 7 * cal.advance, 25, cal), two.value.indexOf("line", 15));
  assert.equal(snapToWord("ab cd", 1), 0);
  assert.equal(snapToWord("ab cd", 2), 2);
});

test("prose that wraps finds the row the press is on", () => {
  const words = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, "0")}`).join(" ");
  const t = { kind: "paragraph", value: words, width: 40 * cal.advance };
  const at = pressToField(t, 0, 1 * cal.rowPx + 3, cal);
  assert.equal(at, 40, "the second row starts at visible column 40");
});

test("caretRow is exact for unwrapped fields and shares out the extra rows of wrapped ones", () => {
  const value = "one\ntwo two\n\nfour";
  const lines = value.split("\n");
  let caret = 0;
  lines.forEach((l, i) => {
    for (let c = 0; c <= l.length; c++) assert.equal(caretRow(value, caret + c, lines.length), i, `line ${i} col ${c}`);
    caret += l.length + 1;
  });
  assert.equal(caretRow(value, 5, undefined), 1);
  const wrapped = `${"a".repeat(300)}\nb`;
  const rows = [0, 100, 200, 299, 301].map(c => caretRow(wrapped, c, 4));
  assert.deepEqual(rows, [...rows].sort((x, y) => x - y), "monotonic");
  assert.ok(rows.every(r => r >= 0 && r <= 3));
  assert.equal(rows.at(-1), 3);
});

test("a one-row field: no break, under 1.5 rows, and its estimated width under 90% of the field", () => {
  assert.equal(isOneRow({ value: "short", height: 24, rowPx: 24, width: 500, advance: 8 }), true);
  assert.equal(isOneRow({ value: "a\nb", height: 24, rowPx: 24, width: 500, advance: 8 }), false);
  assert.equal(isOneRow({ value: "short", height: 48, rowPx: 24, width: 500, advance: 8 }), false);
  assert.equal(isOneRow({ value: "x".repeat(57), height: 24, rowPx: 24, width: 500, advance: 8 }), false, "about to wrap");
});

test("viewport arithmetic: column x, prefix sums, hit-test, clamps", () => {
  assert.equal(columnX(100, 700), 100 - COLUMN.padX);
  assert.equal(columnX(500, 1180), 500 - 200 - 32);
  const sums = prefixSums([30, 50, 20]);
  assert.deepEqual(sums, [0, 30, 80, 100]);
  assert.deepEqual([-5, 0, 29, 30, 79, 80, 500].map(y => blockAt(sums, y)), [0, 0, 0, 1, 1, 2, 2]);
  assert.equal(blockAt([0], 10), -1);
  assert.equal(maxOffset(300, 500), 0);
  assert.equal(clampOffset(900, 1000, 400), 600);
  assert.equal(clampOffset(-3, 1000, 400), 0);
  assert.equal(estimateHeight(3, 24, 14), 86);
  assert.equal(caretY({ blockTop: 100, padTop: 14, chromeTop: 12, rowPx: 20, row: 2 }), 166);
  assert.equal(pageStep(500), 460);
});

test("revealOffset keeps the caret row inside [offset + 24, offset + height - 72], scrolling the least", () => {
  const base = { viewportH: 500, rowPx: 20, contentH: 5000 };
  assert.equal(revealOffset({ ...base, offset: 1000, y: 1200 }), 1000, "already inside");
  assert.equal(revealOffset({ ...base, offset: 1000, y: 1010 }), 986);
  assert.equal(revealOffset({ ...base, offset: 1000, y: 1420 }), 1012);
  assert.equal(revealOffset({ ...base, offset: 0, y: 4990 }), 4500, "clamped to the end");
  assert.equal(revealOffset({ ...base, offset: 50, y: 0 }), 0);
});

test("anchoring keeps the anchor block's screen y when heights above it change", () => {
  const before = prefixSums([100, 100, 100, 1000]), after = prefixSums([100, 400, 100, 1000]);
  const anchor = anchorBlock({ sums: before, offset: 250, viewportH: 300 });
  assert.equal(anchor, 2);
  const offset = anchorOffset({ offset: 250, before: before[anchor], after: after[anchor], contentH: after.at(-1), viewportH: 300 });
  assert.equal(after[anchor] - offset, before[anchor] - 250);
  assert.equal(anchorBlock({ sums: before, offset: 250, viewportH: 300, active: 3, caretY: 320 }), 3, "the active block when its caret is on screen");
  assert.equal(revealAt({ top: 1000, rowY: 40, fraction: 1 / 3, viewportH: 600, contentH: 4000 }), 840);
});

// The column of a block at `depth` in a pane `viewW` wide, as the editor hands it to frameBox.
const column = (viewW, depth = 0) => ({ blockLeft: columnLeft(viewW) + depth * 24, blockW: Math.min(780, viewW) - 64 - depth * 24 });
const STRESS = { natW: 2321, natH: 2722 };
const near = (a, b, what, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} is not ${b}`);

test("frameBox: a wide and tall diagram takes the pane's width less 32 px a side and 70 % of the screen's height", () => {
  const box = frameBox({ viewW: 1900, viewH: 1000, ...column(1900), ...STRESS });
  assert.deepEqual([box.w, box.h, box.left, box.ml], [1836, 700, 32, -(columnLeft(1900) - 32)]);
  near(box.z0, 0.7807, "the full width at a readable zoom");
  near(box.zMin, 0.2483, "zoomed out to the whole diagram");
  assert.equal(frameBox({ viewW: 1900, viewH: 1001, ...column(1900), ...STRESS }).h, 700, "whole pixels: 70.07 % of 1001 rounds down");
  const nested = frameBox({ viewW: 1900, viewH: 1000, ...column(1900, 1), ...STRESS });
  assert.deepEqual([nested.w, nested.left], [1836, 32], "a nested diagram is centred in the pane too");
  assert.ok(nested.ml <= 0);
  const narrow = frameBox({ viewW: 600, viewH: 1000, ...column(600), ...STRESS });
  assert.deepEqual([narrow.w, narrow.ml, narrow.z0], [536, 0, 0.75], "a 600 px pane has nothing to break into; text is not shrunk below 75 %");
  assert.equal(frameBox({ viewW: 1900, viewH: 100, ...column(1900), ...STRESS }).h, FRAME.minH, "never under 120 px");
});

test("frameBox: a small diagram keeps the column and the 120 px of its pending box; a long chain breaks out, centred, at 100 %", () => {
  const small = frameBox({ viewW: 1900, viewH: 1000, ...column(1900), natW: 552, natH: 58 });
  assert.deepEqual([small.w, small.h, small.ml, small.z0, small.zMin], [716, FRAME.minH, 0, 1, 1], "58 + 2 x 12 is 82: the page does not move when the picture arrives");
  const chain = frameBox({ viewW: 1900, viewH: 1000, ...column(1900), natW: 1206, natH: 184 });
  assert.deepEqual([chain.w, chain.h, chain.left, chain.z0], [1230, 208, (1900 - 1230) / 2, 1]);
  const tall = frameBox({ viewW: 1900, viewH: 1000, ...column(1900), natW: 800, natH: 6000 });
  assert.deepEqual([tall.w, tall.h, tall.z0], [824, 700, 1], "a tall, narrow one at 100 %, read by scrolling through it");
});

test("topDown: flowcharts and graphs going down start centred; anything else starts at its left", () => {
  for (const s of ["flowchart TB\nA-->B", "graph TD;\nA-->B", "flowchart BT\nA", "graph\nA", "%%{init: {}}%%\n%% note\nflowchart TD\nA", "---\ntitle: x\n---\nflowchart TB\nA", "\n  flowchart TB\nA"]) assert.equal(topDown(s), true, s);
  for (const s of ["flowchart LR\nA-->B", "graph RL\nA", "sequenceDiagram\nA->>B: hi", "", "%% only a comment"]) assert.equal(topDown(s), false, s);
});

test("startView and clampView: a fitting picture starts centred both ways, a larger one at its top; the canvas pans on until a point of the picture reaches the frame's centre", () => {
  const box = { w: 1000, h: 500 }, nat = { w: 2000, h: 1000 };
  assert.deepEqual(startView(box, nat, 1, false), { z: 1, x: 12, y: 12 }, "LR and sequence diagrams start at the left");
  assert.deepEqual(startView(box, nat, 1, true), { z: 1, x: -500, y: 12 }, "a top-down flowchart starts at its top centre");
  assert.deepEqual(startView(box, nat, 0.25, true), { z: 0.25, x: 250, y: 125 }, "fitting: centred both ways");
  assert.deepEqual(startView(box, nat, 0.25, false), { z: 0.25, x: 250, y: 125 }, "fitting, not top-down: centred too");
  assert.deepEqual(startView(box, { w: 2000, h: 300 }, 1, false), { z: 1, x: 12, y: 100 }, "wide and short: left edge, centred in height");
  assert.deepEqual(startView(box, { w: 400, h: 1000 }, 1, false), { z: 1, x: 300, y: 12 }, "narrow and tall: centred in width, at the top");
  assert.deepEqual(clampView(box, nat, { z: 1, x: 100, y: 100 }), { z: 1, x: 100, y: 100 }, "the picture can be dragged in from its edge");
  assert.deepEqual(clampView(box, nat, { z: 1, x: -5000, y: -5000 }), { z: 1, x: 500 - 2000, y: 250 - 1000 }, "far edge at the centre");
  assert.deepEqual(clampView(box, nat, { z: 1, x: 5000, y: 5000 }), { z: 1, x: 500, y: 250 }, "near edge at the centre");
  assert.deepEqual(clampView(box, nat, { z: 0.25, x: -100, y: -100 }), { z: 0.25, x: 0, y: 0 }, "a fitting picture goes anywhere inside the frame");
  assert.deepEqual(clampView(box, nat, { z: 0.25, x: 900, y: 900 }), { z: 0.25, x: 500, y: 250 });
  assert.deepEqual(overflows(box, nat, 1), { x: true, y: true });
  assert.deepEqual(overflows({ w: 1836, h: 952 }, { w: 2321, h: 2722 }, 1812 / 2321), { x: false, y: true }, "content exactly the frame's inner width fits");
});

test("zoomAround keeps the picture's point under the pointer unless the clamp moves it", () => {
  const box = { w: 1000, h: 800 }, nat = { w: 2000, h: 2000 }, v = { z: 1, x: -300, y: -400 };
  const z = zoomAround(box, nat, v, 1.5, 400, 300);
  near((400 - z.x) / z.z, (400 - v.x) / v.z, "x under the pointer");
  near((300 - z.y) / z.z, (300 - v.y) / v.z, "y under the pointer");
  assert.deepEqual(zoomAround(box, nat, { z: 1, x: 12, y: 12 }, 2, 0, 0), { z: 2, x: 24, y: 24 }, "the corner of the frame keeps its point, the picture's edge may move in");
  assert.deepEqual(zoomAround(box, nat, { z: 1, x: -1500, y: 0 }, 0.5, 0, 0), { z: 0.5, x: -500, y: 0 }, "x is moved by the clamp, y is not");
});

test("zoomStep: the ladder with the frame's own z0 and zMin in it, nothing past the ends", () => {
  const z0 = 0.7807, zMin = 0.3409;
  assert.equal(zoomStep(z0, 1, z0, zMin), 1);
  assert.equal(zoomStep(z0, -1, z0, zMin), 0.75);
  assert.equal(zoomStep(0.5, -1, z0, zMin), zMin);
  assert.equal(zoomStep(zMin, -1, z0, zMin), zMin, "nothing below zMin");
  assert.equal(zoomStep(0.76, 1, z0, zMin), z0);
  assert.equal(zoomStep(2, 1, z0, zMin), 2, "nothing past 200 %");
  assert.equal(zoomStep(1.5, 1, z0, zMin), 2);
  assert.deepEqual([canZoom(zMin, -1, zMin), canZoom(zMin, 1, zMin), canZoom(2, 1, zMin), canZoom(2, -1, zMin)], [false, true, false, true]);
});

test("the − % + group: each cell by geometry, nothing around it; it stays on the page while the frame's top is above it", () => {
  const w = 1000, top = 8, left = w - 8 - 102;
  assert.equal(frameTool(left + 5, top + 10, w, top), "out");
  assert.equal(frameTool(left + 27 + 24, top + 10, w, top), "pct");
  assert.equal(frameTool(left + 27 + 48 + 10, top + 10, w, top), "in");
  for (const [x, y] of [[left - 1, top + 10], [w - 8, top + 10], [left + 5, top - 1], [left + 5, top + 26]]) assert.equal(frameTool(x, y, w, top), null, `${x},${y}`);
  assert.equal(toolsTop(952, 100), 8);
  assert.equal(toolsTop(952, -300), 324, "24 px below the top of the page");
  assert.equal(toolsTop(952, -2000), 952 - 34, "never below the frame");
});

test("sharpScale: typical diagrams get 4x, the stress diagram 2.5x inside the 40 MP budget; a huge one nothing above its base; a bigger app zoom asks for more", () => {
  assert.equal(sharpScale({ w: 552, h: 58 }, 1), 4);
  assert.equal(sharpScale({ w: 800, h: 400 }, 1), 4);
  assert.equal(sharpScale({ w: 2321, h: 2722 }, 1), 2.5, "39.5 MP");
  assert.ok(sharpScale({ w: 9000, h: 9000 }, 1) < 2 + 0.5, "not clearly above a 2x base, so none is asked for");
  assert.equal(sharpScale({ w: 552, h: 58 }, 1.5), 6);
});

test("wheel gestures: a trackpad's start or a pause begins one; a sideways pan needs 8 px clearly more sideways than down", () => {
  assert.equal(startsGesture(null, "moved", 0), true);
  assert.equal(startsGesture({ at: 1000 }, "moved", 1100), false);
  assert.equal(startsGesture({ at: 1000 }, "moved", 1151), true);
  assert.equal(startsGesture({ at: 1000 }, "started", 1001), true);
  assert.equal(decideAxis(1, 0), null, "finger jitter decides nothing");
  assert.equal(decideAxis(1, 7), "y");
  assert.equal(decideAxis(5, 3), "y", "not twice as sideways");
  assert.equal(decideAxis(-9, 4), "x");
  assert.equal(decideAxis(40, 0), "x", "a sideways notch at once");
});

test("passThrough: reading down through a tall frame is reading a picture laid out at its full height", () => {
  const viewH = 1000, h = 952, minY = 952 - 12 - 2125, maxY = 12, maxOff = 5000;
  let r = passThrough({ down: 400, offset: 1000, maxOffset: maxOff, top: 500, h, viewH, y: maxY, minY, maxY });
  assert.deepEqual(r, { offset: 1400, y: maxY }, "a frame 500 px down the pane: all of it to the page while the frame comes up");
  r = passThrough({ down: 100, offset: 1400, maxOffset: maxOff, top: 100, h, viewH, y: maxY, minY, maxY });
  assert.deepEqual(r, { offset: 1476, y: maxY - 24 }, "76 to the page, which brings the frame's top to 24, the rest pans");
  r = passThrough({ down: 2000, offset: 1476, maxOffset: maxOff, top: 24, h, viewH, y: maxY - 24, minY, maxY });
  assert.deepEqual(r, { offset: 1476 + 2000 - 1173, y: minY }, "1197 px of pan in all, then the page again");
  r = passThrough({ down: 50, offset: 2303, maxOffset: maxOff, top: 24 - 827, h, viewH, y: minY, minY, maxY });
  assert.deepEqual(r, { offset: 2353, y: minY }, "a frame passed is left as it is");
  r = passThrough({ down: -1000, offset: 2303, maxOffset: maxOff, top: 24 - 827, h, viewH, y: minY, minY, maxY });
  assert.deepEqual(r, { offset: 1476, y: minY + 173 }, "up, the mirror: the frame comes down to 24, then the picture pans");
  r = passThrough({ down: -1100, offset: 1476, maxOffset: maxOff, top: 24, h, viewH, y: minY + 173, minY, maxY });
  assert.deepEqual(r, { offset: 1476 - 76, y: maxY }, "back to the picture's top, then the page");
  r = passThrough({ down: -50, offset: 1000, maxOffset: maxOff, top: 500, h, viewH, y: maxY, minY, maxY });
  assert.deepEqual(r, { offset: 950, y: maxY }, "a frame below, going up: the page");
});

test("passThrough: a frame fully on screen pans even with an edge inside the 24 px band; one partly off screen is passed", () => {
  const viewH = 1000, h = 952, minY = 952 - 12 - 2125, maxY = 12;
  let r = passThrough({ down: 50, offset: 1000, maxOffset: 5000, top: 10, h, viewH, y: maxY, minY, maxY });
  assert.deepEqual(r, { offset: 1000, y: maxY - 50 }, "its top 10 px down the pane, as Page Down may leave it");
  r = passThrough({ down: -50, offset: 1000, maxOffset: 5000, top: viewH - 10 - h, h, viewH, y: minY, minY, maxY });
  assert.deepEqual(r, { offset: 1000, y: minY + 50 }, "its bottom 10 px above the pane's bottom");
  r = passThrough({ down: 50, offset: 1000, maxOffset: 5000, top: -1, h, viewH, y: maxY, minY, maxY });
  assert.deepEqual(r, { offset: 1050, y: maxY }, "1 px above the pane, going down");
  r = passThrough({ down: -50, offset: 1000, maxOffset: 5000, top: viewH + 1 - h, h, viewH, y: minY, minY, maxY });
  assert.deepEqual(r, { offset: 950, y: minY }, "1 px below the pane, going up");
});

test("passThrough: at the ends of the page the picture still pans, and nothing is trapped", () => {
  const viewH = 1000, h = 952, minY = 952 - 12 - 2125, maxY = 12;
  let r = passThrough({ down: 10, offset: 0, maxOffset: 3000, top: 28, h, viewH, y: maxY, minY, maxY });
  assert.deepEqual(r, { offset: 4, y: maxY - 6 }, "the first block, its top at 28: the page moves the 4 px that bring it fully into view first");
  r = passThrough({ down: -10, offset: 4, maxOffset: 3000, top: 24, h, viewH, y: maxY - 6, minY, maxY });
  assert.deepEqual(r, { offset: 0, y: maxY }, "6 back to the picture, 4 to the page");
  r = passThrough({ down: 30, offset: 500, maxOffset: 500, top: 30, h: 600, viewH, y: maxY, minY: 600 - 12 - 2125, maxY });
  assert.deepEqual(r, { offset: 500, y: maxY - 30 }, "the page cannot move at all: the picture takes the step");
  r = passThrough({ down: 30, offset: 500, maxOffset: 500, top: 30, h: 600, viewH, y: 600 - 12 - 2125, minY: 600 - 12 - 2125, maxY });
  assert.deepEqual(r, { offset: 500, y: 600 - 12 - 2125 }, "both at their ends: the step goes nowhere");
});

test("passThrough: a frame the page has passed still pans when the page is at its end", () => {
  const viewH = 1000, h = 952, minY = 952 - 12 - 2125, maxY = 12;
  let r = passThrough({ down: -40, offset: 0, maxOffset: 3000, top: 109, h, viewH, y: maxY - 300, minY, maxY });
  assert.deepEqual(r, { offset: 0, y: maxY - 260 }, "top of the page, the frame's bottom below the pane, going up: the picture");
  r = passThrough({ down: -40, offset: 10, maxOffset: 3000, top: 99, h, viewH, y: maxY - 300, minY, maxY });
  assert.deepEqual(r, { offset: 0, y: maxY - 270 }, "the page goes its last 10 px, the picture takes the other 30");
  r = passThrough({ down: 40, offset: 3000, maxOffset: 3000, top: -112, h, viewH, y: maxY, minY, maxY });
  assert.deepEqual(r, { offset: 3000, y: maxY - 40 }, "end of the page, the frame's top above the pane, going down: the picture");
  r = passThrough({ down: 40, offset: 2990, maxOffset: 3000, top: -102, h, viewH, y: maxY, minY, maxY });
  assert.deepEqual(r, { offset: 3000, y: maxY - 30 }, "the page goes its last 10 px, the picture takes the other 30");
});

test("the slash menu goes below the caret row when all twelve rows fit, above when only that fits, else on the larger side with as many rows as fit", () => {
  assert.deepEqual([menuH(12), menuH(1)], [384, 43]);
  assert.deepEqual(menuPlace({ rowTop: 100, rowH: 24, viewH: 600, n: 12 }), { side: "below", top: 130, h: 384, visible: 12 });
  assert.deepEqual(menuPlace({ rowTop: 500, rowH: 24, viewH: 600, n: 12 }), { side: "above", top: 500 - 6 - 384, h: 384, visible: 12 });
  assert.deepEqual(menuPlace({ rowTop: 100, rowH: 24, viewH: 300, n: 12 }), { side: "below", top: 130, h: 12 + 4 * 31, visible: 4 }, "162 px below, 86 above: four rows below");
  assert.deepEqual(menuPlace({ rowTop: 200, rowH: 24, viewH: 300, n: 12 }), { side: "above", top: 200 - 6 - (12 + 5 * 31), h: 12 + 5 * 31, visible: 5 }, "62 px below, 186 above: five rows above");
  assert.deepEqual(menuPlace({ rowTop: 10, rowH: 24, viewH: 60, n: 12 }), { side: "below", top: 40, h: 43, visible: 1 }, "never less than one row");
  assert.deepEqual(menuPlace({ rowTop: 100, rowH: 24, viewH: 600, n: 0 }), { side: "below", top: 130, h: 43, visible: 1 }, "No results is one row");
});

test("the slash menu keeps the side it opened on while the list shrinks; above, its bottom edge stays by the line", () => {
  const open = menuPlace({ rowTop: 400, rowH: 24, viewH: 600, n: 12 });
  assert.equal(open.side, "above", "162 px below, 386 above: all twelve fit only above");
  for (const n of [12, 3, 1, 0]) {
    const p = menuPlace({ rowTop: 400, rowH: 24, viewH: 600, n, side: open.side });
    assert.equal(p.side, "above", `${n} rows`);
    assert.equal(p.top + p.h, 400 - 6, `${n} rows: the bottom edge 6 px above the row`);
    assert.equal(p.h, menuH(Math.max(1, n)));
  }
  const kept = menuPlace({ rowTop: 100, rowH: 24, viewH: 600, n: 2, side: "above" });
  assert.deepEqual([kept.side, kept.top + kept.h], ["above", 94], "a side given is kept, though below would fit now");
  const below = menuPlace({ rowTop: 100, rowH: 24, viewH: 600, n: 2, side: "below" });
  assert.equal(below.top, 130, "below, the top stays under the row");
});

test("the slash menu's left edge is the field's left at offset 0, follows the slash's estimated column mid-line, and stays inside the column", () => {
  const left = columnLeft(900), base = { advance: 7, fieldW: 500, fieldX: 24, viewW: 900 };
  assert.equal(left, 92);
  assert.equal(slashX({ ...base, col: 0 }), 92 + 24, "at offset 0: the field's left");
  assert.equal(slashX({ ...base, col: 10 }), 92 + 24 + 70, "ten characters in");
  assert.equal(slashX({ ...base, col: 100 }), 92 + 24 + 200, "past a wrap: the column inside the row");
  assert.equal(slashX({ ...base, col: 80, fieldW: 700 }), 900 - MENU.w - 8, "kept inside the pane on the right");
  assert.equal(slashX({ ...base, col: 0, fieldX: 0, viewW: 1600 }), columnLeft(1600), "the column's left in a wide pane");
  assert.equal(slashX({ ...base, col: 0, fieldX: 0, viewW: 290 }), 290 - MENU.w - 8, "a pane narrower than column and menu: the menu stays in the pane");
});

const BAR_AT = { rowH: 24, col: 0, advance: 7, fieldW: 500, fieldX: 24, viewW: 900, viewH: 600, n: 5 };

test("the format bar is five square buttons in a bordered strip", () => {
  assert.deepEqual(barSize(5), { w: 5 * BAR.button + 2 * BAR.pad + 2, h: BAR.button + 2 * BAR.pad + 2 });
  assert.deepEqual(barSize(6).w - barSize(5).w, BAR.button, "a sixth button widens it by one");
});

test("the format bar goes over the selection's first row, its left edge at the selection's start column", () => {
  const { w, h } = barSize(5);
  assert.deepEqual(barPlace({ ...BAR_AT, firstTop: 200, lastTop: 248 }), { side: "above", top: 200 - BAR.gap - h, left: 92 + 24, w, h });
  assert.equal(barPlace({ ...BAR_AT, firstTop: 200, lastTop: 200, col: 10 }).left, 92 + 24 + 70, "ten characters in");
  assert.equal(barPlace({ ...BAR_AT, firstTop: 200, lastTop: 200, col: 100 }).left, 92 + 24 + 200, "past a wrap: the column inside the row");
  const tight = BAR.margin + BAR.gap + h;
  assert.equal(barPlace({ ...BAR_AT, firstTop: tight, lastTop: tight }).side, "above", "just room above, 8 px from the pane's top");
});

test("the format bar goes under the selection's last row when there is no room above its first, kept inside the pane", () => {
  const { h } = barSize(5), tight = BAR.margin + BAR.gap + h;
  assert.deepEqual(barPlace({ ...BAR_AT, firstTop: tight - 1, lastTop: tight - 1 }), { ...barPlace({ ...BAR_AT, firstTop: 200, lastTop: 200 }), side: "below", top: tight - 1 + 24 + BAR.gap });
  assert.equal(barPlace({ ...BAR_AT, firstTop: 28, lastTop: 76 }).top, 76 + 24 + BAR.gap, "under the last of three rows");
  assert.equal(barPlace({ ...BAR_AT, firstTop: -100, lastTop: 20 }).top, 20 + 24 + BAR.gap, "the first row scrolled off the top");
  assert.equal(barPlace({ ...BAR_AT, firstTop: 10, lastTop: 570 }).top, 600 - BAR.margin - h, "a selection as tall as the pane: the bar stays 8 px over its bottom");
});

test("the format bar stays inside the pane at both sides", () => {
  const { w } = barSize(5);
  assert.equal(barPlace({ ...BAR_AT, firstTop: 200, lastTop: 200, col: 95, fieldW: 700 }).left, 900 - BAR.margin - w, "on the right");
  assert.equal(barPlace({ ...BAR_AT, firstTop: 200, lastTop: 200, fieldX: 0, viewW: 1600 }).left, columnLeft(1600), "the column's left in a wide pane");
  assert.equal(barPlace({ ...BAR_AT, firstTop: 200, lastTop: 200, viewW: w + 10 }).left, BAR.margin, "a pane narrower than the bar and its margins: on the left");
});

test("the format bar is hidden while the row it goes by is out of the pane", () => {
  assert.equal(barPlace({ ...BAR_AT, firstTop: 600, lastTop: 648 }), null, "the selection below the pane");
  assert.equal(barPlace({ ...BAR_AT, firstTop: -200, lastTop: -24 }), null, "the selection above the pane");
  assert.equal(barPlace({ ...BAR_AT, firstTop: 10, lastTop: 620 }), null, "no room over the first row, the last one below the pane");
  assert.equal(barPlace({ ...BAR_AT, firstTop: -200, lastTop: -23 }).side, "below", "a pixel of the last row in the pane");
});

const ok = (natW, natH) => ({ state: "ok", natW, natH });
const pending = { state: "pending", natW: 0, natH: 0 };
const failed = { state: "error", natW: 0, natH: 0 };

test("pictureLayout: no pictures take no room", () => {
  assert.deepEqual(pictureLayout([], 700), { boxes: [], height: 0 });
});

test("pictureLayout: a picture keeps its own size, shrinks to the width, and is never enlarged", () => {
  assert.deepEqual(pictureLayout([ok(200, 100)], 700), { boxes: [{ x: 0, y: 0, w: 200, h: 100 }], height: 100 });
  assert.deepEqual(pictureLayout([ok(1600, 900)], 800), { boxes: [{ x: 0, y: 0, w: 800, h: 450 }], height: 450 });
  assert.deepEqual(pictureLayout([ok(10, 10)], 700), { boxes: [{ x: 0, y: 0, w: 10, h: 10 }], height: 10 });
  assert.deepEqual(pictureLayout([ok(700, 20)], 700).boxes, [{ x: 0, y: 0, w: 700, h: 20 }], "exactly the width");
});

test("pictureLayout: a shrunk picture's height is rounded, its width never undershoots the column", () => {
  assert.deepEqual(pictureLayout([ok(1000, 333)], 300).boxes, [{ x: 0, y: 0, w: 300, h: 100 }]);
  for (const [natW, width] of [[49, 7], [147, 21], [1234, 617], [3000, 1001]]) assert.equal(pictureLayout([ok(natW, 5)], width).boxes[0].w, width, `${natW} into ${width}`);
});

test("pictureLayout: a picture is at least 1 px each way", () => {
  assert.deepEqual(pictureLayout([ok(1, 1)], 700).boxes, [{ x: 0, y: 0, w: 1, h: 1 }]);
  assert.deepEqual(pictureLayout([ok(5000, 1)], 100).boxes, [{ x: 0, y: 0, w: 100, h: 1 }], "a hairline stays one pixel high");
});

test("pictureLayout: pictures that fit side by side share a row, a gap apart", () => {
  const layout = pictureLayout(Array.from({ length: 5 }, () => ok(90, 20)), 700);
  assert.deepEqual(layout.boxes.map(b => [b.x, b.y]), [[0, 0], [98, 0], [196, 0], [294, 0], [392, 0]]);
  assert.equal(PICTURE.gap, 8);
  assert.equal(layout.height, 20);
});

test("pictureLayout: a picture that no longer fits starts a new row, a gap below the tallest of the one above", () => {
  const layout = pictureLayout([ok(300, 100), ok(300, 60), ok(300, 40), ok(100, 10)], 700);
  assert.deepEqual(layout.boxes, [
    { x: 0, y: 0, w: 300, h: 100 }, { x: 308, y: 0, w: 300, h: 60 },
    { x: 0, y: 108, w: 300, h: 40 }, { x: 308, y: 108, w: 100, h: 10 },
  ]);
  assert.equal(layout.height, 148);
});

test("pictureLayout: a picture that ends exactly at the width stays in the row; one pixel more wraps", () => {
  assert.deepEqual(pictureLayout([ok(296, 10), ok(296, 10)], 600).boxes.map(b => [b.x, b.y]), [[0, 0], [304, 0]]);
  assert.deepEqual(pictureLayout([ok(296, 10), ok(297, 10)], 600).boxes.map(b => [b.x, b.y]), [[0, 0], [0, 18]]);
});

test("pictureLayout: a picture as wide as the column fills its row, and what comes after starts the next", () => {
  const layout = pictureLayout([ok(900, 50), ok(20, 20), ok(20, 20)], 600);
  assert.deepEqual(layout.boxes.map(b => [b.x, b.y, b.w, b.h]), [[0, 0, 600, 33], [0, 41, 20, 20], [28, 41, 20, 20]]);
});

test("pictureLayout: a picture that is not ready (pending, failed, or no size) is a box of the column's width and boxH high", () => {
  assert.equal(PICTURE.boxH, 40);
  assert.deepEqual(pictureLayout([pending], 300), { boxes: [{ x: 0, y: 0, w: 300, h: 40 }], height: 40 });
  assert.deepEqual(pictureLayout([failed], 300).boxes, [{ x: 0, y: 0, w: 300, h: 40 }]);
  assert.deepEqual(pictureLayout([ok(0, 10)], 300).boxes, [{ x: 0, y: 0, w: 300, h: 40 }]);
  assert.deepEqual(pictureLayout([{ state: "pending", natW: 50, natH: 50 }], 300).boxes, [{ x: 0, y: 0, w: 300, h: 40 }], "a size on a pending picture is not used");
});

test("pictureLayout: ready, pending and failed pictures mixed", () => {
  const layout = pictureLayout([ok(100, 50), pending, failed, ok(40, 30), ok(40, 30)], 300);
  assert.deepEqual(layout.boxes, [
    { x: 0, y: 0, w: 100, h: 50 },
    { x: 0, y: 58, w: 300, h: 40 },
    { x: 0, y: 106, w: 300, h: 40 },
    { x: 0, y: 154, w: 40, h: 30 },
    { x: 48, y: 154, w: 40, h: 30 },
  ]);
  assert.equal(layout.height, 184);
});

test("pictureLayout: the shrink is by the whole column, not by what is left in the row", () => {
  const layout = pictureLayout([ok(200, 100), ok(1000, 500)], 400);
  assert.deepEqual(layout.boxes, [{ x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 108, w: 400, h: 200 }]);
});
