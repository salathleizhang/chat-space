/**
 * 资产库目录约定（docs/image-blast-mastra.md §7 决策 2/4）。
 * 顶层从上游 `worlds/<slug>/` 泛化为项目结构，"世界"是资产类型之一：
 *
 * ~/Gabo/
 *   projects/<project-slug>/
 *     project.json                 项目信封
 *     analysis.json                场景级合并分析
 *     candidates.json              已确认、尚未发布的生成对象
 *     .analyze-reference-<id>.json 待用户确认的参考图分析草稿（成功确认后删除）
 *     plan.json                    agent 的当前计划（no-op 状态，非可执行结构）
 *     scene.json                   共享场景摆放（用户在视口里手动调过的资产变换）
 *     source/
 *       N-<slug>.<ext>             索引源图（0 = 原始输入）
 *       <image>.json               逐图分析
 *     tasks/
 *       <task-id>.json             持久任务状态与无密钥重试规格
 *       <task-id>/work/            初次模型生成工作目录（成功后原子移走）
 *     assets/<asset-slug>/
 *       asset.json                 正式资产提交标记（只存意图与溯源）
 *       N-<slug>.<ext>             生成产物
 *       .N-<slug>-request.json     请求侧写
 *   sessions/<session-id>.json     会话历史（归 chat/，决策 8）
 *
 * 所有函数返回相对资产库根的逻辑路径（云迁移纪律 ①，绝无绝对路径）。
 */

export const LIBRARY_DIRS = {
  projects: "projects",
  sessions: "sessions",
} as const;

export const projectDir = (projectSlug: string) =>
  `${LIBRARY_DIRS.projects}/${projectSlug}`;

export const projectFile = (projectSlug: string) =>
  `${projectDir(projectSlug)}/project.json`;

export const projectAnalysisFile = (projectSlug: string) =>
  `${projectDir(projectSlug)}/analysis.json`;

export const projectCandidatesFile = (projectSlug: string) =>
  `${projectDir(projectSlug)}/candidates.json`;

export const projectPlanFile = (projectSlug: string) =>
  `${projectDir(projectSlug)}/plan.json`;

export const projectSceneFile = (projectSlug: string) =>
  `${projectDir(projectSlug)}/scene.json`;

export const projectSourceDir = (projectSlug: string) =>
  `${projectDir(projectSlug)}/source`;

/** 持久化后台任务；生成工作文件不属于正式资产。 */
export const projectTasksDir = (projectSlug: string) =>
  `${projectDir(projectSlug)}/tasks`;

export const projectTaskFile = (projectSlug: string, taskId: string) =>
  `${projectTasksDir(projectSlug)}/${taskId}.json`;

export const projectTaskWorkDir = (projectSlug: string, taskId: string) =>
  `${projectTasksDir(projectSlug)}/${taskId}/work`;

export const projectAssetsDir = (projectSlug: string) =>
  `${projectDir(projectSlug)}/assets`;

export const assetDir = (projectSlug: string, assetSlug: string) =>
  `${projectAssetsDir(projectSlug)}/${assetSlug}`;

export const assetIdentityFile = (projectSlug: string, assetSlug: string) =>
  `${assetDir(projectSlug, assetSlug)}/asset.json`;

export const sessionFile = (sessionId: string) =>
  `${LIBRARY_DIRS.sessions}/${sessionId}.json`;
