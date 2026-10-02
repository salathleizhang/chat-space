import type { ViewportHistory } from "./historyTypes";

/**
 * 视口工具栏（**两版共用**）。样式一律**内联**：探针页没有样式表，Tailwind 类会全部失效。
 * 文案与 `aria-label` 与 three 侧同一套，探针按 `aria-label` 可信点击它。
 * **纯展示**：所有状态与副作用都留在调用方（例如"进第一人称要强制单窗格"在父组件回调里做）。
 */
export interface ViewportToolbarProps {
  layout: 1 | 2 | 4;
  onLayout(next: 1 | 2 | 4): void;
  gridVisible: boolean;
  onToggleGrid(): void;
  projection: "perspective" | "orthographic";
  onToggleProjection(): void;
  wireframe: boolean;
  onToggleWireframe(): void;
  history?: ViewportHistory;
  firstPerson: boolean;
  onToggleFirstPerson(): void;
  /** 探针用的挂载点（`[data-pc-toolbar="1"]`）；产品里不传 */
  "data-pc-toolbar"?: string;
}

export function ViewportToolbar(props: ViewportToolbarProps) {
  return (
    <div
      data-pc-toolbar="1"
      style={{ position: "absolute", right: 12, bottom: 12, display: "flex", gap: 6, zIndex: 10 }}
    >
      {([1, 2, 4] as const).map((n) => (
        <button
          key={n}
          type="button"
          aria-label={n === 1 ? "Single view" : n === 2 ? "Two views" : "Four views (Blender layout)"}
          aria-pressed={props.layout === n}
          onClick={() => props.onLayout(n)}
          style={{
            minWidth: 30,
            padding: "4px 8px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.18)",
            background: props.layout === n ? "rgba(120,170,255,0.35)" : "rgba(20,20,22,0.72)",
            color: "#e8e8ea",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {n}
        </button>
      ))}
      <button
        type="button"
        aria-label={props.firstPerson ? "Return to orbit view" : "Enter first-person view"}
        aria-pressed={props.firstPerson}
          onClick={() => props.onToggleFirstPerson()}
        style={{
          padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)",
          background: props.firstPerson ? "rgba(120,170,255,0.35)" : "rgba(20,20,22,0.72)",
          color: "#e8e8ea", fontSize: 12, cursor: "pointer",
        }}
      >
        {props.firstPerson ? "回到轨道" : "第一人称"}
      </button>
      {props.layout === 1 ? (
        <button
          type="button"
          aria-label="Toggle perspective/orthographic view"
          onClick={() => props.onToggleProjection()}
          style={{
            padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(20,20,22,0.72)", color: "#e8e8ea", fontSize: 12, cursor: "pointer",
          }}
        >
          投影
        </button>
      ) : null}
      <button
        type="button"
        aria-label={props.wireframe ? "Solid shading (Shift+Z)" : "Wireframe shading (Shift+Z)"}
        aria-pressed={props.wireframe}
        onClick={() => props.onToggleWireframe()}
        style={{
          padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)",
          background: props.wireframe ? "rgba(120,170,255,0.35)" : "rgba(20,20,22,0.72)",
          color: "#e8e8ea", fontSize: 12, cursor: "pointer",
        }}
      >
        线框
      </button>
      <button
        type="button"
        aria-label={props.gridVisible ? "Hide grid" : "Show grid"}
        aria-pressed={props.gridVisible}
        onClick={() => props.onToggleGrid()}
        style={{
          padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)",
          background: props.gridVisible ? "rgba(120,170,255,0.35)" : "rgba(20,20,22,0.72)",
          color: "#e8e8ea", fontSize: 12, cursor: "pointer",
        }}
      >
        网格
      </button>
      {props.history ? (
        <>
          <button
            type="button"
            aria-label="Undo"
            disabled={!props.history.canUndo}
            title={props.history.undoLabel ? `Undo: ${props.history.undoLabel}` : "Undo"}
            onClick={() => props.history?.undo()}
            style={{
              padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(20,20,22,0.72)", color: "#e8e8ea", fontSize: 12,
              opacity: props.history.canUndo ? 1 : 0.45, cursor: props.history.canUndo ? "pointer" : "default",
            }}
          >
            撤销
          </button>
          <button
            type="button"
            aria-label="Redo"
            disabled={!props.history.canRedo}
            title={props.history.redoLabel ? `Redo: ${props.history.redoLabel}` : "Redo"}
            onClick={() => props.history?.redo()}
            style={{
              padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(20,20,22,0.72)", color: "#e8e8ea", fontSize: 12,
              opacity: props.history.canRedo ? 1 : 0.45, cursor: props.history.canRedo ? "pointer" : "default",
            }}
          >
            重做
          </button>
        </>
      ) : null}
    </div>
  );
}
