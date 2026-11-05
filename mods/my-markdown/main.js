// Markdown: one mod, three roles. A pane shows one file (editor.js: read it as a page, or edit its source); the same
// mod opened as a dialog (props.action === "open") is the picker that finds or makes the file (picker.js), and as a
// popup (props.action === "menu") it is the right-click menu of a file in a list (menu.js).
import { View } from "gpui-kit";
import { props as current } from "herdr";
import { Editor } from "./editor.js";
import { Menu } from "./menu.js";
import { Picker } from "./picker.js";

export default class Markdown extends View {
  init(first, cx) {
    const p = current() ?? first ?? {};
    this.role = p.action === "open" ? new Picker() : p.action === "menu" ? new Menu() : new Editor();
    return this.role.init(p, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }

  async close(cx) {
    await this.role.close?.(cx);
  }
}
