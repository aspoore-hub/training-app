// app/(coach)/workout-batch/[batchId].tsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { CoachGridLayout } from "../../../components/coach/CoachGridLayout";
import type { WorkoutCategory } from "../../../lib/types";
import { createWorkoutTemplateFromSource } from "../../../lib/workoutTemplates";
import { loadAuxiliaryRoutines, type AuxiliaryRoutine } from "../../../lib/auxiliaryRoutines";
import { loadRosterNameMapForTeam } from "../../../lib/rosterNameMap";
import { getCategoryOptions, loadCoachSettings } from "../../../lib/settings";
import { getCurrentTeamId } from "../../../lib/team";
import { compareAthleteDisplayNamesByLastName, resolveAthleteDisplayName } from "../../../lib/teamRoster";
import {
  bulkUpdateTeamWorkouts,
  deleteWorkoutBatch,
  listTeamWorkoutsByBatch,
  type TeamWorkoutRow,
} from "../../../lib/teamWorkoutsCloud";

const IOS_ACCESSORY_ID = "batch-workout-accessory";

type EditableWorkout = {
  id: string;
  athleteId: string;
  athleteName: string;
  session: "AM" | "PM";
  dateISO: string;
  title: string;
  details: string;
  time: string;
  category: string;
  categories: string[];
  plannedDistanceText: string;
  groupNumber: string;
  preRoutineIds: string[];
  postRoutineIds: string[];
};

type CopyTemplate = {
  title?: string;
  details?: string;
  category?: string;
  categories?: string[];
  time?: string;
  session?: "AM" | "PM";
  groupNumber?: string;
  preRoutineIds?: string[];
  postRoutineIds?: string[];
};

function parseISODateOnly(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function isISODateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = parseISODateOnly(value);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` === value;
}
function isoDateOnly(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function monthStart(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, delta: number) {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}
function addDays(d: Date, delta: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + delta);
  return next;
}
function buildMonthGrid(anchor: Date) {
  const first = monthStart(anchor);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    return {
      dateISO: isoDateOnly(d),
      dayNumber: d.getDate(),
      inMonth: d.getMonth() === anchor.getMonth(),
    };
  });
}
function formatDisplayDate(iso: string) {
  if (!isISODateOnly(iso)) return String(iso ?? "");
  const d = parseISODateOnly(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function normalizeGroupNumber(raw?: string) {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (!digits) return "1";
  const parsed = Number(digits);
  if (!Number.isFinite(parsed) || parsed <= 0) return "1";
  return String(Math.floor(parsed));
}
function groupNumberToInt(raw?: string) {
  const parsed = Number(normalizeGroupNumber(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.floor(parsed);
}
function normalizeRoutineIds(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((x) => String(x ?? "").trim()).filter(Boolean)));
}
function splitName(name: string) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
function splitIntoKGroups<T>(items: T[], k: number): T[][] {
  if (k <= 1) return [items];
  const groups: T[][] = Array.from({ length: k }, () => []);
  items.forEach((item, i) => groups[i % k].push(item));
  return groups.filter((g) => g.length > 0);
}
function splitIntoPairs<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2));
  if (out.length >= 2 && out[out.length - 1].length === 1) {
    out[out.length - 2] = out[out.length - 2].concat(out.pop() as T[]);
  }
  return out;
}

function rowFromCloud(
  w: TeamWorkoutRow,
  nameByAthleteId: Map<string, string>,
  onMissingRosterName?: (athleteProfileId: string) => void
): EditableWorkout {
  const athleteId = String(w.athlete_profile_id ?? "").trim();
  const rosterName = String(nameByAthleteId.get(athleteId) ?? "").trim();
  const workoutName = String((w as any).athlete_name ?? "").trim();
  if (!rosterName && athleteId) onMissingRosterName?.(athleteId);
  const athleteName = resolveAthleteDisplayName(athleteId, nameByAthleteId, workoutName);

  const cats =
    Array.isArray(w.categories) && w.categories.length > 0
      ? w.categories.map((x) => String(x))
      : [String(w.primary_category ?? "").trim() || "Other"];

  return {
    id: String(w.id),
    athleteId,
    athleteName,
    session: (w.session ?? "AM") as "AM" | "PM",
    dateISO: String(w.date_iso ?? ""),
    title: String(w.title ?? "").trim() || "Workout",
    details: String(w.details ?? ""),
    time: String((w as any).time_text ?? ""),
    category: String(w.primary_category ?? "").trim() || cats[0] || "Other",
    categories: cats.length > 0 ? cats : ["Other"],
    plannedDistanceText:
      typeof w.planned_distance === "number" && Number.isFinite(w.planned_distance) ? String(w.planned_distance) : "",
    groupNumber: normalizeGroupNumber(String(w.group_id ?? "1")),
    preRoutineIds: normalizeRoutineIds((w as any).pre_routine_ids),
    postRoutineIds: normalizeRoutineIds((w as any).post_routine_ids),
  };
}

function toCloudPatch(row: EditableWorkout): Partial<TeamWorkoutRow> {
  const cats = Array.isArray(row.categories) && row.categories.length > 0 ? row.categories : ["Other"];
  const plannedRaw = String(row.plannedDistanceText ?? "").trim();
  const plannedParsed = plannedRaw.length > 0 ? Number(plannedRaw) : null;
  const plannedDistance = plannedRaw.length === 0 || !Number.isFinite(plannedParsed) ? null : plannedParsed;
  const patch: Partial<TeamWorkoutRow> = {
    session: row.session,
    date_iso: String(row.dateISO ?? "").trim(),
    title: String(row.title ?? "").trim() || "Workout",
    details: String(row.details ?? ""),
    time_text: String(row.time ?? ""),
    categories: cats,
    category: cats[0] ?? "Other",
    planned_distance: plannedDistance,
    group_id: normalizeGroupNumber(row.groupNumber),
    pre_routine_ids: normalizeRoutineIds(row.preRoutineIds),
    post_routine_ids: normalizeRoutineIds(row.postRoutineIds),
  } as any;
  return patch;
}

export default function BatchWorkoutEditorScreen() {
  const { batchId, group, returnTo, returnDate, returnDateISO } = useLocalSearchParams<{
    batchId: string;
    group?: string;
    returnTo?: string;
    returnDate?: string;
    returnDateISO?: string;
  }>();
  const router = useRouter();
  const useSharedGridLayout = true;

  const [rows, setRows] = useState<EditableWorkout[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErrorText, setSaveErrorText] = useState("");

  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [auxiliaryRoutines, setAuxiliaryRoutines] = useState<AuxiliaryRoutine[]>([]);

  const [copied, setCopied] = useState<CopyTemplate | null>(null);
  const [copiedFromRowId, setCopiedFromRowId] = useState<string | null>(null);
  const [pasteHighlightRowId, setPasteHighlightRowId] = useState<string | null>(null);

  const [masterSession, setMasterSession] = useState<"AM" | "PM" | null>(null);
  const [masterDateISO, setMasterDateISO] = useState("");
  const [masterTitle, setMasterTitle] = useState("");
  const [masterCategories, setMasterCategories] = useState<string[]>([]);
  const [masterTime, setMasterTime] = useState("");
  const [masterDetails, setMasterDetails] = useState("");
  const [masterPreRoutineIds, setMasterPreRoutineIds] = useState<string[]>([]);
  const [masterPostRoutineIds, setMasterPostRoutineIds] = useState<string[]>([]);
  const [applySession, setApplySession] = useState(false);
  const [applyDate, setApplyDate] = useState(false);
  const [applyTitle, setApplyTitle] = useState(false);
  const [applyCategory, setApplyCategory] = useState(false);
  const [applyTime, setApplyTime] = useState(false);
  const [applyDetails, setApplyDetails] = useState(false);
  const [applyPreRoutines, setApplyPreRoutines] = useState(false);
  const [applyPostRoutines, setApplyPostRoutines] = useState(false);

  const [groupSyncOpen, setGroupSyncOpen] = useState(false);
  const [lastSyncedDateISO, setLastSyncedDateISO] = useState<string | null>(null);
  const [currentGroupNumber, setCurrentGroupNumber] = useState<number>(1);

  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [pickerMonth, setPickerMonth] = useState<Date>(() => monthStart(new Date()));
  const [categoryPickerRowId, setCategoryPickerRowId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const inputRefs = useRef<Record<string, TextInput | null>>({});
  const gridInputRefs = useRef<Record<string, TextInput | null>>({});
  const [activeInputKey, setActiveInputKey] = useState<string | null>(null);
  const pasteHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedSignatureByIdRef = useRef<Record<string, string>>({});
  const missingRosterNameIdsRef = useRef<Set<string>>(new Set());

  const [dirty, setDirty] = useState(false);

  function clearCopied() {
    setCopied(null);
    setCopiedFromRowId(null);
  }

  // Load roster + batch from cloud
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const teamId = await getCurrentTeamId();
        const nameMap = await loadRosterNameMapForTeam(teamId);

        const [cloudBatch, storedCategories, routines] = await Promise.all([
          listTeamWorkoutsByBatch(String(batchId ?? "")),
          loadCoachSettings(),
          loadAuxiliaryRoutines(),
        ]);

        const sorted = [...cloudBatch].sort((a, b) => {
          const an = String(nameMap.get(String(a.athlete_profile_id ?? "").trim()) ?? (a as any).athlete_name ?? "");
          const bn = String(nameMap.get(String(b.athlete_profile_id ?? "").trim()) ?? (b as any).athlete_name ?? "");
          return compareAthleteDisplayNamesByLastName(an, bn);
        });

        if (!mounted) return;
        const nextRows = sorted.map((w) =>
          rowFromCloud(w, nameMap, (athleteProfileId) => {
            if (missingRosterNameIdsRef.current.has(athleteProfileId)) return;
            missingRosterNameIdsRef.current.add(athleteProfileId);
            console.log("[batch editor] missing roster name for athlete_profile_id", athleteProfileId);
          })
        );
        setRows(nextRows);
        savedSignatureByIdRef.current = Object.fromEntries(
          nextRows.map((row) => [row.id, JSON.stringify(toCloudPatch(row))] as const)
        );
        setCategories(getCategoryOptions(storedCategories));
        setAuxiliaryRoutines(routines);
        setLoading(false);
        setDirty(false);
        setSaveStatus("idle");
        setSaveErrorText("");
      } catch (e: any) {
        if (!mounted) return;
        setLoading(false);
        Alert.alert("Load failed", e?.message ?? "Could not load batch from cloud.");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [batchId]);

  const folderTitle = useMemo(() => {
    return rows[0]?.title?.trim() || "Workout";
  }, [rows]);

  const scopedGroupNumber = useMemo(() => {
    const raw = String(group ?? "").trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }, [group]);

  useEffect(() => {
    if (scopedGroupNumber == null) return;
    setCurrentGroupNumber(scopedGroupNumber);
  }, [scopedGroupNumber]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const groupDiff = groupNumberToInt(a.groupNumber) - groupNumberToInt(b.groupNumber);
      if (groupDiff !== 0) return groupDiff;
      const aParts = splitName(String(a.athleteName ?? ""));
      const bParts = splitName(String(b.athleteName ?? ""));
      const lastDiff = aParts.lastName.localeCompare(bParts.lastName);
      if (lastDiff !== 0) return lastDiff;
      const firstDiff = aParts.firstName.localeCompare(bParts.firstName);
      if (firstDiff !== 0) return firstDiff;
      return String(a.athleteName ?? "").localeCompare(String(b.athleteName ?? ""));
    });
  }, [rows]);

  const groupNumbers = useMemo(() => {
    return Array.from(new Set(sortedRows.map((row) => groupNumberToInt(row.groupNumber)))).sort((a, b) => a - b);
  }, [sortedRows]);

  const visibleRows = useMemo(() => {
    if (scopedGroupNumber == null) return sortedRows;
    return sortedRows.filter((row) => groupNumberToInt(row.groupNumber) === currentGroupNumber);
  }, [sortedRows, scopedGroupNumber, currentGroupNumber]);

  const isMasterListView = scopedGroupNumber == null;

  useEffect(() => {
    if (scopedGroupNumber == null) return;
    if (groupNumbers.length === 0) return;
    if (groupNumbers.includes(currentGroupNumber)) return;
    setCurrentGroupNumber(groupNumbers[0]);
  }, [groupNumbers, currentGroupNumber, scopedGroupNumber]);

  useEffect(() => {
    if (visibleRows.length === 0) return;
    const sample = visibleRows[0];
    setMasterSession(sample.session ?? "AM");
    setMasterDateISO(String(sample.dateISO ?? ""));
    setMasterTitle(sample.title ?? "");
    setMasterCategories(Array.isArray(sample.categories) && sample.categories.length > 0 ? sample.categories : ["Other"]);
    setMasterTime(sample.time ?? "");
    setMasterDetails(sample.details ?? "");
    setMasterPreRoutineIds(normalizeRoutineIds(sample.preRoutineIds));
    setMasterPostRoutineIds(normalizeRoutineIds(sample.postRoutineIds));
    setApplySession(false);
    setApplyDate(false);
    setApplyTitle(false);
    setApplyCategory(false);
    setApplyTime(false);
    setApplyDetails(false);
    setApplyPreRoutines(false);
    setApplyPostRoutines(false);
    // NOTE: don’t change dirty here
  }, [currentGroupNumber, scopedGroupNumber, visibleRows]);

  function updateRow(id: string, patch: Partial<EditableWorkout>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setDirty(true);
  }

  function assignGroups(groups: EditableWorkout[][]) {
    const byId: Record<string, string> = {};
    groups.forEach((grp, idx) => {
      const label = String(idx + 1);
      grp.forEach((item) => {
        byId[item.id] = label;
      });
    });
    setRows((prev) => prev.map((row) => ({ ...row, groupNumber: byId[row.id] ?? row.groupNumber })));
    setDirty(true);
  }

  function applyMasterToAll() {
    if (visibleRows.length === 0) return;
    if (
      !applySession &&
      !applyDate &&
      !applyTitle &&
      !applyCategory &&
      !applyTime &&
      !applyDetails &&
      !applyPreRoutines &&
      !applyPostRoutines
    ) {
      Alert.alert("Nothing selected", "Change one or more group fields first.");
      return;
    }
    if (applyDate && !isISODateOnly(String(masterDateISO ?? "").trim())) {
      Alert.alert("Invalid date", "Use YYYY-MM-DD for date.");
      return;
    }

    const visibleIdSet = new Set(visibleRows.map((row) => row.id));
    setRows((prev) =>
      prev.map((row) => {
        if (!visibleIdSet.has(row.id)) return row;
        return {
          ...row,
          ...(applySession && masterSession ? { session: masterSession } : null),
          ...(applyDate ? { dateISO: masterDateISO.trim() } : null),
          ...(applyTitle ? { title: masterTitle } : null),
          ...(applyCategory
            ? {
                categories: masterCategories.length > 0 ? masterCategories : ["Other"],
                category: masterCategories.length > 0 ? masterCategories[0] : "Other",
              }
            : null),
          ...(applyTime ? { time: masterTime } : null),
          ...(applyDetails ? { details: masterDetails } : null),
          ...(applyPreRoutines ? { preRoutineIds: [...masterPreRoutineIds] } : null),
          ...(applyPostRoutines ? { postRoutineIds: [...masterPostRoutineIds] } : null),
        };
      })
    );

    setDirty(true);
    if (applyDate) setLastSyncedDateISO(masterDateISO.trim());

    Alert.alert("Group sync applied", `Selected fields were synced to ${visibleRows.length} workout(s).`);
  }

  async function saveMasterAsTemplate() {
    await createWorkoutTemplateFromSource({
      title: String(masterTitle ?? "").trim() || "Workout",
      details: String(masterDetails ?? "").trim(),
      categories: masterCategories,
      primary_category: masterCategories[0] ?? null,
      session: masterSession,
    });
    Alert.alert("Saved", "Template added to Saved Workouts.");
  }

  function moveGroup(delta: -1 | 1) {
    if (groupNumbers.length === 0) return;
    const idx = groupNumbers.findIndex((n) => n === currentGroupNumber);
    const currentIdx = idx >= 0 ? idx : 0;
    const nextIdx = Math.max(0, Math.min(groupNumbers.length - 1, currentIdx + delta));
    const next = groupNumbers[nextIdx];
    if (next === currentGroupNumber) return;
    setCurrentGroupNumber(next);
      router.replace({
        pathname: "/(coach)/workout-batch/[batchId]",
        params: {
          batchId: String(batchId),
          group: String(next),
          returnTo: String(returnTo ?? ""),
          returnDate: String(returnDate ?? ""),
          returnDateISO: String(returnDateISO ?? ""),
        },
      });
  }

  const orderedInputKeys = useMemo(() => {
    const keys: string[] = ["master-title", "master-time", "master-details"];
    for (const row of visibleRows) keys.push(`${row.id}-title`, `${row.id}-time`, `${row.id}-details`);
    return keys;
  }, [visibleRows]);

  function focusByOffset(delta: -1 | 1) {
    if (!activeInputKey) return;
    const idx = orderedInputKeys.indexOf(activeInputKey);
    if (idx < 0) return;
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= orderedInputKeys.length) return;
    const nextKey = orderedInputKeys[nextIdx];
    inputRefs.current[nextKey]?.focus?.();
  }

  function dismissKeyboard() {
    Keyboard.dismiss();
    setActiveInputKey(null);
  }

  useEffect(() => {
    return () => {
      if (pasteHighlightTimerRef.current) clearTimeout(pasteHighlightTimerRef.current);
      if (debouncedSaveTimerRef.current) clearTimeout(debouncedSaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (loading || !dirty) return;
    if (debouncedSaveTimerRef.current) clearTimeout(debouncedSaveTimerRef.current);
    debouncedSaveTimerRef.current = setTimeout(() => {
      void saveAllChanges({ silent: true });
    }, 700);
    return () => {
      if (debouncedSaveTimerRef.current) {
        clearTimeout(debouncedSaveTimerRef.current);
        debouncedSaveTimerRef.current = null;
      }
    };
  }, [dirty, loading, rows]);

  async function saveAllChanges(opts?: { silent?: boolean }): Promise<boolean> {
    const silent = !!opts?.silent;
    if (!dirty) {
      setSaveStatus("saved");
      return true;
    }

    // Basic validation
    for (const r of rows) {
      if (!isISODateOnly(String(r.dateISO ?? "").trim())) {
        Alert.alert("Invalid date", `Fix date for ${r.athleteName}: use YYYY-MM-DD.`);
        return false;
      }
    }

    const changedRows = rows.filter((row) => {
      const nextSig = JSON.stringify(toCloudPatch(row));
      const prevSig = savedSignatureByIdRef.current[row.id];
      return nextSig !== prevSig;
    });

    if (changedRows.length === 0) {
      setDirty(false);
      setSaveStatus("saved");
      return true;
    }

    setSaving(true);
    setSaveStatus("saving");
    setSaveErrorText("");
    try {
      await bulkUpdateTeamWorkouts(
        changedRows.map((r) => ({
          id: r.id,
          patch: toCloudPatch(r),
        }))
      );
      for (const row of changedRows) {
        savedSignatureByIdRef.current[row.id] = JSON.stringify(toCloudPatch(row));
      }
      setDirty(false);
      setSaving(false);
      setSaveStatus("saved");
      return true;
    } catch (e: any) {
      setSaving(false);
      setSaveStatus("error");
      setSaveErrorText(e?.message ?? "Could not save updates to cloud.");
      if (!silent) Alert.alert("Save failed", e?.message ?? "Could not save updates to cloud.");
      return false;
    }
  }

  function finishAndReturn() {
    const fallbackRowDate = String(rows[0]?.dateISO ?? "");
    const effectiveDate = isISODateOnly(String(lastSyncedDateISO ?? ""))
      ? String(lastSyncedDateISO)
      : isISODateOnly(String(returnDate ?? ""))
      ? String(returnDate)
      : fallbackRowDate;

    const target = String(returnTo ?? "").trim();
    if (target === "workouts") {
      router.replace({ pathname: "/(coach)/workouts", params: { date: effectiveDate, saved: "1" } });
      return;
    }
    if (target === "calendar") {
      router.replace({ pathname: "/(coach)/(tabs)/calendar", params: { saved: "1" } });
      return;
    }
    if (target === "planner") {
      router.replace({ pathname: "/(coach)/(tabs)/planner", params: { date: effectiveDate, saved: "1" } });
      return;
    }
    router.replace({ pathname: "/(coach)/(tabs)/calendar", params: { saved: "1" } });
  }

  async function onTapDone() {
    dismissKeyboard();
    if (debouncedSaveTimerRef.current) {
      clearTimeout(debouncedSaveTimerRef.current);
      debouncedSaveTimerRef.current = null;
    }
    const ok = await saveAllChanges();
    if (ok) finishAndReturn();
  }

  function finishAfterDelete() {
    const fallbackRowDate = String(rows[0]?.dateISO ?? "");
    const effectiveDate = isISODateOnly(String(returnDateISO ?? ""))
      ? String(returnDateISO)
      : isISODateOnly(String(returnDate ?? ""))
      ? String(returnDate)
      : fallbackRowDate;
    const target = String(returnTo ?? "").trim();

    if (target === "workouts") {
      router.replace({
        pathname: "/(coach)/workouts",
        params: { date: effectiveDate, refresh: Date.now().toString(), deleted: "1" },
      });
      return;
    }
    if (target === "planner") {
      router.replace({
        pathname: "/(coach)/(tabs)/planner",
        params: { date: effectiveDate, refresh: Date.now().toString(), deleted: "1" },
      });
      return;
    }
    if (target === "calendar") {
      router.replace({
        pathname: "/(coach)/(tabs)/calendar",
        params: { date: effectiveDate, refresh: Date.now().toString(), deleted: "1" },
      });
      return;
    }

    if (target) {
      router.replace({
        pathname: target as any,
        params: { date: effectiveDate, refresh: Date.now().toString(), deleted: "1" },
      });
      return;
    }
    router.back();
  }

  async function runDeleteBatch() {
    const cleanBatchId = String(batchId ?? "").trim();
    if (!cleanBatchId) return;
    // Close prompt immediately so it does not appear to loop on failure.
    setDeleteConfirmOpen(false);
    console.log("Delete batch start", cleanBatchId);
    try {
      setDeletingBatch(true);
      const deletedCount = await deleteWorkoutBatch(cleanBatchId);
      console.log("Delete batch deleted rows", deletedCount);
      // Hard proof: verify batch rows are gone before navigating.
      const remaining = await listTeamWorkoutsByBatch(cleanBatchId);
      if (remaining.length > 0) throw new Error("Delete returned but batch still exists");
      setRows([]);
      finishAfterDelete();
    } catch (e: any) {
      const message = String(e?.message ?? "Could not delete workout batch.");
      const details = String(e?.details ?? "").trim();
      const hint = String(e?.hint ?? "").trim();
      const full = [message, details, hint].filter(Boolean).join("\n");
      console.log("[batch editor] delete failed", {
        batchId: cleanBatchId,
        message,
        details,
        hint,
        raw: e,
      });
      Alert.alert("Delete failed", full || "Could not delete workout batch.");
    } finally {
      setDeletingBatch(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Text>Loading...</Text>
      </View>
    );
  }

  if (!batchId || rows.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={{ fontWeight: "800", marginBottom: 10 }}>Batch not found</Text>
        <Pressable style={styles.primaryBtn} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (useSharedGridLayout) {
    const categoryNames = categories.map((c) => String(c.name ?? "").trim()).filter(Boolean);
    const statusText =
      saveStatus === "saving"
        ? "Saving..."
        : saveStatus === "saved"
        ? "Saved"
        : saveStatus === "error"
        ? `Save error${saveErrorText ? `: ${saveErrorText}` : ""}`
        : dirty
        ? "Unsaved changes"
        : "Ready";

    const focusGridCell = (rowIdx: number, field: string) => {
      const key = `grid-${rowIdx}-${field}`;
      gridInputRefs.current[key]?.focus?.();
    };

    const handleGridKeyDown = (e: any, rowIdx: number, field: string) => {
      const key = String(e?.nativeEvent?.key ?? e?.key ?? "");
      if (key !== "Enter") return;
      e?.preventDefault?.();
      e?.stopPropagation?.();
      const nextIdx = Math.min(visibleRows.length - 1, rowIdx + 1);
      if (nextIdx === rowIdx) return;
      setTimeout(() => focusGridCell(nextIdx, field), 0);
    };

    return (
      <>
        <Stack.Screen options={{ title: "Edit Individual Workouts" }} />
        <View style={[styles.container, { paddingTop: 10 }]}>
          <View style={{ marginBottom: 8 }}>
            <Text style={styles.title}>{folderTitle}</Text>
            <Text style={styles.subtitle}>
              {rows.length} athletes • {statusText}
            </Text>
          </View>

          <View style={[styles.card, { marginTop: 0, marginBottom: 8, paddingVertical: 10 }]}>
            <Text style={styles.cardTitle}>Batch Actions</Text>
            <Text style={styles.hint}>
              Delete workout batch and all athlete workouts in this batch.
            </Text>
            <Pressable
              onPress={() => setDeleteConfirmOpen(true)}
              disabled={deletingBatch}
              style={[styles.ghostBtn, { borderColor: "#f0b9b9", backgroundColor: "#fff5f5", opacity: deletingBatch ? 0.6 : 1 }]}
            >
              <Text style={[styles.ghostBtnText, { color: "#b00020" }]}>{deletingBatch ? "Deleting..." : "Delete All"}</Text>
            </Pressable>
          </View>

          <CoachGridLayout
            minWidth={1320}
            columns={[
              { key: "athlete", label: "Athlete", width: 180 },
              { key: "session", label: "Session", width: 82 },
              { key: "category", label: "Category", width: 150 },
              { key: "distance", label: "Distance", width: 110 },
              { key: "time", label: "Time/Pace", width: 120 },
              { key: "title", label: "Title", width: 200 },
              { key: "notes", label: "Notes", width: 360 },
              { key: "group", label: "Group", width: 70 },
            ]}
          >
            {visibleRows.map((row, rowIdx) => (
              <View
                key={`grid-row-${row.id}`}
                style={{
                  flexDirection: "row",
                  borderWidth: 1,
                  borderTopWidth: 0,
                  borderColor: "#e1e6ee",
                  backgroundColor: rowIdx % 2 === 0 ? "#fff" : "#fbfcff",
                  minHeight: 36,
                }}
              >
                <View style={{ width: 180, borderRightWidth: 1, borderRightColor: "#edf1f6", justifyContent: "center", paddingHorizontal: 8 }}>
                  <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "800", color: "#1c2533" }}>
                    {row.athleteName}
                  </Text>
                </View>

                <View style={{ width: 82, borderRightWidth: 1, borderRightColor: "#edf1f6", flexDirection: "row" }}>
                  {(["AM", "PM"] as const).map((value) => (
                    <Pressable
                      key={`${row.id}-s-${value}`}
                      onPress={() => updateRow(row.id, { session: value })}
                      style={{
                        flex: 1,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: row.session === value ? "#101317" : "transparent",
                      }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: "900", color: row.session === value ? "#fff" : "#53627a" }}>{value}</Text>
                    </Pressable>
                  ))}
                </View>

                <Pressable
                  style={{ width: 150, borderRightWidth: 1, borderRightColor: "#edf1f6", justifyContent: "center", paddingHorizontal: 8 }}
                  onPress={() => setCategoryPickerRowId(row.id)}
                >
                  <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "700", color: "#2a374a" }}>
                    {row.category || "Other"} ▾
                  </Text>
                </Pressable>

                <TextInput
                  ref={(r) => {
                    gridInputRefs.current[`grid-${rowIdx}-plannedDistanceText`] = r;
                  }}
                  value={row.plannedDistanceText}
                  onChangeText={(t) => updateRow(row.id, { plannedDistanceText: t })}
                  onKeyPress={(e) => handleGridKeyDown(e, rowIdx, "plannedDistanceText")}
                  style={{ width: 110, borderRightWidth: 1, borderRightColor: "#edf1f6", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "700" }}
                  placeholder="mi/km"
                />

                <TextInput
                  ref={(r) => {
                    gridInputRefs.current[`grid-${rowIdx}-time`] = r;
                  }}
                  value={row.time}
                  onChangeText={(t) => updateRow(row.id, { time: t })}
                  onKeyPress={(e) => handleGridKeyDown(e, rowIdx, "time")}
                  style={{ width: 120, borderRightWidth: 1, borderRightColor: "#edf1f6", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "700" }}
                  placeholder="e.g. 6:20/mi"
                />

                <TextInput
                  ref={(r) => {
                    gridInputRefs.current[`grid-${rowIdx}-title`] = r;
                  }}
                  value={row.title}
                  onChangeText={(t) => updateRow(row.id, { title: t })}
                  onKeyPress={(e) => handleGridKeyDown(e, rowIdx, "title")}
                  style={{ width: 200, borderRightWidth: 1, borderRightColor: "#edf1f6", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "700" }}
                />

                <TextInput
                  ref={(r) => {
                    gridInputRefs.current[`grid-${rowIdx}-details`] = r;
                  }}
                  value={row.details}
                  onChangeText={(t) => updateRow(row.id, { details: t })}
                  onKeyPress={(e) => handleGridKeyDown(e, rowIdx, "details")}
                  style={{ width: 360, borderRightWidth: 1, borderRightColor: "#edf1f6", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "600" }}
                />

                <TextInput
                  ref={(r) => {
                    gridInputRefs.current[`grid-${rowIdx}-groupNumber`] = r;
                  }}
                  value={normalizeGroupNumber(row.groupNumber)}
                  onChangeText={(t) => updateRow(row.id, { groupNumber: normalizeGroupNumber(t) })}
                  onKeyPress={(e) => handleGridKeyDown(e, rowIdx, "groupNumber")}
                  style={{ width: 70, paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, fontWeight: "700" }}
                />
              </View>
            ))}
          </CoachGridLayout>
        </View>

        <Pressable onPress={onTapDone} style={styles.floatingSaveBtn} disabled={saving}>
          <Ionicons name="checkmark" size={24} color="#fff" />
        </Pressable>

        <Modal visible={!!categoryPickerRowId} transparent animationType="fade" onRequestClose={() => setCategoryPickerRowId(null)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setCategoryPickerRowId(null)}>
            <Pressable style={[styles.dateModalCard, { maxWidth: 340 }]} onPress={(e) => e.stopPropagation()}>
              <Text style={[styles.cardTitle, { marginBottom: 8 }]}>Select Category</Text>
              <ScrollView style={{ maxHeight: 260 }}>
                {categoryNames.map((name) => (
                  <Pressable
                    key={`cat-pick-${name}`}
                    onPress={() => {
                      if (!categoryPickerRowId) return;
                      updateRow(categoryPickerRowId, { category: name, categories: [name] });
                      setCategoryPickerRowId(null);
                    }}
                    style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#eef2f7" }}
                  >
                    <Text style={{ fontWeight: "800", color: "#111" }}>{name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal visible={deleteConfirmOpen} transparent animationType="fade" onRequestClose={() => setDeleteConfirmOpen(false)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setDeleteConfirmOpen(false)}>
            <Pressable style={[styles.dateModalCard, { maxWidth: 460 }]} onPress={(e) => e.stopPropagation()}>
              <Text style={[styles.cardTitle, { marginBottom: 8 }]}>Delete workout batch?</Text>
              <Text style={{ color: "#333", fontWeight: "700", marginBottom: 12 }}>
                This will delete the workout batch and all athlete workouts inside it. This can’t be undone.
              </Text>
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                <Pressable style={styles.dateActionBtn} onPress={() => setDeleteConfirmOpen(false)} disabled={deletingBatch}>
                  <Text style={styles.dateActionBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[styles.dateActionBtn, { borderColor: "#f0b9b9", backgroundColor: "#fff0f0" }]}
                  onPress={runDeleteBatch}
                  disabled={deletingBatch}
                >
                  <Text style={[styles.dateActionBtnText, { color: "#b00020" }]}>{deletingBatch ? "Deleting..." : "Delete"}</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Edit Individual Workouts" }} />
      <TouchableWithoutFeedback onPress={dismissKeyboard} accessible={false}>
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            ref={scrollRef}
            automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
            contentContainerStyle={{ paddingBottom: 28 }}
            onScrollBeginDrag={dismissKeyboard}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.title}>{folderTitle}</Text>

            <Text style={styles.subtitle}>
              {rows.length} athletes{dirty ? " • Unsaved changes" : ""}{saving ? " • Saving..." : ""}
            </Text>

            {scopedGroupNumber != null ? (
              <View style={styles.groupNavRow}>
                <Pressable
                  onPress={() => moveGroup(-1)}
                  style={[styles.groupNavBtn, groupNumbers.length <= 1 && styles.groupNavBtnDisabled]}
                  disabled={groupNumbers.length <= 1}
                >
                  <Text style={styles.groupNavBtnText}>◀</Text>
                </Pressable>
                <Text style={styles.scopeText}>Editing Group {currentGroupNumber} only</Text>
                <Pressable
                  onPress={() => moveGroup(1)}
                  style={[styles.groupNavBtn, groupNumbers.length <= 1 && styles.groupNavBtnDisabled]}
                  disabled={groupNumbers.length <= 1}
                >
                  <Text style={styles.groupNavBtnText}>▶</Text>
                </Pressable>
              </View>
            ) : null}

            <View style={styles.card}>
              <Pressable
                onPress={() => setGroupSyncOpen((prev) => !prev)}
                hitSlop={10}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
              >
                <Text style={styles.cardTitle}>
                  {isMasterListView ? "Workout Sync (changed fields only)" : "Group Sync (changed fields only)"}
                </Text>
                <Text style={{ fontSize: 18, color: "#666", fontWeight: "900" }}>{groupSyncOpen ? "▾" : "▸"}</Text>
              </Pressable>
              <Text style={styles.hint}>
                {isMasterListView
                  ? "Tap to expand and sync selected fields across all workouts in this list."
                  : "Tap to expand and sync selected fields across this group."}
              </Text>

              {groupSyncOpen ? (
                <>
                  <View style={styles.row}>
                    <Pressable
                      onPress={() => {
                        setApplySession(true);
                        setMasterSession("AM");
                      }}
                      style={[styles.chip, applySession && masterSession === "AM" && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, applySession && masterSession === "AM" && styles.chipTextActive]}>
                        AM
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setApplySession(true);
                        setMasterSession("PM");
                      }}
                      style={[styles.chip, applySession && masterSession === "PM" && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, applySession && masterSession === "PM" && styles.chipTextActive]}>
                        PM
                      </Text>
                    </Pressable>
                  </View>

                  <TextInput
                    ref={(r) => {
                      inputRefs.current["master-title"] = r;
                    }}
                    onFocus={() => setActiveInputKey("master-title")}
                    inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
                    value={masterTitle}
                    onChangeText={(t) => {
                      setMasterTitle(t);
                      setApplyTitle(true);
                      setDirty(true);
                    }}
                    placeholder="Group title"
                    style={styles.input}
                  />

                  <Text style={styles.fieldLabel}>Category</Text>
                  <View style={styles.row}>
                    {categories.map((cat) => {
                      const active = applyCategory && masterCategories.includes(cat.name);
                      return (
                        <Pressable
                          key={`master-cat-${cat.id}`}
                          onPress={() => {
                            setMasterCategories((prev) =>
                              prev.includes(cat.name) ? prev.filter((n) => n !== cat.name) : [...prev, cat.name]
                            );
                            setApplyCategory(true);
                            setDirty(true);
                          }}
                          style={[
                            styles.chip,
                            active && styles.chipActive,
                            active && !!cat.color ? { borderColor: cat.color, backgroundColor: `${cat.color}22` } : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              active && styles.chipTextActive,
                              active && !!cat.color ? { color: "#111" } : null,
                            ]}
                          >
                            {cat.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Text style={styles.fieldLabel}>Pre-run routines</Text>
                  <View style={styles.row}>
                    {auxiliaryRoutines.map((routine) => {
                      const active = applyPreRoutines && masterPreRoutineIds.includes(routine.id);
                      return (
                        <Pressable
                          key={`master-pre-${routine.id}`}
                          onPress={() => {
                            setMasterPreRoutineIds((prev) =>
                              prev.includes(routine.id) ? prev.filter((id) => id !== routine.id) : [...prev, routine.id]
                            );
                            setApplyPreRoutines(true);
                            setDirty(true);
                          }}
                          style={[styles.chip, active && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>{routine.title}</Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Text style={styles.fieldLabel}>Post-run routines</Text>
                  <View style={styles.row}>
                    {auxiliaryRoutines.map((routine) => {
                      const active = applyPostRoutines && masterPostRoutineIds.includes(routine.id);
                      return (
                        <Pressable
                          key={`master-post-${routine.id}`}
                          onPress={() => {
                            setMasterPostRoutineIds((prev) =>
                              prev.includes(routine.id) ? prev.filter((id) => id !== routine.id) : [...prev, routine.id]
                            );
                            setApplyPostRoutines(true);
                            setDirty(true);
                          }}
                          style={[styles.chip, active && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>{routine.title}</Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Pressable
                    onPress={() => {
                      const base = isISODateOnly(masterDateISO) ? parseISODateOnly(masterDateISO) : new Date();
                      setPickerMonth(monthStart(base));
                      setDatePickerOpen(true);
                    }}
                    style={styles.datePickerBtn}
                  >
                    <Text style={styles.datePickerLabel}>Date</Text>
                    <Text style={styles.datePickerValue}>{formatDisplayDate(masterDateISO) || "Select date"}</Text>
                  </Pressable>

                  <TextInput
                    ref={(r) => {
                      inputRefs.current["master-time"] = r;
                    }}
                    onFocus={() => setActiveInputKey("master-time")}
                    inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
                    value={masterTime}
                    onChangeText={(t) => {
                      setMasterTime(t);
                      setApplyTime(true);
                      setDirty(true);
                    }}
                    placeholder="Group time"
                    style={styles.input}
                  />

                  <TextInput
                    ref={(r) => {
                      inputRefs.current["master-details"] = r;
                    }}
                    onFocus={() => setActiveInputKey("master-details")}
                    inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
                    value={masterDetails}
                    onChangeText={(t) => {
                      setMasterDetails(t);
                      setApplyDetails(true);
                      setDirty(true);
                    }}
                    placeholder="Group details"
                    style={[styles.input, { minHeight: 72, textAlignVertical: "top" }]}
                    multiline
                  />

                  <Pressable onPress={applyMasterToAll} style={styles.secondaryBtn}>
                    <Text style={styles.secondaryBtnText}>
                      {isMasterListView ? "Apply workout sync to all" : "Apply group sync to all"}
                    </Text>
                  </Pressable>
                  <Pressable onPress={saveMasterAsTemplate} style={styles.ghostBtn}>
                    <Text style={styles.ghostBtnText}>
                      {isMasterListView ? "Save Workout Sync As Template" : "Save Group Sync As Template"}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>

            {scopedGroupNumber == null ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Group tools</Text>
                <View style={styles.row}>
                  <Pressable style={styles.miniBtn} onPress={() => assignGroups(splitIntoPairs(rows))}>
                    <Text style={styles.miniBtnText}>Split pairs</Text>
                  </Pressable>
                  <Pressable style={styles.miniBtn} onPress={() => assignGroups(splitIntoKGroups(rows, 3))}>
                    <Text style={styles.miniBtnText}>Split 3 groups</Text>
                  </Pressable>
                  <Pressable
                    style={styles.miniBtn}
                    onPress={() => {
                      setRows((prev) => prev.map((r) => ({ ...r, groupNumber: "1" })));
                      setDirty(true);
                    }}
                  >
                    <Text style={styles.miniBtnText}>Clear groups</Text>
                  </Pressable>
                </View>

                <Pressable
                  style={[styles.miniBtn, { marginTop: 4 }]}
                  onPress={() =>
                    router.push({
                      pathname: "/(coach)/workout-batch/[batchId]/groups",
                      params: {
                        batchId: String(batchId),
                        returnTo: String(returnTo ?? ""),
                        returnDate: String(returnDate ?? ""),
                        returnDateISO: String(returnDateISO ?? ""),
                      },
                    })
                  }
                >
                  <Text style={styles.miniBtnText}>Open Group Sorting Page</Text>
                </Pressable>
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Individual workouts</Text>

              {visibleRows.map((row) => (
                <View
                  key={row.id}
                  style={[styles.rowCard, pasteHighlightRowId === row.id ? styles.rowCardPasted : null]}
                >
                  <View style={styles.rowTop}>
                    <Text style={styles.rowName}>{row.athleteName}</Text>

                    <View style={styles.rowTopActions}>
                      <Pressable
                        onPress={() => {
                          setCopied({
                            title: row.title ?? "",
                            details: row.details ?? "",
                            category: row.category ?? "",
                            categories: Array.isArray(row.categories) ? row.categories : undefined,
                            time: row.time ?? "",
                            session: row.session ?? "AM",
                            groupNumber: row.groupNumber,
                            preRoutineIds: normalizeRoutineIds(row.preRoutineIds),
                            postRoutineIds: normalizeRoutineIds(row.postRoutineIds),
                          });
                          setCopiedFromRowId(row.id);
                        }}
                        style={[styles.copyBtn, copiedFromRowId === row.id ? styles.copyBtnActive : null]}
                      >
                        <Text
                          style={[
                            styles.copyBtnText,
                            copiedFromRowId === row.id ? styles.copyBtnTextActive : null,
                          ]}
                        >
                          Copy
                        </Text>
                      </Pressable>

                      <Pressable
                        onPress={() => {
                          if (!copied) return;
                          updateRow(row.id, {
                            title: copied.title ?? row.title,
                            details: copied.details ?? row.details,
                            category: copied.category ?? row.category,
                            categories: copied.categories ?? row.categories,
                            time: copied.time ?? row.time,
                            session: copied.session ?? row.session,
                            groupNumber: copied.groupNumber ?? row.groupNumber,
                            preRoutineIds: normalizeRoutineIds(copied.preRoutineIds ?? row.preRoutineIds),
                            postRoutineIds: normalizeRoutineIds(copied.postRoutineIds ?? row.postRoutineIds),
                          });

                          setPasteHighlightRowId(row.id);
                          if (pasteHighlightTimerRef.current) clearTimeout(pasteHighlightTimerRef.current);
                          pasteHighlightTimerRef.current = setTimeout(() => {
                            setPasteHighlightRowId((cur) => (cur === row.id ? null : cur));
                            pasteHighlightTimerRef.current = null;
                          }, 500);
                        }}
                        style={[styles.copyBtn, !copied && { opacity: 0.5 }]}
                        disabled={!copied}
                      >
                        <Text style={styles.copyBtnText}>Paste</Text>
                      </Pressable>

                      <Pressable
                        onPress={async () => {
                          await createWorkoutTemplateFromSource({
                            title: String(row.title ?? "").trim() || "Workout",
                            details: String(row.details ?? "").trim(),
                            categories: Array.isArray(row.categories) ? row.categories : [],
                            primary_category: String(row.category ?? "").trim() || null,
                            session: row.session,
                          });
                          Alert.alert("Saved", "Template added to Saved Workouts.");
                        }}
                        style={styles.copyBtn}
                      >
                        <Text style={styles.copyBtnText}>Save</Text>
                      </Pressable>
                    </View>
                  </View>

                  <View style={styles.row}>
                    {(["AM", "PM"] as const).map((value) => (
                      <Pressable
                        key={value}
                        onPress={() => updateRow(row.id, { session: value })}
                        style={[styles.chip, row.session === value && styles.chipActive]}
                      >
                        <Text style={[styles.chipText, row.session === value && styles.chipTextActive]}>{value}</Text>
                      </Pressable>
                    ))}
                  </View>

                  <TextInput
                    ref={(r) => {
                      inputRefs.current[`${row.id}-title`] = r;
                    }}
                    onFocus={() => setActiveInputKey(`${row.id}-title`)}
                    inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
                    value={row.title ?? ""}
                    onChangeText={(t) => updateRow(row.id, { title: t })}
                    placeholder="Title"
                    style={styles.input}
                  />

                  <Text style={styles.fieldLabel}>Category</Text>
                  <View style={styles.row}>
                    {categories.map((cat) => {
                      const current =
                        Array.isArray(row.categories) && row.categories.length > 0
                          ? row.categories
                          : [String(row.category ?? "").trim() || "Other"];
                      const active = current.includes(cat.name);

                      return (
                        <Pressable
                          key={`${row.id}-cat-${cat.id}`}
                          onPress={() => {
                            const next = active
                              ? current.filter((name) => name !== cat.name)
                              : [...current, cat.name];
                            const normalized = next.length > 0 ? next : ["Other"];
                            updateRow(row.id, { categories: normalized, category: normalized[0] });
                          }}
                          style={[
                            styles.chip,
                            active && styles.chipActive,
                            active && !!cat.color ? { borderColor: cat.color, backgroundColor: `${cat.color}22` } : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              active && styles.chipTextActive,
                              active && !!cat.color ? { color: "#111" } : null,
                            ]}
                          >
                            {cat.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Text style={styles.fieldLabel}>Pre-run routines</Text>
                  <View style={styles.row}>
                    {auxiliaryRoutines.map((routine) => {
                      const selected = normalizeRoutineIds(row.preRoutineIds).includes(routine.id);
                      return (
                        <Pressable
                          key={`${row.id}-pre-${routine.id}`}
                          onPress={() => {
                            const next = selected
                              ? normalizeRoutineIds(row.preRoutineIds).filter((id) => id !== routine.id)
                              : [...normalizeRoutineIds(row.preRoutineIds), routine.id];
                            updateRow(row.id, { preRoutineIds: next });
                          }}
                          style={[styles.chip, selected && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, selected && styles.chipTextActive]}>{routine.title}</Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Text style={styles.fieldLabel}>Post-run routines</Text>
                  <View style={styles.row}>
                    {auxiliaryRoutines.map((routine) => {
                      const selected = normalizeRoutineIds(row.postRoutineIds).includes(routine.id);
                      return (
                        <Pressable
                          key={`${row.id}-post-${routine.id}`}
                          onPress={() => {
                            const next = selected
                              ? normalizeRoutineIds(row.postRoutineIds).filter((id) => id !== routine.id)
                              : [...normalizeRoutineIds(row.postRoutineIds), routine.id];
                            updateRow(row.id, { postRoutineIds: next });
                          }}
                          style={[styles.chip, selected && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, selected && styles.chipTextActive]}>{routine.title}</Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <TextInput
                    ref={(r) => {
                      inputRefs.current[`${row.id}-time`] = r;
                    }}
                    onFocus={() => setActiveInputKey(`${row.id}-time`)}
                    inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
                    value={row.time ?? ""}
                    onChangeText={(t) => updateRow(row.id, { time: t })}
                    placeholder="Time"
                    style={styles.input}
                  />

                  <View style={styles.groupStepper}>
                    <Text style={styles.groupLabel}>Group</Text>
                    <View style={styles.groupStepperControls}>
                      <Pressable
                        onPress={() => {
                          const current = groupNumberToInt(row.groupNumber);
                          updateRow(row.id, { groupNumber: String(Math.max(1, current - 1)) });
                        }}
                        style={styles.groupStepperBtn}
                      >
                        <Text style={styles.groupStepperBtnText}>−</Text>
                      </Pressable>

                      <View style={styles.groupStepperValueWrap}>
                        <Text style={styles.groupStepperValue}>{normalizeGroupNumber(row.groupNumber)}</Text>
                      </View>

                      <Pressable
                        onPress={() => {
                          const current = groupNumberToInt(row.groupNumber);
                          updateRow(row.id, { groupNumber: String(current + 1) });
                        }}
                        style={styles.groupStepperBtn}
                      >
                        <Text style={styles.groupStepperBtnText}>+</Text>
                      </Pressable>
                    </View>
                  </View>

                  <TextInput
                    ref={(r) => {
                      inputRefs.current[`${row.id}-details`] = r;
                    }}
                    onFocus={() => setActiveInputKey(`${row.id}-details`)}
                    inputAccessoryViewID={Platform.OS === "ios" ? IOS_ACCESSORY_ID : undefined}
                    value={row.details ?? ""}
                    onChangeText={(t) => updateRow(row.id, { details: t })}
                    placeholder="Details"
                    style={[styles.input, { minHeight: 72, textAlignVertical: "top" }]}
                    multiline
                  />
                </View>
              ))}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </TouchableWithoutFeedback>

      <Pressable onPress={onTapDone} style={styles.floatingSaveBtn} disabled={saving}>
        <Ionicons name="checkmark" size={24} color="#fff" />
      </Pressable>

      {copied ? (
        <Pressable onPress={clearCopied} style={styles.doneCopyBtn}>
          <Text style={styles.doneCopyBtnText}>Done Copy</Text>
        </Pressable>
      ) : null}

      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={IOS_ACCESSORY_ID}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderTopWidth: 1,
              borderTopColor: "#e5e5e5",
              backgroundColor: "#f8f8f8",
            }}
          >
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable onPress={() => focusByOffset(-1)} style={{ paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontWeight: "800", color: "#111" }}>↑</Text>
              </Pressable>
              <Pressable onPress={() => focusByOffset(1)} style={{ paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontWeight: "800", color: "#111" }}>↓</Text>
              </Pressable>
            </View>
            <Pressable onPress={dismissKeyboard} style={{ paddingVertical: 6, paddingHorizontal: 10 }}>
              <Text style={{ fontWeight: "900", color: "#111" }}>Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}

      <Modal visible={datePickerOpen} transparent animationType="fade" onRequestClose={() => setDatePickerOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setDatePickerOpen(false)}>
          <Pressable style={styles.dateModalCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.dateModalHeader}>
              <Pressable onPress={() => setPickerMonth((prev) => addMonths(prev, -1))} style={styles.dateNavBtn}>
                <Text style={styles.dateNavBtnText}>‹</Text>
              </Pressable>
              <Text style={styles.dateModalTitle}>
                {pickerMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
              </Text>
              <Pressable onPress={() => setPickerMonth((prev) => addMonths(prev, 1))} style={styles.dateNavBtn}>
                <Text style={styles.dateNavBtnText}>›</Text>
              </Pressable>
            </View>

            <View style={styles.dateGridHeader}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, idx) => (
                <Text key={`wk-${idx}`} style={styles.dateGridHeaderText}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={styles.dateGrid}>
              {buildMonthGrid(pickerMonth).map((cell) => {
                const active = cell.dateISO === masterDateISO;
                return (
                  <Pressable
                    key={`cell-${cell.dateISO}`}
                    onPress={() => {
                      setMasterDateISO(cell.dateISO);
                      setApplyDate(true);
                      setDirty(true);
                      setDatePickerOpen(false);
                    }}
                    style={[
                      styles.dateCell,
                      !cell.inMonth && styles.dateCellOutsideMonth,
                      active && styles.dateCellActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.dateCellText,
                        !cell.inMonth && styles.dateCellTextOutside,
                        active && styles.dateCellTextActive,
                      ]}
                    >
                      {cell.dayNumber}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.dateModalActions}>
              <Pressable
                style={styles.dateActionBtn}
                onPress={() => {
                  const today = isoDateOnly(new Date());
                  setMasterDateISO(today);
                  setApplyDate(true);
                  setDirty(true);
                  setPickerMonth(monthStart(new Date()));
                  setDatePickerOpen(false);
                }}
              >
                <Text style={styles.dateActionBtnText}>Today</Text>
              </Pressable>
              <Pressable style={styles.dateActionBtn} onPress={() => setDatePickerOpen(false)}>
                <Text style={styles.dateActionBtnText}>Close</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", paddingHorizontal: 16, paddingTop: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  title: { fontSize: 22, fontWeight: "900", color: "#111" },
  subtitle: { marginTop: 4, marginBottom: 10, color: "#666", fontWeight: "700" },
  groupNavRow: { marginTop: -2, marginBottom: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  groupNavBtn: { width: 30, height: 30, borderRadius: 999, borderWidth: 1, borderColor: "#cfd8e3", backgroundColor: "#f5f8ff", alignItems: "center", justifyContent: "center" },
  groupNavBtnDisabled: { opacity: 0.45 },
  groupNavBtnText: { color: "#1f6feb", fontWeight: "900" },
  scopeText: { color: "#1f6feb", fontWeight: "800", fontSize: 12 },
  card: { marginTop: 10, borderWidth: 1, borderColor: "#e8e8e8", borderRadius: 14, padding: 12, backgroundColor: "#fafafa" },
  cardTitle: { fontSize: 15, fontWeight: "900", color: "#111" },
  hint: { marginTop: 4, marginBottom: 8, color: "#666", fontSize: 12, fontWeight: "700" },
  fieldLabel: { marginBottom: 6, color: "#555", fontSize: 12, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" },
  chip: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "#fff" },
  chipActive: { borderColor: "#111", backgroundColor: "#111" },
  chipText: { fontWeight: "800", color: "#333" },
  chipTextActive: { color: "#fff" },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, backgroundColor: "#fff", paddingHorizontal: 10, paddingVertical: 10, marginBottom: 8, fontWeight: "700", color: "#111" },
  datePickerBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, backgroundColor: "#fff", paddingHorizontal: 10, paddingVertical: 10, marginBottom: 8 },
  datePickerLabel: { fontSize: 12, fontWeight: "800", color: "#666", marginBottom: 2 },
  datePickerValue: { fontWeight: "800", color: "#111" },
  miniBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "#fff" },
  miniBtnText: { fontWeight: "800", color: "#111" },
  secondaryBtn: { marginTop: 4, borderWidth: 1, borderColor: "#111", borderRadius: 10, paddingVertical: 10, alignItems: "center", backgroundColor: "#111" },
  secondaryBtnText: { color: "#fff", fontWeight: "800" },
  ghostBtn: { marginTop: 8, borderWidth: 1, borderColor: "#ddd", borderRadius: 10, paddingVertical: 10, alignItems: "center", backgroundColor: "#fff" },
  ghostBtnText: { color: "#111", fontWeight: "800" },
  rowCard: { marginTop: 10, borderWidth: 1, borderColor: "#ececec", borderRadius: 12, padding: 10, backgroundColor: "#fff" },
  rowCardPasted: { borderColor: "#111", backgroundColor: "#11111112" },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  rowTopActions: { flexDirection: "row", gap: 8 },
  rowName: { fontWeight: "900", color: "#111", flex: 1, marginRight: 8 },
  copyBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#fafafa" },
  copyBtnActive: { borderColor: "#111", backgroundColor: "#111" },
  copyBtnText: { fontWeight: "800", color: "#111" },
  copyBtnTextActive: { color: "#fff" },
  groupStepper: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, backgroundColor: "#fff", paddingHorizontal: 10, paddingVertical: 10, marginBottom: 8 },
  groupLabel: { fontWeight: "800", color: "#666", fontSize: 12, marginBottom: 8 },
  groupStepperControls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  groupStepperBtn: { width: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fafafa", alignItems: "center", justifyContent: "center" },
  groupStepperBtnText: { fontSize: 22, fontWeight: "900", color: "#111", lineHeight: 22 },
  groupStepperValueWrap: { minWidth: 64, borderWidth: 1, borderColor: "#eee", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, alignItems: "center", backgroundColor: "#fff" },
  groupStepperValue: { fontSize: 18, fontWeight: "900", color: "#111" },
  primaryBtn: { marginTop: 14, borderWidth: 1, borderColor: "#111", borderRadius: 12, backgroundColor: "#111", paddingVertical: 12, alignItems: "center" },
  primaryBtnText: { color: "#fff", fontWeight: "900" },
  floatingSaveBtn: { position: "absolute", right: 18, bottom: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: "#1f9d50", borderWidth: 1, borderColor: "#178342", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.22, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 5 },
  doneCopyBtn: { position: "absolute", left: 18, bottom: 20, borderWidth: 1, borderColor: "#111", borderRadius: 12, backgroundColor: "#111", paddingHorizontal: 14, paddingVertical: 10, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  doneCopyBtnText: { color: "#fff", fontWeight: "900" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.28)", justifyContent: "center", alignItems: "center", padding: 18 },
  dateModalCard: { width: "100%", maxWidth: 420, borderRadius: 14, borderWidth: 1, borderColor: "#e5e5e5", backgroundColor: "#fff", padding: 12 },
  dateModalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  dateModalTitle: { fontWeight: "900", color: "#111", fontSize: 16 },
  dateNavBtn: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, borderColor: "#ddd", alignItems: "center", justifyContent: "center", backgroundColor: "#fafafa" },
  dateNavBtnText: { fontWeight: "900", color: "#111", fontSize: 18, lineHeight: 18 },
  dateGridHeader: { flexDirection: "row", marginBottom: 6 },
  dateGridHeaderText: { flex: 1, textAlign: "center", fontSize: 12, fontWeight: "800", color: "#666" },
  dateGrid: { flexDirection: "row", flexWrap: "wrap" },
  dateCell: { width: "14.2857%", aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  dateCellOutsideMonth: { opacity: 0.45 },
  dateCellActive: { backgroundColor: "#111" },
  dateCellText: { fontWeight: "800", color: "#111" },
  dateCellTextOutside: { color: "#777" },
  dateCellTextActive: { color: "#fff" },
  dateModalActions: { marginTop: 10, flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  dateActionBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#fafafa" },
  dateActionBtnText: { fontWeight: "800", color: "#111" },
});
