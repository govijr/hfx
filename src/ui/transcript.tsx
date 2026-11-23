import os from "node:os";
import path from "node:path";
import { Box, Image, Markdown, Text } from "@zenbu-labs/pixel";
import { COMMANDS, openPath } from "../controller";
import { fmtBytes } from "../hardware";
import { listLocal, MODELS_DIR } from "../library";
import { useAppState, type Item } from "../store";
import { Line, ProgressBar, fmtDuration, pngSize, spinnerFrame, usePalette, useRem, useTick, type Palette } from "./kit";

const LOGO = [
  "..#####..",
  ".#######.",
  "##.###.##",
  "#########",
  "##.....##",
  ".#######.",
  "..#...#..",
];

function Banner() {
  const p = usePalette();
  const rem = useRem();
  const hw = useAppState((s) => s.hw);
  const px = Math.round(rem * 0.42);
  const local = listLocal();
  const home = MODELS_DIR.replace(os.homedir(), "~");
  return (
    <Box style={{ flexDirection: "row", gap: rem * 1.2, alignItems: "center", padding: { top: rem * 0.6, bottom: rem * 0.8 } }}>
      <Box style={{ flexDirection: "column" }}>
        {LOGO.map((row, y) => (
          <Box key={y} style={{ flexDirection: "row" }}>
            {[...row].map((c, x) => (
              <Box key={x} style={{ width: px, height: px, background: c === "#" ? p.accent : [0, 0, 0, 0] }} />
            ))}
          </Box>
        ))}
      </Box>
      <Box style={{ flexDirection: "column", gap: rem * 0.15 }}>
        <Line color={p.fg} segs={[{ t: "hfx", b: true }, { t: "  v0.1.0", c: p.muted }]} />
        <Line
          color={p.muted}
          segs={[
            hw.chip,
            " · ",
            `${fmtBytes(hw.totalBytes)} ${hw.kind === "apple" ? "unified" : hw.kind === "cuda" ? `RAM · ${hw.gpu}` : "RAM"}`,
            " · ",
            { t: `~${fmtBytes(hw.budgetBytes)} for models`, c: p.accent },
          ]}
        />
        <Line color={p.muted} segs={[home, " · ", `${local.length} model${local.length === 1 ? "" : "s"} downloaded`]} />
      </Box>
    </Box>
  );
}

function Help() {
  const p = usePalette();
  const rem = useRem();
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.2, padding: { left: rem * 1.2 } }}>
      <Line color={p.fg} segs={[{ t: "Just type.", b: true }, " With no model loaded, your text searches the Hub; with one loaded, it's a prompt."]} />
      <Line color={p.muted} segs={["Filter by modality: ", { t: "image flux", c: p.fg }, " · ", { t: "video ltx", c: p.fg }, " · ", { t: "vision qwen vl", c: p.fg }]} />
      <Line color={p.muted} segs={["In results: ", { t: "↑↓", c: p.fg }, " move · ", { t: "←→", c: p.fg }, " quantization · ", { t: "enter", c: p.fg }, " pull & run · ", { t: "esc", c: p.fg }, " close"]} />
      <Box style={{ height: rem * 0.3 }} />
      {COMMANDS.map((c) => (
        <Line key={c.name} color={p.muted} segs={[{ t: `/${c.name}`.padEnd(9), c: p.accent }, { t: (c.args ?? "").padEnd(36), c: p.faint }, c.desc]} />
      ))}
    </Box>
  );
}

function UserMsg({ item, p }: { item: Extract<Item, { kind: "user" }>; p: Palette }) {
  const rem = useRem();
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.4, background: p.field, cornerRadius: rem * 0.35, padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 } }}>
      <Line color={p.fg} segs={[{ t: "› ", c: p.muted }, item.text]} style={{ wrap: true }} />
      {item.images.length > 0 && (
        <Box style={{ flexDirection: "row", gap: rem * 0.5 }}>
          {item.images.map((src) => (
            <Image key={src} src={src} glyph="▣" style={{ height: rem * 6, width: rem * 6, cornerRadius: rem * 0.3 }} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function AssistantMsg({ item, p }: { item: Extract<Item, { kind: "assistant" }>; p: Palette }) {
  const rem = useRem();
  const tick = useTick(90, item.streaming);
  const thinkingTail = item.thinking.split("\n").filter(Boolean).slice(-3).join("\n");
  return (
    <Box style={{ flexDirection: "row", gap: rem * 0.6 }}>
      <Text style={{ color: item.streaming ? p.accent : p.fg }}>{item.streaming && !item.text ? spinnerFrame(tick) : "●"}</Text>
      <Box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, gap: rem * 0.3 }}>
        {item.thinking && !item.text && (
          <Text style={{ color: p.muted, fontStyle: "italic", wrap: true }}>{thinkingTail}</Text>
        )}
        {item.thinking && item.text && <Text style={{ color: p.faint, fontStyle: "italic" }}>✻ thought for a bit</Text>}
        {item.text ? (
          <Markdown
            text={item.text}
            rem={rem}
            streaming={item.streaming}
            theme={{ fg: p.fg, muted: p.muted, link: p.info, inlineCode: p.accent, codeBg: p.field, separator: p.hairline, syntax: {} }}
          />
        ) : null}
        {item.stats && !item.streaming && <Text style={{ color: p.faint, fontSize: rem * 0.85 }}>{item.stats}</Text>}
      </Box>
    </Box>
  );
}

function Download({ item, p }: { item: Extract<Item, { kind: "download" }>; p: Palette }) {
  const rem = useRem();
  const pct = item.total ? item.done / item.total : 0;
  const eta = item.speed > 0 ? fmtDuration(((item.total - item.done) / item.speed) * 1000) : "–";
  const [icon, color, tail] =
    item.state === "done" ? ["✓", p.ok, `${fmtBytes(item.total)} pulled`] :
    item.state === "error" ? ["✗", p.bad, "failed"] :
    item.state === "cancelled" ? ["‖", p.warn, `paused at ${fmtBytes(item.done)}`] :
    ["↓", p.accent, `${fmtBytes(item.done)} / ${fmtBytes(item.total)} · ${fmtBytes(item.speed)}/s · ${eta} left`];
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.3 }}>
      <Line color={p.fg} segs={[{ t: `${icon} `, c: color }, { t: item.model, b: true }, { t: `  ${item.variant}`, c: p.muted }]} />
      <Box style={{ flexDirection: "row", gap: rem * 0.8, alignItems: "center", padding: { left: rem * 1.2 } }}>
        <ProgressBar value={item.state === "done" ? 1 : pct} color={color} />
        <Text style={{ color: p.muted }}>{item.state === "running" ? `${Math.floor(pct * 100)}%  ${tail}` : tail}</Text>
      </Box>
    </Box>
  );
}

function Generation({ item, p }: { item: Extract<Item, { kind: "gen" }>; p: Palette }) {
  const rem = useRem();
  const running = !item.path && !item.failed;
  const tick = useTick(90, running);
  if (running) {
    return (
      <Box style={{ flexDirection: "row", gap: rem * 0.8, alignItems: "center" }}>
        <Text style={{ color: p.accent }}>{spinnerFrame(tick)}</Text>
        {item.total ? <ProgressBar value={item.step / item.total} /> : null}
        <Text style={{ color: p.muted }}>{item.total ? `step ${item.step}/${item.total}` : "warming up…"}</Text>
      </Box>
    );
  }
  if (item.failed) return <Text style={{ color: p.warn }}>‖ cancelled</Text>;
  const preview = item.modality === "video" ? item.poster! : item.path!;
  const [w, h] = pngSize(preview) ?? [1, 1];
  const height = rem * 18;
  const width = Math.round(height * (w / h));
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.4 }}>
      <Box onClick={() => openPath(item.path!)} style={{ width, height, cornerRadius: rem * 0.5, overflow: "hidden", pointerShape: "pointer" }}>
        <Image src={preview} glyph="▣" style={{ width, height }} />
        {item.modality === "video" && (
          <Box style={{ position: "absolute", inset: { top: 0, left: 0, right: 0, bottom: 0 }, justifyContent: "center", alignItems: "center" }}>
            <Box style={{ background: [0, 0, 0, 150], cornerRadius: rem * 2, padding: { left: rem * 1, right: rem * 0.8, top: rem * 0.4, bottom: rem * 0.4 } }}>
              <Text style={{ color: [255, 255, 255, 255], fontSize: rem * 1.6 }}>▶</Text>
            </Box>
          </Box>
        )}
      </Box>
      <Line color={p.faint} segs={[path.basename(item.path!), ` · ${item.seconds?.toFixed(1)}s · click to open`]} style={{ fontSize: rem * 0.85 }} />
    </Box>
  );
}

function Note({ item, p }: { item: Extract<Item, { kind: "note" }>; p: Palette }) {
  const color = item.tone === "error" ? p.bad : item.tone === "ok" ? p.ok : item.tone === "accent" ? p.accent : p.muted;
  return <Line color={p.muted} segs={[{ t: "⎿  ", c: p.faint }, { t: item.text, c: color }]} style={{ wrap: true }} />;
}

function Row({ item }: { item: Item }) {
  const p = usePalette();
  switch (item.kind) {
    case "banner": return <Banner />;
    case "help": return <Help />;
    case "user": return <UserMsg item={item} p={p} />;
    case "assistant": return <AssistantMsg item={item} p={p} />;
    case "download": return <Download item={item} p={p} />;
    case "gen": return <Generation item={item} p={p} />;
    case "note": return <Note item={item} p={p} />;
  }
}

export function Transcript() {
  const items = useAppState((s) => s.items);
  const rem = useRem();
  const p = usePalette();
  return (
    <Box
      style={{
        flexGrow: 1,
        flexShrink: 1,
        overflow: "scroll",
        layout: "list",
        scrollAnchor: "end",
        gap: rem * 0.8,
        padding: { left: rem, right: rem, top: rem * 0.4, bottom: rem * 0.6 },
        scrollbar: { width: rem * 0.2, thumbColor: p.hairline },
        selectable: true,
      }}
    >
      {items.map((it) => (
        <Row key={it.id} item={it} />
      ))}
    </Box>
  );
}
