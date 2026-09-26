import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { deferred, flush, renderHook } from "../../test-utils";
import type { AssetMaterial } from "../../shared/lib/libraryApi";

const actualLibraryApi = await import("../../shared/lib/libraryApi");
const saveSceneMaterials = mock(
  async (_projectSlug: string, _materials: Record<string, AssetMaterial>) => {},
);
mock.module("../../shared/lib/libraryApi", () => ({
  ...actualLibraryApi,
  saveSceneMaterials,
}));

const { useAssetMaterials } = await import("./useAssetMaterials");

const A_MATERIAL: AssetMaterial = { textures: {} };
const B_MATERIAL: AssetMaterial = {
  textures: { map: "projects/p/source/1-ref.png" },
};

beforeEach(() => {
  saveSceneMaterials.mockReset();
  saveSceneMaterials.mockImplementation(async () => {});
});

describe("useAssetMaterials", () => {
  test("离散编辑立即落盘，不做防抖；本地值立刻覆盖服务端快照", async () => {
    const h = await renderHook(
      () => useAssetMaterials("project-a", { chair: A_MATERIAL }),
      null,
    );
    expect(h.result.current.materials.chair).toEqual(A_MATERIAL);

    await act(async () => h.result.current.setMaterial("chair", B_MATERIAL));
    await flush();
    expect(saveSceneMaterials.mock.calls).toEqual([["project-a", { chair: B_MATERIAL }]]);
    // 乐观更新：不等网络往返就已经是新值
    expect(h.result.current.materials.chair).toEqual(B_MATERIAL);
    await h.unmount();
  });

  test("本地覆盖优先于服务端重扫回来的旧值", async () => {
    const h = await renderHook(
      (remote: Record<string, AssetMaterial>) => useAssetMaterials("project-a", remote),
      { chair: A_MATERIAL },
    );
    await act(async () => h.result.current.setMaterial("chair", B_MATERIAL));
    // 刷新重扫拿回磁盘上那份旧记录，不能把本会话刚改的顶掉
    await h.rerender({ chair: A_MATERIAL });
    await flush();
    expect(h.result.current.materials.chair).toEqual(B_MATERIAL);
    await h.unmount();
  });

  test("旧保存未完成时新保存排队，不能让旧请求晚到覆盖新材质", async () => {
    const first = deferred<void>();
    saveSceneMaterials.mockImplementationOnce(() => first.promise);
    const h = await renderHook(
      () => useAssetMaterials("project-a", {}),
      null,
    );

    await act(async () => h.result.current.setMaterial("chair", A_MATERIAL));
    await flush();
    expect(saveSceneMaterials).toHaveBeenCalledTimes(1);

    await act(async () => h.result.current.setMaterial("chair", B_MATERIAL));
    await flush();
    // 第二个请求已产生，但必须等第一个兑现后才真正发送
    expect(saveSceneMaterials).toHaveBeenCalledTimes(1);

    first.resolve();
    await flush();
    expect(saveSceneMaterials.mock.calls).toEqual([
      ["project-a", { chair: A_MATERIAL }],
      ["project-a", { chair: B_MATERIAL }],
    ]);
    await h.unmount();
  });

  test("删除资产后摘掉本地覆盖，且不再为它写盘", async () => {
    const h = await renderHook(
      () => useAssetMaterials("project-a", { chair: A_MATERIAL, desk: B_MATERIAL }),
      null,
    );
    await act(async () => h.result.current.setMaterial("chair", B_MATERIAL));
    await flush();
    await act(async () => h.result.current.dropMaterial("chair"));
    // 本地覆盖摘掉后回落到服务端那份，而不是整条消失
    expect(h.result.current.materials.chair).toEqual(A_MATERIAL);
    expect(h.result.current.materials.desk).toEqual(B_MATERIAL);
    await h.unmount();
  });

  test("保存失败把错误交给上层，不打断后续队列", async () => {
    saveSceneMaterials.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    const errors: string[] = [];
    const h = await renderHook(
      () => useAssetMaterials("project-a", {}, (message) => errors.push(message)),
      null,
    );
    await act(async () => h.result.current.setMaterial("chair", A_MATERIAL));
    await flush();
    expect(errors).toEqual(["network down"]);

    await act(async () => h.result.current.setMaterial("desk", B_MATERIAL));
    await flush();
    expect(saveSceneMaterials).toHaveBeenCalledTimes(2);
    await h.unmount();
  });
});
