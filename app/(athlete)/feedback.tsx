import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { loadFeedbackFlagSettings, type FeedbackWarningMode } from "../../lib/feedbackFlags";
import { loadMileageFeedback, type MileageSessionFeedback } from "../../lib/mileageFeedback";
import { loadWeekStartSetting } from "../../lib/settings";
import { loadJSON, saveJSON } from "../../lib/storage";
import { getCurrentTeamId, getMyClaimedAthleteProfileId, getTeamAthlete } from "../../lib/team";
import { listAthleteWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../lib/teamDataStore";
import { formatMileage, getWeekIndex, getWeekStartISO, parseISODate, parseMileageInput, toISODate } from "../../lib/mileagePlan";
import type { MileageValue, WeekStartDay } from "../../lib/types";
const ATHLETE_FEEDBACK_UI_STATE_KEY = "training_app_athlete_feedback_ui_state_v1";

type PendingItem = {
  key: string;
  dateISO: string;
  session: "AM" | "PM";
  title: string;
  subtitle: string;
  description?: string;
  routeParams: Record<string, string>;
};

type SubmittedItem = {
  key: string;
  dateISO: string;
  updatedAt: number;
  title: string;
  subtitle: string;
  routeParams: Record<string, string>;
};

type AthleteFeedbackUiState = {
  scrollY?: number;
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

function daysBetween(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  let current = String(startISO);
  while (current <= endISO) {
    out.push(current);
    current = addDaysISO(current, 1);
  }
  return out;
}

export default function FeedbackHub() {
  const router = useRouter();
  const store = teamDataStore.use();
  const scrollRef = useRef<ScrollView | null>(null);
  const restoredScrollAppliedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [selectedAthleteName, setSelectedAthleteName] = useState<string | null>(null);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [windowMode, setWindowMode] = useState<FeedbackWarningMode>("all");
  const [windowStartDateISO, setWindowStartDateISO] = useState<string | undefined>(undefined);
  const [workoutRows, setWorkoutRows] = useState<TeamWorkoutRow[]>([]);
  const [mileageFeedbackEntries, setMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [scrollY, setScrollY] = useState(0);
  const [uiHydrated, setUiHydrated] = useState(false);

  const todayISO = useMemo(() => toISODate(new Date()), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [weekStartResult, flagSettings, allMileageFeedback] = await Promise.all([
        loadWeekStartSetting(),
        loadFeedbackFlagSettings(),
        loadMileageFeedback(),
      ]);

      const resolvedWeekStart: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      setWeekStartsOn(resolvedWeekStart);
      setWindowMode(flagSettings.mode ?? "all");
      setWindowStartDateISO(flagSettings.startDateISO);

      const teamId = await getCurrentTeamId();
      const claimedAthleteId = await getMyClaimedAthleteProfileId(teamId);
      const resolvedAthleteId = String(claimedAthleteId ?? "").trim();
      setSelectedAthleteId(resolvedAthleteId || null);

      if (!resolvedAthleteId) {
        setSelectedAthleteName(null);
        setWorkoutRows([]);
        setMileageFeedbackEntries([]);
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
        isDateWithinWindow(dateISO, todayISO, flagSettings.mode ?? "all", flagSettings.startDateISO)
      );

      if (windowDates.length === 0) {
        setWorkoutRows([]);
        setMileageFeedbackEntries([]);
        return;
      }

      const startISO = windowDates[0];
      const endISO = windowDates[windowDates.length - 1];

      const uniqueWeekStarts = Array.from(
        new Set(windowDates.map((dateISO) => getWeekStartISO(dateISO, resolvedWeekStart)))
      );
      await Promise.all(uniqueWeekStarts.map((weekStartISO) => teamDataStore.actions.loadMileageWeek(weekStartISO)));

      const rows = await listAthleteWorkoutsInRange(resolvedAthleteId, startISO, endISO);
      setWorkoutRows(rows);

      const filteredMileageFeedback = allMileageFeedback.filter((entry) => {
        const entryAthleteId = String((entry as any)?.athleteId ?? "").trim();
        const athleteMatchById = entryAthleteId === resolvedAthleteId;
        const athleteMatchByName =
          !entryAthleteId &&
          athleteName &&
          String(entry.athleteName ?? "").trim().toLowerCase() === athleteName.toLowerCase();
        if (!athleteMatchById && !athleteMatchByName) return false;
        return windowDates.includes(String(entry.dateISO ?? ""));
      });
      setMileageFeedbackEntries(filteredMileageFeedback);
    } finally {
      setLoading(false);
    }
  }, [todayISO]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const saved = await loadJSON<AthleteFeedbackUiState>(ATHLETE_FEEDBACK_UI_STATE_KEY, {});
      if (!mounted) return;
      const nextY =
        typeof saved?.scrollY === "number" && Number.isFinite(saved.scrollY) && saved.scrollY >= 0
          ? saved.scrollY
          : 0;
      setScrollY(nextY);
      setUiHydrated(true);
    })().catch(() => {
      if (mounted) setUiHydrated(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!uiHydrated) return;
    const timer = setTimeout(() => {
      void saveJSON<AthleteFeedbackUiState>(ATHLETE_FEEDBACK_UI_STATE_KEY, { scrollY });
    }, 180);
    return () => clearTimeout(timer);
  }, [scrollY, uiHydrated]);

  useEffect(() => {
    if (!uiHydrated) return;
    if (loading) return;
    if (restoredScrollAppliedRef.current) return;
    if (!scrollRef.current) return;
    restoredScrollAppliedRef.current = true;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: scrollY, animated: false });
    });
  }, [loading, scrollY, uiHydrated]);

  const windowDates = useMemo(
    () =>
      daysBetween(addDaysISO(todayISO, -90), todayISO).filter((dateISO) =>
        isDateWithinWindow(dateISO, todayISO, windowMode, windowStartDateISO)
      ),
    [todayISO, windowMode, windowStartDateISO]
  );

  const plannedBySession = useMemo(() => {
    const map = new Map<string, { prescribed: string; hasPlan: boolean }>();
    if (!selectedAthleteId) return map;

    for (const dateISO of windowDates) {
      const weekStartISO = getWeekStartISO(dateISO, weekStartsOn);
      const idx = getWeekIndex(dateISO, weekStartISO);
      if (idx < 0 || idx > 6) continue;

      const cells = store.mileageCellsByWeek[weekStartISO] ?? [];
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

      const amPrescribed = String(formatMileage(am) ?? "").trim();
      const pmPrescribed = String(formatMileage(pm) ?? "").trim();

      map.set(`${dateISO}|AM`, { prescribed: amPrescribed, hasPlan: amPrescribed.length > 0 });
      map.set(`${dateISO}|PM`, { prescribed: pmPrescribed, hasPlan: pmPrescribed.length > 0 });
    }

    return map;
  }, [selectedAthleteId, store.mileageCellsByWeek, weekStartsOn, windowDates]);

  const sections = useMemo(() => {
    const pending: PendingItem[] = [];
    const submitted: SubmittedItem[] = [];

    const workoutBySession = new Map<string, TeamWorkoutRow[]>();
    const workoutSessionHasFeedback = new Map<string, boolean>();

    for (const row of workoutRows) {
      const dateISO = String(row.date_iso ?? "");
      if (!windowDates.includes(dateISO)) continue;
      const session = normalizeSession(row.session);
      const key = `${dateISO}|${session}`;
      const existing = workoutBySession.get(key) ?? [];
      existing.push(row);
      workoutBySession.set(key, existing);

      const hasFeedback = hasFeedbackInWorkout(row);
      if (hasFeedback) {
        workoutSessionHasFeedback.set(key, true);
        submitted.push({
          key: `workout:${row.id}`,
          dateISO,
          updatedAt: Date.parse(String((row as any).updated_at ?? "")) || 0,
          title: String(row.title ?? "Workout"),
          subtitle: `${formatDisplayDate(dateISO)} • ${session}`,
          routeParams: {
            id: String(row.id),
            name: String(selectedAthleteName ?? "Athlete"),
          },
        });
      }
    }

    const mileageFeedbackBySession = new Map<string, MileageSessionFeedback>();
    for (const entry of mileageFeedbackEntries) {
      if (!hasFeedbackInMileageEntry(entry)) continue;
      const dateISO = String(entry.dateISO ?? "");
      const session = normalizeSession(entry.session);
      const key = `${dateISO}|${session}`;
      mileageFeedbackBySession.set(key, entry);

      if (workoutSessionHasFeedback.get(key)) continue;

      const prescribed = String(entry.prescribed ?? "").trim();
      submitted.push({
        key: `synthetic:${entry.id}`,
        dateISO,
        updatedAt: Number(entry.updatedAt ?? 0),
        title: `${session} Planned Session`,
        subtitle: `${formatDisplayDate(dateISO)} • ${session}`,
        routeParams: {
          id: `planned-${dateISO}-${session}`,
          synthetic: "1",
          date: dateISO,
          session,
          prescribed,
          athleteId: String(selectedAthleteId ?? ""),
          name: String(selectedAthleteName ?? "Athlete"),
        },
      });
    }

    for (const dateISO of windowDates) {
      for (const session of ["AM", "PM"] as const) {
        const key = `${dateISO}|${session}`;
        const sessionWorkouts = workoutBySession.get(key) ?? [];
        sessionWorkouts.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) * -1);

        const hasWorkout = sessionWorkouts.length > 0;
        const hasPlan = plannedBySession.get(key)?.hasPlan ?? false;
        const prescribed = String(plannedBySession.get(key)?.prescribed ?? "").trim();
        const requiresFeedback = hasWorkout || hasPlan;
        if (!requiresFeedback) continue;

        const hasFeedback = workoutSessionHasFeedback.get(key) || mileageFeedbackBySession.has(key);
        if (hasFeedback) continue;

        const topWorkout = sessionWorkouts[0];
        if (topWorkout) {
          pending.push({
            key: `pending-workout:${topWorkout.id}`,
            dateISO,
            session,
            title: String(topWorkout.title ?? `${session} Workout`),
            subtitle: `${formatDisplayDate(dateISO)} • ${session}`,
            description: String(topWorkout.time_text ?? "").trim() || String(topWorkout.primary_category ?? "").trim() || undefined,
            routeParams: {
              id: String(topWorkout.id),
              name: String(selectedAthleteName ?? "Athlete"),
            },
          });
        } else {
          pending.push({
            key: `pending-synthetic:${dateISO}|${session}`,
            dateISO,
            session,
            title: `${session} Planned Session`,
            subtitle: `${formatDisplayDate(dateISO)} • ${session}`,
            description: prescribed ? `Prescribed: ${prescribed}` : "Planned from mileage schedule",
            routeParams: {
              id: `planned-${dateISO}-${session}`,
              synthetic: "1",
              date: dateISO,
              session,
              prescribed,
              athleteId: String(selectedAthleteId ?? ""),
              name: String(selectedAthleteName ?? "Athlete"),
            },
          });
        }
      }
    }

    pending.sort((a, b) => {
      const dateCompare = String(a.dateISO).localeCompare(String(b.dateISO));
      if (dateCompare !== 0) return dateCompare;
      return a.session === "AM" ? -1 : 1;
    });

    const recent = submitted
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12);

    return { pending, recent };
  }, [mileageFeedbackEntries, plannedBySession, selectedAthleteId, selectedAthleteName, windowDates, workoutRows]);

  const pending = sections.pending;
  const recent = sections.recent;

  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: "#f6f8fb" }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      keyboardShouldPersistTaps="handled"
      onScroll={(event) => {
        const y = Number(event.nativeEvent.contentOffset.y ?? 0);
        if (!Number.isFinite(y)) return;
        setScrollY(Math.max(0, y));
      }}
      scrollEventThrottle={16}
    >
      <Text style={{ fontSize: 28, fontWeight: "900", color: "#0f172a" }}>Feedback</Text>
      <Text style={{ marginTop: 6, color: "#475569", lineHeight: 20 }}>
        Finish pending feedback first, then review your recent submissions.
      </Text>

      {!selectedAthleteId && !loading ? (
        <View
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "#fde68a",
            backgroundColor: "#fffbeb",
          }}
        >
          <Text style={{ fontWeight: "800", color: "#78350f" }}>No athlete selected</Text>
          <Text style={{ marginTop: 6, color: "#92400e" }}>Join or select an athlete profile first.</Text>
          <Pressable
            onPress={() => router.push("/(athlete)")}
            style={{
              marginTop: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#eab308",
              backgroundColor: "white",
              paddingVertical: 10,
              alignItems: "center",
            }}
          >
            <Text style={{ fontWeight: "800", color: "#78350f" }}>Go to Athlete Home</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={{ marginTop: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Pending feedback</Text>
          <View
            style={{
              borderRadius: 999,
              backgroundColor: pending.length > 0 ? "#fee2e2" : "#dcfce7",
              borderWidth: 1,
              borderColor: pending.length > 0 ? "#fecaca" : "#bbf7d0",
              paddingHorizontal: 10,
              paddingVertical: 4,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "900", color: pending.length > 0 ? "#991b1b" : "#166534" }}>
              {pending.length} open
            </Text>
          </View>
        </View>

        {loading ? (
          <View style={{ marginTop: 14, paddingVertical: 20, alignItems: "center" }}>
            <ActivityIndicator />
            <Text style={{ marginTop: 8, color: "#64748b" }}>Loading feedback tasks...</Text>
          </View>
        ) : pending.length === 0 ? (
          <View
            style={{
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: "#bbf7d0",
              backgroundColor: "#f0fdf4",
              padding: 14,
            }}
          >
            <Text style={{ fontWeight: "900", color: "#166534" }}>All caught up</Text>
            <Text style={{ marginTop: 4, color: "#166534" }}>
              No pending feedback right now.
            </Text>
          </View>
        ) : (
          <View style={{ marginTop: 10, gap: 10 }}>
            {pending.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => router.push({ pathname: "/(athlete)/workout/[id]", params: item.routeParams })}
                style={{
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: "#fecaca",
                  backgroundColor: "#ffffff",
                  padding: 14,
                }}
              >
                <Text style={{ fontSize: 16, fontWeight: "900", color: "#111827" }}>{item.title}</Text>
                <Text style={{ marginTop: 3, color: "#475569", fontWeight: "700" }}>{item.subtitle}</Text>
                {item.description ? (
                  <Text style={{ marginTop: 5, color: "#334155" }}>{item.description}</Text>
                ) : null}
                <Text style={{ marginTop: 8, color: "#dc2626", fontWeight: "900" }}>Open feedback</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      <View style={{ marginTop: 20 }}>
        <Text style={{ fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Recent submissions</Text>
        {!loading && recent.length === 0 ? (
          <Text style={{ marginTop: 8, color: "#64748b" }}>No recent submissions yet.</Text>
        ) : (
          <View style={{ marginTop: 10, gap: 8 }}>
            {recent.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => router.push({ pathname: "/(athlete)/workout/[id]", params: item.routeParams })}
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  backgroundColor: "#ffffff",
                  padding: 12,
                }}
              >
                <Text style={{ fontWeight: "800", color: "#111827" }}>{item.title}</Text>
                <Text style={{ marginTop: 2, color: "#64748b" }}>{item.subtitle}</Text>
                <Text style={{ marginTop: 6, color: "#16a34a", fontWeight: "800" }}>Submitted</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
