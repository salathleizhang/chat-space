import { describe, expect, test } from "bun:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Raycaster, Vector3 } from "three";
import {
  DRAG_MAX_DISTANCE,
  assetIdForObject,
  directionBetween,
  dragMoved,
  draggedPlacement,
  grabOffsetFor,
  pickPlacedAsset,
  pickWithRay,
  pointAlongRay,
} from "./handGrab";
import type { AssetPlacement } from "./scenePlacement";

/**
 * 手势**与场景交互**的纯数学：命中解析（沿父链找身份）、沿射线的搬运、退化输入。
 *
 * 这套判据存在的理由是 PC 侧踩过的坑："命中的实体要按身份解析，不要按名字比"——
 * 比不中的后果是**怎么点都选不中**（把"点中模型"判成"点空白"）。所以身份解析单独立一条。
 */

const placement = (x: number, y: number, z: number): AssetPlacement => ({
  position: [x, y, z],
  rotation: [0, 0.4, 0],
  scale: [1.5, 1.5, 1.5],
});

/** 一棵最小的场景树：`asset:<id>` 根 + 一块真正能被射线打中的子网格 */
function sceneWith(...ids: string[]) {
  const objects = new Map<string, Object3D>();
  const meshes: Mesh[] = [];
  for (const [index, id] of ids.entries()) {
    const root = new Group();
    root.name = `asset:${id}`;
    root.position.set(index * 2, 0, 0);
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    root.add(mesh);
    root.updateMatrixWorld(true);
    objects.set(id, root);
    meshes.push(mesh);
  }
  return { objects, meshes };
}

describe("命中 → 资产 id", () => {
  test("命中的是子网格时沿父链找到登记的根节点（按引用，不按名字）", () => {
    const { objects, meshes } = sceneWith("chair");
    expect(assetIdForObject(meshes[0]!, objects)).toBe("chair");
  });

  test("根节点自己命中也能解析", () => {
    const { objects } = sceneWith("chair");
    expect(assetIdForObject(objects.get("chair")!, objects)).toBe("chair");
  });

  test("不在表里的节点返回 null（不是空串、不是猜一个）", () => {
    const { objects } = sceneWith("chair");
    const stranger = new Group();
    expect(assetIdForObject(stranger, objects)).toBeNull();
    expect(assetIdForObject(null, objects)).toBeNull();
    expect(assetIdForObject(undefined, objects)).toBeNull();
    // 名字像不代表是同一棵树：名字不参与判定
    const impostor = new Group();
    impostor.name = "asset:chair";
    expect(assetIdForObject(impostor, objects)).toBeNull();
  });
});

describe("射线拾取", () => {
  test("打中哪个盒子就返回哪个 id，距离是沿射线量出来的", () => {
    const { objects } = sceneWith("a", "b");
    // 场景里 a 在 x=0、b 在 x=2；从 x=0 正上方朝下打
    const raycaster = new Raycaster();
    raycaster.set(new Vector3(2, 5, 0), new Vector3(0, -1, 0));
    const hit = pickPlacedAsset(raycaster, objects);
    expect(hit?.assetId).toBe("b");
    expect(hit?.distance).toBeCloseTo(4.5, 6);
    expect(hit?.point[1]).toBeCloseTo(0.5, 6);
  });

  test("超过最大距离的命中不算（不然远处的东西会被手抓到）", () => {
    const { objects } = sceneWith("a");
    const hit = pickWithRay({ origin: [0, 20, 0], direction: [0, -1, 0] }, objects, 5);
    expect(hit).toBeNull();
  });

  test("空表与零方向都返回 null（绝不拿零向量去归一化）", () => {
    expect(pickWithRay({ origin: [0, 0, 0], direction: [0, -1, 0] }, new Map())).toBeNull();
    expect(pickWithRay({ origin: [0, 0, 0], direction: [0, 0, 0] }, sceneWith("a").objects)).toBeNull();
  });

  test("根节点下的任何子网格都算命中那件资产（拾取不要求直接命中模型本体）", () => {
    const { objects } = sceneWith("a");
    const decoy = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    decoy.position.set(0, 2, 0);
    decoy.updateMatrixWorld(true);
    // 往资产生成的那棵树里再挂一块网格：射线先打中它，但它沿父链解析到 a
    objects.get("a")!.add(decoy);
    const hit = pickWithRay({ origin: [0, 5, 0], direction: [0, -1, 0] }, objects);
    // 命中的是 decoy（不是盒子本体），但仍应解析成 a
    expect(hit?.assetId).toBe("a");
    expect(hit?.point[1]).toBeCloseTo(2.5, 6);
  });
});

describe("沿着射线搬运", () => {
  test("点 = 起点 + 方向 × 距离，且距离被钳在上限内", () => {
    expect(pointAlongRay([1, 2, 3], [0, -1, 0], 4)).toEqual([1, -2, 3]);
    expect(pointAlongRay([0, 0, 0], [1, 0, 0], DRAG_MAX_DISTANCE + 100)).toEqual([DRAG_MAX_DISTANCE, 0, 0]);
    expect(pointAlongRay([0, 0, 0], [1, 0, 0], -5)).toEqual([0, 0, 0]);
  });

  test("拖动只改位置：姿态与缩放原样保留", () => {
    const base = placement(1, 2, 3);
    const next = draggedPlacement(base, [4, 5, 6]);
    expect(next.position).toEqual([4, 5, 6]);
    expect(next.rotation).toEqual(base.rotation);
    expect(next.scale).toEqual(base.scale);
  });

  test("抓取偏移是「物体原点 − 命中点」：捏在边角上时物体不会跳", () => {
    expect(grabOffsetFor([1, 1, 1], [0.5, 1, 1])).toEqual([0.5, 0, 0]);
  });

  test("「真的挪过没有」按位置距离判，1 mm 以内算没动", () => {
    expect(dragMoved([0, 0, 0], [0.0005, 0, 0])).toBe(false);
    expect(dragMoved([0, 0, 0], [0.002, 0, 0])).toBe(true);
    expect(dragMoved([1, 2, 3], [1, 2, 3])).toBe(false);
  });

  test("方向：两点重合时返回 null（不能归一化零向量）", () => {
    expect(directionBetween([1, 1, 1], [1, 1, 1])).toBeNull();
    const direction = directionBetween([0, 0, 0], [0, 0, -2]);
    expect(direction).toEqual([0, 0, -1]);
  });
});
