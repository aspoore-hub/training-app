import AsyncStorage from "@react-native-async-storage/async-storage";

export const ACTIVE_CONTEXT_ID_KEY = "training_app_active_account_context_id_v1";
export const ACTIVE_CONTEXT_KIND_KEY = "training_app_active_account_context_kind_v1";
export const ACTIVE_CONTEXT_TEAM_ID_KEY = "training_app_active_account_team_id_v1";
export const ACTIVE_CONTEXT_ROLE_KEY = "training_app_active_account_role_v1";
export const ACTIVE_CONTEXT_ATHLETE_ID_KEY = "training_app_active_account_athlete_id_v1";

export type PersistedActiveAccountContext = {
  id: string;
  kind: "coach" | "athlete";
  teamId: string;
  role: string;
  athleteId: string;
};

export async function readPersistedActiveAccountContext(): Promise<PersistedActiveAccountContext | null> {
  const [id, kind, teamId, role, athleteId] = await AsyncStorage.multiGet([
    ACTIVE_CONTEXT_ID_KEY,
    ACTIVE_CONTEXT_KIND_KEY,
    ACTIVE_CONTEXT_TEAM_ID_KEY,
    ACTIVE_CONTEXT_ROLE_KEY,
    ACTIVE_CONTEXT_ATHLETE_ID_KEY,
  ]);
  const contextId = String(id?.[1] ?? "").trim();
  const contextKind = String(kind?.[1] ?? "").trim();
  const contextTeamId = String(teamId?.[1] ?? "").trim();
  if (!contextId || !contextTeamId || (contextKind !== "coach" && contextKind !== "athlete")) return null;
  return {
    id: contextId,
    kind: contextKind,
    teamId: contextTeamId,
    role: String(role?.[1] ?? "").trim(),
    athleteId: String(athleteId?.[1] ?? "").trim(),
  };
}

export async function getPersistedActiveTeamId(): Promise<string | null> {
  return (await readPersistedActiveAccountContext())?.teamId ?? null;
}
