import AsyncStorage from "@react-native-async-storage/async-storage";
import { getActiveAccountContext } from "./accountContexts";
import { loadJSON, saveJSON } from "./storage";
import { supabase } from "./supabase";

export const ATHLETE_DAILY_LOG_ENTRIES_KEY = "training_app_athlete_daily_log_entries_v1";

export type AthleteDailyLogSession = "AM" | "PM" | null;
export type AthleteDailyLogEntryType = "daily_note" | "extra_activity";
export type AthleteDailyLogActivityKind = "run" | "cross_training" | "strength" | "mobility" | "other" | null;

export type AthleteDailyLogEntry = {
  id: string;
  athleteId: string;
  athleteName?: string | null;
  dateISO: string;
  session?: AthleteDailyLogSession;
  entryType: AthleteDailyLogEntryType;
  activityKind?: AthleteDailyLogActivityKind;
  title?: string | null;
  completedMiles?: string | number | null;
  completedTime?: string | null;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
};

function normalizeSession(value: unknown): AthleteDailyLogSession {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "AM" || normalized === "PM") return normalized;
  return null;
}

function normalizeEntryType(value: unknown): AthleteDailyLogEntryType {
  return value === "extra_activity" ? "extra_activity" : "daily_note";
}

function normalizeActivityKind(value: unknown): AthleteDailyLogActivityKind {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "run" ||
    normalized === "cross_training" ||
    normalized === "strength" ||
    normalized === "mobility" ||
    normalized === "other"
  ) {
    return normalized;
  }
  return null;
}

function sanitizeEntry(entry: AthleteDailyLogEntry): AthleteDailyLogEntry {
  const now = Date.now();
  return {
    id: String(entry.id ?? "").trim(),
    athleteId: String(entry.athleteId ?? "").trim(),
    athleteName: String(entry.athleteName ?? "").trim() || null,
    dateISO: String(entry.dateISO ?? "").trim(),
    session: normalizeSession(entry.session),
    entryType: normalizeEntryType(entry.entryType),
    activityKind: normalizeActivityKind(entry.activityKind),
    title: String(entry.title ?? "").trim() || null,
    completedMiles: entry.completedMiles ?? null,
    completedTime: String(entry.completedTime ?? "").trim() || null,
    notes: String(entry.notes ?? "").trim() || null,
    createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : now,
    updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : now,
  };
}

export function buildAthleteDailyLogEntryId(input: {
  athleteId: string;
  dateISO: string;
  createdAt?: number;
}) {
  const athleteId = String(input.athleteId ?? "").trim() || "athlete";
  const dateISO = String(input.dateISO ?? "").trim() || "date";
  const timestamp = Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `log:${athleteId}:${dateISO}:${timestamp}:${random}`;
}

export async function loadAthleteDailyLogEntries(): Promise<AthleteDailyLogEntry[]> {
  const raw = await loadJSON<AthleteDailyLogEntry[]>(ATHLETE_DAILY_LOG_ENTRIES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => sanitizeEntry(entry as AthleteDailyLogEntry))
    .filter((entry) => !!entry.id && !!entry.athleteId && !!entry.dateISO);
}

export async function saveAthleteDailyLogEntries(entries: AthleteDailyLogEntry[]) {
  await saveJSON(
    ATHLETE_DAILY_LOG_ENTRIES_KEY,
    entries
      .map((entry) => sanitizeEntry(entry))
      .filter((entry) => !!entry.id && !!entry.athleteId && !!entry.dateISO)
  );
}

export async function listAthleteDailyLogEntriesForWeek(
  athleteId: string,
  weekStartISO: string,
  weekEndISO: string
): Promise<AthleteDailyLogEntry[]> {
  const normalizedAthleteId = String(athleteId ?? "").trim();
  if (!normalizedAthleteId) return [];
  const entries = await loadAthleteDailyLogEntries();
  return entries.filter((entry) => {
    if (String(entry.athleteId ?? "").trim() !== normalizedAthleteId) return false;
    const dateISO = String(entry.dateISO ?? "");
    return dateISO >= weekStartISO && dateISO <= weekEndISO;
  });
}

export async function upsertAthleteDailyLogEntry(entry: AthleteDailyLogEntry) {
  const sanitized = sanitizeEntry(entry);
  const context = await getActiveAccountContext();
  if (
    context?.kind === "athlete" &&
    context.teamId &&
    context.athleteId &&
    context.athleteId === sanitized.athleteId
  ) {
    const { data, error } = await supabase.rpc("upsert_own_athlete_daily_log_entry", {
      p_team_id: context.teamId,
      p_entry: sanitized,
    });
    if (error) throw error;
    if (Array.isArray(data)) {
      await AsyncStorage.setItem(ATHLETE_DAILY_LOG_ENTRIES_KEY, JSON.stringify(data));
    }
    return sanitized;
  }

  const entries = await loadAthleteDailyLogEntries();
  const byId = new Map<string, AthleteDailyLogEntry>();
  for (const existing of entries) {
    if (existing.id) byId.set(existing.id, existing);
  }
  byId.set(sanitized.id, sanitized);
  await saveAthleteDailyLogEntries(Array.from(byId.values()));
  return sanitized;
}

export async function deleteAthleteDailyLogEntry(id: string) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) return;
  const context = await getActiveAccountContext();
  if (context?.kind === "athlete" && context.teamId && context.athleteId) {
    const { data, error } = await supabase.rpc("delete_own_athlete_daily_log_entry", {
      p_team_id: context.teamId,
      p_entry_id: normalizedId,
    });
    if (error) throw error;
    if (Array.isArray(data)) {
      await AsyncStorage.setItem(ATHLETE_DAILY_LOG_ENTRIES_KEY, JSON.stringify(data));
    }
    return;
  }

  const entries = await loadAthleteDailyLogEntries();
  await saveAthleteDailyLogEntries(entries.filter((entry) => entry.id !== normalizedId));
}
