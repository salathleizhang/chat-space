import { CubeIcon } from "@phosphor-icons/react/Cube";
import { CubeFocusIcon } from "@phosphor-icons/react/CubeFocus";
import { GlobeHemisphereWestIcon } from "@phosphor-icons/react/GlobeHemisphereWest";
import { ImageSquareIcon } from "@phosphor-icons/react/ImageSquare";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { memo } from "react";
import { useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();

  return (
    <Panel className="flex items-center gap-1 p-1 rounded-full!">
      <Tooltip content="Back to projects" side="top">
        <ToolbarButton
          icon={CubeFocusIcon}
          aria-label="Back to projects"
          onClick={() => navigate("/app")}
        />
      </Tooltip>
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
      <DottedDivider />
      <SettingsDialog />
    </Panel>
  );
});
