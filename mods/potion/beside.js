import { exec, spaces, panes } from "herdr";

// Mods get no pane geometry, so the split tree comes from the core's "herdr-app" document, which Herdr does not
// document: when it can't be read or doesn't match the panes on screen, the pane opens right of the anchor.
const READ_DOC = 'printf "%s\\n" "$1" | hc connect';
const ALONG = { row: "right", column: "down" };
const ACROSS = { row: "down", column: "right" };

// The tab's newest corner: the last pane down the tree, split across its row or column (along it when alone there),
// so new panes spiral inward and the first pane keeps its size.
export function spiralSpot(root) {
  let parent = null, node = root;
  while (node?.type !== "block") {
    if (!node?.children?.length) return null;
    parent = node;
    node = node.children.at(-1);
  }
  const kind = parent?.type === "column" ? "column" : "row";
  return { pane: node.id, direction: (parent?.children.length ?? 0) > 1 ? ACROSS[kind] : ALONG[kind] };
}

// `anchor` is a pane of panes(); the spot is in its tab. Another machine's ids carry its name as a prefix here only.
export async function besideSpot(anchor) {
  const machine = spaces().find(s => s.tabs.some(t => t.id === anchor.tab))?.machine ?? null;
  const prefix = machine ? `${machine}/` : "";
  const ask = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doc.get", params: { name: "herdr-app", on: machine } });
  try {
    const r = await exec("sh", ["-c", READ_DOC, "beside", ask], { timeout: 5000 });
    const doc = JSON.parse(r.stdout.split("\n")[0]).result?.value;
    const tab = doc?.spaces?.flatMap(s => s.tabs ?? []).find(t => prefix + t.id === anchor.tab);
    const spot = spiralSpot(tab?.root);
    const pane = spot && prefix + spot.pane;
    if (pane && panes().some(p => p.tab === anchor.tab && p.pane === pane)) return { pane, direction: spot.direction };
  } catch {}
  return { pane: anchor.pane, direction: "right" };
}
