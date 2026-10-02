import { chatFetch, chatResponseError } from "./sse";
import type { AskUserAnswer, AskUserQuestion } from "./chatClient";
import type { ProjectPlan } from "./libraryApi";

/** 会话历史客户端（决策 8：会话由 chat/ 落盘资产库，换浏览器不丢） */

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 已提交且尚未完成自动跟进的后台任务；随会话保存以支持恢复。 */
  pendingTaskIds?: string[];
  /** 等待工作台截图的资产；恢复后继续自检。 */
  pendingInspectionAssetSlug?: string;
  /** 等待主视口截图的整场景检查机位（视角 id）；恢复后继续那次场景检查。 */
  pendingSceneInspectionView?: string;
  /** 消息携带的库内图片（用户附件、自检截图或工具生成图），逻辑路径 */
  images?: string[];
  /** 发送本条消息时选中的资产快照（slug 给 agent，其余字段恢复附件 UI） */
  assets?: {
    assetSlug: string;
    name: string;
    thumbPath?: string;
    kind?: string;
  }[];
  /** assistant 消息内的执行轨迹；恢复会话后完成记录仍可见。 */
  activities?: {
    id: string;
    toolName?: string;
    contentOffset?: number;
    label: string;
    status: "running" | "completed" | "failed";
  }[];
  /** 每轮 Assistant 消息顶部的状态摘要。 */
  agentStatus?: {
    label: string;
    /** waiting = 已把问题交给用户，等卡片被点选或用户直接输入 */
    status: "running" | "waiting" | "completed" | "failed";
  };
  /**
   * ask-user 提问卡片：待回答时渲染成可点选卡片；回答后由 questionAnswer
   * 记录用户选了什么，卡片转为只读。恢复会话后卡片仍可点选——它不依赖任何
   * 服务端状态。
   */
  pendingQuestion?: AskUserQuestion;
  questionAnswer?: AskUserAnswer;
  /** 待回答的问题被用户跳过（直接打字回了别的）；卡片置灰但保留在历史里 */
  supersededQuestion?: boolean;
}

export interface StoredSession {
  id: string;
  projectSlug: string;
  title: string;
  messages: SessionMessage[];
  /** 这条会话最后一次看到的 Agent 计划快照；不与同项目其他会话共享。 */
  plan?: ProjectPlan;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  projectSlug?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** 同一会话的所有保存共用队列，覆盖自动保存、切换和卸载后的在途请求。 */
const saveTails = new Map<string, Promise<void>>();

export async function saveSession(
  projectSlug: string,
  id: string,
  title: string,
  messages: SessionMessage[],
  plan?: ProjectPlan | null,
): Promise<void> {
  // 入队时固定快照，不能等前一请求结束后才读取可变的消息数组。
  const body = JSON.stringify({
    projectSlug,
    title,
    messages,
    ...(plan ? { plan } : {}),
  });
  const request = (saveTails.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const response = await chatFetch(`/api/sessions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!response.ok) {
        throw await chatResponseError(response, `Failed to save conversation (${response.status})`);
      }
    });
  saveTails.set(id, request);
  try {
    await request;
  } finally {
    if (saveTails.get(id) === request) saveTails.delete(id);
  }
}

export async function fetchLatestSession(projectSlug: string): Promise<StoredSession | null> {
  const sessions = await fetchSessions(projectSlug);
  return sessions[0] ? fetchSession(sessions[0].id) : null;
}

export async function fetchSessions(projectSlug: string): Promise<SessionSummary[]> {
  const listResponse = await chatFetch(
    `/api/sessions?project=${encodeURIComponent(projectSlug)}`,
  );
  if (!listResponse.ok) {
    throw await chatResponseError(listResponse, `Failed to load conversations (${listResponse.status})`);
  }
  return ((await listResponse.json()) as { sessions: SessionSummary[] }).sessions;
}

export async function fetchSession(id: string): Promise<StoredSession | null> {
  // 刚离开再回到同一会话时，先等卸载冲刷完成，避免恢复到旧快照。
  await saveTails.get(id)?.catch(() => undefined);
  const response = await chatFetch(`/api/sessions/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to load conversation (${response.status})`);
  }
  return ((await response.json()) as { session: StoredSession }).session;
}
