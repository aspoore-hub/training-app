import { supabase } from "./supabase";
import { getCurrentTeamId, listTeamAthletes, type TeamAthlete } from "./team";

// Authoritative roster source: team_athletes.
// Do not add alternative roster read/write paths for this domain.
export type TeamRosterAthlete = {
  id: string;
  athleteProfileId: string;
  teamId: string;
  displayName: string;
  firstName: string;
  lastName: string;
  sortableName: string;
  searchText: string;
  email: string | null;
  claimedUserId: string | null;
  gradYear: number | null;
  isActive: boolean | null;
  rosterStatus: string | null;
  leftAt: string | null;
  teamStartDate: string | null;
  teamEndDate: string | null;
};

export type AthleteSeasonTenureStatus = "applies" | "before_team_start" | "after_team_end";

function isRosterStatusActive(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "active";
}

function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const clean = String(displayName ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return { firstName: "", lastName: "" };
  const parts = clean.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1] ?? "",
  };
}

export function compareAthleteDisplayNamesByLastName(aName: string, bName: string): number {
  const a = splitDisplayName(aName);
  const b = splitDisplayName(bName);
  const last = String(a.lastName ?? "").toLowerCase().localeCompare(String(b.lastName ?? "").toLowerCase());
  if (last !== 0) return last;
  const first = String(a.firstName ?? "").toLowerCase().localeCompare(String(b.firstName ?? "").toLowerCase());
  if (first !== 0) return first;
  return String(aName ?? "").toLowerCase().localeCompare(String(bName ?? "").toLowerCase());
}

function normalizeDisplayName(raw: Partial<TeamAthlete>): string {
  const fromDisplay = String(raw.display_name ?? "").trim();
  if (fromDisplay) return fromDisplay;

  const first = String(raw.first_name ?? "").trim();
  const last = String(raw.last_name ?? "").trim();
  const joined = `${first} ${last}`.trim();
  return joined || "Athlete";
}

function normalizeSearchText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

export function fallbackAthleteDisplayName(athleteProfileId: string): string {
  const clean = String(athleteProfileId ?? "").trim();
  if (!clean) return "Athlete";
  return `Athlete (${clean.slice(-6)})`;
}

export function normalizeTeamRosterAthlete(raw: Partial<TeamAthlete> & { active?: boolean | null }): TeamRosterAthlete | null {
  const id = String(raw.id ?? "").trim();
  if (!id) return null;

  const teamId = String(raw.team_id ?? "").trim();
  const displayName = normalizeDisplayName(raw);
  const firstName = String(raw.first_name ?? "").trim() || splitDisplayName(displayName).firstName;
  const lastName = String(raw.last_name ?? "").trim() || splitDisplayName(displayName).lastName;
  const sortableName = `${String(lastName).toLowerCase()}|${String(firstName).toLowerCase()}|${String(displayName).toLowerCase()}`;
  const email = String(raw.email ?? "").trim() || null;

  return {
    id,
    athleteProfileId: id,
    teamId,
    displayName,
    firstName,
    lastName,
    sortableName,
    searchText: normalizeSearchText([displayName, firstName, lastName, email, id]),
    email,
    claimedUserId: String(raw.claimed_user_id ?? "").trim() || null,
    gradYear: typeof raw.grad_year === "number" && Number.isFinite(raw.grad_year) ? raw.grad_year : null,
    isActive: typeof raw.active === "boolean" ? raw.active : isRosterStatusActive(raw.roster_status),
    rosterStatus: String(raw.roster_status ?? "").trim() || null,
    leftAt: String(raw.left_at ?? "").trim() || null,
    teamStartDate: String(raw.team_start_date ?? "").trim() || null,
    teamEndDate: String(raw.team_end_date ?? "").trim() || null,
  };
}

function isValidDateOnlyISO(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeDateOnly(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return isValidDateOnlyISO(text) ? text : null;
}

type AthleteEligibilityOptions = {
  includeArchived?: boolean;
  includeInactive?: boolean;
};

type AthleteEligibilityInput =
  | {
      isActive?: boolean | null;
      rosterStatus?: string | null;
      roster_status?: string | null;
      teamStartDate?: string | null;
      teamEndDate?: string | null;
      team_start_date?: string | null;
      team_end_date?: string | null;
      leftAt?: string | null;
      left_at?: string | null;
    }
  | null
  | undefined;

function getAthleteRosterStatus(athlete: AthleteEligibilityInput): string {
  return String(
    athlete && "rosterStatus" in athlete
      ? athlete.rosterStatus
      : athlete && "roster_status" in athlete
        ? athlete.roster_status
        : ""
  ).trim().toLowerCase();
}

function getAthleteStartDate(athlete: AthleteEligibilityInput): string | null {
  return normalizeDateOnly(
    athlete && "teamStartDate" in athlete
      ? athlete.teamStartDate
      : athlete && "team_start_date" in athlete
        ? athlete.team_start_date
        : null
  );
}

function getAthleteEndDate(athlete: AthleteEligibilityInput): string | null {
  return normalizeDateOnly(
    athlete && "teamEndDate" in athlete
      ? athlete.teamEndDate
      : athlete && "team_end_date" in athlete
        ? athlete.team_end_date
        : null
  );
}

export function isAthleteArchived(athlete: AthleteEligibilityInput): boolean {
  return getAthleteRosterStatus(athlete) === "archived";
}

export function isAthleteActiveByRosterStatus(
  athlete: AthleteEligibilityInput,
  options: AthleteEligibilityOptions = {}
): boolean {
  if (!athlete) return false;
  if (!options.includeArchived && isAthleteArchived(athlete)) return false;
  if (options.includeInactive) return true;
  if (typeof athlete.isActive === "boolean") return athlete.isActive;
  return isRosterStatusActive(getAthleteRosterStatus(athlete));
}

export function isAthleteActiveOnDate(
  athlete: AthleteEligibilityInput,
  dateISO: string,
  options: AthleteEligibilityOptions = {}
): boolean {
  const date = normalizeDateOnly(dateISO);
  if (!date || !isAthleteActiveByRosterStatus(athlete, options)) return false;
  const start = getAthleteStartDate(athlete);
  const end = getAthleteEndDate(athlete);
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

export function doesAthleteOverlapDateRange(
  athlete: AthleteEligibilityInput,
  startISO: string,
  endISO: string,
  options: AthleteEligibilityOptions = {}
): boolean {
  const start = normalizeDateOnly(startISO);
  const end = normalizeDateOnly(endISO);
  if (!start || !end || end < start) return false;
  if (!isAthleteActiveByRosterStatus(athlete, options)) return false;
  const athleteStart = getAthleteStartDate(athlete);
  const athleteEnd = getAthleteEndDate(athlete);
  if (athleteStart && athleteStart > end) return false;
  if (athleteEnd && athleteEnd < start) return false;
  return true;
}

export function filterActiveAthletesForDate<T extends AthleteEligibilityInput>(
  athletes: T[],
  dateISO: string,
  options: AthleteEligibilityOptions = {}
): T[] {
  return (Array.isArray(athletes) ? athletes : []).filter((athlete) =>
    isAthleteActiveOnDate(athlete, dateISO, options)
  );
}

export function filterActiveAthletesForRange<T extends AthleteEligibilityInput>(
  athletes: T[],
  startISO: string,
  endISO: string,
  options: AthleteEligibilityOptions = {}
): T[] {
  return (Array.isArray(athletes) ? athletes : []).filter((athlete) =>
    doesAthleteOverlapDateRange(athlete, startISO, endISO, options)
  );
}

export function isAthleteWithinTeamTenureOnDate(
  athlete:
    | {
        teamStartDate?: string | null;
        teamEndDate?: string | null;
        team_start_date?: string | null;
        team_end_date?: string | null;
      }
    | null
    | undefined,
  dateISO: string
): boolean {
  const date = String(dateISO ?? "").trim();
  if (!isValidDateOnlyISO(date)) return false;
  const start = String(
    athlete && "teamStartDate" in athlete
      ? athlete.teamStartDate
      : athlete && "team_start_date" in athlete
        ? athlete.team_start_date
        : ""
  ).trim();
  const end = String(
    athlete && "teamEndDate" in athlete
      ? athlete.teamEndDate
      : athlete && "team_end_date" in athlete
        ? athlete.team_end_date
        : ""
  ).trim();

  if (start && isValidDateOnlyISO(start) && date < start) return false;
  if (end && isValidDateOnlyISO(end) && date > end) return false;
  return true;
}

export function getAthleteSeasonTenureStatus(
  athlete:
    | {
        teamStartDate?: string | null;
        teamEndDate?: string | null;
        team_start_date?: string | null;
        team_end_date?: string | null;
      }
    | null
    | undefined,
  season: { start_date?: string | null; end_date?: string | null } | null | undefined
): AthleteSeasonTenureStatus {
  const seasonStart = normalizeDateOnly(season?.start_date);
  const seasonEnd = normalizeDateOnly(season?.end_date);
  const athleteStart = normalizeDateOnly(
    athlete && "teamStartDate" in athlete
      ? athlete.teamStartDate
      : athlete && "team_start_date" in athlete
        ? athlete.team_start_date
        : null
  );
  const athleteEnd = normalizeDateOnly(
    athlete && "teamEndDate" in athlete
      ? athlete.teamEndDate
      : athlete && "team_end_date" in athlete
        ? athlete.team_end_date
        : null
  );

  if (athleteStart && seasonEnd && athleteStart > seasonEnd) return "before_team_start";
  if (athleteEnd && seasonStart && athleteEnd < seasonStart) return "after_team_end";
  return "applies";
}

export function resolveAthleteSeasonWindowWithTenure(
  athlete:
    | {
        teamStartDate?: string | null;
        teamEndDate?: string | null;
        team_start_date?: string | null;
        team_end_date?: string | null;
      }
    | null
    | undefined,
  season: { start_date?: string | null; end_date?: string | null },
  override: { start_date?: string | null; end_date?: string | null } | null | undefined
): { start_date: string; end_date: string } {
  const baseStart = String(override?.start_date ?? season.start_date ?? "").trim();
  const baseEnd = String(override?.end_date ?? season.end_date ?? "").trim();
  const athleteStart = normalizeDateOnly(
    athlete && "teamStartDate" in athlete
      ? athlete.teamStartDate
      : athlete && "team_start_date" in athlete
        ? athlete.team_start_date
        : null
  );
  const athleteEnd = normalizeDateOnly(
    athlete && "teamEndDate" in athlete
      ? athlete.teamEndDate
      : athlete && "team_end_date" in athlete
        ? athlete.team_end_date
        : null
  );

  let resolvedStart = baseStart;
  let resolvedEnd = baseEnd;
  if (athleteStart && isValidDateOnlyISO(baseStart) && athleteStart > baseStart) {
    resolvedStart = athleteStart;
  }
  if (athleteEnd && isValidDateOnlyISO(baseEnd) && athleteEnd < baseEnd) {
    resolvedEnd = athleteEnd;
  }
  return {
    start_date: resolvedStart,
    end_date: resolvedEnd,
  };
}

export function isAthleteEligibleOnDate(
  athlete:
    | {
        isActive?: boolean | null;
        roster_status?: string | null;
        teamStartDate?: string | null;
        teamEndDate?: string | null;
        team_start_date?: string | null;
        team_end_date?: string | null;
      }
    | null
    | undefined,
  dateISO: string
): boolean {
  return isAthleteActiveOnDate(athlete, dateISO);
}

export function isAthleteEligibleDuringWeek(
  athlete:
    | {
        isActive?: boolean | null;
        roster_status?: string | null;
        teamStartDate?: string | null;
        teamEndDate?: string | null;
        team_start_date?: string | null;
        team_end_date?: string | null;
      }
    | null
    | undefined,
  weekStartISO: string,
  weekEndISO: string
): boolean {
  return doesAthleteOverlapDateRange(athlete, weekStartISO, weekEndISO);
}

export function isAthleteEligibleForPlanningDate(input: {
  athlete:
    | {
        id?: string | null;
        isActive?: boolean | null;
        roster_status?: string | null;
        teamStartDate?: string | null;
        teamEndDate?: string | null;
        team_start_date?: string | null;
        team_end_date?: string | null;
      }
    | null
    | undefined;
  dateISO: string;
  selectedSeason?:
    | {
        id?: string | null;
        start_date?: string | null;
        end_date?: string | null;
      }
    | null
    | undefined;
  athleteSeasonOverride?: { start_date?: string | null; end_date?: string | null } | null | undefined;
  selectedTrainingGroupIds?: string[] | null | undefined;
  trainingGroupMemberships?:
    | Array<{
        group_id?: string | null;
        athlete_profile_id?: string | null;
        ends_on?: string | null;
      }>
    | null
    | undefined;
  isAthleteExcludedFromSeason?: ((athleteId: string, seasonId: string) => boolean) | null;
}): boolean {
  const athlete = input.athlete;
  const dateISO = String(input.dateISO ?? "").trim();
  if (!athlete) return false;
  if (!isAthleteEligibleOnDate(athlete, dateISO)) return false;

  const athleteId = String(athlete.id ?? "").trim();
  const selectedGroupIds = Array.isArray(input.selectedTrainingGroupIds)
    ? input.selectedTrainingGroupIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  if (selectedGroupIds.length > 0) {
    if (!athleteId) return false;
    const groupSet = new Set(selectedGroupIds);
    const inSelectedGroup = (Array.isArray(input.trainingGroupMemberships) ? input.trainingGroupMemberships : []).some(
      (membership) =>
        membership?.ends_on == null &&
        groupSet.has(String(membership?.group_id ?? "").trim()) &&
        String(membership?.athlete_profile_id ?? "").trim() === athleteId
    );
    if (!inSelectedGroup) return false;
  }

  const selectedSeason = input.selectedSeason ?? null;
  const seasonId = String(selectedSeason?.id ?? "").trim();
  if (!selectedSeason || !seasonId) return true;

  if (athleteId && input.isAthleteExcludedFromSeason?.(athleteId, seasonId)) return false;

  const resolved = resolveAthleteSeasonWindowWithTenure(athlete, selectedSeason, input.athleteSeasonOverride ?? null);
  const start = normalizeDateOnly(resolved.start_date);
  const end = normalizeDateOnly(resolved.end_date);
  if (!start || !end) return true;
  if (start > end) return false;
  return dateISO >= start && dateISO <= end;
}

export function compareRosterAthletesByName(a: TeamRosterAthlete, b: TeamRosterAthlete): number {
  return a.sortableName.localeCompare(b.sortableName);
}

export function sortRosterByName(roster: TeamRosterAthlete[]): TeamRosterAthlete[] {
  return [...(Array.isArray(roster) ? roster : [])].sort(compareRosterAthletesByName);
}

export function searchRoster(roster: TeamRosterAthlete[], query: string): TeamRosterAthlete[] {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return sortRosterByName(roster);
  return sortRosterByName(roster).filter((athlete) => athlete.searchText.includes(q));
}

export function toRosterMapById(roster: TeamRosterAthlete[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const athlete of roster) {
    const id = String(athlete.id ?? "").trim();
    if (!id) continue;
    out.set(id, String(athlete.displayName ?? "").trim() || fallbackAthleteDisplayName(id));
  }
  return out;
}

export function resolveAthleteDisplayName(
  athleteProfileId: string | null | undefined,
  mapById: Map<string, string>,
  fallbackFromWorkout?: string | null
): string {
  const id = String(athleteProfileId ?? "").trim();
  if (!id) return String(fallbackFromWorkout ?? "").trim() || "Athlete";
  const fromMap = String(mapById.get(id) ?? "").trim();
  if (fromMap) return fromMap;
  const fallback = String(fallbackFromWorkout ?? "").trim();
  if (fallback) return fallback;
  return fallbackAthleteDisplayName(id);
}

async function listTeamAthletesForTeam(teamId: string): Promise<TeamAthlete[]> {
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

export async function loadTeamRoster(teamId?: string): Promise<TeamRosterAthlete[]> {
  const cleanedTeamId = String(teamId ?? "").trim();
  const rows = cleanedTeamId ? await listTeamAthletesForTeam(cleanedTeamId) : await listTeamAthletes();
  return sortRosterByName(
    (rows ?? [])
      .map((row) => normalizeTeamRosterAthlete(row))
      .filter((row): row is TeamRosterAthlete => !!row)
  );
}

export async function getSortableRoster(teamId?: string): Promise<TeamRosterAthlete[]> {
  const roster = await loadTeamRoster(teamId);
  return sortRosterByName(roster);
}

export async function getRosterMapById(teamId?: string): Promise<Map<string, string>> {
  const roster = await loadTeamRoster(teamId);
  return toRosterMapById(roster);
}

export async function getCurrentTeamRoster(): Promise<TeamRosterAthlete[]> {
  const teamId = await getCurrentTeamId();
  return loadTeamRoster(teamId);
}
