import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadJSON, saveJSON } from "./storage";

export const MILEAGE_FEEDBACK_KEY = "training_app_mileage_feedback_v1";

export type MileageSessionFeedback = {
  id: string;
  athleteId?: string;
  athleteName?: string;
  dateISO: string;
  session: "AM" | "PM";
  prescribed?: string;
  completedMiles?: number | string;
  completedTime?: string;
  splitsOrPace?: string;
  additionalFeedback?: string;
  updatedAt: number;
};

function normalizeSession(value: string | undefined): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
}

function normalizeAthleteKey(athleteId?: string, athleteName?: string) {
  if (athleteId && String(athleteId).trim()) return `id:${String(athleteId).trim()}`;
  return `name:${String(athleteName ?? "").trim().toLowerCase()}`;
}

export function buildMileageFeedbackId(input: {
  athleteId?: string;
  athleteName?: string;
  dateISO: string;
  session: "AM" | "PM";
}) {
  const athleteKey = normalizeAthleteKey(input.athleteId, input.athleteName);
  return `${athleteKey}|${input.dateISO}|${normalizeSession(input.session)}`;
}

export async function loadMileageFeedback(): Promise<MileageSessionFeedback[]> {
  const raw = await loadJSON<MileageSessionFeedback[]>(MILEAGE_FEEDBACK_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => entry && typeof entry === "object");
}

export async function saveMileageFeedback(list: MileageSessionFeedback[]) {
  await saveJSON(MILEAGE_FEEDBACK_KEY, list);
}

export async function upsertMileageFeedback(entry: MileageSessionFeedback) {
  const list = await loadMileageFeedback();
  const next = [...list.filter((item) => item.id !== entry.id), entry];
  await saveMileageFeedback(next);
}

export async function getMileageFeedbackById(id: string) {
  const list = await loadMileageFeedback();
  return list.find((item) => item.id === id) ?? null;
}

export async function migrateLocalMileageFeedbackToTeamForAthlete(input: {
  athleteId?: string | null;
  athleteName?: string | null;
}) {
  const athleteId = String(input.athleteId ?? "").trim();
  const athleteName = String(input.athleteName ?? "").trim().toLowerCase();
  if (!athleteId && !athleteName) return;

  let localEntries: MileageSessionFeedback[] = [];
  try {
    const raw = await AsyncStorage.getItem(MILEAGE_FEEDBACK_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    localEntries = Array.isArray(parsed)
      ? parsed.filter((entry) => entry && typeof entry === "object")
      : [];
  } catch {
    return;
  }

  const matchingLocalEntries = localEntries.filter((entry) => {
    const entryAthleteId = String(entry.athleteId ?? "").trim();
    if (athleteId && entryAthleteId === athleteId) return true;
    if (entryAthleteId) return false;
    return athleteName.length > 0 && String(entry.athleteName ?? "").trim().toLowerCase() === athleteName;
  });
  if (matchingLocalEntries.length === 0) return;

  const latestTeamEntries = await loadMileageFeedback();
  const byId = new Map<string, MileageSessionFeedback>();
  for (const entry of latestTeamEntries) {
    if (entry?.id) byId.set(entry.id, entry);
  }

  let changed = false;
  for (const entry of matchingLocalEntries) {
    if (!entry?.id) continue;
    const existing = byId.get(entry.id);
    const existingUpdatedAt = Number(existing?.updatedAt ?? 0);
    const localUpdatedAt = Number(entry.updatedAt ?? 0);
    if (!existing || localUpdatedAt >= existingUpdatedAt) {
      byId.set(entry.id, entry);
      changed = true;
    }
  }

  if (changed) {
    await saveMileageFeedback(Array.from(byId.values()));
  }
}
