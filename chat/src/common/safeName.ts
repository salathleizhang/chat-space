/**
 * 校验客户端传来的模型导入附属文件名（.mtl/.bin/贴图等）是"安全 basename"：
 * 不含路径分隔符、不是 `..`、不以 `.` 开头（避免伪装成隐藏侧写文件被
 * "可见文件" 过滤逻辑吞掉），防止路径穿越写到资产目录之外。
 */
const SAFE_FILENAME_RE = /^[^/\\]+$/;

export function isSafeFileName(name: string): boolean {
  return SAFE_FILENAME_RE.test(name) && name !== ".." && !name.startsWith(".");
}
