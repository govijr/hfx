import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import type { Hardware } from "./hardware";
import { HFX_HOME, OUTPUTS_DIR, type LocalModel } from "./library";

export type GenEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "stats"; tokens: number; tokPerSec: number }
  | { type: "status"; text: string }
  | { type: "progress"; step: number; total: number }
  | { type: "text"; text: string; seconds: number }
  | { type: "image"; path: string; seconds: number }
  | { type: "video"; path: string; poster: string; seconds: number };

export interface GenRequest {
  prompt: string;
  images?: string[];
}

export interface Engine {
  /** e.g. "llama.cpp", "mlx", "diffusers" */
  readonly runtime: string;
  load(status: (text: string) => void): Promise<void>;
  generate(req: GenRequest, on: (e: GenEvent) => void, signal: AbortSignal): Promise<void>;
  reset(): void;
  dispose(): void;
}

const children = new Set<ChildProcess>();
export function killAllEngines() {
  for (const c of children) c.kill("SIGTERM");
}
process.on("exit", killAllEngines);

export function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).concat(["/opt/homebrew/bin", "/usr/local/bin"])) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function startProcess(cmd: string, args: string[], logName: string) {
  const logs = path.join(HFX_HOME, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const logPath = path.join(logs, `${logName}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} ${cmd} ${args.join(" ")}\n`);
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  children.add(child);
  const tail: string[] = [];
  child.stderr!.on("data", (d: Buffer) => {
    log.write(d);
    for (const line of d.toString().split("\n")) if (line.trim()) tail.push(line.trim());
    while (tail.length > 8) tail.shift();
  });
  child.on("exit", () => {
    children.delete(child);
    log.end();
  });
  return { child, tail, logPath };
}

const dataUri = (file: string) => {
  const ext = path.extname(file).slice(1).toLowerCase().replace("jpg", "jpeg");
  return `data:image/${ext};base64,${fs.readFileSync(file).toString("base64")}`;
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: unknown };

/** llama-server and mlx_lm.server both speak the OpenAI chat API. */
class OpenAIServerEngine implements Engine {
  private port = 0;
  private proc?: ReturnType<typeof startProcess>;
  private history: ChatMessage[] = [];

  constructor(
    readonly runtime: string,
    private cmd: string,
    private args: (port: number) => string[],
    private modelField?: string,
  ) {}

  async load(status: (t: string) => void) {
    this.port = await freePort();
    this.proc = startProcess(this.cmd, this.args(this.port), this.runtime);
    const { child, tail, logPath } = this.proc;
    let exited: number | null = null;
    child.on("exit", (code) => (exited = code ?? 1));
    child.stdout!.on("data", () => {});
    const started = Date.now();
    for (;;) {
      if (exited !== null) throw new Error(`${this.runtime} exited (${exited}): ${tail.slice(-3).join(" · ") || "see " + logPath}`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/v1/models`);
        if (res.ok) return;
      } catch {}
      const secs = Math.round((Date.now() - started) / 1000);
      status(tail.length ? tail[tail.length - 1].slice(0, 120) : `starting ${this.runtime}… ${secs}s`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  reset() {
    this.history = [];
  }

  async generate(req: GenRequest, on: (e: GenEvent) => void, signal: AbortSignal) {
    const content = req.images?.length
      ? [...req.images.map((p) => ({ type: "image_url", image_url: { url: dataUri(p) } })), { type: "text", text: req.prompt }]
      : req.prompt;
    const messages = [...this.history, { role: "user" as const, content }];
    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, stream: true, max_tokens: 4096, ...(this.modelField ? { model: this.modelField } : {}) }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`${this.runtime}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    let answer = "";
    let tokens = 0;
    let firstAt = 0;
    const decoder = new TextDecoder();
    let buf = "";
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          const delta = JSON.parse(data).choices?.[0]?.delta ?? {};
          const think = delta.reasoning_content ?? delta.reasoning;
          if (think) on({ type: "thinking", text: think });
          if (delta.content) {
            answer += delta.content;
            on({ type: "token", text: delta.content });
          }
          if (think || delta.content) {
            tokens++;
            firstAt ||= Date.now();
            const secs = (Date.now() - firstAt) / 1000;
            if (secs > 0.2) on({ type: "stats", tokens, tokPerSec: tokens / secs });
          }
        }
      }
      if (tokens) on({ type: "stats", tokens, tokPerSec: tokens / Math.max(0.05, (Date.now() - firstAt) / 1000) });
    } finally {
      // Keep whatever was produced, even if the user pressed esc mid-stream.
      this.history.push({ role: "user", content }, { role: "assistant", content: answer });
    }
  }

  dispose() {
    this.proc?.child.kill("SIGTERM");
  }
}

const PY_DEPS = [
  "torch", "diffusers", "transformers", "accelerate", "pillow", "numpy", "imageio", "imageio-ffmpeg",
  "sentencepiece", "protobuf", "ftfy", "einops",
];

/** A long-lived Python process (diffusers / transformers) driven over JSON lines. */
class PythonWorkerEngine implements Engine {
  readonly runtime: string;
  private proc?: ReturnType<typeof startProcess>;
  private waiters = new Map<number, (e: any) => boolean>();
  private nextId = 1;
  private history: { role: string; content: unknown }[] = [];

  constructor(private task: "image" | "video" | "vision", private model: LocalModel, private uv: string) {
    this.runtime = task === "vision" ? "transformers" : "diffusers";
  }

  load(status: (t: string) => void): Promise<void> {
    const worker = path.resolve(__dirname, "..", "python", "worker.py");
    const out = path.join(OUTPUTS_DIR, this.model.id.replace("/", "__"));
    const args = ["run", "--no-project", "--python", "3.12", ...PY_DEPS.flatMap((d) => ["--with", d]), worker, this.task, this.model.dir, out];
    status("preparing Python runtime (first run downloads torch)…");
    this.proc = startProcess(this.uv, args, this.runtime);
    const { child, tail, logPath } = this.proc;
    return new Promise((resolve, reject) => {
      let ready = false;
      child.on("exit", (code) => {
        if (!ready) reject(new Error(`worker exited (${code}): ${tail.slice(-2).join(" · ") || "see " + logPath}`));
        for (const w of this.waiters.values()) w({ type: "error", message: "worker exited" });
        this.waiters.clear();
      });
      readline.createInterface({ input: child.stdout! }).on("line", (line) => {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "ready") {
          ready = true;
          resolve();
        } else if (ev.type === "fatal") reject(new Error(ev.message));
        else if (ev.type === "status" && !ready) status(ev.text);
        else if (ev.id != null) {
          const w = this.waiters.get(ev.id);
          if (w && w(ev)) this.waiters.delete(ev.id);
        }
      });
    });
  }

  reset() {
    this.history = [];
  }

  generate(req: GenRequest, on: (e: GenEvent) => void, signal: AbortSignal): Promise<void> {
    const id = this.nextId++;
    const id_l = this.model.id.toLowerCase();
    // Distilled models want few steps and no classifier-free guidance.
    const distilled = /schnell|turbo|lightning|lcm|hyper/.test(id_l);
    const steps = distilled ? 4 : this.task === "video" ? 30 : 28;
    const guidance = distilled ? 0 : undefined;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        this.waiters.delete(id); // the worker finishes in the background; its result is dropped
        resolve();
      });
      this.waiters.set(id, (ev) => {
        if (ev.type === "progress") on({ type: "progress", step: ev.step, total: ev.total });
        else if (ev.type === "error") reject(new Error(ev.message));
        else {
          if (ev.type === "text") {
            on({ type: "text", text: ev.text, seconds: ev.seconds });
            this.history.push(
              { role: "user", content: [{ type: "text", text: req.prompt }] },
              { role: "assistant", content: [{ type: "text", text: ev.text }] },
            );
          } else if (ev.type === "image") on({ type: "image", path: ev.path, seconds: ev.seconds });
          else if (ev.type === "video") on({ type: "video", path: ev.path, poster: ev.poster, seconds: ev.seconds });
          resolve();
          return true;
        }
        return false;
      });
      this.proc!.child.stdin!.write(
        JSON.stringify({ id, prompt: req.prompt, images: req.images ?? [], steps, guidance, history: this.history }) + "\n",
      );
    });
  }

  dispose() {
    this.proc?.child.kill("SIGTERM");
  }
}

export function engineFor(m: LocalModel, hw: Hardware): Engine {
  const uv = which("uv");
  if (m.ggufMain) {
    const llama = which("llama-server");
    if (!llama) throw new Error("GGUF models run on llama.cpp. Install it with `brew install llama.cpp`, then /load again.");
    return new OpenAIServerEngine("llama.cpp", llama, (port) => [
      "-m", path.join(m.dir, m.ggufMain!),
      ...(m.mmproj ? ["--mmproj", path.join(m.dir, m.mmproj)] : []),
      "--port", String(port), "--host", "127.0.0.1", "-c", "16384", "--jinja", "-ngl", "999",
    ]);
  }
  if (!uv) throw new Error("This model needs Python tooling via uv. Install it with `brew install uv` (or see docs.astral.sh/uv).");
  if (m.modality === "text") {
    if (hw.kind !== "apple") throw new Error("Safetensors text models run through MLX on Apple Silicon. Pick a GGUF build on this machine.");
    return new OpenAIServerEngine(
      "mlx",
      uv,
      (port) => ["tool", "run", "--python", "3.12", "--from", "mlx-lm", "mlx_lm.server", "--model", m.dir, "--port", String(port), "--host", "127.0.0.1"],
      m.dir,
    );
  }
  if (m.modality === "vision" && m.mlx) throw new Error("MLX vision models aren't supported yet. Try a GGUF build that ships an mmproj file.");
  return new PythonWorkerEngine(m.modality, m, uv);
}
