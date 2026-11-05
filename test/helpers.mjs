// Shared test helpers: a fake cx and small data builders.
import { find, ids } from "./mocks/element.mjs";

// A cx like the one Herdr hands a callback. spawn() starts the body at once and keeps its promise;
// settle() waits until every task (and the tasks they started) has finished.
export function makeCx() {
  const tasks = [], cx = {
    notified: 0, stopped: 0, clipboard: [], timers: [], handles: [], opened: [],
    // Retained nested views made with new(), and the ones notify(entity) asked to redraw, in order.
    entities: [], notifiedEntities: [],
    notify(target) {
      if (target === undefined) cx.notified++;
      else {
        cx.notifiedEntities.push(target);
        if (target) target.drawn = null;
      }
    },
    // An entity as Herdr hands one back: its view is made and initialised now, and a test renders it with entity.cx.
    // `drawn` is what it rendered last (mocks/element.mjs keeps it until the entity is notified).
    new(Class, props) {
      const view = new Class(props);
      view.init?.(props, cx);
      const entity = {
        __entity: true, view, props, cx, released: false, drawn: null,
        set_props(next) { entity.props = next; entity.drawn = null; view.update?.(next); },
        release() { entity.released = true; return true; },
      };
      cx.entities.push(entity);
      return entity;
    },
    // Key bindings a mod installed, one list per bind_keys call; the answer is how many, as Herdr's.
    bound: [],
    bind_keys(list) { cx.bound.push(list); return list.length; },
    stop_propagation() { cx.stopped++; },
    propagate() {},
    // A test sets the clipboard through `clipboardText` or `held`; both work.
    clipboardText: undefined,
    write_to_clipboard(text) { cx.clipboard.push(text); cx.clipboardText = text; },
    // What the clipboard holds now: `clipboardText` (the last write, or text a test set), else the last text written,
    // else `held` (text a test put there beforehand).
    held: undefined,
    read_from_clipboard() { return cx.clipboardText ?? (cx.clipboard.length ? cx.clipboard.at(-1) : cx.held); },
    // The urls the mod asked to open in the browser.
    open_url(url) { cx.opened.push(url); },
    focus_handle() { const h = { focused: false, focus() { h.focused = true; } }; cx.handles.push(h); return h; },
    spawn(body) {
      let task;
      try { task = Promise.resolve(body(cx)); } catch (e) { task = Promise.reject(e); }
      tasks.push(task);
      return task;
    },
    // `every` and `after` are recorded, not run: a test calls `fn(cx)` itself when it wants the time to have passed
    // (fire_timers() below runs the `after` ones). Both hand back a task, as Herdr does; cancel() marks the entry.
    timer: {
      every(ms, fn) { return timerTask(cx.timers, { ms, fn }); },
      // A timer that waits is marked `once` and `after`; a test may look for either.
      after(ms, fn) { return timerTask(cx.timers, { ms, fn, once: true, after: true }); },
    },
    async settle() { while (tasks.length) await Promise.all(tasks.splice(0)); },
  };
  return cx;
}

function timerTask(timers, entry) {
  timers.push(entry);
  return { cancel() { entry.cancelled = true; }, is_done: () => Boolean(entry.cancelled || entry.ran) };
}

// Runs every `after` timer that is still waiting (not cancelled, not run yet), only those with `ms` when given, then
// waits for the tasks they started. A timer that sets another one has it run by the next call, not this one.
export async function fire_timers(cx, { ms } = {}) {
  const due = cx.timers.filter(t => t.once && !t.cancelled && !t.ran && (ms === undefined || t.ms === ms));
  for (const t of due) t.ran = true;
  await Promise.all(due.map(t => t.fn(cx)));
  await cx.settle();
}

export const space = (id, name, more = {}) => ({
  id, name, folder: "", machine: null, branch: null, active: false, status: null,
  tabs: [{ id: `${id}-tab`, name: "Main", active: true, zoomed: false, status: null }], ...more,
});
export const pane = (id, tab, cwd, more = {}) => ({ pane: id, terminal: `t-${id}`, tab, cwd, focused: false, ...more });

// The element for an id, failing loudly (with the ids that do exist) when it is missing.
export function must(el, id) {
  const found = find(el, id);
  if (!found) throw new Error(`no element ${id}; have: ${ids(el).join(", ")}`);
  return found;
}
