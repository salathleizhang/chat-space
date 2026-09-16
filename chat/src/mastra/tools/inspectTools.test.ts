import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStorage } from "../../services/assetStorage";
import { toAgentMessages } from "../../services/chatService";
import { saveInspectionSheet } from "./inspectTools";
import { createProject } from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "gabo-inspect-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  await createProject(storage, { name: "自检演示", slug: "inspect-demo" });
});

afterAll(async () => {
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
