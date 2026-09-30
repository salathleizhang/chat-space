#!/usr/bin/env node
/**
 * GPU 探针自动化：启动一个**可见窗口**的 Chrome，用 CDP 驱动 `gpuProbe.browser.ts`，
 * 按布局逐轮测量并打印帧预算闭合报告。
 *
 *   bun run probe:gpu                      # 默认 1 / 2 / 4 视图各一轮
 *   bun run probe:gpu -- --layouts 1,4 --json /tmp/probe.json
 *   bun run probe:gpu -- --url http://localhost:5173/app/p-mu5l6om3
 *
 * 为什么必须是**可见窗口**：`WebGPUBackend.trackTimestamp` 在 backend 构造时读取，而 headless
 * 下时间戳会**静默返回 0**——headless 与可见窗口的 adapter feature 列表几乎一致，事前无法分辨。
 * 所以本脚本拒绝 `--headless`，并且不会尝试在无头环境里"跑通"。
 *
 * 依赖：零。Chrome 用系统安装的那个；CDP 走 Node 内置 `WebSocket`（Node ≥ 22）。
 * 退出码：0 = 每轮 `valid === true`；2 = 有轮次不成立；1 = 工具自身失败。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";

const CDP_PORT = Number(process.env.PROBE_CDP_PORT ?? 9333);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_CANDIDATES = [
  process.env.PROBE_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "chromium",
].filter(Boolean);

function usage() {
  console.log(`用法: bun run probe:gpu -- [选项]

  --url <url>          起始地址（默认 http://localhost:5173/app/p-mu5l6om3）
  --layouts <list>     布局，逗号分隔（默认 1,2,4；只有 1/2/4 三种）
  --views <n>          ❌ 已失效（会直接拒绝）：一个 GaussianSplatRenderer 现在服务全部窗格，
                       「4 窗格 + n 个可见 splat」不再可构造。用 --layouts 1,2,4 测窗格数曲线。
  --duration <ms>      每轮采样时长（默认 10000）
  --warmup <ms>        每轮预热（默认 2000）
  --motion <0|1|persp> 0=静止，1=所有窗格相机（默认），persp=只动透视（旧行为）
  --msaa <0|1>         打开 MSAA（默认 0）。只为实测"关 MSAA 的收益"，不是可用设置
  --opaque <0|1>       关掉画布的 alpha（默认 0 = 保持 alpha，即线上行为）。只为实测
                       "合成器每帧混合一张 alpha 画布"的代价，不是可用设置
  --shot <dir>         每个布局在跑探针**之前**存一张 PNG 到 <dir>/<布局>.png。
                       用途是目视核对（AGENTS.md 要求"真实浏览器验证过"要能指明是哪一种），
                       例如 4 窗格的 viewport y 轴原点、gizmo/grid 是否落在正确的格子里。
  --eval <expr>        走完"起浏览器 → 解锁门禁 → 等画布与泼溅就绪"之后，在页面里求值 <expr>
                       并打印 JSON，**不跑探针**。用来在不猜代码的前提下问运行时事实
                       （例如 three 的 needsFrameBufferTarget / getPixelRatio / viewport 单位）。
  --json <path>        把结果写成 JSON
  --keep-open          结束后保留浏览器窗口（调试用）
  --headless           不允许：时间戳在 headless 下静默返回 0

间距/口径见 WEBGPU_PROBE_PROTOCOL.md §4 与 §4.2；本脚本只是把同一套步骤自动化。`);
}

function parseArgs(argv) {
  const options = {
    url: process.env.PROBE_URL ?? "http://localhost:5173/app/p-mu5l6om3",
    layouts: [1, 2, 4],
    durationMs: 10_000,
    warmupMs: 2_000,
    motion: true,
    motionMode: "all",
    views: null,
    msaa: false,
    opaque: false,
    shot: null,
    eval: null,
    json: null,
    keepOpen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    else if (arg === "--url") options.url = next();
    else if (arg === "--layouts") options.layouts = next().split(",").map((value) => Number(value.trim()));
    else if (arg === "--views") {
      console.error("--views 已失效：2026-09-30 起 splat 由**一个** GaussianSplatRenderer 服务全部窗格"
        + "（一趟 ArrayCamera / multiView），所以「4 窗格 + n 个可见 splat」不再可构造。"
        + "改用 --layouts 1,2,4 测窗格数曲线。");
      process.exit(1);
    }
    else if (arg === "--duration") options.durationMs = Number(next());
    else if (arg === "--warmup") options.warmupMs = Number(next());
    else if (arg === "--motion") {
      const value = next();
      if (value === "0") options.motion = false;
      else if (value === "persp") { options.motion = true; options.motionMode = "perspective"; }
      else { options.motion = true; options.motionMode = "all"; }
    }
    else if (arg === "--msaa") options.msaa = next() !== "0"
    else if (arg === "--opaque") options.opaque = next() !== "0"
    else if (arg === "--shot") options.shot = next()
    else if (arg === "--eval") options.eval = next();
    else if (arg === "--json") options.json = next();
    else if (arg === "--keep-open") options.keepOpen = true;
    else if (arg === "--headless") {
      console.error("拒绝 --headless：headless 下 GPU 时间戳会静默返回 0，测出来的不是慢，是没有数。");
      process.exit(1);
    } else { console.error(`未知参数：${arg}`); usage(); process.exit(1); }
  }
  if (!options.layouts.every((value) => [1, 2, 4].includes(value))) {
    console.error(`--layouts 只支持 1 / 2 / 4（应用只有这三种布局）：${options.layouts.join(",")}`);
    process.exit(1);
  }
  return options;
}

/** 布局按钮的 aria-label，与 Viewport 的 LAYOUT_LABEL 一一对应 */
const LAYOUT_LABEL = {
  1: "Single view",
  2: "Two views",
  4: "Four views (Blender layout)",
};

/**
 * 给一个 promise 加超时。
 *
 * 为什么必须有：CDP 的响应可能永远不来（页面渲染进程崩溃、target 被销毁）。
 * 而 **待决的 promise 不会保活事件循环**——没有别的 handle 时，Bun 会以退出码 0 直接结束。
 * 那是最坏的失败模式：什么都没测到，退出码却像成功。本工具一度就是这样：在受限环境里
 * Chrome 的渲染进程崩溃后，它打完一行头就静默退出 0。
 */
function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async connect(url, timeoutMs = 15_000) {
    const ws = new WebSocket(url);
    await withTimeout(
      new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }),
      timeoutMs,
      `CDP WebSocket 在 ${timeoutMs} ms 内没有打开（页面 target 很可能已经崩溃）`,
    );
    const session = new Session(ws);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const entry = session.pending.get(message.id);
      if (entry) { session.pending.delete(message.id); entry.resolve(message); }
    };
    // 连接断掉时把在飞的请求全部拒掉，而不是让它们挂到各自的超时
    ws.onclose = () => {
      for (const [, entry] of session.pending) entry.reject(new Error("CDP 连接已关闭"));
      session.pending.clear();
    };
    return session;
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.id;
    return withTimeout(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    }), timeoutMs, `CDP ${method} 在 ${timeoutMs} ms 内没有响应`);
  }

  async evaluate(expression, timeoutMs = 300_000) {
    const message = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
    }, timeoutMs + 15_000);
    if (message.error) throw new Error(`CDP 错误：${JSON.stringify(message.error)}`);
    const { result, exceptionDetails } = message.result ?? {};
    if (exceptionDetails) {
      throw new Error(`页面异常：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result?.value;
  }
}

/**
 * 探针专用 URL：始终带 `gpuTimestamps=1`（时间戳必须在 backend 构造前开启），
 * `--msaa 1` 再加 `msaa=1`，`--opaque 1` 再加 `opaque=1`。用 URL API 拼接，避免原 URL
 * 已带查询串时拼出 `??`。
 */
function probeUrl(base, msaa, opaque) {
  const url = new URL(base);
  url.searchParams.set("gpuTimestamps", "1");
  if (msaa) url.searchParams.set("msaa", "1");
  if (opaque) url.searchParams.set("opaque", "1");
  return url.toString();
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.includes("/") ? existsSync(candidate) : true) return candidate;
  }
  throw new Error("找不到 Chrome；用 PROBE_CHROME 指定可执行文件路径。");
}

async function waitForCdp(deadlineMs = 20_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`CDP 端口 ${CDP_PORT} 在 ${deadlineMs} ms 内没有响应`);
}

async function findPageTarget(appHost, deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const target = list.find((entry) => entry.type === "page" && entry.url.includes(appHost));
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(400);
  }
  throw new Error("没有找到应用页面 target");
}

/** 页内脚本：解锁门禁（调应用自己的 API，不硬编码口令）、等画布、按布局跑探针 */
const pageHelpers = {
  /*
    门禁：用应用自己的判定与解锁函数，不去嗅探 DOM 文案——冷启动时页面还没渲染，
    按文案判断会误判成"已解锁"，然后卡在门禁页上等画布超时。
  */
  unlock: `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 文档还没就绪时，动态 import 的绝对路径解析不了（实测报
    // "Failed to resolve module specifier '/src/...'"）——先等文档，再重试 import。
    const until = Date.now() + 30000;
    while (Date.now() < until && document.readyState === 'loading') await sleep(200);
    let gate = null;
    for (let attempt = 0; attempt < 60 && !gate; attempt++) {
      try { gate = await import('/src/shared/storage/accessGate.ts'); }
      catch { await sleep(500); }
    }
    if (!gate) return 'gate-module-unresolved';
    if (gate.hasPassedAccessGate()) return 'already-unlocked';
    gate.passAccessGate();
    location.reload();
    return 'unlocked';
  })()`,

  waitForCanvas: (timeoutMs) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = Date.now() + ${timeoutMs};
    while (Date.now() < until) {
      const canvas = document.querySelector('canvas[data-renderer="webgpu"]');
      if (canvas) return { ok: true, size: [canvas.width, canvas.height], dpr: window.devicePixelRatio };
      await sleep(400);
    }
    return { ok: false, text: (document.body.innerText || '').slice(0, 200) };
  })()`,

  /** 等世界真的开始画：探针判定的就是 activeSplats / instanceCount，这里用同一口径 */
  waitForSplat: (timeoutMs) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const entry = performance.getEntriesByType('resource').find((e) => e.name.includes('/deps/@react-three_fiber.js'));
    if (!entry) return { ok: false, reason: 'fiber dep not loaded yet' };
    const mod = await import(entry.name);
    const main = [...mod._roots.values()].find((r) => r.store.getState().gl?.domElement?.dataset?.renderer === 'webgpu');
    if (!main) return { ok: false, reason: 'no webgpu R3F root' };
    const until = Date.now() + ${timeoutMs};
    while (Date.now() < until) {
      let splats = 0;
      main.store.getState().scene?.traverse?.((object) => {
        if (object.activeSplats === undefined && object.geometry?.instanceCount === undefined) return;
        if (object.visible === false) return;
        splats = Math.max(splats, object.activeSplats ?? 0);
      });
      // 视图数按**窗格**数，不按 GaussianSplatRenderer 实例数：一个实例现在服务全部窗格
      // （一趟 ArrayCamera / multiView，见 paneViewports.ts）。
      const panes = document.querySelectorAll('[data-viewport-pane]').length;
      if (splats > 0) return { ok: true, views: panes, splats };
      await sleep(500);
    }
    return { ok: false, reason: 'no visible splat within budget' };
  })()`,

  /*
    等页面稳定：`performance.timeOrigin` 就是"页面代次"，它一变就说明刷新过。
    开发服务器上（HMR / 依赖重优化 / 应用的 stale-chunk 重载）会连续刷新，
    此时跑探针等于在移动靶上测量——实测踩到过连续三次重载，两次重试都用光。
  */
  waitForStablePage: (stableMs) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let origin = performance.timeOrigin;
    let stableFor = 0;
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      await sleep(1000);
      if (performance.timeOrigin !== origin) { origin = performance.timeOrigin; stableFor = 0; continue; }
      stableFor += 1000;
      if (stableFor >= ${stableMs}) return { ok: true, stableFor };
    }
    return { ok: false, reason: 'page kept reloading' };
  })()`,

  clickLayout: (label) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const button = [...document.querySelectorAll('button')]
        .find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
      if (button) { button.click(); return 'clicked'; }
      await sleep(300);
    }
    return 'button not found';
  })()`,

  probe: (label, warmupMs, durationMs, motion, motionMode, expectedViews, layoutLabel, expectedVisible) => `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const entry = performance.getEntriesByType('resource').find((e) => e.name.includes('/deps/@react-three_fiber.js'));
    const mod = await import(entry.name);
    const main = [...mod._roots.values()].find((r) => r.store.getState().gl?.domElement?.dataset?.renderer === 'webgpu');
    if (!main) return { error: 'no webgpu R3F root' };
    /*
      **开测前自己确认布局。** 页面可能刚刷新过（HMR / 依赖重优化），React 状态回到 1 视图；
      此时沿用调用方"点过按钮"的假设，就会把 1 视图的读数挂上 "4 视图" 的标签——测出来的数字
      是错的，而且看不出错。实测踩到过：视图数不匹配时 GPU 时间只有三分之一。
    */
    const visibleViews = () => document.querySelectorAll('[data-viewport-pane]').length;
    if (visibleViews() !== ${expectedViews}) {
      const button = [...document.querySelectorAll('button')]
        .find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(layoutLabel)});
      button?.click();
      const until = Date.now() + 20000;
      while (Date.now() < until && visibleViews() !== ${expectedViews}) await sleep(400);
    }
    let settledViews = visibleViews();
    if (settledViews !== ${expectedViews}) {
      return { error: 'layout mismatch: expected ${expectedViews} splat views, saw ' + settledViews };
    }
    /*
      历史记录里的「3 视图」在 UI 里不存在（布局只有 1/2/4）。要复现它，只能先切到 4 窗格布局，
      再把多余的 splat 视图隐藏——这正是这里做的。收尾时按原样放回，别把用户画面改坏。
    */
    const hidden = [];
    if (${expectedVisible ?? "null"} !== null) {
      const drawables = [];
      main.store.getState().scene?.traverse?.((object) => {
        if (object.activeSplats === undefined && object.geometry?.instanceCount === undefined) return;
        if (object.visible === false) return;
        drawables.push(object);
      });
      for (const object of drawables) {
        if (drawables.length - hidden.length <= ${expectedVisible ?? "null"}) break;
        hidden.push(object);
        object.visible = false;
      }
      settledViews = visibleViews();
      if (settledViews !== ${expectedVisible ?? "null"}) {
        for (const object of hidden) object.visible = true;
        return { error: 'cannot build ' + ${expectedVisible ?? "null"} + ' visible splat views, saw ' + settledViews };
      }
    }
    const { startGpuFrameProbe, formatProbeReport } = await import('/src/shared/rendering/gpuProbe.browser.ts');
    let run;
    try {
      run = startGpuFrameProbe(main.store, {
        label: ${JSON.stringify(label)}, warmupMs: ${warmupMs}, durationMs: ${durationMs}, motion: ${motion},
        motionMode: ${JSON.stringify(motionMode)},
      });
    } catch (error) {
      return { error: 'probe refused: ' + error.message };
    }
    await sleep(${warmupMs} + ${durationMs} + 1500);
    const result = run.stop();
    return {
      label: result.label,
      report: formatProbeReport(result),
      valid: result.valid,
      expectedViews: ${expectedViews},
      layoutSettled: settledViews,
      hiddenViews: hidden.length,
      error: result.error ?? null,
      unsupportedReason: result.unsupportedReason,
      views: result.visibleViews,
      instanceCount: result.totalInstanceCount,
      activeSplats: result.activeSplats,
      hidden: document.hidden,
      attribution: result.attribution,
      io: result.io,
      wallMs: result.wallMs,
      gpuMs: result.gpuMs,
      mainThreadMs: result.mainThreadMs,
    };
  })()`,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chromePath = findChrome();
  const profile = join(tmpdir(), `chatspace-gpu-probe-${Date.now()}`);
  /** Chrome 的 stderr。渲染进程崩溃时这是唯一的现场，别丢掉。 */
  const chromeLog = `${profile}.chrome.log`;
  /*
    stdio 里必须给**文件描述符编号**，不能给路径字符串：Node 支持后者，**Bun 不支持**
    （`error: Invalid stdio option[2] "<path>"`）。踩过一次：给了路径之后 spawn 直接抛，
    而失败点在 try 内、进程又没有别的 handle 保活，表现为**静默退出 0**——比报错难查得多。
  */
  const chromeLogFd = openSync(chromeLog, "a");
  const loadAtStart = loadavg();
  let chrome = null;
  let session = null;
  /** 失败时保留 Chrome 的 stderr 现场；成功时连日志一起清掉，别在 tmp 里堆文件 */
  let failed = false;
  let cleanedUp = false;
  /**
   * 收尾只做一次。**必须能从信号处理器调用**：被 Ctrl-C / SIGTERM 打断时 `finally`
   * 不会执行——上一轮矩阵被中断后就是这样留下了 243 MB 的 Chrome profile 目录。
   */
  const cleanupOnce = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (!chrome) return;
    if (options.keepOpen) {
      console.log(`保留了浏览器窗口与 profile：${profile}`);
      return;
    }
    await shutdown(chrome, profile, failed);
  };

  try {
    // 端口先占着的话，后面的 CDP 会连到**别的** Chrome 上（上一次跑漏下的，或你自己的调试实例），
    // 测出来的东西和你以为的不是一回事——直接拒绝，别猜。
    try {
      const probe = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (probe.ok) {
        throw new Error(`CDP 端口 ${CDP_PORT} 已被占用（可能是上次跑漏下的 Chrome）。`
          + `先 pkill -f chatspace-gpu-probe，或用 PROBE_CDP_PORT 换一个端口。`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("已被占用")) throw error;
      /* 连不上才是正常情况 */
    }

    chrome = spawn(chromePath, [
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check",
      // 窗口被遮挡时 Chrome 会把页面标记为 hidden，探针会中途以
      // "Page became hidden during the probe" 结束——这三个开关阻止那套节流。
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-size=1920,1080", "--window-position=0,0",
      /*
        受限环境（容器 / 收紧的 macOS 沙箱 / CI）里 Chrome 自己的沙箱会初始化失败：
        日志里是 `Failed to initialize sandbox: Operation not permitted`，随后**渲染进程
        直接崩溃**（CDP 侧只看到 `Inspector.targetCrashed`）。此时 target 的 WebSocket
        永远打不开，探针什么也测不到。
        实测（2026-09-29，DSH workspace-write 沙箱）：不加这个开关必然崩；加了就能正常
        取值。用 PROBE_CHROME_SANDBOX=1 可以把它关掉（在正常桌面环境里跑时更安全）。
      */
      ...(process.env.PROBE_CHROME_SANDBOX === "1" ? [] : ["--no-sandbox", "--disable-gpu-sandbox"]),
      probeUrl(options.url, options.msaa, options.opaque),
    // detached 是为了拿到**独立进程组**：Chrome 会派一堆 helper 子进程，只杀主进程
    // 会留下孤儿（实测留下过 network/gpu helper，占着 profile 目录）。收尾时按组杀。
    // stderr 落盘而不是 ignore：渲染进程崩溃时，那是唯一的现场。
    ], { stdio: ["ignore", "ignore", chromeLogFd], detached: true });

    // 中断也要收尾，否则 profile 目录会留下（一个约 240 MB）
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      process.once(signal, () => { void cleanupOnce().finally(() => process.exit(code)); });
    }
    const version = await waitForCdp();
    console.log(`Chrome ${version.Browser} · CDP ${CDP_PORT} · 可见窗口（headless 下时间戳会静默返回 0）`);

    const target = await findPageTarget(new URL(options.url).host);
    session = await Session.connect(target.webSocketDebuggerUrl);
    await session.send("Runtime.enable");
    // 截图需要 Page 域；没有它 Page.captureScreenshot 会以 "Page is not enabled" 失败
    await session.send("Page.enable");

    const appHost = new URL(options.url).host;
    /*
      页面可能自己刷新：Vite 重优化依赖、或应用的 stale-chunk 重载都会销毁执行上下文，
      长跑的 `Runtime.evaluate` 会以 "Inspected target navigated or closed" 失败（实测踩到过）。
      重连后重试；探针那一轮会重跑，但比整条流程失败好。
    */
    const evaluate = async (expression, retries = 0) => {
      try {
        return await session.evaluate(expression);
      } catch (error) {
        const message = String(error?.message ?? "");
        if (retries >= 3 || !/navigated or closed|Execution context was destroyed|Cannot find context/.test(message)) {
          throw error;
        }
        console.log(`页面在测量中刷新了（${message.slice(0, 70)}…），重连后重试 ${retries + 1}/3`);
        await sleep(3000);
        const target = await findPageTarget(appHost);
        session = await Session.connect(target.webSocketDebuggerUrl);
        await session.send("Runtime.enable");
        // 重新加载后门禁可能又出现（实测踩到过一次：重连后卡在门禁页）——先照样解锁一遍
        const unlocked = await session.evaluate(pageHelpers.unlock);
        if (unlocked === "unlocked") await sleep(5000);
        if (unlocked === "gate-module-unresolved") throw new Error("重连后拿不到 accessGate 模块");
        const canvas = await session.evaluate(pageHelpers.waitForCanvas(120_000));
        if (!canvas.ok) throw new Error(`重连后画布没起来：${canvas.text ?? ""}`);
        const ready = await session.evaluate(pageHelpers.waitForSplat(120_000));
        if (!ready.ok) throw new Error(`重连后泼溅没画起来：${ready.reason}`);
        const stable = await session.evaluate(pageHelpers.waitForStablePage(3000));
        if (!stable.ok) throw new Error(`重连后页面仍在重载：${stable.reason}`);
        return evaluate(expression, retries + 1);
      }
    };

    const unlock = await evaluate(pageHelpers.unlock);
    console.log(`访问门禁：${unlock}`);
    if (unlock === "gate-module-unresolved") {
      throw new Error("拿不到 accessGate 模块：开发服务器可能没在跑，或页面没起来");
    }
    if (unlock === "unlocked") await sleep(5000);

    const canvas = await evaluate(pageHelpers.waitForCanvas(120_000));
    if (!canvas.ok) throw new Error(`画布没起来：${canvas.text ?? ""}`);
    console.log(`画布就绪：${canvas.size.join("×")}（DPR ${canvas.dpr}）`);

    const ready = await evaluate(pageHelpers.waitForSplat(120_000));
    if (!ready.ok) throw new Error(`泼溅没画起来：${ready.reason}`);
    console.log(`世界就绪：${ready.views} 个可见泼溅视图，activeSplats=${ready.splats}`);

    const stable = await evaluate(pageHelpers.waitForStablePage(3000));
    if (!stable.ok) throw new Error(`页面仍在重载（开发服务器在改文件？）：${stable.reason}`);
    console.log("页面已稳定 3 s");

    // 只问运行时事实，不测性能：`--eval` 在这里就结束。
    if (options.eval) {
      const value = await evaluate(`(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const entry = performance.getEntriesByType('resource').find((e) => e.name.includes('/deps/@react-three_fiber.js'));
        const mod = await import(entry.name);
        const main = [...mod._roots.values()].find((r) => r.store.getState().gl?.domElement?.dataset?.renderer === 'webgpu');
        if (!main) return { error: 'no webgpu R3F root' };
        const gl = main.store.getState().gl;
        await sleep(200);
        return await (async () => (${options.eval}))();
      })()`);
      console.log(JSON.stringify(value, null, 2));
      // 与 `--shot` 同用时继续走后面的布局循环：这样才能拍下"eval 里改过的运行时状态"。
      if (!options.shot) return;
    }

    /*
      `--views n` 用来构造 UI 里不存在的配置（历史记录说的"3 视图"）：先切到能容纳 n 的布局，
      再把多余的 splat 视图隐藏。不传 `--views` 时就是普通的按布局测。
    */
    const layoutFor = (views) => (views <= 1 ? 1 : views <= 2 ? 2 : 4);
    const targets = options.views === null ? options.layouts : [options.views];
    const runs = [];
    for (const target of targets) {
      const layout = options.views === null ? target : layoutFor(target);
      const expectedVisible = options.views === null ? null : target;
      const clicked = await evaluate(pageHelpers.clickLayout(LAYOUT_LABEL[layout]));
      if (clicked !== "clicked") throw new Error(`切不到 ${layout} 视图：${clicked}`);
      await sleep(2500);
      if (options.shot) {
        /*
          目视核对用。必须在**探针之前**拍：探针会把 frameloop 临时切成 always 并移动相机，
          拍到的就不是用户实际看到的画面了。此时布局已切换并稳定 2.5 s。
        */
        const shot = await session.send("Page.captureScreenshot", { format: "png" });
        const data = shot?.result?.data;
        if (!data) throw new Error(`截图失败：CDP 没有返回图像数据（${JSON.stringify(shot?.error ?? {})}）`);
        mkdirSync(options.shot, { recursive: true });
        const path = join(options.shot, `${layout}view.png`);
        writeFileSync(path, Buffer.from(data, "base64"));
        console.log(`截图：${path}`);
      }
      const result = await evaluate(pageHelpers.probe(
        `probe-${target}view`, options.warmupMs, options.durationMs, options.motion, options.motionMode,
        layout, LAYOUT_LABEL[layout], expectedVisible,
      ));
      // 视图数不符就是测错了对象，不能只靠 valid。
      // 注意用 `layoutSettled`（DOM 里的窗格数）判布局，**不要**用 `result.views`：后者是
      // "有几个 splat drawable 在画"，一个实例服务全部窗格之后它恒为 1。
      const wanted = expectedVisible ?? layout;
      if (result.layoutSettled !== wanted) {
        console.error(`⚠️ 目标 ${wanted} 个窗格，实到 ${result.layoutSettled ?? result.error}，读数不可引用`);
        result.valid = false;
      }
      runs.push({ layout, targetViews: target, ...result });
      console.log(`\n===== ${layout} 视图 =====`);
      console.log(result.report ?? JSON.stringify(result, null, 2));
    }

    console.log("\n===== 汇总（读 paired 行；means/unexplained 是混合分母，不要下结论）=====");
    for (const run of runs) {
      if (!run.attribution) { console.log(`${run.targetViews ?? run.layout} 视图：无归因（${run.error ?? "unknown"}）`); continue; }
      const a = run.attribution;
      const utilization = a.gpuUtilization === null ? "n/a" : `${(a.gpuUtilization * 100).toFixed(1)}%`;
      const io = run.io ?? { presentsPerWallFrame: 0, submitsPerWallFrame: 0, rendersPerWallFrame: 0 };
      console.log(`${run.layout} 窗格：valid=${run.valid} panes=${run.layoutSettled} splatDrawables=${run.views} instances=${run.instanceCount} `
        + `splats=${run.activeSplats} 帧间隔p50=${run.wallMs.p50.toFixed(1)}ms `
        + `pairedGpu均值=${a.pairedGpuMeanMs.toFixed(1)}ms pairedWall均值=${a.pairedWallMeanMs.toFixed(1)}ms `
        + `gpuUtilization=${utilization} 覆盖=${a.gpuFrames}/${a.wallFrames} `
        + `io/帧: present=${io.presentsPerWallFrame.toFixed(2)} submit=${io.submitsPerWallFrame.toFixed(2)} render=${io.rendersPerWallFrame.toFixed(2)}`);
      const sync = run.io?.sync;
      if (sync) {
        console.log(`   gpu→cpu 同步: mapAsync ${sync.mapAsync.calls} 次（${sync.mapAsyncPerWallFrame.toFixed(2)}/帧，`
          + `mean ${sync.mapAsync.meanMs.toFixed(1)}ms，max ${sync.mapAsync.maxMs.toFixed(1)}ms）`
          + ` | onSubmittedWorkDone ${sync.onSubmitted.calls} 次（${sync.onSubmittedPerWallFrame.toFixed(2)}/帧）`);
      }
    }
    console.log(`\nload average: ${loadAtStart.map((value) => value.toFixed(2)).join(" ")}（AGENTS.md 要求记录；忙机与静机不可并列）`);

    if (options.json) {
      writeFileSync(options.json, JSON.stringify({ url: options.url, loadAtStart, runs }, null, 2));
      console.log(`JSON 已写入 ${options.json}`);
    }

    const invalid = runs.filter((run) => run.valid !== true);
    if (invalid.length) {
      console.error(`\n有 ${invalid.length} 轮不成立（valid !== true），按协议不得引用其数字。`);
      process.exitCode = 2;
    }
  } catch (error) {
    /*
      失败时把 Chrome 的现场打出来。渲染进程崩溃只会留在这里（CDP 侧只见到一个
      打不开的 WebSocket），不打印的话现场就只剩"超时"两个字。
    */
    try {
      const tail = readFileSync(chromeLog, "utf8").trim().split("\n").slice(-12).join("\n");
      if (tail) console.error(`\n--- Chrome stderr（末尾 12 行，全文 ${chromeLog}） ---\n${tail}`);
    } catch { /* 没有日志就算了，不要用诊断信息盖掉原始错误 */ }
    failed = true;
    throw error;
  } finally {
    session?.ws.close();
    await cleanupOnce();
  }
}

/**
 * 收尾：按**进程组**杀（Chrome 有一堆 helper 子进程，只杀主进程会留下孤儿并把 profile
 * 目录占住），等到真的退出再删 profile；超时升级 SIGKILL。
 */
async function shutdown(chrome, profile, keepLog = false) {
  const pid = chrome.pid;
  if (pid === undefined) return;
  const signalGroup = (signal) => {
    try { process.kill(-pid, signal); }          // 整个进程组
    catch { try { chrome.kill(signal); } catch { /* 已经没了 */ } }
  };
  signalGroup("SIGTERM");
  for (let waited = 0; waited < 6000; waited += 300) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) break;
    await sleep(300);
  }
  if (chrome.exitCode === null && chrome.signalCode === null) {
    console.log("Chrome 没有在 6 s 内退出，改用 SIGKILL");
    signalGroup("SIGKILL");
    await sleep(800);
  }
  rmSync(profile, { recursive: true, force: true });
  // 成功时日志没有价值；失败时它是唯一现场，留着并已经在 catch 里打印过路径
  if (!keepLog) rmSync(`${profile}.chrome.log`, { force: true });
}

main().catch((error) => {
  console.error(`探针工具失败：${error.message}`);
  process.exit(1);
});
