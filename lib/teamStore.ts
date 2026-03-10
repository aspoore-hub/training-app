import { useSyncExternalStore } from "react";
import { supabase } from "./supabase";

// --- Types you can expand later ---
export type TeamAthlete = {
  id: string;
  team_id: string;
  display_name: string;
  email?: string | null;
  claimed_user_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

type TeamStoreState = {
  // Identity / session
  ready: boolean;              // store has attempted initialization
  userId: string | null;
  teamId: string | null;
  teamIdLoaded: boolean;

  // Roster
  roster: TeamAthlete[];
  rosterLoaded: boolean;
  rosterLastFetchedAt: number;

  // UI / status
  loadingCount: number;
  lastError: string | null;
  lastAction: string | null;
  lastActionAt: number;
};

let state: TeamStoreState = {
  ready: false,
  userId: null,
  teamId: null,
  teamIdLoaded: false,

  roster: [],
  rosterLoaded: false,
  rosterLastFetchedAt: 0,

  loadingCount: 0,
  lastError: null,
  lastAction: null,
  lastActionAt: 0,
};

const listeners = new Set<() => void>();
let rosterInFlight: Promise<boolean> | null = null;
let authUnsub: (() => void) | null = null;

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<TeamStoreState>) {
  state = { ...state, ...patch };
  emit();
}

function getSnapshot() {
  return state;
}

function getState() {
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function incLoading() {
  setState({ loadingCount: state.loadingCount + 1 });
}

function decLoading() {
  setState({ loadingCount: Math.max(0, state.loadingCount - 1) });
}

function setError(e: unknown) {
  const msg =
    typeof e === "object" && e && "message" in e ? String((e as any).message) : "Unknown error";
  setState({ lastError: msg });
}

function setLastAction(action: string) {
  setState({ lastAction: action, lastActionAt: Date.now() });
}

function resetStoreForSignedOut() {
  rosterInFlight = null;
  setState({
    ready: true,
    userId: null,
    teamId: null,
    teamIdLoaded: false,
    roster: [],
    rosterLoaded: false,
    rosterLastFetchedAt: 0,
    lastError: null,
    loadingCount: 0,
    lastAction: "auth:signed_out",
    lastActionAt: Date.now(),
  });
}

function ensureAuthSubscription() {
  if (authUnsub) return;

  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    const userId = session?.user?.id ?? null;

    if (!userId) {
      resetStoreForSignedOut();
      return;
    }

    if (state.userId && state.userId !== userId) {
      rosterInFlight = null;
      setState({
        ready: true,
        userId,
        teamId: null,
        teamIdLoaded: false,
        roster: [],
        rosterLoaded: false,
        rosterLastFetchedAt: 0,
        lastAction: "auth:user_changed",
        lastActionAt: Date.now(),
      });
      return;
    }

    setState({ ready: true, userId });
  });

  authUnsub = () => data.subscription.unsubscribe();
}

// ---------- PUBLIC HOOK ----------
export function useTeamStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------- ACTIONS ----------
async function ensureSessionAndTeam(opts?: { force?: boolean }) {
  const force = !!opts?.force;
  // Called by actions that need teamId/userId.
  const { data } = await supabase.auth.getSession();
  const session = data.session;

  const userId = session?.user?.id ?? null;
  if (!userId) {
    setState({
      ready: true,
      userId: null,
      teamId: null,
      teamIdLoaded: false,
      roster: [],
      rosterLoaded: false,
      rosterLastFetchedAt: 0,
      lastAction: "session:none",
      lastActionAt: Date.now(),
    });
    return { userId: null, teamId: null };
  }

  // Reuse cached identity/team unless explicitly forcing a profile re-read.
  if (!force && state.userId === userId && state.teamIdLoaded) {
    setState({ ready: true, userId });
    return { userId, teamId: state.teamId ?? null };
  }

  // Pull current team from profiles (your schema has profiles.current_team_id)
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("current_team_id")
    .eq("id", userId)
    .single();

  if (error) throw error;

  const teamId = (profile?.current_team_id as string | null) ?? null;
  setState({ ready: true, userId, teamId, teamIdLoaded: true });
  return { userId, teamId };
}

function getAthleteById(id: string) {
  return state.roster.find((a) => a.id === id) ?? null;
}

async function refreshRoster(opts?: { force?: boolean; minAgeMs?: number; throwOnError?: boolean }): Promise<boolean> {
  const force = !!opts?.force;
  const minAgeMs = opts?.minAgeMs ?? 4000;
  const throwOnError = !!opts?.throwOnError;
  const now = Date.now();

  if (!force && state.rosterLoaded && now - (state.rosterLastFetchedAt || 0) < minAgeMs) {
    return !!state.teamId && state.roster.length > 0;
  }

  if (rosterInFlight) {
    const ok = await rosterInFlight;
    if (!ok && throwOnError && state.lastError) {
      throw new Error(state.lastError);
    }
    return ok;
  }

  rosterInFlight = (async () => {
    incLoading();
    setLastAction("refreshRoster:start");
    try {
      const { teamId } = await ensureSessionAndTeam();
      if (!teamId) {
        setState({
          roster: [],
          rosterLoaded: true,
          rosterLastFetchedAt: Date.now(),
          lastError: null,
        });
        setLastAction("refreshRoster:no_team");
        return false;
      }

      const { data, error } = await supabase
        .from("team_athletes")
        .select("id, team_id, display_name, email, claimed_user_id, first_name, last_name")
        .eq("team_id", teamId)
        .order("last_name", { ascending: true, nullsFirst: true })
        .order("first_name", { ascending: true, nullsFirst: true });

      if (error) throw error;

      setState({
        roster: (data ?? []) as TeamAthlete[],
        rosterLoaded: true,
        rosterLastFetchedAt: Date.now(),
        lastError: null,
      });
      setLastAction("refreshRoster:success");
      return (data ?? []).length > 0;
    } catch (e) {
      setError(e);
      setLastAction("refreshRoster:error");
      if (throwOnError) throw e;
      return false;
    } finally {
      decLoading();
      rosterInFlight = null;
    }
  })();

  return rosterInFlight;
}

async function deleteAthlete(athleteId: string) {
  incLoading();
  const prevRoster = state.roster;
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) throw new Error("No team selected.");
    setLastAction("deleteAthlete:start");

    // Optimistic remove from store first (UI updates instantly)
    setState({
      roster: state.roster.filter((a) => a.id !== athleteId),
    });

    const { error } = await supabase
      .from("team_athletes")
      .delete()
      .eq("team_id", teamId)
      .eq("id", athleteId);

    if (error) throw error;

    setState({ lastError: null });
    setLastAction("deleteAthlete:success");
  } catch (e) {
    // Roll back optimistic delete if server delete fails.
    setState({ roster: prevRoster });
    setError(e);
    setLastAction("deleteAthlete:error");
  } finally {
    decLoading();
  }
}

async function updateAthlete(athleteId: string, patch: { display_name?: string; email?: string | null }) {
  incLoading();
  const prevRoster = state.roster;
  try {
    const { teamId } = await ensureSessionAndTeam();
    if (!teamId) throw new Error("No team selected.");
    setLastAction("updateAthlete:start");

    // Optimistic patch
    setState({
      roster: state.roster.map((a) => (a.id === athleteId ? { ...a, ...patch } : a)),
    });

    const update: { display_name?: string; email?: string | null } = {};
    if (typeof patch.display_name === "string") update.display_name = patch.display_name;
    if ("email" in patch) update.email = patch.email ?? null;

    const { error } = await supabase
      .from("team_athletes")
      .update(update)
      .eq("team_id", teamId)
      .eq("id", athleteId);

    if (error) throw error;

    setState({ lastError: null });
    setLastAction("updateAthlete:success");
  } catch (e) {
    setState({ roster: prevRoster });
    setError(e);
    setLastAction("updateAthlete:error");
  } finally {
    decLoading();
  }
}

function invalidateTeam() {
  rosterInFlight = null;
  setState({
    teamId: null,
    teamIdLoaded: false,
    roster: [],
    rosterLoaded: false,
    rosterLastFetchedAt: 0,
  });
  setLastAction("team:invalidated");
}

async function bootstrap() {
  await ensureSessionAndTeam();
  await refreshRoster({ force: true });
  setLastAction("bootstrap");
}

ensureAuthSubscription();

export const teamStore = {
  use: useTeamStore,
  getState,
  getAthleteById,
  actions: {
    bootstrap,
    invalidateTeam,
    ensureSessionAndTeam,
    refreshRoster,
    deleteAthlete,
    updateAthlete,
  },
};
