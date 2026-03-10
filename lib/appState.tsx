import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

export type AppRuntimeState = {
  currentTeamId: string | null;
  activeDateISO: string | null;
  activeBatchId: string | null;
  selectedBatchHighlight: string | null;
  plannerDraftId: string | null;
  lastPlannerSubmitDebug: string;
  lastSaveError: string | null;
  lastSettingsLoadStatus: "idle" | "loading" | "loaded" | "error";
};

type AppRuntimeContextValue = {
  state: AppRuntimeState;
  patch: (patch: Partial<AppRuntimeState>) => void;
};

const defaultState: AppRuntimeState = {
  currentTeamId: null,
  activeDateISO: null,
  activeBatchId: null,
  selectedBatchHighlight: null,
  plannerDraftId: null,
  lastPlannerSubmitDebug: "",
  lastSaveError: null,
  lastSettingsLoadStatus: "idle",
};

const AppRuntimeContext = createContext<AppRuntimeContextValue | null>(null);

export function AppRuntimeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppRuntimeState>(defaultState);

  const patch = useCallback((nextPatch: Partial<AppRuntimeState>) => {
    setState((prev) => {
      let changed = false;

      for (const key of Object.keys(nextPatch) as Array<keyof AppRuntimeState>) {
        if (prev[key] !== nextPatch[key]) {
          changed = true;
          break;
        }
      }

      if (!changed) return prev;
      return { ...prev, ...nextPatch };
    });
  }, []);

  const value = useMemo<AppRuntimeContextValue>(
    () => ({
      state,
      patch,
    }),
    [state, patch]
  );

  return <AppRuntimeContext.Provider value={value}>{children}</AppRuntimeContext.Provider>;
}

export function useAppRuntime() {
  const ctx = useContext(AppRuntimeContext);
  if (!ctx) {
    throw new Error("useAppRuntime must be used inside AppRuntimeProvider");
  }
  return ctx;
}