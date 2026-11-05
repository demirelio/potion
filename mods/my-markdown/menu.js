// The popup behind a right click on a markdown file in a file list: one row, "Open as new tab". main.js starts this
// class instead of the editor when the popup's props say action "menu" ({ file, machine, space }).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, closeOverlay } from "herdr";
import { openMarkdown } from "./open.js";

export class Menu {
  init(initProps, cx) {
    this.fallback = initProps ?? {};
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  current() {
    return props() ?? this.fallback;
  }

  dismiss() {
    closeOverlay(this.current().overlay);
  }

  openTab() {
    const { file, machine, space } = this.current();
    this.dismiss();
    openMarkdown({ file, machine: machine ?? null, place: "tab", space });
  }

  render() {
    const t = theme();
    return v_flex().id("md-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down(e => {
        if (e.key === "enter") this.openTab();
        else if (e.key === "escape") this.dismiss();
      })
      .child(h_flex().id("md-menu-tab").h(31).flex_none().px(8).gap(9).rounded(7).items_center().text_color(t.foreground).bg(t.selected)
        .on_click(() => this.openTab())
        .child(svg("mods/my-markdown/plus.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child("Open as new tab")));
  }
}

export default Menu;
