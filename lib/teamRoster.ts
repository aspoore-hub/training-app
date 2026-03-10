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
};

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
    isActive: typeof raw.active === "boolean" ? raw.active : null,
  };
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
    .select("id,team_id,first_name,last_name,display_name,grad_year,email,claimed_user_id,created_at,updated_at")
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
