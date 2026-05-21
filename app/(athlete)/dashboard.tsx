import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { loadFeedbackFlagSettings, type FeedbackWarningMode } from "../../lib/feedbackFlags";
import {
  hasMileageFeedback as hasMileageFeedbackEntry,
  hasWorkoutFeedback as hasWorkoutFeedbackRow,
} from "../../lib/feedbackParsing";
import { loadMileageFeedback, type MileageSessionFeedback } from "../../lib/mileageFeedback";
import { loadWeekStartSetting } from "../../lib/settings";
import { loadJSON } from "../../lib/storage";
import { resolveAthleteSessionContext } from "../../lib/athleteSession";
import { listAthleteWorkoutsInRange, type TeamWorkoutRow } from "../../lib/teamWorkoutsCloud";
import { teamDataStore } from "../../lib/teamDataStore";
import { formatMileage, getWeekIndex, getWeekStartISO, parseISODate, parseMileageInput, toISODate } from "../../lib/mileagePlan";
import { CATEGORIES_KEY, categoryColorByName, normalizeCategories } from "../../lib/categories";
import type { MileageValue, WeekStartDay, WorkoutCategory } from "../../lib/types";

type PendingTarget = {
  key: string;
  title: string;
  subtitle: string;
  description?: string;
  routeParams: Record<string, string>;
};

type SessionPreview = {
  session: "AM" | "PM";
  workoutId: string;
  title: string;
  details: string;
  timeLocation: string;
  categories: string[];
  moreCount: number;
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

function workoutCategoryNames(row: TeamWorkoutRow): string[] {
  const arr = Array.isArray((row as any)?.categories)
    ? (row as any).categories
    : [String((row as any)?.primary_category ?? "Other")];
  const cleaned = arr.map((x: any) => String(x ?? "").trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["Other"];
}

function hasFeedbackInWorkout(row: TeamWorkoutRow): boolean {
  return hasWorkoutFeedbackRow(row);
}

function hasFeedbackInMileageEntry(entry: MileageSessionFeedback): boolean {
  return hasMileageFeedbackEntry(entry);
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
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [windowRows, setWindowRows] = useState<TeamWorkoutRow[]>([]);
  const [windowMileageFeedbackEntries, setWindowMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [feedbackWindowMode, setFeedbackWindowMode] = useState<FeedbackWarningMode>("all");
  const [feedbackWindowStartDateISO, setFeedbackWindowStartDateISO] = useState<string | undefined>(undefined);
  const [pendingLoading, setPendingLoading] = useState(true);
  const lastLoadRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });
  const inFlightRef = useRef(false);
  const activeLoadKeyRef = useRef("");

  const todayISO = useMemo(() => toISODate(new Date()), []);

  const loadData = useCallback(async () => {
    if (inFlightRef.current) return;
    const loadKey = todayISO;
    const now = Date.now();
    if (lastLoadRef.current.key === loadKey && now - lastLoadRef.current.ts < 12000) {
      return;
    }
    inFlightRef.current = true;
    activeLoadKeyRef.current = loadKey;
    setLoading(true);
    setPendingLoading(true);
    try {
      const [weekStartResult, feedbackSettings, athleteSession, storedCategories] = await Promise.all([
        loadWeekStartSetting(),
        loadFeedbackFlagSettings(),
        resolveAthleteSessionContext(),
        loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
      ]);

      const resolvedWeekStart: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      setWeekStartsOn(resolvedWeekStart);
      setFeedbackWindowMode(feedbackSettings.mode ?? "all");
      setFeedbackWindowStartDateISO(feedbackSettings.startDateISO);

      const resolvedAthleteId = String(athleteSession.athleteId ?? "").trim();
      setSelectedAthleteId(resolvedAthleteId || null);
      setCategories(normalizeCategories(storedCategories));

      if (!resolvedAthleteId) {
        setSelectedAthleteName(null);
        setTodayRows([]);
        setWindowRows([]);
        setWindowMileageFeedbackEntries([]);
        setPendingLoading(false);
        setLoading(false);
        return;
      }

      const athleteName = String(athleteSession.athleteName ?? "").trim() || null;
      setSelectedAthleteName(athleteName);

      const windowDates = daysBetween(addDaysISO(todayISO, -90), todayISO).filter((dateISO) =>
        isDateWithinWindow(dateISO, todayISO, feedbackSettings.mode ?? "all", feedbackSettings.startDateISO)
      );
      const windowStartISO = windowDates[0] ?? todayISO;
      const windowEndISO = windowDates[windowDates.length - 1] ?? todayISO;

      const weekStartsToLoad = new Set<string>();
      weekStartsToLoad.add(getWeekStartISO(todayISO, resolvedWeekStart));
      await teamDataStore.actions.loadMileageWeek(getWeekStartISO(todayISO, resolvedWeekStart));

      const todayOnlyRows = await listAthleteWorkoutsInRange(resolvedAthleteId, todayISO, todayISO);
      if (activeLoadKeyRef.current !== loadKey) return;
      setTodayRows(todayOnlyRows);
      setWindowRows(todayOnlyRows);
      setLoading(false);

      // Hydrate heavier feedback-window data in background.
      void (async () => {
        windowDates.forEach((dateISO) => weekStartsToLoad.add(getWeekStartISO(dateISO, resolvedWeekStart)));
        const [allMileageFeedback, rows] = await Promise.all([
          loadMileageFeedback(),
          listAthleteWorkoutsInRange(resolvedAthleteId, windowStartISO, windowEndISO),
          Promise.all(Array.from(weekStartsToLoad).map((weekStartISO) => teamDataStore.actions.loadMileageWeek(weekStartISO))),
        ]);
        if (activeLoadKeyRef.current !== loadKey) return;
        setWindowRows(rows);
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
        setPendingLoading(false);
        lastLoadRef.current = { key: loadKey, ts: Date.now() };
      })();
      return;
    } finally {
      setLoading(false);
      inFlightRef.current = false;
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

  const todaySummary = useMemo(() => {
    if (!todayAssignment?.hasPlan) {
      return {
        am: "",
        pm: "",
        goal: "",
      };
    }

    const am = String(todayAssignment.amLabel ?? "").trim();
    const pm = String(todayAssignment.pmLabel ?? "").trim();
    const segments = [am, pm].filter(Boolean);
    const goal = segments.length > 0 ? segments.join(" • ") : todayAssignment.ncaaOff ? "Off day" : "";
    return { am, pm, goal };
  }, [todayAssignment]);

  const todaySessionPreviews = useMemo<SessionPreview[]>(() => {
    const bySession = new Map<"AM" | "PM", TeamWorkoutRow[]>();
    for (const row of todayRows) {
      const session = normalizeSession(row.session);
      const list = bySession.get(session) ?? [];
      list.push(row);
      bySession.set(session, list);
    }

    return (["AM", "PM"] as const)
      .map((session) => {
        const rows = (bySession.get(session) ?? []).sort((a, b) =>
          String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))
        );
        if (rows.length === 0) return null;
        const top = rows[0];
        const time = String(top.time_text ?? "").trim();
        const location = String((top as any).location ?? "").trim();
        const timeLocation = time || location ? `${time || "—"} @ ${location || "—"}` : "";
        return {
          session,
          workoutId: String(top.id),
          title: String(top.title ?? "").trim() || "Workout",
          details: String(top.details ?? "").trim(),
          timeLocation,
          categories: workoutCategoryNames(top),
          moreCount: Math.max(0, rows.length - 1),
        };
      })
      .filter((item): item is SessionPreview => Boolean(item));
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
      contentContainerStyle={{ padding: 16, paddingBottom: 28, gap: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={{
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#dbeafe",
          backgroundColor: "#ffffff",
          padding: 12,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>HOME</Text>
        <Text style={{ marginTop: 4, fontSize: 24, fontWeight: "900", color: "#0f172a" }}>Dashboard</Text>
        <Text style={{ marginTop: 3, color: "#475569", fontWeight: "700" }}>
          {selectedAthleteName ? `${selectedAthleteName} • ` : ""}
          {formatDisplayDate(todayISO)}
        </Text>
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
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#dbeafe",
          backgroundColor: "#ffffff",
          padding: 12,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>TODAY</Text>
        {loading ? (
          <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "700" }}>Loading today...</Text>
        ) : !todayAssignment?.hasPlan ? (
          <Text style={{ marginTop: 8, color: "#475569", fontWeight: "700" }}>No assignment set for today.</Text>
        ) : (
          <>
            <View style={{ marginTop: 8, flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1, borderRadius: 9, borderWidth: 1, borderColor: "#e2e8f0", backgroundColor: "#f8fafc", paddingVertical: 7, paddingHorizontal: 9 }}>
                <Text style={{ fontSize: 11, fontWeight: "900", color: "#475569" }}>AM</Text>
                <Text style={{ marginTop: 2, color: "#0f172a", fontWeight: "900" }}>{todaySummary.am || "—"}</Text>
              </View>
              <View style={{ flex: 1, borderRadius: 9, borderWidth: 1, borderColor: "#e2e8f0", backgroundColor: "#f8fafc", paddingVertical: 7, paddingHorizontal: 9 }}>
                <Text style={{ fontSize: 11, fontWeight: "900", color: "#475569" }}>PM</Text>
                <Text style={{ marginTop: 2, color: "#0f172a", fontWeight: "900" }}>{todaySummary.pm || "—"}</Text>
              </View>
            </View>
          </>
        )}
        {!loading && todaySessionPreviews.length > 0 ? (
          <View style={{ marginTop: 9, gap: 8 }}>
            {todaySessionPreviews.map((preview) => (
              <Pressable
                key={preview.workoutId}
                onPress={() =>
                  router.push({
                    pathname: "/(athlete)/workout/[id]",
                    params: { id: preview.workoutId, name: String(selectedAthleteName ?? "Athlete") },
                  })
                }
                style={{
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: "#dbe7f3",
                  backgroundColor: "#f8fafc",
                  paddingVertical: 8,
                  paddingHorizontal: 9,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ fontSize: 12, fontWeight: "900", color: "#334155" }}>{preview.session}</Text>
                  {preview.timeLocation ? (
                    <Text style={{ fontSize: 12, color: "#64748b", fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                      {preview.timeLocation}
                    </Text>
                  ) : null}
                </View>

                {preview.categories.length > 0 ? (
                  <View style={{ marginTop: 6, flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
                    {preview.categories.slice(0, 3).map((name) => {
                      const color = categoryColorByName(categories, name);
                      return (
                        <View
                          key={`${preview.workoutId}-${name}`}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 4,
                            paddingHorizontal: 7,
                            paddingVertical: 2,
                            borderRadius: 999,
                            borderWidth: 1,
                            borderColor: color,
                            backgroundColor: "white",
                          }}
                        >
                          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                          <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>{name}</Text>
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                <Text style={{ marginTop: 6, fontSize: 15, fontWeight: "900", color: "#0f172a" }} numberOfLines={2}>
                  {preview.title}
                </Text>
                {preview.details ? (
                  <Text style={{ marginTop: 3, color: "#475569" }} numberOfLines={2}>
                    {preview.details}
                  </Text>
                ) : null}
                {preview.moreCount > 0 ? (
                  <Text style={{ marginTop: 4, color: "#1d4ed8", fontWeight: "800", fontSize: 12 }}>
                    +{preview.moreCount} more {preview.session} workout{preview.moreCount === 1 ? "" : "s"}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : !loading && todayRows.length === 0 ? (
          <Text style={{ marginTop: 8, color: "#64748b" }}>No programmed workouts today.</Text>
        ) : null}
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
            paddingVertical: 10,
            alignItems: "center",
          }}
        >
          <Text style={{ fontWeight: "800", color: "#1e40af" }}>Open Today</Text>
        </Pressable>
      </View>

      <View
        style={{
          borderRadius: 14,
          borderWidth: 1,
          borderColor: pendingTarget ? "#fecaca" : "#bbf7d0",
          backgroundColor: "#ffffff",
          padding: 12,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>FEEDBACK</Text>
        <View style={{ marginTop: 3, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Next feedback task</Text>
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
              {pendingLoading ? "Loading" : pendingTarget ? "Pending" : "Clear"}
            </Text>
          </View>
        </View>
        {pendingLoading ? (
          <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "700" }}>Checking feedback...</Text>
        ) : !pendingTarget ? (
          <View
            style={{
              marginTop: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#bbf7d0",
              backgroundColor: "#f0fdf4",
              paddingVertical: 8,
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
                paddingVertical: 10,
                alignItems: "center",
              }}
            >
              <Text style={{ fontWeight: "800", color: "#991b1b" }}>Open feedback</Text>
            </Pressable>
          </>
        )}
      </View>

      <View
        style={{
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#e2e8f0",
          backgroundColor: "#ffffff",
          padding: 12,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>CALENDAR</Text>
        <Text style={{ marginTop: 3, fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Browse schedule</Text>
        <Text style={{ marginTop: 6, color: "#475569" }}>Open Month or Week view to navigate your training plan.</Text>
        <View style={{ marginTop: 10, flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => router.push("/(athlete)/month")}
            style={{
              flex: 1,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#cbd5e1",
              backgroundColor: "#f8fafc",
              paddingVertical: 10,
              alignItems: "center",
            }}
          >
            <Text style={{ fontWeight: "800", color: "#0f172a" }}>Open Month</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push({ pathname: "/(athlete)/week", params: { date: todayISO } })}
            style={{
              flex: 1,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#cbd5e1",
              backgroundColor: "#f8fafc",
              paddingVertical: 10,
              alignItems: "center",
            }}
          >
            <Text style={{ fontWeight: "800", color: "#0f172a" }}>Open Week</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
