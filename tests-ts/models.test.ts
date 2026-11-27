import { describe, expect, it } from "vitest";
import { describeModel, DOWNLOADABLE_MODELS, isHumanModel } from "../src/core/models";

describe("downloadable models catalog", () => {
  it("offers medium and large transformer models alongside the human-like model", () => {
    const names = DOWNLOADABLE_MODELS.map((m) => m.name);
    expect(names).toContain("Human-like model");
    expect(names).toContain("Medium transformer model (b10c512)");
    expect(names).toContain("Large transformer model (b11c768)");
    for (const m of DOWNLOADABLE_MODELS) {
      expect(m.url).toMatch(/^https:\/\/github\.com\/lightvector\/KataGo\/releases\/download\//);
      expect(m.sizeMb).toBeGreaterThan(0);
    }
  });

  it("describes models and detects human-like models", () => {
    expect(describeModel("katrain/models/b10c384h6nbttflrs.bin.gz")).toContain("Small transformer model");
    expect(isHumanModel("/models/b18c384nbt-humanv0.bin.gz")).toBe(true);
    expect(isHumanModel("/models/b10c512h8nbt3tflrs-fson-silu-rsnh.bin.gz")).toBe(false);
  });
});
