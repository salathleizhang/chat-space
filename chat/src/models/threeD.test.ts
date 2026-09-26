import { describe, expect, test } from "bun:test";
import { config } from "../config";
import { SEED3D_MODEL } from "./seed3d";
import {
  THREE_D_MODELS,
  THREE_D_MODEL_SELECTIONS,
  THREE_D_PROVIDER_IDS,
  threeDModelFor,
} from "./threeD";

describe("3D 模型注册表", () => {
  test("界面选具体模型：每个条目自带渠道与模型 ID", () => {
    expect(THREE_D_MODEL_SELECTIONS).toEqual([
      "seed3d-2",
      "hyper3d-gen2",
      "hi3d-2",
      "tripo-3-1",
    ]);
    expect(THREE_D_MODELS["seed3d-2"]).toEqual({
      label: "Seed3D 2.0",
      provider: "seed3d-direct",
      model: SEED3D_MODEL,
    });
  });

  test("火山两家的模型 ID 跟随 env 覆盖，不在注册表里写死", () => {
    expect(THREE_D_MODELS["hyper3d-gen2"].model).toBe(config.ark3d.hyper3dModel);
    expect(THREE_D_MODELS["hi3d-2"].model).toBe(config.ark3d.hi3dModel);
    expect(THREE_D_MODELS["tripo-3-1"].model).toBe(config.tripo.imageModel);
  });

  test("四条渠道各有一个条目，且渠道值都在白名单内", () => {
    const providers = THREE_D_MODEL_SELECTIONS.map(
      (selection) => THREE_D_MODELS[selection].provider,
    );
    expect([...providers].sort()).toEqual([...THREE_D_PROVIDER_IDS].sort());
  });

  test("选择键是稳定契约：未注册（含旧版渠道名与模型 ID）一律不解析", () => {
    expect(threeDModelFor("hi3d-2")).toEqual(THREE_D_MODELS["hi3d-2"]);
    for (const unknown of [
      "hi3d-volc",
      "hyper3d-direct",
      "doubao-seed3d-2-0-260328",
      "",
      undefined,
      null,
      42,
      { provider: "hi3d-volc" },
    ]) {
      expect(threeDModelFor(unknown)).toBeUndefined();
    }
  });
});
