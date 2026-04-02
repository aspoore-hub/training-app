import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { loadJSON, saveJSON } from "../../lib/storage";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../lib/pace";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../lib/units";
import type { AthleteWorkout, MileageValue, WeekStartDay } from "../../lib/types";
import { getCurrentTeamId, getMyClaimedAthleteProfileId } from "../../lib/team";
import { loadRosterNameMapForTeam } from "../../lib/rosterNameMap";
import { listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../lib/teamDataStore";
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
import { loadWeekStartSetting } from "../../lib/settings";
import { PrevNextNavButtons } from "../../components/shared/PrevNextNavButtons";
import { SectionEmptyText, SectionLabel } from "../../components/shared/PlannedRecordedPrimitives";

const KEY_SELECTED = "training_app_selected_athlete_v1";
const ATHLETE_DAY_UI_STATE_KEY = "training_app_athlete_day_ui_state_v1";

type AthleteDayUiState = {
  dateISO?: string;
};

type ListRow =
  | { type: "header"; key: string; title: "AM" | "PM" }
  | { type: "item"; key: string; workout: AthleteWorkout };

function normalizeGroupId(groupId?: string): string {
  const normalized = String(groupId ?? "").trim().toUpperCase();
  return normalized || "A";
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

export default function AthleteDayScreen() {
  const router = useRouter();
  const store = teamDataStore.use();
  const { date } = useLocalSearchParams<{ date: string }>();
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
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());

  const dayPlan = useMemo(() => {
    if (!currentDateISO || !selectedAthleteId) return null;

    const weekStartISO = getWeekStartISO(String(currentDateISO), weekStartsOn);
    const idx = getWeekIndex(String(currentDateISO), weekStartISO);
    if (idx < 0 || idx > 6) return null;

    const cells = store.mileageCellsByWeek[weekStartISO] ?? [];
    const flags = store.mileageFlagsByWeek[weekStartISO] ?? [];

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
  }, [currentDateISO, paceSecPerMile, selectedAthleteId, store.mileageCellsByWeek, store.mileageFlagsByWeek, weekStartsOn]);

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
  const hasAmWorkout = amWorkouts.length > 0;
  const hasPmWorkout = pmWorkouts.length > 0;

  const plannedAm = useMemo(() => (dayPlan ? formatMileage(dayPlan.am) : ""), [dayPlan]);
  const plannedPm = useMemo(() => (dayPlan ? formatMileage(dayPlan.pm) : ""), [dayPlan]);

  const plannedSessions = useMemo(
    () =>
      [
        plannedAm ? { session: "AM" as const, prescribed: plannedAm, showFeedbackEntry: !hasAmWorkout } : null,
        plannedPm ? { session: "PM" as const, prescribed: plannedPm, showFeedbackEntry: !hasPmWorkout } : null,
      ].filter((entry): entry is { session: "AM" | "PM"; prescribed: string; showFeedbackEntry: boolean } => Boolean(entry)),
    [hasAmWorkout, hasPmWorkout, plannedAm, plannedPm]
  );

  const rows = useMemo(() => {
    const out: ListRow[] = [];

    if (amWorkouts.length > 0) {
      out.push({ type: "header", key: "h-am", title: "AM" });
      amWorkouts.forEach((workout, index) => out.push({ type: "item", key: `am-workout-${index}`, workout }));
    }

    if (pmWorkouts.length > 0) {
      out.push({ type: "header", key: "h-pm", title: "PM" });
      pmWorkouts.forEach((workout, index) => out.push({ type: "item", key: `pm-workout-${index}`, workout }));
    }

    return out;
  }, [amWorkouts, pmWorkouts]);

  const plannedLine = useMemo(() => {
    if (!dayPlan) return "Off";
    const parts: string[] = [];
    if (plannedAm) parts.push(`AM ${plannedAm}`);
    if (plannedPm) parts.push(`PM ${plannedPm}`);
    if (parts.length === 0) return "Off";
    return parts.join(" • ");
  }, [dayPlan, plannedAm, plannedPm]);

  const plannedTotal = useMemo(() => {
    if (!dayPlan) return "";
    const label = formatSum(dayPlan.total);
    if (!label) return "";
    return `${label} ${distanceUnitLabel(distanceUnit)}`;
  }, [dayPlan, distanceUnit]);

  useEffect(() => {
    async function load() {
      const [selected, ws, pace, unit] = await Promise.all([
        loadJSON<string | null>(KEY_SELECTED, null),
        loadWeekStartSetting(),
        loadPaceSecondsPerMile(),
        loadDistanceUnit(),
      ]);

      const resolvedWeekStart: WeekStartDay = ws.normalized === "sunday" ? 0 : 1;
      console.log("[athlete-day] week start loaded via shared helper", {
        raw: ws.raw,
        normalized: resolvedWeekStart,
      });
      setWeekStartsOn(resolvedWeekStart);
      setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
      setDistanceUnit(unit);

      const teamId = await getCurrentTeamId();
      const [claimedAthleteId, rosterMap] = await Promise.all([
        getMyClaimedAthleteProfileId(teamId),
        loadRosterNameMapForTeam(teamId),
      ]);

      const selectedRaw = String(selected ?? "").trim();
      const resolvedId = String(claimedAthleteId ?? selectedRaw).trim() || null;
      const resolvedName = resolvedId ? String(rosterMap.get(resolvedId) ?? "").trim() || null : null;

      setRosterNameById(rosterMap);

      setSelectedAthleteName(resolvedName);
      setSelectedAthleteId(resolvedId);

      const weekStartISO = getWeekStartISO(String(currentDateISO), resolvedWeekStart);
      await teamDataStore.actions.loadMileageWeek(weekStartISO);

      if (!currentDateISO || (!resolvedName && !resolvedId)) {
        setAllWorkouts([]);
        setWorkouts([]);
        return;
      }

      const allRows = await listTeamWorkoutsInRange(String(currentDateISO), String(currentDateISO));
      const mapped = allRows.map((row) => toAthleteWorkout(row, rosterMap));
      const filtered = mapped
        .filter((w) => String(w.dateISO) === String(currentDateISO) && String((w as any).athleteId ?? "") === String(resolvedId ?? ""))
        .sort((a, b) => {
          const sessionCompare = String(a.session ?? "").localeCompare(String(b.session ?? ""));
          if (sessionCompare !== 0) return sessionCompare;
          return String(a.title ?? "").localeCompare(String(b.title ?? ""));
        });

      setAllWorkouts(mapped);
      setWorkouts(filtered);
    }

    load();
  }, [currentDateISO]);

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
      params: { date: next },
    });
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

  if (!selectedAthleteName) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 20 }}>
        <Text style={{ fontSize: 16, fontWeight: "700", marginBottom: 10 }}>No athlete selected</Text>
        <Text style={{ opacity: 0.7, textAlign: "center", marginBottom: 16 }}>
          Select an athlete to view workouts and submit feedback.
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
        </View>
      </View>

      <GestureDetector gesture={pan}>
      <Animated.View style={[{ flex: 1 }, animatedStyle]}>
      <View
        style={{
          marginTop: 12,
          padding: 14,
          borderRadius: 14,
          backgroundColor: dayPlan?.ncaaOff ? "#eaf4ff" : "#fafafa",
          borderWidth: 1,
          borderColor: dayPlan?.ncaaOff ? "#b8d8ff" : "#eee",
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "900", letterSpacing: 0.6, color: "#64748b" }}>PLAN SUMMARY</Text>
        <Text style={{ fontWeight: "900", marginTop: 4, marginBottom: 4, fontSize: 16, color: "#0f172a" }}>
          {plannedLine}
        </Text>
        {plannedTotal ? (
          <Text style={{ fontWeight: "800", color: "#334155" }}>Distance goal: {plannedTotal}</Text>
        ) : null}
        {dayPlan?.ncaaOff ? (
          <Text style={{ marginTop: 6, fontSize: 12, color: "#0a5eb7", fontWeight: "900" }}>
            Suggested Training - NCAA Off Day. Feedback not required.
          </Text>
        ) : null}
        {dayPlan ? (
          <Text style={{ marginTop: 6, fontSize: 12, color: "#64748b", fontWeight: "700" }}>
            Week starts: {formatDisplayDate(dayPlan.weekStartISO)}
          </Text>
        ) : null}
      </View>

      <Text style={{ marginTop: 10, marginBottom: 8, color: "#475569", fontWeight: "700" }}>
        Athlete: {selectedAthleteName}
      </Text>

      <View
        style={{
          padding: 12,
          borderRadius: 14,
          backgroundColor: "#f8fafc",
          borderWidth: 1,
          borderColor: "#dbeafe",
          marginBottom: 12,
        }}
      >
        <SectionLabel style={{ color: "#0f172a", marginTop: 0, marginBottom: 10 }}>Planned Sessions</SectionLabel>
        {plannedSessions.length === 0 ? (
          <SectionEmptyText style={{ color: "#475569", fontWeight: "600", marginTop: 0 }}>
            No planned sessions for this day.
          </SectionEmptyText>
        ) : (
          plannedSessions.map((planned) => (
            <View
              key={`planned-${planned.session}`}
              style={{
                borderWidth: 1,
                borderColor: "#e2e8f0",
                borderRadius: 10,
                backgroundColor: "#fff",
                padding: 10,
                marginBottom: 8,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <Text style={{ fontWeight: "900", color: "#111827" }}>{planned.session} Plan</Text>
                {planned.showFeedbackEntry ? (
                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: "/(athlete)/workout/[id]",
                        params: {
                          id: `planned-${String(currentDateISO)}-${planned.session}`,
                          synthetic: "1",
                          date: String(currentDateISO),
                          session: planned.session,
                          prescribed: planned.prescribed,
                          athleteId: selectedAthleteId ?? "",
                          name: selectedAthleteName,
                        },
                      })
                    }
                    style={{
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: "#cbd5e1",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "#fff",
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                      flexDirection: "row",
                      gap: 6,
                    }}
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={16} color="#111" />
                    <Text style={{ fontWeight: "800", color: "#0f172a", fontSize: 12 }}>Feedback</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={{ marginTop: 6, color: "#1f2937", fontWeight: "800" }}>
                Prescribed: {planned.prescribed}
              </Text>
            </View>
          ))
        )}
      </View>

      <SectionLabel style={{ color: "#0f172a", marginTop: 0, marginBottom: 8 }}>Today's Workouts</SectionLabel>
      {rows.length === 0 && (
        <SectionEmptyText style={{ marginTop: 0, marginBottom: 12, color: "#475569", fontWeight: "600" }}>
          No workouts assigned for this day.
        </SectionEmptyText>
      )}

      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => {
          if (item.type === "header") {
            return (
              <Text style={{ marginTop: 8, marginBottom: 8, fontWeight: "900", color: "#334155" }}>
                {item.title}
              </Text>
            );
          }

          const workout = item.workout;
          const preRoutineIds = Array.isArray(workout.preRoutineIds) ? workout.preRoutineIds : [];
          const postRoutineIds = Array.isArray(workout.postRoutineIds) ? workout.postRoutineIds : [];
          const peers = groupMatesByWorkoutId.get(workout.id) ?? [];
          const prescribed = (workout.session ?? "PM") === "AM" ? dayPlan?.am : dayPlan?.pm;
          const prescribedLabel = formatMileage(prescribed) || "Off";
          const routineCount = preRoutineIds.length + postRoutineIds.length;

          return (
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/(athlete)/workout/[id]",
                  params: { id: workout.id, name: selectedAthleteName },
                })
              }
              style={{
                padding: 14,
                borderRadius: 14,
                backgroundColor: "#fff",
                marginBottom: 12,
                borderWidth: 1,
                borderColor: "#e2e8f0",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "900", fontSize: 17, color: "#0f172a" }}>{workout.title || "Workout"}</Text>
                  <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>
                    {(workout.session ?? "PM")}
                    {workout.time ? ` • ${workout.time}` : ""}
                    {workout.category ? ` • ${workout.category}` : ""}
                  </Text>
                </View>
                <View
                  style={{
                    alignSelf: "center",
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    backgroundColor: "#f8fafc",
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#0f172a" }}>Open</Text>
                </View>
              </View>

              {workout.details ? (
                <Text numberOfLines={3} style={{ marginTop: 8, color: "#1f2937" }}>
                  {workout.details}
                </Text>
              ) : null}

              {routineCount > 0 ? (
                <Text style={{ marginTop: 8, color: "#334155", fontWeight: "700" }}>
                  Routines: {preRoutineIds.length} pre • {postRoutineIds.length} post
                </Text>
              ) : null}

              {peers.length > 0 ? (
                <Text style={{ marginTop: 8, color: "#444", fontWeight: "700" }}>
                  Working out with {peers.length} teammate{peers.length === 1 ? "" : "s"}
                </Text>
              ) : null}

              <Text style={{ marginTop: 8, color: "#0f172a", fontWeight: "800" }}>
                Prescribed mileage: {prescribedLabel}
              </Text>
              <Text style={{ marginTop: 8, color: "#2563eb", fontWeight: "800" }}>
                Tap to open workout details and feedback
              </Text>
            </Pressable>
          );
        }}
      />
      </Animated.View>
      </GestureDetector>
    </View>
  );
}
