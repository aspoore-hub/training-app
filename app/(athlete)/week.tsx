// app/(athlete)/week.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { loadJSON } from "../../lib/storage";
import { getCurrentTeamId, getMyClaimedAthleteProfileId, getTeamAthlete } from "../../lib/team";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../lib/units";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../lib/pace";
import { loadAthletePaceOverrides, resolveAthletePaceSeconds, type AthletePaceOverrides } from "../../lib/athletePace";
import type { AthleteWorkout, MileageValue, WeekStartDay, WorkoutCategory } from "../../lib/types";
import { CATEGORIES_KEY, categoryColorByName, normalizeCategories } from "../../lib/categories";
import {
  getWeekStartISO,
  getWeekIndex,
  formatMileage,
  parseMileageInput,
  sumMileage,
  parseISODate,
  toISODate,
} from "../../lib/mileagePlan";
import { listAthleteWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../lib/teamDataStore";
import { loadWeekStartSetting } from "../../lib/settings";
import { PrevNextNavButtons } from "../../components/shared/PrevNextNavButtons";
import { SegmentedViewToggle } from "../../components/shared/SegmentedViewToggle";
import { SectionEmptyText, SectionLabel } from "../../components/shared/PlannedRecordedPrimitives";

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

function workoutCategoryNames(w: AthleteWorkout): string[] {
  const arr = Array.isArray((w as any)?.categories)
    ? (w as any).categories
    : [(w as any)?.category ?? (w as any)?.categoryName ?? "Other"];
  const cleaned = arr.map((x: any) => String(x ?? "").trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["Other"];
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

function formatXTTotal(sec: SecRange) {
  if ((sec.min === 0 && sec.max === 0)) return "";
  const fmt = (s: number) => {
    const totalMin = Math.round(s / 60);
    if (totalMin < 60) return `${totalMin}min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}hr ${m}min`;
  };
  if (sec.min === sec.max) return `${fmt(sec.min)} XT`;
  return `${fmt(sec.min)}–${fmt(sec.max)} XT`;
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

export default function AthleteWeekView() {
  const router = useRouter();
  const store = teamDataStore.use();

  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [selectedAthleteLabel, setSelectedAthleteLabel] = useState<string | null>(null);

  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [allWorkouts, setAllWorkouts] = useState<AthleteWorkout[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [athletePaceOverrides, setAthletePaceOverrides] = useState<AthletePaceOverrides>({});

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
    const ws = await loadWeekStartFromShared();
    const [selected, storedCategories, unit, pace, paceOverrides] = await Promise.all([
      loadJSON<string | null>(SELECTED_KEY, null),
      loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
      loadDistanceUnit(),
      loadPaceSecondsPerMile(),
      loadAthletePaceOverrides(),
    ]);

    const teamId = await getCurrentTeamId();
    const claimedAthleteId = await getMyClaimedAthleteProfileId(teamId);
    const selectedId = String(claimedAthleteId ?? selected ?? "").trim();
    setSelectedAthleteId(selectedId || null);

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
    setDistanceUnit(unit);
    setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
    setAthletePaceOverrides(paceOverrides ?? {});

    const weekStartForFetch = getWeekStartISO(weekAnchorISO, ws);
    await teamDataStore.actions.loadMileageWeek(weekStartForFetch);

    if (!selectedId) {
      setAllWorkouts([]);
      return;
    }

    const weekEndForFetch = addDaysISO(weekStartForFetch, 6);
    const rows = await listAthleteWorkoutsInRange(selectedId, weekStartForFetch, weekEndForFetch);
    const athleteName = selectedName ?? "Athlete";
    setAllWorkouts(rows.map((row) => toAthleteWorkout(row, athleteName)));
  }, [loadWeekStartFromShared, weekAnchorISO]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const weekStartISO = useMemo(
    () => getWeekStartISO(weekAnchorISO, weekStartsOn),
    [weekAnchorISO, weekStartsOn]
  );

  const weekEndISO = useMemo(() => addDaysISO(weekStartISO, 6), [weekStartISO]);

  const weekLabel = useMemo(() => {
    // e.g. "Mar 3 – Mar 9"
    const s = parseISODate(weekStartISO);
    const e = parseISODate(weekEndISO);
    const sTxt = s.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const eTxt = e.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${sTxt} – ${eTxt}`;
  }, [weekStartISO, weekEndISO]);

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
      if (String(row.week_start_iso) !== String(weekStartISO)) continue;
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
      if (String(row.week_start_iso) !== String(weekStartISO)) continue;
      map.set(row.day_idx, !!row.ncaa_off);
    }
    return map;
  }, [selectedAthleteId, store.mileageFlagsByWeek, weekStartISO]);

  const effectivePaceSecPerMile = useMemo(
    () => resolveAthletePaceSeconds(selectedAthleteId, athletePaceOverrides, paceSecPerMile),
    [selectedAthleteId, athletePaceOverrides, paceSecPerMile]
  );

  const weeklyGoals = useMemo(() => {
    // planned miles (miles-only) + XT total time
    let miles: MilesRange = { min: 0, max: 0 };
    let xt: SecRange = { min: 0, max: 0 };

    for (let i = 0; i < 7; i++) {
      const am = mileageByDaySession.get(`${i}:AM`);
      const pm = mileageByDaySession.get(`${i}:PM`);
      miles = addMiles(miles, sumMileage([am], effectivePaceSecPerMile));
      miles = addMiles(miles, sumMileage([pm], effectivePaceSecPerMile));
      xt = addSecs(xt, toXTSecRange(am));
      xt = addSecs(xt, toXTSecRange(pm));
    }

    return {
      milesLabel: formatRoundedDistanceTotal(miles, distanceUnit),
      xtLabel: formatXTTotal(xt),
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
        <View>
          <Text style={styles.weekLabel}>{weekLabel}</Text>
          <Text style={styles.athleteLabel}>{selectedAthleteLabel ?? "Athlete"}</Text>
        </View>

        <PrevNextNavButtons onPrev={() => shiftWeek(-1)} onNext={() => shiftWeek(1)} />
      </View>

      {/* Weekly goals */}
      <Pressable style={({ pressed }) => [styles.goalsCard, pressed && styles.goalsCardPressed]}>
        <Text style={styles.goalsTitle}>This week&apos;s goal</Text>
        {weeklyGoals.milesLabel ? <Text style={styles.goalLine}>{weeklyGoals.milesLabel}</Text> : <Text style={styles.goalMuted}>No planned distance set</Text>}
        {weeklyGoals.xtLabel ? <Text style={styles.goalLine}>{weeklyGoals.xtLabel}</Text> : null}
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
              const hasPlannedWork = Boolean(amText || pmText || isNCAAOffDay);

              const workouts = workoutsByDate.get(dRow.dateISO) ?? [];

              return (
                <Pressable
                  key={dRow.dateISO}
                  onPress={() =>
                    router.push({
                      pathname: "/(athlete)/day",
                      params: { date: dRow.dateISO },
                    })
                  }
                  style={({ pressed }) => [styles.dayCard, isNCAAOffDay && styles.dayCardOff, pressed && { opacity: 0.75 }]}
                >
                  {/* Row header */}
                  <View style={styles.dayHeaderRow}>
                    <Text style={styles.dayName}>
                      {dRow.label} <Text style={styles.dayNumber}>{dRow.dayNumber}</Text>
                    </Text>
                    <Text style={styles.dateISO}>{formatDisplayDate(dRow.dateISO)}</Text>
                  </View>

                  <View style={styles.plannedBlock}>
                    <SectionLabel>Planned Work</SectionLabel>
                    {hasPlannedWork ? (
                      <>
                        {(amText || pmText) ? (
                          <View style={styles.planRow}>
                            {amText ? <Text style={styles.planPill}>AM {amText}</Text> : null}
                            {pmText ? <Text style={styles.planPill}>PM {pmText}</Text> : null}
                          </View>
                        ) : (
                          <SectionEmptyText>No mileage target</SectionEmptyText>
                        )}

                        {isNCAAOffDay ? (
                          <Text style={styles.offDayTag}>NCAA Off Day</Text>
                        ) : null}
                      </>
                    ) : (
                      <SectionEmptyText>No plan</SectionEmptyText>
                    )}
                  </View>

                  <View style={styles.recordedBlock}>
                    <SectionLabel>Recorded Workouts</SectionLabel>
                    {workouts.length > 0 ? (
                      <View style={{ marginTop: 8, gap: 6 }}>
                        {workouts.slice(0, 4).map((w: any, idx: number) => {
                          const cats = workoutCategoryNames(w);
                          const primary = cats[0] ?? "Other";
                          const color = categoryColorByName(categories, primary);

                          const session = String(w?.session ?? "").toUpperCase();
                          const title = String(w?.title ?? "").trim();
                          const details = String(w?.details ?? "").trim();

                          return (
                            <View key={`${dRow.dateISO}-${idx}-${primary}`} style={styles.workoutRow}>
                              <View style={[styles.colorDot, { backgroundColor: color }]} />
                              <View style={{ flex: 1 }}>
                                <Text style={styles.workoutTitle} numberOfLines={1}>
                                  {session ? `${session} • ` : ""}{primary}{title ? ` • ${title}` : ""}
                                </Text>
                                {details ? (
                                  <Text style={styles.workoutDetails} numberOfLines={2}>
                                    {details}
                                  </Text>
                                ) : null}
                              </View>
                            </View>
                          );
                        })}

                        {workouts.length > 4 ? (
                          <Text style={styles.moreWorkouts}>+{workouts.length - 4} more</Text>
                        ) : null}
                      </View>
                    ) : (
                      <SectionEmptyText>No workouts</SectionEmptyText>
                    )}
                  </View>
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

  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  weekLabel: { fontSize: 20, fontWeight: "900", color: "#111" },
  athleteLabel: { marginTop: 2, color: "#666", fontWeight: "800" },

  navBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: "#ddd", alignItems: "center", justifyContent: "center", backgroundColor: "#fafafa" },
  navBtnText: { fontWeight: "900", color: "#111" },

  goalsCard: { borderWidth: 1.5, borderColor: "#d8d8d8", backgroundColor: "#f5f8ff", borderRadius: 14, padding: 12, marginBottom: 12 },
  goalsCardPressed: { opacity: 0.9 },
  goalsTitle: { fontWeight: "900", color: "#111", marginBottom: 6, fontSize: 14 },
  goalLine: { fontWeight: "900", color: "#111", marginTop: 2 },
  goalMuted: { color: "#777", fontWeight: "800" },

  listWrap: { flex: 1 },

  dayCard: { borderWidth: 1, borderColor: "#eee", borderRadius: 14, backgroundColor: "#fff", padding: 12, marginBottom: 10 },
  dayCardOff: { borderColor: "#b8d8ff", backgroundColor: "#eaf4ff" },
  dayHeaderRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  dayName: { fontSize: 16, fontWeight: "900", color: "#111" },
  dayNumber: { fontSize: 16, fontWeight: "900" },
  dateISO: { fontSize: 12, color: "#777", fontWeight: "800" },
  plannedBlock: {
    marginTop: 4,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 10,
    backgroundColor: "#f8fafc",
  },
  recordedBlock: {
    marginTop: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#eceff3",
    borderRadius: 10,
    backgroundColor: "#ffffff",
  },

  planRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  planPill: { borderWidth: 1, borderColor: "#e8e8e8", backgroundColor: "#fafafa", paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, fontWeight: "900", color: "#111" },
  offDayTag: { marginTop: 6, color: "#0a5eb7", fontWeight: "900", fontSize: 12 },

  workoutRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  colorDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4, borderWidth: 0.5, borderColor: "rgba(0,0,0,0.15)" },
  workoutTitle: { fontWeight: "900", color: "#111" },
  workoutDetails: { marginTop: 2, color: "#555", fontWeight: "700" },
  moreWorkouts: { marginTop: 4, color: "#666", fontWeight: "800" },
});
