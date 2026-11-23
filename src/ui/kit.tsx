import fs from "node:fs";
import { useEffect, useState } from "react";
import { Box, Text, makeTheme, useTerminalColors, type Color, type Style, type TextSpan } from "@zenbu-labs/pixel";
import type { Fit, Modality } from "../hardware";
import { useAppState } from "../store";

export type Rgba = [number, number, number, number];

export interface Palette {
  bg: Color;
  fg: Color;
  muted: Color;
  faint: Color;
  hairline: Color;
  field: Color;
  hover: Color;
  accent: Color;
  accentSoft: Color;
  ok: Color;
  warn: Color;
  bad: Color;
  info: Color;
  modality: Record<Modality, Color>;
}

const ACCENT: Rgba = [255, 210, 30, 255];

export function usePalette(): Palette {
  const t = makeTheme(useTerminalColors());
  return {
    bg: t.bg,
    fg: t.fg,
    muted: t.muted,
    faint: t.disabled,
    hairline: t.hairline,
    field: t.field,
    hover: t.hover,
    accent: ACCENT,
    accentSoft: [255, 210, 30, 40],
    ok: [80, 200, 120, 255],
    warn: [240, 170, 60, 255],
    bad: [240, 90, 90, 255],
    info: [110, 170, 255, 255],
    modality: {
      text: [110, 170, 255, 255],
      vision: [190, 130, 255, 255],
      image: [255, 140, 170, 255],
      video: [90, 210, 200, 255],
    },
  };
}

export const useRem = () => useAppState((s) => s.rem);

export type Seg = string | { t: string; c?: Color; b?: boolean; i?: boolean; u?: boolean; bg?: Color };

/** One line of mixed styling. Pixel spans are UTF-8 byte offsets. */
export function Line({ segs, style, color }: { segs: Seg[]; style?: Style; color?: Color }) {
  let text = "";
  const spans: TextSpan[] = [];
  let at = 0;
  for (const seg of segs) {
    const s = typeof seg === "string" ? { t: seg } : seg;
    const len = Buffer.byteLength(s.t);
    if (s.c || s.b || s.i || s.u || s.bg) {
      spans.push({ start: at, end: at + len, color: s.c ?? color ?? [255, 255, 255, 255], bold: s.b, italic: s.i, underline: s.u, background: s.bg });
    }
    text += s.t;
    at += len;
  }
  return (
    <Text style={{ color, ...style }} spans={spans.length ? spans : undefined}>
      {text}
    </Text>
  );
}

export function Pill({ text, color }: { text: string; color: Color }) {
  const rem = useRem();
  const c = color as Rgba;
  return (
    <Box style={{ background: [c[0], c[1], c[2], 45], cornerRadius: rem * 0.3, padding: { left: rem * 0.35, right: rem * 0.35 }, alignItems: "center", flexShrink: 0 }}>
      <Text style={{ color, fontSize: rem * 0.82, fontWeight: "bold", wrap: false }}>{text}</Text>
    </Box>
  );
}

export function FitBadge({ fit }: { fit: Fit }) {
  const p = usePalette();
  const [text, color] =
    fit === "fits" ? ["● fits", p.ok] : fit === "tight" ? ["◐ tight", p.warn] : fit === "too-big" ? ["○ too big", p.bad] : ["· size ?", p.faint];
  return <Text style={{ color, fontSize: useRem() * 0.9 }}>{text}</Text>;
}

export function ProgressBar({ value, color, width }: { value: number; color?: Color; width?: number }) {
  const p = usePalette();
  const rem = useRem();
  const pct = Math.max(0, Math.min(1, value || 0));
  return (
    <Box style={{ width: width ?? rem * 22, height: rem * 0.45, background: p.field, cornerRadius: rem * 0.25, overflow: "hidden" }}>
      <Box style={{ width: `${Math.round(pct * 1000) / 10}%` as `${number}%`, height: "100%", background: color ?? p.accent, cornerRadius: rem * 0.25 }} />
    </Box>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function useTick(ms: number, on = true) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return n;
}
export const spinnerFrame = (n: number) => FRAMES[n % FRAMES.length];

/** Width/height of a PNG from its header, for sizing previews. */
export function pngSize(file: string): [number, number] | null {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    if (b.toString("ascii", 1, 4) !== "PNG") return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } catch {
    return null;
  }
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

