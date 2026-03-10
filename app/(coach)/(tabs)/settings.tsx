import React, { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../../../lib/supabase";
import { CategoriesContent } from "./categories";
import { formatPace, loadPaceSecondsPerMile, parsePace, savePaceSecondsPerMile } from "../../../lib/pace";
import { loadJSON, saveJSON } from "../../../lib/storage";
import { MILEAGE_PLANS_KEY, WEEK_START_KEY } from "../../../lib/mileagePlan";
import type { WeekStartDay, WorkoutCategory } from "../../../lib/types";
import {
  convertDistance,
  convertPaceSecondsPerUnit,
  distanceUnitLabel,
  paceUnitLongLabel,
  type DistanceUnit,
} from "../../../lib/units";
import { getSortableRoster, type TeamRosterAthlete } from "../../../lib/teamRoster";
import {
  createGroupId,
  loadCustomAthleteGroups,
  saveCustomAthleteGroups,
  type CustomAthleteGroup,
} from "../../../lib/customGroups";
import {
  loadAthletePaceOverrides,
  saveAthletePaceOverrides,
  type AthletePaceOverrides,
} from "../../../lib/athletePace";
import {
  emptyPracticeTimeDefaults,
  loadPracticeTimeDefaults,
  savePracticeTimeDefaults,
  type PracticeTimeDefaults,
} from "../../../lib/practiceDefaults";
import { normalizeWorkoutTimeInput } from "../../../lib/time";
import {
  createAuxiliaryRoutine,
  deleteAuxiliaryRoutine,
  loadAuxiliaryRoutines,
  updateAuxiliaryRoutine,
  type AuxiliaryRoutine,
} from "../../../lib/auxiliaryRoutines";
import {
  COACH_SETTINGS_SAVE_SOURCE,
  loadCoachCategoriesFromTeamKV,
  loadCoachSettings,
  saveCoachSettings,
} from "../../../lib/settings";
import {
  loadFeedbackFlagSettings,
  saveFeedbackFlagSettings,
  type FeedbackWarningMode,
} from "../../../lib/feedbackFlags";
import { bulkUpdateTeamWorkouts, listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FEEDBACK_WINDOW_OPTIONS: Array<{ mode: FeedbackWarningMode; label: string }> = [
  { mode: "all", label: "All past days" },
  { mode: "previous_month", label: "Previous month only" },
  { mode: "last_14_days", label: "Previous 14 days" },
  { mode: "last_7_days", label: "Previous 7 days" },
  { mode: "since_date", label: "From a specific date" },
];

function round2(n: number) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

function formatNumber(n: number) {
  return String(round2(n));
}

function convertDistanceString(raw: string, from: DistanceUnit, to: DistanceUnit): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(":")) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.includes("xt") || lower.includes("min") || lower.includes("hr")) return trimmed;

  const range = trimmed.match(/^(-?\d*\.?\d+)\s*-\s*(-?\d*\.?\d+)\s*(mi|km)?$/i);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return `${formatNumber(convertDistance(a, from, to))}-${formatNumber(convertDistance(b, from, to))}`;
    }
    return trimmed;
  }

  const single = trimmed.match(/^(-?\d*\.?\d+)\s*(mi|km)?$/i);
  if (single) {
    const v = Number(single[1]);
    if (Number.isFinite(v)) return formatNumber(convertDistance(v, from, to));
  }

  return trimmed;
}

function convertMileageValue(value: any, from: DistanceUnit, to: DistanceUnit): any {
  if (from === to) return value;
  if (value == null) return value;

  if (typeof value === "number") return round2(convertDistance(value, from, to));
  if (typeof value === "string") return convertDistanceString(value, from, to);
  if (typeof value !== "object") return value;

  const kind = value.kind;
  if (kind === "exact" && typeof value.value === "number") {
    return { ...value, value: round2(convertDistance(value.value, from, to)) };
  }
  if (kind === "range" && typeof value.min === "number" && typeof value.max === "number") {
    return {
      ...value,
      min: round2(convertDistance(value.min, from, to)),
      max: round2(convertDistance(value.max, from, to)),
    };
  }

  return value;
}

function convertMileagePlans(rawPlans: any[], from: DistanceUnit, to: DistanceUnit): any[] {
  return (rawPlans ?? []).map((plan: any) => {
    const days = plan?.days ?? {};
    const nextDays: Record<string, any> = {};

    for (let i = 0; i < 7; i++) {
      const key = String(i);
      const day: any = days[key] ?? {};
      const amRaw = day.am ?? day.AM;
      const pmRaw = day.pm ?? day.PM;
      const nextDay: any = { ...day };
      nextDay.am = convertMileageValue(amRaw, from, to);
      nextDay.pm = convertMileageValue(pmRaw, from, to);
      delete nextDay.AM;
      delete nextDay.PM;
      nextDays[key] = nextDay;
    }

    return { ...plan, days: nextDays, updatedAt: Date.now() };
  });
}

function convertWorkoutDistances(rawWorkouts: any[], from: DistanceUnit, to: DistanceUnit): any[] {
  return (rawWorkouts ?? []).map((w: any) => {
    const next: any = { ...w };
    if (typeof next.planned_distance === "number") {
      next.planned_distance = round2(convertDistance(next.planned_distance, from, to));
      next.planned_distance_unit = to;
    }
    return next;
  });
}

export default function CoachSettingsTab() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === "web" && width >= 1100;
  const [paceText, setPaceText] = useState("");
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [feedbackFlagsEnabled, setFeedbackFlagsEnabled] = useState(false);
  const [feedbackWarningMode, setFeedbackWarningMode] = useState<FeedbackWarningMode>("all");
  const [feedbackStartDateText, setFeedbackStartDateText] = useState("");
  const [feedbackWindowMenuOpen, setFeedbackWindowMenuOpen] = useState(false);

  const [workoutTypesOpen, setWorkoutTypesOpen] = useState(false);
  const [categoryAutoRoutinesOpen, setCategoryAutoRoutinesOpen] = useState(false);
  const [customGroupsOpen, setCustomGroupsOpen] = useState(false);
  const [individualPaceOpen, setIndividualPaceOpen] = useState(false);
  const [practiceDefaultsOpen, setPracticeDefaultsOpen] = useState(false);
  const [weekStartMenuOpen, setWeekStartMenuOpen] = useState(false);
  const [paceMenuOpen, setPaceMenuOpen] = useState(false);

  const [roster, setRoster] = useState<TeamRosterAthlete[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [auxiliaryRoutines, setAuxiliaryRoutines] = useState<AuxiliaryRoutine[]>([]);
  const [groups, setGroups] = useState<CustomAthleteGroup[]>([]);
  const [practiceDefaults, setPracticeDefaults] = useState<PracticeTimeDefaults>(emptyPracticeTimeDefaults());
  const [athletePaceOverrides, setAthletePaceOverrides] = useState<AthletePaceOverrides>({});
  const [athletePaceTextById, setAthletePaceTextById] = useState<Record<string, string>>({});
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupNameText, setGroupNameText] = useState("");
  const [draftAthleteIds, setDraftAthleteIds] = useState<string[]>([]);
  const [selectedAuxiliaryRoutineId, setSelectedAuxiliaryRoutineId] = useState<string | null>(null);
  const [auxiliaryTitleDraft, setAuxiliaryTitleDraft] = useState("");
  const [auxiliaryDetailsDraft, setAuxiliaryDetailsDraft] = useState("");
  const [auxiliaryPreCategoryNamesDraft, setAuxiliaryPreCategoryNamesDraft] = useState<string[]>([]);
  const [auxiliaryPostCategoryNamesDraft, setAuxiliaryPostCategoryNamesDraft] = useState<string[]>([]);
  const [auxiliaryAutosaveStatus, setAuxiliaryAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const auxiliaryAutosaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAuxiliarySavedSnapshotRef = React.useRef("");
  const suppressAuxiliaryAutosaveRef = React.useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const [paceSec, coachSettings, loadedCategories, loadedRoster, loadedGroups, loadedOverrides, weekStart, loadedRoutines, feedbackFlagSettings] = await Promise.all([
          loadPaceSecondsPerMile(),
          loadCoachSettings(),
          loadCoachCategoriesFromTeamKV(),
          getSortableRoster(),
          loadCustomAthleteGroups(),
          loadAthletePaceOverrides(),
          loadJSON<WeekStartDay>(WEEK_START_KEY, 1),
          loadAuxiliaryRoutines(),
          loadFeedbackFlagSettings(),
        ]);
        const defaults = await loadPracticeTimeDefaults();
        const loadedCategoryOptions = loadedCategories;
        setPaceText(formatPace(paceSec));
        setDistanceUnit(coachSettings.distanceUnit);
        setWeekStartsOn((weekStart ?? 1) as WeekStartDay);
        setRoster(loadedRoster);
        setCategories(loadedCategoryOptions);
        setAuxiliaryRoutines(loadedRoutines);
        setFeedbackFlagsEnabled(!!feedbackFlagSettings.enabled);
        setFeedbackWarningMode(feedbackFlagSettings.mode ?? "all");
        setFeedbackStartDateText(String(feedbackFlagSettings.startDateISO ?? ""));
        setGroups(loadedGroups);
        setAthletePaceOverrides(loadedOverrides);
        setPracticeDefaults(defaults);

        const textById: Record<string, string> = {};
        for (const athlete of loadedRoster) {
          const value = loadedOverrides?.[athlete.id];
          textById[athlete.id] = Number.isFinite(value) ? formatPace(value) : "";
        }
        setAthletePaceTextById(textById);
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error ?? "Unknown settings load error");
        console.error("[settings-screen] load failed", error);
        Alert.alert("Settings load failed", message);
      }
    })();
  }, []);

  const rosterById = useMemo(() => {
    const map = new Map<string, TeamRosterAthlete>();
    for (const athlete of roster) map.set(athlete.id, athlete);
    return map;
  }, [roster]);

  const sortedRoster = useMemo(() => {
    return [...roster].sort((a, b) => {
      const byLast = (a.lastName ?? "").localeCompare(b.lastName ?? "");
      if (byLast !== 0) return byLast;
      const byFirst = (a.firstName ?? "").localeCompare(b.firstName ?? "");
      if (byFirst !== 0) return byFirst;
      return String(a.displayName ?? "").localeCompare(String(b.displayName ?? ""));
    });
  }, [roster]);

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => a.name.localeCompare(b.name));
  }, [groups]);

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))),
    [categories]
  );

  const sortedAuxiliaryRoutines = useMemo(
    () => [...auxiliaryRoutines].sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? ""))),
    [auxiliaryRoutines]
  );

  const selectedAuxiliaryRoutine = useMemo(
    () => sortedAuxiliaryRoutines.find((routine) => routine.id === selectedAuxiliaryRoutineId) ?? null,
    [sortedAuxiliaryRoutines, selectedAuxiliaryRoutineId]
  );

  function buildAuxiliaryDraftSnapshot() {
    return JSON.stringify({
      id: selectedAuxiliaryRoutineId,
      title: String(auxiliaryTitleDraft ?? "").trim(),
      details: String(auxiliaryDetailsDraft ?? "").trim(),
      pre: [...auxiliaryPreCategoryNamesDraft].sort(),
      post: [...auxiliaryPostCategoryNamesDraft].sort(),
    });
  }

  function loadAuxiliaryRoutineIntoDrafts(routine: AuxiliaryRoutine | null) {
    suppressAuxiliaryAutosaveRef.current = true;

    if (!routine) {
      setAuxiliaryTitleDraft("");
      setAuxiliaryDetailsDraft("");
      setAuxiliaryPreCategoryNamesDraft([]);
      setAuxiliaryPostCategoryNamesDraft([]);
      lastAuxiliarySavedSnapshotRef.current = "";
      setAuxiliaryAutosaveStatus("idle");
      setTimeout(() => {
        suppressAuxiliaryAutosaveRef.current = false;
      }, 0);
      return;
    }
    setAuxiliaryTitleDraft(String(routine.title ?? ""));
    setAuxiliaryDetailsDraft(String(routine.details ?? ""));
    setAuxiliaryPreCategoryNamesDraft(Array.isArray(routine.preCategoryNames) ? routine.preCategoryNames : []);
    setAuxiliaryPostCategoryNamesDraft(Array.isArray(routine.postCategoryNames) ? routine.postCategoryNames : []);

    lastAuxiliarySavedSnapshotRef.current = JSON.stringify({
      id: routine.id,
      title: String(routine.title ?? "").trim(),
      details: String(routine.details ?? "").trim(),
      pre: [...(Array.isArray(routine.preCategoryNames) ? routine.preCategoryNames : [])].sort(),
      post: [...(Array.isArray(routine.postCategoryNames) ? routine.postCategoryNames : [])].sort(),
    });

    setAuxiliaryAutosaveStatus("idle");

    setTimeout(() => {
      suppressAuxiliaryAutosaveRef.current = false;
    }, 0);
  }

  function selectAuxiliaryRoutineById(routineId: string | null) {
    setSelectedAuxiliaryRoutineId(routineId);
    const routine = sortedAuxiliaryRoutines.find((item) => item.id === routineId) ?? null;
    loadAuxiliaryRoutineIntoDrafts(routine);
  }

  async function reloadAuxiliaryRoutines(preferredRoutineId?: string | null) {
    const loaded = await loadAuxiliaryRoutines();
    const sorted = [...loaded].sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")));
    setAuxiliaryRoutines(sorted);
    const targetId = preferredRoutineId ?? selectedAuxiliaryRoutineId;
    const selected = sorted.find((routine) => routine.id === targetId) ?? null;
    if (selected) {
      setSelectedAuxiliaryRoutineId(selected.id);
      loadAuxiliaryRoutineIntoDrafts(selected);
      return;
    }
    setSelectedAuxiliaryRoutineId(null);
    loadAuxiliaryRoutineIntoDrafts(null);
  }

  function toggleDraftCategory(
    setList: React.Dispatch<React.SetStateAction<string[]>>,
    categoryName: string
  ) {
    const key = String(categoryName ?? "").trim();
    if (!key) return;

    setList((prev) =>
      prev.includes(key) ? prev.filter((name) => name !== key) : [...prev, key]
    );
  }

  async function createNewAuxiliaryRoutine() {
    const created = await createAuxiliaryRoutine({
      title: "New Routine",
      details: "",
      preCategoryNames: [],
      postCategoryNames: [],
    });
    await reloadAuxiliaryRoutines(created.id);
    setAuxiliaryAutosaveStatus("idle");
    setCategoryAutoRoutinesOpen(true);
  }

  async function saveSelectedAuxiliaryRoutine() {
    if (!selectedAuxiliaryRoutineId) {
      Alert.alert("Select a routine", "Choose or create a routine to edit.");
      return;
    }

    const title = String(auxiliaryTitleDraft ?? "").trim();
    if (!title) {
      Alert.alert("Title required", "Enter a routine title.");
      return;
    }

    const pre = Array.from(new Set(auxiliaryPreCategoryNamesDraft.map((name) => String(name ?? "").trim()).filter(Boolean)));
    const post = Array.from(new Set(auxiliaryPostCategoryNamesDraft.map((name) => String(name ?? "").trim()).filter(Boolean)));

    await updateAuxiliaryRoutine(selectedAuxiliaryRoutineId, {
      title,
      details: String(auxiliaryDetailsDraft ?? "").trim(),
      preCategoryNames: pre,
      postCategoryNames: post,
      categoryNames: Array.from(new Set([...pre, ...post])),
    });
    await reloadAuxiliaryRoutines(selectedAuxiliaryRoutineId);
  }

  function confirmDeleteSelectedAuxiliaryRoutine() {
    if (!selectedAuxiliaryRoutineId) {
      Alert.alert("Select a routine", "Choose a routine to delete.");
      return;
    }

    const routineId = selectedAuxiliaryRoutineId;
    Alert.alert("Delete routine?", "This removes the selected auxiliary routine.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const index = sortedAuxiliaryRoutines.findIndex((routine) => routine.id === routineId);
          await deleteAuxiliaryRoutine(routineId);
          const refreshed = await loadAuxiliaryRoutines();
          const sorted = [...refreshed].sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")));
          setAuxiliaryRoutines(sorted);
          const fallback = sorted[index] ?? sorted[index - 1] ?? sorted[0] ?? null;
          if (fallback) {
            setSelectedAuxiliaryRoutineId(fallback.id);
            loadAuxiliaryRoutineIntoDrafts(fallback);
          } else {
            setSelectedAuxiliaryRoutineId(null);
            loadAuxiliaryRoutineIntoDrafts(null);
          }
        },
      },
    ]);
  }

  useEffect(() => {
    if (!selectedAuxiliaryRoutineId) return;
    if (suppressAuxiliaryAutosaveRef.current) return;

    const title = String(auxiliaryTitleDraft ?? "").trim();
    if (!title) {
      setAuxiliaryAutosaveStatus("idle");
      return;
    }

    const snapshot = buildAuxiliaryDraftSnapshot();
    if (snapshot === lastAuxiliarySavedSnapshotRef.current) return;

    if (auxiliaryAutosaveTimerRef.current) {
      clearTimeout(auxiliaryAutosaveTimerRef.current);
    }

    setAuxiliaryAutosaveStatus("saving");

    auxiliaryAutosaveTimerRef.current = setTimeout(async () => {
      try {
        const pre = Array.from(
          new Set(auxiliaryPreCategoryNamesDraft.map((name) => String(name ?? "").trim()).filter(Boolean))
        );
        const post = Array.from(
          new Set(auxiliaryPostCategoryNamesDraft.map((name) => String(name ?? "").trim()).filter(Boolean))
        );

        await updateAuxiliaryRoutine(selectedAuxiliaryRoutineId, {
          title,
          details: String(auxiliaryDetailsDraft ?? "").trim(),
          preCategoryNames: pre,
          postCategoryNames: post,
          categoryNames: Array.from(new Set([...pre, ...post])),
        });

        lastAuxiliarySavedSnapshotRef.current = snapshot;
        setAuxiliaryAutosaveStatus("saved");
        await reloadAuxiliaryRoutines(selectedAuxiliaryRoutineId);
      } catch (error) {
        console.error("[settings-aux] autosave failed", error);
        setAuxiliaryAutosaveStatus("error");
      }
    }, 500);

    return () => {
      if (auxiliaryAutosaveTimerRef.current) {
        clearTimeout(auxiliaryAutosaveTimerRef.current);
      }
    };
  }, [
    selectedAuxiliaryRoutineId,
    auxiliaryTitleDraft,
    auxiliaryDetailsDraft,
    auxiliaryPreCategoryNamesDraft,
    auxiliaryPostCategoryNamesDraft,
  ]);

  async function switchDistanceUnit(nextUnit: DistanceUnit) {
    if (nextUnit === distanceUnit) return;

    const [rawPlans, rawWorkouts, currentPace, currentOverrides] = await Promise.all([
      loadJSON<any[]>(MILEAGE_PLANS_KEY, []),
      listTeamWorkoutsInRange("1900-01-01", "9999-12-31"),
      loadPaceSecondsPerMile(),
      loadAthletePaceOverrides(),
    ]);

    const nextPlans = convertMileagePlans(rawPlans, distanceUnit, nextUnit);
    const nextWorkouts = convertWorkoutDistances(rawWorkouts as TeamWorkoutRow[], distanceUnit, nextUnit);
    const nextPace = Math.max(1, Math.round(convertPaceSecondsPerUnit(currentPace, distanceUnit, nextUnit)));
    const nextOverrides: AthletePaceOverrides = {};
    for (const [athleteId, sec] of Object.entries(currentOverrides ?? {})) {
      nextOverrides[athleteId] = Math.max(1, Math.round(convertPaceSecondsPerUnit(sec, distanceUnit, nextUnit)));
    }

    const workoutPatches = (rawWorkouts as TeamWorkoutRow[])
      .map((workout, idx) => {
        const next = nextWorkouts[idx] as TeamWorkoutRow;
        if (workout.planned_distance === next.planned_distance && workout.planned_distance_unit === next.planned_distance_unit) {
          return null;
        }
        return {
          id: workout.id,
          patch: {
            planned_distance: next.planned_distance ?? null,
            planned_distance_unit: next.planned_distance_unit ?? nextUnit,
          },
        };
      })
      .filter(Boolean) as Array<{ id: string; patch: Partial<TeamWorkoutRow> }>;

    console.log("[settings-screen] save payload", {
      action: "switchDistanceUnit",
      source: COACH_SETTINGS_SAVE_SOURCE,
      distanceUnit: nextUnit,
      workoutPatchCount: workoutPatches.length,
    });

    try {
      await Promise.all([
        saveJSON(MILEAGE_PLANS_KEY, nextPlans),
        workoutPatches.length > 0 ? bulkUpdateTeamWorkouts(workoutPatches) : Promise.resolve(),
        savePaceSecondsPerMile(nextPace),
        saveAthletePaceOverrides(nextOverrides),
        saveCoachSettings({ distanceUnit: nextUnit }),
      ]);
      console.log("[settings-screen] save response", {
        action: "switchDistanceUnit",
        status: "success",
      });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error ?? "Unknown settings save error");
      console.error("[settings-screen] save failed", { action: "switchDistanceUnit", error });
      Alert.alert("Settings save failed", message);
      throw error;
    }

    setDistanceUnit(nextUnit);
    setPaceText(formatPace(nextPace));
    setAthletePaceOverrides(nextOverrides);
    setAthletePaceTextById((prev) => {
      const next = { ...prev };
      for (const athlete of roster) {
        const override = nextOverrides[athlete.id];
        next[athlete.id] = Number.isFinite(override) ? formatPace(override) : "";
      }
      return next;
    });
    Alert.alert(
      "Distance unit updated",
      `All saved distance values were converted to ${distanceUnitLabel(nextUnit)} and pace was converted to per ${paceUnitLongLabel(nextUnit)}.`
    );
  }

  async function saveIndividualPaceOverrides() {
    const next: AthletePaceOverrides = {};
    const invalidNames: string[] = [];

    for (const athlete of sortedRoster) {
      const raw = String(athletePaceTextById[athlete.id] ?? "").trim();
      if (!raw) continue;
      const parsed = parsePace(raw);
      if (parsed == null) {
        invalidNames.push(String(athlete.displayName ?? "Athlete"));
        continue;
      }
      next[athlete.id] = parsed;
    }

    if (invalidNames.length > 0) {
      Alert.alert(
        "Invalid pace values",
        `Fix pace for: ${invalidNames.slice(0, 3).join(", ")}${invalidNames.length > 3 ? ` +${invalidNames.length - 3} more` : ""}. Use mm:ss or minutes.`
      );
      return;
    }

    await saveAthletePaceOverrides(next);
    setAthletePaceOverrides(next);
    Alert.alert("Saved", "Individual athlete conversion paces updated.");
  }

  async function clearAllIndividualOverrides() {
    await saveAthletePaceOverrides({});
    setAthletePaceOverrides({});
    setAthletePaceTextById((prev) => {
      const next = { ...prev };
      for (const athlete of sortedRoster) next[athlete.id] = "";
      return next;
    });
    Alert.alert("Cleared", "All athletes now use the team default conversion.");
  }

  async function saveWeekStart(next: WeekStartDay) {
    setWeekStartsOn(next);
    await saveJSON(WEEK_START_KEY, next);
  }

  async function toggleFeedbackFlags(enabled: boolean) {
    setFeedbackFlagsEnabled(enabled);
    await saveFeedbackFlagSettings({
      enabled,
      mode: feedbackWarningMode,
      startDateISO: feedbackStartDateText.trim() || undefined,
    });
  }

  async function saveFeedbackWindow(mode: FeedbackWarningMode, startDateISO?: string) {
    const nextStart = String(startDateISO ?? "").trim();
    if (mode === "since_date" && nextStart) {
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(nextStart) && !Number.isNaN(new Date(nextStart + "T00:00:00").getTime());
      if (!valid) {
        Alert.alert("Invalid date", "Use YYYY-MM-DD format for the start date.");
        return;
      }
    }
    setFeedbackWarningMode(mode);
    setFeedbackStartDateText(nextStart);
    await saveFeedbackFlagSettings({
      enabled: feedbackFlagsEnabled,
      mode,
      startDateISO: nextStart || undefined,
    });
  }

  function updatePracticeDefault(dayIndex: number, field: "am" | "pm", value: string) {
    const key = String(dayIndex);
    setPracticeDefaults((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] ?? {}),
        [field]: value,
      },
    }));
  }

  function normalizePracticeDefaultInput(dayIndex: number, field: "am" | "pm") {
    const key = String(dayIndex);
    const raw = String(practiceDefaults[key]?.[field] ?? "").trim();
    if (!raw) return;
    const normalized = normalizeWorkoutTimeInput(raw);
    if (!normalized) return;
    if (normalized === raw) return;
    updatePracticeDefault(dayIndex, field, normalized);
  }

  async function savePracticeDefaults() {
    const next: PracticeTimeDefaults = emptyPracticeTimeDefaults();
    const invalid: string[] = [];

    for (let day = 0; day < 7; day++) {
      const key = String(day);
      const amRaw = String(practiceDefaults[key]?.am ?? "").trim();
      const pmRaw = String(practiceDefaults[key]?.pm ?? "").trim();

      if (amRaw) {
        const normalized = normalizeWorkoutTimeInput(amRaw);
        if (!normalized) invalid.push(`${WEEKDAY_LABELS[day]} AM`);
        else next[key].am = normalized;
      }

      if (pmRaw) {
        const normalized = normalizeWorkoutTimeInput(pmRaw);
        if (!normalized) invalid.push(`${WEEKDAY_LABELS[day]} PM`);
        else next[key].pm = normalized;
      }
    }

    if (invalid.length > 0) {
      Alert.alert(
        "Invalid default time",
        `Fix: ${invalid.slice(0, 4).join(", ")}${invalid.length > 4 ? ` +${invalid.length - 4} more` : ""}.`
      );
      return;
    }

    console.log("[settings-screen] save payload", {
      action: "savePracticeDefaults",
      source: COACH_SETTINGS_SAVE_SOURCE,
      defaultTimesCount: Object.values(next).reduce((count, day) => {
        const am = String(day?.am ?? "").trim();
        const pm = String(day?.pm ?? "").trim();
        return count + (am ? 1 : 0) + (pm ? 1 : 0);
      }, 0),
    });

    try {
      await savePracticeTimeDefaults(next);
      setPracticeDefaults(next);
      console.log("[settings-screen] save response", {
        action: "savePracticeDefaults",
        status: "success",
      });
      Alert.alert("Saved", "Default practice times updated.");
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error ?? "Unknown settings save error");
      console.error("[settings-screen] save failed", { action: "savePracticeDefaults", error });
      Alert.alert("Settings save failed", message);
    }
  }

  function resetGroupEditor() {
    setEditingGroupId(null);
    setGroupNameText("");
    setDraftAthleteIds([]);
  }

  function toggleDraftAthlete(athleteId: string) {
    setDraftAthleteIds((prev) =>
      prev.includes(athleteId) ? prev.filter((id) => id !== athleteId) : [...prev, athleteId]
    );
  }

  function startEditGroup(group: CustomAthleteGroup) {
    setEditingGroupId(group.id);
    setGroupNameText(group.name);
    setDraftAthleteIds(group.athleteIds);
    setCustomGroupsOpen(true);
  }

  async function saveGroup() {
    const name = groupNameText.trim();
    if (!name) {
      Alert.alert("Group name required", "Enter a name for this training group.");
      return;
    }

    if (draftAthleteIds.length === 0) {
      Alert.alert("No athletes selected", "Select at least one athlete for this group.");
      return;
    }

    const now = Date.now();
    const next = editingGroupId
      ? groups.map((g) =>
          g.id === editingGroupId
            ? { ...g, name, athleteIds: draftAthleteIds, updatedAt: now }
            : g
        )
      : [
          ...groups,
          {
            id: createGroupId(),
            name,
            athleteIds: draftAthleteIds,
            createdAt: now,
            updatedAt: now,
          },
        ];

    await saveCustomAthleteGroups(next);
    setGroups(next);
    resetGroupEditor();
  }

  async function deleteGroup(groupId: string) {
    Alert.alert("Delete group?", "This removes the custom training group.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const next = groups.filter((g) => g.id !== groupId);
          await saveCustomAthleteGroups(next);
          setGroups(next);
          if (editingGroupId === groupId) resetGroupEditor();
        },
      },
    ]);
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/(auth)/login");
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>Manage app preferences and coaching tools.</Text>
      <Pressable
        onPress={() => router.replace("/(auth)/login")}
        style={{
          marginTop: 10,
          alignSelf: "flex-start",
          borderWidth: 1,
          borderColor: "#ddd",
          borderRadius: 10,
          backgroundColor: "#fff",
          paddingVertical: 8,
          paddingHorizontal: 12,
        }}
      >
        <Text style={{ fontWeight: "900", color: "#111" }}>Back to Role Select</Text>
      </Pressable>

      <ScrollView
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        contentContainerStyle={{ paddingBottom: 24, paddingTop: 10 }}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
      >
        <View style={isDesktopWeb ? styles.desktopWorkspace : undefined}>
        <View style={[styles.card, isDesktopWeb && styles.desktopCard]}>
          <Text style={styles.cardTitle}>General</Text>
          <Text style={styles.cardHint}>Core planning preferences used across the app.</Text>

          <View style={styles.settingsRows}>
            <View style={[styles.lineRow, styles.lineRowFirst]}>
              <Text style={styles.lineLabel}>Distance unit</Text>
              <View style={styles.lineValueWrap}>
                {(["mi", "km"] as DistanceUnit[]).map((u) => {
                  const active = u === distanceUnit;
                  return (
                    <Pressable
                      key={u}
                      onPress={() => switchDistanceUnit(u)}
                      style={[styles.unitBtn, active && styles.unitBtnActive]}
                    >
                      <Text style={[styles.unitBtnText, active && styles.unitBtnTextActive]}>{u.toUpperCase()}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={[styles.lineRow, styles.lineDropdownRow]}>
              <Pressable
                onPress={() => setWeekStartMenuOpen((prev) => !prev)}
                hitSlop={10}
                style={styles.dropdownTrigger}
              >
                <Text style={styles.lineLabel}>First day of week</Text>
                <View style={styles.dropdownValueWrap}>
                  <Text style={styles.dropdownValue}>{WEEKDAY_LABELS[weekStartsOn]}</Text>
                  <View style={styles.chevronTapTarget}>
                    <Text style={styles.dropdownChevron}>{weekStartMenuOpen ? "▴" : "▾"}</Text>
                  </View>
                </View>
              </Pressable>
              {weekStartMenuOpen ? (
                <View style={styles.dropdownPanel}>
                  {WEEKDAY_LABELS.map((label, day) => {
                    const active = day === weekStartsOn;
                    return (
                      <Pressable
                        key={`settings-week-start-${label}`}
                        onPress={async () => {
                          await saveWeekStart(day as WeekStartDay);
                          setWeekStartMenuOpen(false);
                        }}
                        style={[
                          styles.dropdownOption,
                          day > 0 && styles.dropdownOptionBorder,
                          active && styles.dropdownOptionActive,
                        ]}
                      >
                        <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>{label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>

            <View style={[styles.lineRow, styles.lineDropdownRow]}>
              <Pressable
                onPress={() => setPaceMenuOpen((prev) => !prev)}
                hitSlop={10}
                style={styles.dropdownTrigger}
              >
                <Text style={styles.lineLabel}>Time → Distance</Text>
                <View style={styles.dropdownValueWrap}>
                  <Text style={styles.dropdownValue}>
                    {formatPace(parsePace(paceText) ?? 0)} / {paceUnitLongLabel(distanceUnit)}
                  </Text>
                  <View style={styles.chevronTapTarget}>
                    <Text style={styles.dropdownChevron}>{paceMenuOpen ? "▴" : "▾"}</Text>
                  </View>
                </View>
              </Pressable>

              {paceMenuOpen ? (
                <View style={styles.dropdownPanel}>
                  <Text style={styles.label}>Team default pace</Text>
                  <TextInput
                    value={paceText}
                    onChangeText={setPaceText}
                    placeholder="8:00"
                    style={styles.input}
                    autoCapitalize="none"
                  />
                  <Text style={styles.cardHint}>
                    Use `8:00` or `8` (minutes per {paceUnitLongLabel(distanceUnit)}).
                  </Text>

                  <Pressable
                    onPress={async () => {
                      const parsed = parsePace(paceText);
                      if (parsed == null) {
                        Alert.alert("Invalid pace", "Enter pace as mm:ss or minutes (e.g. 8:00 or 8).");
                        return;
                      }
                      await savePaceSecondsPerMile(parsed);
                      setPaceText(formatPace(parsed));
                      Alert.alert("Saved", `Pace setting updated for ${distanceUnitLabel(distanceUnit)}.`);
                    }}
                    style={styles.saveBtn}
                  >
                    <Text style={styles.saveBtnText}>Save Team Pace</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setIndividualPaceOpen((prev) => !prev)}
                    style={[styles.groupActionBtn, { marginTop: 10, alignSelf: "flex-start" }]}
                  >
                    <Text style={styles.groupActionBtnText}>
                      {individualPaceOpen ? "Hide individual conversion" : "Individualize conversion by athlete"}
                    </Text>
                  </Pressable>

                  {individualPaceOpen ? (
                    <View style={{ marginTop: 10 }}>
                      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                        <Pressable onPress={saveIndividualPaceOverrides} style={styles.groupActionBtn}>
                          <Text style={styles.groupActionBtnText}>Save athlete paces</Text>
                        </Pressable>
                        <Pressable onPress={clearAllIndividualOverrides} style={styles.groupDeleteBtn}>
                          <Text style={styles.groupDeleteBtnText}>Use team default for all</Text>
                        </Pressable>
                      </View>

                      <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 12, maxHeight: 300 }}>
                        <ScrollView nestedScrollEnabled>
                          {sortedRoster.map((athlete) => {
                            const hasOverride = Number.isFinite(athletePaceOverrides[athlete.id]);
                            return (
                              <View
                                key={athlete.id}
                                style={{
                                  paddingHorizontal: 10,
                                  paddingVertical: 10,
                                  borderBottomWidth: 1,
                                  borderBottomColor: "#f1f1f1",
                                  backgroundColor: "#fff",
                                }}
                              >
                                <Text style={{ fontWeight: "800", color: "#111" }}>{athlete.displayName}</Text>
                                <Text style={{ marginTop: 2, marginBottom: 6, fontSize: 11, color: "#666", fontWeight: "700" }}>
                                  {hasOverride
                                    ? `Override: ${formatPace(athletePaceOverrides[athlete.id])} per ${paceUnitLongLabel(distanceUnit)}`
                                    : `Using team default: ${formatPace(parsePace(paceText) ?? 0)} per ${paceUnitLongLabel(distanceUnit)}`}
                                </Text>
                                <TextInput
                                  value={athletePaceTextById[athlete.id] ?? ""}
                                  onChangeText={(t) =>
                                    setAthletePaceTextById((prev) => ({ ...prev, [athlete.id]: t }))
                                  }
                                  placeholder={`Default (${formatPace(parsePace(paceText) ?? 0)})`}
                                  style={styles.input}
                                  autoCapitalize="none"
                                />
                              </View>
                            );
                          })}
                        </ScrollView>
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>

            <View style={[styles.lineRow, styles.lineRowLast]}>
              <Text style={styles.lineLabel}>Flag missing athlete feedback (past days)</Text>
              <Switch
                value={feedbackFlagsEnabled}
                onValueChange={(value) => {
                  toggleFeedbackFlags(value).catch(() => {});
                }}
              />
            </View>

            {feedbackFlagsEnabled ? (
              <View style={[styles.lineRow, styles.lineDropdownRow]}>
                <Pressable
                  onPress={() => setFeedbackWindowMenuOpen((prev) => !prev)}
                  hitSlop={10}
                  style={styles.dropdownTrigger}
                >
                  <Text style={styles.lineLabel}>Warning window</Text>
                  <View style={styles.dropdownValueWrap}>
                    <Text style={styles.dropdownValue}>
                      {FEEDBACK_WINDOW_OPTIONS.find((opt) => opt.mode === feedbackWarningMode)?.label ?? "All past days"}
                    </Text>
                    <View style={styles.chevronTapTarget}>
                      <Text style={styles.dropdownChevron}>{feedbackWindowMenuOpen ? "▴" : "▾"}</Text>
                    </View>
                  </View>
                </Pressable>

                {feedbackWindowMenuOpen ? (
                  <View style={styles.dropdownPanel}>
                    {FEEDBACK_WINDOW_OPTIONS.map((opt, idx) => {
                      const active = opt.mode === feedbackWarningMode;
                      return (
                        <Pressable
                          key={`feedback-window-${opt.mode}`}
                          onPress={() => {
                            saveFeedbackWindow(opt.mode, feedbackStartDateText).catch(() => {});
                            setFeedbackWindowMenuOpen(false);
                          }}
                          style={[
                            styles.dropdownOption,
                            idx > 0 && styles.dropdownOptionBorder,
                            active && styles.dropdownOptionActive,
                          ]}
                        >
                          <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>
                            {opt.label}
                          </Text>
                        </Pressable>
                      );
                    })}

                    {feedbackWarningMode === "since_date" ? (
                      <View style={{ marginTop: 10 }}>
                        <Text style={styles.label}>Start date (YYYY-MM-DD)</Text>
                        <TextInput
                          value={feedbackStartDateText}
                          onChangeText={setFeedbackStartDateText}
                          placeholder="2026-03-01"
                          style={styles.input}
                          autoCapitalize="none"
                        />
                        <Pressable
                          onPress={() => {
                            saveFeedbackWindow("since_date", feedbackStartDateText).catch(() => {});
                          }}
                          style={[styles.groupActionBtn, { marginTop: 8, alignSelf: "flex-start" }]}
                        >
                          <Text style={styles.groupActionBtnText}>Save start date</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>

        <View style={[styles.card, { marginTop: 12 }, isDesktopWeb && styles.desktopCard]}> 
          <Pressable style={styles.sectionHeader} hitSlop={10} onPress={() => setPracticeDefaultsOpen((prev) => !prev)}>
            <Text style={styles.cardTitle}>Default Practice Times</Text>
            <View style={styles.chevronTapTarget}>
              <Text style={styles.chev}>{practiceDefaultsOpen ? "▾" : "▸"}</Text>
            </View>
          </Pressable>
          <Text style={styles.cardHint}>Set default AM/PM times by weekday (optional).</Text>

          {practiceDefaultsOpen ? (
            <View style={styles.collapsibleBody}>
              <View style={styles.placeholder}>
                {WEEKDAY_LABELS.map((label, dayIdx) => {
                  const key = String(dayIdx);
                  return (
                    <View
                      key={`default-time-${key}`}
                      style={{
                        borderBottomWidth: dayIdx === WEEKDAY_LABELS.length - 1 ? 0 : 1,
                        borderBottomColor: "#f0f0f0",
                        paddingBottom: 10,
                        marginBottom: 10,
                      }}
                    >
                      <Text style={styles.label}>{label}</Text>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.cardHint, { marginBottom: 4 }]}>AM</Text>
                          <TextInput
                            value={practiceDefaults[key]?.am ?? ""}
                            onChangeText={(t) => updatePracticeDefault(dayIdx, "am", t)}
                            onBlur={() => normalizePracticeDefaultInput(dayIdx, "am")}
                            placeholder="Optional"
                            style={styles.input}
                            autoCapitalize="none"
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.cardHint, { marginBottom: 4 }]}>PM</Text>
                          <TextInput
                            value={practiceDefaults[key]?.pm ?? ""}
                            onChangeText={(t) => updatePracticeDefault(dayIdx, "pm", t)}
                            onBlur={() => normalizePracticeDefaultInput(dayIdx, "pm")}
                            placeholder="Optional"
                            style={styles.input}
                            autoCapitalize="none"
                          />
                        </View>
                      </View>
                    </View>
                  );
                })}

                <Text style={styles.cardHint}>
                  Accepts entries like `8a`, `12p`, `8:00am`, `20:00`. Leave blank for no default.
                </Text>

                <Pressable onPress={savePracticeDefaults} style={styles.saveBtn}>
                  <Text style={styles.saveBtnText}>Save Default Times</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>

        <View style={[styles.card, { marginTop: 12 }, isDesktopWeb && styles.desktopCard]}> 
          <Pressable style={styles.sectionHeader} hitSlop={10} onPress={() => setWorkoutTypesOpen((prev) => !prev)}>
            <Text style={styles.cardTitle}>Workout Types</Text>
            <View style={styles.chevronTapTarget}>
              <Text style={styles.chev}>{workoutTypesOpen ? "▾" : "▸"}</Text>
            </View>
          </Pressable>
          <Text style={styles.cardHint}>Manage category names, colors, and ordering.</Text>

          {workoutTypesOpen ? (
            <View style={styles.collapsibleBody}>
              <View
                style={{
                  maxHeight: 460,
                  borderWidth: 1,
                  borderColor: "#e8e8e8",
                  borderRadius: 12,
                  overflow: "hidden",
                  backgroundColor: "#fff",
                }}
              >
                <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  <CategoriesContent useVirtualizedList={false} />
                </ScrollView>
              </View>
            </View>
          ) : null}
        </View>

        <View style={[styles.card, { marginTop: 12 }, isDesktopWeb && styles.desktopCard]}>
          <Pressable
            style={styles.sectionHeader}
            hitSlop={10}
            onPress={() => setCategoryAutoRoutinesOpen((prev) => !prev)}
          >
            <Text style={styles.cardTitle}>Auxiliary Routines</Text>
            <View style={styles.chevronTapTarget}>
              <Text style={styles.chev}>{categoryAutoRoutinesOpen ? "▾" : "▸"}</Text>
            </View>
          </Pressable>
          <Text style={styles.cardHint}>Create and assign pre/post-run routines for Planner auto-application.</Text>

          {categoryAutoRoutinesOpen ? (
            <View style={styles.collapsibleBody}>
              <View style={[styles.placeholder, isDesktopWeb && styles.auxWorkspaceDesktop]}>
                <View style={[styles.auxListPane, isDesktopWeb && styles.auxListPaneDesktop]}>
                  <View style={styles.auxListHeader}>
                    <Text style={styles.auxListTitle}>Auxiliary Routines</Text>
                    <Pressable onPress={createNewAuxiliaryRoutine} style={styles.groupActionBtn}>
                      <Text style={styles.groupActionBtnText}>New Routine</Text>
                    </Pressable>
                  </View>

                  <View style={styles.auxListBody}>
                    {sortedAuxiliaryRoutines.length === 0 ? (
                      <Text style={styles.cardHint}>No routines yet. Create one to get started.</Text>
                    ) : (
                      sortedAuxiliaryRoutines.map((routine) => {
                        const preCount = Array.isArray(routine.preCategoryNames) ? routine.preCategoryNames.length : 0;
                        const postCount = Array.isArray(routine.postCategoryNames) ? routine.postCategoryNames.length : 0;
                        const active = routine.id === selectedAuxiliaryRoutineId;
                        return (
                          <Pressable
                            key={routine.id}
                            onPress={() => selectAuxiliaryRoutineById(routine.id)}
                            style={[styles.auxListRow, active && styles.auxListRowActive]}
                          >
                            <Text style={[styles.auxListRowTitle, active && styles.auxListRowTitleActive]}>
                              {routine.title || "Routine"}
                            </Text>
                            <Text style={styles.auxListRowMeta}>
                              {preCount} pre • {postCount} post
                            </Text>
                          </Pressable>
                        );
                      })
                    )}
                  </View>
                </View>

                <View style={[styles.auxEditorPane, isDesktopWeb && styles.auxEditorPaneDesktop]}>
                  {selectedAuxiliaryRoutine ? (
                    <>
                      <Text style={styles.auxEditorTitle}>Routine Editor</Text>
                      <Text style={styles.label}>Title</Text>
                      <TextInput
                        value={auxiliaryTitleDraft}
                        onChangeText={setAuxiliaryTitleDraft}
                        placeholder="Routine name"
                        style={styles.input}
                      />

                      <Text style={[styles.label, { marginTop: 10 }]}>Details</Text>
                      <TextInput
                        value={auxiliaryDetailsDraft}
                        onChangeText={setAuxiliaryDetailsDraft}
                        placeholder="Notes or instructions"
                        style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
                        multiline
                      />

                      <Text style={[styles.label, { marginTop: 10 }]}>Pre-run categories</Text>
                      <View style={styles.auxChipWrap}>
                        {sortedCategories.map((category) => {
                          const active = auxiliaryPreCategoryNamesDraft.includes(category.name);
                          return (
                            <Pressable
                              key={`aux-pre-${selectedAuxiliaryRoutine.id}-${category.id}`}
                              onPress={() =>
                                toggleDraftCategory(
                                  setAuxiliaryPreCategoryNamesDraft,
                                  category.name
                                )
                              }
                              style={[styles.autoRoutineChip, active && styles.autoRoutineChipActive]}
                            >
                              <Text style={[styles.autoRoutineChipText, active && styles.autoRoutineChipTextActive]}>
                                {category.name}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>

                      <Text style={[styles.label, { marginTop: 10 }]}>Post-run categories</Text>
                      <View style={styles.auxChipWrap}>
                        {sortedCategories.map((category) => {
                          const active = auxiliaryPostCategoryNamesDraft.includes(category.name);
                          return (
                            <Pressable
                              key={`aux-post-${selectedAuxiliaryRoutine.id}-${category.id}`}
                              onPress={() =>
                                toggleDraftCategory(
                                  setAuxiliaryPostCategoryNamesDraft,
                                  category.name
                                )
                              }
                              style={[styles.autoRoutineChip, active && styles.autoRoutineChipActive]}
                            >
                              <Text style={[styles.autoRoutineChipText, active && styles.autoRoutineChipTextActive]}>
                                {category.name}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>

                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
                        <Text style={{ fontSize: 12, fontWeight: "800", color: auxiliaryAutosaveStatus === "error" ? "#b00020" : "#666" }}>
                          {auxiliaryAutosaveStatus === "saving"
                            ? "Saving..."
                            : auxiliaryAutosaveStatus === "saved"
                            ? "Saved"
                            : auxiliaryAutosaveStatus === "error"
                            ? "Autosave failed"
                            : "Autosave enabled"}
                        </Text>

                        <Pressable
                          onPress={confirmDeleteSelectedAuxiliaryRoutine}
                          style={[styles.groupDeleteBtn, { alignItems: "center", justifyContent: "center" }]}
                        >
                          <Text style={styles.groupDeleteBtnText}>Delete</Text>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <View style={styles.auxEmpty}>
                      <Text style={styles.cardTitle}>No routine selected</Text>
                      <Text style={styles.cardHint}>Select a routine on the left, or create a new routine to begin editing.</Text>
                      <Pressable onPress={createNewAuxiliaryRoutine} style={[styles.groupActionBtn, { alignSelf: "flex-start" }]}>
                        <Text style={styles.groupActionBtnText}>Create Routine</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              </View>
            </View>
          ) : null}
        </View>

        <View style={[styles.card, { marginTop: 12 }, isDesktopWeb && styles.desktopCard]}> 
          <Pressable style={styles.sectionHeader} hitSlop={10} onPress={() => setCustomGroupsOpen((prev) => !prev)}>
            <Text style={styles.cardTitle}>Custom Groups</Text>
            <View style={styles.chevronTapTarget}>
              <Text style={styles.chev}>{customGroupsOpen ? "▾" : "▸"}</Text>
            </View>
          </Pressable>
          <Text style={styles.cardHint}>Create named athlete groups for quick selection in Plan.</Text>

          {customGroupsOpen ? (
            <View style={styles.collapsibleBody}>
              <View style={styles.placeholder}>
                <Text style={styles.label}>Group name</Text>
                <TextInput
                  value={groupNameText}
                  onChangeText={setGroupNameText}
                  placeholder="e.g., Varsity Girls"
                  style={styles.input}
                />

                <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                  <Pressable
                    onPress={() => setDraftAthleteIds(sortedRoster.map((a) => a.id))}
                    style={styles.groupActionBtn}
                  >
                    <Text style={styles.groupActionBtnText}>Select all</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setDraftAthleteIds([])}
                    style={styles.groupActionBtn}
                  >
                    <Text style={styles.groupActionBtnText}>Clear</Text>
                  </Pressable>
                  {(editingGroupId || groupNameText || draftAthleteIds.length > 0) ? (
                    <Pressable
                      onPress={resetGroupEditor}
                      style={styles.groupActionBtn}
                    >
                      <Text style={styles.groupActionBtnText}>Cancel</Text>
                    </Pressable>
                  ) : null}
                </View>

                <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 12, maxHeight: 220 }}>
                  <ScrollView nestedScrollEnabled>
                    {sortedRoster.map((athlete) => {
                      const active = draftAthleteIds.includes(athlete.id);
                      return (
                        <Pressable
                          key={athlete.id}
                          onPress={() => toggleDraftAthlete(athlete.id)}
                          style={{
                            flexDirection: "row",
                            justifyContent: "space-between",
                            alignItems: "center",
                            paddingVertical: 10,
                            paddingHorizontal: 10,
                            borderBottomWidth: 1,
                            borderBottomColor: "#f1f1f1",
                            backgroundColor: active ? "rgba(0,0,0,0.04)" : "#fff",
                          }}
                        >
                          <Text style={{ fontWeight: "700", color: "#111", flex: 1, paddingRight: 8 }}>
                            {athlete.displayName}
                          </Text>
                          <Text style={{ fontWeight: "900", color: active ? "#111" : "#999" }}>
                            {active ? "✓" : "○"}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>

                <Pressable onPress={saveGroup} style={[styles.saveBtn, { marginTop: 10 }]}> 
                  <Text style={styles.saveBtnText}>{editingGroupId ? "Update Group" : "Save Group"}</Text>
                </Pressable>
              </View>

              <View style={{ marginTop: 12 }}>
                {sortedGroups.length === 0 ? (
                  <Text style={{ color: "#666", fontWeight: "700" }}>No custom groups yet.</Text>
                ) : (
                  sortedGroups.map((group) => {
                    const names = group.athleteIds
                      .map((id) => rosterById.get(id))
                      .filter((a): a is TeamRosterAthlete => !!a)
                      .map((a) => a.displayName)
                      .slice(0, 3);
                    const extra = Math.max(0, group.athleteIds.length - names.length);

                    return (
                      <View key={group.id} style={styles.groupCard}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={styles.groupName}>{group.name}</Text>
                          <Text style={styles.groupMeta}>
                            {group.athleteIds.length} athlete{group.athleteIds.length === 1 ? "" : "s"}
                            {names.length > 0 ? ` • ${names.join(", ")}${extra > 0 ? ` +${extra} more` : ""}` : ""}
                          </Text>
                        </View>
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          <Pressable onPress={() => startEditGroup(group)} style={styles.groupActionBtn}>
                            <Text style={styles.groupActionBtnText}>Edit</Text>
                          </Pressable>
                          <Pressable onPress={() => deleteGroup(group.id)} style={styles.groupDeleteBtn}>
                            <Text style={styles.groupDeleteBtnText}>Delete</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          ) : null}
        </View>

        <Pressable
          onPress={signOut}
          style={{
            backgroundColor: "#c33",
            padding: 14,
            borderRadius: 12,
            alignItems: "center",
            marginTop: 30,
            ...(isDesktopWeb ? { width: "100%" as const } : null),
          }}
        >
          <Text style={{ color: "white", fontWeight: "600", fontSize: 16 }}>
            Sign Out
          </Text>
        </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 14, backgroundColor: "#fff" },
  title: { fontSize: 22, fontWeight: "900", color: "#111" },
  subtitle: { marginTop: 4, color: "#666", fontWeight: "700" },
  desktopWorkspace: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 12,
  },
  desktopCard: {
    flexBasis: "48%",
    flexGrow: 1,
    marginTop: 0,
  },

  card: { borderWidth: 1, borderColor: "#eee", backgroundColor: "#fafafa", borderRadius: 14, padding: 12 },
  cardTitle: { fontSize: 16, fontWeight: "900", color: "#111" },
  cardHint: { marginTop: 4, marginBottom: 10, color: "#666", fontWeight: "700", fontSize: 12 },
  settingsRows: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e8e8e8",
    backgroundColor: "#fff",
    overflow: "hidden",
  },
  lineRow: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: "#efefef",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  lineRowFirst: { borderTopWidth: 0 },
  lineRowLast: {},
  lineDropdownRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 0,
  },
  lineLabel: { fontSize: 14, fontWeight: "900", color: "#111" },
  lineValueWrap: { minWidth: 148, flexDirection: "row", gap: 8 },
  dropdownTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 40,
  },
  dropdownValueWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  dropdownValue: { fontSize: 13, fontWeight: "800", color: "#444" },
  dropdownChevron: { fontWeight: "900", color: "#666", fontSize: 14 },
  dropdownPanel: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#e6e6e6",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#fafafa",
  },
  dropdownOption: { paddingVertical: 10, paddingHorizontal: 10, backgroundColor: "#fff" },
  dropdownOptionBorder: { borderTopWidth: 1, borderTopColor: "#efefef" },
  dropdownOptionActive: { backgroundColor: "rgba(10,132,255,0.10)" },
  dropdownOptionText: { fontWeight: "800", color: "#111" },
  dropdownOptionTextActive: { color: "#0a84ff" },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 40 },
  chev: { fontSize: 16, fontWeight: "900", color: "#666" },
  chevronTapTarget: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  collapsibleBody: { marginTop: 2 },
  auxWorkspaceDesktop: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 12,
  },
  auxListPane: {
    borderWidth: 1,
    borderColor: "#e8e8e8",
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 10,
    marginBottom: 10,
  },
  auxListPaneDesktop: {
    flex: 1,
    marginBottom: 0,
    minHeight: 420,
  },
  auxEditorPane: {
    borderWidth: 1,
    borderColor: "#e8e8e8",
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 10,
  },
  auxEditorPaneDesktop: {
    flex: 1.3,
    minHeight: 420,
  },
  auxListHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  auxListTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: "#111",
  },
  auxListBody: {
    gap: 8,
  },
  auxListRow: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: "#fafafa",
  },
  auxListRowActive: {
    borderColor: "#111",
    backgroundColor: "#f0f0f0",
  },
  auxListRowTitle: {
    fontSize: 13,
    fontWeight: "900",
    color: "#111",
  },
  auxListRowTitleActive: {
    color: "#000",
  },
  auxListRowMeta: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: "700",
    color: "#666",
  },
  auxEditorTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: "#111",
    marginBottom: 8,
  },
  auxChipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  auxEmpty: {
    paddingVertical: 20,
  },

  placeholder: { borderRadius: 12, borderWidth: 1, borderColor: "#e8e8e8", backgroundColor: "#fff", padding: 12 },
  label: { fontSize: 12, fontWeight: "900", color: "#666", marginBottom: 6 },
  unitBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  unitBtnActive: { borderColor: "#111", backgroundColor: "#111" },
  unitBtnText: { fontWeight: "900", color: "#111" },
  unitBtnTextActive: { color: "#fff" },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    fontWeight: "800",
  },
  saveBtn: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#111",
    borderRadius: 12,
    backgroundColor: "#111",
    alignItems: "center",
    paddingVertical: 10,
  },
  saveBtnText: { fontWeight: "900", color: "white" },

  groupCard: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 12,
    padding: 10,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
  },
  groupName: { fontWeight: "900", color: "#111" },
  groupMeta: { marginTop: 3, color: "#666", fontWeight: "700", fontSize: 12 },
  groupActionBtn: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#fafafa",
  },
  groupActionBtnText: { fontWeight: "900", color: "#111" },
  groupDeleteBtn: {
    borderWidth: 1,
    borderColor: "#f1c3c3",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  groupDeleteBtnText: { fontWeight: "900", color: "#b00020" },
  autoRoutineChip: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#fff",
  },
  autoRoutineChipActive: {
    borderColor: "#111",
    backgroundColor: "#111",
  },
  autoRoutineChipText: { fontWeight: "800", color: "#222" },
  autoRoutineChipTextActive: { color: "#fff" },
});
