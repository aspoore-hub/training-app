import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  hasMileageFeedback,
  hasWorkoutFeedback,
  parseNumericLike,
} from "../../../lib/feedbackParsing";
import { loadAthleteDailyLogEntries, type AthleteDailyLogEntry } from "../../../lib/athleteDailyLogEntries";
import { loadMileageFeedback, type MileageSessionFeedback } from "../../../lib/mileageFeedback";
import { getWeekIndex, getWeekStartISO, parseISODate, toISODate } from "../../../lib/mileagePlan";
import { loadWeekStartSetting } from "../../../lib/settings";
import {
  compareAthleteDisplayNamesByLastName,
  loadTeamRoster,
  resolveAthleteDisplayName,
  type TeamRosterAthlete,
} from "../../../lib/teamRoster";
import { listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../lib/teamWorkoutsCloud";
import { isActiveTrainingGroupMembership, teamDataStore } from "../../../lib/teamDataStore";
import { formatParsedWorkoutEntry, parseWorkoutEntryValue } from "../../../lib/workoutEntryParser";
import type { WeekStartDay } from "../../../lib/types";

type FeedbackFilter = "submitted" | "missing" | "all";
type ViewMode = "day" | "week" | "month";
type SourceType = "workout" | "mileage" | "daily_note" | "extra_activity";
type PrescribedSourceType = "workout" | "mileage";

type SubmittedTrainingLogRow = {
  key: string;
  athleteId: string | null;
  athleteName: string;
  dateISO: string;
  session: "AM" | "PM" | null;
  sourceType: SourceType;
  sourceTitle: string;
  activityKind: string | null;
  prescribedText: string | null;
  completedMiles: number | null;
  completedTime: string | null;
  splitsOrPace: string | null;
  additionalFeedback: string | null;
  updatedAt: number | null;
  duplicateReason: string | null;
};

type MissingTrainingLogRow = {
  key: string;
  athleteId: string | null;
  athleteName: string;
  dateISO: string;
  session: "AM" | "PM";
  sourceType: PrescribedSourceType;
  prescribedText: string | null;
  sourceTitle: string | null;
  categories: string[];
};

type TrainingLogRow = SubmittedTrainingLogRow;

type SubmittedAthleteGroup = {
  athleteKey: string;
  athleteName: string;
  rows: SubmittedTrainingLogRow[];
};

type WeekDayLogSection = {
  dateISO: string;
  submitted: {
    groups: SubmittedAthleteGroup[];
    total: number;
  };
  missing: {
    am: MissingTrainingLogRow[];
    pm: MissingTrainingLogRow[];
    total: number;
  };
};

type MonthSessionSummary = {
  total: number;
  submitted: number;
  missing: number;
};

type MonthDaySummary = {
  dateISO: string;
  total: number;
  submitted: number;
  missing: number;
  am: MonthSessionSummary;
  pm: MonthSessionSummary;
  isVisibleByStatusFilter: boolean;
};

const FEEDBACK_FILTER_OPTIONS: Array<{ value: FeedbackFilter; label: string }> = [
  { value: "submitted", label: "Submitted / Logged" },
  { value: "missing", label: "Missing prescribed feedback" },
  { value: "all", label: "All" },
];

const COACH_TRAINING_LOGS_SELECTED_ATHLETES_KEY = "coach_training_logs_selected_athletes_v1";
const COACH_TRAINING_LOGS_FEEDBACK_FILTER_KEY = "coach_training_logs_feedback_filter_v1";
const COACH_TRAINING_LOGS_VIEW_MODE_KEY = "coach_training_logs_view_mode_v1";

type TrainingGroupFilterOption = {
  id: string;
  label: string;
  archived: boolean;
};

type SeasonFilterOption = {
  id: string;
  label: string;
  archived: boolean;
};

function normalizeSession(value: string | undefined): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
}

function addDaysISO(dateISO: string, days: number) {
  const dt = parseISODate(dateISO);
  dt.setDate(dt.getDate() + days);
  return toISODate(dt);
}

function buildDateRange(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  let cursor = String(startISO);
  while (cursor <= endISO) {
    out.push(cursor);
    cursor = addDaysISO(cursor, 1);
  }
  return out;
}

function getMonthStartISO(dateISO: string): string {
  const dt = parseISODate(dateISO);
  dt.setDate(1);
  return toISODate(dt);
}

function getMonthEndISO(dateISO: string): string {
  const dt = parseISODate(dateISO);
  dt.setMonth(dt.getMonth() + 1, 0);
  return toISODate(dt);
}

function addMonthsISO(dateISO: string, deltaMonths: number): string {
  const dt = parseISODate(dateISO);
  const year = dt.getFullYear();
  const month = dt.getMonth();
  const day = dt.getDate();

  const target = new Date(year, month + deltaMonths, 1);
  const targetYear = target.getFullYear();
  const targetMonth = target.getMonth();
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return toISODate(target);
}

function formatDisplayDate(iso: string) {
  const [y, m, d] = String(iso ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(iso ?? "");
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return String(iso ?? "");
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMonthYearLabel(dateISO: string): string {
  const date = parseISODate(dateISO);
  if (Number.isNaN(date.getTime())) return String(dateISO ?? "");
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatWeekRangeLabel(startISO: string, endISO: string): string {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startISO} – ${endISO}`;
  }

  const startMonth = start.toLocaleDateString(undefined, { month: "short" });
  const endMonth = end.toLocaleDateString(undefined, { month: "short" });
  const startDay = start.getDate();
  const endDay = end.getDate();
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  if (startYear === endYear && startMonth === endMonth) {
    return `${startMonth} ${startDay} – ${endDay}, ${startYear}`;
  }

  if (startYear === endYear) {
    return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${startYear}`;
  }

  return `${startMonth} ${startDay}, ${startYear} – ${endMonth} ${endDay}, ${endYear}`;
}

function formatUpdatedAtLabel(updatedAt: number | null): string | null {
  if (!updatedAt || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return new Date(updatedAt).toLocaleString();
}

function formatCompletedLabel(row: TrainingLogRow): string {
  const parts: string[] = [];
  if (typeof row.completedMiles === "number" && Number.isFinite(row.completedMiles)) {
    const rounded = Math.round(row.completedMiles * 100) / 100;
    const miles = Number.isInteger(rounded)
      ? String(rounded)
      : String(rounded).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
    parts.push(`${miles} mi`);
  }
  if (row.completedTime) parts.push(row.completedTime);
  return parts.length > 0 ? parts.join(" • ") : "—";
}

function formatSourceLabel(sourceType: SourceType): string {
  if (sourceType === "workout") return "Workout";
  if (sourceType === "mileage") return "Mileage";
  if (sourceType === "extra_activity") return "Extra activity";
  return "Daily note";
}

function formatActivityKindLabel(kind: string | null): string {
  if (kind === "cross_training") return "Cross training";
  if (kind === "run") return "Run";
  if (kind === "strength") return "Strength";
  if (kind === "mobility") return "Mobility";
  if (kind === "other") return "Other";
  return "";
}

function normalizeFeedbackFilter(value: unknown): FeedbackFilter {
  const raw = String(value ?? "").trim();
  if (raw === "submitted" || raw === "with_feedback") return "submitted";
  if (raw === "missing" || raw === "no_feedback") return "missing";
  if (raw === "all") return "all";
  return "submitted";
}

function workoutCategories(row: TeamWorkoutRow): string[] {
  const out = new Set<string>();
  const primary = String(row.primary_category ?? "").trim();
  if (primary) out.add(primary);
  (Array.isArray(row.categories) ? row.categories : []).forEach((category) => {
    const normalized = String(category ?? "").trim();
    if (normalized) out.add(normalized);
  });
  return Array.from(out);
}

function resolveMileagePrescribedText(
  cellsByWeek: ReturnType<typeof teamDataStore.use>["mileageCellsByWeek"],
  athleteId: string,
  dateISO: string,
  session: "AM" | "PM",
  weekStartsOn: WeekStartDay
): string {
  const weekStartISO = getWeekStartISO(dateISO, weekStartsOn);
  const dayIdx = getWeekIndex(dateISO, weekStartISO);
  if (!Number.isFinite(dayIdx) || dayIdx < 0 || dayIdx > 6) return "";

  const cell = (cellsByWeek[weekStartISO] ?? []).find(
    (row) =>
      String(row.athlete_profile_id ?? "").trim() === athleteId &&
      row.day_idx === dayIdx &&
      row.session === session
  );
  if (!cell) return "";

  const parsed = parseWorkoutEntryValue(cell.value);
  if (parsed) return formatParsedWorkoutEntry(parsed);
  if (typeof cell.value === "string") return String(cell.value).trim();
  return "";
}

function toComparableUpdatedAt(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  const parsed = Date.parse(String(input ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldPreferWorkout(nextRow: TeamWorkoutRow, currentRow: TeamWorkoutRow): boolean {
  const nextHas = hasWorkoutFeedback(nextRow);
  const currentHas = hasWorkoutFeedback(currentRow);
  if (nextHas !== currentHas) return nextHas;

  const nextUpdated = toComparableUpdatedAt(nextRow.updated_at);
  const currentUpdated = toComparableUpdatedAt(currentRow.updated_at);
  return nextUpdated >= currentUpdated;
}

function normalizeComparableFeedbackValue(value: unknown): string {
  const numeric = parseNumericLike(value);
  if (numeric != null) return String(Math.round(numeric * 100) / 100);
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function mileageFeedbackDiffersFromWorkout(entry: MileageSessionFeedback, row: TeamWorkoutRow): boolean {
  const comparisons: Array<[unknown, unknown]> = [
    [entry.completedMiles, row.completed_miles],
    [entry.completedTime, row.completed_time_text],
    [entry.splitsOrPace, row.splits_or_pace],
    [entry.additionalFeedback, row.additional_feedback],
  ];

  return comparisons.some(([mileageValue, workoutValue]) => {
    const mileage = normalizeComparableFeedbackValue(mileageValue);
    if (!mileage) return false;
    const workout = normalizeComparableFeedbackValue(workoutValue);
    return mileage !== workout;
  });
}

function sortMissingRowsByAthleteName(rows: MissingTrainingLogRow[]): MissingTrainingLogRow[] {
  return [...rows].sort((a, b) => compareAthleteDisplayNamesByLastName(a.athleteName, b.athleteName));
}

function groupSubmittedRowsByAthlete(rows: SubmittedTrainingLogRow[]): SubmittedAthleteGroup[] {
  const submittedByAthlete = new Map<string, SubmittedAthleteGroup>();
  const rowOrder = (row: SubmittedTrainingLogRow) => {
    if (row.session === "AM") return 0;
    if (row.session === "PM") return 1;
    return row.sourceType === "extra_activity" ? 2 : 3;
  };

  for (const row of rows) {
    const athleteKey = row.athleteId ? `athlete:${row.athleteId}` : `name:${row.athleteName}`;
    const group = submittedByAthlete.get(athleteKey) ?? {
      athleteKey,
      athleteName: row.athleteName,
      rows: [],
    };
    group.rows.push(row);
    submittedByAthlete.set(athleteKey, group);
  }

  return Array.from(submittedByAthlete.values())
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => {
        const orderDiff = rowOrder(a) - rowOrder(b);
        if (orderDiff !== 0) return orderDiff;
        const updatedA = a.updatedAt ?? 0;
        const updatedB = b.updatedAt ?? 0;
        if (updatedA !== updatedB) return updatedA - updatedB;
        return a.key.localeCompare(b.key);
      }),
    }))
    .sort((a, b) => compareAthleteDisplayNamesByLastName(a.athleteName, b.athleteName));
}

export default function CoachTrainingLogsTab() {
  const store = teamDataStore.use();

  const [anchorDateISO, setAnchorDateISO] = useState(() => toISODate(new Date()));
  const [loading, setLoading] = useState(true);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartDay>(1);
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [roster, setRoster] = useState<TeamRosterAthlete[]>([]);
  const [workoutRows, setWorkoutRows] = useState<TeamWorkoutRow[]>([]);
  const [mileageFeedback, setMileageFeedback] = useState<MileageSessionFeedback[]>([]);
  const [dailyLogEntries, setDailyLogEntries] = useState<AthleteDailyLogEntry[]>([]);
  const [selectedAthleteIds, setSelectedAthleteIds] = useState<string[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState<FeedbackFilter>("submitted");
  const [athleteFilterOpen, setAthleteFilterOpen] = useState(false);
  const selectedTrainingGroupIds = store.sharedSelectedTrainingGroupIds;
  const [trainingGroupFilterOpen, setTrainingGroupFilterOpen] = useState(false);
  const selectedSeasonId = store.sharedSelectedSeasonId;
  const [seasonFilterOpen, setSeasonFilterOpen] = useState(false);
  const [feedbackFilterOpen, setFeedbackFilterOpen] = useState(false);
  const [showDayMissingFeedback, setShowDayMissingFeedback] = useState(false);
  const [expandedWeekDays, setExpandedWeekDays] = useState<Record<string, boolean>>({});
  const [weekMissingOpenByDate, setWeekMissingOpenByDate] = useState<Record<string, boolean>>({});
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [detailRow, setDetailRow] = useState<TrainingLogRow | null>(null);

  const visibleRange = useMemo(() => {
    if (viewMode === "day") {
      return { startISO: anchorDateISO, endISO: anchorDateISO };
    }
    if (viewMode === "week") {
      const startISO = getWeekStartISO(anchorDateISO, weekStartsOn);
      const endISO = addDaysISO(startISO, 6);
      return { startISO, endISO };
    }
    const startISO = getMonthStartISO(anchorDateISO);
    const endISO = getMonthEndISO(anchorDateISO);
    return { startISO, endISO };
  }, [anchorDateISO, viewMode, weekStartsOn]);

  const visibleDates = useMemo(() => {
    return buildDateRange(visibleRange.startISO, visibleRange.endISO);
  }, [visibleRange.endISO, visibleRange.startISO]);

  const rangeLabel = useMemo(() => {
    if (viewMode === "day") return formatDisplayDate(anchorDateISO);
    if (viewMode === "week") return formatWeekRangeLabel(visibleRange.startISO, visibleRange.endISO);
    return formatMonthYearLabel(anchorDateISO);
  }, [anchorDateISO, viewMode, visibleRange.endISO, visibleRange.startISO]);

  const rosterNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const athlete of roster) {
      const id = String(athlete.id ?? "").trim();
      if (!id) continue;
      map.set(id, String(athlete.displayName ?? "").trim() || "Athlete");
    }
    return map;
  }, [roster]);

  const activeAthleteFilterOptions = useMemo(() => {
    return roster
      .filter((athlete) => athlete.isActive !== false)
      .map((athlete) => ({
        id: String(athlete.id ?? "").trim(),
        label: String(athlete.displayName ?? "").trim() || "Athlete",
      }))
      .filter((athlete) => !!athlete.id)
      .sort((a, b) => compareAthleteDisplayNamesByLastName(a.label, b.label));
  }, [roster]);

  const loadPageData = useCallback(async () => {
    setLoading(true);
    try {
      const weekStartResult = await loadWeekStartSetting();
      const nextWeekStartsOn: WeekStartDay = weekStartResult.normalized === "sunday" ? 0 : 1;
      setWeekStartsOn(nextWeekStartsOn);

      const startISO =
        viewMode === "day"
          ? anchorDateISO
          : viewMode === "week"
            ? getWeekStartISO(anchorDateISO, nextWeekStartsOn)
            : getMonthStartISO(anchorDateISO);
      const endISO =
        viewMode === "day"
          ? anchorDateISO
          : viewMode === "week"
            ? addDaysISO(startISO, 6)
            : getMonthEndISO(anchorDateISO);
      const dates = buildDateRange(startISO, endISO);
      const weekStarts = Array.from(new Set(dates.map((dateISO) => getWeekStartISO(dateISO, nextWeekStartsOn))));

      const [rosterRows, rangeRows, mileageEntries, dailyEntries] = await Promise.all([
        loadTeamRoster(),
        listTeamWorkoutsInRange(startISO, endISO),
        loadMileageFeedback(),
        loadAthleteDailyLogEntries(),
      ]);
      await Promise.all(weekStarts.map((weekStartISO) => teamDataStore.actions.loadMileageWeek(weekStartISO)));

      setRoster(Array.isArray(rosterRows) ? rosterRows : []);
      setWorkoutRows(Array.isArray(rangeRows) ? rangeRows : []);
      setMileageFeedback(Array.isArray(mileageEntries) ? mileageEntries : []);
      setDailyLogEntries(Array.isArray(dailyEntries) ? dailyEntries : []);
    } finally {
      setLoading(false);
    }
  }, [anchorDateISO, viewMode]);

  useFocusEffect(
    useCallback(() => {
      void loadPageData();
      void teamDataStore.actions.loadTrainingGroups();
      void teamDataStore.actions.loadSharedCoachFilters();
      void teamDataStore.actions.loadTeamSeasons();
      void teamDataStore.actions.loadAthleteSeasonOverrides();
    }, [loadPageData])
  );

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [savedAthletesRaw, savedFeedbackFilterRaw, savedViewModeRaw] = await AsyncStorage.multiGet([
          COACH_TRAINING_LOGS_SELECTED_ATHLETES_KEY,
          COACH_TRAINING_LOGS_FEEDBACK_FILTER_KEY,
          COACH_TRAINING_LOGS_VIEW_MODE_KEY,
        ]);

        if (!active) return;

        const savedAthletesParsed = savedAthletesRaw?.[1] ? JSON.parse(savedAthletesRaw[1]) : [];
        const nextSelectedAthletes = Array.isArray(savedAthletesParsed)
          ? savedAthletesParsed.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [];

        const nextFeedbackFilter = normalizeFeedbackFilter(savedFeedbackFilterRaw?.[1]);

        const savedViewMode = String(savedViewModeRaw?.[1] ?? "").trim();
        const nextViewMode: ViewMode =
          savedViewMode === "week" || savedViewMode === "month" || savedViewMode === "day"
            ? savedViewMode
            : "day";

        setSelectedAthleteIds(nextSelectedAthletes);
        setFeedbackFilter(nextFeedbackFilter);
        setViewMode(nextViewMode);
      } finally {
        if (active) setPrefsHydrated(true);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!prefsHydrated) return;
    const validIds = new Set(activeAthleteFilterOptions.map((option) => option.id));
    const filtered = selectedAthleteIds.filter((id) => validIds.has(id));
    if (filtered.length !== selectedAthleteIds.length) {
      setSelectedAthleteIds(filtered);
    }
  }, [activeAthleteFilterOptions, prefsHydrated, selectedAthleteIds]);

  useEffect(() => {
    if (!prefsHydrated) return;
    void AsyncStorage.setItem(
      COACH_TRAINING_LOGS_SELECTED_ATHLETES_KEY,
      JSON.stringify(selectedAthleteIds)
    ).catch(() => {});
  }, [prefsHydrated, selectedAthleteIds]);

  useEffect(() => {
    if (!prefsHydrated) return;
    void AsyncStorage.setItem(COACH_TRAINING_LOGS_FEEDBACK_FILTER_KEY, feedbackFilter).catch(() => {});
  }, [feedbackFilter, prefsHydrated]);

  useEffect(() => {
    setShowDayMissingFeedback(false);
  }, [anchorDateISO, feedbackFilter, selectedAthleteIds, selectedSeasonId, selectedTrainingGroupIds]);

  useEffect(() => {
    if (!prefsHydrated) return;
    void AsyncStorage.setItem(COACH_TRAINING_LOGS_VIEW_MODE_KEY, viewMode).catch(() => {});
  }, [prefsHydrated, viewMode]);

  const trainingGroupFilterOptions = useMemo<TrainingGroupFilterOption[]>(() => {
    const byId = new Map<string, TrainingGroupFilterOption>();
    (Array.isArray(store.trainingGroups) ? store.trainingGroups : []).forEach((group) => {
      const id = String(group?.id ?? "").trim();
      if (!id) return;
      const label = String(group?.name ?? "").trim() || "Training Group";
      const archived = !!group?.archived_at;
      if (!archived) {
        byId.set(id, { id, label, archived });
      }
    });
    selectedTrainingGroupIds.forEach((groupIdRaw) => {
      const id = String(groupIdRaw ?? "").trim();
      if (!id || byId.has(id)) return;
      const match = (store.trainingGroups ?? []).find((group) => String(group?.id ?? "").trim() === id);
      byId.set(id, {
        id,
        label: String(match?.name ?? "").trim() || `Group (${id.slice(-6)})`,
        archived: !!match?.archived_at,
      });
    });
    return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [selectedTrainingGroupIds, store.trainingGroups]);

  const seasonFilterOptions = useMemo<SeasonFilterOption[]>(() => {
    const byId = new Map<string, SeasonFilterOption>();
    (Array.isArray(store.teamSeasons) ? store.teamSeasons : []).forEach((season) => {
      const id = String(season?.id ?? "").trim();
      if (!id) return;
      const label = String(season?.name ?? "").trim() || "Season";
      const archived = !!season?.archived_at;
      if (!archived) byId.set(id, { id, label, archived });
    });
    const selectedId = String(selectedSeasonId ?? "").trim();
    if (selectedId && !byId.has(selectedId)) {
      const match = (store.teamSeasons ?? []).find((season) => String(season?.id ?? "").trim() === selectedId);
      byId.set(selectedId, {
        id: selectedId,
        label: String(match?.name ?? "").trim() || `Season (${selectedId.slice(-6)})`,
        archived: !!match?.archived_at,
      });
    }
    const order = new Map<string, number>();
    (Array.isArray(store.teamSeasons) ? store.teamSeasons : []).forEach((season, idx) => {
      const id = String(season?.id ?? "").trim();
      if (id) order.set(id, idx);
    });
    return Array.from(byId.values()).sort(
      (a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }, [selectedSeasonId, store.teamSeasons]);

  useEffect(() => {
    if (!store.sharedCoachFiltersLoaded) return;
    if (!store.trainingGroupsLoaded) return;
    const validIds = new Set(trainingGroupFilterOptions.map((option) => option.id));
    const next = selectedTrainingGroupIds.filter((id) => validIds.has(id));
    if (next.length !== selectedTrainingGroupIds.length) {
      void teamDataStore.actions.setSharedSelectedTrainingGroupIds(next);
    }
  }, [
    selectedTrainingGroupIds,
    store.sharedCoachFiltersLoaded,
    store.trainingGroupsLoaded,
    trainingGroupFilterOptions,
  ]);

  useEffect(() => {
    if (!store.sharedCoachFiltersLoaded) return;
    if (!store.teamSeasonsLoaded) return;
    const selectedId = String(selectedSeasonId ?? "").trim();
    if (!selectedId) return;
    const validIds = new Set(seasonFilterOptions.map((option) => option.id));
    if (!validIds.has(selectedId)) {
      void teamDataStore.actions.setSharedSelectedSeasonId(null);
    }
  }, [seasonFilterOptions, selectedSeasonId, store.sharedCoachFiltersLoaded, store.teamSeasonsLoaded]);

  const normalizedLogRows = useMemo<{
    submittedLogRows: SubmittedTrainingLogRow[];
    missingPrescribedRows: MissingTrainingLogRow[];
  }>(() => {
    const dateSet = new Set(visibleDates);
    const cellsByWeek = store.mileageCellsByWeek;

    const workoutByAthleteDateSession = new Map<string, TeamWorkoutRow>();
    for (const row of workoutRows) {
      const dateISO = String(row.date_iso ?? "");
      if (!dateSet.has(dateISO)) continue;
      const athleteId = String(row.athlete_profile_id ?? "").trim();
      if (!athleteId) continue;
      const session = normalizeSession(row.session);
      const key = `${dateISO}|${athleteId}|${session}`;
      const existing = workoutByAthleteDateSession.get(key);
      if (!existing || shouldPreferWorkout(row, existing)) {
        workoutByAthleteDateSession.set(key, row);
      }
    }

    const mileageFeedbackByAthleteDateSession = new Map<string, MileageSessionFeedback[]>();
    for (const entry of mileageFeedback) {
      const dateISO = String(entry.dateISO ?? "");
      if (!dateSet.has(dateISO)) continue;
      const session = normalizeSession(entry.session);
      const athleteIdRaw = String(entry.athleteId ?? "").trim();
      const athleteNameFromEntry = String(entry.athleteName ?? "").trim();

      let athleteId: string | null = athleteIdRaw || null;
      if (!athleteId && athleteNameFromEntry) {
        const matched = roster.find(
          (athlete) =>
            String(athlete.displayName ?? "").trim().toLowerCase() === athleteNameFromEntry.toLowerCase()
        );
        athleteId = matched ? String(matched.id ?? "").trim() || null : null;
      }

      if (!athleteId) continue;
      const key = `${dateISO}|${athleteId}|${session}`;
      const list = mileageFeedbackByAthleteDateSession.get(key) ?? [];
      list.push(entry);
      mileageFeedbackByAthleteDateSession.set(key, list);
    }

    const submittedLogRows: SubmittedTrainingLogRow[] = [];
    const missingPrescribedRows: MissingTrainingLogRow[] = [];

    for (const [key, row] of workoutByAthleteDateSession.entries()) {
      const athleteId = String(row.athlete_profile_id ?? "").trim() || null;
      const dateISO = String(row.date_iso ?? "");
      const session = normalizeSession(row.session);
      const athleteName = resolveAthleteDisplayName(
        athleteId,
        rosterNameById,
        String((row as any).athlete_name ?? "").trim()
      );

      const mileagePrescribed = athleteId
        ? resolveMileagePrescribedText(cellsByWeek, athleteId, dateISO, session, weekStartsOn)
        : "";
      const distancePlan =
        typeof row.planned_distance === "number" && Number.isFinite(row.planned_distance)
          ? `${Math.round(row.planned_distance * 100) / 100} ${String(row.planned_distance_unit ?? "mi").toLowerCase()}`
          : "";
      const prescribedText = String(mileagePrescribed || distancePlan).trim() || null;
      const workoutHasFeedback = hasWorkoutFeedback(row);
      const matchingMileageEntries = mileageFeedbackByAthleteDateSession.get(key) ?? [];
      const hasSubmittedMileageFeedback = matchingMileageEntries.some((entry) => hasMileageFeedback(entry));

      if (workoutHasFeedback) {
        submittedLogRows.push({
          key: `workout:${key}:${row.id}`,
          athleteId,
          athleteName,
          dateISO,
          session,
          sourceType: "workout",
          sourceTitle: String(row.title ?? "Workout").trim() || "Workout",
          activityKind: null,
          prescribedText,
          completedMiles: parseNumericLike(row.completed_miles) ?? null,
          completedTime: String(row.completed_time_text ?? "").trim() || null,
          splitsOrPace: String(row.splits_or_pace ?? "").trim() || null,
          additionalFeedback: String(row.additional_feedback ?? "").trim() || null,
          updatedAt: toComparableUpdatedAt(row.updated_at) || null,
          duplicateReason: null,
        });
        continue;
      }

      // A mileage-only submission for the same athlete/date/session should be the
      // submitted row; do not also show a blank workout row as missing.
      if (hasSubmittedMileageFeedback) continue;

      missingPrescribedRows.push({
        key: `missing-workout:${key}:${row.id}`,
        athleteId,
        athleteName,
        dateISO,
        session,
        sourceType: "workout",
        prescribedText,
        sourceTitle: String(row.title ?? "Workout").trim() || "Workout",
        categories: workoutCategories(row),
      });
    }

    for (const entry of mileageFeedback) {
      const dateISO = String(entry.dateISO ?? "");
      if (!dateSet.has(dateISO)) continue;
      const session = normalizeSession(entry.session);
      const athleteIdRaw = String(entry.athleteId ?? "").trim();
      const athleteNameFromEntry = String(entry.athleteName ?? "").trim();

      let athleteId: string | null = athleteIdRaw || null;
      if (!athleteId && athleteNameFromEntry) {
        const matched = roster.find(
          (athlete) =>
            String(athlete.displayName ?? "").trim().toLowerCase() === athleteNameFromEntry.toLowerCase()
        );
        athleteId = matched ? String(matched.id ?? "").trim() || null : null;
      }

      const dedupeKey = athleteId ? `${dateISO}|${athleteId}|${session}` : null;
      const matchingWorkout = dedupeKey ? workoutByAthleteDateSession.get(dedupeKey) ?? null : null;
      const mileageHasFeedback = hasMileageFeedback(entry);
      let duplicateReason: string | null = null;
      if (matchingWorkout) {
        const workoutHasFeedback = hasWorkoutFeedback(matchingWorkout);
        if (workoutHasFeedback) {
          if (!mileageHasFeedback || !mileageFeedbackDiffersFromWorkout(entry, matchingWorkout)) {
            continue;
          }
          duplicateReason = "Additional mileage feedback";
        }
      }

      const athleteName = athleteId
        ? resolveAthleteDisplayName(athleteId, rosterNameById, athleteNameFromEntry)
        : athleteNameFromEntry || "Athlete";
      const fallbackPrescribed =
        athleteId && !String(entry.prescribed ?? "").trim()
          ? resolveMileagePrescribedText(cellsByWeek, athleteId, dateISO, session, weekStartsOn)
          : "";
      const prescribedText = String(entry.prescribed ?? fallbackPrescribed).trim() || null;

      if (mileageHasFeedback) {
        submittedLogRows.push({
          key: `planned:${dateISO}:${String(entry.id ?? "") || `${athleteName}|${session}`}`,
          athleteId,
          athleteName,
          dateISO,
          session,
          sourceType: "mileage",
          sourceTitle: "Planned mileage",
          activityKind: null,
          prescribedText,
          completedMiles: parseNumericLike(entry.completedMiles) ?? null,
          completedTime: String(entry.completedTime ?? "").trim() || null,
          splitsOrPace: String(entry.splitsOrPace ?? "").trim() || null,
          additionalFeedback: String(entry.additionalFeedback ?? "").trim() || null,
          updatedAt: toComparableUpdatedAt(entry.updatedAt) || null,
          duplicateReason,
        });
      } else if (!matchingWorkout) {
        missingPrescribedRows.push({
          key: `missing-mileage-feedback:${dateISO}:${String(entry.id ?? "") || `${athleteName}|${session}`}`,
          athleteId,
          athleteName,
          dateISO,
          session,
          sourceType: "mileage",
          prescribedText,
          sourceTitle: "Planned mileage",
          categories: [],
        });
      }
    }

    for (const entry of dailyLogEntries) {
      const dateISO = String(entry.dateISO ?? "");
      if (!dateSet.has(dateISO)) continue;
      const athleteId = String(entry.athleteId ?? "").trim() || null;
      const athleteNameFromEntry = String(entry.athleteName ?? "").trim();
      const athleteName = athleteId
        ? resolveAthleteDisplayName(athleteId, rosterNameById, athleteNameFromEntry)
        : athleteNameFromEntry || "Athlete";
      const session = entry.session === "AM" || entry.session === "PM" ? entry.session : null;
      const title = String(entry.title ?? "").trim();
      const notes = String(entry.notes ?? "").trim();
      const entryType = entry.entryType === "extra_activity" ? "extra_activity" : "daily_note";
      submittedLogRows.push({
        key: `daily-log:${String(entry.id ?? "") || `${athleteName}|${dateISO}|${entry.updatedAt}`}`,
        athleteId,
        athleteName,
        dateISO,
        session,
        sourceType: entryType,
        sourceTitle: title || formatSourceLabel(entryType),
        activityKind: String(entry.activityKind ?? "").trim() || null,
        prescribedText: null,
        completedMiles: parseNumericLike(entry.completedMiles) ?? null,
        completedTime: String(entry.completedTime ?? "").trim() || null,
        splitsOrPace: null,
        additionalFeedback: notes || null,
        updatedAt: toComparableUpdatedAt(entry.updatedAt) || null,
        duplicateReason: null,
      });
    }

    return { submittedLogRows, missingPrescribedRows };
  }, [
    dailyLogEntries,
    mileageFeedback,
    roster,
    rosterNameById,
    store.mileageCellsByWeek,
    visibleDates,
    weekStartsOn,
    workoutRows,
  ]);

  const selectedAthleteFilterLabel = useMemo(() => {
    if (selectedAthleteIds.length === 0) return "Athletes: All";
    if (selectedAthleteIds.length === 1) {
      const match = activeAthleteFilterOptions.find((option) => option.id === selectedAthleteIds[0]);
      return match ? `Athlete: ${match.label}` : "Athletes: 1 selected";
    }
    return `Athletes: ${selectedAthleteIds.length} selected`;
  }, [activeAthleteFilterOptions, selectedAthleteIds]);

  const feedbackFilterLabel = useMemo(() => {
    return FEEDBACK_FILTER_OPTIONS.find((option) => option.value === feedbackFilter)?.label ?? "All";
  }, [feedbackFilter]);

  const selectedTrainingGroupLabel = useMemo(() => {
    if (selectedTrainingGroupIds.length === 0) return "Groups: All";
    if (selectedTrainingGroupIds.length === 1) {
      const match = trainingGroupFilterOptions.find((option) => option.id === selectedTrainingGroupIds[0]);
      return match ? `Group: ${match.label}` : "Groups: 1 selected";
    }
    return `Groups: ${selectedTrainingGroupIds.length} selected`;
  }, [selectedTrainingGroupIds, trainingGroupFilterOptions]);

  const selectedSeasonLabel = useMemo(() => {
    if (!selectedSeasonId) return "Season: All";
    const match = seasonFilterOptions.find((option) => option.id === selectedSeasonId);
    return match ? `Season: ${match.label}` : "Season: Selected";
  }, [seasonFilterOptions, selectedSeasonId]);

  const trainingGroupAthleteIdsByGroupId = useMemo(() => {
    const map = new Map<string, Set<string>>();
    (Array.isArray(store.trainingGroupMemberships) ? store.trainingGroupMemberships : []).forEach((row) => {
      if (!isActiveTrainingGroupMembership(row)) return;
      const groupId = String(row?.group_id ?? "").trim();
      const athleteId = String(row?.athlete_profile_id ?? "").trim();
      if (!groupId || !athleteId) return;
      const prev = map.get(groupId) ?? new Set<string>();
      prev.add(athleteId);
      map.set(groupId, prev);
    });
    return map;
  }, [store.trainingGroupMemberships]);

  const selectedTrainingGroupAthleteIds = useMemo(() => {
    const out = new Set<string>();
    selectedTrainingGroupIds.forEach((groupId) => {
      const ids = trainingGroupAthleteIdsByGroupId.get(String(groupId ?? "").trim());
      if (!ids) return;
      ids.forEach((id) => out.add(id));
    });
    return out;
  }, [selectedTrainingGroupIds, trainingGroupAthleteIdsByGroupId]);

  const athleteSeasonOverridesBySeasonAndAthlete = useMemo(() => {
    const map = new Map<string, (typeof store.athleteSeasonOverrides)[number]>();
    (Array.isArray(store.athleteSeasonOverrides) ? store.athleteSeasonOverrides : []).forEach((override) => {
      const seasonId = String(override?.season_id ?? "").trim();
      const athleteId = String(override?.athlete_profile_id ?? "").trim();
      if (!seasonId || !athleteId) return;
      map.set(`${seasonId}:${athleteId}`, override);
    });
    return map;
  }, [store.athleteSeasonOverrides]);

  const selectedSeason = useMemo(() => {
    const id = String(selectedSeasonId ?? "").trim();
    if (!id) return null;
    return (store.teamSeasons ?? []).find((season) => String(season?.id ?? "").trim() === id) ?? null;
  }, [selectedSeasonId, store.teamSeasons]);

  const rowPassesSharedFilters = useCallback(
    (row: { athleteId: string | null; dateISO: string }) => {
      const athleteId = String(row.athleteId ?? "").trim();
      const selectedAthletes = new Set(selectedAthleteIds);
      const athletePass = selectedAthleteIds.length === 0 ? true : (!!athleteId && selectedAthletes.has(athleteId));
      const groupPass =
        selectedTrainingGroupIds.length === 0 ? true : (!!athleteId && selectedTrainingGroupAthleteIds.has(athleteId));
      const rowDateISO = String(row.dateISO ?? "").trim();
      const seasonPass = (() => {
        if (!selectedSeason) return true;
        const override = athleteId
          ? athleteSeasonOverridesBySeasonAndAthlete.get(`${String(selectedSeason.id ?? "").trim()}:${athleteId}`) ?? null
          : null;
        const resolvedWindow = teamDataStore.resolveAthleteSeasonWindow(selectedSeason, override);
        return (
          rowDateISO >= String(resolvedWindow.start_date ?? "") &&
          rowDateISO <= String(resolvedWindow.end_date ?? "")
        );
      })();
      return athletePass && groupPass && seasonPass;
    },
    [
      athleteSeasonOverridesBySeasonAndAthlete,
      selectedAthleteIds,
      selectedSeason,
      selectedTrainingGroupAthleteIds,
      selectedTrainingGroupIds.length,
    ]
  );

  const filteredSubmittedLogRows = useMemo(
    () => normalizedLogRows.submittedLogRows.filter(rowPassesSharedFilters),
    [normalizedLogRows.submittedLogRows, rowPassesSharedFilters]
  );

  const filteredMissingPrescribedRows = useMemo(
    () => normalizedLogRows.missingPrescribedRows.filter(rowPassesSharedFilters),
    [normalizedLogRows.missingPrescribedRows, rowPassesSharedFilters]
  );

  const dayRows = useMemo(() => {
    const submittedRows = filteredSubmittedLogRows.filter((row) => row.dateISO === anchorDateISO);
    const missingRows = filteredMissingPrescribedRows.filter((row) => row.dateISO === anchorDateISO);
    const submittedGroups = groupSubmittedRowsByAthlete(submittedRows);
    const missingAm = sortMissingRowsByAthleteName(missingRows.filter((row) => row.session === "AM"));
    const missingPm = sortMissingRowsByAthleteName(missingRows.filter((row) => row.session === "PM"));

    return {
      submitted: {
        groups: submittedGroups,
        total: submittedRows.length,
      },
      missing: {
        am: missingAm,
        pm: missingPm,
        total: missingAm.length + missingPm.length,
      },
    };
  }, [anchorDateISO, filteredMissingPrescribedRows, filteredSubmittedLogRows]);

  const weekDaySections = useMemo<WeekDayLogSection[]>(() => {
    if (viewMode !== "week") return [];
    return visibleDates.map((dateISO) => {
      const submittedRows = filteredSubmittedLogRows.filter((row) => row.dateISO === dateISO);
      const missingRows = filteredMissingPrescribedRows.filter((row) => row.dateISO === dateISO);
      const missingAm = sortMissingRowsByAthleteName(missingRows.filter((row) => row.session === "AM"));
      const missingPm = sortMissingRowsByAthleteName(missingRows.filter((row) => row.session === "PM"));
      return {
        dateISO,
        submitted: {
          groups: groupSubmittedRowsByAthlete(submittedRows),
          total: submittedRows.length,
        },
        missing: {
          am: missingAm,
          pm: missingPm,
          total: missingAm.length + missingPm.length,
        },
      };
    });
  }, [filteredMissingPrescribedRows, filteredSubmittedLogRows, viewMode, visibleDates]);

  useEffect(() => {
    if (viewMode !== "week") return;
    const singleAthleteMode = selectedAthleteIds.length === 1;
    const nextExpanded: Record<string, boolean> = {};
    for (const section of weekDaySections) {
      if (!singleAthleteMode) {
        nextExpanded[section.dateISO] = false;
        continue;
      }
      nextExpanded[section.dateISO] =
        feedbackFilter === "missing" ? section.missing.total > 0 : section.submitted.total > 0;
    }
    setExpandedWeekDays(nextExpanded);
    setWeekMissingOpenByDate({});
  }, [feedbackFilter, selectedAthleteIds.length, viewMode, visibleRange.startISO, weekDaySections]);

  const summaryRows = useMemo(() => {
    const submitted = filteredSubmittedLogRows.map((row) => ({ dateISO: row.dateISO, session: row.session, isSubmitted: true }));
    const missing = filteredMissingPrescribedRows.map((row) => ({ dateISO: row.dateISO, session: row.session, isSubmitted: false }));
    if (feedbackFilter === "submitted") return submitted;
    if (feedbackFilter === "missing") return missing;
    return [...submitted, ...missing];
  }, [feedbackFilter, filteredMissingPrescribedRows, filteredSubmittedLogRows]);

  const hasWeekMatchesAfterFilters = useMemo(() => {
    if (viewMode !== "week") return true;
    if (feedbackFilter === "submitted") return weekDaySections.some((day) => day.submitted.total > 0);
    if (feedbackFilter === "missing") return weekDaySections.some((day) => day.missing.total > 0);
    return weekDaySections.some((day) => day.submitted.total > 0 || day.missing.total > 0);
  }, [feedbackFilter, viewMode, weekDaySections]);

  const monthDaySummaries = useMemo<MonthDaySummary[]>(() => {
    if (viewMode !== "month") return [];
    const byDate = new Map<string, typeof summaryRows>();
    for (const dateISO of visibleDates) byDate.set(dateISO, []);
    for (const row of summaryRows) {
      const bucket = byDate.get(row.dateISO);
      if (bucket) bucket.push(row);
    }

    const buildSessionSummary = (rows: typeof summaryRows, session: "AM" | "PM"): MonthSessionSummary => {
      const sessionRows = rows.filter((row) => row.session === session);
      const total = sessionRows.length;
      const submitted = sessionRows.filter((row) => row.isSubmitted).length;
      return { total, submitted, missing: total - submitted };
    };

    return visibleDates.map((dateISO) => {
      const rows = byDate.get(dateISO) ?? [];
      const total = rows.length;
      const submitted = rows.filter((row) => row.isSubmitted).length;
      const missing = total - submitted;
      const am = buildSessionSummary(rows, "AM");
      const pm = buildSessionSummary(rows, "PM");
      return { dateISO, total, submitted, missing, am, pm, isVisibleByStatusFilter: total > 0 };
    });
  }, [summaryRows, viewMode, visibleDates]);

  const visibleMonthRows = useMemo(() => {
    return monthDaySummaries.filter((day) => day.isVisibleByStatusFilter);
  }, [monthDaySummaries]);

  const hasMonthMatchesAfterFilters = useMemo(() => {
    if (viewMode !== "month") return true;
    return visibleMonthRows.length > 0;
  }, [viewMode, visibleMonthRows]);

  const monthGridCells = useMemo(() => {
    if (viewMode !== "month" || visibleDates.length === 0) return [] as Array<{ type: "blank" } | { type: "day"; day: MonthDaySummary }>;
    const start = parseISODate(visibleDates[0]);
    const firstDayIndex = start.getDay();
    const offset = (firstDayIndex - weekStartsOn + 7) % 7;
    const cells: Array<{ type: "blank" } | { type: "day"; day: MonthDaySummary }> = [];
    for (let i = 0; i < offset; i += 1) cells.push({ type: "blank" });
    for (const day of monthDaySummaries) cells.push({ type: "day", day });
    return cells;
  }, [monthDaySummaries, viewMode, visibleDates, weekStartsOn]);

  const renderMissingRows = (rows: MissingTrainingLogRow[]) => {
    if (rows.length === 0) return null;
    return rows.map((row) => (
      <View
        key={row.key}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 11,
          borderBottomWidth: 1,
          borderBottomColor: "#edf2f7",
          gap: 6,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a", flexShrink: 1 }}>{row.athleteName}</Text>
          <View
            style={{
              borderRadius: 999,
              borderWidth: 1,
              borderColor: "#fed7aa",
              backgroundColor: "#fff7ed",
              paddingHorizontal: 8,
              paddingVertical: 3,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "800", color: "#c2410c" }}>Missing</Text>
          </View>
        </View>
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 12, color: "#334155" }}>
            <Text style={{ fontWeight: "800", color: "#64748b" }}>Source: </Text>
            {row.sourceType === "workout" ? "Workout" : "Mileage"}
          </Text>
          {row.sourceTitle ? (
            <Text style={{ fontSize: 13, fontWeight: "800", color: "#1f2937" }}>{row.sourceTitle}</Text>
          ) : null}
          {row.prescribedText ? (
            <Text style={{ fontSize: 12, color: "#334155" }}>
              <Text style={{ fontWeight: "800", color: "#64748b" }}>Prescribed: </Text>
              {row.prescribedText}
            </Text>
          ) : null}
          {row.categories.length > 0 ? (
            <Text style={{ fontSize: 12, color: "#334155" }}>
              <Text style={{ fontWeight: "800", color: "#64748b" }}>Categories: </Text>
              {row.categories.join(" • ")}
            </Text>
          ) : null}
        </View>
      </View>
    ));
  };

  const renderSubmittedAthleteGroups = (
    groups: SubmittedAthleteGroup[],
    options?: { title?: string; total?: number; emptyLabel?: string; compact?: boolean }
  ) => {
    const title = options?.title ?? "Submitted Logs";
    const total = options?.total ?? dayRows.submitted.total;
    const emptyLabel = options?.emptyLabel ?? "No submitted logs for this day.";
    return (
      <View
        style={{
          marginTop: options?.compact ? 8 : 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: "#dbe2ee",
          backgroundColor: "#ffffff",
          overflow: "hidden",
        }}
      >
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: "#e8edf5",
            backgroundColor: "#f8fbff",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "900", color: "#1f2a44" }}>{title}</Text>
          <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b" }}>
            {total} {total === 1 ? "entry" : "entries"}
          </Text>
        </View>

        {groups.length === 0 ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: "#94a3b8" }}>
              {emptyLabel}
            </Text>
          </View>
        ) : (
          groups.map((group) => (
            <View
              key={`training-logs-submitted-athlete-${group.athleteKey}`}
              style={{
                borderBottomWidth: 1,
                borderBottomColor: "#edf2f7",
                paddingHorizontal: 12,
                paddingVertical: 12,
                gap: 9,
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: "900", color: "#0f172a" }}>{group.athleteName}</Text>
              {group.rows.map((row) => {
                const completedLabel = formatCompletedLabel(row);
                const sessionLabel = row.session ? `${row.session} • ${formatSourceLabel(row.sourceType)}` : formatSourceLabel(row.sourceType);
                return (
                  <Pressable
                    key={row.key}
                    onPress={() => setDetailRow(row)}
                    style={{
                      borderWidth: 1,
                      borderColor: "#e2e8f0",
                      borderRadius: 10,
                      backgroundColor: "#f8fafc",
                      paddingHorizontal: 10,
                      paddingVertical: 9,
                      gap: 5,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <Text style={{ fontSize: 12, fontWeight: "900", color: "#475569" }}>{sessionLabel}</Text>
                      {row.duplicateReason ? (
                        <Text style={{ fontSize: 11, fontWeight: "800", color: "#92400e", flexShrink: 1 }}>
                          {row.duplicateReason}
                        </Text>
                      ) : null}
                    </View>
                    {row.sourceTitle ? (
                      <Text style={{ fontSize: 13, fontWeight: "800", color: "#1f2937" }}>{row.sourceTitle}</Text>
                    ) : null}
                    {row.prescribedText ? (
                      <Text style={{ fontSize: 12, color: "#334155" }}>
                        <Text style={{ fontWeight: "800", color: "#64748b" }}>Planned: </Text>
                        {row.prescribedText}
                      </Text>
                    ) : null}
                    {row.activityKind ? (
                      <Text style={{ fontSize: 12, color: "#334155" }}>
                        <Text style={{ fontWeight: "800", color: "#64748b" }}>Activity: </Text>
                        {formatActivityKindLabel(row.activityKind) || row.activityKind}
                      </Text>
                    ) : null}
                    {completedLabel !== "—" ? (
                      <Text style={{ fontSize: 12, color: "#334155" }}>
                        <Text style={{ fontWeight: "800", color: "#64748b" }}>Completed: </Text>
                        {completedLabel}
                      </Text>
                    ) : null}
                    {row.splitsOrPace ? (
                      <Text style={{ fontSize: 12, color: "#334155", lineHeight: 18 }}>
                        <Text style={{ fontWeight: "800", color: "#64748b" }}>Splits/Pace: </Text>
                        {row.splitsOrPace}
                      </Text>
                    ) : null}
                    {row.additionalFeedback ? (
                      <Text style={{ fontSize: 12, color: "#334155", lineHeight: 18 }}>
                        <Text style={{ fontWeight: "800", color: "#64748b" }}>Notes: </Text>
                        {row.additionalFeedback}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))
        )}
      </View>
    );
  };

  const renderMissingSection = (title: string, rows: MissingTrainingLogRow[]) => {
    return (
      <View
        style={{
          marginTop: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: "#fed7aa",
          backgroundColor: "#ffffff",
          overflow: "hidden",
        }}
      >
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: "#fed7aa",
            backgroundColor: "#fff7ed",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "900", color: "#7c2d12" }}>{title}</Text>
          <Text style={{ fontSize: 11, fontWeight: "800", color: "#9a3412" }}>
            {rows.length} {rows.length === 1 ? "row" : "rows"}
          </Text>
        </View>

        {rows.length === 0 ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: "#94a3b8" }}>No missing prescribed feedback</Text>
          </View>
        ) : (
          renderMissingRows(rows)
        )}
      </View>
    );
  };

  const navigateByMode = useCallback(
    (direction: -1 | 1) => {
      if (viewMode === "month") {
        setAnchorDateISO((prev) => addMonthsISO(prev, direction));
        return;
      }
      const deltaDays = viewMode === "week" ? 7 * direction : direction;
      setAnchorDateISO((prev) => addDaysISO(prev, deltaDays));
    },
    [viewMode]
  );

  const openDayFromWeek = useCallback((dateISO: string) => {
    setAnchorDateISO(dateISO);
    setViewMode("day");
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#f3f6fb" }}>
      <View
        style={{
          borderWidth: 1,
          borderColor: "#dbe2ee",
          borderRadius: 12,
          backgroundColor: "#ffffff",
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {(["day", "week", "month"] as const).map((mode) => (
              <Pressable
                key={`training-logs-view-${mode}`}
                onPress={() => setViewMode(mode)}
                style={{
                  borderWidth: 1,
                  borderColor: viewMode === mode ? "#0f172a" : "#cfd7e6",
                  backgroundColor: viewMode === mode ? "#0f172a" : "#fff",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: viewMode === mode ? "#fff" : "#24334f" }}>
                  {mode === "day" ? "Day" : mode === "week" ? "Week" : "Month"}
                </Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            onPress={() => navigateByMode(-1)}
            style={{
              borderWidth: 1,
              borderColor: "#cfd7e6",
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 6,
              backgroundColor: "#fff",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "800", color: "#24334f" }}>
              {viewMode === "month" ? "Prev Month" : viewMode === "week" ? "Prev Week" : "Prev Day"}
            </Text>
          </Pressable>

          <Text style={{ fontSize: 14, fontWeight: "900", color: "#1f2a44", textAlign: "center", flex: 1 }}>
            {rangeLabel}
          </Text>

          <Pressable
            onPress={() => navigateByMode(1)}
            style={{
              borderWidth: 1,
              borderColor: "#cfd7e6",
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 6,
              backgroundColor: "#fff",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "800", color: "#24334f" }}>
              {viewMode === "month" ? "Next Month" : viewMode === "week" ? "Next Week" : "Next Day"}
            </Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
          <View style={{ minWidth: 220 }}>
            <Pressable
              onPress={() => {
                setAthleteFilterOpen(true);
                setTrainingGroupFilterOpen(false);
                setSeasonFilterOpen(false);
                setFeedbackFilterOpen(false);
              }}
              style={{
                height: 34,
                borderWidth: 1,
                borderColor: "#cfd7e6",
                borderRadius: 8,
                paddingHorizontal: 10,
                backgroundColor: "#fff",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: "#1f2937" }}>
                {selectedAthleteFilterLabel}
              </Text>
              <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>
                ▾
              </Text>
            </Pressable>
          </View>

          <View style={{ minWidth: 220 }}>
            <Pressable
              onPress={() => {
                setTrainingGroupFilterOpen(true);
                setAthleteFilterOpen(false);
                setSeasonFilterOpen(false);
                setFeedbackFilterOpen(false);
              }}
              style={{
                height: 34,
                borderWidth: 1,
                borderColor: "#cfd7e6",
                borderRadius: 8,
                paddingHorizontal: 10,
                backgroundColor: "#fff",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: "#1f2937" }}>
                {selectedTrainingGroupLabel}
              </Text>
              <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>
                ▾
              </Text>
            </Pressable>
          </View>

          <View style={{ minWidth: 220 }}>
            <Pressable
              onPress={() => {
                setSeasonFilterOpen(true);
                setAthleteFilterOpen(false);
                setTrainingGroupFilterOpen(false);
                setFeedbackFilterOpen(false);
              }}
              style={{
                height: 34,
                borderWidth: 1,
                borderColor: "#cfd7e6",
                borderRadius: 8,
                paddingHorizontal: 10,
                backgroundColor: "#fff",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: "#1f2937" }}>
                {selectedSeasonLabel}
              </Text>
              <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>
                ▾
              </Text>
            </Pressable>
            <Text style={{ fontSize: 10, fontWeight: "700", color: "#64748b", marginTop: 4, marginLeft: 4 }}>
              Uses athlete-specific dates where set.
            </Text>
          </View>

          <View style={{ width: 190 }}>
            <Pressable
              onPress={() => {
                setFeedbackFilterOpen(true);
                setAthleteFilterOpen(false);
                setTrainingGroupFilterOpen(false);
                setSeasonFilterOpen(false);
              }}
              style={{
                height: 34,
                borderWidth: 1,
                borderColor: "#cfd7e6",
                borderRadius: 8,
                paddingHorizontal: 10,
                backgroundColor: "#fff",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "700", color: "#1f2937" }}>
                Status: {feedbackFilterLabel}
              </Text>
              <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>
                ▾
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1, marginTop: 10 }}
        contentContainerStyle={{ paddingBottom: 18 }}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: "#dbe2ee",
              borderRadius: 12,
              backgroundColor: "#fff",
              paddingHorizontal: 12,
              paddingVertical: 12,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "700", color: "#64748b" }}>
              Loading training logs...
            </Text>
          </View>
        ) : viewMode === "day" ? (
          <>
            {feedbackFilter !== "missing" ? (
              <>
                {renderSubmittedAthleteGroups(dayRows.submitted.groups)}
                {dayRows.missing.total > 0 ? (
                  <Pressable
                    onPress={() => setShowDayMissingFeedback((prev) => !prev)}
                    style={{
                      marginTop: 12,
                      borderWidth: 1,
                      borderColor: showDayMissingFeedback ? "#fed7aa" : "#dbe2ee",
                      borderRadius: 10,
                      backgroundColor: showDayMissingFeedback ? "#fff7ed" : "#fff",
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <Text
                      style={{
                        flex: 1,
                        fontSize: 13,
                        fontWeight: "900",
                        color: showDayMissingFeedback ? "#7c2d12" : "#334155",
                      }}
                    >
                      {showDayMissingFeedback ? "Hide" : "Show"} Missing Prescribed Feedback ({dayRows.missing.total})
                    </Text>
                    <Text style={{ fontSize: 12, fontWeight: "900", color: showDayMissingFeedback ? "#9a3412" : "#64748b" }}>
                      {showDayMissingFeedback ? "▴" : "▾"}
                    </Text>
                  </Pressable>
                ) : (
                  <View
                    style={{
                      marginTop: 12,
                      borderWidth: 1,
                      borderColor: "#e2e8f0",
                      borderRadius: 10,
                      backgroundColor: "#f8fafc",
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#64748b" }}>
                      No missing prescribed feedback for this day.
                    </Text>
                  </View>
                )}
              </>
            ) : null}
            {feedbackFilter === "missing" || showDayMissingFeedback ? (
              <>
                {feedbackFilter !== "missing" ? (
                  <Text style={{ marginTop: 16, fontSize: 15, fontWeight: "900", color: "#7c2d12" }}>
                    Missing Prescribed Feedback
                  </Text>
                ) : null}
                {renderMissingSection("AM Missing Prescribed Feedback", dayRows.missing.am)}
                {renderMissingSection("PM Missing Prescribed Feedback", dayRows.missing.pm)}
              </>
            ) : null}
          </>
        ) : viewMode === "week" ? (
          <>
            {!hasWeekMatchesAfterFilters ? (
              <View
                style={{
                  marginTop: 12,
                  borderWidth: 1,
                  borderColor: "#dbe2ee",
                  borderRadius: 12,
                  backgroundColor: "#fff",
                  paddingHorizontal: 12,
                  paddingVertical: 14,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "800", color: "#64748b" }}>
                  {feedbackFilter === "missing"
                    ? "No missing prescribed feedback this week."
                    : "No submitted logs for this week."}
                </Text>
              </View>
            ) : null}

            {weekDaySections.map((day) => {
              const expanded = !!expandedWeekDays[day.dateISO];
              const missingOpen = feedbackFilter === "missing" || !!weekMissingOpenByDate[day.dateISO];
              const shouldShowSubmitted = feedbackFilter !== "missing";
              const shouldShowMissingToggle = feedbackFilter !== "missing" && day.missing.total > 0;
              return (
                <View
                  key={`training-logs-week-day-${day.dateISO}`}
                  style={{
                    marginTop: 12,
                    borderWidth: 1,
                    borderColor: expanded ? "#bfdbfe" : "#dbe2ee",
                    borderRadius: 12,
                    backgroundColor: "#ffffff",
                    overflow: "hidden",
                  }}
                >
                  <Pressable
                    onPress={() =>
                      setExpandedWeekDays((prev) => ({
                        ...prev,
                        [day.dateISO]: !prev[day.dateISO],
                      }))
                    }
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 11,
                      borderBottomWidth: 1,
                      borderBottomColor: "#e8edf5",
                      backgroundColor: expanded ? "#eff6ff" : "#fff",
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: "900", color: "#1f2a44" }}>
                        {formatDisplayDate(day.dateISO)}
                      </Text>
                      <Text style={{ marginTop: 2, fontSize: 11, fontWeight: "800", color: "#64748b" }}>
                        {day.submitted.total} {day.submitted.total === 1 ? "submission" : "submissions"}
                        {day.missing.total > 0
                          ? ` • ${day.missing.total} missing`
                          : " • 0 missing"}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Pressable
                        onPress={(event) => {
                          event.stopPropagation();
                          openDayFromWeek(day.dateISO);
                        }}
                        style={{
                          borderWidth: 1,
                          borderColor: "#cfd7e6",
                          borderRadius: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          backgroundColor: "#fff",
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "800", color: "#24334f" }}>Open day</Text>
                      </Pressable>
                      <Text style={{ fontSize: 14, fontWeight: "900", color: "#64748b" }}>
                        {expanded ? "▴" : "▾"}
                      </Text>
                    </View>
                  </Pressable>

                  {expanded ? (
                    <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
                      {shouldShowSubmitted ? (
                        renderSubmittedAthleteGroups(day.submitted.groups, {
                          title: "Submitted Logs",
                          total: day.submitted.total,
                          emptyLabel: "No submitted logs for this day.",
                          compact: true,
                        })
                      ) : null}

                      {shouldShowMissingToggle ? (
                        <Pressable
                          onPress={() =>
                            setWeekMissingOpenByDate((prev) => ({
                              ...prev,
                              [day.dateISO]: !prev[day.dateISO],
                            }))
                          }
                          style={{
                            marginTop: 10,
                            borderWidth: 1,
                            borderColor: missingOpen ? "#fed7aa" : "#dbe2ee",
                            borderRadius: 10,
                            backgroundColor: missingOpen ? "#fff7ed" : "#fff",
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                          }}
                        >
                          <Text
                            style={{
                              flex: 1,
                              fontSize: 12,
                              fontWeight: "900",
                              color: missingOpen ? "#7c2d12" : "#334155",
                            }}
                          >
                            {missingOpen ? "Hide" : "Show"} Missing Prescribed Feedback ({day.missing.total})
                          </Text>
                          <Text style={{ fontSize: 12, fontWeight: "900", color: missingOpen ? "#9a3412" : "#64748b" }}>
                            {missingOpen ? "▴" : "▾"}
                          </Text>
                        </Pressable>
                      ) : null}

                      {missingOpen ? (
                        <>
                          {feedbackFilter !== "missing" ? (
                            <Text style={{ marginTop: 14, fontSize: 14, fontWeight: "900", color: "#7c2d12" }}>
                              Missing Prescribed Feedback
                            </Text>
                          ) : null}
                          {renderMissingSection("AM Missing Prescribed Feedback", day.missing.am)}
                          {renderMissingSection("PM Missing Prescribed Feedback", day.missing.pm)}
                        </>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </>
        ) : (
          <View
            style={{
              marginTop: 12,
              borderWidth: 1,
              borderColor: "#dbe2ee",
              borderRadius: 12,
              backgroundColor: "#fff",
              padding: 10,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                marginBottom: 8,
              }}
            >
              {Array.from({ length: 7 }).map((_, index) => {
                const day = new Date(2026, 0, 4 + ((weekStartsOn + index) % 7));
                const label = day.toLocaleDateString(undefined, { weekday: "short" });
                return (
                  <View
                    key={`training-logs-month-weekday-${index}`}
                    style={{ width: "14.2857%", paddingHorizontal: 3, alignItems: "center" }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b" }}>{label}</Text>
                  </View>
                );
              })}
            </View>

            {!hasMonthMatchesAfterFilters ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  borderRadius: 10,
                  backgroundColor: "#f8fafc",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  marginBottom: 10,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "700", color: "#64748b" }}>
                  No month logs match the current filters.
                </Text>
              </View>
            ) : null}

            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {monthGridCells.map((cell, index) => {
                if (cell.type === "blank") {
                  return <View key={`training-logs-month-blank-${index}`} style={{ width: "14.2857%", padding: 3 }} />;
                }

                const day = cell.day;
                const date = parseISODate(day.dateISO);
                const dayOfMonth = date.getDate();
                const hasVisibleData = day.isVisibleByStatusFilter;
                const missingHeavy = day.total > 0 && day.missing >= Math.ceil(day.total / 2);
                const complete = day.total > 0 && day.missing === 0;
                const accent = !hasVisibleData
                  ? "#cbd5e1"
                  : complete
                    ? "#22c55e"
                    : missingHeavy
                      ? "#f59e0b"
                      : "#60a5fa";
                const cardBg = !hasVisibleData ? "#f8fafc" : "#ffffff";

                const card = (
                  <View
                    style={{
                      borderWidth: 1,
                      borderColor: hasVisibleData ? accent : "#e2e8f0",
                      borderRadius: 10,
                      backgroundColor: cardBg,
                      minHeight: 108,
                      paddingHorizontal: 8,
                      paddingVertical: 7,
                      gap: 3,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "900", color: "#1f2937" }}>{dayOfMonth}</Text>
                    {hasVisibleData ? (
                      <>
                        <Text style={{ fontSize: 11, fontWeight: "800", color: "#334155" }}>
                          {day.submitted}/{day.total} submitted
                        </Text>
                        <Text style={{ fontSize: 10, fontWeight: "700", color: "#64748b" }}>
                          AM {day.am.submitted}/{day.am.total} · PM {day.pm.submitted}/{day.pm.total}
                        </Text>
                        <Text
                          style={{
                            fontSize: 10,
                            fontWeight: "800",
                            color: day.missing > 0 ? "#b45309" : "#166534",
                          }}
                        >
                          {day.missing > 0 ? `${day.missing} missing` : "No missing"}
                        </Text>
                        <Text style={{ fontSize: 10, fontWeight: "800", color: "#1d4ed8" }}>Open day</Text>
                      </>
                    ) : (
                      <Text style={{ fontSize: 10, fontWeight: "700", color: "#94a3b8", marginTop: 6 }}>
                        No visible logs
                      </Text>
                    )}
                  </View>
                );

                return (
                  <View key={`training-logs-month-day-${day.dateISO}`} style={{ width: "14.2857%", padding: 3 }}>
                    {hasVisibleData ? (
                      <Pressable onPress={() => openDayFromWeek(day.dateISO)}>{card}</Pressable>
                    ) : (
                      card
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>

      <Modal
        visible={athleteFilterOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAthleteFilterOpen(false)}
      >
        <Pressable
          onPress={() => setAthleteFilterOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(2,6,23,0.28)",
            alignItems: "center",
            justifyContent: Platform.OS === "web" ? "flex-start" : "center",
            paddingTop: Platform.OS === "web" ? 84 : 24,
            paddingHorizontal: 16,
          }}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              maxHeight: Platform.OS === "web" ? 520 : 460,
              borderWidth: 1,
              borderColor: "#dbe2ee",
              borderRadius: 12,
              backgroundColor: "#fff",
              overflow: "hidden",
              shadowColor: "#000",
              shadowOpacity: 0.22,
              shadowRadius: 14,
              shadowOffset: { width: 0, height: 6 },
              elevation: 16,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: "#dbe2ee",
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>Athletes</Text>
              <Pressable
                onPress={() => setAthleteFilterOpen(false)}
                style={{
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#475569" }}>Done</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: Platform.OS === "web" ? 440 : 360 }} keyboardShouldPersistTaps="handled">
              <Pressable
                onPress={() => {
                  setSelectedAthleteIds([]);
                  setAthleteFilterOpen(false);
                }}
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: "#edf2f7",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  backgroundColor: selectedAthleteIds.length === 0 ? "#eff6ff" : "#fff",
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>All athletes (clear)</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setSelectedAthleteIds(activeAthleteFilterOptions.map((option) => option.id));
                }}
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: "#edf2f7",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  backgroundColor: "#fff",
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>Select all</Text>
              </Pressable>
              {activeAthleteFilterOptions.map((option) => {
                const selected = selectedAthleteIds.includes(option.id);
                return (
                  <Pressable
                    key={`training-logs-athlete-filter-modal-${option.id}`}
                    onPress={() => {
                      setSelectedAthleteIds((prev) =>
                        prev.includes(option.id)
                          ? prev.filter((id) => id !== option.id)
                          : [...prev, option.id]
                      );
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      backgroundColor: selected ? "#eff6ff" : "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>
                      {selected ? "☑ " : "☐ "}
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
              {activeAthleteFilterOptions.length === 0 ? (
                <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                  <Text style={{ fontSize: 12, color: "#64748b" }}>No athletes found</Text>
                </View>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={trainingGroupFilterOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTrainingGroupFilterOpen(false)}
      >
        <Pressable
          onPress={() => setTrainingGroupFilterOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(2,6,23,0.28)",
            alignItems: "center",
            justifyContent: Platform.OS === "web" ? "flex-start" : "center",
            paddingTop: Platform.OS === "web" ? 84 : 24,
            paddingHorizontal: 16,
          }}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              maxHeight: Platform.OS === "web" ? 520 : 460,
              borderWidth: 1,
              borderColor: "#dbe2ee",
              borderRadius: 12,
              backgroundColor: "#fff",
              overflow: "hidden",
              shadowColor: "#000",
              shadowOpacity: 0.22,
              shadowRadius: 14,
              shadowOffset: { width: 0, height: 6 },
              elevation: 16,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: "#dbe2ee",
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>Training Groups</Text>
              <Pressable
                onPress={() => setTrainingGroupFilterOpen(false)}
                style={{
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#475569" }}>Done</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: Platform.OS === "web" ? 440 : 360 }} keyboardShouldPersistTaps="handled">
              <Pressable
                onPress={() => {
                  void teamDataStore.actions.setSharedSelectedTrainingGroupIds([]);
                  setTrainingGroupFilterOpen(false);
                }}
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: "#edf2f7",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  backgroundColor: selectedTrainingGroupIds.length === 0 ? "#eff6ff" : "#fff",
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>All groups (clear)</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  void teamDataStore.actions.setSharedSelectedTrainingGroupIds(
                    trainingGroupFilterOptions.map((option) => option.id)
                  );
                }}
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: "#edf2f7",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  backgroundColor: "#fff",
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>Select all</Text>
              </Pressable>
              {trainingGroupFilterOptions.map((option) => {
                const selected = selectedTrainingGroupIds.includes(option.id);
                return (
                  <Pressable
                    key={`training-logs-group-filter-modal-${option.id}`}
                    onPress={() => {
                      void teamDataStore.actions.setSharedSelectedTrainingGroupIds(
                        selected
                          ? selectedTrainingGroupIds.filter((id) => id !== option.id)
                          : [...selectedTrainingGroupIds, option.id]
                      );
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      backgroundColor: selected ? "#eff6ff" : "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>
                      {selected ? "☑ " : "☐ "}
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
              {trainingGroupFilterOptions.length === 0 ? (
                <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                  <Text style={{ fontSize: 12, color: "#64748b" }}>No training groups found</Text>
                </View>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={seasonFilterOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSeasonFilterOpen(false)}
      >
        <Pressable
          onPress={() => setSeasonFilterOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(2,6,23,0.28)",
            alignItems: "center",
            justifyContent: Platform.OS === "web" ? "flex-start" : "center",
            paddingTop: Platform.OS === "web" ? 84 : 24,
            paddingHorizontal: 16,
          }}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              maxHeight: Platform.OS === "web" ? 520 : 460,
              borderWidth: 1,
              borderColor: "#dbe2ee",
              borderRadius: 12,
              backgroundColor: "#fff",
              overflow: "hidden",
              shadowColor: "#000",
              shadowOpacity: 0.22,
              shadowRadius: 14,
              shadowOffset: { width: 0, height: 6 },
              elevation: 16,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: "#dbe2ee",
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>Season</Text>
              <Pressable
                onPress={() => setSeasonFilterOpen(false)}
                style={{
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#475569" }}>Done</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: Platform.OS === "web" ? 440 : 360 }} keyboardShouldPersistTaps="handled">
              <Pressable
                onPress={() => {
                  void teamDataStore.actions.setSharedSelectedSeasonId(null);
                  setSeasonFilterOpen(false);
                }}
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: "#edf2f7",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  backgroundColor: !selectedSeasonId ? "#eff6ff" : "#fff",
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>All seasons (clear)</Text>
              </Pressable>
              {seasonFilterOptions.map((option) => {
                const selected = selectedSeasonId === option.id;
                return (
                  <Pressable
                    key={`training-logs-season-filter-modal-${option.id}`}
                    onPress={() => {
                      void teamDataStore.actions.setSharedSelectedSeasonId(option.id);
                      setSeasonFilterOpen(false);
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      backgroundColor: selected ? "#eff6ff" : "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>
                      {selected ? "☑ " : "☐ "}
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
              {seasonFilterOptions.length === 0 ? (
                <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                  <Text style={{ fontSize: 12, color: "#64748b" }}>No seasons found</Text>
                </View>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={feedbackFilterOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setFeedbackFilterOpen(false)}
      >
        <Pressable
          onPress={() => setFeedbackFilterOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(2,6,23,0.28)",
            alignItems: "center",
            justifyContent: Platform.OS === "web" ? "flex-start" : "center",
            paddingTop: Platform.OS === "web" ? 84 : 24,
            paddingHorizontal: 16,
          }}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 420,
              maxHeight: Platform.OS === "web" ? 420 : 360,
              borderWidth: 1,
              borderColor: "#dbe2ee",
              borderRadius: 12,
              backgroundColor: "#fff",
              overflow: "hidden",
              shadowColor: "#000",
              shadowOpacity: 0.22,
              shadowRadius: 14,
              shadowOffset: { width: 0, height: 6 },
              elevation: 16,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: "#dbe2ee",
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>Status</Text>
              <Pressable
                onPress={() => setFeedbackFilterOpen(false)}
                style={{
                  borderWidth: 1,
                  borderColor: "#e2e8f0",
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#475569" }}>Done</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: Platform.OS === "web" ? 340 : 280 }} keyboardShouldPersistTaps="handled">
              {FEEDBACK_FILTER_OPTIONS.map((option) => (
                <Pressable
                  key={`training-logs-status-filter-modal-${option.value}`}
                  onPress={() => {
                    setFeedbackFilter(option.value);
                    setFeedbackFilterOpen(false);
                  }}
                  style={{
                    borderBottomWidth: 1,
                    borderBottomColor: "#edf2f7",
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    backgroundColor: feedbackFilter === option.value ? "#eff6ff" : "#fff",
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "700", color: "#334155" }}>
                    {feedbackFilter === option.value ? "☑ " : "☐ "}
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {detailRow ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setDetailRow(null)}>
          <Pressable
            onPress={() => setDetailRow(null)}
            style={{
              flex: 1,
              backgroundColor: "rgba(2, 6, 23, 0.35)",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 540,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: "#dbe2ee",
                backgroundColor: "#fff",
                paddingHorizontal: 14,
                paddingVertical: 12,
                gap: 8,
              }}
            >
              <Text style={{ fontSize: 16, fontWeight: "900", color: "#0f172a" }}>Athlete Feedback</Text>
              <Text style={{ fontSize: 13, fontWeight: "800", color: "#1e293b" }}>{detailRow.athleteName}</Text>
              <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>
                {detailRow.session ?? "All day"} • {formatSourceLabel(detailRow.sourceType)}
              </Text>
              {detailRow.duplicateReason ? (
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#92400e" }}>
                  {detailRow.duplicateReason}
                </Text>
              ) : null}

              {detailRow.sourceType === "workout" ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>Workout</Text>
                  <Text style={{ fontSize: 13, color: "#1f2937" }}>{detailRow.sourceTitle}</Text>
                </View>
              ) : null}

              {detailRow.sourceType === "daily_note" || detailRow.sourceType === "extra_activity" ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>Title</Text>
                  <Text style={{ fontSize: 13, color: "#1f2937" }}>{detailRow.sourceTitle || "—"}</Text>
                </View>
              ) : null}

              {detailRow.activityKind ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>Activity kind</Text>
                  <Text style={{ fontSize: 13, color: "#1f2937" }}>
                    {formatActivityKindLabel(detailRow.activityKind) || detailRow.activityKind}
                  </Text>
                </View>
              ) : null}

              {detailRow.prescribedText ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>Planned</Text>
                  <Text style={{ fontSize: 13, color: "#1f2937" }}>{detailRow.prescribedText}</Text>
                </View>
              ) : null}

              {typeof detailRow.completedMiles === "number" ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>Completed distance</Text>
                  <Text style={{ fontSize: 13, color: "#1f2937" }}>
                    {Math.round(detailRow.completedMiles * 100) / 100} mi
                  </Text>
                </View>
              ) : null}

              {detailRow.completedTime ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>Completed time</Text>
                  <Text style={{ fontSize: 13, color: "#1f2937" }}>{detailRow.completedTime}</Text>
                </View>
              ) : null}

              {detailRow.splitsOrPace ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>Splits / pace</Text>
                  <Text style={{ fontSize: 13, color: "#1f2937", lineHeight: 18 }}>{detailRow.splitsOrPace}</Text>
                </View>
              ) : null}

              {detailRow.additionalFeedback ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "900", color: "#64748b" }}>Notes</Text>
                  <Text style={{ fontSize: 13, color: "#1f2937", lineHeight: 18 }}>
                    {detailRow.additionalFeedback}
                  </Text>
                </View>
              ) : null}

              {formatUpdatedAtLabel(detailRow.updatedAt) ? (
                <Text style={{ marginTop: 2, fontSize: 11, fontWeight: "700", color: "#64748b" }}>
                  Updated: {formatUpdatedAtLabel(detailRow.updatedAt)}
                </Text>
              ) : null}

              <Pressable
                onPress={() => setDetailRow(null)}
                style={{
                  marginTop: 4,
                  borderWidth: 1,
                  borderColor: "#cbd5e1",
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#334155" }}>Close</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}
