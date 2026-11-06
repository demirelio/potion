// Picture files built byte by byte, so the tests carry no binary fixtures. Each takes the size it should claim.

export const ascii = text => [...text].map(c => c.charCodeAt(0));
export const u16le = n => [n & 255, (n >> 8) & 255];
export const u16be = n => [(n >> 8) & 255, n & 255];
export const u24le = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
export const u32le = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
export const u32be = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
// Strings are ASCII, arrays are bytes.
export const bytes = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === "string" ? ascii(p) : p)));

export const png = (w, h) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(w), u32be(h), [8, 6, 0, 0, 0], u32be(0));
export const gif = (w, h, version = "GIF89a") => bytes(version, u16le(w), u16le(h), [0xf7, 0, 0]);
export const bmp = (w, h) => bytes("BM", u32le(0), u32le(0), u32le(54), u32le(40), u32le(w), u32le(h), u16le(1), u16le(24), u32le(0));
export const riff = (...chunk) => bytes("RIFF", u32le(0), "WEBP", ...chunk);
export const vp8 = (w, h, scale = 0) => riff("VP8 ", u32le(10), [0x30, 0x01, 0x00], [0x9d, 0x01, 0x2a], u16le(w | (scale << 14)), u16le(h | (scale << 14)));
export const vp8l = (w, h) => riff("VP8L", u32le(5), [0x2f], u32le((w - 1) | ((h - 1) << 14)));
export const vp8x = (w, h) => riff("VP8X", u32le(10), [0, 0, 0, 0], u24le(w - 1), u24le(h - 1));
export const segment = (marker, payload) => [0xff, marker, ...u16be(payload.length + 2), ...payload];
export const sof = (marker, w, h) => segment(marker, [8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
export const jpeg = (w, h, { marker = 0xc0, before = [] } = {}) => bytes([0xff, 0xd8], segment(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")), before, sof(marker, w, h), segment(0xda, [0, 0]));
export const svg = (w, h) => bytes(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"></svg>`);
