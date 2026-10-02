/**
 * GLB 的**容器级**读取：只看头部与 JSON chunk，不解码几何。
 *
 * 用途是"这个产物到底有多少面"这类判据（自动减面要按真实面数决定跑不跑），而 glTF 的
 * `meshes[].primitives[].indices` 指向的 accessor 里就写着顶点数，JSON chunk 又是整个
 * GLB 里最小的那一段——所以 40 MB 的模型和 40 KB 的模型解析代价几乎一样。绝不为此把
 * BIN chunk（几何本体）读进 three 之类的加载器：那正是"解析一个大 GLB 要烧 CPU"的来源。
 */

const GLB_MAGIC = 0x46546c67; // "glTF" 小端
const CHUNK_JSON = 0x4e4f534a; // "JSON"
/** glTF primitive.mode 的 TRIANGLES；缺省（未写 mode）就是它。 */
const MODE_TRIANGLES = 4;

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

/**
 * 读出 GLB 的三角面数；读不出来一律返回 `null`。
 *
 * **`null` 的含义是"不知道"，不是 0**：调用方必须把它与"面数很小"区分开——本仓库的
 * GLB 测试夹具就是 4 字节的 `glTF` 魔数（没有 chunk），拿 null 当 0 会让"要不要减面"
 * 静默判成否。非 GLB（OBJ/FBX/USD）、截断文件、draco 之类缺 accessor 的写法都走这条。
 */
export function glbTriangleCount(bytes: Uint8Array): number | null {
  if (bytes.length < 20 || readUint32(bytes, 0) !== GLB_MAGIC) return null;
  const chunkLength = readUint32(bytes, 12);
  if (readUint32(bytes, 16) !== CHUNK_JSON) return null;
  if (20 + chunkLength > bytes.length) return null;

  let gltf: unknown;
  try {
    gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + chunkLength)));
  } catch {
    return null;
  }
  if (!gltf || typeof gltf !== "object") return null;
  const meshes = (gltf as { meshes?: unknown }).meshes;
  const accessors = (gltf as { accessors?: unknown }).accessors;
  if (!Array.isArray(meshes) || !Array.isArray(accessors)) return null;

  const countOf = (index: unknown): number | null => {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
    const accessor = accessors[index] as { count?: unknown; mode?: unknown } | undefined;
    if (!accessor || typeof accessor.count !== "number" || accessor.count <= 0) return null;
    return accessor.count;
  };

  let triangles = 0;
  let primitives = 0;
  for (const mesh of meshes) {
    const list = (mesh as { primitives?: unknown }).primitives;
    if (!Array.isArray(list)) continue;
    for (const primitive of list) {
      const source = primitive as {
        mode?: unknown;
        indices?: unknown;
        attributes?: { POSITION?: unknown };
      };
      // 非三角面图元（strip/fan/点/线）不能用 count/3 推：宁可判"不知道"。
      const mode = source.mode === undefined ? MODE_TRIANGLES : source.mode;
      if (mode !== MODE_TRIANGLES) return null;
      const vertexOrIndexCount =
        source.indices !== undefined
          ? countOf(source.indices)
          : countOf(source.attributes?.POSITION);
      if (vertexOrIndexCount === null) return null;
      primitives += 1;
      triangles += vertexOrIndexCount / 3;
    }
  }
  if (primitives === 0) return null;
  return Math.round(triangles);
}
