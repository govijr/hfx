// Headless end-to-end check: search → pick variant → pull → load → stream a reply.
// usage: HFX_HOME=.hfx-test npx tsx scripts/e2e.ts [repo-id]
import { detectHardware, fmtBytes } from "../src/hardware";
import { listRepoFiles, searchHub, variantsFor } from "../src/hub";
import { pull } from "../src/library";
import { engineFor, killAllEngines } from "../src/engines";

const id = process.argv[2] ?? "mlx-community/Qwen3-0.6B-4bit";

(async () => {
  const hw = detectHardware();
  const m = (await searchHub(id)).find((x) => x.id === id);
  if (!m) throw new Error(`${id} not found`);
  const { variants, preferred } = variantsFor(m, await listRepoFiles(m.id), hw);
  const v = variants[preferred];
  console.log("pulling", m.id, v.label, fmtBytes(v.bytes), `(${v.files.length} files, ${v.fit})`);
  let last = 0;
  const local = await pull(m, v, (p) => {
    if (Date.now() - last > 2000) (last = Date.now()), console.log("  ", fmtBytes(p.done), "/", fmtBytes(p.total));
  }, new AbortController().signal);
  const e = engineFor(local, hw);
  const t0 = Date.now();
  let lastStatus = "";
  await e.load((st) => { if (st !== lastStatus) console.log("  load:", (lastStatus = st)); });
  console.log("loaded on", e.runtime, "in", ((Date.now() - t0) / 1000).toFixed(1) + "s");
  let out = "";
  let stats = "";
  const prompt = local.modality === "image" ? "a red fox reading a book in a cozy library, watercolor"
    : local.modality === "video" ? "a paper boat drifting down a rainy street"
    : "In one sentence, what is a GGUF file? /no_think";
  await e.generate({ prompt }, (ev) => {
    if (ev.type === "token") out += ev.text;
    if (ev.type === "text") out = ev.text;
    if (ev.type === "stats") stats = `${ev.tokens} tok, ${ev.tokPerSec.toFixed(0)} tok/s`;
    if (ev.type === "progress") console.log(`  step ${ev.step}/${ev.total}`);
    if (ev.type === "image") (out = ev.path), (stats = `${ev.seconds.toFixed(1)}s`);
    if (ev.type === "video") (out = `${ev.path} (poster ${ev.poster})`), (stats = `${ev.seconds.toFixed(1)}s`);
  }, new AbortController().signal);
  console.log("result:", out.trim().slice(0, 300), "\nstats:", stats);
  killAllEngines();
  process.exit(0);
})().catch((err) => {
  console.error("FAILED", err);
  killAllEngines();
  process.exit(1);
});
