// The marks the format keys put around the selection of a text block's field, or take off it. No imports.

const SPACE = /\s/;
const WORD_BEFORE = /[\p{L}\p{M}\p{N}\p{Pc}]+$/u, WORD_AFTER = /^[\p{L}\p{M}\p{N}\p{Pc}]+/u;
const ADDRESS = /^(?:https?:\/\/|mailto:)[^\s<>]+$/i;
const LINK = /!?\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
const BACKTICKS = /`+/g;

const clampTo = (value, x) => Math.max(0, Math.min(value.length, Number(x) || 0));
const caretAt = (value, at) => ({ value, start: at, end: at });

const runBefore = (s, at, ch) => {
  let i = at;
  while (i > 0 && s[i - 1] === ch) i--;
  return at - i;
};
const runAfter = (s, at, ch) => {
  let i = at;
  while (i < s.length && s[i] === ch) i++;
  return i - at;
};

// A mark next to a space is no mark (`** text**` is not bold), so the spaces at the ends stay outside.
function trimmed(value, start, end) {
  let s = start, e = end;
  while (s < e && SPACE.test(value[s])) s++;
  while (e > s && SPACE.test(value[e - 1])) e--;
  return s === e ? { start, end: start } : { start: s, end: e };
}

// -> the word holding offset `at`, null when `at` is not inside one.
export function wordAround(value, at) {
  const before = WORD_BEFORE.exec(value.slice(0, at))?.[0].length ?? 0, after = WORD_AFTER.exec(value.slice(at))?.[0].length ?? 0;
  return before && after ? { start: at - before, end: at + after } : null;
}

const wrap = (value, { start, end }, open, close = open) => ({
  value: value.slice(0, start) + open + value.slice(start, end) + close + value.slice(end),
  start: start + open.length,
  end: end + open.length,
});

// `takes(n)`: how many of a run of n `ch` beside the text are this mark, 0 when the run is not it. The run on each side
// counts the marks inside the selection with those outside it, and the ones inside go first.
function paired(value, { start, end }, mark, takes) {
  const ch = mark[0], text = value.slice(start, end), lead = runAfter(text, 0, ch), onlyMarks = lead === text.length;
  const inStart = onlyMarks ? 0 : lead, inEnd = onlyMarks ? 0 : runBefore(text, text.length, ch);
  const k = takes(runBefore(value, start, ch) + inStart);
  if (!k || takes(inEnd + runAfter(value, end, ch)) !== k) return wrap(value, { start, end }, mark);
  const fromStart = Math.min(inStart, k), fromEnd = Math.min(inEnd, k), kept = text.slice(fromStart, text.length - fromEnd);
  const at = start - (k - fromStart);
  return { value: value.slice(0, at) + kept + value.slice(end + k - fromEnd), start: at, end: at + kept.length };
}

// Code spans as CommonMark finds them: a backtick run up to the next run of the same length. `from` and `to` bound the
// content less the space that pads both of its ends.
function codeSpans(value) {
  const runs = [...value.matchAll(BACKTICKS)].map(m => ({ at: m.index, n: m[0].length })), spans = [];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i], j = runs.findIndex((r, k) => k > i && r.n === open.n);
    if (j < 0) continue;
    const close = runs[j], content = value.slice(open.at + open.n, close.at);
    const pad = content.length > 1 && content[0] === " " && content.at(-1) === " " && content.trim() ? 1 : 0;
    spans.push({ start: open.at, end: close.at + close.n, from: open.at + open.n + pad, to: close.at - pad });
    i = j;
  }
  return spans;
}

const longestRun = text => (text.match(BACKTICKS) ?? []).reduce((n, run) => Math.max(n, run.length), 0);

function fence(value, sel) {
  const text = value.slice(sel.start, sel.end), ticks = "`".repeat(longestRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return wrap(value, sel, ticks + pad, pad + ticks);
}

const unfence = (value, span, from, to) => ({
  value: value.slice(0, span.start) + value.slice(from, to) + value.slice(span.end),
  start: span.start,
  end: span.start + to - from,
});

function code(value, sel) {
  const { start, end } = sel;
  if (start === end) {
    const n = runBefore(value, start, "`");
    return n && runAfter(value, end, "`") === n ? caretAt(value.slice(0, start - n) + value.slice(end + n), start - n) : fence(value, sel);
  }
  for (const span of codeSpans(value)) {
    if (span.from === start && span.to === end) return unfence(value, span, start, end);
    if (span.start === start && span.end === end) return unfence(value, span, span.from, span.to);
  }
  return fence(value, sel);
}

const balanced = s => {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
};

// A link destination holds parentheses only in balanced pairs, unless it is written in <>.
function addressIn(clipboard) {
  const text = typeof clipboard === "string" ? clipboard.trim() : "";
  if (!ADDRESS.test(text)) return "";
  return balanced(text) ? text : `<${text}>`;
}

// A caret at a link's edge is outside it. A picture is not a link: it can be linked.
const inLink = (value, { start, end }) => [...value.matchAll(LINK)].some(m => {
  const from = m.index, to = from + m[0].length;
  if (m[0][0] === "!") return false;
  return start === end ? start > from && start < to : start >= from && end <= to;
});

function link(value, sel, clipboard) {
  if (inLink(value, sel)) return null;
  const address = addressIn(clipboard), text = value.slice(sel.start, sel.end);
  const out = wrap(value, sel, "[", `](${address})`).value;
  if (!text) return caretAt(out, sel.start + 1);
  return caretAt(out, sel.start + text.length + (address ? address.length + 4 : 3));
}

const MARKS = {
  bold: (value, sel) => paired(value, sel, "**", n => (n === 2 || n === 3 ? 2 : 0)),
  italic: (value, sel) => paired(value, sel, "*", n => (n === 1 || n === 3 ? 1 : 0)),
  strike: (value, sel) => paired(value, sel, "~~", n => (n === 1 || n === 2 ? n : 0)),
  code,
  link,
};

// `mark`: "bold" | "italic" | "strike" | "code" | "link". `range`: the field's selection, in UTF-16 offsets of `value`.
// `clipboard`: its text, which a link takes as its address when that is one web or mail address.
// -> { value, start, end }, the field's value and selection after the key, or null when nothing changes. A caret in a
// word acts on the word and keeps its place in it; a caret elsewhere writes an empty mark, or takes one away.
export function toggleMark(value, range, mark, clipboard = "") {
  const toggle = MARKS[mark];
  if (!toggle) return null;
  const a = clampTo(value, range?.start), b = clampTo(value, range?.end);
  const sel = trimmed(value, Math.min(a, b), Math.max(a, b));
  const word = sel.start === sel.end ? wordAround(value, sel.start) : null;
  const out = toggle(value, word ?? sel, clipboard);
  if (!out || !word || mark === "link") return out;
  return caretAt(out.value, out.start + sel.start - word.start);
}

// Whether `mark` is on the selection already: its key would take it off, or, for a link, change nothing.
export function hasMark(value, range, mark) {
  if (!MARKS[mark]) return false;
  const out = toggleMark(value, range, mark);
  return mark === "link" ? out === null : out.value.length < value.length;
}
