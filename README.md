# hfx

Search, pull and run Hugging Face models from your terminal: text, vision, image and video, in one Claude Code–style UI built on [PixelGUI](https://pixelgui.com).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/govijr/hfx/main/install.sh | sh
```

macOS (Apple Silicon / Intel) and Linux (x64 / arm64). No Node needed: each release bundles its own runtime. Installs to `~/.hfx/app` and links `~/.local/bin/hfx`. Then: `hfx`, `hfx qwen3`, `hfx update`, `hfx uninstall`.

Optional runtimes: `brew install uv` (MLX text, image, video, vision) and `brew install llama.cpp` (GGUF).

## Develop

```bash
npm install
npm run dev            # build + launch
node bin/hfx.js qwen3  # launch straight into a search
npx tsx scripts/e2e.ts mlx-community/Qwen3-0.6B-4bit   # headless pull → load → reply
```

## Release

```bash
npm version patch      # bumps package.json and tags vX.Y.Z
git push --follow-tags # CI builds 4 platform archives and publishes the GitHub release
```

`scripts/package.sh` builds the archive for the machine it runs on (`release/hfx-<os>-<arch>.tar.gz`); test it with `HFX_ARCHIVE=release/hfx-darwin-arm64.tar.gz sh install.sh`.

Best in a terminal with kitty graphics (Ghostty, kitty, WezTerm, iTerm2) — images and video previews render inline. Other terminals fall back to a cell renderer (`PIXEL_RENDERER=cells`).

## Using it

Just type. With no model loaded, text searches the Hub; with one loaded, it's a prompt.

- `image flux`, `video ltx`, `vision qwen vl` — filter by modality
- In results: `↑↓` move · `←→` pick quantization · `enter` pull & run · `esc` close
- Every result shows a **fit badge** (`● fits / ◐ tight / ○ too big`) computed from your RAM/VRAM
- Vision models: paste an image, or drop/type an image path into the prompt
- `/models` `/load` `/unload` `/rm` `/reset` `/open` `/clear` `/help` `/quit`

## How models run

| what you pull | runtime | needs |
| --- | --- | --- |
| GGUF (text, + vision via `mmproj`) | llama.cpp `llama-server` | `brew install llama.cpp` |
| MLX / safetensors text (Apple Silicon) | `mlx_lm.server` via `uv` | `brew install uv` |
| diffusers text-to-image / text-to-video | `python/worker.py` (diffusers + torch) via `uv` | `uv` (first run downloads torch) |
| transformers image-text-to-text | `python/worker.py` (transformers) via `uv` | `uv` |

Text engines are OpenAI-compatible servers on a random localhost port, so the chat UI is engine-agnostic. Python runtimes are created on demand by `uv` — nothing is installed globally.

Files live in `~/.hfx` (`models/`, `outputs/`, `logs/`; override with `HFX_HOME`). Downloads resume. Gated repos use `HF_TOKEN` or your `hf auth login` token.

## Layout

```
src/main.tsx        root, key routing
src/controller.ts   commands, search/pull/load/generate flow
src/hub.ts          Hub API, modality detection, quant/variant picking
src/hardware.ts     memory budget + fit estimates
src/library.ts      local store + resumable parallel downloads
src/engines.ts      llama.cpp / MLX servers, Python worker
src/ui/             transcript, picker, prompt, status line
python/worker.py    diffusers/transformers JSON-lines worker
scripts/e2e.ts      headless pull → load → chat check
scripts/package.sh  per-platform release archive
install.sh          curl installer
bin/hfx             release launcher (runs on the bundled Electron)
bin/hfx.js          dev launcher (runs on system Node)
```
