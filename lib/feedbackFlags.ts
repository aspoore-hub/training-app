import { loadJSON, saveJSON } from "./storage";

export const FEEDBACK_FLAGS_ENABLED_KEY = "training_app_feedback_flags_enabled_v1";

export type FeedbackWarningMode =
  | "all"
  | "previous_month"
  | "last_14_days"
  | "last_7_days"
  | "since_date";

export type FeedbackFlagSettings = {
  enabled: boolean;
  mode: FeedbackWarningMode;
  startDateISO?: string;
};

const DEFAULT_SETTINGS: FeedbackFlagSettings = {
  enabled: false,
  mode: "all",
};

export async function loadFeedbackFlagsEnabled(): Promise<boolean> {
  const raw = await loadJSON<any>(FEEDBACK_FLAGS_ENABLED_KEY, false);
  if (typeof raw === "boolean") return raw;
  if (raw && typeof raw === "object") return !!raw.enabled;
  return false;
}

export async function saveFeedbackFlagsEnabled(enabled: boolean) {
  const existing = await loadFeedbackFlagSettings();
  await saveJSON(FEEDBACK_FLAGS_ENABLED_KEY, {
    ...existing,
    enabled: !!enabled,
  } satisfies FeedbackFlagSettings);
}

export async function loadFeedbackFlagSettings(): Promise<FeedbackFlagSettings> {
  const raw = await loadJSON<any>(FEEDBACK_FLAGS_ENABLED_KEY, false);

  // Backward compatibility with prior boolean toggle storage.
  if (typeof raw === "boolean") {
    return {
      ...DEFAULT_SETTINGS,
      enabled: raw,
    };
  }

  const modeRaw = String(raw?.mode ?? DEFAULT_SETTINGS.mode);
  const mode: FeedbackWarningMode =
    modeRaw === "previous_month" ||
    modeRaw === "last_14_days" ||
    modeRaw === "last_7_days" ||
    modeRaw === "since_date" ||
    modeRaw === "all"
      ? modeRaw
      : DEFAULT_SETTINGS.mode;

  const startDateISO = String(raw?.startDateISO ?? "").trim();

  return {
    enabled: !!raw?.enabled,
    mode,
    startDateISO: startDateISO || undefined,
  };
}

export async function saveFeedbackFlagSettings(settings: FeedbackFlagSettings) {
  const startDateISO = String(settings.startDateISO ?? "").trim();
  await saveJSON(FEEDBACK_FLAGS_ENABLED_KEY, {
    enabled: !!settings.enabled,
    mode: settings.mode,
    startDateISO: startDateISO || undefined,
  } satisfies FeedbackFlagSettings);
}
