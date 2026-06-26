import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { normalizeTeamRole, type TeamRole } from "./teamPermissions";

export type AccountContextKind = "coach" | "athlete";
export type AccountContextRole = TeamRole | "athlete";

export type AccountContext = {
  id: string;
  kind: AccountContextKind;
  teamId: string;
  teamName: string;
  role: AccountContextRole;
  athleteId?: string;
  athleteName?: string;
  memberId?: string;
  isDefault?: boolean;
};

const ACTIVE_CONTEXT_ID_KEY = "training_app_active_account_context_id_v1";
const ACTIVE_CONTEXT_KIND_KEY = "training_app_active_account_context_kind_v1";
const ACTIVE_CONTEXT_TEAM_ID_KEY = "training_app_active_account_team_id_v1";
const ACTIVE_CONTEXT_ROLE_KEY = "training_app_active_account_role_v1";
const ACTIVE_CONTEXT_ATHLETE_ID_KEY = "training_app_active_account_athlete_id_v1";
const SELECTED_ATHLETE_KEY = "training_app_selected_athlete_v1";
const DEBUG_ACCOUNT_CONTEXTS = typeof __DEV__ !== "undefined" ? __DEV__ : false;

type ContextLoadArea =
  | "auth user"
  | "owner teams"
  | "team members"
  | "claimed athletes"
  | "team names"
  | "persisted context"
  | "profile compatibility";

type ContextLoadFailure = {
  area: ContextLoadArea;
  message: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
};

export class AccountContextLoadError extends Error {
  failures: ContextLoadFailure[];

  constructor(failures: ContextLoadFailure[]) {
    super(`Account context loading failed: ${failures.map((failure) => failure.area).join(", ")}`);
    this.name = "AccountContextLoadError";
    this.failures = failures;
  }
}

function debugAccountContexts(...args: unknown[]) {
  if (DEBUG_ACCOUNT_CONTEXTS) console.log("[account-contexts]", ...args);
}

function formatContextFailure(area: ContextLoadArea, error: any): ContextLoadFailure {
  return {
    area,
    message: String(error?.message ?? error ?? "Unknown Supabase error"),
    details: error?.details ?? null,
    hint: error?.hint ?? null,
    code: error?.code ?? null,
  };
}

function logContextFailure(failure: ContextLoadFailure) {
  console.error(`[account-contexts] ${failure.area} query failed`, failure);
}

function contextIdFor(context: Pick<AccountContext, "kind" | "teamId" | "role" | "athleteId">) {
  if (context.kind === "athlete") return `athlete:${context.teamId}:${context.athleteId ?? ""}`;
  return `coach:${context.teamId}:${context.role}`;
}

function displayTeamName(teamNamesById: Map<string, string>, fallbackId: string) {
  return String(teamNamesById.get(fallbackId) ?? "").trim() || `Team ${fallbackId.slice(0, 8)}`;
}

function sortContexts(a: AccountContext, b: AccountContext) {
  const rank = (context: AccountContext) => {
    if (context.role === "owner") return 0;
    if (context.role === "editor") return 1;
    if (context.role === "viewer") return 2;
    return 3;
  };
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const byTeam = a.teamName.localeCompare(b.teamName);
  if (byTeam !== 0) return byTeam;
  return String(a.athleteName ?? "").localeCompare(String(b.athleteName ?? ""));
}

async function getSessionUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    const failure = formatContextFailure("auth user", error);
    logContextFailure(failure);
    throw new AccountContextLoadError([failure]);
  }
  return data.user?.id ?? null;
}

export async function listAccountContextsForCurrentUser(): Promise<AccountContext[]> {
  const userId = await getSessionUserId();
  debugAccountContexts("list:start", { userId });
  if (!userId) return [];

  const failures: ContextLoadFailure[] = [];
  const [ownedRes, memberRes, athleteRes] = await Promise.allSettled([
    supabase.from("teams").select("id,name,owner_id").eq("owner_id", userId),
    supabase.from("team_members").select("team_id,user_id,role,created_at").eq("user_id", userId),
    supabase.from("team_athletes").select("id,team_id,display_name,claimed_user_id").eq("claimed_user_id", userId),
  ]);

  const ownedRows = ownedRes.status === "fulfilled" && !ownedRes.value.error ? ownedRes.value.data ?? [] : [];
  const memberRows = memberRes.status === "fulfilled" && !memberRes.value.error ? memberRes.value.data ?? [] : [];
  const athleteRows = athleteRes.status === "fulfilled" && !athleteRes.value.error ? athleteRes.value.data ?? [] : [];

  const ownerError = ownedRes.status === "rejected" ? ownedRes.reason : ownedRes.value.error;
  const memberError = memberRes.status === "rejected" ? memberRes.reason : memberRes.value.error;
  const athleteError = athleteRes.status === "rejected" ? athleteRes.reason : athleteRes.value.error;

  debugAccountContexts("owner teams result", { count: ownedRows.length, error: ownerError ?? null });
  debugAccountContexts("team members result", { count: memberRows.length, error: memberError ?? null });
  debugAccountContexts("claimed athletes result", { count: athleteRows.length, error: athleteError ?? null });

  if (ownerError) {
    const failure = formatContextFailure("owner teams", ownerError);
    failures.push(failure);
    logContextFailure(failure);
  }
  if (memberError) {
    const failure = formatContextFailure("team members", memberError);
    failures.push(failure);
    logContextFailure(failure);
  }
  if (athleteError) {
    const failure = formatContextFailure("claimed athletes", athleteError);
    failures.push(failure);
    logContextFailure(failure);
  }

  if (ownerError && memberError && athleteError) {
    throw new AccountContextLoadError(failures);
  }

  const teamIds = new Set<string>();
  for (const row of ownedRows) {
    const teamId = String((row as any)?.id ?? "").trim();
    if (teamId) teamIds.add(teamId);
  }
  for (const row of memberRows) {
    const teamId = String((row as any)?.team_id ?? "").trim();
    if (teamId) teamIds.add(teamId);
  }
  for (const row of athleteRows) {
    const teamId = String((row as any)?.team_id ?? "").trim();
    if (teamId) teamIds.add(teamId);
  }

  const teamNamesById = new Map<string, string>();
  if (teamIds.size > 0) {
    const teamNameRes = await supabase
      .from("teams")
      .select("id,name")
      .in("id", [...teamIds]);

    debugAccountContexts("team names result", {
      requested: [...teamIds],
      count: teamNameRes.data?.length ?? 0,
      error: teamNameRes.error ?? null,
    });

    if (teamNameRes.error) {
      const failure = formatContextFailure("team names", teamNameRes.error);
      failures.push(failure);
      logContextFailure(failure);
    } else {
      for (const row of teamNameRes.data ?? []) {
        const teamId = String((row as any)?.id ?? "").trim();
        if (teamId) teamNamesById.set(teamId, String((row as any)?.name ?? "").trim());
      }
    }
  }

  const ownerTeamIds = new Set<string>();
  const contexts: AccountContext[] = [];

  for (const row of ownedRows) {
    const teamId = String((row as any)?.id ?? "").trim();
    if (!teamId) continue;
    ownerTeamIds.add(teamId);
    const context: AccountContext = {
      id: `coach:${teamId}:owner`,
      kind: "coach",
      teamId,
      teamName: String((row as any)?.name ?? "").trim() || displayTeamName(teamNamesById, teamId),
      role: "owner",
      memberId: userId,
    };
    contexts.push(context);
  }

  for (const row of memberRows) {
    const teamId = String((row as any)?.team_id ?? "").trim();
    if (!teamId || ownerTeamIds.has(teamId)) continue;
    const role = normalizeTeamRole((row as any)?.role);
    const context: AccountContext = {
      id: `coach:${teamId}:${role}`,
      kind: "coach",
      teamId,
      teamName: displayTeamName(teamNamesById, teamId),
      role,
      memberId: userId,
    };
    contexts.push(context);
  }

  for (const row of athleteRows) {
    const teamId = String((row as any)?.team_id ?? "").trim();
    const athleteId = String((row as any)?.id ?? "").trim();
    if (!teamId || !athleteId) continue;
    const athleteName = String((row as any)?.display_name ?? "").trim() || "Athlete";
    const context: AccountContext = {
      id: `athlete:${teamId}:${athleteId}`,
      kind: "athlete",
      teamId,
      teamName: displayTeamName(teamNamesById, teamId),
      role: "athlete",
      athleteId,
      athleteName,
    };
    contexts.push(context);
  }

  const deduped = new Map<string, AccountContext>();
  for (const context of contexts) {
    deduped.set(context.id || contextIdFor(context), context);
  }

  const sorted = [...deduped.values()].sort(sortContexts);
  debugAccountContexts(
    "list:done",
    sorted.map((context) => ({
      id: context.id,
      kind: context.kind,
      teamId: context.teamId,
      role: context.role,
      athleteId: context.athleteId,
    }))
  );
  if (failures.length > 0) debugAccountContexts("list:partial failures", failures);
  return sorted;
}

export async function getActiveAccountContext(): Promise<AccountContext | null> {
  const [id, kind, teamId, role, athleteId] = await AsyncStorage.multiGet([
    ACTIVE_CONTEXT_ID_KEY,
    ACTIVE_CONTEXT_KIND_KEY,
    ACTIVE_CONTEXT_TEAM_ID_KEY,
    ACTIVE_CONTEXT_ROLE_KEY,
    ACTIVE_CONTEXT_ATHLETE_ID_KEY,
  ]);
  const contextId = String(id?.[1] ?? "").trim();
  const contextKind = String(kind?.[1] ?? "").trim() as AccountContextKind;
  const contextTeamId = String(teamId?.[1] ?? "").trim();
  const contextRole = String(role?.[1] ?? "").trim() as AccountContextRole;
  const contextAthleteId = String(athleteId?.[1] ?? "").trim();
  if (!contextId || !contextTeamId || (contextKind !== "coach" && contextKind !== "athlete")) return null;
  if (contextKind === "coach" && !["owner", "editor", "viewer"].includes(contextRole)) return null;
  if (contextKind === "athlete" && !contextAthleteId) return null;
  return {
    id: contextId,
    kind: contextKind,
    teamId: contextTeamId,
    teamName: "",
    role: contextKind === "athlete" ? "athlete" : normalizeTeamRole(contextRole),
    athleteId: contextKind === "athlete" ? contextAthleteId : undefined,
  };
}

export async function clearActiveAccountContext(): Promise<void> {
  await AsyncStorage.multiRemove([
    ACTIVE_CONTEXT_ID_KEY,
    ACTIVE_CONTEXT_KIND_KEY,
    ACTIVE_CONTEXT_TEAM_ID_KEY,
    ACTIVE_CONTEXT_ROLE_KEY,
    ACTIVE_CONTEXT_ATHLETE_ID_KEY,
  ]);
}

export async function setActiveAccountContext(context: AccountContext): Promise<void> {
  const userId = await getSessionUserId();
  if (!userId) throw new Error("Not signed in");

  debugAccountContexts("set:start", {
    id: context.id,
    kind: context.kind,
    teamId: context.teamId,
    role: context.role,
    athleteId: context.athleteId,
  });

  await AsyncStorage.multiSet([
    [ACTIVE_CONTEXT_ID_KEY, context.id],
    [ACTIVE_CONTEXT_KIND_KEY, context.kind],
    [ACTIVE_CONTEXT_TEAM_ID_KEY, context.teamId],
    [ACTIVE_CONTEXT_ROLE_KEY, context.role],
    [ACTIVE_CONTEXT_ATHLETE_ID_KEY, context.athleteId ?? ""],
  ]);

  if (context.kind === "athlete" && context.athleteId) {
    await AsyncStorage.setItem(SELECTED_ATHLETE_KEY, context.athleteId);
  } else {
    await AsyncStorage.removeItem(SELECTED_ATHLETE_KEY);
  }

  const profileRole = context.kind === "coach" ? "coach" : "athlete";
  const now = new Date().toISOString();
  const compatibilityUpdate = supabase
    .from("profiles")
    .upsert(
      { id: userId, role: profileRole, current_team_id: context.teamId, updated_at: now, created_at: now },
      { onConflict: "id" }
    );
  void Promise.resolve(compatibilityUpdate).then(
    ({ error }) => {
      if (error) {
        const failure = formatContextFailure("profile compatibility", error);
        console.warn("Profile compatibility update failed", failure);
      }
    },
    (error: unknown) => {
      const failure = formatContextFailure("profile compatibility", error);
      console.warn("Profile compatibility update failed", failure);
    }
  );

  debugAccountContexts("set:done", { id: context.id });
}

export type StartupAccountResolution =
  | { status: "none"; contexts: AccountContext[] }
  | { status: "choose"; contexts: AccountContext[] }
  | { status: "ready"; context: AccountContext; contexts: AccountContext[] };

export async function resolveStartupAccountContext(): Promise<StartupAccountResolution> {
  debugAccountContexts("resolve:start");
  const contexts = await listAccountContextsForCurrentUser();
  if (contexts.length === 0) {
    await clearActiveAccountContext();
    debugAccountContexts("resolve:none");
    return { status: "none", contexts };
  }

  const active = await getActiveAccountContext();
  debugAccountContexts("persisted context result", active);
  const matched = active ? contexts.find((context) => context.id === active.id) ?? null : null;
  if (matched) {
    await setActiveAccountContext(matched);
    debugAccountContexts("resolve:ready:persisted", { id: matched.id });
    return { status: "ready", context: matched, contexts };
  }

  await clearActiveAccountContext();
  if (contexts.length === 1) {
    await setActiveAccountContext(contexts[0]);
    debugAccountContexts("resolve:ready:single", { id: contexts[0].id });
    return { status: "ready", context: contexts[0], contexts };
  }

  debugAccountContexts("resolve:choose", { count: contexts.length });
  return { status: "choose", contexts };
}

export function routeForAccountContext(
  context: Pick<AccountContext, "kind">,
  options?: { coachDefault?: "calendar" | "home" }
): "/(coach)/(tabs)/calendar?view=monthly" | "/(coach)/(tabs)/dashboard" | "/(athlete)/dashboard" {
  if (context.kind !== "coach") return "/(athlete)/dashboard";
  return options?.coachDefault === "home" ? "/(coach)/(tabs)/dashboard" : "/(coach)/(tabs)/calendar?view=monthly";
}
