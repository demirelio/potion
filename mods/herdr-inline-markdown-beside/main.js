// The cmd-shift-m key of herdr-inline-markdown. A key reaches a mod through `mod.open`, which gives it no props but
// its overlay, so the Markdown mod can't tell a picker for a pane beside from one for a new tab: this mod, opened as
// an unseen popup, opens that picker and goes. Pressed again while the picker it opened is still open, it closes it,
// as cmd-m pressed again does; any other open picker gives way to the new one (picker.js closes it). Mods can't import
// each other, so the dialog's spec and the shared key picker.js names the open picker under are repeated.
import { View, div } from "gpui-kit";
import { props, shared, openOverlay, closeOverlay } from "herdr";

const PICKER = { mod: "herdr-inline-markdown", kind: "dialog", width: 560, height: 460, props: { action: "open", place: "pane" } };
const OPEN_PICKER = "herdr-inline-markdown.picker";

// Where this mod remembers the picker it opened last. Each copy of a mod gets its own module, but globalThis lasts as
// long as Herdr runs, so a picker that shared state still names after a quit (Herdr no longer has it, and closing it
// is no error) is never taken for an open one.
export const MEMORY = "herdrInlineMarkdownBeside";

export default class Beside extends View {
  init(first, cx) {
    const { overlay } = props() ?? first ?? {};
    if (!overlay) return;
    // Init runs while Herdr is still making the copy for its overlay; Herdr's own menus close themselves and open a
    // dialog from a callback, in that order, so this waits for the first one.
    cx.timer.after(0, () => {
      closeOverlay(overlay);
      const open = shared(OPEN_PICKER);
      const memory = (globalThis[MEMORY] ??= { opened: null });
      if (open && open === memory.opened) {
        memory.opened = null;
        try { closeOverlay(open); } catch {}
        return;
      }
      memory.opened = openOverlay(PICKER);
    });
  }

  render() {
    return div();
  }
}
