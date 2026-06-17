import { supabase } from "./supabase";
import { getActiveAccountContext } from "./accountContexts";
import { normalizeTeamRole, requireTeamPermission, type TeamRole } from "./teamPermissions";

export async function getMyUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

export async function getMyEmail(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.email ?? null;
}

export async function getCurrentTeamId(): Promise<string> {
  const activeContext = await getActiveAccountContext();
  if (activeContext?.teamId) return activeContext.teamId;

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
  roster_status?: string | null;
  left_at?: string | null;
  team_start_date?: string | null;
  team_end_date?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type TeamAthleteRow = TeamAthlete;

export async function listTeamAthletes(): Promise<TeamAthlete[]> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");

  const { data, error } = await supabase
    .from("team_athletes")
    .select("id,team_id,first_name,last_name,display_name,grad_year,email,claimed_user_id,roster_status,left_at,team_start_date,team_end_date,created_at,updated_at")
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
    .select("id,team_id,first_name,last_name,display_name,grad_year,email,claimed_user_id,roster_status,left_at,team_start_date,team_end_date,created_at,updated_at")
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as TeamAthlete | null;
}

export async function updateTeamAthlete(
  id: string,
  patch: Partial<Pick<TeamAthlete, "display_name" | "email" | "team_start_date" | "team_end_date">>
) {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");
  await requireTeamPermission("roster.edit", teamId);

  const payload: {
    updated_at: string;
    display_name?: string;
    email?: string | null;
    team_start_date?: string | null;
    team_end_date?: string | null;
  } = {
    updated_at: new Date().toISOString(),
  };

  if (patch.display_name !== undefined) payload.display_name = patch.display_name.trim();
  if (patch.email !== undefined) payload.email = patch.email?.trim() || null;
  if (patch.team_start_date !== undefined) payload.team_start_date = patch.team_start_date?.trim() || null;
  if (patch.team_end_date !== undefined) payload.team_end_date = patch.team_end_date?.trim() || null;

  const { data, error } = await supabase
    .from("team_athletes")
    .update(payload)
    .eq("team_id", teamId)
    .eq("id", id)
    .select("id,team_id,first_name,last_name,display_name,grad_year,email,claimed_user_id,roster_status,left_at,team_start_date,team_end_date,created_at,updated_at")
    .single();

  if (error) throw error;
  return data as TeamAthlete;
}

export async function deleteTeamAthlete(id: string) {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");
  await requireTeamPermission("roster.edit", teamId);

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
  await requireTeamPermission("roster.edit", teamId);

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
    .select("id,team_id,first_name,last_name,display_name,email,claimed_user_id,roster_status,left_at,team_start_date,team_end_date,created_at,updated_at")
    .single();

  if (error) throw error;
  return data as TeamAthlete;
}

// Coach creates invite for an athlete profile to claim
export type TeamInviteCreateResult = {
  id: string;
  token: string;
};

export async function createClaimInvite(athlete_profile_id: string, email: string, daysValid = 14) {
  const userId = await getMyUserId();
  const teamId = await getCurrentTeamId();
  if (!userId) throw new Error("Not signed in");
  if (!teamId) throw new Error("No current team");
  await requireTeamPermission("roster.edit", teamId);

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
    .select("id,token")
    .single();

  if (error) throw error;
  return {
    id: String(data.id ?? ""),
    token: String(data.token ?? ""),
  } satisfies TeamInviteCreateResult;
}

export type SendAthleteInviteEmailResult = {
  ok: boolean;
  invite_url?: string;
  message?: string;
  error?: string;
};

export async function sendAthleteInviteEmail(inviteId: string): Promise<SendAthleteInviteEmailResult> {
  const cleanInviteId = String(inviteId ?? "").trim();
  if (!cleanInviteId) throw new Error("Missing invite id.");

  const { data, error } = await supabase.functions.invoke("send-athlete-invite", {
    body: { invite_id: cleanInviteId },
  });
  if (error) throw error;

  const result = (data ?? {}) as Record<string, unknown>;
  return {
    ok: result.ok === true,
    invite_url: result.invite_url == null ? undefined : String(result.invite_url),
    message: result.message == null ? undefined : String(result.message),
    error: result.error == null ? undefined : String(result.error),
  };
}

export type AthleteInvitePreviewStatus = "valid" | "invalid" | "expired" | "accepted";

export type AthleteInvitePreview = {
  ok: boolean;
  status: AthleteInvitePreviewStatus;
  email: string | null;
  team_name: string | null;
  athlete_name: string | null;
  expires_at: string | null;
  accepted_at: string | null;
  message?: string;
  error?: string;
};

function normalizeInvitePreview(data: any): AthleteInvitePreview {
  return {
    ok: data?.ok === true,
    status: String(data?.status ?? "invalid") as AthleteInvitePreviewStatus,
    email: data?.email == null ? null : String(data.email),
    team_name: data?.team_name == null ? null : String(data.team_name),
    athlete_name: data?.athlete_name == null ? null : String(data.athlete_name),
    expires_at: data?.expires_at == null ? null : String(data.expires_at),
    accepted_at: data?.accepted_at == null ? null : String(data.accepted_at),
    message: data?.message == null ? undefined : String(data.message),
    error: data?.error == null ? undefined : String(data.error),
  };
}

export async function getAthleteInvitePreview(token: string): Promise<AthleteInvitePreview> {
  const cleanToken = String(token ?? "").trim();
  if (!cleanToken) {
    return {
      ok: false,
      status: "invalid",
      email: null,
      team_name: null,
      athlete_name: null,
      expires_at: null,
      accepted_at: null,
      error: "Missing invite token.",
    };
  }

  const { data, error } = await supabase.functions.invoke("get-athlete-invite", {
    body: { token: cleanToken },
  });
  if (error) throw error;
  return normalizeInvitePreview(data);
}

export type AthleteLoginLinkStatus =
  | "linked"
  | "no_user_found"
  | "duplicate_claim"
  | "unauthorized"
  | "unlinked";

export type AthleteLoginLinkResult = {
  status: AthleteLoginLinkStatus;
  athlete_id: string | null;
  linked_user_id: string | null;
  linked_email: string | null;
  message: string;
};

function normalizeAthleteLoginLinkResult(data: any): AthleteLoginLinkResult {
  return {
    status: String(data?.status ?? "unauthorized") as AthleteLoginLinkStatus,
    athlete_id: data?.athlete_id == null ? null : String(data.athlete_id),
    linked_user_id: data?.linked_user_id == null ? null : String(data.linked_user_id),
    linked_email: data?.linked_email == null ? null : String(data.linked_email),
    message: String(data?.message ?? "Could not update athlete login access."),
  };
}

export async function linkTeamAthleteToExistingUserEmail(
  teamId: string,
  athleteId: string,
  email: string
): Promise<AthleteLoginLinkResult> {
  await requireTeamPermission("roster.edit", teamId);
  const { data, error } = await supabase.rpc("link_team_athlete_to_existing_user_email", {
    p_team_id: teamId,
    p_athlete_id: athleteId,
    p_email: email,
  });
  if (error) throw error;
  return normalizeAthleteLoginLinkResult(data);
}

export async function unlinkTeamAthleteLogin(teamId: string, athleteId: string): Promise<AthleteLoginLinkResult> {
  await requireTeamPermission("roster.edit", teamId);
  const { data, error } = await supabase.rpc("unlink_team_athlete_login", {
    p_team_id: teamId,
    p_athlete_id: athleteId,
  });
  if (error) throw error;
  return normalizeAthleteLoginLinkResult(data);
}

export type CoachInviteRole = Extract<TeamRole, "editor" | "viewer">;

export type TeamCoachInvite = {
  token: string;
  email: string | null;
  role: CoachInviteRole;
  expires_at: string | null;
  created_at: string | null;
};

export type TeamStaffMember = {
  team_id: string;
  user_id: string;
  role: TeamRole;
  raw_role: string | null;
  created_at: string | null;
  updated_at: string | null;
  is_owner: boolean;
};

export async function createCoachInvite(email: string, role: CoachInviteRole, daysValid = 14) {
  await requireTeamPermission("coaches.manage");
  const userId = await getMyUserId();
  const teamId = await getCurrentTeamId();
  if (!userId) throw new Error("Not signed in");
  if (!teamId) throw new Error("No current team");

  const normalizedRole = role === "viewer" ? "viewer" : "editor";
  const cleanEmail = String(email ?? "").trim().toLowerCase();
  if (!cleanEmail) throw new Error("Coach email is required.");
  const expires = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("team_invites")
    .insert({
      team_id: teamId,
      email: cleanEmail,
      role: normalizedRole,
      athlete_profile_id: null,
      expires_at: expires,
      created_by: userId,
    })
    .select("token")
    .single();

  if (error) throw error;
  return data.token as string;
}

export async function listTeamStaffMembers(): Promise<TeamStaffMember[]> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");
  await requireTeamPermission("team.view", teamId);

  const [{ data: team, error: teamError }, { data: members, error: membersError }] = await Promise.all([
    supabase.from("teams").select("owner_id").eq("id", teamId).maybeSingle(),
    supabase
      .from("team_members")
      .select("team_id,user_id,role,created_at,updated_at")
      .eq("team_id", teamId)
      .order("created_at", { ascending: true }),
  ]);

  if (teamError) throw teamError;
  if (membersError) throw membersError;

  const ownerId = String(team?.owner_id ?? "");
  return ((members ?? []) as Array<Record<string, unknown>>).map((row) => {
    const rawRole = row.role == null ? null : String(row.role);
    const userId = String(row.user_id ?? "");
    const isOwner = ownerId !== "" && userId === ownerId;
    return {
      team_id: String(row.team_id ?? teamId),
      user_id: userId,
      role: isOwner ? "owner" : normalizeTeamRole(rawRole),
      raw_role: rawRole,
      created_at: row.created_at == null ? null : String(row.created_at),
      updated_at: row.updated_at == null ? null : String(row.updated_at),
      is_owner: isOwner,
    };
  });
}

export async function listCoachInvites(): Promise<TeamCoachInvite[]> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");
  await requireTeamPermission("coaches.manage", teamId);

  const { data, error } = await supabase
    .from("team_invites")
    .select("token,email,role,expires_at,created_at")
    .eq("team_id", teamId)
    .in("role", ["editor", "viewer"])
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    token: String(row.token ?? ""),
    email: row.email == null ? null : String(row.email),
    role: normalizeTeamRole(row.role as string | null) === "viewer" ? "viewer" : "editor",
    expires_at: row.expires_at == null ? null : String(row.expires_at),
    created_at: row.created_at == null ? null : String(row.created_at),
  }));
}

export async function updateTeamStaffRole(userId: string, role: CoachInviteRole): Promise<void> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");
  await requireTeamPermission("coaches.manage", teamId);
  const cleanUserId = String(userId ?? "").trim();
  if (!cleanUserId) throw new Error("Missing staff user id.");

  const { data: team, error: teamError } = await supabase
    .from("teams")
    .select("owner_id")
    .eq("id", teamId)
    .maybeSingle();
  if (teamError) throw teamError;
  if (String(team?.owner_id ?? "") === cleanUserId) {
    throw new Error("The team owner role cannot be changed.");
  }

  const { error } = await supabase
    .from("team_members")
    .update({ role: role === "viewer" ? "viewer" : "editor" })
    .eq("team_id", teamId)
    .eq("user_id", cleanUserId);
  if (error) throw error;
}

export async function removeTeamStaffMember(userId: string): Promise<void> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No current team");
  await requireTeamPermission("coaches.manage", teamId);
  const cleanUserId = String(userId ?? "").trim();
  if (!cleanUserId) throw new Error("Missing staff user id.");

  const { data: team, error: teamError } = await supabase
    .from("teams")
    .select("owner_id")
    .eq("id", teamId)
    .maybeSingle();
  if (teamError) throw teamError;
  if (String(team?.owner_id ?? "") === cleanUserId) {
    throw new Error("The team owner cannot be removed.");
  }

  const { error } = await supabase
    .from("team_members")
    .delete()
    .eq("team_id", teamId)
    .eq("user_id", cleanUserId);
  if (error) throw error;
}

export type AcceptInviteResult =
  | string
  | {
      team_id?: string | null;
      athlete_profile_id?: string | null;
      role?: string | null;
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
