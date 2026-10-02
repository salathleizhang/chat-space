import { describe, expect, test } from "bun:test";
import { applyMaterialOverrides, restoreMaterialOverrides, writeMaterialTexture } from "./materialOverride";

const material = (over: Record<string, unknown> = {}) => ({
  diffuseMap: "ORIG-MAP", normalMap: "ORIG-NORMAL", glossMap: "ORIG-GLOSS", glossInvert: false,
  opacityMap: "ORIG-OPACITY", opacityMapChannel: "a", ...over,
});

describe("材质覆盖", () => {
  test("roughnessMap 要写 glossMap **并置 glossInvert**（否则粗糙/光滑对调）", () => {
    const m = material();
    expect(writeMaterialTexture(m, "roughnessMap", "NEW")).toBe(true);
    expect(m.glossMap).toBe("NEW");
    expect(m.glossInvert).toBe(true);
  });

  test("alphaMap 要写 opacityMap 并指定绿通道（three 的默认）", () => {
    const m = material();
    writeMaterialTexture(m, "alphaMap", "NEW");
    expect(m.opacityMap).toBe("NEW");
    expect(m.opacityMapChannel).toBe("g");
  });

  test("同名槽位直接写（map → diffuseMap）", () => {
    const m = material();
    applyMaterialOverrides([m], { map: "NEW" }, new Map());
    expect(m.diffuseMap).toBe("NEW");
    expect(m.normalMap).toBe("ORIG-NORMAL");
  });

  test("还原要**连附加标志一起**还（glossInvert 不能留在 true）", () => {
    const m = material();
    const ledger = new Map();
    applyMaterialOverrides([m], { roughnessMap: "NEW" }, ledger);
    expect(restoreMaterialOverrides(ledger)).toBe(1);
    expect(m.glossMap).toBe("ORIG-GLOSS");
    expect(m.glossInvert).toBe(false);
    expect(ledger.size).toBe(0);
  });

  test("**连开两次**再关：原值必须是第一次那个（记账不被覆盖）", () => {
    const m = material();
    const ledger = new Map();
    applyMaterialOverrides([m], { map: "NEW" }, ledger);
    applyMaterialOverrides([m], { map: "NEW-2" }, ledger);
    restoreMaterialOverrides(ledger);
    expect(m.diffuseMap).toBe("ORIG-MAP");
  });

  test("没覆盖的材质不受影响", () => {
    const a = material();
    const b = material();
    const ledger = new Map();
    applyMaterialOverrides([a], { map: "NEW" }, ledger);
    restoreMaterialOverrides(ledger);
    expect(b.diffuseMap).toBe("ORIG-MAP");
  });
});