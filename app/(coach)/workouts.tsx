import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type SetStateAction } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { GridCell } from "../../components/grid/GridCell";
import { GridTable } from "../../components/grid/GridTable";
import { useGridEngine } from "../../components/grid/useGridEngine";
import { NotesCellEditor } from "../../components/grid/editors/NotesCellEditor";
import { TextCellEditor } from "../../components/grid/editors/TextCellEditor";
import { InlineSaveStatus } from "../../components/shared/InlineSaveStatus";

import { loadCoachCategories } from "../../lib/coachCategories";
import { loadAuxiliaryRoutines, type AuxiliaryRoutine } from "../../lib/auxiliaryRoutines";
import {
  emptyPracticeTimeDefaults,
  getDefaultPracticeTime,
  loadPracticeTimeDefaults,
  type PracticeTimeDefaults,
} from "../../lib/practiceDefaults";
import { getCurrentTeamId } from "../../lib/team";
import { fetchMileageCellsForWeek, type TeamMileageCellRow } from "../../lib/mileageCloud";
import { formatMileageForSheet, getWeekIndex, getWeekStartISO } from "../../lib/mileagePlan";
import {
  compareAthleteDisplayNamesByLastName,
  loadTeamRoster,
  resolveAthleteDisplayName,
  toRosterMapById,
  type TeamRosterAthlete,
} from "../../lib/teamRoster";
import {
  createTeamWorkoutBatch,
  deleteTeamWorkoutsByIds,
  deleteTeamWorkout,
  deleteWorkoutBatch,
  listTeamWorkoutsByBatch,
  listTeamWorkoutsInRange,
  type TeamWorkoutRow,
  updateTeamWorkoutsByBatchId,
  updateTeamWorkoutById,
} from "../../lib/teamWorkoutsCloud";
import { useAppRuntime } from "../../lib/appState";
import type { WorkoutCategory } from "../../lib/types";

type SaveStatus = "idle" | "saving" | "saved" | "error";

type SaveState = {
  status: SaveStatus;
  message?: string;
};

type HeaderSaveDisplayState = {
  kind: "idle" | "pending" | "saving" | "saved" | "error";
  message?: string;
  detail?: string;
};

type BatchEditableField = "session" | "location" | "time_text" | "date_iso" | "title" | "details" | "primary_category" | "categories";

type BatchDraft = {
  session: "AM" | "PM";
  date_iso: string;
  location: string;
  time_text: string;
  title: string;
  details: string;
  primary_category: string;
  categories: string[];
  pre_routine_ids: string[];
  post_routine_ids: string[];
};

type AthleteDraft = {
  session: "AM" | "PM";
  location: string;
  time_text: string;
  details: string;
  primary_category: string;
  categories: string[];
};

type AthleteEditableField = "location" | "time_text" | "details" | "primary_category";

type RosterOption = TeamRosterAthlete;

type GroupedAthleteRows = {
  groupId: string | null;
  groupLabel: string;
  rows: TeamWorkoutRow[];
};

type WorksheetBatchRow = {
  key: string;
  batchId: string | null;
  sample: TeamWorkoutRow;
  workouts: TeamWorkoutRow[];
  groupedAthletes: GroupedAthleteRows[];
  athleteCount: number;
};

type GroupSelectionMeta = {
  rowIds: string[];
  colKeys: AthleteEditableField[];
};

type GroupGridApi = {
  copy: () => Promise<void>;
  paste: () => Promise<void>;
  undo: () => void;
  fillSelected: () => void;
  fillAll: () => void;
};

type GroupAthletePropSlices = {
  workoutIds: string[];
  athleteDrafts: Record<string, AthleteDraft>;
  athleteSaveState: Record<string, SaveState>;
  prescribedDistanceByWorkoutId: Record<string, string>;
};

type WebDragMoveState = {
  workoutId: string;
  batchKey: string;
  batchId: string;
  fromGroupId: string | null;
};

type WebDragGhostState = {
  workoutId: string;
  batchKey: string;
  athleteName: string;
  location: string;
  timeText: string;
  distanceText: string;
  details: string;
  categoriesText: string;
  width: number;
  x: number;
  y: number;
};

const COL = {
  rowSelect: 30,
  toggle: 42,
  session: 90,
  date: 120,
  location: 150,
  time: 90,
  title: 220,
  notes: 360,
  category: 150,
  athletes: 90,
  actions: 180,
  athleteName: 220,
  athleteLocation: 150,
  athleteTime: 100,
  distance: 100,
  athleteNotes: 280,
  athleteCategory: 150,
  athleteActions: 120,
  dragHandle: 32,
};

const SHEET_BORDER = "#dbe2ee";
const SHEET_HEADER_BG = "#f8fafc";
const SHEET_CELL_BG = "#ffffff";
const SHEET_LABEL_COLOR = "#64748b";
const DISTANCE_WEEK_START_DAY = 1 as const;

const batchSheetCellBase = {
  borderRightWidth: 1,
  borderRightColor: SHEET_BORDER,
  paddingHorizontal: 6,
  paddingVertical: 5,
  minHeight: 44,
  justifyContent: "center",
  backgroundColor: SHEET_CELL_BG,
} as const;

const batchSheetLabelText = {
  fontSize: 10,
  fontWeight: "900",
  color: SHEET_LABEL_COLOR,
  marginBottom: 3,
} as const;

const BATCH_GROUP_CORE_BG = "#ffffff";
const BATCH_GROUP_SECONDARY_BG = "#f8fafc";
const BATCH_GROUP_UTILITY_BG = "#f1f5f9";
const BATCH_GROUP_DIVIDER = "#cbd5e1";
const BATCH_GROUP_CAPTION = "#64748b";
const BATCH_START_BORDER = "#9fb2c9";
const BATCH_START_HIGHLIGHT_BORDER = "#fb923c";
const BATCH_HEADER_SECTION_BG = "#f2f6fc";
const BATCH_HEADER_CAPTION_BG = "#e8eff8";
const GROUP_HEADER_BG = "#f7fafd";
const GROUP_SUBHEADER_BG = "#fbfdff";
const GROUP_HEADER_BORDER = "#e4ebf4";
const COACH_WORKOUTS_DAY_DRAFT_CACHE_KEY = "coach_workouts_day_draft_cache_v1";

type PersistedDayDraftState = {
  batchDrafts: Record<string, BatchDraft>;
  batchDirtyFields: Record<string, Partial<Record<BatchEditableField, true>>>;
  athleteDrafts: Record<string, AthleteDraft>;
  updatedAt: number;
};

async function loadPersistedDayDraftCache(): Promise<Record<string, PersistedDayDraftState>> {
  try {
    const raw = await AsyncStorage.getItem(COACH_WORKOUTS_DAY_DRAFT_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, PersistedDayDraftState>;
  } catch {
    return {};
  }
}

async function savePersistedDayDraftCache(next: Record<string, PersistedDayDraftState>): Promise<void> {
  try {
    await AsyncStorage.setItem(COACH_WORKOUTS_DAY_DRAFT_CACHE_KEY, JSON.stringify(next));
  } catch {}
}

function buildMileageLookupKey(
  athleteId: string,
  weekStartISO: string,
  dayIdx: number,
  session: "AM" | "PM"
) {
  return `${athleteId}__${weekStartISO}__${dayIdx}__${session}`;
}

const BATCH_COLUMNS: Array<{ key: string; label: string; width: number }> = [
  { key: "toggle", label: "", width: COL.toggle },
  { key: "session", label: "AM/PM", width: COL.session },
  { key: "time", label: "Time", width: COL.time },
  { key: "date", label: "Date", width: COL.date },
  { key: "location", label: "Location", width: COL.location },
  { key: "title", label: "Title", width: COL.title },
  { key: "notes", label: "Notes", width: COL.notes },
  { key: "category", label: "Category", width: COL.category },
  { key: "athletes", label: "Athletes", width: COL.athletes },
  { key: "actions", label: "Actions", width: COL.actions },
];

const ATHLETE_EDIT_FIELDS: AthleteEditableField[] = ["location", "time_text", "details"];

function normalizeCategoryLabel(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeCategoryArrayForGrid(raw: string[]): string[] {
  return Array.from(
    new Set(
      (Array.isArray(raw) ? raw : [])
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .filter((v) => normalizeCategoryLabel(v) !== "other")
    )
  );
}

function buildGroupKey(batchKey: string, groupId: string | null): string {
  return `${batchKey}::${groupId ?? "__UNGROUPED__"}`;
}

function areOrderedGroupRowsUnchanged(
  prevRows: TeamWorkoutRow[] | undefined,
  nextRows: TeamWorkoutRow[]
): boolean {
  if (!prevRows) return false;
  if (prevRows.length !== nextRows.length) return false;
  for (let i = 0; i < nextRows.length; i += 1) {
    const prevRow = prevRows[i];
    const nextRow = nextRows[i];
    if (!prevRow || String(prevRow.id) !== String(nextRow.id)) return false;
    if (prevRow !== nextRow) return false;
  }
  return true;
}

function areOrderedWorkoutIdsUnchanged(prevIds: string[] | undefined, nextIds: string[]): boolean {
  if (!prevIds) return false;
  if (prevIds.length !== nextIds.length) return false;
  for (let i = 0; i < nextIds.length; i += 1) {
    if (prevIds[i] !== nextIds[i]) return false;
  }
  return true;
}

function resolvePrescribedForSlice(
  prescribedDistanceByWorkoutId: Record<string, string>,
  workoutId: string
): string | undefined {
  const prescribed = prescribedDistanceByWorkoutId[workoutId];
  if (typeof prescribed !== "string" || !prescribed) return undefined;
  return prescribed;
}

function areGroupAthleteSlicesUnchanged(
  previous: GroupAthletePropSlices | undefined,
  workoutIds: string[],
  athleteDrafts: Record<string, AthleteDraft>,
  athleteSaveState: Record<string, SaveState>,
  prescribedDistanceByWorkoutId: Record<string, string>
): boolean {
  if (!previous) return false;
  if (!areOrderedWorkoutIdsUnchanged(previous.workoutIds, workoutIds)) return false;
  for (const workoutId of workoutIds) {
    if (athleteDrafts[workoutId] !== previous.athleteDrafts[workoutId]) return false;
    if (athleteSaveState[workoutId] !== previous.athleteSaveState[workoutId]) return false;
    if (
      resolvePrescribedForSlice(prescribedDistanceByWorkoutId, workoutId) !==
      previous.prescribedDistanceByWorkoutId[workoutId]
    ) {
      return false;
    }
  }
  return true;
}

const GroupAthleteRows = memo(function GroupAthleteRows({
  groupKey,
  batchRowKey,
  batchId,
  group,
  rosterNameById,
  athleteDrafts,
  athleteSaveState,
  prescribedDistanceByWorkoutId,
  deletingKey,
  justMovedWorkoutId,
  onEditAthleteField,
  onDeleteSingleWorkout,
  setMoveMode,
  webDragMove,
  setWebDragMove,
  setWebDragGhost,
  setWebDragGhostClone,
  dragOverGroupKey,
  setDragOverGroupKey,
  activeGridId,
  setActiveGridId,
  onSelectionMetaChange,
  onRegisterGridApi,
  batchHeaderActiveRef,
}: {
  groupKey: string;
  batchRowKey: string;
  batchId: string | null;
  group: GroupedAthleteRows;
  rosterNameById: Map<string, string>;
  athleteDrafts: Record<string, AthleteDraft>;
  athleteSaveState: Record<string, SaveState>;
  prescribedDistanceByWorkoutId: Record<string, string>;
  deletingKey: string | null;
  justMovedWorkoutId: string | null;
  onEditAthleteField: (workoutId: string, field: AthleteEditableField, value: string) => void;
  onDeleteSingleWorkout: (workoutId: string) => void | Promise<void>;
  setMoveMode: (v: any) => void;
  webDragMove: WebDragMoveState | null;
  setWebDragMove: (v: WebDragMoveState | null) => void;
  setWebDragGhost: (v: SetStateAction<WebDragGhostState | null>) => void;
  setWebDragGhostClone: (clone: HTMLElement | null) => void;
  dragOverGroupKey: string | null;
  setDragOverGroupKey: (v: string | null) => void;
  activeGridId: string | null;
  setActiveGridId: (id: string | null) => void;
  onSelectionMetaChange: (groupKey: string, meta: GroupSelectionMeta) => void;
  onRegisterGridApi: (groupKey: string, api: GroupGridApi | null) => void;
  batchHeaderActiveRef: MutableRefObject<boolean>;
}) {
  const gridId = groupKey;
  const rowIds = useMemo(() => group.rows.map((r) => String(r.id)), [group.rows]);
  const groupGridRef = useRef<any>(null);
  const clearDragGhostLocal = useCallback(() => {
    setWebDragGhost(null);
    setWebDragGhostClone(null);
  }, [setWebDragGhost, setWebDragGhostClone]);

  const resolveDisplayCategories = useCallback(
    (workoutId: string, draft?: AthleteDraft, row?: TeamWorkoutRow) => {
      const draftCats = normalizeCategoryArrayForGrid(draft?.categories ?? []);
      if (draftCats.length > 0) return draftCats;

      const rowCats = normalizeCategoryArrayForGrid(
        (Array.isArray(row?.categories) ? row?.categories : []).map((c) => String(c ?? ""))
      );
      if (rowCats.length > 0) return rowCats;

      const primary = String(draft?.primary_category ?? row?.primary_category ?? "").trim();
      if (primary && normalizeCategoryLabel(primary) !== "other") return [primary];

      return [];
    },
    []
  );

  const buildFillSelectedChanges = useCallback(() => {
    const rect = groupGridRef.current?.getSelectionRect?.();
    if (!rect) return [] as Array<{ rowId: string; colKey: AthleteEditableField; prev: string; next: string }>;
    const sourceRowIndex = rect.r1;
    const sourceId = rowIds[sourceRowIndex];
    if (!sourceId) return [] as Array<{ rowId: string; colKey: AthleteEditableField; prev: string; next: string }>;

    const source = athleteDrafts[sourceId] ?? {
      session: "AM",
      location: "",
      time_text: "",
      details: "",
      primary_category: "",
      categories: [],
    };
    const selectedCols = new Set(groupGridRef.current?.getSelectedColKeys?.() ?? []);
    const selectedRowIds = (groupGridRef.current?.selectedRowIds ?? []) as string[];
    const changes: Array<{ rowId: string; colKey: AthleteEditableField; prev: string; next: string }> = [];
    selectedRowIds.forEach((id) => {
      if (id === sourceId) return;
      ATHLETE_EDIT_FIELDS.forEach((field) => {
        if (!selectedCols.has(field)) return;
        const row = group.rows.find((r) => String(r.id) === id);
        const prev = String((athleteDrafts[id] as any)?.[field] ?? row?.[field] ?? "");
        changes.push({ rowId: id, colKey: field, prev, next: String(source[field] ?? "") });
      });
    });
    return changes;
  }, [athleteDrafts, group.rows, rowIds]);

  const groupGrid = useGridEngine<string, AthleteEditableField>({
    enabled: Platform.OS === "web",
    rowIds,
    colKeys: ATHLETE_EDIT_FIELDS,
    isEditorHandlingKeys: () => false,
    getValue: (workoutId, field) => {
      const draft = athleteDrafts[workoutId];
      const row = group.rows.find((r) => String(r.id) === workoutId);
      if (draft && typeof draft[field] === "string") return String(draft[field] ?? "");
      if (!row) return "";
      if (field === "location") return String(row.location ?? "");
      if (field === "time_text") return String(row.time_text ?? "");
      if (field === "details") return String(row.details ?? "");
      return "";
    },
    setValue: (workoutId, field, value) => {
      onEditAthleteField(workoutId, field, value);
    },
    onActivate: () => setActiveGridId(gridId),
    onSelectionChange: (selection) =>
      onSelectionMetaChange(groupKey, {
        rowIds: selection.rowIds.map((id) => String(id)),
        colKeys: selection.colKeys,
      }),
    onFillDown: () => {
      const changes = buildFillSelectedChanges();
      if (changes.length > 0) {
        groupGridRef.current?.applyChanges?.(changes as any);
      }
    },
  });
  groupGridRef.current = groupGrid;

  const fillAllForGroup = useCallback(() => {
    if (rowIds.length < 2) return;
    const sourceId = rowIds[0];
    const source = athleteDrafts[sourceId] ?? {
      session: "AM",
      location: "",
      time_text: "",
      details: "",
      primary_category: "",
      categories: [],
    };
    const targetIds = rowIds.slice(1);
    const changes: Array<{ rowId: string; colKey: AthleteEditableField; prev: string; next: string }> = [];
    targetIds.forEach((id) => {
      ATHLETE_EDIT_FIELDS.forEach((field) => {
        const row = group.rows.find((r) => String(r.id) === id);
        const prev = String((athleteDrafts[id] as any)?.[field] ?? row?.[field] ?? "");
        changes.push({ rowId: id, colKey: field, prev, next: String(source[field] ?? "") });
      });
    });
    groupGrid.applyChanges(changes as any);
  }, [athleteDrafts, group.rows, groupGrid, rowIds]);

  const fillSelectedForGroup = useCallback(() => {
    const changes = buildFillSelectedChanges();
    if (changes.length > 0) {
      groupGrid.applyChanges(changes as any);
    }
  }, [buildFillSelectedChanges, groupGrid]);

  useEffect(() => {
    onRegisterGridApi(groupKey, {
      copy: async () => {
        await groupGrid.copySelectionToClipboard();
      },
      paste: async () => {
        await groupGrid.pasteFromClipboard();
      },
      undo: () => {
        groupGrid.undo();
      },
      fillSelected: fillSelectedForGroup,
      fillAll: fillAllForGroup,
    });
    return () => onRegisterGridApi(groupKey, null);
  }, [fillAllForGroup, fillSelectedForGroup, groupGrid, groupKey, onRegisterGridApi]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handler = (e: any) => {
      if (batchHeaderActiveRef.current) return;
      if (activeGridId !== gridId) return;
      const handled = groupGrid.handleKeyDown(e);
      if (!handled) return;
      e.preventDefault?.();
      e.stopPropagation?.();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, true);
    };
  }, [activeGridId, batchHeaderActiveRef, fillSelectedForGroup, gridId, groupGrid]);

  return (
    <View style={{ position: "relative", overflow: "visible", zIndex: 1 }}>
      {group.rows.map((workout, idx) => {
        const workoutId = String(workout.id);
        const athleteId = String(workout.athlete_profile_id ?? "").trim();
        const athleteName = resolveAthleteDisplayName(
          athleteId,
          rosterNameById,
          String((workout as any).athlete_name ?? "")
        );
        const athleteDraft =
          athleteDrafts[workoutId] ??
          {
            session: normalizeSession(workout.session),
            location: String(workout.location ?? ""),
            time_text: String(workout.time_text ?? ""),
            details: String(workout.details ?? ""),
            primary_category: String(workout.primary_category ?? ""),
            categories: (
              Array.isArray(workout.categories) ? workout.categories : []
            )
              .map((c) => String(c ?? "").trim())
              .filter(Boolean),
          };
        const athleteState = athleteSaveState[workoutId];
        const locationSelected = groupGrid.isCellSelected(workoutId, "location");
        const rowSelected = groupGrid.isRowSelected(workoutId);
        const timeSelected = groupGrid.isCellSelected(workoutId, "time_text");
        const notesSelected = groupGrid.isCellSelected(workoutId, "details");
        const locationActive = groupGrid.isCellActive(workoutId, "location");
        const timeActive = groupGrid.isCellActive(workoutId, "time_text");
        const notesActive = groupGrid.isCellActive(workoutId, "details");
        const displayCategories = resolveDisplayCategories(workoutId, athleteDraft, workout);
        const isDraggingThisRow =
          Platform.OS === "web" &&
          webDragMove?.workoutId === workoutId &&
          webDragMove?.batchKey === batchRowKey;
        const rowStyle = {
          flexDirection: "row" as const,
          minHeight: 40,
          backgroundColor:
            isDraggingThisRow
              ? "rgba(148, 163, 184, 0.18)"
              : justMovedWorkoutId === workoutId
              ? "rgba(59, 130, 246, 0.10)"
              : idx % 2 === 0
              ? "#ffffff"
              : "#f9fbfe",
          borderBottomWidth: 1,
          borderBottomColor: "#e2e8f0",
          position: "relative" as const,
          overflow: "visible" as const,
          zIndex: 1,
          opacity: isDraggingThisRow ? 0.55 : 1,
          outline: isDraggingThisRow ? "1px dashed rgba(51, 65, 85, 0.45)" : "none",
          outlineOffset: isDraggingThisRow ? -1 : 0,
        };

        const rowBody = (
          <>
            <View
              style={{
                width: COL.rowSelect,
                minWidth: COL.rowSelect,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                alignItems: "center",
                ...(rowSelected ? ({ outline: "1px solid rgba(15,23,42,0.55)", outlineOffset: -1 } as any) : null),
              }}
            >
              {Platform.OS === "web" ? (
                <div
                  onMouseDown={(e: any) => {
                    e.preventDefault?.();
                    setActiveGridId(gridId);
                    groupGrid.selectRow(workoutId, !!e?.shiftKey);
                  }}
                  style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "900", color: rowSelected ? "#1d4ed8" : "#94a3b8" }}>
                    {rowSelected ? "◼" : "◻"}
                  </Text>
                </div>
              ) : (
                <Pressable onPress={() => groupGrid.selectRow(workoutId)} style={{ padding: 4 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: rowSelected ? "#1d4ed8" : "#94a3b8" }}>
                    {rowSelected ? "◼" : "◻"}
                  </Text>
                </Pressable>
              )}
            </View>

            <View
              style={{
                width: COL.dragHandle,
                minWidth: COL.dragHandle,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                alignItems: "center",
                overflow: "hidden",
              }}
            >
              {Platform.OS === "web" && batchId ? (
                <div
                  draggable
                  onDragStart={(e: any) => {
                    const payload: WebDragMoveState = {
                      workoutId,
                      batchKey: batchRowKey,
                      batchId,
                      fromGroupId: group.groupId,
                    };
                    setWebDragMove(payload);
                    setDragOverGroupKey(null);
                    setWebDragGhost({
                      workoutId,
                      batchKey: batchRowKey,
                      athleteName,
                      location: String(athleteDraft.location ?? "").trim(),
                      timeText: String(athleteDraft.time_text ?? "").trim(),
                      distanceText: String(prescribedDistanceByWorkoutId[workoutId] ?? "-"),
                      details: String(athleteDraft.details ?? "").trim(),
                      categoriesText: displayCategories.join(", "),
                      width: 520,
                      x: Number(e?.clientX ?? e?.nativeEvent?.clientX ?? 0),
                      y: Number(e?.clientY ?? e?.nativeEvent?.clientY ?? 0),
                    });
                    try {
                      const dataTransfer = e?.dataTransfer ?? e?.nativeEvent?.dataTransfer;
                      dataTransfer?.setData?.("text/plain", JSON.stringify(payload));
                      if (dataTransfer) dataTransfer.effectAllowed = "move";
                      const doc = e?.currentTarget?.ownerDocument as Document | undefined;
                      const findRowFromHandle = (start: HTMLElement | null): HTMLElement | null => {
                        let node: HTMLElement | null = start;
                        while (node) {
                          const childCount = node.children?.length ?? 0;
                          const hasDataRow =
                            (node.getAttribute?.("data-row-container") === "1" ||
                              node.getAttribute?.("data-row-id") === String(workoutId));
                          if (hasDataRow && childCount >= 6) return node;
                          const style = window.getComputedStyle(node);
                          if (
                            childCount >= 6 &&
                            style.display === "flex" &&
                            style.flexDirection === "row" &&
                            Number.parseFloat(style.minHeight || "0") >= 30
                          ) {
                            return node;
                          }
                          node = node.parentElement;
                        }
                        return null;
                      };
                      const rowById =
                        (doc?.querySelector?.(`[data-row-id="${String(workoutId)}"]`) as HTMLElement | null) ?? null;
                      const row =
                        rowById ??
                        findRowFromHandle(e?.currentTarget as HTMLElement | null) ??
                        (e?.currentTarget?.closest?.("[data-row-container='1']") as HTMLElement | null) ??
                        (e?.currentTarget?.parentElement?.closest?.("[data-row-container='1']") as HTMLElement | null);
                      if (row) {
                        const rect = row.getBoundingClientRect();
                        const clone = row.cloneNode(true) as HTMLElement;
                        clone.style.width = `${rect.width}px`;
                        clone.style.minWidth = `${rect.width}px`;
                        clone.style.maxWidth = `${rect.width}px`;
                        clone.style.margin = "0";
                        clone.style.pointerEvents = "none";
                        clone.style.opacity = "0.92";
                        clone.style.background = "#ffffff";
                        clone.style.borderRadius = "8px";
                        clone.style.boxShadow = "0 10px 24px rgba(15,23,42,0.18)";
                        setWebDragGhostClone(clone);
                        setWebDragGhost((prev) => (prev ? { ...prev, width: rect.width } : prev));
                      } else {
                        setWebDragGhostClone(null);
                      }
                      if (dataTransfer?.setDragImage) {
                        const transparentImage = (doc?.createElement?.("img") ?? document.createElement("img")) as HTMLImageElement;
                        transparentImage.src =
                          "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
                        transparentImage.width = 1;
                        transparentImage.height = 1;
                        transparentImage.style.position = "fixed";
                        transparentImage.style.left = "-9999px";
                        transparentImage.style.top = "-9999px";
                        doc?.body?.appendChild(transparentImage);
                        dataTransfer.setDragImage(transparentImage, 0, 0);
                        setTimeout(() => {
                          if (transparentImage.parentNode) transparentImage.parentNode.removeChild(transparentImage);
                        }, 0);
                      }
                    } catch {}
                  }}
                  onDrag={(e: any) => {
                    const x = Number(e?.clientX ?? e?.nativeEvent?.clientX ?? 0);
                    const y = Number(e?.clientY ?? e?.nativeEvent?.clientY ?? 0);
                    if (!(x > 0 || y > 0)) return;
                    setWebDragGhost((prev) => (prev ? { ...prev, x, y } : prev));
                  }}
                  onDragEnd={() => {
                    setDragOverGroupKey(null);
                    setWebDragMove(null);
                    clearDragGhostLocal();
                  }}
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "grab",
                    opacity:
                      webDragMove?.workoutId === workoutId && webDragMove?.batchKey === batchRowKey ? 0.55 : 1,
                    backgroundColor:
                      dragOverGroupKey && dragOverGroupKey === groupKey ? "rgba(59,130,246,0.06)" : "transparent",
                  }}
                  title="Drag to move to another group"
                >
                  <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b", lineHeight: 12 }}>⋮⋮</Text>
                </div>
              ) : (
                <View />
              )}
            </View>

            <View
              style={{
                flexGrow: 0,
                flexShrink: 1,
                flexBasis: COL.athleteName,
                minWidth: 120,
                maxWidth: COL.athleteName,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 8,
                overflow: "hidden",
              }}
            >
              <Text numberOfLines={2} style={{ fontSize: 12, fontWeight: "800", color: "#0f172a", lineHeight: 15 }}>
                {athleteName}
              </Text>
            </View>

            <View
              style={{
                flexBasis: COL.athleteLocation,
                maxWidth: COL.athleteLocation,
                minWidth: 110,
                flexShrink: 1,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 8,
                overflow: "visible",
                ...(locationSelected ? ({ outline: "1px solid rgba(15,23,42,0.55)", outlineOffset: -1 } as any) : null),
                ...(locationActive ? ({ outline: "2px solid #111827", outlineOffset: -2 } as any) : null),
              }}
            >
              <GridCell
                value={athleteDraft.location}
                onChangeText={(v) => groupGrid.applyCellValue(workoutId, "location", v)}
                style={{ fontSize: 12, fontWeight: "600", color: "#334155", paddingVertical: 3 }}
                placeholder="Location"
                numberOfLines={2}
                gridEditing={groupGrid.isEditingCell(workoutId, "location")}
                editIntent={
                  groupGrid.editIntentRef.current?.rowId === workoutId &&
                  groupGrid.editIntentRef.current?.colKey === "location"
                    ? groupGrid.editIntentRef.current
                    : null
                }
                consumeEditIntent={() => groupGrid.consumeEditIntent(workoutId, "location")}
                onEnterEditMode={() => groupGrid.beginEdit(workoutId, "location", "preserve")}
                binding={groupGrid.bindCell(workoutId, "location")}
              />
            </View>

            <View
              style={{
                flexBasis: COL.athleteTime,
                maxWidth: COL.athleteTime,
                minWidth: 70,
                flexShrink: 1,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 8,
                overflow: "visible",
                ...(timeSelected ? ({ outline: "1px solid rgba(15,23,42,0.55)", outlineOffset: -1 } as any) : null),
                ...(timeActive ? ({ outline: "2px solid #111827", outlineOffset: -2 } as any) : null),
              }}
            >
              <GridCell
                value={athleteDraft.time_text}
                onChangeText={(v) => groupGrid.applyCellValue(workoutId, "time_text", v)}
                style={{ fontSize: 12, fontWeight: "600", color: "#334155", paddingVertical: 3 }}
                placeholder="Time"
                numberOfLines={1}
                gridEditing={groupGrid.isEditingCell(workoutId, "time_text")}
                editIntent={
                  groupGrid.editIntentRef.current?.rowId === workoutId &&
                  groupGrid.editIntentRef.current?.colKey === "time_text"
                    ? groupGrid.editIntentRef.current
                    : null
                }
                consumeEditIntent={() => groupGrid.consumeEditIntent(workoutId, "time_text")}
                onEnterEditMode={() => groupGrid.beginEdit(workoutId, "time_text", "preserve")}
                binding={groupGrid.bindCell(workoutId, "time_text")}
              />
            </View>

            <View
              style={{
                width: COL.distance,
                minWidth: 0,
                flexShrink: 1,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                alignItems: "flex-end",
                paddingHorizontal: 8,
                overflow: "hidden",
              }}
            >
              <Text numberOfLines={1} ellipsizeMode="tail" style={{ fontSize: 12, fontWeight: "800", color: "#1f2937" }}>
                {prescribedDistanceByWorkoutId[workoutId] ?? "-"}
              </Text>
            </View>

            <View
              style={{
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: COL.athleteNotes,
                minWidth: COL.athleteNotes,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 8,
                overflow: "hidden",
                ...(notesSelected ? ({ outline: "1px solid rgba(15,23,42,0.55)", outlineOffset: -1 } as any) : null),
                ...(notesActive ? ({ outline: "2px solid #111827", outlineOffset: -2 } as any) : null),
              }}
            >
              <GridCell
                value={athleteDraft.details}
                onChangeText={(v) => groupGrid.applyCellValue(workoutId, "details", v)}
                style={{ fontSize: 12, fontWeight: "600", color: "#334155", paddingVertical: 3 }}
                placeholder="Notes"
                numberOfLines={2}
                gridEditing={groupGrid.isEditingCell(workoutId, "details")}
                editIntent={
                  groupGrid.editIntentRef.current?.rowId === workoutId &&
                  groupGrid.editIntentRef.current?.colKey === "details"
                    ? groupGrid.editIntentRef.current
                    : null
                }
                consumeEditIntent={() => groupGrid.consumeEditIntent(workoutId, "details")}
                onEnterEditMode={() => groupGrid.beginEdit(workoutId, "details", "preserve")}
                binding={groupGrid.bindCell(workoutId, "details")}
              />
            </View>

            <View
              style={{
                width: COL.athleteCategory,
                minWidth: 0,
                flexShrink: 1,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 8,
                overflow: "hidden",
              }}
            >
              <Text
                numberOfLines={3}
                style={{ fontSize: 11, fontWeight: "700", color: displayCategories.length ? "#334155" : "#94a3b8", lineHeight: 14, paddingVertical: 4 }}
              >
                {displayCategories.length ? displayCategories.join(", ") : "No categories"}
              </Text>
            </View>

            <View
              style={{
                width: COL.athleteActions,
                minWidth: 0,
                flexShrink: 1,
                paddingHorizontal: 8,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                overflow: "hidden",
              }}
            >
              {Platform.OS === "web" && batchId ? (
                <Pressable
                  onPress={() =>
                    setMoveMode({
                      workoutId,
                      batchKey: batchRowKey,
                      batchId,
                      fromGroupId: group.groupId,
                    })
                  }
                  style={{ borderWidth: 1, borderColor: "#cbd5e1", backgroundColor: "#f8fafc", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4 }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Move</Text>
                </Pressable>
              ) : null}

              <Pressable
                onPress={() => void onDeleteSingleWorkout(workoutId)}
                disabled={deletingKey === workoutId}
                style={{ borderWidth: 1, borderColor: "#f2c4c4", backgroundColor: "#fff0f0", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: deletingKey === workoutId ? 0.6 : 1 }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#9f1239" }}>
                  {deletingKey === workoutId ? "Deleting..." : "Delete"}
                </Text>
              </Pressable>

              <View style={{ alignItems: "flex-end", flexShrink: 1 }}>
                <InlineSaveStatus status={athleteState?.status ?? "idle"} message={athleteState?.message} size="sm" align="right" />
              </View>
            </View>
          </>
        );

        if (Platform.OS === "web") {
          return (
            <div key={`${batchRowKey}-athlete-${workoutId}`} style={{ display: "contents" }}>
              <View
                {...({ "data-row-id": workoutId, "data-row-container": "1" } as any)}
                style={[
                  rowStyle,
                  {
                    userSelect: "text",
                    transition:
                      "transform 120ms ease, background-color 250ms ease, opacity 120ms ease, border-color 120ms ease",
                    transform: justMovedWorkoutId === workoutId ? "scale(1.01)" : "scale(1)",
                  } as any,
                ]}
              >
                {rowBody}
              </View>
            </div>
          );
        }

        return (
          <Pressable
            key={`${batchRowKey}-athlete-${workoutId}`}
            onLongPress={() => {
              if (!batchId) return;
              setMoveMode({
                workoutId,
                batchKey: batchRowKey,
                batchId,
                fromGroupId: group.groupId,
              });
            }}
            delayLongPress={220}
            style={rowStyle}
          >
            {rowBody}
          </Pressable>
        );
      })}
    </View>
  );
});

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function addDaysISO(dateISO: string, delta: number): string {
  const [y, m, d] = String(dateISO ?? "").split("-").map(Number);
  if (!y || !m || !d) return dateISO;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function normalizeSession(value: string): "AM" | "PM" {
  const v = String(value ?? "").trim().toUpperCase();
  return v === "AM" ? "AM" : "PM";
}

function resolveDefaultSessionSlotAndTimeForDate(
  dateISO: string,
  defaults: PracticeTimeDefaults,
  fallbackSession: "AM" | "PM" = "AM",
  fallbackTime = ""
): { session: "AM" | "PM"; timeText: string } {
  const amTime = getDefaultPracticeTime(defaults, dateISO, "AM") ?? "";
  const pmTime = getDefaultPracticeTime(defaults, dateISO, "PM") ?? "";

  if (amTime) return { session: "AM", timeText: amTime };
  if (pmTime) return { session: "PM", timeText: pmTime };
  return { session: fallbackSession, timeText: fallbackTime };
}

function resolveSessionSwitchTime({
  dateISO,
  defaults,
  fromSession,
  toSession,
  currentTimeText,
}: {
  dateISO: string;
  defaults: PracticeTimeDefaults;
  fromSession: "AM" | "PM";
  toSession: "AM" | "PM";
  currentTimeText: string;
}): string {
  const trimmed = String(currentTimeText ?? "").trim();
  const fromDefault = getDefaultPracticeTime(defaults, dateISO, fromSession) ?? "";
  const toDefault = getDefaultPracticeTime(defaults, dateISO, toSession) ?? "";
  const canAutoSwap = !trimmed || (!!fromDefault && trimmed === fromDefault);
  if (!canAutoSwap) return String(currentTimeText ?? "");
  if (!toDefault) return String(currentTimeText ?? "");
  return toDefault;
}

function parseTimeTextToSortableMinutes(value: string): number | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;

  const compact = raw.replace(/\./g, "").replace(/\s+/g, "");
  const match = compact.match(/^(\d{1,2})(?::(\d{1,2}))?([ap]m?|)$/);
  if (!match) return null;

  const hoursRaw = Number(match[1]);
  const minutesRaw = match[2] == null ? 0 : Number(match[2]);
  if (!Number.isFinite(hoursRaw) || !Number.isFinite(minutesRaw)) return null;
  if (minutesRaw < 0 || minutesRaw > 59) return null;

  const suffix = match[3] ?? "";
  if (suffix) {
    if (hoursRaw < 1 || hoursRaw > 12) return null;
    const isPm = suffix.startsWith("p");
    const normalizedHour = hoursRaw % 12 + (isPm ? 12 : 0);
    return normalizedHour * 60 + minutesRaw;
  }

  if (hoursRaw < 0 || hoursRaw > 23) return null;
  return hoursRaw * 60 + minutesRaw;
}

function sanitizeAthleteCategories(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .map((c) => String(c ?? "").trim())
    .filter(Boolean);
}

function toAthleteDraftFromRow(row: TeamWorkoutRow): AthleteDraft {
  const categories = sanitizeAthleteCategories(row.categories);
  const primary = String(row.primary_category ?? "").trim();
  return {
    session: normalizeSession(row.session),
    location: String(row.location ?? ""),
    time_text: String(row.time_text ?? ""),
    details: String(row.details ?? ""),
    primary_category: primary,
    categories: categories.length > 0 ? categories : (primary ? [primary] : []),
  };
}

function toAthleteCloudPatch(draft: AthleteDraft): Partial<TeamWorkoutRow> {
  return {
    session: normalizeSession(draft.session),
    location: String(draft.location ?? "").trim() || null,
    time_text: String(draft.time_text ?? "").trim() || null,
    details: String(draft.details ?? "").trim() || null,
    primary_category: String(draft.primary_category ?? "").trim() || null,
    categories: sanitizeAthleteCategories(draft.categories),
  };
}

function toSavedAthleteDraftSnapshot(draft: AthleteDraft): AthleteDraft {
  return {
    session: normalizeSession(draft.session),
    location: String(draft.location ?? ""),
    time_text: String(draft.time_text ?? ""),
    details: String(draft.details ?? ""),
    primary_category: String(draft.primary_category ?? ""),
    categories: sanitizeAthleteCategories(draft.categories),
  };
}

function sanitizeBatchCategoriesForPatch(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .map((c) => String(c ?? "").trim())
    .filter((c) => !!c && c.toLowerCase() !== "other");
}

function toBatchCloudPatchFromDraft(
  draft: BatchDraft,
  dirtyKeys: BatchEditableField[]
): Partial<TeamWorkoutRow> {
  const payload: Partial<TeamWorkoutRow> = {};
  dirtyKeys.forEach((k) => {
    if (k === "session") payload.session = normalizeSession(draft.session);
    if (k === "date_iso") (payload as any).date_iso = String(draft.date_iso ?? "").trim() || null;
    if (k === "title") payload.title = String(draft.title ?? "").trim() || "Workout";
    if (k === "location") payload.location = String(draft.location ?? "").trim() || null;
    if (k === "time_text") payload.time_text = String(draft.time_text ?? "").trim() || null;
    if (k === "details") payload.details = String(draft.details ?? "").trim() || null;
    if (k === "primary_category") payload.primary_category = String(draft.primary_category ?? "").trim() || null;
    if (k === "categories") {
      const cleaned = sanitizeBatchCategoriesForPatch(draft.categories);
      payload.categories = cleaned;
      payload.primary_category = cleaned[0] ?? null;
    }
  });
  return payload;
}

function createBatchId(dateISO: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bat_${dateISO}_${suffix}`;
}

function isISODateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim())) return false;
  const [y, m, d] = String(value ?? "").trim().split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return false;
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}` === `${String(value ?? "").trim()}`;
}

function isLikelyConnectivityError(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text) return false;
  return /network|offline|internet|connection|fetch|timed? out|timeout/.test(text);
}

function getBatchKey(row: TeamWorkoutRow): string {
  const batchId = String(row.batch_id ?? "").trim();
  if (batchId) return `batch:${batchId}`;
  return `single:${String(row.id)}`;
}

function parseBatchKey(batchKey: string): { isBatch: boolean; id: string } {
  if (batchKey.startsWith("batch:")) return { isBatch: true, id: batchKey.slice(6) };
  return { isBatch: false, id: batchKey.replace(/^single:/, "") };
}

function encodeGroupOrderId(groupId: string | null): string {
  return groupId == null ? "__UNGROUPED__" : String(groupId);
}

function decodeGroupOrderId(encoded: string): string | null {
  return encoded === "__UNGROUPED__" ? null : encoded;
}

function compareEncodedGroupOrder(a: string, b: string): number {
  const aUngrouped = a === "__UNGROUPED__";
  const bUngrouped = b === "__UNGROUPED__";
  if (aUngrouped && !bUngrouped) return -1;
  if (!aUngrouped && bUngrouped) return 1;

  const aIsNum = /^\d+$/.test(a);
  const bIsNum = /^\d+$/.test(b);
  const aNum = aIsNum ? Number(a) : NaN;
  const bNum = bIsNum ? Number(b) : NaN;
  if (aIsNum && bIsNum) return aNum - bNum;
  if (aIsNum && !bIsNum) return -1;
  if (!aIsNum && bIsNum) return 1;
  return a.localeCompare(b);
}

async function moveWorkoutToGroup(workoutId: string, newGroupId: string | null) {
  await updateTeamWorkoutById(workoutId, { group_id: newGroupId });
}

function makeNewGroupId(): string {
  const webUuid = (globalThis as any)?.crypto?.randomUUID?.();
  if (typeof webUuid === "string" && webUuid) return webUuid;
  return `group_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export default function CoachWorkoutsDay() {
  const router = useRouter();
  const { patch: patchAppRuntime } = useAppRuntime();
  const { date, batch } = useLocalSearchParams<{ date?: string; batch?: string | string[] }>();

  const dayISO = String(date ?? "");
  const batchParam = useMemo(() => {
    const raw = Array.isArray(batch) ? batch[0] : batch;
    return String(raw ?? "").trim();
  }, [batch]);

  const teamIdRef = useRef<string | null>(null);
  const isUnmountingRef = useRef(false);
  const batchSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const batchRoutineSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const athleteSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const savedAthleteDraftsRef = useRef<Record<string, AthleteDraft>>({});
  const batchDraftsRef = useRef<Record<string, BatchDraft>>({});
  const batchDirtyFieldsRef = useRef<Record<string, Partial<Record<BatchEditableField, true>>>>({});
  const athleteDraftsRef = useRef<Record<string, AthleteDraft>>({});
  const groupedAthletesCacheRef = useRef<Record<string, Record<string, GroupedAthleteRows>>>({});
  const groupAthleteSliceCacheRef = useRef<Record<string, GroupAthletePropSlices>>({});
  const mileageDistanceRequestRef = useRef(0);
  const workoutsScrollRef = useRef<ScrollView | null>(null);
  const batchHeaderYByKeyRef = useRef<Record<string, number>>({});
  const alreadyScrolledForBatchRef = useRef<string | null>(null);
  const previousDayISORef = useRef<string | null>(null);
  const flushPendingEditsRef = useRef<() => Promise<void>>(async () => {});

  const [loading, setLoading] = useState(true);
  const [rowsRaw, setRowsRaw] = useState<TeamWorkoutRow[]>([]);
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());
  const [rosterOptions, setRosterOptions] = useState<RosterOption[]>([]);

  const [expandedByBatchKey, setExpandedByBatchKey] = useState<Record<string, boolean>>({});
  const [groupOrderByBatch, setGroupOrderByBatch] = useState<Record<string, string[]>>({});
  const [justMovedWorkoutId, setJustMovedWorkoutId] = useState<string | null>(null);
  const [moveMode, setMoveMode] = useState<{
    workoutId: string;
    batchKey: string;
    batchId: string;
    fromGroupId: string | null;
  } | null>(null);
  const [webDragMove, setWebDragMove] = useState<WebDragMoveState | null>(null);
  const [webDragGhost, setWebDragGhost] = useState<WebDragGhostState | null>(null);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null);
  const webDragGhostCloneRef = useRef<HTMLElement | null>(null);
  const webDragGhostHostRef = useRef<HTMLDivElement | null>(null);
  const [webDragGhostUsingClone, setWebDragGhostUsingClone] = useState(false);

  const [batchDrafts, setBatchDrafts] = useState<Record<string, BatchDraft>>({});
  const [batchDirtyFields, setBatchDirtyFields] = useState<Record<string, Partial<Record<BatchEditableField, true>>>>({});
  const [batchSaveState, setBatchSaveState] = useState<Record<string, SaveState>>({});
  const [mileageDistanceIndex, setMileageDistanceIndex] = useState<Map<string, any>>(new Map());

  const [athleteDrafts, setAthleteDrafts] = useState<Record<string, AthleteDraft>>({});
  const [athleteSaveState, setAthleteSaveState] = useState<Record<string, SaveState>>({});

  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [duplicatingKey, setDuplicatingKey] = useState<string | null>(null);
  const [fillingGroupKey, setFillingGroupKey] = useState<string | null>(null);
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, GroupSelectionMeta>>({});
  const [groupGridApis, setGroupGridApis] = useState<Record<string, GroupGridApi>>({});
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const categoryNames = useMemo(
    () =>
      (Array.isArray(categories) ? categories : [])
        .map((c) => String((c as any)?.name ?? "").trim())
        .filter((name) => !!name && name.toLowerCase() !== "other"),
    [categories]
  );
  const [auxiliaryRoutines, setAuxiliaryRoutines] = useState<AuxiliaryRoutine[]>([]);
  const [practiceDefaults, setPracticeDefaults] = useState<PracticeTimeDefaults>(emptyPracticeTimeDefaults());
  const [batchCategorySlots, setBatchCategorySlots] = useState<Record<string, string[]>>({});
  const [batchPreRoutineSlots, setBatchPreRoutineSlots] = useState<Record<string, string[]>>({});
  const [batchPostRoutineSlots, setBatchPostRoutineSlots] = useState<Record<string, string[]>>({});
  const [batchHeaderActive, setBatchHeaderActive] = useState(false);
  const batchHeaderActiveRef = useRef(false);
  const [batchHeaderFocusKey, setBatchHeaderFocusKey] = useState<string | null>(null);
  const [openBatchPicker, setOpenBatchPicker] = useState<null | {
    batchKey: string;
    field: "category" | "pre" | "post";
    slotIndex: number;
  }>(null);
  const [batchPickerQuery, setBatchPickerQuery] = useState("");
  const [activeGridId, setActiveGridId] = useState<string | null>(null);
  const [highlightBatchKey, setHighlightBatchKey] = useState<string | null>(null);
  const [openAthletePickerBatchKey, setOpenAthletePickerBatchKey] = useState<string | null>(null);
  const [openGroupCategoryPickerKey, setOpenGroupCategoryPickerKey] = useState<string | null>(null);
  const [removingAthleteId, setRemovingAthleteId] = useState<string | null>(null);
  const [pendingRemovedAthleteKeys, setPendingRemovedAthleteKeys] = useState<Set<string>>(new Set());
  const [athletePickerQuery, setAthletePickerQuery] = useState("");
  const [addingAthleteId, setAddingAthleteId] = useState<string | null>(null);
  const [athleteSelectionSyncByBatchKey, setAthleteSelectionSyncByBatchKey] = useState<Record<string, boolean>>({});
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [saveSignalTick, setSaveSignalTick] = useState(0);
  const [lastSavedAtMs, setLastSavedAtMs] = useState<number | null>(null);
  const justMovedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchHeaderInputRefs = useRef<Record<string, any>>({});
  const batchHeaderRegionRefs = useRef<Record<string, any>>({});
  const batchHeaderRootRef = useRef<any>(null);
  const headerBlurTimerRef = useRef<any>(null);
  const loadVersionRef = useRef(0);
  const autoFlushAttemptedDayRef = useRef<string | null>(null);

  const bumpSaveSignal = useCallback(() => {
    setSaveSignalTick((prev) => prev + 1);
  }, []);

  const markSavedNow = useCallback(() => {
    setLastSavedAtMs(Date.now());
  }, []);

  const handleGroupSelectionMetaChange = useCallback((groupKey: string, meta: GroupSelectionMeta) => {
    setSelectedByGroup((prev) => ({ ...prev, [groupKey]: meta }));
  }, []);

  const handleRegisterGroupGridApi = useCallback((groupKey: string, api: GroupGridApi | null) => {
    setGroupGridApis((prev) => {
      if (!api) {
        if (!(groupKey in prev)) return prev;
        const next = { ...prev };
        delete next[groupKey];
        return next;
      }
      if (prev[groupKey] === api) return prev;
      return { ...prev, [groupKey]: api };
    });
  }, []);

  useEffect(() => {
    batchDraftsRef.current = batchDrafts;
  }, [batchDrafts]);

  useEffect(() => {
    batchDirtyFieldsRef.current = batchDirtyFields;
  }, [batchDirtyFields]);

  useEffect(() => {
    athleteDraftsRef.current = athleteDrafts;
  }, [athleteDrafts]);

  useEffect(() => {
    batchHeaderActiveRef.current = batchHeaderActive;
  }, [batchHeaderActive]);

  const ensureTeamId = useCallback(async () => {
    if (teamIdRef.current) return teamIdRef.current;
    const teamId = await getCurrentTeamId();
    teamIdRef.current = teamId ? String(teamId) : null;
    patchAppRuntime({ currentTeamId: teamIdRef.current });
    return teamIdRef.current;
  }, [patchAppRuntime]);

  const resolveMileageLookupMeta = useCallback(
    (row: TeamWorkoutRow, rowDraft?: AthleteDraft, batchDraft?: BatchDraft) => {
      const athleteId = String(row.athlete_profile_id ?? "").trim();
      const effectiveSession = normalizeSession(String((rowDraft?.session ?? row.session) ?? "PM"));
      const effectiveDate = String(
        (batchDraft?.date_iso ? String(batchDraft.date_iso).trim() : String(row.date_iso ?? "")).trim()
      );

      if (!athleteId || !isISODateOnly(effectiveDate)) {
        return null;
      }

      const weekStartISO = getWeekStartISO(effectiveDate, DISTANCE_WEEK_START_DAY);
      const dayIdx = getWeekIndex(effectiveDate, weekStartISO);
      if (!Number.isFinite(dayIdx)) return null;

      return {
        athleteId,
        effectiveSession,
        effectiveDate,
        weekStartISO,
        dayIdx,
      };
    },
    []
  );

  const refreshMileageDistanceIndex = useCallback(async () => {
    const requestId = ++mileageDistanceRequestRef.current;

    if (rowsRaw.length === 0) {
      if (requestId !== mileageDistanceRequestRef.current) return;
      setMileageDistanceIndex(new Map());
      return;
    }

    const teamId = await ensureTeamId();
    if (!teamId) {
      if (requestId !== mileageDistanceRequestRef.current) return;
      setMileageDistanceIndex(new Map());
      return;
    }

    const requiredWeeks = new Set<string>();

    rowsRaw.forEach((row) => {
      const workoutId = String(row.id);
      const rowDraft = athleteDrafts[workoutId];
      const batchKey = row.batch_id ? getBatchKey(row) : null;
      const batchDraft = batchKey ? batchDrafts[batchKey] : undefined;
      const meta = resolveMileageLookupMeta(row, rowDraft, batchDraft);
      if (!meta) return;
      requiredWeeks.add(meta.weekStartISO);
    });

    if (requiredWeeks.size === 0) {
      if (requestId !== mileageDistanceRequestRef.current) return;
      setMileageDistanceIndex(new Map());
      return;
    }

    const loadByWeek = await Promise.all(
      Array.from(requiredWeeks).map(async (weekStartISO) => {
        const cells: TeamMileageCellRow[] = await fetchMileageCellsForWeek(weekStartISO);
        return { weekStartISO, cells };
      })
    );

    const nextIndex = new Map<string, any>();
    loadByWeek.forEach(({ weekStartISO, cells }) => {
      cells.forEach((cell) => {
        const athleteId = String(cell.athlete_profile_id ?? "").trim();
        const session = normalizeSession(String(cell.session ?? ""));
        const dayIdxRaw = Number(cell.day_idx);
        if (!athleteId || !Number.isFinite(dayIdxRaw)) return;
        const key = buildMileageLookupKey(athleteId, weekStartISO, dayIdxRaw, session);
        nextIndex.set(key, (cell as any).value);
      });
    });

    if (requestId !== mileageDistanceRequestRef.current) return;
    setMileageDistanceIndex(nextIndex);
  }, [athleteDrafts, batchDrafts, ensureTeamId, rowsRaw, resolveMileageLookupMeta]);

  const loadDay = useCallback(
    async (targetDateISO: string, requestVersion?: number) => {
      const isLatestRequest = () => requestVersion == null || requestVersion === loadVersionRef.current;
      console.log("[workouts] loadDay:start", { targetDateISO });
      if (!targetDateISO) {
        if (!isLatestRequest()) return false;
        setRowsRaw([]);
        return true;
      }

      const teamId = await ensureTeamId();
      if (!teamId) {
        if (!isLatestRequest()) return false;
        setRowsRaw([]);
        return true;
      }

      const [workoutRows, rosterRows, persistedDraftCache] = await Promise.all([
        listTeamWorkoutsInRange(targetDateISO, targetDateISO),
        loadTeamRoster(teamId),
        loadPersistedDayDraftCache(),
      ]);
      if (!isLatestRequest()) {
        console.log("[workouts] loadDay:staleSkipped", { targetDateISO, requestVersion });
        return false;
      }

      const persistedForDay = persistedDraftCache[targetDateISO];
      let nextRows = workoutRows;
      console.log("[workouts] loadDay:rows", { count: nextRows.length });

      setRosterNameById(toRosterMapById(rosterRows));
      setRosterOptions(rosterRows);

      const nextBatchDrafts: Record<string, BatchDraft> = {};
      const nextAthleteDrafts: Record<string, AthleteDraft> = {};

      const grouped = new Map<string, TeamWorkoutRow[]>();
      nextRows.forEach((w) => {
        const key = getBatchKey(w);
        const list = grouped.get(key) ?? [];
        list.push(w);
        grouped.set(key, list);
      });

      grouped.forEach((rows, key) => {
        const sample = rows[0];
        const sampleCategories = (Array.isArray(sample.categories) ? sample.categories : [])
          .map((c) => String(c ?? "").trim())
          .filter((c) => !!c && c.toLowerCase() !== "other");
        const samplePrimary = String(sample.primary_category ?? "").trim();
        nextBatchDrafts[key] = {
          session: normalizeSession(sample.session),
          date_iso: String(sample.date_iso ?? ""),
          location: String(sample.location ?? ""),
          time_text: String(sample.time_text ?? ""),
          title: String(sample.title ?? "Workout"),
          details: String(sample.details ?? ""),
          primary_category: samplePrimary,
          categories: sampleCategories.length > 0 ? sampleCategories : (samplePrimary ? [samplePrimary] : []),
          pre_routine_ids: (Array.isArray(sample.pre_routine_ids) ? sample.pre_routine_ids : [])
            .map((id) => String(id ?? "").trim())
            .filter(Boolean),
          post_routine_ids: (Array.isArray(sample.post_routine_ids) ? sample.post_routine_ids : [])
            .map((id) => String(id ?? "").trim())
            .filter(Boolean),
        };
      });

      nextRows.forEach((w) => {
        nextAthleteDrafts[String(w.id)] = toAthleteDraftFromRow(w);
      });

      let nextBatchDirtyFields: Record<string, Partial<Record<BatchEditableField, true>>> = {};
      if (persistedForDay) {
        const persistedBatchDrafts = persistedForDay.batchDrafts ?? {};
        const persistedAthleteDrafts = persistedForDay.athleteDrafts ?? {};
        const persistedBatchDirtyFields = persistedForDay.batchDirtyFields ?? {};

        Object.entries(persistedBatchDrafts).forEach(([batchKey, draft]) => {
          if (!nextBatchDrafts[batchKey]) return;
          nextBatchDrafts[batchKey] = {
            ...nextBatchDrafts[batchKey],
            ...draft,
            session: normalizeSession(String((draft as any)?.session ?? nextBatchDrafts[batchKey].session ?? "AM")),
            categories: sanitizeBatchCategoriesForPatch((draft as any)?.categories ?? nextBatchDrafts[batchKey].categories),
          };
        });

        Object.entries(persistedAthleteDrafts).forEach(([workoutId, draft]) => {
          if (!nextAthleteDrafts[workoutId]) return;
          nextAthleteDrafts[workoutId] = {
            ...nextAthleteDrafts[workoutId],
            ...draft,
            session: normalizeSession(String((draft as any)?.session ?? nextAthleteDrafts[workoutId].session ?? "AM")),
            categories: sanitizeAthleteCategories((draft as any)?.categories ?? nextAthleteDrafts[workoutId].categories),
          };
        });

        nextRows = workoutRows.map((row) => {
          const workoutId = String(row.id);
          const batchKey = getBatchKey(row);
          const batchDraft = nextBatchDrafts[batchKey];
          const athleteDraft = nextAthleteDrafts[workoutId];
          if (!batchDraft && !athleteDraft) return row;

          const merged: TeamWorkoutRow = { ...row };
          if (batchDraft) {
            merged.session = normalizeSession(String(batchDraft.session ?? merged.session));
            merged.date_iso = String(batchDraft.date_iso ?? merged.date_iso ?? "");
            merged.location = String(batchDraft.location ?? "").trim() || null;
            merged.time_text = String(batchDraft.time_text ?? "").trim() || null;
            merged.title = String(batchDraft.title ?? "").trim() || "Workout";
            merged.details = String(batchDraft.details ?? "").trim() || null;
            merged.primary_category = String(batchDraft.primary_category ?? "").trim() || null;
            merged.categories = sanitizeBatchCategoriesForPatch(batchDraft.categories);
          }
          if (athleteDraft) {
            merged.session = normalizeSession(String(athleteDraft.session ?? merged.session));
            merged.location = String(athleteDraft.location ?? "").trim() || null;
            merged.time_text = String(athleteDraft.time_text ?? "").trim() || null;
            merged.details = String(athleteDraft.details ?? "").trim() || null;
            merged.primary_category = String(athleteDraft.primary_category ?? "").trim() || null;
            merged.categories = sanitizeAthleteCategories(athleteDraft.categories);
          }
          return merged;
        });

        Object.entries(persistedBatchDirtyFields).forEach(([batchKey, dirty]) => {
          if (!nextBatchDrafts[batchKey]) return;
          nextBatchDirtyFields[batchKey] = { ...(dirty ?? {}) };
        });
      }

      setRowsRaw(nextRows);

      setBatchDrafts(nextBatchDrafts);
      batchDraftsRef.current = nextBatchDrafts;
      setBatchDirtyFields(nextBatchDirtyFields);
      batchDirtyFieldsRef.current = nextBatchDirtyFields;
      setBatchSaveState({});
      setAthleteDrafts(nextAthleteDrafts);
      athleteDraftsRef.current = nextAthleteDrafts;
      console.log("[workouts] loadDay:stateApplied", {
        batchDraftCount: Object.keys(nextBatchDrafts).length,
        athleteDraftCount: Object.keys(nextAthleteDrafts).length,
      });
      const nextSavedAthleteDrafts: Record<string, AthleteDraft> = {};
      workoutRows.forEach((w) => {
        nextSavedAthleteDrafts[String(w.id)] = toAthleteDraftFromRow(w);
      });
      savedAthleteDraftsRef.current = nextSavedAthleteDrafts;
      setAthleteSaveState({});
      setMoveMode(null);
      return true;
    },
    [ensureTeamId]
  );

  const refreshDayGuarded = useCallback(
    async (targetDateISO: string) => {
      const requestVersion = ++loadVersionRef.current;
      return await loadDay(targetDateISO, requestVersion);
    },
    [loadDay]
  );

  const resolveMileageDisplayForWorkout = useCallback(
    (row: TeamWorkoutRow, rowDraft?: AthleteDraft, batchDraft?: BatchDraft) => {
      const workoutId = String(row.id);
      const meta = resolveMileageLookupMeta(row, rowDraft, batchDraft);
      if (!meta) {
        console.log("[workouts-distance]", {
          workoutId,
          athleteId: String(row.athlete_profile_id ?? "").trim(),
          effectiveDate: null,
          effectiveSession: normalizeSession(String((rowDraft?.session ?? row.session) ?? "PM")),
          weekStartISO: null,
          dayIdx: null,
          found: false,
          display: "-",
        });
        return "-";
      }

      const { athleteId, effectiveSession, effectiveDate, weekStartISO, dayIdx } = meta;
      const key = buildMileageLookupKey(athleteId, weekStartISO, dayIdx, effectiveSession);
      const hasMatch = mileageDistanceIndex.has(key);
      const matchedValue = mileageDistanceIndex.get(key);
      const display = hasMatch ? formatMileageForSheet(matchedValue as any) || "-" : "-";

      console.log("[workouts-distance]", {
        athleteId,
        effectiveDate,
        effectiveSession,
        weekStartISO,
        dayIdx,
        found: hasMatch,
        final: display,
      });

      return display;
    },
    [mileageDistanceIndex, resolveMileageLookupMeta]
  );

  useEffect(() => {
    void refreshMileageDistanceIndex();
  }, [athleteDrafts, batchDrafts, rowsRaw, refreshMileageDistanceIndex]);

  const prescribedDistanceByWorkoutId = useMemo(() => {
    const next: Record<string, string> = {};
    rowsRaw.forEach((row) => {
      const workoutId = String(row.id);
      const batchKey = row.batch_id ? getBatchKey(row) : null;
      const batchDraft = batchKey ? batchDrafts[batchKey] : undefined;
      const distance = resolveMileageDisplayForWorkout(row, athleteDrafts[workoutId], batchDraft);
      next[workoutId] = distance;
    });
    return next;
  }, [athleteDrafts, batchDrafts, resolveMileageDisplayForWorkout, rowsRaw]);

  useEffect(() => {
    patchAppRuntime({
      activeDateISO: dayISO || null,
    });
  }, [batchParam, dayISO, highlightBatchKey, patchAppRuntime]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const previousDayISO = previousDayISORef.current;
        if (previousDayISO && previousDayISO !== dayISO) {
          void flushPendingEditsRef.current();
        }
        setLoading(true);
        await refreshDayGuarded(dayISO);
      } catch (e: any) {
        if (!mounted) return;
        patchAppRuntime({ lastSaveError: String(e?.message ?? e ?? "Could not load daily workouts.") });
        Alert.alert("Load failed", e?.message ?? "Could not load daily workouts.");
      } finally {
        if (mounted) {
          previousDayISORef.current = dayISO;
          setLoading(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [dayISO, patchAppRuntime, refreshDayGuarded]);

  useEffect(() => {
    const dirtyBatchCount = Object.values(batchDirtyFields).filter((dirty) => Object.keys(dirty ?? {}).length > 0).length;
    if (dirtyBatchCount === 0) return;
    console.log("[workouts] rowsRaw changed while batch dirty", {
      dirtyBatchCount,
      rowCount: rowsRaw.length,
    });
  }, [batchDirtyFields, rowsRaw]);

  useEffect(() => {
    const dirtyBatchCount = Object.values(batchDirtyFields).filter((dirty) => Object.keys(dirty ?? {}).length > 0).length;
    if (dirtyBatchCount === 0) return;
    console.log("[workouts] athleteDrafts changed while batch dirty", {
      dirtyBatchCount,
      athleteDraftCount: Object.keys(athleteDrafts).length,
    });
  }, [athleteDrafts, batchDirtyFields]);

  useEffect(() => {
    if (!batchParam) return;
    const key = `batch:${batchParam}`;
    setExpandedByBatchKey((prev) => ({ ...prev, [key]: true }));
    setHighlightBatchKey(key);
    const timer = setTimeout(() => {
      setHighlightBatchKey((prev) => (prev === key ? null : prev));
    }, 2200);
    return () => clearTimeout(timer);
  }, [batchParam, dayISO]);

  useEffect(() => {
    alreadyScrolledForBatchRef.current = null;
  }, [batchParam, dayISO]);

  useEffect(() => {
    if (!batchParam || loading) return;
    const key = `batch:${batchParam}`;
    if (alreadyScrolledForBatchRef.current === key) return;
    const y = batchHeaderYByKeyRef.current[key];
    if (!Number.isFinite(y)) return;
    workoutsScrollRef.current?.scrollTo?.({ y: Math.max(0, Number(y) - 72), animated: true });
    alreadyScrolledForBatchRef.current = key;
  }, [batchParam, loading, rowsRaw.length]);

  useEffect(() => {
    setActiveGridId(null);
    setOpenGroupCategoryPickerKey(null);
  }, [dayISO]);

  const setWebDragGhostClone = useCallback((clone: HTMLElement | null) => {
    const prev = webDragGhostCloneRef.current;
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    webDragGhostCloneRef.current = clone;
    setWebDragGhostUsingClone(!!clone);
    const host = webDragGhostHostRef.current;
    if (host) {
      host.innerHTML = "";
      if (clone) host.appendChild(clone);
      return;
    }
  }, []);

  const clearWebDragGhost = useCallback(() => {
    setWebDragGhost(null);
    setWebDragGhostClone(null);
    setWebDragGhostUsingClone(false);
  }, [setWebDragGhostClone]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!webDragGhost) return;
    const onDragOver = (event: DragEvent) => {
      const x = Number(event.clientX ?? 0);
      const y = Number(event.clientY ?? 0);
      if (!(x > 0 || y > 0)) return;
      setWebDragGhost((prev) => (prev ? { ...prev, x, y } : prev));
    };
    const clearGhost = () => clearWebDragGhost();
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", clearGhost);
    window.addEventListener("dragend", clearGhost);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", clearGhost);
      window.removeEventListener("dragend", clearGhost);
    };
  }, [clearWebDragGhost, webDragGhost]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const host = webDragGhostHostRef.current;
    if (!host) return;
    host.innerHTML = "";
    if (webDragGhost && webDragGhostCloneRef.current) {
      host.appendChild(webDragGhostCloneRef.current);
      setWebDragGhostUsingClone(host.childElementCount > 0);
      return;
    }
    setWebDragGhostUsingClone(false);
  }, [webDragGhost?.workoutId, webDragGhost?.batchKey]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [stored, routines, defaults] = await Promise.all([
        loadCoachCategories(),
        loadAuxiliaryRoutines(),
        loadPracticeTimeDefaults(),
      ]);
      if (!mounted) return;
      setCategories(stored);
      setAuxiliaryRoutines(Array.isArray(routines) ? routines : []);
      setPracticeDefaults(defaults);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const activateBatchHeader = useCallback((root?: any) => {
    if (headerBlurTimerRef.current) clearTimeout(headerBlurTimerRef.current);
    if (root) batchHeaderRootRef.current = root;
    setBatchHeaderActive(true);
    setActiveGridId(null);
  }, []);

  const scheduleBatchHeaderDeactivate = useCallback(() => {
    if (headerBlurTimerRef.current) clearTimeout(headerBlurTimerRef.current);
    headerBlurTimerRef.current = setTimeout(() => {
      const activeEl = Platform.OS === "web" ? (document.activeElement as HTMLElement | null) : null;
      const root = batchHeaderRootRef.current as any;
      const rootNode = root?.getScrollableNode?.() ?? root?.getInnerViewNode?.() ?? root;

      if (
        Platform.OS === "web" &&
        activeEl &&
        rootNode &&
        typeof rootNode.contains === "function" &&
        rootNode.contains(activeEl)
      ) {
        setBatchHeaderActive(true);
        return;
      }

      setBatchHeaderActive(false);
      setBatchHeaderFocusKey(null);
    }, 0);
  }, []);

  const activateBatchHeaderField = useCallback((batchKey: string, field: "session" | "location" | "date" | "time" | "title" | "athletes" | "notes" | "category" | "pre" | "post") => {
    activateBatchHeader(batchHeaderRegionRefs.current[batchKey]);
    setBatchHeaderFocusKey(`${batchKey}:${field}`);
  }, [activateBatchHeader]);

  const focusBatchHeaderField = useCallback((batchKey: string, field: "session" | "location" | "date" | "time" | "title" | "athletes" | "notes" | "category" | "pre" | "post") => {
    const refKey = `${batchKey}:${field}`;
    const el = batchHeaderInputRefs.current[refKey];
    if (el && typeof el.focus === "function") {
      el.focus();
      return;
    }
    if (Platform.OS === "web" && el?.current && typeof el.current.focus === "function") {
      el.current.focus();
    }
  }, []);

  const getBatchHeaderNeighborField = useCallback((
    field: "session" | "location" | "date" | "time" | "title" | "athletes" | "notes" | "category" | "pre" | "post",
    direction: "left" | "right" | "up" | "down"
  ): "session" | "location" | "date" | "time" | "title" | "athletes" | "notes" | "category" | "pre" | "post" | null => {
    const row1 = ["session", "location", "date", "time", "title", "athletes"] as const;
    const row2 = ["notes", "category", "pre", "post"] as const;
    const idx1 = row1.indexOf(field as any);
    const idx2 = row2.indexOf(field as any);

    if (direction === "left") {
      if (idx1 > 0) return row1[idx1 - 1];
      if (idx2 > 0) return row2[idx2 - 1];
      return null;
    }
    if (direction === "right") {
      if (idx1 >= 0 && idx1 < row1.length - 1) return row1[idx1 + 1];
      if (idx2 >= 0 && idx2 < row2.length - 1) return row2[idx2 + 1];
      return null;
    }
    if (direction === "down") {
      if (idx1 >= 0) return row2[Math.min(idx1, row2.length - 1)];
      return null;
    }
    if (idx2 >= 0) return row1[Math.min(idx2, row1.length - 1)];
    return null;
  }, []);

  const handleBatchHeaderKeyDown = useCallback((
    batchKey: string,
    field: "session" | "location" | "date" | "time" | "title" | "athletes" | "notes" | "category" | "pre" | "post",
    e: any
  ) => {
    const key = String(e?.key ?? "");
    const directionByKey: Record<string, "left" | "right" | "up" | "down"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const direction = directionByKey[key];
    if (!direction) return;

    e.preventDefault?.();
    e.stopPropagation?.();
    activateBatchHeaderField(batchKey, field);
    const nextField = getBatchHeaderNeighborField(field, direction);
    if (!nextField) return;
    focusBatchHeaderField(batchKey, nextField);
  }, [activateBatchHeaderField, focusBatchHeaderField, getBatchHeaderNeighborField]);

  const worksheetBatches = useMemo<WorksheetBatchRow[]>(() => {
    const previousCache = groupedAthletesCacheRef.current;
    const nextCache: Record<string, Record<string, GroupedAthleteRows>> = {};
    const map = new Map<string, TeamWorkoutRow[]>();
    const visibleRows = rowsRaw.filter((w) => {
      const batchId = String(w.batch_id ?? "").trim();
      if (!batchId) return true;
      const athleteId = String(w.athlete_profile_id ?? "").trim();
      if (!athleteId) return true;
      return !pendingRemovedAthleteKeys.has(`${batchId}::${athleteId}`);
    });
    visibleRows.forEach((w) => {
      const key = getBatchKey(w);
      const list = map.get(key) ?? [];
      list.push(w);
      map.set(key, list);
    });

    const rows: WorksheetBatchRow[] = Array.from(map.entries()).map(([key, workouts]) => {
      const sample = workouts[0];
      const uniqueAthletes = new Set(
        workouts.map((w) => String(w.athlete_profile_id ?? "").trim()).filter(Boolean)
      );

      const groupedByGroup = new Map<string | null, TeamWorkoutRow[]>();
      workouts.forEach((w) => {
        const groupRaw = String(w.group_id ?? "").trim();
        const groupId = groupRaw || null;
        const list = groupedByGroup.get(groupId) ?? [];
        list.push(w);
        groupedByGroup.set(groupId, list);
      });

      const presentOrder = Array.from(groupedByGroup.keys()).map((id) => encodeGroupOrderId(id));
      const preferredOrder = groupOrderByBatch[key] ?? presentOrder;
      const orderedGroupIds = preferredOrder
        .filter((encoded) => presentOrder.includes(encoded))
        .concat(presentOrder.filter((encoded) => !preferredOrder.includes(encoded)))
        .map((encoded) => decodeGroupOrderId(encoded));

      const previousGroupsByKey = previousCache[key] ?? {};
      const nextGroupsByKey: Record<string, GroupedAthleteRows> = {};
      const groupedAthletes: GroupedAthleteRows[] = orderedGroupIds.map((groupId, index) => {
          const groupRows = groupedByGroup.get(groupId) ?? [];
          const sortedRows = [...groupRows].sort((a, b) => {
            const na = String(rosterNameById.get(String(a.athlete_profile_id ?? "").trim()) ?? "");
            const nb = String(rosterNameById.get(String(b.athlete_profile_id ?? "").trim()) ?? "");
            return compareAthleteDisplayNamesByLastName(na, nb);
          });
          const groupLabel = `Group ${index + 1}`;
          const groupKey = buildGroupKey(key, groupId);
          const previousGroup = previousGroupsByKey[groupKey];
          if (
            previousGroup &&
            previousGroup.groupId === groupId &&
            previousGroup.groupLabel === groupLabel &&
            areOrderedGroupRowsUnchanged(previousGroup.rows, sortedRows)
          ) {
            nextGroupsByKey[groupKey] = previousGroup;
            return previousGroup;
          }
          const nextGroup: GroupedAthleteRows = {
            groupId,
            groupLabel,
            rows: sortedRows,
          };
          nextGroupsByKey[groupKey] = nextGroup;
          return nextGroup;
        });
      nextCache[key] = nextGroupsByKey;

      return {
        key,
        batchId: String(sample.batch_id ?? "").trim() || null,
        sample,
        workouts,
        groupedAthletes,
        athleteCount: Math.max(1, uniqueAthletes.size),
      };
    });

    const indexedRows = rows.map((row, index) => ({ row, index }));
    indexedRows.sort((left, right) => {
      const leftSession = normalizeSession(
        String(batchDrafts[left.row.key]?.session ?? left.row.sample.session ?? "")
      );
      const rightSession = normalizeSession(
        String(batchDrafts[right.row.key]?.session ?? right.row.sample.session ?? "")
      );
      const leftSessionRank = leftSession === "AM" ? 0 : 1;
      const rightSessionRank = rightSession === "AM" ? 0 : 1;
      if (leftSessionRank !== rightSessionRank) return leftSessionRank - rightSessionRank;

      const leftTimeText = String(batchDrafts[left.row.key]?.time_text ?? left.row.sample.time_text ?? "").trim();
      const rightTimeText = String(batchDrafts[right.row.key]?.time_text ?? right.row.sample.time_text ?? "").trim();
      const leftMinutes = parseTimeTextToSortableMinutes(leftTimeText);
      const rightMinutes = parseTimeTextToSortableMinutes(rightTimeText);
      const leftHasUsableTime = leftMinutes != null;
      const rightHasUsableTime = rightMinutes != null;

      if (leftHasUsableTime !== rightHasUsableTime) return leftHasUsableTime ? -1 : 1;
      if (leftHasUsableTime && rightHasUsableTime && leftMinutes !== rightMinutes) {
        return (leftMinutes as number) - (rightMinutes as number);
      }

      return left.index - right.index;
    });
    const sortedRows = indexedRows.map((entry) => entry.row);

    groupedAthletesCacheRef.current = nextCache;
    return sortedRows;
  }, [batchDrafts, groupOrderByBatch, pendingRemovedAthleteKeys, rowsRaw, rosterNameById]);

  const getCachedGroupAthleteSlices = useCallback(
    (groupKey: string, groupWorkoutIds: string[]): GroupAthletePropSlices => {
      const previous = groupAthleteSliceCacheRef.current[groupKey];
      if (
        areGroupAthleteSlicesUnchanged(
          previous,
          groupWorkoutIds,
          athleteDrafts,
          athleteSaveState,
          prescribedDistanceByWorkoutId
        )
      ) {
        return previous as GroupAthletePropSlices;
      }

      const nextAthleteDrafts: Record<string, AthleteDraft> = {};
      const nextAthleteSaveState: Record<string, SaveState> = {};
      const nextPrescribedDistanceByWorkoutId: Record<string, string> = {};

      groupWorkoutIds.forEach((workoutId) => {
        const draft = athleteDrafts[workoutId];
        if (draft) nextAthleteDrafts[workoutId] = draft;
        const saveState = athleteSaveState[workoutId];
        if (saveState) nextAthleteSaveState[workoutId] = saveState;
        const prescribed = resolvePrescribedForSlice(prescribedDistanceByWorkoutId, workoutId);
        if (prescribed) nextPrescribedDistanceByWorkoutId[workoutId] = prescribed;
      });

      const next: GroupAthletePropSlices = {
        workoutIds: [...groupWorkoutIds],
        athleteDrafts: nextAthleteDrafts,
        athleteSaveState: nextAthleteSaveState,
        prescribedDistanceByWorkoutId: nextPrescribedDistanceByWorkoutId,
      };
      groupAthleteSliceCacheRef.current[groupKey] = next;
      return next;
    },
    [athleteDrafts, athleteSaveState, prescribedDistanceByWorkoutId]
  );

  useEffect(() => {
    const activeGroupKeys = new Set<string>();
    worksheetBatches.forEach((batchRow) => {
      batchRow.groupedAthletes.forEach((group) => {
        activeGroupKeys.add(buildGroupKey(batchRow.key, group.groupId));
      });
    });

    const cache = groupAthleteSliceCacheRef.current;
    Object.keys(cache).forEach((groupKey) => {
      if (!activeGroupKeys.has(groupKey)) delete cache[groupKey];
    });
  }, [worksheetBatches]);

  useEffect(() => {
    setBatchCategorySlots((prev) => {
      const next = { ...prev };
      worksheetBatches.forEach((batchRow) => {
        if (next[batchRow.key] && next[batchRow.key].length > 0) return;
        const draftCategories = normalizeCategoryArrayForGrid(
          Array.isArray(batchDrafts[batchRow.key]?.categories) ? batchDrafts[batchRow.key]?.categories : []
        );
        const sampleCategories = normalizeCategoryArrayForGrid(
          Array.isArray(batchRow.sample.categories) ? batchRow.sample.categories : []
        );
        const fallback = String(batchDrafts[batchRow.key]?.primary_category ?? batchRow.sample.primary_category ?? "").trim();
        const fallbackCategories = fallback ? normalizeCategoryArrayForGrid([fallback]) : [];
        const resolved = draftCategories.length > 0 ? draftCategories : (sampleCategories.length > 0 ? sampleCategories : fallbackCategories);
        next[batchRow.key] = resolved.length > 0 ? resolved : [""];
      });
      return next;
    });
    setBatchPreRoutineSlots((prev) => {
      const next = { ...prev };
      worksheetBatches.forEach((batchRow) => {
        if (next[batchRow.key]) return;
        next[batchRow.key] = Array.isArray(batchRow.sample.pre_routine_ids)
          ? batchRow.sample.pre_routine_ids.map((id) => String(id ?? "").trim()).filter(Boolean)
          : [];
      });
      return next;
    });
    setBatchPostRoutineSlots((prev) => {
      const next = { ...prev };
      worksheetBatches.forEach((batchRow) => {
        if (next[batchRow.key]) return;
        next[batchRow.key] = Array.isArray(batchRow.sample.post_routine_ids)
          ? batchRow.sample.post_routine_ids.map((id) => String(id ?? "").trim()).filter(Boolean)
          : [];
      });
      return next;
    });
  }, [batchDrafts, worksheetBatches]);

  useEffect(() => {
    setGroupOrderByBatch((prev) => {
      const grouped = new Map<string, string[]>();
      rowsRaw.forEach((w) => {
        const batchKey = getBatchKey(w);
        const groupId = encodeGroupOrderId(String(w.group_id ?? "").trim() || null);
        const list = grouped.get(batchKey) ?? [];
        if (!list.includes(groupId)) list.push(groupId);
        grouped.set(batchKey, list);
      });

      let changed = false;
      const next: Record<string, string[]> = {};

      grouped.forEach((present, batchKey) => {
        const prevOrder = prev[batchKey] ?? [];
        const baseOrder =
          prevOrder.length > 0 ? prevOrder : [...present].sort(compareEncodedGroupOrder);
        const merged = baseOrder
          .filter((id) => present.includes(id))
          .concat(present.filter((id) => !baseOrder.includes(id)));
        next[batchKey] = merged;
        if (!changed && JSON.stringify(merged) !== JSON.stringify(prevOrder)) changed = true;
      });

      const prevKeys = Object.keys(prev);
      if (!changed && prevKeys.length !== Object.keys(next).length) changed = true;

      return changed ? next : prev;
    });
  }, [rowsRaw]);

  useEffect(() => {
    setExpandedByBatchKey((prev) => {
      const next = { ...prev };
      worksheetBatches.forEach((row) => {
        if (!(row.key in next)) next[row.key] = true;
      });
      return next;
    });
  }, [worksheetBatches]);

  const setBatchSavedSoonIdle = (batchKey: string) => {
    setTimeout(() => {
      setBatchSaveState((prev) => {
        if (prev[batchKey]?.status !== "saved") return prev;
        const next = { ...prev };
        next[batchKey] = { status: "idle" };
        return next;
      });
    }, 2000);
  };

  const setAthleteSavedSoonIdle = (workoutId: string) => {
    setTimeout(() => {
      setAthleteSaveState((prev) => {
        if (prev[workoutId]?.status !== "saved") return prev;
        const next = { ...prev };
        next[workoutId] = { status: "idle" };
        return next;
      });
    }, 2000);
  };

  const commitBatchEdit = useCallback(
    async (batchKey: string) => {
      const dirty = batchDirtyFieldsRef.current[batchKey] ?? {};
      const dirtyKeys = Object.keys(dirty) as BatchEditableField[];
      if (dirtyKeys.length === 0) return;

      const draft = batchDraftsRef.current[batchKey];
      if (!draft) return;

      if (dirtyKeys.includes("date_iso")) {
        const trimmedDate = String(draft.date_iso ?? "").trim();
        if (trimmedDate && !isISODateOnly(trimmedDate)) {
          setBatchSaveState((prev) => ({
            ...prev,
            [batchKey]: { status: "error", message: "Use YYYY-MM-DD" },
          }));
          return;
        }
      }

      const payload = toBatchCloudPatchFromDraft(draft, dirtyKeys);

      if (Object.keys(payload).length === 0) return;

      console.log("[workouts] commitBatchEdit:start", {
        batchKey,
        dirtyKeys,
        payload,
      });
      if (!isUnmountingRef.current) {
        setBatchSaveState((prev) => ({ ...prev, [batchKey]: { status: "saving" } }));
      }

      try {
        const parsed = parseBatchKey(batchKey);
        if (parsed.isBatch) {
          await updateTeamWorkoutsByBatchId(parsed.id, payload);
        } else {
          await updateTeamWorkoutById(parsed.id, payload);
        }

        batchDirtyFieldsRef.current = { ...batchDirtyFieldsRef.current, [batchKey]: {} };
        if (!isUnmountingRef.current) {
          setBatchDirtyFields((prev) => ({ ...prev, [batchKey]: {} }));
          setBatchSaveState((prev) => ({ ...prev, [batchKey]: { status: "saved" } }));
          setBatchSavedSoonIdle(batchKey);
          markSavedNow();
        }
        console.log("[workouts] commitBatchEdit:success", { batchKey, dirtyKeys });
        const nextDateISO = String(draft.date_iso ?? "").trim();
        if (!isUnmountingRef.current && isISODateOnly(nextDateISO) && nextDateISO !== dayISO) {
          router.replace({
            pathname: "/(coach)/workouts",
            params: { date: nextDateISO },
          });
        }
      } catch (e: any) {
        console.log("[workouts] commitBatchEdit:error", {
          batchKey,
          message: String(e?.message ?? e ?? "Save failed"),
        });
        if (!isUnmountingRef.current) {
          setBatchSaveState((prev) => ({
            ...prev,
            [batchKey]: { status: "error", message: String(e?.message ?? "Save failed") },
          }));
        }
      }
    },
    [dayISO, markSavedNow, router]
  );

  const scheduleBatchSave = useCallback(
    (batchKey: string, delayMs = 450) => {
      const current = batchSaveTimersRef.current[batchKey];
      if (current) clearTimeout(current);
      bumpSaveSignal();
      batchSaveTimersRef.current[batchKey] = setTimeout(() => {
        delete batchSaveTimersRef.current[batchKey];
        bumpSaveSignal();
        void commitBatchEdit(batchKey);
      }, delayMs);
    },
    [bumpSaveSignal, commitBatchEdit]
  );

  const scheduleBatchRoutineSave = useCallback(
    (batchKey: string, field: "pre" | "post", nextIds: string[], delayMs = 450) => {
      const timerKey = `${batchKey}:${field}`;
      const current = batchRoutineSaveTimersRef.current[timerKey];
      if (current) clearTimeout(current);
      setBatchSaveState((prev) => ({ ...prev, [batchKey]: { status: "saving" } }));
      bumpSaveSignal();
      batchRoutineSaveTimersRef.current[timerKey] = setTimeout(async () => {
        delete batchRoutineSaveTimersRef.current[timerKey];
        bumpSaveSignal();
        try {
          const parsed = parseBatchKey(batchKey);
          const payload =
            field === "pre"
              ? ({ pre_routine_ids: nextIds } as Partial<TeamWorkoutRow>)
              : ({ post_routine_ids: nextIds } as Partial<TeamWorkoutRow>);
          if (parsed.isBatch) {
            await updateTeamWorkoutsByBatchId(parsed.id, payload);
          } else {
            await updateTeamWorkoutById(parsed.id, payload);
          }
          setBatchSaveState((prev) => ({ ...prev, [batchKey]: { status: "saved" } }));
          setBatchSavedSoonIdle(batchKey);
          markSavedNow();
        } catch (e: any) {
          setBatchSaveState((prev) => ({
            ...prev,
            [batchKey]: { status: "error", message: String(e?.message ?? "Save failed") },
          }));
        }
      }, delayMs);
    },
    [bumpSaveSignal, markSavedNow]
  );

  const commitAthleteEdit = useCallback(
    async (workoutId: string) => {
      const draft = athleteDraftsRef.current[workoutId];
      if (!draft) return;

      const payload = toAthleteCloudPatch(draft);

      if (!isUnmountingRef.current) {
        setAthleteSaveState((prev) => ({ ...prev, [workoutId]: { status: "saving" } }));
      }

      try {
        await updateTeamWorkoutById(workoutId, payload);

        savedAthleteDraftsRef.current[workoutId] = toSavedAthleteDraftSnapshot(draft);
        if (!isUnmountingRef.current) {
          setAthleteSaveState((prev) => ({ ...prev, [workoutId]: { status: "saved" } }));
          setAthleteSavedSoonIdle(workoutId);
          markSavedNow();
        }
      } catch (e: any) {
        if (!isUnmountingRef.current) {
          setAthleteSaveState((prev) => ({
            ...prev,
            [workoutId]: { status: "error", message: String(e?.message ?? "Save failed") },
          }));
        }
      }
    },
    [markSavedNow]
  );

  const scheduleAthleteSave = useCallback(
    (workoutId: string, delayMs = 600) => {
      const current = athleteSaveTimersRef.current[workoutId];
      if (current) clearTimeout(current);
      bumpSaveSignal();
      athleteSaveTimersRef.current[workoutId] = setTimeout(() => {
        delete athleteSaveTimersRef.current[workoutId];
        bumpSaveSignal();
        void commitAthleteEdit(workoutId);
      }, delayMs);
    },
    [bumpSaveSignal, commitAthleteEdit]
  );

  const flushAllPendingBatchSaves = useCallback(async () => {
    const timedBatchKeys = Object.keys(batchSaveTimersRef.current);
    timedBatchKeys.forEach((batchKey) => {
      const timer = batchSaveTimersRef.current[batchKey];
      if (timer) clearTimeout(timer);
      delete batchSaveTimersRef.current[batchKey];
    });
    if (timedBatchKeys.length > 0) bumpSaveSignal();

    const dirtyBatchKeys = Object.entries(batchDirtyFieldsRef.current)
      .filter(([, dirty]) => Object.keys(dirty ?? {}).length > 0)
      .map(([batchKey]) => batchKey);
    const batchKeysToFlush = Array.from(new Set([...timedBatchKeys, ...dirtyBatchKeys]));
    if (batchKeysToFlush.length === 0) return;

    console.log("[workouts] flushAllPendingBatchSaves", {
      count: batchKeysToFlush.length,
      keys: batchKeysToFlush,
    });

    for (const batchKey of batchKeysToFlush) {
      await commitBatchEdit(batchKey);
    }
  }, [bumpSaveSignal, commitBatchEdit]);

  const flushAllPendingAthleteSaves = useCallback(async () => {
    const timedWorkoutIds = Object.keys(athleteSaveTimersRef.current);
    timedWorkoutIds.forEach((workoutId) => {
      const timer = athleteSaveTimersRef.current[workoutId];
      if (timer) clearTimeout(timer);
      delete athleteSaveTimersRef.current[workoutId];
    });
    if (timedWorkoutIds.length > 0) bumpSaveSignal();

    const changedWorkoutIds = Object.entries(athleteDraftsRef.current)
      .filter(([workoutId, draft]) => {
        const saved = savedAthleteDraftsRef.current[workoutId];
        if (!saved) return true;
        return JSON.stringify(draft) !== JSON.stringify(saved);
      })
      .map(([workoutId]) => workoutId);

    const workoutIds = Array.from(new Set([...timedWorkoutIds, ...changedWorkoutIds]));
    if (workoutIds.length === 0) return;

    console.log("[workouts] flushAllPendingAthleteSaves", { count: workoutIds.length });
    for (const workoutId of workoutIds) {
      await commitAthleteEdit(workoutId);
    }
  }, [bumpSaveSignal, commitAthleteEdit]);

  useEffect(() => {
    flushPendingEditsRef.current = async () => {
      await flushAllPendingBatchSaves();
      await flushAllPendingAthleteSaves();
    };
  }, [flushAllPendingAthleteSaves, flushAllPendingBatchSaves]);

  const hasQueuedDebounceSaves = useMemo(() => {
    return (
      Object.keys(batchSaveTimersRef.current).length > 0 ||
      Object.keys(batchRoutineSaveTimersRef.current).length > 0 ||
      Object.keys(athleteSaveTimersRef.current).length > 0
    );
  }, [saveSignalTick]);

  const queuedDebounceSaveCount = useMemo(() => {
    return (
      Object.keys(batchSaveTimersRef.current).length +
      Object.keys(batchRoutineSaveTimersRef.current).length +
      Object.keys(athleteSaveTimersRef.current).length
    );
  }, [saveSignalTick]);

  const hasPendingBatchChanges = useMemo(
    () => Object.values(batchDirtyFields).some((dirty) => Object.keys(dirty ?? {}).length > 0),
    [batchDirtyFields]
  );

  const hasPendingAthleteChanges = useMemo(() => {
    const drafts = athleteDrafts;
    for (const workoutId of Object.keys(drafts)) {
      const draft = drafts[workoutId];
      const saved = savedAthleteDraftsRef.current[workoutId];
      if (!saved) return true;
      if (JSON.stringify(draft) !== JSON.stringify(saved)) return true;
    }
    return false;
  }, [athleteDrafts, athleteSaveState]);

  const firstBatchError = useMemo(
    () => Object.values(batchSaveState).find((state) => state?.status === "error"),
    [batchSaveState]
  );
  const firstAthleteError = useMemo(
    () => Object.values(athleteSaveState).find((state) => state?.status === "error"),
    [athleteSaveState]
  );
  const firstSaveError = firstBatchError ?? firstAthleteError;

  const anySaving = useMemo(() => {
    const batchSaving = Object.values(batchSaveState).some((state) => state?.status === "saving");
    if (batchSaving) return true;
    return Object.values(athleteSaveState).some((state) => state?.status === "saving");
  }, [athleteSaveState, batchSaveState]);

  const anySavedRecently = useMemo(() => {
    const batchSaved = Object.values(batchSaveState).some((state) => state?.status === "saved");
    if (batchSaved) return true;
    return Object.values(athleteSaveState).some((state) => state?.status === "saved");
  }, [athleteSaveState, batchSaveState]);

  const showPendingEdits = hasPendingBatchChanges || hasPendingAthleteChanges || hasQueuedDebounceSaves;

  useEffect(() => {
    if (!dayISO) return;
    if (!showPendingEdits) {
      if (autoFlushAttemptedDayRef.current === dayISO) autoFlushAttemptedDayRef.current = null;
      return;
    }
    if (loading) return;
    if (autoFlushAttemptedDayRef.current === dayISO) return;
    autoFlushAttemptedDayRef.current = dayISO;
    const timer = setTimeout(() => {
      void flushPendingEditsRef.current();
    }, 220);
    return () => clearTimeout(timer);
  }, [dayISO, loading, showPendingEdits]);

  const pendingChangeCount = useMemo(() => {
    const pendingBatchCount = Object.values(batchDirtyFields).filter((dirty) => Object.keys(dirty ?? {}).length > 0).length;
    let pendingAthleteCount = 0;
    const drafts = athleteDrafts;
    for (const workoutId of Object.keys(drafts)) {
      const draft = drafts[workoutId];
      const saved = savedAthleteDraftsRef.current[workoutId];
      if (!saved || JSON.stringify(draft) !== JSON.stringify(saved)) pendingAthleteCount += 1;
    }
    return pendingBatchCount + pendingAthleteCount;
  }, [athleteDrafts, batchDirtyFields, athleteSaveState]);

  useEffect(() => {
    if (!dayISO) return;
    const timer = setTimeout(() => {
      void (async () => {
        const cache = await loadPersistedDayDraftCache();
        const next = { ...cache };
        if (!showPendingEdits) {
          if (next[dayISO]) {
            delete next[dayISO];
            await savePersistedDayDraftCache(next);
          }
          return;
        }
        next[dayISO] = {
          batchDrafts,
          batchDirtyFields,
          athleteDrafts,
          updatedAt: Date.now(),
        };
        await savePersistedDayDraftCache(next);
      })();
    }, 280);

    return () => clearTimeout(timer);
  }, [athleteDrafts, batchDirtyFields, batchDrafts, dayISO, showPendingEdits]);

  const lastSavedLabel = useMemo(() => {
    if (!lastSavedAtMs) return "";
    return new Date(lastSavedAtMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }, [lastSavedAtMs]);

  const headerSaveDisplay = useMemo<HeaderSaveDisplayState>(() => {
    if (firstSaveError) {
      return {
        kind: "error",
        message: firstSaveError.message,
        detail: isLikelyConnectivityError(firstSaveError.message)
          ? "Sync delayed. Retry will happen on your next save attempt."
          : undefined,
      };
    }
    if (anySaving) {
      const activeCount = Math.max(1, pendingChangeCount);
      return {
        kind: "saving",
        detail: activeCount === 1 ? "Saving 1 change..." : `Saving ${activeCount} changes...`,
      };
    }
    if (showPendingEdits) {
      const pendingText =
        pendingChangeCount > 0
          ? pendingChangeCount === 1
            ? "1 change pending"
            : `${pendingChangeCount} changes pending`
          : "Pending save";
      const queuedText =
        queuedDebounceSaveCount > 0
          ? queuedDebounceSaveCount === 1
            ? "Autosave queued"
            : `${queuedDebounceSaveCount} autosaves queued`
          : undefined;
      return { kind: "pending", detail: queuedText ? `${pendingText} • ${queuedText}` : pendingText };
    }
    if (anySavedRecently || lastSavedAtMs) {
      return {
        kind: "saved",
        detail: lastSavedLabel ? `Saved at ${lastSavedLabel}` : "All changes saved",
      };
    }
    return { kind: "idle", detail: "No unsaved changes" };
  }, [
    anySavedRecently,
    anySaving,
    firstSaveError,
    lastSavedAtMs,
    lastSavedLabel,
    pendingChangeCount,
    queuedDebounceSaveCount,
    showPendingEdits,
  ]);

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true;
      console.log("[workouts] unmount:flushing pending saves");
      void (async () => {
        await flushAllPendingBatchSaves();
        await flushAllPendingAthleteSaves();
      })();
      Object.values(batchRoutineSaveTimersRef.current).forEach((t) => clearTimeout(t));
      if (headerBlurTimerRef.current) clearTimeout(headerBlurTimerRef.current);
      if (justMovedTimerRef.current) clearTimeout(justMovedTimerRef.current);
    };
  }, [flushAllPendingAthleteSaves, flushAllPendingBatchSaves]);

  const onEditBatchField = (batchKey: string, field: BatchEditableField, value: string | string[]) => {
    console.log("[workouts] onEditBatchField", { batchKey, field, value });
    const parsed = parseBatchKey(batchKey);
    const matchingRows = rowsRaw.filter((w) =>
      parsed.isBatch
        ? String(w.batch_id ?? "").trim() === parsed.id
        : String(w.id) === parsed.id
    );

    setBatchDrafts((prev) => {
      const current = prev[batchKey] ?? ({} as BatchDraft);
      const nextDraft =
        field === "categories"
          ? (() => {
              const cleaned = normalizeCategoryArrayForGrid(Array.isArray(value) ? value : []);
              return {
                ...current,
                categories: cleaned,
                primary_category: cleaned[0] ?? "",
              };
            })()
          : field === "session"
            ? (() => {
                const nextSession = normalizeSession(String(value ?? ""));
                const fallbackRow = matchingRows[0];
                const currentSession = normalizeSession(String(current.session ?? fallbackRow?.session ?? "AM"));
                const effectiveDateISO = String(current.date_iso ?? fallbackRow?.date_iso ?? "").trim();
                const nextTimeText = resolveSessionSwitchTime({
                  dateISO: effectiveDateISO,
                  defaults: practiceDefaults,
                  fromSession: currentSession,
                  toSession: nextSession,
                  currentTimeText: String(current.time_text ?? fallbackRow?.time_text ?? ""),
                });
                return {
                  ...current,
                  session: nextSession,
                  time_text: nextTimeText,
                };
              })()
          : { ...current, [field]: String(value ?? "") };
      const next = { ...prev, [batchKey]: nextDraft };
      batchDraftsRef.current = next;
      return next;
    });
    setBatchDirtyFields((prev) => {
      const next = {
        ...prev,
        [batchKey]:
          field === "session"
            ? { ...(prev[batchKey] ?? {}), session: true, time_text: true }
            : { ...(prev[batchKey] ?? {}), [field]: true },
      };
      batchDirtyFieldsRef.current = next;
      return next;
    });

    const matchingWorkoutIds = matchingRows.map((w) => String(w.id));

    let clearedAthleteTimers = 0;
    matchingWorkoutIds.forEach((workoutId) => {
      const timer = athleteSaveTimersRef.current[workoutId];
      if (!timer) return;
      clearTimeout(timer);
      delete athleteSaveTimersRef.current[workoutId];
      clearedAthleteTimers += 1;
    });

    setRowsRaw((prev) =>
      prev.map((w) => {
        const match = parsed.isBatch
          ? String(w.batch_id ?? "").trim() === parsed.id
          : String(w.id) === parsed.id;
        if (!match) return w;

        if (field === "session") {
          const nextSession = normalizeSession(String(value ?? ""));
          const currentSession = normalizeSession(String(w.session ?? ""));
          const effectiveDateISO = String((batchDraftsRef.current[batchKey]?.date_iso ?? w.date_iso ?? "")).trim();
          const nextTimeText = resolveSessionSwitchTime({
            dateISO: effectiveDateISO,
            defaults: practiceDefaults,
            fromSession: currentSession,
            toSession: nextSession,
            currentTimeText: String(w.time_text ?? ""),
          });
          return { ...w, session: nextSession, time_text: nextTimeText };
        }
        if (field === "date_iso") return { ...w, date_iso: String(value ?? "") };
        if (field === "title") return { ...w, title: String(value ?? "") };
        if (field === "location") return { ...w, location: String(value ?? "") };
        if (field === "time_text") return { ...w, time_text: String(value ?? "") };
        if (field === "details") return { ...w, details: String(value ?? "") };
        if (field === "categories") {
          const cleaned = normalizeCategoryArrayForGrid(Array.isArray(value) ? value : []);
          return {
            ...w,
            primary_category: cleaned[0] ?? null,
            categories: cleaned,
          };
        }
        if (field === "primary_category") {
          const normalized = String(value ?? "").trim();
          return {
            ...w,
            primary_category: normalized,
            categories: normalized ? [normalized] : [],
          };
        }
        return w;
      })
    );

    setAthleteDrafts((prev) => {
      if (matchingWorkoutIds.length === 0) return prev;
      const next = { ...prev };
      matchingWorkoutIds.forEach((workoutId) => {
        const current = next[workoutId] ?? {
          session: "AM" as const,
          location: "",
          time_text: "",
          details: "",
          primary_category: "",
          categories: [] as string[],
        };

        if (field === "session") {
          const nextSession = normalizeSession(String(value ?? ""));
          const row = rowsRaw.find((r) => String(r.id) === workoutId);
          const effectiveDateISO = String((batchDraftsRef.current[batchKey]?.date_iso ?? row?.date_iso ?? "")).trim();
          const currentSession = normalizeSession(String(current.session ?? row?.session ?? "AM"));
          const nextTimeText = resolveSessionSwitchTime({
            dateISO: effectiveDateISO,
            defaults: practiceDefaults,
            fromSession: currentSession,
            toSession: nextSession,
            currentTimeText: String(current.time_text ?? row?.time_text ?? ""),
          });
          next[workoutId] = { ...current, session: nextSession, time_text: nextTimeText };
          return;
        }
        if (field === "location") {
          next[workoutId] = { ...current, location: String(value ?? "") };
          return;
        }
        if (field === "time_text") {
          next[workoutId] = { ...current, time_text: String(value ?? "") };
          return;
        }
        if (field === "details") {
          next[workoutId] = { ...current, details: String(value ?? "") };
          return;
        }
        if (field === "categories") {
          const cleaned = normalizeCategoryArrayForGrid(Array.isArray(value) ? value : []);
          next[workoutId] = {
            ...current,
            primary_category: cleaned[0] ?? "",
            categories: cleaned,
          };
          return;
        }
        if (field === "primary_category") {
          const normalized = String(value ?? "").trim();
          next[workoutId] = {
            ...current,
            primary_category: normalized,
            categories: normalized ? [normalized] : [],
          };
        }
      });
      athleteDraftsRef.current = next;
      return next;
    });

    console.log("[workouts] onEditBatchField:applied", {
      batchKey,
      field,
      updatedRows: matchingWorkoutIds.length,
      clearedAthleteTimers,
    });
    scheduleBatchSave(batchKey);
  };

  const onEditAthleteField = useCallback((
    workoutId: string,
    field: AthleteEditableField,
    value: string
  ) => {
    setAthleteDrafts((prev) => {
      const next = {
        ...prev,
        [workoutId]: {
          ...(prev[workoutId] ?? {
            session: "AM",
            location: "",
            time_text: "",
            details: "",
            primary_category: "",
            categories: [],
          }),
          [field]: value,
        },
      };
      athleteDraftsRef.current = next;
      return next;
    });

    setRowsRaw((prev) =>
      prev.map((w) => {
        if (String(w.id) !== workoutId) return w;
        if (field === "time_text") {
          return { ...w, time_text: value };
        }
        if (field === "location") {
          return { ...w, location: value };
        }
        if (field === "details") {
          return { ...w, details: value };
        }
        if (field === "primary_category") {
          const normalized = String(value ?? "").trim();
          return { ...w, primary_category: normalized || null, categories: normalized ? [normalized] : [] };
        }
        return w;
      })
    );

    scheduleAthleteSave(workoutId);
  }, [scheduleAthleteSave]);

  const onEditAthleteSession = useCallback((workoutId: string, session: "AM" | "PM") => {
    const row = rowsRaw.find((w) => String(w.id) === workoutId);
    const currentDraft = athleteDraftsRef.current[workoutId];
    const currentSession = normalizeSession(String(currentDraft?.session ?? row?.session ?? "AM"));
    const nextTimeText = resolveSessionSwitchTime({
      dateISO: String(row?.date_iso ?? ""),
      defaults: practiceDefaults,
      fromSession: currentSession,
      toSession: session,
      currentTimeText: String(currentDraft?.time_text ?? row?.time_text ?? ""),
    });

    setAthleteDrafts((prev) => {
      const next = {
        ...prev,
        [workoutId]: {
          ...(prev[workoutId] ?? {
            session: "AM",
            location: "",
            time_text: "",
            details: "",
            primary_category: "",
            categories: [],
          }),
          session,
          time_text: nextTimeText,
        },
      };
      athleteDraftsRef.current = next;
      return next;
    });

    setRowsRaw((prev) =>
      prev.map((w) => (String(w.id) === workoutId ? { ...w, session, time_text: nextTimeText } : w))
    );

    scheduleAthleteSave(workoutId);
  }, [practiceDefaults, rowsRaw, scheduleAthleteSave]);

  const applyCategoriesToWorkoutIds = useCallback((workoutIds: string[], categoriesInput: string[]) => {
    const ids = Array.from(new Set((Array.isArray(workoutIds) ? workoutIds : []).map((id) => String(id ?? "").trim()).filter(Boolean)));
    if (ids.length === 0) return;
    const normalized = normalizeCategoryArrayForGrid(Array.isArray(categoriesInput) ? categoriesInput : []);
    const primary = normalized[0] ?? "";
    const idsSet = new Set(ids);

    setAthleteDrafts((prev) => {
      const next = { ...prev };
      ids.forEach((workoutId) => {
        next[workoutId] = {
          ...(prev[workoutId] ?? {
            session: "AM",
            location: "",
            time_text: "",
            details: "",
            primary_category: "",
            categories: [],
          }),
          primary_category: primary,
          categories: normalized,
        };
      });
      athleteDraftsRef.current = next;
      return next;
    });

    setRowsRaw((prev) =>
      prev.map((w) =>
        idsSet.has(String(w.id))
          ? {
              ...w,
              primary_category: primary || null,
              categories: normalized,
            }
          : w
      )
    );

    ids.forEach((workoutId) => scheduleAthleteSave(workoutId));
  }, [scheduleAthleteSave]);

  const onEditAthleteCategories = useCallback((workoutId: string, categoriesInput: string[]) => {
    applyCategoriesToWorkoutIds([workoutId], categoriesInput);
  }, [applyCategoriesToWorkoutIds]);

  const goToDate = useCallback((targetDateISO: string) => {
    void (async () => {
      void flushPendingEditsRef.current();
      router.replace({ pathname: "/(coach)/workouts", params: { date: targetDateISO } });
    })();
  }, [router]);

  const confirmDelete = useCallback(async (title: string, message: string): Promise<boolean> => {
    if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
      return globalThis.confirm(message);
    }

    return await new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Delete", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
  }, []);

  const deleteBatchOrSingle = async (row: WorksheetBatchRow) => {
    const ok = await confirmDelete(
      row.batchId ? "Delete workout batch?" : "Delete workout?",
      row.batchId
        ? "This will delete all workouts in this batch for all athletes. This can’t be undone."
        : "This will permanently delete this workout."
    );
    if (!ok) return;

    try {
      setDeletingKey(row.key);
      if (row.batchId) await deleteWorkoutBatch(row.batchId);
      else await deleteTeamWorkout(String(row.sample.id));
      await refreshDayGuarded(dayISO);
    } catch (e: any) {
      Alert.alert("Delete failed", e?.message ?? "Could not delete row.");
    } finally {
      setDeletingKey((prev) => (prev === row.key ? null : prev));
    }
  };

  const deleteSingleWorkout = useCallback(async (workoutId: string) => {
    const ok = await confirmDelete("Delete workout?", "Delete this individual workout?");
    if (!ok) return;
    try {
      setDeletingKey(workoutId);
      await deleteTeamWorkout(workoutId);
      await refreshDayGuarded(dayISO);
    } catch (e: any) {
      Alert.alert("Delete failed", e?.message ?? "Could not delete workout.");
    } finally {
      setDeletingKey((prev) => (prev === workoutId ? null : prev));
    }
  }, [confirmDelete, dayISO, refreshDayGuarded]);

  const duplicateBatchOrSingle = async (row: WorksheetBatchRow) => {
    try {
      setDuplicatingKey(row.key);
      const teamId = await ensureTeamId();
      if (!teamId) throw new Error("No team selected.");

      const newBatchId = row.batchId
        ? ((globalThis as any)?.crypto?.randomUUID?.() ?? `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
        : null;

      const payload = row.workouts.map((w) => ({
        team_id: teamId,
        athlete_profile_id: w.athlete_profile_id,
        created_by: w.created_by,
        date_iso: dayISO,
        session: w.session,
        location: w.location,
        time_text: w.time_text,
        title: w.title,
        details: w.details,
        primary_category: w.primary_category,
        categories: w.categories,
        batch_id: newBatchId,
        group_id: row.batchId ? w.group_id : null,
        pre_routine_ids: w.pre_routine_ids,
        post_routine_ids: w.post_routine_ids,
        planned_distance: w.planned_distance,
        planned_distance_unit: w.planned_distance_unit,
      }));

      await createTeamWorkoutBatch(payload);

      await refreshDayGuarded(dayISO);
    } catch (e: any) {
      Alert.alert("Duplicate failed", e?.message ?? "Could not duplicate row.");
    } finally {
      setDuplicatingKey((prev) => (prev === row.key ? null : prev));
    }
  };

  const getSelectedRowIdsForGroup = (groupKey: string) => selectedByGroup[groupKey]?.rowIds ?? [];

  const resolveCurrentWorkoutCategories = useCallback(
    (workoutId: string, rowHint?: TeamWorkoutRow) => {
      const draftCategories = normalizeCategoryArrayForGrid(athleteDrafts[workoutId]?.categories ?? []);
      if (draftCategories.length > 0) return draftCategories;
      const row = rowHint ?? rowsRaw.find((r) => String(r.id) === workoutId);
      const rowCategories = normalizeCategoryArrayForGrid(
        Array.isArray((row as any)?.categories) ? (((row as any)?.categories as string[]) ?? []) : []
      );
      if (rowCategories.length > 0) return rowCategories;
      return normalizeCategoryArrayForGrid([String((row as any)?.primary_category ?? "").trim()]);
    },
    [athleteDrafts, rowsRaw]
  );

  const getInitialGroupCategorySelection = useCallback(
    (rows: TeamWorkoutRow[]) => {
      const merged = new Set<string>();
      rows.forEach((row) => {
        const workoutId = String(row.id);
        resolveCurrentWorkoutCategories(workoutId, row).forEach((value) => merged.add(value));
      });
      return Array.from(merged);
    },
    [resolveCurrentWorkoutCategories]
  );

  const bulkSetCategoriesForWorkoutIds = (workoutIds: string[], values: string[]) => {
    const normalized = normalizeCategoryArrayForGrid(Array.isArray(values) ? values : []);
    const validNames = new Set(
      (Array.isArray(categories) ? categories : [])
        .map((c) => String((c as any)?.name ?? "").trim())
        .filter(Boolean)
    );
    const invalidValues = normalized.filter((value) => !validNames.has(value));
    if (validNames.size > 0 && invalidValues.length > 0) {
      Alert.alert("Invalid category", "Choose a category from Settings.");
      return;
    }
    if (workoutIds.length === 0) return;
    applyCategoriesToWorkoutIds(workoutIds, normalized);
  };

  const bulkClearCategoriesForWorkoutIds = (workoutIds: string[]) => {
    if (!Array.isArray(workoutIds) || workoutIds.length === 0) return;
    applyCategoriesToWorkoutIds(workoutIds, []);
  };

  const getSharedGroupFieldValue = useCallback(
    (rows: TeamWorkoutRow[], field: "location" | "time_text"): string | null => {
      if (!Array.isArray(rows) || rows.length === 0) return "";
      let shared: string | null = null;
      for (const row of rows) {
        const workoutId = String(row.id);
        const draft = athleteDrafts[workoutId];
        const value =
          field === "location"
            ? String(draft?.location ?? row.location ?? "").trim()
            : String(draft?.time_text ?? row.time_text ?? "").trim();
        if (shared == null) {
          shared = value;
          continue;
        }
        if (shared !== value) return null;
      }
      return shared ?? "";
    },
    [athleteDrafts]
  );

  const applyGroupFieldValue = useCallback(
    (rows: TeamWorkoutRow[], field: "location" | "time_text", value: string) => {
      const nextValue = String(value ?? "");
      rows.forEach((row) => {
        onEditAthleteField(String(row.id), field, nextValue);
      });
    },
    [onEditAthleteField]
  );

  const bulkAppendNotes = (groupKey: string, value: string) => {
    const ids = getSelectedRowIdsForGroup(groupKey);
    const append = String(value ?? "").trim();
    if (!append || ids.length === 0) return;
    ids.forEach((id) => {
      const current = String(athleteDrafts[id]?.details ?? "").trim();
      const next = current ? `${current}\n${append}` : append;
      onEditAthleteField(id, "details", next);
    });
  };

  const runGroupFillAll = (groupKey: string) => {
    const api = groupGridApis[groupKey];
    if (!api) return;
    setFillingGroupKey(groupKey);
    try {
      api.fillAll();
    } finally {
      setTimeout(() => setFillingGroupKey((prev) => (prev === groupKey ? null : prev)), 500);
    }
  };

  const runGroupFillSelected = (groupKey: string) => {
    const api = groupGridApis[groupKey];
    if (!api) return;
    api.fillSelected();
  };

  const openAthletePickerBatch = useMemo(
    () => (openAthletePickerBatchKey ? worksheetBatches.find((b) => b.key === openAthletePickerBatchKey) ?? null : null),
    [openAthletePickerBatchKey, worksheetBatches]
  );

  const openAthletePickerSelectedAthleteIds = useMemo(
    () =>
      new Set(
        (openAthletePickerBatch?.workouts ?? [])
          .map((w) => String(w.athlete_profile_id ?? "").trim())
          .filter(Boolean)
      ),
    [openAthletePickerBatch]
  );

  const openAthletePickerOptions = useMemo(() => {
    if (!openAthletePickerBatch) return [];
    const rosterById = new Map<string, TeamRosterAthlete>();
    rosterOptions.forEach((athlete) => {
      const athleteId = String((athlete as any)?.id ?? "").trim();
      if (!athleteId) return;
      rosterById.set(athleteId, athlete);
    });

    const rowByAthleteId = new Map<string, TeamWorkoutRow>();
    (openAthletePickerBatch.workouts ?? []).forEach((w) => {
      const athleteId = String(w.athlete_profile_id ?? "").trim();
      if (!athleteId || rowByAthleteId.has(athleteId)) return;
      rowByAthleteId.set(athleteId, w);
    });

    const query = String(athletePickerQuery ?? "").trim().toLowerCase();
    const ids = new Set<string>([...Array.from(rosterById.keys()), ...Array.from(rowByAthleteId.keys())]);
    const out = Array.from(ids).map((athleteId) => {
      const rosterAthlete = rosterById.get(athleteId);
      const row = rowByAthleteId.get(athleteId);
      const fallbackName = String((row as any)?.athlete_name ?? (rosterAthlete as any)?.displayName ?? "").trim();
      const displayName = resolveAthleteDisplayName(athleteId, rosterNameById, fallbackName);
      const selected = openAthletePickerSelectedAthleteIds.has(athleteId);
      return { athleteId, displayName, selected };
    });

    return out
      .filter((item) => !query || item.displayName.toLowerCase().includes(query))
      .sort((a, b) => compareAthleteDisplayNamesByLastName(a.displayName, b.displayName));
  }, [
    athletePickerQuery,
    openAthletePickerBatch,
    openAthletePickerSelectedAthleteIds,
    rosterNameById,
    rosterOptions,
  ]);

  useEffect(() => {
    if (!openAthletePickerBatchKey) return;
    if (openAthletePickerBatch) return;
    setOpenAthletePickerBatchKey(null);
    setAthletePickerQuery("");
    setRemovingAthleteId(null);
  }, [openAthletePickerBatch, openAthletePickerBatchKey]);

  const handleQuickCreateBatch = useCallback(async () => {
    if (creatingBatch) return;

    setCreatingBatch(true);
    try {
      const teamId = await ensureTeamId();
      if (!teamId) {
        Alert.alert("Create failed", "No team selected.");
        return;
      }

      if (rosterOptions.length === 0) {
        Alert.alert("Create failed", "No athletes found on roster.");
        return;
      }

      const freshDefaults = await loadPracticeTimeDefaults().catch(() => practiceDefaults);
      setPracticeDefaults(freshDefaults);
      const newBatchId = createBatchId(dayISO);
      const defaultsForDay = resolveDefaultSessionSlotAndTimeForDate(dayISO, freshDefaults, "AM", "");
      const payload = rosterOptions
        .map((athlete) => String((athlete as any)?.id ?? "").trim())
        .filter(Boolean)
        .map((athleteId) => ({
          team_id: teamId,
          athlete_profile_id: athleteId,
          created_by: null,
          date_iso: dayISO,
          session: defaultsForDay.session,
          location: null,
          time_text: defaultsForDay.timeText,
          title: "",
          details: null,
          primary_category: null,
          categories: [] as string[],
          batch_id: newBatchId,
          group_id: "1",
          pre_routine_ids: null,
          post_routine_ids: null,
          planned_distance: null,
          planned_distance_unit: null,
        }));

      if (payload.length === 0) {
        Alert.alert("Create failed", "No athletes found on roster.");
        return;
      }

      await createTeamWorkoutBatch(payload);
      await refreshDayGuarded(dayISO);

      const key = `batch:${newBatchId}`;
      setExpandedByBatchKey((prev) => ({ ...prev, [key]: true }));
      setHighlightBatchKey(key);
      setTimeout(() => {
        setHighlightBatchKey((prev) => (prev === key ? null : prev));
      }, 2200);
    } catch (e: any) {
      Alert.alert("Create failed", e?.message ?? "Could not create workout batch.");
    } finally {
      setCreatingBatch(false);
    }
  }, [creatingBatch, dayISO, ensureTeamId, practiceDefaults, refreshDayGuarded, rosterOptions]);

  const handleRemoveAthleteFromBatch = useCallback(
    async (batchRow: WorksheetBatchRow, athleteId: string) => {
      const batchId = String(batchRow.batchId ?? "").trim();
      if (!batchId) return;
      const batchAthleteIds = Array.from(
        new Set(
          (batchRow.workouts ?? [])
            .map((w) => String(w.athlete_profile_id ?? "").trim())
            .filter(Boolean)
        )
      );
      if (batchAthleteIds.length <= 1) {
        Alert.alert("Cannot remove", "A batch must contain at least one athlete.");
        return;
      }

      const matchingRows = batchRow.workouts.filter(
        (w) => String(w.athlete_profile_id ?? "").trim() === athleteId
      );
      if (matchingRows.length === 0) return;

      setRemovingAthleteId(athleteId);
      const athleteKey = `${batchId}::${athleteId}`;
      setPendingRemovedAthleteKeys((prev) => {
        const next = new Set(prev);
        next.add(athleteKey);
        return next;
      });
      const idsToRemove = new Set(matchingRows.map((w) => String(w.id)));
      setRowsRaw((prev) => prev.filter((w) => !idsToRemove.has(String(w.id))));

      try {
        await Promise.all(matchingRows.map((w) => deleteTeamWorkout(String(w.id))));
        await refreshDayGuarded(dayISO);
        setPendingRemovedAthleteKeys((prev) => {
          const next = new Set(prev);
          next.delete(athleteKey);
          return next;
        });
      } catch (e: any) {
        setPendingRemovedAthleteKeys((prev) => {
          const next = new Set(prev);
          next.delete(athleteKey);
          return next;
        });
        Alert.alert("Remove athlete failed", e?.message ?? "Could not remove athlete from batch.");
        await refreshDayGuarded(dayISO);
      } finally {
        setRemovingAthleteId(null);
      }
    },
    [dayISO, refreshDayGuarded]
  );

  const addAthleteToBatch = async (batchRow: WorksheetBatchRow, athleteId: string) => {
    if (!batchRow || !batchRow.batchId) return;
    const exists = batchRow.workouts.some(
      (w) => String(w.athlete_profile_id ?? "").trim() === String(athleteId).trim()
    );
    if (exists) {
      Alert.alert("Already added", "This athlete is already in the batch.");
      return;
    }

    const teamId = await ensureTeamId();
    if (!teamId) {
      Alert.alert("Add failed", "No team selected.");
      return;
    }

    setAddingAthleteId(athleteId);
    try {
      const sample = batchRow.sample;
      const batchDraft =
        batchDrafts[batchRow.key] ??
        ({
          session: normalizeSession(sample.session),
          date_iso: String(sample.date_iso ?? ""),
          location: String(sample.location ?? ""),
          time_text: String(sample.time_text ?? ""),
          title: String(sample.title ?? "Workout"),
          details: String(sample.details ?? ""),
          primary_category: String(sample.primary_category ?? ""),
          categories: (
            Array.isArray(sample.categories) ? sample.categories : []
          )
            .map((c) => String(c ?? "").trim())
            .filter((c) => !!c && c.toLowerCase() !== "other"),
          pre_routine_ids: (Array.isArray(sample.pre_routine_ids) ? sample.pre_routine_ids : [])
            .map((id) => String(id ?? "").trim())
            .filter(Boolean),
          post_routine_ids: (Array.isArray(sample.post_routine_ids) ? sample.post_routine_ids : [])
            .map((id) => String(id ?? "").trim())
            .filter(Boolean),
        } as BatchDraft);

      let targetGroupId = batchRow.groupedAthletes.find((g) => !!g.groupId)?.groupId ?? null;
      if (!targetGroupId) targetGroupId = makeNewGroupId();

      const payload = {
        team_id: teamId,
        athlete_profile_id: athleteId,
        created_by: sample.created_by ?? null,
        date_iso: dayISO,
        session: normalizeSession(batchDraft.session),
        location: String(batchDraft.location ?? "").trim() || null,
        time_text: String(batchDraft.time_text ?? "").trim() || null,
        title: String(batchDraft.title ?? "").trim() || "Workout",
        details: String(batchDraft.details ?? "").trim() || null,
        primary_category: String(batchDraft.primary_category ?? "").trim() || null,
        categories: (Array.isArray(batchDraft.categories) ? batchDraft.categories : [])
          .map((c) => String(c ?? "").trim())
          .filter((c) => !!c && c.toLowerCase() !== "other"),
        batch_id: batchRow.batchId,
        group_id: targetGroupId,
        pre_routine_ids: sample.pre_routine_ids ?? null,
        post_routine_ids: sample.post_routine_ids ?? null,
        planned_distance: sample.planned_distance ?? null,
        planned_distance_unit: sample.planned_distance_unit ?? null,
      };

      await createTeamWorkoutBatch([payload]);

      await refreshDayGuarded(dayISO);
    } catch (e: any) {
      patchAppRuntime({ lastSaveError: String(e?.message ?? e ?? "Could not add athlete to batch.") });
      Alert.alert("Add athlete failed", e?.message ?? "Could not add athlete to batch.");
    } finally {
      setAddingAthleteId((prev) => (prev === athleteId ? null : prev));
    }
  };

  const toggleAthleteInBatch = useCallback(
    async (batchRow: WorksheetBatchRow, athleteId: string, selected: boolean) => {
      if (selected) {
        await handleRemoveAthleteFromBatch(batchRow, athleteId);
      } else {
        await addAthleteToBatch(batchRow, athleteId);
      }
    },
    [addAthleteToBatch, handleRemoveAthleteFromBatch]
  );

  const replaceBatchRows = useCallback((rows: TeamWorkoutRow[], batchId: string, nextBatchRows: TeamWorkoutRow[]) => {
    let inserted = false;
    const next: TeamWorkoutRow[] = [];
    rows.forEach((row) => {
      const rowBatchId = String(row.batch_id ?? "").trim();
      if (rowBatchId !== batchId) {
        next.push(row);
        return;
      }
      if (!inserted) {
        next.push(...nextBatchRows);
        inserted = true;
      }
    });
    if (!inserted) next.push(...nextBatchRows);
    return next;
  }, []);

  const applyBatchAthleteSelectionOptimistic = useCallback(
    (batchRow: WorksheetBatchRow, targetAthleteIds: string[]) => {
      const batchId = String(batchRow.batchId ?? "").trim();
      if (!batchId) return;
      const targetSet = new Set(targetAthleteIds.map((id) => String(id ?? "").trim()).filter(Boolean));
      if (targetSet.size === 0) return;

      setRowsRaw((prev) => {
        const currentBatchRows = prev.filter((row) => String(row.batch_id ?? "").trim() === batchId);
        const existingByAthleteId = new Map<string, TeamWorkoutRow>();
        currentBatchRows.forEach((row) => {
          const athleteId = String(row.athlete_profile_id ?? "").trim();
          if (!athleteId || existingByAthleteId.has(athleteId)) return;
          existingByAthleteId.set(athleteId, row);
        });

        const sample = currentBatchRows[0] ?? batchRow.sample;
        const batchDraft =
          batchDrafts[batchRow.key] ??
          ({
            session: normalizeSession(sample.session),
            date_iso: String(sample.date_iso ?? ""),
            location: String(sample.location ?? ""),
            time_text: String(sample.time_text ?? ""),
            title: String(sample.title ?? "Workout"),
            details: String(sample.details ?? ""),
            primary_category: String(sample.primary_category ?? ""),
            categories: (
              Array.isArray(sample.categories) ? sample.categories : []
            )
              .map((c) => String(c ?? "").trim())
              .filter((c) => !!c && c.toLowerCase() !== "other"),
            pre_routine_ids: (Array.isArray(sample.pre_routine_ids) ? sample.pre_routine_ids : [])
              .map((id) => String(id ?? "").trim())
              .filter(Boolean),
            post_routine_ids: (Array.isArray(sample.post_routine_ids) ? sample.post_routine_ids : [])
              .map((id) => String(id ?? "").trim())
              .filter(Boolean),
          } as BatchDraft);
        let targetGroupId = currentBatchRows.find((row) => !!String(row.group_id ?? "").trim())?.group_id ?? null;
        if (!targetGroupId) targetGroupId = batchRow.groupedAthletes.find((g) => !!g.groupId)?.groupId ?? null;
        if (!targetGroupId) targetGroupId = makeNewGroupId();

        const nextBatchRows: TeamWorkoutRow[] = targetAthleteIds
          .map((rawAthleteId) => String(rawAthleteId ?? "").trim())
          .filter(Boolean)
          .map((athleteId) => {
            const existing = existingByAthleteId.get(athleteId);
            if (existing) return existing;
            const nowIso = new Date().toISOString();
            return {
              ...sample,
              id: `optimistic:${batchId}:${athleteId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
              athlete_profile_id: athleteId,
              date_iso: dayISO,
              session: normalizeSession(batchDraft.session),
              location: String(batchDraft.location ?? "").trim() || null,
              time_text: String(batchDraft.time_text ?? "").trim() || null,
              title: String(batchDraft.title ?? "").trim() || "Workout",
              details: String(batchDraft.details ?? "").trim() || null,
              primary_category: String(batchDraft.primary_category ?? "").trim() || null,
              categories: (Array.isArray(batchDraft.categories) ? batchDraft.categories : [])
                .map((c) => String(c ?? "").trim())
                .filter((c) => !!c && c.toLowerCase() !== "other"),
              batch_id: batchId,
              group_id: targetGroupId,
              created_at: nowIso,
              updated_at: nowIso,
            } as TeamWorkoutRow;
          });

        return replaceBatchRows(prev, batchId, nextBatchRows);
      });
    },
    [batchDrafts, dayISO, replaceBatchRows]
  );

  const syncBatchAthleteSelection = useCallback(
    async (batchRow: WorksheetBatchRow, targetAthleteIds: string[], previousRowsSnapshot: TeamWorkoutRow[]) => {
      const batchId = String(batchRow.batchId ?? "").trim();
      if (!batchId) return;
      const targetSet = new Set(targetAthleteIds.map((id) => String(id ?? "").trim()).filter(Boolean));
      if (targetSet.size === 0) return;

      const previousBatchRows = previousRowsSnapshot.filter((row) => String(row.batch_id ?? "").trim() === batchId);
      const existingByAthleteId = new Map<string, TeamWorkoutRow>();
      previousBatchRows.forEach((row) => {
        const athleteId = String(row.athlete_profile_id ?? "").trim();
        if (!athleteId || existingByAthleteId.has(athleteId)) return;
        existingByAthleteId.set(athleteId, row);
      });
      const previousAthleteIds = new Set(existingByAthleteId.keys());
      const toAdd = Array.from(targetSet).filter((athleteId) => !previousAthleteIds.has(athleteId));
      const toRemoveAthleteIds = Array.from(previousAthleteIds).filter((athleteId) => !targetSet.has(athleteId));

      const sample = previousBatchRows[0] ?? batchRow.sample;
      const batchDraft =
        batchDrafts[batchRow.key] ??
        ({
          session: normalizeSession(sample.session),
          date_iso: String(sample.date_iso ?? ""),
          location: String(sample.location ?? ""),
          time_text: String(sample.time_text ?? ""),
          title: String(sample.title ?? "Workout"),
          details: String(sample.details ?? ""),
          primary_category: String(sample.primary_category ?? ""),
          categories: (
            Array.isArray(sample.categories) ? sample.categories : []
          )
            .map((c) => String(c ?? "").trim())
            .filter((c) => !!c && c.toLowerCase() !== "other"),
          pre_routine_ids: (Array.isArray(sample.pre_routine_ids) ? sample.pre_routine_ids : [])
            .map((id) => String(id ?? "").trim())
            .filter(Boolean),
          post_routine_ids: (Array.isArray(sample.post_routine_ids) ? sample.post_routine_ids : [])
            .map((id) => String(id ?? "").trim())
            .filter(Boolean),
        } as BatchDraft);
      let targetGroupId = previousBatchRows.find((row) => !!String(row.group_id ?? "").trim())?.group_id ?? null;
      if (!targetGroupId) targetGroupId = batchRow.groupedAthletes.find((g) => !!g.groupId)?.groupId ?? null;
      if (!targetGroupId) targetGroupId = makeNewGroupId();

      if (toAdd.length > 0) {
        const payload = toAdd.map((athleteId) => ({
          team_id: sample.team_id,
          athlete_profile_id: athleteId,
          created_by: sample.created_by ?? null,
          date_iso: dayISO,
          session: normalizeSession(batchDraft.session),
          location: String(batchDraft.location ?? "").trim() || null,
          time_text: String(batchDraft.time_text ?? "").trim() || null,
          title: String(batchDraft.title ?? "").trim() || "Workout",
          details: String(batchDraft.details ?? "").trim() || null,
          primary_category: String(batchDraft.primary_category ?? "").trim() || null,
          categories: (Array.isArray(batchDraft.categories) ? batchDraft.categories : [])
            .map((c) => String(c ?? "").trim())
            .filter((c) => !!c && c.toLowerCase() !== "other"),
          batch_id: batchId,
          group_id: targetGroupId,
          pre_routine_ids: sample.pre_routine_ids ?? null,
          post_routine_ids: sample.post_routine_ids ?? null,
          planned_distance: sample.planned_distance ?? null,
          planned_distance_unit: sample.planned_distance_unit ?? null,
        }));
        await createTeamWorkoutBatch(payload);
      }

      if (toRemoveAthleteIds.length > 0) {
        const removeIdSet = new Set(toRemoveAthleteIds);
        const rowIdsToDelete = previousBatchRows
          .filter((row) => removeIdSet.has(String(row.athlete_profile_id ?? "").trim()))
          .map((row) => String(row.id))
          .filter((id) => !String(id).startsWith("optimistic:"));
        if (rowIdsToDelete.length > 0) {
          await deleteTeamWorkoutsByIds(rowIdsToDelete);
        }
      }

      const serverRows = await listTeamWorkoutsByBatch(batchId);
      setRowsRaw((prev) => replaceBatchRows(prev, batchId, serverRows));
    },
    [batchDrafts, dayISO, replaceBatchRows]
  );

  const selectAllAthletesForBatch = useCallback(
    async (batchRow: WorksheetBatchRow) => {
      const batchId = String(batchRow.batchId ?? "").trim();
      if (!batchId) return;
      if (athleteSelectionSyncByBatchKey[batchRow.key]) return;
      const allRosterIds = rosterOptions
        .map((r) => String((r as any)?.id ?? "").trim())
        .filter(Boolean);
      if (allRosterIds.length === 0) return;

      const targetAthleteIds = Array.from(new Set(allRosterIds));
      const previousRowsSnapshot = rowsRaw;
      applyBatchAthleteSelectionOptimistic(batchRow, targetAthleteIds);
      setAthleteSelectionSyncByBatchKey((prev) => ({ ...prev, [batchRow.key]: true }));
      try {
        await syncBatchAthleteSelection(batchRow, targetAthleteIds, previousRowsSnapshot);
      } catch (e: any) {
        setRowsRaw(previousRowsSnapshot);
        patchAppRuntime({ lastSaveError: String(e?.message ?? e ?? "Could not select all athletes for batch.") });
        Alert.alert("Select all failed", e?.message ?? "Could not select all athletes for batch.");
      } finally {
        setAthleteSelectionSyncByBatchKey((prev) => ({ ...prev, [batchRow.key]: false }));
      }
    },
    [applyBatchAthleteSelectionOptimistic, athleteSelectionSyncByBatchKey, patchAppRuntime, rosterOptions, rowsRaw, syncBatchAthleteSelection]
  );

  const clearAthletesForBatch = useCallback(
    async (batchRow: WorksheetBatchRow) => {
      const batchId = String(batchRow.batchId ?? "").trim();
      if (!batchId) return;
      if (athleteSelectionSyncByBatchKey[batchRow.key]) return;

      const selectedIds = Array.from(new Set(
        rowsRaw
          .filter((row) => String(row.batch_id ?? "").trim() === batchId)
          .map((row) => String(row.athlete_profile_id ?? "").trim())
          .filter(Boolean)
      ));
      if (selectedIds.length <= 1) return;

      const keeperAthleteId = selectedIds[0];
      if (!keeperAthleteId) return;
      const targetAthleteIds = [keeperAthleteId];

      const previousRowsSnapshot = rowsRaw;
      applyBatchAthleteSelectionOptimistic(batchRow, targetAthleteIds);
      setAthleteSelectionSyncByBatchKey((prev) => ({ ...prev, [batchRow.key]: true }));
      try {
        await syncBatchAthleteSelection(batchRow, targetAthleteIds, previousRowsSnapshot);
      } catch (e: any) {
        setRowsRaw(previousRowsSnapshot);
        patchAppRuntime({ lastSaveError: String(e?.message ?? e ?? "Could not clear athletes for batch.") });
        Alert.alert("Clear failed", e?.message ?? "Could not clear athletes for batch.");
      } finally {
        setAthleteSelectionSyncByBatchKey((prev) => ({ ...prev, [batchRow.key]: false }));
      }
    },
    [applyBatchAthleteSelectionOptimistic, athleteSelectionSyncByBatchKey, patchAppRuntime, rowsRaw, syncBatchAthleteSelection]
  );

  const performMoveWorkout = useCallback(
    async (args: {
      workoutId: string;
      batchKey: string;
      batchId: string | null;
      fromGroupId: string | null;
      toGroupId: string | null | "NEW_GROUP";
    }) => {
      const { workoutId, batchKey, batchId, fromGroupId } = args;
      if (!batchId) return;
      if (!workoutId) return;

      const resolvedGroupId = args.toGroupId === "NEW_GROUP" ? makeNewGroupId() : args.toGroupId;
      if (resolvedGroupId === fromGroupId) {
        setMoveMode(null);
        return;
      }

      setRowsRaw((prev) =>
        prev.map((w) => (String(w.id) === workoutId ? { ...w, group_id: resolvedGroupId } : w))
      );

      if (resolvedGroupId) {
        const encoded = encodeGroupOrderId(resolvedGroupId);
        setGroupOrderByBatch((prev) => {
          const order = prev[batchKey] ?? [];
          if (order.includes(encoded)) return prev;
          return { ...prev, [batchKey]: [...order, encoded] };
        });
      }

      try {
        await moveWorkoutToGroup(workoutId, resolvedGroupId);
        setJustMovedWorkoutId(workoutId);
        if (justMovedTimerRef.current) clearTimeout(justMovedTimerRef.current);
        justMovedTimerRef.current = setTimeout(() => {
          setJustMovedWorkoutId((prev) => (prev === workoutId ? null : prev));
        }, 300);
        setMoveMode(null);
      } catch (e: any) {
        setRowsRaw((prev) =>
          prev.map((w) => (String(w.id) === workoutId ? { ...w, group_id: fromGroupId } : w))
        );
        Alert.alert("Move failed", e?.message ?? "Could not move workout to target group.");
      }
    },
    []
  );

  if (!dayISO) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 15, fontWeight: "800" }}>No date provided</Text>
      </View>
    );
  }

  const batchRowMinWidth =
    COL.toggle + COL.session + COL.time + COL.date + COL.location + COL.title + COL.notes + COL.category + COL.athletes + COL.actions;
  const athleteRowMinWidth =
    COL.rowSelect +
    COL.dragHandle +
    COL.athleteName +
    COL.athleteLocation +
    COL.athleteTime +
    COL.distance +
    COL.athleteNotes +
    COL.athleteCategory +
    COL.athleteActions;
  const worksheetMinWidth = Math.max(batchRowMinWidth, athleteRowMinWidth);

  return (
    <View style={{ flex: 1, backgroundColor: "#f8fafc" }}>
      <View
        style={{
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: "#dbe2ee",
          backgroundColor: "#fff",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable
            onPress={() => goToDate(addDaysISO(dayISO, -1))}
            style={{ borderWidth: 1, borderColor: "#cfd7e6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
          >
            <Text style={{ fontSize: 12, fontWeight: "800", color: "#24334f" }}>Prev Day</Text>
          </Pressable>

          <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>{formatDisplayDate(dayISO)}</Text>

          <Pressable
            onPress={() => goToDate(addDaysISO(dayISO, 1))}
            style={{ borderWidth: 1, borderColor: "#cfd7e6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
          >
            <Text style={{ fontSize: 12, fontWeight: "800", color: "#24334f" }}>Next Day</Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ alignItems: "flex-end", minWidth: 190 }}>
            {headerSaveDisplay.kind === "error" ? (
              <InlineSaveStatus status="error" message={headerSaveDisplay.message} size="sm" align="right" />
            ) : headerSaveDisplay.kind === "saving" ? (
              <InlineSaveStatus status="saving" size="sm" align="right" />
            ) : headerSaveDisplay.kind === "saved" ? (
              <InlineSaveStatus status="saved" size="sm" align="right" />
            ) : headerSaveDisplay.kind === "pending" ? (
              <Text style={{ fontSize: 11, fontWeight: "800", color: "#b45309", textAlign: "right" }}>
                Pending save...
              </Text>
            ) : (
              <Text style={{ fontSize: 10, fontWeight: "700", color: "#64748b", textAlign: "right" }}>
                Ready
              </Text>
            )}
            {headerSaveDisplay.detail ? (
              <Text style={{ marginTop: 2, fontSize: 10, fontWeight: "600", color: "#64748b", textAlign: "right" }}>
                {headerSaveDisplay.detail}
              </Text>
            ) : null}
          </View>

          <Pressable
            onPress={() => goToDate(dayISO)}
            style={{ borderWidth: 1, borderColor: "#cfd7e6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
          >
            <Text style={{ fontSize: 12, fontWeight: "800", color: "#24334f" }}>Reload Day</Text>
          </Pressable>

          <Pressable
            onPress={() => void handleQuickCreateBatch()}
            disabled={creatingBatch}
            style={{
              borderWidth: 1,
              borderColor: "#0f172a",
              backgroundColor: "#0f172a",
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 6,
              opacity: creatingBatch ? 0.65 : 1,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "900", color: "#fff" }}>
              {creatingBatch ? "Creating..." : "Create Session"}
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        ref={workoutsScrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 18 }}
        keyboardShouldPersistTaps="handled"
      >
        <GridTable minWidth={worksheetMinWidth}>
          <View style={{ flex: 1 }}>
          {loading ? (
            <View style={{ padding: 14 }}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: "#64748b" }}>Loading...</Text>
            </View>
          ) : worksheetBatches.length === 0 ? (
            <View style={{ padding: 14 }}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: "#64748b" }}>No workouts scheduled for this day.</Text>
            </View>
          ) : (
            worksheetBatches.map((batchRow, index) => {
              const batchDraft =
                batchDrafts[batchRow.key] ??
                {
                  session: normalizeSession(batchRow.sample.session),
                  date_iso: String(batchRow.sample.date_iso ?? ""),
                  location: String(batchRow.sample.location ?? ""),
                  time_text: String(batchRow.sample.time_text ?? ""),
                  title: String(batchRow.sample.title ?? "Workout"),
                  details: String(batchRow.sample.details ?? ""),
                  primary_category: String(batchRow.sample.primary_category ?? ""),
                  categories: (
                    Array.isArray(batchRow.sample.categories) ? batchRow.sample.categories : []
                  )
                    .map((c) => String(c ?? "").trim())
                    .filter((c) => !!c && c.toLowerCase() !== "other"),
                  pre_routine_ids: (Array.isArray(batchRow.sample.pre_routine_ids) ? batchRow.sample.pre_routine_ids : [])
                    .map((id) => String(id ?? "").trim())
                    .filter(Boolean),
                  post_routine_ids: (Array.isArray(batchRow.sample.post_routine_ids) ? batchRow.sample.post_routine_ids : [])
                    .map((id) => String(id ?? "").trim())
                    .filter(Boolean),
                };

              const expanded = expandedByBatchKey[batchRow.key] !== false;
              const batchState = batchSaveState[batchRow.key];
              const categorySlotsRaw = batchCategorySlots[batchRow.key] ?? [];
              const resolvedCategorySlots =
                categorySlotsRaw.length > 0
                  ? categorySlotsRaw.map((slot) => String(slot ?? "").trim())
                  : normalizeCategoryArrayForGrid(
                      Array.isArray(batchDraft.categories) && batchDraft.categories.length > 0
                        ? batchDraft.categories
                        : [String(batchDraft.primary_category ?? "").trim()].filter(Boolean)
                    );
              const categorySlots = resolvedCategorySlots.length > 0 ? resolvedCategorySlots : [""];
              const preSlotsRaw = batchPreRoutineSlots[batchRow.key] ?? [];
              const postSlotsRaw = batchPostRoutineSlots[batchRow.key] ?? [];
              const preSlots = preSlotsRaw.length > 0 ? preSlotsRaw : [""];
              const postSlots = postSlotsRaw.length > 0 ? postSlotsRaw : [""];
              const categoryOptions = (Array.isArray(categories) ? categories : [])
                .map((c) => String((c as any)?.name ?? "").trim())
                .filter(Boolean)
                .filter((name) => name.toLowerCase().includes(String(batchPickerQuery ?? "").trim().toLowerCase()));
              const routineOptions = auxiliaryRoutines
                .map((r) => ({ id: String(r.id), title: String(r.title ?? "") }))
                .filter((r) => r.id && r.title)
                .filter((r) => r.title.toLowerCase().includes(String(batchPickerQuery ?? "").trim().toLowerCase()));

              const applyBatchRoutineSlots = (field: "pre" | "post", nextIds: string[]) => {
                const parsed = parseBatchKey(batchRow.key);
                const cleaned = Array.from(new Set(nextIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
                setBatchDrafts((prev) => {
                  const next = {
                    ...prev,
                    [batchRow.key]: {
                      ...(prev[batchRow.key] ?? batchDraft),
                      ...(field === "pre" ? { pre_routine_ids: cleaned } : { post_routine_ids: cleaned }),
                    },
                  };
                  batchDraftsRef.current = next;
                  return next;
                });
                setRowsRaw((prev) =>
                  prev.map((w) => {
                    const match = parsed.isBatch
                      ? String(w.batch_id ?? "").trim() === parsed.id
                      : String(w.id) === parsed.id;
                    if (!match) return w;
                    return field === "pre"
                      ? { ...w, pre_routine_ids: cleaned }
                      : { ...w, post_routine_ids: cleaned };
                  })
                );
                scheduleBatchRoutineSave(batchRow.key, field, cleaned);
              };

              const athletePickerOpen = openAthletePickerBatchKey === batchRow.key;
              const athleteSelectionSyncing = !!athleteSelectionSyncByBatchKey[batchRow.key];
              const groupCategoryPickerOpenForBatch =
                typeof openGroupCategoryPickerKey === "string" &&
                openGroupCategoryPickerKey.startsWith(`${batchRow.key}::`);
              const batchHasOpenOverlay =
                openBatchPicker?.batchKey === batchRow.key || athletePickerOpen || groupCategoryPickerOpenForBatch;
              const batchOverlayZIndex = groupCategoryPickerOpenForBatch ? 50000 : batchHasOpenOverlay ? 200 : 1;
              const isFirstBatch = index === 0;
              const isLastBatch = index === worksheetBatches.length - 1;
              return (
                <View
                  key={batchRow.key}
                  onLayout={(e) => {
                    batchHeaderYByKeyRef.current[batchRow.key] = e.nativeEvent.layout.y;
                  }}
                  style={{
                    position: "relative",
                    zIndex: batchOverlayZIndex,
                    marginBottom: isLastBatch ? 0 : 8,
                    paddingBottom: isLastBatch ? 0 : 2,
                  }}
                >
                  <View
                    ref={(el) => {
                      batchHeaderRegionRefs.current[batchRow.key] = el;
                    }}
                    {...(Platform.OS === "web"
                      ? ({
                          onFocusCapture: () => {
                            batchHeaderRootRef.current = batchHeaderRegionRefs.current[batchRow.key];
                            activateBatchHeader(batchHeaderRegionRefs.current[batchRow.key]);
                          },
                          onBlurCapture: () => {
                            scheduleBatchHeaderDeactivate();
                          },
                          onKeyDown: (e: any) => {
                            if (!batchHeaderActive) return;
                            const key = String(e?.key ?? "");
                            if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
                              e.stopPropagation?.();
                            }
                          },
                        } as any)
                      : null)}
                    style={{
                      marginTop: isFirstBatch ? 4 : 16,
                      borderWidth: 1,
                      borderColor: highlightBatchKey === batchRow.key ? "#fdba74" : SHEET_BORDER,
                      borderTopWidth: isFirstBatch ? 1 : 3,
                      borderTopColor:
                        highlightBatchKey === batchRow.key
                          ? BATCH_START_HIGHLIGHT_BORDER
                          : BATCH_START_BORDER,
                      borderRadius: 2,
                      backgroundColor: highlightBatchKey === batchRow.key ? "#fff7ed" : BATCH_HEADER_SECTION_BG,
                      overflow: "visible",
                      position: "relative",
                      zIndex: groupCategoryPickerOpenForBatch ? 50020 : batchHasOpenOverlay ? 220 : 1,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        borderBottomWidth: 1,
                        borderBottomColor: SHEET_BORDER,
                        backgroundColor: BATCH_HEADER_CAPTION_BG,
                      }}
                    >
                      <View style={{ flex: 1, paddingHorizontal: 8, paddingVertical: 3 }}>
                        <Text style={{ fontSize: 9, fontWeight: "800", color: BATCH_GROUP_CAPTION, letterSpacing: 0.2 }}>Core</Text>
                      </View>
                      <View style={{ width: (COL.category + 46) * 3, paddingHorizontal: 8, paddingVertical: 3, borderLeftWidth: 2, borderLeftColor: BATCH_GROUP_DIVIDER }}>
                        <Text style={{ fontSize: 9, fontWeight: "800", color: BATCH_GROUP_CAPTION, letterSpacing: 0.2 }}>Routines</Text>
                      </View>
                      <View
                        style={{
                          width: COL.athletes + 16 + 88 + 230 + 120,
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderLeftWidth: 2,
                          borderLeftColor: BATCH_GROUP_DIVIDER,
                        }}
                      >
                        <Text style={{ fontSize: 9, fontWeight: "800", color: BATCH_GROUP_CAPTION, letterSpacing: 0.2, textAlign: "right" }}>Batch Tools</Text>
                      </View>
                    </View>

                    <View style={{ flexDirection: "row", alignItems: "stretch", gap: 0, borderBottomWidth: 1, borderBottomColor: SHEET_BORDER, backgroundColor: SHEET_HEADER_BG }}>
                      <View style={{ ...batchSheetCellBase, width: COL.toggle, alignItems: "center", backgroundColor: BATCH_GROUP_CORE_BG }}>
                        <Pressable
                          onPress={() =>
                            setExpandedByBatchKey((prev) => ({
                              ...prev,
                              [batchRow.key]: !(prev[batchRow.key] !== false),
                            }))
                          }
                          hitSlop={10}
                          style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: "#fff" }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: "900", color: "#334155" }}>{expanded ? "▾" : "▸"}</Text>
                        </Pressable>
                      </View>

                      <View style={{ ...batchSheetCellBase, width: COL.session, backgroundColor: BATCH_GROUP_CORE_BG }}>
                        <Text style={batchSheetLabelText}>AM/PM</Text>
                        <View style={{ flexDirection: "row", gap: 4 }}>
                          {(["AM", "PM"] as const).map((s) => (
                            <Pressable
                              key={`${batchRow.key}-${s}`}
                              ref={(el) => {
                                if (s === "AM") batchHeaderInputRefs.current[`${batchRow.key}:session`] = el;
                              }}
                              onPress={() => onEditBatchField(batchRow.key, "session", s)}
                              {...(Platform.OS === "web"
                                ? ({
                                    tabIndex: 0,
                                    onFocus: () => activateBatchHeaderField(batchRow.key, "session"),
                                    onBlur: () => scheduleBatchHeaderDeactivate(),
                                    onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "session", e),
                                  } as any)
                                : null)}
                              style={{
                                flex: 1,
                                alignItems: "center",
                                justifyContent: "center",
                                borderWidth: 1,
                                borderColor: batchDraft.session === s ? "#0f172a" : "#cbd5e1",
                                backgroundColor: batchDraft.session === s ? "#0f172a" : "#fff",
                                borderRadius: 3,
                                paddingVertical: 3,
                              }}
                            >
                              <Text style={{ fontSize: 11, fontWeight: "900", color: batchDraft.session === s ? "#fff" : "#334155" }}>{s}</Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>

                      <View style={{ ...batchSheetCellBase, width: COL.time, backgroundColor: BATCH_GROUP_CORE_BG }}>
                        <Text style={batchSheetLabelText}>Time</Text>
                        <TextCellEditor
                          value={batchDraft.time_text}
                          onChangeText={(v) => onEditBatchField(batchRow.key, "time_text", v)}
                          inputRef={(el: any) => {
                            batchHeaderInputRefs.current[`${batchRow.key}:time`] = el;
                          }}
                          webProps={{
                            onFocus: () => activateBatchHeaderField(batchRow.key, "time"),
                            onBlur: () => scheduleBatchHeaderDeactivate(),
                            onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "time", e),
                          }}
                          style={{ fontSize: 12, fontWeight: "700", color: "#111827", paddingVertical: 3 }}
                          placeholder="Time"
                        />
                      </View>

                      <View style={{ ...batchSheetCellBase, width: COL.date, backgroundColor: BATCH_GROUP_CORE_BG }}>
                        <Text style={batchSheetLabelText}>Date</Text>
                        <TextCellEditor
                          value={batchDraft.date_iso}
                          onChangeText={(v) => onEditBatchField(batchRow.key, "date_iso", v)}
                          inputRef={(el: any) => {
                            batchHeaderInputRefs.current[`${batchRow.key}:date`] = el;
                          }}
                          webProps={{
                            onFocus: () => activateBatchHeaderField(batchRow.key, "date"),
                            onBlur: () => scheduleBatchHeaderDeactivate(),
                            onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "date", e),
                          }}
                          style={{ fontSize: 12, fontWeight: "700", color: "#111827", paddingVertical: 3 }}
                          placeholder="YYYY-MM-DD"
                        />
                      </View>

                      <View style={{ ...batchSheetCellBase, minWidth: 160, flex: 1, backgroundColor: BATCH_GROUP_CORE_BG }}>
                        <Text style={batchSheetLabelText}>Location</Text>
                        <TextCellEditor
                          value={batchDraft.location}
                          onChangeText={(v) => onEditBatchField(batchRow.key, "location", v)}
                          inputRef={(el: any) => {
                            batchHeaderInputRefs.current[`${batchRow.key}:location`] = el;
                          }}
                          webProps={{
                            onFocus: () => activateBatchHeaderField(batchRow.key, "location"),
                            onBlur: () => scheduleBatchHeaderDeactivate(),
                            onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "location", e),
                          }}
                          style={{ fontSize: 12, fontWeight: "700", color: "#111827", paddingVertical: 3 }}
                          placeholder="Location"
                        />
                      </View>

                      <View style={{ ...batchSheetCellBase, minWidth: 200, flex: 1.3, backgroundColor: BATCH_GROUP_CORE_BG }}>
                        <Text style={batchSheetLabelText}>Title</Text>
                        <TextCellEditor
                          value={batchDraft.title}
                          onChangeText={(v) => onEditBatchField(batchRow.key, "title", v)}
                          inputRef={(el: any) => {
                            batchHeaderInputRefs.current[`${batchRow.key}:title`] = el;
                          }}
                          webProps={{
                            onFocus: () => activateBatchHeaderField(batchRow.key, "title"),
                            onBlur: () => scheduleBatchHeaderDeactivate(),
                            onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "title", e),
                          }}
                          style={{ fontSize: 13, fontWeight: "800", color: "#111827", paddingVertical: 3 }}
                          placeholder="Workout"
                        />
                      </View>

                      <View
                        style={{
                          ...batchSheetCellBase,
                          width: COL.athletes + 16,
                          alignItems: "flex-start",
                          overflow: "visible",
                          zIndex: athletePickerOpen ? 90 : 1,
                          backgroundColor: BATCH_GROUP_UTILITY_BG,
                          borderLeftWidth: 2,
                          borderLeftColor: BATCH_GROUP_DIVIDER,
                        }}
                      >
                        <Text style={batchSheetLabelText}>Athletes</Text>
                        <Pressable
                          ref={(el) => {
                            batchHeaderInputRefs.current[`${batchRow.key}:athletes`] = el;
                          }}
                          onPress={() => {
                            if (!batchRow.batchId) return;
                            const nextOpen = athletePickerOpen ? null : batchRow.key;
                            if (!nextOpen && openBatchPicker?.batchKey === batchRow.key) {
                              setOpenBatchPicker(null);
                            }
                            setOpenAthletePickerBatchKey(nextOpen);
                            setAthletePickerQuery("");
                          }}
                          style={{ paddingVertical: 1 }}
                          disabled={!batchRow.batchId}
                          {...(Platform.OS === "web"
                            ? ({
                                tabIndex: 0,
                                onFocus: () => activateBatchHeaderField(batchRow.key, "athletes"),
                                onBlur: () => scheduleBatchHeaderDeactivate(),
                                onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "athletes", e),
                              } as any)
                            : null)}
                        >
                          <Text style={{ fontSize: 12, fontWeight: "900", color: "#1e293b" }}>
                            {`Athletes: ${batchRow.athleteCount} ${athletePickerOpen ? "▴" : "▾"}`}
                          </Text>
                        </Pressable>
                        {athletePickerOpen ? (
                          <View
                            style={{
                              position: "absolute",
                              top: 44,
                              left: 0,
                              width: 320,
                              maxHeight: 360,
                              borderWidth: 1,
                              borderColor: "#dbe2ee",
                              borderRadius: 8,
                              backgroundColor: "#fff",
                              padding: 8,
                              gap: 8,
                              zIndex: 95,
                              ...(Platform.OS === "android" ? { elevation: 7 } : null),
                            }}
                          >
                            <TextInput
                              value={athletePickerQuery}
                              onChangeText={setAthletePickerQuery}
                              placeholder="Search athletes..."
                              style={{
                                borderWidth: 1,
                                borderColor: "#d1d9e6",
                                borderRadius: 8,
                                paddingHorizontal: 10,
                                paddingVertical: 6,
                                fontSize: 12,
                                fontWeight: "600",
                                color: "#0f172a",
                              }}
                            />
                            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                              <Pressable
                                onPress={() => void selectAllAthletesForBatch(batchRow)}
                                disabled={athleteSelectionSyncing}
                                style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: "#fff" }}
                              >
                                <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>
                                  {athleteSelectionSyncing ? "Working..." : "Select all"}
                                </Text>
                              </Pressable>
                              <Pressable
                                onPress={() => void clearAthletesForBatch(batchRow)}
                                disabled={athleteSelectionSyncing}
                                style={{ borderWidth: 1, borderColor: "#f2c4c4", backgroundColor: "#fff0f0", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}
                              >
                                <Text style={{ fontSize: 11, fontWeight: "800", color: "#9f1239" }}>
                                  {athleteSelectionSyncing ? "Working..." : "Clear"}
                                </Text>
                              </Pressable>
                            </View>
                            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 250 }}>
                              {openAthletePickerOptions.map((item) => {
                                const busy = athleteSelectionSyncing || addingAthleteId === item.athleteId || removingAthleteId === item.athleteId;
                                return (
                                  <Pressable
                                    key={`athlete-toggle-${batchRow.key}-${item.athleteId}`}
                                    onPress={() => void toggleAthleteInBatch(batchRow, item.athleteId, item.selected)}
                                    disabled={busy}
                                    style={{
                                      borderWidth: 1,
                                      borderColor: item.selected ? "#bfdbfe" : "#e2e8f0",
                                      backgroundColor: item.selected ? "#eff6ff" : "#fff",
                                      borderRadius: 8,
                                      paddingHorizontal: 8,
                                      paddingVertical: 7,
                                      marginBottom: 6,
                                      opacity: busy ? 0.7 : 1,
                                      flexDirection: "row",
                                      alignItems: "center",
                                      justifyContent: "space-between",
                                      gap: 8,
                                    }}
                                  >
                                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155", flex: 1 }}>
                                      {item.displayName}
                                    </Text>
                                    <Text style={{ fontSize: 11, fontWeight: "900", color: item.selected ? "#1d4ed8" : "#64748b" }}>
                                      {busy ? (item.selected ? "Removing..." : "Adding...") : item.selected ? "Selected" : "Add"}
                                    </Text>
                                  </Pressable>
                                );
                              })}
                            </ScrollView>
                          </View>
                        ) : null}
                      </View>

                      <View style={{ ...batchSheetCellBase, width: 88, alignItems: "flex-start", backgroundColor: BATCH_GROUP_UTILITY_BG }}>
                        <Text style={batchSheetLabelText}>Sections</Text>
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#1e293b" }}>
                          {batchRow.groupedAthletes.length}
                        </Text>
                      </View>

                      <View style={{ ...batchSheetCellBase, minWidth: 230, flexDirection: "row", alignItems: "center", gap: 6, borderRightWidth: 0, backgroundColor: BATCH_GROUP_UTILITY_BG }}>
                        <Pressable
                          onPress={() => void duplicateBatchOrSingle(batchRow)}
                          disabled={duplicatingKey === batchRow.key}
                          style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4, opacity: duplicatingKey === batchRow.key ? 0.6 : 1, backgroundColor: "#fff" }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>
                            {duplicatingKey === batchRow.key ? "Duplicating..." : "Duplicate"}
                          </Text>
                        </Pressable>

                        <Pressable
                          onPress={() => void deleteBatchOrSingle(batchRow)}
                          disabled={deletingKey === batchRow.key}
                          style={{ borderWidth: 1, borderColor: "#f2c4c4", backgroundColor: "#fff0f0", borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4, opacity: deletingKey === batchRow.key ? 0.6 : 1 }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: "800", color: "#9f1239" }}>
                            {deletingKey === batchRow.key ? "Deleting..." : batchRow.batchId ? "Delete batch..." : "Delete"}
                          </Text>
                        </Pressable>

                      </View>
                    </View>

                    <View style={{ flexDirection: "row", alignItems: "stretch", gap: 0, backgroundColor: SHEET_CELL_BG }}>
                      <View
                        style={{
                          ...batchSheetCellBase,
                          flex: 1,
                          minWidth: COL.notes,
                          backgroundColor: BATCH_GROUP_CORE_BG,
                        }}
                      >
                        <Text style={batchSheetLabelText}>Workout Notes</Text>
                        <NotesCellEditor
                          value={batchDraft.details}
                          onChangeText={(v) => onEditBatchField(batchRow.key, "details", v)}
                          inputRef={(el: any) => {
                            batchHeaderInputRefs.current[`${batchRow.key}:notes`] = el;
                          }}
                          webProps={{
                            onFocus: () => activateBatchHeaderField(batchRow.key, "notes"),
                            onBlur: () => scheduleBatchHeaderDeactivate(),
                            onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "notes", e),
                          }}
                          style={{ fontSize: 12, fontWeight: "600", color: "#334155", paddingVertical: 3 }}
                          placeholder="Notes"
                        />
                      </View>

                          <View
                            style={{
                              ...batchSheetCellBase,
                              width: COL.category + 46,
                              justifyContent: "flex-start",
                              overflow: "visible",
                              zIndex: 6,
                              backgroundColor: BATCH_GROUP_SECONDARY_BG,
                              borderLeftWidth: 2,
                              borderLeftColor: BATCH_GROUP_DIVIDER,
                            }}
                          >
                            <Text style={batchSheetLabelText}>Category</Text>
                            <View style={{ gap: 4 }}>
                              {categorySlots.map((slotValue, slotIndex) => (
                                <View key={`cat-slot-${batchRow.key}-${slotIndex}`} style={{ flexDirection: "row", alignItems: "center", gap: 6, position: "relative", zIndex: openBatchPicker?.batchKey === batchRow.key && openBatchPicker.field === "category" && openBatchPicker.slotIndex === slotIndex ? 70 : 1 }}>
                                  <Pressable
                                    ref={(el) => {
                                      if (slotIndex === 0) batchHeaderInputRefs.current[`${batchRow.key}:category`] = el;
                                    }}
                                    onPress={() => {
                                      const isOpen =
                                        openBatchPicker?.batchKey === batchRow.key &&
                                        openBatchPicker.field === "category" &&
                                        openBatchPicker.slotIndex === slotIndex;
                                      if (isOpen) {
                                        setOpenBatchPicker(null);
                                        return;
                                      }
                                      setOpenBatchPicker({ batchKey: batchRow.key, field: "category", slotIndex });
                                      setBatchPickerQuery("");
                                    }}
                                    {...(Platform.OS === "web"
                                      ? ({
                                          tabIndex: 0,
                                          onFocus: () => activateBatchHeaderField(batchRow.key, "category"),
                                          onBlur: () => scheduleBatchHeaderDeactivate(),
                                          onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "category", e),
                                        } as any)
                                      : null)}
                                    style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 3, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff" }}
                                  >
                                    <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "700", color: slotValue ? "#334155" : "#94a3b8" }}>
                                      {slotValue || "Select"}
                                    </Text>
                                    <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>▾</Text>
                                  </Pressable>
                                  <Pressable
                                    onPress={() => {
                                      const next = categorySlots.filter((_, idx) => idx !== slotIndex);
                                      const normalizedNext = next.length > 0 ? next : [""];
                                      setBatchCategorySlots((prev) => ({ ...prev, [batchRow.key]: normalizedNext }));
                                      onEditBatchField(batchRow.key, "categories", normalizedNext.filter((v) => String(v ?? "").trim()).filter(Boolean));
                                    }}
                                    style={{ width: 24, height: 24, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 3, alignItems: "center", justifyContent: "center", opacity: slotIndex === 0 && categorySlots.length <= 1 ? 0.4 : 1, backgroundColor: "#fff" }}
                                    disabled={slotIndex === 0 && categorySlots.length <= 1}
                                  >
                                    <Text style={{ fontSize: 14, fontWeight: "900", color: "#b91c1c" }}>−</Text>
                                  </Pressable>
                                  <Pressable
                                    onPress={() => {
                                      setBatchCategorySlots((prev) => ({ ...prev, [batchRow.key]: [...categorySlots, ""] }));
                                    }}
                                    style={{ width: 24, height: 24, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 3, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" }}
                                  >
                                    <Text style={{ fontSize: 14, fontWeight: "900", color: "#334155" }}>+</Text>
                                  </Pressable>

                                  {openBatchPicker?.batchKey === batchRow.key &&
                                  openBatchPicker.field === "category" &&
                                  openBatchPicker.slotIndex === slotIndex ? (
                                    <View style={{ position: "absolute", top: 34, left: 0, right: 58, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, overflow: "hidden", backgroundColor: "#fff", zIndex: 80, ...(Platform.OS === "android" ? { elevation: 7 } : null) }}>
                                      <TextInput
                                        value={batchPickerQuery}
                                        onChangeText={setBatchPickerQuery}
                                        placeholder="Search..."
                                        style={{ borderBottomWidth: 1, borderBottomColor: "#edf2f7", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "700" }}
                                      />
                                      <ScrollView style={{ maxHeight: 180 }} keyboardShouldPersistTaps="handled">
                                        {categoryOptions.map((name) => (
                                          <Pressable
                                            key={`cat-opt-${batchRow.key}-${name}`}
                                            onPress={() => {
                                              const next = [...categorySlots];
                                              if (next.includes(name) && next[slotIndex] !== name) return;
                                              next[slotIndex] = name;
                                              const normalizedNext = next.map((slot) => String(slot ?? "").trim());
                                              const saved = Array.from(
                                                new Set(
                                                  normalizedNext
                                                    .filter(Boolean)
                                                    .filter((v) => normalizeCategoryLabel(v) !== "other")
                                                )
                                              );
                                              setBatchCategorySlots((prev) => ({
                                                ...prev,
                                                [batchRow.key]: normalizedNext.length > 0 ? normalizedNext : [""],
                                              }));
                                              onEditBatchField(batchRow.key, "categories", saved);
                                              setOpenBatchPicker(null);
                                            }}
                                            style={{ paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#edf2f7" }}
                                          >
                                            <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>{name}</Text>
                                          </Pressable>
                                        ))}
                                      </ScrollView>
                                    </View>
                                  ) : null}
                                </View>
                              ))}
                            </View>
                          </View>

                          <View style={{ ...batchSheetCellBase, width: COL.category + 46, justifyContent: "flex-start", overflow: "visible", zIndex: 5, backgroundColor: BATCH_GROUP_SECONDARY_BG }}>
                            <Text style={batchSheetLabelText}>Pre Workout</Text>
                            <View style={{ gap: 4 }}>
                              {preSlots.map((slotValue, slotIndex) => {
                                const routineTitle = auxiliaryRoutines.find((r) => String(r.id) === slotValue)?.title ?? "";
                                return (
                                  <View key={`pre-slot-${batchRow.key}-${slotIndex}`} style={{ flexDirection: "row", alignItems: "center", gap: 6, position: "relative", zIndex: openBatchPicker?.batchKey === batchRow.key && openBatchPicker.field === "pre" && openBatchPicker.slotIndex === slotIndex ? 70 : 1 }}>
                                    <Pressable
                                      ref={(el) => {
                                        if (slotIndex === 0) batchHeaderInputRefs.current[`${batchRow.key}:pre`] = el;
                                      }}
                                      onPress={() => {
                                        const isOpen =
                                          openBatchPicker?.batchKey === batchRow.key &&
                                          openBatchPicker.field === "pre" &&
                                          openBatchPicker.slotIndex === slotIndex;
                                        if (isOpen) {
                                          setOpenBatchPicker(null);
                                          return;
                                        }
                                        setOpenBatchPicker({ batchKey: batchRow.key, field: "pre", slotIndex });
                                        setBatchPickerQuery("");
                                      }}
                                      {...(Platform.OS === "web"
                                        ? ({
                                            tabIndex: 0,
                                            onFocus: () => activateBatchHeaderField(batchRow.key, "pre"),
                                            onBlur: () => scheduleBatchHeaderDeactivate(),
                                            onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "pre", e),
                                          } as any)
                                        : null)}
                                      style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 3, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff" }}
                                    >
                                      <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "700", color: routineTitle ? "#334155" : "#94a3b8" }}>
                                        {routineTitle || "Select"}
                                      </Text>
                                      <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>▾</Text>
                                    </Pressable>
                                    <Pressable
                                      onPress={() => {
                                        const next = preSlots.filter((_, idx) => idx !== slotIndex);
                                        setBatchPreRoutineSlots((prev) => ({ ...prev, [batchRow.key]: next }));
                                        applyBatchRoutineSlots("pre", next);
                                      }}
                                      style={{ width: 24, height: 24, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 3, alignItems: "center", justifyContent: "center", opacity: slotIndex === 0 && preSlots.length <= 1 ? 0.4 : 1, backgroundColor: "#fff" }}
                                      disabled={slotIndex === 0 && preSlots.length <= 1}
                                    >
                                      <Text style={{ fontSize: 14, fontWeight: "900", color: "#b91c1c" }}>−</Text>
                                    </Pressable>
                                    <Pressable
                                      onPress={() => setBatchPreRoutineSlots((prev) => ({ ...prev, [batchRow.key]: [...preSlots, ""] }))}
                                      style={{ width: 24, height: 24, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 3, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" }}
                                    >
                                      <Text style={{ fontSize: 14, fontWeight: "900", color: "#334155" }}>+</Text>
                                    </Pressable>

                                    {openBatchPicker?.batchKey === batchRow.key &&
                                    openBatchPicker.field === "pre" &&
                                    openBatchPicker.slotIndex === slotIndex ? (
                                      <View style={{ position: "absolute", top: 34, left: 0, right: 58, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, overflow: "hidden", backgroundColor: "#fff", zIndex: 80, ...(Platform.OS === "android" ? { elevation: 7 } : null) }}>
                                        <TextInput value={batchPickerQuery} onChangeText={setBatchPickerQuery} placeholder="Search..." style={{ borderBottomWidth: 1, borderBottomColor: "#edf2f7", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "700" }} />
                                        <ScrollView style={{ maxHeight: 180 }} keyboardShouldPersistTaps="handled">
                                          {routineOptions.map((routine) => (
                                            <Pressable
                                              key={`pre-opt-${batchRow.key}-${routine.id}`}
                                              onPress={() => {
                                                const next = [...preSlots];
                                                if (next.includes(routine.id) && next[slotIndex] !== routine.id) return;
                                                next[slotIndex] = routine.id;
                                                const cleaned = next.filter(Boolean);
                                                setBatchPreRoutineSlots((prev) => ({ ...prev, [batchRow.key]: cleaned }));
                                                applyBatchRoutineSlots("pre", cleaned);
                                                setOpenBatchPicker(null);
                                              }}
                                              style={{ paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#edf2f7" }}
                                            >
                                              <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>{routine.title}</Text>
                                            </Pressable>
                                          ))}
                                        </ScrollView>
                                      </View>
                                    ) : null}
                                  </View>
                                );
                              })}
                            </View>
                          </View>

                          <View style={{ ...batchSheetCellBase, width: COL.category + 46, justifyContent: "flex-start", overflow: "visible", zIndex: 4, backgroundColor: BATCH_GROUP_SECONDARY_BG }}>
                            <Text style={batchSheetLabelText}>Post Workout</Text>
                            <View style={{ gap: 4 }}>
                              {postSlots.map((slotValue, slotIndex) => {
                                const routineTitle = auxiliaryRoutines.find((r) => String(r.id) === slotValue)?.title ?? "";
                                return (
                                  <View key={`post-slot-${batchRow.key}-${slotIndex}`} style={{ flexDirection: "row", alignItems: "center", gap: 6, position: "relative", zIndex: openBatchPicker?.batchKey === batchRow.key && openBatchPicker.field === "post" && openBatchPicker.slotIndex === slotIndex ? 70 : 1 }}>
                                    <Pressable
                                      ref={(el) => {
                                        if (slotIndex === 0) batchHeaderInputRefs.current[`${batchRow.key}:post`] = el;
                                      }}
                                      onPress={() => {
                                        const isOpen =
                                          openBatchPicker?.batchKey === batchRow.key &&
                                          openBatchPicker.field === "post" &&
                                          openBatchPicker.slotIndex === slotIndex;
                                        if (isOpen) {
                                          setOpenBatchPicker(null);
                                          return;
                                        }
                                        setOpenBatchPicker({ batchKey: batchRow.key, field: "post", slotIndex });
                                        setBatchPickerQuery("");
                                      }}
                                      {...(Platform.OS === "web"
                                        ? ({
                                            tabIndex: 0,
                                            onFocus: () => activateBatchHeaderField(batchRow.key, "post"),
                                            onBlur: () => scheduleBatchHeaderDeactivate(),
                                            onKeyDown: (e: any) => handleBatchHeaderKeyDown(batchRow.key, "post", e),
                                          } as any)
                                        : null)}
                                      style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 3, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff" }}
                                    >
                                      <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "700", color: routineTitle ? "#334155" : "#94a3b8" }}>
                                        {routineTitle || "Select"}
                                      </Text>
                                      <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>▾</Text>
                                    </Pressable>
                                    <Pressable
                                      onPress={() => {
                                        const next = postSlots.filter((_, idx) => idx !== slotIndex);
                                        setBatchPostRoutineSlots((prev) => ({ ...prev, [batchRow.key]: next }));
                                        applyBatchRoutineSlots("post", next);
                                      }}
                                      style={{ width: 24, height: 24, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 3, alignItems: "center", justifyContent: "center", opacity: slotIndex === 0 && postSlots.length <= 1 ? 0.4 : 1, backgroundColor: "#fff" }}
                                      disabled={slotIndex === 0 && postSlots.length <= 1}
                                    >
                                      <Text style={{ fontSize: 14, fontWeight: "900", color: "#b91c1c" }}>−</Text>
                                    </Pressable>
                                    <Pressable
                                      onPress={() => setBatchPostRoutineSlots((prev) => ({ ...prev, [batchRow.key]: [...postSlots, ""] }))}
                                      style={{ width: 24, height: 24, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 3, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" }}
                                    >
                                      <Text style={{ fontSize: 14, fontWeight: "900", color: "#334155" }}>+</Text>
                                    </Pressable>

                                    {openBatchPicker?.batchKey === batchRow.key &&
                                    openBatchPicker.field === "post" &&
                                    openBatchPicker.slotIndex === slotIndex ? (
                                      <View style={{ position: "absolute", top: 34, left: 0, right: 58, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, overflow: "hidden", backgroundColor: "#fff", zIndex: 80, ...(Platform.OS === "android" ? { elevation: 7 } : null) }}>
                                        <TextInput value={batchPickerQuery} onChangeText={setBatchPickerQuery} placeholder="Search..." style={{ borderBottomWidth: 1, borderBottomColor: "#edf2f7", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "700" }} />
                                        <ScrollView style={{ maxHeight: 180 }} keyboardShouldPersistTaps="handled">
                                          {routineOptions.map((routine) => (
                                            <Pressable
                                              key={`post-opt-${batchRow.key}-${routine.id}`}
                                              onPress={() => {
                                                const next = [...postSlots];
                                                if (next.includes(routine.id) && next[slotIndex] !== routine.id) return;
                                                next[slotIndex] = routine.id;
                                                const cleaned = next.filter(Boolean);
                                                setBatchPostRoutineSlots((prev) => ({ ...prev, [batchRow.key]: cleaned }));
                                                applyBatchRoutineSlots("post", cleaned);
                                                setOpenBatchPicker(null);
                                              }}
                                              style={{ paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#edf2f7" }}
                                            >
                                              <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>{routine.title}</Text>
                                            </Pressable>
                                          ))}
                                        </ScrollView>
                                      </View>
                                    ) : null}
                                  </View>
                                );
                              })}
                            </View>
                          </View>

                      <View
                        style={{
                          ...batchSheetCellBase,
                          width: 120,
                          alignItems: "flex-end",
                          borderRightWidth: 0,
                          backgroundColor: BATCH_GROUP_UTILITY_BG,
                          borderLeftWidth: 2,
                          borderLeftColor: BATCH_GROUP_DIVIDER,
                        }}
                      >
                        <Text style={batchSheetLabelText}>Status</Text>
                        <InlineSaveStatus status={batchState?.status ?? "idle"} message={batchState?.message} size="sm" align="right" />
                      </View>
                    </View>

                    {openBatchPicker?.batchKey === batchRow.key || athletePickerOpen ? (
                      <Pressable
                        onPress={() => {
                          if (openBatchPicker?.batchKey === batchRow.key) setOpenBatchPicker(null);
                          if (athletePickerOpen) {
                            setOpenAthletePickerBatchKey(null);
                            setAthletePickerQuery("");
                          }
                        }}
                        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 }}
                      />
                    ) : null}
                  </View>

                  {expanded
                    ? batchRow.groupedAthletes.map((group) => {
                        const groupKey = buildGroupKey(batchRow.key, group.groupId);
                        const groupWorkoutIds = group.rows.map((row) => String(row.id));
                        const {
                          athleteDrafts: athleteDraftsForGroup,
                          athleteSaveState: athleteSaveStateForGroup,
                          prescribedDistanceByWorkoutId: prescribedDistanceByWorkoutIdForGroup,
                        } = getCachedGroupAthleteSlices(groupKey, groupWorkoutIds);
                        const isFilling = fillingGroupKey === groupKey;
                        const selectedRowIds = selectedByGroup[groupKey]?.rowIds ?? [];
                        const groupApi = groupGridApis[groupKey];
                        const groupSessionValue = group.rows.length
                          ? normalizeSession(String((athleteDrafts[String(group.rows[0].id)]?.session ?? group.rows[0].session) ?? "AM"))
                          : "AM";
                        const sharedGroupLocation = getSharedGroupFieldValue(group.rows, "location");
                        const sharedGroupTime = getSharedGroupFieldValue(group.rows, "time_text");
                        const groupCategoryPickerOpen = openGroupCategoryPickerKey === groupKey;
                        const groupCategorySelection = getInitialGroupCategorySelection(group.rows);
                        const groupContent = (
                          <View
                            style={{
                              position: "relative",
                              overflow: "visible",
                              zIndex: groupCategoryPickerOpen ? 50200 : 1,
                            }}
                          >
                            {groupCategoryPickerOpen ? (
                              <Pressable
                                onPress={() => setOpenGroupCategoryPickerKey(null)}
                                style={{
                                  position: "absolute",
                                  top: 0,
                                  left: 0,
                                  right: 0,
                                  bottom: 0,
                                  zIndex: 50210,
                                }}
                              />
                            ) : null}
                            <View
                              style={{
                                backgroundColor: GROUP_HEADER_BG,
                                borderBottomWidth: 1,
                                borderBottomColor: GROUP_HEADER_BORDER,
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                flexDirection: "row",
                                alignItems: "center",
                                justifyContent: "flex-start",
                                gap: 10,
                                position: "relative",
                                overflow: "visible",
                                zIndex: groupCategoryPickerOpen ? 50215 : 1,
                              }}
                            >
                              <View style={{ flexDirection: "column", flexShrink: 0 }}>
                                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#475569" }}>{group.groupLabel}</Text>
                                  <View style={{ flexDirection: "row", gap: 4 }}>
                                    {(["AM", "PM"] as const).map((sessionValue) => (
                                      <Pressable
                                        key={`${groupKey}-session-${sessionValue}`}
                                        onPress={() => {
                                          group.rows.forEach((row) => {
                                            onEditAthleteSession(String(row.id), sessionValue);
                                          });
                                        }}
                                        style={{
                                          borderWidth: 1,
                                          borderColor: groupSessionValue === sessionValue ? "#0f172a" : "#cbd5e1",
                                          backgroundColor: groupSessionValue === sessionValue ? "#0f172a" : "#fff",
                                          borderRadius: 6,
                                          paddingHorizontal: 7,
                                          paddingVertical: 2,
                                        }}
                                      >
                                        <Text style={{ fontSize: 10, fontWeight: "900", color: groupSessionValue === sessionValue ? "#fff" : "#334155" }}>
                                          {sessionValue}
                                        </Text>
                                      </Pressable>
                                    ))}
                                  </View>
                                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 2 }}>
                                    <TextInput
                                      value={sharedGroupLocation ?? ""}
                                      onChangeText={(next) => applyGroupFieldValue(group.rows, "location", next)}
                                      placeholder={sharedGroupLocation == null ? "Mixed location" : "Location"}
                                      placeholderTextColor="#94a3b8"
                                      style={{
                                        width: 156,
                                        height: 26,
                                        borderWidth: 1,
                                        borderColor: "#cbd5e1",
                                        borderRadius: 6,
                                        paddingHorizontal: 7,
                                        paddingVertical: 3,
                                        backgroundColor: "#fff",
                                        color: "#334155",
                                        fontSize: 11,
                                        fontWeight: "700",
                                      }}
                                    />
                                    <TextInput
                                      value={sharedGroupTime ?? ""}
                                      onChangeText={(next) => applyGroupFieldValue(group.rows, "time_text", next)}
                                      placeholder={sharedGroupTime == null ? "Mixed time" : "Time"}
                                      placeholderTextColor="#94a3b8"
                                      style={{
                                        width: 90,
                                        height: 26,
                                        borderWidth: 1,
                                        borderColor: "#cbd5e1",
                                        borderRadius: 6,
                                        paddingHorizontal: 7,
                                        paddingVertical: 3,
                                        backgroundColor: "#fff",
                                        color: "#334155",
                                        fontSize: 11,
                                        fontWeight: "700",
                                      }}
                                    />
                                  </View>
                                </View>
                              </View>
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
                                <Text style={{ fontSize: 11, fontWeight: "800", color: "#475569" }}>
                                  Selected: {selectedRowIds.length}
                                </Text>
                                <Pressable
                                  onPress={() => {
                                    setActiveGridId(groupKey);
                                    void groupApi?.copy();
                                  }}
                                  disabled={!groupApi}
                                  style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: groupApi ? 1 : 0.5 }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Copy</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => {
                                    setActiveGridId(groupKey);
                                    void groupApi?.paste();
                                  }}
                                  disabled={!groupApi}
                                  style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: groupApi ? 1 : 0.5 }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Paste</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => {
                                    setActiveGridId(groupKey);
                                    groupApi?.undo();
                                  }}
                                  disabled={!groupApi}
                                  style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: groupApi ? 1 : 0.5 }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Undo</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => {
                                    setActiveGridId(groupKey);
                                    runGroupFillSelected(groupKey);
                                  }}
                                  disabled={!groupApi || selectedRowIds.length === 0}
                                  style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: !groupApi || selectedRowIds.length === 0 ? 0.5 : 1 }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Fill Selected</Text>
                                </Pressable>
                                <View style={{ position: "relative", zIndex: groupCategoryPickerOpen ? 50220 : 1 }}>
                                  <Pressable
                                    onPress={() => {
                                      setOpenGroupCategoryPickerKey((prev) => (prev === groupKey ? null : groupKey));
                                    }}
                                    disabled={group.rows.length === 0}
                                    style={{
                                      borderWidth: 1,
                                      borderColor: "#cbd5e1",
                                      borderRadius: 7,
                                      paddingHorizontal: 8,
                                      paddingVertical: 4,
                                      opacity: group.rows.length === 0 ? 0.5 : 1,
                                      backgroundColor: "#fff",
                                    }}
                                  >
                                    <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Set Category</Text>
                                  </Pressable>

                                  {groupCategoryPickerOpen ? (
                                    <View
                                      style={{
                                        position: "absolute",
                                        top: 28,
                                        left: 0,
                                        minWidth: 170,
                                        borderWidth: 1,
                                        borderColor: "#dbe2ee",
                                        borderRadius: 8,
                                        backgroundColor: "#fff",
                                        overflow: "visible",
                                        zIndex: 50230,
                                        ...(Platform.OS === "android" ? { elevation: 8 } : null),
                                      }}
                                    >
                                      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 220 }}>
                                        {categoryNames.length === 0 ? (
                                          <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
                                            <Text style={{ fontSize: 11, fontWeight: "700", color: "#64748b" }}>
                                              No categories
                                            </Text>
                                          </View>
                                        ) : null}
                                        {categoryNames.map((name) => (
                                          <Pressable
                                            key={`group-cat-opt-${groupKey}-${name}`}
                                            onPress={() => {
                                              const hasValue = groupCategorySelection.includes(name);
                                              const nextValues = hasValue
                                                ? groupCategorySelection.filter((value) => value !== name)
                                                : [...groupCategorySelection, name];
                                              bulkSetCategoriesForWorkoutIds(groupWorkoutIds, nextValues);
                                            }}
                                            style={{
                                              paddingHorizontal: 10,
                                              paddingVertical: 8,
                                              borderBottomWidth: 1,
                                              borderBottomColor: "#edf2f7",
                                              backgroundColor: groupCategorySelection.includes(name) ? "#eff6ff" : "#fff",
                                              flexDirection: "row",
                                              alignItems: "center",
                                              justifyContent: "space-between",
                                            }}
                                          >
                                            <Text style={{ fontSize: 11, fontWeight: "700", color: "#334155" }}>{name}</Text>
                                            {groupCategorySelection.includes(name) ? (
                                              <Text style={{ fontSize: 11, fontWeight: "900", color: "#1d4ed8" }}>✓</Text>
                                            ) : null}
                                          </Pressable>
                                        ))}
                                        <View
                                          style={{
                                            paddingHorizontal: 10,
                                            paddingVertical: 8,
                                            borderTopWidth: 1,
                                            borderTopColor: "#e2e8f0",
                                            backgroundColor: "#f8fafc",
                                            flexDirection: "row",
                                            alignItems: "center",
                                            justifyContent: "flex-end",
                                          }}
                                        >
                                          <Pressable
                                            onPress={() => {
                                              bulkClearCategoriesForWorkoutIds(groupWorkoutIds);
                                            }}
                                            style={{
                                              borderWidth: 1,
                                              borderColor: "#cbd5e1",
                                              borderRadius: 6,
                                              paddingHorizontal: 8,
                                              paddingVertical: 4,
                                              backgroundColor: "#fff",
                                            }}
                                          >
                                            <Text style={{ fontSize: 11, fontWeight: "800", color: "#475569" }}>Clear</Text>
                                          </Pressable>
                                        </View>
                                      </ScrollView>
                                    </View>
                                  ) : null}
                                </View>
                                <Pressable
                                  onPress={() => {
                                    if (selectedRowIds.length === 0) return;
                                    const next = Platform.OS === "web" && typeof globalThis.prompt === "function"
                                      ? globalThis.prompt("Append notes to selected rows", "")
                                      : null;
                                    if (next == null) return;
                                    bulkAppendNotes(groupKey, next);
                                  }}
                                  disabled={selectedRowIds.length === 0}
                                  style={{
                                    borderWidth: 1,
                                    borderColor: "#cbd5e1",
                                    borderRadius: 7,
                                    paddingHorizontal: 8,
                                    paddingVertical: 4,
                                    opacity: selectedRowIds.length === 0 ? 0.5 : 1,
                                  }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Append Notes</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => {
                                    setActiveGridId(groupKey);
                                    runGroupFillAll(groupKey);
                                  }}
                                  disabled={isFilling || group.rows.length < 2 || !groupApi}
                                  style={{
                                    borderWidth: 1,
                                    borderColor: "#cbd5e1",
                                    borderRadius: 7,
                                    paddingHorizontal: 8,
                                    paddingVertical: 4,
                                    opacity: isFilling || group.rows.length < 2 || !groupApi ? 0.6 : 1,
                                  }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>
                                    {isFilling ? "Filling..." : "Fill All"}
                                  </Text>
                                </Pressable>
                              </View>
                            </View>

                            <View
                              style={{
                                flexDirection: "row",
                                backgroundColor: GROUP_SUBHEADER_BG,
                                borderBottomWidth: 1,
                                borderBottomColor: GROUP_HEADER_BORDER,
                              }}
                            >
                              <View style={{ width: COL.rowSelect, paddingHorizontal: 6, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0", alignItems: "center" }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>◻</Text>
                              </View>
                              <View style={{ width: COL.dragHandle, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }} />
                              <View
                                style={{
                                  flexGrow: 0,
                                  flexShrink: 1,
                                  flexBasis: COL.athleteName,
                                  minWidth: 120,
                                  maxWidth: COL.athleteName,
                                  paddingHorizontal: 8,
                                  paddingVertical: 5,
                                  borderRightWidth: 1,
                                  borderRightColor: "#e2e8f0",
                                }}
                              >
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>Athlete</Text>
                              </View>
                              <View style={{ flexBasis: COL.athleteLocation, maxWidth: COL.athleteLocation, minWidth: 110, flexShrink: 1, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>Location</Text>
                              </View>
                              <View style={{ flexBasis: COL.athleteTime, maxWidth: COL.athleteTime, minWidth: 70, flexShrink: 1, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>Time</Text>
                              </View>
                              <View style={{ width: COL.distance, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b", textAlign: "right" }}>Distance</Text>
                              </View>
                              <View
                                style={{
                                  flexGrow: 1,
                                  flexShrink: 1,
                                  flexBasis: COL.athleteNotes,
                                  minWidth: COL.athleteNotes,
                                  paddingHorizontal: 8,
                                  paddingVertical: 5,
                                  borderRightWidth: 1,
                                  borderRightColor: "#e2e8f0",
                                }}
                              >
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>Notes</Text>
                              </View>
                              <View style={{ width: COL.athleteCategory, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>Category</Text>
                              </View>
                              <View style={{ width: COL.athleteActions, paddingHorizontal: 8, paddingVertical: 5 }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>Actions</Text>
                              </View>
                            </View>

                            <GroupAthleteRows
                              groupKey={groupKey}
                              batchRowKey={batchRow.key}
                              batchId={batchRow.batchId}
                              group={group}
                              rosterNameById={rosterNameById}
                              athleteDrafts={athleteDraftsForGroup}
                              athleteSaveState={athleteSaveStateForGroup}
                              prescribedDistanceByWorkoutId={prescribedDistanceByWorkoutIdForGroup}
                              deletingKey={deletingKey}
                              justMovedWorkoutId={justMovedWorkoutId}
                              onEditAthleteField={onEditAthleteField}
                              onDeleteSingleWorkout={deleteSingleWorkout}
                              setMoveMode={setMoveMode}
                              webDragMove={webDragMove}
                              setWebDragMove={setWebDragMove}
                              setWebDragGhost={setWebDragGhost}
                              setWebDragGhostClone={setWebDragGhostClone}
                              dragOverGroupKey={dragOverGroupKey}
                              setDragOverGroupKey={setDragOverGroupKey}
                              activeGridId={activeGridId}
                              setActiveGridId={setActiveGridId}
                              onSelectionMetaChange={handleGroupSelectionMetaChange}
                              onRegisterGridApi={handleRegisterGroupGridApi}
                              batchHeaderActiveRef={batchHeaderActiveRef}
                            />
                          </View>
                        );

                        if (Platform.OS === "web") {
                          return (
                            <div
                              key={`${batchRow.key}-${group.groupLabel}`}
                              onDragOver={(e: any) => {
                                if (!webDragMove || webDragMove.batchKey !== batchRow.key) return;
                                e.preventDefault?.();
                                e.dataTransfer!.dropEffect = "move";
                                if (dragOverGroupKey !== groupKey) setDragOverGroupKey(groupKey);
                              }}
                              onDragLeave={() => {
                                if (dragOverGroupKey === groupKey) setDragOverGroupKey(null);
                              }}
                              onDrop={(e: any) => {
                                if (!webDragMove || webDragMove.batchKey !== batchRow.key) return;
                                e.preventDefault?.();
                                setDragOverGroupKey(null);
                                clearWebDragGhost();
                                const payload = webDragMove;
                                setWebDragMove(null);
                                if (payload.fromGroupId === group.groupId) return;
                                void performMoveWorkout({
                                  workoutId: payload.workoutId,
                                  batchKey: payload.batchKey,
                                  batchId: payload.batchId,
                                  fromGroupId: payload.fromGroupId,
                                  toGroupId: group.groupId,
                                });
                              }}
                              style={{
                                position: "relative",
                                zIndex: groupCategoryPickerOpen ? 50150 : 1,
                                borderRadius: 8,
                                overflow: "visible",
                                outline:
                                  dragOverGroupKey === groupKey && webDragMove?.batchKey === batchRow.key
                                    ? "2px dashed rgba(59,130,246,0.55)"
                                    : "none",
                                outlineOffset: -2,
                                backgroundColor:
                                  dragOverGroupKey === groupKey && webDragMove?.batchKey === batchRow.key
                                    ? "rgba(59,130,246,0.04)"
                                    : "transparent",
                              }}
                            >
                              {groupContent}
                            </div>
                          );
                        }

                        return <View key={`${batchRow.key}-${group.groupLabel}`}>{groupContent}</View>;
                    })
                    : null}

                  {expanded && batchRow.batchId ? (
                    Platform.OS === "web" ? (
                      <div
                        onDragOver={(e: any) => {
                          if (!webDragMove || webDragMove.batchKey !== batchRow.key) return;
                          e.preventDefault?.();
                          e.dataTransfer!.dropEffect = "move";
                          if (dragOverGroupKey !== `${batchRow.key}::NEW_GROUP`) {
                            setDragOverGroupKey(`${batchRow.key}::NEW_GROUP`);
                          }
                        }}
                        onDragLeave={() => {
                          if (dragOverGroupKey === `${batchRow.key}::NEW_GROUP`) setDragOverGroupKey(null);
                        }}
                        onDrop={(e: any) => {
                          if (!webDragMove || webDragMove.batchKey !== batchRow.key) return;
                          e.preventDefault?.();
                          const payload = webDragMove;
                          setWebDragMove(null);
                          clearWebDragGhost();
                          setDragOverGroupKey(null);
                          void performMoveWorkout({
                            workoutId: payload.workoutId,
                            batchKey: payload.batchKey,
                            batchId: payload.batchId,
                            fromGroupId: payload.fromGroupId,
                            toGroupId: "NEW_GROUP",
                          });
                        }}
                        style={{
                          marginLeft: 8,
                          marginRight: 8,
                          marginTop: 8,
                          marginBottom: 8,
                          borderRadius: 8,
                          outline:
                            dragOverGroupKey === `${batchRow.key}::NEW_GROUP` &&
                            webDragMove?.batchKey === batchRow.key
                              ? "2px dashed rgba(59,130,246,0.55)"
                              : "none",
                          outlineOffset: -2,
                        }}
                      >
                        <Pressable
                          onPress={() => {
                            if (!moveMode || moveMode.batchKey !== batchRow.key) return;
                            void performMoveWorkout({
                              workoutId: moveMode.workoutId,
                              batchKey: moveMode.batchKey,
                              batchId: moveMode.batchId,
                              fromGroupId: moveMode.fromGroupId,
                              toGroupId: "NEW_GROUP",
                            });
                          }}
                          style={{
                            borderWidth: 1,
                            borderStyle: "dashed",
                            borderColor: "#cbd5e1",
                            backgroundColor:
                              dragOverGroupKey === `${batchRow.key}::NEW_GROUP` &&
                              webDragMove?.batchKey === batchRow.key
                                ? "rgba(59,130,246,0.07)"
                                : "#f8fafc",
                            borderRadius: 8,
                            paddingHorizontal: 10,
                            paddingVertical: 8,
                          }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>+ Add new group</Text>
                        </Pressable>
                      </div>
                    ) : (
                      <Pressable
                        onPress={() => {
                          if (!moveMode || moveMode.batchKey !== batchRow.key) return;
                          void performMoveWorkout({
                            workoutId: moveMode.workoutId,
                            batchKey: moveMode.batchKey,
                            batchId: moveMode.batchId,
                            fromGroupId: moveMode.fromGroupId,
                            toGroupId: "NEW_GROUP",
                          });
                        }}
                        style={{
                          marginHorizontal: 8,
                          marginVertical: 8,
                          borderWidth: 1,
                          borderStyle: "dashed",
                          borderColor: "#cbd5e1",
                          backgroundColor: "#f8fafc",
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>+ Add new group</Text>
                      </Pressable>
                    )
                  ) : null}
                </View>
              );
            })
          )}
          </View>
        </GridTable>
      </ScrollView>

      {Platform.OS === "web" && webDragGhost ? (
        <div
          style={{
            position: "fixed",
            left: Math.max(8, webDragGhost.x + 12),
            top: Math.max(8, webDragGhost.y + 12),
            width: Math.max(360, webDragGhost.width || Math.max(420, worksheetMinWidth - 140)),
            maxWidth: "78vw",
            pointerEvents: "none",
            zIndex: 99999,
            opacity: 0.94,
          }}
        >
          <div
            ref={webDragGhostHostRef}
            style={{
              pointerEvents: "none",
              borderRadius: 8,
              overflow: "hidden",
              display: webDragGhostUsingClone ? "block" : "none",
            }}
          />
          {!webDragGhostUsingClone ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(120px, 220px) minmax(90px, 150px) minmax(70px, 100px) 100px minmax(180px, 1fr) minmax(120px, 180px)",
                columnGap: 10,
                alignItems: "start",
                padding: "8px 10px",
                fontSize: 12,
                color: "#0f172a",
                background: "#ffffff",
                border: "1px solid #dbe2ee",
                borderRadius: 8,
                boxShadow: "0 12px 30px rgba(15,23,42,0.18)",
                overflow: "hidden",
              }}
            >
              <div style={{ fontWeight: 800, lineHeight: 1.3 }}>{webDragGhost.athleteName || "Athlete"}</div>
              <div style={{ fontWeight: 600, color: "#334155", lineHeight: 1.3 }}>{webDragGhost.location || "-"}</div>
              <div style={{ fontWeight: 600, color: "#334155", lineHeight: 1.3 }}>{webDragGhost.timeText || "-"}</div>
              <div style={{ fontWeight: 800, textAlign: "right", color: "#1f2937", lineHeight: 1.3 }}>{webDragGhost.distanceText || "-"}</div>
              <div style={{ fontWeight: 600, color: "#334155", lineHeight: 1.3 }}>{webDragGhost.details || "-"}</div>
              <div style={{ fontWeight: 700, color: "#475569", lineHeight: 1.3 }}>{webDragGhost.categoriesText || "-"}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {moveMode ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setMoveMode(null)}>
          <Pressable
            onPress={() => setMoveMode(null)}
            style={{ flex: 1, backgroundColor: "rgba(2, 6, 23, 0.35)", justifyContent: "flex-end" }}
          >
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{
                backgroundColor: "#fff",
                borderTopLeftRadius: 14,
                borderTopRightRadius: 14,
                paddingHorizontal: 12,
                paddingVertical: 10,
                gap: 8,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "900", color: "#0f172a" }}>Move to group</Text>

              {(worksheetBatches.find((b) => b.key === moveMode.batchKey)?.groupedAthletes ?? []).map((g) => (
                <Pressable
                  key={`move-${moveMode.workoutId}-${g.groupLabel}`}
                  onPress={() =>
                    void performMoveWorkout({
                      workoutId: moveMode.workoutId,
                      batchKey: moveMode.batchKey,
                      batchId: moveMode.batchId,
                      fromGroupId: moveMode.fromGroupId,
                      toGroupId: g.groupId,
                    })
                  }
                  style={{
                    borderWidth: 1,
                    borderColor: "#dbe2ee",
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>{g.groupLabel}</Text>
                </Pressable>
              ))}

              <Pressable
                onPress={() =>
                  void performMoveWorkout({
                    workoutId: moveMode.workoutId,
                    batchKey: moveMode.batchKey,
                    batchId: moveMode.batchId,
                    fromGroupId: moveMode.fromGroupId,
                    toGroupId: "NEW_GROUP",
                  })
                }
                style={{
                  borderWidth: 1,
                  borderColor: "#cbd5e1",
                  borderStyle: "dashed",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "900", color: "#334155" }}>+ Add new group</Text>
              </Pressable>

              <Pressable
                onPress={() => setMoveMode(null)}
                style={{
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#475569" }}>Cancel</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}
