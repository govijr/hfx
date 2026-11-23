import { createRoot, type EngineKeyEvent } from "@zenbu-labs/pixel";
import { attach, cancel, cycleVariant, move, quit, search, setQuit } from "./controller";
import { detectHardware } from "./hardware";
import { getState, initStore, newId, setState } from "./store";
import { App, slashMatches } from "./ui/shell";

initStore({
  hw: detectHardware(),
  rem: 16,
  items: [{ kind: "banner", id: newId() }],
  picker: null,
  busy: null,
  active: null,
  input: "",
  attachments: [],
  history: [],
  historyIndex: -1,
  slashIndex: 0,
  filter: null,
});

function onKey(e: EngineKeyEvent): boolean | void {
  if (e.kind === "release") return;
  const s = getState();
  if (e.mods.ctrl && e.key === "c") {
    if (!cancel()) quit();
    return true;
  }
  if (e.mods.ctrl || e.mods.alt || e.mods.super) return;
  switch (e.key) {
    case "escape":
      if (cancel()) return true;
      if (s.input) return setState({ input: "" }), true;
      return;
    case "up":
    case "down": {
      const d = e.key === "up" ? -1 : 1;
      const slash = slashMatches(s.input);
      if (slash.length) return setState({ slashIndex: (s.slashIndex + d + slash.length) % slash.length }), true;
      if (s.picker) return move(d), true;
      if (!s.history.length) return true;
      const i = s.historyIndex === -1 ? (d < 0 ? s.history.length - 1 : -1) : s.historyIndex + d;
      if (i < 0 || i >= s.history.length) setState({ historyIndex: -1, input: "" });
      else setState({ historyIndex: i, input: s.history[i] });
      return true;
    }
    case "tab": {
      const slash = slashMatches(s.input);
      if (slash.length) {
        const c = slash[s.slashIndex] ?? slash[0];
        return setState({ input: `/${c.name}${c.args ? " " : ""}`, slashIndex: 0 }), true;
      }
      if (s.picker) return cycleVariant(1), true;
      return true;
    }
    case "left":
    case "right":
      if (s.picker && !s.input) return cycleVariant(e.key === "left" ? -1 : 1), true;
      return;
  }
}

const root = createRoot({
  name: "hfx",
  onKey,
  onPasteImage: (img) => attach(img.path),
  onResize: ({ basePx }) => setState({ rem: basePx }),
  onExit: (code) => process.exit(code),
});
root.setTitle("hfx");
root.setKeyCapture(["escape", "up", "down", "tab", "left", "right"]);
setState({ rem: root.info.basePx });
setQuit(() => root.stop());
root.render(<App />);

// `hfx qwen3` jumps straight into a search.
const initial = process.argv.slice(2).join(" ").trim();
if (initial) void search(initial);
