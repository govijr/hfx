import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hardware } from "./hardware";
import { variantsFor, type HubModel, type RepoFile } from "./hub";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const hw = (budgetGB: number): Hardware => ({ chip: "test", totalBytes: budgetGB * GB, budgetBytes: budgetGB * GB, kind: "cpu" });
const model = (modality: HubModel["modality"] = "text"): HubModel => ({
  id: "owner/repo-GGUF", modality, downloads: 0, likes: 0, gguf: true, mlx: false, gated: false,
});
const file = (path: string, size: number): RepoFile => ({ path, size });
const labels = (r: ReturnType<typeof variantsFor>) => r.variants.map((v) => v.label);
const preferredLabel = (r: ReturnType<typeof variantsFor>) => r.variants[r.preferred]?.label;

test("mixed repo: imatrix.gguf is not a variant and the usual quant is preferred", () => {
  const files = [
    file("README.md", 4096),
    file("Model-Q2_K.gguf", 1.2 * GB),
    file("Model-Q4_K_M.gguf", 1.9 * GB),
    file("Model-Q8_0.gguf", 3.2 * GB),
    file("imatrix.gguf", 3 * MB),
    file("mmproj-Model-BF16.gguf", 0.8 * GB),
  ];
  const r = variantsFor(model("vision"), files, hw(16));
  assert.deepEqual(labels(r), ["Q2_K", "Q4_K_M", "Q8_0"]);
  assert.equal(preferredLabel(r), "Q4_K_M");
  for (const v of r.variants) assert.ok(!v.files.some((f) => /imatrix/i.test(f.path)), v.label);
});

test("auxiliary-only GGUF repos yield no variants and never fall back to other files", () => {
  const repos: RepoFile[][] = [
    [file("imatrix.gguf", 3 * MB)],
    [file("README.md", 4096), file("calib/IMATRIX.GGUF", 3 * MB)],
    [file("README.md", 4096), file("mmproj-F16.gguf", 0.6 * GB), file("imatrix.gguf", 3 * MB)],
  ];
  for (const files of repos) assert.deepEqual(variantsFor(model(), files, hw(16)), { variants: [], preferred: 0 });
});

test("vision projector: the F16 projector rides along with every quant", () => {
  const files = [
    file("Model-Q4_K_M.gguf", 1.9 * GB),
    file("Model-Q6_K.gguf", 2.6 * GB),
    file("mmproj-Model-F32.gguf", 1.2 * GB),
    file("mmproj-Model-F16.gguf", 0.6 * GB),
  ];
  const r = variantsFor(model("vision"), files, hw(16));
  const proj = "mmproj-Model-F16.gguf";
  assert.deepEqual(
    r.variants.map((v) => ({ label: v.label, files: v.files.map((f) => f.path), bytes: v.bytes, ggufMain: v.ggufMain, mmproj: v.mmproj })),
    [
      { label: "Q4_K_M", files: ["Model-Q4_K_M.gguf", proj], bytes: 1.9 * GB + 0.6 * GB, ggufMain: "Model-Q4_K_M.gguf", mmproj: proj },
      { label: "Q6_K", files: ["Model-Q6_K.gguf", proj], bytes: 2.6 * GB + 0.6 * GB, ggufMain: "Model-Q6_K.gguf", mmproj: proj },
    ],
  );
});

test("quant preference: first preferred quant that fits, else largest fitting, else smallest", () => {
  const files = [
    file("M-Q8_0.gguf", 8 * GB),
    file("M-Q2_K.gguf", 1 * GB),
    file("M-Q4_K_M.gguf", 4.5 * GB),
    file("M-Q3_K_S.gguf", 1.5 * GB),
  ];
  const roomy = variantsFor(model(), files, hw(16));
  assert.deepEqual(labels(roomy), ["Q2_K", "Q3_K_S", "Q4_K_M", "Q8_0"]);
  assert.equal(preferredLabel(roomy), "Q4_K_M");
  assert.equal(preferredLabel(variantsFor(model(), files, hw(4))), "Q3_K_S");
  assert.equal(preferredLabel(variantsFor(model(), files, hw(1))), "Q2_K");
});

test("split shards group and sort, draft and imatrix-named models stay, nested imatrix.gguf is dropped", () => {
  const files = [
    file("Q8_0/Model-Q8_0-00002-of-00002.gguf", 3 * GB),
    file("Q8_0/Model-Q8_0-00001-of-00002.gguf", 4 * GB),
    file("Model-Q4_K_M.gguf", 4 * GB),
    file("draft-model.gguf", 0.5 * GB),
    file("Model-Imatrix-Q6_K.gguf", 0.2 * GB),
    file("mmproj/Imatrix.gguf", 3 * MB),
  ];
  const r = variantsFor(model(), files, hw(32));
  assert.deepEqual(labels(r), ["Q6_K", "DRAFT-MODEL", "Q4_K_M", "Q8_0"]);
  const q8 = r.variants.find((v) => v.label === "Q8_0")!;
  assert.deepEqual(q8.files.map((f) => f.path), ["Q8_0/Model-Q8_0-00001-of-00002.gguf", "Q8_0/Model-Q8_0-00002-of-00002.gguf"]);
  assert.equal(q8.ggufMain, "Q8_0/Model-Q8_0-00001-of-00002.gguf");
  assert.equal(preferredLabel(r), "Q4_K_M");
});
