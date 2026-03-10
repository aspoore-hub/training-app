import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import { normalizeWorkoutTimeInput } from "./time";
import { CATEGORIES_KEY } from "./categories";
import { normalizeCategories } from "./categories";
import { DISTANCE_UNIT_KEY, DEFAULT_DISTANCE_UNIT, type DistanceUnit, normalizeDistanceUnit } from "./units";
import { PRACTICE_DEFAULTS_KEY, type PracticeTimeDefaults, emptyPracticeTimeDefaults } from "./practiceDefaults";
import { loadJSON, saveJSON } from "./storage";
import type { WorkoutCategory } from "./types";

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

export const COACH_SETTINGS_LOAD_SOURCE_TEAM = "team_kv_blobs + local key cache";
export const COACH_SETTINGS_LOAD_SOURCE_LEGACY = "legacy kv_blobs fallback";
export const COACH_SETTINGS_LOAD_SOURCE_DEFAULTS = "local defaults (no stored settings found)";
export const COACH_SETTINGS_SAVE_SOURCE = "team_kv_blobs + local key cache";
export const COACH_CATEGORIES_SOURCE = "team_kv_blobs (team-scoped)";
export const COACH_CATEGORIES_KEY = CATEGORIES_KEY;

let lastCoachSettingsLoadSource =
  COACH_SETTINGS_LOAD_SOURCE_DEFAULTS;

export function getLastCoachSettingsLoadSource(): string {
  return lastCoachSettingsLoadSource;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

// Persisted category normalization must not auto-fallback to defaults.
function normalizeStoredCategories(input: unknown): WorkoutCategory[] {
  const list = Array.isArray(input) ? input : [];
  const out: WorkoutCategory[] = [];
  const seen = new Set<string>();

  for (const raw of list as any[]) {
    const name = String(raw?.name ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = String(raw?.id ?? "").trim() || `cat-${key}`;
    const color = isHexColor(raw?.color) ? String(raw.color).trim() : undefined;
    out.push({ id, name, color });
  }

  return out;
}

export async function loadCoachCategoriesFromTeamKV(): Promise<WorkoutCategory[]> {
  const local = await loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []);

  if (Array.isArray(local) && local.length > 0) {
    return normalizeCategories(local);
  }

  try {
    const teamId = await getCurrentTeamId();
    if (!teamId) {
      console.warn("[settings] loadCoachCategoriesFromTeamKV: missing team id");
      return [];
    }

    const { data, error } = await supabase
      .from("team_kv_blobs")
      .select("data")
      .eq("team_id", teamId)
      .eq("key", CATEGORIES_KEY)
      .maybeSingle();

    if (error) {
      console.warn("[settings] loadCoachCategoriesFromTeamKV: supabase error", error);
      return [];
    }

    const rawValue = (data as any)?.data;
    if (!Array.isArray(rawValue)) {
      console.warn("[settings] loadCoachCategoriesFromTeamKV: value is not an array", rawValue);
      return [];
    }

    const categories = normalizeCategories(rawValue);
    await saveJSON(CATEGORIES_KEY, categories);
    return categories;
  } catch (err) {
    console.warn("[settings] loadCoachCategoriesFromTeamKV: fallback load failed", err);
    return [];
  }
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

export function getCategoryOptions(settings: CoachAppSettings | null | undefined, options?: { excludeOther?: boolean }): WorkoutCategory[] {
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

  return out;
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

export function practiceDefaultsFromCoachSettings(settings: CoachAppSettings | null | undefined): PracticeTimeDefaults {
  const result: PracticeTimeDefaults = emptyPracticeTimeDefaults();
  if (!settings) return result;

  WEEKDAY_KEYS.forEach((day, idx) => {
    const source = settings.defaultSessionTimes?.[day] ?? {};
    const am = String(source.AM ?? "").trim();
    const pm = String(source.PM ?? "").trim();
    if (am) result[String(idx)].am = am;
    if (pm) result[String(idx)].pm = pm;
  });

  return result;
}

export function parsePracticeDefaultsToSessionTimes(defaults: PracticeTimeDefaults | null | undefined): Record<WeekdayKey, SessionTimeMap> {
  const merged = emptySessionTimes();
  if (!defaults || typeof defaults !== "object") return merged;

  WEEKDAY_KEYS.forEach((dayKey, idx) => {
    const raw = (defaults as any)[String(idx)] as any;
    if (!raw || typeof raw !== "object") return;
    merged[dayKey] = {
      AM: normalizeTime(String((raw as any).am ?? "")),
      PM: normalizeTime(String((raw as any).pm ?? "")),
    };
  });

  return merged;
}

export async function loadCoachSettings(): Promise<CoachAppSettings> {
  const [storedCategories, storedDefaults, storedDistanceUnit] = await Promise.all([
    loadCoachCategoriesFromTeamKV(),
    loadJSON<PracticeTimeDefaults>(PRACTICE_DEFAULTS_KEY, emptyPracticeTimeDefaults()),
    loadJSON<DistanceUnit>(DISTANCE_UNIT_KEY, DEFAULT_DISTANCE_UNIT),
  ]);

  const teamBacked = normalizeCoachSettings({
    categories: storedCategories,
    practiceDefaults: storedDefaults,
    distanceUnit: normalizeDistanceUnit(storedDistanceUnit),
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
    const current = await loadCoachSettings();
    const merged = normalizeCoachSettings({
      ...current,
      ...next,
    });

    await Promise.all([
      saveCoachCategoriesToTeamKV(merged.categories),
      saveJSON(PRACTICE_DEFAULTS_KEY, toPracticeDefaults(merged)),
      saveJSON(DISTANCE_UNIT_KEY, merged.distanceUnit),
    ]);
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
