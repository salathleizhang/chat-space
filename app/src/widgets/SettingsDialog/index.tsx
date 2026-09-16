import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { useState } from "react";
import { chatFetch } from "../../shared/lib/sse";
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
  ToolbarButton,
} from "../../shared/ui";

const providers = [
  { id: "volcengine", label: "火山方舟", hint: "GLM-5.3 · Seedream · Seed3D · Hyper3D · Hi3D" },
  { id: "tripo3d", label: "Tripo3D", hint: "3D 模型生成" },
  { id: "worldlabs", label: "World Labs", hint: "Marble 场景生成" },
] as const;

type ProviderStatus = Record<(typeof providers)[number]["id"], boolean>;

export function SettingsDialog() {
  const [status, setStatus] = useState<ProviderStatus | null | undefined>(undefined);

  const refreshStatus = () => {
    setStatus(undefined);
    void chatFetch("/api/capabilities")
      .then(async (response) => {
        if (!response.ok) throw new Error(`本机服务返回 ${response.status}`);
        return response.json() as Promise<{ providers?: Partial<ProviderStatus> }>;
      })
      .then((payload) => {
        setStatus({
          volcengine: payload.providers?.volcengine === true,
          tripo3d: payload.providers?.tripo3d === true,
          worldlabs: payload.providers?.worldlabs === true,
        });
      })
      .catch(() => setStatus(null));
  };

  return (
    <Dialog
      className="max-h-[80vh] w-[32rem] overflow-y-auto p-6"
      trigger={(open) => (
        <ToolbarButton icon={GearSixIcon} aria-label="设置" onClick={() => { refreshStatus(); open(); }} />
      )}
    >
      {(close) => (
        <>
          <DialogTitle>设置 · 本机服务</DialogTitle>
          <DialogDescription>
            API 凭证只在本机 chat/.env 中配置。网页不会保存或发送密钥。
          </DialogDescription>
          <div className="mt-4 flex flex-col gap-4">
            {providers.map((provider) => (
              <div key={provider.id} className="flex items-baseline justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-sm text-ink">{provider.label}</span>
                  <span className="text-xs text-ink-subtle">{provider.hint}</span>
                </div>
                <Badge>
                  {status === undefined ? "读取中" : status === null ? "无法连接" : status[provider.id] ? "已配置" : "未配置"}
                </Badge>
              </div>
            ))}
          </div>
          <div className="mt-6 flex justify-end">
            <Button variant="secondary" onClick={close}>关闭</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
