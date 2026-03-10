import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { GridCell } from "../../components/grid/GridCell";
import { GridTable } from "../../components/grid/GridTable";
import { useGridEngine } from "../../components/grid/useGridEngine";
import { NotesCellEditor } from "../../components/grid/editors/NotesCellEditor";
import { TextCellEditor } from "../../components/grid/editors/TextCellEditor";

import { loadCoachCategories } from "../../lib/coachCategories";
import { loadAuxiliaryRoutines, type AuxiliaryRoutine } from "../../lib/auxiliaryRoutines";
import { getCurrentTeamId } from "../../lib/team";
import { fetchMileageCellsForWeek, type TeamMileageCellRow } from "../../lib/mileageCloud";
import { formatMileageForSheet, getWeekIndex, getWeekStartISO } from "../../lib/mileagePlan";
import {
  compareAthleteDisplayNamesByLastName,
  loadTeamRoster,
  resolveAthleteDisplayName,
  searchRoster,
  toRosterMapById,
  type TeamRosterAthlete,
} from "../../lib/teamRoster";
import {
  createTeamWorkoutBatch,
  deleteTeamWorkout,
  deleteWorkoutBatch,
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
  athleteSession: 90,
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

const ATHLETE_EDIT_FIELDS: AthleteEditableField[] = ["location", "time_text", "details", "primary_category"];

function normalizeCategoryLabel(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function serializeCategories(categories: string[]): string {
  const cleaned = (Array.isArray(categories) ? categories : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .filter((v) => normalizeCategoryLabel(v) !== "other");
  return cleaned.join(", ");
}

function parseCategoryClipboard(text: string, validOptions: string[]): string[] {
  const canonicalByNorm = new Map<string, string>();
  (Array.isArray(validOptions) ? validOptions : []).forEach((opt) => {
    const raw = String(opt ?? "").trim();
    if (!raw) return;
    if (normalizeCategoryLabel(raw) === "other") return;
    canonicalByNorm.set(normalizeCategoryLabel(raw), raw);
  });

  const out: string[] = [];
  String(text ?? "")
    .split(",")
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .forEach((part) => {
      const canonical = canonicalByNorm.get(normalizeCategoryLabel(part));
      if (!canonical) return;
      if (!out.includes(canonical)) out.push(canonical);
    });
  return out;
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

function GroupAthleteRows({
  batchRowKey,
  batchId,
  group,
  rowElByWorkoutId,
  rosterNameById,
  athleteDrafts,
  athleteSaveState,
  categoryNames,
  prescribedDistanceByWorkoutId,
  deletingKey,
  draggingWorkoutId,
  justMovedWorkoutId,
  onEditAthleteField,
  onEditAthleteSession,
  onEditAthleteCategories,
  onDeleteSingleWorkout,
  setDraggingWorkoutId,
  setDragOverTargetGroupId,
  setMoveMode,
  activeGridId,
  setActiveGridId,
  onSelectionMetaChange,
  onRegisterGridApi,
  batchHeaderActiveRef,
}: {
  batchRowKey: string;
  batchId: string | null;
  group: GroupedAthleteRows;
  rowElByWorkoutId: MutableRefObject<Record<string, HTMLElement | null>>;
  rosterNameById: Map<string, string>;
  athleteDrafts: Record<string, AthleteDraft>;
  athleteSaveState: Record<string, SaveState>;
  categoryNames: string[];
  prescribedDistanceByWorkoutId: Record<string, string>;
  deletingKey: string | null;
  draggingWorkoutId: string | null;
  justMovedWorkoutId: string | null;
  onEditAthleteField: (workoutId: string, field: AthleteEditableField, value: string) => void;
  onEditAthleteSession: (workoutId: string, session: "AM" | "PM") => void;
  onEditAthleteCategories: (workoutId: string, categories: string[]) => void;
  onDeleteSingleWorkout: (workoutId: string) => void;
  setDraggingWorkoutId: (id: string | null) => void;
  setDragOverTargetGroupId: (id: string | null) => void;
  setMoveMode: (v: any) => void;
  activeGridId: string | null;
  setActiveGridId: (id: string | null) => void;
  onSelectionMetaChange: (meta: GroupSelectionMeta) => void;
  onRegisterGridApi: (gridId: string, api: GroupGridApi | null) => void;
  batchHeaderActiveRef: MutableRefObject<boolean>;
}) {
  const gridId = useMemo(() => buildGroupKey(batchRowKey, group.groupId), [batchRowKey, group.groupId]);
  const rowIds = useMemo(() => group.rows.map((r) => String(r.id)), [group.rows]);
  const [openCategoryPicker, setOpenCategoryPicker] = useState<{ workoutId: string; slotIndex: number } | null>(null);
  const [categoryPickerQuery, setCategoryPickerQuery] = useState("");
  const [categorySlotCountByWorkoutId, setCategorySlotCountByWorkoutId] = useState<Record<string, number>>({});
  const groupGridRef = useRef<any>(null);

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

  const applyCategoryCellValue = useCallback(
    (workoutId: string, nextCategoriesInput: string[]) => {
      const row = group.rows.find((r) => String(r.id) === workoutId);
      const draft = athleteDrafts[workoutId];
      const prevCategories = resolveDisplayCategories(workoutId, draft, row);
      const nextCategories = normalizeCategoryArrayForGrid(nextCategoriesInput);

      const prevSerialized = serializeCategories(prevCategories);
      const nextSerialized = serializeCategories(nextCategories);

      if (prevSerialized === nextSerialized) return;

      onEditAthleteCategories(workoutId, nextCategories);

      groupGridRef.current?.applyChanges([
        {
          rowId: workoutId,
          colKey: "primary_category",
          prev: prevSerialized,
          next: nextSerialized,
        },
      ] as any);
    },
    [athleteDrafts, group.rows, onEditAthleteCategories, resolveDisplayCategories]
  );

  const groupGrid = useGridEngine<string, AthleteEditableField>({
    enabled: Platform.OS === "web",
    rowIds,
    colKeys: ATHLETE_EDIT_FIELDS,
    isEditorHandlingKeys: () => !!openCategoryPicker,
    getValue: (workoutId, field) => {
      const draft = athleteDrafts[workoutId];
      const row = group.rows.find((r) => String(r.id) === workoutId);
      if (field === "primary_category") {
        const resolved = resolveDisplayCategories(workoutId, draft, row);
        return serializeCategories(resolved);
      }
      if (draft && typeof draft[field] === "string") return String(draft[field] ?? "");
      if (!row) return "";
      if (field === "location") return String(row.location ?? "");
      if (field === "time_text") return String(row.time_text ?? "");
      if (field === "details") return String(row.details ?? "");
      return "";
    },
    setValue: (workoutId, field, value) => {
      if (field !== "primary_category") {
        onEditAthleteField(workoutId, field, value);
        return;
      }
      const parsed = parseCategoryClipboard(String(value ?? ""), categoryNames);
      if (parsed.length > 0) {
        applyCategoryCellValue(workoutId, parsed);
        return;
      }
      if (!String(value ?? "").trim()) {
        applyCategoryCellValue(workoutId, []);
      }
    },
    onActivate: () => setActiveGridId(gridId),
    onSelectionChange: (selection) =>
      onSelectionMetaChange({
        rowIds: selection.rowIds.map((id) => String(id)),
        colKeys: selection.colKeys,
      }),
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
    const sourceRow = group.rows.find((r) => String(r.id) === sourceId);
    const sourceCategories = resolveDisplayCategories(sourceId, athleteDrafts[sourceId], sourceRow);
    const targetIds = rowIds.slice(1);
    const changes: Array<{ rowId: string; colKey: AthleteEditableField; prev: string; next: string }> = [];
    targetIds.forEach((id) => {
      ATHLETE_EDIT_FIELDS.forEach((field) => {
        if (field === "primary_category") return;
        const prev = String((athleteDrafts[id] as any)?.[field] ?? group.rows.find((r) => String(r.id) === id)?.[field] ?? "");
        changes.push({ rowId: id, colKey: field, prev, next: String(source[field] ?? "") });
      });
      applyCategoryCellValue(id, sourceCategories);
    });
    groupGrid.applyChanges(changes as any);
  }, [applyCategoryCellValue, athleteDrafts, group.rows, groupGrid, resolveDisplayCategories, rowIds]);

  const fillSelectedForGroup = useCallback(() => {
    const rect = groupGrid.getSelectionRect();
    if (!rect) return;
    const sourceRowIndex = rect.r1;
    const sourceId = rowIds[sourceRowIndex];
    if (!sourceId) return;
    const source = athleteDrafts[sourceId] ?? {
      session: "AM",
      location: "",
      time_text: "",
      details: "",
      primary_category: "",
      categories: [],
    };
    const sourceRow = group.rows.find((r) => String(r.id) === sourceId);
    const sourceCategories = resolveDisplayCategories(sourceId, athleteDrafts[sourceId], sourceRow);
    const selectedCols = new Set(groupGrid.getSelectedColKeys());
    const selectedRowIds = groupGrid.selectedRowIds;
    const changes: Array<{ rowId: string; colKey: AthleteEditableField; prev: string; next: string }> = [];
    selectedRowIds.forEach((id) => {
      if (id === sourceId) return;
      ATHLETE_EDIT_FIELDS.forEach((field) => {
        if (field === "primary_category") return;
        if (!selectedCols.has(field)) return;
        const prev = String((athleteDrafts[id] as any)?.[field] ?? group.rows.find((r) => String(r.id) === id)?.[field] ?? "");
        changes.push({ rowId: id, colKey: field, prev, next: String(source[field] ?? "") });
      });
      if (selectedCols.has("primary_category")) applyCategoryCellValue(id, sourceCategories);
    });
    groupGrid.applyChanges(changes as any);
  }, [applyCategoryCellValue, athleteDrafts, group.rows, groupGrid, resolveDisplayCategories, rowIds]);

  useEffect(() => {
    onRegisterGridApi(gridId, {
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
    return () => onRegisterGridApi(gridId, null);
  }, [fillAllForGroup, fillSelectedForGroup, gridId, groupGrid, onRegisterGridApi]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handler = (e: any) => {
      if (batchHeaderActiveRef.current) return;
      if (activeGridId !== gridId) return;
      const key = String(e?.key ?? "");
      const categoryDropdownOpen = !!openCategoryPicker;
      if (
        categoryDropdownOpen &&
        ["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(key)
      ) {
        return;
      }
      const handled = groupGrid.handleKeyDown(e);
      if (!handled) return;
      e.preventDefault?.();
      e.stopPropagation?.();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, true);
    };
  }, [activeGridId, batchHeaderActiveRef, fillSelectedForGroup, gridId, groupGrid, openCategoryPicker]);

  return (
    <View style={{ position: "relative" }}>
      {openCategoryPicker ? (
        <Pressable
          onPress={() => setOpenCategoryPicker(null)}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 70,
          }}
        />
      ) : null}
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
        const categorySelected = groupGrid.isCellSelected(workoutId, "primary_category");
        const locationActive = groupGrid.isCellActive(workoutId, "location");
        const timeActive = groupGrid.isCellActive(workoutId, "time_text");
        const notesActive = groupGrid.isCellActive(workoutId, "details");
        const categoryActive = groupGrid.isCellActive(workoutId, "primary_category");
        const displayCategories = resolveDisplayCategories(workoutId, athleteDraft, workout);
        const categorySlotsRaw =
          displayCategories.length > 0
            ? displayCategories
            : String(athleteDraft.primary_category ?? "").trim()
            ? [String(athleteDraft.primary_category ?? "").trim()]
            : [];
        const categorySlotCount = Math.max(1, categorySlotsRaw.length, categorySlotCountByWorkoutId[workoutId] ?? 1);
        const categoryOptions = categoryNames
          .map((name) => String(name ?? "").trim())
          .filter(Boolean)
          .filter((name) => name.toLowerCase().includes(String(categoryPickerQuery ?? "").trim().toLowerCase()));
        const rowStyle = {
          flexDirection: "row" as const,
          minHeight: 40,
          backgroundColor:
            draggingWorkoutId === workoutId
              ? "rgba(148, 163, 184, 0.08)"
              : justMovedWorkoutId === workoutId
              ? "rgba(59, 130, 246, 0.10)"
              : idx % 2 === 0
              ? "#ffffff"
              : "#f9fbfe",
          borderBottomWidth: 1,
          borderBottomColor: "#e2e8f0",
          opacity: draggingWorkoutId === workoutId ? 0.45 : 1,
          position: "relative" as const,
          zIndex: openCategoryPicker?.workoutId === workoutId ? 200 : 1,
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
              {Platform.OS === "web" ? (
                <div
                  draggable
                  style={{
                    width: 30,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "grab",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    MozUserSelect: "none",
                    color: "#64748b",
                    fontSize: "14px",
                    fontWeight: 900,
                  }}
                  onDragStart={(e: any) => {
                    if (!batchId) return;
                    const ne = e?.nativeEvent ?? e;
                    const payload = { workoutId, batchId, fromGroupId: group.groupId ?? null };
                    const anchor = rowElByWorkoutId.current[workoutId];
                    if (!anchor) return;
                    const rowNode =
                      (anchor.firstElementChild?.closest?.("[data-row-container]") as HTMLElement | null) ??
                      (anchor.firstElementChild as HTMLElement | null) ??
                      anchor;
                    const row = rowNode as HTMLElement;
                    if (row && ne?.dataTransfer?.setDragImage) {
                      const clone = row.cloneNode(true) as HTMLElement;
                      const rect = row.getBoundingClientRect();
                      clone.style.position = "absolute";
                      clone.style.top = "-1000px";
                      clone.style.left = "-1000px";
                      clone.style.width = `${rect.width}px`;
                      clone.style.pointerEvents = "none";
                      clone.style.opacity = "0.95";
                      clone.style.background = "white";
                      clone.style.borderRadius = "8px";
                      clone.style.boxShadow = "0 8px 24px rgba(0,0,0,0.15)";
                      document.body.appendChild(clone);
                      ne.dataTransfer.setDragImage(clone, 24, 24);
                      requestAnimationFrame(() => {
                        setTimeout(() => {
                          if (clone.parentNode) clone.parentNode.removeChild(clone);
                        }, 50);
                      });
                    }
                    ne?.dataTransfer?.setData?.("text/plain", JSON.stringify(payload));
                    ne?.dataTransfer?.setData?.("application/json", JSON.stringify(payload));
                    if (ne?.dataTransfer) ne.dataTransfer.effectAllowed = "move";
                    setDraggingWorkoutId(workoutId);
                  }}
                  onDragEnd={() => {
                    setDraggingWorkoutId(null);
                    setDragOverTargetGroupId(null);
                  }}
                >
                  {"⋮⋮"}
                </div>
              ) : (
                <Text style={{ fontSize: 13, fontWeight: "900", color: "#94a3b8" }}>⋮⋮</Text>
              )}
            </View>

            <View
              style={{
                flexGrow: 0,
                flexShrink: 1,
                flexBasis: COL.athleteName,
                minWidth: 160,
                maxWidth: 260,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 8,
                overflow: "hidden",
              }}
            >
              <Text numberOfLines={1} ellipsizeMode="tail" style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>
                {athleteName}
              </Text>
            </View>

            <View
              style={{
                width: COL.athleteSession,
                minWidth: 0,
                flexShrink: 1,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 6,
              }}
            >
              <View style={{ flexDirection: "row", gap: 4 }}>
                {(["AM", "PM"] as const).map((s) => (
                  <Pressable
                    key={`${workoutId}-${s}`}
                    onPress={() => onEditAthleteSession(workoutId, s)}
                    style={{
                      flex: 1,
                      alignItems: "center",
                      justifyContent: "center",
                      borderWidth: 1,
                      borderColor: athleteDraft.session === s ? "#0f172a" : "#cbd5e1",
                      backgroundColor: athleteDraft.session === s ? "#0f172a" : "#fff",
                      borderRadius: 6,
                      paddingVertical: 2,
                    }}
                  >
                    <Text style={{ fontSize: 10, fontWeight: "900", color: athleteDraft.session === s ? "#fff" : "#334155" }}>
                      {s}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View
              style={{
                width: COL.athleteLocation,
                minWidth: 0,
                flexShrink: 1,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 8,
                overflow: "hidden",
                ...(locationSelected ? ({ outline: "1px solid rgba(15,23,42,0.55)", outlineOffset: -1 } as any) : null),
                ...(locationActive ? ({ outline: "2px solid #111827", outlineOffset: -2 } as any) : null),
              }}
            >
              <GridCell
                value={athleteDraft.location}
                onChangeText={(v) => groupGrid.applyCellValue(workoutId, "location", v)}
                style={{ fontSize: 12, fontWeight: "600", color: "#334155", paddingVertical: 3 }}
                placeholder="Location"
                numberOfLines={1}
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
                width: COL.athleteTime,
                minWidth: 0,
                flexShrink: 1,
                borderRightWidth: 1,
                borderRightColor: "#e3e8f0",
                justifyContent: "center",
                paddingHorizontal: 8,
                overflow: "hidden",
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
                justifyContent: "flex-start",
                paddingHorizontal: 8,
                ...(categorySelected ? ({ outline: "1px solid rgba(15,23,42,0.55)", outlineOffset: -1 } as any) : null),
                ...(categoryActive ? ({ outline: "2px solid #111827", outlineOffset: -2 } as any) : null),
                overflow: "visible",
                zIndex: 20,
              }}
            >
              <View style={{ gap: 4, paddingVertical: 4 }} {...(groupGrid.bindCell(workoutId, "primary_category") as any)}>
                {Array.from({ length: categorySlotCount }).map((_, slotIndex) => {
                  const slotValue = categorySlotsRaw[slotIndex] ?? "";
                  const isOpen =
                    openCategoryPicker?.workoutId === workoutId &&
                    openCategoryPicker.slotIndex === slotIndex;
                  return (
                    <View
                      key={`athlete-cat-slot-${workoutId}-${slotIndex}`}
                      data-athlete-category-picker="1"
                      style={{ flexDirection: "row", alignItems: "center", gap: 4, position: "relative", zIndex: isOpen ? 80 : 1 }}
                    >
                      <Pressable
                        onPress={() => {
                          setActiveGridId(gridId);
                          if (isOpen) {
                            setOpenCategoryPicker(null);
                            return;
                          }
                          setOpenCategoryPicker({ workoutId, slotIndex });
                          setCategoryPickerQuery("");
                        }}
                        style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 5, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#fff", position: "relative", zIndex: isOpen ? 95 : 1 }}
                      >
                        <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "700", color: slotValue ? "#334155" : "#94a3b8" }}>
                          {slotValue || "Select"}
                        </Text>
                        <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>{isOpen ? "▴" : "▾"}</Text>
                      </Pressable>

                      <Pressable
                        onPress={() => {
                          if (slotIndex === 0 && categorySlotCount <= 1) return;
                          if (slotValue) {
                            const next = categorySlotsRaw.filter((_, idx) => idx !== slotIndex);
                            applyCategoryCellValue(workoutId, next);
                          }
                          setCategorySlotCountByWorkoutId((prev) => ({
                            ...prev,
                            [workoutId]: Math.max(1, (prev[workoutId] ?? categorySlotCount) - 1),
                          }));
                          if (isOpen) setOpenCategoryPicker(null);
                        }}
                        style={{ width: 22, height: 22, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 6, alignItems: "center", justifyContent: "center", opacity: slotIndex === 0 && categorySlotCount <= 1 ? 0.4 : 1 }}
                        disabled={slotIndex === 0 && categorySlotCount <= 1}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#b91c1c" }}>−</Text>
                      </Pressable>

                      <Pressable
                        onPress={() =>
                          setCategorySlotCountByWorkoutId((prev) => ({
                            ...prev,
                            [workoutId]: (prev[workoutId] ?? categorySlotCount) + 1,
                          }))
                        }
                        style={{ width: 22, height: 22, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 6, alignItems: "center", justifyContent: "center" }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#334155" }}>+</Text>
                      </Pressable>

                      {isOpen ? (
                        <View
                          data-athlete-category-picker="1"
                          style={{
                            position: "absolute",
                            top: 30,
                            left: 0,
                            right: 48,
                            borderWidth: 1,
                            borderColor: "#e2e8f0",
                            borderRadius: 8,
                            overflow: "hidden",
                            backgroundColor: "#fff",
                            zIndex: 90,
                            ...(Platform.OS === "android" ? { elevation: 7 } : null),
                          }}
                        >
                          <TextInput
                            value={categoryPickerQuery}
                            onChangeText={setCategoryPickerQuery}
                            placeholder="Search..."
                            style={{ borderBottomWidth: 1, borderBottomColor: "#edf2f7", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "700" }}
                          />
                          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 180 }}>
                            {categoryOptions.map((name) => (
                              <Pressable
                                key={`athlete-cat-opt-${workoutId}-${name}`}
                                onPress={() => {
                                  const next = [...categorySlotsRaw];
                                  if (next.includes(name) && next[slotIndex] !== name) return;
                                  next[slotIndex] = name;
                                  applyCategoryCellValue(workoutId, next.filter(Boolean));
                                  setOpenCategoryPicker(null);
                                }}
                                style={{ paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#edf2f7", backgroundColor: "#fff" }}
                              >
                                <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>{name}</Text>
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
              <Pressable
                onPress={() => void onDeleteSingleWorkout(workoutId)}
                disabled={deletingKey === workoutId}
                style={{ borderWidth: 1, borderColor: "#f2c4c4", backgroundColor: "#fff0f0", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: deletingKey === workoutId ? 0.6 : 1 }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#9f1239" }}>
                  {deletingKey === workoutId ? "Deleting..." : "Delete"}
                </Text>
              </Pressable>

              <Text style={{ fontSize: 11, fontWeight: "800", color: athleteState?.status === "error" ? "#b91c1c" : "#64748b" }}>
                {saveStatusText(athleteState)}
              </Text>
            </View>
          </>
        );

        if (Platform.OS === "web") {
          return (
            <div
              key={`${batchRowKey}-athlete-${workoutId}`}
              style={{ display: "contents" }}
              data-row-anchor={workoutId}
              ref={(el) => {
                rowElByWorkoutId.current[workoutId] = el;
              }}
            >
              <View
                {...({ "data-row-id": workoutId, "data-row-container": "1" } as any)}
                style={[
                  rowStyle,
                  {
                    userSelect: "text",
                    transition:
                      "transform 120ms ease, background-color 250ms ease, opacity 120ms ease, border-color 120ms ease",
                    transform: justMovedWorkoutId === workoutId ? "scale(1.01)" : "scale(1)",
                    outline: draggingWorkoutId === workoutId ? "1px solid rgba(0,0,0,0.15)" : "none",
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
}

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

function saveStatusText(state?: SaveState): string {
  if (!state || state.status === "idle") return "";
  if (state.status === "saving") return "Saving...";
  if (state.status === "saved") return "Saved";
  return "Error";
}

export default function CoachWorkoutsDay() {
  const router = useRouter();
  const { patch: patchAppRuntime } = useAppRuntime();
  const { date, refresh, batch } = useLocalSearchParams<{ date?: string; refresh?: string | string[]; batch?: string | string[] }>();

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
  const rowElByWorkoutId = useRef<Record<string, HTMLElement | null>>({});
  const savedAthleteDraftsRef = useRef<Record<string, AthleteDraft>>({});
  const batchDraftsRef = useRef<Record<string, BatchDraft>>({});
  const batchDirtyFieldsRef = useRef<Record<string, Partial<Record<BatchEditableField, true>>>>({});
  const athleteDraftsRef = useRef<Record<string, AthleteDraft>>({});
  const mileageDistanceRequestRef = useRef(0);

  const [loading, setLoading] = useState(true);
  const [rowsRaw, setRowsRaw] = useState<TeamWorkoutRow[]>([]);
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());
  const [rosterOptions, setRosterOptions] = useState<RosterOption[]>([]);

  const [expandedByBatchKey, setExpandedByBatchKey] = useState<Record<string, boolean>>({});
  const [groupOrderByBatch, setGroupOrderByBatch] = useState<Record<string, string[]>>({});
  const [draggingWorkoutId, setDraggingWorkoutId] = useState<string | null>(null);
  const [dragOverTargetGroupId, setDragOverTargetGroupId] = useState<string | null>(null);
  const [justMovedWorkoutId, setJustMovedWorkoutId] = useState<string | null>(null);
  const [moveMode, setMoveMode] = useState<{
    workoutId: string;
    batchKey: string;
    batchId: string;
    fromGroupId: string | null;
  } | null>(null);

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
  const [auxiliaryRoutines, setAuxiliaryRoutines] = useState<AuxiliaryRoutine[]>([]);
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
  const [pickerBatchKey, setPickerBatchKey] = useState<string | null>(null);
  const [athleteMenuBatchKey, setAthleteMenuBatchKey] = useState<string | null>(null);
  const [removingAthleteId, setRemovingAthleteId] = useState<string | null>(null);
  const [pendingRemovedAthleteKeys, setPendingRemovedAthleteKeys] = useState<Set<string>>(new Set());
  const [pickerQuery, setPickerQuery] = useState("");
  const [addingAthleteId, setAddingAthleteId] = useState<string | null>(null);
  const [creatingBatch, setCreatingBatch] = useState(false);
  const justMovedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchHeaderInputRefs = useRef<Record<string, any>>({});
  const batchHeaderRegionRefs = useRef<Record<string, any>>({});
  const batchHeaderRootRef = useRef<any>(null);
  const headerBlurTimerRef = useRef<any>(null);
  const loadVersionRef = useRef(0);

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

      const [workoutRows, rosterRows] = await Promise.all([
        listTeamWorkoutsInRange(targetDateISO, targetDateISO),
        loadTeamRoster(teamId),
      ]);
      if (!isLatestRequest()) {
        console.log("[workouts] loadDay:staleSkipped", { targetDateISO, requestVersion });
        return false;
      }

      const nextRows = workoutRows;
      console.log("[workouts] loadDay:rows", { count: nextRows.length });
      setRowsRaw(nextRows);

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
        const categoriesForRow = (Array.isArray(w.categories) ? w.categories : [])
          .map((c) => String(c ?? "").trim())
          .filter(Boolean);
        const primary = String(w.primary_category ?? "").trim();
        nextAthleteDrafts[String(w.id)] = {
          session: normalizeSession(w.session),
          location: String(w.location ?? ""),
          time_text: String(w.time_text ?? ""),
          details: String(w.details ?? ""),
          primary_category: primary,
          categories: categoriesForRow.length > 0 ? categoriesForRow : (primary ? [primary] : []),
        };
      });

      setBatchDrafts(nextBatchDrafts);
      batchDraftsRef.current = nextBatchDrafts;
      setBatchDirtyFields({});
      batchDirtyFieldsRef.current = {};
      setBatchSaveState({});
      setAthleteDrafts(nextAthleteDrafts);
      athleteDraftsRef.current = nextAthleteDrafts;
      console.log("[workouts] loadDay:stateApplied", {
        batchDraftCount: Object.keys(nextBatchDrafts).length,
        athleteDraftCount: Object.keys(nextAthleteDrafts).length,
      });
      savedAthleteDraftsRef.current = nextAthleteDrafts;
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
      activeBatchId: batchParam || null,
      selectedBatchHighlight: highlightBatchKey,
    });
  }, [batchParam, dayISO, highlightBatchKey, patchAppRuntime]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        await refreshDayGuarded(dayISO);
      } catch (e: any) {
        if (!mounted) return;
        patchAppRuntime({ lastSaveError: String(e?.message ?? e ?? "Could not load daily workouts.") });
        Alert.alert("Load failed", e?.message ?? "Could not load daily workouts.");
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [dayISO, refresh, patchAppRuntime, refreshDayGuarded]);

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
    setActiveGridId(null);
  }, [dayISO]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [stored, routines] = await Promise.all([loadCoachCategories(), loadAuxiliaryRoutines()]);
      if (!mounted) return;
      setCategories(stored);
      setAuxiliaryRoutines(Array.isArray(routines) ? routines : []);
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

      const groupedAthletes: GroupedAthleteRows[] = orderedGroupIds.map((groupId, index) => {
          const groupRows = groupedByGroup.get(groupId) ?? [];
          const sortedRows = [...groupRows].sort((a, b) => {
            const na = String(rosterNameById.get(String(a.athlete_profile_id ?? "").trim()) ?? "");
            const nb = String(rosterNameById.get(String(b.athlete_profile_id ?? "").trim()) ?? "");
            return compareAthleteDisplayNamesByLastName(na, nb);
          });
          return {
            groupId,
            groupLabel: `Group ${index + 1}`,
            rows: sortedRows,
          };
        });

      return {
        key,
        batchId: String(sample.batch_id ?? "").trim() || null,
        sample,
        workouts,
        groupedAthletes,
        athleteCount: Math.max(1, uniqueAthletes.size),
      };
    });

    rows.sort((a, b) => {
      const sa = String(a.sample.session ?? "");
      const sb = String(b.sample.session ?? "");
      if (sa !== sb) return sa.localeCompare(sb);
      const ta = String(a.sample.time_text ?? "").trim();
      const tb = String(b.sample.time_text ?? "").trim();
      if (!ta && tb) return -1;
      if (ta && !tb) return 1;
      if (ta !== tb) return ta.localeCompare(tb);
      return String(a.sample.title ?? "").localeCompare(String(b.sample.title ?? ""));
    });

    return rows;
  }, [groupOrderByBatch, pendingRemovedAthleteKeys, rowsRaw, rosterNameById]);

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
    }, 900);
  };

  const setAthleteSavedSoonIdle = (workoutId: string) => {
    setTimeout(() => {
      setAthleteSaveState((prev) => {
        if (prev[workoutId]?.status !== "saved") return prev;
        const next = { ...prev };
        next[workoutId] = { status: "idle" };
        return next;
      });
    }, 900);
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
          const cleaned = (Array.isArray(draft.categories) ? draft.categories : [])
            .map((c) => String(c ?? "").trim())
            .filter((c) => !!c && c.toLowerCase() !== "other");
          payload.categories = cleaned;
          payload.primary_category = cleaned[0] ?? null;
        }
      });

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
        }
        console.log("[workouts] commitBatchEdit:success", { batchKey, dirtyKeys });
        const nextDateISO = String(draft.date_iso ?? "").trim();
        if (!isUnmountingRef.current && isISODateOnly(nextDateISO) && nextDateISO !== dayISO) {
          router.replace({
            pathname: "/(coach)/workouts",
            params: { date: nextDateISO, refresh: Date.now().toString() },
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
    [dayISO, router]
  );

  const scheduleBatchSave = useCallback(
    (batchKey: string, delayMs = 450) => {
      const current = batchSaveTimersRef.current[batchKey];
      if (current) clearTimeout(current);
      batchSaveTimersRef.current[batchKey] = setTimeout(() => {
        void commitBatchEdit(batchKey);
      }, delayMs);
    },
    [commitBatchEdit]
  );

  const scheduleBatchRoutineSave = useCallback(
    (batchKey: string, field: "pre" | "post", nextIds: string[], delayMs = 450) => {
      const timerKey = `${batchKey}:${field}`;
      const current = batchRoutineSaveTimersRef.current[timerKey];
      if (current) clearTimeout(current);
      setBatchSaveState((prev) => ({ ...prev, [batchKey]: { status: "saving" } }));
      batchRoutineSaveTimersRef.current[timerKey] = setTimeout(async () => {
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
        } catch (e: any) {
          setBatchSaveState((prev) => ({
            ...prev,
            [batchKey]: { status: "error", message: String(e?.message ?? "Save failed") },
          }));
        }
      }, delayMs);
    },
    []
  );

  const commitAthleteEdit = useCallback(
    async (workoutId: string) => {
      const draft = athleteDraftsRef.current[workoutId];
      if (!draft) return;

      const payload: Partial<TeamWorkoutRow> = {
        session: normalizeSession(draft.session),
        location: String(draft.location ?? "").trim() || null,
        time_text: String(draft.time_text ?? "").trim() || null,
        details: String(draft.details ?? "").trim() || null,
        primary_category: String(draft.primary_category ?? "").trim() || null,
        categories: (Array.isArray(draft.categories) ? draft.categories : [])
          .map((c) => String(c ?? "").trim())
          .filter(Boolean),
      };

      if (!isUnmountingRef.current) {
        setAthleteSaveState((prev) => ({ ...prev, [workoutId]: { status: "saving" } }));
      }

      try {
        await updateTeamWorkoutById(workoutId, payload);

        savedAthleteDraftsRef.current[workoutId] = {
          session: normalizeSession(draft.session),
          location: String(draft.location ?? ""),
          time_text: String(draft.time_text ?? ""),
          details: String(draft.details ?? ""),
          primary_category: String(draft.primary_category ?? ""),
          categories: (Array.isArray(draft.categories) ? draft.categories : [])
            .map((c) => String(c ?? "").trim())
            .filter(Boolean),
        };
        if (!isUnmountingRef.current) {
          setAthleteSaveState((prev) => ({ ...prev, [workoutId]: { status: "saved" } }));
          setAthleteSavedSoonIdle(workoutId);
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
    []
  );

  const scheduleAthleteSave = useCallback(
    (workoutId: string, delayMs = 600) => {
      const current = athleteSaveTimersRef.current[workoutId];
      if (current) clearTimeout(current);
      athleteSaveTimersRef.current[workoutId] = setTimeout(() => {
        void commitAthleteEdit(workoutId);
      }, delayMs);
    },
    [commitAthleteEdit]
  );

  const flushAllPendingBatchSaves = useCallback(async () => {
    const timedBatchKeys = Object.keys(batchSaveTimersRef.current);
    timedBatchKeys.forEach((batchKey) => {
      const timer = batchSaveTimersRef.current[batchKey];
      if (timer) clearTimeout(timer);
      delete batchSaveTimersRef.current[batchKey];
    });

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
  }, [commitBatchEdit]);

  const flushAllPendingAthleteSaves = useCallback(async () => {
    const timedWorkoutIds = Object.keys(athleteSaveTimersRef.current);
    timedWorkoutIds.forEach((workoutId) => {
      const timer = athleteSaveTimersRef.current[workoutId];
      if (timer) clearTimeout(timer);
      delete athleteSaveTimersRef.current[workoutId];
    });

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
  }, [commitAthleteEdit]);

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
          : { ...current, [field]: String(value ?? "") };
      const next = { ...prev, [batchKey]: nextDraft };
      batchDraftsRef.current = next;
      return next;
    });
    setBatchDirtyFields((prev) => {
      const next = {
        ...prev,
        [batchKey]: { ...(prev[batchKey] ?? {}), [field]: true },
      };
      batchDirtyFieldsRef.current = next;
      return next;
    });

    const parsed = parseBatchKey(batchKey);
    const matchingWorkoutIds = rowsRaw
      .filter((w) =>
        parsed.isBatch
          ? String(w.batch_id ?? "").trim() === parsed.id
          : String(w.id) === parsed.id
      )
      .map((w) => String(w.id));

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

        if (field === "session") return { ...w, session: normalizeSession(String(value ?? "")) };
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
          next[workoutId] = { ...current, session: normalizeSession(String(value ?? "")) };
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

  const onEditAthleteField = (
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
  };

  const onEditAthleteSession = (workoutId: string, session: "AM" | "PM") => {
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
        },
      };
      athleteDraftsRef.current = next;
      return next;
    });

    setRowsRaw((prev) =>
      prev.map((w) => (String(w.id) === workoutId ? { ...w, session } : w))
    );

    scheduleAthleteSave(workoutId);
  };

  const onEditAthleteCategories = (workoutId: string, categoriesInput: string[]) => {
    const normalized = normalizeCategoryArrayForGrid(Array.isArray(categoriesInput) ? categoriesInput : []);
    const primary = normalized[0] ?? "";

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
          primary_category: primary,
          categories: normalized,
        },
      };
      athleteDraftsRef.current = next;
      return next;
    });

    setRowsRaw((prev) =>
      prev.map((w) =>
        String(w.id) === workoutId
          ? {
              ...w,
              primary_category: primary || null,
              categories: normalized,
            }
          : w
      )
    );

    scheduleAthleteSave(workoutId);
  };

  const goToDate = (targetDateISO: string) => {
    router.replace({ pathname: "/(coach)/workouts", params: { date: targetDateISO } });
  };

  const openBatchEditor = (row: WorksheetBatchRow) => {
    if (row.batchId) {
      router.push({
        pathname: "/(coach)/workout-batch/[batchId]",
        params: {
          batchId: row.batchId,
          returnTo: "/(coach)/workouts",
          returnDateISO: dayISO,
        },
      });
      return;
    }

    router.push({ pathname: "/(coach)/workout/[id]", params: { id: String(row.sample.id) } });
  };

  const confirmDelete = async (title: string, message: string): Promise<boolean> => {
    if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
      return globalThis.confirm(message);
    }

    return await new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Delete", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
  };

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

  const deleteSingleWorkout = async (workoutId: string) => {
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
  };

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

  const bulkSetCategory = (groupKey: string, value: string) => {
    const ids = getSelectedRowIdsForGroup(groupKey);
    const trimmed = String(value ?? "").trim();
    const validNames = new Set(
      (Array.isArray(categories) ? categories : [])
        .map((c) => String((c as any)?.name ?? "").trim())
        .filter(Boolean)
    );
    if (validNames.size > 0 && !validNames.has(trimmed)) {
      Alert.alert("Invalid category", "Choose a category from Settings.");
      return;
    }
    if (!trimmed || ids.length === 0) return;
    ids.forEach((id) => onEditAthleteCategories(id, [trimmed]));
  };

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

  const pickerBatch = useMemo(
    () => (pickerBatchKey ? worksheetBatches.find((b) => b.key === pickerBatchKey) ?? null : null),
    [pickerBatchKey, worksheetBatches]
  );

  const pickerSelectedAthleteIds = useMemo(
    () =>
      new Set(
        (pickerBatch?.workouts ?? [])
          .map((w) => String(w.athlete_profile_id ?? "").trim())
          .filter(Boolean)
      ),
    [pickerBatch]
  );

  const athleteMenuBatch = useMemo(
    () => (athleteMenuBatchKey ? worksheetBatches.find((b) => b.key === athleteMenuBatchKey) ?? null : null),
    [athleteMenuBatchKey, worksheetBatches]
  );

  const athleteMenuItems = useMemo(() => {
    if (!athleteMenuBatch) return [];
    const byAthleteId = new Map<string, { athleteId: string; displayName: string; workoutIds: string[] }>();
    athleteMenuBatch.workouts.forEach((w) => {
      const athleteId = String(w.athlete_profile_id ?? "").trim();
      if (!athleteId) return;
      const current = byAthleteId.get(athleteId);
      if (current) {
        current.workoutIds.push(String(w.id));
        return;
      }
      byAthleteId.set(athleteId, {
        athleteId,
        displayName: resolveAthleteDisplayName(
          athleteId,
          rosterNameById,
          String((w as any).athlete_name ?? "")
        ),
        workoutIds: [String(w.id)],
      });
    });
    return Array.from(byAthleteId.values()).sort((a, b) =>
      compareAthleteDisplayNamesByLastName(a.displayName, b.displayName)
    );
  }, [athleteMenuBatch, rosterNameById]);

  const filteredRosterOptions = useMemo(() => {
    return searchRoster(rosterOptions, pickerQuery);
  }, [pickerQuery, rosterOptions]);

  useEffect(() => {
    if (!athleteMenuBatchKey) return;
    if (athleteMenuBatch) return;
    setAthleteMenuBatchKey(null);
    setRemovingAthleteId(null);
  }, [athleteMenuBatch, athleteMenuBatchKey]);

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

      const newBatchId = createBatchId(dayISO);
      const payload = rosterOptions
        .map((athlete) => String((athlete as any)?.id ?? "").trim())
        .filter(Boolean)
        .map((athleteId) => ({
          team_id: teamId,
          athlete_profile_id: athleteId,
          created_by: null,
          date_iso: dayISO,
          session: "AM" as const,
          location: null,
          time_text: "",
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
  }, [creatingBatch, dayISO, ensureTeamId, refreshDayGuarded, rosterOptions]);

  const handleRemoveAthleteFromBatch = useCallback(
    async (athleteId: string) => {
      if (!athleteMenuBatch) return;
      const batchId = String(athleteMenuBatch.batchId ?? "").trim();
      if (!batchId) return;
      if (athleteMenuItems.length <= 1) {
        Alert.alert("Cannot remove", "A batch must contain at least one athlete.");
        return;
      }

      const matchingRows = athleteMenuBatch.workouts.filter(
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
        if (athleteMenuItems.length <= 2) {
          setAthleteMenuBatchKey(null);
        }
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
    [athleteMenuBatch, athleteMenuItems, dayISO, refreshDayGuarded]
  );

  const addAthleteToBatch = async (athleteId: string) => {
    if (!pickerBatch || !pickerBatch.batchId) return;
    const exists = pickerBatch.workouts.some(
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
      const sample = pickerBatch.sample;
      const batchDraft =
        batchDrafts[pickerBatch.key] ??
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

      let targetGroupId = pickerBatch.groupedAthletes.find((g) => !!g.groupId)?.groupId ?? null;
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
        batch_id: pickerBatch.batchId,
        group_id: targetGroupId,
        pre_routine_ids: sample.pre_routine_ids ?? null,
        post_routine_ids: sample.post_routine_ids ?? null,
        planned_distance: sample.planned_distance ?? null,
        planned_distance_unit: sample.planned_distance_unit ?? null,
      };

      await createTeamWorkoutBatch([payload]);

      setPickerQuery("");
      setPickerBatchKey(null);
      await refreshDayGuarded(dayISO);
    } catch (e: any) {
      patchAppRuntime({ lastSaveError: String(e?.message ?? e ?? "Could not add athlete to batch.") });
      Alert.alert("Add athlete failed", e?.message ?? "Could not add athlete to batch.");
    } finally {
      setAddingAthleteId((prev) => (prev === athleteId ? null : prev));
    }
  };

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
      } finally {
        setDraggingWorkoutId(null);
        setDragOverTargetGroupId(null);
      }
    },
    []
  );

  const onWebDropToGroup = useCallback(
    async (e: any, targetBatchKey: string, targetBatchId: string | null, targetGroupId: string | null | "NEW_GROUP") => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      setDragOverTargetGroupId(null);
      setDraggingWorkoutId(null);
      console.log("dropTarget", { targetBatchKey, targetBatchId, targetGroupId });

      try {
        const dt = e?.dataTransfer ?? e?.nativeEvent?.dataTransfer;
        const raw = dt?.getData?.("application/json") || dt?.getData?.("text/plain");
        if (!raw) return;
        const payload = JSON.parse(raw);
        console.log("dropPayload", payload);
        const workoutId = String(payload?.workoutId ?? "");
        const sourceBatchId = String(payload?.batchId ?? "");
        const fromGroupIdRaw = String(payload?.fromGroupId ?? "");
        const fromGroupId = fromGroupIdRaw ? fromGroupIdRaw : null;

        if (!workoutId || !targetBatchId) {
          return;
        }
        if (sourceBatchId !== String(targetBatchId)) {
          return;
        }

        await performMoveWorkout({
          workoutId,
          batchKey: targetBatchKey,
          batchId: targetBatchId,
          fromGroupId,
          toGroupId: targetGroupId,
        });
      } catch (err: any) {
        setDraggingWorkoutId(null);
        setDragOverTargetGroupId(null);
      }
    },
    [performMoveWorkout]
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
    COL.athleteSession +
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
          <Pressable
            onPress={() => goToDate(dayISO)}
            style={{ borderWidth: 1, borderColor: "#cfd7e6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
          >
            <Text style={{ fontSize: 12, fontWeight: "800", color: "#24334f" }}>Pick Date</Text>
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

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 18 }} keyboardShouldPersistTaps="handled">
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

              const batchHasOpenOverlay = openBatchPicker?.batchKey === batchRow.key;
              return (
                <View key={batchRow.key} style={{ position: "relative", zIndex: batchHasOpenOverlay ? 200 : 1 }}>
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
                      marginTop: 6,
                      borderWidth: 1,
                      borderColor: highlightBatchKey === batchRow.key ? "#fdba74" : SHEET_BORDER,
                      borderRadius: 2,
                      backgroundColor: highlightBatchKey === batchRow.key ? "#fff7ed" : SHEET_HEADER_BG,
                      overflow: "visible",
                      position: "relative",
                      zIndex: batchHasOpenOverlay ? 220 : 1,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "stretch", gap: 0, borderBottomWidth: 1, borderBottomColor: SHEET_BORDER, backgroundColor: SHEET_HEADER_BG }}>
                      <View style={{ ...batchSheetCellBase, width: COL.toggle, alignItems: "center" }}>
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

                      <View style={{ ...batchSheetCellBase, width: COL.session }}>
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

                      <View style={{ ...batchSheetCellBase, width: COL.time }}>
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

                      <View style={{ ...batchSheetCellBase, width: COL.date }}>
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

                      <View style={{ ...batchSheetCellBase, minWidth: 160, flex: 1 }}>
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

                      <View style={{ ...batchSheetCellBase, minWidth: 200, flex: 1.3 }}>
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

                      <View style={{ ...batchSheetCellBase, width: COL.athletes + 16, alignItems: "flex-start" }}>
                        <Text style={batchSheetLabelText}>Athletes</Text>
                        <Pressable
                          ref={(el) => {
                            batchHeaderInputRefs.current[`${batchRow.key}:athletes`] = el;
                          }}
                          onPress={() => {
                            if (!batchRow.batchId) return;
                            setAthleteMenuBatchKey(batchRow.key);
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
                            {`Athletes: ${batchRow.athleteCount} ▾`}
                          </Text>
                        </Pressable>
                      </View>

                      <View style={{ ...batchSheetCellBase, width: 88, alignItems: "flex-start" }}>
                        <Text style={batchSheetLabelText}>Sections</Text>
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#1e293b" }}>
                          {batchRow.groupedAthletes.length}
                        </Text>
                      </View>

                      <View style={{ ...batchSheetCellBase, minWidth: 230, flexDirection: "row", alignItems: "center", gap: 6, borderRightWidth: 0 }}>
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

                      <View style={{ ...batchSheetCellBase, width: COL.category + 46, justifyContent: "flex-start", overflow: "visible", zIndex: 6 }}>
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

                      <View style={{ ...batchSheetCellBase, width: COL.category + 46, justifyContent: "flex-start", overflow: "visible", zIndex: 5 }}>
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

                      <View style={{ ...batchSheetCellBase, width: COL.category + 46, justifyContent: "flex-start", overflow: "visible", zIndex: 4 }}>
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

                      <View style={{ ...batchSheetCellBase, width: 120, alignItems: "flex-end", borderRightWidth: 0 }}>
                        <Text style={batchSheetLabelText}>Status</Text>
                        <Text style={{ fontSize: 11, fontWeight: "800", color: batchState?.status === "error" ? "#b91c1c" : "#64748b", textAlign: "right" }}>
                          {saveStatusText(batchState)}
                        </Text>
                      </View>
                    </View>

                    {openBatchPicker?.batchKey === batchRow.key ? (
                      <Pressable
                        onPress={() => setOpenBatchPicker(null)}
                        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 }}
                      />
                    ) : null}
                  </View>

                  {expanded
                    ? batchRow.groupedAthletes.map((group) => {
                        const groupTargetId = group.groupId ?? "UNGROUPED";
                        const groupSurfaceStyle = {
                          width: "100%",
                          borderRadius: 8,
                          padding: 4,
                          minHeight: 44,
                          overflow: "visible",
                          position: "relative",
                          zIndex: 1,
                          backgroundColor: dragOverTargetGroupId === groupTargetId ? "#dbeafe" : "transparent",
                          border: dragOverTargetGroupId === groupTargetId ? "1px dashed rgba(0,0,0,0.25)" : "1px dashed transparent",
                          boxShadow: dragOverTargetGroupId === groupTargetId ? "inset 0 0 0 1px rgba(37,99,235,0.08)" : "none",
                        } as const;
                        const groupKey = buildGroupKey(batchRow.key, group.groupId);
                        const isFilling = fillingGroupKey === groupKey;
                        const selectedRowIds = selectedByGroup[groupKey]?.rowIds ?? [];
                        const groupApi = groupGridApis[groupKey];
                        const groupContent = (
                          <>
                            <View
                              style={{
                                backgroundColor: dragOverTargetGroupId === groupTargetId ? "#dbeafe" : "#f1f5f9",
                                borderBottomWidth: 1,
                                borderBottomColor: "#dbe2ee",
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                flexDirection: "row",
                                alignItems: "center",
                                justifyContent: "space-between",
                              }}
                            >
                              <View style={{ flexDirection: "column" }}>
                                <Text style={{ fontSize: 11, fontWeight: "900", color: "#475569" }}>{group.groupLabel}</Text>
                                {Platform.OS === "web" ? (
                                  <Text style={{ fontSize: 10, fontWeight: "700", color: "#64748b", marginTop: 2 }}>
                                    Drop athlete here
                                  </Text>
                                ) : null}
                              </View>
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                                <Text style={{ fontSize: 11, fontWeight: "800", color: "#475569" }}>
                                  Selected: {selectedRowIds.length}
                                </Text>
                                <Pressable
                                  onPress={() => void groupApi?.copy()}
                                  disabled={!groupApi}
                                  style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: groupApi ? 1 : 0.5 }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Copy</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => void groupApi?.paste()}
                                  disabled={!groupApi}
                                  style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: groupApi ? 1 : 0.5 }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Paste</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => groupApi?.undo()}
                                  disabled={!groupApi}
                                  style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: groupApi ? 1 : 0.5 }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Undo</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => runGroupFillSelected(groupKey)}
                                  disabled={!groupApi || selectedRowIds.length === 0}
                                  style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, opacity: !groupApi || selectedRowIds.length === 0 ? 0.5 : 1 }}
                                >
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Fill Selected</Text>
                                </Pressable>
                                <Pressable
                                  onPress={() => {
                                    if (selectedRowIds.length === 0) return;
                                    const available = categories
                                      .map((c) => String(c.name ?? "").trim())
                                      .filter((name) => !!name && name.toLowerCase() !== "other");
                                    const next = Platform.OS === "web" && typeof globalThis.prompt === "function"
                                      ? globalThis.prompt(
                                          `Set category for selected rows.\nAvailable: ${available.join(", ")}`,
                                          available[0] ?? ""
                                        )
                                      : null;
                                    if (next == null) return;
                                    bulkSetCategory(groupKey, next);
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
                                  <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>Set Category</Text>
                                </Pressable>
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
                                  onPress={() => runGroupFillAll(groupKey)}
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

                            <View style={{ flexDirection: "row", backgroundColor: "#f8fafc", borderBottomWidth: 1, borderBottomColor: "#e2e8f0" }}>
                              <View style={{ width: COL.rowSelect, paddingHorizontal: 6, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0", alignItems: "center" }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>◻</Text>
                              </View>
                              <View style={{ width: COL.dragHandle, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }} />
                              <View
                                style={{
                                  flexGrow: 0,
                                  flexShrink: 1,
                                  flexBasis: COL.athleteName,
                                  minWidth: 160,
                                  maxWidth: 260,
                                  paddingHorizontal: 8,
                                  paddingVertical: 5,
                                  borderRightWidth: 1,
                                  borderRightColor: "#e2e8f0",
                                }}
                              >
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>Athlete</Text>
                              </View>
                              <View style={{ width: COL.athleteSession, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b", textAlign: "center" }}>AM/PM</Text>
                              </View>
                              <View style={{ width: COL.athleteLocation, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }}>
                                <Text style={{ fontSize: 10, fontWeight: "900", color: "#64748b" }}>Location</Text>
                              </View>
                              <View style={{ width: COL.athleteTime, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderRightColor: "#e2e8f0" }}>
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
                              batchRowKey={batchRow.key}
                              batchId={batchRow.batchId}
                              group={group}
                              rowElByWorkoutId={rowElByWorkoutId}
                              rosterNameById={rosterNameById}
                              athleteDrafts={athleteDrafts}
                              athleteSaveState={athleteSaveState}
                              categoryNames={(Array.isArray(categories) ? categories : [])
                                .map((c) => String((c as any)?.name ?? "").trim())
                                .filter((name) => !!name && name.toLowerCase() !== "other")}
                              prescribedDistanceByWorkoutId={prescribedDistanceByWorkoutId}
                              deletingKey={deletingKey}
                              draggingWorkoutId={draggingWorkoutId}
                              justMovedWorkoutId={justMovedWorkoutId}
                              onEditAthleteField={onEditAthleteField}
                              onEditAthleteSession={onEditAthleteSession}
                              onEditAthleteCategories={onEditAthleteCategories}
                              onDeleteSingleWorkout={(id) => void deleteSingleWorkout(id)}
                              setDraggingWorkoutId={setDraggingWorkoutId}
                              setDragOverTargetGroupId={setDragOverTargetGroupId}
                              setMoveMode={setMoveMode}
                              activeGridId={activeGridId}
                              setActiveGridId={setActiveGridId}
                              onSelectionMetaChange={(meta) =>
                                setSelectedByGroup((prev) => ({ ...prev, [groupKey]: meta }))
                              }
                              onRegisterGridApi={(id, api) =>
                                setGroupGridApis((prev) => {
                                  if (!api) {
                                    const next = { ...prev };
                                    delete next[id];
                                    return next;
                                  }
                                  return { ...prev, [id]: api };
                                })
                              }
                              batchHeaderActiveRef={batchHeaderActiveRef}
                            />
                          </>
                        );

                        if (Platform.OS === "web") {
                          return (
                            <div
                              key={`${batchRow.key}-${group.groupLabel}`}
                              data-dropzone="group"
                              style={groupSurfaceStyle as any}
                              onDragOver={(e: any) => {
                                e.preventDefault();
                                if (e?.dataTransfer) e.dataTransfer.dropEffect = "move";
                                setDragOverTargetGroupId(groupTargetId);
                              }}
                              onDragLeave={() => setDragOverTargetGroupId((prev) => (prev === groupTargetId ? null : prev))}
                              onDrop={(e: any) => void onWebDropToGroup(e, batchRow.key, batchRow.batchId, group.groupId)}
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
                        data-dropzone="new-group"
                        style={{
                          width: "100%",
                          minHeight: 44,
                          margin: "8px 8px",
                          border: "1px dashed",
                          borderColor: dragOverTargetGroupId === "NEW_GROUP" ? "#2563eb" : "#cbd5e1",
                          backgroundColor: dragOverTargetGroupId === "NEW_GROUP" ? "#eff6ff" : "#f8fafc",
                          borderRadius: 8,
                          padding: "8px 10px",
                          display: "flex",
                          alignItems: "center",
                          boxShadow: dragOverTargetGroupId === "NEW_GROUP" ? "inset 0 0 0 1px rgba(37,99,235,0.1)" : "none",
                        } as any}
                        onDragOver={(e: any) => {
                          e.preventDefault();
                          if (e?.dataTransfer) e.dataTransfer.dropEffect = "move";
                          setDragOverTargetGroupId("NEW_GROUP");
                        }}
                        onDragLeave={() => setDragOverTargetGroupId((prev) => (prev === "NEW_GROUP" ? null : prev))}
                        onDrop={(e: any) => void onWebDropToGroup(e, batchRow.key, batchRow.batchId, "NEW_GROUP")}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Drop here to add new group</Text>
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

      {athleteMenuBatch ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setAthleteMenuBatchKey(null)}>
          <Pressable
            onPress={() => setAthleteMenuBatchKey(null)}
            style={{ flex: 1, backgroundColor: "rgba(2, 6, 23, 0.35)", justifyContent: Platform.OS === "web" ? "center" : "flex-end", alignItems: "center" }}
          >
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{
                width: Platform.OS === "web" ? 560 : "100%",
                maxHeight: Platform.OS === "web" ? "72%" : "80%",
                backgroundColor: "#fff",
                borderRadius: Platform.OS === "web" ? 12 : 0,
                borderTopLeftRadius: Platform.OS === "web" ? 12 : 14,
                borderTopRightRadius: Platform.OS === "web" ? 12 : 14,
                paddingHorizontal: 12,
                paddingVertical: 10,
                gap: 8,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>Batch Athletes</Text>
              <Text style={{ fontSize: 12, fontWeight: "700", color: "#64748b" }}>
                Remove athletes from this batch
              </Text>

              <ScrollView style={{ maxHeight: Platform.OS === "web" ? 360 : 320 }}>
                {athleteMenuItems.map((item) => {
                  const busy = removingAthleteId === item.athleteId;
                  return (
                    <View
                      key={`batch-athlete-${athleteMenuBatch.key}-${item.athleteId}`}
                      style={{
                        borderWidth: 1,
                        borderColor: "#e2e8f0",
                        backgroundColor: "#fff",
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        marginBottom: 6,
                        opacity: busy ? 0.7 : 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#1d4ed8" }}>✓</Text>
                        <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155", flexShrink: 1 }}>
                          {item.displayName}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => void handleRemoveAthleteFromBatch(item.athleteId)}
                        disabled={busy}
                        style={{
                          borderWidth: 1,
                          borderColor: "#f2c4c4",
                          backgroundColor: "#fff0f0",
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          opacity: busy ? 0.65 : 1,
                        }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: "900", color: "#9f1239" }}>
                          {busy ? "Removing..." : "Remove"}
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>

              <Pressable
                onPress={() => setAthleteMenuBatchKey(null)}
                style={{
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#475569" }}>Close</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}

      {pickerBatch ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setPickerBatchKey(null)}>
          <Pressable
            onPress={() => setPickerBatchKey(null)}
            style={{ flex: 1, backgroundColor: "rgba(2, 6, 23, 0.35)", justifyContent: Platform.OS === "web" ? "center" : "flex-end", alignItems: "center" }}
          >
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{
                width: Platform.OS === "web" ? 560 : "100%",
                maxHeight: Platform.OS === "web" ? "72%" : "80%",
                backgroundColor: "#fff",
                borderRadius: Platform.OS === "web" ? 12 : 0,
                borderTopLeftRadius: Platform.OS === "web" ? 12 : 14,
                borderTopRightRadius: Platform.OS === "web" ? 12 : 14,
                paddingHorizontal: 12,
                paddingVertical: 10,
                gap: 8,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>Add Athletes to Batch</Text>
              <TextCellEditor
                value={pickerQuery}
                onChangeText={setPickerQuery}
                placeholder="Search athletes..."
                style={{
                  borderWidth: 1,
                  borderColor: "#d1d9e6",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  fontSize: 13,
                  fontWeight: "600",
                  color: "#0f172a",
                }}
              />

              <ScrollView style={{ maxHeight: Platform.OS === "web" ? 360 : 320 }}>
                {filteredRosterOptions.map((r) => {
                  const selected = pickerSelectedAthleteIds.has(String(r.id).trim());
                  const busy = addingAthleteId === r.id;
                  return (
                    <Pressable
                      key={`picker-athlete-${r.id}`}
                      onPress={() => {
                        if (!selected && !busy) void addAthleteToBatch(r.id);
                      }}
                      disabled={selected || busy}
                      style={{
                        borderWidth: 1,
                        borderColor: selected ? "#bfdbfe" : "#e2e8f0",
                        backgroundColor: selected ? "#eff6ff" : "#fff",
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        marginBottom: 6,
                        opacity: busy ? 0.7 : 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155", flexShrink: 1 }}>
                        {r.displayName}
                      </Text>
                      <Text style={{ fontSize: 11, fontWeight: "900", color: selected ? "#1d4ed8" : "#64748b" }}>
                        {selected ? "Added" : busy ? "Adding..." : "Add"}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <Pressable
                onPress={() => setPickerBatchKey(null)}
                style={{
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#475569" }}>Close</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}

      {Platform.OS !== "web" && moveMode ? (
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
