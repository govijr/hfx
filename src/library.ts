import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { Modality } from "./hardware";
import { HUB, hubHeaders, type HubModel, type RepoFile, type Variant } from "./hub";

export const HFX_HOME = process.env.HFX_HOME ?? path.join(os.homedir(), ".hfx");
export const MODELS_DIR = path.join(HFX_HOME, "models");
export const OUTPUTS_DIR = path.join(HFX_HOME, "outputs");

export interface LocalModel {
  id: string;
  dir: string;
  modality: Modality;
  variant: string;
  bytes: number;
  files: string[];
  ggufMain?: string;
  mmproj?: string;
  mlx: boolean;
  library?: string;
  pulledAt: string;
}

const dirFor = (id: string, v: Variant) => path.join(MODELS_DIR, id.replace("/", "__") + (v.ggufMain ? `@${v.label}` : ""));

export function listLocal(): LocalModel[] {
  if (!fs.existsSync(MODELS_DIR)) return [];
  const out: LocalModel[] = [];
  for (const name of fs.readdirSync(MODELS_DIR)) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(MODELS_DIR, name, "hfx.json"), "utf8")));
    } catch {
      /* incomplete pull */
    }
  }
  return out.sort((a, b) => b.pulledAt.localeCompare(a.pulledAt));
}

export function findLocal(id: string, variant?: string): LocalModel | undefined {
  return listLocal().find((m) => m.id.toLowerCase() === id.toLowerCase() && (!variant || m.variant === variant));
}

export function removeLocal(m: LocalModel) {
  fs.rmSync(m.dir, { recursive: true, force: true });
}

export interface PullProgress {
  done: number;
  total: number;
  bytesPerSec: number;
  file: string;
}

const CHUNK = 16 * 1024 * 1024;
const CONNECTIONS = 8;

/** GET with redirects. The HF token is only sent to the Hub itself, never to the CDN it redirects to. */
function httpGet(url: string, headers: Record<string, string>, signal: AbortSignal, hops = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.get(u, { headers, signal }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (hops > 8) return reject(new Error("too many redirects"));
        const next = new URL(loc, u);
        const h = { ...headers };
        if (next.host !== u.host) delete h.authorization;
        return resolve(httpGet(next.toString(), h, signal, hops + 1));
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

interface Chunk {
  file: RepoFile;
  index: number;
  start: number;
  end: number; // inclusive
}

export async function pull(
  model: HubModel,
  variant: Variant,
  onProgress: (p: PullProgress) => void,
  signal: AbortSignal,
): Promise<LocalModel> {
  if (!model.modality) throw new Error("this model type isn't runnable yet");
  const dir = dirFor(model.id, variant);
  fs.mkdirSync(dir, { recursive: true });
  const total = variant.bytes;
  let done = 0;
  let current = "";
  const samples: [number, number][] = [];
  const tick = setInterval(() => {
    const now = Date.now();
    samples.push([now, done]);
    while (samples.length > 2 && now - samples[0][0] > 3000) samples.shift();
    const [t0, d0] = samples[0];
    onProgress({ done, total, bytesPerSec: now > t0 ? ((done - d0) * 1000) / (now - t0) : 0, file: current });
  }, 120);

  // Every file becomes 16 MB range requests in one shared queue, so big files download over many connections.
  const queue: Chunk[] = [];
  const state = new Map<string, { fd: number; remaining: Set<number>; meta: string; part: string; dest: string }>();
  for (const f of variant.files) {
    const dest = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) {
      done += f.size;
      continue;
    }
    const part = `${dest}.part`;
    const meta = `${part}.json`;
    const count = Math.max(1, Math.ceil(f.size / CHUNK));
    let finished: number[] = [];
    try {
      if (fs.statSync(part).size === f.size) finished = JSON.parse(fs.readFileSync(meta, "utf8"));
    } catch {}
    const fd = fs.openSync(part, finished.length ? "r+" : "w");
    if (!finished.length) fs.ftruncateSync(fd, f.size);
    const remaining = new Set<number>();
    for (let i = 0; i < count; i++) {
      const start = i * CHUNK;
      const end = Math.min(f.size, start + CHUNK) - 1;
      if (finished.includes(i)) done += end - start + 1;
      else {
        remaining.add(i);
        queue.push({ file: f, index: i, start, end });
      }
    }
    state.set(f.path, { fd, remaining, meta, part, dest });
  }

  const finishChunk = (c: Chunk) => {
    const st = state.get(c.file.path)!;
    st.remaining.delete(c.index);
    const count = Math.max(1, Math.ceil(c.file.size / CHUNK));
    if (st.remaining.size) {
      const finished = [...Array(count).keys()].filter((i) => !st.remaining.has(i));
      fs.writeFileSync(st.meta, JSON.stringify(finished));
      return;
    }
    fs.closeSync(st.fd);
    fs.renameSync(st.part, st.dest);
    fs.rmSync(st.meta, { force: true });
  };

  const fetchChunk = async (c: Chunk) => {
    const url = `${HUB}/${model.id}/resolve/main/${c.file.path.split("/").map(encodeURIComponent).join("/")}`;
    const { fd } = state.get(c.file.path)!;
    if (c.file.size === 0) return;
    for (let attempt = 0; ; attempt++) {
      let wrote = 0;
      try {
        const res = await httpGet(url, { ...hubHeaders(), range: `bytes=${c.start}-${c.end}` }, signal);
        if (res.statusCode === 401 || res.statusCode === 403) {
          res.resume();
          throw Object.assign(new Error(`${model.id} is gated: accept its licence on huggingface.co and set HF_TOKEN`), { fatal: true });
        }
        if (res.statusCode !== 206 && !(res.statusCode === 200 && c.start === 0 && c.end === c.file.size - 1)) {
          res.resume();
          throw new Error(`download failed for ${c.file.path}: HTTP ${res.statusCode}`);
        }
        current = c.file.path;
        for await (const data of res as AsyncIterable<Buffer>) {
          fs.writeSync(fd, data, 0, data.length, c.start + wrote);
          wrote += data.length;
          done += data.length;
        }
        if (wrote !== c.end - c.start + 1) throw new Error(`short read on ${c.file.path}`);
        return;
      } catch (e: any) {
        done -= wrote; // this chunk restarts from its beginning
        if (signal.aborted || e?.fatal || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  };

  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      await fetchChunk(c);
      finishChunk(c);
    }
  };
  try {
    await Promise.all(Array.from({ length: CONNECTIONS }, worker));
    // Zero-byte files never enter a chunk loop with data; make sure they land.
    for (const [, st] of state) if (fs.existsSync(st.part)) (fs.closeSync(st.fd), fs.renameSync(st.part, st.dest), fs.rmSync(st.meta, { force: true }));
  } catch (e) {
    for (const [, st] of state) {
      try {
        fs.closeSync(st.fd);
      } catch {}
    }
    throw e;
  } finally {
    clearInterval(tick);
  }
  onProgress({ done: total, total, bytesPerSec: 0, file: "" });

  const local: LocalModel = {
    id: model.id,
    dir,
    modality: model.modality,
    variant: variant.label,
    bytes: variant.bytes,
    files: variant.files.map((f) => f.path),
    ggufMain: variant.ggufMain,
    mmproj: variant.mmproj,
    mlx: model.mlx,
    library: model.library,
    pulledAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "hfx.json"), JSON.stringify(local, null, 2));
  return local;
}
