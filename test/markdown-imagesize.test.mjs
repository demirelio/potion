import test from "node:test";
import assert from "node:assert/strict";
import { sniffImage } from "../mods/herdr-inline-markdown/imagesize.js";

import { ascii, u32le, bytes, png, gif, bmp, riff, vp8, vp8l, vp8x, segment, sof, jpeg } from "./pictures.mjs";

const text = source => bytes(source);

test("png: the size is in the IHDR chunk, big-endian", () => {
  assert.deepEqual(sniffImage(png(640, 480)), { type: "png", ext: "png", width: 640, height: 480 });
  assert.deepEqual(sniffImage(png(70000, 1)), { type: "png", ext: "png", width: 70000, height: 1 }, "wider than 16 bits");
});

test("jpeg: the size is in the first SOF marker, whichever kind of SOF it is", () => {
  assert.deepEqual(sniffImage(jpeg(1024, 768)), { type: "jpeg", ext: "jpg", width: 1024, height: 768 });
  for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
    assert.deepEqual(sniffImage(jpeg(300, 200, { marker })), { type: "jpeg", ext: "jpg", width: 300, height: 200 }, `SOF 0x${marker.toString(16)}`);
  }
});

test("jpeg: the walk skips other segments, fill bytes and standalone markers on the way to the SOF", () => {
  const dht = segment(0xc4, new Array(20).fill(7)), dac = segment(0xcc, [1, 2]), jpg = segment(0xc8, [1, 2, 3]);
  const before = [...dht, 0xff, 0xff, 0xff, ...segment(0xdb, new Array(65).fill(1)), 0xff, 0x01, 0xff, 0xd0, ...dac, ...jpg, 0xff, 0xff, ...segment(0xfe, ascii("comment"))];
  assert.deepEqual(sniffImage(jpeg(48, 32, { before })), { type: "jpeg", ext: "jpg", width: 48, height: 32 }, "C4, C8 and CC are not SOF markers");
});

test("jpeg: a picture that ends or starts its data before any SOF has no size", () => {
  assert.equal(sniffImage(bytes([0xff, 0xd8], segment(0xe0, [1, 2, 3]), [0xff, 0xd9])), null, "EOI first");
  assert.equal(sniffImage(bytes([0xff, 0xd8], segment(0xda, [0, 0]), sof(0xc0, 5, 5))), null, "the scan comes before the SOF");
  assert.equal(sniffImage(bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x01])), null, "a segment shorter than its own length field");
});

test("gif: both versions, little-endian size", () => {
  assert.deepEqual(sniffImage(gif(320, 200)), { type: "gif", ext: "gif", width: 320, height: 200 });
  assert.deepEqual(sniffImage(gif(1, 65535, "GIF87a")), { type: "gif", ext: "gif", width: 1, height: 65535 });
  assert.equal(sniffImage(gif(5, 5, "GIF90a")), null, "not a GIF version");
});

test("webp lossy (VP8 ): the 14 low bits of two little-endian u16", () => {
  assert.deepEqual(sniffImage(vp8(800, 600)), { type: "webp", ext: "webp", width: 800, height: 600 });
  assert.deepEqual(sniffImage(vp8(800, 600, 2)), { type: "webp", ext: "webp", width: 800, height: 600 }, "the scale bits are not size");
});

test("webp lossless (VP8L): two 14-bit fields packed after the signature byte, each one less than the size", () => {
  assert.deepEqual(sniffImage(vp8l(1, 1)), { type: "webp", ext: "webp", width: 1, height: 1 });
  assert.deepEqual(sniffImage(vp8l(16384, 9000)), { type: "webp", ext: "webp", width: 16384, height: 9000 });
});

test("webp extended (VP8X): 1 + a little-endian 24-bit canvas size", () => {
  assert.deepEqual(sniffImage(vp8x(100000, 3)), { type: "webp", ext: "webp", width: 100000, height: 3 });
  assert.equal(sniffImage(riff("ALPH", u32le(4), [0, 0, 0, 0], new Array(20).fill(0))), null, "a chunk that holds no size");
});

test("bmp: little-endian signed width and height; a negative height is a top-down picture", () => {
  assert.deepEqual(sniffImage(bmp(100, 50)), { type: "bmp", ext: "bmp", width: 100, height: 50 });
  assert.deepEqual(sniffImage(bmp(100, 0xfffffffe)), { type: "bmp", ext: "bmp", width: 100, height: 2 }, "-2");
  assert.equal(sniffImage(bmp(0xffffffff, 10)), null, "a negative width");
});

test("svg: the width and height attributes, in numbers or px, rounded to whole pixels and at least 1; a quoted > does not end the tag", () => {
  assert.deepEqual(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"></svg>')), { type: "svg", ext: "svg", width: 120, height: 60 });
  assert.deepEqual(sniffImage(text("<svg width='100px' height=\"50.5px\"/>")), { type: "svg", ext: "svg", width: 100, height: 51 });
  assert.deepEqual(sniffImage(text('<svg\n  xmlns="x"\n  width = "7"\n  height="9">')), { type: "svg", ext: "svg", width: 7, height: 9 });
  assert.deepEqual(sniffImage(text('<svg width="0.3" height="0.2">')), { type: "svg", ext: "svg", width: 1, height: 1 });
  assert.deepEqual(sniffImage(text('<svg width="10.4" height="10.5">')), { type: "svg", ext: "svg", width: 10, height: 11 });
  assert.deepEqual(sniffImage(text('<svg data-x="a>b" width="5" height="6">')), { type: "svg", ext: "svg", width: 5, height: 6 });
});

test("svg: a lone width or height takes the other from the viewBox's ratio; neither takes the viewBox's size", () => {
  assert.deepEqual(sniffImage(text('<svg width="400" viewBox="0 0 200 100">')), { type: "svg", ext: "svg", width: 400, height: 200 });
  assert.deepEqual(sniffImage(text('<svg height="50" viewBox="0 0 200 100">')), { type: "svg", ext: "svg", width: 100, height: 50 });
  assert.deepEqual(sniffImage(text('<svg viewBox="0 0 24 24">')), { type: "svg", ext: "svg", width: 24, height: 24 });
  assert.deepEqual(sniffImage(text('<svg viewBox="-5,-5, 90.5 , 45">')), { type: "svg", ext: "svg", width: 91, height: 45 }, "commas and spaces, any origin");
});

test("svg: %, em and the like are no size, so the viewBox decides, else 300 x 150", () => {
  assert.deepEqual(sniffImage(text('<svg width="100%" height="50%" viewBox="0 0 80 40">')), { type: "svg", ext: "svg", width: 80, height: 40 });
  assert.deepEqual(sniffImage(text('<svg width="2em" height="1ex">')), { type: "svg", ext: "svg", width: 300, height: 150 });
  assert.deepEqual(sniffImage(text("<svg>")), { type: "svg", ext: "svg", width: 300, height: 150 });
  assert.deepEqual(sniffImage(text('<svg width="10">')), { type: "svg", ext: "svg", width: 300, height: 150 }, "one side and no viewBox");
  assert.deepEqual(sniffImage(text('<svg viewBox="0 0 0 10">')), { type: "svg", ext: "svg", width: 300, height: 150 }, "a viewBox with no area");
});

test("svg: a byte order mark, blanks, an XML declaration, comments and a DOCTYPE may come before the svg tag", () => {
  const head = bytes([0xef, 0xbb, 0xbf], " \r\n\t", '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n', "<!-- made by <svg> tools -->\n",
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [ <!ENTITY a "b > c"> ]>\n', "<!-- again -->", '<svg width="11" height="22">');
  assert.deepEqual(sniffImage(head), { type: "svg", ext: "svg", width: 11, height: 22 });
});

test("svg: only the first 64 KB are looked at, and a first tag that is not svg is not an svg", () => {
  assert.equal(sniffImage(text(`<!--${"x".repeat(70000)}--><svg width="1" height="1">`)), null);
  assert.equal(sniffImage(text('<html><svg width="1" height="1"></html>')), null);
  assert.equal(sniffImage(text('<svgfoo width="1" height="1">')), null);
  assert.equal(sniffImage(text('<svg:svg width="1" height="1">')), null);
  assert.deepEqual(sniffImage(text(`<!--${"x".repeat(60000)}--><svg width="3" height="4">`)), { type: "svg", ext: "svg", width: 3, height: 4 });
});

test("a zero size, or one that is not a finite number, is no picture, in any format", () => {
  assert.equal(sniffImage(png(0, 10)), null);
  assert.equal(sniffImage(png(10, 0)), null);
  assert.equal(sniffImage(gif(0, 5)), null);
  assert.equal(sniffImage(bmp(5, 0)), null);
  assert.equal(sniffImage(jpeg(0, 5)), null);
  assert.equal(sniffImage(vp8(0, 5)), null);
  assert.equal(sniffImage(text('<svg width="0" height="10">')), null);
  assert.equal(sniffImage(text('<svg width="10" height="0">')), null);
  assert.equal(sniffImage(text(`<svg width="${"9".repeat(400)}" height="5">`)), null);
});

test("every format is null while a byte of its header is still missing", () => {
  const headers = { png: [png(5, 5), 24], gif: [gif(5, 5), 10], bmp: [bmp(5, 5), 26], vp8: [vp8(5, 5), 30], vp8l: [vp8l(5, 5), 25], vp8x: [vp8x(5, 5), 30] };
  for (const [name, [sample, need]] of Object.entries(headers)) {
    assert.ok(sniffImage(sample.slice(0, need)), `${name} whole header`);
    for (let n = 0; n < need; n++) assert.equal(sniffImage(sample.slice(0, n)), null, `${name} cut at ${n}`);
  }
  const jpg = jpeg(5, 5), end = jpg.indexOf(0xc0, 20) + 8;
  assert.ok(sniffImage(jpg.slice(0, end)), "jpeg up to the SOF's width");
  for (let n = 0; n < end; n++) assert.equal(sniffImage(jpg.slice(0, n)), null, `jpeg cut at ${n}`);
  assert.equal(sniffImage(text("<svg width=\"5\" height=\"5\"")), null, "svg whose tag never ends");
});

test("what is not a picture is null: nothing, text, an archive, a lone marker", () => {
  assert.equal(sniffImage(new Uint8Array(0)), null);
  assert.equal(sniffImage(null), null);
  assert.equal(sniffImage(undefined), null);
  assert.equal(sniffImage(text("hello, this is not a picture")), null);
  assert.equal(sniffImage(text("# Markdown\n\n![a](b.png)\n")), null);
  assert.equal(sniffImage(bytes("PK", [3, 4], new Array(40).fill(0))), null);
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8])), null);
  assert.equal(sniffImage(bytes("RIFF", u32le(0), "WAVE", new Array(30).fill(0))), null, "RIFF that is not WebP");
});

test("the kind is told by the bytes: the same picture in a view of a bigger buffer, or a Buffer, reads the same", () => {
  const picture = png(33, 44), padded = new Uint8Array(picture.length + 10);
  padded.set(picture, 7);
  assert.deepEqual(sniffImage(padded.subarray(7, 7 + picture.length)), { type: "png", ext: "png", width: 33, height: 44 });
  assert.deepEqual(sniffImage(Buffer.from(picture)), { type: "png", ext: "png", width: 33, height: 44 });
});
