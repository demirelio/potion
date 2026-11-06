// `fs/promises` as a mod imports it, in memory: `files` maps a path to what was written there, and a folder exists
// while a file is under it.

export const files = new Map();
// What the mod asked for, in order: `readFile` and `writeFile` hold the path, `mkdir` the path and its options.
export const log = { readFile: [], writeFile: [], mkdir: [] };
// op -> (path -> the error that call rejects with); the path "*" is every path.
export const failing = { readFile: new Map(), writeFile: new Map(), readdir: new Map() };
// path -> a promise a read of it waits for, after it has taken what the file holds then.
const held = new Map();

export function resetFs() {
  files.clear();
  held.clear();
  for (const list of Object.values(log)) list.length = 0;
  for (const map of Object.values(failing)) map.clear();
}

// Reads of `path` wait until the returned function is called.
export function hold(path) {
  let release;
  held.set(path, new Promise(done => { release = done; }));
  return () => { held.delete(path); release(); };
}

const missing = path => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" });
const failure = (op, path) => failing[op].get(path) ?? failing[op].get("*");

export async function mkdir(path, options) { log.mkdir.push([path, options]); }
export async function rmdir() {}
export async function writeFile(path, contents) {
  log.writeFile.push(path);
  const error = failure("writeFile", path);
  if (error) throw error;
  files.set(path, contents);
}
export async function readFile(path, encoding) {
  log.readFile.push(path);
  const error = failure("readFile", path);
  if (error) throw error;
  if (!files.has(path)) throw missing(path);
  const contents = files.get(path), wait = held.get(path);
  if (wait) await wait;
  return encoding ? String(contents) : contents;
}
export async function exists(path) { return files.has(path); }
export async function unlink(path) {
  if (!files.delete(path)) throw missing(path);
}
// What is directly in a folder: its files, and the folders files sit in further down. A file is not a folder.
export async function readdir(path) {
  const error = failure("readdir", path);
  if (error) throw error;
  const names = new Set([...files.keys()].filter(p => p.startsWith(`${path}/`)).map(p => p.slice(path.length + 1).split("/")[0]));
  if (!names.size) throw missing(path);
  return [...names];
}
