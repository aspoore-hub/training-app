import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { loadJSON, saveJSON } from "../../lib/storage";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../lib/pace";
import { distanceUnitLabel, loadDistanceUnit, type DistanceUnit } from "../../lib/units";
import type { AthleteWorkout, MileageValue, WeekStartDay } from "../../lib/types";
import { resolveAthleteSessionContext } from "../../lib/athleteSession";
import { ATHLETE_CALENDAR_VIEW_STATE_KEY, type AthleteCalendarViewState } from "../../lib/athleteCalendarView";
import { loadRosterNameMapForTeam } from "../../lib/rosterNameMap";
import { listAthleteWorkoutsInRange, listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
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

const ATHLETE_DAY_UI_STATE_KEY = "training_app_athlete_day_ui_state_v1";

type AthleteDayUiState = {
  dateISO?: string;
};

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
  const [paceSecPerMile, setPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("mi");
  const [rosterNameById, setRosterNameById] = useState<Map<string, string>>(new Map());
  const [loadingContext, setLoadingContext] = useState(true);
  const lastLoadRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });
  const inFlightRef = useRef(false);
  const activeLoadKeyRef = useRef("");

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

  useEffect(() => {
    async function load() {
      if (inFlightRef.current) return;
      const loadKey = String(currentDateISO);
      const now = Date.now();
      if (lastLoadRef.current.key === loadKey && now - lastLoadRef.current.ts < 12000) {
        return;
      }
      activeLoadKeyRef.current = loadKey;
      inFlightRef.current = true;
      setLoadingContext(true);
      try {
        const [ws, pace, unit, athleteSession] = await Promise.all([
          loadWeekStartSetting(),
          loadPaceSecondsPerMile(),
          loadDistanceUnit(),
          resolveAthleteSessionContext(),
        ]);

        const resolvedWeekStart: WeekStartDay = ws.normalized === "sunday" ? 0 : 1;
        console.log("[athlete-day] week start loaded via shared helper", {
          raw: ws.raw,
          normalized: resolvedWeekStart,
        });
        setWeekStartsOn(resolvedWeekStart);
        setPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
        setDistanceUnit(unit);

        const resolvedId = String(athleteSession.athleteId ?? "").trim() || null;
        const resolvedName = resolvedId ? String(athleteSession.athleteName ?? "").trim() || null : null;

        setRosterNameById(new Map());
        setSelectedAthleteName(resolvedName);
        setSelectedAthleteId(resolvedId);

        const weekStartISO = getWeekStartISO(String(currentDateISO), resolvedWeekStart);
        void teamDataStore.actions.loadMileageWeek(weekStartISO);

        if (!currentDateISO || !resolvedId) {
          setAllWorkouts([]);
          setWorkouts([]);
          return;
        }

        const athleteRows = await listAthleteWorkoutsInRange(String(resolvedId), String(currentDateISO), String(currentDateISO));
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
        lastLoadRef.current = { key: loadKey, ts: Date.now() };

        // Hydrate roster + team rows in background for group-mate context and names.
        void (async () => {
          const rosterMap = await loadRosterNameMapForTeam(athleteSession.teamId);
          if (activeLoadKeyRef.current !== loadKey) return;
          setRosterNameById(rosterMap);
          const allRows = await listTeamWorkoutsInRange(String(currentDateISO), String(currentDateISO));
          if (activeLoadKeyRef.current !== loadKey) return;
          const mapped = allRows.map((row) => toAthleteWorkout(row, rosterMap));
          setAllWorkouts(mapped);
        })();
      } finally {
        setLoadingContext(false);
        inFlightRef.current = false;
      }
    }

    void load();
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
          <View
            style={{
              borderWidth: 1,
              borderColor: "#e2e8f0",
              borderRadius: 12,
              backgroundColor: "#fff",
              padding: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <Text style={{ fontWeight: "900", color: "#0f172a" }}>{item.session}</Text>
              {item.prescribed ? (
                <Text style={{ color: "#334155", fontWeight: "800" }}>Plan: {item.prescribed}</Text>
              ) : null}
            </View>

            {item.workouts.length === 0 && item.prescribed ? (
              <View style={{ marginTop: 8 }}>
                <Pressable
                  onPress={() =>
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
                      },
                    })
                  }
                  style={{
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    backgroundColor: "#f8fafc",
                    paddingVertical: 9,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ fontWeight: "800", color: "#0f172a" }}>Open feedback</Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ marginTop: 8, gap: 8 }}>
                {item.workouts.map((workout) => {
                  const preRoutineIds = Array.isArray(workout.preRoutineIds) ? workout.preRoutineIds : [];
                  const postRoutineIds = Array.isArray(workout.postRoutineIds) ? workout.postRoutineIds : [];
                  const peers = groupMatesByWorkoutId.get(workout.id) ?? [];
                  const prescribed = item.session === "AM" ? dayPlan?.am : dayPlan?.pm;
                  const prescribedLabel = formatMileage(prescribed) || "Off";
                  const routineCount = preRoutineIds.length + postRoutineIds.length;

                  return (
                    <Pressable
                      key={workout.id}
                      onPress={() =>
                        router.push({
                          pathname: "/(athlete)/workout/[id]",
                          params: { id: workout.id, name: selectedAthleteName },
                        })
                      }
                      style={{
                        padding: 10,
                        borderRadius: 10,
                        backgroundColor: "#f8fafc",
                        borderWidth: 1,
                        borderColor: "#dbe7f3",
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontWeight: "900", fontSize: 16, color: "#0f172a" }}>{workout.title || "Workout"}</Text>
                          <Text style={{ marginTop: 3, color: "#475569", fontWeight: "700" }}>
                            {workout.time ? `${workout.time}` : "Time TBA"}
                            {workout.category ? ` • ${workout.category}` : ""}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 12, fontWeight: "800", color: "#1e40af" }}>Open</Text>
                      </View>

                      {workout.details ? (
                        <Text numberOfLines={3} style={{ marginTop: 7, color: "#1f2937" }}>
                          {workout.details}
                        </Text>
                      ) : null}

                      {routineCount > 0 ? (
                        <Text style={{ marginTop: 7, color: "#334155", fontWeight: "700" }}>
                          Routines: {preRoutineIds.length} pre • {postRoutineIds.length} post
                        </Text>
                      ) : null}

                      {peers.length > 0 ? (
                        <Text style={{ marginTop: 6, color: "#475569", fontWeight: "700" }}>
                          With {peers.length} teammate{peers.length === 1 ? "" : "s"}
                        </Text>
                      ) : null}

                      <Text style={{ marginTop: 6, color: "#0f172a", fontWeight: "800" }}>
                        Prescribed: {prescribedLabel}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
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
    </View>
  );
}
