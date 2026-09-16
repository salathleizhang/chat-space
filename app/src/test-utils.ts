import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * 最小 hook 测试台：把 hook 挂进一个只渲染 null 的探针组件，用 React 19 自带的
 * `act` 驱动。刻意不引入 @testing-library/react——这里只需要"渲染 / 换 props /
 * 卸载"三件事，为此加一个依赖不值得。
 */
export interface HookHarness<P, R> {
  result: { current: R };
  rerender: (props: P) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function renderHook<P, R>(
  hook: (props: P) => R,
  initialProps: P,
): Promise<HookHarness<P, R>> {
  const result = { current: undefined as R };
  let props = initialProps;
  const Probe = () => {
    result.current = hook(props);
    return null;
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });

  return {
    result,
    rerender: async (next: P) => {
      props = next;
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 让已排队的微任务与 0ms 定时器跑完（等 fetch 的 .then 链落地） */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** 手工控制兑现时机的 promise，用来模拟"请求还在路上时组件被卸载" */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
