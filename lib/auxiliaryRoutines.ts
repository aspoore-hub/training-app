import { loadJSON, saveJSON } from "./storage";
import { saveJSONWithTeamCloudSyncStrict } from "./teamCloudSync";

export const AUXILIARY_ROUTINES_KEY = "training_app_auxiliary_routines_v1";

export type AuxiliaryRoutine = {
  id: string;
  title: string;
  details: string;
  categoryNames?: string[];
  preCategoryNames?: string[];
  postCategoryNames?: string[];
  createdAt: number;
  updatedAt: number;
};

function normalizeCategoryNames(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
    )
  );
}

function createRoutineId() {
  return `aux_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeRoutine(raw: any): AuxiliaryRoutine | null {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? "").trim() || "Routine";
  const details = String(raw.details ?? "").trim();
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id: String(raw.id ?? "").trim() || createRoutineId(),
    title,
    details,
    categoryNames: normalizeCategoryNames(raw.categoryNames),
    preCategoryNames: normalizeCategoryNames(raw.preCategoryNames),
    postCategoryNames: normalizeCategoryNames(raw.postCategoryNames),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

export async function loadAuxiliaryRoutines(): Promise<AuxiliaryRoutine[]> {
  const raw = await loadJSON<any[]>(AUXILIARY_ROUTINES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeRoutine(item))
    .filter((item): item is AuxiliaryRoutine => !!item)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveAuxiliaryRoutines(
  list: AuxiliaryRoutine[],
  options?: { requireCloudSync?: boolean }
) {
  if (options?.requireCloudSync) {
    await saveJSONWithTeamCloudSyncStrict(AUXILIARY_ROUTINES_KEY, list);
    return;
  }
  await saveJSON(AUXILIARY_ROUTINES_KEY, list);
}

export async function createAuxiliaryRoutine(input: {
  title?: string;
  details?: string;
  categoryNames?: string[];
  preCategoryNames?: string[];
  postCategoryNames?: string[];
}) {
  const now = Date.now();
  const preCategoryNames = normalizeCategoryNames(input.preCategoryNames);
  const postCategoryNames = normalizeCategoryNames(input.postCategoryNames);
  const categoryNames = normalizeCategoryNames([
    ...normalizeCategoryNames(input.categoryNames),
    ...preCategoryNames,
    ...postCategoryNames,
  ]);
  const next: AuxiliaryRoutine = {
    id: createRoutineId(),
    title: String(input.title ?? "").trim() || "Routine",
    details: String(input.details ?? "").trim(),
    categoryNames,
    preCategoryNames,
    postCategoryNames,
    createdAt: now,
    updatedAt: now,
  };
  const existing = await loadAuxiliaryRoutines();
  await saveAuxiliaryRoutines([next, ...existing]);
  return next;
}

export async function updateAuxiliaryRoutine(
  id: string,
  patch: {
    title?: string;
    details?: string;
    categoryNames?: string[];
    preCategoryNames?: string[];
    postCategoryNames?: string[];
  }
) {
  const existing = await loadAuxiliaryRoutines();
  const next = existing.map((item) => {
    if (item.id !== id) return item;
    const preCategoryNames = patch.preCategoryNames != null
      ? normalizeCategoryNames(patch.preCategoryNames)
      : normalizeCategoryNames(item.preCategoryNames);
    const postCategoryNames = patch.postCategoryNames != null
      ? normalizeCategoryNames(patch.postCategoryNames)
      : normalizeCategoryNames(item.postCategoryNames);
    const categoryNames = patch.categoryNames != null
      ? normalizeCategoryNames([
          ...patch.categoryNames,
          ...preCategoryNames,
          ...postCategoryNames,
        ])
      : normalizeCategoryNames([
          ...normalizeCategoryNames(item.categoryNames),
          ...preCategoryNames,
          ...postCategoryNames,
        ]);
    return {
      ...item,
      title: patch.title != null ? String(patch.title).trim() || "Routine" : item.title,
      details: patch.details != null ? String(patch.details).trim() : item.details,
      categoryNames,
      preCategoryNames,
      postCategoryNames,
      updatedAt: Date.now(),
    };
  });
  await saveAuxiliaryRoutines(next);
}

export async function deleteAuxiliaryRoutine(
  id: string,
  options?: { requireCloudSync?: boolean }
) {
  const existing = await loadAuxiliaryRoutines();
  const next = existing.filter((item) => item.id !== id);
  await saveAuxiliaryRoutines(next, options);
}
