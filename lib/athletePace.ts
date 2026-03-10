import { loadJSON, saveJSON } from "./storage";
import { DEFAULT_PACE_SEC } from "./pace";

export const ATHLETE_PACE_OVERRIDES_KEY = "training_app_athlete_pace_seconds_per_unit_v1";

export type AthletePaceOverrides = Record<string, number>;

function normalizeAthletePaceKey(id: string | null | undefined) {
  let v = String(id ?? "").trim().toLowerCase();
  if (!v) return "";
  if (v.startsWith("ath_")) v = v.slice(4);
  v = v.replace(/_\d+$/, "");
  return v;
}

export async function loadAthletePaceOverrides(): Promise<AthletePaceOverrides> {
  const raw = await loadJSON<Record<string, number>>(ATHLETE_PACE_OVERRIDES_KEY, {});
  if (!raw || typeof raw !== "object") return {};

  const next: AthletePaceOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    const sec = Number(value);
    if (!Number.isFinite(sec) || sec <= 0) continue;
    next[String(key)] = Math.round(sec);
  }
  return next;
}

export async function saveAthletePaceOverrides(overrides: AthletePaceOverrides) {
  const cleaned: AthletePaceOverrides = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const sec = Number(value);
    if (!Number.isFinite(sec) || sec <= 0) continue;
    cleaned[String(key)] = Math.round(sec);
  }
  await saveJSON(ATHLETE_PACE_OVERRIDES_KEY, cleaned);
}

export function resolveAthletePaceSeconds(
  athleteId: string | null | undefined,
  overrides: AthletePaceOverrides,
  fallbackSec: number = DEFAULT_PACE_SEC
) {
  const fallback = Math.max(1, Math.round(fallbackSec || DEFAULT_PACE_SEC));
  const rawId = String(athleteId ?? "").trim();
  if (!rawId) return fallback;

  const exact = overrides?.[rawId];
  if (Number.isFinite(exact) && exact > 0) return Math.round(exact);

  const norm = normalizeAthletePaceKey(rawId);
  if (!norm) return fallback;

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (normalizeAthletePaceKey(key) !== norm) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    return Math.round(value);
  }

  return fallback;
}
