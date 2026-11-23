#!/bin/sh
# Build a self-contained release archive for the current platform:
#   release/hfx-<os>-<arch>.tar.gz (+ .sha256)
# The archive holds the app, its production dependencies and Pixel's Electron runtime.
set -eu

cd "$(dirname "$0")/.."
root=$(pwd)

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
case $os in darwin | linux) ;; *) echo "unsupported OS $os" >&2; exit 1 ;; esac

name=hfx-$os-$arch
version=$(node -p 'require("./package.json").version')
stage=$root/release/stage/hfx
out=$root/release

echo "==> building $name (v$version)"
rm -rf "$root/release"
mkdir -p "$stage"

# CI starts clean; locally keep the existing node_modules (and its Electron runtime).
if [ -n "${CI:-}" ] || [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi
npm run typecheck
npm run build

# Copy into a staging dir, then install production dependencies there only.
cp -R bin dist python package.json package-lock.json README.md "$stage/"
rm -f "$stage/bin/hfx.js" # dev launcher; releases use bin/hfx
[ -f LICENSE ] && cp LICENSE "$stage/"
(
  cd "$stage"
  npm ci --omit=dev --no-audit --no-fund
  # Reuse an already-downloaded runtime when there is one; postinstall then only verifies it.
  if [ -f "$root/node_modules/@zenbu-labs/pixel/electron/dist/.zenbu-electron-sha256" ]; then
    mkdir -p node_modules/@zenbu-labs/pixel/electron
    cp -R "$root/node_modules/@zenbu-labs/pixel/electron/dist" node_modules/@zenbu-labs/pixel/electron/
  fi
  # npm may skip install scripts (allow-scripts); fetch Pixel's Electron runtime explicitly. It's idempotent.
  node node_modules/@zenbu-labs/pixel/scripts/postinstall.mjs
  rm -f package-lock.json
  # Trim what the runtime never reads.
  rm -rf node_modules/@zenbu-labs/pixel/electron/electron.d.ts node_modules/.package-lock.json
  find node_modules \( -name "*.d.ts" -o -name "*.map" -o -name "*.md" \) -type f -delete 2>/dev/null || true
)

# Smoke test the staged launcher before archiving.
"$stage/bin/hfx" --version

tar -C "$root/release/stage" -czf "$out/$name.tar.gz" hfx
(
  cd "$out"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$name.tar.gz"; else shasum -a 256 "$name.tar.gz"; fi > "$name.tar.gz.sha256"
)
rm -rf "$root/release/stage"
ls -lh "$out"
