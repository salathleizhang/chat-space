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
  { id: "volcengine", label: "Volcano Engine Ark", hint: "Doubao Seed 2.0 Lite · Seedream · Seed3D · Hyper3D · Hi3D" },
  { id: "tripo3d", label: "Tripo3D", hint: "3D model generation" },
  { id: "worldlabs", label: "World Labs", hint: "Marble scene generation" },
] as const;

type ProviderStatus = Record<(typeof providers)[number]["id"], boolean>;

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
          worldlabs: payload.providers?.worldlabs === true,
        });
      })
      .catch(() => setStatus(null));
  };

  return (
    <Dialog
      className="max-h-[80vh] w-[32rem] overflow-y-auto p-6"
      trigger={(open) => (
        <ToolbarButton icon={GearSixIcon} aria-label="Settings" onClick={() => { refreshStatus(); open(); }} />
      )}
    >
      {(close) => (
        <>
          <DialogTitle>Settings · Local service</DialogTitle>
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
          <div className="mt-6 flex justify-end">
            <Button variant="secondary" onClick={close}>Close</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
