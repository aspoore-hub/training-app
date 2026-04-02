import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { MaterialIcons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { loadJSON, saveJSON } from "../../lib/storage";
import { getCurrentTeamId, getMyClaimedAthleteProfileId, getTeamAthlete } from "../../lib/team";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../lib/pace";
import { loadAthletePaceOverrides, resolveAthletePaceSeconds, type AthletePaceOverrides } from "../../lib/athletePace";
import type { AthleteWorkout, MileageValue, WeekStartDay, WorkoutCategory } from "../../lib/types";
import { CATEGORIES_KEY, categoryColorByName, normalizeCategories } from "../../lib/categories";
import { getWeekStartISO, getWeekIndex, parseMileageInput, parseISODate, toISODate, formatMileage, sumMileage } from "../../lib/mileagePlan";
import { loadMileageFeedback, type MileageSessionFeedback } from "../../lib/mileageFeedback";
import { loadFeedbackFlagSettings, type FeedbackWarningMode } from "../../lib/feedbackFlags";
import { listAthleteWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../lib/teamDataStore";
import { loadWeekStartSetting } from "../../lib/settings";
import { SegmentedViewToggle } from "../../components/shared/SegmentedViewToggle";

const SELECTED_KEY = "training_app_selected_athlete_v1";
const ATHLETE_MONTH_UI_STATE_KEY = "training_app_athlete_month_ui_state_v1";
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_W = SCREEN_WIDTH;

type MonthCell = {
  dateISO: string;
  dayNumber: number;
  inMonth: boolean;
};

type AthleteMonthUiState = {
  anchorMonthISO?: string;
  selectedDateISO?: string;
};

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function isISODateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
}

function addDaysISO(dateISO: string, days: number) {
  const d = parseISODate(dateISO);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function isDateWithinWarningWindow(
  dateISO: string,
  todayISO: string,
  mode: FeedbackWarningMode,
  startDateISO?: string
) {
  if (!dateISO || dateISO >= todayISO) return false;

  if (mode === "all") return true;

  if (mode === "last_7_days") {
    const lower = addDaysISO(todayISO, -7);
    return dateISO >= lower;
  }

  if (mode === "last_14_days") {
    const lower = addDaysISO(todayISO, -14);
    return dateISO >= lower;
  }

  if (mode === "previous_month") {
    const today = parseISODate(todayISO);
    const firstCurrent = toISODate(new Date(today.getFullYear(), today.getMonth(), 1));
    const prevEndISO = addDaysISO(firstCurrent, -1);
    const prevEnd = parseISODate(prevEndISO);
    const prevStartISO = toISODate(new Date(prevEnd.getFullYear(), prevEnd.getMonth(), 1));
    return dateISO >= prevStartISO && dateISO <= prevEndISO;
  }

  const start = String(startDateISO ?? "").trim();
  if (!start) return false;
  return dateISO >= start && dateISO < todayISO;
}


function toMileageValue(raw: unknown): MileageValue | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return parseMileageInput(raw);
  if (typeof raw === "number") return { kind: "exact", value: raw };
  if (typeof raw === "object") return raw as MileageValue;
  return undefined;
}

function workoutCategoryNames(w: AthleteWorkout): string[] {
  const arr = Array.isArray((w as any)?.categories)
    ? (w as any).categories
    : [(w as any)?.category ?? (w as any)?.categoryName ?? "Other"];
  const cleaned = arr.map((x: any) => String(x ?? "").trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["Other"];
}

type SecRange = { min: number; max: number };

function xtRangeForValue(v: MileageValue | undefined): SecRange {
  if (!v || typeof v !== "object") return { min: 0, max: 0 };
  const kind = (v as any).kind;

  if (kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    if (options.length !== 2) return { min: 0, max: 0 };
    const a = xtRangeForValue(options[0]);
    const b = xtRangeForValue(options[1]);
    return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
  }

  const xt = !!(v as any).xt;
  if (!xt) return { min: 0, max: 0 };

  if (kind === "time") {
    const sec = Number((v as any).seconds ?? 0);
    return Number.isFinite(sec) ? { min: sec, max: sec } : { min: 0, max: 0 };
  }
  if (kind === "timeRange") {
    const a = Number((v as any).minSeconds ?? 0);
    const b = Number((v as any).maxSeconds ?? 0);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: 0, max: 0 };
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return { min: 0, max: 0 };
}

function formatRoundedRange(min: number, max: number): string {
  const a = Math.round(min);
  const b = Math.round(max);
  if (a === 0 && b === 0) return "";
  if (a === b) return String(a);
  return `${a}-${b}`;
}

function hasSessionAssignment(v: MileageValue | undefined): boolean {
  if (!v || typeof v !== "object") return false;
  const kind = (v as any).kind;

  if (kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    return options.some((option: MileageValue) => hasSessionAssignment(option));
  }

  if (kind === "exact") return Number((v as any).value) > 0;
  if (kind === "range") {
    const min = Number((v as any).min) || 0;
    const max = Number((v as any).max) || 0;
    return min > 0 || max > 0;
  }

  if (kind === "time") {
    const sec = Number((v as any).seconds) || 0;
    return sec > 0;
  }
  if (kind === "timeRange") {
    const min = Number((v as any).minSeconds) || 0;
    const max = Number((v as any).maxSeconds) || 0;
    return min > 0 || max > 0;
  }

  // Unknown/empty payloads are treated as no assignment.
  return false;
}

function buildMonthGrid(anchor: Date, weekStartsOn: WeekStartDay): MonthCell[] {
  const firstOfMonth = monthStart(anchor);
  const firstDay = firstOfMonth.getDay(); // 0 Sun..6 Sat
  const startIndex = (firstDay - weekStartsOn + 7) % 7; // 0 means already on week start

  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(firstOfMonth.getDate() - startIndex);

  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push({
      dateISO: toISODate(d),
      dayNumber: d.getDate(),
      inMonth: d.getMonth() === anchor.getMonth(),
    });
  }

  return cells;
}

function toAthleteWorkout(row: TeamWorkoutRow, athleteName: string): AthleteWorkout {
  return {
    id: String(row.id),
    athleteId: String(row.athlete_profile_id ?? "").trim(),
    athleteName,
    batchId: row.batch_id ?? undefined,
    groupId: row.group_id ?? undefined,
    dateISO: String(row.date_iso),
    session: row.session === "AM" ? "AM" : "PM",
    time: row.time_text ?? undefined,
    preRoutineIds: row.pre_routine_ids ?? undefined,
    postRoutineIds: row.post_routine_ids ?? undefined,
    category: String(row.primary_category ?? "Other"),
    categories: row.categories ?? undefined,
    title: row.title ?? "Workout",
    details: row.details ?? undefined,
    completedMiles: typeof (row as any).completed_miles === "number" ? (row as any).completed_miles : undefined,
    completedTime: String((row as any).completed_time_text ?? "").trim() || undefined,
    splitsOrPace: String((row as any).splits_or_pace ?? "").trim() || undefined,
    additionalFeedback: String((row as any).additional_feedback ?? "").trim() || undefined,
    feedback: String((row as any).additional_feedback ?? "").trim() || undefined,
  };
}

export default function AthleteMonthCalendar() {
  const router = useRouter();
  const store = teamDataStore.use();
  const { name } = useLocalSearchParams<{ name?: string }>();
  const athleteName = name ?? "";
  const todayISO = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;
  }, []);

  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [, setSelectedAthleteLabel] = useState<string | null>(null);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [allWorkouts, setAllWorkouts] = useState<AthleteWorkout[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [anchorMonth, setAnchorMonth] = useState(() => monthStart(new Date()));
  const [selectedDateISO, setSelectedDateISO] = useState<string>(toISODate(new Date()));
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [athletePaceOverrides, setAthletePaceOverrides] = useState<AthletePaceOverrides>({});
  const [mileageFeedbackEntries, setMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [feedbackFlagsEnabled, setFeedbackFlagsEnabled] = useState(false);
  const [feedbackWarningMode, setFeedbackWarningMode] = useState<FeedbackWarningMode>("all");
  const [feedbackStartDateISO, setFeedbackStartDateISO] = useState<string | undefined>(undefined);
  const [monthUiHydrated, setMonthUiHydrated] = useState(false);

  const loadMonthWeekStartFromShared = useCallback(async () => {
    const weekStartResult = await loadWeekStartSetting();
    const normalized: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
    console.log("[athlete-month] week start loaded via shared helper", {
      raw: weekStartResult.raw,
      normalized,
    });
    setWeekStartsOn(normalized);
    return normalized;
  }, []);

  const loadMonthData = useCallback(async () => {
    const ws = await loadMonthWeekStartFromShared();
    const [
      selected,
      storedCategories,
      pace,
      paceOverrides,
      feedbackEntries,
      flagSettings,
    ] = await Promise.all([
      loadJSON<string | null>(SELECTED_KEY, null),
      loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
      loadPaceSecondsPerMile(),
      loadAthletePaceOverrides(),
      loadMileageFeedback(),
      loadFeedbackFlagSettings(),
    ]);

    const teamId = await getCurrentTeamId();
    const claimedAthleteId = await getMyClaimedAthleteProfileId(teamId);
    const selectedId = String(claimedAthleteId ?? selected ?? "").trim();
    setSelectedAthleteId(selectedId || null);

    // Optional: fetch the athlete label from Supabase so UI shows the right name
    let selectedName: string | null = null;
    if (selectedId) {
      try {
        const a = await getTeamAthlete(selectedId);
        selectedName = a?.display_name ?? null;
        setSelectedAthleteLabel(selectedName);
      } catch {
        setSelectedAthleteLabel(null);
      }
    } else {
      setSelectedAthleteLabel(null);
    }

    setCategories(normalizeCategories(storedCategories));
    setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
    setAthletePaceOverrides(paceOverrides ?? {});
    setMileageFeedbackEntries(feedbackEntries ?? []);
    setFeedbackFlagsEnabled(!!flagSettings.enabled);
    setFeedbackWarningMode(flagSettings.mode ?? "all");
    setFeedbackStartDateISO(flagSettings.startDateISO);

    if (!selectedId) {
      setAllWorkouts([]);
      return;
    }

    const grid = buildMonthGrid(anchorMonth, ws);
    const weekStarts = Array.from(new Set(grid.map((cell) => getWeekStartISO(cell.dateISO, ws))));
    await Promise.all(weekStarts.map((weekStartISO) => teamDataStore.actions.loadMileageWeek(weekStartISO)));

    const startISO = grid[0]?.dateISO ?? toISODate(monthStart(anchorMonth));
    const endISO = grid[grid.length - 1]?.dateISO ?? startISO;
    const rows = await listAthleteWorkoutsInRange(selectedId, startISO, endISO);
    const resolvedAthleteName = selectedName ?? athleteName ?? "Athlete";
    setAllWorkouts(rows.map((row) => toAthleteWorkout(row, resolvedAthleteName)));
  }, [anchorMonth, athleteName, loadMonthWeekStartFromShared]);

  useEffect(() => {
    loadMonthData();
  }, [loadMonthData]);

  useFocusEffect(
    useCallback(() => {
      loadMonthData();
    }, [loadMonthData])
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const saved = await loadJSON<AthleteMonthUiState>(ATHLETE_MONTH_UI_STATE_KEY, {});
      if (!mounted) return;
      const savedAnchor = String(saved?.anchorMonthISO ?? "").trim();
      const savedSelected = String(saved?.selectedDateISO ?? "").trim();

      if (isISODateOnly(savedAnchor)) {
        const parsed = parseISODate(savedAnchor);
        if (!Number.isNaN(parsed.getTime())) setAnchorMonth(monthStart(parsed));
      }
      if (isISODateOnly(savedSelected)) setSelectedDateISO(savedSelected);
      setMonthUiHydrated(true);
    })().catch(() => {
      if (mounted) setMonthUiHydrated(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!monthUiHydrated) return;
    const anchorMonthISO = toISODate(monthStart(anchorMonth));
    const selectedISO = String(selectedDateISO ?? "").trim();
    void saveJSON<AthleteMonthUiState>(ATHLETE_MONTH_UI_STATE_KEY, {
      anchorMonthISO,
      selectedDateISO: isISODateOnly(selectedISO) ? selectedISO : undefined,
    });
  }, [anchorMonth, monthUiHydrated, selectedDateISO]);

  const monthCells = useMemo(() => buildMonthGrid(anchorMonth, weekStartsOn), [anchorMonth, weekStartsOn]);
  const monthRows = useMemo(() => {
    const rows: MonthCell[][] = [];
    for (let i = 0; i < monthCells.length; i += 7) {
      rows.push(monthCells.slice(i, i + 7));
    }
    return rows;
  }, [monthCells]);

  const monthLabel = useMemo(
    () =>
      anchorMonth.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      }),
    [anchorMonth]
  );

  const weekdayLabels = useMemo(() => {
    const arr: string[] = [];
    for (let i = 0; i < 7; i++) {
      arr.push(WEEKDAY_LABELS[(weekStartsOn + i) % 7]);
    }
    return arr;
  }, [weekStartsOn]);

  const shiftMonth = useCallback((delta: number) => {
    setAnchorMonth((prev) => addMonths(prev, delta));
  }, []);

  const translateX = useSharedValue(0);

  const commitSwipe = useCallback(
    (direction: "prev" | "next") => {
      const delta = direction === "prev" ? -1 : 1;

      translateX.value = withTiming(
        direction === "prev" ? SCREEN_W : -SCREEN_W,
        { duration: 140 },
        (finished) => {
          if (finished) {
            runOnJS(shiftMonth)(delta);
            translateX.value = 0;
          }
        }
      );
    },
    [shiftMonth]
  );

  const pan = Gesture.Pan()
    .onChange((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      const threshold = SCREEN_W * 0.22;

      if (e.translationX > threshold) {
        runOnJS(shiftMonth)(-1);
      } else if (e.translationX < -threshold) {
        runOnJS(shiftMonth)(1);
      }

      translateX.value = withSpring(0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const visibleDayPlanByDate = useMemo(() => {
    const map = new Map<string, { am: MileageValue | undefined; pm: MileageValue | undefined; ncaaOff: boolean }>();
    if (!selectedAthleteId) return map;

    for (const cell of monthCells) {
      const weekStartISO = getWeekStartISO(cell.dateISO, weekStartsOn);
      const idx = getWeekIndex(cell.dateISO, weekStartISO);
      if (idx < 0 || idx > 6) continue;
      const rows = store.mileageCellsByWeek[weekStartISO] ?? [];
      const flags = store.mileageFlagsByWeek[weekStartISO] ?? [];
      const am = toMileageValue(
        rows.find(
          (row) =>
            String(row.athlete_profile_id) === String(selectedAthleteId) &&
            row.day_idx === idx &&
            row.session === "AM"
        )?.value
      );
      const pm = toMileageValue(
        rows.find(
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
      map.set(cell.dateISO, { am, pm, ncaaOff });
    }

    return map;
  }, [monthCells, selectedAthleteId, store.mileageCellsByWeek, store.mileageFlagsByWeek, weekStartsOn]);

  const effectivePaceSecPerMile = useMemo(
    () => resolveAthletePaceSeconds(selectedAthleteId, athletePaceOverrides, paceSecPerMile),
    [selectedAthleteId, athletePaceOverrides, paceSecPerMile]
  );

  const workoutDotColorsByDate = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const w of allWorkouts) {
      const dateISO = String((w as any)?.dateISO ?? (w as any)?.date ?? "");
      if (!dateISO) continue;
      const wAthleteId = String((w as any)?.athleteId ?? "").trim();
      if (!selectedAthleteId || wAthleteId !== selectedAthleteId) continue;

      const existing = map.get(dateISO) ?? [];
      for (const categoryName of workoutCategoryNames(w)) {
        const normalized = String(categoryName ?? "").trim().toLowerCase();
        // Off-category days use cell highlight instead of an Off dot.
        if (normalized === "off" || normalized === "off / rest" || normalized === "rest") continue;
        const color = categoryColorByName(categories, categoryName);
        if (!existing.includes(color)) existing.push(color);
      }
      map.set(dateISO, existing);
    }
    return map;
  }, [allWorkouts, categories, selectedAthleteId]);

  const dayTotalsByDate = useMemo(() => {
    const map = new Map<string, { distanceLabel: string; xtLabel: string }>();
    for (const cell of monthCells) {
      const day = visibleDayPlanByDate.get(cell.dateISO);
      const am = day?.am;
      const pm = day?.pm;

      const milesSum = sumMileage([am, pm], effectivePaceSecPerMile);
      const distanceLabel = formatRoundedRange(milesSum.min, milesSum.max);

      const amXt = xtRangeForValue(am);
      const pmXt = xtRangeForValue(pm);
      const xtMin = (amXt.min + pmXt.min) / 60;
      const xtMax = (amXt.max + pmXt.max) / 60;
      const xtCore = formatRoundedRange(xtMin, xtMax);
      const xtLabel = xtCore;

      map.set(cell.dateISO, { distanceLabel, xtLabel });
    }
    return map;
  }, [monthCells, visibleDayPlanByDate, effectivePaceSecPerMile]);

  const workoutCountByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const w of allWorkouts) {
      const dateISO = String((w as any)?.dateISO ?? (w as any)?.date ?? "");
      if (!dateISO) continue;
      const wAthleteId = String((w as any)?.athleteId ?? "").trim();
      if (!selectedAthleteId || wAthleteId !== selectedAthleteId) continue;
      map.set(dateISO, (map.get(dateISO) ?? 0) + 1);
    }
    return map;
  }, [allWorkouts, selectedAthleteId]);

  const offWorkoutDates = useMemo(() => {
    const dates = new Set<string>();
    for (const workout of allWorkouts) {
      const dateISO = String((workout as any)?.dateISO ?? "");
      if (!dateISO) continue;
      const workoutAthleteId = String((workout as any)?.athleteId ?? "").trim();
      if (!selectedAthleteId || workoutAthleteId !== selectedAthleteId) continue;

      const names = workoutCategoryNames(workout).map((name) => String(name ?? "").trim().toLowerCase());
      if (names.some((name) => name === "off" || name === "off / rest" || name === "rest")) {
        dates.add(dateISO);
      }
    }
    return dates;
  }, [allWorkouts, selectedAthleteId]);

  const missingFeedbackByDate = useMemo(() => {
    if (!feedbackFlagsEnabled || !selectedAthleteId) return new Set<string>();

    const missing = new Set<string>();
    const ncaaOffDates = new Set<string>();

    for (const cell of monthCells) {
      const dateISO = cell.dateISO;
      if (!isDateWithinWarningWindow(dateISO, todayISO, feedbackWarningMode, feedbackStartDateISO)) continue;
      if (visibleDayPlanByDate.get(dateISO)?.ncaaOff) ncaaOffDates.add(dateISO);
    }

    const workoutSessions = new Map<string, { hasAM: boolean; hasPM: boolean; fbAM: boolean; fbPM: boolean }>();
    for (const workout of allWorkouts) {
      const dateISO = String((workout as any)?.dateISO ?? "");
      if (!dateISO || !isDateWithinWarningWindow(dateISO, todayISO, feedbackWarningMode, feedbackStartDateISO)) continue;

      const workoutAthleteId = String((workout as any)?.athleteId ?? "").trim();
      if (!selectedAthleteId || workoutAthleteId !== selectedAthleteId) continue;

      const session = String((workout as any)?.session ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
      const state = workoutSessions.get(dateISO) ?? { hasAM: false, hasPM: false, fbAM: false, fbPM: false };
      if (session === "AM") state.hasAM = true;
      if (session === "PM") state.hasPM = true;

      const hasFeedback =
        typeof (workout as any)?.completedMiles === "number" ||
        String((workout as any)?.completedTime ?? "").trim().length > 0 ||
        String((workout as any)?.splitsOrPace ?? "").trim().length > 0 ||
        String((workout as any)?.additionalFeedback ?? "").trim().length > 0 ||
        String((workout as any)?.feedback ?? "").trim().length > 0;

      if (hasFeedback && session === "AM") state.fbAM = true;
      if (hasFeedback && session === "PM") state.fbPM = true;

      workoutSessions.set(dateISO, state);
    }

    const mileageFeedbackBySession = new Map<string, { fbAM: boolean; fbPM: boolean }>();
    for (const entry of mileageFeedbackEntries) {
      const entryAthleteId = String((entry as any)?.athleteId ?? "").trim();
      if (!selectedAthleteId || entryAthleteId !== selectedAthleteId) continue;
      const dateISO = String(entry.dateISO ?? "");
      if (!dateISO || !isDateWithinWarningWindow(dateISO, todayISO, feedbackWarningMode, feedbackStartDateISO)) continue;

      const hasFeedback =
        typeof entry.completedMiles === "number" ||
        String(entry.completedTime ?? "").trim().length > 0 ||
        String(entry.splitsOrPace ?? "").trim().length > 0 ||
        String(entry.additionalFeedback ?? "").trim().length > 0;
      if (!hasFeedback) continue;

      const state = mileageFeedbackBySession.get(dateISO) ?? { fbAM: false, fbPM: false };
      const session = String(entry.session ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
      if (session === "AM") state.fbAM = true;
      if (session === "PM") state.fbPM = true;
      mileageFeedbackBySession.set(dateISO, state);
    }

    for (const cell of monthCells) {
      const dateISO = cell.dateISO;
      if (!isDateWithinWarningWindow(dateISO, todayISO, feedbackWarningMode, feedbackStartDateISO)) continue;
      const day = visibleDayPlanByDate.get(dateISO);
      const isNCAAOffDay = !!day?.ncaaOff;
      if (isNCAAOffDay) continue;
      const hasPlannedAM = String(formatMileage(day?.am)).trim().length > 0;
      const hasPlannedPM = String(formatMileage(day?.pm)).trim().length > 0;

      const wState = workoutSessions.get(dateISO) ?? { hasAM: false, hasPM: false, fbAM: false, fbPM: false };
      const mState = mileageFeedbackBySession.get(dateISO) ?? { fbAM: false, fbPM: false };

      const requiresAM = hasPlannedAM || wState.hasAM;
      const requiresPM = hasPlannedPM || wState.hasPM;

      const hasAMFeedback = wState.fbAM || mState.fbAM;
      const hasPMFeedback = wState.fbPM || mState.fbPM;

      if (ncaaOffDates.has(dateISO)) continue;

      if ((requiresAM && !hasAMFeedback) || (requiresPM && !hasPMFeedback)) {
        missing.add(dateISO);
      }
    }

    // Also include days with created workouts but no mileage-plan row for the week.
    for (const [dateISO, wState] of workoutSessions.entries()) {
      if (!isDateWithinWarningWindow(dateISO, todayISO, feedbackWarningMode, feedbackStartDateISO)) continue;
      if (ncaaOffDates.has(dateISO)) continue;
      const needs = (wState.hasAM && !wState.fbAM) || (wState.hasPM && !wState.fbPM);
      if (needs) missing.add(dateISO);
    }

    return missing;
  }, [
    allWorkouts,
    feedbackFlagsEnabled,
    feedbackStartDateISO,
    feedbackWarningMode,
    mileageFeedbackEntries,
    monthCells,
    selectedAthleteId,
    todayISO,
    visibleDayPlanByDate,
  ]);

  return (
    <View style={styles.container}>
      <SegmentedViewToggle
        activeKey="month"
        items={[
          { key: "month", label: "Monthly", onPress: () => {} },
          { key: "week", label: "Weekly", onPress: () => router.push("/(athlete)/week") },
        ]}
      />

      <View style={styles.headerRow}>
        <Pressable onPress={() => commitSwipe("prev")} style={styles.monthNavButton}>
          <Text style={styles.monthNavButtonText}>◀</Text>
        </Pressable>
        <Text style={styles.monthLabel}>{monthLabel}</Text>
        <Pressable onPress={() => commitSwipe("next")} style={styles.monthNavButton}>
          <Text style={styles.monthNavButtonText}>▶</Text>
        </Pressable>
      </View>

      {!selectedAthleteId ? (
        <View style={{ padding: 16, borderRadius: 14, backgroundColor: "#fff6e6", marginBottom: 12 }}>
          <Text style={{ fontWeight: "800", marginBottom: 6 }}>No athlete selected</Text>
          <Text style={{ opacity: 0.75, marginBottom: 10 }}>
            Pick an athlete to view the calendar and submit feedback.
          </Text>
          <Pressable
            onPress={() => router.push("/(athlete)")}
            style={{ paddingVertical: 10, borderRadius: 12, alignItems: "center", backgroundColor: "white", borderWidth: 1, borderColor: "#e6d3a8" }}
          >
            <Text style={{ fontWeight: "800" }}>Select Athlete</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.weekdayRow}>
        {weekdayLabels.map((label, index) => (
          <View key={label} style={[styles.headerCell, index < 6 && styles.headerCellGapRight]}>
            <Text style={styles.headerText}>{label}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.browseHint}>Tap any day to open the daily view</Text>
      <View style={styles.xtLegendRow}>
        <Ionicons name="bicycle-outline" size={12} color="#6b7280" />
        <Text style={styles.xtLegendText}>Cross-training minutes</Text>
      </View>

      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.gridWrap, animatedStyle]}>
          <View style={styles.grid}>
            {monthRows.map((row, rowIndex) => (
              <View key={`row-${rowIndex}`} style={styles.weekRow}>
                <>
                  {row.map((cell, cellIndex) => {
                        const iso = cell.dateISO;

                        // Monthly-only compact display:
                        // - XT session => "XT"
                        // - Otherwise show miles only (time converted via coach pace)
                        const needsFeedback = missingFeedbackByDate.has(iso);
                        const isToday = iso === todayISO;
                        const isOffWorkoutDay = offWorkoutDates.has(iso);
                        const hasMeaningfulSignal = needsFeedback;
                        const recordedDots = workoutDotColorsByDate.get(iso) ?? [];
                        const day = visibleDayPlanByDate.get(iso);
                        const hasAMAssigned = hasSessionAssignment(day?.am);
                        const hasPMAssigned = hasSessionAssignment(day?.pm);
                        const assignedSessionCount = (hasAMAssigned ? 1 : 0) + (hasPMAssigned ? 1 : 0);
                        const totals = dayTotalsByDate.get(iso);
                        const distanceLabel = String(totals?.distanceLabel ?? "");
                        const xtLabel = String(totals?.xtLabel ?? "");
                        const signalStyle = styles.signalFeedback;

                        return (
                          <Pressable
                            key={cell.dateISO}
                            onPress={() => {
                              setSelectedDateISO(iso);
                              router.push({
                                pathname: "/(athlete)/day",
                                params: { date: iso },
                              });
                            }}
                            style={({ pressed }) => [
                              styles.cell,
                              cellIndex < 6 && styles.cellGapRight,
                              styles.emptyCell,
                              isOffWorkoutDay && styles.offDayCell,
                              !cell.inMonth && styles.dayCellOutsideMonth,
                              isToday && styles.todayCell,
                              pressed && styles.cellPressed,
                            ]}
                          >
                            <View style={styles.dayTopRow}>
                              <Text style={[styles.dayNumber, !cell.inMonth && styles.dayNumberOutsideMonth]}>
                                {cell.dayNumber}
                              </Text>
                              {assignedSessionCount > 0 ? (
                                <View style={styles.sessionCountBadge}>
                                  <Text style={styles.sessionCountText}>{assignedSessionCount}</Text>
                                </View>
                              ) : null}
                            </View>

                            <View style={styles.cellSignalRow}>
                              {hasMeaningfulSignal ? <View style={[styles.activityDot, signalStyle]} /> : null}
                              {recordedDots.length > 0 ? (
                                <View style={styles.dotRow}>
                                  {recordedDots.map((color, i) => (
                                    <View key={`${iso}-dot-${i}-${color}`} style={[styles.workoutDot, { backgroundColor: color }]} />
                                  ))}
                                </View>
                              ) : null}
                            </View>
                            {distanceLabel ? (
                              <View style={styles.distanceInlineRow}>
                                <MaterialIcons name="directions-run" size={10} color="#6b7280" />
                                <Text style={styles.totalLabel}>{distanceLabel}</Text>
                              </View>
                            ) : null}
                            {xtLabel ? (
                              <View style={styles.xtInlineRow}>
                                <Ionicons name="bicycle-outline" size={11} color="#6b7280" />
                                <Text style={styles.xtInlineText}>{xtLabel}</Text>
                              </View>
                            ) : null}
                          </Pressable>
                        );
                      })}
                </>
              </View>
            ))}
          </View>
        </Animated.View>
      </GestureDetector>

      <Text style={styles.subtitle}>Swipe left/right to change month</Text>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 14,
    backgroundColor: "#ffffff",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  monthNavButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#e2e2e2",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fafafa",
  },
  monthNavButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#222",
  },
  monthLabel: {
    fontSize: 20,
    fontWeight: "800",
    color: "#111",
    textAlign: "center",
  },
  subtitle: {
    color: "#5a5a5a",
    marginTop: 10,
    marginBottom: 8,
    textAlign: "center",
  },
  viewToggleRow: {
    flexDirection: "row",
    alignSelf: "center",
    borderWidth: 1,
    borderColor: "#e1e1e1",
    borderRadius: 999,
    backgroundColor: "#f7f7f7",
    padding: 4,
    marginBottom: 10,
    gap: 6,
  },
  viewTogglePill: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  viewTogglePillActive: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  viewToggleText: {
    fontWeight: "800",
    color: "#666",
  },
  viewToggleTextActive: {
    color: "#111",
  },
  weekdayRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  headerCell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
  },
  headerCellGapRight: {
    marginRight: 6,
  },
  headerText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#6b6b6b",
  },
  signalLegend: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    marginBottom: 8,
  },
  signalLegendLabel: {
    fontSize: 10,
    fontWeight: "900",
    color: "#334155",
  },
  signalLegendValue: {
    fontSize: 10,
    fontWeight: "700",
    color: "#475569",
  },
  signalLegendDivider: {
    fontSize: 10,
    color: "#94a3b8",
    marginHorizontal: 2,
  },
  weekdayText: {
    width: (SCREEN_WIDTH - 32) / 7,
    textAlign: "center",
    fontSize: 12,
    fontWeight: "700",
    color: "#6b6b6b",
  },
  gridWrap: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 14,
    padding: 1,
    backgroundColor: "#fafafa",
  },
  grid: {
  },
  weekRow: {
    flexDirection: "row",
    marginBottom: 1,
    alignItems: "stretch",
  },
  cell: {
    flex: 1,
    minHeight: 62,
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderWidth: 1,
  },
  cellGapRight: {
    marginRight: 1,
  },
  emptyCell: {
    borderColor: "#efefef",
    backgroundColor: "#fff",
  },
  offDayCell: {
    borderColor: "#e5e7eb",
    backgroundColor: "#f3f4f6",
  },
  dayCellOutsideMonth: {
    opacity: 0.45,
  },
  todayCell: {
    borderColor: "#0a84ff",
    borderWidth: 2,
  },
  cellPressed: {
    opacity: 0.7,
  },
  dayNumber: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1e1e1e",
    marginBottom: 2,
  },
  dayTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
  },
  sessionCountBadge: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#f8fafc",
    alignItems: "center",
    justifyContent: "center",
  },
  sessionCountText: {
    fontSize: 9,
    lineHeight: 10,
    fontWeight: "900",
    color: "#475569",
  },
  dayNumberOutsideMonth: {
    color: "#7a7a7a",
  },
  browseHint: {
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    color: "#64748b",
    marginBottom: 4,
  },
  xtLegendRow: {
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  xtLegendText: {
    fontSize: 10,
    color: "#6b7280",
    fontWeight: "700",
  },
  cellSignalRow: {
    marginTop: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  dotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    flexWrap: "wrap",
  },
  activityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  signalFeedback: {
    backgroundColor: "#d62828",
  },
  workoutDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 0.5,
    borderColor: "rgba(0,0,0,0.18)",
  },
  totalLabel: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "800",
    color: "#334155",
  },
  distanceInlineRow: {
    marginTop: 5,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
  },
  xtInlineRow: {
    marginTop: 2,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
  },
  xtInlineText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "700",
    color: "#4b5563",
  },
  moreDotsText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#666",
    marginLeft: 2,
  },
  listButton: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "white",
  },
  listButtonText: {
    fontWeight: "700",
    color: "#222",
  },
});
