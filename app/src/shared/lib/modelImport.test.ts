import { describe, expect, test } from "bun:test";
import { groupModelImportFiles } from "./modelImport";

function file(name: string) {
  return new File([name], name);
}

describe("groupModelImportFiles", () => {
  test("单模型保留全部外部依赖", () => {
    const groups = groupModelImportFiles([
      file("chair.gltf"),
      file("chair.bin"),
      file("albedo.png"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.primary.name).toBe("chair.gltf");
    expect(groups[0]?.auxFiles.map((entry) => entry.name)).toEqual([
      "chair.bin",
      "albedo.png",
    ]);
  });

  test("多个模型各自成为主文件，绝不互相降级成附属文件", () => {
    const groups = groupModelImportFiles([
      file("chair.glb"),
      file("table.fbx"),
      file("shared.png"),
    ]);
    expect(groups.map((group) => group.primary.name)).toEqual(["chair.glb", "table.fbx"]);
    expect(groups.map((group) => group.auxFiles.map((entry) => entry.name))).toEqual([
      ["shared.png"],
      ["shared.png"],
    ]);
  });

  test("没有模型主文件时返回空组", () => {
    expect(groupModelImportFiles([file("material.mtl"), file("albedo.png")])).toEqual([]);
  });
});
