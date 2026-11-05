// Markdown: one mod, three roles. A pane shows one file (editor.js: read it as a page, or edit its source); the same
// mod opened as a dialog (props.action === "open") is the picker that finds or makes the file (picker.js), and as a
// popup (props.action === "menu") it is the right-click menu of a file in a list (menu.js).
import { View } from "gpui-kit";
import { props as current } from "herdr";
import { Editor } from "./editor.js";
import { Menu } from "./menu.js";
import { Picker } from "./picker.js";

// `mod.open` (the cmd-m key) shows the mod as mod.json's dialog with no props but the overlay's id: that is the picker
// for a new tab.
const bareOverlay = p => p.overlay != null && p.action == null && p.file == null;

export default class Markdown extends View {
  init(first, cx) {
    const p = current() ?? first ?? {};
    this.role = p.action === "open" || bareOverlay(p) ? new Picker() : p.action === "menu" ? new Menu() : new Editor();
    return this.role.init(p, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }

  async close(cx) {
    await this.role.close?.(cx);
  }
}
