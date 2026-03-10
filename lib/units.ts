import { loadJSON, saveJSON } from "./storage";

export type DistanceUnit = "mi" | "km";

export const DISTANCE_UNIT_KEY = "training_app_distance_unit_v1";
export const DEFAULT_DISTANCE_UNIT: DistanceUnit = "mi";

export const MI_TO_KM = 1.609344;
export const KM_TO_MI = 1 / MI_TO_KM;

export function normalizeDistanceUnit(raw: unknown): DistanceUnit {
  return raw === "km" ? "km" : "mi";
}

export async function loadDistanceUnit(): Promise<DistanceUnit> {
  const raw = await loadJSON<string>(DISTANCE_UNIT_KEY, DEFAULT_DISTANCE_UNIT);
  return normalizeDistanceUnit(raw);
}

export async function saveDistanceUnit(unit: DistanceUnit) {
  await saveJSON(DISTANCE_UNIT_KEY, normalizeDistanceUnit(unit));
}

export function convertDistance(value: number, from: DistanceUnit, to: DistanceUnit): number {
  if (!Number.isFinite(value) || from === to) return value;
  if (from === "mi" && to === "km") return value * MI_TO_KM;
  return value * KM_TO_MI;
}

export function convertPaceSecondsPerUnit(sec: number, from: DistanceUnit, to: DistanceUnit): number {
  if (!Number.isFinite(sec) || from === to) return sec;
  // time per unit: sec/km = sec/mi * (mi per km), sec/mi = sec/km * (km per mi)
  if (from === "mi" && to === "km") return sec * KM_TO_MI;
  return sec * MI_TO_KM;
}

export function distanceUnitLabel(unit: DistanceUnit): string {
  return unit === "km" ? "km" : "mi";
}

export function paceUnitLongLabel(unit: DistanceUnit): string {
  return unit === "km" ? "kilometer" : "mile";
}
