import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import { requireTeamPermission } from "./teamPermissions";

// Authoritative workout source: team_workouts.
// Do not add alternative workout read/write paths for this domain.
async function requireTeamId(): Promise<string> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No team selected (teamId missing).");
  return teamId;
}

function normalizeISODate(value: unknown): string {
  const match = String(value ?? "").trim().match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "";
}

function getWeekStartISOForWorkoutVisibility(dateISO: string, weekStartsOn: 0 | 1): string {
  const cleanDateISO = normalizeISODate(dateISO);
  if (!cleanDateISO) return "";
  const [year, month, day] = cleanDateISO.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return "";
  const jsDay = date.getDay();
  const diff = weekStartsOn === 0 ? jsDay : (jsDay + 6) % 7;
  date.setDate(date.getDate() - diff);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function workoutWeekVisibilityKey(athleteId: string, weekStartISO: string): string {
  return `${athleteId}:${weekStartISO}`;
}

function possibleWorkoutWeekStartISOs(dateISO: string): string[] {
  return Array.from(new Set([
    getWeekStartISOForWorkoutVisibility(dateISO, 1),
    getWeekStartISOForWorkoutVisibility(dateISO, 0),
  ].filter(Boolean)));
}

async function loadInheritedWorkoutWeekVisibility(
  teamId: string,
  rows: TeamWorkoutInsertInput[]
): Promise<Map<string, boolean>> {
  const athleteIds = Array.from(new Set(
    rows.map((row) => String(row.athlete_profile_id ?? "").trim()).filter(Boolean)
  ));
  const weekStartISOs = Array.from(new Set(
    rows.flatMap((row) => possibleWorkoutWeekStartISOs(row.date_iso))
  ));

  const byAthleteAndWeek = new Map<string, boolean>();
  if (athleteIds.length === 0 || weekStartISOs.length === 0) return byAthleteAndWeek;

  const { data, error } = await supabase
    .from("team_mileage_week_visibility")
    .select("athlete_profile_id,week_start_iso,athlete_visible")
    .eq("team_id", teamId)
    .in("athlete_profile_id", athleteIds)
    .in("week_start_iso", weekStartISOs);

  if (error) throw error;

  for (const row of data ?? []) {
    const athleteId = String((row as any).athlete_profile_id ?? "").trim();
    const weekStartISO = String((row as any).week_start_iso ?? "").trim();
    if (!athleteId || !weekStartISO) continue;
    byAthleteAndWeek.set(workoutWeekVisibilityKey(athleteId, weekStartISO), !!(row as any).athlete_visible);
  }
  return byAthleteAndWeek;
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
  completed_miles: number | null;
  completed_time_text: string | null;
  splits_or_pace: string | null;
  additional_feedback: string | null;

  athlete_visible: boolean;
  athlete_visible_updated_at: string | null;
  published_at: string | null;

  created_at: string;
  updated_at: string;
};

export type TeamWorkoutInsertRow = Omit<
  TeamWorkoutRow,
  | "id"
  | "created_at"
  | "updated_at"
  | "completed_miles"
  | "completed_time_text"
  | "splits_or_pace"
  | "additional_feedback"
  | "athlete_visible"
  | "athlete_visible_updated_at"
  | "published_at"
> & {
  completed_miles?: number | null;
  completed_time_text?: string | null;
  splits_or_pace?: string | null;
  additional_feedback?: string | null;
  athlete_visible?: boolean;
  athlete_visible_updated_at?: string | null;
  published_at?: string | null;
};
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
    completed_miles: null,
    completed_time_text: null,
    splits_or_pace: null,
    additional_feedback: null,
  }));
}

export async function createTeamWorkoutBatch(
  rows: TeamWorkoutInsertInput[]
): Promise<TeamWorkoutRow[]> {
  const teamId = await requireTeamId();
  await requireTeamPermission("training.edit", teamId);
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const now = new Date().toISOString();
  const inheritedVisibility = await loadInheritedWorkoutWeekVisibility(teamId, rows);
  const payload: TeamWorkoutInsertInput[] = rows.map((r) => ({
    ...r,
    team_id: r.team_id ?? teamId,
    ...(() => {
      const athleteId = String(r.athlete_profile_id ?? "").trim();
      const inherited = possibleWorkoutWeekStartISOs(r.date_iso).some(
        (weekStartISO) => inheritedVisibility.get(workoutWeekVisibilityKey(athleteId, weekStartISO)) === true
      );
      const athleteVisible = typeof r.athlete_visible === "boolean" ? r.athlete_visible : inherited;
      return {
        athlete_visible: athleteVisible,
        athlete_visible_updated_at: r.athlete_visible_updated_at ?? now,
        published_at: r.published_at ?? (athleteVisible ? now : null),
      };
    })(),
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
  const pageSize = 1000;
  const rows: TeamWorkoutRow[] = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("team_workouts")
      .select("*")
      .eq("team_id", teamId)
      .gte("date_iso", dateStartISO)
      .lte("date_iso", dateEndISO)
      .order("date_iso", { ascending: true })
      .order("session", { ascending: true })
      .range(from, to);

    if (error) throw error;
    const page = (data ?? []) as TeamWorkoutRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }

  return rows;
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

export async function listVisibleAthleteWorkoutsInRange(
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
    .eq("athlete_visible", true)
    .gte("date_iso", dateStartISO)
    .lte("date_iso", dateEndISO)
    .order("date_iso", { ascending: true })
    .order("session", { ascending: true });

  if (error) throw error;
  return (data ?? []) as TeamWorkoutRow[];
}

export async function getVisibleAthleteWorkoutById(
  id: string,
  athleteProfileId: string
): Promise<TeamWorkoutRow | null> {
  const teamId = await requireTeamId();

  const { data, error } = await supabase
    .from("team_workouts")
    .select("*")
    .eq("team_id", teamId)
    .eq("id", id)
    .eq("athlete_profile_id", athleteProfileId)
    .eq("athlete_visible", true)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as TeamWorkoutRow | null;
}

export async function setWorkoutVisibilityByDateRange(input: {
  teamId?: string | null;
  startISO: string;
  endISO: string;
  athleteIds?: string[] | null;
  visible: boolean;
}): Promise<number> {
  const teamId = input.teamId ?? await requireTeamId();
  await requireTeamPermission("training.publish", teamId);
  const now = new Date().toISOString();
  let query = supabase
    .from("team_workouts")
    .update({
      athlete_visible: !!input.visible,
      athlete_visible_updated_at: now,
      published_at: input.visible ? now : null,
    })
    .eq("team_id", teamId)
    .gte("date_iso", input.startISO)
    .lte("date_iso", input.endISO);

  const athleteIds = Array.from(
    new Set((input.athleteIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))
  );
  if (athleteIds.length > 0) query = query.in("athlete_profile_id", athleteIds);

  const { data, error } = await query.select("id");
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

export async function setWorkoutVisibilityByBatch(input: {
  teamId?: string | null;
  batchId: string;
  visible: boolean;
}): Promise<void> {
  const teamId = input.teamId ?? await requireTeamId();
  await requireTeamPermission("training.publish", teamId);
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("team_workouts")
    .update({
      athlete_visible: !!input.visible,
      athlete_visible_updated_at: now,
      published_at: input.visible ? now : null,
    })
    .eq("team_id", teamId)
    .eq("batch_id", input.batchId);

  if (error) throw error;
}

export async function setWorkoutVisibilityByIds(ids: string[], visible: boolean): Promise<void> {
  const teamId = await requireTeamId();
  await requireTeamPermission("training.publish", teamId);
  const cleanIds = Array.from(new Set((ids ?? []).map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (cleanIds.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("team_workouts")
    .update({
      athlete_visible: !!visible,
      athlete_visible_updated_at: now,
      published_at: visible ? now : null,
    })
    .eq("team_id", teamId)
    .in("id", cleanIds);

  if (error) throw error;
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
  await requireTeamPermission("training.edit", teamId);

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
  await requireTeamPermission("training.edit", teamId);
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
  await requireTeamPermission("training.edit", teamId);

  const { error } = await supabase
    .from("team_workouts")
    .delete()
    .eq("team_id", teamId)
    .eq("id", id);

  if (error) throw error;
}

export async function deleteTeamWorkoutsByIds(ids: string[]): Promise<number> {
  const teamId = await requireTeamId();
  await requireTeamPermission("training.edit", teamId);
  const cleanIds = Array.from(
    new Set((Array.isArray(ids) ? ids : []).map((id) => String(id ?? "").trim()).filter(Boolean))
  );
  if (cleanIds.length === 0) return 0;

  const { data, error } = await supabase
    .from("team_workouts")
    .delete()
    .eq("team_id", teamId)
    .in("id", cleanIds)
    .select("id");

  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

export async function deleteWorkoutBatch(batchId: string): Promise<number> {
  const teamId = await requireTeamId();
  await requireTeamPermission("training.edit", teamId);
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
