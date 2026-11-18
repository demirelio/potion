import { View } from "gpui-kit";
import { props as current } from "herdr";
import { Editor } from "./editor.js";
import { Menu } from "./menu.js";
import { Picker } from "./picker.js";

// `mod.open` (the cmd-m key) shows the dialog with no props but the overlay's id: that is the picker for a new tab.
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
