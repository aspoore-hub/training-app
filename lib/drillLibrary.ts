import { loadJSON, saveJSON } from "./storage";
import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import { saveJSONWithTeamCloudSyncStrict } from "./teamCloudSync";

export const DRILL_FOLDERS_KEY = "training_app_drill_folders_v1";
export const DRILL_LIBRARY_KEY = "training_app_drill_library_v1";
export const ROUTINE_FOLDERS_KEY = "training_app_routine_folders_v1";

export type DrillFolder = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type RoutineFolder = DrillFolder;

export type DrillLibraryItem = {
  id: string;
  folderId?: string | null;
  name: string;
  videoUrl: string;
  defaultDetails: string;
  categoryNames?: string[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type DrillLibraryDefinitionsLoadResult = {
  items: DrillLibraryItem[];
  loadedFromCloud: boolean;
  cloudError?: string;
  version?: number;
  updatedAt?: string;
};

export type FolderDefinitionsLoadResult<T extends DrillFolder = DrillFolder> = {
  items: T[];
  loadedFromCloud: boolean;
  cloudError?: string;
  version?: number;
  updatedAt?: string;
};

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeCategoryNames(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function normalizeFolder(raw: any): DrillFolder | null {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  const sortOrder = Number(raw.sortOrder);
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id: String(raw.id ?? "").trim() || createId("drill_folder"),
    name,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : Date.now(),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

function normalizeDrill(raw: any): DrillLibraryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  const sortOrder = Number(raw.sortOrder);
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id: String(raw.id ?? "").trim() || createId("drill"),
    folderId: String(raw.folderId ?? "").trim() || null,
    name,
    videoUrl: String(raw.videoUrl ?? "").trim(),
    defaultDetails: String(raw.defaultDetails ?? "").trim(),
    categoryNames: normalizeCategoryNames(raw.categoryNames),
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : Date.now(),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

function formatCloudError(error: any, fallback: string) {
  return String(error?.message ?? error?.details ?? error?.hint ?? error ?? fallback);
}

async function loadTeamKVBlob(key: string): Promise<{
  data: any;
  version?: number;
  updatedAt?: string;
  error?: string;
}> {
  try {
    const teamId = await getCurrentTeamId();
    const { data, error } = await supabase
      .from("team_kv_blobs")
      .select("data,version,updated_at")
      .eq("team_id", teamId)
      .eq("key", key)
      .maybeSingle();

    if (error) {
      return { data: null, error: formatCloudError(error, `${key} cloud read failed.`) };
    }

    return {
      data: data?.data,
      version: typeof data?.version === "number" ? data.version : undefined,
      updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined,
    };
  } catch (error: any) {
    return { data: null, error: formatCloudError(error, `${key} cloud read failed.`) };
  }
}

export async function loadDrillFolders(): Promise<DrillFolder[]> {
  const raw = await loadJSON<any[]>(DRILL_FOLDERS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeFolder(item))
    .filter((item): item is DrillFolder => !!item)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export async function saveDrillFolders(list: DrillFolder[]) {
  await saveJSON(DRILL_FOLDERS_KEY, list);
}

export async function loadRoutineFolders(): Promise<RoutineFolder[]> {
  const raw = await loadJSON<any[]>(ROUTINE_FOLDERS_KEY, []);
  const normalized = Array.isArray(raw)
    ? raw
        .map((item) => normalizeFolder(item))
        .filter((item): item is RoutineFolder => !!item)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    : [];
  if (normalized.length > 0) return normalized;

  // Backward compatibility: routine folders used to share the drill folder key.
  // Preserve old routine.folderId references by treating legacy drill folders as
  // routine folders until the new routine-folder key is saved.
  return loadDrillFolders();
}

export async function saveRoutineFolders(list: RoutineFolder[]) {
  await saveJSON(ROUTINE_FOLDERS_KEY, list);
}

export async function loadDrillLibraryItems(): Promise<DrillLibraryItem[]> {
  const raw = await loadJSON<any[]>(DRILL_LIBRARY_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeDrill(item))
    .filter((item): item is DrillLibraryItem => !!item)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export async function loadDrillLibraryDefinitions(): Promise<DrillLibraryItem[]> {
  const result = await loadDrillLibraryDefinitionsWithStatus();
  return result.items;
}

export async function loadDrillLibraryDefinitionsWithStatus(): Promise<DrillLibraryDefinitionsLoadResult> {
  const result = await loadTeamKVBlob(DRILL_LIBRARY_KEY);
  if (Array.isArray(result.data)) {
    return {
      items: result.data
        .map((item) => normalizeDrill(item))
        .filter((item): item is DrillLibraryItem => !!item)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
      loadedFromCloud: true,
      version: result.version,
      updatedAt: result.updatedAt,
    };
  }

  return {
    items: [],
    loadedFromCloud: false,
    cloudError: result.error || "Drill library cloud row missing or invalid.",
    version: result.version,
    updatedAt: result.updatedAt,
  };
}

export async function loadDrillFoldersWithStatus(): Promise<FolderDefinitionsLoadResult<DrillFolder>> {
  const result = await loadTeamKVBlob(DRILL_FOLDERS_KEY);
  if (Array.isArray(result.data)) {
    return {
      items: result.data
        .map((item) => normalizeFolder(item))
        .filter((item): item is DrillFolder => !!item)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
      loadedFromCloud: true,
      version: result.version,
      updatedAt: result.updatedAt,
    };
  }
  if (result.data == null && !result.error) {
    return { items: [], loadedFromCloud: true, version: result.version, updatedAt: result.updatedAt };
  }
  return {
    items: [],
    loadedFromCloud: false,
    cloudError: result.error || "Drill folders cloud row invalid.",
    version: result.version,
    updatedAt: result.updatedAt,
  };
}

export async function loadRoutineFoldersWithStatus(): Promise<FolderDefinitionsLoadResult<RoutineFolder>> {
  const result = await loadTeamKVBlob(ROUTINE_FOLDERS_KEY);
  if (Array.isArray(result.data)) {
    return {
      items: result.data
        .map((item) => normalizeFolder(item))
        .filter((item): item is RoutineFolder => !!item)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
      loadedFromCloud: true,
      version: result.version,
      updatedAt: result.updatedAt,
    };
  }
  if (result.data == null && !result.error) {
    return { items: [], loadedFromCloud: true, version: result.version, updatedAt: result.updatedAt };
  }
  return {
    items: [],
    loadedFromCloud: false,
    cloudError: result.error || "Routine folders cloud row invalid.",
    version: result.version,
    updatedAt: result.updatedAt,
  };
}

export async function saveDrillLibraryItems(list: DrillLibraryItem[]) {
  await saveJSONWithTeamCloudSyncStrict(DRILL_LIBRARY_KEY, list);
}

export function createDrillFolderDraft(name = "New Folder", sortOrder = Date.now()): DrillFolder {
  const now = Date.now();
  return {
    id: createId("drill_folder"),
    name,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}

export function createRoutineFolderDraft(name = "New Folder", sortOrder = Date.now()): RoutineFolder {
  const now = Date.now();
  return {
    id: createId("routine_folder"),
    name,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}

export function createDrillLibraryItemDraft(sortOrder = Date.now()): DrillLibraryItem {
  const now = Date.now();
  return {
    id: createId("drill"),
    folderId: null,
    name: "New Drill",
    videoUrl: "",
    defaultDetails: "",
    categoryNames: [],
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}
