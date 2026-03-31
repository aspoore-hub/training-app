import { resolveAthleteDisplayName } from "./teamRoster";
import type { TeamWorkoutRow } from "./teamWorkoutsCloud";

export type TeamWorkoutLegacyNameRow = TeamWorkoutRow & {
  athlete_name?: string | null;
};

export function resolveWorkoutAthleteName(
  row: TeamWorkoutLegacyNameRow,
  rosterMap: Map<string, string>
): string {
  return resolveAthleteDisplayName(
    row.athlete_profile_id,
    rosterMap,
    String(row.athlete_name ?? "").trim()
  );
}

export function normalizeWorkoutGroupId(raw: unknown): string {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (!digits) return "1";
  const parsed = Number(digits);
  if (!Number.isFinite(parsed) || parsed <= 0) return "1";
  return String(Math.floor(parsed));
}

export function splitIntoKGroups<T>(items: T[], k: number): T[][] {
  if (k <= 1) return [items];
  const groups: T[][] = Array.from({ length: k }, () => []);
  items.forEach((item, i) => groups[i % k].push(item));
  return groups.filter((group) => group.length > 0);
}

export function splitIntoPairs<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2));
  if (out.length >= 2 && out[out.length - 1].length === 1) {
    out[out.length - 2] = out[out.length - 2].concat(out.pop() as T[]);
  }
  return out;
}
