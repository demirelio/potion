// Merges the keys a package expects (its keys.json) into the person's keys.json, as Herdr's guide asks of a shared mod:
// add the keys that are missing, keep the ones they bound, replace one of theirs only when asked. The file is edited
// where it changes, never written again from its parsed value, so every other byte stays as the person left it.
//
//   node merge-keys.mjs <our keys.json> <their keys.json> <backup folder> [--replace]
//
// Prints a line a key. A changed file is copied into the backup folder first, then replaced in one rename (through a
// link, the file it points at). A file it can't merge is left alone and says why. Exits 0 when every key has our
// action afterwards, 2 when one does not (a key of theirs kept, or the file refused), 1 when it can't write.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

class Refusal extends Error {}

const SPACE = " \t\n\r";
const BOUND = 0, WRITE_FAILED = 1, NOT_BOUND = 2;

// One key however its modifiers are written: "shift-cmd-m" is "cmd-shift-m". A stroke may end in "-", its key ("cmd--").
export function chord(keys) {
  return keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "" && parts.length) { key = "-"; parts.pop(); }
    return [...parts.map(m => m.toLowerCase()).sort(), key].join("-");
  }).join(" ");
}

// Where things sit in `text`, which is valid JSON: each value's span, and for an object its members' keys and values.
function locate(text) {
  let at = 0;
  const space = () => { while (at < text.length && SPACE.includes(text[at])) at++; };
  const string = () => {
    const start = at++;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    return { start, end: ++at, name: JSON.parse(text.slice(start, at)) };
  };
  const value = () => {
    space();
    const start = at, open = text[at];
    if (open === "{" || open === "[") {
      const members = [];
      at++;
      space();
      while (text[at] !== (open === "{" ? "}" : "]")) {
        if (open === "{") {
          const key = string();
          space();
          at++;
          members.push({ key, value: value() });
        } else value();
        space();
        if (text[at] === ",") { at++; space(); }
      }
      at++;
      return open === "{" ? { start, end: at, members } : { start, end: at };
    }
    if (open === '"') return { start, end: string().end };
    while (at < text.length && !`,]}${SPACE}`.includes(text[at])) at++;
    return { start, end: at };
  };
  return value();
}

const lastOf = (list, test) => list.findLast(test) ?? null;
const indentAt = (text, at) => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", at - 1) + 1))[0];

// How the file writes an object: its line ending, one level of indent, and the text between a key and its value.
function styleOf(text, root) {
  const first = root.members[0];
  const memberIndent = first ? indentAt(text, first.key.start) : "";
  const multiline = first && text.slice(root.start, first.key.start).includes("\n");
  return {
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    unit: multiline && memberIndent.length > indentAt(text, root.start).length ? memberIndent.slice(indentAt(text, root.start).length) : "  ",
    colon: first ? text.slice(first.key.end, first.value.start) : ": ",
  };
}

// `entries` ([key, action] or [section, entries]) as an object: on one line, or one member a line under `indent`.
function objectText(entries, indent, inline, style) {
  const item = ([key, value], inner) => `${JSON.stringify(key)}${style.colon}${Array.isArray(value) ? objectText(value, inner, inline, style) : JSON.stringify(value)}`;
  if (inline) return `{ ${entries.map(e => item(e, indent)).join(", ")} }`;
  const inner = indent + style.unit;
  return `{${style.eol}${entries.map(e => inner + item(e, inner)).join(`,${style.eol}`)}${style.eol}${indent}}`;
}

// The edit that adds `entries` to `object`: after its last member, spaced as that member is from the one before; an
// empty object is written anew.
function addTo(text, object, entries, style) {
  const last = object.members.at(-1);
  if (!last) return { start: object.start, end: object.end, text: objectText(entries, indentAt(text, object.start), false, style) };
  let from = last.key.start;
  while (SPACE.includes(text[from - 1])) from--;
  const gap = text.slice(from, last.key.start), inline = !gap.includes("\n"), colon = text.slice(last.key.end, last.value.start);
  const indent = inline ? "" : gap.slice(gap.lastIndexOf("\n") + 1);
  const value = v => (Array.isArray(v) ? objectText(v, indent, inline, style) : JSON.stringify(v));
  return { start: last.value.end, end: last.value.end, text: entries.map(([key, v]) => `,${gap}${JSON.stringify(key)}${colon}${value(v)}`).join("") };
}

// `wanted` ({ section: { key: action } }) merged into the keys.json `text`; `bound`: every key has its action in the
// merged text. Throws a Refusal for a file it can't merge.
export function mergeKeys(text, wanted, { replace = false } = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Refusal(`it is not valid JSON (${e.message})`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Refusal("it is not an object");
  const root = locate(text), style = styleOf(text, root), edits = [], notes = [], sections = [];
  for (const [section, keys] of Object.entries(wanted)) {
    const node = lastOf(root.members, m => m.key.name === section)?.value ?? null;
    if (node && !node.members) throw new Refusal(`its "${section}" is not an object`);
    const missing = [];
    for (const [key, action] of Object.entries(keys)) {
      const hit = node && lastOf(node.members, m => chord(m.key.name) === chord(key));
      if (!hit) {
        missing.push([key, action]);
        notes.push({ section, key, as: key, action, outcome: "added" });
        continue;
      }
      const was = JSON.parse(text.slice(hit.value.start, hit.value.end)), note = { section, key, as: hit.key.name, action, was };
      if (was === action) notes.push({ ...note, outcome: "same" });
      else if (replace) {
        edits.push({ start: hit.value.start, end: hit.value.end, text: JSON.stringify(action) });
        notes.push({ ...note, outcome: "replaced" });
      } else notes.push({ ...note, outcome: "kept" });
    }
    if (missing.length && node) edits.push(addTo(text, node, missing, style));
    else if (missing.length) sections.push([section, missing]);
  }
  if (sections.length) edits.push(addTo(text, root, sections, style));
  edits.sort((a, b) => b.start - a.start);
  return { text: edits.reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), text), notes, bound: notes.every(n => n.outcome !== "kept") };
}

export function describe({ section, key, as = key, action, outcome, was }) {
  const name = section === "global" ? as : `${as} in "${section}"`, theirs = typeof was === "string" ? was : JSON.stringify(was);
  if (outcome === "added") return `keys: added ${name}: ${action}`;
  if (outcome === "same") return `keys: ${name} is already ${action}`;
  if (outcome === "replaced") return `keys: replaced ${name}: ${theirs} with ${action}`;
  return `keys: kept your ${name}: ${theirs} (./install.sh --replace-keys makes it ${action})`;
}

function main([ours, theirs, backup, ...flags]) {
  const wanted = JSON.parse(readFileSync(ours, "utf8")), file = realpathSync(theirs), before = readFileSync(file, "utf8");
  let merged;
  try { merged = mergeKeys(before, wanted, { replace: flags.includes("--replace") }); }
  catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.log(`keys: left ${theirs} alone: ${e.message}`);
    return NOT_BOUND;
  }
  for (const note of merged.notes) console.log(describe(note));
  const done = merged.bound ? BOUND : NOT_BOUND;
  if (merged.text === before) return done;
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`), saved = join(backup, "keys.json");
  try {
    writeFileSync(temp, merged.text);
    chmodSync(temp, statSync(file).mode & 0o7777);
    mkdirSync(backup, { recursive: true });
    copyFileSync(file, saved);
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    console.error(`keys: could not write ${theirs}: ${e.message}`);
    return WRITE_FAILED;
  }
  console.log(`keys: saved the previous keys.json as ${saved}`);
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
