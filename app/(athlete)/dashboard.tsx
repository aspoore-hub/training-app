import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { loadFeedbackFlagSettings, type FeedbackWarningMode } from "../../lib/feedbackFlags";
import { loadMileageFeedback, type MileageSessionFeedback } from "../../lib/mileageFeedback";
import { loadWeekStartSetting } from "../../lib/settings";
import { loadJSON } from "../../lib/storage";
import { getCurrentTeamId, getMyClaimedAthleteProfileId, getTeamAthlete } from "../../lib/team";
import { listAthleteWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../lib/teamDataStore";
import { formatMileage, getWeekIndex, getWeekStartISO, parseISODate, parseMileageInput, toISODate } from "../../lib/mileagePlan";
import type { MileageValue, WeekStartDay } from "../../lib/types";

const KEY_SELECTED = "training_app_selected_athlete_v1";

type PendingTarget = {
  key: string;
  title: string;
  subtitle: string;
  description?: string;
  routeParams: Record<string, string>;
};

function normalizeSession(value: string | undefined): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
}

function toMileageValue(raw: unknown): MileageValue | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return parseMileageInput(raw);
  if (typeof raw === "number") return { kind: "exact", value: raw };
  if (typeof raw === "object") return raw as MileageValue;
  return undefined;
}

function addDaysISO(dateISO: string, days: number) {
  const d = parseISODate(dateISO);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function daysBetween(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  let current = String(startISO);
  while (current <= endISO) {
    out.push(current);
    current = addDaysISO(current, 1);
  }
  return out;
}

function hasFeedbackInWorkout(row: TeamWorkoutRow): boolean {
  return (
    typeof (row as any).completed_miles === "number" ||
    String((row as any).completed_time_text ?? "").trim().length > 0 ||
    String((row as any).splits_or_pace ?? "").trim().length > 0 ||
    String((row as any).additional_feedback ?? "").trim().length > 0
  );
}

function hasFeedbackInMileageEntry(entry: MileageSessionFeedback): boolean {
  return (
    typeof entry.completedMiles === "number" ||
    String(entry.completedTime ?? "").trim().length > 0 ||
    String(entry.splitsOrPace ?? "").trim().length > 0 ||
    String(entry.additionalFeedback ?? "").trim().length > 0
  );
}

function isDateWithinWindow(
  dateISO: string,
  todayISO: string,
  mode: FeedbackWarningMode,
  startDateISO?: string
) {
  if (!dateISO || dateISO > todayISO) return false;

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
  return dateISO >= start && dateISO <= todayISO;
}

export default function AthleteDashboardScreen() {
  const router = useRouter();
  const store = teamDataStore.use();

  const [loading, setLoading] = useState(true);
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [selectedAthleteName, setSelectedAthleteName] = useState<string | null>(null);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [todayRows, setTodayRows] = useState<TeamWorkoutRow[]>([]);
  const [windowRows, setWindowRows] = useState<TeamWorkoutRow[]>([]);
  const [windowMileageFeedbackEntries, setWindowMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [feedbackWindowMode, setFeedbackWindowMode] = useState<FeedbackWarningMode>("all");
  const [feedbackWindowStartDateISO, setFeedbackWindowStartDateISO] = useState<string | undefined>(undefined);

  const todayISO = useMemo(() => toISODate(new Date()), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [selected, weekStartResult, allMileageFeedback, feedbackSettings] = await Promise.all([
        loadJSON<string | null>(KEY_SELECTED, null),
        loadWeekStartSetting(),
        loadMileageFeedback(),
        loadFeedbackFlagSettings(),
      ]);

      const resolvedWeekStart: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      setWeekStartsOn(resolvedWeekStart);
      setFeedbackWindowMode(feedbackSettings.mode ?? "all");
      setFeedbackWindowStartDateISO(feedbackSettings.startDateISO);

      const teamId = await getCurrentTeamId();
      const claimedAthleteId = await getMyClaimedAthleteProfileId(teamId);
      const fallbackSelected = String(selected ?? "").trim();
      const resolvedAthleteId = String(claimedAthleteId ?? fallbackSelected).trim();
      setSelectedAthleteId(resolvedAthleteId || null);

      if (!resolvedAthleteId) {
        setSelectedAthleteName(null);
        setTodayRows([]);
        setWindowRows([]);
        setWindowMileageFeedbackEntries([]);
        return;
      }

      let athleteName: string | null = null;
      try {
        const athlete = await getTeamAthlete(resolvedAthleteId);
        athleteName = String(athlete?.display_name ?? "").trim() || null;
      } catch {
        athleteName = null;
      }
      setSelectedAthleteName(athleteName);

      const windowDates = daysBetween(addDaysISO(todayISO, -90), todayISO).filter((dateISO) =>
        isDateWithinWindow(dateISO, todayISO, feedbackSettings.mode ?? "all", feedbackSettings.startDateISO)
      );
      const windowStartISO = windowDates[0] ?? todayISO;
      const windowEndISO = windowDates[windowDates.length - 1] ?? todayISO;

      const weekStartsToLoad = new Set<string>();
      weekStartsToLoad.add(getWeekStartISO(todayISO, resolvedWeekStart));
      windowDates.forEach((dateISO) => weekStartsToLoad.add(getWeekStartISO(dateISO, resolvedWeekStart)));
      await Promise.all(Array.from(weekStartsToLoad).map((weekStartISO) => teamDataStore.actions.loadMileageWeek(weekStartISO)));

      const rows = await listAthleteWorkoutsInRange(resolvedAthleteId, windowStartISO, windowEndISO);
      setWindowRows(rows);
      setTodayRows(rows.filter((row) => String(row.date_iso) === todayISO));

      const filteredMileage = allMileageFeedback.filter((entry) => {
        const entryAthleteId = String((entry as any)?.athleteId ?? "").trim();
        const byId = entryAthleteId === resolvedAthleteId;
        const byName =
          !entryAthleteId &&
          athleteName &&
          String(entry.athleteName ?? "").trim().toLowerCase() === athleteName.toLowerCase();
        if (!byId && !byName) return false;
        return windowDates.includes(String(entry.dateISO ?? ""));
      });
      setWindowMileageFeedbackEntries(filteredMileage);
    } finally {
      setLoading(false);
    }
  }, [todayISO]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData])
  );

  const todayAssignment = useMemo(() => {
    if (!selectedAthleteId) return null;
    const weekStartISO = getWeekStartISO(todayISO, weekStartsOn);
    const idx = getWeekIndex(todayISO, weekStartISO);
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

    return {
      amLabel: String(formatMileage(am) ?? "").trim(),
      pmLabel: String(formatMileage(pm) ?? "").trim(),
      ncaaOff,
      hasPlan: Boolean(am || pm || ncaaOff),
    };
  }, [selectedAthleteId, store.mileageCellsByWeek, store.mileageFlagsByWeek, todayISO, weekStartsOn]);

  const todayWorkoutSummary = useMemo(() => {
    const sorted = [...todayRows].sort((a, b) => {
      const sessionCompare = normalizeSession(a.session).localeCompare(normalizeSession(b.session));
      if (sessionCompare !== 0) return sessionCompare;
      return String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? "")) * -1;
    });
    const first = sorted[0] ?? null;
    return {
      first,
      count: sorted.length,
    };
  }, [todayRows]);

  const pendingTarget = useMemo<PendingTarget | null>(() => {
    if (!selectedAthleteId) return null;

    const windowDates = daysBetween(addDaysISO(todayISO, -90), todayISO).filter((dateISO) =>
      isDateWithinWindow(dateISO, todayISO, feedbackWindowMode, feedbackWindowStartDateISO)
    );

    const workoutBySession = new Map<string, TeamWorkoutRow[]>();
    const workoutFeedbackBySession = new Map<string, boolean>();

    for (const row of windowRows) {
      const dateISO = String(row.date_iso ?? "");
      if (!windowDates.includes(dateISO)) continue;
      const session = normalizeSession(row.session);
      const key = `${dateISO}|${session}`;
      const list = workoutBySession.get(key) ?? [];
      list.push(row);
      workoutBySession.set(key, list);
      if (hasFeedbackInWorkout(row)) workoutFeedbackBySession.set(key, true);
    }

    const mileageFeedbackBySession = new Set<string>();
    for (const entry of windowMileageFeedbackEntries) {
      if (!hasFeedbackInMileageEntry(entry)) continue;
      const dateISO = String(entry.dateISO ?? "");
      const session = normalizeSession(entry.session);
      mileageFeedbackBySession.add(`${dateISO}|${session}`);
    }

    const newestDates = [...windowDates].sort((a, b) => b.localeCompare(a));
    for (const dateISO of newestDates) {
      const weekStartISO = getWeekStartISO(dateISO, weekStartsOn);
      const idx = getWeekIndex(dateISO, weekStartISO);
      if (idx < 0 || idx > 6) continue;

      const cells = store.mileageCellsByWeek[weekStartISO] ?? [];
      const flags = store.mileageFlagsByWeek[weekStartISO] ?? [];
      const ncaaOff =
        flags.find(
          (row) =>
            String(row.athlete_profile_id) === String(selectedAthleteId) &&
            row.day_idx === idx
        )?.ncaa_off ?? false;

      for (const session of ["PM", "AM"] as const) {
        const key = `${dateISO}|${session}`;
        const sessionWorkouts = workoutBySession.get(key) ?? [];
        const hasWorkout = sessionWorkouts.length > 0;

        const planValue = toMileageValue(
          cells.find(
            (row) =>
              String(row.athlete_profile_id) === String(selectedAthleteId) &&
              row.day_idx === idx &&
              row.session === session
          )?.value
        );
        const planLabel = String(formatMileage(planValue) ?? "").trim();
        const hasPlan = planLabel.length > 0;

        const requiresFeedback = !ncaaOff && (hasWorkout || hasPlan);
        if (!requiresFeedback) continue;

        const hasFeedback = Boolean(workoutFeedbackBySession.get(key)) || mileageFeedbackBySession.has(key);
        if (hasFeedback) continue;

        const topWorkout = [...sessionWorkouts].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
        if (topWorkout) {
          return {
            key: `workout-${topWorkout.id}`,
            title: String(topWorkout.title ?? `${session} Workout`),
            subtitle: `${formatDisplayDate(dateISO)} • ${session}`,
            description:
              String(topWorkout.time_text ?? "").trim() || String(topWorkout.primary_category ?? "").trim() || "Feedback pending",
            routeParams: {
              id: String(topWorkout.id),
              name: String(selectedAthleteName ?? "Athlete"),
            } as Record<string, string>,
          };
        }

        return {
          key: `synthetic-${key}`,
          title: `${session} Planned Session`,
          subtitle: `${formatDisplayDate(dateISO)} • ${session}`,
          description: planLabel ? `Prescribed: ${planLabel}` : "Planned from mileage schedule",
          routeParams: {
            id: `planned-${dateISO}-${session}`,
            synthetic: "1",
            date: dateISO,
            session,
            prescribed: planLabel,
            athleteId: String(selectedAthleteId ?? ""),
            name: String(selectedAthleteName ?? "Athlete"),
          } as Record<string, string>,
        };
      }
    }

    return null;
  }, [feedbackWindowMode, feedbackWindowStartDateISO, selectedAthleteId, selectedAthleteName, store.mileageCellsByWeek, store.mileageFlagsByWeek, todayISO, weekStartsOn, windowMileageFeedbackEntries, windowRows]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "#f6f8fb" }}
      contentContainerStyle={{ padding: 16, paddingBottom: 30 }}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={{
          borderRadius: 16,
          borderWidth: 1,
          borderColor: "#dbeafe",
          backgroundColor: "#ffffff",
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>ATHLETE HOME</Text>
        <Text style={{ marginTop: 6, fontSize: 28, fontWeight: "900", color: "#0f172a" }}>Dashboard</Text>
        <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>
          {selectedAthleteName ? `${selectedAthleteName} • ` : ""}
          {formatDisplayDate(todayISO)}
        </Text>
        <View style={{ marginTop: 12, flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => router.push("/(athlete)/month")}
            style={{
              flex: 1,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#cbd5e1",
              backgroundColor: "#f8fafc",
              paddingVertical: 11,
              alignItems: "center",
            }}
          >
            <Text style={{ fontWeight: "800", color: "#0f172a" }}>Open Calendar</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/(athlete)/day",
                params: { date: todayISO },
              })
            }
            style={{
              flex: 1,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#bfdbfe",
              backgroundColor: "#eff6ff",
              paddingVertical: 11,
              alignItems: "center",
            }}
          >
            <Text style={{ fontWeight: "800", color: "#1e40af" }}>Open Daily View</Text>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={{ marginTop: 10, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 2 }}>
          <ActivityIndicator />
          <Text style={{ color: "#64748b", fontWeight: "600" }}>Loading dashboard...</Text>
        </View>
      ) : null}

      {!loading && !selectedAthleteId ? (
        <View
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: "#fde68a",
            backgroundColor: "#fffbeb",
          }}
        >
          <Text style={{ fontWeight: "800", color: "#78350f" }}>No athlete selected</Text>
          <Text style={{ marginTop: 6, color: "#92400e" }}>
            Join or select an athlete profile first.
          </Text>
          <Pressable
            onPress={() => router.push("/(athlete)")}
            style={{
              marginTop: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#eab308",
              backgroundColor: "white",
              paddingVertical: 9,
              alignItems: "center",
            }}
          >
            <Text style={{ fontWeight: "800", color: "#78350f" }}>Go to Athlete Home</Text>
          </Pressable>
        </View>
      ) : null}

      <View
        style={{
          marginTop: 16,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#dbeafe",
          backgroundColor: "#ffffff",
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>TODAY'S PLAN</Text>
        <Text style={{ marginTop: 4, fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Today's Assignment</Text>
        {loading ? (
          <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "700" }}>Loading assignment...</Text>
        ) : !todayAssignment?.hasPlan ? (
          <View
            style={{
              marginTop: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#e2e8f0",
              backgroundColor: "#f8fafc",
              paddingVertical: 9,
              paddingHorizontal: 10,
            }}
          >
            <Text style={{ color: "#475569", fontWeight: "700" }}>No assignment set for today.</Text>
            <Text style={{ marginTop: 2, color: "#64748b", fontSize: 12 }}>Open Daily View to review your full day.</Text>
          </View>
        ) : (
          <>
            <View style={{ marginTop: 10, gap: 8 }}>
              {todayAssignment.amLabel ? (
                <View
                  style={{
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: "#e2e8f0",
                    backgroundColor: "#f8fafc",
                    padding: 10,
                  }}
                >
                  <Text style={{ fontWeight: "900", color: "#334155", fontSize: 12 }}>AM</Text>
                  <Text style={{ marginTop: 3, color: "#0f172a", fontWeight: "900", fontSize: 16 }}>{todayAssignment.amLabel}</Text>
                </View>
              ) : null}
              {todayAssignment.pmLabel ? (
                <View
                  style={{
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: "#e2e8f0",
                    backgroundColor: "#f8fafc",
                    padding: 10,
                  }}
                >
                  <Text style={{ fontWeight: "900", color: "#334155", fontSize: 12 }}>PM</Text>
                  <Text style={{ marginTop: 3, color: "#0f172a", fontWeight: "900", fontSize: 16 }}>{todayAssignment.pmLabel}</Text>
                </View>
              ) : null}
            </View>
            {todayAssignment.ncaaOff ? (
              <Text style={{ marginTop: 10, color: "#0a5eb7", fontWeight: "900" }}>
                Suggested Training - NCAA Off Day
              </Text>
            ) : null}
          </>
        )}
        <Pressable
          onPress={() =>
            router.push({
              pathname: "/(athlete)/day",
              params: { date: todayISO },
            })
          }
          style={{
            marginTop: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: "#bfdbfe",
            backgroundColor: "#eff6ff",
            paddingVertical: 11,
            alignItems: "center",
          }}
        >
          <Text style={{ fontWeight: "800", color: "#1e40af" }}>Review Full Daily Plan</Text>
        </Pressable>
      </View>

      <View
        style={{
          marginTop: 14,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#e2e8f0",
          backgroundColor: "#ffffff",
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>WORKOUT</Text>
        <Text style={{ marginTop: 4, fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Today's Workout</Text>
        {loading ? (
          <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "700" }}>Loading workout...</Text>
        ) : !todayWorkoutSummary.first ? (
          <View
            style={{
              marginTop: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#e2e8f0",
              backgroundColor: "#f8fafc",
              paddingVertical: 9,
              paddingHorizontal: 10,
            }}
          >
            <Text style={{ color: "#475569", fontWeight: "700" }}>No workout assigned for today.</Text>
            <Text style={{ marginTop: 2, color: "#64748b", fontSize: 12 }}>Check Calendar for upcoming sessions.</Text>
          </View>
        ) : (
          <>
            <Text style={{ marginTop: 8, fontSize: 16, fontWeight: "900", color: "#111827" }}>
              {String(todayWorkoutSummary.first.title ?? "Workout")}
            </Text>
            <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>
              {normalizeSession(todayWorkoutSummary.first.session)}
              {String(todayWorkoutSummary.first.time_text ?? "").trim()
                ? ` • ${String(todayWorkoutSummary.first.time_text).trim()}`
                : ""}
              {String(todayWorkoutSummary.first.primary_category ?? "").trim()
                ? ` • ${String(todayWorkoutSummary.first.primary_category).trim()}`
                : ""}
            </Text>
            {String(todayWorkoutSummary.first.details ?? "").trim() ? (
              <Text style={{ marginTop: 6, color: "#334155" }} numberOfLines={3}>
                {String(todayWorkoutSummary.first.details ?? "")}
              </Text>
            ) : null}
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/(athlete)/workout/[id]",
                  params: {
                    id: String(todayWorkoutSummary.first?.id ?? ""),
                    name: String(selectedAthleteName ?? "Athlete"),
                  },
                })
              }
              style={{
                marginTop: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: "#cbd5e1",
                backgroundColor: "#f8fafc",
                paddingVertical: 11,
                alignItems: "center",
              }}
            >
              <Text style={{ fontWeight: "800", color: "#0f172a" }}>Open Today's Workout</Text>
            </Pressable>
            {todayWorkoutSummary.count > 1 ? (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/(athlete)/day",
                    params: { date: todayISO },
                  })
                }
                style={{ marginTop: 8, alignSelf: "center" }}
              >
                <Text style={{ color: "#2563eb", fontWeight: "800" }}>
                  View all {todayWorkoutSummary.count} workouts today
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>

      <View
        style={{
          marginTop: 14,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: pendingTarget ? "#fecaca" : "#bbf7d0",
          backgroundColor: "#ffffff",
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>TASK</Text>
        <View style={{ marginTop: 4, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Needs Feedback</Text>
          <View
            style={{
              borderRadius: 999,
              borderWidth: 1,
              borderColor: pendingTarget ? "#fecaca" : "#bbf7d0",
              backgroundColor: pendingTarget ? "#fff1f2" : "#f0fdf4",
              paddingHorizontal: 9,
              paddingVertical: 3,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "900", color: pendingTarget ? "#991b1b" : "#166534" }}>
              {loading ? "Loading" : pendingTarget ? "Pending" : "All Clear"}
            </Text>
          </View>
        </View>
        {loading ? (
          <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "700" }}>Checking feedback status...</Text>
        ) : !pendingTarget ? (
          <View
            style={{
              marginTop: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#bbf7d0",
              backgroundColor: "#f0fdf4",
              paddingVertical: 9,
              paddingHorizontal: 10,
            }}
          >
            <Text style={{ color: "#166534", fontWeight: "900" }}>All caught up.</Text>
            <Text style={{ marginTop: 2, color: "#166534" }}>No pending feedback right now.</Text>
          </View>
        ) : (
          <>
            <Text style={{ marginTop: 8, fontSize: 16, fontWeight: "900", color: "#111827" }}>
              {pendingTarget.title}
            </Text>
            <Text style={{ marginTop: 3, color: "#475569", fontWeight: "700" }}>{pendingTarget.subtitle}</Text>
            {pendingTarget.description ? (
              <Text style={{ marginTop: 5, color: "#334155" }}>{pendingTarget.description}</Text>
            ) : null}
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/(athlete)/workout/[id]",
                  params: pendingTarget.routeParams,
                })
              }
              style={{
                marginTop: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: "#fecaca",
                backgroundColor: "#fff1f2",
                paddingVertical: 11,
                alignItems: "center",
              }}
            >
              <Text style={{ fontWeight: "800", color: "#991b1b" }}>Open pending feedback</Text>
            </Pressable>
          </>
        )}
      </View>
    </ScrollView>
  );
}
