import { describe, expect, test } from "bun:test";
import { glbTriangleCount } from "./glb";

/** 造一个只有 JSON chunk 的 GLB：面数判据只依赖它，BIN chunk 在本模块里根本用不到。 */
function glbOf(gltf: unknown, chunkType = 0x4e4f534a): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
  padded.set(json);
  const bytes = new Uint8Array(20 + padded.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, chunkType, true);
  bytes.set(padded, 20);
  return bytes;
}

const mesh = (primitive: Record<string, unknown>) => ({
  meshes: [{ primitives: [primitive] }],
  accessors: [
    { count: 30 }, // 0：索引数 → 10 个三角面
    { count: 12, mode: 4 }, // 1：非索引顶点数 → 4 个三角面
  ],
});

describe("glbTriangleCount", () => {
  test("有索引时按索引数算，没有索引时按 POSITION 顶点数算", () => {
    expect(glbTriangleCount(glbOf(mesh({ indices: 0, attributes: { POSITION: 1 } })))).toBe(10);
    expect(glbTriangleCount(glbOf(mesh({ attributes: { POSITION: 1 } })))).toBe(4);
  });

  test("多个 mesh / primitive 累加", () => {
    const gltf = {
      meshes: [
        { primitives: [{ indices: 0, attributes: { POSITION: 1 } }] },
        { primitives: [{ indices: 0, attributes: { POSITION: 1 } }] },
      ],
      accessors: [{ count: 9 }, { count: 12 }],
    };
    expect(glbTriangleCount(glbOf(gltf))).toBe(6);
  });

  test("读不出来一律 null（不是 0）：测试夹具那种 4 字节 glTF 魔数、非 GLB、缺 chunk", () => {
    // 仓库里的假 GLB 夹具就是这个形状；当成 0 面会让"要不要减面"静默判否
    expect(glbTriangleCount(new Uint8Array([0x67, 0x6c, 0x54, 0x46]))).toBeNull();
    expect(glbTriangleCount(new Uint8Array(0))).toBeNull();
    expect(glbTriangleCount(new TextEncoder().encode("not a glb at all, but long enough"))).toBeNull();
    // 第二个 chunk 不是 JSON
    expect(glbTriangleCount(glbOf(mesh({ indices: 0 }), 0x004e4942))).toBeNull();
    // 没有网格
    expect(glbTriangleCount(glbOf({ accessors: [] }))).toBeNull();
    // 声明长度超过实际字节（截断）
    const truncated = glbOf(mesh({ indices: 0 }));
    expect(glbTriangleCount(truncated.subarray(0, 24))).toBeNull();
  });

  test("非三角面图元与缺 accessor 判为不知道，不猜", () => {
    expect(glbTriangleCount(glbOf(mesh({ indices: 0, mode: 5 })))).toBeNull();
    expect(glbTriangleCount(glbOf(mesh({ indices: 7 })))).toBeNull();
    expect(glbTriangleCount(glbOf(mesh({ indices: 0 })))).toBe(10);
  });

  test("坏 JSON 不抛异常", () => {
    const bytes = glbOf({ meshes: [{ primitives: [{ indices: 0 }] }], accessors: [{ count: 3 }] });
    bytes[24] = 0x7b; // 把 JSON 首个字符改成 `{`，制造语法错误
    expect(glbTriangleCount(bytes)).toBeNull();
  });
});
