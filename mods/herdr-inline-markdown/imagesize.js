// The kind and size of a picture, read from its first bytes, never from its name. No imports.

const SVG_WINDOW = 64 * 1024;
const SVG_DEFAULT = [300, 150];

const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const u32le = (b, i) => i32le(b, i) >>> 0;
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const startsWith = (b, at, text) => [...text].every((c, k) => b[at + k] === c.charCodeAt(0));

const found = (type, ext, width, height) => (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
  ? { type, ext, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
  : null);

// Each reader answers undefined when the bytes are not its kind, null when they are but give no size.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(b) {
  if (!PNG_SIGNATURE.every((v, i) => b[i] === v)) return undefined;
  return b.length >= 24 ? found("png", "png", u32be(b, 16), u32be(b, 20)) : null;
}

const isSof = marker => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
const isStandalone = marker => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);

function readJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++;
    const marker = b[i++];
    if (marker === undefined || marker === 0xd9) return null;
    if (isStandalone(marker)) continue;
    if (i + 2 > b.length) return null;
    if (isSof(marker)) return i + 7 <= b.length ? found("jpeg", "jpg", u16be(b, i + 5), u16be(b, i + 3)) : null;
    const length = u16be(b, i);
    if (marker === 0xda || length < 2) return null;
    i += length;
  }
  return null;
}

function readGif(b) {
  if (!startsWith(b, 0, "GIF87a") && !startsWith(b, 0, "GIF89a")) return undefined;
  return b.length >= 10 ? found("gif", "gif", u16le(b, 6), u16le(b, 8)) : null;
}

function readWebp(b) {
  if (!startsWith(b, 0, "RIFF") || !startsWith(b, 8, "WEBP")) return undefined;
  if (startsWith(b, 12, "VP8 ")) return b.length >= 30 ? found("webp", "webp", u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff) : null;
  if (startsWith(b, 12, "VP8L")) {
    if (b.length < 25) return null;
    const packed = u32le(b, 21);
    return found("webp", "webp", (packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }
  if (startsWith(b, 12, "VP8X")) return b.length >= 30 ? found("webp", "webp", 1 + u24le(b, 24), 1 + u24le(b, 27)) : null;
  return null;
}

function readBmp(b) {
  if (b[0] !== 0x42 || b[1] !== 0x4d) return undefined;
  return b.length >= 26 ? found("bmp", "bmp", i32le(b, 18), Math.abs(i32le(b, 22))) : null;
}

const latin1 = (b, length) => {
  let text = "";
  for (let i = 0; i < length; i += 8192) text += String.fromCharCode.apply(null, b.subarray(i, Math.min(length, i + 8192)));
  return text;
};

const UTF8_BOM_AS_LATIN1 = "ï»¿";
const SVG_PROLOG = /\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>/iy;
const SVG_TAG = /<svg(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ATTRIBUTE = /([^\s=/"'>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PLAIN_LENGTH = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(?:px)?\s*$/i;

const lengthOf = value => {
  const m = PLAIN_LENGTH.exec(value ?? "");
  return m ? Number(m[1]) : null;
};

const viewBoxOf = value => {
  const n = String(value ?? "").trim().split(/[\s,]+/).map(Number);
  return n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? { w: n[2], h: n[3] } : null;
};

function svgSize(attributes) {
  const w = lengthOf(attributes.get("width")), h = lengthOf(attributes.get("height")), box = viewBoxOf(attributes.get("viewBox"));
  if (w !== null && h !== null) return [w, h];
  if (box && w !== null) return [w, (w * box.h) / box.w];
  if (box && h !== null) return [(h * box.w) / box.h, h];
  return box ? [box.w, box.h] : SVG_DEFAULT;
}

function readSvg(b) {
  const text = latin1(b, Math.min(b.length, SVG_WINDOW));
  let at = text.startsWith(UTF8_BOM_AS_LATIN1) ? UTF8_BOM_AS_LATIN1.length : 0;
  SVG_PROLOG.lastIndex = at;
  while (SVG_PROLOG.exec(text)) at = SVG_PROLOG.lastIndex;
  SVG_TAG.lastIndex = at;
  const tag = SVG_TAG.exec(text);
  if (!tag) return null;
  const attributes = new Map([...tag[1].matchAll(ATTRIBUTE)].map(m => [m[1], m[2] ?? m[3]]));
  return found("svg", "svg", ...svgSize(attributes));
}

const READERS = [readPng, readJpeg, readGif, readWebp, readBmp, readSvg];

// bytes: Uint8Array. -> { type, ext, width, height } (type: png, jpeg, gif, webp, bmp, svg; `ext` is its file extension;
// the size in whole pixels), or null for anything else, a truncated file, or a size that is zero or not finite.
export function sniffImage(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  for (const read of READERS) {
    const size = read(bytes);
    if (size !== undefined) return size;
  }
  return null;
}
