// lib/mileageCloud.ts
import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import type { PostgrestError } from "@supabase/supabase-js";

// Authoritative mileage sources: team_mileage_cells and team_mileage_day_flags.
// Do not add alternative mileage read/write paths for this domain.
export type TeamMileageCellRow = {
  athlete_profile_id: string;
  day_idx: number;
  session: "AM" | "PM";
  value: any;
};

export type MileageDayFlagRow = {
  athlete_profile_id: string;
  week_start_iso: string; // YYYY-MM-DD
  day_idx: number;
  ncaa_off: boolean;
};

async function getUserIdOrNull(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user?.id ?? null;
}

// -----------------------------
// READS (teamId resolved inside)
// -----------------------------

export async function fetchMileageCellsForWeek(
  weekStartISO: string
): Promise<TeamMileageCellRow[]> {
  const teamId = await getCurrentTeamId();

  const { data, error } = await supabase
    .from("team_mileage_cells")
    .select("athlete_profile_id,day_idx,session,value")
    .eq("team_id", teamId)
    .eq("week_start_iso", weekStartISO);

  if (error) throw error;
  return (data ?? []) as TeamMileageCellRow[];
}

export async function fetchMileageDayFlagsForWeek(
  weekStartISO: string
): Promise<MileageDayFlagRow[]> {
  const teamId = await getCurrentTeamId();

  const { data, error } = await supabase
    .from("team_mileage_day_flags")
    .select("athlete_profile_id,week_start_iso,day_idx,ncaa_off")
    .eq("team_id", teamId)
    .eq("week_start_iso", weekStartISO);

  if (error) throw error;
  return (data ?? []) as MileageDayFlagRow[];
}

// -----------------------------
// WRITES (teamId resolved inside)
// -----------------------------

export async function upsertMileageCell(
  athleteProfileId: string,
  weekStartISO: string,
  dayIdx: number,
  session: "AM" | "PM",
  value: any
) {
  if (!athleteProfileId) throw new Error("upsertMileageCell: missing athleteProfileId");

  const teamId = await getCurrentTeamId();
  const userId = await getUserIdOrNull();

  const payload = {
    team_id: teamId,
    athlete_profile_id: athleteProfileId,
    week_start_iso: weekStartISO, // date string ok
    day_idx: dayIdx,
    session,
    value, // jsonb
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };

  const { error } = await supabase
    .from("team_mileage_cells")
    .upsert(payload, {
      onConflict: "team_id,athlete_profile_id,week_start_iso,day_idx,session",
    });

  if (error) throw error;
}

export async function upsertMileageDayFlag(
  athleteProfileId: string,
  weekStartISO: string,
  dayIdx: number,
  ncaaOff: boolean
) {
  if (!athleteProfileId) throw new Error("upsertMileageDayFlag: missing athleteProfileId");

  const teamId = await getCurrentTeamId();

  const payload = {
    team_id: teamId,
    athlete_profile_id: athleteProfileId,
    week_start_iso: weekStartISO,
    day_idx: dayIdx,
    ncaa_off: ncaaOff,
    updated_at: new Date().toISOString(),
  };
  console.log("[mileageCloud] upsertMileageDayFlag payload", payload);

  const result = await supabase
    .from("team_mileage_day_flags")
    .upsert(payload, {
      onConflict: "team_id,athlete_profile_id,week_start_iso,day_idx",
    })
    .select();

  console.log("[mileageCloud] upsertMileageDayFlag result", result);

  if (result.error) {
    console.error("[mileageCloud] upsertMileageDayFlag error", result.error);
    throw result.error;
  }

  return result.data;
}
