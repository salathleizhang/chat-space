import { CubeIcon } from "@phosphor-icons/react/Cube";
import { GlobeHemisphereWestIcon } from "@phosphor-icons/react/GlobeHemisphereWest";
import { ImageSquareIcon } from "@phosphor-icons/react/ImageSquare";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { memo } from "react";
import { Panel, ToolbarButton, Tooltip } from "../../shared/ui";
import { SettingsDialog } from "../SettingsDialog";

export type SectionId = "assets" | "images" | "scenes" | "tasks";

const SECTIONS: { id: SectionId; label: string; icon: typeof CubeIcon }[] = [
  { id: "assets", label: "Asset library", icon: CubeIcon },
  { id: "images", label: "Images", icon: ImageSquareIcon },
  { id: "scenes", label: "Scenes", icon: GlobeHemisphereWestIcon },
  { id: "tasks", label: "Generation tasks", icon: ListChecksIcon },
];

interface SidebarProps {
  active: SectionId;
  onChange: (section: SectionId) => void;
}

function DottedDivider() {
  return (
    <span
      className="mx-0.5 grid grid-cols-2 gap-0.5 px-0.5"
      role="separator"
      aria-orientation="vertical"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} className="h-0.5 w-0.5 rounded-full bg-ink-faint" aria-hidden="true" />
      ))}
    </span>
  );
}

export const Sidebar = memo(function Sidebar({ active, onChange }: SidebarProps) {
  return (
    <Panel className="flex items-center gap-1 p-1 rounded-full!">
      {/*
        **没有"返回项目列表"那一颗**（曾经是第一颗 `CubeFocusIcon`）：外壳顶部居中的
        那颗 `<Button aria-label="Leave current scene">` 就是同一个动作（`navigate("/app")`），
        两处并排只是把"离开场景"画了两遍（2026-10-14 用户要求删掉下面这颗）。
        这里因此也不再需要 `useNavigate`。

        设置与它的点状分隔线在**最左端**（2026-10-15 用户要求从最右端挪过来）：
        形状是 `[齿轮][⋮⋮][四个分区]`，分隔线跟在齿轮后面，隔开"设置"与"分区"。
        换顺序时 `sidebar.test.tsx` 钉住的 `aria-label` 序列会红。
      */}
      <SettingsDialog />
      <DottedDivider />
      {SECTIONS.map(({ id, label, icon }) => (
        <Tooltip key={id} content={label} side="top">
          <ToolbarButton
            selected={active === id}
            icon={icon}
            aria-label={label}
            onClick={() => onChange(id)}
          />
        </Tooltip>
      ))}
    </Panel>
  );
});
