import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import {
  fetchMileageCellsForWeek,
  fetchMileageDayFlagsForWeek,
  fetchVisibleMileageCellsForAthleteWeek,
  fetchVisibleMileageDayFlagsForAthleteWeek,
  upsertMileageCell,
  upsertMileageDayFlag,
} from "./mileageCloud";
import { listTeamWorkoutsInRange, type TeamWorkoutRow as TeamWorkoutRowBase } from "./teamWorkoutsCloud";
import {
  createTrainingGroup,
  listTrainingGroupMemberships,
  listTrainingGroups,
  replaceTrainingGroupActiveMemberships,
  setTrainingGroupArchived,
  updateTrainingGroupName,
  type TeamTrainingGroupMembershipRow,
  type TeamTrainingGroupRow,
} from "./trainingGroupsCloud";
import {
  clearAthleteSeasonOverride,
  createTeamSeason,
  listTeamAthleteSeasonOverrides,
  listTeamSeasons,
  setTeamSeasonArchived,
  upsertAthleteSeasonOverride,
  updateTeamSeason,
  type TeamAthleteSeasonOverrideRow,
  type TeamSeasonRow,
} from "./seasonsCloud";
import { compareNames, sortSeasonsForDisplay } from "./sortHelpers";

export type TeamAthlete = {
  id: string;
  team_id: string;
  display_name: string;
  email?: string | null;
  claimed_user_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  roster_status?: string | null;
  left_at?: string | null;
  team_start_date?: string | null;
  team_end_date?: string | null;
};

export type TeamAthleteRosterStatus = "active" | "inactive" | "graduated" | "transferred" | "archived";

export type TeamMileageCellRow = {
  athlete_profile_id: string;
  week_start_iso: string;
  day_idx: number;
  session: "AM" | "PM";
  value: any;
  updated_at?: string | null;
};

export type MileageDayFlagRow = {
  athlete_profile_id: string;
  week_start_iso: string;
  day_idx: number;
  ncaa_off: boolean;
  updated_at?: string | null;
};

export type TeamWorkoutRow = TeamWorkoutRowBase;
export type TeamTrainingGroup = TeamTrainingGroupRow;
export type TeamTrainingGroupMembership = TeamTrainingGroupMembershipRow;
export type TeamSeason = TeamSeasonRow;
export type TeamAthleteSeasonOverride = TeamAthleteSeasonOverrideRow;

function sortTrainingGroupsByName(rows: TeamTrainingGroup[]): TeamTrainingGroup[] {
  return [...(Array.isArray(rows) ? rows : [])].sort(compareNames);
}

export function isActiveTrainingGroupMembership(
  membership: TeamTrainingGroupMembership | null | undefined
): boolean {
  return membership?.ends_on == null;
}

export function isAthleteExcludedFromSeason(
  athleteProfileId: string | null | undefined,
  seasonId: string | null | undefined,
  overrides?: TeamAthleteSeasonOverride[] | null
): boolean {
  const athleteId = String(athleteProfileId ?? "").trim();
  const sid = String(seasonId ?? "").trim();
  if (!athleteId || !sid) return false;
  const rows = Array.isArray(overrides) ? overrides : state.athleteSeasonOverrides;
  const match = rows.find(
    (row) =>
      String(row?.athlete_profile_id ?? "").trim() === athleteId &&
      String(row?.season_id ?? "").trim() === sid
  );
  return !!match?.is_excluded;
}

type WeekKey = string; // weekStartISO
type DayKey = string;  // dateISO
type MileageCellPendingByWeek = Record<WeekKey, TeamMileageCellRow[]>;
type MileageFlagPendingByWeek = Record<WeekKey, MileageDayFlagRow[]>;

const MILEAGE_PENDING_CELLS_STORAGE_PREFIX = "training_app_mileage_pending_cells_team_v1";
const MILEAGE_PENDING_FLAGS_STORAGE_PREFIX = "training_app_mileage_pending_flags_team_v1";
const TEAM_ROSTER_CACHE_STORAGE_PREFIX = "training_app_team_roster_cache_v1";
const USER_LAST_TEAM_ID_STORAGE_PREFIX = "training_app_user_last_team_id_v1";
const SHARED_COACH_SELECTED_TRAINING_GROUP_IDS_KEY = "coach_shared_selected_training_group_ids_v1";
const SHARED_COACH_SELECTED_SEASON_ID_KEY = "coach_shared_selected_season_id_v1";
const LEGACY_COACH_GROUP_FILTER_KEYS = [
  "coach_calendar_selected_training_group_filter_v1",
  "coach_workouts_day_selected_training_group_filter_v1",
  "coach_mileage_selected_training_group_filter_v1",
  "coach_training_logs_selected_training_group_filter_v1",
] as const;
const LEGACY_COACH_SEASON_FILTER_KEYS = [
  "coach_calendar_selected_season_filter_v1",
  "coach_workouts_day_selected_season_filter_v1",
  "coach_mileage_selected_season_filter_v1",
  "coach_training_logs_selected_season_filter_v1",
] as const;
const TEAM_ID_VERIFY_TTL_MS = 30_000;
const ROSTER_REFRESH_TTL_MS = 60_000;
let pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
let lastVerifiedTeamContext: { userId: string | null; teamId: string | null; atMs: number } = {
  userId: null,
  teamId: null,
  atMs: 0,
};
let lastRosterRefreshByTeamKey: Record<string, number> = {};
const inFlightRosterRefreshByKey = new Map<string, Promise<void>>();
type MileageWeekLoadResult = {
  weekStartISO: string;
  cells: TeamMileageCellRow[];
  flags: MileageDayFlagRow[];
};

const inFlightMileageWeekByKey = new Map<string, Promise<MileageWeekLoadResult>>();
const inFlightVisibleMileageWeekByKey = new Map<string, Promise<MileageWeekLoadResult>>();
const inFlightTrainingGroupsByKey = new Map<string, Promise<void>>();
const inFlightTeamSeasonsByKey = new Map<string, Promise<void>>();
const inFlightAthleteSeasonOverridesByKey = new Map<string, Promise<void>>();
const inFlightSharedCoachFiltersByKey = new Map<string, Promise<void>>();

function teamScopedLoadKey(suffix = "") {
  return `${String(state.userId ?? "unknown")}:${String(state.teamId ?? "unknown")}${suffix ? `:${suffix}` : ""}`;
}

type StoreState = {
  ready: boolean;
  userId: string | null;
  teamId: string | null;

  // roster
  roster: TeamAthlete[];
  rosterLoaded: boolean;

  // mileage cache (by week)
  mileageCellsByWeek: Record<WeekKey, TeamMileageCellRow[]>;
  mileageFlagsByWeek: Record<WeekKey, MileageDayFlagRow[]>;
  mileageLoadedWeeks: Record<WeekKey, boolean>;
  mileagePendingCellsByWeek: MileageCellPendingByWeek;
  mileagePendingFlagsByWeek: MileageFlagPendingByWeek;
  mileagePendingLoadedForTeamId: string | null;
  visibleMileageCellsByAthleteWeek: Record<string, TeamMileageCellRow[]>;
  visibleMileageFlagsByAthleteWeek: Record<string, MileageDayFlagRow[]>;
  visibleMileageLoadedByAthleteWeek: Record<string, boolean>;

  // workouts cache (by day)
  workoutsByDay: Record<DayKey, TeamWorkoutRow[]>;
  workoutsLoadedDays: Record<DayKey, boolean>;

  // training groups
  trainingGroups: TeamTrainingGroup[];
  trainingGroupMemberships: TeamTrainingGroupMembership[];
  trainingGroupsLoaded: boolean;

  // seasons
  teamSeasons: TeamSeason[];
  teamSeasonsLoaded: boolean;
  athleteSeasonOverrides: TeamAthleteSeasonOverride[];
  athleteSeasonOverridesLoaded: boolean;
  sharedSelectedTrainingGroupIds: string[];
  sharedSelectedSeasonId: string | null;
  sharedSelectedSeasonInitialized: boolean;
  sharedCoachFiltersLoaded: boolean;

  loadingCount: number;
  lastError: string | null;
};

let state: StoreState = {
  ready: false,
  userId: null,
  teamId: null,

  roster: [],
  rosterLoaded: false,

  mileageCellsByWeek: {},
  mileageFlagsByWeek: {},
  mileageLoadedWeeks: {},
  mileagePendingCellsByWeek: {},
  mileagePendingFlagsByWeek: {},
  mileagePendingLoadedForTeamId: null,
  visibleMileageCellsByAthleteWeek: {},
  visibleMileageFlagsByAthleteWeek: {},
  visibleMileageLoadedByAthleteWeek: {},

  workoutsByDay: {},
  workoutsLoadedDays: {},

  trainingGroups: [],
  trainingGroupMemberships: [],
  trainingGroupsLoaded: false,

  teamSeasons: [],
  teamSeasonsLoaded: false,
  athleteSeasonOverrides: [],
  athleteSeasonOverridesLoaded: false,
  sharedSelectedTrainingGroupIds: [],
  sharedSelectedSeasonId: null,
  sharedSelectedSeasonInitialized: false,
  sharedCoachFiltersLoaded: false,

  loadingCount: 0,
  lastError: null,
};

const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function setState(patch: Partial<StoreState>) { state = { ...state, ...patch }; emit(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
function getSnapshot() { return state; }
function getState() { return state; }

function mileagePendingCellsStorageKey(teamId: string) {
  return `${MILEAGE_PENDING_CELLS_STORAGE_PREFIX}:${teamId}`;
}

function mileagePendingFlagsStorageKey(teamId: string) {
  return `${MILEAGE_PENDING_FLAGS_STORAGE_PREFIX}:${teamId}`;
}

function rosterCacheStorageKey(teamId: string) {
  return `${TEAM_ROSTER_CACHE_STORAGE_PREFIX}:${teamId}`;
}

function userLastTeamIdStorageKey(userId: string) {
  return `${USER_LAST_TEAM_ID_STORAGE_PREFIX}:${userId}`;
}

function mileageCellIdentity(row: TeamMileageCellRow): string {
  return `${row.athlete_profile_id}__${row.week_start_iso}__${row.day_idx}__${row.session}`;
}

function mileageFlagIdentity(row: MileageDayFlagRow): string {
  return `${row.athlete_profile_id}__${row.week_start_iso}__${row.day_idx}`;
}

export function visibleMileageAthleteWeekKey(athleteId: string, weekStartISO: string): string {
  return `${String(athleteId ?? "").trim()}|${String(weekStartISO ?? "").trim()}`;
}

function upsertByIdentity<T>(
  rows: T[],
  row: T,
  identity: (value: T) => string
): T[] {
  const key = identity(row);
  const next = rows.filter((value) => identity(value) !== key);
  next.push(row);
  return next;
}

function removeByIdentity<T>(
  rows: T[],
  row: T,
  identity: (value: T) => string
): T[] {
  const key = identity(row);
  return rows.filter((value) => identity(value) !== key);
}

function mergeRowsByIdentity<T>(
  baseRows: T[],
  overrideRows: T[],
  identity: (value: T) => string
): T[] {
  const byId = new Map<string, T>();
  for (const row of baseRows) byId.set(identity(row), row);
  for (const row of overrideRows) byId.set(identity(row), row);
  return Array.from(byId.values());
}

function rowUpdatedAtMs(row: { updated_at?: string | null } | null | undefined): number {
  const parsed = Date.parse(String(row?.updated_at ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeRowsByIdentityPreferLatest<T extends { updated_at?: string | null }>(
  rowsA: T[],
  rowsB: T[],
  identity: (value: T) => string
): T[] {
  const byId = new Map<string, T>();
  for (const row of rowsA) byId.set(identity(row), row);
  for (const row of rowsB) {
    const key = identity(row);
    const existing = byId.get(key);
    if (!existing || rowUpdatedAtMs(row) >= rowUpdatedAtMs(existing)) {
      byId.set(key, row);
    }
  }
  return Array.from(byId.values());
}

async function persistMileagePendingForTeam(teamId: string, cells: MileageCellPendingByWeek, flags: MileageFlagPendingByWeek) {
  try {
    await AsyncStorage.multiSet([
      [mileagePendingCellsStorageKey(teamId), JSON.stringify(cells)],
      [mileagePendingFlagsStorageKey(teamId), JSON.stringify(flags)],
    ]);
  } catch (e) {
    console.warn("Failed to persist mileage pending queue", e);
  }
}

function schedulePersistMileagePendingForTeam(teamId: string, cells: MileageCellPendingByWeek, flags: MileageFlagPendingByWeek) {
  if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
  pendingPersistTimer = setTimeout(() => {
    pendingPersistTimer = null;
    void persistMileagePendingForTeam(teamId, cells, flags);
  }, 120);
}

async function loadMileagePendingForTeam(teamId: string): Promise<{
  cells: MileageCellPendingByWeek;
  flags: MileageFlagPendingByWeek;
}> {
  try {
    const [cellsRaw, flagsRaw] = await AsyncStorage.multiGet([
      mileagePendingCellsStorageKey(teamId),
      mileagePendingFlagsStorageKey(teamId),
    ]);
    const cells = (cellsRaw?.[1] ? JSON.parse(cellsRaw[1]) : {}) as MileageCellPendingByWeek;
    const flags = (flagsRaw?.[1] ? JSON.parse(flagsRaw[1]) : {}) as MileageFlagPendingByWeek;
    return {
      cells: cells && typeof cells === "object" ? cells : {},
      flags: flags && typeof flags === "object" ? flags : {},
    };
  } catch (e) {
    console.warn("Failed to load mileage pending queue", e);
    return { cells: {}, flags: {} };
  }
}

async function loadRosterCacheForTeam(teamId: string): Promise<TeamAthlete[] | null> {
  try {
    const raw = await AsyncStorage.getItem(rosterCacheStorageKey(teamId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { roster?: TeamAthlete[] };
    const roster = Array.isArray(parsed?.roster) ? parsed.roster : [];
    return roster as TeamAthlete[];
  } catch {
    return null;
  }
}

async function persistRosterCacheForTeam(teamId: string, roster: TeamAthlete[]): Promise<void> {
  try {
    await AsyncStorage.setItem(
      rosterCacheStorageKey(teamId),
      JSON.stringify({ roster: Array.isArray(roster) ? roster : [], updatedAt: Date.now() })
    );
  } catch {}
}

async function loadCachedTeamIdForUser(userId: string): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(userLastTeamIdStorageKey(userId));
    const teamId = String(value ?? "").trim();
    return teamId || null;
  } catch {
    return null;
  }
}

async function persistCachedTeamIdForUser(userId: string, teamId: string | null): Promise<void> {
  try {
    await AsyncStorage.setItem(userLastTeamIdStorageKey(userId), String(teamId ?? ""));
  } catch {}
}

function incLoading() { setState({ loadingCount: state.loadingCount + 1 }); }
function decLoading() { setState({ loadingCount: Math.max(0, state.loadingCount - 1) }); }
function setError(e: unknown) {
  const msg = typeof e === "object" && e && "message" in e ? String((e as any).message) : "Unknown error";
  setState({ lastError: msg });
}

function isAthleteActive(athlete: TeamAthlete | null | undefined): boolean {
  const status = String(athlete?.roster_status ?? "").trim().toLowerCase();
  if (!status) return true;
  return status === "active";
}

function toDateOnlyISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function resolveDefaultCurrentSeasonId(todayISO: string, seasons: TeamSeason[]): string | null {
  const candidates = (Array.isArray(seasons) ? seasons : []).filter((season) => !season?.archived_at);
  if (candidates.length === 0) return null;
  const normalizedToday = String(todayISO ?? "").trim();

  const containing = candidates.filter((season) => {
    const start = String(season?.start_date ?? "").trim();
    const end = String(season?.end_date ?? "").trim();
    return !!start && !!end && normalizedToday >= start && normalizedToday <= end;
  });
  if (containing.length > 0) return String(containing[0]?.id ?? "").trim() || null;

  const upcoming = candidates
    .filter((season) => {
      const start = String(season?.start_date ?? "").trim();
      return !!start && start > normalizedToday;
    })
    .sort((a, b) => String(a.start_date ?? "").localeCompare(String(b.start_date ?? "")));
  if (upcoming.length > 0) return String(upcoming[0]?.id ?? "").trim() || null;

  const past = candidates
    .filter((season) => {
      const end = String(season?.end_date ?? "").trim();
      return !!end && end < normalizedToday;
    })
    .sort((a, b) => String(b.end_date ?? "").localeCompare(String(a.end_date ?? "")));
  if (past.length > 0) return String(past[0]?.id ?? "").trim() || null;

  return String(candidates[0]?.id ?? "").trim() || null;
}

export function useTeamDataStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------- identity ----------
async function ensureSessionAndTeam() {
  const { data } = await supabase.auth.getSession();
  const session = data.session;

  const userId = session?.user?.id ?? null;
  if (!userId) {
    setState({
      ready: true,
      userId: null,
      teamId: null,
      roster: [],
      rosterLoaded: false,
      mileageCellsByWeek: {},
      mileageFlagsByWeek: {},
      mileageLoadedWeeks: {},
      mileagePendingCellsByWeek: {},
      mileagePendingFlagsByWeek: {},
      mileagePendingLoadedForTeamId: null,
      visibleMileageCellsByAthleteWeek: {},
      visibleMileageFlagsByAthleteWeek: {},
      visibleMileageLoadedByAthleteWeek: {},
      workoutsByDay: {},
      workoutsLoadedDays: {},
      trainingGroups: [],
      trainingGroupMemberships: [],
      trainingGroupsLoaded: false,
      teamSeasons: [],
      teamSeasonsLoaded: false,
      athleteSeasonOverrides: [],
      athleteSeasonOverridesLoaded: false,
      sharedSelectedTrainingGroupIds: [],
      sharedSelectedSeasonId: null,
      sharedCoachFiltersLoaded: false,
    });
    return { userId: null, teamId: null };
  }

  const now = Date.now();
  if (
    state.ready &&
    state.userId === userId &&
    state.teamId &&
    lastVerifiedTeamContext.userId === userId &&
    lastVerifiedTeamContext.teamId === state.teamId &&
    now - lastVerifiedTeamContext.atMs < TEAM_ID_VERIFY_TTL_MS
  ) {
    return { userId, teamId: state.teamId };
  }

  const hydrateLocalTeamCaches = async (teamIdToHydrate: string | null) => {
    if (!teamIdToHydrate) return;
    if (state.mileagePendingLoadedForTeamId !== teamIdToHydrate) {
      const pending = await loadMileagePendingForTeam(teamIdToHydrate);
      setState({
        mileagePendingCellsByWeek: pending.cells,
        mileagePendingFlagsByWeek: pending.flags,
        mileagePendingLoadedForTeamId: teamIdToHydrate,
      });
    }
    const shouldHydrateRoster =
      state.teamId !== teamIdToHydrate || !state.rosterLoaded || state.roster.length === 0;
    if (!shouldHydrateRoster) return;
    const cachedRoster = await loadRosterCacheForTeam(teamIdToHydrate);
    if (Array.isArray(cachedRoster) && cachedRoster.length > 0) {
      setState({
        roster: cachedRoster,
        rosterLoaded: true,
      });
    }
  };

  const cachedTeamId = await loadCachedTeamIdForUser(userId);
  if (cachedTeamId) {
    setState({ ready: true, userId, teamId: cachedTeamId });
    await hydrateLocalTeamCaches(cachedTeamId);
  } else if (!state.ready || state.userId !== userId) {
    setState({ ready: true, userId, teamId: null });
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("current_team_id")
    .eq("id", userId)
    .single();

  if (error) {
    if (cachedTeamId) {
      return { userId, teamId: cachedTeamId };
    }
    throw error;
  }

  const teamId = (profile?.current_team_id as string | null) ?? null;

  setState({ ready: true, userId, teamId });
  await persistCachedTeamIdForUser(userId, teamId);
  await hydrateLocalTeamCaches(teamId);

  lastVerifiedTeamContext = { userId, teamId, atMs: Date.now() };
  return { userId, teamId };
}

function sanitizeStringArray(input: unknown): string[] {
  return Array.isArray(input)
    ? input.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
}

async function loadSharedCoachFilters(force = false) {
  if (!force && state.sharedCoachFiltersLoaded) return;
  const inFlightKey = teamScopedLoadKey(force ? "shared-filters:force" : "shared-filters");
  const existing = inFlightSharedCoachFiltersByKey.get(inFlightKey);
  if (existing) return existing;
  const promise = (async () => {
  try {
    const [sharedGroupsRaw, sharedSeasonRaw] = await AsyncStorage.multiGet([
      SHARED_COACH_SELECTED_TRAINING_GROUP_IDS_KEY,
      SHARED_COACH_SELECTED_SEASON_ID_KEY,
    ]);

    let selectedTrainingGroupIds: string[] | null = null;
    let selectedSeasonId: string | null | undefined = undefined;
    let selectedSeasonInitialized = false;

    if (sharedGroupsRaw?.[1] != null) {
      try {
        selectedTrainingGroupIds = sanitizeStringArray(JSON.parse(sharedGroupsRaw[1]));
      } catch {
        selectedTrainingGroupIds = [];
      }
    }
    if (sharedSeasonRaw?.[1] != null) {
      try {
        const parsed = JSON.parse(sharedSeasonRaw[1]);
        if (parsed && typeof parsed === "object" && "initialized" in (parsed as Record<string, unknown>)) {
          const initialized = (parsed as { initialized?: unknown }).initialized === true;
          selectedSeasonInitialized = initialized;
          if ("selectedSeasonId" in (parsed as Record<string, unknown>)) {
            const rawId = (parsed as { selectedSeasonId?: unknown }).selectedSeasonId;
            const next = typeof rawId === "string" ? String(rawId ?? "").trim() : "";
            selectedSeasonId = next || null;
          } else {
            selectedSeasonId = null;
          }
        } else {
          const next = typeof parsed === "string" ? String(parsed ?? "").trim() : "";
          selectedSeasonId = next || null;
          selectedSeasonInitialized = true;
        }
      } catch {
        selectedSeasonId = null;
        selectedSeasonInitialized = true;
      }
    }

    if (selectedTrainingGroupIds == null) {
      for (const key of LEGACY_COACH_GROUP_FILTER_KEYS) {
        const raw = await AsyncStorage.getItem(key);
        if (raw == null) continue;
        try {
          const parsed = sanitizeStringArray(JSON.parse(raw));
          if (parsed.length > 0) {
            selectedTrainingGroupIds = parsed;
            break;
          }
        } catch {}
      }
      if (selectedTrainingGroupIds == null) selectedTrainingGroupIds = [];
    }

    if (typeof selectedSeasonId === "undefined") {
      selectedSeasonId = null;
      for (const key of LEGACY_COACH_SEASON_FILTER_KEYS) {
        const raw = await AsyncStorage.getItem(key);
        if (raw == null) continue;
        try {
          const parsed = JSON.parse(raw);
          const next = typeof parsed === "string" ? String(parsed ?? "").trim() : "";
          if (next) {
            selectedSeasonId = next;
            selectedSeasonInitialized = true;
            break;
          }
        } catch {}
      }
    }

    if (!selectedSeasonInitialized && selectedSeasonId == null && state.teamSeasonsLoaded) {
      const defaultSeasonId = resolveDefaultCurrentSeasonId(
        toDateOnlyISO(new Date()),
        sortTeamSeasons(Array.isArray(state.teamSeasons) ? state.teamSeasons : [])
      );
      selectedSeasonId = defaultSeasonId;
      selectedSeasonInitialized = true;
    }

    setState({
      sharedSelectedTrainingGroupIds: selectedTrainingGroupIds,
      sharedSelectedSeasonId: selectedSeasonId ?? null,
      sharedSelectedSeasonInitialized: selectedSeasonInitialized,
      sharedCoachFiltersLoaded: true,
    });

    await AsyncStorage.multiSet([
      [SHARED_COACH_SELECTED_TRAINING_GROUP_IDS_KEY, JSON.stringify(selectedTrainingGroupIds)],
      [
        SHARED_COACH_SELECTED_SEASON_ID_KEY,
        JSON.stringify({ selectedSeasonId: selectedSeasonId ?? null, initialized: selectedSeasonInitialized }),
      ],
    ]);
  } catch (e) {
    setError(e);
    setState({
      sharedSelectedTrainingGroupIds: [],
      sharedSelectedSeasonId: null,
      sharedSelectedSeasonInitialized: true,
      sharedCoachFiltersLoaded: true,
    });
  }
  })();
  inFlightSharedCoachFiltersByKey.set(inFlightKey, promise);
  try {
    await promise;
  } finally {
    inFlightSharedCoachFiltersByKey.delete(inFlightKey);
  }
}

async function setSharedSelectedTrainingGroupIds(ids: string[]) {
  const next = sanitizeStringArray(ids);
  setState({ sharedSelectedTrainingGroupIds: next, sharedCoachFiltersLoaded: true });
  try {
    await AsyncStorage.setItem(
      SHARED_COACH_SELECTED_TRAINING_GROUP_IDS_KEY,
      JSON.stringify(next)
    );
  } catch {}
}

async function setSharedSelectedSeasonId(id: string | null) {
  const next = String(id ?? "").trim() || null;
  setState({
    sharedSelectedSeasonId: next,
    sharedSelectedSeasonInitialized: true,
    sharedCoachFiltersLoaded: true,
  });
  try {
    await AsyncStorage.setItem(
      SHARED_COACH_SELECTED_SEASON_ID_KEY,
      JSON.stringify({ selectedSeasonId: next, initialized: true })
    );
  } catch {}
}

async function clearSharedCoachFilters() {
  setState({
    sharedSelectedTrainingGroupIds: [],
    sharedSelectedSeasonId: null,
    sharedSelectedSeasonInitialized: true,
    sharedCoachFiltersLoaded: true,
  });
  try {
    await AsyncStorage.multiSet([
      [SHARED_COACH_SELECTED_TRAINING_GROUP_IDS_KEY, JSON.stringify([])],
      [SHARED_COACH_SELECTED_SEASON_ID_KEY, JSON.stringify({ selectedSeasonId: null, initialized: true })],
    ]);
  } catch {}
}

// ---------- roster ----------
async function refreshRoster(opts?: { force?: boolean; throwOnError?: boolean }) {
  const force = !!opts?.force;
  const throwOnError = !!opts?.throwOnError;
  const preflightKey = teamScopedLoadKey("roster");
  if (!force && state.rosterLoaded && Date.now() - (lastRosterRefreshByTeamKey[preflightKey] ?? 0) < ROSTER_REFRESH_TTL_MS) {
    return;
  }
  const inFlightKey = teamScopedLoadKey(force ? "roster:force" : "roster");
  const existing = inFlightRosterRefreshByKey.get(inFlightKey);
  if (existing) return existing;
  const promise = (async () => {
  incLoading();
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) {
      setState({ roster: [], rosterLoaded: true });
      return;
    }

    const { data, error } = await supabase
      .from("team_athletes")
      .select("id, team_id, display_name, email, claimed_user_id, first_name, last_name, roster_status, left_at, team_start_date, team_end_date")
      .eq("team_id", teamId)
      .order("last_name", { ascending: true, nullsFirst: true })
      .order("first_name", { ascending: true, nullsFirst: true });

    if (error) throw error;

    const nextRoster = (data ?? []) as TeamAthlete[];
    setState({ roster: nextRoster, rosterLoaded: true, lastError: null });
    if (teamId) {
      void persistRosterCacheForTeam(teamId, nextRoster);
    }
    lastRosterRefreshByTeamKey[teamScopedLoadKey("roster")] = Date.now();
  } catch (e) {
    setError(e);
    if (throwOnError) throw e;
  } finally {
    decLoading();
  }
  })();
  inFlightRosterRefreshByKey.set(inFlightKey, promise);
  try {
    await promise;
  } finally {
    inFlightRosterRefreshByKey.delete(inFlightKey);
  }
}

function getAthleteById(id: string) {
  return state.roster.find((a) => a.id === id) ?? null;
}

function getActiveRoster() {
  return state.roster.filter((athlete) => isAthleteActive(athlete));
}

function getInactiveRoster() {
  return state.roster.filter((athlete) => !isAthleteActive(athlete));
}

async function updateAthlete(
  athleteId: string,
  patch: {
    first_name?: string | null;
    last_name?: string | null;
    display_name?: string;
    email?: string | null;
    team_start_date?: string | null;
    team_end_date?: string | null;
  }
) {
  incLoading();
  const prevRoster = state.roster;
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) throw new Error("No team selected.");

    const nextRoster = state.roster.map((a) => (a.id === athleteId ? { ...a, ...patch } : a));

    // optimistic patch
    setState({
      roster: nextRoster,
    });

    const update: {
      first_name?: string | null;
      last_name?: string | null;
      display_name?: string;
      email?: string | null;
      team_start_date?: string | null;
      team_end_date?: string | null;
    } = {};
    if ("first_name" in patch) update.first_name = patch.first_name?.trim() || null;
    if ("last_name" in patch) update.last_name = patch.last_name?.trim() || null;
    if (typeof patch.display_name === "string") update.display_name = patch.display_name;
    if ("email" in patch) update.email = patch.email ?? null;
    if ("team_start_date" in patch) update.team_start_date = patch.team_start_date ?? null;
    if ("team_end_date" in patch) update.team_end_date = patch.team_end_date ?? null;

    const { error } = await supabase
      .from("team_athletes")
      .update(update)
      .eq("team_id", teamId)
      .eq("id", athleteId);

    if (error) throw error;

    if (teamId) {
      void persistRosterCacheForTeam(teamId, nextRoster);
    }
    setState({ lastError: null });
  } catch (e) {
    setState({ roster: prevRoster });
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

// DESTRUCTIVE legacy path: hard-deletes team_athletes rows and should never be used
// for normal roster removal. Prefer setAthleteRosterStatus for non-destructive changes.
async function hardDeleteAthleteUnsafe(athleteId: string) {
  incLoading();
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) throw new Error("No team selected.");

    // optimistic remove from roster
    setState({ roster: state.roster.filter((a) => a.id !== athleteId) });

    const { error } = await supabase
      .from("team_athletes")
      .delete()
      .eq("team_id", teamId)
      .eq("id", athleteId);

    if (error) throw error;

    setState({ lastError: null });
  } catch (e) {
    setError(e);
    await refreshRoster();
  } finally {
    decLoading();
  }
}

async function setAthleteRosterStatus(athleteId: string, rosterStatus: TeamAthleteRosterStatus) {
  incLoading();
  const prevRoster = state.roster;
  const nowIso = rosterStatus === "active" ? null : new Date().toISOString();
  const todayISO = toDateOnlyISO(new Date());
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) throw new Error("No team selected.");

    const currentAthlete = state.roster.find((athlete) => athlete.id === athleteId) ?? null;
    const shouldSetTeamEndDate = rosterStatus !== "active" && !String(currentAthlete?.team_end_date ?? "").trim();
    const nextRoster = state.roster.map((athlete) =>
      athlete.id === athleteId
        ? {
            ...athlete,
            roster_status: rosterStatus,
            left_at: nowIso,
            ...(shouldSetTeamEndDate ? { team_end_date: todayISO } : null),
          }
        : athlete
    );

    setState({
      roster: nextRoster,
    });

    const updatePayload: {
      roster_status: TeamAthleteRosterStatus;
      left_at: string | null;
      team_end_date?: string;
    } = {
      roster_status: rosterStatus,
      left_at: nowIso,
    };
    if (shouldSetTeamEndDate) updatePayload.team_end_date = todayISO;

    const { error } = await supabase
      .from("team_athletes")
      .update(updatePayload)
      .eq("team_id", teamId)
      .eq("id", athleteId);

    if (error) throw error;

    if (teamId) {
      void persistRosterCacheForTeam(teamId, nextRoster);
    }
    setState({ lastError: null });
  } catch (e) {
    setState({ roster: prevRoster });
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

// ---------- mileage (by week) ----------
function getPendingCellsForWeek(weekStartISO: string): TeamMileageCellRow[] {
  return state.mileagePendingCellsByWeek[weekStartISO] ?? [];
}

function getPendingFlagsForWeek(weekStartISO: string): MileageDayFlagRow[] {
  return state.mileagePendingFlagsByWeek[weekStartISO] ?? [];
}

function markMileageCellPending(weekStartISO: string, row: TeamMileageCellRow) {
  const prevWeekRows = getPendingCellsForWeek(weekStartISO);
  const nextWeekRows = upsertByIdentity(prevWeekRows, row, mileageCellIdentity);
  const nextPendingCellsByWeek = {
    ...state.mileagePendingCellsByWeek,
    [weekStartISO]: nextWeekRows,
  };
  setState({ mileagePendingCellsByWeek: nextPendingCellsByWeek });
  if (state.teamId) {
    schedulePersistMileagePendingForTeam(state.teamId, nextPendingCellsByWeek, state.mileagePendingFlagsByWeek);
  }
}

function clearMileageCellPending(weekStartISO: string, row: TeamMileageCellRow) {
  const prevWeekRows = getPendingCellsForWeek(weekStartISO);
  const nextWeekRows = removeByIdentity(prevWeekRows, row, mileageCellIdentity);
  const nextPendingCellsByWeek: MileageCellPendingByWeek = { ...state.mileagePendingCellsByWeek };
  if (nextWeekRows.length > 0) nextPendingCellsByWeek[weekStartISO] = nextWeekRows;
  else delete nextPendingCellsByWeek[weekStartISO];
  setState({ mileagePendingCellsByWeek: nextPendingCellsByWeek });
  if (state.teamId) {
    schedulePersistMileagePendingForTeam(state.teamId, nextPendingCellsByWeek, state.mileagePendingFlagsByWeek);
  }
}

function markMileageFlagPending(weekStartISO: string, row: MileageDayFlagRow) {
  const prevWeekRows = getPendingFlagsForWeek(weekStartISO);
  const nextWeekRows = upsertByIdentity(prevWeekRows, row, mileageFlagIdentity);
  const nextPendingFlagsByWeek = {
    ...state.mileagePendingFlagsByWeek,
    [weekStartISO]: nextWeekRows,
  };
  setState({ mileagePendingFlagsByWeek: nextPendingFlagsByWeek });
  if (state.teamId) {
    schedulePersistMileagePendingForTeam(state.teamId, state.mileagePendingCellsByWeek, nextPendingFlagsByWeek);
  }
}

function clearMileageFlagPending(weekStartISO: string, row: MileageDayFlagRow) {
  const prevWeekRows = getPendingFlagsForWeek(weekStartISO);
  const nextWeekRows = removeByIdentity(prevWeekRows, row, mileageFlagIdentity);
  const nextPendingFlagsByWeek: MileageFlagPendingByWeek = { ...state.mileagePendingFlagsByWeek };
  if (nextWeekRows.length > 0) nextPendingFlagsByWeek[weekStartISO] = nextWeekRows;
  else delete nextPendingFlagsByWeek[weekStartISO];
  setState({ mileagePendingFlagsByWeek: nextPendingFlagsByWeek });
  if (state.teamId) {
    schedulePersistMileagePendingForTeam(state.teamId, state.mileagePendingCellsByWeek, nextPendingFlagsByWeek);
  }
}

function clearStaleMileagePendingAgainstCloud(
  weekStartISO: string,
  cloudCells: TeamMileageCellRow[],
  cloudFlags: MileageDayFlagRow[]
) {
  const cloudCellById = new Map(cloudCells.map((row) => [mileageCellIdentity(row), row] as const));
  const cloudFlagById = new Map(cloudFlags.map((row) => [mileageFlagIdentity(row), row] as const));
  const pendingCells = getPendingCellsForWeek(weekStartISO);
  const pendingFlags = getPendingFlagsForWeek(weekStartISO);
  const nextPendingCells = pendingCells.filter((row) => {
    const cloudRow = cloudCellById.get(mileageCellIdentity(row));
    return !cloudRow || rowUpdatedAtMs(row) >= rowUpdatedAtMs(cloudRow);
  });
  const nextPendingFlags = pendingFlags.filter((row) => {
    const cloudRow = cloudFlagById.get(mileageFlagIdentity(row));
    return !cloudRow || rowUpdatedAtMs(row) >= rowUpdatedAtMs(cloudRow);
  });
  if (nextPendingCells.length === pendingCells.length && nextPendingFlags.length === pendingFlags.length) return;

  const nextPendingCellsByWeek: MileageCellPendingByWeek = { ...state.mileagePendingCellsByWeek };
  const nextPendingFlagsByWeek: MileageFlagPendingByWeek = { ...state.mileagePendingFlagsByWeek };
  if (nextPendingCells.length > 0) nextPendingCellsByWeek[weekStartISO] = nextPendingCells;
  else delete nextPendingCellsByWeek[weekStartISO];
  if (nextPendingFlags.length > 0) nextPendingFlagsByWeek[weekStartISO] = nextPendingFlags;
  else delete nextPendingFlagsByWeek[weekStartISO];

  setState({
    mileagePendingCellsByWeek: nextPendingCellsByWeek,
    mileagePendingFlagsByWeek: nextPendingFlagsByWeek,
  });
  if (state.teamId) {
    schedulePersistMileagePendingForTeam(state.teamId, nextPendingCellsByWeek, nextPendingFlagsByWeek);
  }
}

async function resetForContextSwitch(nextTeamId: string | null) {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? state.userId ?? null;
  if (pendingPersistTimer) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = null;
  }
  lastVerifiedTeamContext = { userId, teamId: nextTeamId, atMs: 0 };
  lastRosterRefreshByTeamKey = {};
  inFlightRosterRefreshByKey.clear();
  inFlightMileageWeekByKey.clear();
  inFlightVisibleMileageWeekByKey.clear();
  inFlightTrainingGroupsByKey.clear();
  inFlightTeamSeasonsByKey.clear();
  inFlightAthleteSeasonOverridesByKey.clear();
  inFlightSharedCoachFiltersByKey.clear();

  setState({
    ready: true,
    userId,
    teamId: nextTeamId,
    roster: [],
    rosterLoaded: false,
    mileageCellsByWeek: {},
    mileageFlagsByWeek: {},
    mileageLoadedWeeks: {},
    mileagePendingCellsByWeek: {},
    mileagePendingFlagsByWeek: {},
    mileagePendingLoadedForTeamId: null,
    visibleMileageCellsByAthleteWeek: {},
    visibleMileageFlagsByAthleteWeek: {},
    visibleMileageLoadedByAthleteWeek: {},
    workoutsByDay: {},
    workoutsLoadedDays: {},
    trainingGroups: [],
    trainingGroupMemberships: [],
    trainingGroupsLoaded: false,
    teamSeasons: [],
    teamSeasonsLoaded: false,
    athleteSeasonOverrides: [],
    athleteSeasonOverridesLoaded: false,
    sharedSelectedTrainingGroupIds: [],
    sharedSelectedSeasonId: null,
    sharedSelectedSeasonInitialized: false,
    sharedCoachFiltersLoaded: false,
    loadingCount: 0,
    lastError: null,
  });

  if (userId) {
    await persistCachedTeamIdForUser(userId, nextTeamId);
  }
}

async function flushPendingMileageWeek(weekStartISO: string): Promise<void> {
  const pendingCellsSnapshot = [...getPendingCellsForWeek(weekStartISO)];
  const pendingFlagsSnapshot = [...getPendingFlagsForWeek(weekStartISO)];

  if (pendingCellsSnapshot.length === 0 && pendingFlagsSnapshot.length === 0) return;

  const cellResults = await Promise.all(
    pendingCellsSnapshot.map(async (row) => {
      try {
        await upsertMileageCell(
          row.athlete_profile_id,
          row.week_start_iso,
          row.day_idx,
          row.session,
          row.value
        );
        return { ok: true as const, row };
      } catch {
        return { ok: false as const, row };
      }
    })
  );

  const flagResults = await Promise.all(
    pendingFlagsSnapshot.map(async (row) => {
      try {
        await upsertMileageDayFlag(
          row.athlete_profile_id,
          row.week_start_iso,
          row.day_idx,
          row.ncaa_off
        );
        return { ok: true as const, row };
      } catch {
        return { ok: false as const, row };
      }
    })
  );

  const failedCells = cellResults.filter((r) => !r.ok).map((r) => r.row);
  const failedFlags = flagResults.filter((r) => !r.ok).map((r) => r.row);

  const snapshotCellIds = new Set(pendingCellsSnapshot.map((row) => mileageCellIdentity(row)));
  const snapshotFlagIds = new Set(pendingFlagsSnapshot.map((row) => mileageFlagIdentity(row)));

  const cellsAddedDuringFlush = getPendingCellsForWeek(weekStartISO).filter(
    (row) => !snapshotCellIds.has(mileageCellIdentity(row))
  );
  const flagsAddedDuringFlush = getPendingFlagsForWeek(weekStartISO).filter(
    (row) => !snapshotFlagIds.has(mileageFlagIdentity(row))
  );

  const nextWeekPendingCells = mergeRowsByIdentity(failedCells, cellsAddedDuringFlush, mileageCellIdentity);
  const nextWeekPendingFlags = mergeRowsByIdentity(failedFlags, flagsAddedDuringFlush, mileageFlagIdentity);

  const nextPendingCellsByWeek: MileageCellPendingByWeek = { ...state.mileagePendingCellsByWeek };
  const nextPendingFlagsByWeek: MileageFlagPendingByWeek = { ...state.mileagePendingFlagsByWeek };

  if (nextWeekPendingCells.length > 0) nextPendingCellsByWeek[weekStartISO] = nextWeekPendingCells;
  else delete nextPendingCellsByWeek[weekStartISO];

  if (nextWeekPendingFlags.length > 0) nextPendingFlagsByWeek[weekStartISO] = nextWeekPendingFlags;
  else delete nextPendingFlagsByWeek[weekStartISO];

  setState({
    mileagePendingCellsByWeek: nextPendingCellsByWeek,
    mileagePendingFlagsByWeek: nextPendingFlagsByWeek,
  });

  if (state.teamId) {
    schedulePersistMileagePendingForTeam(state.teamId, nextPendingCellsByWeek, nextPendingFlagsByWeek);
  }
}

function buildMileageWeekStateResult(weekStartISO: string): MileageWeekLoadResult {
  return {
    weekStartISO,
    cells: mergeRowsByIdentityPreferLatest(
      state.mileageCellsByWeek[weekStartISO] ?? [],
      getPendingCellsForWeek(weekStartISO),
      mileageCellIdentity
    ) as TeamMileageCellRow[],
    flags: mergeRowsByIdentityPreferLatest(
      state.mileageFlagsByWeek[weekStartISO] ?? [],
      getPendingFlagsForWeek(weekStartISO),
      mileageFlagIdentity
    ) as MileageDayFlagRow[],
  };
}

async function loadMileageWeekSnapshot(weekStartISO: string, force = false): Promise<MileageWeekLoadResult> {
  const cleanWeekStartISO = String(weekStartISO ?? "").trim();
  if (!cleanWeekStartISO) return { weekStartISO: cleanWeekStartISO, cells: [], flags: [] };
  const inFlightKey = teamScopedLoadKey(`mileage-week:${cleanWeekStartISO}:${force ? "force" : "normal"}`);
  const existing = inFlightMileageWeekByKey.get(inFlightKey);
  if (existing) return existing;
  const promise = (async () => {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) {
      return { weekStartISO: cleanWeekStartISO, cells: [], flags: [] };
    }

    if (!force && state.mileageLoadedWeeks[cleanWeekStartISO]) {
      return buildMileageWeekStateResult(cleanWeekStartISO);
    }

    const [cells, flags] = await Promise.all([
      fetchMileageCellsForWeek(cleanWeekStartISO),
      fetchMileageDayFlagsForWeek(cleanWeekStartISO),
    ]);

    clearStaleMileagePendingAgainstCloud(
      cleanWeekStartISO,
      (cells ?? []) as TeamMileageCellRow[],
      (flags ?? []) as MileageDayFlagRow[]
    );
    void flushPendingMileageWeek(cleanWeekStartISO);

    const mergedCells = mergeRowsByIdentityPreferLatest(
      (cells ?? []) as TeamMileageCellRow[],
      getPendingCellsForWeek(cleanWeekStartISO),
      mileageCellIdentity
    );
    const mergedFlags = mergeRowsByIdentityPreferLatest(
      (flags ?? []) as MileageDayFlagRow[],
      getPendingFlagsForWeek(cleanWeekStartISO),
      mileageFlagIdentity
    );

    return {
      weekStartISO: cleanWeekStartISO,
      cells: mergedCells as TeamMileageCellRow[],
      flags: mergedFlags as MileageDayFlagRow[],
    };
  })();
  inFlightMileageWeekByKey.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightMileageWeekByKey.get(inFlightKey) === promise) {
      inFlightMileageWeekByKey.delete(inFlightKey);
    }
  }
}

async function loadMileageWeek(weekStartISO: string, force = false, opts?: { throwOnError?: boolean }) {
  const cleanWeekStartISO = String(weekStartISO ?? "").trim();
  if (!cleanWeekStartISO) return;
  incLoading();
  try {
    const result = await loadMileageWeekSnapshot(cleanWeekStartISO, force);
    setState({
      mileageCellsByWeek: { ...state.mileageCellsByWeek, [cleanWeekStartISO]: result.cells },
      mileageFlagsByWeek: { ...state.mileageFlagsByWeek, [cleanWeekStartISO]: result.flags },
      mileageLoadedWeeks: { ...state.mileageLoadedWeeks, [cleanWeekStartISO]: true },
      lastError: null,
    });
  } catch (e) {
    setError(e);
    const pendingCells = getPendingCellsForWeek(cleanWeekStartISO);
    const pendingFlags = getPendingFlagsForWeek(cleanWeekStartISO);
    if (pendingCells.length > 0 || pendingFlags.length > 0) {
      const fallback = buildMileageWeekStateResult(cleanWeekStartISO);
      setState({
        mileageCellsByWeek: { ...state.mileageCellsByWeek, [cleanWeekStartISO]: fallback.cells },
        mileageFlagsByWeek: { ...state.mileageFlagsByWeek, [cleanWeekStartISO]: fallback.flags },
        mileageLoadedWeeks: { ...state.mileageLoadedWeeks, [cleanWeekStartISO]: true },
      });
    }
    if (opts?.throwOnError) throw e;
  } finally {
    decLoading();
  }
}

async function loadVisibleMileageWeekForAthlete(athleteProfileId: string, weekStartISO: string, force = false) {
  const cleanAthleteId = String(athleteProfileId ?? "").trim();
  const cleanWeekStartISO = String(weekStartISO ?? "").trim();
  if (!cleanAthleteId || !cleanWeekStartISO) return;
  const cacheKey = visibleMileageAthleteWeekKey(cleanAthleteId, cleanWeekStartISO);
  const inFlightKey = teamScopedLoadKey(`visible-mileage-week:${cacheKey}:${force ? "force" : "normal"}`);
  const existing = inFlightVisibleMileageWeekByKey.get(inFlightKey);
  if (existing) {
    const result = await existing;
    setState({
      visibleMileageCellsByAthleteWeek: { ...state.visibleMileageCellsByAthleteWeek, [cacheKey]: result.cells },
      visibleMileageFlagsByAthleteWeek: { ...state.visibleMileageFlagsByAthleteWeek, [cacheKey]: result.flags },
      visibleMileageLoadedByAthleteWeek: { ...state.visibleMileageLoadedByAthleteWeek, [cacheKey]: true },
      lastError: null,
    });
    return;
  }

  incLoading();
  const promise = (async (): Promise<MileageWeekLoadResult> => {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) return { weekStartISO: cleanWeekStartISO, cells: [], flags: [] };
    if (!force && state.visibleMileageLoadedByAthleteWeek[cacheKey]) {
      return {
        weekStartISO: cleanWeekStartISO,
        cells: state.visibleMileageCellsByAthleteWeek[cacheKey] ?? [],
        flags: state.visibleMileageFlagsByAthleteWeek[cacheKey] ?? [],
      };
    }

    const [cells, flags] = await Promise.all([
      fetchVisibleMileageCellsForAthleteWeek(teamId, cleanAthleteId, cleanWeekStartISO),
      fetchVisibleMileageDayFlagsForAthleteWeek(teamId, cleanAthleteId, cleanWeekStartISO),
    ]);

    return {
      weekStartISO: cleanWeekStartISO,
      cells: (cells ?? []) as TeamMileageCellRow[],
      flags: (flags ?? []) as MileageDayFlagRow[],
    };
  })();

  inFlightVisibleMileageWeekByKey.set(inFlightKey, promise);
  try {
    const result = await promise;
    setState({
      visibleMileageCellsByAthleteWeek: { ...state.visibleMileageCellsByAthleteWeek, [cacheKey]: result.cells },
      visibleMileageFlagsByAthleteWeek: { ...state.visibleMileageFlagsByAthleteWeek, [cacheKey]: result.flags },
      visibleMileageLoadedByAthleteWeek: { ...state.visibleMileageLoadedByAthleteWeek, [cacheKey]: true },
      lastError: null,
    });
  } catch (e) {
    setError(e);
  } finally {
    if (inFlightVisibleMileageWeekByKey.get(inFlightKey) === promise) {
      inFlightVisibleMileageWeekByKey.delete(inFlightKey);
    }
    decLoading();
  }
}

async function loadMileageWeeks(weekStartISOs: string[], force = false, opts?: { throwOnError?: boolean }) {
  const cleanWeekStartISOs = Array.from(
    new Set((Array.isArray(weekStartISOs) ? weekStartISOs : []).map((week) => String(week ?? "").trim()).filter(Boolean))
  );
  if (cleanWeekStartISOs.length === 0) return;
  incLoading();
  try {
    const results = await Promise.all(
      cleanWeekStartISOs.map(async (weekStartISO) => {
        try {
          return { ok: true as const, result: await loadMileageWeekSnapshot(weekStartISO, force) };
        } catch (error) {
          return { ok: false as const, weekStartISO, error };
        }
      })
    );

    const nextCellsByWeek = { ...state.mileageCellsByWeek };
    const nextFlagsByWeek = { ...state.mileageFlagsByWeek };
    const nextLoadedWeeks = { ...state.mileageLoadedWeeks };
    let firstError: unknown = null;

    for (const item of results) {
      if (item.ok) {
        nextCellsByWeek[item.result.weekStartISO] = item.result.cells;
        nextFlagsByWeek[item.result.weekStartISO] = item.result.flags;
        nextLoadedWeeks[item.result.weekStartISO] = true;
      } else {
        if (!firstError) firstError = item.error;
        const pendingCells = getPendingCellsForWeek(item.weekStartISO);
        const pendingFlags = getPendingFlagsForWeek(item.weekStartISO);
        if (pendingCells.length > 0 || pendingFlags.length > 0) {
          const fallback = buildMileageWeekStateResult(item.weekStartISO);
          nextCellsByWeek[item.weekStartISO] = fallback.cells;
          nextFlagsByWeek[item.weekStartISO] = fallback.flags;
          nextLoadedWeeks[item.weekStartISO] = true;
        }
      }
    }

    const lastError =
      firstError && typeof firstError === "object" && "message" in firstError
        ? String((firstError as any).message)
        : firstError
          ? "Unknown error"
          : null;
    setState({
      mileageCellsByWeek: nextCellsByWeek,
      mileageFlagsByWeek: nextFlagsByWeek,
      mileageLoadedWeeks: nextLoadedWeeks,
      lastError,
    });
    if (firstError && opts?.throwOnError) throw firstError;
  } finally {
    decLoading();
  }
}

function upsertCellLocal(weekStartISO: string, row: TeamMileageCellRow) {
  const prev = state.mileageCellsByWeek[weekStartISO] ?? [];
  const next = prev.filter(
    (r) =>
      !(
        r.athlete_profile_id === row.athlete_profile_id &&
        r.week_start_iso === row.week_start_iso &&
        r.day_idx === row.day_idx &&
        r.session === row.session
      )
  );
  next.push(row);
  setState({ mileageCellsByWeek: { ...state.mileageCellsByWeek, [weekStartISO]: next } });
}

function upsertFlagLocal(weekStartISO: string, row: MileageDayFlagRow) {
  const prev = state.mileageFlagsByWeek[weekStartISO] ?? [];
  const next = prev.filter(
    (r) =>
      !(
        r.athlete_profile_id === row.athlete_profile_id &&
        r.week_start_iso === row.week_start_iso &&
        r.day_idx === row.day_idx
      )
  );
  next.push(row);
  setState({ mileageFlagsByWeek: { ...state.mileageFlagsByWeek, [weekStartISO]: next } });
}

async function setMileageCell(
  athleteProfileId: string,
  weekStartISO: string,
  dayIdx: number,
  session: "AM" | "PM",
  value: any
) {
  const updatedAt = new Date().toISOString();
  const row: TeamMileageCellRow = {
    athlete_profile_id: athleteProfileId,
    week_start_iso: weekStartISO,
    day_idx: dayIdx,
    session,
    value,
    updated_at: updatedAt,
  };
  // optimistic local write first
  upsertCellLocal(weekStartISO, row);
  markMileageCellPending(weekStartISO, row);

  try {
    await upsertMileageCell(athleteProfileId, weekStartISO, dayIdx, session, value);
    clearMileageCellPending(weekStartISO, row);
    setState({ lastError: null });
  } catch (e) {
    setError(e);
    // Keep local-first pending value; retry on next load/sync attempt.
  }
}

async function setMileageOffFlag(
  athleteProfileId: string,
  weekStartISO: string,
  dayIdx: number,
  ncaaOff: boolean
) {
  const updatedAt = new Date().toISOString();
  const row: MileageDayFlagRow = {
    athlete_profile_id: athleteProfileId,
    week_start_iso: weekStartISO,
    day_idx: dayIdx,
    ncaa_off: ncaaOff,
    updated_at: updatedAt,
  };
  // optimistic local write first
  upsertFlagLocal(weekStartISO, row);
  markMileageFlagPending(weekStartISO, row);

  try {
    await upsertMileageDayFlag(athleteProfileId, weekStartISO, dayIdx, ncaaOff);
    clearMileageFlagPending(weekStartISO, row);
    setState({ lastError: null });
  } catch (e) {
    setError(e);
    // Keep local-first pending value; retry on next load/sync attempt.
  }
}

// ---------- workouts (by day) ----------
async function loadWorkoutsForDay(dateISO: string, force = false) {
  incLoading();
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) {
      setState({
        workoutsByDay: { ...state.workoutsByDay, [dateISO]: [] },
        workoutsLoadedDays: { ...state.workoutsLoadedDays, [dateISO]: true },
      });
      return;
    }

    if (!force && state.workoutsLoadedDays[dateISO]) return;

    const rows = await listTeamWorkoutsInRange(dateISO, dateISO);

    setState({
      workoutsByDay: { ...state.workoutsByDay, [dateISO]: (rows ?? []) as any },
      workoutsLoadedDays: { ...state.workoutsLoadedDays, [dateISO]: true },
      lastError: null,
    });
  } catch (e) {
    setError(e);
  } finally {
    decLoading();
  }
}

// ---------- training groups ----------
async function loadTrainingGroups(force = false) {
  const inFlightKey = teamScopedLoadKey(force ? "training-groups:force" : "training-groups");
  const existing = inFlightTrainingGroupsByKey.get(inFlightKey);
  if (existing) return existing;
  const promise = (async () => {
  incLoading();
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) {
      setState({ trainingGroups: [], trainingGroupMemberships: [], trainingGroupsLoaded: true });
      return;
    }
    if (!force && state.trainingGroupsLoaded) return;
    const [groups, memberships] = await Promise.all([
      listTrainingGroups(),
      listTrainingGroupMemberships(),
    ]);
    setState({
      trainingGroups: sortTrainingGroupsByName(Array.isArray(groups) ? groups : []),
      trainingGroupMemberships: Array.isArray(memberships) ? memberships : [],
      trainingGroupsLoaded: true,
      lastError: null,
    });
  } catch (e) {
    setError(e);
  } finally {
    decLoading();
  }
  })();
  inFlightTrainingGroupsByKey.set(inFlightKey, promise);
  try {
    await promise;
  } finally {
    inFlightTrainingGroupsByKey.delete(inFlightKey);
  }
}

// ---------- seasons ----------
function sortTeamSeasons(rows: TeamSeason[]): TeamSeason[] {
  return sortSeasonsForDisplay(rows);
}

async function loadTeamSeasons(force = false) {
  const inFlightKey = teamScopedLoadKey(force ? "team-seasons:force" : "team-seasons");
  const existing = inFlightTeamSeasonsByKey.get(inFlightKey);
  if (existing) return existing;
  const promise = (async () => {
  incLoading();
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) {
      setState({ teamSeasons: [], teamSeasonsLoaded: true });
      return;
    }
    if (!force && state.teamSeasonsLoaded) return;
    const rows = await listTeamSeasons();
    const sortedSeasons = sortTeamSeasons(Array.isArray(rows) ? rows : []);
    setState({
      teamSeasons: sortedSeasons,
      teamSeasonsLoaded: true,
      lastError: null,
    });

    const selectedSeasonId = String(state.sharedSelectedSeasonId ?? "").trim();
    const hasSelectedSeason = !!selectedSeasonId;
    const selectedStillExists = hasSelectedSeason
      ? sortedSeasons.some((season) => String(season?.id ?? "").trim() === selectedSeasonId)
      : true;

    if (!state.sharedSelectedSeasonInitialized) {
      const defaultSeasonId = resolveDefaultCurrentSeasonId(toDateOnlyISO(new Date()), sortedSeasons);
      if (defaultSeasonId || state.sharedSelectedSeasonId !== defaultSeasonId) {
        await setSharedSelectedSeasonId(defaultSeasonId);
      }
    } else if (hasSelectedSeason && !selectedStillExists) {
      const defaultSeasonId = resolveDefaultCurrentSeasonId(toDateOnlyISO(new Date()), sortedSeasons);
      await setSharedSelectedSeasonId(defaultSeasonId);
    }
  } catch (e) {
    setError(e);
  } finally {
    decLoading();
  }
  })();
  inFlightTeamSeasonsByKey.set(inFlightKey, promise);
  try {
    await promise;
  } finally {
    inFlightTeamSeasonsByKey.delete(inFlightKey);
  }
}

function resolveAthleteSeasonWindow(
  season: TeamSeason,
  override: TeamAthleteSeasonOverride | null | undefined
): { start_date: string; end_date: string } {
  return {
    start_date: String(override?.start_date ?? season.start_date ?? ""),
    end_date: String(override?.end_date ?? season.end_date ?? ""),
  };
}

function isDateOnlyISO(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function defaultPriorSeasonIdsForTeamStartDate(teamStartDate: string, seasons: TeamSeason[]): string[] {
  const startDate = String(teamStartDate ?? "").trim();
  if (!isDateOnlyISO(startDate)) return [];
  const sorted = [...(Array.isArray(seasons) ? seasons : [])]
    .filter((season) => !season?.archived_at)
    .filter((season) => isDateOnlyISO(String(season?.start_date ?? "")) && isDateOnlyISO(String(season?.end_date ?? "")))
    .sort((a, b) =>
      String(a.start_date ?? "").localeCompare(String(b.start_date ?? "")) ||
      String(a.end_date ?? "").localeCompare(String(b.end_date ?? "")) ||
      String(a.name ?? "").localeCompare(String(b.name ?? ""))
    );
  const containingIndex = sorted.findIndex(
    (season) => String(season.start_date ?? "") <= startDate && String(season.end_date ?? "") >= startDate
  );
  const priorSeasons = containingIndex >= 0
    ? sorted.slice(0, containingIndex)
    : sorted.filter((season) => String(season.end_date ?? "") < startDate);
  return priorSeasons.map((season) => String(season.id ?? "").trim()).filter(Boolean);
}

async function loadAthleteSeasonOverrides(force = false) {
  const inFlightKey = teamScopedLoadKey(force ? "athlete-season-overrides:force" : "athlete-season-overrides");
  const existing = inFlightAthleteSeasonOverridesByKey.get(inFlightKey);
  if (existing) return existing;
  const promise = (async () => {
  incLoading();
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) {
      setState({ athleteSeasonOverrides: [], athleteSeasonOverridesLoaded: true });
      return;
    }
    if (!force && state.athleteSeasonOverridesLoaded) return;
    const rows = await listTeamAthleteSeasonOverrides();
    setState({
      athleteSeasonOverrides: Array.isArray(rows) ? rows : [],
      athleteSeasonOverridesLoaded: true,
      lastError: null,
    });
  } catch (e) {
    setError(e);
  } finally {
    decLoading();
  }
  })();
  inFlightAthleteSeasonOverridesByKey.set(inFlightKey, promise);
  try {
    await promise;
  } finally {
    inFlightAthleteSeasonOverridesByKey.delete(inFlightKey);
  }
}

async function upsertAthleteSeasonOverrideInStore(input: {
  season_id: string;
  athlete_profile_id: string;
  start_date?: string | null;
  end_date?: string | null;
  is_excluded?: boolean;
  excluded_at?: string | null;
}) {
  incLoading();
  try {
    const saved = await upsertAthleteSeasonOverride(input);
    const keySeason = String(saved.season_id ?? "").trim();
    const keyAthlete = String(saved.athlete_profile_id ?? "").trim();
    const next = state.athleteSeasonOverrides.filter(
      (row) =>
        !(
          String(row.season_id ?? "").trim() === keySeason &&
          String(row.athlete_profile_id ?? "").trim() === keyAthlete
        )
    );
    next.push(saved);
    setState({
      athleteSeasonOverrides: next,
      athleteSeasonOverridesLoaded: true,
      lastError: null,
    });
    return saved;
  } catch (e) {
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

async function clearAthleteSeasonOverrideInStore(seasonId: string, athleteProfileId: string) {
  incLoading();
  try {
    await clearAthleteSeasonOverride(seasonId, athleteProfileId);
    setState({
      athleteSeasonOverrides: state.athleteSeasonOverrides.filter(
        (row) =>
          !(
            String(row.season_id ?? "").trim() === String(seasonId ?? "").trim() &&
            String(row.athlete_profile_id ?? "").trim() === String(athleteProfileId ?? "").trim()
          )
      ),
      athleteSeasonOverridesLoaded: true,
      lastError: null,
    });
  } catch (e) {
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

async function applyDefaultPriorSeasonExclusionsForAthlete(athleteProfileId: string, teamStartDate: string | null | undefined) {
  const cleanAthleteId = String(athleteProfileId ?? "").trim();
  const cleanStartDate = String(teamStartDate ?? "").trim();
  if (!cleanAthleteId || !isDateOnlyISO(cleanStartDate)) return { added: 0 };

  await loadTeamSeasons(false);
  await loadAthleteSeasonOverrides(false);

  const priorSeasonIds = defaultPriorSeasonIdsForTeamStartDate(cleanStartDate, state.teamSeasons);
  if (priorSeasonIds.length === 0) return { added: 0 };
  const existingOverrideKeys = new Set(
    (Array.isArray(state.athleteSeasonOverrides) ? state.athleteSeasonOverrides : [])
      .filter((row) => String(row.athlete_profile_id ?? "").trim() === cleanAthleteId)
      .map((row) => String(row.season_id ?? "").trim())
      .filter(Boolean)
  );
  const missingPriorSeasonIds = priorSeasonIds.filter((seasonId) => !existingOverrideKeys.has(seasonId));
  for (const seasonId of missingPriorSeasonIds) {
    await upsertAthleteSeasonOverrideInStore({
      season_id: seasonId,
      athlete_profile_id: cleanAthleteId,
      is_excluded: true,
    });
  }
  return { added: missingPriorSeasonIds.length };
}

async function createTeamSeasonInStore(input: {
  name: string;
  start_date: string;
  end_date: string;
  color?: string | null;
  sort_order?: number | null;
}) {
  incLoading();
  try {
    const created = await createTeamSeason(input);
    setState({
      teamSeasons: sortTeamSeasons([...state.teamSeasons, created]),
      lastError: null,
    });
    return created;
  } catch (e) {
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

async function updateTeamSeasonInStore(
  seasonId: string,
  patch: {
    name?: string;
    start_date?: string;
    end_date?: string;
    color?: string | null;
    sort_order?: number | null;
  }
) {
  incLoading();
  try {
    const updated = await updateTeamSeason(seasonId, patch);
    setState({
      teamSeasons: sortTeamSeasons(state.teamSeasons.map((row) => (row.id === seasonId ? updated : row))),
      lastError: null,
    });
    return updated;
  } catch (e) {
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

async function setTeamSeasonArchivedInStore(seasonId: string, archived: boolean) {
  incLoading();
  try {
    const updated = await setTeamSeasonArchived(seasonId, archived);
    setState({
      teamSeasons: sortTeamSeasons(state.teamSeasons.map((row) => (row.id === seasonId ? updated : row))),
      lastError: null,
    });
    return updated;
  } catch (e) {
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

async function createTrainingGroupInStore(name: string) {
  incLoading();
  try {
    const created = await createTrainingGroup(name);
    setState({
      trainingGroups: sortTrainingGroupsByName([...state.trainingGroups, created]),
      lastError: null,
    });
    return created;
  } catch (e) {
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

async function renameTrainingGroupInStore(groupId: string, name: string) {
  incLoading();
  try {
    const updated = await updateTrainingGroupName(groupId, name);
    setState({
      trainingGroups: sortTrainingGroupsByName(state.trainingGroups.map((row) => (row.id === groupId ? updated : row))),
      lastError: null,
    });
    return updated;
  } catch (e) {
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

async function setTrainingGroupArchivedInStore(groupId: string, archived: boolean) {
  incLoading();
  try {
    const updated = await setTrainingGroupArchived(groupId, archived);
    setState({
      trainingGroups: sortTrainingGroupsByName(state.trainingGroups.map((row) => (row.id === groupId ? updated : row))),
      lastError: null,
    });
    return updated;
  } catch (e) {
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

async function replaceTrainingGroupMembersInStore(groupId: string, athleteProfileIds: string[]) {
  incLoading();
  try {
    console.log("[teamDataStore] replaceTrainingGroupMembers start", {
      groupId,
      selectedAthleteCount: Array.isArray(athleteProfileIds) ? athleteProfileIds.length : 0,
      selectedAthleteSample: Array.isArray(athleteProfileIds) ? athleteProfileIds.slice(0, 10) : [],
    });
    await replaceTrainingGroupActiveMemberships(groupId, athleteProfileIds);
    console.log("[teamDataStore] replaceTrainingGroupMembers cloud step success", { groupId });
    const memberships = await listTrainingGroupMemberships();
    setState({
      trainingGroupMemberships: Array.isArray(memberships) ? memberships : [],
      lastError: null,
    });
    const activeCount = (Array.isArray(memberships) ? memberships : []).filter(
      (row) =>
        String((row as TeamTrainingGroupMembership)?.group_id ?? "").trim() === String(groupId ?? "").trim() &&
        (((row as TeamTrainingGroupMembership)?.ends_on) == null ||
          String((row as TeamTrainingGroupMembership)?.ends_on ?? "").trim() === "")
    ).length;
    console.log("[teamDataStore] replaceTrainingGroupMembers reload success", {
      groupId,
      activeMembershipCount: activeCount,
    });
  } catch (e) {
    console.error("[teamDataStore] replaceTrainingGroupMembers failed", e);
    setError(e);
    throw e;
  } finally {
    decLoading();
  }
}

export const teamDataStore = {
  use: useTeamDataStore,
  getState,
  getAthleteById,
  getActiveRoster,
  getInactiveRoster,
  actions: {
    ensureSessionAndTeam,
    refreshRoster,
    hardDeleteAthleteUnsafe,
    setAthleteRosterStatus,
    updateAthlete,

    loadMileageWeek,
    loadMileageWeeks,
    loadVisibleMileageWeekForAthlete,
    setMileageCell,
    setMileageOffFlag,

    loadWorkoutsForDay,
    loadTrainingGroups,
    loadTeamSeasons,
    loadAthleteSeasonOverrides,
    loadSharedCoachFilters,
    resetForContextSwitch,
    setSharedSelectedTrainingGroupIds,
    setSharedSelectedSeasonId,
    clearSharedCoachFilters,
    createTrainingGroup: createTrainingGroupInStore,
    renameTrainingGroup: renameTrainingGroupInStore,
    setTrainingGroupArchived: setTrainingGroupArchivedInStore,
    replaceTrainingGroupMembers: replaceTrainingGroupMembersInStore,
    createTeamSeason: createTeamSeasonInStore,
    updateTeamSeason: updateTeamSeasonInStore,
    setTeamSeasonArchived: setTeamSeasonArchivedInStore,
    upsertAthleteSeasonOverride: upsertAthleteSeasonOverrideInStore,
    clearAthleteSeasonOverride: clearAthleteSeasonOverrideInStore,
    applyDefaultPriorSeasonExclusionsForAthlete,
  },
  resolveAthleteSeasonWindow,
};
