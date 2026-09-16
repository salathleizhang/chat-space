import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { deferred, flush, renderHook } from "../../test-utils";
import type { AssetTransform } from "../../shared/lib/libraryApi";

const actualLibraryApi = await import("../../shared/lib/libraryApi");
const saveSceneTransforms = mock(
  async (_projectSlug: string, _transforms: Record<string, AssetTransform>) => {},
);
mock.module("../../shared/lib/libraryApi", () => ({
  ...actualLibraryApi,
  saveSceneTransforms,
}));

const { useSceneTransforms } = await import("./useSceneTransforms");

const A_TRANSFORM: AssetTransform = {
  position: [1, 2, 3],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};
const B_TRANSFORM: AssetTransform = {
  position: [9, 8, 7],
  rotation: [0, 1, 0],
  scale: [2, 2, 2],
};

beforeEach(() => {
  saveSceneTransforms.mockReset();
  saveSceneTransforms.mockImplementation(async () => {});
});

describe("useSceneTransforms", () => {
  test("删除前 flush 包括防抖快照，清除最后一项后卸载不再写回", async () => {
    const saving = deferred<void>();
    saveSceneTransforms.mockImplementationOnce(() => saving.promise);
    const h = await renderHook(() => useSceneTransforms("project-a", {}), null);
    await act(async () => h.result.current.commitTransforms({ chair: A_TRANSFORM }));
    let finished = false;
    const flushing = h.result.current.flushPendingSave().then(() => { finished = true; });
    await flush();
    expect(saveSceneTransforms.mock.calls).toEqual([["project-a", { chair: A_TRANSFORM }]]);
    expect(finished).toBe(false);
    saving.resolve();
    await flushing;
    await act(async () => h.result.current.dropTransform("chair"));
    await h.unmount();
    await flush(550);
    expect(saveSceneTransforms).toHaveBeenCalledTimes(1);
  });

  test("移除待保存资产时保留其他资产的摆位，卸载只保存剩余项", async () => {
    const h = await renderHook(() => useSceneTransforms("project-a", {}), null);
    await act(async () => h.result.current.commitTransforms({ chair: A_TRANSFORM, desk: B_TRANSFORM }));
    await act(async () => h.result.current.dropTransform("chair"));
    await h.unmount();
    await flush();
    expect(saveSceneTransforms.mock.calls).toEqual([["project-a", { desk: B_TRANSFORM }]]);
  });

  test("删除唯一待保存资产后退出，不冲刷已删除的摆位", async () => {
    const h = await renderHook(() => useSceneTransforms("project-a", {}), null);
    await act(async () => h.result.current.commitTransforms({ chair: A_TRANSFORM }));
    await act(async () => h.result.current.dropTransform("chair"));
    await h.unmount();
    await flush();
    expect(saveSceneTransforms).not.toHaveBeenCalled();
  });

  test("旧保存未完成时新保存排队，不能让旧请求晚到覆盖新位置", async () => {
    const first = deferred<void>();
    saveSceneTransforms.mockImplementationOnce(() => first.promise);
    saveSceneTransforms.mockImplementation(async () => {});
    const h = await renderHook<string, ReturnType<typeof useSceneTransforms>>(
      (slug: string) => useSceneTransforms(slug, {}),
      "project-a",
    );

    await act(async () => h.result.current.commitTransforms({ chair: A_TRANSFORM }));
    await flush(550);
    expect(saveSceneTransforms).toHaveBeenCalledTimes(1);

    await act(async () => h.result.current.commitTransforms({ chair: B_TRANSFORM }));
    await flush(550);
    // 第二班车已产生，但必须等第一班保存兑现后才真正发送。
    expect(saveSceneTransforms).toHaveBeenCalledTimes(1);

    first.resolve();
    await flush();
    expect(saveSceneTransforms.mock.calls).toEqual([
      ["project-a", { chair: A_TRANSFORM }],
      ["project-a", { chair: B_TRANSFORM }],
    ]);
    await h.unmount();
  });
});
