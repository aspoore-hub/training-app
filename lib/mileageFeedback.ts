import { loadJSON, saveJSON } from "./storage";

export const MILEAGE_FEEDBACK_KEY = "training_app_mileage_feedback_v1";

export type MileageSessionFeedback = {
  id: string;
  athleteId?: string;
  athleteName?: string;
  dateISO: string;
  session: "AM" | "PM";
  prescribed?: string;
  completedMiles?: number;
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
