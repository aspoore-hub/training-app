import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";

// Authoritative workout source: team_workouts.
// Do not add alternative workout read/write paths for this domain.
async function requireTeamId(): Promise<string> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No team selected (teamId missing).");
  return teamId;
}

export type TeamWorkoutRow = {
  id: string;
  team_id: string;
  athlete_profile_id: string;
  created_by: string | null;

  date_iso: string;
  session: "AM" | "PM";
  location: string | null;
  time_text: string | null;

  title: string;
  details: string | null;

  primary_category: string | null;
  categories: string[] | null;

  batch_id: string | null;
  group_id: string | null;

  pre_routine_ids: string[] | null;
  post_routine_ids: string[] | null;

  planned_distance: number | null;
  planned_distance_unit: "mi" | "km" | null;

  created_at: string;
  updated_at: string;
};

export type TeamWorkoutInsertRow = Omit<TeamWorkoutRow, "id" | "created_at" | "updated_at">;
export type TeamWorkoutInsertInput = Omit<TeamWorkoutInsertRow, "team_id"> & {
  team_id?: string;
};
export type PlannedDistanceMap = ReadonlyMap<string, number | null | undefined> | Record<string, number | null | undefined>;

export type TeamWorkoutInsertParams = {
  selectedAthleteIds: string[];
  date_iso: string;
  session: "AM" | "PM";
  location?: string | null;
  time_text: string | null;
  title: string;
  details: string | null;
  primary_category: string | null;
  categories: string[];
  plannedDistanceByAthlete?: PlannedDistanceMap;
  plannedDistanceUnit: "mi" | "km" | null;
  batch_id: string | null;
  group_id: string | null;
  team_id: string;
  created_by: string | null;
  pre_routine_ids?: string[] | null;
  post_routine_ids?: string[] | null;
};

/*
  IMPORTANT:
  Planner, Daily View, and edit pages should go through these shared team_workouts
  cloud helpers so payload shape is consistent across create/edit flows and we avoid
  inline payload drift.
*/
export function buildTeamWorkoutInsertRows(params: TeamWorkoutInsertParams): TeamWorkoutInsertRow[] {
  const {
    selectedAthleteIds,
    date_iso,
    session,
    location,
    time_text,
    title,
    details,
    primary_category,
    categories,
    plannedDistanceByAthlete,
    plannedDistanceUnit,
    batch_id,
    group_id,
    team_id,
    created_by,
    pre_routine_ids,
    post_routine_ids,
  } = params;

  const cleanCategoryList = Array.isArray(categories)
    ? Array.from(new Set(categories.map((c) => String(c ?? "").trim()).filter(Boolean)))
    : [];
  const normalizedPrimaryCategory = String(primary_category ?? "").trim() || null;
  const normalizedLocation = location == null ? null : String(location).trim() || null;
  const normalizedTitle = String(title ?? "").trim() || "Workout";
  const normalizedDetails = details == null ? null : String(details).trim() || null;
  const cleanBatchId = batch_id ?? null;
  const cleanGroupId = group_id ?? null;

  const readDistance = (athleteId: string): number | null => {
    if (!plannedDistanceByAthlete) return null;
    const raw = plannedDistanceByAthlete instanceof Map ? plannedDistanceByAthlete.get(athleteId) : (plannedDistanceByAthlete as Record<string, number | null>)[athleteId];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };

  return (selectedAthleteIds ?? []).map((athleteId) => ({
    team_id,
    athlete_profile_id: String(athleteId),
    created_by,
    date_iso,
    session,
    location: normalizedLocation,
    time_text,
    title: normalizedTitle,
    details: normalizedDetails,
    primary_category: normalizedPrimaryCategory,
    categories: cleanCategoryList,
    batch_id: cleanBatchId,
    group_id: cleanGroupId,
    pre_routine_ids: pre_routine_ids ?? null,
    post_routine_ids: post_routine_ids ?? null,
    planned_distance: readDistance(String(athleteId)),
    planned_distance_unit: readDistance(String(athleteId)) != null ? plannedDistanceUnit : null,
  }));
}

export async function createTeamWorkoutBatch(
  rows: TeamWorkoutInsertInput[]
): Promise<TeamWorkoutRow[]> {
  const teamId = await requireTeamId();
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const payload: TeamWorkoutInsertInput[] = rows.map((r) => ({
    ...r,
    team_id: r.team_id ?? teamId,
  }));

  const { data, error } = await supabase
    .from("team_workouts")
    .insert(payload)
    .select("*");

  if (error) throw error;
  return (data ?? []) as TeamWorkoutRow[];
}

export async function getTeamWorkoutById(id: string): Promise<TeamWorkoutRow | null> {
  const teamId = await requireTeamId();

  const { data, error } = await supabase
    .from("team_workouts")
    .select("*")
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as TeamWorkoutRow | null;
}

export async function listTeamWorkoutsByBatch(batchId: string): Promise<TeamWorkoutRow[]> {
  const teamId = await requireTeamId();

  const { data, error } = await supabase
    .from("team_workouts")
    .select("*")
    .eq("team_id", teamId)
    .eq("batch_id", batchId)
    .order("group_id", { ascending: true })
    .order("athlete_profile_id", { ascending: true });

  if (error) throw error;
  return (data ?? []) as TeamWorkoutRow[];
}

export async function listTeamWorkoutsInRange(
  dateStartISO: string,
  dateEndISO: string
): Promise<TeamWorkoutRow[]> {
  const teamId = await requireTeamId();

  const { data, error } = await supabase
    .from("team_workouts")
    .select("*")
    .eq("team_id", teamId)
    .gte("date_iso", dateStartISO)
    .lte("date_iso", dateEndISO)
    .order("date_iso", { ascending: true })
    .order("session", { ascending: true });

  if (error) throw error;
  return (data ?? []) as TeamWorkoutRow[];
}

export async function listAthleteWorkoutsInRange(
  athleteProfileId: string,
  dateStartISO: string,
  dateEndISO: string
): Promise<TeamWorkoutRow[]> {
  const teamId = await requireTeamId();

  const { data, error } = await supabase
    .from("team_workouts")
    .select("*")
    .eq("team_id", teamId)
    .eq("athlete_profile_id", athleteProfileId)
    .gte("date_iso", dateStartISO)
    .lte("date_iso", dateEndISO)
    .order("date_iso", { ascending: true })
    .order("session", { ascending: true });

  if (error) throw error;
  return (data ?? []) as TeamWorkoutRow[];
}

export async function updateTeamWorkout(
  id: string,
  patch: Partial<Omit<TeamWorkoutRow, "id" | "team_id" | "created_at" | "updated_at">>
) {
  await updateTeamWorkoutById(id, patch);
}

export async function updateTeamWorkoutById(
  id: string,
  patch: Partial<TeamWorkoutRow>
): Promise<void> {
  const teamId = await requireTeamId();

  const { error } = await supabase
    .from("team_workouts")
    .update(patch)
    .eq("team_id", teamId)
    .eq("id", id);

  if (error) throw error;
}

export async function updateTeamWorkoutsByBatchId(
  batchId: string,
  patch: Partial<TeamWorkoutRow>
): Promise<void> {
  const teamId = await requireTeamId();
  const { error } = await supabase
    .from("team_workouts")
    .update(patch)
    .eq("team_id", teamId)
    .eq("batch_id", batchId);

  if (error) throw error;
}

export async function bulkUpdateTeamWorkouts(
  patches: Array<{ id: string; patch: Partial<TeamWorkoutRow> }>
): Promise<void> {
  await Promise.all(patches.map((p) => updateTeamWorkoutById(p.id, p.patch)));
}

export async function deleteTeamWorkout(id: string) {
  const teamId = await requireTeamId();

  const { error } = await supabase
    .from("team_workouts")
    .delete()
    .eq("team_id", teamId)
    .eq("id", id);

  if (error) throw error;
}

export async function deleteWorkoutBatch(batchId: string): Promise<number> {
  const teamId = await requireTeamId();
  const cleanBatchId = String(batchId ?? "").trim();
  if (!cleanBatchId) throw new Error("Missing batchId");

  const { data, error } = await supabase
    .from("team_workouts")
    .delete()
    .eq("team_id", teamId)
    .eq("batch_id", cleanBatchId)
    .select("id");

  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(`No rows deleted for batch_id=${cleanBatchId}. Check that the screen is passing the real batch_id.`);
  }
  return data.length;
}
