import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import {
  MATERIAL_TEXTURE_SLOTS,
  type AssetMaterial,
  type LibraryAsset,
  type MaterialTextureSlot,
  type Vec3,
} from "../../shared/lib/libraryApi";
import { DEFAULT_MATERIAL, normalizeMaterial } from "../../shared/lib/materialOverrides";
import { Panel } from "../../shared/ui";
import type { LiveTransforms } from "../Viewport/liveTransforms";
import { NumberField } from "./NumberField";
import { TextureChannels } from "./TextureChannels";

/**
 * 右侧栏：选中单个模型后的检查器。上半是摆放（position / rotate / scale），下半是材质
 * （按通道替换贴图）。
 *
 * 为什么单独开一栏而不是继续往左侧模型栏里塞：左侧栏回答"项目里有什么"，是列表；
 * 这里回答"当前这个是什么样"，是详情。两者随选中变化的关系完全相反（列表不随选中变，
 * 详情完全由选中决定），混在一起会让列表的分区切换（资产/图片/场景/任务）也跟着语义打架。
 *
 * 面板外壳与左侧模型栏逐项对齐（Panel + w-64 + 同一套 header/行/圆角 token），
 * 视觉上两者是同一套 chrome 的两端。
 */

/** 欧拉旋转在磁盘上是弧度（与 three 的 Object3D 一致），给用户看和让用户输的是度 */
const RAD_TO_DEG = 180 / Math.PI;

const AXES = ["X", "Y", "Z"] as const;

/** 摆放里的三个分组：标签、显示精度、单位换算 */
const TRANSFORM_ROWS = [
  { key: "position", label: "Position", precision: 3, scale: 1 },
  { key: "rotation", label: "Rotation", precision: 1, scale: RAD_TO_DEG },
  { key: "scale", label: "Scale", precision: 3, scale: 1 },
] as const;

type TransformKey = (typeof TRANSFORM_ROWS)[number]["key"];

function TransformRow({
  label,
  precision,
  value,
  onChange,
}: {
  label: string;
  precision: number;
  /** 已经换算成显示单位的分量 */
  value: Vec3;
  onChange: (axis: 0 | 1 | 2, value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      <span className="text-xs text-ink-subtle">{label}</span>
      <div className="flex items-center gap-1">
        {AXES.map((axis, index) => (
          <NumberField
            key={axis}
            axis={axis}
            label={`${label} ${axis}`}
            precision={precision}
            value={value[index] ?? 0}
            onChange={(next) => onChange(index as 0 | 1 | 2, next)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Transform 三行。**只有这一小块订阅拖拽中的实时值**，这是刻意的：
 * gizmo 拖拽时每帧都会写一次实时摆放，如果把订阅放在 Inspector 上，整块面板（含贴图通道
 * 列表、缩略图、浮层）就会跟着每帧重渲染。订阅下沉到这里之后，每帧重渲染的范围只有 9 个
 * 输入格，场景树那边更是一帧都不重渲染（各窗格命令式读同一张表）。
 */
function TransformSection({
  assetId,
  live,
  transform,
  onTransformChange,
}: {
  assetId: string;
  live: LiveTransforms;
  /** 已提交的生效摆放；没有拖拽时用它 */
  transform: { position: Vec3; rotation: Vec3; scale: Vec3 };
  onTransformChange: (transform: { position: Vec3; rotation: Vec3; scale: Vec3 }) => void;
}) {
  const getLive = useCallback(() => live.get(assetId), [live, assetId]);
  // getSnapshot 返回表里那个对象本身：没拖拽时稳定返回 undefined，写入时每帧换新对象，
  // 所以"没变就不重渲染、变了才重渲染"由 Object.is 天然成立，不需要额外的版本号
  const dragging = useSyncExternalStore(live.subscribe, getLive, getLive);
  const effective = dragging ?? transform;

  const updateAxis = useCallback(
    (key: TransformKey, scale: number, axis: 0 | 1 | 2, raw: number) => {
      // 输入框给的是显示单位（度），落盘必须是弧度
      const next = raw / scale;
      const currentVec = effective[key];
      if (currentVec[axis] === next) return;
      const vector = [...currentVec] as Vec3;
      vector[axis] = next;
      onTransformChange({ ...effective, [key]: vector });
    },
    [effective, onTransformChange],
  );

  return (
    <section className="flex flex-col gap-0.5">
      <h2 className="px-1 pt-1 pb-1 text-[11px] tracking-wide text-ink-subtle uppercase">
        Transform
      </h2>
      {TRANSFORM_ROWS.map((row) => (
        <TransformRow
          key={row.key}
          label={row.label}
          precision={row.precision}
          value={effective[row.key].map((v) => v * row.scale) as Vec3}
          onChange={(axis, value) => updateAxis(row.key, row.scale, axis, value)}
        />
      ))}
    </section>
  );
}

export interface InspectorProps {
  asset: LibraryAsset;
  /** 该资产在场景里的**生效**摆放（磁盘记录叠加网格默认位，见 scenePlacement） */
  transform: { position: Vec3; rotation: Vec3; scale: Vec3 };
  onTransformChange: (transform: { position: Vec3; rotation: Vec3; scale: Vec3 }) => void;
  /** 拖拽期间的实时摆放表；拖拽时栏里的数字跟着它走（见 liveTransforms.ts） */
  live: LiveTransforms;
  /** scene.json 里的材质覆盖；无记录即供应商原材质 */
  material: AssetMaterial | undefined;
  onMaterialChange: (material: AssetMaterial) => void;
  /** 可当贴图用的工程图片逻辑路径（参考图 + 该资产的源图） */
  images: string[];
}

export const Inspector = memo(function Inspector({
  asset,
  transform,
  onTransformChange,
  live,
  material,
  onMaterialChange,
  images,
}: InspectorProps) {
  const current = useMemo(() => normalizeMaterial(material), [material]);

  const updateTexture = useCallback(
    (slot: MaterialTextureSlot, path: string | null) => {
      const textures = { ...current.textures };
      if (path) textures[slot] = path;
      else delete textures[slot];
      onMaterialChange({ ...current, textures });
    },
    [current, onMaterialChange],
  );

  const slots = MATERIAL_TEXTURE_SLOTS;
  const replaced = Object.keys(current.textures).length;

  return (
    <Panel className="flex max-h-[70vh] w-64 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <span className="min-w-0 truncate text-sm font-medium text-ink-strong">
          {asset.name}
        </span>
        <span className="shrink-0 text-[11px] text-ink-subtle">
          {asset.modelExt?.toUpperCase() ?? ""}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <TransformSection
          assetId={asset.id}
          live={live}
          transform={transform}
          onTransformChange={onTransformChange}
        />

        <div className="mx-1 h-px bg-line" role="separator" />

        <section className="flex flex-col gap-0.5">
          <h2 className="px-1 pt-1 pb-1 text-[11px] tracking-wide text-ink-subtle uppercase">
            Material
          </h2>
          <TextureChannels
            asset={asset}
            slots={slots}
            textures={current.textures}
            images={images}
            onChange={updateTexture}
          />
          {replaced > 0 && (
            <div className="px-1 pt-1">
              <button
                type="button"
                onClick={() => onMaterialChange(DEFAULT_MATERIAL)}
                className="w-full rounded-inset px-3 py-1.5 text-left text-xs text-ink-subtle transition-colors hover:bg-fill"
              >
                Reset all {replaced} replaced {replaced === 1 ? "texture" : "textures"}
              </button>
            </div>
          )}
        </section>
      </div>
    </Panel>
  );
});
