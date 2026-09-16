import { describe, expect, test } from "bun:test";
import type { AnimationClip, Object3D } from "three";
import { mergeLoadedModel, type LoadedModel } from "./modelAssembly";

function model(object: object, animations: object[]): LoadedModel {
  return { object: object as Object3D, animations: animations as AnimationClip[] };
}

describe("ModelMesh 加载登记", () => {
  test("相同底层资源即使包在新对象里，也不重复更新 state", () => {
    const object = {};
    const animations: object[] = [];
    const registered = mergeLoadedModel([null], 0, model(object, animations));

    // 复现原回归：loader render-prop 每次渲染都曾创建一个新的外层对象字面量。
    expect(mergeLoadedModel(registered, 0, model(object, animations))).toBe(registered);
  });

  test("底层对象或动画集合真的变化时才创建新装配状态", () => {
    const original = model({}, []);
    const current = [original];
    const replacement = model({}, []);

    const next = mergeLoadedModel(current, 0, replacement);
    expect(next).not.toBe(current);
    expect(next[0]).toBe(replacement);
  });
});
