// app/(athlete)/week.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { MaterialIcons } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { loadJSON, saveJSON } from "../../lib/storage";
import { resolveAthleteSessionContext } from "../../lib/athleteSession";
import { ATHLETE_CALENDAR_VIEW_STATE_KEY, type AthleteCalendarViewState } from "../../lib/athleteCalendarView";
import { loadRosterNameMapForTeam } from "../../lib/rosterNameMap";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../lib/units";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../lib/pace";
import { loadAthletePaceOverrides, resolveAthletePaceSeconds, type AthletePaceOverrides } from "../../lib/athletePace";
import type { AthleteWorkout, MileageValue, WeekStartDay, WorkoutCategory } from "../../lib/types";
import { CATEGORIES_KEY, categoryColorByName, normalizeCategories } from "../../lib/categories";
import {
  getWeekStartISO,
  getWeekIndex,
  formatMileage,
  formatSum,
  parseMileageInput,
  sumMileage,
  parseISODate,
  toISODate,
} from "../../lib/mileagePlan";
import { listAthleteWorkoutsInRange, listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../lib/teamDataStore";
import { loadCoachWeekLabels, loadWeekStartSetting, type CoachWeekLabels } from "../../lib/settings";
import { getWeekLabelTone } from "../../lib/weekLabelStyle";
import { SegmentedViewToggle } from "../../components/shared/SegmentedViewToggle";

const SELECTED_KEY = "training_app_selected_athlete_v1";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type DayRow = {
  dateISO: string;
  jsDay: number;
  label: string; // "Mon"
  dayNumber: number;
};

function addDaysISO(iso: string, days: number) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function formatDisplayDate(iso: string) {
  const d = parseISODate(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDayCardHeaderDate(iso: string) {
  const d = parseISODate(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function normalizeGroupId(groupId?: string): string {
  const normalized = String(groupId ?? "").trim().toUpperCase();
  return normalized || "A";
}

function fallbackAthleteName(athleteId: string) {
  const clean = String(athleteId ?? "").trim();
  if (!clean) return "Athlete";
  return `Athlete (${clean.slice(-6)})`;
}

function workoutCategoryNames(w: AthleteWorkout): string[] {
  const arr = Array.isArray((w as any)?.categories)
    ? (w as any).categories
    : [(w as any)?.category ?? (w as any)?.categoryName ?? "Other"];
  const cleaned = arr.map((x: any) => String(x ?? "").trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["Other"];
}

function isBuiltInOffCategory(name: string): boolean {
  const normalized = String(name ?? "").trim().toLowerCase();
  return normalized === "off" || normalized === "off / rest" || normalized === "rest";
}

function formatGroupMateNamesCompact(names: string[]): string {
  const parsed = names
    .map((raw) => {
      const text = String(raw ?? "").trim();
      if (!text) return null;
      const parts = text.split(/\s+/).filter(Boolean);
      const first = String(parts[0] ?? "").trim();
      const last = String(parts[parts.length - 1] ?? "").trim() || text;
      return { first, last, original: text };
    })
    .filter((entry): entry is { first: string; last: string; original: string } => Boolean(entry));

  const byLast = new Map<string, Array<{ first: string; last: string; original: string }>>();
  for (const entry of parsed) {
    const key = entry.last.toLowerCase();
    const list = byLast.get(key) ?? [];
    list.push(entry);
    byLast.set(key, list);
  }

  const labels: string[] = [];
  for (const entry of parsed) {
    const sameLast = byLast.get(entry.last.toLowerCase()) ?? [entry];
    if (sameLast.length <= 1) {
      labels.push(entry.last);
      continue;
    }

    const firstLetters = sameLast.map((item) => String(item.first[0] ?? "").toUpperCase()).filter(Boolean);
    const currentFirst = String(entry.first[0] ?? "").toUpperCase();
    const hasUniqueFirst = Boolean(currentFirst) && firstLetters.filter((value) => value === currentFirst).length === 1;
    if (hasUniqueFirst) {
      labels.push(`${currentFirst}. ${entry.last}`);
      continue;
    }

    const second = String(entry.first[1] ?? "").toUpperCase();
    const prefix = second ? `${currentFirst}${second}` : currentFirst;
    labels.push(prefix ? `${prefix}. ${entry.last}` : entry.last);
  }

  return labels.join(", ");
}

// --- Weekly totals helpers (planned miles + XT time) ---
// We keep display simple: planned miles total (rounded) + XT time total (if any).
type MilesRange = { min: number; max: number };
type SecRange = { min: number; max: number };

function addMiles(a: MilesRange, b: MilesRange): MilesRange {
  return { min: a.min + b.min, max: a.max + b.max };
}
function addSecs(a: SecRange, b: SecRange): SecRange {
  return { min: a.min + b.min, max: a.max + b.max };
}

// Convert MileageValue to XT seconds ONLY (ignores non-XT)
function toXTSecRange(v: MileageValue | undefined): SecRange {
  if (!v || typeof v !== "object") return { min: 0, max: 0 };
  const kind = (v as any).kind;

  if (kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    if (options.length !== 2) return { min: 0, max: 0 };
    const a = toXTSecRange(options[0]);
    const b = toXTSecRange(options[1]);
    return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
  }

  const xt = !!(v as any).xt;
  if (!xt) return { min: 0, max: 0 };

  if (kind === "time") {
    const s = typeof (v as any).seconds === "number" ? (v as any).seconds : 0;
    return { min: s, max: s };
  }
  if (kind === "timeRange") {
    const a = typeof (v as any).minSeconds === "number" ? (v as any).minSeconds : 0;
    const b = typeof (v as any).maxSeconds === "number" ? (v as any).maxSeconds : 0;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return { min: 0, max: 0 };
}

// Convert MileageValue to miles-range (time converts to miles ONLY if not XT)
// NOTE: this uses your coach-set pace elsewhere for totals in coach sheet.
// For athlete weekly “goals”, we keep it simple: show the planned miles total
// by summing only miles entries. If you want time->miles here too, say so.
function toMilesRangeConservative(v: MileageValue | undefined): MilesRange {
  if (!v) return { min: 0, max: 0 };
  if (typeof v === "object") {
    const kind = (v as any).kind;
    if (kind === "choice") {
      const options = Array.isArray((v as any).options) ? (v as any).options : [];
      if (options.length !== 2) return { min: 0, max: 0 };
      const a = toMilesRangeConservative(options[0]);
      const b = toMilesRangeConservative(options[1]);
      return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
    }
    if (kind === "exact") return { min: Number((v as any).value) || 0, max: Number((v as any).value) || 0 };
    if (kind === "range") {
      const a = Number((v as any).min) || 0;
      const b = Number((v as any).max) || 0;
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
    // ignore time entries here for the “planned miles” line (keeps goals clean)
    return { min: 0, max: 0 };
  }
  return { min: 0, max: 0 };
}

function formatRoundedDistanceTotal(r: MilesRange, unit: DistanceUnit) {
  const a = Math.round(r.min);
  const b = Math.round(r.max);
  if (a === 0 && b === 0) return "";
  const suffix = distanceUnitLabel(unit);
  return a === b ? `${a} planned ${suffix}` : `${a}–${b} planned ${suffix}`;
}

function formatXTTotalCoachStyle(sec: SecRange) {
  const minMinutes = Math.round(sec.min / 60);
  const maxMinutes = Math.round(sec.max / 60);
  if (minMinutes === 0 && maxMinutes === 0) return "";
  if (minMinutes === maxMinutes) return `${minMinutes}XT`;
  return `${minMinutes}-${maxMinutes}XT`;
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

function toMileageValue(raw: unknown): MileageValue | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return parseMileageInput(raw);
  if (typeof raw === "number") return { kind: "exact", value: raw };
  if (typeof raw === "object") return raw as MileageValue;
  return undefined;
}

function hasXTToken(text: string): boolean {
  return /XT/i.test(String(text ?? ""));
}

function renderTextWithXTIcon(text: string, textStyle: any, iconSize: number, includeMinLabel: boolean = false) {
  const raw = String(text ?? "");
  if (!hasXTToken(raw)) return <Text style={textStyle}>{raw}</Text>;

  const parts = raw.split(/XT/gi);
  return (
    <View style={styles.xtInlineRow}>
      {parts.map((part, idx) => (
        <View key={`xt-part-${idx}`} style={styles.xtInlineSegment}>
          {part ? <Text style={textStyle}>{part}</Text> : null}
          {idx < parts.length - 1 ? (
            <>
              {includeMinLabel ? <Text style={textStyle}> min </Text> : null}
              <Ionicons name="bicycle-outline" size={iconSize} color="#64748b" />
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function isPlainRunningValue(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (/XT/i.test(raw)) return false;
  const lowered = raw.toLowerCase();
  if (lowered === "no plan" || lowered === "off day") return false;
  return true;
}

function shouldAppendDistanceUnit(text: string): boolean {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (/\b(mi|km)\b/.test(raw)) return false;
  if (raw.includes("min") || raw.includes("hr") || raw.includes(":")) return false;
  return true;
}

function hasPositiveTrainingAssignment(v: MileageValue | undefined): boolean {
  if (!v || typeof v !== "object") return false;
  const kind = (v as any).kind;

  if (kind === "choice") {
    const options = Array.isArray((v as any).options) ? (v as any).options : [];
    return options.some((option: MileageValue) => hasPositiveTrainingAssignment(option));
  }
  if (kind === "exact") return Number((v as any).value ?? 0) > 0;
  if (kind === "range") return Number((v as any).max ?? 0) > 0 || Number((v as any).min ?? 0) > 0;
  if (kind === "time") return Number((v as any).seconds ?? 0) > 0;
  if (kind === "timeRange") return Number((v as any).maxSeconds ?? 0) > 0 || Number((v as any).minSeconds ?? 0) > 0;
  return false;
}

function renderRunningTextWithIcon(text: string, textStyle: any, iconSize: number) {
  return (
    <View style={styles.xtInlineRow}>
      <Text style={textStyle}>{String(text ?? "")}</Text>
      <MaterialIcons name="directions-run" size={iconSize} color="#64748b" />
    </View>
  );
}

function getWeekLabelToneColors(tone: "competition" | "break" | "camp" | "custom") {
  if (tone === "competition") {
    return { border: "rgba(220,38,38,0.34)", bg: "rgba(220,38,38,0.1)", text: "#991b1b" };
  }
  if (tone === "break") {
    return { border: "rgba(14,116,144,0.34)", bg: "rgba(14,116,144,0.1)", text: "#0e7490" };
  }
  if (tone === "camp") {
    return { border: "rgba(22,163,74,0.34)", bg: "rgba(22,163,74,0.1)", text: "#166534" };
  }
  return { border: "rgba(15,23,42,0.2)", bg: "rgba(15,23,42,0.06)", text: "#334155" };
}

function isChoiceMileageValue(v: MileageValue | undefined): v is Extract<MileageValue, { kind: "choice" }> {
  return Boolean(v && typeof v === "object" && (v as any).kind === "choice");
}

export default function AthleteWeekView() {
  const router = useRouter();
  const { date } = useLocalSearchParams<{ date?: string }>();
  const store = teamDataStore.use();

  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [selectedAthleteLabel, setSelectedAthleteLabel] = useState<string | null>(null);

  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [allWorkouts, setAllWorkouts] = useState<AthleteWorkout[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [weekLabelsByStart, setWeekLabelsByStart] = useState<CoachWeekLabels>({});
  const [teamWeekRows, setTeamWeekRows] = useState<TeamWorkoutRow[]>([]);
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [athletePaceOverrides, setAthletePaceOverrides] = useState<AthletePaceOverrides>({});
  const lastLoadRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });
  const inFlightRef = useRef(false);
  const activeLoadKeyRef = useRef("");

  // anchor is any date within the current week we’re viewing
  const [weekAnchorISO, setWeekAnchorISO] = useState(() => toISODate(new Date()));

  const loadWeekStartFromShared = useCallback(async () => {
    const weekStartResult = await loadWeekStartSetting();
    const normalized: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
    console.log("[athlete-week] week start loaded via shared helper", {
      raw: weekStartResult.raw,
      normalized,
    });
    setWeekStartsOn(normalized);
    return normalized;
  }, []);

  const loadData = useCallback(async () => {
    if (inFlightRef.current) return;
    const loadKey = String(weekAnchorISO);
    const now = Date.now();
    if (lastLoadRef.current.key === loadKey && now - lastLoadRef.current.ts < 12000) {
      return;
    }
    inFlightRef.current = true;
    activeLoadKeyRef.current = loadKey;
    const ws = await loadWeekStartFromShared();
    try {
      const [selected, unit, pace, paceOverrides, storedCategories, weekLabels] = await Promise.all([
        loadJSON<string | null>(SELECTED_KEY, null),
        loadDistanceUnit(),
        loadPaceSecondsPerMile(),
        loadAthletePaceOverrides(),
        loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
        loadCoachWeekLabels(),
      ]);

      const athleteSession = await resolveAthleteSessionContext();
      const teamId = athleteSession.teamId;
      const rosterMap = await loadRosterNameMapForTeam(teamId);
      setRosterNameById(rosterMap);
      const selectedId = String(athleteSession.athleteId ?? selected ?? "").trim();
      setSelectedAthleteId(selectedId || null);

      const selectedName = selectedId ? String(athleteSession.athleteName ?? "").trim() || null : null;
      setSelectedAthleteLabel(selectedName);

      setDistanceUnit(unit);
      setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
      setAthletePaceOverrides(paceOverrides ?? {});
      setCategories(normalizeCategories(storedCategories));
      setWeekLabelsByStart(weekLabels ?? {});

      const weekStartForFetch = getWeekStartISO(weekAnchorISO, ws);
      void teamDataStore.actions.loadMileageWeek(weekStartForFetch);

      if (!selectedId) {
        setAllWorkouts([]);
        setTeamWeekRows([]);
        return;
      }

      const weekEndForFetch = addDaysISO(weekStartForFetch, 6);
      const rows = await listAthleteWorkoutsInRange(selectedId, weekStartForFetch, weekEndForFetch);
      if (activeLoadKeyRef.current !== loadKey) return;
      const athleteName = selectedName ?? "Athlete";
      setAllWorkouts(rows.map((row) => toAthleteWorkout(row, athleteName)));
      setTeamWeekRows([]);
      lastLoadRef.current = { key: loadKey, ts: Date.now() };

      // Load full-team rows in background for group-mate context and extra metadata.
      void (async () => {
        const allRowsForWeek = await listTeamWorkoutsInRange(weekStartForFetch, weekEndForFetch);
        if (activeLoadKeyRef.current !== loadKey) return;
        setTeamWeekRows(allRowsForWeek);
      })();
    } finally {
      inFlightRef.current = false;
    }
  }, [loadWeekStartFromShared, weekAnchorISO]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData])
  );

  useEffect(() => {
    const routeDate = String(date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return;
    const parsed = parseISODate(routeDate);
    if (Number.isNaN(parsed.getTime())) return;
    setWeekAnchorISO(routeDate);
  }, [date]);

  const weekStartISO = useMemo(
    () => getWeekStartISO(weekAnchorISO, weekStartsOn),
    [weekAnchorISO, weekStartsOn]
  );

  useEffect(() => {
    void saveJSON<AthleteCalendarViewState>(ATHLETE_CALENDAR_VIEW_STATE_KEY, {
      view: "week",
      dateISO: weekStartISO,
    });
  }, [weekStartISO]);

  const weekEndISO = useMemo(() => addDaysISO(weekStartISO, 6), [weekStartISO]);

  const weekLabel = useMemo(() => {
    // e.g. "Mar 30 – Apr 5, 2026" (or include both years when crossing years)
    const s = parseISODate(weekStartISO);
    const e = parseISODate(weekEndISO);
    const sTxt = s.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (s.getFullYear() === e.getFullYear()) {
      const eTxt = e.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      return `${sTxt} – ${eTxt}`;
    }
    const sYear = s.toLocaleDateString(undefined, { year: "numeric" });
    const eTxt = e.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${sTxt}, ${sYear} – ${eTxt}`;
  }, [weekStartISO, weekEndISO]);

  const currentWeekAnnotation = useMemo(() => {
    return String(weekLabelsByStart[weekStartISO] ?? "").trim();
  }, [weekLabelsByStart, weekStartISO]);

  const currentWeekAnnotationColors = useMemo(() => {
    if (!currentWeekAnnotation) return null;
    const tone = getWeekLabelTone(currentWeekAnnotation);
    return getWeekLabelToneColors(tone);
  }, [currentWeekAnnotation]);

  const dayRows = useMemo<DayRow[]>(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const dateISO = addDaysISO(weekStartISO, i);
      const d = parseISODate(dateISO);
      const jsDay = d.getDay();
      const label = WEEKDAY_LABELS[jsDay];
      return { dateISO, jsDay, label, dayNumber: d.getDate() };
    });
  }, [weekStartISO]);

  const mileageByDaySession = useMemo(() => {
    const map = new Map<string, MileageValue | undefined>();
    if (!selectedAthleteId) return map;
    const rows = store.mileageCellsByWeek[weekStartISO] ?? [];
    for (const row of rows) {
      if (String(row.athlete_profile_id) !== String(selectedAthleteId)) continue;
      const session = row.session === "AM" ? "AM" : "PM";
      map.set(`${row.day_idx}:${session}`, toMileageValue((row as any).value));
    }
    return map;
  }, [selectedAthleteId, store.mileageCellsByWeek, weekStartISO]);

  const ncaaOffByDay = useMemo(() => {
    const map = new Map<number, boolean>();
    if (!selectedAthleteId) return map;
    const rows = store.mileageFlagsByWeek[weekStartISO] ?? [];
    for (const row of rows) {
      if (String(row.athlete_profile_id) !== String(selectedAthleteId)) continue;
      map.set(row.day_idx, !!row.ncaa_off);
    }
    return map;
  }, [selectedAthleteId, store.mileageFlagsByWeek, weekStartISO]);

  const effectivePaceSecPerMile = useMemo(
    () => resolveAthletePaceSeconds(selectedAthleteId, athletePaceOverrides, paceSecPerMile),
    [selectedAthleteId, athletePaceOverrides, paceSecPerMile]
  );

  const weeklyGoals = useMemo(() => {
    // Coach-sheet style weekly totals: running volume + XT range.
    const runningValues: Array<MileageValue | undefined> = [];
    let xt: SecRange = { min: 0, max: 0 };

    for (let i = 0; i < 7; i++) {
      const am = mileageByDaySession.get(`${i}:AM`);
      const pm = mileageByDaySession.get(`${i}:PM`);
      runningValues.push(am, pm);
      xt = addSecs(xt, toXTSecRange(am));
      xt = addSecs(xt, toXTSecRange(pm));
    }
    const miles = sumMileage(runningValues, effectivePaceSecPerMile);
    const runningCore = formatSum(miles);

    return {
      milesLabel: runningCore ? `${runningCore} ${distanceUnitLabel(distanceUnit)}` : "",
      xtLabel: formatXTTotalCoachStyle(xt),
    };
  }, [distanceUnit, effectivePaceSecPerMile, mileageByDaySession]);

  const workoutsByDate = useMemo(() => {
    const map = new Map<string, AthleteWorkout[]>();

    for (const w of allWorkouts) {
      const dateISO = String((w as any)?.dateISO ?? (w as any)?.date ?? "");
      if (!dateISO) continue;

      const wAthleteId = String((w as any)?.athleteId ?? "").trim();
      if (!selectedAthleteId || wAthleteId !== selectedAthleteId) continue;

      const arr = map.get(dateISO) ?? [];
      arr.push(w);
      map.set(dateISO, arr);
    }

    // optional: stable sort by session
    for (const [k, arr] of map.entries()) {
      arr.sort((a: any, b: any) => String(a?.session ?? "").localeCompare(String(b?.session ?? "")));
      map.set(k, arr);
    }

    return map;
  }, [allWorkouts, selectedAthleteId]);

  const workoutRowById = useMemo(() => {
    const map = new Map<string, TeamWorkoutRow>();
    for (const row of teamWeekRows) map.set(String(row.id), row);
    return map;
  }, [teamWeekRows]);

  const groupMateNamesByWorkoutId = useMemo(() => {
    const map = new Map<string, string[]>();

    for (const workout of allWorkouts) {
      const workoutId = String(workout.id ?? "").trim();
      if (!workoutId) continue;
      if (!workout.batchId) {
        map.set(workoutId, []);
        continue;
      }

      const peers = teamWeekRows.filter((row) => {
        if (String(row.date_iso ?? "") !== String(workout.dateISO ?? "")) return false;
        if (String(row.batch_id ?? "") !== String(workout.batchId ?? "")) return false;
        if (normalizeGroupId(String(row.group_id ?? "")) !== normalizeGroupId(String(workout.groupId ?? ""))) return false;
        return String(row.athlete_profile_id ?? "").trim() !== String(workout.athleteId ?? "").trim();
      });

      const names = Array.from(
        new Set(
          peers
            .map((row) => {
              const athleteId = String(row.athlete_profile_id ?? "").trim();
              return (
                String(rosterNameById.get(athleteId) ?? "").trim() ||
                String((row as any).athlete_name ?? "").trim() ||
                fallbackAthleteName(athleteId)
              );
            })
            .filter((name) => Boolean(String(name ?? "").trim()))
        )
      );
      map.set(workoutId, names);
    }

    return map;
  }, [allWorkouts, rosterNameById, teamWeekRows]);

  const shiftWeek = useCallback((deltaWeeks: number) => {
    setWeekAnchorISO((prev) => addDaysISO(prev, deltaWeeks * 7));
  }, []);

  // Swipe: left = next week, right = prev week
  const translateX = useSharedValue(0);

  const horizontalPan = Gesture.Pan()
    .maxPointers(1)
    .onChange((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      const threshold = 70;
      if (e.translationX > threshold) runOnJS(shiftWeek)(-1);
      else if (e.translationX < -threshold) runOnJS(shiftWeek)(1);
      translateX.value = withSpring(0);
    });

  const pan = horizontalPan;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={styles.container}>
      <SegmentedViewToggle
        activeKey="week"
        items={[
          { key: "month", label: "Monthly", onPress: () => router.push("/(athlete)/month") },
          { key: "week", label: "Weekly", onPress: () => {} },
        ]}
      />

      {/* Week header */}
      <View style={styles.header}>
        <View style={styles.headerNavRow}>
          <Pressable onPress={() => shiftWeek(-1)} style={styles.monthNavButton}>
            <Text style={styles.monthNavButtonText}>◀</Text>
          </Pressable>
          <Text style={styles.weekLabel}>{weekLabel}</Text>
          <Pressable onPress={() => shiftWeek(1)} style={styles.monthNavButton}>
            <Text style={styles.monthNavButtonText}>▶</Text>
          </Pressable>
        </View>
        {currentWeekAnnotation && currentWeekAnnotationColors ? (
          <View
            style={[
              styles.weekAnnotationChip,
              {
                borderColor: currentWeekAnnotationColors.border,
                backgroundColor: currentWeekAnnotationColors.bg,
              },
            ]}
          >
            <Text style={[styles.weekAnnotationText, { color: currentWeekAnnotationColors.text }]}>
              {currentWeekAnnotation}
            </Text>
          </View>
        ) : null}
        <Text style={styles.athleteLabel}>{selectedAthleteLabel ?? "Athlete"}</Text>
      </View>

      {/* Weekly goals */}
      <Pressable style={({ pressed }) => [styles.goalsCard, pressed && styles.goalsCardPressed]}>
        <View style={styles.goalSingleRow}>
          <Text style={styles.goalPrefix}>This week&apos;s goal:</Text>
          <View style={styles.goalSingleItem}>
            <MaterialIcons name="directions-run" size={12} color="#64748b" />
            <Text style={styles.goalSingleItemText} numberOfLines={1}>
              {weeklyGoals.milesLabel || "No distance"}
            </Text>
          </View>
          <Text style={styles.goalDot}>•</Text>
          <View style={styles.goalSingleItem}>
            <Ionicons name="bicycle-outline" size={12} color="#64748b" />
            <Text style={styles.goalSingleItemText} numberOfLines={1}>
              {weeklyGoals.xtLabel ? weeklyGoals.xtLabel.replace(/XT/gi, " min") : "No XT"}
            </Text>
          </View>
        </View>
      </Pressable>

      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.listWrap, animatedStyle]}>
          <ScrollView contentContainerStyle={{ paddingBottom: 18 }} keyboardShouldPersistTaps="handled">
            {dayRows.map((dRow) => {
              const weekIdx = getWeekIndex(dRow.dateISO, weekStartISO);
              const amValue = mileageByDaySession.get(`${weekIdx}:AM`);
              const pmValue = mileageByDaySession.get(`${weekIdx}:PM`);
              const isNCAAOffDay = !!ncaaOffByDay.get(weekIdx);
              const amText = formatMileage(amValue);
              const pmText = formatMileage(pmValue);
              const workouts = workoutsByDate.get(dRow.dateISO) ?? [];
              const dayHasBuiltInOff = workouts.some((w) => workoutCategoryNames(w).some((name) => isBuiltInOffCategory(name)));
              const amWorkouts = workouts.filter((w) => String((w as any)?.session ?? "PM").toUpperCase() === "AM");
              const pmWorkouts = workouts.filter((w) => String((w as any)?.session ?? "PM").toUpperCase() === "PM");
              const hasAMLoad = hasPositiveTrainingAssignment(amValue);
              const hasPMLoad = hasPositiveTrainingAssignment(pmValue);
              const showAMBlock = isNCAAOffDay || hasAMLoad || amWorkouts.length > 0;
              const showPMBlock = isNCAAOffDay || hasPMLoad || pmWorkouts.length > 0;
              const amPlanned = isNCAAOffDay ? "Off day" : amText || "0 mi";
              const pmPlanned = isNCAAOffDay ? "Off day" : pmText || "0 mi";

              return (
                <Pressable
                  key={dRow.dateISO}
                  onPress={() =>
                    router.push({
                      pathname: "/(athlete)/day",
                      params: { date: dRow.dateISO, returnView: "week", returnDate: dRow.dateISO },
                    })
                  }
                  style={({ pressed }) => [
                    styles.dayCard,
                    (isNCAAOffDay || dayHasBuiltInOff) && styles.dayCardOff,
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  {/* Row header */}
                  <View style={styles.dayHeaderRow}>
                    <View style={styles.dayHeaderLeft}>
                      <Text style={styles.dayName}>{formatDayCardHeaderDate(dRow.dateISO)}</Text>
                      {dayHasBuiltInOff ? (
                        <View style={styles.dayOffBadge}>
                          <View style={styles.dayOffBadgeDot} />
                          <Text style={styles.dayOffBadgeText}>Off</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>

                  {[
                    { session: "AM" as const, planned: amPlanned, value: amValue, rows: amWorkouts, visible: showAMBlock },
                    { session: "PM" as const, planned: pmPlanned, value: pmValue, rows: pmWorkouts, visible: showPMBlock },
                  ]
                    .filter((section) => section.visible)
                    .map((section) => (
                    <View
                      key={`${dRow.dateISO}-${section.session}`}
                      style={[styles.sessionBlock, section.rows.length === 0 && styles.sessionBlockCompact]}
                    >
                      {(() => {
                        const sessionMeta = (() => {
                          if (section.rows.length === 0) return "";
                          const labels = section.rows
                            .map((w) => {
                              const row = workoutRowById.get(String(w.id ?? "").trim());
                              const timeText = String(w.time ?? "").trim();
                              const locationText = String(row?.location ?? "").trim();
                              if (!timeText && !locationText) return "";
                              return `${timeText || "—"} @ ${locationText || "—"}`;
                            })
                            .filter(Boolean);
                          if (labels.length === 0) return "";
                          const first = labels[0];
                          const allSame = labels.every((label) => label === first);
                          return allSame ? first : "Varies";
                        })();
                        return (
                      <View style={styles.sessionHeader}>
                        <View style={styles.sessionLeft}>
                          <Text style={styles.sessionTitle}>{section.session}</Text>
                          {sessionMeta ? <Text style={styles.sessionMeta}>{sessionMeta}</Text> : null}
                        </View>
                        {(() => {
                          const renderPlannedText = (plannedText: string) => {
                            if (hasXTToken(plannedText)) {
                              return renderTextWithXTIcon(plannedText, styles.sessionPlanned, 12, false);
                            }
                            if (isPlainRunningValue(plannedText)) {
                              return renderRunningTextWithIcon(
                                shouldAppendDistanceUnit(plannedText)
                                  ? `${plannedText} ${distanceUnitLabel(distanceUnit)}`
                                  : plannedText,
                                styles.sessionPlanned,
                                12
                              );
                            }
                            return <Text style={styles.sessionPlanned}>{plannedText}</Text>;
                          };

                          if (isChoiceMileageValue(section.value)) {
                            const optionValues = Array.isArray((section.value as any).options) ? (section.value as any).options : [];
                            const optionTexts = optionValues.map((option: MileageValue) => formatMileage(option)).filter((text: string) => Boolean(String(text ?? "").trim()));
                            if (optionTexts.length > 0) {
                              return (
                                <View style={styles.sessionChoiceValueRow}>
                                  {optionTexts.map((plannedText: string, index: number) => (
                                    <View key={`${dRow.dateISO}-${section.session}-choice-${index}`} style={styles.sessionChoicePart}>
                                      {renderPlannedText(plannedText)}
                                      {index < optionTexts.length - 1 ? <Text style={styles.sessionChoiceSeparator}>or</Text> : null}
                                    </View>
                                  ))}
                                </View>
                              );
                            }
                          }

                          return renderPlannedText(section.planned);
                        })()}
                      </View>
                        );
                      })()}

                      {section.rows.length === 0 ? null : (
                        <View style={styles.sessionRows}>
                          {section.rows.map((workout) => {
                            const workoutId = String(workout.id ?? "");
                            const groupMates = groupMateNamesByWorkoutId.get(workoutId) ?? [];
                            const categoryNames = workoutCategoryNames(workout).filter((name) => !isBuiltInOffCategory(name));
                            const barCategoryNames = (categoryNames.length > 0 ? categoryNames : ["Other"]).slice(0, 3);
                            const title = String(workout.title ?? "").trim() || "Workout";
                            const details = String(workout.details ?? "").trim();

                            return (
                              <View key={`${dRow.dateISO}-${workoutId}`} style={styles.workoutItem}>
                                <View style={styles.workoutCategoryBar}>
                                  {barCategoryNames.map((name) => (
                                    <View
                                      key={`${workoutId}-bar-${name}`}
                                      style={[
                                        styles.workoutCategoryBarSegment,
                                        { backgroundColor: categoryColorByName(categories, name) },
                                      ]}
                                    />
                                  ))}
                                </View>
                                <View style={styles.workoutItemContent}>
                                  {categoryNames.length > 0 ? (
                                    <View style={styles.categoryChipRow}>
                                      {categoryNames.map((name) => {
                                        const color = categoryColorByName(categories, name);
                                        return (
                                          <View key={`${workoutId}-${name}`} style={[styles.categoryChip, { borderColor: color }]}>
                                            <View style={[styles.categoryChipDot, { backgroundColor: color }]} />
                                            <Text style={styles.categoryChipText}>{name}</Text>
                                          </View>
                                        );
                                      })}
                                    </View>
                                  ) : null}
                                  <Text style={styles.workoutItemTitle}>{title}</Text>
                                  {details ? <Text style={styles.workoutItemDetails}>{details}</Text> : null}
                                  {groupMates.length > 0 ? (
                                    <Text style={styles.workoutGroupText}>Group: {formatGroupMateNamesCompact(groupMates)}</Text>
                                  ) : null}
                                </View>
                              </View>
                            );
                          })}
                        </View>
                      )}
                    </View>
                    ))}

                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 14, backgroundColor: "#fff" },

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

  header: { marginBottom: 10 },
  headerNavRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  monthNavButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#ddd",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fafafa",
  },
  monthNavButtonText: { fontWeight: "900", color: "#111" },
  weekLabel: { fontSize: 20, fontWeight: "900", color: "#111", textAlign: "center", flex: 1 },
  weekAnnotationChip: {
    alignSelf: "center",
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  weekAnnotationText: { fontSize: 11, fontWeight: "800" },
  athleteLabel: { marginTop: 4, color: "#666", fontWeight: "800" },

  goalsCard: {
    borderWidth: 1.25,
    borderColor: "#d8d8d8",
    backgroundColor: "#f5f8ff",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 9,
  },
  goalsCardPressed: { opacity: 0.9 },
  goalSingleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 16,
  },
  goalPrefix: { fontWeight: "900", color: "#111", fontSize: 12 },
  goalSingleItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 1,
  },
  goalSingleItemText: { fontWeight: "900", color: "#111", fontSize: 11.5 },
  goalDot: { color: "#64748b", fontWeight: "800", fontSize: 12 },
  goalLine: { fontWeight: "900", color: "#111", marginTop: 2 },
  goalMuted: { color: "#777", fontWeight: "800", fontSize: 12 },
  xtInlineRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginTop: 2 },
  xtInlineSegment: { flexDirection: "row", alignItems: "center", gap: 0 },

  listWrap: { flex: 1 },

  dayCard: { borderWidth: 1, borderColor: "#eee", borderRadius: 13, backgroundColor: "#fff", padding: 10, marginBottom: 8 },
  dayCardOff: { borderColor: "#e5e7eb", backgroundColor: "#f3f4f6" },
  dayHeaderRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  dayHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  dayName: { fontSize: 16, fontWeight: "900", color: "#111" },
  dayOffBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#f8fafc",
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  dayOffBadgeDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: "#6B7280" },
  dayOffBadgeText: { fontSize: 11, fontWeight: "800", color: "#334155" },
  dayNumber: { fontSize: 16, fontWeight: "900" },
  dateISO: { fontSize: 12, color: "#777", fontWeight: "800" },
  sessionBlock: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 9,
    backgroundColor: "#f8fafc",
    padding: 8,
  },
  sessionBlockCompact: {
    paddingVertical: 6,
  },
  sessionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sessionLeft: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  sessionTitle: { fontSize: 11, fontWeight: "900", color: "#334155", letterSpacing: 0.35 },
  sessionMeta: { fontSize: 11, fontWeight: "700", color: "#64748b", flexShrink: 1 },
  sessionPlanned: { fontSize: 11.5, fontWeight: "900", color: "#0f172a" },
  sessionChoiceValueRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 4 },
  sessionChoicePart: { flexDirection: "row", alignItems: "center", columnGap: 4 },
  sessionChoiceSeparator: { fontSize: 12, fontWeight: "800", color: "#334155" },
  sessionRows: { marginTop: 6, gap: 6 },
  workoutItem: {
    position: "relative",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 9,
    backgroundColor: "#ffffff",
    overflow: "hidden",
  },
  workoutCategoryBar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
  },
  workoutCategoryBarSegment: {
    flex: 1,
  },
  workoutItemContent: {
    padding: 7,
    paddingLeft: 9,
  },
  categoryChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginBottom: 4 },
  categoryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 7,
    paddingVertical: 1.5,
  },
  categoryChipDot: { width: 7, height: 7, borderRadius: 3.5 },
  categoryChipText: { fontSize: 11, fontWeight: "800", color: "#334155" },
  workoutItemTitle: { fontSize: 13, lineHeight: 17, fontWeight: "900", color: "#0f172a" },
  workoutItemDetails: { marginTop: 2, color: "#526173", fontWeight: "600" },
  workoutGroupText: { marginTop: 3, color: "#64748b", fontSize: 11, fontWeight: "600" },
  dayActionRow: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dayActionText: { color: "#0f172a", fontWeight: "800" },
  dayActionChevron: { color: "#64748b", fontSize: 18, lineHeight: 18, fontWeight: "700" },
});
