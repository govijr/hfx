#!/bin/sh
# hfx installer
#   curl -fsSL https://raw.githubusercontent.com/govijr/hfx/main/install.sh | sh
#
# Environment:
#   HFX_VERSION      install a specific tag (e.g. v0.2.0) instead of the latest release
#   HFX_INSTALL_DIR  where versions are unpacked   (default ~/.hfx/app)
#   HFX_BIN_DIR      where the `hfx` link goes     (default ~/.local/bin)
#   HFX_ARCHIVE      install from a local .tar.gz instead of downloading (for testing)
set -eu

REPO=${HFX_REPO:-govijr/hfx}
INSTALL_DIR=${HFX_INSTALL_DIR:-$HOME/.hfx/app}
BIN_DIR=${HFX_BIN_DIR:-$HOME/.local/bin}

if [ -t 1 ]; then
  bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); yellow=$(printf '\033[33m'); red=$(printf '\033[31m'); reset=$(printf '\033[0m')
else
  bold=''; dim=''; yellow=''; red=''; reset=''
fi
info() { printf '%s\n' "${dim}›${reset} $*"; }
fail() { printf '%s\n' "${red}error:${reset} $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"; }
need curl
need tar
need uname

# ── platform ────────────────────────────────────────────────────────────────
os=$(uname -s)
case $os in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS: $os (hfx runs on macOS and Linux; on Windows use WSL)" ;;
esac
arch=$(uname -m)
case $arch in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture: $arch" ;;
esac
# A shell running under Rosetta reports x86_64; prefer the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset=hfx-$os-$arch.tar.gz

if [ -n "${HFX_VERSION:-}" ]; then
  base=https://github.com/$REPO/releases/download/$HFX_VERSION
else
  base=https://github.com/$REPO/releases/latest/download
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# ── download + verify ──────────────────────────────────────────────────────
if [ -n "${HFX_ARCHIVE:-}" ]; then
  info "using local archive $HFX_ARCHIVE"
  cp "$HFX_ARCHIVE" "$tmp/$asset"
  [ -f "$HFX_ARCHIVE.sha256" ] && cp "$HFX_ARCHIVE.sha256" "$tmp/$asset.sha256"
else
  info "downloading $asset ${HFX_VERSION:-(latest)}"
  curl -fL --progress-bar -o "$tmp/$asset" "$base/$asset" ||
    fail "download failed. Is there a release with $asset at https://github.com/$REPO/releases ?"
  curl -fsSL -o "$tmp/$asset.sha256" "$base/$asset.sha256" || fail "could not download the checksum"
fi

if [ -f "$tmp/$asset.sha256" ]; then
  expected=$(cut -d ' ' -f 1 <"$tmp/$asset.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)
  else
    actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)
  fi
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"
  info "checksum ok"
fi

# ── unpack ─────────────────────────────────────────────────────────────────
tar -xzf "$tmp/$asset" -C "$tmp"
[ -x "$tmp/hfx/bin/hfx" ] || fail "archive is missing bin/hfx"
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$tmp/hfx/package.json" | head -n 1)
[ -n "$version" ] || fail "could not read the version from the archive"

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
dest=$INSTALL_DIR/$version
rm -rf "$dest"
mv "$tmp/hfx" "$dest"

# Switch the `current` link atomically, then point the command at it.
ln -sfn "$version" "$INSTALL_DIR/current.tmp"
mv -f "$INSTALL_DIR/current.tmp" "$INSTALL_DIR/current" 2>/dev/null || {
  rm -rf "$INSTALL_DIR/current"
  mv "$INSTALL_DIR/current.tmp" "$INSTALL_DIR/current"
}
ln -sf "$INSTALL_DIR/current/bin/hfx" "$BIN_DIR/hfx"

# Keep only the newest two versions.
ls -1t "$INSTALL_DIR" | grep -v '^current' | tail -n +3 | while read -r old; do
  [ "$old" != "$version" ] && rm -rf "${INSTALL_DIR:?}/$old"
done

"$BIN_DIR/hfx" --version >/dev/null || fail "installed, but hfx failed to start"

printf '\n%s\n' "${bold}${yellow}◆${reset} ${bold}hfx $version installed${reset} ${dim}→ $dest${reset}"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    shell_rc=
    case ${SHELL:-} in
      */zsh) shell_rc=~/.zshrc ;;
      */bash) shell_rc=~/.bashrc ;;
      */fish) shell_rc=~/.config/fish/config.fish ;;
    esac
    printf '\n%s\n' "${yellow}$BIN_DIR is not on your PATH.${reset} Add it with:"
    if [ "${SHELL:-}" != "${SHELL%fish}" ]; then
      printf '  %s\n' "fish_add_path $BIN_DIR"
    else
      printf '  %s\n' "echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ${shell_rc:-~/.profile} && exec \$SHELL"
    fi
    ;;
esac

# Optional runtimes, checked so first runs don't surprise anyone.
missing=
command -v uv >/dev/null 2>&1 || missing="$missing uv"
command -v llama-server >/dev/null 2>&1 || missing="$missing llama.cpp"
if [ -n "$missing" ]; then
  printf '\n%s\n' "Optional, for running models:"
  for m in $missing; do
    case $m in
      uv) printf '  %s\n' "uv          MLX text + image/video/vision   → brew install uv  (or curl -LsSf https://astral.sh/uv/install.sh | sh)" ;;
      llama.cpp) printf '  %s\n' "llama.cpp   GGUF models                     → brew install llama.cpp" ;;
    esac
  done
fi

printf '\n%s\n' "Run ${bold}hfx${reset} to start. Best in Ghostty, kitty, WezTerm or iTerm2."
