import { useSyncExternalStore } from "react";
import { supabase } from "./supabase";
import {
  fetchMileageCellsForWeek,
  fetchMileageDayFlagsForWeek,
  upsertMileageCell,
  upsertMileageDayFlag,
} from "./mileageCloud";
import type { TeamWorkoutRow as TeamWorkoutRowBase } from "./teamWorkoutsCloud";

export type TeamAthlete = {
  id: string;
  team_id: string;
  display_name: string;
  email?: string | null;
  claimed_user_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export type TeamMileageCellRow = {
  athlete_profile_id: string;
  week_start_iso: string;
  day_idx: number;
  session: "AM" | "PM";
  value: any;
};

export type MileageDayFlagRow = {
  athlete_profile_id: string;
  week_start_iso: string;
  day_idx: number;
  ncaa_off: boolean;
};

export type TeamWorkoutRow = TeamWorkoutRowBase;

type WeekKey = string; // weekStartISO
type DayKey = string;  // dateISO

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

  // workouts cache (by day)
  workoutsByDay: Record<DayKey, TeamWorkoutRow[]>;
  workoutsLoadedDays: Record<DayKey, boolean>;

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

  workoutsByDay: {},
  workoutsLoadedDays: {},

  loadingCount: 0,
  lastError: null,
};

const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function setState(patch: Partial<StoreState>) { state = { ...state, ...patch }; emit(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
function getSnapshot() { return state; }

function incLoading() { setState({ loadingCount: state.loadingCount + 1 }); }
function decLoading() { setState({ loadingCount: Math.max(0, state.loadingCount - 1) }); }
function setError(e: unknown) {
  const msg = typeof e === "object" && e && "message" in e ? String((e as any).message) : "Unknown error";
  setState({ lastError: msg });
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
      workoutsByDay: {},
      workoutsLoadedDays: {},
    });
    return { userId: null, teamId: null };
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("current_team_id")
    .eq("id", userId)
    .single();

  if (error) throw error;

  const teamId = (profile?.current_team_id as string | null) ?? null;

  setState({ ready: true, userId, teamId });
  return { userId, teamId };
}

// ---------- roster ----------
async function refreshRoster() {
  incLoading();
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) {
      setState({ roster: [], rosterLoaded: true });
      return;
    }

    const { data, error } = await supabase
      .from("team_athletes")
      .select("id, team_id, display_name, email, claimed_user_id, first_name, last_name")
      .eq("team_id", teamId)
      .order("last_name", { ascending: true, nullsFirst: true })
      .order("first_name", { ascending: true, nullsFirst: true });

    if (error) throw error;

    setState({ roster: (data ?? []) as TeamAthlete[], rosterLoaded: true, lastError: null });
  } catch (e) {
    setError(e);
  } finally {
    decLoading();
  }
}

async function deleteAthlete(athleteId: string) {
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

// ---------- mileage (by week) ----------
async function loadMileageWeek(weekStartISO: string, force = false) {
  incLoading();
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) {
      setState({
        mileageCellsByWeek: { ...state.mileageCellsByWeek, [weekStartISO]: [] },
        mileageFlagsByWeek: { ...state.mileageFlagsByWeek, [weekStartISO]: [] },
        mileageLoadedWeeks: { ...state.mileageLoadedWeeks, [weekStartISO]: true },
      });
      return;
    }

    if (!force && state.mileageLoadedWeeks[weekStartISO]) return;

    const [cells, flags] = await Promise.all([
      fetchMileageCellsForWeek(weekStartISO),
      fetchMileageDayFlagsForWeek(weekStartISO),
    ]);

    setState({
      mileageCellsByWeek: { ...state.mileageCellsByWeek, [weekStartISO]: cells as any },
      mileageFlagsByWeek: { ...state.mileageFlagsByWeek, [weekStartISO]: flags as any },
      mileageLoadedWeeks: { ...state.mileageLoadedWeeks, [weekStartISO]: true },
      lastError: null,
    });
  } catch (e) {
    setError(e);
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
  // optimistic local write first
  upsertCellLocal(weekStartISO, {
    athlete_profile_id: athleteProfileId,
    week_start_iso: weekStartISO,
    day_idx: dayIdx,
    session,
    value,
  });

  try {
    await upsertMileageCell(athleteProfileId, weekStartISO, dayIdx, session, value);
  } catch (e) {
    setError(e);
    // reconcile from server (keeps you “no ambiguity”)
    await loadMileageWeek(weekStartISO, true);
  }
}

async function setMileageOffFlag(
  athleteProfileId: string,
  weekStartISO: string,
  dayIdx: number,
  ncaaOff: boolean
) {
  // optimistic local write first
  upsertFlagLocal(weekStartISO, {
    athlete_profile_id: athleteProfileId,
    week_start_iso: weekStartISO,
    day_idx: dayIdx,
    ncaa_off: ncaaOff,
  });

  try {
    await upsertMileageDayFlag(athleteProfileId, weekStartISO, dayIdx, ncaaOff);
  } catch (e) {
    setError(e);
    await loadMileageWeek(weekStartISO, true);
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

    const { data, error } = await supabase
      .from("team_workouts")
      .select("*")
      .eq("team_id", teamId)
      .eq("date_iso", dateISO);

    if (error) throw error;

    setState({
      workoutsByDay: { ...state.workoutsByDay, [dateISO]: (data ?? []) as any },
      workoutsLoadedDays: { ...state.workoutsLoadedDays, [dateISO]: true },
      lastError: null,
    });
  } catch (e) {
    setError(e);
  } finally {
    decLoading();
  }
}

export const teamDataStore = {
  use: useTeamDataStore,
  actions: {
    ensureSessionAndTeam,
    refreshRoster,
    deleteAthlete,

    loadMileageWeek,
    setMileageCell,
    setMileageOffFlag,

    loadWorkoutsForDay,
  },
};
