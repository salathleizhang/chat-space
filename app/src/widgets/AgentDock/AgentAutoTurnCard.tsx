import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { ImageIcon } from "@phosphor-icons/react/Image";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import type { AgentAutoTurn } from ".";
import { GeneratedMessageImages } from "./GeneratedMessageImages";

const ICONS: Record<AgentAutoTurn["kind"], typeof MagnifyingGlassIcon> = {
  inspection: MagnifyingGlassIcon,
  identify: ImageIcon,
  tasks: CheckCircleIcon,
};

/**
 * Agent 自发续跑时本轮看的东西：四视角自检图、候选参考图、后台任务结果。
 *
 * 发起者是 Agent 自己——它请求工作台截图、等后台任务收尾，然后继续同一条思路，
 * 所以这里渲染成 Agent 侧的产物卡片而不是用户气泡：图上没有"用户发了张图"的痕迹，
 * 判断紧跟在后面的正文里。缩略图点开是完整检查图（2×2：ISO / 前 / 右 / 顶）。
 */
export function AgentAutoTurnCard({
  attachment,
}: {
  attachment: AgentAutoTurn;
}) {
  const Icon = ICONS[attachment.kind];
  return (
    <div
      data-agent-auto-turn={attachment.kind}
      className="mt-2 ml-[30px] max-w-[calc(100%-30px)] rounded-media border border-hairline px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-subtle">
        <Icon size={14} weight="bold" aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate">{attachment.label}</span>
      </div>
      {attachment.images && attachment.images.length > 0 && (
        <GeneratedMessageImages paths={attachment.images} inset={false} />
      )}
    </div>
  );
}
