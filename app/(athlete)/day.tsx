import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { loadJSON } from "../../lib/storage";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../lib/pace";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../lib/units";
import type { AthleteWorkout, WeekStartDay, WeeklyMileagePlan } from "../../lib/types";
import { loadAuxiliaryRoutines } from "../../lib/auxiliaryRoutines";
import { getCurrentTeamId, getMyClaimedAthleteProfileId } from "../../lib/team";
import { loadRosterNameMapForTeam } from "../../lib/rosterNameMap";
import { listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
import {
  WEEK_START_KEY,
  MILEAGE_PLANS_KEY,
  getWeekStartISO,
  getWeekIndex,
  getDayTarget,
  sumMileage,
  formatSum,
  formatMileage,
  parseISODate,
  toISODate,
} from "../../lib/mileagePlan";

const KEY_SELECTED = "training_app_selected_athlete_v1";

type SessionRowItem =
  | { kind: "workout"; workout: AthleteWorkout }
  | { kind: "planned"; session: "AM" | "PM"; prescribed: string };

type ListRow =
  | { type: "header"; key: string; title: "AM" | "PM" }
  | { type: "item"; key: string; item: SessionRowItem };

function slugName(name: string) {
  return String(name ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function normalizeAthleteId(value: string | null | undefined) {
  let v = String(value ?? "").trim().toLowerCase();
  if (!v) return "";
  if (v.startsWith("ath_")) v = v.slice(4);
  v = v.replace(/_\d+$/, "");
  return v;
}

function athletePlanMatches(planAthleteId: string, selectedAthleteId: string | null, selectedAthleteName: string | null) {
  const planRaw = String(planAthleteId ?? "");
  const selectedRaw = String(selectedAthleteId ?? "");
  if (planRaw && selectedRaw && planRaw === selectedRaw) return true;

  const planNorm = normalizeAthleteId(planRaw);
  const selectedNorm = normalizeAthleteId(selectedRaw);
  if (planNorm && selectedNorm && planNorm === selectedNorm) return true;

  const selectedNameSlug = slugName(String(selectedAthleteName ?? ""));
  if (planNorm && selectedNameSlug && planNorm === selectedNameSlug) return true;

  return false;
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
    plannedMiles: typeof row.planned_distance === "number" ? row.planned_distance : undefined,
    completedMiles: typeof (row as any).completed_miles === "number" ? (row as any).completed_miles : undefined,
    completedTime: String((row as any).completed_time_text ?? "").trim() || undefined,
    splitsOrPace: String((row as any).splits_or_pace ?? "").trim() || undefined,
    additionalFeedback: String((row as any).additional_feedback ?? "").trim() || undefined,
    feedback: String((row as any).additional_feedback ?? "").trim() || undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

export default function AthleteDayScreen() {
  const router = useRouter();
  const { date } = useLocalSearchParams<{ date: string }>();
  const [currentDateISO, setCurrentDateISO] = useState<string>(String(date ?? ""));

  const [allWorkouts, setAllWorkouts] = useState<AthleteWorkout[]>([]);
  const [workouts, setWorkouts] = useState<AthleteWorkout[]>([]);
  const [selectedAthleteName, setSelectedAthleteName] = useState<string | null>(null);
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [plans, setPlans] = useState<WeeklyMileagePlan[]>([]);
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());
  const [routineById, setRoutineById] = useState<Map<string, { title: string; details: string }>>(new Map());

  const dayPlan = useMemo(() => {
    if (!currentDateISO || !selectedAthleteId) return null;

    const weekStartISO = getWeekStartISO(String(currentDateISO), weekStartsOn);
    const plan = plans.find(
      (p) =>
        athletePlanMatches(String(p.athleteId), selectedAthleteId, selectedAthleteName) &&
        String(p.weekStartISO) === String(weekStartISO)
    );
    if (!plan) return null;

    const idx = getWeekIndex(String(currentDateISO), weekStartISO);
    if (idx < 0 || idx > 6) return null;

    const target = getDayTarget(plan, idx);
    const total = sumMileage([target.am, target.pm], paceSecPerMile);

    return {
      weekStartISO,
      am: target.am,
      pm: target.pm,
      ncaaOff: !!(target as any).ncaaOff,
      total,
    };
  }, [currentDateISO, paceSecPerMile, plans, selectedAthleteId, selectedAthleteName, weekStartsOn]);

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

  const rows = useMemo(() => {
    const out: ListRow[] = [];

    const amItems: SessionRowItem[] = amWorkouts.map((workout) => ({ kind: "workout", workout }));
    if (amItems.length === 0 && plannedAm) {
      amItems.push({ kind: "planned", session: "AM", prescribed: plannedAm });
    }

    const pmItems: SessionRowItem[] = pmWorkouts.map((workout) => ({ kind: "workout", workout }));
    if (pmItems.length === 0 && plannedPm) {
      pmItems.push({ kind: "planned", session: "PM", prescribed: plannedPm });
    }

    if (amItems.length > 0) {
      out.push({ type: "header", key: "h-am", title: "AM" });
      amItems.forEach((item, index) => out.push({ type: "item", key: `am-${item.kind}-${index}`, item }));
    }

    if (pmItems.length > 0) {
      out.push({ type: "header", key: "h-pm", title: "PM" });
      pmItems.forEach((item, index) => out.push({ type: "item", key: `pm-${item.kind}-${index}`, item }));
    }

    return out;
  }, [amWorkouts, plannedAm, plannedPm, pmWorkouts]);

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
      const [selected, ws, storedPlans, pace, unit, routines] = await Promise.all([
        loadJSON<string | null>(KEY_SELECTED, null),
        loadJSON<WeekStartDay>(WEEK_START_KEY, 1),
        loadJSON<WeeklyMileagePlan[]>(MILEAGE_PLANS_KEY, []),
        loadPaceSecondsPerMile(),
        loadDistanceUnit(),
        loadAuxiliaryRoutines(),
      ]);

      setWeekStartsOn((ws ?? 1) as WeekStartDay);
      setPlans(storedPlans ?? []);
      setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
      setDistanceUnit(unit);
      setRoutineById(
        new Map(
          routines.map((routine) => [
            routine.id,
            { title: routine.title, details: routine.details },
          ])
        )
      );

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
    setCurrentDateISO(String(date ?? ""));
  }, [date]);

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
    <View style={{ flex: 1, padding: 20 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <Pressable
          onPress={() => navigateDay(-1)}
          style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: "#ddd", alignItems: "center", justifyContent: "center", backgroundColor: "#fafafa" }}
        >
          <Text style={{ fontWeight: "900", color: "#111" }}>◀</Text>
        </Pressable>
        <Text style={{ fontSize: 20, fontWeight: "700" }}>{formatDisplayDate(String(currentDateISO ?? ""))}</Text>
        <Pressable
          onPress={() => navigateDay(1)}
          style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: "#ddd", alignItems: "center", justifyContent: "center", backgroundColor: "#fafafa" }}
        >
          <Text style={{ fontWeight: "900", color: "#111" }}>▶</Text>
        </Pressable>
      </View>

      <GestureDetector gesture={pan}>
      <Animated.View style={[{ flex: 1 }, animatedStyle]}>
      <View
        style={{
          marginTop: 10,
          padding: 12,
          borderRadius: 12,
          backgroundColor: dayPlan?.ncaaOff ? "#eaf4ff" : "#fafafa",
          borderWidth: 1,
          borderColor: dayPlan?.ncaaOff ? "#b8d8ff" : "#eee",
        }}
      >
        <Text style={{ fontWeight: "900", marginBottom: 4 }}>Planned: {plannedLine}</Text>
        {plannedTotal ? (
          <Text style={{ fontWeight: "800", color: "#444" }}>Distance goal: {plannedTotal}</Text>
        ) : null}
        {dayPlan?.ncaaOff ? (
          <Text style={{ marginTop: 6, fontSize: 12, color: "#0a5eb7", fontWeight: "900" }}>
            Suggested Training - NCAA Off Day. Feedback not required.
          </Text>
        ) : null}
        {dayPlan ? (
          <Text style={{ marginTop: 6, fontSize: 12, color: "#666", fontWeight: "700" }}>
            Week starts: {formatDisplayDate(dayPlan.weekStartISO)}
          </Text>
        ) : null}
      </View>

      <Text style={{ marginTop: 10, marginBottom: 12, opacity: 0.7 }}>{selectedAthleteName}</Text>

      {rows.length === 0 && <Text>No workouts for this day</Text>}

      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => {
          if (item.type === "header") {
            return (
              <Text style={{ marginTop: 6, marginBottom: 8, fontWeight: "900", color: "#333" }}>
                {item.title}
              </Text>
            );
          }

          if (item.item.kind === "planned") {
            const planned = item.item;
            return (
              <View
                style={{
                  padding: 14,
                  borderRadius: 12,
                  backgroundColor: "#fff",
                  marginBottom: 12,
                  borderWidth: 1,
                  borderColor: "#e5e5e5",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: "900", fontSize: 16 }}>{planned.session} Session</Text>
                  </View>

                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: "/(athlete)/workout/[id]",
                        params: {
                          id: `planned-${String(date)}-${planned.session}`,
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
                      width: 34,
                      height: 34,
                      borderRadius: 17,
                      borderWidth: 1,
                      borderColor: "#ddd",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "#fafafa",
                    }}
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={18} color="#111" />
                  </Pressable>
                </View>

                <Text style={{ marginTop: 8, color: "#222", fontWeight: "800" }}>
                  Prescribed: {planned.prescribed}
                </Text>
              </View>
            );
          }

          const workout = item.item.workout;
          const preRoutineIds = Array.isArray(workout.preRoutineIds) ? workout.preRoutineIds : [];
          const postRoutineIds = Array.isArray(workout.postRoutineIds) ? workout.postRoutineIds : [];
          const peers = groupMatesByWorkoutId.get(workout.id) ?? [];
          const prescribed = (workout.session ?? "PM") === "AM" ? dayPlan?.am : dayPlan?.pm;
          const prescribedLabel = formatMileage(prescribed) || "Off";

          return (
            <View
              style={{
                padding: 14,
                borderRadius: 12,
                backgroundColor: "#fff",
                marginBottom: 12,
                borderWidth: 1,
                borderColor: "#e5e5e5",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() =>
                    router.push({
                      pathname: "/(athlete)/workout/[id]",
                      params: { id: workout.id, name: selectedAthleteName },
                    })
                  }
                >
                  <Text style={{ fontWeight: "900", fontSize: 16 }}>{workout.title || "Workout"}</Text>
                  <Text style={{ opacity: 0.75, marginTop: 3 }}>
                    {(workout.session ?? "PM")} • {workout.time ? `${workout.time} • ` : ""}{workout.category}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/(athlete)/workout/[id]",
                      params: { id: workout.id, name: selectedAthleteName },
                    })
                  }
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 17,
                    borderWidth: 1,
                    borderColor: "#ddd",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "#fafafa",
                  }}
                >
                  <Ionicons name="chatbubble-ellipses-outline" size={18} color="#111" />
                </Pressable>
              </View>

              {workout.details ? <Text style={{ marginTop: 8, color: "#222" }}>{workout.details}</Text> : null}

              {preRoutineIds.length > 0 ? (
                <View style={{ marginTop: 8 }}>
                  <Text style={{ fontWeight: "800", color: "#333" }}>Pre-run:</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {preRoutineIds.map((routineId) => {
                      const routine = routineById.get(routineId);
                      if (!routine) return null;
                      return (
                        <Pressable
                          key={`pre-${workout.id}-${routineId}`}
                          onPress={() => Alert.alert(routine.title, routine.details || "No details entered.")}
                          style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, backgroundColor: "#fafafa" }}
                        >
                          <Text style={{ fontWeight: "700", color: "#222" }}>{routine.title}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              {postRoutineIds.length > 0 ? (
                <View style={{ marginTop: 8 }}>
                  <Text style={{ fontWeight: "800", color: "#333" }}>Post-run:</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {postRoutineIds.map((routineId) => {
                      const routine = routineById.get(routineId);
                      if (!routine) return null;
                      return (
                        <Pressable
                          key={`post-${workout.id}-${routineId}`}
                          onPress={() => Alert.alert(routine.title, routine.details || "No details entered.")}
                          style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, backgroundColor: "#fafafa" }}
                        >
                          <Text style={{ fontWeight: "700", color: "#222" }}>{routine.title}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              {peers.length > 0 ? (
                <Text style={{ marginTop: 8, color: "#444", fontWeight: "700" }}>
                  Working out with: {peers.join(", ")}
                </Text>
              ) : null}

              <Text style={{ marginTop: 8, color: "#222", fontWeight: "800" }}>
                Prescribed mileage: {prescribedLabel}
              </Text>
            </View>
          );
        }}
      />
      </Animated.View>
      </GestureDetector>
    </View>
  );
}
