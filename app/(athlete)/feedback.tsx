import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { loadFeedbackFlagSettings, type FeedbackWarningMode } from "../../lib/feedbackFlags";
import {
  hasMileageFeedback as hasMileageFeedbackEntry,
  hasWorkoutFeedback as hasWorkoutFeedbackRow,
  parseNumericLike,
} from "../../lib/feedbackParsing";
import {
  buildAthleteDailyLogEntryId,
  deleteAthleteDailyLogEntry,
  listAthleteDailyLogEntriesForWeek,
  type AthleteDailyLogActivityKind,
  type AthleteDailyLogEntry,
  type AthleteDailyLogEntryType,
  type AthleteDailyLogSession,
  upsertAthleteDailyLogEntry,
} from "../../lib/athleteDailyLogEntries";
import {
  buildMileageFeedbackId,
  loadMileageFeedback,
  migrateLocalMileageFeedbackToTeamForAthlete,
  type MileageSessionFeedback,
  upsertMileageFeedback,
} from "../../lib/mileageFeedback";
import { loadWeekStartSetting } from "../../lib/settings";
import { loadJSON, saveJSON } from "../../lib/storage";
import { resolveAthleteSessionContext } from "../../lib/athleteSession";
import { listVisibleAthleteWorkoutsInRange, type TeamWorkoutRow, updateOwnWorkoutFeedbackById } from "../../lib/teamWorkoutsCloud";
import { teamDataStore, visibleMileageAthleteWeekKey } from "../../lib/teamDataStore";
import {
  computeWeeklyPlannedMileageAndXtTotals,
  formatMileage,
  getWeekIndex,
  getWeekStartISO,
  parseISODate,
  parseMileageInput,
  toISODate,
} from "../../lib/mileagePlan";
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

type PendingDayGroup = {
  dateISO: string;
  label: string;
  items: PendingItem[];
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

type WeekSessionCard = {
  key: string;
  dateISO: string;
  session: "AM" | "PM";
  prescribed: string;
  workouts: TeamWorkoutRow[];
  mileageFeedback?: MileageSessionFeedback;
  status: "submitted" | "missing" | "planned" | "none" | "multiple";
  title: string;
  summary: string;
  planSummary: string;
  isFuture: boolean;
};

type WeekDayRow = {
  dateISO: string;
  label: string;
  cards: WeekSessionCard[];
  dailyLogEntries: AthleteDailyLogEntry[];
};

type FeedbackEditorState = {
  card: WeekSessionCard;
  completedMilesText: string;
  completedTimeText: string;
  splitsText: string;
  additionalFeedbackText: string;
};

type DailyLogEditorState = {
  id?: string;
  dateISO: string;
  entryType: AthleteDailyLogEntryType;
  session: AthleteDailyLogSession;
  activityKind: AthleteDailyLogActivityKind;
  titleText: string;
  completedMilesText: string;
  completedTimeText: string;
  notesText: string;
  createdAt?: number;
};

type RangeTotal = {
  min: number;
  max: number;
};

type WeeklyLogSummary = {
  goalMileage: string;
  completedMileage: string;
  goalXT: string;
  completedXT: string;
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

function daysBetween(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  let current = String(startISO);
  while (current <= endISO) {
    out.push(current);
    current = addDaysISO(current, 1);
  }
  return out;
}

function formatWeekLabel(startISO: string) {
  const endISO = addDaysISO(startISO, 6);
  return `${formatDisplayDate(startISO)} - ${formatDisplayDate(endISO)}`;
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

function formatDailyLogEntryType(entryType: AthleteDailyLogEntryType) {
  return entryType === "extra_activity" ? "Extra activity" : "Daily note";
}

function formatDailyLogActivityKind(kind?: AthleteDailyLogActivityKind) {
  if (kind === "cross_training") return "Cross training";
  if (kind === "run") return "Run";
  if (kind === "strength") return "Strength";
  if (kind === "mobility") return "Mobility";
  if (kind === "other") return "Other";
  return "";
}

function formatDailyLogSession(session?: AthleteDailyLogSession) {
  return session === "AM" || session === "PM" ? session : "All day";
}

function formatDailyLogEntrySummary(entry: AthleteDailyLogEntry) {
  const parts = [
    entry.completedMiles != null && String(entry.completedMiles).trim() ? `${entry.completedMiles} mi` : "",
    String(entry.completedTime ?? "").trim(),
    String(entry.notes ?? "").trim(),
  ].filter(Boolean);
  return parts.join(" • ");
}

function plannedTextFromWorkout(row: TeamWorkoutRow): string {
  return [
    String(row.title ?? "").trim(),
    String(row.time_text ?? "").trim(),
    String(row.primary_category ?? "").trim(),
  ].filter(Boolean).join(" • ");
}

function addRange(a: RangeTotal, b: RangeTotal): RangeTotal {
  return { min: a.min + b.min, max: a.max + b.max };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function hasRangeTotal(total: RangeTotal) {
  return Number.isFinite(total.min) && Number.isFinite(total.max) && (total.min > 0 || total.max > 0);
}

function formatMilesTotal(total: RangeTotal) {
  if (!hasRangeTotal(total)) return "—";
  const min = round1(total.min);
  const max = round1(total.max);
  if (Math.abs(min - max) < 1e-9) return `${min} mi`;
  return `${min}–${max} mi`;
}

function formatMinutesTotal(total: RangeTotal) {
  if (!hasRangeTotal(total)) return "—";
  const min = Math.round(total.min / 60);
  const max = Math.round(total.max / 60);
  if (min === max) return `${min} min`;
  return `${min}–${max} min`;
}

function parseCompletedTimeToSeconds(value: unknown): number | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const minutes = Number(raw);
    return Number.isFinite(minutes) ? Math.round(minutes * 60) : undefined;
  }

  const parts = raw.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return Math.round(minutes * 60 + seconds);
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return Math.round(hours * 3600 + minutes * 60 + seconds);
  }
  return undefined;
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
  const [selectedWeekStartISO, setSelectedWeekStartISO] = useState<string>(() => getWeekStartISO(toISODate(new Date()), 1));
  const [weekWorkoutRows, setWeekWorkoutRows] = useState<TeamWorkoutRow[]>([]);
  const [weekMileageFeedbackEntries, setWeekMileageFeedbackEntries] = useState<MileageSessionFeedback[]>([]);
  const [weekDailyLogEntries, setWeekDailyLogEntries] = useState<AthleteDailyLogEntry[]>([]);
  const [weekLoading, setWeekLoading] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);
  const [editor, setEditor] = useState<FeedbackEditorState | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [dailyLogEditor, setDailyLogEditor] = useState<DailyLogEditorState | null>(null);
  const [dailyLogSaving, setDailyLogSaving] = useState(false);
  const [dailyLogError, setDailyLogError] = useState<string | null>(null);
  const [scrollY, setScrollY] = useState(0);
  const [uiHydrated, setUiHydrated] = useState(false);
  const lastLoadRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });
  const inFlightRef = useRef(false);
  const activeLoadKeyRef = useRef("");
  const activeWeekLoadKeyRef = useRef("");

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
    try {
      const [weekStartResult, flagSettings, athleteSession] = await Promise.all([
        loadWeekStartSetting(),
        loadFeedbackFlagSettings(),
        resolveAthleteSessionContext(),
      ]);

      const resolvedWeekStart: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      setWeekStartsOn(resolvedWeekStart);
      setSelectedWeekStartISO((prev) => getWeekStartISO(prev || todayISO, resolvedWeekStart));
      setWindowMode(flagSettings.mode ?? "all");
      setWindowStartDateISO(flagSettings.startDateISO);

      const resolvedAthleteId = String(athleteSession.athleteId ?? "").trim();
      setSelectedAthleteId(resolvedAthleteId || null);

      if (!resolvedAthleteId) {
        setSelectedAthleteName(null);
        setWorkoutRows([]);
        setMileageFeedbackEntries([]);
        setLoading(false);
        return;
      }

      const athleteName = String(athleteSession.athleteName ?? "").trim() || null;
      setSelectedAthleteName(athleteName);
      await migrateLocalMileageFeedbackToTeamForAthlete({
        athleteId: resolvedAthleteId,
        athleteName,
      });

      const windowDates = daysBetween(addDaysISO(todayISO, -90), todayISO).filter((dateISO) =>
        isDateWithinWindow(dateISO, todayISO, flagSettings.mode ?? "all", flagSettings.startDateISO)
      );

      if (windowDates.length === 0) {
        setWorkoutRows([]);
        setMileageFeedbackEntries([]);
        setLoading(false);
        return;
      }

      const startISO = windowDates[0];
      const endISO = windowDates[windowDates.length - 1];

      const uniqueWeekStarts = Array.from(
        new Set(windowDates.map((dateISO) => getWeekStartISO(dateISO, resolvedWeekStart)))
      );
      await teamDataStore.actions.loadVisibleMileageWeekForAthlete(resolvedAthleteId, getWeekStartISO(todayISO, resolvedWeekStart));

      const recentRows = await listVisibleAthleteWorkoutsInRange(resolvedAthleteId, addDaysISO(todayISO, -14), todayISO);
      if (activeLoadKeyRef.current !== loadKey) return;
      setWorkoutRows(recentRows);
      setLoading(false);

      // Hydrate full feedback window in background.
      void (async () => {
        const [allMileageFeedback, rows] = await Promise.all([
          loadMileageFeedback(),
          listVisibleAthleteWorkoutsInRange(resolvedAthleteId, startISO, endISO),
          Promise.all(uniqueWeekStarts.map((weekStartISO) => teamDataStore.actions.loadVisibleMileageWeekForAthlete(resolvedAthleteId, weekStartISO))),
        ]);
        if (activeLoadKeyRef.current !== loadKey) return;
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

  const loadWeekData = useCallback(async () => {
    const athleteId = String(selectedAthleteId ?? "").trim();
    if (!athleteId || !selectedWeekStartISO) {
      setWeekWorkoutRows([]);
      setWeekMileageFeedbackEntries([]);
      setWeekDailyLogEntries([]);
      return;
    }

    const weekStartISO = String(selectedWeekStartISO);
    const weekEndISO = addDaysISO(weekStartISO, 6);
    const loadKey = `${athleteId}|${weekStartISO}`;
    activeWeekLoadKeyRef.current = loadKey;
    setWeekLoading(true);
    setWeekError(null);
    try {
      const [rows, allMileageFeedback, dailyLogEntries] = await Promise.all([
        listVisibleAthleteWorkoutsInRange(athleteId, weekStartISO, weekEndISO),
        loadMileageFeedback(),
        listAthleteDailyLogEntriesForWeek(athleteId, weekStartISO, weekEndISO),
        teamDataStore.actions.loadVisibleMileageWeekForAthlete(athleteId, weekStartISO),
      ]);
      if (activeWeekLoadKeyRef.current !== loadKey) return;

      setWeekWorkoutRows(rows);
      const athleteName = String(selectedAthleteName ?? "").trim().toLowerCase();
      setWeekMileageFeedbackEntries(
        allMileageFeedback.filter((entry) => {
          const entryAthleteId = String(entry.athleteId ?? "").trim();
          const athleteMatchById = entryAthleteId === athleteId;
          const athleteMatchByName =
            !entryAthleteId &&
            athleteName.length > 0 &&
            String(entry.athleteName ?? "").trim().toLowerCase() === athleteName;
          if (!athleteMatchById && !athleteMatchByName) return false;
          const dateISO = String(entry.dateISO ?? "");
          return dateISO >= weekStartISO && dateISO <= weekEndISO;
        })
      );
      setWeekDailyLogEntries(dailyLogEntries);

      const previousWeek = addDaysISO(weekStartISO, -7);
      const nextWeek = addDaysISO(weekStartISO, 7);
      void Promise.all([
        teamDataStore.actions.loadVisibleMileageWeekForAthlete(athleteId, previousWeek),
        teamDataStore.actions.loadVisibleMileageWeekForAthlete(athleteId, nextWeek),
      ]).catch(() => undefined);
    } catch (error: any) {
      if (activeWeekLoadKeyRef.current !== loadKey) return;
      setWeekError(String(error?.message ?? error ?? "Could not load week logs."));
    } finally {
      if (activeWeekLoadKeyRef.current === loadKey) {
        setWeekLoading(false);
      }
    }
  }, [selectedAthleteId, selectedAthleteName, selectedWeekStartISO]);

  useEffect(() => {
    void loadWeekData();
  }, [loadWeekData]);

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

      const cells = store.visibleMileageCellsByAthleteWeek[visibleMileageAthleteWeekKey(selectedAthleteId, weekStartISO)] ?? [];
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
  }, [selectedAthleteId, store.visibleMileageCellsByAthleteWeek, weekStartsOn, windowDates]);

  const weekDayRows = useMemo<WeekDayRow[]>(() => {
    const dates = daysBetween(selectedWeekStartISO, addDaysISO(selectedWeekStartISO, 6));
    const workoutBySession = new Map<string, TeamWorkoutRow[]>();
    for (const row of weekWorkoutRows) {
      const dateISO = String(row.date_iso ?? "");
      const session = normalizeSession(row.session);
      const key = `${dateISO}|${session}`;
      const list = workoutBySession.get(key) ?? [];
      list.push(row);
      workoutBySession.set(key, list);
    }

    const mileageFeedbackBySession = new Map<string, MileageSessionFeedback>();
    for (const entry of weekMileageFeedbackEntries) {
      const dateISO = String(entry.dateISO ?? "");
      const session = normalizeSession(entry.session);
      mileageFeedbackBySession.set(`${dateISO}|${session}`, entry);
    }

    const dailyLogsByDate = new Map<string, AthleteDailyLogEntry[]>();
    for (const entry of weekDailyLogEntries) {
      const dateISO = String(entry.dateISO ?? "");
      if (!dateISO) continue;
      const list = dailyLogsByDate.get(dateISO) ?? [];
      list.push(entry);
      dailyLogsByDate.set(dateISO, list);
    }

    return dates.map((dateISO) => {
      const dayIdx = getWeekIndex(dateISO, selectedWeekStartISO);
      const cells = store.visibleMileageCellsByAthleteWeek[visibleMileageAthleteWeekKey(selectedAthleteId ?? "", selectedWeekStartISO)] ?? [];

      const cards = (["AM", "PM"] as const).map<WeekSessionCard>((session) => {
        const key = `${dateISO}|${session}`;
        const workouts = (workoutBySession.get(key) ?? []).slice().sort((a, b) =>
          String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? "")) * -1
        );
        const mileageFeedback = mileageFeedbackBySession.get(key);
        const plannedValue = toMileageValue(
          cells.find(
            (row) =>
              String(row.athlete_profile_id) === String(selectedAthleteId ?? "") &&
              row.day_idx === dayIdx &&
              row.session === session
          )?.value
        );
        const prescribed = String(formatMileage(plannedValue) ?? "").trim();
        const isFuture = dateISO > todayISO;
        const hasSubmittedWorkout = workouts.some((row) => hasFeedbackInWorkout(row));
        const hasSubmittedMileage = mileageFeedback ? hasFeedbackInMileageEntry(mileageFeedback) : false;
        const hasPlan = workouts.length > 0 || prescribed.length > 0;
        const status: WeekSessionCard["status"] =
          workouts.length > 1
            ? "multiple"
            : hasSubmittedWorkout || hasSubmittedMileage
              ? "submitted"
              : hasPlan
                ? isFuture
                  ? "planned"
                  : "missing"
                : "none";
        const topWorkout = workouts[0];
        const title =
          workouts.length > 1
            ? "Multiple workouts"
            : topWorkout
              ? String(topWorkout.title ?? `${session} Workout`)
              : prescribed
                ? `${session} Planned Session`
                : "No planned session";
        const plannedSummary = [
          prescribed ? `Mileage: ${prescribed}` : "",
          topWorkout ? plannedTextFromWorkout(topWorkout) : "",
        ].filter(Boolean).join(" • ");
        const feedbackSummary = topWorkout ? feedbackSummaryFromWorkout(topWorkout) : feedbackSummaryFromMileage(mileageFeedback);
        const summary = status === "submitted" && feedbackSummary ? feedbackSummary : plannedSummary;

        return {
          key,
          dateISO,
          session,
          prescribed,
          workouts,
          mileageFeedback,
          status,
          title,
          summary,
          planSummary: plannedSummary,
          isFuture,
        };
      });

      return {
        dateISO,
        label: formatDisplayDate(dateISO),
        cards,
        dailyLogEntries: (dailyLogsByDate.get(dateISO) ?? []).slice().sort((a, b) => {
          const sessionCompare = formatDailyLogSession(a.session).localeCompare(formatDailyLogSession(b.session));
          if (sessionCompare !== 0) return sessionCompare;
          return Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
        }),
      };
    });
  }, [
    selectedAthleteId,
    selectedWeekStartISO,
    store.visibleMileageCellsByAthleteWeek,
    todayISO,
    weekMileageFeedbackEntries,
    weekDailyLogEntries,
    weekWorkoutRows,
  ]);

  const weekSummary = useMemo(() => {
    const feedbackCards = weekDayRows.flatMap((day) =>
      day.cards.filter((card) => card.status === "submitted" || card.status === "missing")
    );
    const submitted = feedbackCards.filter((card) => card.status === "submitted").length;
    const missing = feedbackCards.filter((card) => card.status === "missing").length;
    return { submitted, missing, total: feedbackCards.length };
  }, [weekDayRows]);

  const weeklyLogSummary = useMemo<WeeklyLogSummary>(() => {
    const athleteId = String(selectedAthleteId ?? "").trim();
    const cells = store.visibleMileageCellsByAthleteWeek[visibleMileageAthleteWeekKey(selectedAthleteId ?? "", selectedWeekStartISO)] ?? [];
    const plannedTotals = computeWeeklyPlannedMileageAndXtTotals({
      cells,
      athleteId,
      weekStartISO: selectedWeekStartISO,
    });

    let completedMileage: RangeTotal = { min: 0, max: 0 };
    let completedXTSeconds: RangeTotal = { min: 0, max: 0 };
    const submittedWorkoutSessionKeys = new Set<string>();

    for (const row of weekWorkoutRows) {
      if (!hasFeedbackInWorkout(row)) continue;
      const dateISO = String(row.date_iso ?? "");
      const session = normalizeSession(row.session);
      const key = `${dateISO}|${session}`;
      submittedWorkoutSessionKeys.add(key);

      const completedMiles = parseNumericLike(row.completed_miles);
      if (completedMiles != null) {
        completedMileage = addRange(completedMileage, { min: completedMiles, max: completedMiles });
      }

      if (hasRangeTotal(plannedTotals.xtSecondsBySessionKey.get(key) ?? { min: 0, max: 0 })) {
        const completedSeconds = parseCompletedTimeToSeconds(row.completed_time_text);
        if (completedSeconds != null && completedSeconds > 0) {
          completedXTSeconds = addRange(completedXTSeconds, { min: completedSeconds, max: completedSeconds });
        }
      }
    }

    for (const entry of weekMileageFeedbackEntries) {
      if (!hasFeedbackInMileageEntry(entry)) continue;
      const dateISO = String(entry.dateISO ?? "");
      const session = normalizeSession(entry.session);
      const key = `${dateISO}|${session}`;
      if (submittedWorkoutSessionKeys.has(key)) continue;

      const completedMiles = parseNumericLike(entry.completedMiles);
      if (completedMiles != null) {
        completedMileage = addRange(completedMileage, { min: completedMiles, max: completedMiles });
      }

      if (hasRangeTotal(plannedTotals.xtSecondsBySessionKey.get(key) ?? { min: 0, max: 0 })) {
        const completedSeconds = parseCompletedTimeToSeconds(entry.completedTime);
        if (completedSeconds != null && completedSeconds > 0) {
          completedXTSeconds = addRange(completedXTSeconds, { min: completedSeconds, max: completedSeconds });
        }
      }
    }

    for (const entry of weekDailyLogEntries) {
      if (entry.entryType !== "extra_activity") continue;

      const completedMiles = parseNumericLike(entry.completedMiles);
      if (completedMiles != null) {
        completedMileage = addRange(completedMileage, { min: completedMiles, max: completedMiles });
      }

      if (entry.activityKind === "cross_training") {
        const completedSeconds = parseCompletedTimeToSeconds(entry.completedTime);
        if (completedSeconds != null && completedSeconds > 0) {
          completedXTSeconds = addRange(completedXTSeconds, { min: completedSeconds, max: completedSeconds });
        }
      }
    }

    return {
      goalMileage: plannedTotals.goalMileageText,
      completedMileage: hasRangeTotal(completedMileage) ? formatMilesTotal(completedMileage) : "0 mi",
      goalXT: plannedTotals.goalXTText,
      completedXT: hasRangeTotal(completedXTSeconds) ? formatMinutesTotal(completedXTSeconds) : "0 min",
    };
  }, [
    selectedAthleteId,
    selectedWeekStartISO,
    store.visibleMileageCellsByAthleteWeek,
    weekDailyLogEntries,
    weekMileageFeedbackEntries,
    weekWorkoutRows,
  ]);

  const openEditorForCard = useCallback((card: WeekSessionCard) => {
    if (card.status === "none") return;
    if (card.status === "multiple") {
      Alert.alert("Multiple workouts", "Open the day view to complete logs for multiple workouts in this session.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open day",
          onPress: () => router.push({ pathname: "/(athlete)/day", params: { date: card.dateISO } }),
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
  }, [router]);

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
        await updateOwnWorkoutFeedbackById(workout.id, workout.athlete_profile_id, {
          completed_miles: parsedCompletedMiles ?? null,
          completed_time_text: completedTimeText || null,
          splits_or_pace: splitsText || null,
          additional_feedback: additionalFeedbackText || null,
        });
        setWeekWorkoutRows((prev) =>
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
        setWorkoutRows((prev) =>
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
            dateISO: card.dateISO,
            session: card.session,
          }),
          athleteId: String(selectedAthleteId ?? "") || undefined,
          athleteName: String(selectedAthleteName ?? "") || undefined,
          dateISO: card.dateISO,
          session: card.session,
          prescribed: card.prescribed || undefined,
          completedMiles: parsedCompletedMiles,
          completedTime: completedTimeText || undefined,
          splitsOrPace: splitsText || undefined,
          additionalFeedback: additionalFeedbackText || undefined,
          updatedAt: Date.now(),
        };
        await upsertMileageFeedback(entry);
        setWeekMileageFeedbackEntries((prev) => [...prev.filter((item) => item.id !== entry.id), entry]);
        setMileageFeedbackEntries((prev) => [...prev.filter((item) => item.id !== entry.id), entry]);
      }

      setEditor(null);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not save log.");
      setEditorError(message);
      Alert.alert("Save failed", message);
    } finally {
      setEditorSaving(false);
    }
  }, [editor, selectedAthleteId, selectedAthleteName]);

  const openDailyLogEditor = useCallback((dateISO: string, entryType: AthleteDailyLogEntryType) => {
    setDailyLogError(null);
    setDailyLogEditor({
      dateISO,
      entryType,
      session: null,
      activityKind: entryType === "extra_activity" ? "run" : null,
      titleText: "",
      completedMilesText: "",
      completedTimeText: "",
      notesText: "",
    });
  }, []);

  const editDailyLogEntry = useCallback((entry: AthleteDailyLogEntry) => {
    setDailyLogError(null);
    setDailyLogEditor({
      id: entry.id,
      dateISO: entry.dateISO,
      entryType: entry.entryType,
      session: entry.session ?? null,
      activityKind: entry.activityKind ?? (entry.entryType === "extra_activity" ? "run" : null),
      titleText: String(entry.title ?? ""),
      completedMilesText: entry.completedMiles != null ? String(entry.completedMiles) : "",
      completedTimeText: String(entry.completedTime ?? ""),
      notesText: String(entry.notes ?? ""),
      createdAt: entry.createdAt,
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
    const createdAt = dailyLogEditor.createdAt ?? now;
    const entry: AthleteDailyLogEntry = {
      id:
        dailyLogEditor.id ??
        buildAthleteDailyLogEntryId({
          athleteId,
          dateISO: dailyLogEditor.dateISO,
          createdAt,
        }),
      athleteId,
      athleteName: String(selectedAthleteName ?? "").trim() || null,
      dateISO: dailyLogEditor.dateISO,
      session: dailyLogEditor.session,
      entryType: dailyLogEditor.entryType,
      activityKind: isExtraActivity ? dailyLogEditor.activityKind ?? "other" : null,
      title: title || null,
      completedMiles: completedMilesRaw || null,
      completedTime: completedTime || null,
      notes: notes || null,
      createdAt,
      updatedAt: now,
    };

    setDailyLogSaving(true);
    setDailyLogError(null);
    try {
      const saved = await upsertAthleteDailyLogEntry(entry);
      setWeekDailyLogEntries((prev) => [...prev.filter((item) => item.id !== saved.id), saved]);
      setDailyLogEditor(null);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not save daily log entry.");
      setDailyLogError(message);
      Alert.alert("Save failed", message);
    } finally {
      setDailyLogSaving(false);
    }
  }, [dailyLogEditor, selectedAthleteId, selectedAthleteName]);

  const deleteDailyLogEntryFromEditor = useCallback(async () => {
    if (!dailyLogEditor?.id) return;
    const id = dailyLogEditor.id;
    setDailyLogSaving(true);
    setDailyLogError(null);
    try {
      await deleteAthleteDailyLogEntry(id);
      setWeekDailyLogEntries((prev) => prev.filter((entry) => entry.id !== id));
      setDailyLogEditor(null);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? "Could not delete daily log entry.");
      setDailyLogError(message);
      Alert.alert("Delete failed", message);
    } finally {
      setDailyLogSaving(false);
    }
  }, [dailyLogEditor?.id]);

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
          updatedAt: Date.parse(String(row.updated_at ?? "")) || 0,
          title: String(row.title ?? "Workout"),
          subtitle: `${formatDisplayDate(dateISO)} • ${session}`,
          routeParams: {
            id: String(row.id),
            name: String(selectedAthleteName ?? "Athlete"),
            returnTo: "/(athlete)/feedback",
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
          returnTo: "/(athlete)/feedback",
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
              returnTo: "/(athlete)/feedback",
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
              returnTo: "/(athlete)/feedback",
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

    const pendingByDayMap = new Map<string, PendingItem[]>();
    for (const item of pending) {
      const list = pendingByDayMap.get(item.dateISO) ?? [];
      list.push(item);
      pendingByDayMap.set(item.dateISO, list);
    }

    const pendingByDay: PendingDayGroup[] = Array.from(pendingByDayMap.entries())
      .sort(([a], [b]) => String(b).localeCompare(String(a)))
      .map(([dateISO, items]) => ({
        dateISO,
        label: formatDisplayDate(dateISO),
        items: items.sort((a, b) => (a.session === b.session ? 0 : a.session === "AM" ? -1 : 1)),
      }));

    return { pending, pendingByDay, recent };
  }, [mileageFeedbackEntries, plannedBySession, selectedAthleteId, selectedAthleteName, windowDates, workoutRows]);

  const pending = sections.pending;
  const pendingByDay = sections.pendingByDay;
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
      <Text style={{ fontSize: 28, fontWeight: "900", color: "#0f172a" }}>Log</Text>
      <Text style={{ marginTop: 6, color: "#475569", lineHeight: 20 }}>
        Submit logs and review your weekly totals.
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

      {selectedAthleteId ? (
        <View
          style={{
            marginTop: 16,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: "#dbeafe",
            backgroundColor: "#ffffff",
            padding: 14,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 20, fontWeight: "900", color: "#0f172a" }}>Week Log</Text>
              <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>
                Week of {formatWeekLabel(selectedWeekStartISO)}
              </Text>
            </View>
            <View
              style={{
                borderRadius: 999,
                borderWidth: 1,
                borderColor: weekSummary.missing > 0 ? "#fecaca" : "#bbf7d0",
                backgroundColor: weekSummary.missing > 0 ? "#fff1f2" : "#f0fdf4",
                paddingHorizontal: 10,
                paddingVertical: 5,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "900", color: weekSummary.missing > 0 ? "#be123c" : "#166534" }}>
                {weekSummary.submitted} of {weekSummary.total} submitted
              </Text>
            </View>
          </View>

          <View style={{ marginTop: 12, flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Pressable
              onPress={() => setSelectedWeekStartISO((prev) => addDaysISO(prev, -7))}
              style={{
                borderRadius: 999,
                borderWidth: 1,
                borderColor: "#cbd5e1",
                backgroundColor: "#f8fafc",
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <Text style={{ fontWeight: "900", color: "#334155" }}>Previous</Text>
            </Pressable>
            <Pressable
              onPress={() => setSelectedWeekStartISO(getWeekStartISO(todayISO, weekStartsOn))}
              style={{
                borderRadius: 999,
                borderWidth: 1,
                borderColor: "#bfdbfe",
                backgroundColor: "#eff6ff",
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <Text style={{ fontWeight: "900", color: "#1d4ed8" }}>Current week</Text>
            </Pressable>
            <Pressable
              onPress={() => setSelectedWeekStartISO((prev) => addDaysISO(prev, 7))}
              style={{
                borderRadius: 999,
                borderWidth: 1,
                borderColor: "#cbd5e1",
                backgroundColor: "#f8fafc",
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <Text style={{ fontWeight: "900", color: "#334155" }}>Next</Text>
            </Pressable>
          </View>

          <View
            style={{
              marginTop: 12,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: "#e2e8f0",
              backgroundColor: "#f8fafc",
              padding: 12,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>Weekly Summary</Text>
            <View style={{ marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {[
                ["Goal mileage", weeklyLogSummary.goalMileage],
                ["Completed mileage", weeklyLogSummary.completedMileage],
                ["Goal cross training", weeklyLogSummary.goalXT],
                ["Completed cross training", weeklyLogSummary.completedXT],
              ].map(([label, value]) => (
                <View
                  key={label}
                  style={{
                    flexBasis: "48%",
                    flexGrow: 1,
                    minWidth: 135,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "#e2e8f0",
                    backgroundColor: "#ffffff",
                    paddingHorizontal: 10,
                    paddingVertical: 9,
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>{label}</Text>
                  <Text style={{ marginTop: 3, fontSize: 16, fontWeight: "900", color: "#0f172a" }}>{value}</Text>
                </View>
              ))}
            </View>
          </View>

          {weekLoading ? (
            <View style={{ marginTop: 14, paddingVertical: 14, alignItems: "center" }}>
              <ActivityIndicator />
              <Text style={{ marginTop: 8, color: "#64748b" }}>Loading this week...</Text>
            </View>
          ) : weekError ? (
            <View
              style={{
                marginTop: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: "#fecaca",
                backgroundColor: "#fff1f2",
                padding: 12,
              }}
            >
              <Text style={{ fontWeight: "900", color: "#be123c" }}>Could not load week</Text>
              <Text style={{ marginTop: 4, color: "#991b1b" }}>{weekError}</Text>
              <Pressable
                onPress={() => void loadWeekData()}
                style={{
                  marginTop: 10,
                  alignSelf: "flex-start",
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: "#fecaca",
                  backgroundColor: "white",
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                }}
              >
                <Text style={{ fontWeight: "900", color: "#be123c" }}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ marginTop: 14, gap: 10 }}>
              {weekDayRows.map((day) => (
                <View
                  key={day.dateISO}
                  style={{
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: "#e2e8f0",
                    backgroundColor: "#f8fafc",
                    padding: 12,
                  }}
                >
                  <Text style={{ fontSize: 16, fontWeight: "900", color: "#0f172a" }}>{day.label}</Text>
                  <View style={{ marginTop: 10, gap: 8 }}>
                    {day.cards.map((card) => {
                      const tone =
                        card.status === "submitted"
                          ? { bg: "#f0fdf4", border: "#bbf7d0", text: "#166534", label: "Submitted" }
                          : card.status === "missing"
                            ? { bg: "#fff1f2", border: "#fecaca", text: "#be123c", label: "Missing" }
                            : card.status === "planned"
                              ? { bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8", label: "Planned" }
                              : card.status === "multiple"
                                ? { bg: "#fffbeb", border: "#fde68a", text: "#92400e", label: "Multiple workouts" }
                                : { bg: "#ffffff", border: "#e2e8f0", text: "#64748b", label: "No planned session" };
                      const canOpen = card.status !== "none";
                      return (
                        <Pressable
                          key={card.key}
                          disabled={!canOpen}
                          onPress={() => openEditorForCard(card)}
                          style={{
                            borderRadius: 14,
                            borderWidth: 1,
                            borderColor: tone.border,
                            backgroundColor: tone.bg,
                            padding: 12,
                            opacity: canOpen ? 1 : 0.75,
                          }}
                        >
                          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                            <Text style={{ fontSize: 13, fontWeight: "900", color: "#334155" }}>{card.session}</Text>
                            <Text style={{ fontSize: 12, fontWeight: "900", color: tone.text }}>{tone.label}</Text>
                          </View>
                          <Text style={{ marginTop: 5, fontSize: 16, fontWeight: "900", color: "#111827" }}>
                            {card.title}
                          </Text>
                          {card.summary ? (
                            <Text style={{ marginTop: 4, color: "#475569", lineHeight: 19 }}>{card.summary}</Text>
                          ) : null}
                          {canOpen ? (
                            <Text style={{ marginTop: 7, color: tone.text, fontWeight: "900" }}>
                              {card.status === "submitted" ? "Edit log" : card.status === "multiple" ? "Open day to review" : "Enter log"}
                            </Text>
                          ) : null}
                        </Pressable>
                      );
                    })}
                    {day.dailyLogEntries.length > 0 ? (
                      <View style={{ marginTop: 4, gap: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>
                          Daily notes / extra entries
                        </Text>
                        {day.dailyLogEntries.map((entry) => {
                          const typeLabel = formatDailyLogEntryType(entry.entryType);
                          const kindLabel = formatDailyLogActivityKind(entry.activityKind);
                          const summary = formatDailyLogEntrySummary(entry);
                          return (
                            <Pressable
                              key={entry.id}
                              onPress={() => editDailyLogEntry(entry)}
                              style={{
                                borderRadius: 14,
                                borderWidth: 1,
                                borderColor: entry.entryType === "extra_activity" ? "#bae6fd" : "#e9d5ff",
                                backgroundColor: entry.entryType === "extra_activity" ? "#f0f9ff" : "#faf5ff",
                                padding: 12,
                              }}
                            >
                              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                                <Text style={{ fontSize: 12, fontWeight: "900", color: "#334155" }}>
                                  {typeLabel}{kindLabel ? ` • ${kindLabel}` : ""}
                                </Text>
                                <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>
                                  {formatDailyLogSession(entry.session)}
                                </Text>
                              </View>
                              {entry.title ? (
                                <Text style={{ marginTop: 5, fontSize: 15, fontWeight: "900", color: "#0f172a" }}>
                                  {entry.title}
                                </Text>
                              ) : null}
                              {summary ? (
                                <Text style={{ marginTop: 4, color: "#475569", lineHeight: 19 }}>{summary}</Text>
                              ) : null}
                              <Text style={{ marginTop: 7, fontWeight: "900", color: "#2563eb" }}>Edit entry</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    ) : null}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      <Pressable
                        onPress={() => openDailyLogEditor(day.dateISO, "daily_note")}
                        style={{
                          flexGrow: 1,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: "#d8b4fe",
                          backgroundColor: "#faf5ff",
                          paddingHorizontal: 12,
                          paddingVertical: 9,
                          alignItems: "center",
                        }}
                      >
                        <Text style={{ fontWeight: "900", color: "#7e22ce" }}>Add daily note</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => openDailyLogEditor(day.dateISO, "extra_activity")}
                        style={{
                          flexGrow: 1,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: "#7dd3fc",
                          backgroundColor: "#f0f9ff",
                          paddingHorizontal: 12,
                          paddingVertical: 9,
                          alignItems: "center",
                        }}
                      >
                        <Text style={{ fontWeight: "900", color: "#0369a1" }}>Add extra activity</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      ) : null}

      <View style={{ marginTop: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Missing logs</Text>
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
            <Text style={{ marginTop: 8, color: "#64748b" }}>Loading log tasks...</Text>
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
              No missing logs right now.
            </Text>
          </View>
        ) : (
          <View style={{ marginTop: 10, gap: 10 }}>
            {pendingByDay.map((dayGroup) => (
              <View
                key={dayGroup.dateISO}
                style={{
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  backgroundColor: "#ffffff",
                  padding: 14,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <Text style={{ fontSize: 17, fontWeight: "900", color: "#0f172a" }}>{dayGroup.label}</Text>
                  <View
                    style={{
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: "#fecaca",
                      backgroundColor: "#fff1f2",
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "900", color: "#be123c" }}>
                      {dayGroup.items.length} {dayGroup.items.length === 1 ? "session" : "sessions"}
                    </Text>
                  </View>
                </View>

                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/(athlete)/day",
                      params: { date: dayGroup.dateISO },
                    })
                  }
                  style={{
                    marginTop: 8,
                    alignSelf: "flex-start",
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    backgroundColor: "#f8fafc",
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Open day</Text>
                </Pressable>

                <View style={{ marginTop: 10, gap: 8 }}>
                  {dayGroup.items.map((item) => (
                    <Pressable
                      key={item.key}
                      onPress={() => router.push({ pathname: "/(athlete)/workout/[id]", params: item.routeParams })}
                      style={{
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: "#fecaca",
                        backgroundColor: "#fffafa",
                        padding: 11,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#64748b" }}>{item.session}</Text>
                        <Text style={{ fontSize: 12, fontWeight: "900", color: "#dc2626" }}>Missing log</Text>
                      </View>
                      <Text style={{ marginTop: 4, fontSize: 16, fontWeight: "900", color: "#111827" }}>{item.title}</Text>
                      {item.description ? (
                        <Text style={{ marginTop: 4, color: "#334155" }}>{item.description}</Text>
                      ) : null}
                      <Text style={{ marginTop: 7, color: "#dc2626", fontWeight: "900" }}>Open log</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
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

      <Modal
        visible={Boolean(editor)}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!editorSaving) setEditor(null);
        }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(15, 23, 42, 0.35)",
            justifyContent: "flex-end",
          }}
        >
          <View
            style={{
              maxHeight: "88%",
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              backgroundColor: "#ffffff",
              padding: 18,
            }}
          >
            {editor ? (
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={{ fontSize: 22, fontWeight: "900", color: "#0f172a" }}>
                  {editor.card.session} Log
                </Text>
                <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>
                  {formatDisplayDate(editor.card.dateISO)}
                </Text>
                {editor.card.planSummary || editor.card.prescribed ? (
                  <View
                    style={{
                      marginTop: 12,
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: "#dbeafe",
                      backgroundColor: "#eff6ff",
                      padding: 12,
                    }}
                  >
                    <Text style={{ fontWeight: "900", color: "#1e3a8a" }}>Planned</Text>
                    <Text style={{ marginTop: 4, color: "#1e40af", lineHeight: 20 }}>
                      {editor.card.planSummary || `Mileage: ${editor.card.prescribed}`}
                    </Text>
                  </View>
                ) : null}

                <View style={{ marginTop: 14, gap: 12 }}>
                  <View>
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Completed distance</Text>
                    <TextInput
                      value={editor.completedMilesText}
                      onChangeText={(text) => setEditor((prev) => (prev ? { ...prev, completedMilesText: text } : prev))}
                      placeholder="Example: 5.25"
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
                  <View>
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Completed time</Text>
                    <TextInput
                      value={editor.completedTimeText}
                      onChangeText={(text) => setEditor((prev) => (prev ? { ...prev, completedTimeText: text } : prev))}
                      placeholder="Example: 42:30"
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
                  <View>
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Splits / pace</Text>
                    <TextInput
                      value={editor.splitsText}
                      onChangeText={(text) => setEditor((prev) => (prev ? { ...prev, splitsText: text } : prev))}
                      placeholder="Optional"
                      multiline
                      style={{
                        marginTop: 6,
                        minHeight: 72,
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
                  <View>
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Notes</Text>
                    <TextInput
                      value={editor.additionalFeedbackText}
                      onChangeText={(text) => setEditor((prev) => (prev ? { ...prev, additionalFeedbackText: text } : prev))}
                      placeholder="Optional notes"
                      multiline
                      style={{
                        marginTop: 6,
                        minHeight: 92,
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

                {editorError ? (
                  <Text style={{ marginTop: 12, color: "#be123c", fontWeight: "800" }}>{editorError}</Text>
                ) : null}

                <View style={{ marginTop: 18, flexDirection: "row", gap: 10 }}>
                  <Pressable
                    disabled={editorSaving}
                    onPress={() => setEditor(null)}
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
                    disabled={editorSaving}
                    onPress={() => void saveEditor()}
                    style={{
                      flex: 1,
                      borderRadius: 14,
                      backgroundColor: editorSaving ? "#93c5fd" : "#2563eb",
                      paddingVertical: 13,
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ fontWeight: "900", color: "white" }}>
                      {editorSaving ? "Saving..." : "Save log"}
                    </Text>
                  </Pressable>
                </View>
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={Boolean(dailyLogEditor)}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!dailyLogSaving) setDailyLogEditor(null);
        }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(15, 23, 42, 0.35)",
            justifyContent: "flex-end",
          }}
        >
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
                  {dailyLogEditor.id ? "Edit daily log" : "Add daily log"}
                </Text>
                <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }}>
                  {formatDisplayDate(dailyLogEditor.dateISO)}
                </Text>

                <View style={{ marginTop: 14, gap: 12 }}>
                  <View>
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Entry type</Text>
                    <View style={{ marginTop: 7, flexDirection: "row", gap: 8 }}>
                      {(["daily_note", "extra_activity"] as const).map((entryType) => {
                        const selected = dailyLogEditor.entryType === entryType;
                        return (
                          <Pressable
                            key={`daily-log-entry-type-${entryType}`}
                            onPress={() =>
                              setDailyLogEditor((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      entryType,
                                      activityKind: entryType === "extra_activity" ? prev.activityKind ?? "run" : null,
                                    }
                                  : prev
                              )
                            }
                            style={{
                              flex: 1,
                              borderRadius: 999,
                              borderWidth: 1,
                              borderColor: selected ? "#2563eb" : "#cbd5e1",
                              backgroundColor: selected ? "#eff6ff" : "#ffffff",
                              paddingVertical: 10,
                              alignItems: "center",
                            }}
                          >
                            <Text style={{ fontWeight: "900", color: selected ? "#1d4ed8" : "#334155" }}>
                              {formatDailyLogEntryType(entryType)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>

                  <View>
                    <Text style={{ fontWeight: "900", color: "#334155" }}>Session</Text>
                    <View style={{ marginTop: 7, flexDirection: "row", gap: 8 }}>
                      {[
                        { value: null, label: "All day" },
                        { value: "AM" as const, label: "AM" },
                        { value: "PM" as const, label: "PM" },
                      ].map((option) => {
                        const selected = dailyLogEditor.session === option.value;
                        return (
                          <Pressable
                            key={`daily-log-session-${option.label}`}
                            onPress={() => setDailyLogEditor((prev) => (prev ? { ...prev, session: option.value } : prev))}
                            style={{
                              flex: 1,
                              borderRadius: 999,
                              borderWidth: 1,
                              borderColor: selected ? "#2563eb" : "#cbd5e1",
                              backgroundColor: selected ? "#eff6ff" : "#ffffff",
                              paddingVertical: 10,
                              alignItems: "center",
                            }}
                          >
                            <Text style={{ fontWeight: "900", color: selected ? "#1d4ed8" : "#334155" }}>
                              {option.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>

                  {dailyLogEditor.entryType === "extra_activity" ? (
                    <View>
                      <Text style={{ fontWeight: "900", color: "#334155" }}>Activity kind</Text>
                      <View style={{ marginTop: 7, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        {(["run", "cross_training", "strength", "mobility", "other"] as const).map((kind) => {
                          const selected = dailyLogEditor.activityKind === kind;
                          return (
                            <Pressable
                              key={`daily-log-kind-${kind}`}
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
                          onChangeText={(text) =>
                            setDailyLogEditor((prev) => (prev ? { ...prev, completedMilesText: text } : prev))
                          }
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
                          onChangeText={(text) =>
                            setDailyLogEditor((prev) => (prev ? { ...prev, completedTimeText: text } : prev))
                          }
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

                {dailyLogError ? (
                  <Text style={{ marginTop: 12, color: "#be123c", fontWeight: "800" }}>{dailyLogError}</Text>
                ) : null}

                <View style={{ marginTop: 18, gap: 10 }}>
                  {dailyLogEditor.id ? (
                    <Pressable
                      disabled={dailyLogSaving}
                      onPress={() => {
                        Alert.alert("Delete entry?", "This removes only this daily log entry. Prescribed training is unchanged.", [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Delete",
                            style: "destructive",
                            onPress: () => void deleteDailyLogEntryFromEditor(),
                          },
                        ]);
                      }}
                      style={{
                        borderRadius: 14,
                        borderWidth: 1,
                        borderColor: "#fecaca",
                        backgroundColor: "#fff1f2",
                        paddingVertical: 12,
                        alignItems: "center",
                      }}
                    >
                      <Text style={{ fontWeight: "900", color: "#be123c" }}>Delete entry</Text>
                    </Pressable>
                  ) : null}
                  <View style={{ flexDirection: "row", gap: 10 }}>
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
                        {dailyLogSaving ? "Saving..." : "Save entry"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
