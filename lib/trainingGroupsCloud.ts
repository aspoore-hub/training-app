import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";

export type TeamTrainingGroupRow = {
  id: string;
  team_id: string;
  name: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TeamTrainingGroupMembershipRow = {
  id: string;
  team_id: string;
  group_id: string;
  athlete_profile_id: string;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  updated_at: string;
};

async function requireTeamId(): Promise<string> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No team selected (teamId missing).");
  return teamId;
}

function getCloudErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const anyError = error as any;
    return (
      anyError.message ||
      anyError.error_description ||
      anyError.details ||
      anyError.hint ||
      anyError.code ||
      JSON.stringify(error)
    );
  }
  return String(error);
}

export async function listTrainingGroups(): Promise<TeamTrainingGroupRow[]> {
  const teamId = await requireTeamId();
  const { data, error } = await supabase
    .from("team_training_groups")
    .select("id,team_id,name,archived_at,created_at,updated_at")
    .eq("team_id", teamId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TeamTrainingGroupRow[];
}

export async function listTrainingGroupMemberships(): Promise<TeamTrainingGroupMembershipRow[]> {
  const teamId = await requireTeamId();
  const { data, error } = await supabase
    .from("team_training_group_memberships")
    .select("id,team_id,group_id,athlete_profile_id,starts_on,ends_on,created_at,updated_at")
    .eq("team_id", teamId);
  if (error) throw error;
  return (data ?? []) as TeamTrainingGroupMembershipRow[];
}

export async function createTrainingGroup(name: string): Promise<TeamTrainingGroupRow> {
  const teamId = await requireTeamId();
  const { data, error } = await supabase
    .from("team_training_groups")
    .insert({ team_id: teamId, name: String(name ?? "").trim() })
    .select("id,team_id,name,archived_at,created_at,updated_at")
    .single();
  if (error) throw error;
  return data as TeamTrainingGroupRow;
}

export async function updateTrainingGroupName(groupId: string, name: string): Promise<TeamTrainingGroupRow> {
  const teamId = await requireTeamId();
  const { data, error } = await supabase
    .from("team_training_groups")
    .update({ name: String(name ?? "").trim() })
    .eq("team_id", teamId)
    .eq("id", groupId)
    .select("id,team_id,name,archived_at,created_at,updated_at")
    .single();
  if (error) throw error;
  return data as TeamTrainingGroupRow;
}

export async function setTrainingGroupArchived(groupId: string, archived: boolean): Promise<TeamTrainingGroupRow> {
  const teamId = await requireTeamId();
  const { data, error } = await supabase
    .from("team_training_groups")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("team_id", teamId)
    .eq("id", groupId)
    .select("id,team_id,name,archived_at,created_at,updated_at")
    .single();
  if (error) throw error;
  return data as TeamTrainingGroupRow;
}

export async function replaceTrainingGroupActiveMemberships(
  groupId: string,
  athleteProfileIds: string[]
): Promise<void> {
  const teamId = await requireTeamId();
  const cleanAthleteIds = Array.from(
    new Set((athleteProfileIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))
  );

  const { data: existingRows, error: existingError } = await supabase
    .from("team_training_group_memberships")
    .select("id,athlete_profile_id")
    .eq("team_id", teamId)
    .eq("group_id", groupId)
    .is("ends_on", null);
  if (existingError) {
    console.error("[training-groups-cloud] load existing active memberships failed", existingError);
    throw new Error(`Load current memberships failed: ${getCloudErrorMessage(existingError)}`);
  }

  const existingActive = (existingRows ?? []) as Array<{ id: string; athlete_profile_id: string }>;
  const existingIds = new Set(
    existingActive.map((row) => String(row?.athlete_profile_id ?? "").trim()).filter(Boolean)
  );
  const toClose = existingActive.filter(
    (row) => !cleanAthleteIds.includes(String(row?.athlete_profile_id ?? "").trim())
  );

  const todayISO = new Date().toISOString().slice(0, 10);
  for (const row of toClose) {
    const membershipId = String(row?.id ?? "").trim();
    if (!membershipId) continue;
    const { error } = await supabase
      .from("team_training_group_memberships")
      .update({ ends_on: todayISO })
      .eq("team_id", teamId)
      .eq("id", membershipId);
    if (error) {
      console.error("[training-groups-cloud] close membership failed", {
        teamId,
        groupId,
        membershipId,
        athlete_profile_id: row?.athlete_profile_id,
        error,
      });
      throw new Error(`Close removed memberships failed: ${getCloudErrorMessage(error)}`);
    }
  }

  if (cleanAthleteIds.length === 0) return;

  const toInsert = cleanAthleteIds.filter((id) => !existingIds.has(id));
  if (toInsert.length === 0) return;

  const payload = toInsert.map((athleteId) => ({
    team_id: teamId,
    group_id: groupId,
    athlete_profile_id: athleteId,
    starts_on: null,
    ends_on: null,
  }));
  console.log("[training-groups-cloud] insert memberships payload summary", {
    teamId,
    groupId,
    insertCount: payload.length,
    athleteIdSample: toInsert.slice(0, 10),
  });
  const { error: insertError } = await supabase
    .from("team_training_group_memberships")
    .insert(payload);
  if (insertError) {
    console.error("[training-groups-cloud] insert memberships failed", {
      teamId,
      groupId,
      payloadCount: payload.length,
      error: insertError,
    });
    throw new Error(`Insert memberships failed: ${getCloudErrorMessage(insertError)}`);
  }
}
