import { ChatServiceError } from "./errors";

/**
 * 出网请求的统一超时预算。
 *
 * 2026-09-26 定位到的根因（World Labs 世界生成：整条任务 53 分钟，其中 37 分钟纯空转，
 * 最后还失败）：供应商侧 5 分 14 秒就完成了，本机却一直没有进展，而「30 分钟 deadline」
 * 一次都没触发。原因是所有超时都只建立在 `AbortSignal` 上，而它依赖 fetch 真的遵守
 * abort：Bun 在 keep-alive 连接被服务端或本机代理静默断开时既不 reject 也不理会 abort，
 * 于是 `Date.now() > deadline` 那行永远走不到——它排在 await 之后，请求不返回就没人执行它。
 *
 * 所以这里的原则是：**每一个可能挂住的 await 都要有 Promise.race 级别的硬上限**，
 * 不把正确性寄托在底层组件会守约上。`withHardTimeout` 是唯一的兜底原语，
 * `Deadline` 是任务级总预算，`readBodyWithTimeout` 补上「响应头到了但 body 不传数据」。
 */

/** 提交、查询状态这类短请求；正常在秒级返回 */
export const API_REQUEST_TIMEOUT_MS = 2 * 60_000;
/** 上传参考图/模型（multipart 或 S3 直传） */
export const UPLOAD_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** 图片生成/编辑；高分辨率单张可能跑一两分钟 */
export const IMAGE_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** 产物下载的单次尝试预算（GLB 可达数十 MB） */
export const DOWNLOAD_REQUEST_TIMEOUT_MS = 10 * 60_000;
/** 产物下载的重试次数（含首次）：链路抖一下不该让整条任务白跑 */
export const DOWNLOAD_MAX_ATTEMPTS = 4;

/** 统一的单次请求超时错误（可重试；与任务级 deadline 的区别见 Deadline 注释） */
export function requestTimeoutError(label: string, timeoutMs: number): ChatServiceError {
  return new ChatServiceError(
    `${label} request timed out (no response for ${Math.round(timeoutMs / 1000)} seconds); aborted`,
    504,
    "request_timeout",
  );
}

/**
 * 硬预算：到点一定拒绝，不等 work 自己响应取消。
 *
 * Promise.race 不依赖被包裹的 promise 是否理会 AbortSignal，所以它是「卡死」的唯一
 * 可靠解药。work 在超时之后才落定对已结算的 promise 是空操作，也不会产生未处理拒绝
 * （两个分支都挂了处理器）。
 */
export function withHardTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  error: () => ChatServiceError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), Math.max(1, timeoutMs));
    const settle = <A>(fn: (value: A) => void) => (value: A) => {
      clearTimeout(timer);
      fn(value);
    };
    work.then(settle(resolve), settle(reject));
  });
}

/**
 * 一条任务级总预算。
 *
 * - `signal` 交给出网请求：到期时 abort 正在飞的那一个，让连接真的被释放。
 * - `guard(work)` 是硬兜底：即使请求完全不理会 abort，调用方也能在预算内拿回控制权。
 * - 错误由调用方给：各供应商保留自己的错误码（`tripo_timeout` 等），不统一成一个。
 *
 * 用 `dispose()` 结束（放在 finally 里），否则定时器会一直挂到进程结束。
 */
export class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly expiresAt: number;
  private readonly makeError: () => ChatServiceError;

  constructor(timeoutMs: number, makeError: () => ChatServiceError) {
    this.makeError = makeError;
    this.expiresAt = Date.now() + timeoutMs;
    // abort 的 reason 直接用调用方的错误：使用 signal 的请求会带着正确的错误码拒绝，
    // 而 isRetryableNetworkError 会把它判成「不可重试」，循环立刻收手。
    this.timer = setTimeout(() => this.controller.abort(this.makeError()), timeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get expired(): boolean {
    return this.controller.signal.aborted || Date.now() >= this.expiresAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  error(): ChatServiceError {
    return this.makeError();
  }

  /** 在预算内等一次操作；预算到点必然拒绝。budgetMs 用来给单次尝试更紧的上限。 */
  guard<T>(work: Promise<T>, budgetMs: number = this.remainingMs): Promise<T> {
    return withHardTimeout(work, Math.min(budgetMs, this.remainingMs), () => this.makeError());
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** 给请求补上超时信号；调用方自带 signal 时两者取先到者（显式取消仍然有效）。 */
export function withRequestTimeout(init: RequestInit = {}, timeoutMs: number): RequestInit {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout };
}

/** fetch 因超时/取消抛出的 DOMException（TimeoutError 或 AbortError） */
export function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * 只有超时和网络层错误值得重试；供应商明确回错的业务错误（ChatServiceError）应立刻
 * 冒泡，否则一个错 key 会白白轮询到 deadline 才失败。
 */
export function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof ChatServiceError) return error.code === "request_timeout";
  return true;
}

/**
 * 带硬超时的 fetch。
 *
 * 两层保险：① signal 让底层请求真的被取消；② withHardTimeout 保证即使 fetch 不理会
 * abort，调用方也能在预算内拿到 504。只做①正是 2026-09-26 卡死的原因。
 *
 * 注意这只覆盖到响应头：响应体必须用 `readBodyWithTimeout` 兜底，否则 body 读不完
 * 同样会无限等。
 */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await withHardTimeout(
      fetchFn(input, withRequestTimeout(init ?? {}, timeoutMs)),
      timeoutMs,
      () => requestTimeoutError(label, timeoutMs),
    );
  } catch (error) {
    if (isTimeoutError(error)) throw requestTimeoutError(label, timeoutMs);
    throw error;
  }
}

/** 在预算内读完响应体：响应头到了但 body 不传数据时也要中止，不能无限等。 */
export function readBodyWithTimeout<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return withHardTimeout(Promise.resolve().then(read), timeoutMs, () =>
    requestTimeoutError(label, timeoutMs),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
