import { getRosterMapById, normalizeTeamRosterAthlete, toRosterMapById } from "./teamRoster";

export type RosterMap = Map<string, string>; // athlete_profile_id -> display_name

export async function loadRosterNameMapForTeam(teamId: string): Promise<RosterMap> {
  return getRosterMapById(teamId);
}

// Backward-compatible alias used by batch editor screens.
export function buildRosterNameMap(
  rows: Array<{
    athlete_profile_id?: string | null;
    athlete_id?: string | null;
    id?: string | null;
    display_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    team_id?: string | null;
  }> = []
): RosterMap {
  return toRosterMapById(
    (rows ?? [])
      .map((row) =>
        normalizeTeamRosterAthlete({
          id: row?.athlete_profile_id ?? row?.athlete_id ?? row?.id ?? undefined,
          display_name: row?.display_name ?? undefined,
          first_name: row?.first_name ?? undefined,
          last_name: row?.last_name ?? undefined,
          email: row?.email ?? undefined,
          team_id: row?.team_id ?? undefined,
        })
      )
      .filter((item): item is NonNullable<typeof item> => !!item)
  );
}
