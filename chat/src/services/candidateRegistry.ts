import { projectCandidatesFile } from "../common/libraryPaths";
import { CandidateRegistrySchema, type CandidateRegistry } from "../dto/library";
import { readJson, writeJson, type AssetStorage } from "./assetStorage";

const mutationTails = new Map<string, Promise<boolean>>();

function emptyRegistry(): CandidateRegistry {
  return { schemaVersion: 1, objects: [], updatedAt: new Date().toISOString() };
}

/** 读 candidates.json；不存在时返回空注册表。读是快照，写方经 mutateCandidates 串行。 */
export async function readCandidates(
  storage: AssetStorage,
  projectSlug: string,
): Promise<CandidateRegistry> {
  const path = projectCandidatesFile(projectSlug);
  if (!(await storage.exists(path))) return emptyRegistry();
  return readJson(storage, path, CandidateRegistrySchema);
}

/**
 * candidates.json 的读改写必须按文件串行：并行 3D 任务完成后的删项、前台工具的确认/
 * 登记写回会在 await 边界交错，不加锁就是经典丢更新。reducer 接收锁内最新注册表，返回
 * 新的注册表（返回 undefined 表示不写）。
 */
export function mutateCandidates(
  storage: AssetStorage,
  projectSlug: string,
  reducer: (
    candidates: CandidateRegistry,
  ) => CandidateRegistry | undefined | Promise<CandidateRegistry | undefined>,
): Promise<boolean> {
  const path = projectCandidatesFile(projectSlug);
  const previous = mutationTails.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const candidates = await readCandidates(storage, projectSlug);
    const next = await reducer(candidates);
    if (next === undefined) return false;
    await writeJson(storage, path, CandidateRegistrySchema, next);
    return true;
  });
  mutationTails.set(path, current);
  return current.finally(() => {
    if (mutationTails.get(path) === current) mutationTails.delete(path);
  });
}
