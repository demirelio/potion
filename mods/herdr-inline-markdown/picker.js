// The dialog behind the Markdown shortcuts and the "Markdown" row of the + menu: find a markdown file in a folder, or
// make one, and open it beside the focused pane (props.place "pane") or in a tab (place "tab"). main.js starts this
// class instead of the editor when the dialog's props say action "open" ({ place, space, folder, machine }), or when
// `mod.open` gave it none (a tab, in the active space). Without a folder it looks where the person is: the folder of
// the Markdown file the focused pane shows, else that pane's folder, else the space's.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, props, shared, setShared, settings, theme, readTextFile, writeTextFile, closeOverlay, focused, panes, spaces } from "herdr";
import { FIND_SCRIPT, basename, dirname, filterFiles, joinPath, markdownPathsFromFind, markdownPathsFromGit, newFileName, normalizePath, tildePath, uniqueName } from "./lib.js";
import { openMarkdown } from "./open.js";

// A picker that opens closes the one named here, so one is open at a time; the cmd-shift-m mod reads it to close the
// picker it opened itself. Shared state is persisted, so a name left by a quit is of an overlay Herdr no longer has.
const OPEN_PICKER = "herdr-inline-markdown.picker";
const ROW = 32, ROOM = 8; // a row's height; how many fit before the list has measured itself
const HINTS = {
  pane: "↑↓ to move · ↵ to open beside · esc to close",
  tab: "↑↓ to move · ↵ to open in a new tab · esc to close",
};
const why = e => String(e?.message ?? e);
const clamp = (n, low, high) => Math.max(low, Math.min(n, high));

// The registry's "<machine>:<path>" for a pane, as { machine, path }; only an absolute path counts.
function fileOf(key) {
  const at = typeof key === "string" ? key.indexOf(":") : -1;
  return at >= 0 && key.startsWith("/", at + 1) ? { machine: key.slice(0, at) || null, path: key.slice(at + 1) } : null;
}

export class Picker {
  init(initProps, cx) {
    const p = props() ?? initProps ?? {};
    this.overlay = p.overlay ?? null;
    this.takeOver();
    this.place = p.place === "pane" ? "pane" : "tab";
    this.anchor = focused()?.pane ?? null;
    this.space = p.space ?? spaces().find(s => s.active)?.id;
    const start = p.folder ? { folder: p.folder, machine: p.machine || null } : p.machine ? { folder: "", machine: p.machine } : this.around();
    this.machine = start.machine;
    this.folder = start.folder ? normalizePath(start.folder) : this.machine ? "" : normalizePath(home());
    this.home = this.machine ? null : home();
    // A snapshot: the dialog is short-lived, and shared() hands out a new copy on every call.
    const recent = shared("herdr-inline-markdown.recent");
    this.recent = (Array.isArray(recent) ? recent : []).filter(r => r && typeof r.path === "string" && (r.machine ?? null) === this.machine);
    this.files = [];
    this.loading = true; this.failure = null; this.problem = null; this.busy = false; this.closed = false;
    this.query = ""; this.at = null; this.scroll = 0; this.listHeight = null;

    this.input = InputState.new({ placeholder: "Find or create a markdown file…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value(); this.at = null; this.scroll = 0; this.problem = null;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => { const rows = this.rows(); this.choose(rows[this.cursor(rows)], cx); });
    this.input.focus();
    this.refocus = cx.timer.after(600, () => { if (!this.closed) this.input.focus(); });
    this.handle = cx.focus_handle();

    // Creating a file waits for the listing: the name it picks has to be free.
    this.ready = new Promise(done => cx.spawn(async cx => {
      try { await this.load(); } catch (e) { this.failure = why(e); }
      this.loading = false;
      done();
      if (!this.closed) cx.notify();
    }));
  }

  close() {
    this.closed = true;
    this.refocus?.cancel();
    // close() comes after the overlay has gone, so the picker that took this one's place may already be named.
    if (this.overlay && shared(OPEN_PICKER) === this.overlay) setShared(OPEN_PICKER, null);
  }

  takeOver() {
    if (!this.overlay) return;
    const other = shared(OPEN_PICKER);
    setShared(OPEN_PICKER, this.overlay);
    if (other && other !== this.overlay) try { closeOverlay(other); } catch {}
  }

  // --- Listing

  // Where the person is, when nobody said: the folder (and machine) of the file the focused Markdown pane shows,
  // else the focused pane's folder, else the space's. The space says which machine the other two are on.
  around() {
    const f = focused(), here = panes().find(p => p.pane === this.anchor), space = spaces().find(s => s.id === this.space);
    const file = here?.mod === "herdr-inline-markdown" ? fileOf(shared("herdr-inline-markdown.panes")?.[here.pane]) : null;
    if (file) return { folder: dirname(file.path), machine: file.machine };
    return { folder: here?.cwd || f?.cwd || space?.folder || "", machine: space?.machine ?? null };
  }

  // A remote machine's home is the folder when none was given, and what "~" means there.
  async findHome() {
    if (!this.machine) return home();
    try {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.machine });
      const path = r.stdout.trim();
      if (r.code === 0 && path.startsWith("/")) return path;
    } catch {}
    return null;
  }

  async load() {
    this.home = await this.findHome();
    if (!this.folder) {
      if (!this.home) throw new Error(`Can't reach ${this.machine}`);
      this.folder = normalizePath(this.home);
    }
    const { folder, machine: on } = this;
    try {
      // In a repository git knows the files (and leaves out what .gitignore does); anywhere else, look around.
      const r = await exec("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: folder, on });
      if (r.code === 0) { this.files = markdownPathsFromGit(r.stdout); return; }
    } catch {}
    const r = await exec("sh", ["-c", FIND_SCRIPT], { cwd: folder, on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Can't list this folder");
    this.files = markdownPathsFromFind(r.stdout);
  }

  // What can be picked: the recent files first (also those outside the folder), then the folder's files.
  // `path` is what the row shows and the query matches: relative to the folder when inside it, else with "~".
  entries() {
    const c = this.cache;
    if (c && c.files === this.files && c.folder === this.folder && c.home === this.home) return c;
    const { folder } = this, prefix = folder === "/" ? "/" : `${folder}/`, seen = new Set(), list = [];
    const add = (file, recent) => {
      if (seen.has(file)) return;
      seen.add(file);
      const inside = Boolean(folder) && file.startsWith(prefix);
      list.push({ file, path: inside ? file.slice(prefix.length) : tildePath(file, this.home), inside, recent });
    };
    for (const r of this.recent) add(r.path, true);
    if (folder) for (const path of this.files) add(joinPath(folder, path), false);
    this.cache = { files: this.files, folder, home: this.home, list, taken: new Set(list.filter(e => e.inside && !e.path.includes("/")).map(e => e.path)) };
    return this.cache;
  }

  // New note, then the matching files, then Create <name> unless the query already names a listed file.
  rows() {
    const { list } = this.entries(), query = this.query, c = this.shown;
    if (c && c.list === list && c.query === query) return c.rows;
    const rows = [{ id: "mdp-new", kind: "new" }];
    filterFiles(list, query).forEach((entry, i) => rows.push({ id: `mdp-file-${i}`, kind: "file", entry }));
    const named = query.trim() ? newFileName(query) : null;
    if (named?.name && !list.some(e => e.inside && e.path.toLowerCase() === named.name.toLowerCase())) rows.push({ id: "mdp-create", kind: "create", name: named.name });
    this.shown = { list, query, rows };
    return rows;
  }

  // The highlighted row. Until the person moves it, it is the best file (so Enter opens it), else Create, else New note.
  cursor(rows) {
    const first = rows.findIndex(r => r.kind === "file"), create = rows.findIndex(r => r.kind === "create");
    return clamp(this.at ?? (first >= 0 ? first : Math.max(create, 0)), 0, rows.length - 1);
  }

  status() {
    if (this.failure) return { text: `Can't list this folder: ${this.failure}`, bad: true };
    if (this.loading) return { text: "Looking for markdown files…" };
    if (!this.files.length && !this.query.trim()) return { text: "No markdown files here" };
    return null;
  }

  // Rows that fit in the list (the status line takes one of them).
  room() {
    return Math.max(1, Math.floor((this.listHeight ?? ROW * ROOM) / ROW) - (this.status() ? 1 : 0));
  }

  // --- Acting

  disabled(row) {
    return Boolean(this.machine) && row.kind !== "file";
  }

  choose(row, cx) {
    if (!row || this.disabled(row) || this.busy) return;
    if (row.kind === "file") this.open(row.entry.file);
    else this.make(row.kind === "create" ? row.name : null, cx);
  }

  // The dialog goes first: the file's pane or tab is what the person looks at next.
  open(file) {
    closeOverlay(this.overlay);
    openMarkdown({ file, machine: this.machine, place: this.place, space: this.space, pane: this.anchor });
  }

  // `name` null: a note called untitled.md (or the first free untitled-N.md). A file that already exists is just opened.
  make(name, cx) {
    this.busy = true;
    this.problem = null;
    cx.spawn(async cx => {
      try {
        await this.ready;
        const file = joinPath(this.folder, name ?? uniqueName(this.entries().taken));
        if (dirname(file) !== this.folder) {
          const r = await exec("mkdir", ["-p", dirname(file)]);
          if (r.code !== 0) throw new Error(r.stderr.trim() || "Can't make the folder");
        }
        try { await writeTextFile(file, "", null); }
        catch (e) {
          // Whatever the host says, a file that reads back is there already; anything else is for the person to see.
          const there = await readTextFile(file).catch(() => null);
          if (typeof there !== "string") throw e;
        }
        this.open(file);
      } catch (e) { this.problem = `Can't create ${name ?? "the note"}: ${why(e)}`; }
      this.busy = false;
      if (!this.closed) cx.notify();
    });
  }

  dismiss() {
    closeOverlay(this.overlay);
  }

  // Moves the highlight and the list with it, so it never runs off the visible rows.
  move(step) {
    const rows = this.rows(), at = (this.cursor(rows) + step + rows.length) % rows.length, room = this.room();
    let top = Math.floor(this.scroll / ROW);
    if (at < top) top = at;
    else if (at >= top + room) top = at - room + 1;
    this.at = at;
    this.scroll = top * ROW;
  }

  // --- Drawing

  row(t, row, on) {
    const off = this.disabled(row), file = row.kind === "file";
    const name = file ? basename(row.entry.path) : row.kind === "new" ? "New note" : `Create ${row.name}`;
    const dir = file && row.entry.path.includes("/") ? dirname(row.entry.path) : "";
    const hint = off ? `Creating files on ${this.machine} isn't supported yet` : row.kind === "new" ? uniqueName(this.entries().taken) : dir;
    return h_flex().id(row.id).h(ROW).flex_none().px(10).gap(10).items_center().rounded(7).text_color(off ? t.dim : t.foreground)
      .when(on, el => el.bg(t.selected))
      .when(!off, el => el.cursor_pointer().on_click((_e, cx) => this.choose(row, cx)))
      .when(off, el => el.cursor_default())
      // Hover only counts when the mouse moves: a list that scrolls under a still mouse must not take the highlight.
      .on_mouse_move((_e, cx) => {
        const rows = this.rows(), i = rows.indexOf(row);
        if (i < 0 || i === this.cursor(rows)) return;
        this.at = i;
        cx.notify();
      })
      .child(svg(file ? "mods/herdr-inline-markdown/markdown.svg" : "mods/herdr-inline-markdown/file-plus.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().max_w(320).truncate().font_semibold().child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(hint))
      .when(file && row.entry.recent, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("recent")));
  }

  render() {
    const t = theme(), rows = this.rows(), at = this.cursor(rows), status = this.status(), room = this.room();
    this.scroll = clamp(this.scroll, 0, Math.max(0, rows.length - room) * ROW);
    const top = Math.floor(this.scroll / ROW);
    // A name that can't be used is only worth a word when nothing matches the query either.
    const named = this.query.trim() && !rows.some(r => r.kind === "file") ? newFileName(this.query).error : null;
    const note = this.problem ?? named;
    const where = this.folder ? tildePath(this.folder, this.home) : "";
    return v_flex().id("mdp-root").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.dismiss();
        else if (e.key === "down") this.move(1);
        else if (e.key === "up") this.move(-1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(div().text_size(15).font_semibold().child("Markdown"))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/herdr-inline-markdown/search.svg").size(15).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(note), el => el.child(div().id("mdp-note").flex_none().text_size(12).text_color(this.problem ? t.blocked : t.dim).child(note)))
      .child(v_flex().id("mdp-list").flex_1().min_h(0).overflow_hidden()
        .on_size_change((size, cx) => {
          const height = size.height / settings().zoom;
          if (height === this.listHeight) return;
          this.listHeight = height;
          cx.notify();
        })
        .on_scroll_wheel((e, cx) => {
          this.scroll = clamp(this.scroll - e.delta.y, 0, Math.max(0, this.rows().length - this.room()) * ROW);
          cx.notify();
        })
        .children(rows.slice(top, top + room).map((row, i) => this.row(t, row, top + i === at)))
        .when(Boolean(status), el => el.child(div().id("mdp-status").h(ROW).flex_none().px(10).flex().items_center().text_size(12).text_color(status.bad ? t.blocked : t.dim).child(status.text))))
      .child(h_flex().id("mdp-footer").flex_none().gap(12).text_size(11).text_color(t.dim)
        .child(div().flex_none().child(HINTS[this.place]))
        .child(div().flex_1().min_w(0).truncate().text_right().child(this.machine && where ? `${this.machine}: ${where}` : where)));
  }
}

export default Picker;
