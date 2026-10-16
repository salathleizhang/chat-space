/**
 * SKP 贴图的平面基补偿（纯计算，无依赖，便于单测钉住）。
 *
 * 背景：openskp 1.3.0 写入端 `faceUvBasis2(points, normal)` 用**面的第一条边**当平面基的
 * u 轴，而它自己的读回端 `faceUvBasis(normal)`（以及文档里 `Face.uvTransform` 的说明）用
 * **法线推出来的规范轴** `normalize(-ny, nx, 0)`。两者只在"第一条边恰好沿规范轴"时一致；
 * 三角汤的第一条边方向任意，于是差一个面内旋转，钉住的 UV 被读成旋转/斜切过的。
 *
 * **哪个基才是 SketchUp 的约定：规范基（法线推出来的那个）。** 判据来自 openskp 自己的
 * Python 参考实现（`packages/python/src/openskp/create.py`，宣称逐特性对照真 SketchUp SDK 验证）：
 *   - `_uv_matrix_for_face` 的注释：拟合用的 basis 是"the basis **SketchUp reads the face's
 *     matrix in**（`face_uv_basis` of the plane normal; `points` no longer matter, kept for
 *     the call sites）"；
 *   - `_solve_uv_matrix` 的注释：该 basis 是"**SketchUp's own, derived from the face NORMAL
 *     alone**（`U = normalize(Z × n)`、`W = n × U`…），the same basis the reader inverts the
 *     matrix in"；
 *   - 同一文件另一处写着"unlike a texture matrix, **whose basis SketchUp fixes**"。
 * 也就是说 TS 版的 `faceUvBasis2` 是移植时留下的旧写法。真实资产实测：直接用 TS 写入器
 * （第一条边基）UV 往返正确率 1.78%，补偿后 100%。
 *（Python 还会把 pins 按材质的 applied size 放大后再拟合；我们不传 applied size，默认
 * 1 英寸/瓦片，放大是恒等，所以不需要那一步。）
 *
 * 补偿做法：先算出"我们真正想存的映射" A_target（uv → 规范基下的平面坐标），再反解出
 * 该喂给写入器的 uv'，使写入器按它自己的基解出来的矩阵恰好等于 A_target：
 *
 *   uv'_i = A_target⁻¹( coords_writer(p_i) )
 *
 * 第一条边沿规范轴时这是恒等变换，不会把本来就对的面弄坏。
 */
export type Vec3 = [number, number, number];
export type Uv = [number, number];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** 与 openskp 读回端 `faceUvBasis` 完全一致的规范基 */
export function canonicalBasis(normal: Vec3): { xr: Vec3; yr: Vec3 } {
  const [nx, ny, nz] = normal;
  const cx = -ny;
  const cy = nx;
  const clen = Math.hypot(cx, cy);
  if (clen < 1e-9) return { xr: [1, 0, 0], yr: [0, nz >= 0 ? 1 : -1, 0] };
  const xr: Vec3 = [cx / clen, cy / clen, 0];
  return { xr, yr: cross(normal, xr) };
}

/** 与 openskp 写入端 `faceUvBasis2` 完全一致的基（u 轴 = 第一条边） */
export function writerBasis(points: readonly Vec3[], normal: Vec3): { u: Vec3; w: Vec3 } {
  const u = normalize([
    points[1]![0] - points[0]![0],
    points[1]![1] - points[0]![1],
    points[1]![2] - points[0]![2],
  ]);
  return { u, w: normalize(cross(normal, u)) };
}

/** 与 openskp 写入端 `planeFromPolygon` 一致的 Newell 法线（保证与写入器同源） */
export function newellNormal(points: readonly Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const [x0, y0, z0] = points[i]!;
    const [x1, y1, z1] = points[(i + 1) % count]!;
    nx += (y0 - y1) * (z0 + z1);
    ny += (z0 - z1) * (x0 + x1);
    nz += (x0 - x1) * (y0 + y1);
  }
  return normalize([nx, ny, nz]);
}

/** 解 3x3 线性方程组（高斯消元；矩阵很小，不需要更重的解法） */
function solve3x3(rows: number[][], rhs: number[]): number[] {
  const a = rows.map((row, index) => [...row, rhs[index]!]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const p = a[col]![col]!;
    if (Math.abs(p) < 1e-12) throw new Error("退化的三角形：UV 映射不可解");
    for (let c = col; c < 4; c++) a[col]![c] = a[col]![c]! / p;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let c = col; c < 4; c++) a[r]![c] = a[r]![c]! - factor * a[col]![c]!;
    }
  }
  return [a[0]![3]!, a[1]![3]!, a[2]![3]!];
}

/**
 * 把"按规范基理解的 UV"换算成"该喂给写入器的 UV"。
 * `points` 必须与传给 `addFace` 的顺序一致。
 */
export function compensateUv(points: readonly Vec3[], rawNormal: Vec3, uvs: readonly Uv[]): Uv[] {
  const length = Math.hypot(rawNormal[0], rawNormal[1], rawNormal[2]) || 1;
  const normal: Vec3 = [rawNormal[0] / length, rawNormal[1] / length, rawNormal[2] / length];
  const { xr, yr } = canonicalBasis(normal);
  const { u, w } = writerBasis(points, normal);

  // A_target：uv → 规范基下的平面坐标，由 3 组对应解出
  const matrix = uvs.map((uv) => [uv[0], uv[1], 1]);
  const targetX = solve3x3(matrix, points.map((point) => dot(point, xr)));
  const targetY = solve3x3(matrix, points.map((point) => dot(point, yr)));

  // A_target⁻¹：规范基坐标 → uv
  const linear = [
    [targetX[0]!, targetX[1]!],
    [targetY[0]!, targetY[1]!],
  ];
  const det = linear[0]![0]! * linear[1]![1]! - linear[0]![1]! * linear[1]![0]!;
  if (Math.abs(det) < 1e-12) throw new Error("退化的三角形：UV 映射不可逆");

  return points.map((point) => {
    const bx = dot(point, u) - targetX[2]!;
    const by = dot(point, w) - targetY[2]!;
    return [
      (bx * linear[1]![1]! - by * linear[0]![1]!) / det,
      (by * linear[0]![0]! - bx * linear[1]![0]!) / det,
    ];
  });
}
