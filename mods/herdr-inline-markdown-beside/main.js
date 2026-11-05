// The cmd-shift-m key of herdr-inline-markdown. A key reaches a mod through `mod.open`, which gives it no props but
// its overlay, so the Markdown mod can't tell a picker for a pane beside from one for a new tab: this mod, opened as
// an unseen popup, opens that picker and goes. With a picker open it closes that one instead, as cmd-m pressed again
// does. Mods can't import each other, so the dialog's spec and the shared key picker.js names it under are repeated.
import { View, div } from "gpui-kit";
import { props, shared, setShared, openOverlay, closeOverlay } from "herdr";

const PICKER = { mod: "herdr-inline-markdown", kind: "dialog", width: 560, height: 460, props: { action: "open", place: "pane" } };
const OPEN_PICKER = "herdr-inline-markdown.picker";

export default class Beside extends View {
  init(first, cx) {
    const { overlay } = props() ?? first ?? {};
    if (!overlay) return;
    // Init runs while Herdr is still making the copy for its overlay; Herdr's own menus close themselves and open a
    // dialog from a callback, in that order, so this waits for the first one.
    cx.timer.after(0, () => {
      closeOverlay(overlay);
      const open = shared(OPEN_PICKER);
      if (!open) {
        openOverlay(PICKER);
        return;
      }
      // Cleared here too: a name left by a quit would otherwise keep this key from ever opening a picker.
      setShared(OPEN_PICKER, null);
      try { closeOverlay(open); } catch {}
    });
  }

  render() {
    return div();
  }
}
