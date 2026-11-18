import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, props, shared, setShared, settings, theme, readTextFile, writeTextFile, closeOverlay, focused, panes, spaces } from "herdr";
import { EXISTING_SCRIPT, FIND_SCRIPT, basename, dirname, existingFrom, fileKey, filterFiles, joinPath, markdownPathsFromFind, markdownPathsFromGit, newFileName, normalizePath, tildePath, uniqueName } from "./lib.js";
import { MOD, PANES, RECENT, openMarkdown } from "./open.js";
import { withAlpha } from "./colors.js";

// A picker that opens closes the one named here, so one is open at a time; the cmd-shift-m mod reads it to close the
// picker it opened itself. Shared state is persisted, so a name left by a quit is of an overlay Herdr no longer has.
const OPEN_PICKER = "potion.picker";
const ROW_H = 30, ROWS_BEFORE_MEASURED = 8, FIELD_H = 32, MAKER_H = 38;
const KEYS = {
  pane: [["↑↓", "move"], ["↵", "open beside"], ["esc", "close"]],
  tab: [["↑↓", "move"], ["↵", "open in a new tab"], ["esc", "close"]],
};
const ICON = name => `mods/potion/${name}.svg`;
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
    const recent = shared(RECENT);
    this.recent = (Array.isArray(recent) ? recent : []).filter(r => r && typeof r.path === "string" && (r.machine ?? null) === this.machine);
    this.openHere = this.openInTab();
    this.files = [];
    this.loading = true; this.failure = null; this.problem = null; this.busy = false; this.closed = false;
    this.query = ""; this.at = null; this.scroll = 0; this.listHeight = null;

    this.input = InputState.new({ placeholder: "Find or create a markdown file…" });
    this.input.on("change", (_e, cx) => this.typed(cx));
    this.input.on("submit", (_e, cx) => { const rows = this.rows(); this.choose(rows[this.cursor(rows)], cx); });
    this.input.focus();
    this.refocus = cx.timer.after(600, () => { if (!this.closed) this.input.focus(); });
    this.handle = cx.focus_handle();

    // Creating a file waits for the listing: the name it picks has to be free. The listing starts from the dialog's own
    // timer: the cmd-shift-m mod makes the dialog inside its timer and then closes, and Herdr never answers a call made
    // for a view that has gone (gpui-kit shell `async_function`), which would hang New note.
    this.ready = new Promise(done => cx.timer.after(0, cx => cx.spawn(async cx => {
      try { await this.load(); } catch (e) { this.failure = why(e); }
      this.loading = false;
      done();
      if (!this.closed) cx.notify();
    })));
  }

  typed(cx) {
    this.query = this.input.value(); this.at = null; this.scroll = 0; this.problem = null;
    cx.notify();
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

  // The folder of the file the focused Markdown pane shows, else the pane's, else the space's; the space says which
  // machine the last two are on.
  around() {
    const f = focused(), here = panes().find(p => p.pane === this.anchor), space = spaces().find(s => s.id === this.space);
    const file = here?.mod === MOD ? fileOf(shared(PANES)?.[here.pane]) : null;
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
    await Promise.all([this.list(), this.forgetGone()]);
  }

  async list() {
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

  // A recent file deleted since it was opened leaves the list, and the saved list, once its machine says so. The folder
  // listing can't tell: it leaves out the files git ignores. A machine that can't be asked keeps the list as it is.
  async forgetGone() {
    const paths = this.recent.map(r => r.path);
    if (!paths.length) return;
    let alive;
    try {
      const r = await exec("sh", ["-c", EXISTING_SCRIPT, "sh", ...paths], { on: this.machine });
      if (r.code !== 0) return;
      alive = existingFrom(r.stdout);
    } catch { return; }
    const gone = new Set(paths.filter(p => !alive.has(p)));
    if (!gone.size) return;
    this.recent = this.recent.filter(r => !gone.has(r.path));
    const saved = shared(RECENT);
    if (Array.isArray(saved)) setShared(RECENT, saved.filter(r => !(r && (r.machine ?? null) === this.machine && gone.has(r.path))));
  }

  // Recent files come first, also those outside the folder. `path` is what the row shows and the query matches:
  // relative to the folder when inside it, else with "~".
  entries() {
    const c = this.cache;
    if (c && c.files === this.files && c.recent === this.recent && c.folder === this.folder && c.home === this.home) return c;
    const { folder } = this, prefix = folder === "/" ? "/" : `${folder}/`, seen = new Set(), list = [];
    const add = (file, recent) => {
      if (seen.has(file)) return;
      seen.add(file);
      const inside = Boolean(folder) && file.startsWith(prefix);
      list.push({ file, path: inside ? file.slice(prefix.length) : tildePath(file, this.home), inside, recent });
    };
    for (const r of this.recent) add(r.path, true);
    if (folder) for (const path of this.files) add(joinPath(folder, path), false);
    this.cache = { files: this.files, recent: this.recent, folder, home: this.home, list, taken: new Set(list.filter(e => e.inside && !e.path.includes("/")).map(e => e.path)) };
    return this.cache;
  }

  // One row that makes a file comes first: New note with nothing typed, Create for a name no listed file has; none for
  // a name that is listed or can't be used.
  rows() {
    const { list } = this.entries(), query = this.query, c = this.shown;
    if (c && c.list === list && c.query === query) return c.rows;
    const named = query.trim() ? newFileName(query) : null, rows = [];
    if (!named) rows.push({ id: "mdp-new", kind: "new" });
    else if (named.name && !list.some(e => e.inside && e.path.toLowerCase() === named.name.toLowerCase())) rows.push({ id: "mdp-create", kind: "create", name: named.name });
    filterFiles(list, query).forEach((entry, i) => rows.push({ id: `mdp-file-${i}`, kind: "file", entry }));
    this.shown = { list, query, rows };
    return rows;
  }

  // The row that makes a file stays above the list: only the files scroll.
  split(rows) {
    const made = rows.length && rows[0].kind !== "file" ? 1 : 0;
    return { made, files: rows.slice(made) };
  }

  // The files shown in the focused tab's Markdown panes. Choosing one only goes to its pane, so Enter skips them.
  openInTab() {
    const known = shared(PANES) ?? {}, tab = focused()?.tab;
    return new Set(panes().filter(p => p.tab === tab && p.mod === MOD && known[p.pane]).map(p => known[p.pane]));
  }

  isOpenHere(file) {
    return this.openHere.has(fileKey(this.machine, file));
  }

  // Until the person moves it: the best file not already on screen (so Enter opens it), else any file, else the row
  // that makes one.
  cursor(rows) {
    const files = rows.flatMap((r, i) => (r.kind === "file" ? [i] : []));
    const first = files.find(i => !this.isOpenHere(rows[i].entry.file)) ?? files[0] ?? 0;
    return clamp(this.at ?? first, 0, Math.max(0, rows.length - 1));
  }

  status() {
    if (this.failure) return { text: `Can't list this folder: ${this.failure}`, bad: true };
    if (this.loading) return { text: "Looking for markdown files…" };
    if (!this.files.length && !this.query.trim()) return { text: "No markdown files here" };
    return null;
  }

  room() {
    return Math.max(1, Math.floor((this.listHeight ?? ROW_H * ROWS_BEFORE_MEASURED) / ROW_H) - (this.status() ? 1 : 0));
  }

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

  move(step) {
    const rows = this.rows();
    if (!rows.length) return;
    const at = (this.cursor(rows) + step + rows.length) % rows.length, room = this.room(), k = at - this.split(rows).made;
    let top = Math.floor(this.scroll / ROW_H);
    if (k >= 0 && k < top) top = k;
    else if (k >= top + room) top = k - room + 1;
    this.at = at;
    this.scroll = top * ROW_H;
  }

  pressable(el, row) {
    const off = this.disabled(row);
    return el.when(!off, el => el.cursor_pointer().on_click((_e, cx) => this.choose(row, cx)))
      .when(off, el => el.cursor_default())
      // Hover only counts when the mouse moves: a list that scrolls under a still mouse must not take the highlight.
      .on_mouse_move((_e, cx) => {
        const rows = this.rows(), i = rows.indexOf(row);
        if (i < 0 || i === this.cursor(rows)) return;
        this.at = i;
        cx.notify();
      });
  }

  // New note, with the name it will get, or Create with the name typed.
  maker(t, row, on) {
    const off = this.disabled(row), create = row.kind === "create";
    return this.pressable(h_flex().id(row.id).h(MAKER_H).flex_none().mx(8).px(8).gap(10).items_center().rounded(8).text_size(12.8)
      .text_color(off ? t.dim : t.foreground).when(on, el => el.bg(t.selected)), row)
      .child(div().size(24).flex_none().flex().items_center().justify_center().rounded(6).bg(off ? t.raised : withAlpha(t.accent, 0.16))
        .child(svg(ICON("file-plus")).size(14).flex_none().text_color(off ? t.dim : t.accent)))
      .child(div().flex_none().font_medium().child(create ? "Create" : "New note"))
      .when(create, el => el.child(div().flex_none().max_w(280).truncate().font_semibold().text_color(off ? t.dim : t.accent).child(row.name)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
        .child(off ? `Creating files on ${this.machine} isn't supported yet` : create ? "" : uniqueName(this.entries().taken)));
  }

  row(t, row, on) {
    const name = basename(row.entry.path), dir = row.entry.path.includes("/") ? dirname(row.entry.path) : "";
    const open = this.isOpenHere(row.entry.file), tag = open ? "open" : row.entry.recent ? "recent" : null;
    return this.pressable(h_flex().id(row.id).h(ROW_H).flex_none().px(10).gap(9).items_center().rounded(7).text_size(12.8).text_color(t.foreground)
      .when(on, el => el.bg(t.selected)), row)
      .child(image(ICON("file-markdown")).w(15).h(15).flex_none())
      .child(div().flex_none().max_w(300).truncate().font_medium().child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir))
      .when(Boolean(tag), el => el.child(div().flex_none().h(18).px(7).flex().items_center().rounded_full().text_size(10.5).font_medium()
        .when(open, el => el.border_1().border_color(t.accent).text_color(t.accent))
        .when(!open, el => el.bg(t.raised).text_color(t.muted))
        .child(tag)));
  }

  header(t) {
    const where = this.folder ? tildePath(this.folder, this.home) : "", place = this.machine && where ? `${this.machine}: ${where}` : where;
    return h_flex().id("mdp-header").h(46).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(image(ICON("file-markdown")).w(16).h(16).flex_none())
      .child(div().flex_none().text_size(14).font_semibold().child("Potion"))
      .child(div().flex_none().text_size(14).text_color(t.muted).child("Markdown"))
      .child(div().flex_1())
      .when(Boolean(place), el => el.child(h_flex().id("mdp-folder").min_w(0).max_w(300).h(26).px(10).gap(6).items_center().rounded_full()
        .border_1().border_color(t.input).text_size(12).font_medium().text_color(t.muted).tooltip(place)
        .child(svg(ICON("folder")).size(13).flex_none())
        .child(div().min_w(0).truncate().child(place))));
  }

  search(t) {
    const words = this.query !== "";
    return div().id("mdp-search").relative().flex_none().mx(12).mt(12).mb(6)
      .child(Input.new(this.input).h(FIELD_H).pl(34).pr(words ? FIELD_H : 14).rounded_full().border_1().border_color(words ? t.accent : t.input)
        .bg(t.background).text_size(13).text_color(t.foreground))
      .child(svg(ICON("search")).absolute().left(13).top(9).size(14).text_color(t.dim))
      .when(words, el => el.child(div().id("mdp-clear").absolute().right(6).top(6).size(20).flex().items_center().justify_center().rounded_full()
        .cursor_pointer().tooltip("Clear").text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.input.set_value(""); this.typed(cx); this.input.focus(); })
        .child(svg(ICON("x")).size(12).flex_none())));
  }

  footer(t) {
    return h_flex().id("mdp-footer").h(36).flex_none().px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .children(KEYS[this.place].map(([key, what]) => h_flex().flex_none().gap(6).items_center()
        .child(div().h(18).min_w(18).px(5).flex().items_center().justify_center().rounded(5).border_1().border_color(t.input).bg(t.background)
          .text_size(10.5).font_medium().text_color(t.muted).child(key))
        .child(div().child(what))));
  }

  render() {
    const t = theme(), rows = this.rows(), at = this.cursor(rows), status = this.status(), room = this.room(), { made, files } = this.split(rows);
    this.scroll = clamp(this.scroll, 0, Math.max(0, files.length - room) * ROW_H);
    const top = Math.floor(this.scroll / ROW_H);
    // A name that can't be used is only worth a word when nothing matches the query either.
    const named = this.query.trim() && !rows.some(r => r.kind === "file") ? newFileName(this.query).error : null;
    const note = this.problem ?? named;
    return v_flex().id("mdp-root").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.dismiss();
        else if (e.key === "down") this.move(1);
        else if (e.key === "up") this.move(-1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.header(t))
      .child(this.search(t))
      .when(Boolean(note), el => el.child(div().id("mdp-note").flex_none().px(16).pb(4).text_size(12).text_color(this.problem ? t.blocked : t.dim).child(note)))
      .when(made > 0, el => el.child(this.maker(t, rows[0], at === 0)).child(div().h(1).flex_none().mx(14).mt(4).bg(t.border)))
      .child(v_flex().id("mdp-list").flex_1().min_h(0).mx(8).my(4).overflow_hidden()
        .on_size_change((size, cx) => {
          const height = size.height / settings().zoom;
          if (height === this.listHeight) return;
          this.listHeight = height;
          cx.notify();
        })
        .on_scroll_wheel((e, cx) => {
          this.scroll = clamp(this.scroll - e.delta.y, 0, Math.max(0, this.split(this.rows()).files.length - this.room()) * ROW_H);
          cx.notify();
        })
        .children(files.slice(top, top + room).map((row, i) => this.row(t, row, made + top + i === at)))
        .when(Boolean(status), el => el.child(div().id("mdp-status").h(ROW_H).flex_none().px(10).flex().items_center().text_size(12).text_color(status.bad ? t.blocked : t.dim).child(status.text))))
      .child(this.footer(t));
  }
}
