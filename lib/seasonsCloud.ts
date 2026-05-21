import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";

export type TeamSeasonRow = {
  id: string;
  team_id: string;
  name: string;
  start_date: string;
  end_date: string;
  color: string | null;
  sort_order: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TeamAthleteSeasonOverrideRow = {
  id: string;
  team_id: string;
  season_id: string;
  athlete_profile_id: string;
  start_date: string | null;
  end_date: string | null;
  is_excluded: boolean;
  excluded_at: string | null;
  created_at: string;
  updated_at: string;
};

async function requireTeamId(): Promise<string> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No team selected (teamId missing).");
  return teamId;
}

export async function listTeamSeasons(): Promise<TeamSeasonRow[]> {
  const teamId = await requireTeamId();
  const { data, error } = await supabase
    .from("team_seasons")
    .select("id,team_id,name,start_date,end_date,color,sort_order,archived_at,created_at,updated_at")
    .eq("team_id", teamId)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("start_date", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TeamSeasonRow[];
}

export async function createTeamSeason(input: {
  name: string;
  start_date: string;
  end_date: string;
  color?: string | null;
  sort_order?: number | null;
}): Promise<TeamSeasonRow> {
  const teamId = await requireTeamId();
  const payload = {
    team_id: teamId,
    name: String(input.name ?? "").trim(),
    start_date: String(input.start_date ?? "").trim(),
    end_date: String(input.end_date ?? "").trim(),
    color: input.color == null || String(input.color).trim() === "" ? null : String(input.color).trim(),
    sort_order: Number.isFinite(input.sort_order as number) ? Number(input.sort_order) : null,
  };
  const { data, error } = await supabase
    .from("team_seasons")
    .insert(payload)
    .select("id,team_id,name,start_date,end_date,color,sort_order,archived_at,created_at,updated_at")
    .single();
  if (error) throw error;
  return data as TeamSeasonRow;
}

export async function updateTeamSeason(
  seasonId: string,
  patch: {
    name?: string;
    start_date?: string;
    end_date?: string;
    color?: string | null;
    sort_order?: number | null;
  }
): Promise<TeamSeasonRow> {
  const teamId = await requireTeamId();
  const update: Record<string, unknown> = {};
  if (typeof patch.name === "string") update.name = patch.name.trim();
  if (typeof patch.start_date === "string") update.start_date = patch.start_date.trim();
  if (typeof patch.end_date === "string") update.end_date = patch.end_date.trim();
  if ("color" in patch) update.color = patch.color == null || String(patch.color).trim() === "" ? null : String(patch.color).trim();
  if ("sort_order" in patch) {
    update.sort_order = Number.isFinite(patch.sort_order as number) ? Number(patch.sort_order) : null;
  }
  const { data, error } = await supabase
    .from("team_seasons")
    .update(update)
    .eq("team_id", teamId)
    .eq("id", seasonId)
    .select("id,team_id,name,start_date,end_date,color,sort_order,archived_at,created_at,updated_at")
    .single();
  if (error) throw error;
  return data as TeamSeasonRow;
}

export async function setTeamSeasonArchived(seasonId: string, archived: boolean): Promise<TeamSeasonRow> {
  const teamId = await requireTeamId();
  const { data, error } = await supabase
    .from("team_seasons")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("team_id", teamId)
    .eq("id", seasonId)
    .select("id,team_id,name,start_date,end_date,color,sort_order,archived_at,created_at,updated_at")
    .single();
  if (error) throw error;
  return data as TeamSeasonRow;
}

export async function listTeamAthleteSeasonOverrides(): Promise<TeamAthleteSeasonOverrideRow[]> {
  const teamId = await requireTeamId();
  const { data, error } = await supabase
    .from("team_athlete_season_overrides")
    .select("id,team_id,season_id,athlete_profile_id,start_date,end_date,is_excluded,excluded_at,created_at,updated_at")
    .eq("team_id", teamId);
  if (error) throw error;
  return (data ?? []) as TeamAthleteSeasonOverrideRow[];
}

export async function upsertAthleteSeasonOverride(input: {
  season_id: string;
  athlete_profile_id: string;
  start_date?: string | null;
  end_date?: string | null;
  is_excluded?: boolean;
  excluded_at?: string | null;
}): Promise<TeamAthleteSeasonOverrideRow> {
  const teamId = await requireTeamId();
  const payload = {
    team_id: teamId,
    season_id: String(input.season_id ?? "").trim(),
    athlete_profile_id: String(input.athlete_profile_id ?? "").trim(),
    start_date: input.start_date == null || String(input.start_date).trim() === "" ? null : String(input.start_date).trim(),
    end_date: input.end_date == null || String(input.end_date).trim() === "" ? null : String(input.end_date).trim(),
    is_excluded: input.is_excluded === true,
    excluded_at:
      input.is_excluded === true
        ? (input.excluded_at ?? new Date().toISOString())
        : null,
  };
  const { data, error } = await supabase
    .from("team_athlete_season_overrides")
    .upsert(payload, {
      onConflict: "team_id,season_id,athlete_profile_id",
    })
    .select("id,team_id,season_id,athlete_profile_id,start_date,end_date,is_excluded,excluded_at,created_at,updated_at")
    .single();
  if (error) throw error;
  return data as TeamAthleteSeasonOverrideRow;
}

export async function clearAthleteSeasonOverride(seasonId: string, athleteProfileId: string): Promise<void> {
  const teamId = await requireTeamId();
  const { error } = await supabase
    .from("team_athlete_season_overrides")
    .delete()
    .eq("team_id", teamId)
    .eq("season_id", String(seasonId ?? "").trim())
    .eq("athlete_profile_id", String(athleteProfileId ?? "").trim());
  if (error) throw error;
}
