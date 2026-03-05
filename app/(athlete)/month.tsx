import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { loadJSON } from "../../lib/storage";
import { getCurrentTeamId, getMyClaimedAthleteProfileId, getTeamAthlete } from "../../lib/team";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../lib/pace";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../lib/units";
import { loadAthletePaceOverrides, resolveAthletePaceSeconds, type AthletePaceOverrides } from "../../lib/athletePace";
import type { AthleteWorkout, MileageValue, WeekStartDay, WeeklyMileagePlan, WorkoutCategory } from "../../lib/types";
import { CATEGORIES_KEY, categoryColorByName, normalizeCategories } from "../../lib/categories";
import { WEEK_START_KEY, MILEAGE_PLANS_KEY, getWeekStartISO, getWeekIndex, sumMileage, formatSum, getDayTarget, parseISODate, toISODate, formatMileage } from "../../lib/mileagePlan";
import { loadMileageFeedback, type MileageSessionFeedback } from "../../lib/mileageFeedback";
import { loadFeedbackFlagSettings, type FeedbackWarningMode } from "../../lib/feedbackFlags";
import { listAthleteWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";

const SELECTED_KEY = "training_app_selected_athlete_v1";
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_W = SCREEN_WIDTH;

type MonthCell = {
  dateISO: string;
  dayNumber: number;
  inMonth: boolean;
};

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
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

function workoutCategoryNames(w: AthleteWorkout): string[] {
  const arr = Array.isArray((w as any)?.categories)
    ? (w as any).categories
    : [(w as any)?.category ?? (w as any)?.categoryName ?? "Other"];
  const cleaned = arr
    .map((x: any) => String(x ?? "").trim())
    .filter(Boolean);
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
    if (!Number.isFinite(sec)) return { min: 0, max: 0 };
    return { min: sec, max: sec };
  }
  if (kind === "timeRange") {
    const a = Number((v as any).minSeconds ?? 0);
    const b = Number((v as any).maxSeconds ?? 0);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: 0, max: 0 };
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return { min: 0, max: 0 };
}

function sumWeekXTSecRange(plan: WeeklyMileagePlan | undefined): SecRange {
  if (!plan) return { min: 0, max: 0 };

  let min = 0;
  let max = 0;
  for (let i = 0; i < 7; i++) {
    const day: any = plan.days?.[String(i)] ?? {};
    const values: Array<MileageValue | undefined> = [day.am ?? day.AM, day.pm ?? day.PM];
    for (const v of values) {
      const xt = xtRangeForValue(v);
      min += xt.min;
      max += xt.max;
    }
  }

  return { min, max };
}

function formatXTRangeLabel(sec: SecRange): string {
  const fmt = (s: number) => {
    const totalMin = Math.round(s / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return `${m}min`;
    return `${h}hr ${m}min`;
  };

  if (!sec || (sec.min === 0 && sec.max === 0)) return "";
  if (sec.min === sec.max) return `${fmt(sec.min)} Cross training`;
  return `${fmt(sec.min)} to ${fmt(sec.max)} Cross training`;
}

function isXTValue(v: MileageValue | undefined): boolean {
  if (!v || typeof v !== "object") return false;
  const kind = (v as any).kind;
  if (kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    if (options.length !== 2) return false;
    return isXTValue(options[0]) || isXTValue(options[1]);
  }
  return (kind === "time" || kind === "timeRange") && !!(v as any).xt;
}

function containsTimeValue(v: MileageValue | undefined): boolean {
  if (!v || typeof v !== "object") return false;
  const kind = (v as any).kind;
  if (kind === "time" || kind === "timeRange") return true;
  if (kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    return options.some((option: MileageValue) => containsTimeValue(option));
  }
  return false;
}

function formatMilesOnly(v: MileageValue | undefined, paceSecPerMile: number) {
  if (!v || isXTValue(v)) return "";
  const miles = sumMileage([v], paceSecPerMile);
  if (miles.min === 0 && miles.max === 0) return "";

  // Monthly cells are compact summaries. If time was converted to decimal miles,
  // round to whole miles for a cleaner display.
  if (containsTimeValue(v)) {
    const a = Math.round(miles.min);
    const b = Math.round(miles.max);
    if (a === b) return String(a);
    return `${a}-${b}`;
  }

  return formatSum(miles);
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
    plannedMiles: typeof row.planned_distance === "number" ? row.planned_distance : undefined,
    completedMiles: typeof (row as any).completed_miles === "number" ? (row as any).completed_miles : undefined,
    completedTime: String((row as any).completed_time_text ?? "").trim() || undefined,
    splitsOrPace: String((row as any).splits_or_pace ?? "").trim() || undefined,
    additionalFeedback: String((row as any).additional_feedback ?? "").trim() || undefined,
    feedback: String((row as any).additional_feedback ?? "").trim() || undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

export default function AthleteMonthCalendar() {
  const router = useRouter();
  const { name } = useLocalSearchParams<{ name?: string }>();
  const athleteName = name ?? "";
  const todayISO = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;
  }, []);

  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [selectedAthleteLabel, setSelectedAthleteLabel] = useState<string | null>(null);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [mileagePlans, setMileagePlans] = useState<WeeklyMileagePlan[]>([]);
  const [allWorkouts, setAllWorkouts] = useState<AthleteWorkout[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [anchorMonth, setAnchorMonth] = useState(() => monthStart(new Date()));
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [athletePaceOverrides, setAthletePaceOverrides] = useState<AthletePaceOverrides>({});
  const [mileageFeedbackEntries, setMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [feedbackFlagsEnabled, setFeedbackFlagsEnabled] = useState(false);
  const [feedbackWarningMode, setFeedbackWarningMode] = useState<FeedbackWarningMode>("all");
  const [feedbackStartDateISO, setFeedbackStartDateISO] = useState<string | undefined>(undefined);

  const loadMonthData = useCallback(async () => {
    const [
      selected,
      ws,
      plans,
      storedCategories,
      pace,
      unit,
      paceOverrides,
      feedbackEntries,
      flagSettings,
    ] = await Promise.all([
      loadJSON<string | null>(SELECTED_KEY, null),
      loadJSON<WeekStartDay>(WEEK_START_KEY, 1),
      loadJSON<WeeklyMileagePlan[]>(MILEAGE_PLANS_KEY, []),
      loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
      loadPaceSecondsPerMile(),
      loadDistanceUnit(),
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

    setWeekStartsOn((ws ?? 1) as WeekStartDay);
    setMileagePlans(plans ?? []);
    setCategories(normalizeCategories(storedCategories));
    setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
    setDistanceUnit(unit);
    setAthletePaceOverrides(paceOverrides ?? {});
    setMileageFeedbackEntries(feedbackEntries ?? []);
    setFeedbackFlagsEnabled(!!flagSettings.enabled);
    setFeedbackWarningMode(flagSettings.mode ?? "all");
    setFeedbackStartDateISO(flagSettings.startDateISO);

    if (!selectedId) {
      setAllWorkouts([]);
      return;
    }

    const grid = buildMonthGrid(anchorMonth, (ws ?? 1) as WeekStartDay);
    const startISO = grid[0]?.dateISO ?? toISODate(monthStart(anchorMonth));
    const endISO = grid[grid.length - 1]?.dateISO ?? startISO;
    const rows = await listAthleteWorkoutsInRange(selectedId, startISO, endISO);
    const resolvedAthleteName = selectedName ?? athleteName ?? "Athlete";
    setAllWorkouts(rows.map((row) => toAthleteWorkout(row, resolvedAthleteName)));
  }, [anchorMonth, athleteName]);

  useEffect(() => {
    loadMonthData();
  }, [loadMonthData]);

  useFocusEffect(
    useCallback(() => {
      loadMonthData();
    }, [loadMonthData])
  );

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

  const planByWeek = useMemo(() => {
    if (!selectedAthleteId) return new Map<string, WeeklyMileagePlan>();

    const map = new Map<string, WeeklyMileagePlan>();
    for (const p of mileagePlans) {
      if (String((p as any)?.athleteId ?? "") !== selectedAthleteId) continue;
      map.set(p.weekStartISO, p);
    }
    return map;
  }, [mileagePlans, selectedAthleteId]);

  const effectivePaceSecPerMile = useMemo(
    () => resolveAthletePaceSeconds(selectedAthleteId, athletePaceOverrides, paceSecPerMile),
    [selectedAthleteId, athletePaceOverrides, paceSecPerMile]
  );

  const thisWeekGoal = useMemo(() => {
    if (!selectedAthleteId) {
      return { miles: "", xt: "" };
    }

    const currentWeekStart = getWeekStartISO(todayISO, weekStartsOn);
    const plan = planByWeek.get(currentWeekStart);
    if (!plan) return { miles: "", xt: "" };

    const values: Array<MileageValue | undefined> = [];
    for (let i = 0; i < 7; i++) {
      const day: any = plan.days?.[String(i)] ?? {};
      values.push(day.am ?? day.AM);
      values.push(day.pm ?? day.PM);
    }

    const milesSum = sumMileage(values, effectivePaceSecPerMile);
    const roundedMin = Math.round(milesSum.min);
    const roundedMax = Math.round(milesSum.max);
    const milesLabel =
      roundedMin === 0 && roundedMax === 0
        ? ""
        : roundedMin === roundedMax
        ? `${roundedMin} ${distanceUnitLabel(distanceUnit)}`
        : `${roundedMin}-${roundedMax} ${distanceUnitLabel(distanceUnit)}`;

    const xt = sumWeekXTSecRange(plan);
    const xtLabel = formatXTRangeLabel(xt);

    return { miles: milesLabel, xt: xtLabel };
  }, [distanceUnit, effectivePaceSecPerMile, planByWeek, selectedAthleteId, todayISO, weekStartsOn]);
  const compactGoalLine = useMemo(() => {
    const miles = thisWeekGoal.miles || "No distance goal";
    const xt = thisWeekGoal.xt ? thisWeekGoal.xt.replace(" Cross training", " XT") : "";
    return xt ? `${miles} • ${xt}` : miles;
  }, [thisWeekGoal]);

  const workoutDotColorsByDate = useMemo(() => {
    const map = new Map<string, string[]>();

    for (const w of allWorkouts) {
      const dateISO = String((w as any)?.dateISO ?? (w as any)?.date ?? "");
      if (!dateISO) continue;

      const wAthleteId = String((w as any)?.athleteId ?? "").trim();
      if (!selectedAthleteId || wAthleteId !== selectedAthleteId) continue;

      const existing = map.get(dateISO) ?? [];
      for (const categoryName of workoutCategoryNames(w)) {
        const color = categoryColorByName(categories, categoryName);
        if (!existing.includes(color)) existing.push(color);
      }
      map.set(dateISO, existing);
    }

    return map;
  }, [allWorkouts, categories, selectedAthleteId]);

  const missingFeedbackByDate = useMemo(() => {
    if (!feedbackFlagsEnabled || !selectedAthleteId) return new Set<string>();

    const missing = new Set<string>();
    const ncaaOffDates = new Set<string>();

    for (const plan of mileagePlans) {
      if (String((plan as any)?.athleteId ?? "") !== selectedAthleteId) continue;
      for (let idx = 0; idx < 7; idx++) {
        const dateISO = addDaysISO(plan.weekStartISO, idx);
        if (!isDateWithinWarningWindow(dateISO, todayISO, feedbackWarningMode, feedbackStartDateISO)) continue;
        const day = getDayTarget(plan, idx) as any;
        if (day?.ncaaOff) ncaaOffDates.add(dateISO);
      }
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

    for (const plan of mileagePlans) {
      if (String((plan as any)?.athleteId ?? "") !== selectedAthleteId) continue;
      for (let idx = 0; idx < 7; idx++) {
        const dateISO = addDaysISO(plan.weekStartISO, idx);
        if (!isDateWithinWarningWindow(dateISO, todayISO, feedbackWarningMode, feedbackStartDateISO)) continue;
        const day = getDayTarget(plan, idx) as any;
        const isNCAAOffDay = !!day.ncaaOff;
        if (isNCAAOffDay) continue;
        const hasPlannedAM = String(formatMileage(day.am ?? day.AM)).trim().length > 0;
        const hasPlannedPM = String(formatMileage(day.pm ?? day.PM)).trim().length > 0;

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
    mileagePlans,
    selectedAthleteId,
    selectedAthleteLabel,
    todayISO,
  ]);

  return (
    <View style={styles.container}>
      <View style={styles.viewToggleRow}>
        <Pressable style={[styles.viewTogglePill, styles.viewTogglePillActive]}>
          <Text style={[styles.viewToggleText, styles.viewToggleTextActive]}>Monthly</Text>
        </Pressable>
        <Pressable onPress={() => router.push("/(athlete)/week")} style={styles.viewTogglePill}>
          <Text style={styles.viewToggleText}>Weekly</Text>
        </Pressable>
      </View>

      <View style={styles.headerRow}>
        <Pressable onPress={() => commitSwipe("prev")} style={styles.monthNavButton}>
          <Text style={styles.monthNavButtonText}>◀</Text>
        </Pressable>

        <View style={styles.monthCenter}>
          <Text style={styles.monthLabel}>{monthLabel}</Text>
          <View style={styles.compactGoalBadge}>
            <Text style={styles.compactGoalLabel}>This week</Text>
            <Text numberOfLines={1} style={styles.compactGoalValue}>{compactGoalLine}</Text>
          </View>
        </View>

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
                        let amText = "";
                        let pmText = "";
                        let isNCAAOffDay = false;
                        if (selectedAthleteId) {
                          const weekStartISO = getWeekStartISO(iso, weekStartsOn);
                          const plan = planByWeek.get(weekStartISO);
                          const idx = getWeekIndex(iso, weekStartISO);
                          if (plan && idx >= 0 && idx < 7) {
                            const target = getDayTarget(plan, idx);
                            const dayAny = target as any;
                            isNCAAOffDay = !!dayAny.ncaaOff;
                            const amValue = dayAny.am ?? dayAny.AM;
                            const pmValue = dayAny.pm ?? dayAny.PM;
                            amText = isXTValue(amValue) ? "XT" : formatMilesOnly(amValue, effectivePaceSecPerMile);
                            pmText = isXTValue(pmValue) ? "XT" : formatMilesOnly(pmValue, effectivePaceSecPerMile);
                          }
                        }

                        const hasAm = !!amText;
                        const hasPm = !!pmText;
                        const hasPlanForDay = hasAm || hasPm;
                        const singleAmount = amText || pmText;

                        return (
                          <Pressable
                            key={cell.dateISO}
                            onPress={() =>
                              router.push({
                                pathname: "/(athlete)/day",
                                params: { date: iso },
                              })
                            }
                            style={({ pressed }) => [
                              styles.cell,
                              cellIndex < 6 && styles.cellGapRight,
                              isNCAAOffDay ? styles.ncaaOffCell : (hasPlanForDay ? styles.plannedCell : styles.emptyCell),
                              !cell.inMonth && styles.dayCellOutsideMonth,
                              iso === todayISO && styles.todayCell,
                              pressed && styles.cellPressed,
                            ]}
                          >
                            <View style={styles.dayTopRow}>
                              <Text style={[styles.dayNumber, !cell.inMonth && styles.dayNumberOutsideMonth]}>
                                {cell.dayNumber}
                              </Text>
                              {missingFeedbackByDate.has(iso) ? (
                                <View style={styles.missingFeedbackBadge}>
                                  <Text style={styles.missingFeedbackBadgeText}>!</Text>
                                </View>
                              ) : null}
                            </View>

                            {hasAm && hasPm ? (
                              <View style={styles.planRows}>
                                <Text style={styles.planText}>AM {amText}</Text>
                                <Text style={styles.planText}>PM {pmText}</Text>
                              </View>
                            ) : singleAmount ? (
                              <Text style={styles.singlePlanText}>{singleAmount}</Text>
                            ) : null}

                            {isNCAAOffDay ? (
                              <Text style={styles.offDayTag}>NCAA Off</Text>
                            ) : null}

                            {(workoutDotColorsByDate.get(iso) ?? []).length > 0 ? (
                              <View style={styles.dotRow}>
                                {(workoutDotColorsByDate.get(iso) ?? []).slice(0, 3).map((color, i) => (
                                  <View key={`${iso}-dot-${i}-${color}`} style={[styles.workoutDot, { backgroundColor: color }]} />
                                ))}
                                {(workoutDotColorsByDate.get(iso) ?? []).length > 3 ? (
                                  <Text style={styles.moreDotsText}>+{(workoutDotColorsByDate.get(iso) ?? []).length - 3}</Text>
                                ) : null}
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
    marginBottom: 8,
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
    fontWeight: "700",
    color: "#111",
  },
  monthCenter: {
    alignItems: "center",
    maxWidth: "72%",
  },
  compactGoalBadge: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: "#cfe3ff",
    backgroundColor: "#eef6ff",
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 10,
    alignItems: "center",
    maxWidth: "100%",
  },
  compactGoalLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: "#3b5b8a",
  },
  compactGoalValue: {
    marginTop: 1,
    fontSize: 11,
    fontWeight: "900",
    color: "#17365d",
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
    padding: 8,
    backgroundColor: "#fafafa",
  },
  grid: {
  },
  weekRow: {
    flexDirection: "row",
    marginBottom: 6,
    alignItems: "stretch",
  },
  cell: {
    flex: 1,
    minHeight: 72,
    borderRadius: 10,
    paddingHorizontal: 5,
    paddingVertical: 6,
    borderWidth: 1,
  },
  cellGapRight: {
    marginRight: 6,
  },
  emptyCell: {
    borderColor: "#efefef",
    backgroundColor: "#fff",
  },
  plannedCell: {
    borderColor: "#f5d9a6",
    backgroundColor: "#fff8ec",
  },
  ncaaOffCell: {
    borderColor: "#b8d8ff",
    backgroundColor: "#eaf4ff",
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
  },
  missingFeedbackBadge: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#d62828",
  },
  missingFeedbackBadgeText: {
    color: "white",
    fontSize: 10,
    fontWeight: "900",
    lineHeight: 12,
  },
  dayNumberOutsideMonth: {
    color: "#7a7a7a",
  },
  planRows: {
    marginTop: 6,
    gap: 2,
  },
  planText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#222",
  },
  singlePlanText: {
    marginTop: 8,
    fontSize: 11,
    fontWeight: "800",
    color: "#222",
  },
  offDayTag: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: "900",
    color: "#0a5eb7",
  },
  dotRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
    gap: 4,
  },
  workoutDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 0.5,
    borderColor: "rgba(0,0,0,0.2)",
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
