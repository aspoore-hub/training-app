import { loadJSON } from "./storage";
import { getCurrentTeamId, getMyClaimedAthleteProfileId, getTeamAthlete } from "./team";

const SELECTED_KEY = "training_app_selected_athlete_v1";

export type AthleteSessionContext = {
  teamId: string;
  athleteId: string | null;
  athleteName: string | null;
};

let cached: AthleteSessionContext | null = null;
let inflight: Promise<AthleteSessionContext> | null = null;

async function resolveFresh(): Promise<AthleteSessionContext> {
  const [selected, teamId] = await Promise.all([
    loadJSON<string | null>(SELECTED_KEY, null),
    getCurrentTeamId(),
  ]);
  const claimedAthleteId = await getMyClaimedAthleteProfileId(teamId);
  const fallbackSelected = String(selected ?? "").trim();
  const athleteId = String(claimedAthleteId ?? fallbackSelected).trim() || null;

  let athleteName: string | null = null;
  if (athleteId) {
    try {
      const athlete = await getTeamAthlete(athleteId);
      athleteName = String(athlete?.display_name ?? "").trim() || null;
    } catch {
      athleteName = null;
    }
  }

  return { teamId, athleteId, athleteName };
}

export async function resolveAthleteSessionContext(forceRefresh: boolean = false): Promise<AthleteSessionContext> {
  if (!forceRefresh && cached) return cached;
  if (!forceRefresh && inflight) return inflight;

  inflight = resolveFresh()
    .then((value) => {
      cached = value;
      return value;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function clearAthleteSessionContextCache() {
  cached = null;
  inflight = null;
}
