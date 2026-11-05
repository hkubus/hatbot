import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

// The daemon's UiState and Action (app/src/daemon.rs).
export type AppState = {
  phase: "starting" | "welcome" | "login" | "settingUp" | "in";
  platform: string;
  server: string | null;
  local: boolean;
  lan: string | null;
  step: string | null;
  error: string | null;
  busy: boolean;
  computerEnabled: boolean;
  agent: {
    online: boolean;
    status: {
      enabled: boolean;
      locked: boolean;
      ownerActive: boolean;
      paused: boolean;
      screen: { output: string; width: number; height: number } | null;
    };
  };
};

export type Action =
  | { do: "runHere" | "connectElsewhere" | "back" | "stopComputer" | "openHatbot" }
  | { do: "signIn"; address: string; password: string; code: string }
  | { do: "computerEnabled" | "computerPaused" | "lan"; on: boolean };

export const act = (action: Action) => invoke("act", { action });

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    const off = listen<AppState>("state", (e) => setState(e.payload));
    invoke<AppState>("state").then((s) => setState((now) => now ?? s));
    return () => {
      off.then((f) => f());
    };
  }, []);
  return state;
}
