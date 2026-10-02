import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStorage, setAssetStorage } from "../../services/assetStorage";
import { toAgentMessages } from "../../services/chatService";
import { buildRequestContext } from "../../services/workflowRuns";
import {
  InspectParamsSchema,
  inspectTool,
  saveInspectionSheet,
  saveSceneInspectionSheet,
} from "./inspectTools";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-inspect-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  await createProject(storage, { name: "自检演示", slug: "inspect-demo" });
});

afterAll(async () => {
  setAssetStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

describe("saveInspectionSheet", () => {
  test("检查图落盘 assets/<asset>/inspections/<id>.png", async () => {
    const { path } = await saveInspectionSheet(storage, {
      projectSlug: "inspect-demo",
      assetSlug: "cube",
      inspectionId: "call_Abc-123",
      bytes: PNG_BYTES,
    });
    expect(path).toBe("projects/inspect-demo/assets/cube/inspections/call_Abc-123.png");
    expect(await storage.readBytes(path)).toEqual(PNG_BYTES);
  });

  test("拒绝路径注入型 id 与空内容", async () => {
    await expect(
      saveInspectionSheet(storage, {
        projectSlug: "inspect-demo",
        assetSlug: "cube",
        inspectionId: "../escape",
        bytes: PNG_BYTES,
      }),
    ).rejects.toThrow();
    await expect(
      saveInspectionSheet(storage, {
        projectSlug: "inspect-demo",
        assetSlug: "cube",
        inspectionId: "ok-id",
        bytes: new Uint8Array(0),
      }),
    ).rejects.toThrow(/为空/);
  });
});

describe("saveSceneInspectionSheet", () => {
  test("整场景检查图落盘项目级 inspections/，不挂到任何资产下", async () => {
    const { path } = await saveSceneInspectionSheet(storage, {
      projectSlug: "inspect-demo",
      inspectionId: "scene_Abc-1",
      bytes: PNG_BYTES,
    });
    expect(path).toBe("projects/inspect-demo/inspections/scene_Abc-1.png");
    expect(await storage.readBytes(path)).toEqual(PNG_BYTES);
  });

  test("拒绝路径注入型 id 与空内容（与资产级同一套校验）", async () => {
    await expect(
      saveSceneInspectionSheet(storage, {
        projectSlug: "inspect-demo",
        inspectionId: "a/b",
        bytes: PNG_BYTES,
      }),
    ).rejects.toThrow();
    await expect(
      saveSceneInspectionSheet(storage, {
        projectSlug: "inspect-demo",
        inspectionId: "empty",
        bytes: new Uint8Array(0),
      }),
    ).rejects.toThrow(/为空/);
  });
});

describe("inspect 工具入参", () => {
  test("入参是一个平铺对象（火山方舟不接受顶层 union，组合约束在 execute 里校验）", () => {
    // 顶层必须是 object：判别联合会序列化成 anyOf，整轮请求会 400。
    const schema = InspectParamsSchema;
    expect(schema.safeParse({ target: "asset" }).success).toBe(true);
    expect(schema.safeParse({ target: "scene", views: ["top"] }).success).toBe(true);
    expect(schema.safeParse({ target: "closeup", assetSlug: "cube" }).success).toBe(true);
    // 未知视角 id 直接拒绝，而不是悄悄退化成默认四视角
    expect(schema.safeParse({ target: "scene", views: ["diagonal"] }).success).toBe(false);
    expect(schema.safeParse({ target: "whatever" }).success).toBe(false);
  });
});

describe("inspect 工具", () => {
  test("整场景检查：项目里没有可渲染内容时立刻失败，不让 app 空转", async () => {
    setAssetStorage(storage);
    await createProject(storage, { name: "空场景", slug: "empty-scene" });
    await expect(
      inspectTool.execute!({ target: "scene" } as never, {
        requestContext: buildRequestContext({ projectSlug: "empty-scene" }),
      } as never),
    ).rejects.toThrow(/还没有可渲染/);
  });

  /**
   * 判别联合被拆成平铺对象（火山方舟要求顶层 object），所以"target=asset 但没给
   * assetSlug"这类组合约束只能在 execute 里报错——这条断言把它钉住。
   */
  test("单模型检查：没给 assetSlug 时明确拒绝，而不是去查一个 undefined 的资产", async () => {
    setAssetStorage(storage);
    await expect(
      inspectTool.execute!({ target: "asset" } as never, {
        requestContext: buildRequestContext({ projectSlug: "inspect-demo" }),
      } as never),
    ).rejects.toThrow(/assetSlug/);
  });

  test("贴近检查：没给 assetSlug 时同样明确拒绝（不是退化成整场景）", async () => {
    setAssetStorage(storage);
    await expect(
      inspectTool.execute!({ target: "closeup" } as never, {
        requestContext: buildRequestContext({ projectSlug: "inspect-demo" }),
      } as never),
    ).rejects.toThrow(/assetSlug/);
  });

  test("贴近检查：资产没有可渲染模型时立刻失败，并说明相机要飞过去看的是哪个资产", async () => {
    setAssetStorage(storage);
    await expect(
      inspectTool.execute!({ target: "closeup", assetSlug: "no-model" } as never, {
        requestContext: buildRequestContext({ projectSlug: "inspect-demo" }),
      } as never),
    ).rejects.toThrow(/没有模型文件/);
  });

  test("贴近检查：有模型时返回 closeup 请求，且提示词不让它重复换角度", async () => {
    setAssetStorage(storage);
    await storage.writeBytes("projects/inspect-demo/assets/closeup-cube/1-cube.glb", new Uint8Array([1]));
    const result = (await inspectTool.execute!(
      { target: "closeup", assetSlug: "closeup-cube" } as never,
      { requestContext: buildRequestContext({ projectSlug: "inspect-demo" }) } as never,
    )) as { requested: boolean; target: string; assetSlug: string; modelPath: string; note: string };
    expect(result.requested).toBe(true);
    expect(result.target).toBe("closeup");
    expect(result.assetSlug).toBe("closeup-cube");
    expect(result.modelPath).toBe("projects/inspect-demo/assets/closeup-cube/1-cube.glb");
    // 机位由摆放决定：重复调用只会得到同一张图，必须告诉模型别指望换角度
    expect(result.note).toContain("same framing");
  });
});

describe("toAgentMessages（多模态映射）", () => {
  test("纯文本消息原样透传", async () => {
    const result = await toAgentMessages(storage, [
      { role: "user", content: "你好" },
      { role: "assistant", content: "好的" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "好的" },
    ]);
  });

  test("user 带图片部件 → 逻辑路径内联为 data URI", async () => {
    const imagePath = "projects/inspect-demo/assets/cube/inspections/sheet.png";
    await storage.writeBytes(imagePath, PNG_BYTES);
    const result = await toAgentMessages(storage, [
      {
        role: "user",
        content: [
          { type: "text", text: "请检查" },
          { type: "image", path: imagePath },
        ],
      },
    ]);
    const content = result[0]!.content as {
      type: string;
      text?: string;
      image?: string;
    }[];
    expect(content[0]).toEqual({ type: "text", text: "请检查" });
    expect(content[1]!.type).toBe("image");
    expect(content[1]!.image).toStartWith("data:image/png;base64,");
  });

  test("user 带资产附件 → 按当前项目真实名称生成主要目标锚点", async () => {
    const result = await toAgentMessages(
      storage,
      [
        {
          role: "user",
          content: [
            { type: "asset", assetSlug: "chair" },
            { type: "asset", assetSlug: "chair" },
            { type: "asset", assetSlug: "table" },
            { type: "text", text: "把它们放大" },
          ],
        },
      ],
      new Map([
        ["chair", "休闲椅"],
        ["table", "边桌"],
      ]),
    );
    expect(result[0]!.content).toEqual([
      {
        type: "text",
        text:
          "【本条消息明确选中的资产】休闲椅(chair)、边桌(table)。" +
          "这些资产是本条指令的主要目标；“它 / 这个模型 / 这些模型”等指代优先落到这里。",
      },
      { type: "text", text: "把它们放大" },
    ]);
  });

  test("不存在的资产附件明确标记为已删除，不信任客户端显示名", async () => {
    const result = await toAgentMessages(storage, [
      {
        role: "user",
        content: [
          { type: "asset", assetSlug: "gone-model" },
          { type: "text", text: "继续修改" },
        ],
      },
    ]);
    expect(JSON.stringify(result[0]!.content)).toContain(
      "已删除或不存在的资产(gone-model)",
    );
  });

  test("非 user 角色的部件消息折叠为纯文本", async () => {
    const result = await toAgentMessages(storage, [
      {
        role: "assistant",
        content: [{ type: "text", text: "折叠我" }],
      },
    ]);
    expect(result[0]).toEqual({ role: "assistant", content: "折叠我" });
  });
});
