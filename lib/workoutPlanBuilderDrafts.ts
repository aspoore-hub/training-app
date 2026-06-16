import { loadJSON, saveJSON } from "./storage";

export const WORKOUT_PLAN_BUILDER_DRAFTS_KEY = "training_app_workout_plan_builder_drafts_v1";

export type WorkoutPlanBuilderCell = {
  dateISO: string;
  session: "AM" | "PM";
  title: string;
  details: string;
  timeText?: string;
  location?: string;
  categoryIds?: string[];
  preRoutineIds?: string[];
  postRoutineIds?: string[];
  sourceType?: "manual" | "existing";
  sourceWorkoutId?: string;
  sourceBatchId?: string | null;
  sourceGroupId?: string | null;
  sourceDateISO?: string;
  sourceSession?: "AM" | "PM";
  originalSnapshot?: {
    title: string;
    details: string;
    timeText?: string;
    location?: string;
    categoryIds?: string[];
    preRoutineIds?: string[];
    postRoutineIds?: string[];
  };
  sourceRowCount?: number;
  conflictReason?: string;
};

export type WorkoutPlanBuilderDraft = {
  id: string;
  athleteId: string;
  seasonId?: string | null;
  rangeMode?: "season" | "custom";
  firstWeekStartISO: string;
  numberOfWeeks: number;
  cellsByKey: Record<string, WorkoutPlanBuilderCell>;
  createdAt: number;
  updatedAt: number;
};

function createDraftId() {
  return `wpb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isDateISO(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeSession(value: unknown): "AM" | "PM" {
  return String(value ?? "").trim().toUpperCase() === "AM" ? "AM" : "PM";
}

function normalizeStringArray(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from(new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function normalizeNullableString(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return value || null;
}

function normalizeSnapshot(raw: any): WorkoutPlanBuilderCell["originalSnapshot"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return {
    title: String(raw.title ?? "").trim(),
    details: String(raw.details ?? "").trim(),
    timeText: String(raw.timeText ?? "").trim() || undefined,
    location: String(raw.location ?? "").trim() || undefined,
    categoryIds: normalizeStringArray(raw.categoryIds),
    preRoutineIds: normalizeStringArray(raw.preRoutineIds),
    postRoutineIds: normalizeStringArray(raw.postRoutineIds),
  };
}

export function workoutPlanBuilderCellKey(athleteId: string, dateISO: string, session: "AM" | "PM") {
  return `${String(athleteId ?? "").trim()}__${String(dateISO ?? "").trim()}__${session}`;
}

function normalizeCell(raw: any): WorkoutPlanBuilderCell | null {
  if (!raw || typeof raw !== "object") return null;
  const dateISO = String(raw.dateISO ?? "").trim();
  if (!isDateISO(dateISO)) return null;
  return {
    dateISO,
    session: normalizeSession(raw.session),
    title: String(raw.title ?? "").trim(),
    details: String(raw.details ?? "").trim(),
    timeText: String(raw.timeText ?? "").trim() || undefined,
    location: String(raw.location ?? "").trim() || undefined,
    categoryIds: normalizeStringArray(raw.categoryIds),
    preRoutineIds: normalizeStringArray(raw.preRoutineIds),
    postRoutineIds: normalizeStringArray(raw.postRoutineIds),
    sourceType: raw.sourceType === "existing" ? "existing" : raw.sourceType === "manual" ? "manual" : undefined,
    sourceWorkoutId: normalizeNullableString(raw.sourceWorkoutId) ?? undefined,
    sourceBatchId: normalizeNullableString(raw.sourceBatchId),
    sourceGroupId: normalizeNullableString(raw.sourceGroupId),
    sourceDateISO: isDateISO(String(raw.sourceDateISO ?? "").trim()) ? String(raw.sourceDateISO).trim() : undefined,
    sourceSession: raw.sourceSession ? normalizeSession(raw.sourceSession) : undefined,
    originalSnapshot: normalizeSnapshot(raw.originalSnapshot),
    sourceRowCount: Number.isFinite(Number(raw.sourceRowCount)) ? Math.max(0, Math.round(Number(raw.sourceRowCount))) : undefined,
    conflictReason: String(raw.conflictReason ?? "").trim() || undefined,
  };
}

function normalizeCells(raw: unknown): Record<string, WorkoutPlanBuilderCell> {
  const out: Record<string, WorkoutPlanBuilderCell> = {};
  if (!raw || typeof raw !== "object") return out;
  Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
    const cell = normalizeCell(value);
    if (!cell) return;
    out[String(key ?? "").trim()] = cell;
  });
  return out;
}

function normalizeDraft(raw: any): WorkoutPlanBuilderDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const athleteId = String(raw.athleteId ?? "").trim();
  const firstWeekStartISO = String(raw.firstWeekStartISO ?? "").trim();
  if (!athleteId || !isDateISO(firstWeekStartISO)) return null;
  const numberOfWeeks = Math.min(52, Math.max(1, Math.round(Number(raw.numberOfWeeks) || 6)));
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id: String(raw.id ?? "").trim() || createDraftId(),
    athleteId,
    seasonId: String(raw.seasonId ?? "").trim() || null,
    rangeMode: raw.rangeMode === "season" || raw.rangeMode === "custom" ? raw.rangeMode : "custom",
    firstWeekStartISO,
    numberOfWeeks,
    cellsByKey: normalizeCells(raw.cellsByKey),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

export async function loadWorkoutPlanBuilderDrafts(): Promise<WorkoutPlanBuilderDraft[]> {
  const raw = await loadJSON<any[]>(WORKOUT_PLAN_BUILDER_DRAFTS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeDraft(item))
    .filter((item): item is WorkoutPlanBuilderDraft => !!item)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveWorkoutPlanBuilderDrafts(list: WorkoutPlanBuilderDraft[]) {
  const normalized = (Array.isArray(list) ? list : [])
    .map((item) => normalizeDraft(item))
    .filter((item): item is WorkoutPlanBuilderDraft => !!item);
  await saveJSON(WORKOUT_PLAN_BUILDER_DRAFTS_KEY, normalized);
}

export async function upsertWorkoutPlanBuilderDraft(
  draft: Omit<WorkoutPlanBuilderDraft, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
    createdAt?: number;
    updatedAt?: number;
  }
): Promise<WorkoutPlanBuilderDraft> {
  const existing = await loadWorkoutPlanBuilderDrafts();
  const now = Date.now();
  const id = String(draft.id ?? "").trim() || createDraftId();
  const previous = existing.find((item) => item.id === id);
  const nextItem: WorkoutPlanBuilderDraft = {
    id,
    athleteId: String(draft.athleteId ?? "").trim(),
    seasonId: String(draft.seasonId ?? "").trim() || null,
    rangeMode: draft.rangeMode === "season" || draft.rangeMode === "custom" ? draft.rangeMode : "custom",
    firstWeekStartISO: String(draft.firstWeekStartISO ?? "").trim(),
    numberOfWeeks: Math.min(52, Math.max(1, Math.round(Number(draft.numberOfWeeks) || 6))),
    cellsByKey: normalizeCells(draft.cellsByKey),
    createdAt: previous?.createdAt ?? (Number.isFinite(Number(draft.createdAt)) ? Number(draft.createdAt) : now),
    updatedAt: now,
  };
  const normalized = normalizeDraft(nextItem);
  if (!normalized) throw new Error("Invalid workout plan builder draft.");
  const next = previous
    ? existing.map((item) => (item.id === normalized.id ? normalized : item))
    : [normalized, ...existing];
  await saveWorkoutPlanBuilderDrafts(next);
  return normalized;
}

export async function deleteWorkoutPlanBuilderDraft(id: string) {
  const cleanId = String(id ?? "").trim();
  if (!cleanId) return;
  const existing = await loadWorkoutPlanBuilderDrafts();
  await saveWorkoutPlanBuilderDrafts(existing.filter((item) => item.id !== cleanId));
}
