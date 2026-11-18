// gpui-base as the mods import it: flex containers, text fields, and the rich-text and code views.
import { makeElement } from "./element.mjs";

export const h_flex = () => makeElement("h_flex");
export const v_flex = () => makeElement("v_flex");

export class EditorState {
  static new(options) {
    const state = new EditorState();
    state.options = options;
    state.released = false;
    state.text = options?.value ?? "";
    state.handlers = {};
    return state;
  }
  value() { return this.text; }
  set_value(next) { this.text = String(next); }
  on(event, handler) { this.handlers[event] = handler; return true; }
  release() { this.released = true; }
}
export const Editor = { new: state => makeElement("editor", { state }) };

// Live fields (liveFields(true, cx)): replace() emits its "change" as Herdr does, after the handler that called it
// has returned (a setImmediate, which the tests' flush() waits for), to the change handler with `cx`.
let live = null;
export function liveFields(on, cx = null) { live = on ? { cx } : null; }
// Herdr's set_value with tokens reports no change; echoTokenSets(true) makes live fields report one, as a Herdr that did.
let echo = false;
export function echoTokenSets(on) { echo = on; }

// Herdr refuses a token whose text or label holds one.
const CONTROL = /[\p{Cc}\u{2028}\u{2029}]/u;
const graphemes = new Intl.Segmenter();
const lastGrapheme = s => [...graphemes.segment(s)].at(-1)?.segment ?? "";
const firstGrapheme = s => graphemes.segment(s).containing(0)?.segment ?? "";

// Inline tokens as Herdr's field keeps them: set_value with { text, tokens } validates them against the text or throws,
// edits move the tokens after them and drop one they cut through, and a selection set inside a token goes to its edges
// (a caret to its end). Grapheme edges are not checked.
function checkedTokens(text, spans) {
  const out = [...(spans ?? [])].map(s => ({ range: { start: s.range.start, end: s.range.end }, token: { ...s.token } }))
    .sort((a, b) => a.range.start - b.range.start);
  let past = 0;
  for (const { range: { start, end }, token } of out) {
    if (!(start >= past && start < end && end <= text.length)) throw new Error("token range is out of bounds or overlaps another");
    if (text.slice(start, end) !== token.text) throw new Error("token text does not match its range");
    if (!String(token.id ?? "").trim() || !token.text || !token.label || CONTROL.test(token.text) || CONTROL.test(token.label)) {
      throw new Error("token requires a nonempty ID, text and label without control characters");
    }
    past = end;
  }
  return out;
}

// The change between two texts as the range [at, at + removed) of `a` that `inserted` characters replaced.
function changeOf(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { at: p, removed: a.length - p - q, inserted: b.length - p - q };
}

// set_value() and replace() fire no "change" unless fields are live; set_value() fires none even then, unless
// echoTokenSets(true) and it sets tokens. replace() takes the whole value until set_selected_range() gives a selection,
// then replaces it and leaves the caret after what it wrote.
class TextState {
  static new(options = {}) {
    const state = new this();
    state.options = options;
    state.text = options.value ?? "";
    state.focused = false;
    state.handlers = {};
    state.selection = null;
    state.log = [];
    state.undos = [];
    state.spans = [];
    return state;
  }
  value() { return this.text; }
  set_value(next) {
    const content = typeof next === "string" ? null : next, text = content ? String(content?.text ?? "") : next;
    const spans = content ? checkedTokens(text, content.tokens) : [];
    this.text = text;
    this.spans = spans;
    this.selection = live ? { start: 0, end: 0 } : null;
    this.undos = [];
    this.log.push(["set_value", this.text]);
    if (content && echo && live) {
      const cx = live.cx;
      setImmediate(() => this.handlers.change?.({}, cx));
    }
  }
  tokens() { return this.spans.map(s => ({ range: { ...s.range }, token: { ...s.token } })); }
  content() { return { text: this.text, tokens: this.tokens() }; }
  edgeOf(x, toStart) {
    const t = this.spans.find(s => s.range.start < x && x < s.range.end);
    return t ? (toStart ? t.range.start : t.range.end) : x;
  }
  selectionOf(a, b) {
    const start = Math.min(a, b), end = Math.max(a, b);
    if (start === end) {
      const at = this.edgeOf(start, false);
      return { start: at, end: at };
    }
    return { start: this.edgeOf(start, true), end: this.edgeOf(end, false) };
  }
  moveTokens(at, removed, inserted) {
    const end = at + removed, shift = inserted - removed;
    this.spans = this.spans.filter(s => !(s.range.start < end && at < s.range.end))
      .map(s => (s.range.start >= end ? { range: { start: s.range.start + shift, end: s.range.end + shift }, token: s.token } : s));
  }
  retext(text) {
    const c = changeOf(this.text, text);
    this.moveTokens(c.at, c.removed, c.inserted);
    this.text = text;
  }
  set_selected_range(range) {
    const clamp = v => Math.max(0, Math.min(this.text.length, Number(v) || 0));
    this.selection = this.selectionOf(clamp(range?.start), clamp(range?.end));
    this.log.push(["set_selected_range", { ...this.selection }]);
  }
  // Read only: no log entry, no undo, no event. Before any selection the whole value counts as selected, as
  // replace() takes it.
  selected_range() { return { ...(this.selection ?? { start: 0, end: this.text.length }) }; }
  replace(text) {
    const s = String(text), before = this.text;
    this.log.push(["replace", s]);
    if (!this.selection) this.retext(s);
    else {
      const { start, end } = this.selection;
      this.moveTokens(start, end - start, s.length);
      this.text = this.text.slice(0, start) + s + this.text.slice(end);
      this.selection = { start: start + s.length, end: start + s.length };
    }
    if (this.text !== before) this.undos.push(before);
    if (live) {
      const cx = live.cx;
      setImmediate(() => this.handlers.change?.({}, cx));
    }
  }
  focus() {
    const was = this.focused;
    this.focused = true;
    if (live && !was) setImmediate(() => this.handlers.focus?.({}, live.cx));
  }
  blur(cx) {
    this.focused = false;
    return this.handlers.blur?.({}, cx);
  }
  on(event, handler) { this.handlers[event] = handler; return true; }
  release() { this.releases = (this.releases ?? 0) + 1; this.released = true; return true; }
  edit(text, cx) {
    if (text !== this.text) this.undos.push(this.text);
    this.retext(text);
    return this.handlers.change?.({}, cx);
  }
  // A click, a drag or an arrow key: nothing is reported to the mod. The caret never stops inside a token.
  select(start, end = start) { this.selection = this.selectionOf(start, end); }
  // Types over the selection (at the end when there is none); with live fields the change comes after the current handler.
  type(text, cx) {
    const { start, end } = this.selection ?? { start: this.text.length, end: this.text.length };
    this.undos.push(this.text);
    this.moveTokens(start, end - start, text.length);
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    this.selection = { start: start + text.length, end: start + text.length };
    return this.report(cx);
  }
  // Backspace and Delete as Herdr's field does them: a selection goes; at a caret, back to the previous boundary (on to
  // the next), the start (end) of a token holding the character before (after) the caret, else that character. At the
  // start Backspace does nothing (the key table takes it); at the end Delete reports a change that leaves the value.
  backspace(cx) {
    const { start, end } = this.selection ?? { start: this.text.length, end: this.text.length };
    if (start === end) {
      if (start === 0) return undefined;
      const t = this.spans.find(s => s.range.start < start && start <= s.range.end);
      this.selection = { start: t ? t.range.start : start - lastGrapheme(this.text.slice(0, start)).length, end: start };
    }
    return this.type("", cx);
  }
  delete(cx) {
    const { start, end } = this.selection ?? { start: this.text.length, end: this.text.length };
    if (start === end) {
      if (start === this.text.length) return this.report(cx);
      const t = this.spans.find(s => s.range.start <= start && start < s.range.end);
      this.selection = { start, end: t ? t.range.end : start + firstGrapheme(this.text.slice(start)).length };
    }
    return this.type("", cx);
  }
  report(cx) {
    if (live) { const at = live.cx; setImmediate(() => this.handlers.change?.({}, at)); return undefined; }
    return this.handlers.change?.({}, cx);
  }
  undo(cx) {
    if (!this.undos.length) return undefined;
    this.retext(this.undos.pop());
    const n = this.text.length;
    if (this.selection) this.selection = { start: Math.min(this.selection.start, n), end: Math.min(this.selection.end, n) };
    return this.handlers.change?.({}, cx);
  }
  submit(cx) { return this.handlers.submit?.({}, cx); }
}
export class InputState extends TextState {}
export class TextareaState extends TextState {
  set_rows(rows) { this.options = { ...this.options, rows }; }
  set_auto_grow() {}
  set_soft_wrap() {}
}
export const Input = { new: state => makeElement("input", { state }) };
export const Textarea = { new: state => makeElement("textarea", { state }) };

export const TextView = {
  markdown: (id, markdown) => makeElement("textview", { id: String(id), markdown }),
};
