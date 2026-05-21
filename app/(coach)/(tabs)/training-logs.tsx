import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  hasMileageFeedback,
  hasWorkoutFeedback,
  parseNumericLike,
} from "../../../lib/feedbackParsing";
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

type FeedbackFilter = "all" | "with_feedback" | "no_feedback";
type ViewMode = "day" | "week" | "month";
type SourceType = "workout" | "planned_session";

type TrainingLogRow = {
  key: string;
  athleteId: string | null;
  athleteName: string;
  dateISO: string;
  session: "AM" | "PM";
  sourceType: SourceType;
  sourceTitle: string;
  prescribedText: string | null;
  completedMiles: number | null;
  completedTime: string | null;
  splitsOrPace: string | null;
  additionalFeedback: string | null;
  updatedAt: number | null;
  hasFeedback: boolean;
};

type SessionSummary = {
  session: "AM" | "PM";
  total: number;
  submitted: number;
  missing: number;
};

type DaySummary = {
  dateISO: string;
  totalRows: number;
  visibleSessions: SessionSummary[];
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
  { value: "all", label: "All" },
  { value: "with_feedback", label: "With feedback" },
  { value: "no_feedback", label: "No feedback" },
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

function formatStatusLabel(row: TrainingLogRow): string {
  return row.hasFeedback ? "Feedback submitted" : "No feedback";
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

function sortRowsByAthleteName(rows: TrainingLogRow[]): TrainingLogRow[] {
  return [...rows].sort((a, b) => compareAthleteDisplayNamesByLastName(a.athleteName, b.athleteName));
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
  const [selectedAthleteIds, setSelectedAthleteIds] = useState<string[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState<FeedbackFilter>("all");
  const [athleteFilterOpen, setAthleteFilterOpen] = useState(false);
  const selectedTrainingGroupIds = store.sharedSelectedTrainingGroupIds;
  const [trainingGroupFilterOpen, setTrainingGroupFilterOpen] = useState(false);
  const selectedSeasonId = store.sharedSelectedSeasonId;
  const [seasonFilterOpen, setSeasonFilterOpen] = useState(false);
  const [feedbackFilterOpen, setFeedbackFilterOpen] = useState(false);
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

      const [rosterRows, rangeRows, mileageEntries] = await Promise.all([
        loadTeamRoster(),
        listTeamWorkoutsInRange(startISO, endISO),
        loadMileageFeedback(),
      ]);
      await Promise.all(weekStarts.map((weekStartISO) => teamDataStore.actions.loadMileageWeek(weekStartISO)));

      setRoster(Array.isArray(rosterRows) ? rosterRows : []);
      setWorkoutRows(Array.isArray(rangeRows) ? rangeRows : []);
      setMileageFeedback(Array.isArray(mileageEntries) ? mileageEntries : []);
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

        const savedFeedbackFilter = String(savedFeedbackFilterRaw?.[1] ?? "").trim();
        const nextFeedbackFilter: FeedbackFilter =
          savedFeedbackFilter === "with_feedback" ||
          savedFeedbackFilter === "no_feedback" ||
          savedFeedbackFilter === "all"
            ? savedFeedbackFilter
            : "all";

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

  const normalizedRows = useMemo<TrainingLogRow[]>(() => {
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

    const rows: TrainingLogRow[] = [];

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

      rows.push({
        key: `workout:${key}:${row.id}`,
        athleteId,
        athleteName,
        dateISO,
        session,
        sourceType: "workout",
        sourceTitle: String(row.title ?? "Workout").trim() || "Workout",
        prescribedText,
        completedMiles: parseNumericLike(row.completed_miles) ?? null,
        completedTime: String(row.completed_time_text ?? "").trim() || null,
        splitsOrPace: String(row.splits_or_pace ?? "").trim() || null,
        additionalFeedback: String(row.additional_feedback ?? "").trim() || null,
        updatedAt: toComparableUpdatedAt(row.updated_at) || null,
        hasFeedback: hasWorkoutFeedback(row),
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
      if (dedupeKey && workoutByAthleteDateSession.has(dedupeKey)) continue;

      const athleteName = athleteId
        ? resolveAthleteDisplayName(athleteId, rosterNameById, athleteNameFromEntry)
        : athleteNameFromEntry || "Athlete";
      const fallbackPrescribed =
        athleteId && !String(entry.prescribed ?? "").trim()
          ? resolveMileagePrescribedText(cellsByWeek, athleteId, dateISO, session, weekStartsOn)
          : "";

      rows.push({
        key: `planned:${dateISO}:${String(entry.id ?? "") || `${athleteName}|${session}`}`,
        athleteId,
        athleteName,
        dateISO,
        session,
        sourceType: "planned_session",
        sourceTitle: "Planned mileage",
        prescribedText: String(entry.prescribed ?? fallbackPrescribed).trim() || null,
        completedMiles: parseNumericLike(entry.completedMiles) ?? null,
        completedTime: String(entry.completedTime ?? "").trim() || null,
        splitsOrPace: String(entry.splitsOrPace ?? "").trim() || null,
        additionalFeedback: String(entry.additionalFeedback ?? "").trim() || null,
        updatedAt: toComparableUpdatedAt(entry.updatedAt) || null,
        hasFeedback: hasMileageFeedback(entry),
      });
    }

    return rows;
  }, [mileageFeedback, roster, rosterNameById, store.mileageCellsByWeek, visibleDates, weekStartsOn, workoutRows]);

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

  const athleteGroupSeasonFilteredRows = useMemo(() => {
    let rows = normalizedRows;
    const selectedAthletes = new Set(selectedAthleteIds);
    rows = rows.filter((row) => {
      const athleteId = String(row.athleteId ?? "").trim();
      const athletePass =
        selectedAthleteIds.length === 0 ? true : (!!athleteId && selectedAthletes.has(athleteId));
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
    });
    return rows;
  }, [
    athleteSeasonOverridesBySeasonAndAthlete,
    normalizedRows,
    selectedAthleteIds,
    selectedSeason,
    selectedTrainingGroupAthleteIds,
    selectedTrainingGroupIds.length,
  ]);

  const statusFilteredRows = useMemo(() => {
    let rows = athleteGroupSeasonFilteredRows;
    if (feedbackFilter === "with_feedback") rows = rows.filter((row) => row.hasFeedback);
    if (feedbackFilter === "no_feedback") rows = rows.filter((row) => !row.hasFeedback);
    return rows;
  }, [athleteGroupSeasonFilteredRows, feedbackFilter]);

  const dayRows = useMemo(() => {
    const rows = statusFilteredRows.filter((row) => row.dateISO === anchorDateISO);
    return {
      am: sortRowsByAthleteName(rows.filter((row) => row.session === "AM")),
      pm: sortRowsByAthleteName(rows.filter((row) => row.session === "PM")),
    };
  }, [anchorDateISO, statusFilteredRows]);

  const weekDaySummaries = useMemo<DaySummary[]>(() => {
    const byDateSession = new Map<string, { am: TrainingLogRow[]; pm: TrainingLogRow[] }>();
    for (const dateISO of visibleDates) {
      byDateSession.set(dateISO, { am: [], pm: [] });
    }
    for (const row of athleteGroupSeasonFilteredRows) {
      const day = byDateSession.get(row.dateISO);
      if (!day) continue;
      if (row.session === "AM") day.am.push(row);
      else day.pm.push(row);
    }

    const allowSession = (summary: SessionSummary): boolean => {
      if (feedbackFilter === "with_feedback") return summary.submitted > 0;
      if (feedbackFilter === "no_feedback") return summary.missing > 0;
      return summary.total > 0;
    };

    return visibleDates.map((dateISO) => {
      const buckets = byDateSession.get(dateISO) ?? { am: [], pm: [] };
      const buildSummary = (session: "AM" | "PM", rows: TrainingLogRow[]): SessionSummary => {
        const total = rows.length;
        const submitted = rows.filter((row) => row.hasFeedback).length;
        const missing = total - submitted;
        return { session, total, submitted, missing };
      };
      const summaries = [buildSummary("AM", buckets.am), buildSummary("PM", buckets.pm)];
      const visibleSessions = summaries.filter(allowSession);
      return {
        dateISO,
        totalRows: summaries.reduce((sum, s) => sum + s.total, 0),
        visibleSessions,
      };
    });
  }, [athleteGroupSeasonFilteredRows, feedbackFilter, visibleDates]);

  const hasWeekMatchesAfterFilters = useMemo(() => {
    if (viewMode !== "week") return true;
    return weekDaySummaries.some((day) => day.visibleSessions.length > 0);
  }, [viewMode, weekDaySummaries]);

  const monthDaySummaries = useMemo<MonthDaySummary[]>(() => {
    if (viewMode !== "month") return [];
    const byDate = new Map<string, TrainingLogRow[]>();
    for (const dateISO of visibleDates) byDate.set(dateISO, []);
    for (const row of athleteGroupSeasonFilteredRows) {
      const bucket = byDate.get(row.dateISO);
      if (bucket) bucket.push(row);
    }

    const buildSessionSummary = (rows: TrainingLogRow[], session: "AM" | "PM"): MonthSessionSummary => {
      const sessionRows = rows.filter((row) => row.session === session);
      const total = sessionRows.length;
      const submitted = sessionRows.filter((row) => row.hasFeedback).length;
      return { total, submitted, missing: total - submitted };
    };

    return visibleDates.map((dateISO) => {
      const rows = byDate.get(dateISO) ?? [];
      const total = rows.length;
      const submitted = rows.filter((row) => row.hasFeedback).length;
      const missing = total - submitted;
      const am = buildSessionSummary(rows, "AM");
      const pm = buildSessionSummary(rows, "PM");
      const isVisibleByStatusFilter =
        feedbackFilter === "with_feedback"
          ? submitted > 0
          : feedbackFilter === "no_feedback"
            ? missing > 0
            : total > 0;
      return { dateISO, total, submitted, missing, am, pm, isVisibleByStatusFilter };
    });
  }, [athleteGroupSeasonFilteredRows, feedbackFilter, viewMode, visibleDates]);

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

  const renderRows = (rows: TrainingLogRow[]) => {
    if (rows.length === 0) return null;
    return rows.map((row) => {
      const content = (
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: "#edf2f7",
            gap: 6,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "900", color: "#0f172a", flexShrink: 1 }}>
              {row.athleteName}
            </Text>
            <View
              style={{
                borderRadius: 999,
                borderWidth: 1,
                borderColor: row.hasFeedback ? "#bbf7d0" : "#e2e8f0",
                backgroundColor: row.hasFeedback ? "#ecfdf3" : "#f8fafc",
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "800",
                  color: row.hasFeedback ? "#166534" : "#64748b",
                }}
              >
                {formatStatusLabel(row)}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 }}>
            <Text style={{ fontSize: 12, color: "#334155" }}>
              <Text style={{ fontWeight: "800", color: "#64748b" }}>Source: </Text>
              {row.sourceTitle}
            </Text>
            <Text style={{ fontSize: 12, color: "#334155" }}>
              <Text style={{ fontWeight: "800", color: "#64748b" }}>Planned: </Text>
              {row.prescribedText || "—"}
            </Text>
            <Text style={{ fontSize: 12, color: "#334155" }}>
              <Text style={{ fontWeight: "800", color: "#64748b" }}>Completed: </Text>
              {formatCompletedLabel(row)}
            </Text>
          </View>
        </View>
      );

      if (!row.hasFeedback) return <View key={row.key}>{content}</View>;
      return (
        <Pressable key={row.key} onPress={() => setDetailRow(row)}>
          {content}
        </Pressable>
      );
    });
  };

  const renderSessionSection = (session: "AM" | "PM", rows: TrainingLogRow[]) => {
    return (
      <View
        style={{
          marginTop: 12,
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
          <Text style={{ fontSize: 14, fontWeight: "900", color: "#1f2a44" }}>{session}</Text>
          <Text style={{ fontSize: 11, fontWeight: "800", color: "#64748b" }}>
            {rows.length} {rows.length === 1 ? "log" : "logs"}
          </Text>
        </View>

        {rows.length === 0 ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: "#94a3b8" }}>No {session} logs</Text>
          </View>
        ) : (
          renderRows(rows)
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

        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, zIndex: 30, flexWrap: "wrap" }}>
          <View style={{ minWidth: 220, position: "relative", zIndex: 40 }}>
            <Pressable
              onPress={() => {
                setAthleteFilterOpen((prev) => !prev);
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
                {athleteFilterOpen ? "▴" : "▾"}
              </Text>
            </Pressable>

            {athleteFilterOpen ? (
              <View
                style={{
                  position: "absolute",
                  top: 40,
                  left: 0,
                  right: 0,
                  borderWidth: 1,
                  borderColor: "#dbe2ee",
                  borderRadius: 8,
                  backgroundColor: "#fff",
                  zIndex: 50,
                  ...(Platform.OS === "android" ? { elevation: 8 } : null),
                }}
              >
                <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 240 }}>
                  <Pressable
                    onPress={() => {
                      setSelectedAthleteIds([]);
                      setAthleteFilterOpen(false);
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: selectedAthleteIds.length === 0 ? "#eff6ff" : "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>
                      All athletes (clear)
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => {
                      setSelectedAthleteIds(activeAthleteFilterOptions.map((option) => option.id));
                      setAthleteFilterOpen(false);
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>Select all</Text>
                  </Pressable>

                  {activeAthleteFilterOptions.map((option) => {
                    const selected = selectedAthleteIds.includes(option.id);
                    return (
                      <Pressable
                        key={`training-logs-athlete-${option.id}`}
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
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          backgroundColor: selected ? "#eff6ff" : "#fff",
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>
                          {selected ? "☑ " : "☐ "}
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
          </View>

          <View style={{ minWidth: 220, position: "relative", zIndex: 38 }}>
            <Pressable
              onPress={() => {
                setTrainingGroupFilterOpen((prev) => !prev);
                setAthleteFilterOpen(false);
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
                {trainingGroupFilterOpen ? "▴" : "▾"}
              </Text>
            </Pressable>

            {trainingGroupFilterOpen ? (
              <View
                style={{
                  position: "absolute",
                  top: 40,
                  left: 0,
                  right: 0,
                  borderWidth: 1,
                  borderColor: "#dbe2ee",
                  borderRadius: 8,
                  backgroundColor: "#fff",
                  zIndex: 48,
                  ...(Platform.OS === "android" ? { elevation: 8 } : null),
                }}
              >
                <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 240 }}>
                  <Pressable
                    onPress={() => {
                      void teamDataStore.actions.setSharedSelectedTrainingGroupIds([]);
                      setTrainingGroupFilterOpen(false);
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: selectedTrainingGroupIds.length === 0 ? "#eff6ff" : "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>
                      All groups (clear)
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => {
                      void teamDataStore.actions.setSharedSelectedTrainingGroupIds(
                        trainingGroupFilterOptions.map((option) => option.id)
                      );
                      setTrainingGroupFilterOpen(false);
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>Select all</Text>
                  </Pressable>

                  {trainingGroupFilterOptions.map((option) => {
                    const selected = selectedTrainingGroupIds.includes(option.id);
                    return (
                      <Pressable
                        key={`training-logs-group-${option.id}`}
                        onPress={() => {
                          void teamDataStore.actions.setSharedSelectedTrainingGroupIds(
                            selectedTrainingGroupIds.includes(option.id)
                              ? selectedTrainingGroupIds.filter((id) => id !== option.id)
                              : [...selectedTrainingGroupIds, option.id]
                          );
                        }}
                        style={{
                          borderBottomWidth: 1,
                          borderBottomColor: "#edf2f7",
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          backgroundColor: selected ? "#eff6ff" : "#fff",
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>
                          {selected ? "☑ " : "☐ "}
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
          </View>

          <View style={{ minWidth: 220, position: "relative", zIndex: 36 }}>
            <Pressable
              onPress={() => {
                setSeasonFilterOpen((prev) => !prev);
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
                {seasonFilterOpen ? "▴" : "▾"}
              </Text>
            </Pressable>

            {seasonFilterOpen ? (
              <View
                style={{
                  position: "absolute",
                  top: 40,
                  left: 0,
                  right: 0,
                  borderWidth: 1,
                  borderColor: "#dbe2ee",
                  borderRadius: 8,
                  backgroundColor: "#fff",
                  zIndex: 46,
                  ...(Platform.OS === "android" ? { elevation: 8 } : null),
                }}
              >
                <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 240 }}>
                  <Pressable
                    onPress={() => {
                      void teamDataStore.actions.setSharedSelectedSeasonId(null);
                      setSeasonFilterOpen(false);
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: !selectedSeasonId ? "#eff6ff" : "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>
                      All seasons (clear)
                    </Text>
                  </Pressable>

                  {seasonFilterOptions.map((option) => {
                    const selected = selectedSeasonId === option.id;
                    return (
                      <Pressable
                        key={`training-logs-season-${option.id}`}
                        onPress={() => {
                          void teamDataStore.actions.setSharedSelectedSeasonId(option.id);
                          setSeasonFilterOpen(false);
                        }}
                        style={{
                          borderBottomWidth: 1,
                          borderBottomColor: "#edf2f7",
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          backgroundColor: selected ? "#eff6ff" : "#fff",
                        }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>
                          {selected ? "◉ " : "○ "}
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
            <Text style={{ fontSize: 10, fontWeight: "700", color: "#64748b", marginTop: 4, marginLeft: 4 }}>
              Uses athlete-specific dates where set.
            </Text>
          </View>

          <View style={{ width: 190, position: "relative", zIndex: 35 }}>
            <Pressable
              onPress={() => {
                setFeedbackFilterOpen((prev) => !prev);
                setAthleteFilterOpen(false);
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
                {feedbackFilterOpen ? "▴" : "▾"}
              </Text>
            </Pressable>

            {feedbackFilterOpen ? (
              <View
                style={{
                  position: "absolute",
                  top: 40,
                  left: 0,
                  right: 0,
                  borderWidth: 1,
                  borderColor: "#dbe2ee",
                  borderRadius: 8,
                  backgroundColor: "#fff",
                  zIndex: 45,
                  ...(Platform.OS === "android" ? { elevation: 8 } : null),
                }}
              >
                {FEEDBACK_FILTER_OPTIONS.map((option) => (
                  <Pressable
                    key={`training-logs-filter-${option.value}`}
                    onPress={() => {
                      setFeedbackFilter(option.value);
                      setFeedbackFilterOpen(false);
                    }}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: "#edf2f7",
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      backgroundColor: feedbackFilter === option.value ? "#eff6ff" : "#fff",
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#334155" }}>
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
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
            {renderSessionSection("AM", dayRows.am)}
            {renderSessionSection("PM", dayRows.pm)}
          </>
        ) : viewMode === "week" ? (
          !hasWeekMatchesAfterFilters ? (
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
                No week logs match the current filters.
              </Text>
            </View>
          ) : (
            weekDaySummaries.map((day) => {
              const totalVisible = day.visibleSessions.reduce((sum, s) => sum + s.total, 0);
              return (
                <View
                  key={`training-logs-day-${day.dateISO}`}
                  style={{
                    marginTop: 12,
                    borderWidth: 1,
                    borderColor: "#dbe2ee",
                    borderRadius: 12,
                    backgroundColor: "#ffffff",
                    padding: 10,
                  }}
                >
                  <View
                    style={{
                      paddingHorizontal: 4,
                      paddingBottom: 8,
                      borderBottomWidth: 1,
                      borderBottomColor: "#e8edf5",
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
                        {totalVisible} visible • {day.totalRows} total
                      </Text>
                    </View>

                    <Pressable
                      onPress={() => openDayFromWeek(day.dateISO)}
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
                  </View>

                  {day.visibleSessions.length === 0 ? (
                    <View style={{ paddingTop: 10, paddingHorizontal: 4 }}>
                      <Text style={{ fontSize: 12, fontWeight: "700", color: "#94a3b8" }}>
                        {day.totalRows === 0 ? "No logs for this day." : "No sessions match this status filter."}
                      </Text>
                    </View>
                  ) : (
                    <View style={{ paddingTop: 8, gap: 8 }}>
                      {day.visibleSessions.map((session) => (
                        <View
                          key={`training-logs-summary-${day.dateISO}-${session.session}`}
                          style={{
                            borderWidth: 1,
                            borderColor: "#e2e8f0",
                            borderRadius: 10,
                            backgroundColor: "#f8fbff",
                            paddingHorizontal: 10,
                            paddingVertical: 8,
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 12, fontWeight: "900", color: "#1f2a44" }}>
                              {session.session} · {session.submitted}/{session.total} submitted
                            </Text>
                            <Text style={{ marginTop: 2, fontSize: 11, fontWeight: "700", color: "#64748b" }}>
                              {session.missing} missing
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              );
            })
          )
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
                {detailRow.session} • {detailRow.sourceTitle}
              </Text>

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
