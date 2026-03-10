import { loadJSON, saveJSON } from "./storage";

export const PLANNER_DRAFTS_KEY = "training_app_planner_drafts_v1";

export type PlannerDraft = {
  id: string;
  dateISO: string;
  session: "AM" | "PM";
  groupingMode?: "all_group_1" | "pairs" | "three_groups" | "preserve_existing";
  location: string;
  timeText: string;
  title: string;
  details: string;
  preRoutineIds: string[];
  postRoutineIds: string[];
  categoryIds: string[];
  selectedAthleteIds: string[];
  createdAt: number;
  updatedAt: number;
};

function createDraftId() {
  return `drf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeStringArray(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from(
    new Set(
      list
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
    )
  );
}

function normalizePlannerDraftInput(raw: any) {
  const groupingMode =
    raw?.groupingMode === "pairs" ||
    raw?.groupingMode === "three_groups" ||
    raw?.groupingMode === "preserve_existing"
      ? raw.groupingMode
      : "all_group_1";
  return {
    id: String(raw?.id ?? "").trim() || undefined,
    dateISO: String(raw?.dateISO ?? "").trim(),
    session: String(raw?.session ?? "").toUpperCase() === "PM" ? "PM" : "AM",
    groupingMode,
    location: String(raw?.location ?? "").trim(),
    timeText: String(raw?.timeText ?? "").trim(),
    title: String(raw?.title ?? "").trim(),
    details: String(raw?.details ?? "").trim(),
    preRoutineIds: normalizeStringArray(raw?.preRoutineIds),
    postRoutineIds: normalizeStringArray(raw?.postRoutineIds),
    categoryIds: normalizeStringArray(raw?.categoryIds),
    selectedAthleteIds: normalizeStringArray(raw?.selectedAthleteIds),
    createdAt: Number.isFinite(Number(raw?.createdAt)) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : Date.now(),
  };
}

function normalizeDraft(raw: any): PlannerDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const normalized = normalizePlannerDraftInput(raw);
  const id = String(normalized.id ?? "").trim() || createDraftId();
  const dateISO = String(normalized.dateISO ?? "").trim();
  if (!dateISO) return null;
  const session = normalized.session === "PM" ? "PM" : "AM";
  const groupingMode = normalized.groupingMode as PlannerDraft["groupingMode"];
  const location = String(normalized.location ?? "").trim();
  const timeText = String(normalized.timeText ?? "").trim();
  const title = String(normalized.title ?? "").trim();
  const details = String(normalized.details ?? "").trim();
  const preRoutineIds = Array.isArray(normalized.preRoutineIds) ? normalized.preRoutineIds : [];
  const postRoutineIds = Array.isArray(normalized.postRoutineIds) ? normalized.postRoutineIds : [];
  const categoryIds = Array.isArray(normalized.categoryIds) ? normalized.categoryIds : [];
  const selectedAthleteIds = Array.isArray(normalized.selectedAthleteIds) ? normalized.selectedAthleteIds : [];
  const createdAt = Number(normalized.createdAt);
  const updatedAt = Number(normalized.updatedAt);
  return {
    id,
    dateISO,
    session,
    groupingMode,
    location,
    timeText,
    title,
    details,
    preRoutineIds,
    postRoutineIds,
    categoryIds,
    selectedAthleteIds,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

export async function loadPlannerDrafts(): Promise<PlannerDraft[]> {
  const raw = await loadJSON<any[]>(PLANNER_DRAFTS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeDraft(item))
    .filter((item): item is PlannerDraft => !!item)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function savePlannerDrafts(list: PlannerDraft[]) {
  await saveJSON(PLANNER_DRAFTS_KEY, list);
}

export async function upsertPlannerDraft(
  draft: Omit<PlannerDraft, "id" | "createdAt" | "updatedAt"> & { id?: string }
) {
  const existing = await loadPlannerDrafts();
  const now = Date.now();
  const normalizedDraft = normalizePlannerDraftInput({ ...draft, createdAt: now, updatedAt: now });
  const id = String(normalizedDraft.id ?? draft.id ?? "").trim() || createDraftId();
  const nextItem: PlannerDraft = {
    id,
    dateISO: String(normalizedDraft.dateISO ?? "").trim(),
    session: normalizedDraft.session === "PM" ? "PM" : "AM",
    groupingMode: normalizedDraft.groupingMode as PlannerDraft["groupingMode"],
    location: String(normalizedDraft.location ?? "").trim(),
    timeText: String(normalizedDraft.timeText ?? "").trim(),
    title: String(normalizedDraft.title ?? "").trim(),
    details: String(normalizedDraft.details ?? "").trim(),
    preRoutineIds: Array.isArray(normalizedDraft.preRoutineIds) ? normalizedDraft.preRoutineIds : [],
    postRoutineIds: Array.isArray(normalizedDraft.postRoutineIds) ? normalizedDraft.postRoutineIds : [],
    categoryIds: Array.isArray(normalizedDraft.categoryIds) ? normalizedDraft.categoryIds : [],
    selectedAthleteIds: Array.isArray(normalizedDraft.selectedAthleteIds) ? normalizedDraft.selectedAthleteIds : [],
    createdAt: now,
    updatedAt: now,
  };

  const found = existing.find((item) => item.id === id);
  const next = found
    ? existing.map((item) =>
        item.id === id
          ? {
              ...nextItem,
              createdAt: item.createdAt,
            }
          : item
      )
    : [nextItem, ...existing];

  await savePlannerDrafts(next);
  return nextItem;
}

export async function deletePlannerDraft(id: string) {
  const existing = await loadPlannerDrafts();
  const next = existing.filter((item) => item.id !== id);
  await savePlannerDrafts(next);
}
