import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { loadJSON, saveJSON } from "../../lib/storage";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../lib/pace";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../lib/units";
import type { AthleteWorkout, MileageValue, WeekStartDay } from "../../lib/types";
import { resolveAthleteSessionContext } from "../../lib/athleteSession";
import { ATHLETE_CALENDAR_VIEW_STATE_KEY, type AthleteCalendarViewState } from "../../lib/athleteCalendarView";
import { loadRosterNameMapForTeam } from "../../lib/rosterNameMap";
import {
  listTeamWorkoutsByBatch,
  listVisibleAthleteWorkoutsInRange,
  type TeamWorkoutRow,
  updateOwnWorkoutFeedbackById,
} from "../../lib/teamWorkoutsCloud";
import { listTeamWorkoutBatchHeadersForDate } from "../../lib/teamWorkoutBatchHeadersCloud";
import {
  buildMileageFeedbackId,
  loadMileageFeedback,
  migrateLocalMileageFeedbackToTeamForAthlete,
  type MileageSessionFeedback,
  upsertMileageFeedback,
} from "../../lib/mileageFeedback";
import { hasMileageFeedback, hasWorkoutFeedback, parseNumericLike } from "../../lib/feedbackParsing";
import { teamDataStore, visibleMileageAthleteWeekKey } from "../../lib/teamDataStore";
import {
  getWeekStartISO,
  getWeekIndex,
  sumMileage,
  formatSum,
  formatMileage,
  parseMileageInput,
  parseISODate,
  toISODate,
} from "../../lib/mileagePlan";
import { loadCoachWeekLabels, loadWeekStartSetting, type CoachWeekLabels } from "../../lib/settings";
import { PrevNextNavButtons } from "../../components/shared/PrevNextNavButtons";
import { CATEGORIES_KEY, normalizeCategories } from "../../lib/categories";
import { AthleteQuickFeedbackSheet } from "../../components/athlete/AthleteQuickFeedbackSheet";
import { AthleteSessionCard, type AthleteSessionCardStatus } from "../../components/athlete/AthleteSessionCard";
import type { WorkoutCategory } from "../../lib/types";
import { loadAuxiliaryRoutineDefinitions, type AuxiliaryRoutine } from "../../lib/auxiliaryRoutines";
import {
  buildBatchNotesByWorkoutId,
  cleanDisplayText,
  formatPlannedDistanceLabel,
  formatPrescribedLabel,
  getRoutineTitles,
} from "../../lib/athleteWorkoutDisplay";
import { getWeekLabelTone, getWeekLabelToneColors } from "../../lib/weekLabelStyle";

const ATHLETE_DAY_UI_STATE_KEY = "training_app_athlete_day_ui_state_v1";

type AthleteDayUiState = {
  dateISO?: string;
};

type FeedbackEditorState = {
  dateISO: string;
  session: "AM" | "PM";
  prescribed: string;
  workout?: AthleteWorkout;
  mileageFeedback?: MileageSessionFeedback;
  planSummary: string;
  completedMilesText: string;
  completedTimeText: string;
  splitsText: string;
  additionalFeedbackText: string;
};

function normalizeGroupId(groupId?: string): string {
  const normalized = String(groupId ?? "").trim().toUpperCase();
  return normalized || "A";
}

function normalizeSession(value: string | undefined): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
}

function fallbackAthleteName(athleteId: string) {
  const clean = String(athleteId ?? "").trim();
  if (!clean) return "Athlete";
  return `Athlete (${clean.slice(-6)})`;
}

function toAthleteWorkout(row: TeamWorkoutRow, nameByAthleteId: Map<string, string>): AthleteWorkout {
  const athleteId = String(row.athlete_profile_id ?? "").trim();
  const athleteName =
    String(nameByAthleteId.get(athleteId) ?? "").trim() ||
    String((row as any).athlete_name ?? "").trim() ||
    fallbackAthleteName(athleteId);

  return {
    id: String(row.id),
    athleteId,
    athleteName,
    batchId: row.batch_id ?? undefined,
    groupId: row.group_id ?? undefined,
    dateISO: String(row.date_iso),
    session: row.session === "AM" ? "AM" : "PM",
    time: row.time_text ?? undefined,
    location: row.location ?? undefined,
    preRoutineIds: row.pre_routine_ids ?? undefined,
    postRoutineIds: row.post_routine_ids ?? undefined,
    category: String(row.primary_category ?? "Other"),
    categories: row.categories ?? undefined,
    title: row.title ?? "Workout",
    details: row.details ?? undefined,
    plannedMiles: parseNumericLike(row.planned_distance),
    plannedDistanceUnit: row.planned_distance_unit === "km" ? "km" : "mi",
    completedMiles: typeof (row as any).completed_miles === "number" ? (row as any).completed_miles : undefined,
    completedTime: String((row as any).completed_time_text ?? "").trim() || undefined,
    splitsOrPace: String((row as any).splits_or_pace ?? "").trim() || undefined,
    additionalFeedback: String((row as any).additional_feedback ?? "").trim() || undefined,
    feedback: String((row as any).additional_feedback ?? "").trim() || undefined,
  };
}

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

function toMileageValue(raw: unknown): MileageValue | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return parseMileageInput(raw);
  if (typeof raw === "number") return { kind: "exact", value: raw };
  if (typeof raw === "object") return raw as MileageValue;
  return undefined;
}

function isTodayISO(dateISO: string) {
  const today = toISODate(new Date());
  return String(dateISO) === String(today);
}

function isISODateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
}

function appendRouteParam(parts: string[], key: string, value: unknown) {
  const clean = String(value ?? "").trim();
  if (!clean) return;
  parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(clean)}`);
}

function workoutCategoryNames(workout: AthleteWorkout): string[] {
  const arr = Array.isArray(workout.categories) ? workout.categories : [String(workout.category ?? "Other")];
  const cleaned = arr.map((x) => String(x ?? "").trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["Other"];
}

function feedbackSummaryFromWorkout(workout: AthleteWorkout): string {
  const parts = [
    workout.completedMiles != null ? `${workout.completedMiles} mi` : "",
    String(workout.completedTime ?? "").trim(),
    String(workout.splitsOrPace ?? "").trim(),
    String(workout.additionalFeedback ?? workout.feedback ?? "").trim(),
  ].filter(Boolean);
  return parts.join(" • ");
}

function feedbackSummaryFromMileage(entry?: MileageSessionFeedback): string {
  if (!entry) return "";
  const parts = [
    entry.completedMiles != null ? `${entry.completedMiles} mi` : "",
    String(entry.completedTime ?? "").trim(),
    String(entry.splitsOrPace ?? "").trim(),
    String(entry.additionalFeedback ?? "").trim(),
  ].filter(Boolean);
  return parts.join(" • ");
}

export default function AthleteDayScreen() {
  const router = useRouter();
  const store = teamDataStore.use();
  const { date, returnView, returnDate } = useLocalSearchParams<{ date: string; returnView?: string; returnDate?: string }>();
  const [currentDateISO, setCurrentDateISO] = useState<string>(() => {
    const routeDate = String(date ?? "").trim();
    if (isISODateOnly(routeDate)) return routeDate;
    return toISODate(new Date());
  });

  const [allWorkouts, setAllWorkouts] = useState<AthleteWorkout[]>([]);
  const [workouts, setWorkouts] = useState<AthleteWorkout[]>([]);
  const [selectedAthleteName, setSelectedAthleteName] = useState<string | null>(null);
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [weekLabelsByStart, setWeekLabelsByStart] = useState<CoachWeekLabels>({});
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());
  const [mileageFeedbackEntries, setMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [batchNotesByWorkoutId, setBatchNotesByWorkoutId] = useState<Map<string, string>>(new Map());
  const [routineById, setRoutineById] = useState<Map<string, AuxiliaryRoutine>>(new Map());
  const [editor, setEditor] = useState<FeedbackEditorState | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(true);
  const lastLoadRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });
  const inFlightRef = useRef(false);
  const activeLoadKeyRef = useRef("");

  const dayPlan = useMemo(() => {
    if (!currentDateISO || !selectedAthleteId) return null;

    const weekStartISO = getWeekStartISO(String(currentDateISO), weekStartsOn);
    const visibleMileageKey = visibleMileageAthleteWeekKey(selectedAthleteId, weekStartISO);
    const idx = getWeekIndex(String(currentDateISO), weekStartISO);
    if (idx < 0 || idx > 6) return null;

    const cells = store.visibleMileageCellsByAthleteWeek[visibleMileageKey] ?? [];
    const flags = store.visibleMileageFlagsByAthleteWeek[visibleMileageKey] ?? [];

    const am = toMileageValue(
      cells.find(
        (row) =>
          String(row.athlete_profile_id) === String(selectedAthleteId) &&
          row.day_idx === idx &&
          row.session === "AM"
      )?.value
    );
    const pm = toMileageValue(
      cells.find(
        (row) =>
          String(row.athlete_profile_id) === String(selectedAthleteId) &&
          row.day_idx === idx &&
          row.session === "PM"
      )?.value
    );
    const ncaaOff =
      flags.find(
        (row) =>
          String(row.athlete_profile_id) === String(selectedAthleteId) &&
          row.day_idx === idx
      )?.ncaa_off ?? false;

    if (!am && !pm && !ncaaOff) return null;

    const total = sumMileage([am, pm], paceSecPerMile);

    return {
      weekStartISO,
      am,
      pm,
      ncaaOff,
      total,
    };
  }, [currentDateISO, paceSecPerMile, selectedAthleteId, store.visibleMileageCellsByAthleteWeek, store.visibleMileageFlagsByAthleteWeek, weekStartsOn]);

  const currentWeekStartISO = useMemo(
    () => (currentDateISO ? getWeekStartISO(String(currentDateISO), weekStartsOn) : ""),
    [currentDateISO, weekStartsOn]
  );
  const currentWeekLabelEntry = useMemo(
    () => (currentWeekStartISO ? weekLabelsByStart[currentWeekStartISO] ?? null : null),
    [currentWeekStartISO, weekLabelsByStart]
  );
  const currentWeekLabelText = useMemo(
    () => String(currentWeekLabelEntry?.label ?? "").trim(),
    [currentWeekLabelEntry]
  );
  const currentWeekLabelColors = useMemo(
    () => getWeekLabelToneColors(getWeekLabelTone(currentWeekLabelEntry?.type ?? "training")),
    [currentWeekLabelEntry]
  );

  const groupMatesByWorkoutId = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const workout of workouts) {
      if (!workout.batchId) {
        out.set(workout.id, []);
        continue;
      }
      const peers = allWorkouts.filter(
        (item) =>
          item.batchId === workout.batchId &&
          normalizeGroupId(item.groupId) === normalizeGroupId(workout.groupId) &&
          item.id !== workout.id
      );
      const names = Array.from(
        new Set(
          peers
            .map((item) => {
              if (item.athleteId) return rosterNameById.get(item.athleteId) ?? item.athleteName;
              return item.athleteName;
            })
            .filter((value): value is string => !!(value && value.trim()))
        )
      );
      out.set(workout.id, names);
    }
    return out;
  }, [allWorkouts, workouts, rosterNameById]);

  const amWorkouts = useMemo(() => workouts.filter((w) => (w.session ?? "PM") === "AM"), [workouts]);
  const pmWorkouts = useMemo(() => workouts.filter((w) => (w.session ?? "PM") === "PM"), [workouts]);

  const plannedAm = useMemo(() => (dayPlan ? formatMileage(dayPlan.am) : ""), [dayPlan]);
  const plannedPm = useMemo(() => (dayPlan ? formatMileage(dayPlan.pm) : ""), [dayPlan]);

  const plannedTotal = useMemo(() => {
    if (!dayPlan) return "";
    const label = formatSum(dayPlan.total);
    if (!label) return "";
    return `${label} ${distanceUnitLabel(distanceUnit)}`;
  }, [dayPlan, distanceUnit]);

  const sessionCards = useMemo(
    () =>
      ([
        {
          session: "AM" as const,
          prescribed: plannedAm,
          workouts: amWorkouts,
        },
        {
          session: "PM" as const,
          prescribed: plannedPm,
          workouts: pmWorkouts,
        },
      ] as const).filter((entry) => entry.workouts.length > 0 || Boolean(entry.prescribed)),
    [amWorkouts, plannedAm, plannedPm, pmWorkouts]
  );

  const loadDayData = useCallback(
    async (force = false) => {
      if (inFlightRef.current) return;
      const loadKey = String(currentDateISO);
      const now = Date.now();
      if (!force && lastLoadRef.current.key === loadKey && now - lastLoadRef.current.ts < 12000) {
        return;
      }
      activeLoadKeyRef.current = loadKey;
      inFlightRef.current = true;
      setLoadingContext(true);
      try {
        const [ws, pace, unit, athleteSession, storedCategories, routines, weekLabels] = await Promise.all([
          loadWeekStartSetting(),
          loadPaceSecondsPerMile(),
          loadDistanceUnit(),
          resolveAthleteSessionContext(),
          loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
          loadAuxiliaryRoutineDefinitions(),
          loadCoachWeekLabels(),
        ]);

        const resolvedWeekStart: WeekStartDay = ws.normalized === "sunday" ? 0 : 1;
        setWeekStartsOn(resolvedWeekStart);
        setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
        setDistanceUnit(unit);
        setCategories(normalizeCategories(storedCategories));
        setWeekLabelsByStart(weekLabels ?? {});
        setRoutineById(new Map(routines.map((routine) => [routine.id, routine] as const)));

        const resolvedId = String(athleteSession.athleteId ?? "").trim() || null;
        const resolvedName = resolvedId ? String(athleteSession.athleteName ?? "").trim() || null : null;

        setRosterNameById(new Map());
        setSelectedAthleteName(resolvedName);
        setSelectedAthleteId(resolvedId);

        const weekStartISO = getWeekStartISO(String(currentDateISO), resolvedWeekStart);
        if (resolvedId) void teamDataStore.actions.loadVisibleMileageWeekForAthlete(resolvedId, weekStartISO);

        if (!currentDateISO || !resolvedId) {
          setAllWorkouts([]);
          setWorkouts([]);
          setBatchNotesByWorkoutId(new Map());
          return;
        }

        await migrateLocalMileageFeedbackToTeamForAthlete({ athleteId: resolvedId, athleteName: resolvedName });
        const [athleteRows, allMileageFeedback, batchHeaders] = await Promise.all([
          listVisibleAthleteWorkoutsInRange(String(resolvedId), String(currentDateISO), String(currentDateISO)),
          loadMileageFeedback(),
          listTeamWorkoutBatchHeadersForDate(String(currentDateISO)),
        ]);
        if (activeLoadKeyRef.current !== loadKey) return;
        const batchIds = Array.from(
          new Set(athleteRows.map((row) => cleanDisplayText(row.batch_id)).filter(Boolean))
        );
        const batchContextRows =
          batchIds.length > 0
            ? (await Promise.all(batchIds.map((batchId) => listTeamWorkoutsByBatch(batchId).catch(() => [])))).flat()
            : [];
        if (activeLoadKeyRef.current !== loadKey) return;

        const athleteMapped = athleteRows.map((row) => toAthleteWorkout(row, new Map()));
        const athleteFiltered = athleteMapped
          .filter((w) => String(w.dateISO) === String(currentDateISO))
          .sort((a, b) => {
            const sessionCompare = String(a.session ?? "").localeCompare(String(b.session ?? ""));
            if (sessionCompare !== 0) return sessionCompare;
            return String(a.title ?? "").localeCompare(String(b.title ?? ""));
          });

        setAllWorkouts(athleteMapped);
        setWorkouts(athleteFiltered);
        setBatchNotesByWorkoutId(buildBatchNotesByWorkoutId([...athleteRows, ...batchContextRows], batchHeaders));
        setMileageFeedbackEntries(
          allMileageFeedback.filter((entry) => {
            const entryAthleteId = String((entry as any)?.athleteId ?? "").trim();
            const byId = entryAthleteId === resolvedId;
            const byName =
              !entryAthleteId &&
              resolvedName &&
              String(entry.athleteName ?? "").trim().toLowerCase() === resolvedName.toLowerCase();
            return (byId || byName) && String(entry.dateISO ?? "") === String(currentDateISO);
          })
        );
        lastLoadRef.current = { key: loadKey, ts: Date.now() };

        // Hydrate roster names in background without loading hidden team rows.
        void (async () => {
          const rosterMap = await loadRosterNameMapForTeam(athleteSession.teamId);
          if (activeLoadKeyRef.current !== loadKey) return;
          setRosterNameById(rosterMap);
        })();
      } finally {
        setLoadingContext(false);
        inFlightRef.current = false;
      }
    },
    [currentDateISO]
  );

  useEffect(() => {
    void loadDayData(false);
  }, [loadDayData]);

  useFocusEffect(
    useCallback(() => {
      void loadDayData(true);
    }, [loadDayData])
  );

  useEffect(() => {
    const routeDate = String(date ?? "").trim();
    if (isISODateOnly(routeDate)) {
      setCurrentDateISO(routeDate);
      return;
    }

    let cancelled = false;
    (async () => {
      const saved = await loadJSON<AthleteDayUiState>(ATHLETE_DAY_UI_STATE_KEY, {});
      if (cancelled) return;
      const savedDateISO = String(saved?.dateISO ?? "").trim();
      if (isISODateOnly(savedDateISO)) {
        setCurrentDateISO(savedDateISO);
        return;
      }
      setCurrentDateISO(toISODate(new Date()));
    })().catch(() => {
      if (!cancelled) setCurrentDateISO(toISODate(new Date()));
    });

    return () => {
      cancelled = true;
    };
  }, [date]);

  useEffect(() => {
    const next = String(currentDateISO ?? "").trim();
    if (!isISODateOnly(next)) return;
    void saveJSON<AthleteDayUiState>(ATHLETE_DAY_UI_STATE_KEY, { dateISO: next });
  }, [currentDateISO]);

  function addDays(dateISO: string, days: number) {
    const d = parseISODate(dateISO);
    d.setDate(d.getDate() + days);
    return toISODate(d);
  }

  function navigateDay(delta: number) {
    if (!currentDateISO) return;
    const next = addDays(currentDateISO, delta);
    setCurrentDateISO(next);
    router.replace({
      pathname: "/(athlete)/day",
      params: {
        date: next,
        ...(returnView ? { returnView: String(returnView) } : {}),
        ...(returnDate ? { returnDate: String(returnDate) } : {}),
      },
    });
  }

  async function goBackToCalendar() {
    const routeView = String(returnView ?? "").trim().toLowerCase();
    const routeDateISO = String(returnDate ?? "").trim();
    if (routeView === "week" || routeView === "month") {
      const dateISO = routeDateISO || String(currentDateISO ?? "").trim();
      router.push({
        pathname: routeView === "week" ? "/(athlete)/week" : "/(athlete)/month",
        params: dateISO ? { date: dateISO } : undefined,
      });
      return;
    }

    const saved = await loadJSON<AthleteCalendarViewState>(ATHLETE_CALENDAR_VIEW_STATE_KEY, {});
    const view = saved?.view === "week" ? "week" : "month";
    const dateISO = String(saved?.dateISO ?? "").trim() || String(currentDateISO ?? "").trim();
    router.push({
      pathname: view === "week" ? "/(athlete)/week" : "/(athlete)/month",
      params: dateISO ? { date: dateISO } : undefined,
    });
  }

  function buildWorkoutReturnTo(dateISO: string) {
    const params: string[] = [];
    appendRouteParam(params, "date", dateISO);
    appendRouteParam(params, "returnView", returnView);
    appendRouteParam(params, "returnDate", returnDate);
    return `/(athlete)/day?${params.join("&")}`;
  }

  function mileageFeedbackForSession(session: "AM" | "PM") {
    return mileageFeedbackEntries.find((entry) => String(entry.dateISO ?? "") === String(currentDateISO) && normalizeSession(entry.session) === session);
  }

  function openEditorForSession(input: {
    session: "AM" | "PM";
    prescribed: string;
    workout?: AthleteWorkout;
  }) {
    const mileageFeedback = mileageFeedbackForSession(input.session);
    const workout = input.workout;
    setEditorError(null);
    setEditor({
      dateISO: String(currentDateISO),
      session: input.session,
      prescribed: input.prescribed,
      workout,
      mileageFeedback,
      planSummary: input.prescribed ? `Mileage: ${formatPrescribedLabel(input.prescribed)}` : "",
      completedMilesText:
        workout?.completedMiles != null
          ? String(workout.completedMiles)
          : mileageFeedback?.completedMiles != null
            ? String(mileageFeedback.completedMiles)
            : "",
      completedTimeText: String(workout?.completedTime ?? mileageFeedback?.completedTime ?? ""),
      splitsText: String(workout?.splitsOrPace ?? mileageFeedback?.splitsOrPace ?? ""),
      additionalFeedbackText: String(workout?.additionalFeedback ?? workout?.feedback ?? mileageFeedback?.additionalFeedback ?? ""),
    });
  }

  async function saveEditor() {
    if (!editor) return;
    const completedMilesRaw = editor.completedMilesText.trim();
    const completedTimeText = editor.completedTimeText.trim();
    const splitsText = editor.splitsText.trim();
    const additionalFeedbackText = editor.additionalFeedbackText.trim();
    const parsedCompletedMiles = completedMilesRaw ? parseNumericLike(completedMilesRaw) : undefined;

    if (completedMilesRaw && parsedCompletedMiles == null) {
      setEditorError("Distance must be a number, like 5 or 5.25.");
      return;
    }
    if (parsedCompletedMiles != null && !/^\d+(\.\d{1,2})?$/.test(completedMilesRaw)) {
      setEditorError("Distance can use up to two decimals.");
      return;
    }
    if (parsedCompletedMiles == null && !completedTimeText) {
      setEditorError("Enter either distance completed or time completed before saving.");
      return;
    }

    setEditorSaving(true);
    setEditorError(null);
    try {
      const workout = editor.workout;
      if (workout) {
        await updateOwnWorkoutFeedbackById(workout.id, String(workout.athleteId ?? selectedAthleteId ?? ""), {
          completed_miles: parsedCompletedMiles ?? null,
          completed_time_text: completedTimeText || null,
          splits_or_pace: splitsText || null,
          additional_feedback: additionalFeedbackText || null,
        });
        const updateWorkout = (item: AthleteWorkout): AthleteWorkout =>
          item.id === workout.id
            ? {
                ...item,
                completedMiles: parsedCompletedMiles,
                completedTime: completedTimeText || undefined,
                splitsOrPace: splitsText || undefined,
                additionalFeedback: additionalFeedbackText || undefined,
                feedback: additionalFeedbackText || undefined,
              }
            : item;
        setWorkouts((prev) => prev.map(updateWorkout));
        setAllWorkouts((prev) => prev.map(updateWorkout));
      } else {
        const entry: MileageSessionFeedback = {
          id: buildMileageFeedbackId({
            athleteId: String(selectedAthleteId ?? "") || undefined,
            athleteName: String(selectedAthleteName ?? "") || undefined,
            dateISO: editor.dateISO,
            session: editor.session,
          }),
          athleteId: String(selectedAthleteId ?? "") || undefined,
          athleteName: String(selectedAthleteName ?? "") || undefined,
          dateISO: editor.dateISO,
          session: editor.session,
          prescribed: editor.prescribed || undefined,
          completedMiles: parsedCompletedMiles,
          completedTime: completedTimeText || undefined,
          splitsOrPace: splitsText || undefined,
          additionalFeedback: additionalFeedbackText || undefined,
          updatedAt: Date.now(),
        };
        await upsertMileageFeedback(entry);
        setMileageFeedbackEntries((prev) => [...prev.filter((item) => item.id !== entry.id), entry]);
      }

      setEditor(null);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not save log.");
      setEditorError(message);
      Alert.alert("Save failed", message);
    } finally {
      setEditorSaving(false);
    }
  }

  const translateX = useSharedValue(0);
  const pan = Gesture.Pan()
    .maxPointers(1)
    .onChange((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      const threshold = 70;
      if (e.translationX > threshold) runOnJS(navigateDay)(-1);
      else if (e.translationX < -threshold) runOnJS(navigateDay)(1);
      translateX.value = withSpring(0);
    });
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  if (!currentDateISO) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <Text>No date provided</Text>
      </View>
    );
  }

  if (loadingContext) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 20 }}>
        <Text style={{ color: "#64748b", fontWeight: "700" }}>Loading daily view...</Text>
      </View>
    );
  }

  if (!selectedAthleteId) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 20 }}>
        <Text style={{ fontSize: 16, fontWeight: "700", marginBottom: 10 }}>No athlete selected</Text>
        <Text style={{ opacity: 0.7, textAlign: "center", marginBottom: 16 }}>
          Select an athlete to view workouts and submit logs.
        </Text>

        <Pressable
          onPress={() => router.push("/(athlete)")}
          style={{
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderRadius: 12,
            backgroundColor: "rgba(0,0,0,0.08)",
          }}
        >
          <Text style={{ fontWeight: "700" }}>Select Athlete</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16, backgroundColor: "#f6f8fb" }}>
      <View style={{ marginBottom: 6, position: "relative", justifyContent: "center", minHeight: 40 }}>
        <View style={{ position: "absolute", left: 0, right: 0, top: 0 }}>
          <PrevNextNavButtons onPrev={() => navigateDay(-1)} onNext={() => navigateDay(1)} size={36} spread />
        </View>
        <View style={{ alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "800", letterSpacing: 0.6, color: "#64748b" }}>TODAY</Text>
          <Text style={{ marginTop: 2, fontSize: 22, fontWeight: "900", color: "#0f172a", textAlign: "center" }}>
            {formatDisplayDate(String(currentDateISO ?? ""))}
          </Text>
          {isTodayISO(String(currentDateISO ?? "")) ? (
            <View
              style={{
                marginTop: 8,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 999,
                backgroundColor: "#e0f2fe",
                borderWidth: 1,
                borderColor: "#bae6fd",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "900", color: "#0c4a6e" }}>Today</Text>
            </View>
          ) : null}
          {currentWeekLabelText ? (
            <View
              style={{
                marginTop: 8,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 999,
                backgroundColor: currentWeekLabelColors.bg,
                borderWidth: 1,
                borderColor: currentWeekLabelColors.border,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "900", color: currentWeekLabelColors.text }}>
                {currentWeekLabelText}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <Pressable
        onPress={() => {
          void goBackToCalendar();
        }}
        style={{
          alignSelf: "flex-start",
          marginTop: 2,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: "#dbe3ef",
          backgroundColor: "#f8fafc",
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 6,
        }}
      >
        <Text style={{ color: "#334155", fontSize: 12, fontWeight: "800" }}>Back to Calendar</Text>
      </Pressable>

      <GestureDetector gesture={pan}>
      <Animated.View style={[{ flex: 1 }, animatedStyle]}>
      <View
        style={{
          marginTop: 10,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: dayPlan?.ncaaOff ? "#b8d8ff" : "#dbeafe",
          backgroundColor: dayPlan?.ncaaOff ? "#eaf4ff" : "#ffffff",
          paddingVertical: 10,
          paddingHorizontal: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>DAILY SUMMARY</Text>
          {dayPlan?.ncaaOff ? <Text style={{ fontSize: 11, fontWeight: "900", color: "#0a5eb7" }}>NCAA Off Day</Text> : null}
        </View>
        <View style={{ marginTop: 8, flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1, borderRadius: 9, borderWidth: 1, borderColor: "#e2e8f0", backgroundColor: "#f8fafc", paddingVertical: 7, paddingHorizontal: 9 }}>
            <Text style={{ fontSize: 11, fontWeight: "900", color: "#475569" }}>AM</Text>
            <Text style={{ marginTop: 2, color: "#0f172a", fontWeight: "900" }}>{plannedAm || "—"}</Text>
          </View>
          <View style={{ flex: 1, borderRadius: 9, borderWidth: 1, borderColor: "#e2e8f0", backgroundColor: "#f8fafc", paddingVertical: 7, paddingHorizontal: 9 }}>
            <Text style={{ fontSize: 11, fontWeight: "900", color: "#475569" }}>PM</Text>
            <Text style={{ marginTop: 2, color: "#0f172a", fontWeight: "900" }}>{plannedPm || "—"}</Text>
          </View>
        </View>
        {plannedTotal ? (
          <Text style={{ marginTop: 8, color: "#334155", fontWeight: "700" }}>Distance goal: {plannedTotal}</Text>
        ) : null}
      </View>

      <FlatList
        data={sessionCards}
        keyExtractor={(item) => item.session}
        contentContainerStyle={{ paddingTop: 10, paddingBottom: 24, gap: 10 }}
        renderItem={({ item }) => (
          <View style={{ gap: 10 }}>
            {item.workouts.length === 0 && item.prescribed ? (
              <AthleteSessionCard
                session={item.session}
                title={`${item.session} Planned Session`}
                summary={`Prescribed mileage: ${formatPrescribedLabel(item.prescribed)}`}
                prescribed={formatPrescribedLabel(item.prescribed)}
                status={hasMileageFeedback(mileageFeedbackForSession(item.session) ?? {}) ? "submitted" : "missing"}
                actionLabel={hasMileageFeedback(mileageFeedbackForSession(item.session) ?? {}) ? "Edit log" : "Enter log"}
                onOpen={() =>
                  router.push({
                    pathname: "/(athlete)/workout/[id]",
                    params: {
                      id: `planned-${String(currentDateISO)}-${item.session}`,
                      synthetic: "1",
                      date: String(currentDateISO),
                      session: item.session,
                      prescribed: item.prescribed,
                      athleteId: selectedAthleteId ?? "",
                      name: selectedAthleteName,
                      returnTo: buildWorkoutReturnTo(String(currentDateISO)),
                    },
                  })
                }
                onLog={() => openEditorForSession({ session: item.session, prescribed: item.prescribed })}
              />
            ) : null}

            {item.workouts.map((workout) => {
              const peers = groupMatesByWorkoutId.get(workout.id) ?? [];
              const prescribed = item.session === "AM" ? dayPlan?.am : dayPlan?.pm;
              const prescribedLabel =
                formatPlannedDistanceLabel(workout.plannedMiles, workout.plannedDistanceUnit) ||
                formatPrescribedLabel(formatMileage(prescribed) || item.prescribed);
              const logged = hasWorkoutFeedback({
                completed_miles: workout.completedMiles,
                completed_time_text: workout.completedTime,
                splits_or_pace: workout.splitsOrPace,
                additional_feedback: workout.additionalFeedback ?? workout.feedback,
              });
              const status: AthleteSessionCardStatus = logged ? "submitted" : "missing";
              const feedbackSummary = feedbackSummaryFromWorkout(workout);
              const peerSummary = peers.length > 0 ? `With ${peers.length} teammate${peers.length === 1 ? "" : "s"}.` : "";
              return (
                <AthleteSessionCard
                  key={workout.id}
                  session={item.session}
                  title={workout.title || "Workout"}
                  summary={logged ? feedbackSummary || "Log submitted." : "Workout log needed."}
                  planSummary={peerSummary}
                  prescribed={prescribedLabel}
                  time={workout.time ?? null}
                  location={workout.location ?? null}
                  categories={workoutCategoryNames(workout)}
                  categoriesSource={categories}
                  batchDetails={batchNotesByWorkoutId.get(String(workout.id)) ?? ""}
                  individualDetails={
                    cleanDisplayText(workout.details) === cleanDisplayText(batchNotesByWorkoutId.get(String(workout.id)))
                      ? ""
                      : cleanDisplayText(workout.details)
                  }
                  preRoutineTitles={getRoutineTitles(workout.preRoutineIds, routineById)}
                  postRoutineTitles={getRoutineTitles(workout.postRoutineIds, routineById)}
                  status={status}
                  actionLabel={logged ? "Edit log" : "Enter log"}
                  onOpen={() =>
                    router.push({
                      pathname: "/(athlete)/workout/[id]",
                      params: {
                        id: workout.id,
                        name: selectedAthleteName,
                        returnTo: buildWorkoutReturnTo(String(currentDateISO)),
                      },
                    })
                  }
                  onLog={() => openEditorForSession({ session: item.session, prescribed: prescribedLabel, workout })}
                />
              );
            })}
          </View>
        )}
        ListEmptyComponent={
          <View
            style={{
              borderRadius: 12,
              borderWidth: 1,
              borderColor: "#e2e8f0",
              backgroundColor: "#fff",
              padding: 12,
            }}
          >
            <Text style={{ color: "#475569", fontWeight: "700" }}>No planned sessions or workouts for this day.</Text>
          </View>
        }
      />
      </Animated.View>
      </GestureDetector>
      <AthleteQuickFeedbackSheet
        visible={Boolean(editor)}
        title={editor ? `${editor.session} Log` : "Log"}
        subtitle={formatDisplayDate(String(currentDateISO))}
        planSummary={editor?.planSummary ?? ""}
        completedMilesText={editor?.completedMilesText ?? ""}
        completedTimeText={editor?.completedTimeText ?? ""}
        splitsText={editor?.splitsText ?? ""}
        additionalFeedbackText={editor?.additionalFeedbackText ?? ""}
        saving={editorSaving}
        error={editorError}
        onChangeCompletedMiles={(text) => setEditor((prev) => (prev ? { ...prev, completedMilesText: text } : prev))}
        onChangeCompletedTime={(text) => setEditor((prev) => (prev ? { ...prev, completedTimeText: text } : prev))}
        onChangeSplits={(text) => setEditor((prev) => (prev ? { ...prev, splitsText: text } : prev))}
        onChangeAdditionalFeedback={(text) => setEditor((prev) => (prev ? { ...prev, additionalFeedbackText: text } : prev))}
        onCancel={() => {
          if (!editorSaving) setEditor(null);
        }}
        onSave={() => void saveEditor()}
      />
    </View>
  );
}
