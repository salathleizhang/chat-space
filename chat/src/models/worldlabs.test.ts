import { describe, expect, test } from "bun:test";
import { extractWorldSemantics, type MarbleWorldResponse } from "./worldlabs";

/**
 * 世界响应的语义元数据 → 渲染对齐参数。
 *
 * 这一组的核心是**缺省值**：World Labs 的坐标系是 +Y 朝下（实测 collider 网格 94.7%
 * 的法线指向 −Y），而 Marble 取默认值时**不会**返回 `flip_y`。所以「字段缺失」必须
 * 解释成「要翻转」——照字面理解成 false，整个世界就是倒的。
 */
function world(semantics?: Record<string, unknown>): MarbleWorldResponse {
  return { assets: { splats: { semantics_metadata: semantics } } };
}

describe("extractWorldSemantics", () => {
  test("flip_y 缺失时缺省为 true：Marble 不返回它，不等于不用翻转", () => {
    expect(extractWorldSemantics(world({ metric_scale_factor: 2.5 })).flipY).toBe(true);
    expect(extractWorldSemantics({}).flipY).toBe(true);
  });

  test("显式 flip_y: false 才是不翻转", () => {
    expect(extractWorldSemantics(world({ flip_y: false })).flipY).toBe(false);
  });

  test("缩放与地面偏移原样取出", () => {
    const semantics = extractWorldSemantics(
      world({ metric_scale_factor: 2.6222534, ground_plane_offset: 1.5924374 }),
    );
    expect(semantics.metricScaleFactor).toBeCloseTo(2.6222534, 6);
    expect(semantics.groundPlaneOffset).toBeCloseTo(1.5924374, 6);
  });

  test("缺失或非法数值退回中性缺省，不产生 NaN 变换", () => {
    const semantics = extractWorldSemantics(
      world({ metric_scale_factor: "2.5", ground_plane_offset: Number.NaN }),
    );
    expect(semantics.metricScaleFactor).toBe(1);
    expect(semantics.groundPlaneOffset).toBe(0);
    expect(extractWorldSemantics(world()).metricScaleFactor).toBe(1);
  });
});
