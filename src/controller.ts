import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { engineFor, killAllEngines, type Engine } from "./engines";
import { fmtBytes, type Modality } from "./hardware";
import { listRepoFiles, searchHub, variantsFor } from "./hub";
import { findLocal, listLocal, pull, removeLocal, type LocalModel } from "./library";
import { getState, newId, note, patchItem, pushItem, setState, type HubRow, type Row } from "./store";

export const COMMANDS: { name: string; args?: string; desc: string }[] = [
  { name: "search", args: "[text|vision|image|video] <query>", desc: "Search the Hugging Face Hub" },
  { name: "models", desc: "Models on this machine" },
  { name: "load", args: "<repo>", desc: "Load a downloaded model" },
  { name: "unload", desc: "Stop the running model" },
  { name: "rm", args: "<repo>", desc: "Delete a downloaded model" },
  { name: "reset", desc: "Forget the conversation" },
  { name: "open", desc: "Open the last image or video" },
  { name: "clear", desc: "Clear the screen" },
  { name: "help", desc: "Show help" },
  { name: "quit", desc: "Exit hfx" },
];

const MODALITIES: Modality[] = ["text", "vision", "image", "video"];
const IMAGE_PATH = /(?:^|\s)(['"]?)((?:~|\.{0,2})?\/[^'"\n]+?\.(?:png|jpe?g|webp|gif|bmp))\1(?=\s|$)/gi;

let engine: Engine | null = null;
let abort: AbortController | null = null;
let searchAbort: AbortController | null = null;
let lastOutput: string | null = null;
let quitFn: () => void = () => process.exit(0);

export function setQuit(fn: () => void) {
  quitFn = fn;
}

function begin(label: string, cancellable = true) {
  abort = new AbortController();
  setState({ busy: { label, startedAt: Date.now(), cancellable } });
  return abort.signal;
}
function end() {
  abort = null;
  setState({ busy: null });
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";

export function cancel(): boolean {
  if (abort && getState().busy?.cancellable) {
    abort.abort();
    return true;
  }
  if (getState().picker) {
    closePicker();
    return true;
  }
  return false;
}

export function quit() {
  engine?.dispose();
  killAllEngines();
  quitFn();
}

// ── input ──────────────────────────────────────────────────────────────────

export async function submit(raw: string) {
  const text = raw.trim();
  const s = getState();
  setState({ input: "", slashIndex: 0 });
  if (!text) {
    if (s.picker) await choose();
    return;
  }
  setState((st) => ({ history: [...st.history.filter((h) => h !== text), text], historyIndex: -1 }));
  if (s.busy) {
    note("Still working. Press esc to cancel first.", "muted");
    return;
  }
  if (text.startsWith("/")) return command(text);
  if (s.active && !s.picker) return generate(text);
  return search(text);
}

async function command(text: string) {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "search":
    case "s":
      return arg ? search(arg) : note("Usage: /search [text|vision|image|video] <query>");
    case "models":
    case "ls":
      return showLocal();
    case "load": {
      const m = arg ? findLocal(arg) : undefined;
      return m ? load(m) : arg ? note(`${arg} isn't downloaded. Search for it first.`, "error") : showLocal();
    }
    case "unload":
      engine?.dispose();
      engine = null;
      setState({ active: null });
      return note("Model unloaded.");
    case "rm": {
      const m = arg && findLocal(arg);
      if (!m) return note(`No local model named ${arg || "(none)"}.`, "error");
      if (getState().active?.model.dir === m.dir) await command("/unload");
      removeLocal(m);
      return note(`Deleted ${m.id} (${fmtBytes(m.bytes)} freed).`, "ok");
    }
    case "reset":
      engine?.reset();
      return note("Conversation cleared. The model stays loaded.");
    case "clear":
      return setState({ items: [] });
    case "open":
      if (!lastOutput) return note("Nothing generated yet.");
      return openPath(lastOutput);
    case "help":
    case "?":
      return pushItem({ kind: "help", id: newId() });
    case "quit":
    case "exit":
    case "q":
      return quit();
    default:
      return note(`Unknown command /${cmd}. Try /help.`, "error");
  }
}

export function openPath(p: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [p], { detached: true, stdio: "ignore" }).unref();
}

// ── picker ─────────────────────────────────────────────────────────────────

export async function search(text: string) {
  let words = text.split(/\s+/);
  let modality: Modality | undefined;
  if (MODALITIES.includes(words[0] as Modality) && words.length > 1) {
    modality = words[0] as Modality;
    words = words.slice(1);
  }
  const query = words.join(" ");
  searchAbort?.abort();
  searchAbort = new AbortController();
  const title = `${modality ? modality + " · " : ""}"${query}"`;
  setState({ picker: { title, rows: [], index: 0, loading: true } });
  try {
    const models = await searchHub(query, modality, searchAbort.signal);
    const rows: Row[] = models
      .map((m) => ({ kind: "hub" as const, model: m, variantIndex: 0 }))
      .sort((a, b) => Number(!a.model.modality) - Number(!b.model.modality));
    setState({ picker: { title, rows, index: 0, loading: false } });
    if (rows.length) hover(0);
  } catch (e) {
    if (isAbort(e)) return;
    setState({ picker: { title, rows: [], index: 0, loading: false, error: errText(e) } });
  }
}

function showLocal() {
  const rows: Row[] = listLocal().map((m) => ({ kind: "local", model: m }));
  if (!rows.length) return note("No models yet. Type what you're looking for, e.g. `qwen3`, `image flux`, `video ltx`.");
  setState({ picker: { title: "on this machine", rows, index: 0, loading: false } });
}

export function closePicker() {
  searchAbort?.abort();
  setState({ picker: null });
}

function patchRow(modelId: string, patch: Partial<HubRow>) {
  setState((s) => {
    if (!s.picker) return {};
    const rows = s.picker.rows.map((r) => (r.kind === "hub" && r.model.id === modelId ? { ...r, ...patch } : r));
    return { picker: { ...s.picker, rows } };
  });
}

export function move(delta: number) {
  const p = getState().picker;
  if (!p || !p.rows.length) return;
  const index = Math.max(0, Math.min(p.rows.length - 1, p.index + delta));
  setState({ picker: { ...p, index } });
  hover(index);
}

export function cycleVariant(delta: number) {
  const p = getState().picker;
  const row = p?.rows[p.index];
  if (!row || row.kind !== "hub" || !Array.isArray(row.variants)) return;
  const n = row.variants.length;
  patchRow(row.model.id, { variantIndex: (row.variantIndex + delta + n) % n });
}

async function hover(index: number) {
  const row = getState().picker?.rows[index];
  if (!row || row.kind !== "hub" || row.variants !== undefined || !row.model.modality) return;
  patchRow(row.model.id, { variants: "loading" });
  try {
    const files = await listRepoFiles(row.model.id, searchAbort?.signal);
    const { variants, preferred } = variantsFor(row.model, files, getState().hw);
    if (!variants.length) return patchRow(row.model.id, { variants: "no runnable GGUF model in this repo" });
    patchRow(row.model.id, { variants, variantIndex: preferred });
  } catch (e) {
    if (!isAbort(e)) patchRow(row.model.id, { variants: errText(e) });
  }
}

export async function choose() {
  const p = getState().picker;
  const row = p?.rows[p.index];
  if (!row) return;
  if (row.kind === "local") {
    closePicker();
    return load(row.model);
  }
  const m = row.model;
  if (!m.modality) return note(`${m.id} is a ${m.pipeline ?? "unknown"} model; hfx runs text, vision, image and video models.`, "error");
  if (!Array.isArray(row.variants)) return note(row.variants === "loading" ? "Still reading the repo…" : `Can't use ${m.id}: ${row.variants}`, "error");
  const variant = row.variants[row.variantIndex];
  if (!variant.files.length) return note(`${m.id} has no weights hfx can run.`, "error");
  closePicker();
  let local = findLocal(m.id, variant.label);
  if (!local) {
    if (variant.fit === "too-big") note(`Heads up: ${m.id} (${fmtBytes(variant.bytes)}) probably won't fit in memory.`, "error");
    const id = pushItem({ kind: "download", id: newId(), model: m.id, variant: variant.label, done: 0, total: variant.bytes, speed: 0, state: "running" });
    const signal = begin(`Pulling ${m.id}`);
    try {
      local = await pull(m, variant, (pr) => patchItem<"download">(id, { done: pr.done, total: pr.total, speed: pr.bytesPerSec }), signal);
      patchItem<"download">(id, { state: "done" });
    } catch (e) {
      patchItem<"download">(id, { state: isAbort(e) ? "cancelled" : "error" });
      if (isAbort(e)) note("Download paused. Pick the model again to resume.");
      else note(errText(e), "error");
      return;
    } finally {
      end();
    }
  }
  return load(local);
}

// ── run ────────────────────────────────────────────────────────────────────

async function load(m: LocalModel) {
  engine?.dispose();
  engine = null;
  setState({ active: null });
  begin(`Loading ${m.id}`, false);
  try {
    const e = engineFor(m, getState().hw);
    await e.load((detail) => setState((s) => ({ busy: s.busy && { ...s.busy, detail } })));
    engine = e;
    setState({ active: { model: m, runtime: e.runtime } });
    const hint =
      m.modality === "image" ? "Describe an image to generate." :
      m.modality === "video" ? "Describe a short clip to generate." :
      m.modality === "vision" ? "Paste or drop an image, then ask about it." : "Say something.";
    note(`${m.id} is ready on ${e.runtime}. ${hint}`, "ok");
  } catch (e) {
    note(errText(e), "error");
  } finally {
    end();
  }
}

export function attach(p: string) {
  setState((s) => ({ attachments: [...s.attachments, p] }));
}

function extractImages(text: string): { prompt: string; images: string[] } {
  const images: string[] = [];
  const prompt = text.replace(IMAGE_PATH, (whole, _q, p: string) => {
    const abs = path.resolve(p.replace(/^~/, os.homedir()).replace(/\\ /g, " "));
    if (!fs.existsSync(abs)) return whole;
    images.push(abs);
    return " ";
  });
  return { prompt: prompt.trim() || "Describe this image.", images };
}

async function generate(text: string) {
  const s = getState();
  const m = s.active!.model;
  const { prompt, images: inline } = extractImages(text);
  const images = [...s.attachments, ...inline];
  setState({ attachments: [] });
  pushItem({ kind: "user", id: newId(), text: images.length ? prompt : text, images });
  if (images.length && m.modality === "text") note("This model is text-only, so the image was ignored. Load a vision model to use images.");
  const signal = begin(m.modality === "image" ? "Painting" : m.modality === "video" ? "Rendering" : "Thinking");
  const useImages = m.modality === "vision" || m.mmproj ? images : [];
  try {
    if (m.modality === "image" || m.modality === "video") {
      const id = pushItem({ kind: "gen", id: newId(), prompt, modality: m.modality, step: 0, total: 0 });
      await engine!.generate({ prompt }, (e) => {
        if (e.type === "progress") patchItem<"gen">(id, { step: e.step, total: e.total });
        if (e.type === "image") (lastOutput = e.path), patchItem<"gen">(id, { path: e.path, seconds: e.seconds });
        if (e.type === "video") (lastOutput = e.path), patchItem<"gen">(id, { path: e.path, poster: e.poster, seconds: e.seconds });
      }, signal);
      if (signal.aborted) patchItem<"gen">(id, { failed: true });
      return;
    }
    const id = pushItem({ kind: "assistant", id: newId(), text: "", thinking: "", streaming: true });
    let answer = "";
    let thinking = "";
    let stats = "";
    let pending = false;
    const flush = () => {
      pending = false;
      patchItem<"assistant">(id, { text: answer, thinking, stats });
    };
    await engine!
      .generate({ prompt, images: useImages }, (e) => {
        if (e.type === "token") answer += e.text;
        else if (e.type === "thinking") thinking += e.text;
        else if (e.type === "text") (answer = e.text), (stats = `${e.seconds.toFixed(1)}s`);
        else if (e.type === "stats") stats = `${e.tokens} tok · ${e.tokPerSec.toFixed(1)} tok/s`;
        if (!pending) {
          pending = true;
          setTimeout(flush, 33); // batch token updates to ~30 fps
        }
      }, signal)
      .catch((e) => {
        if (!isAbort(e)) throw e;
      });
    flush();
    patchItem<"assistant">(id, { streaming: false, stats: signal.aborted ? `${stats} · interrupted` : stats });
  } catch (e) {
    note(errText(e), "error");
  } finally {
    end();
  }
}
