interface Initializable {
  init(): Promise<unknown>;
  dispose(): Promise<unknown>;
}

/** GPU adapter/device requests cannot be cancelled. Bound the UI wait, but
 * retain ownership until a late init settles so its device is still released.
 * Never dispose a half-initialized backend and then let it allocate again.
 */
export function initializeRenderer<T extends Initializable>(renderer: T, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const cleanup = () => {
      // Preserve the original init error if the failed GPU service also rejects cleanup.
      void Promise.resolve().then(() => renderer.dispose()).catch(() => {});
    };
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("WebGPU initialization timed out. Retry rendering; if it persists, restart the browser."));
    }, timeoutMs);
    void Promise.resolve().then(() => renderer.init()).then(() => {
      clearTimeout(timer);
      if (expired) cleanup();
      else resolve(renderer);
    }, (error: unknown) => {
      clearTimeout(timer);
      cleanup();
      if (!expired) reject(error);
    });
  });
}
