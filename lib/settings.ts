import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import { normalizeWorkoutTimeInput } from "./time";
import { CATEGORIES_KEY } from "./categories";
import { normalizeCategories } from "./categories";
import { DISTANCE_UNIT_KEY, DEFAULT_DISTANCE_UNIT, type DistanceUnit, normalizeDistanceUnit } from "./units";
import {
  PRACTICE_DEFAULTS_KEY,
  type PracticeTimeDefaults,
  emptyPracticeTimeDefaults,
  loadPracticeTimeDefaults,
} from "./practiceDefaults";
import { loadJSON, saveJSON } from "./storage";
import { sortCategoriesForDisplay } from "./sortHelpers";
import type { WorkoutCategory } from "./types";
import { normalizeWeekLabelType, type WeekLabelType } from "./weekLabelStyle";

// Authoritative settings source: synced storage keys managed in this module
// (backed by kv_blobs/team_kv_blobs sync). Do not add alternate settings paths.
// Coach settings should be loaded and saved from this module only.
// Planner, Daily View, category editors, and editor screens should not parse
// local storage keys directly for these values.
type WeekdayKey = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

export type SessionTimeMap = {
  AM?: string;
  PM?: string;
};

export type CoachAppSettings = {
  categories: WorkoutCategory[];
  defaultSessionTimes: Record<WeekdayKey, SessionTimeMap>;
  distanceUnit: DistanceUnit;
};
export type CoachCoreSettings = Pick<CoachAppSettings, "categories" | "distanceUnit">;
export type CoachCategorySettings = Pick<CoachAppSettings, "categories">;

export type WeekStartSetting = "sunday" | "monday";
export const WEEK_START_KEY = "training_app_week_start_v1";
export const COACH_WEEK_LABELS_KEY = "training_app_week_labels_v1";

export const COACH_SETTINGS_LOAD_SOURCE_TEAM = "team_kv_blobs + local key cache";
export const COACH_SETTINGS_LOAD_SOURCE_DEFAULTS = "local defaults (no stored settings found)";
export const COACH_SETTINGS_SAVE_SOURCE = "team_kv_blobs + local key cache";
export const COACH_CATEGORIES_SOURCE = "team_kv_blobs (team-scoped)";
export const COACH_CATEGORIES_KEY = CATEGORIES_KEY;
let cachedCoachCategories: WorkoutCategory[] = [];
let inFlightCoachCategoriesRefresh: Promise<WorkoutCategory[]> | null = null;

let lastCoachSettingsLoadSource =
  COACH_SETTINGS_LOAD_SOURCE_DEFAULTS;

export function getLastCoachSettingsLoadSource(): string {
  return lastCoachSettingsLoadSource;
}

export function normalizeWeekStartSetting(raw: unknown): WeekStartSetting {
  if (raw === 0 || raw === "sunday") return "sunday";
  if (raw === 1 || raw === "monday") return "monday";
  return "monday";
}

export async function loadWeekStartSetting(): Promise<{
  raw: WeekStartSetting | 0 | 1;
  normalized: WeekStartSetting;
}> {
  const raw = await loadJSON<WeekStartSetting | 0 | 1>(WEEK_START_KEY, "monday");
  return {
    raw,
    normalized: normalizeWeekStartSetting(raw),
  };
}

export async function saveWeekStartSetting(next: WeekStartSetting): Promise<void> {
  await saveJSON<WeekStartSetting>(WEEK_START_KEY, normalizeWeekStartSetting(next));
}

export type CoachWeekLabelType = WeekLabelType;
export type CoachWeekLabelEntry = {
  label: string;
  type: CoachWeekLabelType;
};
export type CoachWeekLabels = Record<string, CoachWeekLabelEntry>;

function inferLegacyWeekLabelType(labelText: string): CoachWeekLabelType {
  const normalized = String(labelText ?? "").trim().toLowerCase();
  if (!normalized) return "training";
  const competition = [
    "meet",
    "relays",
    "open",
    "challenge",
    "champs",
    "district",
    "sectional",
    "regional",
    "state",
    "invite",
    "competition",
    "conference",
    "section",
    "qualifier",
    "ncaa",
    "race",
    "championship",
    "invitational",
  ];
  const breakKeywords = ["break", "off", "rest", "recovery", "holiday"];
  if (competition.some((key) => normalized.includes(key))) return "competition";
  if (breakKeywords.some((key) => normalized.includes(key))) return "break";
  return "training";
}

function normalizeCoachWeekLabelEntry(raw: unknown): CoachWeekLabelEntry | null {
  if (typeof raw === "string") {
    const label = raw.trim();
    if (!label) return null;
    return { label, type: inferLegacyWeekLabelType(label) };
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const label = String(obj.label ?? obj.text ?? obj.name ?? "").trim();
  const rawType = obj.type ?? obj.category ?? obj.tone;
  const type = normalizeWeekLabelType(rawType);
  if (!label && type === "training") return null;
  return { label, type };
}

function normalizeCoachWeekLabels(raw: unknown): CoachWeekLabels {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: CoachWeekLabels = {};
  for (const [weekStartISO, value] of Object.entries(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekStartISO ?? ""))) continue;
    const entry = normalizeCoachWeekLabelEntry(value);
    if (!entry) continue;
    out[weekStartISO] = entry;
  }
  return out;
}

export async function loadCoachWeekLabels(): Promise<CoachWeekLabels> {
  const raw = await loadJSON<unknown>(COACH_WEEK_LABELS_KEY, {});
  return normalizeCoachWeekLabels(raw);
}

export async function saveCoachWeekLabel(weekStartISO: string, labelText: string): Promise<CoachWeekLabels> {
  const normalizedWeek = String(weekStartISO ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedWeek)) {
    throw new Error("Invalid week start key.");
  }
  const current = await loadCoachWeekLabels();
  const next: CoachWeekLabels = { ...current };
  const currentEntry = current[normalizedWeek] ?? { label: "", type: "training" as const };
  const text = String(labelText ?? "").trim();
  if (!text && currentEntry.type === "training") delete next[normalizedWeek];
  else next[normalizedWeek] = { label: text, type: currentEntry.type };
  await saveJSON<CoachWeekLabels>(COACH_WEEK_LABELS_KEY, next);
  return next;
}

export async function saveCoachWeekLabelType(weekStartISO: string, type: CoachWeekLabelType): Promise<CoachWeekLabels> {
  const normalizedWeek = String(weekStartISO ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedWeek)) {
    throw new Error("Invalid week start key.");
  }
  const current = await loadCoachWeekLabels();
  const next: CoachWeekLabels = { ...current };
  const currentEntry = current[normalizedWeek] ?? { label: "", type: "training" as const };
  const normalizedType = normalizeWeekLabelType(type);
  if (!currentEntry.label && normalizedType === "training") delete next[normalizedWeek];
  else next[normalizedWeek] = { label: currentEntry.label, type: normalizedType };
  await saveJSON<CoachWeekLabels>(COACH_WEEK_LABELS_KEY, next);
  return next;
}

export async function loadCoachCategoriesFromTeamKV(): Promise<WorkoutCategory[]> {
  // Local-first read for fast UI hydration (do not block on remote).
  try {
    const rawLocal = await AsyncStorage.getItem(CATEGORIES_KEY);
    if (rawLocal) {
      const parsedLocal = JSON.parse(rawLocal);
      if (Array.isArray(parsedLocal) && parsedLocal.length > 0) {
        const normalizedLocal = normalizeCategories(parsedLocal);
        cachedCoachCategories = normalizedLocal;

        // Refresh in the background so local-first reads still converge to cloud.
        if (!inFlightCoachCategoriesRefresh) {
          inFlightCoachCategoriesRefresh = (async () => {
            try {
              const refreshed = await fetchCoachCategoriesFromTeamKV();
              cachedCoachCategories = refreshed;
              return refreshed;
            } finally {
              inFlightCoachCategoriesRefresh = null;
            }
          })();
        }

        return normalizedLocal;
      }
    }
  } catch {}

  // Fall back to remote fetch when local cache is missing/empty.
  const fetched = await fetchCoachCategoriesFromTeamKV();
  cachedCoachCategories = fetched;
  return fetched;
}

async function fetchCoachCategoriesFromTeamKV(): Promise<WorkoutCategory[]> {
  if (inFlightCoachCategoriesRefresh) return await inFlightCoachCategoriesRefresh;

  try {
    const teamId = await getCurrentTeamId();
    if (!teamId) {
      console.warn("[settings] loadCoachCategoriesFromTeamKV: missing team id");
      return cachedCoachCategories;
    }

    const { data, error } = await supabase
      .from("team_kv_blobs")
      .select("data")
      .eq("team_id", teamId)
      .eq("key", CATEGORIES_KEY)
      .maybeSingle();

    if (error) {
      console.warn("[settings] loadCoachCategoriesFromTeamKV: supabase error", error);
      return cachedCoachCategories;
    }

    const rawValue = (data as any)?.data;
    if (!Array.isArray(rawValue)) {
      console.warn("[settings] loadCoachCategoriesFromTeamKV: value is not an array", rawValue);
      return cachedCoachCategories;
    }

    const categories = normalizeCategories(rawValue);
    await saveJSON(CATEGORIES_KEY, categories);
    cachedCoachCategories = categories;
    return categories;
  } catch (err) {
    console.warn("[settings] loadCoachCategoriesFromTeamKV: fallback load failed", err);
    return cachedCoachCategories;
  }
}

export function getCachedCoachCategories(): WorkoutCategory[] {
  return cachedCoachCategories;
}

export async function saveCoachCategoriesToTeamKV(next: WorkoutCategory[]): Promise<WorkoutCategory[]> {
  const normalized = normalizeCategories(next);

  if (!Array.isArray(normalized) || normalized.length === 0) {
    console.warn("[settings] refusing to save empty category list");
    return normalized;
  }

  const teamId = await getCurrentTeamId();
  if (!teamId) {
    throw new Error("Missing team id while saving categories.");
  }

  const { error } = await supabase
    .from("team_kv_blobs")
    .upsert(
      {
        team_id: teamId,
        key: CATEGORIES_KEY,
        data: normalized,
      },
      {
        onConflict: "team_id,key",
      }
    );

  if (error) {
    throw error;
  }

  await saveJSON(CATEGORIES_KEY, normalized);
  cachedCoachCategories = normalized;
  return normalized;
}

const WEEKDAY_KEYS: WeekdayKey[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function mapIndexToWeekday(index: number): WeekdayKey {
  const idx = ((index % 7) + 7) % 7;
  return WEEKDAY_KEYS[idx];
}

function normalizeSessionTimes(raw: any): Record<WeekdayKey, SessionTimeMap> {
  const base = emptySessionTimes();
  const fromMap = raw && typeof raw === "object" ? raw : {};

  for (let i = 0; i < 7; i++) {
    const dayKey = mapIndexToWeekday(i);
    const legacyValue = fromMap[String(i)] as any;
    const namedValue = fromMap[dayKey] as any;

    const source = legacyValue && typeof legacyValue === "object" ? legacyValue : namedValue;
    if (!source || typeof source !== "object") continue;

    const am = String((source as any).am ?? (source as any).AM ?? "").trim();
    const pm = String((source as any).pm ?? (source as any).PM ?? "").trim();

    base[dayKey] = {
      AM: normalizeTime(am),
      PM: normalizeTime(pm),
    };
  }

  return base;
}

function normalizeTime(raw: string): string | undefined {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return undefined;
  return normalizeWorkoutTimeInput(trimmed) ?? trimmed;
}

function emptySessionTimes(): Record<WeekdayKey, SessionTimeMap> {
  const out = {} as Record<WeekdayKey, SessionTimeMap>;
  WEEKDAY_KEYS.forEach((key) => {
    out[key] = {};
  });
  return out;
}

export function normalizeCoachSettings(input: unknown): CoachAppSettings {
  const root = (input && typeof input === "object" ? (input as any) : {}) as Partial<CoachAppSettings & { defaultSessionTimes: any; sessionTimes: any; } & { practiceDefaults: any }>;

  const categories = Array.isArray(root.categories) ? normalizeCategories(root.categories as any) : [];
  const sessionTimesFromLegacy = normalizeSessionTimes(root.practiceDefaults ?? root.defaultSessionTimes ?? root.sessionTimes);

  const mergedSessionTimes = emptySessionTimes();
  WEEKDAY_KEYS.forEach((dayKey) => {
    const source = sessionTimesFromLegacy[dayKey] ?? {};
    mergedSessionTimes[dayKey] = {
      AM: source.AM ? String(source.AM) : undefined,
      PM: source.PM ? String(source.PM) : undefined,
    };
  });

  return {
    categories,
    defaultSessionTimes: mergedSessionTimes,
    distanceUnit: normalizeDistanceUnit((root as any).distanceUnit),
  };
}

export function getDefaultSessionTime(settings: CoachAppSettings | null | undefined, dateISO: string, session: "AM" | "PM"): string {
  if (!settings) return "";
  const [y, m, d] = String(dateISO ?? "").split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return "";
  const day = mapIndexToWeekday(new Date(y, m - 1, d).getDay());

  const byDay = settings.defaultSessionTimes?.[day] ?? {};
  const raw = String((session === "AM" ? byDay.AM : byDay.PM) ?? "").trim();
  return raw ? normalizeTime(raw) ?? raw : "";
}

export function getCategoryOptions(
  settings: CoachCategorySettings | null | undefined,
  options?: { excludeOther?: boolean }
): WorkoutCategory[] {
  const list = Array.isArray(settings?.categories) ? settings.categories : [];
  const seen = new Set<string>();
  const out: WorkoutCategory[] = [];

  for (const category of list) {
    const name = String(category?.name ?? "").trim();
    if (!name) continue;
    const key = String(name).trim().toLowerCase();
    if (seen.has(key)) continue;

    const excludeOther = !!options?.excludeOther;
    if (excludeOther && key === "other") continue;

    const id = String(category?.id ?? "").trim() || `cat-${key}`;
    seen.add(key);
    out.push({
      id,
      name,
      color: typeof (category as any)?.color === "string" ? String((category as any).color).trim() : undefined,
    });
  }

  return sortCategoriesForDisplay(out);
}

export function toPracticeDefaults(settings: CoachAppSettings): PracticeTimeDefaults {
  const result: PracticeTimeDefaults = emptyPracticeTimeDefaults();

  WEEKDAY_KEYS.forEach((day, idx) => {
    const next = settings.defaultSessionTimes?.[day] ?? {};
    const am = String(next.AM ?? "").trim();
    const pm = String(next.PM ?? "").trim();
    if (am) result[String(idx)].am = normalizeTime(am) ?? am;
    if (pm) result[String(idx)].pm = normalizeTime(pm) ?? pm;
  });

  return result;
}

export async function loadCoreCoachSettings(): Promise<CoachCoreSettings> {
  const [storedCategories, storedDistanceUnit] = await Promise.all([
    loadCoachCategoriesFromTeamKV(),
    loadJSON<DistanceUnit>(DISTANCE_UNIT_KEY, DEFAULT_DISTANCE_UNIT),
  ]);

  return {
    categories: normalizeCategories(storedCategories),
    distanceUnit: normalizeDistanceUnit(storedDistanceUnit),
  };
}

// Compatibility aggregate loader: keep for legacy/aggregate reads.
// New code should prefer loadCoreCoachSettings() + dedicated domain helpers (for example, practice defaults).
export async function loadCoachSettings(): Promise<CoachAppSettings> {
  const [core, storedDefaults] = await Promise.all([
    loadCoreCoachSettings(),
    loadJSON<PracticeTimeDefaults>(PRACTICE_DEFAULTS_KEY, emptyPracticeTimeDefaults()),
  ]);

  const teamBacked = normalizeCoachSettings({
    categories: core.categories,
    practiceDefaults: storedDefaults,
    distanceUnit: core.distanceUnit,
  });

  const [hasCategoriesKey, hasDefaultsKey, hasDistanceKey] = await Promise.all([
    AsyncStorage.getItem(CATEGORIES_KEY),
    AsyncStorage.getItem(PRACTICE_DEFAULTS_KEY),
    AsyncStorage.getItem(DISTANCE_UNIT_KEY),
  ]);
  const hasAuthoritativeStoredSettings = [hasCategoriesKey, hasDefaultsKey, hasDistanceKey].some((value) => value != null);
  if (hasAuthoritativeStoredSettings) {
    lastCoachSettingsLoadSource = COACH_SETTINGS_LOAD_SOURCE_TEAM;
    console.log("[settings] loadCoachSettings: loaded from authoritative team settings path", {
      source: lastCoachSettingsLoadSource,
      categoriesCount: teamBacked.categories.length,
      distanceUnit: teamBacked.distanceUnit,
    });
    return teamBacked;
  }

  lastCoachSettingsLoadSource = COACH_SETTINGS_LOAD_SOURCE_DEFAULTS;
  console.warn("[settings] loadCoachSettings: no stored settings found; using defaults", {
    source: lastCoachSettingsLoadSource,
    categoriesCount: teamBacked.categories.length,
    distanceUnit: teamBacked.distanceUnit,
  });
  return teamBacked;
}

export async function saveCoachSettings(next: Partial<CoachAppSettings>): Promise<CoachAppSettings> {
  console.log("[settings] saveCoachSettings: payload", next);
  try {
    const hasDefaultSessionTimesOverride = Object.prototype.hasOwnProperty.call(next, "defaultSessionTimes");
    const [core, practiceDefaults] = await Promise.all([
      loadCoreCoachSettings(),
      hasDefaultSessionTimesOverride ? Promise.resolve(undefined) : loadPracticeTimeDefaults(),
    ]);
    const current = normalizeCoachSettings({
      categories: core.categories,
      distanceUnit: core.distanceUnit,
      ...(practiceDefaults ? { practiceDefaults } : {}),
    });
    const merged = normalizeCoachSettings({
      ...current,
      ...next,
    });

    const writes: Array<Promise<unknown>> = [
      saveCoachCategoriesToTeamKV(merged.categories),
      saveJSON(DISTANCE_UNIT_KEY, merged.distanceUnit),
    ];
    if (hasDefaultSessionTimesOverride) {
      writes.push(saveJSON(PRACTICE_DEFAULTS_KEY, toPracticeDefaults(merged)));
    }

    await Promise.all(writes);
    console.log("[settings] saveCoachSettings: success", {
      source: COACH_SETTINGS_SAVE_SOURCE,
      categoriesCount: merged.categories.length,
      distanceUnit: merged.distanceUnit,
    });
    return merged;
  } catch (error) {
    console.error("[settings] saveCoachSettings: failed", error);
    throw error;
  }
}

export async function saveCoreCoachSettings(
  next: Partial<CoachCoreSettings>
): Promise<CoachCoreSettings> {
  const current = await loadCoreCoachSettings();
  const merged: CoachCoreSettings = {
    categories: Array.isArray(next.categories) ? normalizeCategories(next.categories) : current.categories,
    distanceUnit: normalizeDistanceUnit(next.distanceUnit ?? current.distanceUnit),
  };

  await Promise.all([
    saveCoachCategoriesToTeamKV(merged.categories),
    saveJSON(DISTANCE_UNIT_KEY, merged.distanceUnit),
  ]);

  return merged;
}
