// The colours the editor draws formatting in, taken from the theme so light and dark themes both work. No imports.

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Mixed a quarter into a dark page (#191919) this gives the owner's reference highlight, #4a3b20.
const OCHRE = "#dca136";
const OCHRE_SHARE = 0.25, DEEP_SHARE = 0.45;
const DARK_PAGE = "#191919";

// The text colours a selection can take, each from a theme's ANSI colour, with one for a theme that lacks it.
export const TEXT_COLORS = ["red", "yellow", "green", "teal", "purple"];
const ANSI = { red: "ansi1", yellow: "ansi3", green: "ansi2", teal: "ansi6", purple: "ansi5" };
const FALLBACK = { red: "#e06c75", yellow: "#e5c07b", green: "#98c379", teal: "#56b6c2", purple: "#c678dd" };

// A colour as [r, g, b], any alpha of its own left out; null when it is not a hex colour.
function channels(color) {
  const hex = HEX.exec(String(color ?? "").trim())?.[1];
  if (!hex) return null;
  const full = hex.length <= 4 ? [...hex.slice(0, 3)].map(ch => ch + ch).join("") : hex.slice(0, 6);
  return [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16));
}

const hexOf = rgb => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

// Ochre mixed `share` into a grey as light as the theme's page, not into the page itself, because a blue page
// (cobalt2) turns the mix olive.
function ochreOver(t, share) {
  const [r, g, b] = channels(t?.background) ?? channels(DARK_PAGE), ochre = channels(OCHRE);
  const grey = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return hexOf(ochre.map(v => grey * (1 - share) + v * share));
}

// Comments and highlights with no colour of their own: an opaque ochre, quiet on the theme's page.
export const highlightColor = t => ochreOver(t, OCHRE_SHARE);

// The comment being looked at, edited or written: the same ochre, deeper.
export const deepHighlightColor = t => ochreOver(t, DEEP_SHARE);

// What a text colour `name` draws in: one of TEXT_COLORS from theme `t`, or a hex colour as it is; null for any other.
export function textColor(t, name) {
  const value = String(name ?? "");
  if (HEX.test(value)) return value;
  if (!ANSI[value]) return null;
  const themed = channels(t?.[ANSI[value]]);
  return themed ? hexOf(themed) : FALLBACK[value];
}
