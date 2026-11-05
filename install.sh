#!/usr/bin/env bash
# install.sh: put the Markdown mod and its diagram renderer where Herdr and the mod look for them.
#
#   ./install.sh                copy mods/herdr-inline-markdown into the Herdr app home, then install the diagram renderer
#   ./install.sh --no-mermaid   only the mod: diagrams then show as code blocks
#   ./install.sh --help
#
# Environment:
#   HERDR_APP_HOME      Herdr's app folder, default ~/.config/herdr-app; the mod goes to its mods/herdr-inline-markdown
#   HERDR_MERMAID_HOME  where the renderer goes, default ~/.local/share/herdr-inline-markdown/mermaid. The mod only looks in
#                       the default place, so set this to try an install somewhere else, not to move it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MERMAID_HOME="${HERDR_MERMAID_HOME:-$HOME/.local/share/herdr-inline-markdown/mermaid}"
BACKUPS="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-inline-markdown/backups"
# Herdr writes these into every mod folder: never ours, never copied, never removed.
DIFF_EXCLUDES=(-x '*.d.ts' -x 'jsconfig.json' -x '*.error' -x '.DS_Store')

die() { echo "install.sh: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
usage() { sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

copy() { mkdir -p "$(dirname "$2")"; cp -p "$1" "$2"; }
sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1; }

# The mod: its files replace the installed ones. What was there is kept under $BACKUPS when it differed.
install_mod() {
  local src="$REPO/mods/herdr-inline-markdown" dst="$APP_HOME/mods/herdr-inline-markdown" f stamp
  [ -d "$src" ] || die "$src is missing: run install.sh from a complete checkout"
  [ -d "$APP_HOME" ] || die "no Herdr app home at $APP_HOME: start Herdr once so it creates one, or set HERDR_APP_HOME"
  if [ -d "$dst" ] && ! diff -rq "${DIFF_EXCLUDES[@]}" "$src" "$dst" >/dev/null 2>&1; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUPS/$stamp"
    cp -R "$dst" "$BACKUPS/$stamp/herdr-inline-markdown"
    say "mod: the installed copy differed; saved it under $BACKUPS/$stamp/herdr-inline-markdown"
  fi
  # Herdr docks a mod into the shown layout the first time it sees its folder, unless mod.json says otherwise. A folder
  # filled file by file can be seen before its mod.json, so a first install appears whole: staged outside mods/, then
  # renamed into place.
  if [ ! -d "$dst" ]; then
    local stage
    stage="$(mktemp -d "$APP_HOME/.herdr-inline-markdown.XXXXXX")"
    for f in "$src"/*; do copy "$f" "$stage/$(basename "$f")"; done
    mkdir -p "$(dirname "$dst")"
    mv "$stage" "$dst"
    say "mod: herdr-inline-markdown installed in $dst"
    return
  fi
  for f in "$dst"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.d.ts|*/jsconfig.json|*.error|*/.DS_Store) continue ;; esac
    [ -e "$src/$(basename "$f")" ] || rm -f "$f"
  done
  for f in "$src"/*; do copy "$f" "$dst/$(basename "$f")"; done
  say "mod: herdr-inline-markdown installed in $dst"
}

# puppeteer 25 (inside mermaid-cli) needs Node.js 22.12 or newer.
node_ok() {
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'
}

# What the mod keys its diagram cache on: a new mermaid-cli, render.mjs or lock file (mermaid itself moves with the lock
# file, not with package.json's mermaid-cli pin) draws everything again.
mermaid_version() {
  local pin
  pin="$(node -p 'require(process.argv[1]).dependencies["@mermaid-js/mermaid-cli"]' "$REPO/tools/mermaid/package.json")"
  printf 'mmdc-%s+%s+%s' "$pin" "$(sha256 "$REPO/tools/mermaid/render.mjs" | cut -c1-8)" \
    "$(sha256 "$REPO/tools/mermaid/package-lock.json" | cut -c1-8)"
}

# tools/mermaid -> $MERMAID_HOME with its node_modules, the path of node (Herdr's PATH is short) and the version.
# The mod reads node-path and version as they are, so neither ends in a newline. Without a usable Node.js it says so and
# returns 0: the mod works without diagrams.
install_mermaid() {
  local src="$REPO/tools/mermaid" node f lock out
  if ! node="$(command -v node)" || ! command -v npm >/dev/null; then
    say "mermaid: Node.js (node and npm) not found, so no diagrams yet: install Node.js 22.12 or newer, then run ./install.sh again"
    return 0
  fi
  if ! node_ok; then
    say "mermaid: Node.js $(node -v) is too old for the renderer (22.12 or newer), so no diagrams yet"
    return 0
  fi

  mkdir -p "$MERMAID_HOME" || return 1
  # version goes first and comes back last: a run that stops in between leaves an install that reads as not installed,
  # not new files under the old version.
  rm -f "$MERMAID_HOME/version"
  for f in package.json package-lock.json render.mjs; do copy "$src/$f" "$MERMAID_HOME/$f" || return 1; done
  lock="$(sha256 "$src/package-lock.json")"
  # Only when the lock file changed, or node_modules is gone: it is 400 MB of downloads.
  if [ ! -d "$MERMAID_HOME/node_modules" ] || [ "$(cat "$MERMAID_HOME/lock.sha256" 2>/dev/null)" != "$lock" ]; then
    say "mermaid: npm ci in $MERMAID_HOME (a few minutes the first time)"
    # No install scripts: puppeteer's postinstall would fetch the full Chrome too. The browser comes from the step below.
    (cd "$MERMAID_HOME" && npm ci --ignore-scripts --no-audit --no-fund) ||
      { say "mermaid: npm ci failed (offline?); retry with ./install.sh"; return 1; }
    printf '%s' "$lock" > "$MERMAID_HOME/lock.sha256"
  fi
  # The browser: only chrome-headless-shell, the one render.mjs launches. puppeteer's installer does nothing while
  # ~/.cache/puppeteer holds the build it wants, and fetches it again if the cache was cleared. It says "downloaded"
  # either way and exits 0 when the download fails, so its output only shows on failure, found by its words.
  if ! out="$(cd "$MERMAID_HOME" && PUPPETEER_CHROME_SKIP_DOWNLOAD=true node node_modules/puppeteer/install.mjs 2>&1)" ||
     [[ "$out" == *"download failed"* ]]; then
    grep -v 'INFO\|^ *at ' <<<"$out" | head -3 | sed 's/^/    /'
    say "mermaid: could not fetch chrome-headless-shell; retry with ./install.sh"
    return 1
  fi
  printf '%s' "$node" > "$MERMAID_HOME/node-path"
  printf '%s' "$(mermaid_version)" > "$MERMAID_HOME/version" # last: a half install reads as not installed
  say "mermaid: renderer $(cat "$MERMAID_HOME/version") installed in $MERMAID_HOME"
}

main() {
  local with_mermaid=1 failed=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-mermaid) with_mermaid=0 ;;
      -h|--help) usage; return 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done

  install_mod
  if [ "$with_mermaid" = 1 ]; then
    install_mermaid || failed=1
  else
    say "mermaid: skipped (--no-mermaid); diagrams show as code blocks"
  fi

  say "Herdr reloads mods as their files change, so there is nothing to restart."
  say "Next: integrations/README.md says how to open Markdown files from the keys, the + menu and the file panels."
  if [ "$failed" = 1 ]; then
    say "The mod is installed, the diagram renderer is not: fix the problem above and run ./install.sh again."
    return 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
