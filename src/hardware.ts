import os from "node:os";
import { execFileSync } from "node:child_process";

export type Modality = "text" | "vision" | "image" | "video";
export type Fit = "fits" | "tight" | "too-big" | "unknown";

export interface Hardware {
  chip: string;
  totalBytes: number;
  /** Memory a model may realistically use (unified memory / VRAM / RAM). */
  budgetBytes: number;
  kind: "apple" | "cuda" | "cpu";
  gpu?: string;
}

const GB = 1024 ** 3;

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

export function detectHardware(): Hardware {
  const totalBytes = os.totalmem();
  if (process.platform === "darwin" && process.arch === "arm64") {
    const chip = run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]) ?? "Apple Silicon";
    // Metal lets the GPU wire roughly 2/3 (≤36 GB) to 3/4 (>36 GB) of unified memory.
    const share = totalBytes > 36 * GB ? 0.75 : 0.67;
    return { chip, totalBytes, budgetBytes: totalBytes * share, kind: "apple" };
  }
  const smi = run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (smi) {
    const [name, mib] = smi.split("\n")[0].split(",").map((s) => s.trim());
    const vram = Number(mib) * 1024 * 1024;
    if (vram > 0) return { chip: os.cpus()[0]?.model ?? "CPU", totalBytes, budgetBytes: vram * 0.92, kind: "cuda", gpu: name };
  }
  return { chip: os.cpus()[0]?.model ?? "CPU", totalBytes, budgetBytes: totalBytes * 0.6, kind: "cpu" };
}

/** Weights on disk → memory needed while running (KV cache / activations included). */
export function memoryNeeded(weightBytes: number, modality: Modality | null): number {
  if (modality === "image" || modality === "video") return weightBytes * 1.25 + 1.5 * GB;
  return weightBytes * 1.1 + 0.8 * GB;
}

export function fitOf(weightBytes: number | undefined, modality: Modality | null, hw: Hardware): Fit {
  if (!weightBytes) return "unknown";
  const need = memoryNeeded(weightBytes, modality);
  if (need <= hw.budgetBytes * 0.85) return "fits";
  if (need <= hw.budgetBytes) return "tight";
  return "too-big";
}

export function fmtBytes(n: number | undefined): string {
  if (!n) return "–";
  if (n >= GB) return `${(n / GB).toFixed(n >= 100 * GB ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function fmtCount(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
