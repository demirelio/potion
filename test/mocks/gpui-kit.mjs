// gpui-kit as the mods import it: the View base class and the element factories.
import { makeElement } from "./element.mjs";

export class View {
  constructor(props) { this.initialProps = props; }
}
export const div = () => makeElement("div");
export const svg = path => makeElement("svg", { path });
export const image = path => makeElement("image", { path });
