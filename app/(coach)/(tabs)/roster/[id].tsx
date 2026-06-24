import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { AppText } from "../../../../components/ui/AppText";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { Divider } from "../../../../components/ui/Divider";
import { Screen } from "../../../../components/ui/Screen";
import { TextField } from "../../../../components/ui/TextField";
import { useAppTheme } from "../../../../components/ui/useAppTheme";
import { useResponsive } from "../../../../lib/useResponsive";
import {
  isAthleteExcludedFromSeason,
  teamDataStore,
  type TeamAthleteRosterStatus,
} from "../../../../lib/teamDataStore";
import {
  getAthleteSeasonTenureStatus,
  resolveAthleteSeasonWindowWithTenure,
} from "../../../../lib/teamRoster";
import {
  createClaimInvite,
  getCurrentTeamId,
  linkTeamAthleteToExistingUserEmail,
  sendAthleteInviteEmail,
  unlinkTeamAthleteLogin,
  type AthleteLoginLinkResult,
} from "../../../../lib/team";
import { listTeamWorkoutsInRange, type TeamWorkoutRow } from "../../../../lib/teamWorkoutsCloud";
import { loadMileageFeedback, type MileageSessionFeedback } from "../../../../lib/mileageFeedback";
import { hasMileageFeedback, hasWorkoutFeedback, parseNumericLike } from "../../../../lib/feedbackParsing";
import { loadWeekStartSetting } from "../../../../lib/settings";
import { getWeekIndex, getWeekStartISO, parseISODate, toISODate } from "../../../../lib/mileagePlan";
import { DEFAULT_PACE_SEC, loadPaceSecondsPerMile } from "../../../../lib/pace";
import { formatParsedWorkoutEntry, parseWorkoutEntryValue, workoutEntryMilesRange, workoutEntryXTRange } from "../../../../lib/workoutEntryParser";
import type { WeekStartDay } from "../../../../lib/types";
import { canEditRoster, getCurrentTeamRole, type TeamRole } from "../../../../lib/teamPermissions";
import { getAthleteDisplayName, getAthleteFirstName, getAthleteLastName } from "../../../../lib/athleteName";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function buildInviteUrl(token: string) {
  const cleanToken = String(token ?? "").trim();
  const origin =
    Platform.OS === "web" && typeof window !== "undefined"
      ? window.location.origin
      : "https://www.tracksidecoach.com";
  return `${origin}/join?token=${encodeURIComponent(cleanToken)}`;
}

function isValidDateOnlyISO(value: string): boolean {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const atMidnight = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(atMidnight.getTime())) return false;
  return atMidnight.toISOString().slice(0, 10) === text;
}

function addDaysISO(dateISO: string, days: number) {
  const dt = parseISODate(dateISO);
  dt.setDate(dt.getDate() + days);
  return toISODate(dt);
}

function normalizeSession(value: string | undefined): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
}

function formatMilesRange(minMiles: number, maxMiles: number): string {
  const min = Math.round(minMiles * 10) / 10;
  const max = Math.round(maxMiles * 10) / 10;
  if (min === 0 && max === 0) return "—";
  if (min === max) return `${min} mi`;
  return `${min}-${max} mi`;
}

function formatMilesValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} mi`;
}

function formatXTRangeMinutes(minSec: number, maxSec: number): string {
  const min = Math.round(minSec / 60);
  const max = Math.round(maxSec / 60);
  if (min === 0 && max === 0) return "—";
  if (min === max) return `${min} min XT`;
  return `${min}-${max} min XT`;
}

function formatWeekLabel(weekStartISO: string): string {
  const weekEndISO = addDaysISO(weekStartISO, 6);
  const start = parseISODate(weekStartISO);
  const end = parseISODate(weekEndISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${weekStartISO} - ${weekEndISO}`;
  const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${startLabel} - ${endLabel}`;
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

function toXTSecRangeWithLegacyFallback(value: unknown): { min: number; max: number } {
  const parsed = parseWorkoutEntryValue(value);
  if (parsed) return workoutEntryXTRange(parsed);

  const raw = (value && typeof value === "object" ? value : null) as
    | {
        kind?: string;
        seconds?: unknown;
        minSeconds?: unknown;
        maxSeconds?: unknown;
        value?: unknown;
        min?: unknown;
        max?: unknown;
        xt?: unknown;
        options?: unknown;
      }
    | null;
  if (!raw) return { min: 0, max: 0 };

  const toNumber = (input: unknown): number | null => {
    if (typeof input !== "number" || !Number.isFinite(input)) return null;
    return input;
  };
  const clamp = (n: number) => Math.max(0, n);
  const normalize = (a: number, b: number) => (a <= b ? { min: a, max: b } : { min: b, max: a });

  if (raw.kind === "choice") {
    const opts = Array.isArray(raw.options) ? raw.options : [];
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    let found = false;
    opts.forEach((option) => {
      const r = toXTSecRangeWithLegacyFallback(option);
      min = Math.min(min, r.min);
      max = Math.max(max, r.max);
      if (r.min !== 0 || r.max !== 0) found = true;
    });
    if (!found) return { min: 0, max: 0 };
    return { min, max };
  }

  if (raw.kind === "time" && raw.xt) {
    const sec = toNumber(raw.seconds);
    if (sec == null) return { min: 0, max: 0 };
    const c = clamp(sec);
    return { min: c, max: c };
  }

  if (raw.kind === "timeRange" && raw.xt) {
    const a = toNumber(raw.minSeconds);
    const b = toNumber(raw.maxSeconds);
    if (a == null || b == null) return { min: 0, max: 0 };
    const n = normalize(clamp(a), clamp(b));
    return { min: n.min, max: n.max };
  }

  if (raw.kind === "minutes" && raw.xt) {
    const minutes = toNumber(raw.value);
    if (minutes == null) return { min: 0, max: 0 };
    const sec = Math.round(clamp(minutes) * 60);
    return { min: sec, max: sec };
  }

  if (raw.kind === "minutesRange" && raw.xt) {
    const a = toNumber(raw.min);
    const b = toNumber(raw.max);
    if (a == null || b == null) return { min: 0, max: 0 };
    const n = normalize(clamp(a), clamp(b));
    return { min: Math.round(n.min * 60), max: Math.round(n.max * 60) };
  }

  return { min: 0, max: 0 };
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
  return toComparableUpdatedAt(nextRow.updated_at) >= toComparableUpdatedAt(currentRow.updated_at);
}

type AthleteSeasonSessionRow = {
  key: string;
  dateISO: string;
  session: "AM" | "PM";
  sourceType: "workout" | "planned_session";
  sourceTitle: string;
  prescribedText: string | null;
  completedMiles: number | null;
  hasFeedback: boolean;
};

export default function CoachEditTeamAthlete() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const athleteId = useMemo(() => (Array.isArray(id) ? id[0] : id) ?? "", [id]);

  const { theme } = useAppTheme();
  const { isDesktop } = useResponsive();
  const s = teamDataStore.use();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [teamStartDate, setTeamStartDate] = useState("");
  const [teamEndDate, setTeamEndDate] = useState("");
  const [claimed, setClaimed] = useState(false);
  const [loginAccessMessage, setLoginAccessMessage] = useState<string | null>(null);
  const [loginAccessTone, setLoginAccessTone] = useState<"success" | "mutedText" | "danger">("mutedText");
  const [latestInviteUrl, setLatestInviteUrl] = useState("");
  const [rosterStatus, setRosterStatus] = useState<TeamAthleteRosterStatus>("active");
  const [teamTenureError, setTeamTenureError] = useState<string | null>(null);
  const [seasonDraftById, setSeasonDraftById] = useState<Record<string, { start: string; end: string }>>({});
  const [seasonSavingById, setSeasonSavingById] = useState<Record<string, boolean>>({});
  const [seasonTrainingSelectedSeasonId, setSeasonTrainingSelectedSeasonId] = useState<string | null>(null);
  const [seasonTrainingLoading, setSeasonTrainingLoading] = useState(false);
  const [seasonTrainingError, setSeasonTrainingError] = useState<string | null>(null);
  const [seasonTrainingWeekStartsOn, setSeasonTrainingWeekStartsOn] = useState<WeekStartDay>(1);
  const [seasonTrainingPaceSecPerMile, setSeasonTrainingPaceSecPerMile] = useState<number>(DEFAULT_PACE_SEC);
  const [seasonTrainingWorkoutRows, setSeasonTrainingWorkoutRows] = useState<TeamWorkoutRow[]>([]);
  const [seasonTrainingMileageFeedback, setSeasonTrainingMileageFeedback] = useState<MileageSessionFeedback[]>([]);
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);
  const readOnlyRoster = !canEditRoster(currentTeamRole);

  // ---- IMPORTANT: prevent navigation loops on web (idempotent nav) ----
  const didNavigateRef = useRef(false);

  const safeGoBack = useCallback(() => {
    if (didNavigateRef.current) return;
    didNavigateRef.current = true;

    try {
      const canGoBack = (router as any)?.canGoBack?.() ?? false;
      if (canGoBack) {
        router.back();
        return;
      }
    } catch {}

    router.replace("/(coach)/(tabs)/roster");
  }, [router]);

  useEffect(() => {
    let active = true;
    getCurrentTeamId()
      .then((teamId) => getCurrentTeamRole(teamId))
      .then((role) => {
        if (active) setCurrentTeamRole(role);
      })
      .catch((error) => {
        console.warn("[coach-roster-detail] role load failed", error);
        if (active) setCurrentTeamRole(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!athleteId) {
        safeGoBack();
        return;
      }

      if (!isUuid(athleteId)) {
        Alert.alert("Invalid athlete id", athleteId);
        safeGoBack();
        return;
      }

      setLoading(true);
      try {
        // Ensure roster is loaded at least once
        if (!teamDataStore.getState?.().rosterLoaded) {
          await teamDataStore.actions.refreshRoster({ throwOnError: true });
        }
        await Promise.all([
          teamDataStore.actions.loadTeamSeasons(),
          teamDataStore.actions.loadAthleteSeasonOverrides(),
        ]);

        if (cancelled) return;

        // Read fresh state AFTER refresh
        const a = teamDataStore.getAthleteById(athleteId);
        if (!a) {
          Alert.alert("Not found", "This athlete profile was not found on the team roster.");
          safeGoBack();
          return;
        }

        setFirstName(getAthleteFirstName(a));
        setLastName(getAthleteLastName(a));
        setEmail(String(a.email ?? ""));
        setTeamStartDate(String(a.team_start_date ?? ""));
        setTeamEndDate(String(a.team_end_date ?? ""));
        setClaimed(!!a.claimed_user_id);
        setLoginAccessMessage(!!a.claimed_user_id ? "Linked" : null);
        setLoginAccessTone(!!a.claimed_user_id ? "success" : "mutedText");
        setRosterStatus(
          String(a.roster_status ?? "").trim().toLowerCase() === "inactive"
            ? "inactive"
            : String(a.roster_status ?? "").trim().toLowerCase() === "graduated"
              ? "graduated"
              : String(a.roster_status ?? "").trim().toLowerCase() === "transferred"
                ? "transferred"
                : String(a.roster_status ?? "").trim().toLowerCase() === "archived"
                  ? "archived"
                  : "active"
        );
      } catch (e: any) {
        if (!cancelled) {
          Alert.alert("Load failed", e?.message ?? "Could not load athlete.");
          safeGoBack();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [athleteId, safeGoBack]);

  const activeSeasons = useMemo(() => {
    return (Array.isArray(s.teamSeasons) ? s.teamSeasons : []).filter((season) => !season.archived_at);
  }, [s.teamSeasons]);

  useEffect(() => {
    if (seasonTrainingSelectedSeasonId) return;
    const first = activeSeasons[0]?.id ? String(activeSeasons[0].id) : null;
    if (first) setSeasonTrainingSelectedSeasonId(first);
  }, [activeSeasons, seasonTrainingSelectedSeasonId]);

  const overridesBySeasonId = useMemo(() => {
    const map = new Map<string, (typeof s.athleteSeasonOverrides)[number]>();
    (Array.isArray(s.athleteSeasonOverrides) ? s.athleteSeasonOverrides : []).forEach((row) => {
      const seasonId = String(row?.season_id ?? "").trim();
      const athlete = String(row?.athlete_profile_id ?? "").trim();
      if (!seasonId || athlete !== athleteId) return;
      map.set(seasonId, row);
    });
    return map;
  }, [athleteId, s.athleteSeasonOverrides]);

  const selectedTrainingSeason = useMemo(() => {
    const id = String(seasonTrainingSelectedSeasonId ?? "").trim();
    if (!id) return null;
    return activeSeasons.find((season) => String(season.id ?? "").trim() === id) ?? null;
  }, [activeSeasons, seasonTrainingSelectedSeasonId]);

  const selectedTrainingSeasonOverride = useMemo(() => {
    const seasonId = String(selectedTrainingSeason?.id ?? "").trim();
    if (!seasonId) return null;
    return overridesBySeasonId.get(seasonId) ?? null;
  }, [overridesBySeasonId, selectedTrainingSeason]);

  const participatingSeasons = useMemo(() => {
    return activeSeasons.filter(
      (season) =>
        !isAthleteExcludedFromSeason(
          athleteId,
          String(season?.id ?? "").trim(),
          s.athleteSeasonOverrides
        )
    );
  }, [activeSeasons, athleteId, s.athleteSeasonOverrides]);

  const excludedSeasons = useMemo(() => {
    return activeSeasons.filter((season) =>
      isAthleteExcludedFromSeason(
        athleteId,
        String(season?.id ?? "").trim(),
        s.athleteSeasonOverrides
      )
    );
  }, [activeSeasons, athleteId, s.athleteSeasonOverrides]);

  const selectedTrainingResolvedWindow = useMemo(() => {
    if (!selectedTrainingSeason) return null;
    return teamDataStore.resolveAthleteSeasonWindow(selectedTrainingSeason, selectedTrainingSeasonOverride);
  }, [selectedTrainingSeason, selectedTrainingSeasonOverride]);

  const selectedTrainingWindowStatus = useMemo(() => {
    if (!selectedTrainingSeason) return "Inherited";
    const hasOverride = !!selectedTrainingSeasonOverride && (!!selectedTrainingSeasonOverride.start_date || !!selectedTrainingSeasonOverride.end_date);
    return hasOverride ? "Override" : "Inherited";
  }, [selectedTrainingSeason, selectedTrainingSeasonOverride]);

  const seasonTrainingWeekStarts = useMemo(() => {
    if (!selectedTrainingResolvedWindow) return [] as string[];
    const startISO = String(selectedTrainingResolvedWindow.start_date ?? "").trim();
    const endISO = String(selectedTrainingResolvedWindow.end_date ?? "").trim();
    if (!startISO || !endISO || endISO < startISO) return [] as string[];
    const firstWeekStart = getWeekStartISO(startISO, seasonTrainingWeekStartsOn);
    const lastWeekStart = getWeekStartISO(endISO, seasonTrainingWeekStartsOn);
    const out: string[] = [];
    let cursor = firstWeekStart;
    while (cursor <= lastWeekStart) {
      out.push(cursor);
      cursor = addDaysISO(cursor, 7);
    }
    return out;
  }, [seasonTrainingWeekStartsOn, selectedTrainingResolvedWindow]);

  const seasonTrainingRequestSeqRef = useRef(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const weekStartResult = await loadWeekStartSetting();
        if (!active) return;
        setSeasonTrainingWeekStartsOn(weekStartResult.normalized === "sunday" ? 0 : 1);
      } catch {}
      try {
        const pace = await loadPaceSecondsPerMile();
        if (!active) return;
        setSeasonTrainingPaceSecPerMile(pace ?? DEFAULT_PACE_SEC);
      } catch {}
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!athleteId || !selectedTrainingResolvedWindow) {
      setSeasonTrainingWorkoutRows([]);
      setSeasonTrainingMileageFeedback([]);
      setSeasonTrainingError(null);
      setSeasonTrainingLoading(false);
      return;
    }
    const startISO = String(selectedTrainingResolvedWindow.start_date ?? "").trim();
    const endISO = String(selectedTrainingResolvedWindow.end_date ?? "").trim();
    if (!startISO || !endISO || endISO < startISO) {
      setSeasonTrainingWorkoutRows([]);
      setSeasonTrainingMileageFeedback([]);
      setSeasonTrainingError("Invalid season date window.");
      setSeasonTrainingLoading(false);
      return;
    }

    const requestSeq = seasonTrainingRequestSeqRef.current + 1;
    seasonTrainingRequestSeqRef.current = requestSeq;
    setSeasonTrainingLoading(true);
    setSeasonTrainingError(null);

    let cancelled = false;
    (async () => {
      try {
        const [workoutsInRange, allMileageFeedback] = await Promise.all([
          listTeamWorkoutsInRange(startISO, endISO),
          loadMileageFeedback(),
        ]);

        await Promise.all(
          seasonTrainingWeekStarts.map((weekStartISO) =>
            teamDataStore.actions.loadMileageWeek(weekStartISO).catch(() => {})
          )
        );

        if (cancelled || seasonTrainingRequestSeqRef.current !== requestSeq) return;

        const athleteNameLower = getAthleteDisplayName({ firstName, lastName }).toLowerCase();
        const filteredFeedback = (Array.isArray(allMileageFeedback) ? allMileageFeedback : []).filter((entry) => {
          const dateISO = String(entry?.dateISO ?? "").trim();
          if (!dateISO || dateISO < startISO || dateISO > endISO) return false;
          const feedbackAthleteId = String(entry?.athleteId ?? "").trim();
          if (feedbackAthleteId) return feedbackAthleteId === athleteId;
          const feedbackAthleteName = String(entry?.athleteName ?? "").trim().toLowerCase();
          return !!feedbackAthleteName && !!athleteNameLower && feedbackAthleteName === athleteNameLower;
        });

        const filteredWorkouts = (Array.isArray(workoutsInRange) ? workoutsInRange : []).filter(
          (row) => String(row?.athlete_profile_id ?? "").trim() === athleteId
        );

        setSeasonTrainingWorkoutRows(filteredWorkouts);
        setSeasonTrainingMileageFeedback(filteredFeedback);
        setSeasonTrainingError(null);
      } catch (e: any) {
        if (cancelled || seasonTrainingRequestSeqRef.current !== requestSeq) return;
        setSeasonTrainingError(String(e?.message ?? "Could not load season training data."));
        setSeasonTrainingWorkoutRows([]);
        setSeasonTrainingMileageFeedback([]);
      } finally {
        if (cancelled || seasonTrainingRequestSeqRef.current !== requestSeq) return;
        setSeasonTrainingLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [athleteId, firstName, lastName, seasonTrainingWeekStarts, selectedTrainingResolvedWindow]);

  const seasonTrainingSessionRows = useMemo(() => {
    if (!selectedTrainingResolvedWindow) return [] as AthleteSeasonSessionRow[];
    const startISO = String(selectedTrainingResolvedWindow.start_date ?? "").trim();
    const endISO = String(selectedTrainingResolvedWindow.end_date ?? "").trim();
    if (!startISO || !endISO || endISO < startISO) return [] as AthleteSeasonSessionRow[];

    const workoutByDateSession = new Map<string, TeamWorkoutRow>();
    seasonTrainingWorkoutRows.forEach((row) => {
      const dateISO = String(row?.date_iso ?? "").trim();
      if (!dateISO || dateISO < startISO || dateISO > endISO) return;
      const session = normalizeSession(row?.session);
      const key = `${dateISO}|${session}`;
      const existing = workoutByDateSession.get(key);
      if (!existing || shouldPreferWorkout(row, existing)) {
        workoutByDateSession.set(key, row);
      }
    });

    const rows: AthleteSeasonSessionRow[] = [];
    for (const [key, row] of workoutByDateSession.entries()) {
      const dateISO = String(row.date_iso ?? "").trim();
      const session = normalizeSession(row.session);
      const mileagePrescribed = resolveMileagePrescribedText(
        s.mileageCellsByWeek,
        athleteId,
        dateISO,
        session,
        seasonTrainingWeekStartsOn
      );
      const distancePlan =
        typeof row.planned_distance === "number" && Number.isFinite(row.planned_distance)
          ? `${Math.round(row.planned_distance * 100) / 100} ${String(row.planned_distance_unit ?? "mi").toLowerCase()}`
          : "";
      rows.push({
        key: `workout:${key}:${row.id}`,
        dateISO,
        session,
        sourceType: "workout",
        sourceTitle: String(row.title ?? "Workout").trim() || "Workout",
        prescribedText: String(mileagePrescribed || distancePlan).trim() || null,
        completedMiles: parseNumericLike(row.completed_miles) ?? null,
        hasFeedback: hasWorkoutFeedback(row),
      });
    }

    seasonTrainingMileageFeedback.forEach((entry) => {
      const dateISO = String(entry?.dateISO ?? "").trim();
      if (!dateISO || dateISO < startISO || dateISO > endISO) return;
      const session = normalizeSession(entry?.session);
      const dedupeKey = `${dateISO}|${session}`;
      if (workoutByDateSession.has(dedupeKey)) return;
      rows.push({
        key: `planned:${dateISO}:${String(entry?.id ?? dedupeKey)}`,
        dateISO,
        session,
        sourceType: "planned_session",
        sourceTitle: "Planned mileage",
        prescribedText:
          String(entry?.prescribed ?? "").trim() ||
          resolveMileagePrescribedText(
            s.mileageCellsByWeek,
            athleteId,
            dateISO,
            session,
            seasonTrainingWeekStartsOn
          ) ||
          null,
        completedMiles: parseNumericLike(entry?.completedMiles) ?? null,
        hasFeedback: hasMileageFeedback(entry),
      });
    });

    return rows.sort((a, b) => {
      const byDate = String(a.dateISO).localeCompare(String(b.dateISO));
      if (byDate !== 0) return byDate;
      if (a.session !== b.session) return a.session === "AM" ? -1 : 1;
      return String(a.sourceTitle).localeCompare(String(b.sourceTitle));
    });
  }, [
    athleteId,
    s.mileageCellsByWeek,
    seasonTrainingMileageFeedback,
    selectedTrainingResolvedWindow,
    seasonTrainingWeekStartsOn,
    seasonTrainingWorkoutRows,
  ]);

  const seasonTrainingWeekSummaries = useMemo(() => {
    if (!selectedTrainingResolvedWindow) return [] as Array<{
      weekStartISO: string;
      weekEndISO: string;
      plannedMilesMin: number;
      plannedMilesMax: number;
      plannedXTSecMin: number;
      plannedXTSecMax: number;
      completedMiles: number;
      workoutCount: number;
      feedbackSubmitted: number;
      feedbackMissing: number;
    }>;
    const startISO = String(selectedTrainingResolvedWindow.start_date ?? "").trim();
    const endISO = String(selectedTrainingResolvedWindow.end_date ?? "").trim();

    return seasonTrainingWeekStarts.map((weekStartISO) => {
      const weekEndISO = addDaysISO(weekStartISO, 6);
      let plannedMilesMin = 0;
      let plannedMilesMax = 0;
      let plannedXTSecMin = 0;
      let plannedXTSecMax = 0;
      const weekCells = s.mileageCellsByWeek[weekStartISO] ?? [];
      weekCells.forEach((cell) => {
        if (String(cell?.athlete_profile_id ?? "").trim() !== athleteId) return;
        const dayIdx = Number(cell?.day_idx);
        if (!Number.isFinite(dayIdx) || dayIdx < 0 || dayIdx > 6) return;
        const dateISO = addDaysISO(weekStartISO, dayIdx);
        if (dateISO < startISO || dateISO > endISO) return;
        const parsed = parseWorkoutEntryValue(cell?.value);
        if (!parsed) return;
        const miles = workoutEntryMilesRange(parsed, seasonTrainingPaceSecPerMile);
        plannedMilesMin += miles.min;
        plannedMilesMax += miles.max;
        const xt = toXTSecRangeWithLegacyFallback(cell?.value);
        plannedXTSecMin += xt.min;
        plannedXTSecMax += xt.max;
      });

      const weekSessions = seasonTrainingSessionRows.filter((row) => {
        const dateISO = String(row.dateISO ?? "");
        return dateISO >= weekStartISO && dateISO <= weekEndISO && dateISO >= startISO && dateISO <= endISO;
      });

      const completedMiles = weekSessions.reduce((sum, row) => {
        const value = parseNumericLike(row.completedMiles);
        return sum + (value ?? 0);
      }, 0);
      const workoutCount = seasonTrainingWorkoutRows.filter((row) => {
        const dateISO = String(row.date_iso ?? "").trim();
        return dateISO >= weekStartISO && dateISO <= weekEndISO && dateISO >= startISO && dateISO <= endISO;
      }).length;
      const feedbackSubmitted = weekSessions.filter((row) => row.hasFeedback).length;
      const feedbackMissing = Math.max(0, weekSessions.length - feedbackSubmitted);

      return {
        weekStartISO,
        weekEndISO,
        plannedMilesMin,
        plannedMilesMax,
        plannedXTSecMin,
        plannedXTSecMax,
        completedMiles,
        workoutCount,
        feedbackSubmitted,
        feedbackMissing,
      };
    });
  }, [
    athleteId,
    s.mileageCellsByWeek,
    seasonTrainingPaceSecPerMile,
    selectedTrainingResolvedWindow,
    seasonTrainingSessionRows,
    seasonTrainingWeekStarts,
    seasonTrainingWorkoutRows,
  ]);

  const seasonTrainingTotals = useMemo(() => {
    const totals = seasonTrainingWeekSummaries.reduce(
      (acc, week) => {
        acc.plannedMilesMin += week.plannedMilesMin;
        acc.plannedMilesMax += week.plannedMilesMax;
        acc.plannedXTSecMin += week.plannedXTSecMin;
        acc.plannedXTSecMax += week.plannedXTSecMax;
        acc.completedMiles += week.completedMiles;
        acc.workoutCount += week.workoutCount;
        acc.feedbackSubmitted += week.feedbackSubmitted;
        acc.feedbackMissing += week.feedbackMissing;
        return acc;
      },
      {
        plannedMilesMin: 0,
        plannedMilesMax: 0,
        plannedXTSecMin: 0,
        plannedXTSecMax: 0,
        completedMiles: 0,
        workoutCount: 0,
        feedbackSubmitted: 0,
        feedbackMissing: 0,
      }
    );
    return totals;
  }, [seasonTrainingWeekSummaries]);

  function getDraftForSeason(seasonId: string, fallbackStart: string | null, fallbackEnd: string | null) {
    const draft = seasonDraftById[seasonId];
    if (draft) return draft;
    return {
      start: String(fallbackStart ?? ""),
      end: String(fallbackEnd ?? ""),
    };
  }

  function updateSeasonDraft(seasonId: string, patch: Partial<{ start: string; end: string }>) {
    setSeasonDraftById((prev) => {
      const current = prev[seasonId] ?? { start: "", end: "" };
      return { ...prev, [seasonId]: { ...current, ...patch } };
    });
  }

  async function saveSeasonOverride(seasonId: string) {
    const season = activeSeasons.find((row) => String(row.id ?? "").trim() === String(seasonId ?? "").trim());
    if (!season) {
      Alert.alert("Season not found", "Could not find this season.");
      return;
    }
    const existing = overridesBySeasonId.get(seasonId);
    const draft = getDraftForSeason(
      seasonId,
      existing?.start_date ?? null,
      existing?.end_date ?? null
    );
    const start = String(draft.start ?? "").trim();
    const end = String(draft.end ?? "").trim();

    if (start && !isValidDateOnlyISO(start)) {
      Alert.alert("Invalid start date", "Use YYYY-MM-DD.");
      return;
    }
    if (end && !isValidDateOnlyISO(end)) {
      Alert.alert("Invalid end date", "Use YYYY-MM-DD.");
      return;
    }

    const resolved = teamDataStore.resolveAthleteSeasonWindow(season, {
      ...(existing ?? {}),
      start_date: start || null,
      end_date: end || null,
    } as any);
    const tenureStatus = getAthleteSeasonTenureStatus(
      { teamStartDate, teamEndDate },
      season
    );
    if (tenureStatus !== "applies") {
      Alert.alert(
        "Season outside team tenure",
        "This season is outside the athlete's team tenure. No override is required."
      );
      return;
    }
    const resolvedWithTenure = resolveAthleteSeasonWindowWithTenure(
      { teamStartDate, teamEndDate },
      season,
      {
        ...(existing ?? {}),
        start_date: start || null,
        end_date: end || null,
      } as any
    );
    if (
      String(resolvedWithTenure.start_date ?? "").trim() &&
      String(resolvedWithTenure.end_date ?? "").trim() &&
      String(resolvedWithTenure.end_date ?? "") < String(resolvedWithTenure.start_date ?? "")
    ) {
      Alert.alert("Invalid date range", "Resolved range does not overlap athlete team tenure.");
      return;
    }
    if (String(resolved.end_date ?? "") < String(resolved.start_date ?? "")) {
      Alert.alert("Invalid date range", "Resolved end date must be on or after resolved start date.");
      return;
    }

    setSeasonSavingById((prev) => ({ ...prev, [seasonId]: true }));
    try {
      if (!start && !end) {
        await teamDataStore.actions.clearAthleteSeasonOverride(seasonId, athleteId);
        setSeasonDraftById((prev) => {
          const next = { ...prev };
          delete next[seasonId];
          return next;
        });
      } else {
        await teamDataStore.actions.upsertAthleteSeasonOverride({
          season_id: seasonId,
          athlete_profile_id: athleteId,
          start_date: start || null,
          end_date: end || null,
        });
      }
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not save season override.");
    } finally {
      setSeasonSavingById((prev) => ({ ...prev, [seasonId]: false }));
    }
  }

  async function clearSeasonOverride(seasonId: string) {
    setSeasonSavingById((prev) => ({ ...prev, [seasonId]: true }));
    try {
      await teamDataStore.actions.clearAthleteSeasonOverride(seasonId, athleteId);
      setSeasonDraftById((prev) => {
        const next = { ...prev };
        delete next[seasonId];
        return next;
      });
    } catch (e: any) {
      Alert.alert("Clear failed", e?.message ?? "Could not clear season override.");
    } finally {
      setSeasonSavingById((prev) => ({ ...prev, [seasonId]: false }));
    }
  }

  async function excludeSeason(seasonId: string) {
    const season = activeSeasons.find((row) => String(row.id ?? "").trim() === String(seasonId ?? "").trim());
    if (!season) return;
    const existing = overridesBySeasonId.get(String(season.id ?? "").trim()) ?? null;
    const athleteLabel = getAthleteDisplayName({ firstName, lastName });
    const message = `Exclude ${String(season.name ?? "this season")} for ${athleteLabel}?\n\nThis only affects this athlete's season participation. Historical workouts and team season dates will not change.`;
    const run = async () => {
      setSeasonSavingById((prev) => ({ ...prev, [seasonId]: true }));
      try {
        await teamDataStore.actions.upsertAthleteSeasonOverride({
          season_id: seasonId,
          athlete_profile_id: athleteId,
          start_date: existing?.start_date ?? null,
          end_date: existing?.end_date ?? null,
          is_excluded: true,
          excluded_at: existing?.excluded_at ?? null,
        });
      } catch (e: any) {
        Alert.alert("Exclude failed", e?.message ?? "Could not exclude season.");
      } finally {
        setSeasonSavingById((prev) => ({ ...prev, [seasonId]: false }));
      }
    };
    if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
      if (!globalThis.confirm(message)) return;
      await run();
      return;
    }
    Alert.alert("Exclude season", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Exclude", style: "destructive", onPress: () => void run() },
    ]);
  }

  async function restoreSeasonParticipation(seasonId: string) {
    const season = activeSeasons.find((row) => String(row.id ?? "").trim() === String(seasonId ?? "").trim());
    if (!season) return;
    const existing = overridesBySeasonId.get(String(season.id ?? "").trim()) ?? null;
    setSeasonSavingById((prev) => ({ ...prev, [seasonId]: true }));
    try {
      await teamDataStore.actions.upsertAthleteSeasonOverride({
        season_id: seasonId,
        athlete_profile_id: athleteId,
        start_date: existing?.start_date ?? null,
        end_date: existing?.end_date ?? null,
        is_excluded: false,
        excluded_at: null,
      });
    } catch (e: any) {
      Alert.alert("Restore failed", e?.message ?? "Could not restore season.");
    } finally {
      setSeasonSavingById((prev) => ({ ...prev, [seasonId]: false }));
    }
  }

  async function chainNextSeasonStart(currentSeasonId: string) {
    const currentIndex = participatingSeasons.findIndex(
      (row) => String(row.id ?? "").trim() === String(currentSeasonId ?? "").trim()
    );
    if (currentIndex < 0) return;
    const currentSeason = participatingSeasons[currentIndex];
    const nextSeason = participatingSeasons[currentIndex + 1];
    if (!currentSeason || !nextSeason) return;
    const nextSeasonTenureStatus = getAthleteSeasonTenureStatus(
      { teamStartDate, teamEndDate },
      nextSeason
    );
    if (nextSeasonTenureStatus !== "applies") {
      Alert.alert(
        "Cannot chain next season",
        nextSeasonTenureStatus === "before_team_start"
          ? "Next season is before this athlete's team start date."
          : "Next season is after this athlete's team end date."
      );
      return;
    }

    const currentOverride = overridesBySeasonId.get(String(currentSeason.id ?? "").trim()) ?? null;
    const currentResolved = resolveAthleteSeasonWindowWithTenure(
      { teamStartDate, teamEndDate },
      currentSeason,
      currentOverride
    );
    const currentResolvedEnd = String(currentResolved.end_date ?? "").trim();
    if (!isValidDateOnlyISO(currentResolvedEnd)) {
      Alert.alert("Cannot chain season", "Current season resolved end date is invalid or missing.");
      return;
    }

    const nextStartISO = addDaysISO(currentResolvedEnd, 1);
    if (!isValidDateOnlyISO(nextStartISO)) {
      Alert.alert("Cannot chain season", "Computed next season start date is invalid.");
      return;
    }

    const nextSeasonId = String(nextSeason.id ?? "").trim();
    const existingNextOverride = overridesBySeasonId.get(nextSeasonId) ?? null;
    const nextResolvedBefore = resolveAthleteSeasonWindowWithTenure(
      { teamStartDate, teamEndDate },
      nextSeason,
      existingNextOverride
    );
    const nextResolvedEnd = String(nextResolvedBefore.end_date ?? "").trim();
    if (isValidDateOnlyISO(nextResolvedEnd) && nextStartISO > nextResolvedEnd) {
      Alert.alert(
        "Invalid next season range",
        `Cannot start next season on ${nextStartISO} because it is after the next season's end date.`
      );
      return;
    }

    const athleteLabel = getAthleteDisplayName({ firstName, lastName });
    const nextSeasonName = String(nextSeason.name ?? "").trim() || "next season";
    const confirmMessage = `Set ${nextSeasonName} start date for ${athleteLabel} to ${nextStartISO}?\n\nThis will only update this athlete's season override. Team season dates will not change.`;

    const run = async () => {
      setSeasonSavingById((prev) => ({ ...prev, [nextSeasonId]: true }));
      try {
        await teamDataStore.actions.upsertAthleteSeasonOverride({
          season_id: nextSeasonId,
          athlete_profile_id: athleteId,
          start_date: nextStartISO,
          end_date: existingNextOverride?.end_date ?? null,
        });
      } catch (e: any) {
        Alert.alert("Chain failed", e?.message ?? "Could not update next season override.");
      } finally {
        setSeasonSavingById((prev) => ({ ...prev, [nextSeasonId]: false }));
      }
    };

    if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
      if (!globalThis.confirm(confirmMessage)) return;
      await run();
      return;
    }

    Alert.alert("Chain next season", confirmMessage, [
      { text: "Cancel", style: "cancel" },
      { text: "Apply", onPress: () => void run() },
    ]);
  }

  async function save() {
    if (!isUuid(athleteId)) {
      Alert.alert("Save blocked", `Invalid athlete id: ${athleteId}`);
      return;
    }

    const start = String(teamStartDate ?? "").trim();
    const end = String(teamEndDate ?? "").trim();
    if (start && !isValidDateOnlyISO(start)) {
      setTeamTenureError("Team Start Date must be YYYY-MM-DD.");
      return;
    }
    if (end && !isValidDateOnlyISO(end)) {
      setTeamTenureError("Team End Date must be YYYY-MM-DD.");
      return;
    }
    if (start && end && end < start) {
      setTeamTenureError("Team End Date must be on or after Team Start Date.");
      return;
    }
    setTeamTenureError(null);

    setBusy(true);
    try {
      const cleanFirstName = firstName.trim();
      const cleanLastName = lastName.trim();
      if (!cleanFirstName || !cleanLastName) {
        Alert.alert("Name required", "Enter both a first and last name.");
        return;
      }
      const displayName = `${cleanFirstName} ${cleanLastName}`.trim();
      const cleanEmail = email.trim();
      await teamDataStore.actions.updateAthlete(athleteId, {
        first_name: cleanFirstName,
        last_name: cleanLastName,
        display_name: displayName,
        email: cleanEmail || null,
        team_start_date: start || null,
        team_end_date: end || null,
      });

      if (cleanEmail) {
        await tryLinkLoginEmail(cleanEmail);
      } else {
        setLoginAccessTone("mutedText");
        setLoginAccessMessage("No login email is saved for this athlete.");
        await refreshLoginClaimedState().catch(() => {});
      }

      if (Platform.OS !== "web") {
        Alert.alert("Saved", "Athlete updated.");
      }
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  function loginAccessCopy(result: AthleteLoginLinkResult) {
    const linkedEmail = String(result.linked_email ?? email.trim()).trim();
    if (result.status === "linked") {
      return {
        tone: "success" as const,
        message: `Login linked to ${linkedEmail}. This athlete can now access this profile.`,
      };
    }
    if (result.status === "no_user_found") {
      return {
        tone: "mutedText" as const,
        message: `Email saved, but no login account exists for ${linkedEmail || "that email"} yet. Send an invite or have the athlete create an account.`,
      };
    }
    if (result.status === "duplicate_claim") {
      return {
        tone: "danger" as const,
        message: "That login is already linked to another athlete on this team.",
      };
    }
    if (result.status === "unlinked") {
      return {
        tone: "mutedText" as const,
        message: "Login access was unlinked from this athlete profile.",
      };
    }
    return {
      tone: "danger" as const,
      message: result.message || "Could not update athlete login access.",
    };
  }

  async function refreshLoginClaimedState() {
    await teamDataStore.actions.refreshRoster({ throwOnError: true });
    const next = teamDataStore.getAthleteById(athleteId);
    setClaimed(!!next?.claimed_user_id);
  }

  async function tryLinkLoginEmail(nextEmail = email.trim()) {
    const cleanEmail = String(nextEmail ?? "").trim();
    if (!cleanEmail) {
      setLoginAccessTone("mutedText");
      setLoginAccessMessage("Add a login email, then retry linking.");
      return null;
    }
    const teamId = await getCurrentTeamId();
    const result = await linkTeamAthleteToExistingUserEmail(teamId, athleteId, cleanEmail);
    const copy = loginAccessCopy(result);
    setLoginAccessTone(copy.tone);
    setLoginAccessMessage(copy.message);
    if (result.status === "linked") {
      setClaimed(true);
    } else {
      await refreshLoginClaimedState().catch(() => {});
    }
    return result;
  }

  async function retryLinkLogin() {
    if (!isUuid(athleteId)) {
      Alert.alert("Link blocked", `Invalid athlete id: ${athleteId}`);
      return;
    }
    setBusy(true);
    try {
      const result = await tryLinkLoginEmail(email.trim());
      if (result && Platform.OS !== "web") {
        const copy = loginAccessCopy(result);
        Alert.alert("Login Access", copy.message);
      }
    } catch (e: any) {
      Alert.alert("Link failed", e?.message ?? "Could not link athlete login access.");
    } finally {
      setBusy(false);
    }
  }

  async function unlinkLogin() {
    if (!isUuid(athleteId)) {
      Alert.alert("Unlink blocked", `Invalid athlete id: ${athleteId}`);
      return;
    }
    setBusy(true);
    try {
      const teamId = await getCurrentTeamId();
      const result = await unlinkTeamAthleteLogin(teamId, athleteId);
      const copy = loginAccessCopy(result);
      setLoginAccessTone(copy.tone);
      setLoginAccessMessage(copy.message);
      setClaimed(false);
      await teamDataStore.actions.refreshRoster();
      if (Platform.OS !== "web") {
        Alert.alert("Login Access", copy.message);
      }
    } catch (e: any) {
      Alert.alert("Unlink failed", e?.message ?? "Could not unlink athlete login access.");
    } finally {
      setBusy(false);
    }
  }

  async function invite() {
    if (!isUuid(athleteId)) {
      Alert.alert("Invite blocked", `Invalid athlete id: ${athleteId}`);
      return;
    }

    const e = email.trim();
    if (!e) return Alert.alert("Email required", "Enter an email before creating an invite.");

    setBusy(true);
    try {
      const invite = await createClaimInvite(athleteId, e);
      const inviteUrl = buildInviteUrl(invite.token);
      await Clipboard.setStringAsync(inviteUrl);
      setLatestInviteUrl(inviteUrl);

      try {
        const emailResult = await sendAthleteInviteEmail(invite.id);
        const copyableUrl = emailResult.invite_url || inviteUrl;
        await Clipboard.setStringAsync(copyableUrl);
        setLatestInviteUrl(copyableUrl);
        setLoginAccessTone("success");
        setLoginAccessMessage(`Invite email sent. Invite link copied as backup: ${copyableUrl}`);
        Alert.alert("Invite email sent", "Invite email sent. The invite link was copied as a manual backup.");
      } catch (emailError: any) {
        setLoginAccessTone("danger");
        setLoginAccessMessage(`Invite link created, but email failed to send. Copy and send manually: ${inviteUrl}`);
        Alert.alert(
          "Invite link created",
          `Invite link created, but email failed to send.\n\nThe invite link was copied so you can send it manually:\n${inviteUrl}`
        );
      }
    } catch (e: any) {
      Alert.alert("Invite failed", e?.message ?? "Could not create invite token.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const isActive = rosterStatus === "active";
    const nextStatus: TeamAthleteRosterStatus = isActive ? "inactive" : "active";
    const promptTitle = isActive ? "Remove from active roster?" : "Restore to active roster?";
    const promptBody = isActive
      ? "This keeps workout and training history, and the athlete can still log in to view prior training."
      : "This returns the athlete to your active roster for new planning and mileage edits.";
    const actionLabel = isActive ? "Remove" : "Restore";

    if (!isUuid(athleteId)) {
      Alert.alert("Status update blocked", `Invalid athlete id: ${athleteId}`);
      return;
    }

    const runStatusUpdate = async () => {
      setBusy(true);
      try {
        await teamDataStore.actions.setAthleteRosterStatus(athleteId, nextStatus);
        setRosterStatus(nextStatus);

        // Web: navigate immediately
        if (Platform.OS === "web") {
          return;
        }

        Alert.alert(
          isActive ? "Removed from active roster" : "Restored to active roster",
          isActive
            ? "Workout and training history remains available."
            : "Athlete is active again for new assignments."
        );
      } catch (e: any) {
        console.warn("SET ATHLETE ROSTER STATUS ERROR", e);
        Alert.alert("Update failed", e?.message ?? "Could not update roster status.");
      } finally {
        setBusy(false);
      }
    };

    if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
      if (!globalThis.confirm(promptTitle)) return;
      await runStatusUpdate();
      return;
    }

    Alert.alert(promptTitle, promptBody, [
      { text: "Cancel", style: "cancel" },
      { text: actionLabel, style: isActive ? "destructive" : "default", onPress: () => void runStatusUpdate() },
    ]);
  }

  const rosterStatusLabel = rosterStatus === "active" ? "Active" : `Roster: ${rosterStatus}`;
  const rosterStatusPillStyle = useMemo(
    () => ({
      borderWidth: 1,
      borderColor: rosterStatus === "active" ? "#b8e7ca" : "#d7dfeb",
      backgroundColor: rosterStatus === "active" ? "#eefaf2" : "#f7f9fd",
      borderRadius: 999,
      paddingVertical: 5,
      paddingHorizontal: 10,
    }),
    [rosterStatus]
  );
  const rosterActionLabel = rosterStatus === "active" ? "Remove from active roster" : "Restore to active roster";

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{ padding: theme.space.lg, gap: 10 }}
        keyboardShouldPersistTaps="handled"
      >
      <Card
        style={{
          borderColor: "#dde4f0",
          backgroundColor: "#fff",
          shadowColor: "#111827",
          shadowOpacity: Platform.OS === "web" ? 0.04 : 0.08,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 2 },
          elevation: 1,
          paddingVertical: 11,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <View style={{ gap: 3, flex: 1 }}>
            <AppText variant="caption" color="mutedText">
              Roster profile
            </AppText>
            <AppText variant="title" numberOfLines={1}>
              {getAthleteDisplayName({ firstName, lastName })}
            </AppText>
            <AppText variant="caption" color="mutedText" numberOfLines={1}>
              {athleteId}
            </AppText>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={rosterStatusPillStyle}>
              <AppText variant="caption" color={rosterStatus === "active" ? "success" : "mutedText"}>
                {rosterStatusLabel}
              </AppText>
            </View>
            <View
              style={{
                borderWidth: 1,
                borderColor: "#d7dfeb",
                backgroundColor: claimed ? "#eefaf2" : "#f7f9fd",
                borderRadius: 999,
                paddingVertical: 5,
                paddingHorizontal: 10,
              }}
            >
              <AppText variant="caption" color={claimed ? "success" : "mutedText"}>
                {claimed ? "Claimed" : "Not claimed"}
              </AppText>
            </View>
          </View>

          {!isDesktop ? <Button title="Back" variant="secondary" onPress={safeGoBack} /> : null}
        </View>
      </Card>

      <Card style={{ gap: theme.space.md, borderColor: "#dde4f0", backgroundColor: "#fff" }}>
        <View style={{ gap: 4 }}>
          <AppText variant="headline">Profile</AppText>
          <AppText variant="caption" color="mutedText">
            {readOnlyRoster ? "Viewer access: editing is disabled." : "Edit athlete identity and invite contact details."}
          </AppText>
        </View>
        <Divider />
        <TextField
          label="First name"
          value={firstName}
          onChangeText={setFirstName}
          placeholder="e.g. Alex"
          autoCapitalize="words"
          editable={!readOnlyRoster}
        />
        <TextField
          label="Last name"
          value={lastName}
          onChangeText={setLastName}
          placeholder="e.g. Rivera or Somers Glenn"
          autoCapitalize="words"
          editable={!readOnlyRoster}
        />
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="athlete@email.com"
          keyboardType="email-address"
          editable={!readOnlyRoster}
        />
        <Divider />
        <View style={{ gap: 4 }}>
          <AppText variant="sub">Team Tenure</AppText>
          <AppText variant="caption" color="mutedText">
            Controls future planning/default selection. Historical records remain visible.
          </AppText>
        </View>
        <TextField
          label="Team Start Date"
          value={teamStartDate}
          onChangeText={(value) => {
            setTeamStartDate(value);
            if (teamTenureError) setTeamTenureError(null);
          }}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          editable={!readOnlyRoster}
        />
        <TextField
          label="Team End Date"
          value={teamEndDate}
          onChangeText={(value) => {
            setTeamEndDate(value);
            if (teamTenureError) setTeamTenureError(null);
          }}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          editable={!readOnlyRoster}
        />
        {teamTenureError ? (
          <AppText variant="caption" color="danger">
            {teamTenureError}
          </AppText>
        ) : null}
        {latestInviteUrl ? (
          <View style={{ gap: 3 }}>
            <AppText variant="caption" color="mutedText">
              Latest invite link, copied for manual sending
            </AppText>
            <AppText variant="caption" color="text" numberOfLines={2}>
              {latestInviteUrl}
            </AppText>
          </View>
        ) : null}
        {!readOnlyRoster ? (
          <View style={{ flexDirection: "row", gap: theme.space.sm, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Button title={busy || loading ? "Saving..." : "Save"} onPress={save} disabled={busy || loading} />
            <Button title="Create and send invite" variant="secondary" onPress={invite} disabled={busy || loading} />
          </View>
        ) : null}

        {s.lastError ? (
          <AppText variant="caption" color="danger">
            {s.lastError}
          </AppText>
        ) : null}
      </Card>

      <Card style={{ gap: theme.space.md, borderColor: "#dde4f0", backgroundColor: "#fff" }}>
        <View style={{ gap: 4 }}>
          <AppText variant="headline">Login Access</AppText>
          <AppText variant="caption" color="mutedText">
            Email is used for invite delivery and to find an existing login account. The invite link can also be copied and sent manually.
          </AppText>
        </View>
        <Divider />
        <View style={{ gap: 6 }}>
          <AppText variant="caption" color="mutedText">Contact/login email</AppText>
          <AppText variant="sub">{email.trim() || "No email saved"}</AppText>
        </View>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <View
            style={{
              borderWidth: 1,
              borderColor: claimed ? "#b8e7ca" : "#d7dfeb",
              backgroundColor: claimed ? "#eefaf2" : "#f7f9fd",
              borderRadius: 999,
              paddingVertical: 5,
              paddingHorizontal: 10,
            }}
          >
            <AppText variant="caption" color={claimed ? "success" : "mutedText"}>
              {claimed ? "Linked" : "Not linked"}
            </AppText>
          </View>
          {loginAccessMessage ? (
            <AppText variant="caption" color={loginAccessTone} style={{ flex: 1, minWidth: 220 }}>
              {loginAccessMessage}
            </AppText>
          ) : (
            <AppText variant="caption" color="mutedText" style={{ flex: 1, minWidth: 220 }}>
              Save or retry link to connect this athlete to an existing login account.
            </AppText>
          )}
        </View>
        {!readOnlyRoster ? (
          <View style={{ flexDirection: "row", gap: theme.space.sm, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Button title={busy || loading ? "Working..." : "Retry link"} variant="secondary" onPress={retryLinkLogin} disabled={busy || loading} />
            <Button title="Unlink login" variant="danger" onPress={unlinkLogin} disabled={busy || loading || !claimed} />
          </View>
        ) : (
          <AppText variant="caption" color="mutedText">
            Viewer access: login linking is read-only.
          </AppText>
        )}
      </Card>

      {!readOnlyRoster ? (
      <Card style={{ gap: theme.space.md, borderColor: "#dde4f0", backgroundColor: "#fff" }}>
        <AppText variant="headline">Roster status</AppText>
        <Divider />
        <AppText variant="caption" color="mutedText">
          Changing roster status keeps workout and training history, and does not remove athlete login access.
        </AppText>
        <Button
          title={rosterActionLabel}
          variant={rosterStatus === "active" ? "danger" : "secondary"}
          onPress={remove}
          disabled={busy || loading}
        />
      </Card>
      ) : null}

      {!readOnlyRoster ? (
      <Card style={{ gap: theme.space.md, borderColor: "#dde4f0", backgroundColor: "#fff" }}>
        <AppText variant="headline">Season Overrides</AppText>
        <Divider />
        <AppText variant="caption" color="mutedText">
          Team season dates are defaults. Set athlete-specific dates to override one or both boundaries.
        </AppText>
        {activeSeasons.length === 0 ? (
          <AppText variant="caption" color="mutedText">No active seasons found.</AppText>
        ) : (
          <View style={{ gap: 10 }}>
            <AppText variant="sub" style={{ fontWeight: "900" }}>Participating Seasons</AppText>
            {participatingSeasons.map((season) => {
              const seasonId = String(season.id ?? "").trim();
              const override = overridesBySeasonId.get(seasonId) ?? null;
              const draft = getDraftForSeason(seasonId, override?.start_date ?? null, override?.end_date ?? null);
              const tenureStatus = getAthleteSeasonTenureStatus(
                { teamStartDate, teamEndDate },
                season
              );
              const resolved = resolveAthleteSeasonWindowWithTenure(
                { teamStartDate, teamEndDate },
                season,
                override
              );
              const hasOverride = !!override && (!!override.start_date || !!override.end_date);
              const saving = !!seasonSavingById[seasonId];
              const seasonIdx = participatingSeasons.findIndex((row) => String(row.id ?? "").trim() === seasonId);
              const nextSeason = seasonIdx >= 0 ? participatingSeasons[seasonIdx + 1] ?? null : null;
              const resolvedEnd = String(resolved.end_date ?? "").trim();
              const nextSeasonTenureStatus = nextSeason
                ? getAthleteSeasonTenureStatus({ teamStartDate, teamEndDate }, nextSeason)
                : null;
              const canShowChainAction =
                tenureStatus === "applies" &&
                !!nextSeason &&
                nextSeasonTenureStatus === "applies" &&
                isValidDateOnlyISO(resolvedEnd);
              const chainedNextStartISO = canShowChainAction ? addDaysISO(resolvedEnd, 1) : "";
              return (
                <View
                  key={`season-override-${seasonId}`}
                  style={{
                    borderWidth: 1,
                    borderColor: "#e2e8f0",
                    borderRadius: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 10,
                    gap: 8,
                    backgroundColor: "#fff",
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <AppText variant="sub" style={{ fontWeight: "900" }}>{season.name}</AppText>
                    <AppText variant="caption" color={hasOverride ? "tint" : "mutedText"}>
                      {hasOverride ? "Override" : "Inherited"}
                    </AppText>
                  </View>
                  <AppText variant="caption" color="mutedText">
                    Team default: {season.start_date} to {season.end_date}
                  </AppText>
                  {tenureStatus === "before_team_start" ? (
                    <AppText variant="caption" color="mutedText">
                      Not on team yet. No override required for this season.
                    </AppText>
                  ) : tenureStatus === "after_team_end" ? (
                    <AppText variant="caption" color="mutedText">
                      After team end date. No override required for this season.
                    </AppText>
                  ) : (
                    <>
                      <AppText variant="caption" color="mutedText">
                        Resolved: {resolved.start_date} to {resolved.end_date}
                      </AppText>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <TextField
                            label="Override start (optional)"
                            value={draft.start}
                            onChangeText={(value) => updateSeasonDraft(seasonId, { start: value })}
                            placeholder={season.start_date}
                            autoCapitalize="none"
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <TextField
                            label="Override end (optional)"
                            value={draft.end}
                            onChangeText={(value) => updateSeasonDraft(seasonId, { end: value })}
                            placeholder={season.end_date}
                            autoCapitalize="none"
                          />
                        </View>
                      </View>
                    </>
                  )}
                  {tenureStatus !== "applies" && hasOverride ? (
                    <AppText variant="caption" color="mutedText">
                      This override exists, but this season is outside the athlete&apos;s team tenure.
                    </AppText>
                  ) : null}
                  <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    {tenureStatus === "applies" ? (
                      <Button
                        title={saving ? "Saving..." : "Save Override"}
                        onPress={() => void saveSeasonOverride(seasonId)}
                        disabled={busy || loading || saving}
                      />
                    ) : null}
                    <Button
                      title="Use Team Default"
                      variant="secondary"
                      onPress={() => void clearSeasonOverride(seasonId)}
                      disabled={busy || loading || saving}
                    />
                    <Button
                      title="Exclude Season"
                      variant="secondary"
                      onPress={() => void excludeSeason(seasonId)}
                      disabled={busy || loading || saving}
                    />
                    {canShowChainAction ? (
                      <Button
                        title={`Start ${String(nextSeason?.name ?? "next season")} on ${chainedNextStartISO}`}
                        variant="secondary"
                        onPress={() => void chainNextSeasonStart(seasonId)}
                        disabled={busy || loading || !!seasonSavingById[String(nextSeason?.id ?? "")]}
                      />
                    ) : null}
                    {!!nextSeason && nextSeasonTenureStatus !== "applies" && tenureStatus === "applies" ? (
                      <AppText variant="caption" color="mutedText">
                        Next season is outside athlete team tenure.
                      </AppText>
                    ) : null}
                  </View>
                </View>
              );
            })}
            {participatingSeasons.length === 0 ? (
              <AppText variant="caption" color="mutedText">
                No participating seasons. Restore an excluded season to edit overrides.
              </AppText>
            ) : null}
            {excludedSeasons.length > 0 ? (
              <View style={{ gap: 8 }}>
                <Divider />
                <AppText variant="sub" style={{ fontWeight: "900" }}>Excluded Seasons</AppText>
                {excludedSeasons.map((season) => {
                  const seasonId = String(season.id ?? "").trim();
                  const override = overridesBySeasonId.get(seasonId) ?? null;
                  const saving = !!seasonSavingById[seasonId];
                  return (
                    <View
                      key={`season-excluded-${seasonId}`}
                      style={{
                        borderWidth: 1,
                        borderColor: "#e2e8f0",
                        borderRadius: 10,
                        paddingHorizontal: 10,
                        paddingVertical: 10,
                        gap: 6,
                        backgroundColor: "#fff",
                      }}
                    >
                      <AppText variant="sub" style={{ fontWeight: "900" }}>{season.name}</AppText>
                      <AppText variant="caption" color="mutedText">
                        Team default: {season.start_date} to {season.end_date}
                      </AppText>
                      {(override?.start_date || override?.end_date) ? (
                        <AppText variant="caption" color="mutedText">
                          Saved override dates: {String(override?.start_date ?? "inherit")} to {String(override?.end_date ?? "inherit")}
                        </AppText>
                      ) : null}
                      <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
                        <Button
                          title={saving ? "Restoring..." : "Restore Season"}
                          variant="secondary"
                          onPress={() => void restoreSeasonParticipation(seasonId)}
                          disabled={busy || loading || saving}
                        />
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        )}
      </Card>
      ) : null}

      <Card style={{ gap: theme.space.md, borderColor: "#dde4f0", backgroundColor: "#fff" }}>
        <AppText variant="headline">Season Training View</AppText>
        <Divider />
        <AppText variant="caption" color="mutedText">
          Read-only summary for this athlete&apos;s resolved season window.
        </AppText>

        {activeSeasons.length === 0 ? (
          <AppText variant="caption" color="mutedText">No active seasons available.</AppText>
        ) : (
          <View style={{ gap: 8 }}>
            <AppText variant="caption" color="mutedText">Season</AppText>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {activeSeasons.map((season) => {
                const selected = String(seasonTrainingSelectedSeasonId ?? "").trim() === String(season.id ?? "").trim();
                return (
                  <Button
                    key={`season-training-select-${season.id}`}
                    title={String(season.name ?? "Season")}
                    variant={selected ? "primary" : "secondary"}
                    onPress={() => setSeasonTrainingSelectedSeasonId(String(season.id ?? ""))}
                    disabled={loading || busy}
                  />
                );
              })}
            </View>
          </View>
        )}

        {selectedTrainingSeason ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: "#e2e8f0",
              borderRadius: 10,
              paddingHorizontal: 10,
              paddingVertical: 10,
              gap: 6,
              backgroundColor: "#fff",
            }}
          >
            <AppText variant="sub" style={{ fontWeight: "900" }}>
              {selectedTrainingSeason.name}
            </AppText>
            <AppText variant="caption" color="mutedText">
              Resolved window: {selectedTrainingResolvedWindow?.start_date ?? "—"} to {selectedTrainingResolvedWindow?.end_date ?? "—"}
            </AppText>
            <AppText variant="caption" color={selectedTrainingWindowStatus === "Override" ? "tint" : "mutedText"}>
              {selectedTrainingWindowStatus}
            </AppText>
          </View>
        ) : null}

        {seasonTrainingError ? (
          <AppText variant="caption" color="danger">{seasonTrainingError}</AppText>
        ) : null}

        {seasonTrainingLoading ? (
          <AppText variant="caption" color="mutedText">Loading season training data...</AppText>
        ) : (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <View style={{ minWidth: 140, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, padding: 8 }}>
                <AppText variant="caption" color="mutedText">Planned miles</AppText>
                <AppText variant="sub">{formatMilesRange(seasonTrainingTotals.plannedMilesMin, seasonTrainingTotals.plannedMilesMax)}</AppText>
              </View>
              <View style={{ minWidth: 140, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, padding: 8 }}>
                <AppText variant="caption" color="mutedText">Completed miles</AppText>
                <AppText variant="sub">{formatMilesValue(seasonTrainingTotals.completedMiles)}</AppText>
              </View>
              <View style={{ minWidth: 140, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, padding: 8 }}>
                <AppText variant="caption" color="mutedText">Planned XT</AppText>
                <AppText variant="sub">{formatXTRangeMinutes(seasonTrainingTotals.plannedXTSecMin, seasonTrainingTotals.plannedXTSecMax)}</AppText>
              </View>
              <View style={{ minWidth: 120, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, padding: 8 }}>
                <AppText variant="caption" color="mutedText">Workouts</AppText>
                <AppText variant="sub">{seasonTrainingTotals.workoutCount}</AppText>
              </View>
              <View style={{ minWidth: 120, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, padding: 8 }}>
                <AppText variant="caption" color="mutedText">Submitted</AppText>
                <AppText variant="sub">{seasonTrainingTotals.feedbackSubmitted}</AppText>
              </View>
              <View style={{ minWidth: 120, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, padding: 8 }}>
                <AppText variant="caption" color="mutedText">Missing</AppText>
                <AppText variant="sub">{seasonTrainingTotals.feedbackMissing}</AppText>
              </View>
            </View>

            <View style={{ gap: 8 }}>
              <AppText variant="sub" style={{ fontWeight: "900" }}>Weekly Summary</AppText>
              {seasonTrainingWeekSummaries.length === 0 ? (
                <AppText variant="caption" color="mutedText">No training rows in this resolved window.</AppText>
              ) : (
                seasonTrainingWeekSummaries.map((week) => (
                  <View
                    key={`season-week-${week.weekStartISO}`}
                    style={{
                      borderWidth: 1,
                      borderColor: "#e2e8f0",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      gap: 4,
                    }}
                  >
                    <AppText variant="caption" style={{ fontWeight: "900" }}>
                      {formatWeekLabel(week.weekStartISO)}
                    </AppText>
                    <AppText variant="caption" color="mutedText">
                      Planned {formatMilesRange(week.plannedMilesMin, week.plannedMilesMax)} · Completed {formatMilesValue(week.completedMiles)}
                    </AppText>
                    <AppText variant="caption" color="mutedText">
                      XT {formatXTRangeMinutes(week.plannedXTSecMin, week.plannedXTSecMax)} · Workouts {week.workoutCount}
                    </AppText>
                    <AppText variant="caption" color="mutedText">
                      Feedback {week.feedbackSubmitted} submitted / {week.feedbackMissing} missing
                    </AppText>
                  </View>
                ))
              )}
            </View>

            <View style={{ gap: 8 }}>
              <AppText variant="sub" style={{ fontWeight: "900" }}>Session Details</AppText>
              {seasonTrainingSessionRows.length === 0 ? (
                <AppText variant="caption" color="mutedText">No workout or planned-session rows in this resolved window.</AppText>
              ) : (
                seasonTrainingSessionRows.map((row) => (
                  <View
                    key={row.key}
                    style={{
                      borderWidth: 1,
                      borderColor: "#e2e8f0",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      gap: 4,
                    }}
                  >
                    <AppText variant="caption" style={{ fontWeight: "900" }}>
                      {row.dateISO} · {row.session} · {row.sourceTitle}
                    </AppText>
                    <AppText variant="caption" color="mutedText">
                      Prescribed: {row.prescribedText ? row.prescribedText : "—"} · Completed: {formatMilesValue(parseNumericLike(row.completedMiles) ?? 0)}
                    </AppText>
                    <AppText variant="caption" color={row.hasFeedback ? "success" : "mutedText"}>
                      {row.hasFeedback ? "Feedback submitted" : "No feedback"}
                    </AppText>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </Card>
      </ScrollView>
    </Screen>
  );
}
