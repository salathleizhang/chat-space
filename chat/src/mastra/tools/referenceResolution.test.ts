import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "./projectTools";
import { RequestSidecarSchema } from "../../dto/library";
import { projectSourceDir } from "../../common/libraryPaths";
import { LocalFileStorage, writeJson, type AssetStorage } from "../../services/assetStorage";
import {
  ReferenceReuseConsentError,
  isReferenceReusableInSession,
  listSourceReferences,
  resolveSessionReferenceImage,
} from "./referenceResolution";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "chatspace-refresolution-"));
  const storage: AssetStorage = new LocalFileStorage(root);
  await createProject(storage, { name: "参考图归属", slug: "p" });
  return { storage, sourceDir: projectSourceDir("p") };
}

/** 落一张"由生成请求产出"的参考图：图片 + 成功侧写（带 createdAt）。 */
async function landGeneratedReference(
  storage: AssetStorage,
  sourceDir: string,
  index: number,
  slug: string,
  createdAt: string,
) {
  const path = `${sourceDir}/${index}-${slug}.png`;
  await storage.writeBytes(path, PNG_BYTES);
  await writeJson(storage, `${sourceDir}/.${index}-${slug}-request.json`, RequestSidecarSchema, {
    schemaVersion: 1,
    index,
    slug,
    provider: "volcengine",
    model: "seedream",
    params: { prompt: slug, count: 1 },
    status: "succeeded",
    outputs: [{ path }],
    createdAt,
    updatedAt: createdAt,
  });
  return path;
}

const SESSION_START = Date.parse("2026-10-02T12:00:00.000Z");
const BEFORE_SESSION = new Date(SESSION_START - 3_600_000).toISOString();
const AFTER_SESSION = new Date(SESSION_START + 60_000).toISOString();

describe("参考图能不能自动复用", () => {
  test("上一轮生成的参考图：不自动复用，报错时把清单和下一步一起给模型", async () => {
    const { storage, sourceDir } = await harness();
    const old = await landGeneratedReference(
      storage, sourceDir, 0, "chair-ref", BEFORE_SESSION,
    );

    const error = await resolveSessionReferenceImage(storage, "p", {
      sessionStartedAt: SESSION_START,
      operation: "Seed3D 图生 3D",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ReferenceReuseConsentError);
    const consent = error as ReferenceReuseConsentError;
    expect(consent.code).toBe("reference_reuse_needs_consent");
    // 清单要能看到（用户口径：不许复用但看得见）
    expect(consent.availableReferences.map((reference) => reference.path)).toEqual([old]);
    // 没有一张是本轮可用的，所以候选为空
    expect(consent.reusableReferences).toEqual([]);
    // 报错文案必须点名"先用 ask-user 征得同意"，而不是只报失败
    expect(consent.message).toContain("ask-user");
    expect(consent.message).toContain(old);
    expect(consent.message).toContain("generate-reference-images");
  });

  test("本会话刚落盘的参考图：照旧自动使用（不打扰用户）", async () => {
    const { storage, sourceDir } = await harness();
    const fresh = await landGeneratedReference(
      storage, sourceDir, 0, "chair-ref", AFTER_SESSION,
    );

    expect(
      await resolveSessionReferenceImage(storage, "p", { sessionStartedAt: SESSION_START }),
    ).toBe(fresh);
  });

  test("用户自己上传的原图：没有侧写，永远是用户给的输入，不算复用", async () => {
    const { storage, sourceDir } = await harness();
    const upload = `${sourceDir}/0-photo.png`;
    await storage.writeBytes(upload, PNG_BYTES);

    expect(
      await resolveSessionReferenceImage(storage, "p", { sessionStartedAt: SESSION_START }),
    ).toBe(upload);
  });

  test("新旧混在一起时取最新的：旧的被挡、新的照用", async () => {
    const { storage, sourceDir } = await harness();
    await landGeneratedReference(storage, sourceDir, 0, "old-ref", BEFORE_SESSION);
    const fresh = await landGeneratedReference(
      storage, sourceDir, 1, "new-ref", AFTER_SESSION,
    );

    expect(
      await resolveSessionReferenceImage(storage, "p", { sessionStartedAt: SESSION_START }),
    ).toBe(fresh);
  });

  test("身份绑定的候选同样过闸门：资产绑的是上一轮的图也要先问", async () => {
    const { storage, sourceDir } = await harness();
    const old = await landGeneratedReference(
      storage, sourceDir, 0, "chair-ref", BEFORE_SESSION,
    );

    const error = await resolveSessionReferenceImage(storage, "p", {
      sessionStartedAt: SESSION_START,
      boundCandidates: [old],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ReferenceReuseConsentError);
    expect((error as ReferenceReuseConsentError).message).toContain(old);
  });

  test("客户端没带会话时间：保持原行为，不把同会话的正常复用也挡掉", async () => {
    const { storage, sourceDir } = await harness();
    const old = await landGeneratedReference(
      storage, sourceDir, 0, "chair-ref", BEFORE_SESSION,
    );

    expect(await resolveSessionReferenceImage(storage, "p", {})).toBe(old);
  });

  test("显式传入的图直接放行（点名这个动作本身就是调用方的意图）", async () => {
    const { storage, sourceDir } = await harness();
    const old = await landGeneratedReference(
      storage, sourceDir, 0, "chair-ref", BEFORE_SESSION,
    );

    expect(
      await resolveSessionReferenceImage(storage, "p", {
        sessionStartedAt: SESSION_START,
        explicit: old,
      }),
    ).toBe(old);
  });

  test("项目里一张图都没有：仍然是原来的 reference_image_missing", async () => {
    const { storage } = await harness();
    const error = await resolveSessionReferenceImage(storage, "p", {
      sessionStartedAt: SESSION_START,
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: "reference_image_missing", status: 409 });
  });
});

describe("isReferenceReusableInSession 的边界", () => {
  test("侧写时间损坏：按不可复用处理（保守，宁可多问一次）", () => {
    expect(
      isReferenceReusableInSession(
        { path: "p/source/0-a.png", generatedAt: "not-a-date" },
        SESSION_START,
      ),
    ).toBe(false);
  });

  test("没有生成时间（用户原图）：可复用", () => {
    expect(isReferenceReusableInSession({ path: "p/source/0-a.png" }, SESSION_START)).toBe(
      true,
    );
  });

  test("恰好等于会话开始时刻：算本会话的（同秒落盘不该被误判成上一轮）", () => {
    expect(
      isReferenceReusableInSession(
        { path: "p/source/0-a.png", generatedAt: new Date(SESSION_START).toISOString() },
        SESSION_START,
      ),
    ).toBe(true);
  });
});

describe("listSourceReferences", () => {
  test("只列索引图片（含隐藏侧写与缩略图之外的项），新→旧，带生成时间", async () => {
    const { storage, sourceDir } = await harness();
    const old = await landGeneratedReference(
      storage, sourceDir, 0, "old-ref", BEFORE_SESSION,
    );
    const fresh = await landGeneratedReference(
      storage, sourceDir, 1, "new-ref", AFTER_SESSION,
    );
    await storage.writeBytes(`${sourceDir}/2-upload.png`, PNG_BYTES);
    // 非索引命名的文件不该进清单
    await storage.writeText(`${sourceDir}/notes.txt`, "x");

    const references = await listSourceReferences(storage, "p");
    expect(references.map((reference) => reference.path)).toEqual([
      `${sourceDir}/2-upload.png`,
      fresh,
      old,
    ]);
    // 只有由生成请求产出的那张带时间
    expect(references.find((reference) => reference.path === old)?.generatedAt).toBe(
      BEFORE_SESSION,
    );
    expect(references.find((reference) => reference.path === fresh)?.generatedAt).toBe(
      AFTER_SESSION,
    );
    expect(references.find((reference) => reference.path.endsWith("2-upload.png"))).toEqual({
      path: `${sourceDir}/2-upload.png`,
    });
  });
});

describe("explicitMustBeFresh：存档里的\"显式\"也要判归属", () => {
  test("默认不判（显式点名是调用方的决定），开了才判", async () => {
    const { storage, sourceDir } = await harness();
    const old = await landGeneratedReference(
      storage, sourceDir, 0, "chair-ref", BEFORE_SESSION,
    );

    // 默认：放行
    expect(
      await resolveSessionReferenceImage(storage, "p", {
        sessionStartedAt: SESSION_START,
        explicit: old,
      }),
    ).toBe(old);

    // 开了：这批"显式"来自存档的历史选择，和兜底一样属于静默复用
    const error = await resolveSessionReferenceImage(storage, "p", {
      sessionStartedAt: SESSION_START,
      explicit: old,
      explicitMustBeFresh: true,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ReferenceReuseConsentError);
  });

  test("用户自己上传的原图：即使开了判定也照用（没有生成时间就是用户输入）", async () => {
    const { storage, sourceDir } = await harness();
    const upload = `${sourceDir}/0-photo.png`;
    await storage.writeBytes(upload, PNG_BYTES);

    expect(
      await resolveSessionReferenceImage(storage, "p", {
        sessionStartedAt: SESSION_START,
        explicit: upload,
        explicitMustBeFresh: true,
      }),
    ).toBe(upload);
  });
});
