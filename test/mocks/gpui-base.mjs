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

// set_value() and replace() fire no "change" unless fields are live. replace() takes the whole value until
// set_selected_range() gives a selection, then replaces it and leaves the caret after what it wrote.
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
    return state;
  }
  value() { return this.text; }
  set_value(next) {
    this.text = typeof next === "string" ? next : String(next?.text ?? "");
    this.selection = live ? { start: 0, end: 0 } : null;
    this.undos = [];
    this.log.push(["set_value", this.text]);
  }
  set_selected_range(range) {
    const clamp = v => Math.max(0, Math.min(this.text.length, Number(v) || 0));
    const start = clamp(range?.start), end = clamp(range?.end);
    this.selection = { start: Math.min(start, end), end: Math.max(start, end) };
    this.log.push(["set_selected_range", { ...this.selection }]);
  }
  // Read only: no log entry, no undo, no event. Before any selection the whole value counts as selected, as
  // replace() takes it.
  selected_range() { return { ...(this.selection ?? { start: 0, end: this.text.length }) }; }
  replace(text) {
    const s = String(text), before = this.text;
    this.log.push(["replace", s]);
    if (!this.selection) this.text = s;
    else {
      const { start, end } = this.selection;
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
  release() { return true; }
  edit(text, cx) {
    if (text !== this.text) this.undos.push(this.text);
    this.text = text;
    return this.handlers.change?.({}, cx);
  }
  // A click, a drag or an arrow key: nothing is reported to the mod.
  select(start, end = start) { this.selection = { start: Math.min(start, end), end: Math.max(start, end) }; }
  // Types over the selection (at the end when there is none); with live fields the change comes after the current handler.
  type(text, cx) {
    const { start, end } = this.selection ?? { start: this.text.length, end: this.text.length };
    this.undos.push(this.text);
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    this.selection = { start: start + text.length, end: start + text.length };
    if (live) { const at = live.cx; setImmediate(() => this.handlers.change?.({}, at)); return undefined; }
    return this.handlers.change?.({}, cx);
  }
  undo(cx) {
    if (!this.undos.length) return undefined;
    this.text = this.undos.pop();
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
  html: (id, html) => makeElement("textview", { id: String(id), html }),
  markdown: (id, markdown) => makeElement("textview", { id: String(id), markdown }),
};
