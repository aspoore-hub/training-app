import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import { requireTeamPermission } from "./teamPermissions";
import {
  listTeamAthleteSeasonOverrides,
  listTeamSeasons,
  type TeamAthleteSeasonOverrideRow,
  type TeamSeasonRow,
} from "./seasonsCloud";
import {
  loadTeamRoster,
  resolveAthleteSeasonWindowWithTenure,
  type TeamRosterAthlete,
} from "./teamRoster";

export type SeasonWeekVisibilityRow = {
  team_id: string;
  season_id: string;
  week_start_iso: string;
  athlete_visible: boolean;
  updated_at: string;
  updated_by: string | null;
};

type VisibilityContent = {
  includeWorkouts?: boolean;
  includeMileage?: boolean;
};

type EligibilityContext = {
  seasons: TeamSeasonRow[];
  roster: TeamRosterAthlete[];
  overrides: TeamAthleteSeasonOverrideRow[];
};

type WorkoutVisibilityInputRow = {
  athlete_profile_id?: string | null;
  date_iso: string;
};

function isValidDateISO(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeDateISO(value: unknown): string {
  return String(value ?? "").trim().slice(0, 10);
}

export function normalizeWeekStartISO(value: unknown): string {
  return normalizeDateISO(value);
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

function getWeekStartISOForDate(dateISO: string, weekStartsOn: 0 | 1 = 1): string {
  const clean = normalizeDateISO(dateISO);
  if (!isValidDateISO(clean)) return "";
  const [year, month, day] = clean.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return "";
  const jsDay = date.getDay();
  const diff = weekStartsOn === 0 ? jsDay : (jsDay + 6) % 7;
  date.setDate(date.getDate() - diff);
  return addDaysISO(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`, 0);
}

export function weekStartISOsForDateRange(startISO: string, endISO: string, weekStartsOn: 0 | 1 = 1): string[] {
  const start = normalizeDateISO(startISO);
  const end = normalizeDateISO(endISO);
  if (!isValidDateISO(start) || !isValidDateISO(end) || start > end) return [];
  const out: string[] = [];
  let cursor = getWeekStartISOForDate(start, weekStartsOn);
  const last = getWeekStartISOForDate(end, weekStartsOn);
  while (cursor && cursor <= last) {
    out.push(cursor);
    cursor = addDaysISO(cursor, 7);
  }
  return out;
}

async function getUserIdOrNull(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user?.id ?? null;
}

async function requireTeamId(): Promise<string> {
  const teamId = await getCurrentTeamId();
  if (!teamId) throw new Error("No team selected (teamId missing).");
  return teamId;
}

async function loadEligibilityContext(teamId: string): Promise<EligibilityContext> {
  const [seasons, roster, overrides] = await Promise.all([
    listTeamSeasons(),
    loadTeamRoster(teamId),
    listTeamAthleteSeasonOverrides(),
  ]);
  return { seasons, roster, overrides };
}

function overrideKey(seasonId: string, athleteId: string) {
  return `${seasonId}:${athleteId}`;
}

function isAthleteEligibleForSeasonWeek(input: {
  athlete: TeamRosterAthlete | null | undefined;
  season: TeamSeasonRow | null | undefined;
  override?: TeamAthleteSeasonOverrideRow | null;
  weekStartISO: string;
}) {
  const { athlete, season, override } = input;
  const weekStartISO = normalizeWeekStartISO(input.weekStartISO);
  if (!athlete || !season || !weekStartISO) return false;
  if (String(athlete.rosterStatus ?? "").trim().toLowerCase() === "archived") return false;
  if (athlete.isActive === false) return false;
  if (override?.is_excluded) return false;
  const weekEndISO = addDaysISO(weekStartISO, 6);
  const resolved = resolveAthleteSeasonWindowWithTenure(athlete, season, override ?? null);
  const start = normalizeDateISO(resolved.start_date);
  const end = normalizeDateISO(resolved.end_date);
  if (!isValidDateISO(start) || !isValidDateISO(end) || start > end) return false;
  return start <= weekEndISO && end >= weekStartISO;
}

function eligibleAthleteIdsForSeasonWeek(
  context: EligibilityContext,
  seasonId: string,
  weekStartISO: string,
  athleteFilter?: string[]
) {
  const season = context.seasons.find((row) => String(row.id ?? "").trim() === seasonId) ?? null;
  if (!season) return [];
  const filter = new Set((athleteFilter ?? []).map((id) => String(id ?? "").trim()).filter(Boolean));
  const overridesByKey = new Map(
    context.overrides.map((row) => [overrideKey(String(row.season_id ?? "").trim(), String(row.athlete_profile_id ?? "").trim()), row])
  );
  return context.roster
    .filter((athlete) => {
      const athleteId = String(athlete.id ?? "").trim();
      if (!athleteId) return false;
      if (filter.size > 0 && !filter.has(athleteId)) return false;
      return isAthleteEligibleForSeasonWeek({
        athlete,
        season,
        override: overridesByKey.get(overrideKey(seasonId, athleteId)) ?? null,
        weekStartISO,
      });
    })
    .map((athlete) => String(athlete.id ?? "").trim());
}

async function syncLegacyMileageVisibility(input: {
  teamId: string;
  athleteIds: string[];
  weekStartISO: string;
  visible: boolean;
  userId: string | null;
}) {
  const athleteIds = Array.from(new Set(input.athleteIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (athleteIds.length === 0) return 0;
  const now = new Date().toISOString();
  const rows = athleteIds.map((athleteId) => ({
    team_id: input.teamId,
    athlete_profile_id: athleteId,
    week_start_iso: input.weekStartISO,
    athlete_visible: input.visible,
    athlete_visible_updated_at: now,
    published_at: input.visible ? now : null,
    hidden_at: input.visible ? null : now,
    updated_by: input.userId,
    updated_at: now,
  }));
  const { error } = await supabase
    .from("team_mileage_week_visibility")
    .upsert(rows, { onConflict: "team_id,athlete_profile_id,week_start_iso" });
  if (error) throw error;
  return rows.length;
}

async function syncWorkoutVisibility(input: {
  teamId: string;
  athleteIds: string[];
  weekStartISO: string;
  visible: boolean;
}) {
  const athleteIds = Array.from(new Set(input.athleteIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (athleteIds.length === 0) return 0;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("team_workouts")
    .update({
      athlete_visible: input.visible,
      athlete_visible_updated_at: now,
      published_at: input.visible ? now : null,
    })
    .eq("team_id", input.teamId)
    .in("athlete_profile_id", athleteIds)
    .gte("date_iso", input.weekStartISO)
    .lte("date_iso", addDaysISO(input.weekStartISO, 6))
    .select("id");
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

export async function fetchSeasonWeekVisibilityForWeek(input: {
  teamId?: string | null;
  seasonId: string;
  weekStartISO: string;
}): Promise<SeasonWeekVisibilityRow | null> {
  const teamId = input.teamId ?? await requireTeamId();
  const seasonId = String(input.seasonId ?? "").trim();
  const weekStartISO = normalizeWeekStartISO(input.weekStartISO);
  if (!seasonId || !weekStartISO) return null;
  const { data, error } = await supabase
    .from("team_season_week_visibility")
    .select("team_id,season_id,week_start_iso,athlete_visible,updated_at,updated_by")
    .eq("team_id", teamId)
    .eq("season_id", seasonId)
    .eq("week_start_iso", weekStartISO)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as SeasonWeekVisibilityRow | null;
}

export async function setSeasonWeekVisibility(input: {
  teamId?: string | null;
  seasonId: string;
  weekStartISO: string;
  visible: boolean;
  athleteIds?: string[] | null;
} & VisibilityContent): Promise<{ athleteCount: number; workoutRows: number; mileageRows: number }> {
  const teamId = input.teamId ?? await requireTeamId();
  await requireTeamPermission("training.publish", teamId);
  const seasonId = String(input.seasonId ?? "").trim();
  const weekStartISO = normalizeWeekStartISO(input.weekStartISO);
  if (!seasonId) throw new Error("Select a season before changing visibility.");
  if (!weekStartISO) throw new Error("Missing week start for visibility.");

  const userId = await getUserIdOrNull();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("team_season_week_visibility")
    .upsert({
      team_id: teamId,
      season_id: seasonId,
      week_start_iso: weekStartISO,
      athlete_visible: !!input.visible,
      updated_at: now,
      updated_by: userId,
    }, { onConflict: "team_id,season_id,week_start_iso" });
  if (error) throw error;

  const context = await loadEligibilityContext(teamId);
  const athleteIds = eligibleAthleteIdsForSeasonWeek(
    context,
    seasonId,
    weekStartISO,
    input.athleteIds?.map((id) => String(id ?? "").trim()).filter(Boolean) ?? undefined
  );
  const includeWorkouts = input.includeWorkouts !== false;
  const includeMileage = input.includeMileage !== false;
  const [workoutRows, mileageRows] = await Promise.all([
    includeWorkouts ? syncWorkoutVisibility({ teamId, athleteIds, weekStartISO, visible: !!input.visible }) : Promise.resolve(0),
    includeMileage ? syncLegacyMileageVisibility({ teamId, athleteIds, weekStartISO, visible: !!input.visible, userId }) : Promise.resolve(0),
  ]);
  return { athleteCount: athleteIds.length, workoutRows, mileageRows };
}

export async function setSeasonWeekVisibilityByDateRange(input: {
  teamId?: string | null;
  seasonId: string;
  startISO: string;
  endISO: string;
  visible: boolean;
  weekStartsOn?: 0 | 1;
  athleteIds?: string[] | null;
} & VisibilityContent): Promise<{ athleteCount: number; weekCount: number; workoutRows: number; mileageRows: number; weekStartISOs: string[] }> {
  const weekStartISOs = weekStartISOsForDateRange(input.startISO, input.endISO, input.weekStartsOn ?? 1);
  let athleteCount = 0;
  let workoutRows = 0;
  let mileageRows = 0;
  for (const weekStartISO of weekStartISOs) {
    const result = await setSeasonWeekVisibility({ ...input, weekStartISO });
    athleteCount = Math.max(athleteCount, result.athleteCount);
    workoutRows += result.workoutRows;
    mileageRows += result.mileageRows;
  }
  return { athleteCount, weekCount: weekStartISOs.length, workoutRows, mileageRows, weekStartISOs };
}

export async function loadInheritedSeasonWeekVisibilityForWorkoutRows(
  teamId: string,
  rows: WorkoutVisibilityInputRow[],
  weekStartsOn: 0 | 1 = 1,
  seasonId?: string | null
): Promise<Map<string, boolean>> {
  const cleanRows = (rows ?? []).map((row) => ({
    athleteId: String(row.athlete_profile_id ?? "").trim(),
    dateISO: normalizeDateISO(row.date_iso),
  })).filter((row) => row.athleteId && isValidDateISO(row.dateISO));
  const result = new Map<string, boolean>();
  if (cleanRows.length === 0) return result;

  const selectedSeasonId = String(seasonId ?? "").trim();
  const weekStartISOs = Array.from(new Set(cleanRows.map((row) => getWeekStartISOForDate(row.dateISO, weekStartsOn)).filter(Boolean)));
  let query = supabase
    .from("team_season_week_visibility")
    .select("season_id,week_start_iso,athlete_visible")
    .eq("team_id", teamId)
    .in("week_start_iso", weekStartISOs);
  if (selectedSeasonId) query = query.eq("season_id", selectedSeasonId);
  const { data, error } = await query;
  if (error) throw error;

  const visibilityRows = (data ?? []) as Array<{ season_id: string; week_start_iso: string; athlete_visible: boolean }>;
  if (visibilityRows.length === 0) return result;

  const context = await loadEligibilityContext(teamId);
  const rosterById = new Map(context.roster.map((athlete) => [String(athlete.id ?? "").trim(), athlete]));
  const seasonsById = new Map(context.seasons.map((season) => [String(season.id ?? "").trim(), season]));
  const overridesByKey = new Map(
    context.overrides.map((row) => [overrideKey(String(row.season_id ?? "").trim(), String(row.athlete_profile_id ?? "").trim()), row])
  );
  const visibilityByWeek = new Map<string, typeof visibilityRows>();
  visibilityRows.forEach((row) => {
    const week = normalizeWeekStartISO(row.week_start_iso);
    if (!visibilityByWeek.has(week)) visibilityByWeek.set(week, []);
    visibilityByWeek.get(week)?.push(row);
  });

  cleanRows.forEach((row) => {
    const weekStartISO = getWeekStartISOForDate(row.dateISO, weekStartsOn);
    const athlete = rosterById.get(row.athleteId) ?? null;
    const visible = (visibilityByWeek.get(weekStartISO) ?? []).some((visibility) => {
      const seasonId = String(visibility.season_id ?? "").trim();
      return (
        visibility.athlete_visible === true &&
        isAthleteEligibleForSeasonWeek({
          athlete,
          season: seasonsById.get(seasonId) ?? null,
          override: overridesByKey.get(overrideKey(seasonId, row.athleteId)) ?? null,
          weekStartISO,
        })
      );
    });
    result.set(`${row.athleteId}:${weekStartISO}`, visible);
  });
  return result;
}

export async function ensureLegacyMileageVisibilityFromSeasonWeek(input: {
  teamId: string;
  athleteId: string;
  weekStartISO: string;
}) {
  const teamId = input.teamId;
  const athleteId = String(input.athleteId ?? "").trim();
  const weekStartISO = normalizeWeekStartISO(input.weekStartISO);
  if (!teamId || !athleteId || !weekStartISO) return;
  const inherited = await loadInheritedSeasonWeekVisibilityForWorkoutRows(teamId, [
    { athlete_profile_id: athleteId, date_iso: weekStartISO },
  ]);
  const visible = inherited.get(`${athleteId}:${weekStartISO}`) === true;
  await syncLegacyMileageVisibility({
    teamId,
    athleteIds: [athleteId],
    weekStartISO,
    visible,
    userId: await getUserIdOrNull(),
  });
}
