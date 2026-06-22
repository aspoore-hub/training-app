import { loadJSON, saveJSON } from "./storage";
import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import { saveJSONWithTeamCloudSyncStrict } from "./teamCloudSync";

export const AUXILIARY_ROUTINES_KEY = "training_app_auxiliary_routines_v1";

export type DrillRoutineItem =
  | {
      id: string;
      kind: "libraryDrill";
      drillId: string;
      prescription: string;
      customNotes?: string;
      drillTitle?: string;
      drillVideoUrl?: string;
      drillDefaultDetails?: string;
    }
  | {
      id: string;
      kind: "text";
      text: string;
    };

export type AuxiliaryRoutine = {
  id: string;
  folderId?: string | null;
  title: string;
  description?: string;
  details: string;
  items?: DrillRoutineItem[];
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

export function createRoutineItemId() {
  return `routine_item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeRoutineItem(raw: any): DrillRoutineItem | null {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim() || createRoutineItemId();
  const kind = String(raw.kind ?? "").trim();
  if (kind === "libraryDrill") {
    const drillId = String(raw.drillId ?? "").trim();
    if (!drillId) return null;
    return {
      id,
      kind: "libraryDrill",
      drillId,
      prescription: String(raw.prescription ?? "").trim(),
      customNotes: String(raw.customNotes ?? "").trim() || undefined,
      drillTitle: String(raw.drillTitle ?? "").trim() || undefined,
      drillVideoUrl: String(raw.drillVideoUrl ?? "").trim() || undefined,
      drillDefaultDetails: String(raw.drillDefaultDetails ?? "").trim() || undefined,
    };
  }
  if (kind === "text") {
    const text = String(raw.text ?? "").trim();
    if (!text) return null;
    return { id, kind: "text", text };
  }
  return null;
}

function normalizeRoutineItems(raw: any): DrillRoutineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeRoutineItem(item))
    .filter((item): item is DrillRoutineItem => Boolean(item));
}

function normalizeRoutine(raw: any): AuxiliaryRoutine | null {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? "").trim() || "Routine";
  const description = String(raw.description ?? "").trim();
  const details = String(raw.details ?? "").trim();
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id: String(raw.id ?? "").trim() || createRoutineId(),
    folderId: String(raw.folderId ?? "").trim() || null,
    title,
    description: description || undefined,
    details,
    items: normalizeRoutineItems(raw.items),
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

export async function loadAuxiliaryRoutineDefinitions(): Promise<AuxiliaryRoutine[]> {
  try {
    const teamId = await getCurrentTeamId();
    const { data, error } = await supabase
      .from("team_kv_blobs")
      .select("data")
      .eq("team_id", teamId)
      .eq("key", AUXILIARY_ROUTINES_KEY)
      .maybeSingle();

    if (!error && Array.isArray(data?.data)) {
      return data.data
        .map((item) => normalizeRoutine(item))
        .filter((item): item is AuxiliaryRoutine => !!item)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
  } catch {
    // Fall back to the synced storage path below.
  }

  return loadAuxiliaryRoutines();
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
  description?: string;
  details?: string;
  categoryNames?: string[];
  preCategoryNames?: string[];
  postCategoryNames?: string[];
  folderId?: string | null;
  items?: DrillRoutineItem[];
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
    folderId: String(input.folderId ?? "").trim() || null,
    title: String(input.title ?? "").trim() || "Routine",
    description: String(input.description ?? "").trim() || undefined,
    details: String(input.details ?? "").trim(),
    items: normalizeRoutineItems(input.items),
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
    description?: string;
    details?: string;
    categoryNames?: string[];
    preCategoryNames?: string[];
    postCategoryNames?: string[];
    folderId?: string | null;
    items?: DrillRoutineItem[];
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
      folderId: patch.folderId !== undefined ? String(patch.folderId ?? "").trim() || null : item.folderId ?? null,
      title: patch.title != null ? String(patch.title).trim() || "Routine" : item.title,
      description: patch.description != null ? String(patch.description).trim() || undefined : item.description,
      details: patch.details != null ? String(patch.details).trim() : item.details,
      items: patch.items != null ? normalizeRoutineItems(patch.items) : normalizeRoutineItems(item.items),
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
