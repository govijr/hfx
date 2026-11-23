import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fitOf, type Fit, type Hardware, type Modality } from "./hardware";

export const HUB = process.env.HF_ENDPOINT ?? "https://huggingface.co";

export interface HubModel {
  id: string;
  modality: Modality | null;
  pipeline?: string;
  library?: string;
  downloads: number;
  likes: number;
  /** Rough weight size from search metadata; refined once the file tree is fetched. */
  estBytes?: number;
  gguf: boolean;
  mlx: boolean;
  gated: boolean;
}

export interface RepoFile {
  path: string;
  size: number;
}

export interface Variant {
  label: string;
  files: RepoFile[];
  bytes: number;
  fit: Fit;
  ggufMain?: string;
  mmproj?: string;
}

export function hfToken(): string | undefined {
  const env = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  if (env) return env.trim();
  const home = process.env.HF_HOME ?? path.join(os.homedir(), ".cache", "huggingface");
  try {
    return fs.readFileSync(path.join(home, "token"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function hubHeaders(): Record<string, string> {
  const token = hfToken();
  return { "user-agent": "hfx/0.1", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

const DTYPE_BYTES: Record<string, number> = {
  F64: 8, F32: 4, BF16: 2, F16: 2, F8_E4M3: 1, F8_E5M2: 1, I64: 8, I32: 4, U32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1,
};

const PIPELINE_MODALITY: Record<string, Modality> = {
  "text-generation": "text",
  "text2text-generation": "text",
  "image-text-to-text": "vision",
  "visual-question-answering": "vision",
  "image-to-text": "vision",
  "text-to-image": "image",
  "text-to-video": "video",
};

export const MODALITY_PIPELINE: Record<Modality, string> = {
  text: "text-generation",
  vision: "image-text-to-text",
  image: "text-to-image",
  video: "text-to-video",
};

export function modalityOf(pipeline: string | undefined, tags: string[], library?: string): Modality | null {
  const m = pipeline ? PIPELINE_MODALITY[pipeline] : undefined;
  if (m === "image" || m === "video") {
    // We generate pixels through diffusers; other formats (ComfyUI single files, GGUF) aren't runnable yet.
    return library === "diffusers" || tags.includes("diffusers") ? m : null;
  }
  if (m) return m;
  if (!pipeline && tags.includes("gguf")) return "text";
  return null;
}

interface RawModel {
  id: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  library_name?: string;
  tags?: string[];
  gated?: boolean | string;
  safetensors?: { parameters?: Record<string, number>; total?: number };
  gguf?: { total?: number };
}

export async function searchHub(query: string, modality?: Modality, signal?: AbortSignal): Promise<HubModel[]> {
  const params = new URLSearchParams({ search: query, limit: "40", sort: "downloads", direction: "-1" });
  for (const e of ["downloads", "likes", "pipeline_tag", "library_name", "tags", "gated", "safetensors", "gguf"]) {
    params.append("expand[]", e);
  }
  if (modality) params.set("pipeline_tag", MODALITY_PIPELINE[modality]);
  const res = await fetch(`${HUB}/api/models?${params}`, { headers: hubHeaders(), signal });
  if (!res.ok) throw new Error(`Hub search failed: HTTP ${res.status}`);
  const raw = (await res.json()) as RawModel[];
  return raw.map((r) => {
    const tags = r.tags ?? [];
    let estBytes: number | undefined;
    if (r.gguf?.total) estBytes = r.gguf.total * 0.6; // ≈ Q4_K_M
    else if (r.safetensors?.parameters) {
      estBytes = Object.entries(r.safetensors.parameters).reduce((s, [dt, n]) => s + n * (DTYPE_BYTES[dt] ?? 2), 0);
    }
    return {
      id: r.id,
      modality: modalityOf(r.pipeline_tag, tags, r.library_name),
      pipeline: r.pipeline_tag,
      library: r.library_name,
      downloads: r.downloads ?? 0,
      likes: r.likes ?? 0,
      estBytes,
      gguf: tags.includes("gguf"),
      mlx: r.library_name === "mlx" || tags.includes("mlx"),
      gated: Boolean(r.gated),
    };
  });
}

export async function listRepoFiles(id: string, signal?: AbortSignal): Promise<RepoFile[]> {
  const res = await fetch(`${HUB}/api/models/${id}/tree/main?recursive=true`, { headers: hubHeaders(), signal });
  if (res.status === 401 || res.status === 403) throw new Error("gated or private: set HF_TOKEN or run `hf auth login`");
  if (!res.ok) throw new Error(`could not list files: HTTP ${res.status}`);
  const raw = (await res.json()) as { type: string; path: string; size: number; lfs?: { size: number } }[];
  return raw.filter((f) => f.type === "file").map((f) => ({ path: f.path, size: f.lfs?.size ?? f.size }));
}

const QUANT_RE = /[-_.]((?:I?Q\d+(?:_[A-Z0-9]+)*)|(?:B?F16)|F32|MXFP4(?:_MOE)?)(?:-\d{5}-of-\d{5})?\.gguf$/i;
const IMATRIX_RE = /(^|\/)imatrix\.gguf$/i;
const QUANT_PREFERENCE = ["Q4_K_M", "Q5_K_M", "Q4_K_S", "Q6_K", "Q8_0", "Q4_0", "IQ4_XS", "IQ4_NL", "Q3_K_M", "Q5_K_S"];

const SKIP_WITH_SAFETENSORS = /\.(bin|pt|pth|ckpt|msgpack|h5|onnx|onnx_data|ot|tflite|mlmodel)$/i;
const SKIP_ALWAYS = /(^|\/)(onnx|openvino|coreml|flax|tf)\/|^original\/|\.(png|jpe?g|gif|webp|mp4|mov|webm|pdf)$/i;

/** Drop duplicate weight formats so a pull downloads one runnable copy. */
export function runnableFiles(files: RepoFile[]): RepoFile[] {
  const names = new Set(files.map((f) => f.path));
  const hasSafetensors = files.some((f) => f.path.endsWith(".safetensors"));
  const diffusers = names.has("model_index.json");
  const shardedModel = files.some((f) => /^model-\d{5}-of-\d{5}\.safetensors$/.test(f.path));
  return files.filter((f) => {
    const p = f.path;
    if (p.endsWith(".gguf") || SKIP_ALWAYS.test(p)) return false;
    if (hasSafetensors && SKIP_WITH_SAFETENSORS.test(p)) return false;
    if (diffusers && p.endsWith(".safetensors") && !p.includes("/")) return false; // root single-file checkpoints
    if (shardedModel && p === "consolidated.safetensors") return false;
    if (p.endsWith(".safetensors") && !/\.fp16\.safetensors$/.test(p) && names.has(p.replace(/\.safetensors$/, ".fp16.safetensors"))) {
      return false; // keep the fp16 twin only
    }
    return true;
  });
}

export function variantsFor(model: HubModel, files: RepoFile[], hw: Hardware): { variants: Variant[]; preferred: number } {
  // Keep a repo with only IMATRIX.GGUF out of the safetensors fallback.
  const ggufs = files.filter((f) => f.path.endsWith(".gguf") || IMATRIX_RE.test(f.path));
  const sum = (fs: RepoFile[]) => fs.reduce((s, f) => s + f.size, 0);
  if (ggufs.length) {
    const mmprojs = ggufs.filter((f) => /mmproj/i.test(f.path) && !IMATRIX_RE.test(f.path));
    const mmproj = mmprojs.find((f) => /f16/i.test(f.path)) ?? mmprojs[0];
    const groups = new Map<string, RepoFile[]>();
    for (const f of ggufs) {
      if (/mmproj/i.test(f.path) || IMATRIX_RE.test(f.path)) continue;
      const label = (QUANT_RE.exec(f.path)?.[1] ?? path.basename(f.path, ".gguf")).toUpperCase();
      groups.set(label, [...(groups.get(label) ?? []), f]);
    }
    const variants: Variant[] = [...groups.entries()]
      .map(([label, parts]) => {
        parts.sort((a, b) => a.path.localeCompare(b.path));
        const all = mmproj ? [...parts, mmproj] : parts;
        const bytes = sum(all);
        return { label, files: all, bytes, fit: fitOf(bytes, model.modality ?? "text", hw), ggufMain: parts[0].path, mmproj: mmproj?.path };
      })
      .sort((a, b) => a.bytes - b.bytes);
    const fitting = variants.map((v, i) => ({ v, i })).filter(({ v }) => v.fit === "fits");
    let preferred = 0;
    for (const q of QUANT_PREFERENCE) {
      const hit = fitting.find(({ v }) => v.label === q);
      if (hit) { preferred = hit.i; break; }
    }
    if (!fitting.length) preferred = 0;
    else if (!QUANT_PREFERENCE.some((q) => fitting.some(({ v }) => v.label === q))) preferred = fitting[fitting.length - 1].i;
    return { variants, preferred };
  }
  const keep = runnableFiles(files);
  const bytes = sum(keep);
  const label = model.mlx ? "mlx" : model.library === "diffusers" ? "diffusers" : "safetensors";
  return { variants: [{ label, files: keep, bytes, fit: fitOf(bytes, model.modality, hw) }], preferred: 0 };
}
