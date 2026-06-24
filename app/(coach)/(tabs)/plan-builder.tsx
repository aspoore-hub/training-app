import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { WeekStartDay } from "../../../lib/types";
import { useGridEngine } from "../../../components/grid/useGridEngine";
import { parseTsv } from "../../../lib/grid/tsv";
import { loadAuxiliaryRoutines, type AuxiliaryRoutine } from "../../../lib/auxiliaryRoutines";
import { getWeekStartISO, parseISODate, toISODate } from "../../../lib/mileagePlan";
import { getCachedCoachCategories, loadCoachCategoriesFromTeamKV, loadWeekStartSetting } from "../../../lib/settings";
import {
  listTeamWorkoutBatchHeadersInRange,
  saveTeamWorkoutBatchHeaderNotes,
  type TeamWorkoutBatchHeaderRow,
} from "../../../lib/teamWorkoutBatchHeadersCloud";
import {
  buildTeamWorkoutInsertRows,
  createTeamWorkoutBatch,
  listAthleteWorkoutsInRange,
  listTeamWorkoutsByBatch,
  updateTeamWorkoutById,
  type TeamWorkoutRow,
} from "../../../lib/teamWorkoutsCloud";
import { resolveAthleteSeasonWindowWithTenure } from "../../../lib/teamRoster";
import { teamDataStore } from "../../../lib/teamDataStore";
import { getAthleteDisplayName, getAthleteFirstName, getAthleteLastName } from "../../../lib/athleteName";
import type { WorkoutCategory } from "../../../lib/types";
import {
  loadWorkoutPlanBuilderDrafts,
  upsertWorkoutPlanBuilderDraft,
  workoutPlanBuilderCellKey,
  type WorkoutPlanBuilderCell,
  type WorkoutPlanBuilderDraft,
} from "../../../lib/workoutPlanBuilderDrafts";
import { canApplyPlanBuilder, getCurrentTeamRole, type TeamRole } from "../../../lib/teamPermissions";

const MAX_PLAN_BUILDER_WEEKS = 52;
const DEFAULT_PLAN_BUILDER_WEEKS = 6;
const PLAN_BUILDER_GRID_ID = "workout-plan-builder-grid";
const DEBUG_PLAN_BUILDER_PASTE = false;

type PlanBuilderColKey = "AM" | "PM";

type PlanBuilderSnapshot = NonNullable<WorkoutPlanBuilderCell["originalSnapshot"]>;

type ExistingPlanCell = {
  dateISO: string;
  session: "AM" | "PM";
  rows: TeamWorkoutRow[];
  source?: {
    row: TeamWorkoutRow;
    snapshot: PlanBuilderSnapshot;
  };
  conflictReason?: string;
};

type PlanBuilderCellState =
  | "blank"
  | "existing"
  | "new"
  | "changed"
  | "cleared"
  | "conflict";

type PlanBuilderEditingField = "title" | "details";
type PlanBuilderRangeMode = "season" | "custom";

type ApplyPreviewScope = "entire" | "range";

type ApplyPreviewStatus = "new" | "update" | "unchanged" | "conflict" | "cleared";
type ApplyPreviewFilter = "all" | "new" | "update" | "conflict" | "skipped";

type ApplyPreviewRow = {
  id: string;
  dateISO: string;
  dayLabel: string;
  session: "AM" | "PM";
  draftTitle: string;
  existingTitle: string;
  status: ApplyPreviewStatus;
  reason: string;
};

type ApplySummary = {
  title: string;
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  errors: string[];
};

type CreateSafeNewRowsResult = {
  createdKeys: string[];
  headerNoteFailureCount: number;
};

type UpdateSafeExistingRowsResult = {
  updatedKeys: string[];
  sharedSkipped: number;
  staleSkipped: number;
  unsafeSkipped: number;
  headerNoteFailureCount: number;
};

function addDaysISO(dateISO: string, days: number): string {
  const base = parseISODate(dateISO);
  if (Number.isNaN(base.getTime())) return dateISO;
  base.setDate(base.getDate() + days);
  return toISODate(base);
}

function isDateISO(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTextEditingTarget(target: unknown): boolean {
  if (Platform.OS !== "web") return false;
  const node = target as any;
  if (!node) return false;
  const tag = String(node.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || !!node.isContentEditable;
}

function stopTextFieldClipboardPropagation(event: any) {
  event?.stopPropagation?.();
}

function debugPlanBuilderPaste(...args: unknown[]) {
  if (DEBUG_PLAN_BUILDER_PASTE) console.log("[plan-builder-paste]", ...args);
}

function formatDateShort(dateISO: string): string {
  const dt = parseISODate(dateISO);
  if (Number.isNaN(dt.getTime())) return dateISO;
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDayShort(dateISO: string): string {
  const dt = parseISODate(dateISO);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, { weekday: "short" });
}

function makeDraftId(athleteId: string) {
  return `wpb_${String(athleteId ?? "").trim()}_${Date.now()}`;
}

function createBatchId(dateISO: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bat_${dateISO}_${suffix}`;
}

function normalizeWeekCount(value: unknown): number {
  return Math.min(MAX_PLAN_BUILDER_WEEKS, Math.max(1, Math.round(Number(value) || DEFAULT_PLAN_BUILDER_WEEKS)));
}

function isRosterRowActive(row: { roster_status?: string | null } | null | undefined): boolean {
  const status = String(row?.roster_status ?? "").trim().toLowerCase();
  if (!status) return true;
  return status === "active";
}

function rosterRowDisplayName(row: { display_name?: string | null; first_name?: string | null; last_name?: string | null; id?: string | null }) {
  return getAthleteDisplayName(row);
}

function rosterRowSortName(row: { display_name?: string | null; first_name?: string | null; last_name?: string | null; id?: string | null }) {
  const display = getAthleteDisplayName(row).toLowerCase();
  const first = getAthleteFirstName(row).toLowerCase();
  const last = getAthleteLastName(row).toLowerCase();
  return `${last}|${first}|${display}`;
}

function normalizePlanBuilderSession(value: string): "AM" | "PM" {
  return String(value ?? "").trim().toUpperCase() === "AM" ? "AM" : "PM";
}

function normalizeStringList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from(new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function normalizeSession(value: unknown): "AM" | "PM" {
  return String(value ?? "").trim().toUpperCase() === "AM" ? "AM" : "PM";
}

function cellKey(dateISO: string, session: "AM" | "PM") {
  return `${String(dateISO ?? "").trim()}__${session}`;
}

function editingFieldKey(athleteId: string, dateISO: string, session: "AM" | "PM", field: PlanBuilderEditingField) {
  return `${workoutPlanBuilderCellKey(athleteId, dateISO, session)}__${field}`;
}

function parseEditingFieldKey(key: string): {
  athleteId: string;
  dateISO: string;
  session: "AM" | "PM";
  field: PlanBuilderEditingField;
} | null {
  const parts = String(key ?? "").split("__");
  if (parts.length !== 4) return null;
  const [athleteId, dateISO, sessionRaw, fieldRaw] = parts;
  if (!athleteId || !isDateISO(dateISO)) return null;
  const field = fieldRaw === "title" || fieldRaw === "details" ? fieldRaw : null;
  if (!field) return null;
  return {
    athleteId,
    dateISO,
    session: normalizePlanBuilderSession(sessionRaw),
    field,
  };
}

function headerNotesExactKey(dateISO: string, batchId: string, session: string) {
  return `${String(dateISO ?? "").trim()}::${String(batchId ?? "").trim()}::${normalizeSession(session)}`;
}

function headerNotesBaseKey(dateISO: string, batchId: string) {
  return `${String(dateISO ?? "").trim()}::${String(batchId ?? "").trim()}`;
}

function cleanNotes(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.toLowerCase() === "no notes" ? "" : text;
}

function normalizePrimaryAndCategories(rawCategories: unknown, primary: unknown): string[] {
  const categories = normalizeStringList(rawCategories);
  const primaryText = String(primary ?? "").trim();
  return normalizeStringList(categories.length ? categories : primaryText ? [primaryText] : []);
}

function snapshotsEqual(a: PlanBuilderSnapshot | null | undefined, b: PlanBuilderSnapshot | null | undefined): boolean {
  const left = a ?? { title: "", details: "" };
  const right = b ?? { title: "", details: "" };
  return (
    String(left.title ?? "").trim() === String(right.title ?? "").trim() &&
    String(left.details ?? "").trim() === String(right.details ?? "").trim() &&
    String(left.timeText ?? "").trim() === String(right.timeText ?? "").trim() &&
    String(left.location ?? "").trim() === String(right.location ?? "").trim() &&
    normalizeStringList(left.categoryIds).join("\u0001") === normalizeStringList(right.categoryIds).join("\u0001") &&
    normalizeStringList(left.preRoutineIds).join("\u0001") === normalizeStringList(right.preRoutineIds).join("\u0001") &&
    normalizeStringList(left.postRoutineIds).join("\u0001") === normalizeStringList(right.postRoutineIds).join("\u0001")
  );
}

function snapshotFromDraftCell(cell: WorkoutPlanBuilderCell | null | undefined): PlanBuilderSnapshot {
  return {
    title: String(cell?.title ?? "").trim(),
    details: String(cell?.details ?? "").trim(),
    timeText: String(cell?.timeText ?? "").trim() || undefined,
    location: String(cell?.location ?? "").trim() || undefined,
    categoryIds: normalizeStringList(cell?.categoryIds),
    preRoutineIds: normalizeStringList(cell?.preRoutineIds),
    postRoutineIds: normalizeStringList(cell?.postRoutineIds),
  };
}

function getDraftCell(
  draft: WorkoutPlanBuilderDraft | null,
  athleteId: string,
  dateISO: string,
  session: "AM" | "PM"
): WorkoutPlanBuilderCell | null {
  if (!draft || !athleteId) return null;
  const key = workoutPlanBuilderCellKey(athleteId, dateISO, session);
  return draft.cellsByKey[key] ?? null;
}

function cellToCombinedText(cell: WorkoutPlanBuilderCell | null | undefined): string {
  const title = String(cell?.title ?? "").trim();
  const details = String(cell?.details ?? "").trim();
  return [title, details].filter(Boolean).join("\n");
}

function combinedTextToTitleDetails(value: string): { title: string; details: string } {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const title = String(lines.shift() ?? "").trim();
  const details = lines.join("\n").trim();
  return { title, details };
}

function hasDraftCellContent(cell: WorkoutPlanBuilderCell): boolean {
  return !!(
    String(cell.title ?? "").trim() ||
    String(cell.details ?? "").trim() ||
    String(cell.timeText ?? "").trim() ||
    String(cell.location ?? "").trim() ||
    normalizeStringList(cell.categoryIds).length ||
    normalizeStringList(cell.preRoutineIds).length ||
    normalizeStringList(cell.postRoutineIds).length
  );
}

function categoryDisplayName(category: WorkoutCategory): string {
  return String(category?.name ?? "").trim() || String(category?.id ?? "").trim();
}

function sourceFieldsForExisting(existing: ExistingPlanCell | null | undefined): Partial<WorkoutPlanBuilderCell> {
  if (!existing?.source) return {};
  const row = existing.source.row;
  return {
    sourceType: "existing",
    sourceWorkoutId: String(row.id ?? "").trim() || undefined,
    sourceBatchId: String(row.batch_id ?? "").trim() || null,
    sourceGroupId: String(row.group_id ?? "").trim() || null,
    sourceDateISO: String(row.date_iso ?? "").trim() || undefined,
    sourceSession: normalizeSession(row.session),
    originalSnapshot: existing.source.snapshot,
    sourceRowCount: existing.rows.length,
  };
}

function resolveCellState(args: {
  draftCell: WorkoutPlanBuilderCell | null;
  existingCell: ExistingPlanCell | null;
}): PlanBuilderCellState {
  const { draftCell, existingCell } = args;
  if (existingCell?.conflictReason) return "conflict";
  if (!draftCell && existingCell?.source) return "existing";
  if (!draftCell) return "blank";
  if (draftCell.sourceType === "existing" || draftCell.originalSnapshot) {
    const current = snapshotFromDraftCell(draftCell);
    if (!hasDraftCellContent(draftCell)) return "cleared";
    return snapshotsEqual(current, draftCell.originalSnapshot) ? "existing" : "changed";
  }
  return hasDraftCellContent(draftCell) ? "new" : "blank";
}

function cellStatusLabel(state: PlanBuilderCellState) {
  if (state === "existing") return "Existing";
  if (state === "new") return "New draft";
  if (state === "changed") return "Changed";
  if (state === "cleared") return "Cleared draft";
  if (state === "conflict") return "Multiple workouts";
  return "";
}

function previewStatusLabel(status: ApplyPreviewStatus) {
  if (status === "new") return "New";
  if (status === "update") return "Update";
  if (status === "unchanged") return "Unchanged";
  if (status === "conflict") return "Conflict";
  return "Cleared";
}

function previewFilterLabel(filter: ApplyPreviewFilter) {
  if (filter === "all") return "All";
  if (filter === "new") return "New";
  if (filter === "update") return "Updates";
  if (filter === "conflict") return "Conflicts";
  return "Skipped";
}

function rowMatchesApplyPreviewFilter(row: ApplyPreviewRow, filter: ApplyPreviewFilter) {
  if (filter === "all") return true;
  if (filter === "new") return row.status === "new";
  if (filter === "update") return row.status === "update";
  if (filter === "conflict") return row.status === "conflict";
  return row.status === "cleared" || row.status === "unchanged";
}

function compareDateISO(a: string, b: string) {
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function isCellInsideRange(cell: WorkoutPlanBuilderCell, startISO: string, endISO: string) {
  const dateISO = String(cell.dateISO ?? "").trim();
  return isDateISO(dateISO) && dateISO >= startISO && dateISO <= endISO;
}

function createEmptyDraft(args: {
  athleteId: string;
  seasonId?: string | null;
  rangeMode?: PlanBuilderRangeMode;
  firstWeekStartISO: string;
  numberOfWeeks?: number;
}): WorkoutPlanBuilderDraft {
  const now = Date.now();
  return {
    id: makeDraftId(args.athleteId),
    athleteId: args.athleteId,
    seasonId: args.seasonId ?? null,
    rangeMode: args.rangeMode ?? (args.seasonId ? "season" : "custom"),
    firstWeekStartISO: args.firstWeekStartISO,
    numberOfWeeks: normalizeWeekCount(args.numberOfWeeks),
    cellsByKey: {},
    createdAt: now,
    updatedAt: now,
  };
}

function getDraftCellValue(
  draft: WorkoutPlanBuilderDraft | null,
  athleteId: string,
  dateISO: string,
  colKey: string
): string {
  if (!draft || !athleteId) return "";
  const session = normalizePlanBuilderSession(colKey);
  const key = workoutPlanBuilderCellKey(athleteId, dateISO, session);
  return cellToCombinedText(draft.cellsByKey[key]);
}

function setDraftCellValue(
  draft: WorkoutPlanBuilderDraft,
  athleteId: string,
  dateISO: string,
  colKey: string,
  value: string
): WorkoutPlanBuilderDraft {
  const session = normalizePlanBuilderSession(colKey);
  const key = workoutPlanBuilderCellKey(athleteId, dateISO, session);
  const previous = draft.cellsByKey[key];
  const parsed = combinedTextToTitleDetails(value);
  const nextCell: WorkoutPlanBuilderCell = {
    dateISO,
    session,
    title: parsed.title,
    details: parsed.details,
    timeText: previous?.timeText,
    location: previous?.location,
    categoryIds: normalizeStringList(previous?.categoryIds),
    preRoutineIds: normalizeStringList(previous?.preRoutineIds),
    postRoutineIds: normalizeStringList(previous?.postRoutineIds),
    sourceType: previous?.sourceType,
    sourceWorkoutId: previous?.sourceWorkoutId,
    sourceBatchId: previous?.sourceBatchId,
    sourceGroupId: previous?.sourceGroupId,
    sourceDateISO: previous?.sourceDateISO,
    sourceSession: previous?.sourceSession,
    originalSnapshot: previous?.originalSnapshot,
    sourceRowCount: previous?.sourceRowCount,
    conflictReason: previous?.conflictReason,
  };
  const keepExistingSource = previous?.sourceType === "existing" || !!previous?.originalSnapshot;
  const nextCells = { ...draft.cellsByKey };
  if (hasDraftCellContent(nextCell) || keepExistingSource) nextCells[key] = nextCell;
  else delete nextCells[key];
  return {
    ...draft,
    cellsByKey: nextCells,
    updatedAt: Date.now(),
  };
}

function patchDraftCell(
  draft: WorkoutPlanBuilderDraft,
  athleteId: string,
  dateISO: string,
  sessionInput: string,
  patch: Partial<WorkoutPlanBuilderCell>
): WorkoutPlanBuilderDraft {
  const session = normalizePlanBuilderSession(sessionInput);
  const key = workoutPlanBuilderCellKey(athleteId, dateISO, session);
  const previous = draft.cellsByKey[key];
  const nextCell: WorkoutPlanBuilderCell = {
    dateISO,
    session,
    title: String(patch.title ?? previous?.title ?? "").trim(),
    details: String(patch.details ?? previous?.details ?? "").trim(),
    timeText: String(patch.timeText ?? previous?.timeText ?? "").trim() || undefined,
    location: String(patch.location ?? previous?.location ?? "").trim() || undefined,
    categoryIds: patch.categoryIds != null ? normalizeStringList(patch.categoryIds) : normalizeStringList(previous?.categoryIds),
    preRoutineIds: patch.preRoutineIds != null ? normalizeStringList(patch.preRoutineIds) : normalizeStringList(previous?.preRoutineIds),
    postRoutineIds: patch.postRoutineIds != null ? normalizeStringList(patch.postRoutineIds) : normalizeStringList(previous?.postRoutineIds),
    sourceType: patch.sourceType ?? previous?.sourceType,
    sourceWorkoutId: patch.sourceWorkoutId ?? previous?.sourceWorkoutId,
    sourceBatchId: patch.sourceBatchId !== undefined ? patch.sourceBatchId : previous?.sourceBatchId,
    sourceGroupId: patch.sourceGroupId !== undefined ? patch.sourceGroupId : previous?.sourceGroupId,
    sourceDateISO: patch.sourceDateISO ?? previous?.sourceDateISO,
    sourceSession: patch.sourceSession ?? previous?.sourceSession,
    originalSnapshot: patch.originalSnapshot ?? previous?.originalSnapshot,
    sourceRowCount: patch.sourceRowCount ?? previous?.sourceRowCount,
    conflictReason: patch.conflictReason ?? previous?.conflictReason,
  };
  const keepExistingSource = nextCell.sourceType === "existing" || !!nextCell.originalSnapshot;
  const nextCells = { ...draft.cellsByKey };
  if (hasDraftCellContent(nextCell) || keepExistingSource) nextCells[key] = nextCell;
  else delete nextCells[key];
  return {
    ...draft,
    cellsByKey: nextCells,
    updatedAt: Date.now(),
  };
}

function setDraftCellCombinedValue(
  draft: WorkoutPlanBuilderDraft,
  athleteId: string,
  dateISO: string,
  sessionInput: string,
  value: string,
  existing: ExistingPlanCell | null
): WorkoutPlanBuilderDraft {
  const session = normalizePlanBuilderSession(sessionInput);
  const previous = getDraftCell(draft, athleteId, dateISO, session);
  const parsed = combinedTextToTitleDetails(value);
  if (!previous && existing?.source) {
    return patchDraftCell(draft, athleteId, dateISO, session, {
      title: parsed.title,
      details: parsed.details,
      timeText: existing.source.snapshot.timeText,
      location: existing.source.snapshot.location,
      categoryIds: existing.source.snapshot.categoryIds,
      preRoutineIds: existing.source.snapshot.preRoutineIds,
      postRoutineIds: existing.source.snapshot.postRoutineIds,
      ...sourceFieldsForExisting(existing),
    });
  }
  return setDraftCellValue(draft, athleteId, dateISO, session, value);
}

export default function WorkoutPlanBuilderDraftScreen() {
  const router = useRouter();
  const store = teamDataStore.use();
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [drafts, setDrafts] = useState<WorkoutPlanBuilderDraft[]>([]);
  const [activeDraft, setActiveDraft] = useState<WorkoutPlanBuilderDraft | null>(null);
  const [existingCellsByKey, setExistingCellsByKey] = useState<Record<string, ExistingPlanCell>>({});
  const [existingWorkoutsLoading, setExistingWorkoutsLoading] = useState(false);
  const [existingWorkoutsError, setExistingWorkoutsError] = useState<string | null>(null);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [auxiliaryRoutines, setAuxiliaryRoutines] = useState<AuxiliaryRoutine[]>([]);
  const [selectedAthleteId, setSelectedAthleteId] = useState("");
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [firstWeekInput, setFirstWeekInput] = useState(() => getWeekStartISO(toISODate(new Date()), 1));
  const [weekCountInput, setWeekCountInput] = useState(String(DEFAULT_PLAN_BUILDER_WEEKS));
  const [athletePickerOpen, setAthletePickerOpen] = useState(false);
  const [seasonPickerOpen, setSeasonPickerOpen] = useState(false);
  const [firstWeekPickerOpen, setFirstWeekPickerOpen] = useState(false);
  const [firstWeekPickerDraftDate, setFirstWeekPickerDraftDate] = useState("");
  const [firstWeekPickerError, setFirstWeekPickerError] = useState<string | null>(null);
  const [metadataEditorDateISO, setMetadataEditorDateISO] = useState<string | null>(null);
  const [applyPreviewOpen, setApplyPreviewOpen] = useState(false);
  const [applyPreviewScope, setApplyPreviewScope] = useState<ApplyPreviewScope>("entire");
  const [applyPreviewStartISO, setApplyPreviewStartISO] = useState("");
  const [applyPreviewEndISO, setApplyPreviewEndISO] = useState("");
  const [applyPreviewRows, setApplyPreviewRows] = useState<ApplyPreviewRow[]>([]);
  const [applyPreviewFilter, setApplyPreviewFilter] = useState<ApplyPreviewFilter>("all");
  const [lastApplySummary, setLastApplySummary] = useState<ApplySummary | null>(null);
  const [applyPreviewLoading, setApplyPreviewLoading] = useState(false);
  const [applyNewLoading, setApplyNewLoading] = useState(false);
  const [applyUpdateLoading, setApplyUpdateLoading] = useState(false);
  const [applySafeLoading, setApplySafeLoading] = useState(false);
  const [applyPreviewError, setApplyPreviewError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [editingFieldsByKey, setEditingFieldsByKey] = useState<Record<string, string>>({});
  const [activeGridId, setActiveGridId] = useState<string | null>(null);
  const [focusedEditorKey, setFocusedEditorKey] = useState<string | null>(null);
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);
  const readOnlyPlanBuilder = !canApplyPlanBuilder(currentTeamRole);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveGenerationRef = useRef(0);
  const saveQueueRef = useRef<Promise<WorkoutPlanBuilderDraft | null>>(Promise.resolve(null));
  const activeDraftRef = useRef<WorkoutPlanBuilderDraft | null>(null);
  const editingFieldsRef = useRef<Record<string, string>>({});
  const focusedEditorKeyRef = useRef<string | null>(null);
  const existingCellsRef = useRef<Record<string, ExistingPlanCell>>({});
  const selectedAthleteIdRef = useRef("");
  const commitEditingFieldsRef = useRef<((keys?: string[]) => Promise<WorkoutPlanBuilderDraft | null>) | null>(null);
  const existingLoadSeqRef = useRef(0);
  const planBuilderClipboardRef = useRef("");
  const pendingPasteDebugRef = useRef<{
    rowCount: number;
    colCount: number;
    parsedTargetCount: number;
    firstTarget: { dateISO: string; session: "AM" | "PM" } | null;
    lastTarget: { dateISO: string; session: "AM" | "PM" } | null;
  } | null>(null);

  const roster = useMemo(
    () =>
      (Array.isArray(store.roster) ? store.roster : [])
        .filter((athlete) => isRosterRowActive(athlete))
        .sort((a, b) => rosterRowSortName(a).localeCompare(rosterRowSortName(b))),
    [store.roster]
  );

  const seasons = useMemo(
    () => (Array.isArray(store.teamSeasons) ? store.teamSeasons : []).filter((season) => !season?.archived_at),
    [store.teamSeasons]
  );

  useEffect(() => {
    let active = true;
    getCurrentTeamRole()
      .then((role) => {
        if (active) setCurrentTeamRole(role);
      })
      .catch((error) => {
        console.warn("[plan-builder] role load failed", error);
        if (active) setCurrentTeamRole(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedAthlete = useMemo(
    () => roster.find((athlete) => String(athlete.id ?? "").trim() === selectedAthleteId) ?? null,
    [roster, selectedAthleteId]
  );

  const selectedSeason = useMemo(
    () => seasons.find((season) => String(season?.id ?? "").trim() === String(selectedSeasonId ?? "").trim()) ?? null,
    [seasons, selectedSeasonId]
  );

  const categoryById = useMemo(() => {
    const map = new Map<string, WorkoutCategory>();
    categories.forEach((category) => {
      const id = String(category?.id ?? "").trim();
      if (id) map.set(id, category);
    });
    return map;
  }, [categories]);

  const categoryIdByName = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach((category) => {
      const id = String(category?.id ?? "").trim();
      const name = String(category?.name ?? "").trim().toLowerCase();
      if (id && name) map.set(name, id);
    });
    return map;
  }, [categories]);

  const routineById = useMemo(() => {
    const map = new Map<string, AuxiliaryRoutine>();
    auxiliaryRoutines.forEach((routine) => {
      const id = String(routine?.id ?? "").trim();
      if (id) map.set(id, routine);
    });
    return map;
  }, [auxiliaryRoutines]);

  const refreshPlanBuilderCategories = useCallback(async () => {
    const cached = getCachedCoachCategories();
    if (Array.isArray(cached) && cached.length > 0) {
      setCategories(cached);
    }

    try {
      await teamDataStore.actions.ensureSessionAndTeam().catch(() => {});
      const loaded = await loadCoachCategoriesFromTeamKV();
      setCategories(Array.isArray(loaded) ? loaded : []);
    } catch (error) {
      console.warn("[plan-builder] failed to refresh workout categories", error);
    }
  }, []);

  const firstWeekStartISO = useMemo(
    () => (isDateISO(firstWeekInput) ? getWeekStartISO(firstWeekInput, weekStartsOn) : getWeekStartISO(toISODate(new Date()), weekStartsOn)),
    [firstWeekInput, weekStartsOn]
  );

  const weekCount = useMemo(() => normalizeWeekCount(weekCountInput), [weekCountInput]);

  const weekStarts = useMemo(
    () => Array.from({ length: weekCount }, (_, idx) => addDaysISO(firstWeekStartISO, idx * 7)),
    [firstWeekStartISO, weekCount]
  );

  const dateRows = useMemo(
    () => Array.from({ length: weekCount * 7 }, (_, idx) => addDaysISO(firstWeekStartISO, idx)),
    [firstWeekStartISO, weekCount]
  );

  const colKeys = useMemo<PlanBuilderColKey[]>(() => ["AM", "PM"], []);

  const saveDraftNow = useCallback(async (draft: WorkoutPlanBuilderDraft) => {
    const generation = saveGenerationRef.current + 1;
    saveGenerationRef.current = generation;
    setSaveState("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const saveTask = saveQueueRef.current
      .catch(() => null)
      .then(async () => {
        debugPlanBuilderPaste("save start", {
          generation,
          draftId: draft.id,
          cellCount: Object.keys(draft.cellsByKey ?? {}).length,
        });
        return upsertWorkoutPlanBuilderDraft(draft);
      });
    saveQueueRef.current = saveTask
      .then((saved) => saved)
      .catch(() => null);

    try {
      const saved = await saveTask;
      if (saveGenerationRef.current !== generation) {
        debugPlanBuilderPaste("stale save completed after newer save", {
          generation,
          latestGeneration: saveGenerationRef.current,
          draftId: draft.id,
        });
        return activeDraftRef.current;
      }
      setDrafts((prev) => {
        const exists = prev.some((item) => item.id === saved.id);
        return exists ? prev.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...prev];
      });
      setActiveDraft((prev) => (prev?.id === saved.id ? saved : prev));
      activeDraftRef.current = saved;
      setSaveState("saved");
      setTimeout(() => setSaveState((prev) => (prev === "saved" ? "idle" : prev)), 1800);
      return saved;
    } catch {
      if (saveGenerationRef.current !== generation) return activeDraftRef.current;
      setSaveState("error");
      return null;
    }
  }, []);

  const scheduleSave = useCallback((draft: WorkoutPlanBuilderDraft) => {
    activeDraftRef.current = draft;
    setSaveState("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const current = activeDraftRef.current;
      if (!current) return;
      await saveDraftNow(current);
    }, 450);
  }, [saveDraftNow]);

  const patchActiveDraft = useCallback(
    (patch: Partial<WorkoutPlanBuilderDraft>) => {
      if (!selectedAthleteId) return;
      setActiveDraft((prev) => {
        const base =
          prev ??
          createEmptyDraft({
            athleteId: selectedAthleteId,
            seasonId: selectedSeasonId,
            rangeMode: selectedSeasonId ? "season" : "custom",
            firstWeekStartISO,
            numberOfWeeks: weekCount,
          });
        const next: WorkoutPlanBuilderDraft = {
          ...base,
          ...patch,
          athleteId: selectedAthleteId,
          updatedAt: Date.now(),
        };
        activeDraftRef.current = next;
        scheduleSave(next);
        return next;
      });
    },
    [firstWeekStartISO, scheduleSave, selectedAthleteId, selectedSeasonId, weekCount]
  );

  const getResolvedSeasonWeekRange = useCallback(
    (athlete: typeof selectedAthlete, season: typeof selectedSeason) => {
      if (!athlete || !season) return null;
      const resolved = resolveAthleteSeasonWindowWithTenure(athlete, season, null);
      const start = String(resolved.start_date ?? season.start_date ?? "").trim();
      const end = String(resolved.end_date ?? season.end_date ?? "").trim();
      if (!isDateISO(start) || !isDateISO(end) || end < start) return null;
      const first = getWeekStartISO(start, weekStartsOn);
      const last = getWeekStartISO(end, weekStartsOn);
      const weeks = Math.min(
        MAX_PLAN_BUILDER_WEEKS,
        Math.max(1, Math.floor((parseISODate(last).getTime() - parseISODate(first).getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1)
      );
      return { firstWeekStartISO: first, numberOfWeeks: weeks };
    },
    [weekStartsOn]
  );

  useEffect(() => {
    activeDraftRef.current = activeDraft;
  }, [activeDraft]);

  useEffect(() => {
    existingCellsRef.current = existingCellsByKey;
  }, [existingCellsByKey]);

  useEffect(() => {
    selectedAthleteIdRef.current = selectedAthleteId;
  }, [selectedAthleteId]);

  useEffect(() => {
    focusedEditorKeyRef.current = focusedEditorKey;
  }, [focusedEditorKey]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshPlanBuilderCategories();
    }, [refreshPlanBuilderCategories])
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const win = (globalThis as any)?.window;
    const doc = (globalThis as any)?.document;
    if (!win) return;

    const refreshIfVisible = () => {
      if (doc?.hidden) return;
      void refreshPlanBuilderCategories();
    };

    win.addEventListener?.("focus", refreshIfVisible);
    doc?.addEventListener?.("visibilitychange", refreshIfVisible);
    return () => {
      win.removeEventListener?.("focus", refreshIfVisible);
      doc?.removeEventListener?.("visibilitychange", refreshIfVisible);
    };
  }, [refreshPlanBuilderCategories]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const weekStartResult = await loadWeekStartSetting().catch(() => ({ normalized: "monday" as const }));
      if (cancelled) return;
      const resolved: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      setWeekStartsOn(resolved);
      setFirstWeekInput((prev) => getWeekStartISO(prev, resolved));
    })();
    void teamDataStore.actions.ensureSessionAndTeam().catch(() => {});
    void teamDataStore.actions.refreshRoster({ force: false }).catch(() => {});
    void teamDataStore.actions.loadTeamSeasons(false).catch(() => {});
    void teamDataStore.actions.loadSharedCoachFilters(false).catch(() => {});
    void refreshPlanBuilderCategories();
    void loadAuxiliaryRoutines()
      .then((routines) => setAuxiliaryRoutines(Array.isArray(routines) ? routines : []))
      .catch(() => setAuxiliaryRoutines([]));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await loadWorkoutPlanBuilderDrafts().catch(() => []);
      if (cancelled) return;
      setDrafts(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedAthleteId || roster.length === 0) return;
    setSelectedAthleteId(String(roster[0]?.id ?? "").trim());
  }, [roster, selectedAthleteId]);

  useEffect(() => {
    if (selectedSeasonId !== null) return;
    const shared = String(store.sharedSelectedSeasonId ?? "").trim();
    if (shared) setSelectedSeasonId(shared);
    else if (seasons[0]?.id) setSelectedSeasonId(String(seasons[0].id));
  }, [seasons, selectedSeasonId, store.sharedSelectedSeasonId]);

  useEffect(() => {
    if (!selectedAthleteId) {
      setActiveDraft(null);
      return;
    }
    const existing = drafts.find((draft) => draft.athleteId === selectedAthleteId) ?? null;
    const current = activeDraftRef.current;
    const currentIsNewerForAthlete =
      current?.athleteId === selectedAthleteId &&
      (!existing || Number(current.updatedAt ?? 0) >= Number(existing.updatedAt ?? 0));
    if (currentIsNewerForAthlete) {
      setActiveDraft(current);
      setSelectedSeasonId(current.seasonId ?? null);
      setFirstWeekInput(current.firstWeekStartISO);
      setWeekCountInput(String(current.numberOfWeeks));
      return;
    }
    const seasonRange = !existing ? getResolvedSeasonWeekRange(selectedAthlete, selectedSeason) : null;
    const fallback = createEmptyDraft({
      athleteId: selectedAthleteId,
      seasonId: selectedSeasonId,
      rangeMode: selectedSeasonId && seasonRange ? "season" : "custom",
      firstWeekStartISO: seasonRange?.firstWeekStartISO ?? firstWeekStartISO,
      numberOfWeeks: seasonRange?.numberOfWeeks ?? weekCount,
    });
    const next = existing
      ? existing.rangeMode === "season"
        ? {
            ...existing,
            ...(getResolvedSeasonWeekRange(selectedAthlete, selectedSeason) ?? {}),
          }
        : existing
      : fallback;
    setActiveDraft(next);
    activeDraftRef.current = next;
    setSelectedSeasonId(next.seasonId ?? null);
    setFirstWeekInput(next.firstWeekStartISO);
    setWeekCountInput(String(next.numberOfWeeks));
  }, [drafts, selectedAthleteId]);

  const applySeasonRange = useCallback(() => {
    if (!selectedAthlete || !selectedSeason) return;
    void commitEditingFieldsRef.current?.();
    const range = getResolvedSeasonWeekRange(selectedAthlete, selectedSeason);
    if (!range) return;
    setFirstWeekInput(range.firstWeekStartISO);
    setWeekCountInput(String(range.numberOfWeeks));
    patchActiveDraft({
      seasonId: selectedSeasonId,
      rangeMode: "season",
      firstWeekStartISO: range.firstWeekStartISO,
      numberOfWeeks: range.numberOfWeeks,
    });
  }, [getResolvedSeasonWeekRange, patchActiveDraft, selectedAthlete, selectedSeason, selectedSeasonId]);

  const buildExistingCellIndex = useCallback(
    (rows: TeamWorkoutRow[], headerRows: TeamWorkoutBatchHeaderRow[]): Record<string, ExistingPlanCell> => {
      const headerByExact = new Map<string, string>();
      const headerByBase = new Map<string, string>();
      const headerByBatch = new Map<string, string>();

      (Array.isArray(headerRows) ? headerRows : []).forEach((header) => {
        const batchId = String(header.batch_id ?? "").trim();
        const dateISO = String(header.date_iso ?? "").trim();
        if (!batchId || !dateISO) return;
        const notes = cleanNotes(header.header_notes);
        if (!notes) return;
        headerByExact.set(headerNotesExactKey(dateISO, batchId, header.session), notes);
        const baseKey = headerNotesBaseKey(dateISO, batchId);
        const prevBase = String(headerByBase.get(baseKey) ?? "").trim();
        if (!prevBase || notes.length > prevBase.length) headerByBase.set(baseKey, notes);
        const prevBatch = String(headerByBatch.get(batchId) ?? "").trim();
        if (!prevBatch || notes.length > prevBatch.length) headerByBatch.set(batchId, notes);
      });

      const grouped = new Map<string, TeamWorkoutRow[]>();
      (Array.isArray(rows) ? rows : []).forEach((row) => {
        const dateISO = String(row.date_iso ?? "").trim();
        if (!dateISO) return;
        const session = normalizeSession(row.session);
        const key = cellKey(dateISO, session);
        const list = grouped.get(key) ?? [];
        list.push(row);
        grouped.set(key, list);
      });

      const out: Record<string, ExistingPlanCell> = {};
      grouped.forEach((cellRows, key) => {
        const first = cellRows[0];
        const dateISO = String(first?.date_iso ?? "").trim();
        const session = normalizeSession(first?.session);
        if (!dateISO) return;

        if (cellRows.length !== 1) {
          out[key] = {
            dateISO,
            session,
            rows: cellRows,
            conflictReason: "Multiple workouts - edit in Daily Workouts.",
          };
          return;
        }

        const row = cellRows[0];
        const batchId = String(row.batch_id ?? "").trim();
        const exactNotes = batchId ? cleanNotes(headerByExact.get(headerNotesExactKey(dateISO, batchId, row.session))) : "";
        const baseNotes = batchId ? cleanNotes(headerByBase.get(headerNotesBaseKey(dateISO, batchId))) : "";
        const batchNotes = batchId ? cleanNotes(headerByBatch.get(batchId)) : "";
        const rowNotes = cleanNotes(row.details);
        const details = exactNotes || baseNotes || batchNotes || rowNotes;
        const rowCategoryNames = normalizePrimaryAndCategories(row.categories, row.primary_category);
        const categoryIds = rowCategoryNames.map((name) => categoryIdByName.get(name.toLowerCase()) ?? name);
        const snapshot: PlanBuilderSnapshot = {
          title: String(row.title ?? "").trim(),
          details,
          timeText: String(row.time_text ?? "").trim() || undefined,
          location: String(row.location ?? "").trim() || undefined,
          categoryIds,
          preRoutineIds: normalizeStringList(row.pre_routine_ids),
          postRoutineIds: normalizeStringList(row.post_routine_ids),
        };
        out[key] = {
          dateISO,
          session,
          rows: cellRows,
          source: { row, snapshot },
        };
      });
      return out;
    },
    [categoryIdByName]
  );

  useEffect(() => {
    const startISO = dateRows[0];
    const endISO = dateRows[dateRows.length - 1];
    const athleteId = String(selectedAthleteId ?? "").trim();
    const seq = existingLoadSeqRef.current + 1;
    existingLoadSeqRef.current = seq;
    if (!athleteId || !isDateISO(startISO) || !isDateISO(endISO)) {
      setExistingCellsByKey({});
      setExistingWorkoutsError(null);
      setExistingWorkoutsLoading(false);
      return;
    }

    let cancelled = false;
    setExistingWorkoutsLoading(true);
    setExistingWorkoutsError(null);
    (async () => {
      try {
        const [workoutRows, headerRows] = await Promise.all([
          listAthleteWorkoutsInRange(athleteId, startISO, endISO),
          listTeamWorkoutBatchHeadersInRange(startISO, endISO),
        ]);
        if (cancelled || existingLoadSeqRef.current !== seq) return;
        setExistingCellsByKey(buildExistingCellIndex(workoutRows, headerRows));
      } catch (error: any) {
        if (cancelled || existingLoadSeqRef.current !== seq) return;
        setExistingCellsByKey({});
        setExistingWorkoutsError(String(error?.message ?? "Could not load existing workouts."));
      } finally {
        if (!cancelled && existingLoadSeqRef.current === seq) setExistingWorkoutsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [buildExistingCellIndex, dateRows, selectedAthleteId]);

  const setEditingFieldValue = useCallback(
    (dateISO: string, session: "AM" | "PM", field: PlanBuilderEditingField, value: string) => {
      const athleteId = String(selectedAthleteIdRef.current ?? "").trim();
      if (!athleteId) return;
      const key = editingFieldKey(athleteId, dateISO, session, field);
      editingFieldsRef.current = {
        ...editingFieldsRef.current,
        [key]: value,
      };
      setEditingFieldsByKey(editingFieldsRef.current);
      setSaveState("dirty");
    },
    []
  );

  const commitEditingFields = useCallback(
    async (keys?: string[]) => {
      const pending = editingFieldsRef.current;
      const keysToCommit = (keys ?? Object.keys(pending)).filter((key) =>
        Object.prototype.hasOwnProperty.call(pending, key)
      );
      if (keysToCommit.length === 0) return activeDraftRef.current;

      const athleteId = String(selectedAthleteIdRef.current ?? "").trim();
      if (!athleteId) return activeDraftRef.current;

      const capturedValues = keysToCommit.reduce<Record<string, string>>((out, key) => {
        out[key] = pending[key];
        return out;
      }, {});
      let next =
        activeDraftRef.current ??
        createEmptyDraft({
          athleteId,
          seasonId: selectedSeasonId,
          rangeMode: selectedSeasonId ? "season" : "custom",
          firstWeekStartISO,
          numberOfWeeks: weekCount,
        });

      keysToCommit.forEach((key) => {
        const parsed = parseEditingFieldKey(key);
        if (!parsed || parsed.athleteId !== athleteId) return;
        const previous = getDraftCell(next, athleteId, parsed.dateISO, parsed.session);
        const existing = existingCellsRef.current[cellKey(parsed.dateISO, parsed.session)] ?? null;
        const patch: Partial<WorkoutPlanBuilderCell> = {
          [parsed.field]: capturedValues[key],
        };
        const nextPatch =
          !previous && existing?.source
            ? {
                timeText: existing.source.snapshot.timeText,
                location: existing.source.snapshot.location,
                categoryIds: existing.source.snapshot.categoryIds,
                preRoutineIds: existing.source.snapshot.preRoutineIds,
                postRoutineIds: existing.source.snapshot.postRoutineIds,
                ...sourceFieldsForExisting(existing),
                ...patch,
              }
            : !previous
              ? { sourceType: "manual" as const, ...patch }
              : patch;
        next = patchDraftCell(next, athleteId, parsed.dateISO, parsed.session, nextPatch);
      });

      setActiveDraft(next);
      activeDraftRef.current = next;
      const saved = await saveDraftNow(next);
      if (saved) {
        const latestBuffers = editingFieldsRef.current;
        const nextBuffers = { ...latestBuffers };
        let changed = false;
        keysToCommit.forEach((key) => {
          if (latestBuffers[key] === capturedValues[key]) {
            delete nextBuffers[key];
            changed = true;
          }
        });
        if (changed) {
          editingFieldsRef.current = nextBuffers;
          setEditingFieldsByKey(nextBuffers);
        }
      }
      return saved ?? next;
    },
    [firstWeekStartISO, saveDraftNow, selectedSeasonId, weekCount]
  );

  useEffect(() => {
    commitEditingFieldsRef.current = commitEditingFields;
  }, [commitEditingFields]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") {
      return () => {
        void commitEditingFieldsRef.current?.();
      };
    }
    const flushOnLeave = () => {
      void commitEditingFieldsRef.current?.();
    };
    window.addEventListener("beforeunload", flushOnLeave);
    return () => {
      flushOnLeave();
      window.removeEventListener("beforeunload", flushOnLeave);
    };
  }, []);

  const setGridValue = useCallback(
    (dateISO: string, colKey: string, value: string) => {
      const base = activeDraftRef.current;
      if (!base || !selectedAthleteId) return;
      const session = normalizePlanBuilderSession(colKey);
      const existing = existingCellsByKey[cellKey(dateISO, session)] ?? null;
      const next = setDraftCellCombinedValue(base, selectedAthleteId, dateISO, session, value, existing);
      setActiveDraft(next);
      activeDraftRef.current = next;
      scheduleSave(next);
    },
    [existingCellsByKey, scheduleSave, selectedAthleteId]
  );

  const patchSessionCell = useCallback(
    (dateISO: string, session: "AM" | "PM", patch: Partial<WorkoutPlanBuilderCell>) => {
      const base = activeDraftRef.current;
      if (!base || !selectedAthleteId) return;
      const previous = getDraftCell(base, selectedAthleteId, dateISO, session);
      const existing = existingCellsByKey[cellKey(dateISO, session)] ?? null;
      const nextPatch =
        !previous && existing?.source
          ? {
              timeText: existing.source.snapshot.timeText,
              location: existing.source.snapshot.location,
              categoryIds: existing.source.snapshot.categoryIds,
              preRoutineIds: existing.source.snapshot.preRoutineIds,
              postRoutineIds: existing.source.snapshot.postRoutineIds,
              ...sourceFieldsForExisting(existing),
              ...patch,
            }
          : !previous
            ? { sourceType: "manual" as const, ...patch }
            : patch;
      const next = patchDraftCell(base, selectedAthleteId, dateISO, session, nextPatch);
      setActiveDraft(next);
      activeDraftRef.current = next;
      scheduleSave(next);
    },
    [existingCellsByKey, scheduleSave, selectedAthleteId]
  );

  const setSessionTitle = useCallback(
    (dateISO: string, session: "AM" | "PM", title: string) => {
      setEditingFieldValue(dateISO, session, "title", title);
    },
    [setEditingFieldValue]
  );

  const setSessionDetails = useCallback(
    (dateISO: string, session: "AM" | "PM", details: string) => {
      setEditingFieldValue(dateISO, session, "details", details);
    },
    [setEditingFieldValue]
  );

  const commitSessionField = useCallback(
    (dateISO: string, session: "AM" | "PM", field: PlanBuilderEditingField) => {
      const athleteId = String(selectedAthleteIdRef.current ?? "").trim();
      if (!athleteId) return;
      void commitEditingFields([editingFieldKey(athleteId, dateISO, session, field)]);
    },
    [commitEditingFields]
  );

  const grid = useGridEngine<string, PlanBuilderColKey>({
    enabled: Platform.OS === "web",
    rowIds: dateRows,
    colKeys,
    isEditorHandlingKeys: () => !!focusedEditorKeyRef.current,
    onActivate: () => setActiveGridId(PLAN_BUILDER_GRID_ID),
    getValue: (dateISO, colKey) => {
      const session = normalizePlanBuilderSession(colKey);
      const athleteId = String(selectedAthleteIdRef.current ?? selectedAthleteId ?? "").trim();
      const titleEditKey = athleteId ? editingFieldKey(athleteId, dateISO, session, "title") : "";
      const detailsEditKey = athleteId ? editingFieldKey(athleteId, dateISO, session, "details") : "";
      const draftValue = getDraftCellValue(activeDraftRef.current, selectedAthleteId, dateISO, colKey);
      const existing = existingCellsRef.current[cellKey(dateISO, session)];
      const baseCell = draftValue
        ? getDraftCell(activeDraftRef.current, selectedAthleteId, dateISO, session)
        : existing?.source
          ? ({ ...existing.source.snapshot, dateISO, session } as WorkoutPlanBuilderCell)
          : null;
      const hasTitleEdit = titleEditKey
        ? Object.prototype.hasOwnProperty.call(editingFieldsRef.current, titleEditKey)
        : false;
      const hasDetailsEdit = detailsEditKey
        ? Object.prototype.hasOwnProperty.call(editingFieldsRef.current, detailsEditKey)
        : false;
      if (!baseCell && !hasTitleEdit && !hasDetailsEdit) return "";
      return cellToCombinedText({
        ...(baseCell ?? { dateISO, session, title: "", details: "" }),
        title: hasTitleEdit ? editingFieldsRef.current[titleEditKey] : String(baseCell?.title ?? ""),
        details: hasDetailsEdit ? editingFieldsRef.current[detailsEditKey] : String(baseCell?.details ?? ""),
      });
    },
    setValuesBatch: (changes) => {
      const athleteId = String(selectedAthleteIdRef.current ?? "").trim();
      let next = activeDraftRef.current;
      if (!next || !athleteId) return;
      const beforeCellCount = Object.keys(next.cellsByKey ?? {}).length;
      const targets = changes.map((change) => ({
        dateISO: String(change.rowId ?? "").trim(),
        session: normalizePlanBuilderSession(change.colKey),
      }));
      changes.forEach((change) => {
        const session = normalizePlanBuilderSession(change.colKey);
        const existing = existingCellsRef.current[cellKey(change.rowId, session)] ?? null;
        next = next ? setDraftCellCombinedValue(next, athleteId, change.rowId, session, change.value, existing) : next;
      });
      if (!next) return;
      setActiveDraft(next);
      activeDraftRef.current = next;
      const pasteMeta = pendingPasteDebugRef.current;
      pendingPasteDebugRef.current = null;
      debugPlanBuilderPaste("batch paste applied", {
        ...(pasteMeta ?? {}),
        targetCount: changes.length,
        beforeCellCount,
        afterCellCount: Object.keys(next.cellsByKey ?? {}).length,
        firstTarget: targets[0] ?? null,
        lastTarget: targets[targets.length - 1] ?? null,
      });
      void saveDraftNow(next);
    },
    setValue: (dateISO, colKey, value) => setGridValue(dateISO, colKey, value),
  });

  const bindPlanCell = useCallback(
    (dateISO: string, colKey: PlanBuilderColKey) => {
      const base = grid.bindCell(dateISO, colKey);
      const handlers = base.handlers ?? {};
      const { onCopy: _onCopy, onPaste: _onPaste, ...cellHandlers } = handlers as any;
      return {
        ...base,
        handlers: {
          ...cellHandlers,
          onMouseDown: (event: any) => {
            setActiveGridId(PLAN_BUILDER_GRID_ID);
            handlers.onMouseDown?.(event);
          },
          onFocus: (event: any) => {
            setActiveGridId(PLAN_BUILDER_GRID_ID);
            handlers.onFocus?.(event);
          },
        },
      };
    },
    [grid]
  );

  const copyPlanBuilderSelection = useCallback(async () => {
    await commitEditingFields();
    planBuilderClipboardRef.current = await grid.copySelectionToClipboard();
  }, [commitEditingFields, grid]);

  const applyPlanBuilderPasteText = useCallback(
    (rawText: string) => {
      const raw = String(rawText ?? "").trimEnd();
      if (!raw) return;
      const matrix = parseTsv(raw);
      if (matrix.length === 0) return;
      const rect = grid.getSelectionRect();
      const startRow = rect?.r1 ?? 0;
      const startCol = rect?.c1 ?? 0;
      const isSingleValuePaste = matrix.length <= 1 && (matrix[0]?.length ?? 0) <= 1;
      const changes: Array<{ rowId: string; colKey: PlanBuilderColKey; prev: string; next: string }> = [];
      const targets: Array<{ dateISO: string; session: "AM" | "PM" }> = [];

      const pushChange = (rowIndex: number, colIndex: number, value: string) => {
        if (rowIndex < 0 || rowIndex >= dateRows.length) return;
        if (colIndex < 0 || colIndex >= colKeys.length) return;
        const rowId = dateRows[rowIndex];
        const colKey = colKeys[colIndex];
        const session = normalizePlanBuilderSession(colKey);
        changes.push({
          rowId,
          colKey,
          prev: "",
          next: String(value ?? ""),
        });
        targets.push({ dateISO: rowId, session });
      };

      if (isSingleValuePaste && rect) {
        const single = matrix[0]?.[0] ?? raw;
        for (let r = rect.r1; r <= rect.r2; r += 1) {
          for (let c = rect.c1; c <= rect.c2; c += 1) {
            pushChange(r, c, single);
          }
        }
      } else {
        matrix.forEach((row, rOffset) => {
          row.forEach((value, cOffset) => {
            pushChange(startRow + rOffset, startCol + cOffset, value);
          });
        });
      }

      if (!rect && isSingleValuePaste) {
        pushChange(startRow, startCol, matrix[0]?.[0] ?? raw);
      }

      if (changes.length === 0) return;
      const normalizedChanges = changes.map((change) => ({
        ...change,
        prev: getDraftCellValue(activeDraftRef.current, selectedAthleteIdRef.current, change.rowId, change.colKey),
      }));
      pendingPasteDebugRef.current = {
        rowCount: matrix.length,
        colCount: Math.max(0, ...matrix.map((row) => row.length)),
        parsedTargetCount: normalizedChanges.length,
        firstTarget: targets[0] ?? null,
        lastTarget: targets[targets.length - 1] ?? null,
      };
      debugPlanBuilderPaste("parsed clipboard", pendingPasteDebugRef.current);
      grid.applyChanges(normalizedChanges as any);
    },
    [colKeys, dateRows, grid]
  );

  const pastePlanBuilderSelection = useCallback(async () => {
    await commitEditingFields();
    setActiveGridId(PLAN_BUILDER_GRID_ID);
    let raw = "";
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      try {
        raw = String(await navigator.clipboard.readText());
      } catch {}
    }
    if (!raw) raw = planBuilderClipboardRef.current;
    applyPlanBuilderPasteText(raw);
  }, [applyPlanBuilderPasteText, commitEditingFields]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onKeyDown = (event: any) => {
      const doc = (globalThis as any)?.document;
      if (isTextEditingTarget(event?.target) || isTextEditingTarget(doc?.activeElement)) return;
      const key = String(event?.key ?? "").toLowerCase();
      const ctrlMeta = !!(event?.ctrlKey || event?.metaKey);
      if (activeGridId === PLAN_BUILDER_GRID_ID && ctrlMeta && key === "c" && !focusedEditorKeyRef.current) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        void copyPlanBuilderSelection();
        return;
      }
      if (activeGridId === PLAN_BUILDER_GRID_ID && ctrlMeta && key === "v" && !focusedEditorKeyRef.current) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        void pastePlanBuilderSelection();
        return;
      }
      const handled = activeGridId === PLAN_BUILDER_GRID_ID ? grid.handleKeyDown(event) : false;
      if (!handled) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activeGridId, copyPlanBuilderSelection, grid, pastePlanBuilderSelection]);



  const openFirstWeekPicker = useCallback(async () => {
    await commitEditingFields();
    const current = isDateISO(firstWeekInput) ? firstWeekInput : getWeekStartISO(toISODate(new Date()), weekStartsOn);
    setFirstWeekPickerDraftDate(current);
    setFirstWeekPickerError(null);
    setFirstWeekPickerOpen(true);
  }, [commitEditingFields, firstWeekInput, weekStartsOn]);

  const closeFirstWeekPicker = useCallback(() => {
    setFirstWeekPickerOpen(false);
    setFirstWeekPickerDraftDate("");
    setFirstWeekPickerError(null);
  }, []);

  const confirmFirstWeekPicker = useCallback(async () => {
    const selectedDateISO = String(firstWeekPickerDraftDate ?? "").trim();
    if (!isDateISO(selectedDateISO)) {
      setFirstWeekPickerError("Choose a valid date.");
      return;
    }
    await commitEditingFields();
    const nextWeekStartISO = getWeekStartISO(selectedDateISO, weekStartsOn);
    setFirstWeekInput(nextWeekStartISO);
    patchActiveDraft({ rangeMode: "custom", firstWeekStartISO: nextWeekStartISO });
    closeFirstWeekPicker();
  }, [closeFirstWeekPicker, commitEditingFields, firstWeekPickerDraftDate, patchActiveDraft, weekStartsOn]);

  const updateWeekCount = useCallback(
    (value: string) => {
      void commitEditingFields();
      setWeekCountInput(value);
      const parsed = normalizeWeekCount(value);
      if (String(parsed) === String(Number(value))) patchActiveDraft({ rangeMode: "custom", numberOfWeeks: parsed });
    },
    [commitEditingFields, patchActiveDraft]
  );

  const buildCellMetadataSummary = useCallback(
    (cell: WorkoutPlanBuilderCell | null | undefined): string => {
      if (!cell) return "";
      const categoryNames = normalizeStringList(cell.categoryIds)
        .map((id) => categoryById.get(id) ? categoryDisplayName(categoryById.get(id) as WorkoutCategory) : id)
        .filter(Boolean);
      const preNames = normalizeStringList(cell.preRoutineIds)
        .map((id) => routineById.get(id)?.title ?? "")
        .map((name) => String(name ?? "").trim())
        .filter(Boolean);
      const postNames = normalizeStringList(cell.postRoutineIds)
        .map((id) => routineById.get(id)?.title ?? "")
        .map((name) => String(name ?? "").trim())
        .filter(Boolean);
      const parts = [...categoryNames];
      if (preNames.length) parts.push(`Pre: ${preNames.join(", ")}`);
      if (postNames.length) parts.push(`Post: ${postNames.join(", ")}`);
      return parts.join(" • ");
    },
    [categoryById, routineById]
  );

  const getDisplayCell = useCallback(
    (dateISO: string, session: "AM" | "PM"): WorkoutPlanBuilderCell | null => {
      const draftCell = getDraftCell(activeDraft, selectedAthleteId, dateISO, session);
      const titleEditKey = selectedAthleteId ? editingFieldKey(selectedAthleteId, dateISO, session, "title") : "";
      const detailsEditKey = selectedAthleteId ? editingFieldKey(selectedAthleteId, dateISO, session, "details") : "";
      const hasTitleEdit = titleEditKey
        ? Object.prototype.hasOwnProperty.call(editingFieldsByKey, titleEditKey)
        : false;
      const hasDetailsEdit = detailsEditKey
        ? Object.prototype.hasOwnProperty.call(editingFieldsByKey, detailsEditKey)
        : false;
      if (draftCell) {
        return {
          ...draftCell,
          title: hasTitleEdit ? editingFieldsByKey[titleEditKey] : draftCell.title,
          details: hasDetailsEdit ? editingFieldsByKey[detailsEditKey] : draftCell.details,
        };
      }
      const existing = existingCellsByKey[cellKey(dateISO, session)];
      if (!existing?.source && !hasTitleEdit && !hasDetailsEdit) return null;
      const snapshot = existing?.source?.snapshot;
      return {
        dateISO,
        session,
        title: hasTitleEdit ? editingFieldsByKey[titleEditKey] : String(snapshot?.title ?? ""),
        details: hasDetailsEdit ? editingFieldsByKey[detailsEditKey] : String(snapshot?.details ?? ""),
        timeText: snapshot?.timeText,
        location: snapshot?.location,
        categoryIds: normalizeStringList(snapshot?.categoryIds),
        preRoutineIds: normalizeStringList(snapshot?.preRoutineIds),
        postRoutineIds: normalizeStringList(snapshot?.postRoutineIds),
        ...sourceFieldsForExisting(existing ?? null),
      };
    },
    [activeDraft, editingFieldsByKey, existingCellsByKey, selectedAthleteId]
  );

  const buildRowMetadataSummary = useCallback(
    (dateISO: string): string => {
      const am = buildCellMetadataSummary(getDisplayCell(dateISO, "AM"));
      const pm = buildCellMetadataSummary(getDisplayCell(dateISO, "PM"));
      const lines = [];
      if (am) lines.push(`AM: ${am}`);
      if (pm) lines.push(`PM: ${pm}`);
      return lines.join("\n");
    },
    [buildCellMetadataSummary, getDisplayCell]
  );

  const toggleSessionListValue = useCallback(
    (
      dateISO: string,
      session: "AM" | "PM",
      field: "categoryIds" | "preRoutineIds" | "postRoutineIds",
      id: string
    ) => {
      const current = getDraftCell(activeDraftRef.current, selectedAthleteId, dateISO, session);
      const existing = normalizeStringList(current?.[field]);
      const cleanId = String(id ?? "").trim();
      if (!cleanId) return;
      const nextValues = existing.includes(cleanId)
        ? existing.filter((item) => item !== cleanId)
        : [...existing, cleanId];
      patchSessionCell(dateISO, session, { [field]: nextValues } as Partial<WorkoutPlanBuilderCell>);
    },
    [patchSessionCell, selectedAthleteId]
  );

  const buildFreshApplyPreviewRows = useCallback(
    async (input: {
      athleteId: string;
      startISO: string;
      endISO: string;
      draft: WorkoutPlanBuilderDraft | null;
    }): Promise<ApplyPreviewRow[]> => {
      const { athleteId, startISO, endISO, draft } = input;
      const [freshRows, freshHeaderRows] = await Promise.all([
        listAthleteWorkoutsInRange(athleteId, startISO, endISO),
        listTeamWorkoutBatchHeadersInRange(startISO, endISO),
      ]);
      const freshExistingByKey = buildExistingCellIndex(freshRows, freshHeaderRows);
      const freshRowsById = new Map(
        (Array.isArray(freshRows) ? freshRows : []).map((row) => [String(row.id ?? "").trim(), row] as const)
      );
      const keys = new Set<string>();
      Object.keys(freshExistingByKey).forEach((key) => keys.add(key));
      Object.values(draft?.cellsByKey ?? {}).forEach((cell) => {
        if (isCellInsideRange(cell, startISO, endISO)) keys.add(cellKey(cell.dateISO, cell.session));
      });

      return Array.from(keys)
        .map((key) => {
          const [dateISO, sessionRaw] = key.split("__");
          const session = normalizeSession(sessionRaw);
          const draftCell = getDraftCell(draft, athleteId, dateISO, session);
          const existingCell = freshExistingByKey[key] ?? null;
          const draftSnapshot = snapshotFromDraftCell(draftCell);
          const existingSnapshot = existingCell?.source?.snapshot ?? null;
          const sourceWorkoutId = String(draftCell?.sourceWorkoutId ?? "").trim();
          const draftHasContent = draftCell ? hasDraftCellContent(draftCell) : false;
          let status: ApplyPreviewStatus = "unchanged";
          let reason = "No draft changes.";

          if (existingCell?.conflictReason) {
            status = "conflict";
            reason = existingCell.conflictReason;
          } else if (draftCell?.sourceType === "existing" || draftCell?.originalSnapshot) {
            if (!draftHasContent) {
              status = "cleared";
              reason = "Delete deferred; real workout would remain unchanged in this phase.";
            } else if (sourceWorkoutId && !freshRowsById.has(sourceWorkoutId)) {
              status = "conflict";
              reason = "Source workout no longer exists in the selected range.";
            } else if (!existingCell?.source) {
              status = "conflict";
              reason = "Original source slot is no longer a single existing workout.";
            } else if (sourceWorkoutId && String(existingCell.source.row.id ?? "").trim() !== sourceWorkoutId) {
              status = "conflict";
              reason = "Source slot now points to a different workout.";
            } else if (!snapshotsEqual(existingCell.source.snapshot, draftCell.originalSnapshot)) {
              status = "conflict";
              reason = "Existing workout changed since this draft was created.";
            } else if (snapshotsEqual(draftSnapshot, existingCell.source.snapshot)) {
              status = "unchanged";
              reason = "Draft matches the current existing workout.";
            } else {
              status = "update";
              reason = "Draft differs from the existing workout.";
            }
          } else if (draftCell && draftHasContent) {
            if (existingCell?.source) {
              status = "conflict";
              reason = "Draft would create into a slot that now has an existing workout.";
            } else {
              status = "new";
              reason = "Draft content in an empty real slot.";
            }
          } else if (existingCell?.source) {
            status = "unchanged";
            reason = "Existing workout has no draft override.";
          }

          return {
            id: `${dateISO}__${session}`,
            dateISO,
            dayLabel: formatDayShort(dateISO),
            session,
            draftTitle: String(draftCell?.title ?? "").trim(),
            existingTitle: String(existingSnapshot?.title ?? existingCell?.rows?.[0]?.title ?? "").trim(),
            status,
            reason,
          };
        })
        .sort((a, b) => compareDateISO(a.dateISO, b.dateISO) || a.session.localeCompare(b.session));
    },
    [buildExistingCellIndex]
  );

  const getApplyScopeRange = useCallback(() => {
    const fullStartISO = dateRows[0] ?? firstWeekStartISO;
    const fullEndISO = dateRows[dateRows.length - 1] ?? addDaysISO(firstWeekStartISO, Math.max(0, weekCount * 7 - 1));
    return {
      startISO: applyPreviewScope === "range" ? String(applyPreviewStartISO ?? "").trim() : fullStartISO,
      endISO: applyPreviewScope === "range" ? String(applyPreviewEndISO ?? "").trim() : fullEndISO,
    };
  }, [applyPreviewEndISO, applyPreviewScope, applyPreviewStartISO, dateRows, firstWeekStartISO, weekCount]);

  const generateApplyPreview = useCallback(async () => {
    await commitEditingFields();
    const { startISO, endISO } = getApplyScopeRange();
    const athleteId = String(selectedAthleteId ?? "").trim();

    if (!athleteId) {
      setApplyPreviewError("Select an athlete before generating a preview.");
      return;
    }
    if (!isDateISO(startISO) || !isDateISO(endISO) || endISO < startISO) {
      setApplyPreviewError("Choose a valid preview date range.");
      return;
    }

    const draftForPreview = activeDraftRef.current;

    setApplyPreviewLoading(true);
    setApplyPreviewError(null);
    setLastApplySummary(null);
    setApplyPreviewRows([]);
    try {
      const rows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: draftForPreview,
      });

      setApplyPreviewRows(rows);
    } catch (error: any) {
      setApplyPreviewError(String(error?.message ?? "Could not generate preview."));
    } finally {
      setApplyPreviewLoading(false);
    }
  }, [
    buildFreshApplyPreviewRows,
    commitEditingFields,
    getApplyScopeRange,
    selectedAthleteId,
  ]);

  const visibleRangeLabel = dateRows.length > 0
    ? `${formatDateShort(dateRows[0])} - ${formatDateShort(dateRows[dateRows.length - 1])} • ${weekStarts.length} week${weekStarts.length === 1 ? "" : "s"}`
    : "No weeks selected";

  const currentWeekStartISO = useMemo(() => getWeekStartISO(toISODate(new Date()), weekStartsOn), [weekStartsOn]);

  const draftCellCount = activeDraft ? Object.keys(activeDraft.cellsByKey).length : 0;

  const applyPreviewCounts = useMemo(() => {
    const counts: Record<ApplyPreviewStatus, number> = {
      new: 0,
      update: 0,
      unchanged: 0,
      conflict: 0,
      cleared: 0,
    };
    applyPreviewRows.forEach((row) => {
      counts[row.status] += 1;
    });
    return counts;
  }, [applyPreviewRows]);

  const filteredApplyPreviewRows = useMemo(
    () => applyPreviewRows.filter((row) => rowMatchesApplyPreviewFilter(row, applyPreviewFilter)),
    [applyPreviewFilter, applyPreviewRows]
  );

  const applyPreviewFilterCounts = useMemo(
    () => ({
      all: applyPreviewRows.length,
      new: applyPreviewCounts.new,
      update: applyPreviewCounts.update,
      conflict: applyPreviewCounts.conflict,
      skipped: applyPreviewCounts.cleared + applyPreviewCounts.unchanged,
    }),
    [applyPreviewCounts, applyPreviewRows.length]
  );

  const confirmCreateNewWorkouts = useCallback((count: number): Promise<boolean> => {
    const title = `Create ${count} new workout${count === 1 ? "" : "s"}?`;
    const message = "Existing workouts will not be changed. Conflicts, updates, cleared drafts, and unchanged rows will be skipped.";
    if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.confirm === "function") {
      return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    }
    return new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Create New Workouts", style: "default", onPress: () => resolve(true) },
      ]);
    });
  }, []);

  const confirmUpdateExistingWorkouts = useCallback((count: number): Promise<boolean> => {
    const title = `Update ${count} existing workout${count === 1 ? "" : "s"}?`;
    const message = "Only safe single-athlete workouts will be changed. Shared batches, conflicts, cleared drafts, new rows, and unchanged rows will be skipped.";
    if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.confirm === "function") {
      return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    }
    return new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Update Safe Existing", style: "default", onPress: () => resolve(true) },
      ]);
    });
  }, []);

  const confirmApplySafeChanges = useCallback((newCount: number, updateCount: number): Promise<boolean> => {
    const total = newCount + updateCount;
    const title = `Apply ${total} safe change${total === 1 ? "" : "s"}?`;
    const message = `Apply ${newCount} new workout${newCount === 1 ? "" : "s"} and ${updateCount} safe update${updateCount === 1 ? "" : "s"}?\n\nConflicts, shared batches, and deletes will be skipped.`;
    if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.confirm === "function") {
      return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    }
    return new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Apply Safe Changes", style: "default", onPress: () => resolve(true) },
      ]);
    });
  }, []);

  const refreshExistingWorkoutOverlay = useCallback(
    async (startISO?: string, endISO?: string) => {
      const rangeStart = startISO ?? dateRows[0];
      const rangeEnd = endISO ?? dateRows[dateRows.length - 1];
      const athleteId = String(selectedAthleteIdRef.current ?? "").trim();
      if (!athleteId || !isDateISO(rangeStart) || !isDateISO(rangeEnd)) return;
      const [workoutRows, headerRows] = await Promise.all([
        listAthleteWorkoutsInRange(athleteId, rangeStart, rangeEnd),
        listTeamWorkoutBatchHeadersInRange(rangeStart, rangeEnd),
      ]);
      setExistingCellsByKey(buildExistingCellIndex(workoutRows, headerRows));
    },
    [buildExistingCellIndex, dateRows]
  );

  const loadFreshExistingCellIndex = useCallback(
    async (athleteId: string, startISO: string, endISO: string) => {
      const [freshRows, freshHeaderRows] = await Promise.all([
        listAthleteWorkoutsInRange(athleteId, startISO, endISO),
        listTeamWorkoutBatchHeadersInRange(startISO, endISO),
      ]);
      return buildExistingCellIndex(freshRows, freshHeaderRows);
    },
    [buildExistingCellIndex]
  );

  const createSafeNewDraftRows = useCallback(
    async (input: {
      athleteId: string;
      teamId: string;
      draft: WorkoutPlanBuilderDraft | null;
      rows: ApplyPreviewRow[];
    }): Promise<CreateSafeNewRowsResult> => {
      const { athleteId, teamId, draft, rows } = input;
      const createdKeys: string[] = [];
      let headerNoteFailureCount = 0;

      for (const row of rows) {
        const draftCell = getDraftCell(draft, athleteId, row.dateISO, row.session);
        if (!draftCell || !hasDraftCellContent(draftCell)) continue;

        const categoryNames = normalizeStringList(draftCell.categoryIds)
          .map((id) => {
            const match = categoryById.get(id);
            return match ? categoryDisplayName(match) : id;
          })
          .filter(Boolean);
        const details = String(draftCell.details ?? "").trim();
        const newBatchId = createBatchId(row.dateISO);
        const payload = buildTeamWorkoutInsertRows({
          selectedAthleteIds: [athleteId],
          date_iso: row.dateISO,
          session: row.session,
          location: String(draftCell.location ?? "").trim() || null,
          time_text: String(draftCell.timeText ?? "").trim() || "",
          title: String(draftCell.title ?? "").trim() || "Workout",
          details: details || null,
          primary_category: categoryNames[0] ?? null,
          categories: categoryNames,
          plannedDistanceUnit: null,
          batch_id: newBatchId,
          group_id: "1",
          team_id: teamId,
          created_by: null,
          pre_routine_ids: normalizeStringList(draftCell.preRoutineIds).length > 0 ? normalizeStringList(draftCell.preRoutineIds) : null,
          post_routine_ids: normalizeStringList(draftCell.postRoutineIds).length > 0 ? normalizeStringList(draftCell.postRoutineIds) : null,
        });
        if (payload.length === 0) continue;

        await createTeamWorkoutBatch(payload);
        createdKeys.push(workoutPlanBuilderCellKey(athleteId, row.dateISO, row.session));
        if (details) {
          try {
            await saveTeamWorkoutBatchHeaderNotes({
              batch_id: newBatchId,
              date_iso: row.dateISO,
              session: row.session,
              header_notes: details,
            });
          } catch {
            headerNoteFailureCount += 1;
          }
        }
      }

      return { createdKeys, headerNoteFailureCount };
    },
    [categoryById]
  );

  const updateSafeExistingDraftRows = useCallback(
    async (input: {
      athleteId: string;
      draft: WorkoutPlanBuilderDraft | null;
      rows: ApplyPreviewRow[];
      freshExistingByKey: Record<string, ExistingPlanCell>;
    }): Promise<UpdateSafeExistingRowsResult> => {
      const { athleteId, draft, rows, freshExistingByKey } = input;
      const updatedKeys: string[] = [];
      let sharedSkipped = 0;
      let staleSkipped = 0;
      let unsafeSkipped = 0;
      let headerNoteFailureCount = 0;

      for (const row of rows) {
        const draftCell = getDraftCell(draft, athleteId, row.dateISO, row.session);
        const existingCell = freshExistingByKey[cellKey(row.dateISO, row.session)] ?? null;
        const sourceWorkoutId = String(draftCell?.sourceWorkoutId ?? "").trim();
        const sourceRow = existingCell?.source?.row ?? null;
        if (!draftCell || !sourceWorkoutId || !existingCell?.source || existingCell.rows.length !== 1 || !sourceRow) {
          unsafeSkipped += 1;
          continue;
        }
        if (String(sourceRow.id ?? "").trim() !== sourceWorkoutId) {
          staleSkipped += 1;
          continue;
        }
        if (
          String(sourceRow.athlete_profile_id ?? "").trim() !== athleteId ||
          String(sourceRow.date_iso ?? "").trim() !== row.dateISO ||
          normalizeSession(sourceRow.session) !== row.session
        ) {
          staleSkipped += 1;
          continue;
        }
        if (!snapshotsEqual(existingCell.source.snapshot, draftCell.originalSnapshot)) {
          staleSkipped += 1;
          continue;
        }

        const batchId = String(sourceRow.batch_id ?? "").trim();
        if (batchId) {
          const batchRows = await listTeamWorkoutsByBatch(batchId);
          const uniqueAthleteIds = new Set(
            (Array.isArray(batchRows) ? batchRows : []).map((batchRow) => String(batchRow.athlete_profile_id ?? "").trim()).filter(Boolean)
          );
          if (batchRows.length !== 1 || uniqueAthleteIds.size !== 1 || !uniqueAthleteIds.has(athleteId)) {
            sharedSkipped += 1;
            continue;
          }
        }

        const categoryNames = normalizeStringList(draftCell.categoryIds)
          .map((id) => {
            const match = categoryById.get(id);
            return match ? categoryDisplayName(match) : id;
          })
          .filter(Boolean);
        const details = String(draftCell.details ?? "").trim();
        await updateTeamWorkoutById(sourceWorkoutId, {
          title: String(draftCell.title ?? "").trim() || "Workout",
          details: details || null,
          time_text: String(draftCell.timeText ?? "").trim() || null,
          location: String(draftCell.location ?? "").trim() || null,
          primary_category: categoryNames[0] ?? null,
          categories: categoryNames,
          pre_routine_ids: normalizeStringList(draftCell.preRoutineIds).length > 0 ? normalizeStringList(draftCell.preRoutineIds) : null,
          post_routine_ids: normalizeStringList(draftCell.postRoutineIds).length > 0 ? normalizeStringList(draftCell.postRoutineIds) : null,
        });

        if (batchId) {
          try {
            await saveTeamWorkoutBatchHeaderNotes({
              batch_id: batchId,
              date_iso: row.dateISO,
              session: row.session,
              header_notes: details || null,
            });
          } catch {
            headerNoteFailureCount += 1;
          }
        }
        updatedKeys.push(workoutPlanBuilderCellKey(athleteId, row.dateISO, row.session));
      }

      return { updatedKeys, sharedSkipped, staleSkipped, unsafeSkipped, headerNoteFailureCount };
    },
    [categoryById]
  );

  const clearAppliedDraftKeys = useCallback(
    async (keys: string[], fallbackDraft: WorkoutPlanBuilderDraft | null) => {
      if (keys.length === 0 || !fallbackDraft) return;
      const nextCells = { ...(activeDraftRef.current?.cellsByKey ?? fallbackDraft.cellsByKey) };
      keys.forEach((key) => {
        delete nextCells[key];
      });
      const nextDraft: WorkoutPlanBuilderDraft = {
        ...(activeDraftRef.current ?? fallbackDraft),
        cellsByKey: nextCells,
        updatedAt: Date.now(),
      };
      setActiveDraft(nextDraft);
      activeDraftRef.current = nextDraft;
      await saveDraftNow(nextDraft);
    },
    [saveDraftNow]
  );

  const applyNewDraftWorkouts = useCallback(async () => {
    await commitEditingFields();
    const { startISO, endISO } = getApplyScopeRange();
    const athleteId = String(selectedAthleteIdRef.current ?? "").trim();
    const teamId = String((store as any)?.teamId ?? "").trim();
    if (!athleteId) {
      setApplyPreviewError("Select an athlete before creating workouts.");
      return;
    }
    if (!teamId) {
      setApplyPreviewError("Team is still loading. Try again in a moment.");
      return;
    }
    if (!isDateISO(startISO) || !isDateISO(endISO) || endISO < startISO) {
      setApplyPreviewError("Choose a valid apply date range.");
      return;
    }

    setApplyNewLoading(true);
    setApplyPreviewError(null);
    try {
      const draftBeforeConfirm = activeDraftRef.current;
      const firstFreshRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: draftBeforeConfirm,
      });
      setApplyPreviewRows(firstFreshRows);
      const firstNewRows = firstFreshRows.filter((row) => row.status === "new");
      if (firstNewRows.length === 0) {
        setApplyPreviewError("No new draft workouts are safe to create.");
        return;
      }

      const confirmed = await confirmCreateNewWorkouts(firstNewRows.length);
      if (!confirmed) return;

      const draftForApply = activeDraftRef.current;
      const finalFreshRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: draftForApply,
      });
      setApplyPreviewRows(finalFreshRows);
      const rowsToCreate = finalFreshRows.filter((row) => row.status === "new");
      if (rowsToCreate.length === 0) {
        setApplyPreviewError("No new draft workouts remain safe to create after the fresh conflict check.");
        return;
      }

      const createResult = await createSafeNewDraftRows({
        athleteId,
        teamId,
        draft: draftForApply,
        rows: rowsToCreate,
      });
      await clearAppliedDraftKeys(createResult.createdKeys, draftForApply);

      await refreshExistingWorkoutOverlay();
      const refreshedRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: activeDraftRef.current,
      });
      setApplyPreviewRows(refreshedRows);
      const skipped = Math.max(0, finalFreshRows.filter((row) => row.status !== "new").length + rowsToCreate.length - createResult.createdKeys.length);
      const errors = createResult.headerNoteFailureCount > 0
        ? [`${createResult.headerNoteFailureCount} header note save${createResult.headerNoteFailureCount === 1 ? "" : "s"} failed, but row details were created.`]
        : [];
      setLastApplySummary({
        title: "Import New Only",
        created: createResult.createdKeys.length,
        updated: 0,
        skipped,
        conflicts: finalFreshRows.filter((row) => row.status === "conflict").length,
        errors,
      });
      setApplyPreviewError(null);
    } catch (error: any) {
      setApplyPreviewError(String(error?.message ?? "Could not create new draft workouts."));
    } finally {
      setApplyNewLoading(false);
    }
  }, [
    buildFreshApplyPreviewRows,
    clearAppliedDraftKeys,
    commitEditingFields,
    confirmCreateNewWorkouts,
    createSafeNewDraftRows,
    getApplyScopeRange,
    refreshExistingWorkoutOverlay,
    store,
  ]);

  const applySafeExistingUpdates = useCallback(async () => {
    await commitEditingFields();
    const { startISO, endISO } = getApplyScopeRange();
    const athleteId = String(selectedAthleteIdRef.current ?? "").trim();
    if (!athleteId) {
      setApplyPreviewError("Select an athlete before updating workouts.");
      return;
    }
    if (!isDateISO(startISO) || !isDateISO(endISO) || endISO < startISO) {
      setApplyPreviewError("Choose a valid apply date range.");
      return;
    }

    setApplyUpdateLoading(true);
    setApplyPreviewError(null);
    try {
      const draftBeforeConfirm = activeDraftRef.current;
      const firstFreshRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: draftBeforeConfirm,
      });
      setApplyPreviewRows(firstFreshRows);
      const firstUpdateRows = firstFreshRows.filter((row) => row.status === "update");
      if (firstUpdateRows.length === 0) {
        setApplyPreviewError("No safe existing workout updates are available.");
        return;
      }

      const confirmed = await confirmUpdateExistingWorkouts(firstUpdateRows.length);
      if (!confirmed) return;

      const draftForApply = activeDraftRef.current;
      const finalFreshRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: draftForApply,
      });
      setApplyPreviewRows(finalFreshRows);
      const rowsToUpdate = finalFreshRows.filter((row) => row.status === "update");
      if (rowsToUpdate.length === 0) {
        setApplyPreviewError("No updates remain safe after the fresh conflict check.");
        return;
      }

      const freshExistingByKey = await loadFreshExistingCellIndex(athleteId, startISO, endISO);
      const updateResult = await updateSafeExistingDraftRows({
        athleteId,
        draft: draftForApply,
        rows: rowsToUpdate,
        freshExistingByKey,
      });
      await clearAppliedDraftKeys(updateResult.updatedKeys, draftForApply);

      await refreshExistingWorkoutOverlay();
      const refreshedRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: activeDraftRef.current,
      });
      setApplyPreviewRows(refreshedRows);
      const skipped = Math.max(0, finalFreshRows.filter((row) => row.status !== "update").length + rowsToUpdate.length - updateResult.updatedKeys.length);
      const errors: string[] = [];
      if (updateResult.sharedSkipped > 0) errors.push(`${updateResult.sharedSkipped} shared batch row${updateResult.sharedSkipped === 1 ? "" : "s"} skipped.`);
      if (updateResult.staleSkipped > 0) errors.push(`${updateResult.staleSkipped} stale/source-changed row${updateResult.staleSkipped === 1 ? "" : "s"} skipped.`);
      if (updateResult.unsafeSkipped > 0) errors.push(`${updateResult.unsafeSkipped} unsafe row${updateResult.unsafeSkipped === 1 ? "" : "s"} skipped.`);
      if (updateResult.headerNoteFailureCount > 0) errors.push(`${updateResult.headerNoteFailureCount} updated header note save${updateResult.headerNoteFailureCount === 1 ? "" : "s"} failed, but workout rows were updated.`);
      setLastApplySummary({
        title: "Update Safe Existing",
        created: 0,
        updated: updateResult.updatedKeys.length,
        skipped,
        conflicts: finalFreshRows.filter((row) => row.status === "conflict").length + updateResult.sharedSkipped + updateResult.staleSkipped + updateResult.unsafeSkipped,
        errors,
      });
      setApplyPreviewError(null);
    } catch (error: any) {
      setApplyPreviewError(String(error?.message ?? "Could not update safe existing workouts."));
    } finally {
      setApplyUpdateLoading(false);
    }
  }, [
    buildFreshApplyPreviewRows,
    clearAppliedDraftKeys,
    commitEditingFields,
    confirmUpdateExistingWorkouts,
    getApplyScopeRange,
    loadFreshExistingCellIndex,
    refreshExistingWorkoutOverlay,
    updateSafeExistingDraftRows,
  ]);

  const applySafeChanges = useCallback(async () => {
    await commitEditingFields();
    const { startISO, endISO } = getApplyScopeRange();
    const athleteId = String(selectedAthleteIdRef.current ?? "").trim();
    const teamId = String((store as any)?.teamId ?? "").trim();
    if (!athleteId) {
      setApplyPreviewError("Select an athlete before applying safe changes.");
      return;
    }
    if (!teamId) {
      setApplyPreviewError("Team is still loading. Try again in a moment.");
      return;
    }
    if (!isDateISO(startISO) || !isDateISO(endISO) || endISO < startISO) {
      setApplyPreviewError("Choose a valid apply date range.");
      return;
    }

    setApplySafeLoading(true);
    setApplyPreviewError(null);
    try {
      const draftBeforeConfirm = activeDraftRef.current;
      const firstFreshRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: draftBeforeConfirm,
      });
      setApplyPreviewRows(firstFreshRows);
      const firstNewRows = firstFreshRows.filter((row) => row.status === "new");
      const firstUpdateRows = firstFreshRows.filter((row) => row.status === "update");
      if (firstNewRows.length + firstUpdateRows.length === 0) {
        setApplyPreviewError("No safe new workouts or safe existing updates are available.");
        return;
      }

      const confirmed = await confirmApplySafeChanges(firstNewRows.length, firstUpdateRows.length);
      if (!confirmed) return;

      const draftForApply = activeDraftRef.current;
      const finalFreshRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: draftForApply,
      });
      setApplyPreviewRows(finalFreshRows);
      const rowsToCreate = finalFreshRows.filter((row) => row.status === "new");
      const rowsToUpdate = finalFreshRows.filter((row) => row.status === "update");
      if (rowsToCreate.length + rowsToUpdate.length === 0) {
        setApplyPreviewError("No safe changes remain after the fresh conflict check.");
        return;
      }

      const freshExistingByKey = await loadFreshExistingCellIndex(athleteId, startISO, endISO);
      const createResult = rowsToCreate.length > 0
        ? await createSafeNewDraftRows({ athleteId, teamId, draft: draftForApply, rows: rowsToCreate })
        : { createdKeys: [], headerNoteFailureCount: 0 };
      const updateResult = rowsToUpdate.length > 0
        ? await updateSafeExistingDraftRows({ athleteId, draft: draftForApply, rows: rowsToUpdate, freshExistingByKey })
        : { updatedKeys: [], sharedSkipped: 0, staleSkipped: 0, unsafeSkipped: 0, headerNoteFailureCount: 0 };

      const appliedKeys = Array.from(new Set([...createResult.createdKeys, ...updateResult.updatedKeys]));
      await clearAppliedDraftKeys(appliedKeys, draftForApply);

      await refreshExistingWorkoutOverlay();
      const refreshedRows = await buildFreshApplyPreviewRows({
        athleteId,
        startISO,
        endISO,
        draft: activeDraftRef.current,
      });
      setApplyPreviewRows(refreshedRows);
      const skipped = Math.max(
        0,
        finalFreshRows.filter((row) => row.status !== "new" && row.status !== "update").length +
          rowsToCreate.length - createResult.createdKeys.length +
          rowsToUpdate.length - updateResult.updatedKeys.length
      );
      const errors: string[] = [];
      if (createResult.headerNoteFailureCount > 0) errors.push(`${createResult.headerNoteFailureCount} header note save${createResult.headerNoteFailureCount === 1 ? "" : "s"} failed, but row details were created.`);
      if (updateResult.sharedSkipped > 0) errors.push(`${updateResult.sharedSkipped} shared batch row${updateResult.sharedSkipped === 1 ? "" : "s"} skipped.`);
      if (updateResult.staleSkipped > 0) errors.push(`${updateResult.staleSkipped} stale/source-changed row${updateResult.staleSkipped === 1 ? "" : "s"} skipped.`);
      if (updateResult.unsafeSkipped > 0) errors.push(`${updateResult.unsafeSkipped} unsafe row${updateResult.unsafeSkipped === 1 ? "" : "s"} skipped.`);
      if (updateResult.headerNoteFailureCount > 0) errors.push(`${updateResult.headerNoteFailureCount} updated header note save${updateResult.headerNoteFailureCount === 1 ? "" : "s"} failed, but workout rows were updated.`);
      setLastApplySummary({
        title: "Apply Safe Changes",
        created: createResult.createdKeys.length,
        updated: updateResult.updatedKeys.length,
        skipped,
        conflicts: finalFreshRows.filter((row) => row.status === "conflict").length + updateResult.sharedSkipped + updateResult.staleSkipped + updateResult.unsafeSkipped,
        errors,
      });
      setApplyPreviewError(null);
    } catch (error: any) {
      setApplyPreviewError(String(error?.message ?? "Could not apply safe changes."));
    } finally {
      setApplySafeLoading(false);
    }
  }, [
    buildFreshApplyPreviewRows,
    clearAppliedDraftKeys,
    commitEditingFields,
    confirmApplySafeChanges,
    createSafeNewDraftRows,
    getApplyScopeRange,
    loadFreshExistingCellIndex,
    refreshExistingWorkoutOverlay,
    store,
    updateSafeExistingDraftRows,
  ]);

  const openApplyPreview = useCallback(async () => {
    await commitEditingFields();
    const startISO = dateRows[0] ?? firstWeekStartISO;
    const endISO = dateRows[dateRows.length - 1] ?? addDaysISO(firstWeekStartISO, Math.max(0, weekCount * 7 - 1));
    setApplyPreviewScope("entire");
    setApplyPreviewStartISO(startISO);
    setApplyPreviewEndISO(endISO);
    setApplyPreviewRows([]);
    setApplyPreviewError(null);
    setLastApplySummary(null);
    setApplyPreviewFilter("all");
    setApplyPreviewOpen(true);
  }, [commitEditingFields, dateRows, firstWeekStartISO, weekCount]);

  const applyActionBusy = applyNewLoading || applyUpdateLoading || applySafeLoading || applyPreviewLoading;

  if (readOnlyPlanBuilder) {
    return (
      <View style={{ flex: 1, backgroundColor: "#f3f0e8" }}>
        <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <View>
              <Text style={{ fontSize: 28, fontWeight: "900", color: "#1f2933" }}>Workout Plan Builder</Text>
              <Text style={{ marginTop: 4, color: "#64748b", fontWeight: "700" }}>
                Viewer access: editing is disabled.
              </Text>
            </View>
            <Pressable
              onPress={() => router.push("/(coach)/(tabs)/calendar")}
              style={{ borderWidth: 1, borderColor: "#d6d3c8", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: "#fffaf0" }}
            >
              <Text style={{ fontWeight: "900", color: "#334155" }}>Back to Calendar</Text>
            </Pressable>
          </View>
          <View style={{ borderWidth: 1, borderColor: "#cbd5e1", backgroundColor: "#f8fafc", borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 14, fontWeight: "900", color: "#334155" }}>
              Plan builder edits are available to Owners and Editors.
            </Text>
            <Text style={{ marginTop: 4, color: "#64748b", fontWeight: "700" }}>
              View existing training from Calendar, Daily Workouts, Mileage, Roster, and Training Logs.
            </Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#f3f0e8" }}>
      <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <View>
            <Text style={{ fontSize: 28, fontWeight: "900", color: "#1f2933" }}>Workout Plan Builder</Text>
            <Text style={{ marginTop: 4, color: "#64748b", fontWeight: "700" }}>
              Draft matrix for fast long-range planning.
            </Text>
          </View>
          <Pressable
            onPress={async () => {
              await commitEditingFields();
              router.push("/(coach)/(tabs)/planner");
            }}
            style={{ borderWidth: 1, borderColor: "#d6d3c8", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: "#fffaf0" }}
          >
            <Text style={{ fontWeight: "900", color: "#334155" }}>Back to Planner</Text>
          </Pressable>
        </View>

        <View style={{ borderWidth: 1, borderColor: "#f0c36a", backgroundColor: "#fff7dd", borderRadius: 18, padding: 14 }}>
          <Text style={{ fontSize: 14, fontWeight: "900", color: "#7c4a03" }}>
            Draft only - does not update Calendar yet.
          </Text>
          <Text style={{ marginTop: 4, color: "#7c4a03", fontWeight: "700" }}>
            This screen saves isolated plan drafts only. It does not create workout batches, change mileage, or alter exports.
          </Text>
        </View>

        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <View style={{ minWidth: 220 }}>
            <Text style={{ fontSize: 12, fontWeight: "900", color: "#475569", marginBottom: 6 }}>Athlete</Text>
            <Pressable onPress={() => setAthletePickerOpen(true)} style={controlStyle}>
              <Text style={controlTextStyle}>{selectedAthlete ? rosterRowDisplayName(selectedAthlete) : "Select athlete"}</Text>
            </Pressable>
          </View>
          <View style={{ minWidth: 220 }}>
            <Text style={{ fontSize: 12, fontWeight: "900", color: "#475569", marginBottom: 6 }}>Season</Text>
            <Pressable onPress={() => setSeasonPickerOpen(true)} style={controlStyle}>
              <Text style={controlTextStyle}>{selectedSeason?.name || "Custom / no season"}</Text>
            </Pressable>
          </View>
          <View style={{ minWidth: 160 }}>
            <Text style={{ fontSize: 12, fontWeight: "900", color: "#475569", marginBottom: 6 }}>First week</Text>
            <Pressable onPress={() => void openFirstWeekPicker()} style={controlStyle}>
              <Text style={controlTextStyle}>Week of {formatDateShort(firstWeekStartISO)}</Text>
              <Text style={{ marginTop: 2, color: "#64748b", fontSize: 11, fontWeight: "700" }}>
                {firstWeekStartISO}
              </Text>
            </Pressable>
          </View>
          <View style={{ width: 130 }}>
            <Text style={{ fontSize: 12, fontWeight: "900", color: "#475569", marginBottom: 6 }}>Weeks</Text>
            <TextInput
              value={weekCountInput}
              onChangeText={updateWeekCount}
              onBlur={() => setWeekCountInput(String(weekCount))}
              keyboardType="number-pad"
              style={inputStyle}
            />
          </View>
          <Pressable
            onPress={applySeasonRange}
            disabled={!selectedAthlete || !selectedSeason}
            style={[secondaryButtonStyle, (!selectedAthlete || !selectedSeason) && { opacity: 0.45 }]}
          >
            <Text style={secondaryButtonTextStyle}>Use Season Range</Text>
          </Pressable>
          <Pressable
            onPress={() => void openApplyPreview()}
            disabled={!selectedAthleteId}
            style={[primaryButtonStyle, !selectedAthleteId && { opacity: 0.45 }]}
          >
            <Text style={primaryButtonTextStyle}>Preview Apply...</Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Text style={{ fontWeight: "900", color: "#334155" }}>Range: {visibleRangeLabel}</Text>
          <Text style={{ color: "#64748b", fontWeight: "700" }}>Draft cells: {draftCellCount}</Text>
          <Text style={{ color: saveState === "error" ? "#b91c1c" : "#64748b", fontWeight: "800" }}>
            {saveState === "dirty" ? "Unsaved cell edit" : saveState === "saving" ? "Saving draft..." : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Draft save failed" : "Draft ready"}
          </Text>
          <Text style={{ color: existingWorkoutsError ? "#b91c1c" : "#64748b", fontWeight: "800" }}>
            {existingWorkoutsLoading ? "Loading existing workouts..." : existingWorkoutsError ? existingWorkoutsError : "Existing workouts overlay ready"}
          </Text>
          {activeGridId === PLAN_BUILDER_GRID_ID ? (
            <>
              <Pressable
                style={miniButtonStyle}
                onPress={async () => {
                  setActiveGridId(PLAN_BUILDER_GRID_ID);
                  void copyPlanBuilderSelection();
                }}
              >
                <Text style={miniButtonTextStyle}>Copy</Text>
              </Pressable>
              <Pressable
                style={miniButtonStyle}
                onPress={async () => {
                  void pastePlanBuilderSelection();
                }}
              >
                <Text style={miniButtonTextStyle}>Paste</Text>
              </Pressable>
              <Pressable
                style={miniButtonStyle}
                onPress={async () => {
                  await commitEditingFields();
                  setActiveGridId(PLAN_BUILDER_GRID_ID);
                  grid.undo();
                }}
              >
                <Text style={miniButtonTextStyle}>Undo</Text>
              </Pressable>
            </>
          ) : null}
        </View>

        <View style={{ borderWidth: 1, borderColor: "#d8d2c4", borderRadius: 14, overflow: "hidden", backgroundColor: "#fffdf7", width: "100%" }}>
          <View style={{ flexDirection: "row", backgroundColor: "#ede7d8" }}>
            <View style={dateHeaderCellStyle}>
              <Text style={headerTextStyle}>Date</Text>
            </View>
            <View style={dayHeaderCellStyle}>
              <Text style={headerTextStyle}>Day</Text>
            </View>
            <View style={sessionHeaderCellStyle}>
              <Text style={headerTextStyle}>AM</Text>
            </View>
            <View style={sessionHeaderCellStyle}>
              <Text style={headerTextStyle}>PM</Text>
            </View>
            <View style={metadataHeaderCellStyle}>
              <Text style={headerTextStyle}>Tags</Text>
            </View>
          </View>
          {dateRows.map((dateISO, rowIndex) => {
            const weekIndex = Math.floor(rowIndex / 7);
            const isAlternateWeek = weekIndex % 2 === 1;
            const isWeekStartRow = rowIndex % 7 === 0;
            const isCurrentWeek = getWeekStartISO(dateISO, weekStartsOn) === currentWeekStartISO;
            const weekTopBorderColor = isWeekStartRow && rowIndex > 0 ? "#cfc5b2" : "#e5dccb";
            const metadataSummary = buildRowMetadataSummary(dateISO);
            return (
            <View
              key={dateISO}
              style={{
                flexDirection: "row",
                borderTopWidth: isWeekStartRow && rowIndex > 0 ? 2 : 1,
                borderTopColor: weekTopBorderColor,
                width: "100%",
              }}
            >
              <View style={[dateBodyCellStyle, isAlternateWeek && alternateDateCellStyle, isCurrentWeek && currentWeekDateCellStyle]}>
                <Text style={{ fontWeight: "900", color: "#1f2933" }}>{formatDateShort(dateISO)}</Text>
                {isCurrentWeek && isWeekStartRow ? (
                  <View style={currentWeekPillStyle}>
                    <Text style={currentWeekPillTextStyle}>Current</Text>
                  </View>
                ) : null}
              </View>
              <View style={[dayBodyCellStyle, isAlternateWeek && alternateDateCellStyle, isCurrentWeek && currentWeekDateCellStyle]}>
                <Text style={{ fontWeight: "800", color: "#64748b" }}>{formatDayShort(dateISO)}</Text>
              </View>
              {colKeys.map((colKey) => {
                const selected = grid.isCellSelected(dateISO, colKey);
                const active = grid.isCellActive(dateISO, colKey);
                const draftCell = getDraftCell(activeDraft, selectedAthleteId, dateISO, colKey);
                const existingCell = existingCellsByKey[cellKey(dateISO, colKey)] ?? null;
                const cell = getDisplayCell(dateISO, colKey);
                const cellState = resolveCellState({ draftCell, existingCell });
                const statusLabel = cellStatusLabel(cellState);
                const isConflict = cellState === "conflict";
                const binding = bindPlanCell(dateISO, colKey);
                const bindProps = Platform.OS === "web"
                  ? ({ ref: binding.ref, tabIndex: 0, ...binding.handlers } as any)
                  : {};
                const handleEditorKeyDown = (event: any, field: PlanBuilderEditingField) => {
                  const key = String(event?.key ?? event?.nativeEvent?.key ?? "");
                  const shift = !!(event?.shiftKey ?? event?.nativeEvent?.shiftKey);
                  if (key === "Tab") {
                    event?.preventDefault?.();
                    commitSessionField(dateISO, colKey, field);
                    setFocusedEditorKey(null);
                    grid.moveActiveBy(shift ? -1 : 1, 0);
                    return;
                  }
                  if (field === "title" && key === "Enter") {
                    event?.preventDefault?.();
                    commitSessionField(dateISO, colKey, field);
                    setFocusedEditorKey(null);
                    grid.moveActiveBy(0, 1);
                    return;
                  }
                  if (field === "details" && key === "Enter" && !shift) {
                    event?.preventDefault?.();
                    commitSessionField(dateISO, colKey, field);
                    setFocusedEditorKey(null);
                    grid.moveActiveBy(0, 1);
                  }
                };
                return (
                  <View
                    key={`${dateISO}:${colKey}`}
                    {...bindProps}
                    style={[
                      sessionBodyCellStyle,
                      isAlternateWeek && alternateSessionCellStyle,
                      isCurrentWeek && currentWeekSessionCellStyle,
                      selected && { backgroundColor: "#eff6ff" },
                      active && { borderColor: "#2563eb", borderWidth: 2 },
                      cellState === "changed" && changedCellStyle,
                      cellState === "new" && newDraftCellStyle,
                      cellState === "conflict" && conflictCellStyle,
                    ]}
                  >
                    {statusLabel ? (
                      <View style={[statusPillStyle, statusPillStyleByState[cellState] ?? null]}>
                        <Text style={[statusPillTextStyle, statusPillTextStyleByState[cellState] ?? null]}>{statusLabel}</Text>
                      </View>
                    ) : null}
                    {isConflict ? (
                      <View style={conflictMessageStyle}>
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#92400e" }}>
                          Multiple workouts - edit in Daily Workouts.
                        </Text>
                        <Text style={{ marginTop: 4, fontSize: 11, fontWeight: "700", color: "#a16207" }}>
                          {existingCell?.rows.map((row) => String(row.title ?? "Workout").trim() || "Workout").join(" • ")}
                        </Text>
                      </View>
                    ) : (
                      <>
                        <TextInput
                          value={String(cell?.title ?? "")}
                          onChangeText={(value) => setSessionTitle(dateISO, colKey, value)}
                          onBlur={() => {
                            setFocusedEditorKey((current) => (current === editingFieldKey(selectedAthleteId, dateISO, colKey, "title") ? null : current));
                            commitSessionField(dateISO, colKey, "title");
                          }}
                          onSubmitEditing={() => commitSessionField(dateISO, colKey, "title")}
                          onFocus={() => {
                            setActiveGridId(PLAN_BUILDER_GRID_ID);
                            setFocusedEditorKey(editingFieldKey(selectedAthleteId, dateISO, colKey, "title"));
                          }}
                          {...(Platform.OS === "web" ? ({ onKeyDown: (event: any) => handleEditorKeyDown(event, "title") } as any) : null)}
                          {...(Platform.OS === "web" ? ({ onMouseDown: (event: any) => event.stopPropagation?.() } as any) : null)}
                          {...(Platform.OS === "web" ? ({ onPaste: stopTextFieldClipboardPropagation, onCopy: stopTextFieldClipboardPropagation, onCut: stopTextFieldClipboardPropagation } as any) : null)}
                          placeholder={`${colKey} title`}
                          placeholderTextColor="#9ca3af"
                          style={sessionTitleInputStyle}
                        />
                        <TextInput
                          value={String(cell?.details ?? "")}
                          onChangeText={(value) => setSessionDetails(dateISO, colKey, value)}
                          onBlur={() => {
                            setFocusedEditorKey((current) => (current === editingFieldKey(selectedAthleteId, dateISO, colKey, "details") ? null : current));
                            commitSessionField(dateISO, colKey, "details");
                          }}
                          onFocus={() => {
                            setActiveGridId(PLAN_BUILDER_GRID_ID);
                            setFocusedEditorKey(editingFieldKey(selectedAthleteId, dateISO, colKey, "details"));
                          }}
                          {...(Platform.OS === "web" ? ({ onKeyDown: (event: any) => handleEditorKeyDown(event, "details") } as any) : null)}
                          {...(Platform.OS === "web" ? ({ onMouseDown: (event: any) => event.stopPropagation?.() } as any) : null)}
                          {...(Platform.OS === "web" ? ({ onPaste: stopTextFieldClipboardPropagation, onCopy: stopTextFieldClipboardPropagation, onCut: stopTextFieldClipboardPropagation } as any) : null)}
                          placeholder="Workout notes"
                          placeholderTextColor="#9ca3af"
                          multiline
                          numberOfLines={3}
                          style={sessionDetailsInputStyle}
                        />
                      </>
                    )}
                  </View>
                );
              })}
              <Pressable
                onPress={async () => {
                  await commitEditingFields();
                  setMetadataEditorDateISO(dateISO);
                }}
                style={[
                  metadataBodyCellStyle,
                  isAlternateWeek && alternateSessionCellStyle,
                  isCurrentWeek && currentWeekSessionCellStyle,
                ]}
              >
                {metadataSummary ? (
                  <Text style={metadataSummaryTextStyle}>{metadataSummary}</Text>
                ) : (
                  <Text style={metadataPlaceholderTextStyle}>Add tags</Text>
                )}
              </Pressable>
            </View>
            );
          })}
        </View>
      </ScrollView>

      <Modal visible={athletePickerOpen} transparent animationType="fade" onRequestClose={() => setAthletePickerOpen(false)}>
        <Pressable style={modalBackdropStyle} onPress={() => setAthletePickerOpen(false)}>
          <Pressable style={modalCardStyle} onPress={(event) => event.stopPropagation()}>
            <Text style={modalTitleStyle}>Select Athlete</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {roster.map((athlete) => (
                <Pressable
                  key={athlete.id}
                  onPress={async () => {
                    await commitEditingFields();
                    setSelectedAthleteId(athlete.id);
                    setAthletePickerOpen(false);
                  }}
                  style={[pickerRowStyle, selectedAthleteId === athlete.id && { backgroundColor: "#eff6ff" }]}
                >
                  <Text style={{ fontWeight: "900", color: "#1f2933" }}>{selectedAthleteId === athlete.id ? "✓ " : ""}{rosterRowDisplayName(athlete)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={seasonPickerOpen} transparent animationType="fade" onRequestClose={() => setSeasonPickerOpen(false)}>
        <Pressable style={modalBackdropStyle} onPress={() => setSeasonPickerOpen(false)}>
          <Pressable style={modalCardStyle} onPress={(event) => event.stopPropagation()}>
            <Text style={modalTitleStyle}>Select Season</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              <Pressable
                onPress={async () => {
                  await commitEditingFields();
                  setSelectedSeasonId(null);
                  patchActiveDraft({ seasonId: null, rangeMode: "custom" });
                  setSeasonPickerOpen(false);
                }}
                style={[pickerRowStyle, !selectedSeasonId && { backgroundColor: "#eff6ff" }]}
              >
                <Text style={{ fontWeight: "900", color: "#1f2933" }}>{!selectedSeasonId ? "✓ " : ""}Custom / no season</Text>
              </Pressable>
              {seasons.map((season) => (
                <Pressable
                  key={String(season.id)}
                  onPress={async () => {
                    await commitEditingFields();
                    const id = String(season.id ?? "").trim();
                    setSelectedSeasonId(id);
                    const currentMode = activeDraftRef.current?.rangeMode ?? "custom";
                    if (currentMode === "season") {
                      const range = getResolvedSeasonWeekRange(selectedAthlete, season);
                      if (range) {
                        setFirstWeekInput(range.firstWeekStartISO);
                        setWeekCountInput(String(range.numberOfWeeks));
                        patchActiveDraft({
                          seasonId: id,
                          rangeMode: "season",
                          firstWeekStartISO: range.firstWeekStartISO,
                          numberOfWeeks: range.numberOfWeeks,
                        });
                      } else {
                        patchActiveDraft({ seasonId: id, rangeMode: "season" });
                      }
                    } else {
                      patchActiveDraft({ seasonId: id, rangeMode: "custom" });
                    }
                    setSeasonPickerOpen(false);
                  }}
                  style={[pickerRowStyle, selectedSeasonId === String(season.id) && { backgroundColor: "#eff6ff" }]}
                >
                  <Text style={{ fontWeight: "900", color: "#1f2933" }}>{selectedSeasonId === String(season.id) ? "✓ " : ""}{season.name}</Text>
                  <Text style={{ marginTop: 3, color: "#64748b", fontWeight: "700" }}>
                    {season.start_date} - {season.end_date}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={firstWeekPickerOpen} transparent animationType="fade" onRequestClose={closeFirstWeekPicker}>
        <Pressable style={modalBackdropStyle} onPress={closeFirstWeekPicker}>
          <Pressable style={[modalCardStyle, { maxWidth: 420 }]} onPress={(event) => event.stopPropagation()}>
            <Text style={modalTitleStyle}>Select First Week</Text>
            <Text style={{ marginBottom: 12, color: "#64748b", fontWeight: "700" }}>
              Pick any date in the week you want to start with. The builder will snap it to the configured week start.
            </Text>
            {Platform.OS === "web" ? (
              <input
                type="date"
                value={firstWeekPickerDraftDate}
                onChange={(event) => {
                  setFirstWeekPickerDraftDate(String((event.target as HTMLInputElement)?.value ?? "").trim());
                  if (firstWeekPickerError) setFirstWeekPickerError(null);
                }}
                style={{
                  width: "100%",
                  minHeight: 42,
                  border: "1px solid #d6d3c8",
                  borderRadius: 12,
                  padding: "9px 10px",
                  fontSize: 14,
                  fontWeight: 800,
                  color: "#1f2933",
                  backgroundColor: "#fffdf7",
                }}
              />
            ) : (
              <TextInput
                value={firstWeekPickerDraftDate}
                onChangeText={(value) => {
                  setFirstWeekPickerDraftDate(value);
                  if (firstWeekPickerError) setFirstWeekPickerError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="YYYY-MM-DD"
                style={inputStyle}
              />
            )}
            {isDateISO(firstWeekPickerDraftDate) ? (
              <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "800" }}>
                Will use week of {formatDateShort(getWeekStartISO(firstWeekPickerDraftDate, weekStartsOn))}.
              </Text>
            ) : null}
            {firstWeekPickerError ? (
              <Text style={{ marginTop: 8, color: "#b91c1c", fontWeight: "800" }}>{firstWeekPickerError}</Text>
            ) : null}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <Pressable
                onPress={() => {
                  setFirstWeekPickerDraftDate(getWeekStartISO(toISODate(new Date()), weekStartsOn));
                  setFirstWeekPickerError(null);
                }}
                style={secondaryButtonStyle}
              >
                <Text style={secondaryButtonTextStyle}>Current week</Text>
              </Pressable>
              <Pressable onPress={closeFirstWeekPicker} style={secondaryButtonStyle}>
                <Text style={secondaryButtonTextStyle}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void confirmFirstWeekPicker()} style={primaryButtonStyle}>
                <Text style={primaryButtonTextStyle}>Use Date</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={!!metadataEditorDateISO}
        transparent
        animationType="fade"
        onRequestClose={() => setMetadataEditorDateISO(null)}
      >
        <Pressable style={modalBackdropStyle} onPress={() => setMetadataEditorDateISO(null)}>
          <Pressable style={[modalCardStyle, { maxWidth: 760 }]} onPress={(event) => event.stopPropagation()}>
            <Text style={modalTitleStyle}>
              Tags / Metadata {metadataEditorDateISO ? `• ${formatDateShort(metadataEditorDateISO)}` : ""}
            </Text>
            <Text style={{ marginBottom: 12, color: "#64748b", fontWeight: "700" }}>
              Tags are draft-only. They are saved with this plan draft and do not update Calendar.
            </Text>
            <ScrollView style={{ maxHeight: 520 }} keyboardShouldPersistTaps="handled">
              {metadataEditorDateISO
                ? colKeys.map((session) => {
                    const existingCell = existingCellsByKey[cellKey(metadataEditorDateISO, session)] ?? null;
                    const draftCell = getDraftCell(activeDraft, selectedAthleteId, metadataEditorDateISO, session);
                    const state = resolveCellState({ draftCell, existingCell });
                    const cell = getDisplayCell(metadataEditorDateISO, session);
                    const selectedCategoryIds = normalizeStringList(cell?.categoryIds);
                    const selectedPreRoutineIds = normalizeStringList(cell?.preRoutineIds);
                    const selectedPostRoutineIds = normalizeStringList(cell?.postRoutineIds);
                    return (
                      <View key={`metadata-${session}`} style={metadataSessionCardStyle}>
                        <Text style={{ fontSize: 15, fontWeight: "900", color: "#1f2933", marginBottom: 10 }}>
                          {session}
                        </Text>

                        {state === "conflict" ? (
                          <View style={conflictMessageStyle}>
                            <Text style={{ fontSize: 12, fontWeight: "900", color: "#92400e" }}>
                              Multiple workouts in this {session} slot. Edit tags in Daily Workouts.
                            </Text>
                          </View>
                        ) : (
                          <>

                        <Text style={metadataSectionLabelStyle}>Categories</Text>
                        {categories.length ? (
                          <View style={metadataChipWrapStyle}>
                            {categories.map((category) => {
                              const id = String(category.id ?? "").trim();
                              const selected = selectedCategoryIds.includes(id);
                              return (
                                <Pressable
                                  key={`${session}-category-${id}`}
                                  onPress={() => toggleSessionListValue(metadataEditorDateISO, session, "categoryIds", id)}
                                  style={[metadataChipStyle, selected && metadataChipSelectedStyle]}
                                >
                                  <Text style={[metadataChipTextStyle, selected && metadataChipSelectedTextStyle]}>
                                    {selected ? "✓ " : ""}{categoryDisplayName(category)}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        ) : (
                          <Text style={metadataEmptyTextStyle}>No categories configured yet.</Text>
                        )}

                        <Text style={metadataSectionLabelStyle}>Pre-routines</Text>
                        {auxiliaryRoutines.length ? (
                          <View style={metadataChipWrapStyle}>
                            {auxiliaryRoutines.map((routine) => {
                              const id = String(routine.id ?? "").trim();
                              const selected = selectedPreRoutineIds.includes(id);
                              return (
                                <Pressable
                                  key={`${session}-pre-${id}`}
                                  onPress={() => toggleSessionListValue(metadataEditorDateISO, session, "preRoutineIds", id)}
                                  style={[metadataChipStyle, selected && metadataChipSelectedStyle]}
                                >
                                  <Text style={[metadataChipTextStyle, selected && metadataChipSelectedTextStyle]}>
                                    {selected ? "✓ " : ""}{routine.title}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        ) : (
                          <Text style={metadataEmptyTextStyle}>No routines configured yet.</Text>
                        )}

                        <Text style={metadataSectionLabelStyle}>Post-routines</Text>
                        {auxiliaryRoutines.length ? (
                          <View style={metadataChipWrapStyle}>
                            {auxiliaryRoutines.map((routine) => {
                              const id = String(routine.id ?? "").trim();
                              const selected = selectedPostRoutineIds.includes(id);
                              return (
                                <Pressable
                                  key={`${session}-post-${id}`}
                                  onPress={() => toggleSessionListValue(metadataEditorDateISO, session, "postRoutineIds", id)}
                                  style={[metadataChipStyle, selected && metadataChipSelectedStyle]}
                                >
                                  <Text style={[metadataChipTextStyle, selected && metadataChipSelectedTextStyle]}>
                                    {selected ? "✓ " : ""}{routine.title}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        ) : (
                          <Text style={metadataEmptyTextStyle}>No routines configured yet.</Text>
                        )}
                          </>
                        )}
                      </View>
                    );
                  })
                : null}
            </ScrollView>
            <Pressable onPress={() => setMetadataEditorDateISO(null)} style={[secondaryButtonStyle, { alignSelf: "flex-end", marginTop: 12 }]}>
              <Text style={secondaryButtonTextStyle}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={applyPreviewOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setApplyPreviewOpen(false)}
      >
        <Pressable style={modalBackdropStyle} onPress={() => setApplyPreviewOpen(false)}>
          <Pressable style={[modalCardStyle, { maxWidth: 920 }]} onPress={(event) => event.stopPropagation()}>
            <Text style={modalTitleStyle}>Apply Preview</Text>
            <View style={previewWarningStyle}>
              <Text style={{ color: "#7c4a03", fontWeight: "900" }}>
                Preview first - imports are limited and explicit.
              </Text>
              <Text style={{ marginTop: 3, color: "#7c4a03", fontWeight: "700" }}>
                Apply Safe Changes creates new workouts and updates safe existing single-athlete workouts. Conflicts, shared batches, cleared drafts, deletes, and unchanged rows are skipped.
              </Text>
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginTop: 12 }}>
              <View>
                <Text style={{ fontSize: 12, fontWeight: "900", color: "#475569", marginBottom: 6 }}>Scope</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {(["entire", "range"] as ApplyPreviewScope[]).map((scope) => (
                    <Pressable
                      key={scope}
                      onPress={() => setApplyPreviewScope(scope)}
                      style={[scopeButtonStyle, applyPreviewScope === scope && scopeButtonActiveStyle]}
                    >
                      <Text style={[scopeButtonTextStyle, applyPreviewScope === scope && scopeButtonTextActiveStyle]}>
                        {scope === "entire" ? "Entire planner" : "Date range"}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {applyPreviewScope === "range" ? (
                <>
                  <View style={{ width: 150 }}>
                    <Text style={{ fontSize: 12, fontWeight: "900", color: "#475569", marginBottom: 6 }}>Start</Text>
                    <TextInput
                      value={applyPreviewStartISO}
                      onChangeText={setApplyPreviewStartISO}
                      placeholder="YYYY-MM-DD"
                      style={inputStyle}
                    />
                  </View>
                  <View style={{ width: 150 }}>
                    <Text style={{ fontSize: 12, fontWeight: "900", color: "#475569", marginBottom: 6 }}>End</Text>
                    <TextInput
                      value={applyPreviewEndISO}
                      onChangeText={setApplyPreviewEndISO}
                      placeholder="YYYY-MM-DD"
                      style={inputStyle}
                    />
                  </View>
                </>
              ) : null}

              <Pressable
                onPress={() => void generateApplyPreview()}
                disabled={applyPreviewLoading}
                style={[primaryButtonStyle, applyPreviewLoading && { opacity: 0.55 }]}
              >
                <Text style={primaryButtonTextStyle}>
                  {applyPreviewLoading ? "Generating..." : "Generate Preview"}
                </Text>
              </Pressable>
            </View>

            {applyPreviewError ? (
              <Text style={{ marginTop: 10, color: "#b91c1c", fontWeight: "800" }}>{applyPreviewError}</Text>
            ) : null}

            {lastApplySummary ? (
              <View style={applySummaryBoxStyle}>
                <Text style={applySummaryTitleStyle}>{lastApplySummary.title} summary</Text>
                <View style={applySummaryCountsStyle}>
                  <Text style={applySummaryCountTextStyle}>Created: {lastApplySummary.created}</Text>
                  <Text style={applySummaryCountTextStyle}>Updated: {lastApplySummary.updated}</Text>
                  <Text style={applySummaryCountTextStyle}>Skipped: {lastApplySummary.skipped}</Text>
                  <Text style={applySummaryCountTextStyle}>Conflicts: {lastApplySummary.conflicts}</Text>
                </View>
                {lastApplySummary.errors.length > 0 ? (
                  <View style={{ marginTop: 6, gap: 3 }}>
                    {lastApplySummary.errors.map((error, idx) => (
                      <Text key={`apply-summary-error-${idx}`} style={applySummaryErrorTextStyle}>
                        {error}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}

            {applyPreviewRows.length > 0 ? (
              <>
                <View style={previewCountsWrapStyle}>
                  {(["new", "update", "unchanged", "conflict", "cleared"] as ApplyPreviewStatus[]).map((status) => (
                    <View key={status} style={[previewCountPillStyle, previewStatusPillStyleByStatus[status] ?? null]}>
                      <Text style={[previewCountTextStyle, previewStatusTextStyleByStatus[status] ?? null]}>
                        {previewStatusLabel(status)}: {applyPreviewCounts[status]}
                      </Text>
                    </View>
                  ))}
                </View>
                <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "800" }}>
                  New to create: {applyPreviewCounts.new} • Updates available: {applyPreviewCounts.update} • Conflicts skipped: {applyPreviewCounts.conflict} • Cleared skipped: {applyPreviewCounts.cleared} • Unchanged skipped: {applyPreviewCounts.unchanged}
                </Text>
                <View style={previewFilterWrapStyle}>
                  {(["all", "new", "update", "conflict", "skipped"] as ApplyPreviewFilter[]).map((filter) => {
                    const selected = applyPreviewFilter === filter;
                    return (
                      <Pressable
                        key={filter}
                        onPress={() => setApplyPreviewFilter(filter)}
                        style={[previewFilterButtonStyle, selected && previewFilterButtonActiveStyle]}
                      >
                        <Text style={[previewFilterTextStyle, selected && previewFilterTextActiveStyle]}>
                          {previewFilterLabel(filter)} ({applyPreviewFilterCounts[filter]})
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <ScrollView style={{ marginTop: 10, maxHeight: 440 }} horizontal={false}>
                  <View style={previewTableStyle}>
                    <View style={[previewRowStyle, previewHeaderRowStyle]}>
                      <Text style={[previewHeaderTextStyle, { width: 92 }]}>Date</Text>
                      <Text style={[previewHeaderTextStyle, { width: 56 }]}>Day</Text>
                      <Text style={[previewHeaderTextStyle, { width: 70 }]}>Session</Text>
                      <Text style={[previewHeaderTextStyle, { flex: 1 }]}>Draft title</Text>
                      <Text style={[previewHeaderTextStyle, { flex: 1 }]}>Existing title</Text>
                      <Text style={[previewHeaderTextStyle, { width: 100 }]}>Status</Text>
                      <Text style={[previewHeaderTextStyle, { flex: 1.2 }]}>Reason</Text>
                    </View>
                    {filteredApplyPreviewRows.map((row) => (
                      <View key={row.id} style={previewRowStyle}>
                        <Text style={[previewCellTextStyle, { width: 92 }]}>{formatDateShort(row.dateISO)}</Text>
                        <Text style={[previewCellTextStyle, { width: 56 }]}>{row.dayLabel}</Text>
                        <Text style={[previewCellTextStyle, { width: 70 }]}>{row.session}</Text>
                        <Text style={[previewCellTextStyle, { flex: 1 }]} numberOfLines={2}>{row.draftTitle || "-"}</Text>
                        <Text style={[previewCellTextStyle, { flex: 1 }]} numberOfLines={2}>{row.existingTitle || "-"}</Text>
                        <View style={{ width: 100 }}>
                          <View style={[previewStatusPillStyle, previewStatusPillStyleByStatus[row.status] ?? null]}>
                            <Text style={[previewStatusTextStyle, previewStatusTextStyleByStatus[row.status] ?? null]}>
                              {previewStatusLabel(row.status)}
                            </Text>
                          </View>
                        </View>
                        <Text style={[previewCellTextStyle, { flex: 1.2 }]}>{row.reason}</Text>
                      </View>
                    ))}
                    {filteredApplyPreviewRows.length === 0 ? (
                      <View style={previewRowStyle}>
                        <Text style={[previewCellTextStyle, { flex: 1 }]}>No rows match this filter.</Text>
                      </View>
                    ) : null}
                  </View>
                </ScrollView>
              </>
            ) : (
              <Text style={{ marginTop: 14, color: "#64748b", fontWeight: "700" }}>
                Generate a preview to see what would be created, updated, skipped, or flagged for review.
              </Text>
            )}

            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
              <Pressable onPress={() => setApplyPreviewOpen(false)} style={secondaryButtonStyle}>
                <Text style={secondaryButtonTextStyle}>Close</Text>
              </Pressable>
              <Pressable
                onPress={() => void applyNewDraftWorkouts()}
                disabled={applyActionBusy}
                style={[secondaryButtonStyle, applyActionBusy && { opacity: 0.55 }]}
              >
                <Text style={secondaryButtonTextStyle}>
                  {applyNewLoading ? "Creating..." : "Import New Only"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void applySafeExistingUpdates()}
                disabled={applyActionBusy}
                style={[secondaryButtonStyle, applyActionBusy && { opacity: 0.55 }]}
              >
                <Text style={secondaryButtonTextStyle}>
                  {applyUpdateLoading ? "Updating..." : "Update Safe Existing"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void applySafeChanges()}
                disabled={applyActionBusy}
                style={[primaryButtonStyle, applyActionBusy && { opacity: 0.55 }]}
              >
                <Text style={primaryButtonTextStyle}>
                  {applySafeLoading ? "Applying..." : "Apply Safe Changes"}
                </Text>
              </Pressable>
            </View>
            <Text style={{ marginTop: 8, color: "#64748b", fontSize: 12, fontWeight: "700", textAlign: "right" }}>
              Imported workouts are hidden from athletes until published. Safe existing single-athlete updates keep their current visibility.
            </Text>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const controlStyle = {
  borderWidth: 1,
  borderColor: "#d6d3c8",
  backgroundColor: "#fffdf7",
  borderRadius: 14,
  paddingHorizontal: 12,
  paddingVertical: 11,
} as const;

const controlTextStyle = {
  fontWeight: "900" as const,
  color: "#1f2933",
};

const inputStyle = {
  borderWidth: 1,
  borderColor: "#d6d3c8",
  backgroundColor: "#fffdf7",
  borderRadius: 14,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontWeight: "900" as const,
  color: "#1f2933",
};

const secondaryButtonStyle = {
  borderWidth: 1,
  borderColor: "#0f766e",
  backgroundColor: "#ecfdf5",
  borderRadius: 14,
  paddingHorizontal: 14,
  paddingVertical: 11,
};

const secondaryButtonTextStyle = {
  fontWeight: "900" as const,
  color: "#0f766e",
};

const primaryButtonStyle = {
  borderWidth: 1,
  borderColor: "#1d4ed8",
  backgroundColor: "#eff6ff",
  borderRadius: 14,
  paddingHorizontal: 14,
  paddingVertical: 11,
};

const primaryButtonTextStyle = {
  fontWeight: "900" as const,
  color: "#1d4ed8",
};

const miniButtonStyle = {
  borderWidth: 1,
  borderColor: "#cbd5e1",
  backgroundColor: "#fffdf7",
  borderRadius: 999,
  paddingHorizontal: 11,
  paddingVertical: 6,
};

const miniButtonTextStyle = {
  fontSize: 12,
  fontWeight: "900" as const,
  color: "#334155",
};

const dateHeaderCellStyle = {
  width: 86,
  padding: 10,
  borderRightWidth: 1,
  borderRightColor: "#d8d2c4",
};

const dayHeaderCellStyle = {
  width: 62,
  padding: 10,
  borderRightWidth: 1,
  borderRightColor: "#d8d2c4",
};

const sessionHeaderCellStyle = {
  flex: 1,
  minWidth: 0,
  padding: 10,
  borderRightWidth: 1,
  borderRightColor: "#d8d2c4",
};

const metadataHeaderCellStyle = {
  width: 190,
  padding: 10,
};

const dateBodyCellStyle = {
  width: 86,
  padding: 10,
  borderRightWidth: 1,
  borderRightColor: "#eee3d1",
  backgroundColor: "#faf6ed",
};

const dayBodyCellStyle = {
  width: 62,
  padding: 10,
  borderRightWidth: 1,
  borderRightColor: "#eee3d1",
  backgroundColor: "#faf6ed",
};

const sessionBodyCellStyle = {
  flex: 1,
  minWidth: 0,
  minHeight: 118,
  borderRightWidth: 1,
  borderRightColor: "#eee3d1",
  backgroundColor: "#fffdf7",
  padding: 8,
  gap: 6,
};

const metadataBodyCellStyle = {
  width: 190,
  minHeight: 118,
  padding: 10,
  backgroundColor: "#fffdf7",
  justifyContent: "center" as const,
};

const sessionTitleInputStyle = {
  borderWidth: 1,
  borderColor: "#e1d8c8",
  backgroundColor: "#fffaf0",
  borderRadius: 8,
  paddingHorizontal: 8,
  paddingVertical: 6,
  color: "#1f2933",
  fontSize: 13,
  fontWeight: "900" as const,
  outlineStyle: "none" as any,
};

const sessionDetailsInputStyle = {
  minHeight: 62,
  borderWidth: 1,
  borderColor: "#e7dece",
  backgroundColor: "#fffdf7",
  borderRadius: 8,
  paddingHorizontal: 8,
  paddingVertical: 7,
  color: "#334155",
  fontSize: 12,
  fontWeight: "700" as const,
  lineHeight: 16,
  textAlignVertical: "top" as const,
  outlineStyle: "none" as any,
};

const metadataSummaryTextStyle = {
  color: "#334155",
  fontSize: 11,
  fontWeight: "800" as const,
  lineHeight: 15,
};

const metadataPlaceholderTextStyle = {
  color: "#94a3b8",
  fontSize: 11,
  fontWeight: "800" as const,
};

const statusPillStyle = {
  alignSelf: "flex-start" as const,
  borderRadius: 999,
  paddingHorizontal: 7,
  paddingVertical: 2,
  backgroundColor: "#e2e8f0",
};

const statusPillTextStyle = {
  fontSize: 10,
  fontWeight: "900" as const,
  color: "#475569",
};

const statusPillStyleByState: Partial<Record<PlanBuilderCellState, any>> = {
  existing: { backgroundColor: "#e0f2fe" },
  new: { backgroundColor: "#dcfce7" },
  changed: { backgroundColor: "#fef3c7" },
  cleared: { backgroundColor: "#fee2e2" },
  conflict: { backgroundColor: "#ffedd5" },
};

const statusPillTextStyleByState: Partial<Record<PlanBuilderCellState, any>> = {
  existing: { color: "#0369a1" },
  new: { color: "#15803d" },
  changed: { color: "#92400e" },
  cleared: { color: "#b91c1c" },
  conflict: { color: "#c2410c" },
};

const changedCellStyle = {
  borderColor: "#fbbf24",
};

const newDraftCellStyle = {
  borderColor: "#86efac",
};

const conflictCellStyle = {
  borderColor: "#fed7aa",
  backgroundColor: "#fff7ed",
};

const conflictMessageStyle = {
  borderWidth: 1,
  borderColor: "#fed7aa",
  backgroundColor: "#fff7ed",
  borderRadius: 8,
  padding: 8,
};

const alternateDateCellStyle = {
  backgroundColor: "#f2eee4",
};

const alternateSessionCellStyle = {
  backgroundColor: "#fbf7ee",
};

const currentWeekDateCellStyle = {
  backgroundColor: "#edf7f3",
};

const currentWeekSessionCellStyle = {
  backgroundColor: "#f4fbf8",
};

const currentWeekPillStyle = {
  alignSelf: "flex-start" as const,
  marginTop: 6,
  borderRadius: 999,
  backgroundColor: "#ccefe2",
  paddingHorizontal: 7,
  paddingVertical: 2,
};

const currentWeekPillTextStyle = {
  fontSize: 10,
  fontWeight: "900" as const,
  color: "#0f766e",
};

const metadataSessionCardStyle = {
  borderWidth: 1,
  borderColor: "#e2ddcf",
  backgroundColor: "#fffaf0",
  borderRadius: 14,
  padding: 12,
  marginBottom: 10,
};

const metadataSectionLabelStyle = {
  marginTop: 8,
  marginBottom: 6,
  fontSize: 11,
  fontWeight: "900" as const,
  color: "#64748b",
  textTransform: "uppercase" as const,
  letterSpacing: 0.4,
};

const metadataChipWrapStyle = {
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 7,
};

const metadataChipStyle = {
  borderWidth: 1,
  borderColor: "#d8d2c4",
  backgroundColor: "#fffdf7",
  borderRadius: 999,
  paddingHorizontal: 10,
  paddingVertical: 7,
};

const metadataChipSelectedStyle = {
  borderColor: "#0f766e",
  backgroundColor: "#ecfdf5",
};

const metadataChipTextStyle = {
  fontSize: 12,
  fontWeight: "900" as const,
  color: "#334155",
};

const metadataChipSelectedTextStyle = {
  color: "#0f766e",
};

const metadataEmptyTextStyle = {
  color: "#94a3b8",
  fontSize: 12,
  fontWeight: "800" as const,
};

const previewWarningStyle = {
  borderWidth: 1,
  borderColor: "#f0c36a",
  backgroundColor: "#fff7dd",
  borderRadius: 14,
  padding: 12,
};

const scopeButtonStyle = {
  borderWidth: 1,
  borderColor: "#d8d2c4",
  backgroundColor: "#fffdf7",
  borderRadius: 999,
  paddingHorizontal: 12,
  paddingVertical: 8,
};

const scopeButtonActiveStyle = {
  borderColor: "#1d4ed8",
  backgroundColor: "#eff6ff",
};

const scopeButtonTextStyle = {
  fontSize: 12,
  fontWeight: "900" as const,
  color: "#475569",
};

const scopeButtonTextActiveStyle = {
  color: "#1d4ed8",
};

const previewCountsWrapStyle = {
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 8,
  marginTop: 12,
};

const previewCountPillStyle = {
  borderRadius: 999,
  backgroundColor: "#e2e8f0",
  paddingHorizontal: 10,
  paddingVertical: 6,
};

const previewCountTextStyle = {
  fontSize: 12,
  fontWeight: "900" as const,
  color: "#475569",
};

const previewFilterWrapStyle = {
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 8,
  marginTop: 10,
};

const previewFilterButtonStyle = {
  borderWidth: 1,
  borderColor: "#d8d2c4",
  backgroundColor: "#fffdf7",
  borderRadius: 999,
  paddingHorizontal: 10,
  paddingVertical: 7,
};

const previewFilterButtonActiveStyle = {
  borderColor: "#1d4ed8",
  backgroundColor: "#eff6ff",
};

const previewFilterTextStyle = {
  fontSize: 12,
  fontWeight: "900" as const,
  color: "#475569",
};

const previewFilterTextActiveStyle = {
  color: "#1d4ed8",
};

const applySummaryBoxStyle = {
  borderWidth: 1,
  borderColor: "#bbf7d0",
  backgroundColor: "#f0fdf4",
  borderRadius: 14,
  padding: 12,
  marginTop: 12,
};

const applySummaryTitleStyle = {
  fontSize: 13,
  fontWeight: "900" as const,
  color: "#166534",
};

const applySummaryCountsStyle = {
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 8,
  marginTop: 8,
};

const applySummaryCountTextStyle = {
  fontSize: 12,
  fontWeight: "900" as const,
  color: "#166534",
};

const applySummaryErrorTextStyle = {
  fontSize: 12,
  fontWeight: "800" as const,
  color: "#92400e",
};

const previewTableStyle = {
  borderWidth: 1,
  borderColor: "#e2ddcf",
  borderRadius: 12,
  overflow: "hidden" as const,
};

const previewRowStyle = {
  flexDirection: "row" as const,
  alignItems: "stretch" as const,
  gap: 8,
  borderTopWidth: 1,
  borderTopColor: "#eee3d1",
  paddingHorizontal: 10,
  paddingVertical: 9,
  backgroundColor: "#fffdf7",
};

const previewHeaderRowStyle = {
  borderTopWidth: 0,
  backgroundColor: "#ede7d8",
};

const previewHeaderTextStyle = {
  fontSize: 11,
  fontWeight: "900" as const,
  color: "#334155",
};

const previewCellTextStyle = {
  fontSize: 12,
  fontWeight: "700" as const,
  color: "#334155",
  lineHeight: 16,
};

const previewStatusPillStyle = {
  alignSelf: "flex-start" as const,
  borderRadius: 999,
  backgroundColor: "#e2e8f0",
  paddingHorizontal: 8,
  paddingVertical: 4,
};

const previewStatusTextStyle = {
  fontSize: 11,
  fontWeight: "900" as const,
  color: "#475569",
};

const previewStatusPillStyleByStatus: Partial<Record<ApplyPreviewStatus, any>> = {
  new: { backgroundColor: "#dcfce7" },
  update: { backgroundColor: "#fef3c7" },
  unchanged: { backgroundColor: "#e0f2fe" },
  conflict: { backgroundColor: "#ffedd5" },
  cleared: { backgroundColor: "#fee2e2" },
};

const previewStatusTextStyleByStatus: Partial<Record<ApplyPreviewStatus, any>> = {
  new: { color: "#15803d" },
  update: { color: "#92400e" },
  unchanged: { color: "#0369a1" },
  conflict: { color: "#c2410c" },
  cleared: { color: "#b91c1c" },
};

const headerTextStyle = {
  fontSize: 12,
  fontWeight: "900" as const,
  color: "#334155",
};

const modalBackdropStyle = {
  flex: 1,
  backgroundColor: "rgba(15,23,42,0.45)",
  alignItems: "center" as const,
  justifyContent: "center" as const,
  padding: 18,
};

const modalCardStyle = {
  width: "100%" as const,
  maxWidth: 520,
  borderRadius: 20,
  backgroundColor: "#fffdf7",
  borderWidth: 1,
  borderColor: "#d8d2c4",
  padding: 16,
};

const modalTitleStyle = {
  fontSize: 18,
  fontWeight: "900" as const,
  color: "#1f2933",
  marginBottom: 10,
};

const pickerRowStyle = {
  borderWidth: 1,
  borderColor: "#e2ddcf",
  backgroundColor: "#fffaf0",
  borderRadius: 14,
  padding: 12,
  marginBottom: 8,
};
