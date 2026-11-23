import path from "node:path";
import { Box, Input, Text, type Color } from "@zenbu-labs/pixel";
import { attach, choose, COMMANDS, submit } from "../controller";
import { fitOf, fmtBytes, fmtCount } from "../hardware";
import { getState, setState, useAppState, type Row } from "../store";
import { FitBadge, Line, Pill, fmtDuration, spinnerFrame, usePalette, useRem, useTick } from "./kit";
import { Transcript } from "./transcript";

const VISIBLE_ROWS = 8;

export function slashMatches(input: string) {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const q = input.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

function PickerRow({ row, selected }: { row: Row; selected: boolean }) {
  const p = usePalette();
  const rem = useRem();
  const hw = useAppState((s) => s.hw);
  const bg: Color = selected ? p.hover : [0, 0, 0, 0];
  const bar = { left: [rem * 0.2, selected ? p.accent : [0, 0, 0, 0]] as [number, Color] };
  if (row.kind === "local") {
    const m = row.model;
    return (
      <Box style={{ flexDirection: "row", gap: rem * 0.8, alignItems: "center", background: bg, border: bar, padding: { left: rem * 0.5, right: rem * 0.5 } }}>
        <Box style={{ width: rem * 6, flexShrink: 0 }}><Pill text={m.modality.toUpperCase()} color={p.modality[m.modality]} /></Box>
        <Box style={{ flexGrow: 1, flexShrink: 1 }}><Text style={{ color: p.fg, ellipsis: true, fontWeight: selected ? "bold" : "normal" }}>{m.id}</Text></Box>
        <Text style={{ color: p.muted }}>{m.variant}</Text>
        <Text style={{ color: p.muted }}>{fmtBytes(m.bytes)}</Text>
        <FitBadge fit={fitOf(m.bytes, m.modality, hw)} />
      </Box>
    );
  }
  const m = row.model;
  const variant = Array.isArray(row.variants) ? row.variants[row.variantIndex] : undefined;
  const bytes = variant?.bytes ?? m.estBytes;
  const runnable = !!m.modality;
  return (
    <Box style={{ flexDirection: "row", gap: rem * 0.8, alignItems: "center", background: bg, border: bar, padding: { left: rem * 0.5, right: rem * 0.5 } }}>
      <Box style={{ width: rem * 6, flexShrink: 0 }}>
        {m.modality ? <Pill text={m.modality.toUpperCase()} color={p.modality[m.modality]} /> : <Text style={{ color: p.faint, fontSize: rem * 0.82 }}>{(m.pipeline ?? "other").slice(0, 8)}</Text>}
      </Box>
      <Box style={{ flexGrow: 1, flexShrink: 1 }}><Text style={{ color: runnable ? p.fg : p.faint, ellipsis: true, fontWeight: selected ? "bold" : "normal" }}>{m.id}</Text></Box>
      {m.gated && <Text style={{ color: p.warn, fontSize: rem * 0.85 }}>gated</Text>}
      <Text style={{ color: p.muted, width: rem * 6, flexShrink: 0 }}>{(variant ? "" : "~") + fmtBytes(bytes)}</Text>
      <Text style={{ color: p.faint, width: rem * 5, flexShrink: 0 }}>{"↓" + fmtCount(m.downloads)}</Text>
      <Box style={{ width: rem * 7, flexShrink: 0 }}>{runnable ? <FitBadge fit={variant?.fit ?? fitOf(bytes, m.modality, hw)} /> : <Text style={{ color: p.faint }}>n/a</Text>}</Box>
    </Box>
  );
}

function VariantStrip({ row }: { row: Row | undefined }) {
  const p = usePalette();
  const rem = useRem();
  const tick = useTick(90, row?.kind === "hub" && row.variants === "loading");
  if (!row || row.kind !== "hub") return null;
  if (!row.model.modality) {
    return <Text style={{ color: p.faint }}>{`${row.model.pipeline ?? "This"} models aren't runnable in hfx yet.`}</Text>;
  }
  if (row.variants === undefined || row.variants === "loading") return <Text style={{ color: p.muted }}>{`${spinnerFrame(tick)} reading repo…`}</Text>;
  if (typeof row.variants === "string") return <Text style={{ color: p.bad }}>{row.variants}</Text>;
  const vs = row.variants;
  const cur = vs[row.variantIndex];
  return (
    <Box style={{ flexDirection: "row", gap: rem * 0.5, alignItems: "center", flexWrap: "wrap" }}>
      {vs.length > 1 && <Text style={{ color: p.faint }}>‹</Text>}
      {vs.map((v, i) => {
        const on = i === row.variantIndex;
        const c = v.fit === "fits" ? p.ok : v.fit === "tight" ? p.warn : v.fit === "too-big" ? p.bad : p.muted;
        return (
          <Box key={v.label} style={{ background: on ? p.accentSoft : [0, 0, 0, 0], border: { width: 1, color: on ? p.accent : p.hairline }, cornerRadius: rem * 0.3, padding: { left: rem * 0.35, right: rem * 0.35 } }}>
            <Line color={on ? p.fg : p.muted} segs={[{ t: v.label, b: on }, { t: ` ${fmtBytes(v.bytes)}`, c }]} style={{ fontSize: rem * 0.85 }} />
          </Box>
        );
      })}
      {vs.length > 1 && <Text style={{ color: p.faint }}>›</Text>}
      <Text style={{ color: p.faint, fontSize: rem * 0.85 }}>{cur.mmproj ? "  + vision projector" : ""}</Text>
    </Box>
  );
}

function Picker() {
  const picker = useAppState((s) => s.picker);
  const p = usePalette();
  const rem = useRem();
  const tick = useTick(90, !!picker?.loading);
  if (!picker) return null;
  const start = Math.max(0, Math.min(picker.index - Math.floor(VISIBLE_ROWS / 2), picker.rows.length - VISIBLE_ROWS));
  const visible = picker.rows.slice(start, start + VISIBLE_ROWS);
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.25, margin: { left: rem, right: rem, bottom: rem * 0.4 }, padding: rem * 0.6, border: { width: 1, color: p.hairline }, cornerRadius: rem * 0.5 }}>
      <Box style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Line color={p.fg} segs={[{ t: "◆ ", c: p.accent }, { t: picker.title, b: true }, { t: picker.rows.length ? `  ${picker.index + 1}/${picker.rows.length}` : "", c: p.faint }]} />
        <Text style={{ color: p.faint, fontSize: rem * 0.85 }}>↑↓ move · ←→ quant · enter pull & run · esc close</Text>
      </Box>
      {picker.loading && <Text style={{ color: p.muted }}>{`${spinnerFrame(tick)} searching the Hub…`}</Text>}
      {picker.error && <Text style={{ color: p.bad }}>{picker.error}</Text>}
      {!picker.loading && !picker.error && !picker.rows.length && <Text style={{ color: p.muted }}>No models found. Try fewer words.</Text>}
      {visible.map((row, i) => (
        <Box key={row.kind === "hub" ? row.model.id : row.model.dir} onClick={() => {
          const index = start + i;
          if (getState().picker?.index === index) void choose();
          else setState((s) => ({ picker: s.picker && { ...s.picker, index } }));
        }}>
          <PickerRow row={row} selected={start + i === picker.index} />
        </Box>
      ))}
      {picker.rows.length > 0 && (
        <Box style={{ padding: { top: rem * 0.3, left: rem * 0.7 } }}>
          <VariantStrip row={picker.rows[picker.index]} />
        </Box>
      )}
    </Box>
  );
}

function SlashMenu() {
  const input = useAppState((s) => s.input);
  const index = useAppState((s) => s.slashIndex);
  const p = usePalette();
  const rem = useRem();
  const matches = slashMatches(input);
  if (!matches.length) return null;
  return (
    <Box style={{ flexDirection: "column", padding: { left: rem * 2, bottom: rem * 0.3 } }}>
      {matches.map((c, i) => (
        <Line
          key={c.name}
          color={p.muted}
          style={{ background: i === index ? p.hover : undefined }}
          segs={[{ t: `/${c.name}`.padEnd(10), c: i === index ? p.accent : p.fg, b: i === index }, { t: (c.args ?? "").padEnd(36), c: p.faint }, c.desc]}
        />
      ))}
    </Box>
  );
}

function StatusLine() {
  const busy = useAppState((s) => s.busy);
  const p = usePalette();
  const rem = useRem();
  const tick = useTick(90, !!busy);
  if (!busy) return null;
  return (
    <Box style={{ flexDirection: "row", gap: rem * 0.6, padding: { left: rem, right: rem, bottom: rem * 0.3 } }}>
      <Text style={{ color: p.accent }}>{spinnerFrame(tick)}</Text>
      <Line
        color={p.muted}
        style={{ flexShrink: 1, ellipsis: true }}
        segs={[{ t: `${busy.label}…`, c: p.accent, b: true }, `  ${fmtDuration(Date.now() - busy.startedAt)}`, busy.cancellable ? " · esc to interrupt" : "", busy.detail ? `  ${busy.detail}` : ""]}
      />
    </Box>
  );
}

function Prompt() {
  const input = useAppState((s) => s.input);
  const attachments = useAppState((s) => s.attachments);
  const active = useAppState((s) => s.active);
  const picker = useAppState((s) => s.picker);
  const p = usePalette();
  const rem = useRem();
  const placeholder = picker
    ? "enter to pull & run the highlighted model, or type a new search"
    : active
      ? active.model.modality === "image" ? "Describe an image…" : active.model.modality === "video" ? "Describe a video…" : "Message the model…  (paste or drop images)"
      : 'Search Hugging Face, e.g. "qwen3", "image flux", "video wan"  ·  / for commands';
  return (
    <Box style={{ flexDirection: "column", margin: { left: rem, right: rem }, border: { top: [1, p.hairline], bottom: [1, p.hairline] }, padding: { top: rem * 0.35, bottom: rem * 0.35 } }}>
      {attachments.length > 0 && (
        <Box style={{ flexDirection: "row", gap: rem * 0.5, padding: { left: rem * 1.4, bottom: rem * 0.3 } }}>
          {attachments.map((a, i) => (
            <Text key={a} style={{ color: p.info, fontSize: rem * 0.9 }}>{`[image ${i + 1}: ${path.basename(a)}]`}</Text>
          ))}
        </Box>
      )}
      <Box style={{ flexDirection: "row", gap: rem * 0.6, alignItems: "center" }}>
        <Text style={{ color: p.fg, fontWeight: "bold" }}>›</Text>
        <Box style={{ flexGrow: 1, flexShrink: 1 }}>
          <Input
            autoFocus
            value={input}
            caretShape="block"
            caretColor={p.accent}
            selectionColor={p.accentSoft}
            style={{ wrap: false, color: p.fg, width: "100%" }}
            onChange={(text) => setState({ input: text, slashIndex: 0, historyIndex: -1 })}
            onSubmit={(text) => {
              const matches = slashMatches(text);
              if (matches.length) {
                const c = matches[getState().slashIndex] ?? matches[0];
                if (c.args) return setState({ input: `/${c.name} `, slashIndex: 0 });
                return void submit(`/${c.name}`);
              }
              void submit(text);
            }}
            onPasteImage={(img) => attach(img.path)}
          />
          {!input && (
            <Box style={{ position: "absolute", inset: { left: 0, top: 0 }, pointerShape: "text" }}>
              <Text style={{ color: p.faint }}>{placeholder}</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function Footer() {
  const active = useAppState((s) => s.active);
  const p = usePalette();
  const rem = useRem();
  return (
    <Box style={{ flexDirection: "row", justifyContent: "space-between", padding: { left: rem * 1.5, right: rem, top: rem * 0.3, bottom: rem * 0.3 } }}>
      {active ? (
        <Line
          color={p.muted}
          segs={[{ t: "● ", c: p.modality[active.model.modality] }, { t: active.model.id, c: p.fg }, `  ${active.model.variant} · ${active.model.modality} · ${active.runtime}`]}
        />
      ) : (
        <Line color={p.muted} segs={[{ t: "○ ", c: p.faint }, "no model loaded"]} />
      )}
      <Text style={{ color: p.faint }}>/ commands · ↑↓ history · ctrl+c quit</Text>
    </Box>
  );
}

export function App() {
  return (
    <Box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <Transcript />
      <Picker />
      <StatusLine />
      <SlashMenu />
      <Prompt />
      <Footer />
    </Box>
  );
}
