// `fs/promises` as a mod imports it, in memory: `files` maps a path to what was written there; a folder exists
// while a file is under it. Nothing touches disk. reset() in herdr.mjs empties it.

export const files = new Map();

export function resetFs() { files.clear(); }

const missing = path => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" });

export async function mkdir() {}
export async function rmdir() {}
export async function writeFile(path, contents) { files.set(path, contents); }
export async function readFile(path, encoding) {
  if (!files.has(path)) throw missing(path);
  const contents = files.get(path);
  return encoding ? String(contents) : contents;
}
export async function exists(path) { return files.has(path); }
export async function unlink(path) {
  if (!files.delete(path)) throw missing(path);
}
// What is directly in a folder: its files, and the folders files sit in further down. A file is not a folder.
export async function readdir(path) {
  const names = new Set([...files.keys()].filter(p => p.startsWith(`${path}/`)).map(p => p.slice(path.length + 1).split("/")[0]));
  if (!names.size) throw missing(path);
  return [...names];
}
