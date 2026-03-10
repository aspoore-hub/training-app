import { loadJSONWithTeamCloudSync, saveJSONWithTeamCloudSync } from "./teamCloudSync";
import { loadJSON } from "./storage";

export const ROSTER_V1_KEY = "training_app_roster_v1";
export const ROSTER_V2_KEY = "training_app_roster_v2";

export type AthleteProfile = {
  id: string;         // stable
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
};

export function athleteDisplayName(a: AthleteProfile) {
  const full = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
  return full || "Athlete";
}

export function compareAthletesByLastName(a: AthleteProfile, b: AthleteProfile) {
  const aLast = String(a.lastName ?? "").trim().toLowerCase();
  const bLast = String(b.lastName ?? "").trim().toLowerCase();
  const byLast = aLast.localeCompare(bLast);
  if (byLast !== 0) return byLast;

  const aFirst = String(a.firstName ?? "").trim().toLowerCase();
  const bFirst = String(b.firstName ?? "").trim().toLowerCase();
  const byFirst = aFirst.localeCompare(bFirst);
  if (byFirst !== 0) return byFirst;

  const aName = athleteDisplayName(a).toLowerCase();
  const bName = athleteDisplayName(b).toLowerCase();
  const byName = aName.localeCompare(bName);
  if (byName !== 0) return byName;

  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

export function sortRosterByLastName(list: AthleteProfile[]) {
  return [...list].sort(compareAthletesByLastName);
}

function slugName(name: string) {
  return String(name ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function splitName(name: string) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function rosterDisplayName(a: any) {
  if (typeof a === "string") return a.trim();
  const direct =
    a?.name ??
    a?.fullName ??
    a?.athleteName ??
    a?.athlete ??
    a?.displayName ??
    a?.label;
  return String(direct ?? "").trim();
}

function normalizeFromAny(raw: any, index: number): AthleteProfile {
  // legacy string roster
  if (typeof raw === "string") {
    const name = raw.trim();
    const { firstName, lastName } = splitName(name);
    const id = `ath_${slugName(name) || `athlete_${index}`}`;
    return { id, firstName, lastName };
  }

  const name = rosterDisplayName(raw);
  const existingId = String(raw?.id ?? raw?.athleteId ?? "").trim();
  const id = existingId || `ath_${slugName(name) || `athlete_${index}`}`;

  const firstName = String(raw?.firstName ?? "").trim();
  const lastName = String(raw?.lastName ?? "").trim();

  // If old object only had "name", split it
  const split = (!firstName && !lastName && name) ? splitName(name) : null;

  const email = raw?.email ? String(raw.email).trim() : undefined;
  const phone = raw?.phone ? String(raw.phone).trim() : undefined;

  return {
    id,
    firstName: split ? split.firstName : firstName,
    lastName: split ? split.lastName : lastName,
    email: email || undefined,
    phone: phone || undefined,
  };
}

export async function loadRoster(): Promise<AthleteProfile[]> {
  // IMPORTANT: use TEAM sync so web + mobile see the same roster
  const v2 = await loadJSONWithTeamCloudSync<AthleteProfile[]>(ROSTER_V2_KEY, []);
  if (Array.isArray(v2) && v2.length) return sortRosterByLastName(v2);

  // fall back to v1
  const v1 = await loadJSON<any[]>(ROSTER_V1_KEY, []);
  if (!Array.isArray(v1)) return [];
  return sortRosterByLastName(v1.map((a, i) => normalizeFromAny(a, i)));
}

export async function saveRoster(list: AthleteProfile[]) {
  // IMPORTANT: use TEAM sync so web + mobile see the same roster
  await saveJSONWithTeamCloudSync<AthleteProfile[]>(ROSTER_V2_KEY, sortRosterByLastName(list));
}

export async function migrateRosterToV2Once() {
  const v2 = await loadJSON<AthleteProfile[]>(ROSTER_V2_KEY, []);
  if (Array.isArray(v2) && v2.length) return;

  const roster = await loadRoster();
  if (roster.length) {
    await saveJSONWithTeamCloudSync<AthleteProfile[]>(ROSTER_V2_KEY, roster);
  }
}
