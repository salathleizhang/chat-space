const PRIMARY_EXT_RE = /\.(glb|gltf|obj|fbx)$/i;

export interface ModelImportGroup {
  primary: File;
  auxFiles: File[];
}

/**
 * 一批拖入/选中的文件按“模型主文件”拆成多个导入组。
 *
 * 非模型文件复制给每一组：glTF/OBJ 的外部依赖文件名可以完全不含主模型 basename，
 * 只按名称猜归属会把纹理或 .bin 漏掉；复制进各自资产目录虽然多占少量磁盘，却能保证
 * 每个模型内部的相对 URI 都可解析。模型文件本身绝不能互相当附属文件，否则第二个 GLB
 * 会以无索引原名落盘、随后永远不被资产扫描识别。
 */
export function groupModelImportFiles(files: File[]): ModelImportGroup[] {
  const primaries = files.filter((file) => PRIMARY_EXT_RE.test(file.name));
  if (primaries.length === 0) return [];
  const auxFiles = files.filter((file) => !PRIMARY_EXT_RE.test(file.name));
  return primaries.map((primary) => ({ primary, auxFiles: [...auxFiles] }));
}
