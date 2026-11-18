# Before open-sourcing

- **Publish on herdr.dev.** Herdr lists a public GitHub repo with the topic `herdr-mod` at herdr.dev/mods within the
  hour. The repo needs a `RECIPE.md` (the brief another agent builds the mod from: what you see, how it behaves, what
  it is built from, what to watch out for) and a `preview.png` screenshot; the folder layout (`mods/<name>/` and
  `keys.json`) is already the one Herdr expects.
- **Check the claims about Herdr.** Every patch and the install paths were made for Herdr 0.1.12. The patches were
  checked by applying them to copies of that version's shipped mods, also with the `mods/<name>/` asset paths
  rewritten the way a clone does it (simulated, not cloned by Herdr), and by loading the mod against test mocks;
  nothing here has been run inside the app or in another version. The keys rely on `mod.open` showing each mod as
  its `mod.json` overlay says (the companion's 2 px frameless popup included). Say so in the compatibility notes.
- **Icon provenance.** Twenty icons are from lucide-static 1.69.0 and ten from 1.73.0; four more match the path
  data of current Lucide icons, but the release they were copied from was not recorded. `spinner.svg` and `dots.svg` were drawn for
  this package, and `file-markdown.svg` is the Material Icon Theme's markdown icon.
- **Opening a file can fetch https pictures.** A markdown file can name pictures on the web, and the mod downloads
  them with `curl` when the file opens (https only, 10 MB at most, 20 s), so the server of each one sees your address.
  Say so, or put the download behind a setting.
- **The installer fetches about 650 MB** (mermaid-cli and its dependencies, then a headless Chrome from the
  puppeteer download host) and runs `npm ci --ignore-scripts`. Say so before anyone runs it, and consider an
  opt-in for the Chrome download.
- **Node.js versions.** Tested on a current Node.js release; Node.js 22 is untested. The test loader has a fallback
  for versions without `module.registerHooks`, and the renderer needs 22.12.
- **Remote machines are read-only.** A file on another machine opens, but is never edited. Say so near the top,
  or build it.
- **`cmd-m` is the macOS shortcut for minimizing a window**, and `install.sh` binds it by default (unless it is
  taken). Pick another default, or make the keys opt-in.
- **No CHANGELOG, CI or issue templates yet.**
