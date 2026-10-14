import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { lazy, Suspense, useState } from "react";
import { browserLocalEnabled } from "../../browser/client";
import { chatFetch } from "../../shared/lib/sse";
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
  ToolbarButton,
} from "../../shared/ui";

/** 备份面板只在浏览器本地版有意义，所以懒加载：另一个构建的包里连这段代码都不该出现。 */
const BackupPanel = lazy(() => import("../../browser/BackupPanel").then((module) => ({ default: module.BackupPanel })));

const providers = [
  { id: "volcengine", label: "Volcano Engine Ark", hint: "GLM 5.3 Flash · DeepSeek V4.1 Flash · Doubao-Seed-Evolving · Doubao-Seed-2.1-pro · Seedream · Seed3D · Hyper3D · Hi3D" },
  { id: "tripo3d", label: "Tripo3D", hint: "3D generation · Retopology · Rigging · Animation · Texture · Segmentation" },
  { id: "hunyuan", label: "Tencent Hunyuan", hint: "UV unwrapping only" },
  { id: "worldlabs", label: "World Labs", hint: "Marble scene generation" },
] as const;

type ProviderStatus = Record<(typeof providers)[number]["id"], boolean>;

/**
 * 两个构建共用这一个对话框，但**内容不同**：
 *
 * - **本地服务版**（默认构建，数据在 `~/ChatSpace`）：凭据确实来自本机 `chat/.env`，
 *   所以保留供应商状态表——它是"`.env` 是否接上"的自检。
 * - **浏览器本地版**（`VITE_BROWSER_LOCAL=1`，数据在 IndexedDB）：凭据由站点服务端持有
 *   （`chat/src/cloud/proxy.ts`），这份对话框里没有任何可配项，而那张状态表恰好在那儿
 *   **有死行**（`proxy.ts` 的 `allowedProviderUrl` 不放行混元的域名 → `HUNYUAN_KEY` 配了也永远
 *   用不上）；用户能采取的行动只是"找网站管理员"，同样的信息出错时由
 *   `browser/errors.ts` 直接给出。所以这个构建里删掉供应商表，只留"数据与备份"。
 */
export function SettingsDialog() {
  const [status, setStatus] = useState<ProviderStatus | null | undefined>(undefined);

  const refreshStatus = () => {
    setStatus(undefined);
    void chatFetch("/api/capabilities")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Local service returned ${response.status}`);
        return response.json() as Promise<{ providers?: Partial<ProviderStatus> }>;
      })
      .then((payload) => {
        setStatus({
          volcengine: payload.providers?.volcengine === true,
          tripo3d: payload.providers?.tripo3d === true,
          hunyuan: payload.providers?.hunyuan === true,
          worldlabs: payload.providers?.worldlabs === true,
        });
      })
      .catch(() => setStatus(null));
  };

  return (
    <Dialog
      className="max-h-[80vh] w-[32rem] overflow-y-auto p-6"
      trigger={(open) => (
        <ToolbarButton
          icon={GearSixIcon}
          aria-label="Settings"
          onClick={() => { if (!browserLocalEnabled) refreshStatus(); open(); }}
        />
      )}
    >
      {(close) => (
        <>
          <DialogTitle>{browserLocalEnabled ? "Settings" : "Settings · Local service"}</DialogTitle>
          {browserLocalEnabled ? (
            <>
              <DialogDescription>
                AI provider credentials are maintained by this site's server. The app does not store or send your keys.
              </DialogDescription>
              <div className="mt-4">
                <Suspense fallback={null}>
                  <BackupPanel />
                </Suspense>
              </div>
            </>
          ) : (
            <>
              <DialogDescription>
                API credentials are configured locally in chat/.env. The web app does not store or send keys.
              </DialogDescription>
              <div className="mt-4 flex flex-col gap-4">
                {providers.map((provider) => (
                  <div key={provider.id} className="flex items-baseline justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm text-ink">{provider.label}</span>
                      <span className="text-xs text-ink-subtle">{provider.hint}</span>
                    </div>
                    <Badge>
                      {status === undefined ? "Loading" : status === null ? "Unable to connect" : status[provider.id] ? "Configured" : "Not configured"}
                    </Badge>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="mt-6 flex justify-end">
            <Button variant="secondary" onClick={close}>Close</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
