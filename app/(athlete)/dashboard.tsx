import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  buildAthleteDailyLogEntryId,
  listAthleteDailyLogEntriesForWeek,
  type AthleteDailyLogActivityKind,
  type AthleteDailyLogEntry,
  type AthleteDailyLogEntryType,
  upsertAthleteDailyLogEntry,
} from "../../lib/athleteDailyLogEntries";
import {
  hasMileageFeedback as hasMileageFeedbackEntry,
  hasWorkoutFeedback as hasWorkoutFeedbackRow,
  parseNumericLike,
} from "../../lib/feedbackParsing";
import {
  buildMileageFeedbackId,
  loadMileageFeedback,
  migrateLocalMileageFeedbackToTeamForAthlete,
  type MileageSessionFeedback,
  upsertMileageFeedback,
} from "../../lib/mileageFeedback";
import { loadWeekStartSetting } from "../../lib/settings";
import { loadJSON } from "../../lib/storage";
import { resolveAthleteSessionContext } from "../../lib/athleteSession";
import {
  listTeamWorkoutsByBatch,
  listVisibleAthleteWorkoutsInRange,
  type TeamWorkoutRow,
  updateTeamWorkoutById,
} from "../../lib/teamWorkoutsCloud";
import { listTeamWorkoutBatchHeadersForDate } from "../../lib/teamWorkoutBatchHeadersCloud";
import { teamDataStore, visibleMileageAthleteWeekKey } from "../../lib/teamDataStore";
import { formatMileage, getWeekIndex, getWeekStartISO, parseISODate, parseMileageInput, toISODate } from "../../lib/mileagePlan";
import { CATEGORIES_KEY, normalizeCategories } from "../../lib/categories";
import { AthleteQuickFeedbackSheet } from "../../components/athlete/AthleteQuickFeedbackSheet";
import { AthleteSessionCard } from "../../components/athlete/AthleteSessionCard";
import { loadAuxiliaryRoutineDefinitions, type AuxiliaryRoutine } from "../../lib/auxiliaryRoutines";
import {
  buildBatchNotesByWorkoutId,
  cleanDisplayText,
  formatPlannedDistanceLabel,
  formatPrescribedLabel,
  getRoutineTitles,
} from "../../lib/athleteWorkoutDisplay";
import type { MileageValue, WeekStartDay, WorkoutCategory } from "../../lib/types";

type TodaySessionCard = {
  key: string;
  session: "AM" | "PM";
  prescribed: string;
  workouts: TeamWorkoutRow[];
  mileageFeedback?: MileageSessionFeedback;
  status: "submitted" | "missing" | "none" | "multiple";
  title: string;
  summary: string;
  planSummary: string;
};

type FeedbackEditorState = {
  card: TodaySessionCard;
  completedMilesText: string;
  completedTimeText: string;
  splitsText: string;
  additionalFeedbackText: string;
};

type DailyLogEditorState = {
  entryType: AthleteDailyLogEntryType;
  activityKind: AthleteDailyLogActivityKind;
  titleText: string;
  completedMilesText: string;
  completedTimeText: string;
  notesText: string;
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

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function formatCompactDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function workoutCategoryNames(row: TeamWorkoutRow): string[] {
  const arr = Array.isArray((row as any)?.categories)
    ? (row as any).categories
    : [String((row as any)?.primary_category ?? "Other")];
  const cleaned = arr.map((x: any) => String(x ?? "").trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["Other"];
}

function feedbackSummaryFromWorkout(row: TeamWorkoutRow): string {
  const parts = [
    row.completed_miles != null ? `${row.completed_miles} mi` : "",
    String(row.completed_time_text ?? "").trim(),
    String(row.splits_or_pace ?? "").trim(),
    String(row.additional_feedback ?? "").trim(),
  ].filter(Boolean);
  return parts.join(" • ");
}

function feedbackSummaryFromMileage(entry?: MileageSessionFeedback): string {
  if (!entry) return "";
  const parts = [
    entry.completedMiles != null ? `${entry.completedMiles} mi` : "",
    String(entry.completedTime ?? "").trim(),
    String(entry.splitsOrPace ?? "").trim(),
    String(entry.additionalFeedback ?? "").trim(),
  ].filter(Boolean);
  return parts.join(" • ");
}

function formatDailyLogActivityKind(kind?: AthleteDailyLogActivityKind) {
  if (kind === "cross_training") return "Cross training";
  if (kind === "run") return "Run";
  if (kind === "strength") return "Strength";
  if (kind === "mobility") return "Mobility";
  if (kind === "other") return "Other";
  return "";
}

function formatDailyLogEntrySummary(entry: AthleteDailyLogEntry) {
  const title = String(entry.title ?? "").trim();
  const notes = String(entry.notes ?? "").trim();
  const parts = [
    entry.entryType === "extra_activity" ? formatDailyLogActivityKind(entry.activityKind) : "Daily note",
    entry.completedMiles != null && String(entry.completedMiles).trim() ? `${entry.completedMiles} mi` : "",
    String(entry.completedTime ?? "").trim(),
  ].filter(Boolean);
  const detail = title || notes;
  return [parts.join(" · "), detail].filter(Boolean).join(": ");
}

export default function AthleteDashboardScreen() {
  const router = useRouter();
  const store = teamDataStore.use();

  const [loading, setLoading] = useState(true);
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [selectedAthleteName, setSelectedAthleteName] = useState<string | null>(null);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [todayRows, setTodayRows] = useState<TeamWorkoutRow[]>([]);
  const [todayMileageFeedbackEntries, setTodayMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [todayDailyLogEntries, setTodayDailyLogEntries] = useState<AthleteDailyLogEntry[]>([]);
  const [categories, setCategories] = useState<WorkoutCategory[]>([]);
  const [batchNotesByWorkoutId, setBatchNotesByWorkoutId] = useState<Map<string, string>>(new Map());
  const [routineById, setRoutineById] = useState<Map<string, AuxiliaryRoutine>>(new Map());
  const [editor, setEditor] = useState<FeedbackEditorState | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [dailyLogEditor, setDailyLogEditor] = useState<DailyLogEditorState | null>(null);
  const [dailyLogSaving, setDailyLogSaving] = useState(false);
  const [dailyLogError, setDailyLogError] = useState<string | null>(null);
  const lastLoadRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });
  const inFlightRef = useRef(false);
  const activeLoadKeyRef = useRef("");

  const todayISO = useMemo(() => toISODate(new Date()), []);

  const loadData = useCallback(async (force = false) => {
    if (inFlightRef.current) return;
    const loadKey = todayISO;
    const now = Date.now();
    if (!force && lastLoadRef.current.key === loadKey && now - lastLoadRef.current.ts < 12000) {
      return;
    }

    inFlightRef.current = true;
    activeLoadKeyRef.current = loadKey;
    setLoading(true);
    try {
      const [weekStartResult, athleteSession, storedCategories, routines] = await Promise.all([
        loadWeekStartSetting(),
        resolveAthleteSessionContext(),
        loadJSON<WorkoutCategory[]>(CATEGORIES_KEY, []),
        loadAuxiliaryRoutineDefinitions(),
      ]);

      const resolvedWeekStart: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      setWeekStartsOn(resolvedWeekStart);
      setCategories(normalizeCategories(storedCategories));
      setRoutineById(new Map(routines.map((routine) => [routine.id, routine] as const)));

      const resolvedAthleteId = String(athleteSession.athleteId ?? "").trim();
      const athleteName = String(athleteSession.athleteName ?? "").trim() || null;
      setSelectedAthleteId(resolvedAthleteId || null);
      setSelectedAthleteName(athleteName);

      if (!resolvedAthleteId) {
        setTodayRows([]);
        setBatchNotesByWorkoutId(new Map());
        setTodayMileageFeedbackEntries([]);
        setTodayDailyLogEntries([]);
        lastLoadRef.current = { key: loadKey, ts: Date.now() };
        return;
      }

      await migrateLocalMileageFeedbackToTeamForAthlete({
        athleteId: resolvedAthleteId,
        athleteName,
      });

      const weekStartISO = getWeekStartISO(todayISO, resolvedWeekStart);
      const [todayOnlyRows, allMileageFeedback, todayDailyLogs, batchHeaders] = await Promise.all([
        listVisibleAthleteWorkoutsInRange(resolvedAthleteId, todayISO, todayISO),
        loadMileageFeedback(),
        listAthleteDailyLogEntriesForWeek(resolvedAthleteId, todayISO, todayISO),
        listTeamWorkoutBatchHeadersForDate(todayISO),
        teamDataStore.actions.loadVisibleMileageWeekForAthlete(resolvedAthleteId, weekStartISO),
      ]);

      if (activeLoadKeyRef.current !== loadKey) return;
      const batchIds = Array.from(
        new Set(todayOnlyRows.map((row) => cleanDisplayText(row.batch_id)).filter(Boolean))
      );
      const batchContextRows =
        batchIds.length > 0
          ? (await Promise.all(batchIds.map((batchId) => listTeamWorkoutsByBatch(batchId).catch(() => [])))).flat()
          : [];
      if (activeLoadKeyRef.current !== loadKey) return;
      setTodayRows(todayOnlyRows);
      setBatchNotesByWorkoutId(buildBatchNotesByWorkoutId([...todayOnlyRows, ...batchContextRows], batchHeaders));
      setTodayMileageFeedbackEntries(
        allMileageFeedback.filter((entry) => {
          const entryAthleteId = String((entry as any)?.athleteId ?? "").trim();
          const byId = entryAthleteId === resolvedAthleteId;
          const byName =
            !entryAthleteId &&
            athleteName &&
            String(entry.athleteName ?? "").trim().toLowerCase() === athleteName.toLowerCase();
          return (byId || byName) && String(entry.dateISO ?? "") === todayISO;
        })
      );
      setTodayDailyLogEntries(todayDailyLogs);
      lastLoadRef.current = { key: loadKey, ts: Date.now() };
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [todayISO]);

  useFocusEffect(
    useCallback(() => {
      void loadData(true);
    }, [loadData])
  );

  const todayAssignment = useMemo(() => {
    if (!selectedAthleteId) return null;
    const weekStartISO = getWeekStartISO(todayISO, weekStartsOn);
    const visibleMileageKey = visibleMileageAthleteWeekKey(selectedAthleteId, weekStartISO);
    const idx = getWeekIndex(todayISO, weekStartISO);
    if (idx < 0 || idx > 6) return null;

    const cells = store.visibleMileageCellsByAthleteWeek[visibleMileageKey] ?? [];
    const flags = store.visibleMileageFlagsByAthleteWeek[visibleMileageKey] ?? [];

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
  }, [selectedAthleteId, store.visibleMileageCellsByAthleteWeek, store.visibleMileageFlagsByAthleteWeek, todayISO, weekStartsOn]);

  const todaySessionCards = useMemo<TodaySessionCard[]>(() => {
    const workoutBySession = new Map<"AM" | "PM", TeamWorkoutRow[]>();
    for (const row of todayRows) {
      const session = normalizeSession(row.session);
      const list = workoutBySession.get(session) ?? [];
      list.push(row);
      workoutBySession.set(session, list);
    }

    const mileageFeedbackBySession = new Map<"AM" | "PM", MileageSessionFeedback>();
    for (const entry of todayMileageFeedbackEntries) {
      if (String(entry.dateISO ?? "") !== todayISO) continue;
      mileageFeedbackBySession.set(normalizeSession(entry.session), entry);
    }

    return (["AM", "PM"] as const).map((session) => {
      const workouts = (workoutBySession.get(session) ?? []).sort((a, b) =>
        String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))
      );
      const topWorkout = workouts[0];
      const mileageFeedback = mileageFeedbackBySession.get(session);
      const prescribed = session === "AM" ? todayAssignment?.amLabel ?? "" : todayAssignment?.pmLabel ?? "";
      const submitted = workouts.some((row) => hasWorkoutFeedbackRow(row)) || Boolean(mileageFeedback && hasMileageFeedbackEntry(mileageFeedback));
      const hasPlannedSession = workouts.length > 0 || prescribed.length > 0;
      const status: TodaySessionCard["status"] =
        workouts.length > 1 ? "multiple" : submitted ? "submitted" : hasPlannedSession ? "missing" : "none";
      const title =
        workouts.length > 1
          ? `${workouts.length} workouts scheduled`
          : topWorkout
            ? String(topWorkout.title ?? "Workout").trim() || "Workout"
            : prescribed
              ? `${session} Planned Session`
              : "No planned session";
      const planSummary = prescribed ? `Mileage: ${formatPrescribedLabel(prescribed)}` : "";
      const submittedSummary = topWorkout ? feedbackSummaryFromWorkout(topWorkout) : feedbackSummaryFromMileage(mileageFeedback);
      const summary =
        status === "submitted"
          ? submittedSummary || "Log submitted."
          : workouts.length > 1
            ? "Open the day view to complete logs for multiple workouts in this session."
            : topWorkout
              ? "Workout log needed."
              : prescribed
                ? `Prescribed mileage: ${formatPrescribedLabel(prescribed)}`
                : "Nothing planned for this session.";

      return {
        key: `${todayISO}|${session}`,
        session,
        prescribed,
        workouts,
        mileageFeedback,
        status,
        title,
        summary,
        planSummary,
      };
    }).filter((card) => card.workouts.length > 0 || Boolean(card.prescribed));
  }, [todayAssignment, todayISO, todayMileageFeedbackEntries, todayRows]);

  const openDetailForCard = useCallback((card: TodaySessionCard) => {
    if (card.status === "none") return;
    if (card.workouts.length > 1) {
      router.push({ pathname: "/(athlete)/day", params: { date: todayISO } });
      return;
    }

    const workout = card.workouts[0];
    if (workout) {
      router.push({
        pathname: "/(athlete)/workout/[id]",
        params: {
          id: workout.id,
          name: selectedAthleteName ?? "",
          returnTo: "/(athlete)/dashboard",
        },
      });
      return;
    }

    if (card.prescribed) {
      router.push({
        pathname: "/(athlete)/workout/[id]",
        params: {
          id: `planned-${todayISO}-${card.session}`,
          synthetic: "1",
          date: todayISO,
          session: card.session,
          prescribed: card.prescribed,
          athleteId: selectedAthleteId ?? "",
          name: selectedAthleteName ?? "",
          returnTo: "/(athlete)/dashboard",
        },
      });
    }
  }, [router, selectedAthleteId, selectedAthleteName, todayISO]);

  const openEditorForCard = useCallback((card: TodaySessionCard) => {
    if (card.status === "none") return;
    if (card.status === "multiple") {
      Alert.alert("Multiple workouts", "Open the day view to complete logs for multiple workouts in this session.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open day",
          onPress: () => router.push({ pathname: "/(athlete)/day", params: { date: todayISO } }),
        },
      ]);
      return;
    }

    const workout = card.workouts[0];
    const mileage = card.mileageFeedback;
    setEditorError(null);
    setEditor({
      card,
      completedMilesText:
        workout?.completed_miles != null
          ? String(workout.completed_miles)
          : mileage?.completedMiles != null
            ? String(mileage.completedMiles)
            : "",
      completedTimeText: String(workout?.completed_time_text ?? mileage?.completedTime ?? ""),
      splitsText: String(workout?.splits_or_pace ?? mileage?.splitsOrPace ?? ""),
      additionalFeedbackText: String(workout?.additional_feedback ?? mileage?.additionalFeedback ?? ""),
    });
  }, [router, todayISO]);

  const saveEditor = useCallback(async () => {
    if (!editor) return;
    const completedMilesRaw = editor.completedMilesText.trim();
    const completedTimeText = editor.completedTimeText.trim();
    const splitsText = editor.splitsText.trim();
    const additionalFeedbackText = editor.additionalFeedbackText.trim();
    const parsedCompletedMiles = completedMilesRaw ? parseNumericLike(completedMilesRaw) : undefined;

    if (completedMilesRaw && parsedCompletedMiles == null) {
      setEditorError("Distance must be a number, like 5 or 5.25.");
      return;
    }
    if (parsedCompletedMiles != null && !/^\d+(\.\d{1,2})?$/.test(completedMilesRaw)) {
      setEditorError("Distance can use up to two decimals.");
      return;
    }
    if (parsedCompletedMiles == null && !completedTimeText) {
      setEditorError("Enter either distance completed or time completed before saving.");
      return;
    }

    setEditorSaving(true);
    setEditorError(null);
    try {
      const card = editor.card;
      const workout = card.workouts[0];

      if (workout) {
        await updateTeamWorkoutById(workout.id, {
          completed_miles: parsedCompletedMiles ?? null,
          completed_time_text: completedTimeText || null,
          splits_or_pace: splitsText || null,
          additional_feedback: additionalFeedbackText || null,
        });
        setTodayRows((prev) =>
          prev.map((row) =>
            row.id === workout.id
              ? {
                  ...row,
                  completed_miles: parsedCompletedMiles ?? null,
                  completed_time_text: completedTimeText || null,
                  splits_or_pace: splitsText || null,
                  additional_feedback: additionalFeedbackText || null,
                  updated_at: new Date().toISOString(),
                }
              : row
          )
        );
      } else {
        const entry: MileageSessionFeedback = {
          id: buildMileageFeedbackId({
            athleteId: String(selectedAthleteId ?? "") || undefined,
            athleteName: String(selectedAthleteName ?? "") || undefined,
            dateISO: todayISO,
            session: card.session,
          }),
          athleteId: String(selectedAthleteId ?? "") || undefined,
          athleteName: String(selectedAthleteName ?? "") || undefined,
          dateISO: todayISO,
          session: card.session,
          prescribed: card.prescribed || undefined,
          completedMiles: parsedCompletedMiles,
          completedTime: completedTimeText || undefined,
          splitsOrPace: splitsText || undefined,
          additionalFeedback: additionalFeedbackText || undefined,
          updatedAt: Date.now(),
        };
        await upsertMileageFeedback(entry);
        setTodayMileageFeedbackEntries((prev) => [...prev.filter((item) => item.id !== entry.id), entry]);
      }

      setEditor(null);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not save log.");
      setEditorError(message);
      Alert.alert("Save failed", message);
    } finally {
      setEditorSaving(false);
    }
  }, [editor, selectedAthleteId, selectedAthleteName, todayISO]);

  const openDailyLogEditor = useCallback((entryType: AthleteDailyLogEntryType) => {
    setDailyLogError(null);
    setDailyLogEditor({
      entryType,
      activityKind: entryType === "extra_activity" ? "run" : null,
      titleText: "",
      completedMilesText: "",
      completedTimeText: "",
      notesText: "",
    });
  }, []);

  const saveDailyLogEntry = useCallback(async () => {
    if (!dailyLogEditor) return;
    const athleteId = String(selectedAthleteId ?? "").trim();
    if (!athleteId) {
      setDailyLogError("No athlete profile is selected.");
      return;
    }

    const title = dailyLogEditor.titleText.trim();
    const notes = dailyLogEditor.notesText.trim();
    const isExtraActivity = dailyLogEditor.entryType === "extra_activity";
    const completedMilesRaw = isExtraActivity ? dailyLogEditor.completedMilesText.trim() : "";
    const completedTime = isExtraActivity ? dailyLogEditor.completedTimeText.trim() : "";
    const parsedCompletedMiles = completedMilesRaw ? parseNumericLike(completedMilesRaw) : undefined;

    if (completedMilesRaw && parsedCompletedMiles == null) {
      setDailyLogError("Distance must be a number, like 3 or 3.5.");
      return;
    }

    if (!title && !notes && !completedMilesRaw && !completedTime) {
      setDailyLogError("Add a title, notes, distance, or time before saving.");
      return;
    }

    const now = Date.now();
    const entry: AthleteDailyLogEntry = {
      id: buildAthleteDailyLogEntryId({
        athleteId,
        dateISO: todayISO,
        createdAt: now,
      }),
      athleteId,
      athleteName: String(selectedAthleteName ?? "").trim() || null,
      dateISO: todayISO,
      session: null,
      entryType: dailyLogEditor.entryType,
      activityKind: isExtraActivity ? dailyLogEditor.activityKind ?? "other" : null,
      title: title || null,
      completedMiles: completedMilesRaw || null,
      completedTime: completedTime || null,
      notes: notes || null,
      createdAt: now,
      updatedAt: now,
    };

    setDailyLogSaving(true);
    setDailyLogError(null);
    try {
      const saved = await upsertAthleteDailyLogEntry(entry);
      setTodayDailyLogEntries((prev) => [...prev.filter((item) => item.id !== saved.id), saved]);
      setDailyLogEditor(null);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not save daily log entry.");
      setDailyLogError(message);
      Alert.alert("Save failed", message);
    } finally {
      setDailyLogSaving(false);
    }
  }, [dailyLogEditor, selectedAthleteId, selectedAthleteName, todayISO]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "#f6f8fb" }}
      contentContainerStyle={{ padding: 16, paddingBottom: 28, gap: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={{
          borderRadius: 18,
          borderWidth: 1,
          borderColor: "#dbeafe",
          backgroundColor: "#ffffff",
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>DASHBOARD</Text>
        <Text style={{ marginTop: 4, fontSize: 26, fontWeight: "900", color: "#0f172a" }}>Today</Text>
        <Text style={{ marginTop: 3, color: "#475569", fontWeight: "700" }}>
          {selectedAthleteName ? `${selectedAthleteName} • ` : ""}
          {formatDisplayDate(todayISO)}
        </Text>
      </View>

      {loading ? (
        <View style={{ marginTop: 10, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 2 }}>
          <ActivityIndicator />
          <Text style={{ color: "#64748b", fontWeight: "600" }}>Loading today...</Text>
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
          <Text style={{ marginTop: 6, color: "#92400e" }}>Join or select an athlete profile first.</Text>
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
          borderRadius: 18,
          borderWidth: 1,
          borderColor: "#dbeafe",
          backgroundColor: "#ffffff",
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>TODAY SUMMARY</Text>
        {loading ? (
          <Text style={{ marginTop: 8, color: "#64748b", fontWeight: "700" }}>Loading mileage and workouts...</Text>
        ) : !todayAssignment?.hasPlan && todayRows.length === 0 ? (
          <Text style={{ marginTop: 8, color: "#475569", fontWeight: "700" }}>No planned training set for today.</Text>
        ) : (
          <>
            <View style={{ marginTop: 10, flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1, borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0", backgroundColor: "#f8fafc", paddingVertical: 10, paddingHorizontal: 10 }}>
                <Text style={{ fontSize: 11, fontWeight: "900", color: "#475569" }}>AM Mileage</Text>
                <Text style={{ marginTop: 3, color: "#0f172a", fontWeight: "900", fontSize: 16 }}>{todayAssignment?.amLabel || "—"}</Text>
              </View>
              <View style={{ flex: 1, borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0", backgroundColor: "#f8fafc", paddingVertical: 10, paddingHorizontal: 10 }}>
                <Text style={{ fontSize: 11, fontWeight: "900", color: "#475569" }}>PM Mileage</Text>
                <Text style={{ marginTop: 3, color: "#0f172a", fontWeight: "900", fontSize: 16 }}>{todayAssignment?.pmLabel || "—"}</Text>
              </View>
            </View>
            {todayAssignment?.ncaaOff ? (
              <Text style={{ marginTop: 9, color: "#166534", fontWeight: "800" }}>NCAA off day is marked for today.</Text>
            ) : null}
          </>
        )}
      </View>

      <View
        style={{
          borderRadius: 18,
          borderWidth: 1,
          borderColor: "#dbeafe",
          backgroundColor: "#ffffff",
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.7, color: "#64748b" }}>TODAY WORKOUTS & LOG</Text>
        <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>
          Enter logs directly for today’s AM and PM sessions.
        </Text>
        <View style={{ marginTop: 12, gap: 10 }}>
          {todaySessionCards.map((card) => {
            const workout = card.workouts[0];
            const categoriesForCard = workout ? workoutCategoryNames(workout) : [];
            const actionLabel = card.status === "submitted" ? "Edit log" : card.status === "none" ? "No log needed" : "Enter log";
            const prescribedLabel =
              (workout ? formatPlannedDistanceLabel(workout.planned_distance, workout.planned_distance_unit) : "") ||
              formatPrescribedLabel(card.prescribed);
            return (
              <AthleteSessionCard
                key={card.key}
                session={card.session}
                title={card.title}
                summary={card.summary}
                prescribed={prescribedLabel}
                time={workout?.time_text ?? null}
                location={String((workout as any)?.location ?? "").trim() || null}
                categories={categoriesForCard}
                categoriesSource={categories}
                batchDetails={workout ? batchNotesByWorkoutId.get(String(workout.id)) ?? "" : ""}
                individualDetails={
                  workout && cleanDisplayText(workout.details) !== cleanDisplayText(batchNotesByWorkoutId.get(String(workout.id)))
                    ? cleanDisplayText(workout.details)
                    : ""
                }
                preRoutineTitles={workout ? getRoutineTitles(workout.pre_routine_ids, routineById) : []}
                postRoutineTitles={workout ? getRoutineTitles(workout.post_routine_ids, routineById) : []}
                status={card.status}
                actionLabel={actionLabel}
                onOpen={() => openDetailForCard(card)}
                onLog={() => openEditorForCard(card)}
              />
            );
          })}
        </View>

        <View style={{ marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Pressable
            disabled={!selectedAthleteId}
            onPress={() => openDailyLogEditor("daily_note")}
            style={{
              flexGrow: 1,
              minWidth: 140,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: "#ddd6fe",
              backgroundColor: "#faf5ff",
              paddingVertical: 11,
              paddingHorizontal: 12,
              alignItems: "center",
              opacity: selectedAthleteId ? 1 : 0.55,
            }}
          >
            <Text style={{ fontWeight: "900", color: "#7e22ce" }}>Add daily note</Text>
          </Pressable>
          <Pressable
            disabled={!selectedAthleteId}
            onPress={() => openDailyLogEditor("extra_activity")}
            style={{
              flexGrow: 1,
              minWidth: 140,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: "#bae6fd",
              backgroundColor: "#f0f9ff",
              paddingVertical: 11,
              paddingHorizontal: 12,
              alignItems: "center",
              opacity: selectedAthleteId ? 1 : 0.55,
            }}
          >
            <Text style={{ fontWeight: "900", color: "#0369a1" }}>Add extra activity</Text>
          </Pressable>
        </View>

        {todayDailyLogEntries.length > 0 ? (
          <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: "#e2e8f0", paddingTop: 10, gap: 6 }}>
            <Text style={{ fontSize: 11, fontWeight: "900", letterSpacing: 0.5, color: "#64748b" }}>TODAY EXTRAS</Text>
            {todayDailyLogEntries
              .slice()
              .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
              .map((entry) => (
                <Text key={entry.id} style={{ color: "#334155", fontWeight: "700", lineHeight: 18 }}>
                  {formatDailyLogEntrySummary(entry)}
                </Text>
              ))}
          </View>
        ) : null}
      </View>

      <AthleteQuickFeedbackSheet
        visible={Boolean(editor)}
        title={editor ? `${editor.card.session} Log` : "Log"}
        subtitle={formatCompactDate(todayISO)}
        planSummary={editor ? editor.card.planSummary || (editor.card.prescribed ? `Mileage: ${editor.card.prescribed}` : "") : ""}
        completedMilesText={editor?.completedMilesText ?? ""}
        completedTimeText={editor?.completedTimeText ?? ""}
        splitsText={editor?.splitsText ?? ""}
        additionalFeedbackText={editor?.additionalFeedbackText ?? ""}
        saving={editorSaving}
        error={editorError}
        onChangeCompletedMiles={(text) => setEditor((prev) => (prev ? { ...prev, completedMilesText: text } : prev))}
        onChangeCompletedTime={(text) => setEditor((prev) => (prev ? { ...prev, completedTimeText: text } : prev))}
        onChangeSplits={(text) => setEditor((prev) => (prev ? { ...prev, splitsText: text } : prev))}
        onChangeAdditionalFeedback={(text) => setEditor((prev) => (prev ? { ...prev, additionalFeedbackText: text } : prev))}
        onCancel={() => {
          if (!editorSaving) setEditor(null);
        }}
        onSave={() => void saveEditor()}
      />

      <Modal
        visible={Boolean(dailyLogEditor)}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!dailyLogSaving) setDailyLogEditor(null);
        }}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(15, 23, 42, 0.35)", justifyContent: "flex-end" }}>
          <View
            style={{
              maxHeight: "90%",
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              backgroundColor: "#ffffff",
              padding: 18,
            }}
          >
            {dailyLogEditor ? (
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={{ fontSize: 22, fontWeight: "900", color: "#0f172a" }}>
                  {dailyLogEditor.entryType === "extra_activity" ? "Add extra activity" : "Add daily note"}
                </Text>
                <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>{formatCompactDate(todayISO)}</Text>

                <View style={{ marginTop: 14, gap: 12 }}>
                  {dailyLogEditor.entryType === "extra_activity" ? (
                    <View>
                      <Text style={{ fontWeight: "900", color: "#334155" }}>Activity kind</Text>
                      <View style={{ marginTop: 7, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        {(["run", "cross_training", "strength", "mobility", "other"] as const).map((kind) => {
                          const selected = dailyLogEditor.activityKind === kind;
                          return (
                            <Pressable
                              key={`dashboard-daily-log-kind-${kind}`}
                              onPress={() => setDailyLogEditor((prev) => (prev ? { ...prev, activityKind: kind } : prev))}
                              style={{
                                borderRadius: 999,
                                borderWidth: 1,
                                borderColor: selected ? "#0284c7" : "#cbd5e1",
                                backgroundColor: selected ? "#f0f9ff" : "#ffffff",
                                paddingHorizontal: 12,
                                paddingVertical: 9,
                              }}
                            >
                              <Text style={{ fontWeight: "900", color: selected ? "#0369a1" : "#334155" }}>
                                {formatDailyLogActivityKind(kind)}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  ) : null}

                  <View>
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Title</Text>
                    <TextInput
                      value={dailyLogEditor.titleText}
                      onChangeText={(text) => setDailyLogEditor((prev) => (prev ? { ...prev, titleText: text } : prev))}
                      placeholder={dailyLogEditor.entryType === "extra_activity" ? "Example: Extra bike ride" : "Example: Felt sick today"}
                      style={{
                        marginTop: 6,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: "#cbd5e1",
                        paddingHorizontal: 12,
                        paddingVertical: 11,
                        fontWeight: "800",
                        color: "#0f172a",
                      }}
                    />
                  </View>

                  {dailyLogEditor.entryType === "extra_activity" ? (
                    <View style={{ flexDirection: "row", gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontWeight: "900", color: "#334155" }}>Completed miles</Text>
                        <TextInput
                          value={dailyLogEditor.completedMilesText}
                          onChangeText={(text) => setDailyLogEditor((prev) => (prev ? { ...prev, completedMilesText: text } : prev))}
                          placeholder="Optional"
                          keyboardType="decimal-pad"
                          style={{
                            marginTop: 6,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: "#cbd5e1",
                            paddingHorizontal: 12,
                            paddingVertical: 11,
                            fontWeight: "800",
                            color: "#0f172a",
                          }}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontWeight: "900", color: "#334155" }}>Completed time</Text>
                        <TextInput
                          value={dailyLogEditor.completedTimeText}
                          onChangeText={(text) => setDailyLogEditor((prev) => (prev ? { ...prev, completedTimeText: text } : prev))}
                          placeholder="30:00"
                          style={{
                            marginTop: 6,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: "#cbd5e1",
                            paddingHorizontal: 12,
                            paddingVertical: 11,
                            fontWeight: "800",
                            color: "#0f172a",
                          }}
                        />
                      </View>
                    </View>
                  ) : null}

                  <View>
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Notes</Text>
                    <TextInput
                      value={dailyLogEditor.notesText}
                      onChangeText={(text) => setDailyLogEditor((prev) => (prev ? { ...prev, notesText: text } : prev))}
                      placeholder="Add anything your coach should know."
                      multiline
                      style={{
                        marginTop: 6,
                        minHeight: 104,
                        textAlignVertical: "top",
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: "#cbd5e1",
                        paddingHorizontal: 12,
                        paddingVertical: 11,
                        fontWeight: "700",
                        color: "#0f172a",
                      }}
                    />
                  </View>
                </View>

                {dailyLogError ? <Text style={{ marginTop: 12, color: "#be123c", fontWeight: "800" }}>{dailyLogError}</Text> : null}

                <View style={{ marginTop: 18, flexDirection: "row", gap: 10 }}>
                  <Pressable
                    disabled={dailyLogSaving}
                    onPress={() => setDailyLogEditor(null)}
                    style={{
                      flex: 1,
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: "#cbd5e1",
                      backgroundColor: "#ffffff",
                      paddingVertical: 13,
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    disabled={dailyLogSaving}
                    onPress={() => void saveDailyLogEntry()}
                    style={{
                      flex: 1,
                      borderRadius: 14,
                      backgroundColor: dailyLogSaving ? "#93c5fd" : "#2563eb",
                      paddingVertical: 13,
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ fontWeight: "900", color: "white" }}>
                      {dailyLogSaving ? "Saving..." : dailyLogEditor.entryType === "extra_activity" ? "Save activity" : "Save note"}
                    </Text>
                  </Pressable>
                </View>
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
