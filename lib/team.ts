import { supabase } from "./supabase";

export async function getMyUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

export async function getMyEmail(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.email ?? null;
}

export async function getCurrentTeamId(): Promise<string> {
  const { data: userRes, error: userErr } = await supabase.auth.getUser();
  if (userErr) throw userErr;

  const userId = userRes.user?.id;
  if (!userId) throw new Error("Not signed in");

  const { data, error } = await supabase
    .from("profiles")
    .select("current_team_id")
    .eq("id", userId)
    .single();

  if (error) throw error;

  const teamId = (data?.current_team_id as string) ?? null;
  if (!teamId) {
    throw new Error("No current team selected. profiles.current_team_id is empty.");
  }

  return teamId;
}

export async function ensureCoachTeam(teamName = "My Team"): Promise<string | null> {
  const userId = await getMyUserId();
  if (!userId) return null;

  // Always ensure profile exists & get current team.
  let teamId: string | null = null;
  try {
    teamId = await getCurrentTeamId();
  } catch (e) {
    const msg = String((e as any)?.message ?? "");
    if (
      !msg.includes("No current team selected") &&
      !msg.includes("profiles.current_team_id is empty")
    ) {
      throw e;
    }
  }

  // If none, find or create owned team.
  if (!teamId) {
    const { data: existingTeam, error: findErr } = await supabase
      .from("teams")
      .select("id")
      .eq("owner_id", userId)
      .limit(1)
      .maybeSingle();
    if (findErr) throw findErr;

    teamId = existingTeam?.id ?? null;

    if (!teamId) {
      const { data: createdTeam, error: teamErr } = await supabase
        .from("teams")
        .insert({ name: teamName, owner_id: userId })
        .select("id")
        .single();
      if (teamErr) throw teamErr;
      teamId = createdTeam.id as string;
    }
  }

  if (!teamId) return null;

  // Always ensure membership row exists.
  const { error: memErr } = await supabase
    .from("team_members")
    .upsert({ team_id: teamId, user_id: userId, role: "coach" }, { onConflict: "team_id,user_id" });
  if (memErr) throw memErr;

  // Always ensure profile row exists + current_team_id set.
  const now = new Date().toISOString();
  const { error: profErr } = await supabase
    .from("profiles")
    .upsert(
      { id: userId, role: "coach", current_team_id: teamId, updated_at: now, created_at: now },
      { onConflict: "id" }
    );
  if (profErr) throw profErr;

  return teamId;
}

export type TeamAthlete = {
  id: string;
  team_id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  grad_year?: number | null;
  email: string | null;
  claimed_user_id: string | null;
  created_at?: string;
  updated_at?: string;
};
export type TeamAthleteRow = TeamAthlete;

export async function listTeamAthletes(): Promise<TeamAthlete[]> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");

  const { data, error } = await supabase
    .from("team_athletes")
    .select("id,team_id,first_name,last_name,display_name,grad_year,email,claimed_user_id,created_at,updated_at")
    .eq("team_id", teamId)
    .order("last_name", { ascending: true, nullsFirst: false })
    .order("first_name", { ascending: true, nullsFirst: false })
    .order("display_name", { ascending: true });

  if (error) throw error;
  return (data ?? []) as TeamAthlete[];
}

export async function getTeamAthlete(id: string): Promise<TeamAthlete | null> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");

  const { data, error } = await supabase
    .from("team_athletes")
    .select("id,team_id,first_name,last_name,display_name,grad_year,email,claimed_user_id,created_at,updated_at")
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as TeamAthlete | null;
}

export async function updateTeamAthlete(id: string, patch: Partial<Pick<TeamAthlete, "display_name" | "email">>) {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");

  const payload: { updated_at: string; display_name?: string; email?: string | null } = {
    updated_at: new Date().toISOString(),
  };

  if (patch.display_name !== undefined) payload.display_name = patch.display_name.trim();
  if (patch.email !== undefined) payload.email = patch.email?.trim() || null;

  const { data, error } = await supabase
    .from("team_athletes")
    .update(payload)
    .eq("team_id", teamId)
    .eq("id", id)
    .select("id,team_id,first_name,last_name,display_name,grad_year,email,claimed_user_id,created_at,updated_at")
    .single();

  if (error) throw error;
  return data as TeamAthlete;
}

export async function deleteTeamAthlete(id: string) {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");

  const { error } = await supabase
    .from("team_athletes")
    .delete()
    .eq("team_id", teamId)
    .eq("id", id);

  if (error) throw error;
}

// Coach creates an athlete profile (roster entry) inside the team
export async function createTeamAthlete(first_name: string, last_name: string, email?: string | null) {
  // IMPORTANT: ensure team exists on *this device/session*
  const teamId = (await ensureCoachTeam("My Team")) ?? (await getCurrentTeamId());
  if (!teamId) throw new Error("No current team");

  const fn = first_name.trim();
  const ln = last_name.trim();
  const display_name = `${fn} ${ln}`.trim();

  const { data, error } = await supabase
    .from("team_athletes")
    .insert({
      team_id: teamId,
      first_name: fn,
      last_name: ln,
      display_name,
      email: email?.trim() || null,
    })
    .select("id,team_id,first_name,last_name,display_name,email,claimed_user_id,created_at,updated_at")
    .single();

  if (error) throw error;
  return data as TeamAthlete;
}

// Coach creates invite for an athlete profile to claim
export async function createClaimInvite(athlete_profile_id: string, email: string, daysValid = 14) {
  const userId = await getMyUserId();
  const teamId = await getCurrentTeamId();
  if (!userId) throw new Error("Not signed in");
  if (!teamId) throw new Error("No current team");

  const expires = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("team_invites")
    .insert({
      team_id: teamId,
      email: email.trim(),
      role: "athlete",
      athlete_profile_id,
      expires_at: expires,
      created_by: userId,
    })
    .select("token")
    .single();

  if (error) throw error;
  return data.token as string;
}

export type AcceptInviteResult =
  | string
  | {
      team_id?: string | null;
      athlete_profile_id?: string | null;
    };

export async function acceptInvite(token: string) {
  const { data, error } = await supabase.rpc("accept_team_invite", { p_token: token });
  if (error) throw error;
  return data as AcceptInviteResult; // team_id or object payload
}

export async function getMyClaimedAthleteProfileId(teamId?: string | null): Promise<string | null> {
  const userId = await getMyUserId();
  if (!userId) return null;

  let query = supabase
    .from("team_athletes")
    .select("id,team_id")
    .eq("claimed_user_id", userId)
    .limit(1);

  if (teamId) {
    query = query.eq("team_id", teamId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data?.id as string) ?? null;
}
