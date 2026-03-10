import { loadJSON, saveJSON } from "./storage";

export const CATEGORY_ROUTINE_DEFAULTS_KEY = "training_app_category_routine_defaults_v1";

export type CategoryRoutineDefaults = Record<string, string[]>;

export function normalizeCategoryRoutineKey(name: string) {
  return String(name ?? "").trim().toLowerCase();
}

function normalizeRoutineIds(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
    )
  );
}

export async function loadCategoryRoutineDefaults(): Promise<CategoryRoutineDefaults> {
  const raw = await loadJSON<Record<string, any>>(CATEGORY_ROUTINE_DEFAULTS_KEY, {});
  if (!raw || typeof raw !== "object") return {};
  const out: CategoryRoutineDefaults = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeCategoryRoutineKey(key);
    if (!normalizedKey) continue;
    out[normalizedKey] = normalizeRoutineIds(value);
  }
  return out;
}

export async function saveCategoryRoutineDefaults(value: CategoryRoutineDefaults) {
  const out: CategoryRoutineDefaults = {};
  for (const [key, routineIds] of Object.entries(value ?? {})) {
    const normalizedKey = normalizeCategoryRoutineKey(key);
    if (!normalizedKey) continue;
    out[normalizedKey] = normalizeRoutineIds(routineIds);
  }
  await saveJSON(CATEGORY_ROUTINE_DEFAULTS_KEY, out);
}
