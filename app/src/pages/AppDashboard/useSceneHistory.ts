import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AssetMaterial, AssetTransform } from "../../shared/lib/libraryApi";
import { DEFAULT_MATERIAL } from "../../shared/lib/materialOverrides";
// 只取类型：变换模式的权威定义在 gizmo 那边，不在这里另立一份
import type { TransformMode } from "../../widgets/Viewport/TransformGizmo";
import type { LiveTransforms } from "../../widgets/Viewport/liveTransforms";
import type { AssetPlacement } from "../../widgets/Viewport/scenePlacement";

/**
 * 场景编辑的撤销/重做。
 *
 * **范围**：只覆盖用户在视口里的操作——gizmo 拖拽（含多选）与右侧栏的换贴图、数值输入。
 * Agent 的增删资产不进这个栈：那是任务链路的产物，把它塞进来意味着撤销要能回滚付费生成
 * 任务，语义对不上。
 *
 * **每一步记的是"改成了什么"（绝对值），不是"改了多少"（增量）。** 和 Godot 的
 * `EditorUndoRedoManager` 同一个取向：绝对值的逆就是"设回旧值"，而增量在乱序、重试、
 * 合并下会累积漂移。这也正是 `liveTransforms` 那条"拖拽期间走实时表、松手才提交"的边界
 * 能直接当命令切点的原因——松手那一刻的 `updates` 就是一组绝对值。
 *
 * **保存顺序不用这里操心**：撤销发出去的仍是普通的 `commitTransforms` / `setMaterial`，
 * 因此走的还是原来那条队列（摆放是 500ms 防抖 + 串行队列，材质是即时的串行队列）。
 * 只要不绕过它们，就不会出现"撤销的值被在途的旧保存覆盖"。
 */

/** 某个资产在某一刻的状态；缺省的字段表示"这一步没有改它" */
interface SceneEntry {
  placement?: AssetPlacement;
  textures?: AssetMaterial["textures"];
}

/** 一步里对单个资产的改动 */
interface SceneChange {
  assetId: string;
  before: SceneEntry;
  after: SceneEntry;
}

/** 撤销栈里的一步 */
export interface SceneStep {
  changes: SceneChange[];
  /** 界面文案，例如"移动 黑猫" */
  label: string;
}

/**
 * 连续的同资产数值输入合并成一步的窗口。
 * 右侧栏的输入格每敲一个能解析成数字的字符就会提交一次（`NumberField` 的注释写了为什么），
 * 不合并的话输入"12.5"会留下四步撤销。**拖拽不合并**：一次拖拽只提交一次，两次拖拽是两件事。
 */
const COALESCE_MS = 500;

export interface SceneHistoryOptions {
  /** 当前显示的摆放（含未落盘的网格默认位）。查不到说明该资产不可摆放，这一步不入栈 */
  resolvePlacement: (assetId: string) => AssetPlacement | undefined;
  /** 当前生效的材质表（远端叠加本会话改动） */
  materials: Record<string, AssetMaterial>;
  /** 资产是否还存在：被删除的资产不该再被撤销写回，否则留下孤儿记录 */
  isKnownAsset: (assetId: string) => boolean;
  /** 资产显示名，只用于步骤文案 */
  assetLabel: (assetId: string) => string;
  commitTransforms: (updates: Record<string, AssetTransform>) => void;
  setMaterial: (assetId: string, material: AssetMaterial) => void;
  live: LiveTransforms;
}

/** gizmo 的变换模式，决定步骤文案（与视口工具条的英文标签保持一致） */
const MODE_LABEL: Record<TransformMode, string> = {
  translate: "Move",
  rotate: "Rotate",
  scale: "Scale",
};

/** 输入框里的 Cmd+Z 是"撤销打字"，不是撤销场景改动 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useSceneHistory(options: SceneHistoryOptions) {
  /*
    事件处理器里要读"最新的"摆放表与材质表，但它们每次渲染都是新对象。
    用 ref 存一份最新值：栈只在事件里变动（不是渲染期间），所以不存在撕裂读。
  */
  const latest = useRef(options);
  latest.current = options;

  const undoRef = useRef<SceneStep[]>([]);
  const redoRef = useRef<SceneStep[]>([]);
  const lastPushRef = useRef<{ at: number; key: string } | null>(null);
  // 栈放在 ref 里（事件处理器读改写最直接），用一次强制渲染把 canUndo/标签带给界面
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const applyEntry = useCallback((assetId: string, entry: SceneEntry) => {
    const { commitTransforms, setMaterial, isKnownAsset } = latest.current;
    // 资产已被删除：写回只会留下指向不存在资产的孤儿记录
    if (!isKnownAsset(assetId)) return;
    if (entry.placement) commitTransforms({ [assetId]: entry.placement });
    if (entry.textures) setMaterial(assetId, { textures: entry.textures });
  }, []);

  const pushStep = useCallback((step: SceneStep, coalesceKey: string | null) => {
    const now = Date.now();
    const stack = undoRef.current;
    const top = stack[stack.length - 1];
    const last = lastPushRef.current;
    const merged =
      coalesceKey !== null &&
      last !== null &&
      last.key === coalesceKey &&
      now - last.at < COALESCE_MS &&
      top?.changes.length === 1 &&
      step.changes.length === 1 &&
      top.changes[0]!.assetId === step.changes[0]!.assetId;

    if (merged && top) {
      // 留最早的 before、用最新的 after：中间那些按键不该各占一步
      stack[stack.length - 1] = {
        ...top,
        changes: [{ ...top.changes[0]!, after: step.changes[0]!.after }],
      };
    } else {
      stack.push(step);
    }
    lastPushRef.current = { at: now, key: coalesceKey ?? "" };
    // 新的一步让重做分支失效
    redoRef.current = [];
    bump();
  }, []);

  /** gizmo 松手、或右侧栏数值提交。一次可以带多个资产（多选拖拽） */
  const commitPlacements = useCallback(
    (
      updates: Record<string, AssetTransform>,
      source: "drag" | "field",
      /**
       * 变换模式，只用来写步骤文案。右侧栏一次改的是整个变换（position/rotation/scale
       * 都可能），说不出具体是哪种，所以留空并写成 "Adjust"，不硬塞一个可能错的动词。
       */
      mode?: TransformMode,
    ) => {
      const changes: SceneChange[] = [];
      for (const [assetId, placement] of Object.entries(updates)) {
        // 记不住"改之前长什么样"就不入栈：宁可这一步不能撤销，也不要记一步错的
        const before = latest.current.resolvePlacement(assetId);
        if (!before) continue;
        changes.push({ assetId, before: { placement: before }, after: { placement } });
      }
      latest.current.commitTransforms(updates);
      if (changes.length === 0) return;

      const verb = mode ? MODE_LABEL[mode] : "Adjust";
      const label =
        changes.length > 1
          ? `${verb} ${changes.length} objects`
          : `${verb} ${latest.current.assetLabel(changes[0]!.assetId)}`;
      // 只有"输入框连续微调同一个资产"才合并；拖拽与多选一律各占一步
      const coalesceKey =
        source === "field" && changes.length === 1
          ? `field:${changes[0]!.assetId}:placement`
          : null;
      pushStep({ changes, label }, coalesceKey);
    },
    [pushStep],
  );

  /** 右侧栏换贴图。离散动作，不与任何东西合并 */
  const commitMaterial = useCallback(
    (assetId: string, next: AssetMaterial) => {
      const before = latest.current.materials[assetId] ?? DEFAULT_MATERIAL;
      latest.current.setMaterial(assetId, next);
      pushStep(
        {
          changes: [
            {
              assetId,
              before: { textures: before.textures },
              after: { textures: next.textures },
            },
          ],
          label: `Change texture of ${latest.current.assetLabel(assetId)}`,
        },
        null,
      );
    },
    [pushStep],
  );

  const undo = useCallback(() => {
    // 拖拽途中不动基础值：画面此刻由实时表决定，改了只会被松手时的提交再覆盖一次
    if (latest.current.live.size > 0) return;
    const step = undoRef.current.pop();
    if (!step) return;
    for (const change of step.changes) applyEntry(change.assetId, change.before);
    redoRef.current.push(step);
    // 撤销之后的输入不该和撤销前那一步合并
    lastPushRef.current = null;
    bump();
  }, [applyEntry]);

  const redo = useCallback(() => {
    if (latest.current.live.size > 0) return;
    const step = redoRef.current.pop();
    if (!step) return;
    for (const change of step.changes) applyEntry(change.assetId, change.after);
    undoRef.current.push(step);
    lastPushRef.current = null;
    bump();
  }, [applyEntry]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      if (isEditableTarget(event.target)) return;
      // macOS 是 Cmd+Shift+Z，Windows 习惯再加一个 Ctrl+Y
      const wantsRedo = event.shiftKey || key === "y";
      event.preventDefault();
      if (wantsRedo) redo();
      else undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  const undoStack = undoRef.current;
  const redoStack = redoRef.current;
  return {
    commitPlacements,
    commitMaterial,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack[undoStack.length - 1]?.label,
    redoLabel: redoStack[redoStack.length - 1]?.label,
  };
}
