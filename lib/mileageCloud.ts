// lib/mileageCloud.ts
import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import type { PostgrestError } from "@supabase/supabase-js";
import { requireTeamPermission } from "./teamPermissions";

const DEBUG_MILEAGE_CLOUD = false;
function debugMileageCloud(...args: unknown[]) {
  if (DEBUG_MILEAGE_CLOUD) console.log(...args);
}

// Authoritative mileage sources: team_mileage_cells and team_mileage_day_flags.
// Do not add alternative mileage read/write paths for this domain.
export type TeamMileageCellRow = {
  athlete_profile_id: string;
  week_start_iso?: string;
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

export type MileageWeekVisibilityRow = {
  team_id: string;
  athlete_profile_id: string;
  week_start_iso: string;
  athlete_visible: boolean;
  athlete_visible_updated_at: string | null;
  published_at: string | null;
  hidden_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

async function getUserIdOrNull(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user?.id ?? null;
}

function normalizeWeekStartISO(weekStartISO: string): string {
  return String(weekStartISO ?? "").trim().slice(0, 10);
}

function isDateISO(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
}

function addDaysISO(dateISO: string, days: number): string {
  const [year, month, day] = String(dateISO ?? "").split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getWeekStartISOForVisibility(dateISO: string, weekStartsOn: 0 | 1 = 1): string {
  const [year, month, day] = String(dateISO ?? "").split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const jsDay = date.getDay();
  const diff = weekStartsOn === 0 ? jsDay : (jsDay + 6) % 7;
  date.setDate(date.getDate() - diff);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function weekStartISOsForDateRange(
  startISO: string,
  endISO: string,
  weekStartsOn: 0 | 1 = 1
): string[] {
  const start = String(startISO ?? "").trim();
  const end = String(endISO ?? "").trim();
  if (!isDateISO(start) || !isDateISO(end) || start > end) return [];
  const out: string[] = [];
  let cursor = getWeekStartISOForVisibility(start, weekStartsOn);
  const last = getWeekStartISOForVisibility(end, weekStartsOn);
  while (cursor <= last) {
    out.push(cursor);
    cursor = addDaysISO(cursor, 7);
  }
  return out;
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

export async function fetchVisibleMileageCellsForAthleteWeek(
  teamId: string,
  athleteProfileId: string,
  weekStartISO: string
): Promise<TeamMileageCellRow[]> {
  const cleanWeekStartISO = normalizeWeekStartISO(weekStartISO);
  if (!teamId || !athleteProfileId || !cleanWeekStartISO) return [];

  const { data: visibility, error: visibilityError } = await supabase
    .from("team_mileage_week_visibility")
    .select("team_id")
    .eq("team_id", teamId)
    .eq("athlete_profile_id", athleteProfileId)
    .eq("week_start_iso", cleanWeekStartISO)
    .eq("athlete_visible", true)
    .maybeSingle();

  if (visibilityError) throw visibilityError;
  if (!visibility) return [];

  const { data, error } = await supabase
    .from("team_mileage_cells")
    .select("athlete_profile_id,week_start_iso,day_idx,session,value")
    .eq("team_id", teamId)
    .eq("athlete_profile_id", athleteProfileId)
    .eq("week_start_iso", cleanWeekStartISO);

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

export async function fetchVisibleMileageDayFlagsForAthleteWeek(
  teamId: string,
  athleteProfileId: string,
  weekStartISO: string
): Promise<MileageDayFlagRow[]> {
  const cleanWeekStartISO = normalizeWeekStartISO(weekStartISO);
  if (!teamId || !athleteProfileId || !cleanWeekStartISO) return [];

  const { data: visibility, error: visibilityError } = await supabase
    .from("team_mileage_week_visibility")
    .select("team_id")
    .eq("team_id", teamId)
    .eq("athlete_profile_id", athleteProfileId)
    .eq("week_start_iso", cleanWeekStartISO)
    .eq("athlete_visible", true)
    .maybeSingle();

  if (visibilityError) throw visibilityError;
  if (!visibility) return [];

  const { data, error } = await supabase
    .from("team_mileage_day_flags")
    .select("athlete_profile_id,week_start_iso,day_idx,ncaa_off")
    .eq("team_id", teamId)
    .eq("athlete_profile_id", athleteProfileId)
    .eq("week_start_iso", cleanWeekStartISO);

  if (error) throw error;
  return (data ?? []) as MileageDayFlagRow[];
}

export async function upsertMileageWeekVisibility(input: {
  teamId?: string | null;
  athleteId: string;
  weekStartISO: string;
  visible: boolean;
}) {
  const teamId = input.teamId ?? await getCurrentTeamId();
  await requireTeamPermission("training.publish", teamId);
  const userId = await getUserIdOrNull();
  const now = new Date().toISOString();
  const visible = !!input.visible;
  const payload = {
    team_id: teamId,
    athlete_profile_id: input.athleteId,
    week_start_iso: normalizeWeekStartISO(input.weekStartISO),
    athlete_visible: visible,
    athlete_visible_updated_at: now,
    published_at: visible ? now : null,
    hidden_at: visible ? null : now,
    updated_by: userId,
    updated_at: now,
  };

  const { error } = await supabase
    .from("team_mileage_week_visibility")
    .upsert(payload, { onConflict: "team_id,athlete_profile_id,week_start_iso" });

  if (error) throw error;
}

export async function fetchMileageWeekVisibilityForWeek(
  weekStartISO: string
): Promise<MileageWeekVisibilityRow[]> {
  const teamId = await getCurrentTeamId();
  const cleanWeekStartISO = normalizeWeekStartISO(weekStartISO);
  const { data, error } = await supabase
    .from("team_mileage_week_visibility")
    .select("*")
    .eq("team_id", teamId)
    .eq("week_start_iso", cleanWeekStartISO);

  if (error) throw error;
  return (data ?? []) as MileageWeekVisibilityRow[];
}

export async function ensureHiddenMileageWeekVisibility(
  athleteProfileId: string,
  weekStartISO: string
) {
  if (!athleteProfileId) throw new Error("ensureHiddenMileageWeekVisibility: missing athleteProfileId");
  const teamId = await getCurrentTeamId();
  const cleanWeekStartISO = normalizeWeekStartISO(weekStartISO);
  const userId = await getUserIdOrNull();
  const now = new Date().toISOString();
  const { error: insertError } = await supabase
    .from("team_mileage_week_visibility")
    .upsert({
      team_id: teamId,
      athlete_profile_id: athleteProfileId,
      week_start_iso: cleanWeekStartISO,
      athlete_visible: false,
      athlete_visible_updated_at: now,
      published_at: null,
      hidden_at: now,
      updated_by: userId,
      updated_at: now,
    }, {
      onConflict: "team_id,athlete_profile_id,week_start_iso",
      ignoreDuplicates: true,
    });

  if (insertError) throw insertError;
}

export async function setMileageVisibilityByWeeks(input: {
  teamId?: string | null;
  athleteIds: string[];
  weekStartISOs: string[];
  visible: boolean;
}) {
  const teamId = input.teamId ?? await getCurrentTeamId();
  const athleteIds = Array.from(new Set((input.athleteIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean)));
  const weekStartISOs = Array.from(new Set((input.weekStartISOs ?? []).map(normalizeWeekStartISO).filter(Boolean)));
  if (athleteIds.length === 0 || weekStartISOs.length === 0) return;

  await Promise.all(
    athleteIds.flatMap((athleteId) =>
      weekStartISOs.map((weekStartISO) =>
        upsertMileageWeekVisibility({ teamId, athleteId, weekStartISO, visible: input.visible })
      )
    )
  );
}

export async function setMileageVisibilityByDateRange(input: {
  teamId?: string | null;
  athleteIds: string[];
  startISO: string;
  endISO: string;
  visible: boolean;
  weekStartsOn?: 0 | 1;
}): Promise<{ athleteCount: number; weekCount: number; rowCount: number; weekStartISOs: string[] }> {
  const athleteIds = Array.from(new Set((input.athleteIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean)));
  const weekStartISOs = weekStartISOsForDateRange(input.startISO, input.endISO, input.weekStartsOn ?? 1);
  if (athleteIds.length === 0 || weekStartISOs.length === 0) {
    return { athleteCount: athleteIds.length, weekCount: weekStartISOs.length, rowCount: 0, weekStartISOs };
  }
  await setMileageVisibilityByWeeks({
    teamId: input.teamId,
    athleteIds,
    weekStartISOs,
    visible: input.visible,
  });
  return {
    athleteCount: athleteIds.length,
    weekCount: weekStartISOs.length,
    rowCount: athleteIds.length * weekStartISOs.length,
    weekStartISOs,
  };
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
  await requireTeamPermission("mileage.edit", teamId);
  const userId = await getUserIdOrNull();
  await ensureHiddenMileageWeekVisibility(athleteProfileId, weekStartISO);

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
  await requireTeamPermission("mileage.edit", teamId);
  await ensureHiddenMileageWeekVisibility(athleteProfileId, weekStartISO);

  const payload = {
    team_id: teamId,
    athlete_profile_id: athleteProfileId,
    week_start_iso: weekStartISO,
    day_idx: dayIdx,
    ncaa_off: ncaaOff,
    updated_at: new Date().toISOString(),
  };
  debugMileageCloud("[mileageCloud] upsertMileageDayFlag payload", payload);

  const result = await supabase
    .from("team_mileage_day_flags")
    .upsert(payload, {
      onConflict: "team_id,athlete_profile_id,week_start_iso,day_idx",
    })
    .select();

  debugMileageCloud("[mileageCloud] upsertMileageDayFlag result", result);

  if (result.error) {
    console.error("[mileageCloud] upsertMileageDayFlag error", result.error);
    throw result.error;
  }

  return result.data;
}
